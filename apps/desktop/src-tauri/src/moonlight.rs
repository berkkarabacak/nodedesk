//! Moonlight-Qt controller integration.
//!
//! NodeDesk drives the real, unmodified Moonlight client for pairing and
//! streaming. That gives v1 hardware H.264/HEVC/AV1 decoding, 4K, HDR, high
//! refresh, gamepad/mouse/keyboard input and clipboard sync — all upstream.

use serde::Deserialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

use crate::state::{AppState, Settings};

const GITHUB_RELEASE: &str = "https://api.github.com/repos/moonlight-stream/moonlight-qt/releases/latest";

#[derive(Deserialize)]
struct GithubRelease {
    assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

/// Locates a Moonlight executable: previously downloaded portable copy,
/// a system install, or PATH.
pub fn moonlight_exe(config_dir: &Path) -> Option<PathBuf> {
    let portable_root = config_dir.join("moonlight");
    if portable_root.exists() {
        if let Some(found) = find_moonlight_in(&portable_root, 3) {
            return Some(found);
        }
    }
    let mut candidates: Vec<PathBuf> = vec![];
    #[cfg(windows)]
    {
        if let Ok(pf) = std::env::var("ProgramFiles") {
            candidates.push(
                PathBuf::from(pf)
                    .join("Moonlight Game Streaming")
                    .join("Moonlight.exe"),
            );
        }
    }
    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/Applications/Moonlight.app/Contents/MacOS/Moonlight"));
    }
    #[cfg(target_os = "linux")]
    {
        candidates.push(PathBuf::from("/usr/bin/moonlight"));
    }
    candidates
        .into_iter()
        .find(|p| p.exists())
        .or_else(|| which_in_path(if cfg!(windows) { "moonlight.exe" } else { "moonlight" }))
}

fn find_moonlight_in(dir: &Path, depth: u8) -> Option<PathBuf> {
    if depth == 0 {
        return None;
    }
    let entries = std::fs::read_dir(dir).ok()?;
    let mut dirs: Vec<PathBuf> = vec![];
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            dirs.push(path);
        } else if entry.file_name().to_string_lossy().eq_ignore_ascii_case("moonlight.exe") {
            return Some(path);
        }
    }
    dirs.iter().find_map(|d| find_moonlight_in(d.as_path(), depth - 1))
}

fn which_in_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    std::env::split_paths(&path_var).find_map(|dir| {
        let candidate = dir.join(name);
        if candidate.exists() {
            Some(candidate)
        } else {
            None
        }
    })
}

