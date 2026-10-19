//! Managed Sunshine host: detection, install, configuration, PIN approval.
//!
//! NodeDesk deploys an unmodified upstream Sunshine build and drives its
//! documented interfaces (config CLI + local HTTPS API). Nothing here weakens
//! upstream security: pairing still requires the host user to type the PIN,
//! and the API credentials are machine-local secrets in OS secure storage.

use base64::Engine;
// Only the gated release structs derive it.
#[cfg(any(windows, target_os = "linux"))]
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

/// Sunshine `POST /api/config` replaces the whole config file with the keys
/// in the body. This keeps every existing key and only flips the input
/// switches. `status`, `platform`, and `version` are response metadata and
/// must not be written back.
pub fn config_with_input(current: &serde_json::Value, allow_input: bool) -> Result<serde_json::Value, String> {
    let obj = current.as_object().ok_or("Sunshine config was not an object")?;
    let mut out = serde_json::Map::new();
    for (key, value) in obj {
        if matches!(key.as_str(), "status" | "platform" | "version") {
            continue;
        }
        out.insert(key.clone(), value.clone());
    }
    let flag = serde_json::Value::Bool(allow_input);
    out.insert("mouse".into(), flag.clone());
    out.insert("keyboard".into(), flag.clone());
    out.insert("controller".into(), flag);
    Ok(serde_json::Value::Object(out))
}

