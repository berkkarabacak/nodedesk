//! File transfer: resumable upload/download between NodeDesk computers.
//!
//! Transport is the authenticated agent channel (every request is signed;
//! see `auth`). Resume works both ways: uploads continue at the remote file's
//! current size, downloads continue at the local file's current size.
//!
//! Every path arriving from the network is confined by `safepath` before it
//! reaches the filesystem — reads to the user's own folders, writes to the
//! incoming-transfer folder alone.

use serde::{Deserialize, Serialize};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Duration;

use crate::client;
use crate::safepath;
use crate::state::AppState;

const CHUNK: usize = 2 * 1024 * 1024; // 2 MiB

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

/// A resumable upload asks for the size of a file that may not exist yet, so
/// "not there" has to stay distinguishable from "you may not look".
pub enum StatError {
    Missing,
    Denied(String),
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
    let path: PathBuf = if path.is_empty() {
        dirs::home_dir().ok_or("no home directory")?
    } else {
        safepath::resolve_read(path)?
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

/// Stat is reachable for both roots: a download checks a readable file, a
/// resuming upload checks its own partial file in the incoming folder.
pub fn stat(path: &str) -> Result<StatResponse, StatError> {
    let mut roots = safepath::read_roots();
    roots.extend(safepath::write_roots());
    let resolved = safepath::resolve(path, &roots).map_err(StatError::Denied)?;
    let meta = std::fs::metadata(&resolved).map_err(|_| StatError::Missing)?;
    Ok(StatResponse {
        size: if meta.is_file() { meta.len() } else { 0 },
        is_dir: meta.is_dir(),
    })
}

/// Reads `path` starting at `offset`. Enables download resume.
pub fn read_from(path: &str, offset: u64) -> Result<Vec<u8>, String> {
    let resolved = safepath::resolve_read(path)?;
    let mut file = std::fs::File::open(&resolved).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

/// Writes `data` into `path` at `offset`. Enables upload resume.
///
/// A write at offset 0 truncates: without that, uploading a shorter file over
/// a longer one of the same name would leave the old tail in place and
/// silently corrupt the result.
pub fn write_at(path: &str, offset: u64, data: &[u8]) -> Result<u64, String> {
    let resolved = safepath::resolve_write(path)?;
    if let Some(parent) = resolved.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(offset == 0)
        .open(&resolved)
        .map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    file.write_all(data).map_err(|e| e.to_string())?;
    Ok(offset + data.len() as u64)
}

pub fn incoming_dir() -> String {
    if let Ok(dir) = std::env::var("NODEDESK_INCOMING_DIR") {
        return dir;
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("NodeDesk-Incoming")
        .to_string_lossy()
        .to_string()
}

/// Where downloads land locally.
pub fn download_dir() -> Option<PathBuf> {
    let base = std::env::var("NODEDESK_DOWNLOAD_DIR")
        .ok()
        .map(PathBuf::from)
        .or_else(dirs::download_dir)
        .or_else(dirs::home_dir)?;
    Some(base.join("NodeDesk"))
}

// ---------------------------------------------------------------------------
// Client-side transfers (called via Tauri commands)
// ---------------------------------------------------------------------------

fn code_for(state: &AppState, address: &str) -> Result<String, String> {
    crate::state::code_for_host(state, address)
        .ok_or_else(|| "No access code stored for this computer — add it with its code first".into())
}

fn cancelled(state: &AppState) -> bool {
    state.transfer_cancel.load(Ordering::SeqCst)
}

/// Sends local files to a host's incoming folder, resuming partial uploads.
/// `emit` receives progress updates (the command layer forwards them to the UI).
pub async fn send_files(
    state: &AppState,
    address: &str,
    paths: Vec<String>,
    emit: &(dyn Fn(&TransferProgress) + Send + Sync),
) -> Result<(), String> {
    let code = code_for(state, address)?;
    state.transfer_cancel.store(false, Ordering::SeqCst);
    let remote_dir = incoming_dir();
    let port = crate::discovery::agent_port();

    for path in &paths {
        if cancelled(state) {
            return Err("Transfer cancelled".into());
        }
        let local = PathBuf::from(path);
        let name = local
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .ok_or("invalid file name")?;
        let mut file = std::fs::File::open(&local).map_err(|e| format!("cannot open {name}: {e}"))?;
        let total = file.metadata().map_err(|e| e.to_string())?.len();
        let remote_path = format!("{remote_dir}/{name}");

        // Resume: ask the host how much it already has. A missing file (404)
        // simply means "start from zero".
        let mut offset: u64 = match client::AgentRequest::get(address, port, "/files/stat")
            .query(vec![("path", remote_path.clone())])
            .timeout(Duration::from_millis(3000))
            .send(&state.http, &code)
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                resp.json::<StatResponse>().await.map(|s| s.size).unwrap_or(0)
            }
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
            client::AgentRequest::post(address, port, "/files/upload")
                .query(vec![
                    ("path", remote_path.clone()),
                    ("offset", offset.to_string()),
                ])
                .body(buf[..read].to_vec())
                .send_ok(&state.http, &code)
                .await
                .map_err(|e| format!("upload failed: {e}"))?;
            offset += read as u64;
            emit(&TransferProgress {
                direction: "up".into(),
                file: name.clone(),
                done_bytes: offset,
                total_bytes: total,
                finished: offset >= total,
            });
        }
    }
    Ok(())
}

/// Downloads a remote file into ~/Downloads/NodeDesk, resuming partial files.
pub async fn download_file(
    state: &AppState,
    address: &str,
    remote_path: &str,
    emit: &(dyn Fn(&TransferProgress) + Send + Sync),
) -> Result<String, String> {
    let code = code_for(state, address)?;
    state.transfer_cancel.store(false, Ordering::SeqCst);
    let port = crate::discovery::agent_port();

    let name = std::path::Path::new(remote_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or("invalid remote path")?;

    let total: u64 = client::AgentRequest::get(address, port, "/files/stat")
        .query(vec![("path", remote_path.to_string())])
        .timeout(Duration::from_millis(3000))
        .send_ok(&state.http, &code)
        .await?
        .json::<StatResponse>()
    .await
    .map_err(|e| e.to_string())?
    .size;

    let local_dir = download_dir().ok_or("no download directory")?;
    std::fs::create_dir_all(&local_dir).map_err(|e| e.to_string())?;
    let local_path = local_dir.join(&name);

    let mut offset: u64 = std::fs::metadata(&local_path).map(|m| m.len()).unwrap_or(0);
    // A local file already larger than the remote one is a stale leftover,
    // not a resumable prefix.
    if offset > total {
        let _ = std::fs::remove_file(&local_path);
        offset = 0;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&local_path)
        .map_err(|e| e.to_string())?;

    while offset < total {
        if cancelled(state) {
            return Err("Transfer cancelled".into());
        }
        let bytes = client::AgentRequest::get(address, port, "/files/download")
            .query(vec![
                ("path", remote_path.to_string()),
                ("offset", offset.to_string()),
            ])
            .send_ok(&state.http, &code)
            .await?
            .bytes()
        .await
        .map_err(|e| e.to_string())?;
        if bytes.is_empty() {
            break;
        }
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        offset += bytes.len() as u64;
        emit(&TransferProgress {
            direction: "down".into(),
            file: name.clone(),
            done_bytes: offset,
            total_bytes: total,
            finished: offset >= total,
        });
    }
    Ok(local_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Points the incoming folder at a scratch directory so confined writes
    /// have somewhere legitimate to land.
    fn incoming_sandbox(name: &str) -> PathBuf {
        // Caller holds the env lock; see `state::testenv`.
        let dir = std::env::temp_dir().join(format!("nodedesk-files-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("NODEDESK_INCOMING_DIR", dir.to_string_lossy().to_string());
        dir.canonicalize().unwrap()
    }

    #[test]
    fn write_read_roundtrip_with_offset() {
        let _env = crate::state::testenv::lock();
        let dir = incoming_sandbox("roundtrip");
        let path = dir.join("transfer.bin").to_string_lossy().to_string();
        assert_eq!(write_at(&path, 0, b"hello ").unwrap(), 6);
        assert_eq!(write_at(&path, 6, b"world").unwrap(), 11);
        assert_eq!(read_from(&path, 6).unwrap(), b"world");
        assert_eq!(stat(&path).ok().unwrap().size, 11);
        std::env::remove_var("NODEDESK_INCOMING_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn overwrite_at_offset_keeps_later_bytes() {
        let _env = crate::state::testenv::lock();
        let dir = incoming_sandbox("offset");
        let path = dir.join("offset.bin").to_string_lossy().to_string();
        write_at(&path, 0, b"abcdef").unwrap();
        write_at(&path, 2, b"XY").unwrap();
        assert_eq!(read_from(&path, 0).unwrap(), b"abXYef");
        std::env::remove_var("NODEDESK_INCOMING_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn restarting_an_upload_truncates_the_old_file() {
        let _env = crate::state::testenv::lock();
        let dir = incoming_sandbox("truncate");
        let path = dir.join("replaced.bin").to_string_lossy().to_string();
        write_at(&path, 0, b"a-much-longer-previous-file").unwrap();
        // A fresh upload of a shorter file starts again at offset 0.
        write_at(&path, 0, b"short").unwrap();
        assert_eq!(
            read_from(&path, 0).unwrap(),
            b"short",
            "the tail of the replaced file must not survive"
        );
        std::env::remove_var("NODEDESK_INCOMING_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stat_missing_file_reports_missing_not_denied() {
        let _env = crate::state::testenv::lock();
        let dir = incoming_sandbox("missing");
        let path = dir.join("nope.bin").to_string_lossy().to_string();
        assert!(matches!(stat(&path), Err(StatError::Missing)));
        std::env::remove_var("NODEDESK_INCOMING_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn writes_outside_the_incoming_folder_are_refused() {
        let _env = crate::state::testenv::lock();
        let dir = incoming_sandbox("confined");
        let outside = std::env::temp_dir().join("nodedesk-files-escape.bin");
        let _ = std::fs::remove_file(&outside);
        assert!(
            write_at(&outside.to_string_lossy(), 0, b"payload").is_err(),
            "an upload must not write outside the incoming folder"
        );
        assert!(!outside.exists());
        std::env::remove_var("NODEDESK_INCOMING_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_dir_puts_dirs_first() {
        let _env = crate::state::testenv::lock();
        let dir = incoming_sandbox("list");
        std::fs::create_dir_all(dir.join("zdir")).unwrap();
        std::fs::write(dir.join("afile.txt"), b"x").unwrap();
        let entries = list_dir(&dir.to_string_lossy()).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries[0].is_dir);
        assert_eq!(entries[0].name, "zdir");
        std::env::remove_var("NODEDESK_INCOMING_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
