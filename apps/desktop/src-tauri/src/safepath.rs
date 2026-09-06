//! Path confinement for agent file operations.
//!
//! The agent serves file requests from the network. Without confinement a
//! caller can name any path the host process can touch — reading private keys
//! or writing into a startup folder. Every path from the network is resolved
//! here first, and anything that lands outside the permitted roots is refused.
//!
//! Reads are confined to the user's own files (home, plus the transfer
//! folders). Writes are confined to the incoming-transfer folder alone: an
//! upload has no legitimate reason to land anywhere else.

use std::path::{Component, Path, PathBuf};

/// Roots that may be listed, stat'd or downloaded from.
pub fn read_roots() -> Vec<PathBuf> {
    let mut roots = vec![];
    if let Some(home) = dirs::home_dir() {
        roots.push(home);
    }
    roots.push(PathBuf::from(crate::files::incoming_dir()));
    if let Some(downloads) = crate::files::download_dir() {
        roots.push(downloads);
    }
    roots
}

/// The only root an upload may write into.
pub fn write_roots() -> Vec<PathBuf> {
    vec![PathBuf::from(crate::files::incoming_dir())]
}

/// Removes `.` and `..` without touching the filesystem, so a path can be
/// checked before any of it exists. `..` that would escape the start is
/// dropped rather than applied.
fn lexically_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    // Refuse to climb above the path we were given.
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Canonicalizes as much of `path` as exists, keeping the rest verbatim.
/// Needed for uploads, whose target file does not exist yet.
fn canonicalize_existing_prefix(path: &Path) -> Option<PathBuf> {
    if let Ok(real) = path.canonicalize() {
        return Some(real);
    }
    let parent = path.parent()?;
    let name = path.file_name()?;
    let real_parent = canonicalize_existing_prefix(parent)?;
    Some(real_parent.join(name))
}

fn is_within(candidate: &Path, root: &Path) -> bool {
    let Some(real_root) = canonicalize_existing_prefix(root) else {
        return false;
    };
    candidate.starts_with(&real_root)
}

/// Resolves a network-supplied path against `roots`.
///
/// Returns the canonical path on success. Symlinks are followed before the
/// check, so a link inside a root that points outside it is still refused.
pub fn resolve(path: &str, roots: &[PathBuf]) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("path is required".into());
    }
    // Windows accepts both separators; normalize so `..` is always visible
    // to the component walk below.
    let unified = path.replace('\\', "/");
    let normalized = lexically_normalize(Path::new(&unified));
    if !normalized.is_absolute() {
        return Err("path must be absolute".into());
    }
    let candidate = canonicalize_existing_prefix(&normalized)
        .ok_or_else(|| "path is not reachable".to_string())?;

    if roots.iter().any(|root| is_within(&candidate, root)) {
        Ok(candidate)
    } else {
        // Deliberately vague: a precise answer would let a caller map the
        // filesystem by probing which paths exist.
        Err("path is outside the folders NodeDesk shares".into())
    }
}

/// Resolve for listing/stat/download.
pub fn resolve_read(path: &str) -> Result<PathBuf, String> {
    resolve(path, &read_roots())
}

/// Resolve for upload. The parent is created first so a fresh incoming
/// folder still resolves.
pub fn resolve_write(path: &str) -> Result<PathBuf, String> {
    let roots = write_roots();
    for root in &roots {
        let _ = std::fs::create_dir_all(root);
    }
    resolve(path, &roots)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sandbox(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nodedesk-safepath-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn accepts_a_path_inside_the_root() {
        let root = sandbox("inside");
        std::fs::write(root.join("ok.txt"), b"x").unwrap();
        let target = root.join("ok.txt").to_string_lossy().to_string();
        assert!(resolve(&target, &[root]).is_ok());
    }

    #[test]
    fn rejects_a_path_outside_the_root() {
        let root = sandbox("outside");
        let outside = std::env::temp_dir().join("nodedesk-outside-marker.txt");
        std::fs::write(&outside, b"secret").unwrap();
        let result = resolve(&outside.to_string_lossy(), &[root]);
        assert!(result.is_err(), "a path outside every root must be refused");
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn rejects_traversal_out_of_the_root() {
        let root = sandbox("traversal");
        let escape = format!("{}/../../etc/passwd", root.to_string_lossy());
        assert!(resolve(&escape, &[root]).is_err(), "`..` must not escape the root");
    }

    #[test]
    fn rejects_traversal_written_with_backslashes() {
        let root = sandbox("backslash");
        let escape = format!("{}\\..\\..\\Windows\\System32\\config\\SAM", root.to_string_lossy());
        assert!(
            resolve(&escape, &[root]).is_err(),
            "backslash traversal must be caught too"
        );
    }

    #[test]
    fn allows_a_file_that_does_not_exist_yet() {
        let root = sandbox("newfile");
        let target = root.join("subdir").join("new.bin");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        assert!(
            resolve(&target.to_string_lossy(), &[root]).is_ok(),
            "uploads target files that do not exist yet"
        );
    }

    #[test]
    fn rejects_relative_and_empty_paths() {
        let root = sandbox("relative");
        assert!(resolve("", std::slice::from_ref(&root)).is_err());
        assert!(resolve("relative/path.txt", &[root]).is_err());
    }
}
