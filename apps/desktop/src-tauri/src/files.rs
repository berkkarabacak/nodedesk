//! File transfer: resumable upload/download between NodeDesk computers.
//!
//! Transport is the authenticated agent channel (access code required).
//! Resume works both ways: uploads continue at the remote file's current
//! size, downloads continue at the local file's current size.

use serde::{Deserialize, Serialize};
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter};

use crate::discovery::AGENT_PORT;
use crate::state::AppState;

const CHUNK: usize = 4 * 1024 * 1024; // 4 MiB

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Serialize, Deserialize)]
pub struct StatResponse {
    pub size: u64,
    pub is_dir: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub direction: String,
    pub file: String,
    pub done_bytes: u64,
    pub total_bytes: u64,
    pub finished: bool,
}

// ---------------------------------------------------------------------------
// Agent-side helpers (server)
// ---------------------------------------------------------------------------

pub fn list_dir(path: &str) -> Result<Vec<FileEntry>, String> {
    let path = if path.is_empty() {
        dirs::home_dir().ok_or("no home directory")?
    } else {
        path.into()
    };
    let mut entries = vec![];
    let read = std::fs::read_dir(&path).map_err(|e| format!("cannot open {}: {e}", path.display()))?;
    for entry in read.flatten() {
        let meta = entry.metadata().ok();
        entries.push(FileEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            is_dir: meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
            size: meta.map(|m| m.len()).unwrap_or(0),
        });
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}

pub fn stat(path: &str) -> Result<StatResponse, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    Ok(StatResponse {
        size: if meta.is_file() { meta.len() } else { 0 },
        is_dir: meta.is_dir(),
    })
}

/// Reads `path` starting at `offset`. Enables download resume.
pub fn read_from(path: &str, offset: u64) -> Result<Vec<u8>, String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

/// Appends `data` to `path` at `offset`. Enables upload resume.
pub fn write_at(path: &str, offset: u64, data: &[u8]) -> Result<u64, String> {
    if let Some(parent) = std::path::Path::new(path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    file.write_all(data).map_err(|e| e.to_string())?;
    Ok(offset + data.len() as u64)
}

pub fn incoming_dir() -> String {
    dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("NodeDesk-Incoming")
        .to_string_lossy()
        .to_string()
}

// ---------------------------------------------------------------------------
// Client-side transfers (called via Tauri commands)
// ---------------------------------------------------------------------------

fn emit(app: &AppHandle, p: &TransferProgress) {
    let _ = app.emit("transfer-progress", p);
}

fn code_for(state: &AppState, address: &str) -> Result<String, String> {
    state
        .settings
        .read()
        .ok()
        .and_then(|s| s.host_codes.get(address).cloned())
        .ok_or("No access code stored for this computer — add it with its code first".to_string())
}

fn cancelled(state: &AppState) -> bool {
    state.transfer_cancel.load(Ordering::SeqCst)
}

pub async fn send_files(app: AppHandle, state: &AppState, address: &str, paths: Vec<String>) -> Result<(), String> {
    let code = code_for(state, address)?;
    state.transfer_cancel.store(false, Ordering::SeqCst);
    let remote_dir = incoming_dir();

    for path in &paths {
        if cancelled(state) {
            return Err("Transfer cancelled".into());
        }
        let local = std::path::PathBuf::from(path);
        let name = local
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .ok_or("invalid file name")?;
        let mut file = std::fs::File::open(&local).map_err(|e| format!("cannot open {name}: {e}"))?;
        let total = file.metadata().map_err(|e| e.to_string())?.len();
        let remote_path = format!("{remote_dir}/{name}");

        // Resume: ask the host how much it already has.
        let mut offset: u64 = match state
            .http
            .get(format!("http://{address}:{AGENT_PORT}/files/stat"))
            .header("x-nodedesk-code", &code)
            .query(&[("path", &remote_path)])
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => resp
                .json::<StatResponse>()
                .await
                .map(|s| s.size)
                .unwrap_or(0),
            _ => 0,
        };

        let mut buf = vec![0u8; CHUNK];
        file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        loop {
            if cancelled(state) {
                return Err("Transfer cancelled".into());
            }
            let read = file.read(&mut buf).map_err(|e| e.to_string())?;
            if read == 0 {
                break;
            }
            let resp = state
                .http
                .post(format!("http://{address}:{AGENT_PORT}/files/upload"))
                .header("x-nodedesk-code", &code)
                .query(&[("path", remote_path.clone()), ("offset", offset.to_string())])
                .body(buf[..read].to_vec())
                .send()
                .await
                .map_err(|e| format!("upload failed: {e}"))?;
            if !resp.status().is_success() {
                return Err(format!("host rejected the upload (HTTP {})", resp.status()));
            }
            offset += read as u64;
            emit(
                &app,
                &TransferProgress {
                    direction: "up".into(),
                    file: name.clone(),
                    done_bytes: offset,
                    total_bytes: total,
                    finished: offset >= total,
                },
            );
        }
    }
    Ok(())
}

pub async fn download_file(app: AppHandle, state: &AppState, address: &str, remote_path: &str) -> Result<String, String> {
    let code = code_for(state, address)?;
    state.transfer_cancel.store(false, Ordering::SeqCst);

    let name = std::path::Path::new(remote_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or("invalid remote path")?;

    let total: u64 = state
        .http
        .get(format!("http://{address}:{AGENT_PORT}/files/stat"))
        .header("x-nodedesk-code", &code)
        .query(&[("path", remote_path)])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<StatResponse>()
        .await
        .map_err(|e| e.to_string())?
        .size;

    let local_dir = dirs::download_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from(".")))
        .join("NodeDesk");
    std::fs::create_dir_all(&local_dir).map_err(|e| e.to_string())?;
    let local_path = local_dir.join(&name);

    let mut offset: u64 = std::fs::metadata(&local_path).map(|m| m.len()).unwrap_or(0);
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&local_path)
        .map_err(|e| e.to_string())?;

    while offset < total {
        if cancelled(state) {
            return Err("Transfer cancelled".into());
        }
        let bytes = state
            .http
            .get(format!("http://{address}:{AGENT_PORT}/files/download"))
            .header("x-nodedesk-code", &code)
            .query(&[("path", remote_path.to_string()), ("offset", offset.to_string())])
            .send()
            .await
            .map_err(|e| e.to_string())?
            .bytes()
            .await
            .map_err(|e| e.to_string())?;
        if bytes.is_empty() {
            break;
        }
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        offset += bytes.len() as u64;
        emit(
            &app,
            &TransferProgress {
                direction: "down".into(),
                file: name.clone(),
                done_bytes: offset,
                total_bytes: total,
                finished: offset >= total,
            },
        );
    }
    Ok(local_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_read_roundtrip_with_offset() {
        let path = std::env::temp_dir().join("nodedesk-test-transfer.bin");
        let path = path.to_string_lossy().to_string();
        let _ = std::fs::remove_file(&path);
        assert_eq!(write_at(&path, 0, b"hello ").unwrap(), 6);
        assert_eq!(write_at(&path, 6, b"world").unwrap(), 11);
        assert_eq!(read_from(&path, 6).unwrap(), b"world");
        assert_eq!(stat(&path).unwrap().size, 11);
        let _ = std::fs::remove_file(&path);
    }
}
