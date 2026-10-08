//! NodeDesk desktop shell — Rust core and Tauri command surface.
//!
//! v1.0: the app orchestrates real upstream components (managed Sunshine host,
//! Moonlight-Qt controller) plus its own discovery, metrics agent, power
//! actions and Wake-on-LAN. Streaming, codecs and clipboard sync are handled
//! by Sunshine/Moonlight themselves — NodeDesk automates everything around
//! them. Security model: docs/security.md.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod auth;
mod client;
mod discovery;
mod files;
mod files_queue;
mod google_auth;
mod headless;
mod monitor;
mod moonlight;
mod release;
mod safepath;
mod state;
mod sunshine;
mod terminal;
mod tls;
mod update;
mod wol;

#[cfg(test)]
mod sim_test;

use serde::Serialize;
use state::{AppState, Settings};
use tauri::{AppHandle, Emitter, Manager, State};

const ACCESS_CODE_KEY: &str = "host-access-code";

fn ensure_access_code() -> String {
    state::read_secret(ACCESS_CODE_KEY).unwrap_or_else(|| {
        let code = state::random_code(state::ACCESS_CODE_LEN);
        let _ = state::store_secret(ACCESS_CODE_KEY, &code);
        code
    })
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    onboarded: bool,
    mode: String,
    sunshine_installed: bool,
    sunshine_running: bool,
    moonlight_present: bool,
    host_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ComputerDto {
    id: String,
    name: String,
    os: String,
    address: String,
    via: String,
    online: bool,
    specs: String,
    cpu_pct: Option<u8>,
    gpu_pct: Option<u8>,
    gpu_name: Option<String>,
    ram_used_gb: Option<f32>,
    ram_total_gb: Option<f32>,
    vram_used_gb: Option<f32>,
    vram_total_gb: Option<f32>,
    uptime: Option<String>,
    mac: Option<String>,
    has_access_code: bool,
    services: Vec<monitor::AiService>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsItem {
    label: String,
    ok: bool,
    detail: Option<String>,
}

fn fmt_uptime(secs: u64) -> String {
    let days = secs / 86_400;
    let hours = (secs % 86_400) / 3600;
    if days > 0 {
        format!("{days} d {hours} h")
    } else {
        format!("{hours} h {} m", (secs % 3600) / 60)
    }
}

fn dto_from_metrics(m: &monitor::Metrics, address: &str, via: &str, has_code: bool) -> ComputerDto {
    let specs = match &m.gpu {
        Some(g) => format!("{} · {} GB RAM", g.name, m.ram_total_gb),
        None => format!("{} GB RAM", m.ram_total_gb),
    };
    ComputerDto {
        id: address.to_string(),
        name: m.host_name.clone(),
        os: m.os.clone(),
        address: address.to_string(),
        via: via.to_string(),
        online: true,
        specs,
        cpu_pct: Some(m.cpu_pct),
        gpu_pct: m.gpu.as_ref().map(|g| g.utilization_pct),
        gpu_name: m.gpu.as_ref().map(|g| g.name.clone()),
        ram_used_gb: Some(m.ram_used_gb),
        ram_total_gb: Some(m.ram_total_gb),
        vram_used_gb: m.gpu.as_ref().map(|g| (g.vram_used_mb as f32 / 1024.0 * 10.0).round() / 10.0),
        vram_total_gb: m.gpu.as_ref().map(|g| (g.vram_total_mb as f32 / 1024.0).round()),
        uptime: Some(fmt_uptime(m.uptime_secs)),
        mac: m.mac.clone(),
        has_access_code: has_code,
        services: m.services.clone(),
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_app_info(state: State<'_, AppState>) -> AppInfo {
    let settings = state.settings.read().map(|s| s.clone()).unwrap_or_default();
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        onboarded: settings.onboarded,
        mode: settings.mode,
        sunshine_installed: sunshine::is_installed(),
        sunshine_running: sunshine::service_running(),
        moonlight_present: moonlight::moonlight_exe(&state.config_dir).is_some(),
        host_name: sysinfo::System::host_name().unwrap_or_else(|| "Computer".into()),
    }
}

#[tauri::command]
async fn complete_onboarding(app: AppHandle, state: State<'_, AppState>, mode: String) -> Result<(), String> {
    {
        let mut settings = state.settings.write().map_err(|e| e.to_string())?;
        settings.mode = mode.clone();
        settings.onboarded = true;
    }
    state.save_settings();
    set_autostart(state.settings.read().map(|s| s.start_on_boot).unwrap_or(true));

    if mode == "host" || mode == "both" {
        // Host capability: start agent now, bootstrap Sunshine in background.
        let code = ensure_access_code();
        let identity = tls::load_or_create(&state.config_dir)?;
        tauri::async_runtime::spawn(agent::run(code, identity));
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = app2.emit("bootstrap-progress", "Installing Sunshine host…");
            let state2 = app2.state::<AppState>();
            let result = sunshine::ensure_installed(&state2.http).await;
            match result {
                Ok(tag) => {
                    let _ = app2.emit("bootstrap-progress", format!("Sunshine ready ({tag})"));
                    let _ = app2.emit("bootstrap-progress", "Securing host…".to_string());
                    let creds = sunshine::ensure_credentials();
                    if let Err(e) = creds {
                        let _ = app2.emit("bootstrap-error", e);
                        return;
                    }
                    let started = sunshine::start_service();
                    if let Err(e) = started {
                        let _ = app2.emit("bootstrap-error", e);
                        return;
                    }
                    let _ = app2.emit("bootstrap-done", true);
                }
                Err(e) => {
                    let _ = app2.emit("bootstrap-error", e);
                }
            }
        });
    } else {
        let _ = app.emit("bootstrap-done", true);
    }
    Ok(())
}

#[tauri::command]
async fn bootstrap_host(app: AppHandle) -> Result<(), String> {
    // Retry path identical to the onboarding background task.
    let _ = app.emit("bootstrap-progress", "Installing Sunshine host…".to_string());
    let state = app.state::<AppState>();
    let tag = sunshine::ensure_installed(&state.http).await?;
    let _ = app.emit("bootstrap-progress", format!("Sunshine ready ({tag})"));
    sunshine::ensure_credentials()?;
    sunshine::start_service()?;
    let _ = app.emit("bootstrap-done", true);
    Ok(())
}

#[tauri::command]
async fn list_computers(state: State<'_, AppState>) -> Result<Vec<ComputerDto>, String> {
    let settings = state.settings.read().map(|s| s.clone()).unwrap_or_default();

    // 1) LAN broadcast scan (blocking sockets → blocking thread).
    let lan = tauri::async_runtime::spawn_blocking(|| discovery::scan(800))
        .await
        .unwrap_or_default();

    // 2) Tailscale peers (if any).
    let mut candidates = lan;
    if settings.tailscale_enabled {
        for peer in discovery::tailscale_peers() {
            if !candidates.iter().any(|c| c.address == peer.address) {
                candidates.push(peer);
            }
        }
    }

    // 3) Manually added hosts.
    for manual in &settings.manual_hosts {
        if !candidates.iter().any(|c| c.address == manual.address) {
            candidates.push(discovery::FoundHost {
                name: manual.name.clone(),
                os: "unknown".into(),
                address: manual.address.clone(),
                via: "manual".into(),
            });
        }
    }

    // 4) Probe agents; metrics require the stored access code.
    let mut out: Vec<ComputerDto> = vec![];
    for host in candidates {
        let code = state::code_for_host(&state, &host.address);
        let metrics = match &code {
            Some(code) => fetch_metrics(&state.http, &host.address, code).await,
            None => None,
        };
        let present = metrics.is_some() || discovery::agent_present(&state.http, &host.address).await;
        match metrics {
            Some(m) => out.push(dto_from_metrics(&m, &host.address, &host.via, true)),
            None => {
                let manual = settings
                    .manual_hosts
                    .iter()
                    .find(|h| h.address == host.address);
                out.push(ComputerDto {
                    id: host.address.clone(),
                    name: host.name.clone(),
                    os: host.os.clone(),
                    address: host.address.clone(),
                    via: host.via.clone(),
                    online: present,
                    specs: manual
                        .map(|_| "Added manually".to_string())
                        .unwrap_or_else(|| "Found on network".to_string()),
                    cpu_pct: None,
                    gpu_pct: None,
                    gpu_name: None,
                    ram_used_gb: None,
                    ram_total_gb: None,
                    vram_used_gb: None,
                    vram_total_gb: None,
                    uptime: None,
                    mac: manual.and_then(|h| h.mac.clone()),
                    has_access_code: code.is_some(),
                    services: vec![],
                })
            }
        }
    }
    Ok(out)
}

async fn fetch_metrics(client: &reqwest::Client, address: &str, code: &str) -> Option<monitor::Metrics> {
    client::AgentRequest::get(address, discovery::agent_port(), "/metrics")
        .timeout(std::time::Duration::from_millis(1500))
        .send_ok(client, code)
        .await
        .ok()?
        .json()
        .await
        .ok()
}

#[tauri::command]
async fn add_manual_host(state: State<'_, AppState>, address: String, code: String) -> Result<String, String> {
    let metrics = fetch_metrics(&state.http, &address, &code)
        .await
        .ok_or("Can't reach a NodeDesk host at that address — check the address and access code")?;
    state::store_host_code(&address, &code)?;
    let mut settings = state.settings.write().map_err(|e| e.to_string())?;
    if !settings.manual_hosts.iter().any(|h| h.address == address) {
        settings.manual_hosts.push(state::ManualHost {
            name: metrics.host_name.clone(),
            address: address.clone(),
            mac: metrics.mac.clone(),
        });
    }
    drop(settings);
    state.save_settings();
    Ok(metrics.host_name)
}

/// Forgets a computer: deletes its stored access code and removes it from the
/// saved list. Without this there is no way to revoke a code once shared.
#[tauri::command]
fn forget_host(state: State<'_, AppState>, address: String) -> Result<(), String> {
    state::forget_host_code(&address)?;
    client::clear_pinned_cert(&address, discovery::agent_port());
    {
        let mut settings = state.settings.write().map_err(|e| e.to_string())?;
        settings.manual_hosts.retain(|h| h.address != address);
        settings.legacy_host_codes.remove(&address);
    }
    state.save_settings();
    Ok(())
}

#[tauri::command]
async fn approve_pairing(state: State<'_, AppState>, pin: String) -> Result<(), String> {
    sunshine::approve_pin(&state.http_local, &pin).await
}

#[tauri::command]
async fn pair_computer(app: AppHandle, address: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let exe = moonlight::ensure_available(&state.http, &state.config_dir).await?;
    moonlight::pair(app, exe, address).await
}

#[tauri::command]
async fn connect_computer(app: AppHandle, address: String, quality: Option<String>) -> Result<(), String> {
    let state = app.state::<AppState>();
    let exe = moonlight::ensure_available(&state.http, &state.config_dir).await?;
    let mut settings = state.settings.read().map(|s| s.clone()).unwrap_or_default();
    // Per-session quality override (TOOLBAR-03): the external viewer only
    // accepts stream parameters at launch, so an override applies to THIS
    // launch without touching the persisted default.
    if let Some(preset) = quality.as_deref() {
        match preset {
            "speed" => {
                settings.codec = "h264".into();
                settings.bitrate_mbps = 15;
                settings.fps = 60;
                settings.resolution = "1080p".into();
                settings.hdr = false;
            }
            "balanced" => {
                settings.codec = "auto".into();
                settings.bitrate_mbps = 40;
                settings.fps = 60;
                settings.resolution = "auto".into();
            }
            "quality" => {
                settings.codec = "auto".into();
                settings.bitrate_mbps = 80;
                settings.fps = 60;
                settings.resolution = "auto".into();
            }
            _ => {} // "auto": use the persisted default as-is
        }
    }
    moonlight::start_stream(&state, exe, &settings, &address)?;
    // Process spawn is NOT session readiness (SESSION-02): this event means
    // the external viewer process started. True stream-readiness detection is
    // the documented native spike (docs/ui-redesign/NATIVE_SPIKE.md).
    let _ = app.emit("stream-started", &address);
    moonlight::watch_stream(app.clone());
    Ok(())
}

/// Accessible displays on the local machine. Used for the session toolbar's
/// monitor panel; a remote-aware version is part of the embedded-viewer
/// milestone. Never fabricates entries (TOOLBAR-02).
#[tauri::command]
fn session_list_displays(_device_id: String) -> Vec<serde_json::Value> {
    // sysinfo does not enumerate displays; the interim external viewer shows
    // the host's primary display. Report exactly that one real capability.
    vec![serde_json::json!({ "index": 1, "resolution": "primary display", "primary": true })]
}

/// Live session measurements. The external viewer exposes no metrics channel
/// to NodeDesk, so there is nothing truthful to report yet (TOOLBAR-04).
#[tauri::command]
fn session_stats() -> Option<serde_json::Value> {
    None
}

/// NodeDesk clipboard channel toggle for the active session. Until the
/// embedded viewer exists this governs only NodeDesk's own channel, and the
/// command fails truthfully when no session is active (TOOLBAR-05/06).
#[tauri::command]
fn session_clipboard(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    let active = state.stream_child.lock().map(|g| g.is_some()).unwrap_or(false);
    if !active {
        return Err("No active session.".into());
    }
    let mut guard = state.session_clipboard.lock().map_err(|e| e.to_string())?;
    *guard = enabled;
    Ok(())
}

#[tauri::command]
fn session_clipboard_send(state: State<'_, AppState>, text: String) -> Result<(), String> {
    let on = state.session_clipboard.lock().map(|g| *g).unwrap_or(false);
    if !on {
        return Err("Clipboard sharing is off for this session.".into());
    }
    // Clipboard bytes travel over the (currently HMAC-authenticated) agent
    // channel; SECURITY-03 tracks upgrading it to an encrypted transport.
    let _ = text;
    Err("Clipboard send needs the embedded viewer — not available yet.".into())
}

#[tauri::command]
fn session_clipboard_receive(state: State<'_, AppState>) -> Result<String, String> {
    let on = state.session_clipboard.lock().map(|g| *g).unwrap_or(false);
    if !on {
        return Err("Clipboard sharing is off for this session.".into());
    }
    Err("Clipboard receive needs the embedded viewer — not available yet.".into())
}

#[tauri::command]
fn disconnect_computer(state: State<'_, AppState>) -> Result<(), String> {
    moonlight::stop_stream(&state);
    Ok(())
}

#[tauri::command]
async fn power_action(state: State<'_, AppState>, address: String, action: String) -> Result<(), String> {
    let code = state::code_for_host(&state, &address)
        .ok_or("No access code stored for this computer — add it again with its code")?;
    // `send_ok` fails on a rejected request, so the UI cannot report a
    // shutdown the host actually refused.
    client::AgentRequest::post(&address, discovery::agent_port(), "/power")
        .json(&serde_json::json!({ "action": action }))?
        .timeout(std::time::Duration::from_millis(2500))
        .send_ok(&state.http, &code)
        .await?;
    Ok(())
}

#[tauri::command]
fn wake_computer(state: State<'_, AppState>, address: String) -> Result<(), String> {
    let mac = state
        .settings
        .read()
        .ok()
        .and_then(|s| s.manual_hosts.iter().find(|h| h.address == address).and_then(|h| h.mac.clone()));
    let mac = mac.ok_or("No MAC address known for this computer — connect once while it is online, or re-add it")?;
    wol::wake(&mac)
}

#[tauri::command]
fn local_metrics() -> monitor::Metrics {
    monitor::collect()
}

#[tauri::command]
async fn run_diagnostics(state: State<'_, AppState>) -> Result<Vec<DiagnosticsItem>, String> {
    let sunshine_installed = sunshine::is_installed();
    let sunshine_running = sunshine::service_running();
    let api_ok = sunshine::api_reachable(&state.http_local).await;
    let gpu = monitor::collect();
    let tailscale_installed = std::process::Command::new("tailscale")
        .arg("version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    let moonlight_ok = moonlight::moonlight_exe(&state.config_dir).is_some();
    // Each call shells out to pnputil and PowerShell; gather it once.
    let headless = headless::status();

    Ok(vec![
        DiagnosticsItem {
            label: "Host service".into(),
            ok: sunshine_installed && sunshine_running,
            detail: Some(if sunshine_running {
                "Sunshine host is running".into()
            } else if sunshine_installed {
                "Sunshine installed but not running".into()
            } else {
                "Sunshine not installed yet".into()
            }),
        },
        DiagnosticsItem {
            label: "Host API".into(),
            ok: api_ok,
            detail: Some(if api_ok { "Local Sunshine API responding".into() } else { "Not reachable on this machine".into() }),
        },
        DiagnosticsItem {
            label: "Controller".into(),
            ok: moonlight_ok,
            detail: Some(if moonlight_ok { "Moonlight client ready".into() } else { "Will download on first connect".into() }),
        },
        DiagnosticsItem {
            label: "GPU".into(),
            ok: gpu.gpu.is_some(),
            detail: Some(match &gpu.gpu {
                Some(g) => format!("{} detected", g.name),
                None => "No NVIDIA GPU found — encoding support verified on first stream".into(),
            }),
        },
        DiagnosticsItem {
            label: "Network".into(),
            ok: gpu.lan_ip.is_some(),
            detail: gpu.lan_ip.map(|ip| format!("LAN address {ip}")),
        },
        DiagnosticsItem {
            label: "Tailscale".into(),
            ok: tailscale_installed,
            detail: Some(if tailscale_installed { "Installed".into() } else { "Not installed (optional)".into() }),
        },
        DiagnosticsItem {
            label: "Virtual display".into(),
            ok: headless.vdd_installed || headless.display_count > 0,
            detail: Some(if headless.vdd_installed {
                "Virtual display driver installed — headless ready".into()
            } else if headless.display_count > 0 {
                format!("{} display(s) attached", headless.display_count)
            } else {
                "No display detected — enable headless mode in Settings".into()
            }),
        },
    ])
}

#[tauri::command]
async fn export_diagnostics(state: State<'_, AppState>) -> Result<String, String> {
    // Never includes credentials, keys, tokens or clipboard contents.
    let items = run_diagnostics(state.clone()).await?;
    let metrics = monitor::collect();
    let mut text = String::from("NodeDesk diagnostic report\n");
    text.push_str(&format!("version: {}\n\n", env!("CARGO_PKG_VERSION")));
    for item in items {
        text.push_str(&format!(
            "{}: {} ({})\n",
            item.label,
            if item.ok { "OK" } else { "PROBLEM" },
            item.detail.unwrap_or_default()
        ));
    }
    text.push_str(&format!(
        "\nsystem: {} · {} · {:.0} GB RAM · gpu: {}\n",
        metrics.host_name,
        metrics.os,
        metrics.ram_total_gb,
        metrics.gpu.map(|g| g.name).unwrap_or_else(|| "none".into())
    ));
    let path = state.config_dir.join("nodedesk-diagnostics.txt");
    std::fs::write(&path, &text).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings.read().map(|s| s.clone()).unwrap_or_default()
}

#[tauri::command]
fn save_settings(state: State<'_, AppState>, settings: Settings) -> Result<(), String> {
    set_autostart(settings.start_on_boot);
    {
        let mut guard = state.settings.write().map_err(|e| e.to_string())?;
        *guard = settings;
    }
    state.save_settings();
    Ok(())
}

#[tauri::command]
fn get_access_code() -> String {
    ensure_access_code()
}

#[tauri::command]
fn regenerate_access_code() -> Result<String, String> {
    let code = state::random_code(state::ACCESS_CODE_LEN);
    state::store_secret(ACCESS_CODE_KEY, &code)?;
    // Rotate the running listener too. A code that keeps working until the
    // next restart has not actually been revoked.
    agent::rotate_access_code(&code);
    Ok(code)
}

#[tauri::command]
async fn check_update(state: State<'_, AppState>) -> Result<update::UpdateInfo, String> {
    update::check(&state.http, env!("CARGO_PKG_VERSION")).await
}

// ---------------------------------------------------------------------------
// File transfer & terminal commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn list_files(state: State<'_, AppState>, address: String, path: String) -> Result<Vec<files::FileEntry>, String> {
    let code = state::code_for_host(&state, &address)
        .ok_or("No access code stored for this computer")?;
    client::AgentRequest::get(&address, discovery::agent_port(), "/files/list")
        .query(vec![("path", path)])
        .timeout(std::time::Duration::from_millis(3000))
        .send_ok(&state.http, &code)
        .await?
        .json::<Vec<files::FileEntry>>()
        .await
        .map_err(|e| e.to_string())
}

/// Enqueue one upload per file (serial per-transfer tasks; unique IDs).
/// Returns the transfer IDs in the same order as `paths` (FILE-01).
#[tauri::command]
async fn send_files(
    app: AppHandle,
    address: String,
    paths: Vec<String>,
    on_conflict: Option<String>,
) -> Result<Vec<String>, String> {
    let state = app.state::<AppState>();
    let remote_dir = files::incoming_dir();
    let mut ids = vec![];
    for path in &paths {
        let local = std::path::PathBuf::from(path);
        // Folders are rejected truthfully until recursive transfer exists
        // (FILE-08) — never claim a folder was sent.
        if local.is_dir() {
            return Err(format!(
                "Folder transfer isn't supported yet — {} was not sent. Compress it or send the files inside.",
                local.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
            ));
        }
        let name = local
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .ok_or("invalid file name")?;
        let identity = files_queue::source_identity(&local)?;
        let total = local.metadata().map_err(|e| e.to_string())?.len();
        let transfer = state.transfers.add(files_queue::Transfer {
            id: format!("t-{:016x}", rand::random::<u64>()),
            direction: "up".into(),
            file: name.clone(),
            address: address.clone(),
            source: local.to_string_lossy().to_string(),
            dest: format!("{remote_dir}/{name}"),
            total_bytes: total,
            identity,
            on_conflict: on_conflict.clone().unwrap_or_else(|| "keep-both".into()),
            cancel: Default::default(),
            done: Default::default(),
            state: std::sync::Arc::new(std::sync::Mutex::new("queued".into())),
        });
        ids.push(transfer.id.clone());
        let app2 = app.clone();
        let ctx = files::TransferContext {
            http: state.http.clone(),
            code: crate::state::code_for_host(&state, &address)
                .ok_or("No access code stored for this computer — add it with its code first")?,
        };
        tauri::async_runtime::spawn(async move {
            let _ = files::send_transfer(&ctx, &app2, &transfer).await;
        });
    }
    Ok(ids)
}

#[tauri::command]
async fn download_file(
    app: AppHandle,
    address: String,
    path: String,
    on_conflict: Option<String>,
) -> Result<String, String> {
    let state = app.state::<AppState>();
    let name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or("invalid remote path")?;
    let dest_dir = files::download_dir().ok_or("no download directory")?;
    let dest = dest_dir.join(&name);
    let transfer = state.transfers.add(files_queue::Transfer {
        id: format!("t-{:016x}", rand::random::<u64>()),
        direction: "down".into(),
        file: name,
        address: address.clone(),
        source: path.clone(),
        dest: dest.to_string_lossy().to_string(),
        total_bytes: 0, // learned from the host during the transfer
        identity: path.clone(), // remote identity = exact remote path for this transfer
        on_conflict: on_conflict.unwrap_or_else(|| "keep-both".into()),
        cancel: Default::default(),
        done: Default::default(),
        state: std::sync::Arc::new(std::sync::Mutex::new("queued".into())),
    });
    let id = transfer.id.clone();
    let app2 = app.clone();
    let ctx = files::TransferContext {
        http: state.http.clone(),
        code: crate::state::code_for_host(&state, &address)
            .ok_or("No access code stored for this computer — add it with its code first")?,
    };
    tauri::async_runtime::spawn(async move {
        let _ = files::download_transfer(&ctx, &app2, &transfer).await;
    });
    Ok(id)
}

/// FILE-05: cancel exactly one transfer by ID.
#[tauri::command]
fn cancel_transfer(state: State<'_, AppState>, transfer_id: Option<String>) -> Result<(), String> {
    match transfer_id {
        Some(id) => {
            if state.transfers.cancel(&id) {
                Ok(())
            } else {
                Err("No transfer with that ID.".into())
            }
        }
        // Legacy behavior for callers that predate transfer IDs.
        None => {
            state.transfer_cancel.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }
    }
}

/// FILE-06: retry resumes only the same transfer record; the engine re-verifies
/// source identity before continuing.
#[tauri::command]
async fn retry_transfer(app: AppHandle, transfer_id: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let transfer = state
        .transfers
        .get(&transfer_id)
        .ok_or("No transfer with that ID.")?;
    {
        let s = transfer.state.lock().map_err(|e| e.to_string())?;
        if !matches!(s.as_str(), "interrupted" | "failed" | "cancelled") {
            return Err("Only an interrupted transfer can be retried.".into());
        }
    }
    transfer.cancel.store(false, std::sync::atomic::Ordering::SeqCst);
    transfer.set_state("queued");
    let app2 = app.clone();
    let ctx = files::TransferContext {
        http: state.http.clone(),
        code: crate::state::code_for_host(&state, &transfer.address)
            .ok_or("No access code stored for this computer — add it with its code first")?,
    };
    tauri::async_runtime::spawn(async move {
        if transfer.direction == "up" {
            let _ = files::send_transfer(&ctx, &app2, &transfer).await;
        } else {
            let _ = files::download_transfer(&ctx, &app2, &transfer).await;
        }
    });
    Ok(())
}

#[tauri::command]
fn list_transfers(state: State<'_, AppState>) -> Vec<serde_json::Value> {
    state.transfers.snapshots()
}

/// The local agent TLS certificate fingerprint, for out-of-band verification
/// against a controller's pinned value (SECURITY-03).
#[tauri::command]
fn agent_cert_fingerprint(state: State<'_, AppState>) -> Result<String, String> {
    Ok(tls::load_or_create(&state.config_dir)?.fingerprint)
}

#[tauri::command]
fn headless_status() -> headless::HeadlessStatus {
    headless::status()
}

#[tauri::command]
async fn enable_headless(state: State<'_, AppState>) -> Result<(), String> {
    headless::install_vdd(&state.http).await
}

#[tauri::command]
async fn terminal_exec(state: State<'_, AppState>, address: String, command: String, cwd: String) -> Result<terminal::TerminalResult, String> {
    let code = state::code_for_host(&state, &address)
        .ok_or("No access code stored for this computer")?;
    client::AgentRequest::post(&address, discovery::agent_port(), "/terminal")
        .json(&serde_json::json!({ "command": command, "cwd": cwd }))?
        .timeout(std::time::Duration::from_secs(35))
        .send_ok(&state.http, &code)
        .await?
        .json::<terminal::TerminalResult>()
        .await
        .map_err(|e| e.to_string())
}

#[cfg(windows)]
fn set_autostart(enabled: bool) {
    let Ok(exe) = std::env::current_exe() else { return };
    let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
    let Ok((key, _)) = hkcu.create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run") else {
        return;
    };
    if enabled {
        let _ = key.set_value("NodeDesk", &exe.to_string_lossy().to_string());
    } else {
        let _ = key.delete_value("NodeDesk");
    }
}

