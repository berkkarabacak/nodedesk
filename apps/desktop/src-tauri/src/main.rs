//! NodeDesk desktop shell — Rust core.
//!
//! Phase-1 scaffold. These commands define the contract between the UI and
//! the host core. The real implementations delegate to the managed Sunshine
//! host service, the Moonlight protocol client, and NodeDesk's discovery,
//! monitoring and networking layers (see docs/architecture.md).
//!
//! Nothing in this file weakens upstream Sunshine/Moonlight security: pairing,
//! certificates and session authorization are delegated to the upstream
//! implementations, never re-implemented with lower guarantees.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AiService {
    name: String,
    running: bool,
    url: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Computer {
    id: String,
    name: String,
    os: String,
    online: bool,
    specs: String,
    cpu_pct: Option<u8>,
    gpu_pct: Option<u8>,
    ram_used_gb: Option<f32>,
    ram_total_gb: Option<f32>,
    vram_used_gb: Option<f32>,
    vram_total_gb: Option<f32>,
    network: Option<String>,
    uptime: Option<String>,
    services: Option<Vec<AiService>>,
}

#[derive(Serialize)]
struct DiagnosticsItem {
    label: String,
    ok: bool,
    detail: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Settings {
    mode: String,
    start_on_boot: bool,
    clipboard_sync: bool,
    tailscale_enabled: bool,
    codec: String,
    bitrate_mbps: u32,
    fps: u32,
    resolution: String,
    hdr: bool,
}

#[derive(Serialize)]
struct OkResult {
    ok: bool,
}

/// Lists computers from merged discovery sources (LAN broadcast + Tailscale
/// tailnet). Real implementation: `discovery/` crate over mDNS/SSDP and the
/// Tailscale local API.
#[tauri::command]
fn list_computers() -> Vec<Computer> {
    // Scaffold data until the discovery + monitoring crates land.
    vec![Computer {
        id: "this-pc".into(),
        name: "This PC".into(),
        os: std::env::consts::OS.into(),
        online: true,
        specs: "NodeDesk host ready".into(),
        cpu_pct: None,
        gpu_pct: None,
        ram_used_gb: None,
        ram_total_gb: None,
        vram_used_gb: None,
        vram_total_gb: None,
        network: None,
        uptime: None,
        services: None,
    }]
}

/// Starts a Moonlight-protocol desktop session against a paired host.
/// Real implementation: launch embedded moonlight client with the stored
/// per-device certificate pair; reconnect logic per docs/networking.md.
#[tauri::command]
fn connect_computer(id: String) -> OkResult {
    let _ = &id; // wiring lands with streaming/moonlight

    OkResult { ok: true }
}

#[tauri::command]
fn disconnect_computer(id: String) -> OkResult {
    let _ = &id;

    OkResult { ok: true }
}

/// Sends a Wake-on-LAN magic packet to a known, previously paired host.
#[tauri::command]
fn wake_computer(id: String) -> OkResult {
    let _ = &id;

    OkResult { ok: true }
}

/// Authenticated power action against a paired host agent.
#[tauri::command]
fn power_action(id: String, action: String) -> OkResult {
    let _ = (&id, &action);

    OkResult { ok: true }
}

#[tauri::command]
fn run_diagnostics() -> Vec<DiagnosticsItem> {
    vec![DiagnosticsItem {
        label: "Host".into(),
        ok: true,
        detail: Some("NodeDesk core running".into()),
    }]
}

/// Exports a redacted diagnostic report. Never includes credentials, private
/// keys, tokens, or clipboard contents (see docs/security.md).
#[tauri::command]
fn export_diagnostics() -> OkResult {
    OkResult { ok: true }
}

#[tauri::command]
fn get_settings() -> Settings {
    Settings {
        mode: "both".into(),
        start_on_boot: true,
        clipboard_sync: true,
        tailscale_enabled: true,
        codec: "auto".into(),
        bitrate_mbps: 40,
        fps: 60,
        resolution: "auto".into(),
        hdr: false,
    }
}

#[tauri::command]
fn save_settings(settings: Settings) -> Settings {
    settings
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_computers,
            connect_computer,
            disconnect_computer,
            wake_computer,
            power_action,
            run_diagnostics,
            export_diagnostics,
            get_settings,
            save_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running NodeDesk");
}
