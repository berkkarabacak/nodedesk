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
        candidates.push(PathBuf::from(
            "/Applications/Sunshine.app/Contents/MacOS/Sunshine",
        ));
    }
    candidates.into_iter().find(|p| p.exists())
}

pub fn is_installed() -> bool {
    exe_path().is_some()
}

fn run(cmd: &str, args: &[&str]) -> Result<String, String> {
    let out = crate::procutil::hidden_command(cmd)
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
    // Already running: do not call `net start`. That command needs an
    // administrator token when the service is stopped, and asking the user to
    // relaunch NodeDesk elevated popped a UAC prompt for the whole app.
    if service_running() {
        return Ok(());
    }
    let out = run("net", &["start", "SunshineService"]).unwrap_or_default();
    if service_running() || out.contains("already been started") {
        Ok(())
    } else {
        Err("The host service did not start. Try setup again from this screen.".into())
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
        crate::procutil::hidden_command("open")
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

/// Windows Installer code for "success, reboot required". `/norestart` still
/// returns this when the package asked for a reboot.
#[cfg_attr(not(windows), allow(dead_code))]
const MSI_EXIT_SUCCESS_REBOOT: i32 = 3010;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
enum HostInstallerKind {
    Exe,
    Msi,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
struct HostInstaller<'a> {
    name: &'a str,
    kind: HostInstallerKind,
}

#[cfg_attr(not(windows), allow(dead_code))]
fn is_explicit_arm(name: &str) -> bool {
    let n = name.to_lowercase();
    n.contains("arm64") || n.contains("aarch64")
}

#[cfg_attr(not(windows), allow(dead_code))]
fn is_explicit_amd64(name: &str) -> bool {
    let n = name.to_lowercase();
    n.contains("amd64") || n.contains("x86_64") || n.contains("x64")
}

/// `windows` + `installer` + `.msi` or `.exe` only. Zips, debug symbols, and
/// packages for other operating systems stay out. An asset that names the
/// other CPU architecture is skipped so an AMD64 PC does not receive the
/// ARM64 package when both are published.
#[cfg_attr(not(windows), allow(dead_code))]
fn select_windows_host_installer<'a>(names: &[&'a str], host_arch: &str) -> Option<HostInstaller<'a>> {
    let wants_arm = host_arch == "aarch64";
    names
        .iter()
        .filter_map(|name| {
            let n = name.to_lowercase();
            if !n.contains("windows") || !n.contains("installer") {
                return None;
            }
            let kind = if n.ends_with(".msi") {
                HostInstallerKind::Msi
            } else if n.ends_with(".exe") {
                HostInstallerKind::Exe
            } else {
                return None;
            };
            let arm = is_explicit_arm(name);
            let amd = is_explicit_amd64(name);
            let arch_rank = if wants_arm {
                if arm {
                    2
                } else if amd {
                    return None;
                } else {
                    1
                }
            } else if amd {
                2
            } else if arm {
                return None;
            } else {
                1
            };
            // Current upstream releases ship an MSI. Prefer it when an older
            // `.exe` installer is also attached to the same release.
            let kind_rank = if kind == HostInstallerKind::Msi { 2 } else { 1 };
            Some((arch_rank, kind_rank, HostInstaller { name, kind }))
        })
        .max_by_key(|(arch_rank, kind_rank, _)| (*arch_rank, *kind_rank))
        .map(|(_, _, choice)| choice)
}

/// Quiet MSI install. One elevated `msiexec` shows the consent dialog;
/// `/quiet` keeps the installer UI from appearing after that.
#[cfg_attr(not(windows), allow(dead_code))]
fn msi_quiet_args(package: &std::path::Path) -> Vec<String> {
    vec![
        "/i".into(),
        package.to_string_lossy().into_owned(),
        "/quiet".into(),
        "/norestart".into(),
    ]
}

#[cfg(windows)]
fn msiexec_path() -> PathBuf {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    PathBuf::from(root).join("System32").join("msiexec.exe")
}

