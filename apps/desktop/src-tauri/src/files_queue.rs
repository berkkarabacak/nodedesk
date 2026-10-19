//! M7: transfer queue — per-transfer IDs, independent cancel, identity-checked
//! resume, explicit collision policy.
//!
//! Invariants (SPEC §09 FEATURE H):
//! - Every operation has a unique transfer ID; filename alone never correlates
//!   (FILE-01/04).
//! - Cancelling one item never touches another (FILE-05).
//! - Resume is allowed only for the SAME transfer record with unchanged source
//!   identity (path + size + mtime + leading-bytes hash); anything else
//!   restarts safely (FILE-06).
//! - A completed different file at the destination triggers the caller's
//!   conflict policy (keep-both default); nothing is silently appended or
//!   resumed merely because a name matches (FILE-07).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use sha2::Digest;

#[derive(Clone)]
pub struct Transfer {
    pub id: String,
    pub direction: String, // "up" | "down"
    pub file: String,
    pub address: String,
    /// Upload: local source path. Download: remote source path.
    pub source: String,
    /// Destination path (local for downloads, remote incoming for uploads).
    pub dest: String,
    pub total_bytes: u64,
    /// Source identity captured at enqueue (FILE-06).
    pub identity: String,
    pub on_conflict: String, // "keep-both" | "overwrite"
    pub cancel: Arc<AtomicBool>,
    pub done: Arc<AtomicU64>,
    pub state: Arc<Mutex<String>>, // queued|transferring|interrupted|verifying|completed|cancelled|failed
}

impl Transfer {
    pub fn snapshot(&self) -> serde_json::Value {
        serde_json::json!({
            "transferId": self.id,
            "direction": self.direction,
            "file": self.file,
            "address": self.address,
            "dest": self.dest,
            "doneBytes": self.done.load(Ordering::SeqCst),
            "totalBytes": self.total_bytes,
            "state": self.state.lock().map(|s| s.clone()).unwrap_or_default(),
        })
    }

    pub fn set_state(&self, s: &str) {
        if let Ok(mut guard) = self.state.lock() {
            // Cancelled/terminal states are never reopened by late events
            // (FILE-05: late events cannot report Done after cancellation).
            let current = guard.clone();
            let terminal = matches!(current.as_str(), "cancelled" | "completed" | "failed");
            if !terminal {
                *guard = s.to_string();
            }
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
}

#[derive(Default)]
pub struct TransferQueue {
    pub items: Mutex<Vec<Arc<Transfer>>>,
}

impl TransferQueue {
    pub fn new() -> Self {
        Self { items: Mutex::new(vec![]) }
    }

    pub fn add(&self, t: Transfer) -> Arc<Transfer> {
        let shared = Arc::new(t);
        if let Ok(mut items) = self.items.lock() {
            items.push(shared.clone());
        }
        shared
    }

    pub fn get(&self, id: &str) -> Option<Arc<Transfer>> {
        self.items.lock().ok()?.iter().find(|t| t.id == id).cloned()
    }

    /// FILE-05: cancel exactly one operation; others proceed untouched.
    pub fn cancel(&self, id: &str) -> bool {
        if let Some(t) = self.get(id) {
            t.cancel.store(true, Ordering::SeqCst);
            if let Ok(mut s) = t.state.lock() {
                if !matches!(s.as_str(), "completed") {
                    *s = "cancelled".into();
                }
            }
            return true;
        }
        false
    }

    pub fn snapshots(&self) -> Vec<serde_json::Value> {
        self.items
            .lock()
            .map(|items| items.iter().map(|t| t.snapshot()).collect())
            .unwrap_or_default()
    }
}

/// Identity for resume decisions: size + modified time + hash of the first
/// 64 KiB. Same name/size alone is never enough (FILE-06).
pub fn source_identity(path: &std::path::Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut head = [0u8; 65536];
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let n = std::io::Read::read(&mut f, &mut head).unwrap_or(0);
    let hash = sha2::Sha256::digest(&head[..n]);
    Ok(format!(
        "{}:{}:{}",
        meta.len(),
        mtime,
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hash)
    ))
}

/// Emit a progress event carrying the transfer ID (FILE-03/04).
pub fn emit_transfer(app: &tauri::AppHandle, t: &Transfer) {
    use tauri::Emitter;
    let _ = app.emit("transfer-progress", t.snapshot());
}

/// Resolve a destination collision per policy (FILE-07). Returns the path to
/// write to. `keep-both` picks `name (2).ext`, `name (3).ext`, …; `overwrite`
/// returns the original (the old file is replaced, never appended-blended).
pub fn resolve_collision(dest: &std::path::Path, policy: &str) -> std::path::PathBuf {
    if policy == "overwrite" || !dest.exists() {
        return dest.to_path_buf();
    }
    let parent = dest.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let stem = dest.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = dest.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    for n in 2..1000 {
        let candidate = parent.join(format!("{stem} ({n}){ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dest.to_path_buf()
}