/// Downloads the Moonlight-Qt portable build and extracts it under the
/// NodeDesk config directory. No installer, no system changes.
pub async fn ensure_available(client: &reqwest::Client, config_dir: &Path) -> Result<PathBuf, String> {
    if let Some(exe) = moonlight_exe(config_dir) {
        return Ok(exe);
    }
    if !cfg!(windows) {
        return Err(
            "Automatic Moonlight download is Windows-only for now — install Moonlight from moonlight-stream.org and NodeDesk will use it"
                .into(),
        );
    }

    let release: GithubRelease = client
        .get(GITHUB_RELEASE)
        .send()
        .await
        .map_err(|e| format!("cannot reach GitHub: {e}"))?
        .json()
        .await
        .map_err(|e| format!("cannot parse Moonlight release info: {e}"))?;

    let asset = release
        .assets
        .iter()
        .find(|a| {
            let n = a.name.to_lowercase();
            n.contains("portable") && n.ends_with(".zip") && !n.contains("arm")
        })
        .ok_or("no portable Windows build found in the latest Moonlight release")?;

    crate::release::verify_asset_url(
        &asset.browser_download_url,
        "moonlight-stream",
        "moonlight-qt",
    )?;
    let bytes = client
        .get(&asset.browser_download_url)
        .send()
        .await
        .map_err(|e| format!("download failed: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("download failed: {e}"))?;

    let zip_path = std::env::temp_dir().join("nodedesk-moonlight-portable.zip");
    std::fs::write(&zip_path, &bytes).map_err(|e| e.to_string())?;

    let target = config_dir.join("moonlight");
    let _ = std::fs::remove_dir_all(&target);
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;

    let file = std::fs::File::open(&zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("invalid Moonlight archive: {e}"))?;
    archive
        .extract(&target)
        .map_err(|e| format!("failed to extract Moonlight: {e}"))?;
    let _ = std::fs::remove_file(&zip_path);

    moonlight_exe(config_dir).ok_or_else(|| "Moonlight.exe not found after extraction".into())
}

/// Extracts the 4-digit PIN from Moonlight's `pair` console output.
pub fn extract_pin(line: &str) -> Option<String> {
    let digits: Vec<&str> = line
        .split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .collect();
    digits
        .iter()
        .find(|d| d.len() == 4)
        .map(|d| d.to_string())
}

/// Runs `moonlight pair <host>`, forwarding the displayed PIN to the UI via
/// the `pair-pin` event. Resolves when pairing completes or times out.
pub async fn pair(app: AppHandle, exe: PathBuf, host: String) -> Result<(), String> {
    let mut child = Command::new(&exe)
        .args(["pair", &host])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start Moonlight: {e}"))?;

    let stdout = child.stdout.take().ok_or("cannot read Moonlight output")?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Some(pin) = extract_pin(&line) {
                let _ = tx.send(pin);
            }
        }
    });

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
    loop {
        while let Ok(pin) = rx.try_recv() {
            let _ = app.emit("pair-pin", pin);
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(())
                } else {
                    Err("Pairing failed — make sure the PIN was approved on the host".into())
                }
            }
            Ok(None) => {
                if std::time::Instant::now() > deadline {
                    let _ = child.kill();
                    return Err("Pairing timed out — approve the PIN on the host, then retry".into());
                }
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// Builds `moonlight stream` arguments from user settings.
pub fn stream_args(settings: &Settings, host: &str) -> Vec<String> {
    let mut args: Vec<String> = vec![];
    match settings.resolution.as_str() {
        "1080p" => args.push("-1080".into()),
        "1440p" => args.push("-1440".into()),
        "4k" => args.push("-4k".into()),
        _ => {}
    }
    if settings.fps > 0 {
        args.push("-fps".into());
        args.push(settings.fps.to_string());
    }
    if settings.bitrate_mbps > 0 {
        args.push("-bitrate".into());
        args.push((settings.bitrate_mbps * 1000).to_string());
    }
    if settings.codec != "auto" {
        args.push("-codec".into());
        args.push(settings.codec.clone());
    }
    if settings.hdr {
        args.push("-hdr".into());
    }
    args.push("stream".into());
    args.push(host.to_string());
    args.push("Desktop".into());
    args
}

pub fn start_stream(state: &AppState, exe: PathBuf, settings: &Settings, host: &str) -> Result<(), String> {
    let args = stream_args(settings, host);
    let child = Command::new(exe)
        .args(&args)
        .spawn()
        .map_err(|e| format!("failed to start Moonlight: {e}"))?;
    let mut guard = state.stream_child.lock().map_err(|e| e.to_string())?;
    *guard = Some(child);
    Ok(())
}

pub fn stop_stream(state: &AppState) {
    if let Ok(mut guard) = state.stream_child.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pin_parsing() {
        assert_eq!(
            extract_pin("Please enter the following PIN on the target PC: 1234"),
            Some("1234".to_string())
        );
        assert_eq!(extract_pin("Connecting to 192.168.1.10"), None);
    }

    #[test]
    fn stream_arg_mapping() {
        let s = Settings {
            resolution: "4k".into(),
            fps: 120,
            bitrate_mbps: 80,
            codec: "hevc".into(),
            hdr: true,
            ..Default::default()
        };
        let args = stream_args(&s, "ai-pc");
        assert!(args.contains(&"-4k".to_string()));
        assert!(args.contains(&"-fps".to_string()));
        assert!(args.contains(&"120".to_string()));
        assert!(args.contains(&"80000".to_string()));
        assert!(args.contains(&"hevc".to_string()));
        assert!(args.contains(&"-hdr".to_string()));
        assert_eq!(args.last().unwrap(), "Desktop");
    }
}