/// UUIDs from `GET /api/clients/list`. Missing or malformed entries are skipped.
#[cfg(test)]
pub fn client_uuids(list: &serde_json::Value) -> Vec<String> {
    list.get("named_certs")
        .and_then(|v| v.as_array())
        .map(|certs| {
            certs
                .iter()
                .filter_map(|cert| cert.get("uuid").and_then(|u| u.as_str()).map(|s| s.to_string()))
                .filter(|uuid| !uuid.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

async fn api_json(
    client: &reqwest::Client,
    method: reqwest::Method,
    path: &str,
    body: Option<&serde_json::Value>,
    auth: &str,
) -> Result<serde_json::Value, String> {
    let mut request = client
        .request(method, format!("{}{path}", api_base()))
        .header("Authorization", auth);
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("cannot reach the host service: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("the host service refused {path}"));
    }
    response.json().await.map_err(|e| e.to_string())
}

/// Turn remote keyboard, mouse, and gamepad input off or on.
///
/// Sunshine applies `mouse` / `keyboard` / `controller` from its config at
/// startup, so a change is followed by a restart. The previous values are
/// kept beside the app config (not in settings.json) so a view-only session
/// can be undone. Fails closed: a partial config is never posted.
pub async fn set_remote_input(client: &reqwest::Client, config_dir: &std::path::Path, allow_input: bool) -> Result<(), String> {
    let auth = auth_header()?;
    set_remote_input_with(client, config_dir, allow_input, &auth).await
}

pub async fn set_remote_input_with(
    client: &reqwest::Client,
    config_dir: &std::path::Path,
    allow_input: bool,
    auth: &str,
) -> Result<(), String> {
    let current = api_json(client, reqwest::Method::GET, "/api/config", None, auth).await?;
    if !allow_input {
        let snapshot = serde_json::json!({
            "mouse": current.get("mouse").cloned().unwrap_or(serde_json::Value::Bool(true)),
            "keyboard": current.get("keyboard").cloned().unwrap_or(serde_json::Value::Bool(true)),
            "controller": current.get("controller").cloned().unwrap_or(serde_json::Value::Bool(true)),
        });
        let _ = std::fs::create_dir_all(config_dir);
        std::fs::write(config_dir.join("input-gate.json"), snapshot.to_string()).map_err(|e| e.to_string())?;
    }
    let body = if allow_input {
        if let Ok(text) = std::fs::read_to_string(config_dir.join("input-gate.json")) {
            if let Ok(saved) = serde_json::from_str::<serde_json::Value>(&text) {
                let mut merged = config_with_input(&current, true)?;
                if let Some(obj) = merged.as_object_mut() {
                    for key in ["mouse", "keyboard", "controller"] {
                        if let Some(value) = saved.get(key) {
                            obj.insert(key.to_string(), value.clone());
                        }
                    }
                }
                let _ = std::fs::remove_file(config_dir.join("input-gate.json"));
                merged
            } else {
                config_with_input(&current, true)?
            }
        } else {
            // Nothing was gated. Don't restart the host just to rewrite config.
            return Ok(());
        }
    } else {
        config_with_input(&current, false)?
    };
    let _ = api_json(client, reqwest::Method::POST, "/api/config", Some(&body), auth).await?;
    let _ = api_json(
        client,
        reqwest::Method::POST,
        "/api/restart",
        Some(&serde_json::json!({})),
        auth,
    )
    .await?;
    Ok(())
}

/// Drop every paired streaming client so an old pairing cannot keep sending
/// input after a revoke, sign-out, or session end (APPROVAL-05 bypass).
pub async fn unpair_all(client: &reqwest::Client) -> Result<(), String> {
    let auth = auth_header()?;
    unpair_all_with(client, &auth).await
}

pub async fn unpair_all_with(client: &reqwest::Client, auth: &str) -> Result<(), String> {
    let _ = api_json(
        client,
        reqwest::Method::POST,
        "/api/clients/unpair-all",
        Some(&serde_json::json!({})),
        auth,
    )
    .await?;
    Ok(())
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

    #[test]
    fn input_config_preserves_unrelated_keys_and_drops_metadata() {
        let current = serde_json::json!({
            "status": true,
            "platform": "linux",
            "version": "0.23.0",
            "port": 47989,
            "mouse": true,
            "keyboard": true,
            "controller": true,
            "encoder": "nvenc"
        });
        let body = config_with_input(&current, false).unwrap();
        assert!(body.get("status").is_none());
        assert!(body.get("platform").is_none());
        assert!(body.get("version").is_none());
        assert_eq!(body["port"], 47989);
        assert_eq!(body["encoder"], "nvenc");
        assert_eq!(body["mouse"], false);
        assert_eq!(body["keyboard"], false);
        assert_eq!(body["controller"], false);
    }

    #[test]
    fn client_uuids_reads_the_paired_list() {
        let list = serde_json::json!({
            "status": true,
            "named_certs": [
                { "uuid": "abc", "name": "Odin" },
                { "name": "missing" },
                { "uuid": "", "name": "blank" }
            ]
        });
        assert_eq!(client_uuids(&list), vec!["abc".to_string()]);
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn view_only_posts_the_full_config_and_unpair_is_explicit() {
        use std::sync::{Arc, Mutex};

        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let record = seen.clone();
        let app = axum::Router::new()
            .route(
                "/api/config",
                axum::routing::get(|| async {
                    axum::Json(serde_json::json!({
                        "status": true,
                        "platform": "linux",
                        "version": "test",
                        "encoder": "software",
                        "mouse": true,
                        "keyboard": true,
                        "controller": true
                    }))
                })
                .post(move |axum::Json(body): axum::Json<serde_json::Value>| {
                    let record = record.clone();
                    async move {
                        record.lock().unwrap().push(body.to_string());
                        axum::Json(serde_json::json!({ "status": true }))
                    }
                }),
            )
            .route(
                "/api/restart",
                axum::routing::post({
                    let seen = seen.clone();
                    move || {
                        let seen = seen.clone();
                        async move {
                            seen.lock().unwrap().push("restart".into());
                            axum::Json(serde_json::json!({ "status": true }))
                        }
                    }
                }),
            )
            .route(
                "/api/clients/unpair-all",
                axum::routing::post({
                    let seen = seen.clone();
                    move || {
                        let seen = seen.clone();
                        async move {
                            seen.lock().unwrap().push("unpair-all".into());
                            axum::Json(serde_json::json!({ "status": true }))
                        }
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let _env = crate::state::testenv::lock();
        std::env::set_var("NODEDESK_SUNSHINE_API", format!("http://{addr}"));
        let dir = std::env::temp_dir().join("nodedesk-input-gate-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let client = reqwest::Client::new();
        set_remote_input_with(&client, &dir, false, "Basic dGVzdA==")
            .await
            .unwrap();
        let posted = seen.lock().unwrap().clone();
        let config_post = posted.iter().find(|line| line.contains("encoder")).expect("config posted");
        assert!(config_post.contains("\"encoder\":\"software\""));
        assert!(config_post.contains("\"mouse\":false"));
        assert!(!config_post.contains("platform"));
        assert!(posted.iter().any(|line| line == "restart"));
        unpair_all_with(&client, "Basic dGVzdA==").await.unwrap();
        assert!(seen.lock().unwrap().iter().any(|line| line == "unpair-all"));
        std::env::remove_var("NODEDESK_SUNSHINE_API");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
