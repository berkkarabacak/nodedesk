//! NodeDesk host agent: a tiny HTTP service answering metrics and power
//! actions on the LAN/tailnet. Every request requires the host's access
//! code (X-NodeDesk-Code header), compared in constant time.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use std::sync::Arc;

use crate::monitor;

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

async fn metrics(State(ctx): State<Arc<AgentCtx>>, headers: HeaderMap) -> impl IntoResponse {
    if !authorized(&headers, &ctx) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
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
    if !authorized(&headers, &ctx) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
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

#[cfg(not(windows))]
fn run_power_action(_action: &str) -> Result<(), String> {
    Err("power actions are only supported on Windows in v1.0".into())
}

/// Starts the agent. Runs for the lifetime of the app.
pub async fn run(access_code: String) {
    let ctx = Arc::new(AgentCtx { access_code });
    let app = Router::new()
        .route("/metrics", get(metrics))
        .route("/power", post(power))
        .with_state(ctx);
    let listener =
        match tokio::net::TcpListener::bind(("0.0.0.0", crate::discovery::AGENT_PORT)).await {
            Ok(l) => l,
            Err(_) => return, // another instance is already serving
        };
    let _ = axum::serve(listener, app).await;
}