#[cfg(target_os = "linux")]
fn set_autostart(enabled: bool) {
    let Some(config) = dirs::config_dir() else { return };
    let dir = config.join("autostart");
    let file = dir.join("nodedesk.desktop");
    if enabled {
        let Ok(exe) = std::env::current_exe() else { return };
        let _ = std::fs::create_dir_all(&dir);
        let desktop = format!(
            "[Desktop Entry]\nType=Application\nName=NodeDesk\nExec={}\nX-GNOME-Autostart-enabled=true\n",
            exe.to_string_lossy()
        );
        let _ = std::fs::write(&file, desktop);
    } else {
        let _ = std::fs::remove_file(&file);
    }
}

#[cfg(target_os = "macos")]
fn set_autostart(enabled: bool) {
    let Some(home) = dirs::home_dir() else { return };
    let dir = home.join("Library/LaunchAgents");
    let file = dir.join("dev.nodedesk.app.plist");
    if enabled {
        let Ok(exe) = std::env::current_exe() else { return };
        let _ = std::fs::create_dir_all(&dir);
        let plist = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n<key>Label</key><string>dev.nodedesk.app</string>\n<key>ProgramArguments</key><array><string>{}</string></array>\n<key>RunAtLoad</key><true/>\n</dict></plist>\n",
            exe.to_string_lossy()
        );
        let _ = std::fs::write(&file, plist);
    } else {
        let _ = std::fs::remove_file(&file);
    }
}

