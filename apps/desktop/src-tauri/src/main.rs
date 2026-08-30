//! NodeDesk desktop shell — Rust core and Tauri command surface.
//!
//! v1.0: the app orchestrates real upstream components (managed Sunshine host,
//! Moonlight-Qt controller) plus its own discovery, metrics agent, power
//! actions and Wake-on-LAN. Streaming, codecs and clipboard sync are handled
//! by Sunshine/Moonlight themselves — NodeDesk automates everything around
//! them. Security model: docs/security.md.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod discovery;
mod monitor;
mod moonlight;
mod state;
mod sunshine;
mod update;
mod wol;

use serde::Serialize;
use state::{AppState, Settings};
use tauri::{AppHandle, Emitter, Manager, State};

const ACCESS_CODE_KEY: &str = "host-access-code";

fn ensure_access_code() -> String {
    state::read_secret(ACCESS_CODE_KEY).unwrap_or_else(|| {
        let code = state::random_code(8);
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
        tauri::async_runtime::spawn(agent::run(code));
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
        let code = settings.host_codes.get(&host.address).cloned();
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
                })
            }
        }
    }
    Ok(out)
}

async fn fetch_metrics(client: &reqwest::Client, address: &str, code: &str) -> Option<monitor::Metrics> {
    client
        .get(format!("http://{address}:{}/metrics", discovery::AGENT_PORT))
        .header("x-nodedesk-code", code)
        .timeout(std::time::Duration::from_millis(900))
        .send()
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
    let mut settings = state.settings.write().map_err(|e| e.to_string())?;
    settings.host_codes.insert(address.clone(), code);
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
async fn connect_computer(app: AppHandle, address: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let exe = moonlight::ensure_available(&state.http, &state.config_dir).await?;
    let settings = state.settings.read().map(|s| s.clone()).unwrap_or_default();
    moonlight::start_stream(&state, exe, &settings, &address)?;
    let _ = app.emit("stream-started", &address);
    Ok(())
}

#[tauri::command]
fn disconnect_computer(state: State<'_, AppState>) -> Result<(), String> {
    moonlight::stop_stream(&state);
    Ok(())
}

#[tauri::command]
async fn power_action(state: State<'_, AppState>, address: String, action: String) -> Result<(), String> {
    let code = state
        .settings
        .read()
        .ok()
        .and_then(|s| s.host_codes.get(&address).cloned())
        .ok_or("No access code stored for this computer — add it again with its code")?;
    state
        .http
        .post(format!("http://{address}:{}/power", discovery::AGENT_PORT))
        .header("x-nodedesk-code", code)
        .json(&serde_json::json!({ "action": action }))
        .timeout(std::time::Duration::from_millis(1500))
        .send()
        .await
        .map_err(|e| format!("can't reach {address}: {e}"))?;
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
async fn run_diagnostics(state: State<'_, AppState>) -> Vec<DiagnosticsItem> {
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

    vec![
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
    ]
}

#[tauri::command]
async fn export_diagnostics(state: State<'_, AppState>) -> Result<String, String> {
    // Never includes credentials, keys, tokens or clipboard contents.
    let items = run_diagnostics(state.clone()).await;
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
    let code = state::random_code(8);
    state::store_secret(ACCESS_CODE_KEY, &code)?;
    Ok(code)
}

#[tauri::command]
async fn check_update(state: State<'_, AppState>) -> Result<update::UpdateInfo, String> {
    update::check(&state.http, env!("CARGO_PKG_VERSION")).await
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

#[cfg(not(windows))]
fn set_autostart(_enabled: bool) {}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            let app_state = AppState::new(dir);
            let onboarded = app_state.settings.read().map(|s| s.onboarded).unwrap_or(false);
            let mode = app_state.settings.read().map(|s| s.mode.clone()).unwrap_or_default();
            app.manage(app_state);

            discovery::start_responder();
            if onboarded && (mode == "host" || mode == "both") {
                let code = ensure_access_code();
                tauri::async_runtime::spawn(agent::run(code));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            complete_onboarding,
            bootstrap_host,
            list_computers,
            add_manual_host,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running NodeDesk");
}
