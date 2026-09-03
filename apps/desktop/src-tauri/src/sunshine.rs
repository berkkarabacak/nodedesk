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

/// Sunshine API base URL — env-overridable so tests can run a mock Sunshine.
fn api_base() -> String {
    std::env::var("NODEDESK_SUNSHINE_API").unwrap_or_else(|_| SUNSHINE_API.to_string())
}
const CREDS_KEY: &str = "sunshine-credentials"; // stored as "user:pass"
const FIXED_USER: &str = "nodedesk";

pub fn exe_path() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = vec![];
    #[cfg(windows)]
    {
        if let Ok(pf) = std::env::var("ProgramFiles") {
            candidates.push(PathBuf::from(pf).join("Sunshine").join("sunshine.exe"));
        }
        candidates.push(PathBuf::from(r"C:\Program Files\Sunshine\sunshine.exe"));
    }
    #[cfg(target_os = "linux")]
    {
        candidates.push(PathBuf::from("/usr/bin/sunshine"));
        candidates.push(PathBuf::from("/usr/local/bin/sunshine"));
    }
    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/Applications/Sunshine.app/Contents/MacOS/Sunshine"));
    }
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

#[cfg(windows)]
pub fn service_running() -> bool {
    run("sc", &["query", "SunshineService"])
        .map(|o| o.contains("RUNNING"))
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
pub fn service_running() -> bool {
    // Upstream ships a systemd user unit on Linux.
    run("systemctl", &["--user", "is-active", "sunshine"])
        .map(|o| o.trim().starts_with("active"))
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
pub fn service_running() -> bool {
    // Sunshine on macOS runs as a user process, not a service.
    run("pgrep", &["-x", "sunshine"])
        .map(|o| !o.trim().is_empty())
        .unwrap_or(false)
}

#[cfg(windows)]
pub fn start_service() -> Result<(), String> {
    let out = run("net", &["start", "SunshineService"])?;
    if service_running() || out.contains("already been started") {
        Ok(())
    } else {
        Err("Sunshine service did not start (try running NodeDesk as administrator once)".into())
    }
}

#[cfg(target_os = "linux")]
pub fn start_service() -> Result<(), String> {
    let _ = run("systemctl", &["--user", "enable", "--now", "sunshine"]);
    if service_running() {
        Ok(())
    } else {
        Err("Sunshine did not start — check `systemctl --user status sunshine`".into())
    }
}

#[cfg(target_os = "macos")]
pub fn start_service() -> Result<(), String> {
    if let Some(exe) = exe_path() {
        std::process::Command::new("open")
            .arg("-a")
            .arg(exe.parent().and_then(|p| p.parent()).unwrap_or(&exe))
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    Err("Sunshine is not installed".into())
}

#[cfg(any(windows, target_os = "linux"))]
#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    assets: Vec<GithubAsset>,
}

#[cfg(any(windows, target_os = "linux"))]
#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

#[cfg(any(windows, target_os = "linux"))]
async fn latest_release(client: &reqwest::Client) -> Result<GithubRelease, String> {
    client
        .get("https://api.github.com/repos/LizardByte/Sunshine/releases/latest")
        .send()
        .await
        .map_err(|e| format!("cannot reach GitHub: {e}"))?
        .json()
        .await
        .map_err(|e| format!("cannot parse Sunshine release info: {e}"))
}

#[cfg(any(windows, target_os = "linux"))]
async fn download_asset(
    client: &reqwest::Client,
    url: &str,
    dest: &std::path::Path,
) -> Result<(), String> {
    // This file gets executed with installer privileges; make sure it is
    // really an upstream Sunshine asset before it lands on disk.
    crate::release::verify_asset_url(url, "LizardByte", "Sunshine")?;
    let bytes = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("download failed: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    std::fs::write(dest, &bytes).map_err(|e| e.to_string())
}

/// Downloads and installs the latest upstream Sunshine release.
pub async fn ensure_installed(client: &reqwest::Client) -> Result<String, String> {
    if is_installed() {
        return Ok("already installed".into());
    }

    #[cfg(windows)]
    {
        let release = latest_release(client).await?;
        let asset = release
            .assets
            .iter()
            .find(|a| {
                let n = a.name.to_lowercase();
                n.contains("windows") && n.contains("installer") && n.ends_with(".exe")
            })
            .ok_or("no Windows installer found in the latest Sunshine release")?;

        let installer = std::env::temp_dir().join("nodedesk-sunshine-installer.exe");
        download_asset(client, &asset.browser_download_url, &installer).await?;

        // Upstream installer is NSIS-based: /S = silent (installs service,
        // firewall rules and starts Sunshine).
        let status = std::process::Command::new(&installer)
            .arg("/S")
            .status()
            .map_err(|e| format!("failed to launch Sunshine installer: {e}"))?;
        if !status.success() {
            return Err("Sunshine installer returned an error".into());
        }

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

    #[cfg(target_os = "linux")]
    {
        // Debian/Ubuntu .deb packages from the upstream release. Other
        // distros: clear instructions instead of a wrong guess.
        let os_release = std::fs::read_to_string("/etc/os-release").unwrap_or_default();
        let version_id = os_release
            .lines()
            .find(|l| l.starts_with("VERSION_ID="))
            .map(|l| l.trim_start_matches("VERSION_ID=").trim_matches('"').to_string())
            .unwrap_or_default();
        let is_deb = os_release.contains("ubuntu") || os_release.contains("debian");
        if !is_deb {
            return Err(
                "Automatic Sunshine install supports Debian/Ubuntu in this release — see docs for other distros"
                    .into(),
            );
        }

        let release = latest_release(client).await?;
        let wanted = format!("ubuntu-{version_id}");
        let asset = release
            .assets
            .iter()
            .find(|a| a.name.to_lowercase().contains(&wanted) && a.name.ends_with(".deb"))
            .or_else(|| {
                release
                    .assets
                    .iter()
                    .find(|a| a.name.to_lowercase().contains("ubuntu") && a.name.ends_with(".deb"))
            })
            .ok_or("no matching Ubuntu package in the latest Sunshine release")?;

        let deb = std::env::temp_dir().join("nodedesk-sunshine.deb");
        download_asset(client, &asset.browser_download_url, &deb).await?;

        // Package install needs root; try non-interactive sudo first.
        let installed = std::process::Command::new("sudo")
            .args(["-n", "apt-get", "install", "-y"])
            .arg(&deb)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        let _ = std::fs::remove_file(&deb);

        if !installed && !is_installed() {
            return Err(
                "Sunshine downloaded but needs root to install — run: sudo apt install <downloaded .deb>"
                    .into(),
            );
        }
        Ok(release.tag_name)
    }

    #[cfg(target_os = "macos")]
    {
        let _ = client; // controller-only: nothing to download
        Err("macOS is controller-only for now — no Sunshine host install".into())
    }
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

/// Normalizes a user-typed PIN: digits only, exactly four.
pub fn clean_pin(pin: &str) -> Option<String> {
    let clean: String = pin.chars().filter(|c| c.is_ascii_digit()).collect();
    if clean.len() == 4 {
        Some(clean)
    } else {
        None
    }
}

/// Approves a pairing PIN the controller is showing. This is the same call
/// Sunshine's own web UI makes — NodeDesk just removes the web-UI detour.
pub async fn approve_pin(client: &reqwest::Client, pin: &str) -> Result<(), String> {
    let clean = clean_pin(pin).ok_or("PIN must be the 4 digits shown on the other computer")?;
    let resp = client
        .post(format!("{}/api/pin", api_base()))
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
        .get(format!("{}/api/config", api_base()))
        .header("Authorization", auth_header().unwrap_or_default())
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pin_cleaning() {
        assert_eq!(clean_pin("1234"), Some("1234".to_string()));
        assert_eq!(clean_pin(" 1 2 3 4 "), Some("1234".to_string()));
        assert_eq!(clean_pin("12-34"), Some("1234".to_string()));
        assert_eq!(clean_pin("123"), None);
        assert_eq!(clean_pin("12345"), None);
        assert_eq!(clean_pin("abcd"), None);
    }
}