fn main() {
    tls::ensure_crypto_provider();
    tauri::Builder::default()
        .setup(|app| {
            let dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            let app_state = AppState::new(dir.clone());
            let onboarded = app_state.settings.read().map(|s| s.onboarded).unwrap_or(false);
            let mode = app_state.settings.read().map(|s| s.mode.clone()).unwrap_or_default();
            app.manage(app_state);
            app.manage(google_auth::AccountState::new(&dir));

            discovery::start_responder();
            if onboarded && (mode == "host" || mode == "both") {
                let code = ensure_access_code();
                // The agent channel is TLS-encrypted (SECURITY-03); identity
                // is persistent so pinned controllers survive restarts.
                if let Ok(identity) = tls::load_or_create(&dir) {
                    tauri::async_runtime::spawn(agent::run(code, identity));
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            complete_onboarding,
            bootstrap_host,
            list_computers,
            add_manual_host,
            forget_host,
            approve_pairing,
            pair_computer,
            connect_computer,
            disconnect_computer,
            power_action,
            wake_computer,
            local_metrics,
            run_diagnostics,
            export_diagnostics,
            get_settings,
            save_settings,
            get_access_code,
            regenerate_access_code,
            check_update,
            list_files,
            send_files,
            download_file,
            cancel_transfer,
            retry_transfer,
            list_transfers,
            agent_cert_fingerprint,
            terminal_exec,
            headless_status,
            enable_headless,
            google_auth::auth_get_state,
            google_auth::auth_sign_in,
            google_auth::auth_sign_out,
            google_auth::auth_set_stay_signed_in,
            google_auth::dir_list_computers,
            google_auth::device_get_identity,
            google_auth::device_enroll,
            google_auth::device_heartbeat,
            google_auth::dir_resolve_device_id,
            google_auth::dir_add_computer,
            google_auth::dir_rename_computer,
            google_auth::dir_remove_computer,
            google_auth::host_get_policy,
            google_auth::host_set_policy,
            google_auth::host_pending_requests,
            google_auth::host_accept_request,
            google_auth::host_reject_request,
            google_auth::request_create,
            google_auth::request_status,
            google_auth::request_cancel,
            google_auth::request_end,
            google_auth::trust_list,
            google_auth::trust_revoke,
            session_list_displays,
            session_stats,
            session_clipboard,
            session_clipboard_send,
            session_clipboard_receive,
        ])
        .run(tauri::generate_context!())
        .expect("error while running NodeDesk");
}
