//! Managed Sunshine host: detection, install, configuration, PIN approval.
//!
//! NodeDesk deploys an unmodified upstream Sunshine build and drives its
//! documented interfaces (config CLI + local HTTPS API). Nothing here weakens
//! upstream security: pairing still requires the host user to type the PIN,
//! and the API credentials are machine-local secrets in OS secure storage.

use base64::Engine;
use serde::Deserialize;
use std::path::PathBuf;

const SUNSHINE_API: &str = "https://127.0.0.1:47990";
const CREDS_KEY: &str = "sunshine-credentials"; // stored as "user:pass"
const FIXED_USER: &str = "nodedesk";

pub fn exe_path() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = vec![];
    if let Ok(pf) = std::env::var("ProgramFiles") {
        candidates.push(PathBuf::from(pf).join("Sunshine").join("sunshine.exe"));
    }
    if let Ok(pf) = std::env::var("ProgramFiles(x86)") {
        candidates.push(PathBuf::from(pf).join("Sunshine").join("sunshine.exe"));
    }
    candidates.push(PathBuf::from(r"C:\Program Files\Sunshine\sunshine.exe"));
    candidates.into_iter().find(|p| p.exists())
}

pub fn is_installed() -> bool {
    exe_path().is_some()
}

fn run(cmd: &str, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new(cmd)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run {cmd}: {e}"))?;
    Ok(format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    ))
}

pub fn service_running() -> bool {
    run("sc", &["query", "SunshineService"])
        .map(|o| o.contains("RUNNING"))
        .unwrap_or(false)
}

pub fn start_service() -> Result<(), String> {
    let out = run("net", &["start", "SunshineService"])?;
    if service_running() || out.contains("already been started") {
        Ok(())
    } else {
        Err("Sunshine service did not start (try running NodeDesk as administrator once)".into())
    }
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

/// Downloads and silently installs the latest upstream Sunshine release.
pub async fn ensure_installed(client: &reqwest::Client) -> Result<String, String> {
    if is_installed() {
        return Ok("already installed".into());
    }
    if !cfg!(windows) {
        return Err("Automatic Sunshine install is only supported on Windows in v1.0".into());
    }

    let release: GithubRelease = client
        .get("https://api.github.com/repos/LizardByte/Sunshine/releases/latest")
        .send()
        .await
        .map_err(|e| format!("cannot reach GitHub: {e}"))?
        .json()
        .await
        .map_err(|e| format!("cannot parse Sunshine release info: {e}"))?;

    let asset = release
        .assets
        .iter()
        .find(|a| {
            let n = a.name.to_lowercase();
            n.contains("windows") && n.contains("installer") && n.ends_with(".exe")
        })
        .ok_or("no Windows installer found in the latest Sunshine release")?;

    let bytes = client
        .get(&asset.browser_download_url)
        .send()
        .await
        .map_err(|e| format!("download failed: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("download failed: {e}"))?;

    let installer = std::env::temp_dir().join("nodedesk-sunshine-installer.exe");
    std::fs::write(&installer, &bytes).map_err(|e| e.to_string())?;

    // Upstream installer is NSIS-based: /S = silent (installs service,
    // firewall rules and starts Sunshine).
    let status = std::process::Command::new(&installer)
        .arg("/S")
        .status()
        .map_err(|e| format!("failed to launch Sunshine installer: {e}"))?;
    if !status.success() {
        return Err("Sunshine installer returned an error".into());
    }

    // Wait for the installation to materialize.
    for _ in 0..60 {
        if is_installed() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_secs(2));
    }
    if !is_installed() {
        return Err("Sunshine installer completed but sunshine.exe was not found".into());
    }
    let _ = std::fs::remove_file(&installer);
    Ok(release.tag_name)
}

/// Generates random web-UI credentials and writes them via Sunshine's CLI.
/// Stored in OS secure storage; never logged or exported.
pub fn ensure_credentials() -> Result<(), String> {
    if crate::state::read_secret(CREDS_KEY).is_some() {
        return Ok(());
    }
    let exe = exe_path().ok_or("Sunshine is not installed")?;
    let password = crate::state::random_code(20);
    let status = std::process::Command::new(exe)
        .args(["--creds", FIXED_USER, &password])
        .status()
        .map_err(|e| format!("failed to set Sunshine credentials: {e}"))?;
    if !status.success() {
        return Err("Sunshine rejected credential setup".into());
    }
    crate::state::store_secret(CREDS_KEY, &format!("{FIXED_USER}:{password}"))
}

fn auth_header() -> Result<String, String> {
    let creds = crate::state::read_secret(CREDS_KEY).ok_or("Sunshine credentials not configured")?;
    Ok(format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(creds)
    ))
}

/// Approves a pairing PIN the controller is showing. This is the same call
/// Sunshine's own web UI makes — NodeDesk just removes the web-UI detour.
pub async fn approve_pin(client: &reqwest::Client, pin: &str) -> Result<(), String> {
    let clean: String = pin.chars().filter(|c| c.is_ascii_digit()).collect();
    if clean.len() != 4 {
        return Err("PIN must be the 4 digits shown on the other computer".into());
    }
    let resp = client
        .post(format!("{SUNSHINE_API}/api/pin"))
        .header("Authorization", auth_header()?)
        .json(&serde_json::json!({ "pin": clean }))
        .send()
        .await
        .map_err(|e| format!("cannot reach the Sunshine API: {e}"))?;

    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if body.get("status").and_then(|s| s.as_str()) == Some("true") {
        Ok(())
    } else {
        Err("Sunshine rejected the PIN — check it matches the other computer".into())
    }
}

pub async fn api_reachable(client: &reqwest::Client) -> bool {
    client
        .get(format!("{SUNSHINE_API}/api/config"))
        .header("Authorization", auth_header().unwrap_or_default())
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}
