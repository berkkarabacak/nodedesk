//! NodeDesk host agent: a tiny HTTP service answering metrics, power actions,
//! file transfer and terminal requests on the LAN/tailnet. Every request
//! requires the host's access code (X-NodeDesk-Code), compared in constant
//! time.

use axum::{
    body::Bytes,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use std::sync::Arc;

use crate::{files, monitor, terminal};

pub struct AgentCtx {
    pub access_code: String,
}

fn authorized(headers: &HeaderMap, ctx: &AgentCtx) -> bool {
    let Some(provided) = headers.get("x-nodedesk-code").and_then(|v| v.to_str().ok()) else {
        return false;
    };
    constant_time_eq(provided.as_bytes(), ctx.access_code.as_bytes())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b.iter()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

macro_rules! auth {
    ($headers:expr, $ctx:expr) => {
        if !authorized($headers, &$ctx) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
    };
}

async fn metrics(State(ctx): State<Arc<AgentCtx>>, headers: HeaderMap) -> impl IntoResponse {
    auth!(&headers, ctx);
    Json(monitor::collect()).into_response()
}

#[derive(Deserialize)]
struct PowerRequest {
    action: String,
}

async fn power(
    State(ctx): State<Arc<AgentCtx>>,
    headers: HeaderMap,
    Json(body): Json<PowerRequest>,
) -> impl IntoResponse {
    auth!(&headers, ctx);
    match run_power_action(&body.action) {
        Ok(()) => StatusCode::OK.into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

#[cfg(windows)]
fn run_power_action(action: &str) -> Result<(), String> {
    let (cmd, args): (&str, Vec<&str>) = match action {
        "sleep" => ("rundll32", vec!["powrprof.dll,SetSuspendState", "0", "1", "0"]),
        "restart" => ("shutdown", vec!["/r", "/t", "3"]),
        "shutdown" => ("shutdown", vec!["/s", "/t", "3"]),
        "lock" => ("rundll32", vec!["user32.dll,LockWorkStation"]),
        _ => return Err("unknown power action".into()),
    };
    std::process::Command::new(cmd)
        .args(&args)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn run_power_action(action: &str) -> Result<(), String> {
    let (cmd, args): (&str, Vec<&str>) = match action {
        "sleep" => ("systemctl", vec!["suspend"]),
        "restart" => ("systemctl", vec!["reboot"]),
        "shutdown" => ("systemctl", vec!["poweroff"]),
        "lock" => ("loginctl", vec!["lock-session"]),
        _ => return Err("unknown power action".into()),
    };
    std::process::Command::new(cmd)
        .args(&args)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn run_power_action(action: &str) -> Result<(), String> {
    let (cmd, args): (&str, Vec<&str>) = match action {
        "sleep" => ("pmset", vec!["sleepnow"]),
        "restart" => ("shutdown", vec!["-r", "now"]),
        "shutdown" => ("shutdown", vec!["-h", "now"]),
        "lock" => (
            "pmset",
            vec!["displaysleepnow"],
        ),
        _ => return Err("unknown power action".into()),
    };
    std::process::Command::new(cmd)
        .args(&args)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// File transfer endpoints
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct PathQuery {
    path: Option<String>,
}

async fn files_list(
    State(ctx): State<Arc<AgentCtx>>,
    headers: HeaderMap,
    Query(q): Query<PathQuery>,
) -> impl IntoResponse {
    auth!(&headers, ctx);
    match files::list_dir(q.path.as_deref().unwrap_or("")) {
        Ok(entries) => Json(entries).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

async fn files_stat(
    State(ctx): State<Arc<AgentCtx>>,
    headers: HeaderMap,
    Query(q): Query<PathQuery>,
) -> impl IntoResponse {
    auth!(&headers, ctx);
    let Some(path) = q.path else {
        return (StatusCode::BAD_REQUEST, "missing path").into_response();
    };
    match files::stat(&path) {
        Ok(s) => Json(s).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

#[derive(Deserialize)]
struct DownloadQuery {
    path: String,
    offset: Option<u64>,
}

async fn files_download(
    State(ctx): State<Arc<AgentCtx>>,
    headers: HeaderMap,
    Query(q): Query<DownloadQuery>,
) -> impl IntoResponse {
    auth!(&headers, ctx);
    match files::read_from(&q.path, q.offset.unwrap_or(0)) {
        Ok(bytes) => bytes.into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

#[derive(Deserialize)]
struct UploadQuery {
    path: String,
    offset: Option<u64>,
}

async fn files_upload(
    State(ctx): State<Arc<AgentCtx>>,
    headers: HeaderMap,
    Query(q): Query<UploadQuery>,
    body: Bytes,
) -> impl IntoResponse {
    auth!(&headers, ctx);
    match files::write_at(&q.path, q.offset.unwrap_or(0), &body) {
        Ok(size) => Json(serde_json::json!({ "size": size })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

// ---------------------------------------------------------------------------
// Terminal endpoint
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct TerminalRequest {
    command: String,
    cwd: Option<String>,
}

async fn terminal_exec(
    State(ctx): State<Arc<AgentCtx>>,
    headers: HeaderMap,
    Json(body): Json<TerminalRequest>,
) -> impl IntoResponse {
    auth!(&headers, ctx);
    if body.command.len() > 4096 {
        return (StatusCode::BAD_REQUEST, "command too long").into_response();
    }
    Json(terminal::execute(&body.command, &body.cwd.unwrap_or_default())).into_response()
}

/// Starts the agent. Runs for the lifetime of the app.
pub async fn run(access_code: String) {
    let ctx = Arc::new(AgentCtx { access_code });
    let app = Router::new()
        .route("/metrics", get(metrics))
        .route("/power", post(power))
        .route("/files/list", get(files_list))
        .route("/files/stat", get(files_stat))
        .route("/files/download", get(files_download))
        .route("/files/upload", post(files_upload))
        .route("/terminal", post(terminal_exec))
        .with_state(ctx);
    let listener =
        match tokio::net::TcpListener::bind(("0.0.0.0", crate::discovery::AGENT_PORT)).await {
            Ok(l) => l,
            Err(_) => return, // another instance is already serving
        };
    let _ = axum::serve(listener, app).await;
}
