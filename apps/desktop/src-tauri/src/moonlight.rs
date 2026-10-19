//! Moonlight-Qt controller integration.
//!
//! NodeDesk drives the real, unmodified Moonlight client for pairing and
//! streaming. That gives v1 hardware H.264/HEVC/AV1 decoding, 4K, HDR, high
//! refresh, gamepad/mouse/keyboard input and clipboard sync — all upstream.

use serde::Deserialize;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use crate::session::{self, Recovery, StreamSignal};
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

pub fn start_stream(app: &AppHandle, exe: PathBuf, settings: &Settings, host: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    state.stream_user_stop.store(false, Ordering::SeqCst);
    state.stream_revoked.store(false, Ordering::SeqCst);
    state.stream_ready.store(false, Ordering::SeqCst);
    state.stream_saw_failure.store(false, Ordering::SeqCst);
    state.stream_attempt.store(0, Ordering::SeqCst);
    let args = stream_args(settings, host);
    if let Ok(mut launch) = state.stream_launch.lock() {
        *launch = Some(crate::state::StreamLaunch {
            exe: exe.clone(),
            args: args.clone(),
            host: host.to_string(),
        });
    }
    spawn_viewer(app, &exe, &args)
}

fn spawn_viewer(app: &AppHandle, exe: &Path, args: &[String]) -> Result<(), String> {
    let mut child = Command::new(exe)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start Moonlight: {e}"))?;
    // SESSION-02: readiness is a line from the viewer, not the fact that it spawned.
    if let Some(stdout) = child.stdout.take() {
        spawn_output_reader(app.clone(), stdout);
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_output_reader(app.clone(), stderr);
    }
    let state = app.state::<AppState>();
    let mut guard = state.stream_child.lock().map_err(|e| e.to_string())?;
    // SESSION-06: one outgoing session at a time. Never silently overwrite a
    // running viewer's handle — the old process would leak.
    if let Some(mut old) = guard.take() {
        let _ = old.kill();
        let _ = old.wait();
    }
    *guard = Some(child);
    Ok(())
}

fn spawn_output_reader(app: AppHandle, pipe: impl Read + Send + 'static) {
    std::thread::spawn(move || {
        for line in BufReader::new(pipe).lines() {
            let Ok(line) = line else { break };
            match session::classify_stream_line(&line) {
                StreamSignal::Ready => {
                    if let Some(state) = app.try_state::<AppState>() {
                        state.stream_ready.store(true, Ordering::SeqCst);
                        state.stream_attempt.store(0, Ordering::SeqCst);
                    }
                    let _ = app.emit("stream-ready", true);
                }
                StreamSignal::Failed => {
                    if let Some(state) = app.try_state::<AppState>() {
                        state.stream_saw_failure.store(true, Ordering::SeqCst);
                    }
                    let _ = app.emit("stream-failed-line", line);
                }
                StreamSignal::Ignore => {}
            }
        }
    });
}

/// Watches the viewer. A clean user stop emits `stream-exited`. An exit
/// before readiness fails the attempt. A drop after readiness reconnects on
/// the 1/2/4 s schedule unless the grant was revoked (SESSION-07/08/11).
pub fn watch_stream(app: AppHandle) {
    let generation = {
        let state = app.state::<AppState>();
        state.stream_generation.fetch_add(1, Ordering::SeqCst) + 1
    };
    std::thread::spawn(move || watcher(app, generation));
}

fn watcher(app: AppHandle, generation: u64) {
    loop {
        if !still_current(&app, generation) {
            return;
        }
        let exited = {
            let state = app.state::<AppState>();
            let mut guard = match state.stream_child.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            match guard.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => {
                        *guard = None;
                        Some(status.success())
                    }
                    Ok(None) => None,
                    Err(_) => {
                        *guard = None;
                        Some(false)
                    }
                },
                None => return,
            }
        };
        let Some(clean_exit) = exited else {
            std::thread::sleep(Duration::from_millis(200));
            continue;
        };
        if !still_current(&app, generation) {
            return;
        }
        let state = app.state::<AppState>();
        let decision = session::on_process_exit(
            state.stream_ready.load(Ordering::SeqCst),
            clean_exit,
            state.stream_saw_failure.load(Ordering::SeqCst),
            state.stream_attempt.load(Ordering::SeqCst),
            state.stream_revoked.load(Ordering::SeqCst),
            state.stream_user_stop.load(Ordering::SeqCst),
        );
        match decision {
            Recovery::Stop => {
                let _ = app.emit("stream-exited", true);
                return;
            }
            Recovery::GiveUp => {
                // Distinct from stream-exited so the UI does not start a second schedule.
                let _ = app.emit("stream-reconnect-failed", true);
                return;
            }
            Recovery::Retry { delay_ms, attempt } => {
                state.stream_attempt.store(attempt, Ordering::SeqCst);
                state.stream_ready.store(false, Ordering::SeqCst);
                state.stream_saw_failure.store(false, Ordering::SeqCst);
                let _ = app.emit(
                    "stream-reconnecting",
                    serde_json::json!({ "attempt": attempt, "delayMs": delay_ms }),
                );
                if !sleep_interruptible(&app, generation, Duration::from_millis(delay_ms)) {
                    // A user stop or a newer launch also aborts the wait. Only
                    // a revoked grant tells the UI the host ended the session.
                    if state.stream_revoked.load(Ordering::SeqCst) {
                        let _ = app.emit("stream-revoked", true);
                    }
                    return;
                }
                let launch = state.stream_launch.lock().ok().and_then(|g| g.clone());
                let Some(launch) = launch else {
                    let _ = app.emit("stream-reconnect-failed", true);
                    return;
                };
                if spawn_viewer(&app, &launch.exe, &launch.args).is_err() {
                    let _ = app.emit("stream-reconnect-failed", true);
                    return;
                }
                let _ = app.emit("stream-started", &launch.host);
            }
        }
    }
}

fn still_current(app: &AppHandle, generation: u64) -> bool {
    let state = app.state::<AppState>();
    state.stream_generation.load(Ordering::SeqCst) == generation
        && !state.stream_revoked.load(Ordering::SeqCst)
        && !state.stream_user_stop.load(Ordering::SeqCst)
}

/// Sleep in short slices so revocation or a new launch aborts the wait.
fn sleep_interruptible(app: &AppHandle, generation: u64, total: Duration) -> bool {
    let deadline = Instant::now() + total;
    while Instant::now() < deadline {
        if !still_current(app, generation) {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    still_current(app, generation)
}

pub fn stop_stream(state: &AppState) {
    state.stream_user_stop.store(true, Ordering::SeqCst);
    // Retire the watcher before the child dies, so the exit is not a reconnect.
    state.stream_generation.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut guard) = state.stream_child.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// SESSION-08: the host revoked this controller's grant. Kill the viewer and
/// do not relaunch it.
pub fn mark_stream_revoked(state: &AppState) {
    state.stream_revoked.store(true, Ordering::SeqCst);
    state.stream_generation.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut guard) = state.stream_child.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
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