/// Downloads and installs the latest upstream Sunshine release.
pub async fn ensure_installed(client: &reqwest::Client) -> Result<String, String> {
    if is_installed() {
        return Ok("already installed".into());
    }

    #[cfg(windows)]
    {
        let release = latest_release(client).await?;
        let names: Vec<&str> = release.assets.iter().map(|a| a.name.as_str()).collect();
        let choice = select_windows_host_installer(&names, std::env::consts::ARCH)
            .ok_or("Could not find a Windows installer for the host service.")?;
        let asset = release
            .assets
            .iter()
            .find(|a| a.name == choice.name)
            .ok_or("Could not find a Windows installer for the host service.")?;

        // Fixed local name. The remote asset name must not become the path.
        let installer = match choice.kind {
            HostInstallerKind::Msi => std::env::temp_dir().join("nodedesk-sunshine-installer.msi"),
            HostInstallerKind::Exe => std::env::temp_dir().join("nodedesk-sunshine-installer.exe"),
        };
        download_asset(client, &asset.browser_download_url, &installer).await?;

        // One consent dialog for this installer only. NodeDesk itself stays
        // unelevated. Current releases are an MSI (`msiexec /quiet`). Older
        // releases attached an NSIS `.exe` that understands `/S`.
        let launched = match choice.kind {
            HostInstallerKind::Exe => crate::procutil::run_elevated_wait(&installer, &["/S"], true),
            HostInstallerKind::Msi => {
                let args = msi_quiet_args(&installer);
                let refs: Vec<&str> = args.iter().map(String::as_str).collect();
                crate::procutil::run_elevated_wait_codes(
                    &msiexec_path(),
                    &refs,
                    true,
                    &[MSI_EXIT_SUCCESS_REBOOT],
                )
            }
        };
        if let Err(err) = launched {
            let _ = std::fs::remove_file(&installer);
            return Err(err);
        }

        for _ in 0..60 {
            if is_installed() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
        if !is_installed() {
            return Err(
                "The installer finished, but the host service was not found on this computer."
                    .into(),
            );
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
            .map(|l| {
                l.trim_start_matches("VERSION_ID=")
                    .trim_matches('"')
                    .to_string()
            })
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
        let installed = crate::procutil::hidden_command("sudo")
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
    // `--creds` returns before the host UI starts. Hide the console anyway:
    // the Windows build is a console-subsystem binary and would otherwise
    // flash a window on the GUI app.
    let status = crate::procutil::hidden_command(exe)
        .args(["--creds", FIXED_USER, &password])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|_| "Could not secure the host service.".to_string())?;
    if !status.success() {
        return Err("Could not secure the host service.".into());
    }
    crate::state::store_secret(CREDS_KEY, &format!("{FIXED_USER}:{password}"))
}

fn auth_header() -> Result<String, String> {
    let creds =
        crate::state::read_secret(CREDS_KEY).ok_or("Sunshine credentials not configured")?;
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

/// Sunshine v2026.914.233613 `pairing_id`: 32 hexadecimal characters.
const PAIRING_ID_LEN: usize = 32;
/// `nvhttp::is_valid_pairing_name`: 1 to 128 bytes.
const MAX_PAIRING_NAME_BYTES: usize = 128;

/// One client waiting on `GET /api/pin`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingPairing {
    id: String,
    name: String,
}

fn is_pairing_id(id: &str) -> bool {
    id.len() == PAIRING_ID_LEN && id.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Client name stored with the pair. Empty names are rejected by current
/// Sunshine, so a missing name becomes a short placeholder.
fn pairing_client_name(raw: &str) -> String {
    let trimmed = raw.trim();
    let source = if trimmed.is_empty() { "Controller" } else { trimmed };
    let mut end = source.len().min(MAX_PAIRING_NAME_BYTES);
    while end > 0 && !source.is_char_boundary(end) {
        end -= 1;
    }
    if end == 0 {
        "Controller".to_string()
    } else {
        source[..end].to_string()
    }
}

fn parse_pending_pairings(body: &serde_json::Value) -> Vec<PendingPairing> {
    let Some(items) = body.get("pairings").and_then(|p| p.as_array()) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let id = item.get("id").and_then(|v| v.as_str())?;
            if !is_pairing_id(id) {
                return None;
            }
            let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
            Some(PendingPairing {
                id: id.to_string(),
                name: pairing_client_name(name),
            })
        })
        .collect()
}

/// A wrong `pairing_id` fails that client's handshake, so never guess.
fn choose_pending_pairing(pairings: &[PendingPairing]) -> Result<PendingPairing, String> {
    match pairings {
        [] => Err(
            "No computer is waiting to pair. Start pairing on the other computer, then enter the PIN it shows."
                .into(),
        ),
        [only] => Ok(only.clone()),
        many => {
            let names = many
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            Err(format!(
                "More than one computer is waiting ({names}). Cancel the extra request, then approve this PIN."
            ))
        }
    }
}

/// Body for current `POST /api/pin`: pairing id, four-digit PIN, and client name.
fn pin_request_body(pin: &str, pairing: &PendingPairing) -> Result<serde_json::Value, String> {
    let clean = clean_pin(pin).ok_or("PIN must be the 4 digits shown on the other computer")?;
    if !is_pairing_id(&pairing.id) {
        return Err(
            "The waiting pairing is not valid. Start pairing again on the other computer.".into(),
        );
    }
    Ok(serde_json::json!({
        "pairing_id": pairing.id,
        "pin": clean,
        "name": pairing_client_name(&pairing.name),
    }))
}

/// Current Sunshine returns `{"status":true}` (a boolean). Older builds used
/// the string `"true"`. Either one means the handshake finished.
fn pin_response_ok(body: &serde_json::Value) -> bool {
    match body.get("status") {
        Some(status) if status.as_bool() == Some(true) => true,
        Some(status) if status.as_str() == Some("true") => true,
        _ => false,
    }
}

/// Approves a pairing PIN the controller is showing.
///
/// Current Sunshine (`POST /api/pin`) rejects a PIN-only body. It needs the
/// `pairing_id` from `GET /api/pin` plus the client name, then holds the POST
/// open until the controller finishes the handshake.
pub async fn approve_pin(client: &reqwest::Client, pin: &str) -> Result<(), String> {
    // Fail before talking to the host when the typed PIN cannot be valid.
    let _ = clean_pin(pin).ok_or("PIN must be the 4 digits shown on the other computer")?;
    let auth = auth_header()?;
    let base = api_base();

    let listed = client
        .get(format!("{base}/api/pin"))
        .header("Authorization", &auth)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("cannot reach the host service: {e}"))?;
    if !listed.status().is_success() {
        return Err("The host service did not list the computer waiting to pair.".into());
    }
    let listed_body: serde_json::Value = listed.json().await.map_err(|e| e.to_string())?;
    let pairing = choose_pending_pairing(&parse_pending_pairings(&listed_body))?;
    let body = pin_request_body(pin, &pairing)?;

    // The host keeps this request open until the other computer finishes
    // pairing (Sunshine's ping timeout). Do not send Origin or Referer:
    // those headers turn on the web UI's CSRF check.
    let resp = client
        .post(format!("{base}/api/pin"))
        .header("Authorization", auth)
        .json(&body)
        .timeout(std::time::Duration::from_secs(90))
        .send()
        .await
        .map_err(|e| format!("cannot reach the host service: {e}"))?;
    let resp_body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if pin_response_ok(&resp_body) {
        Ok(())
    } else {
        Err("The host rejected the PIN — check it matches the other computer.".into())
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
    fn selects_the_current_sunshine_windows_msi() {
        // Asset names from LizardByte/Sunshine v2026.914.233613. The release
        // has no `.exe` installer; an `.exe`-only matcher skips the install.
        let assets = [
            "Sunshine-Windows-AMD64-debuginfo.7z",
            "Sunshine-Windows-AMD64-installer.msi",
            "Sunshine-Windows-AMD64-lite.zip",
            "Sunshine-Windows-ARM64-debuginfo.7z",
            "Sunshine-Windows-ARM64-installer.msi",
            "Sunshine-Windows-ARM64-lite.zip",
            "sunshine_2026.914.233613-1+ubuntu24.04_amd64.deb",
        ];
        let choice = select_windows_host_installer(&assets, "x86_64").unwrap();
        assert_eq!(choice.name, "Sunshine-Windows-AMD64-installer.msi");
        assert_eq!(choice.kind, HostInstallerKind::Msi);

        let arm = select_windows_host_installer(&assets, "aarch64").unwrap();
        assert_eq!(arm.name, "Sunshine-Windows-ARM64-installer.msi");
    }

    #[test]
    fn still_selects_a_legacy_windows_exe_installer() {
        let assets = [
            "sunshine-windows-installer.exe",
            "Sunshine-Windows-AMD64-lite.zip",
        ];
        let choice = select_windows_host_installer(&assets, "x86_64").unwrap();
        assert_eq!(choice.name, "sunshine-windows-installer.exe");
        assert_eq!(choice.kind, HostInstallerKind::Exe);
    }

    #[test]
    fn prefers_msi_and_ignores_non_installers() {
        let assets = [
            "sunshine-windows-installer.exe",
            "Sunshine-Windows-AMD64-installer.msi",
            "windows-something.exe",
            "Sunshine-Windows-AMD64-lite.zip",
        ];
        let choice = select_windows_host_installer(&assets, "x86_64").unwrap();
        assert_eq!(choice.name, "Sunshine-Windows-AMD64-installer.msi");
        assert!(select_windows_host_installer(
            &["Sunshine-Windows-AMD64-lite.zip", "not-an-installer.msi"],
            "x86_64"
        )
        .is_none());
    }

    #[test]
    fn does_not_install_the_other_cpu_architecture() {
        let only_arm = ["Sunshine-Windows-ARM64-installer.msi"];
        assert!(select_windows_host_installer(&only_arm, "x86_64").is_none());
        let only_amd = ["Sunshine-Windows-AMD64-installer.msi"];
        assert!(select_windows_host_installer(&only_amd, "aarch64").is_none());
    }

    #[test]
    fn msi_install_is_quiet_and_does_not_reboot() {
        let args = msi_quiet_args(std::path::Path::new(
            r"C:\Users\Berk\AppData\Local\Temp\nodedesk-sunshine-installer.msi",
        ));
        assert_eq!(
            args,
            vec![
                "/i",
                r"C:\Users\Berk\AppData\Local\Temp\nodedesk-sunshine-installer.msi",
                "/quiet",
                "/norestart",
            ]
        );
    }

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
    fn current_pin_request_includes_pairing_id_and_name() {
        // Shape of POST /api/pin on Sunshine v2026.914.233613. A body of
        // `{"pin":"1234"}` is rejected before the handshake starts.
        let pairing = PendingPairing {
            id: "0123456789abcdef0123456789abcdef".into(),
            name: "HD2".into(),
        };
        let body = pin_request_body("12 34", &pairing).unwrap();
        assert_eq!(body["pairing_id"], "0123456789abcdef0123456789abcdef");
        assert_eq!(body["pin"], "1234");
        assert_eq!(body["name"], "HD2");
        assert!(body.get("pin").is_some());
        assert_eq!(body.as_object().unwrap().len(), 3);
        assert!(pin_request_body("1234", &PendingPairing {
            id: "short".into(),
            name: "HD2".into(),
        })
        .is_err());
    }

    #[test]
    fn boolean_status_true_means_the_pair_finished() {
        // Live response is a JSON boolean, not the string "true".
        assert!(pin_response_ok(&serde_json::json!({ "status": true })));
        assert!(pin_response_ok(&serde_json::json!({ "status": "true" })));
        assert!(!pin_response_ok(&serde_json::json!({ "status": false })));
        assert!(!pin_response_ok(&serde_json::json!({ "status": "false" })));
        assert!(!pin_response_ok(&serde_json::json!({})));
    }

    #[test]
    fn selects_the_single_waiting_client_from_get_pin() {
        let body = serde_json::json!({
            "pairings": [{
                "id": "0123456789abcdef0123456789abcdef",
                "name": "HD2",
                "address": "192.168.1.20"
            }]
        });
        let choice = choose_pending_pairing(&parse_pending_pairings(&body)).unwrap();
        assert_eq!(choice.id, "0123456789abcdef0123456789abcdef");
        assert_eq!(choice.name, "HD2");
        let posted = pin_request_body("1234", &choice).unwrap();
        assert_eq!(posted["pairing_id"], choice.id);
        assert_eq!(posted["name"], "HD2");
    }

    #[test]
    fn ignores_ids_that_are_not_32_hex_digits() {
        let body = serde_json::json!({
            "pairings": [{ "id": "not-a-pairing-id", "name": "HD2" }]
        });
        assert!(parse_pending_pairings(&body).is_empty());
        assert!(choose_pending_pairing(&[]).is_err());
    }

    #[test]
    fn does_not_guess_when_two_clients_are_waiting() {
        let pending = vec![
            PendingPairing {
                id: "0123456789abcdef0123456789abcdef".into(),
                name: "HD2".into(),
            },
            PendingPairing {
                id: "fedcba9876543210fedcba9876543210".into(),
                name: "Other".into(),
            },
        ];
        let err = choose_pending_pairing(&pending).unwrap_err();
        assert!(err.contains("HD2"));
        assert!(err.contains("Other"));
    }
}
