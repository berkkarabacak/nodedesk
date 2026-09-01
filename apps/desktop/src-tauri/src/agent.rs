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

/// Router with all agent routes (extracted for integration tests).
pub fn router(ctx: Arc<AgentCtx>) -> Router {
    Router::new()
        .route("/metrics", get(metrics))
        .route("/power", post(power))
        .route("/files/list", get(files_list))
        .route("/files/stat", get(files_stat))
        .route("/files/download", get(files_download))
        .route("/files/upload", post(files_upload))
        .route("/terminal", post(terminal_exec))
        .with_state(ctx)
}

/// Starts the agent on the configured port. Runs for the app's lifetime.
pub async fn run(access_code: String) {
    run_on(crate::discovery::agent_port(), access_code).await
}

/// Port-parameterized so tests can run simulated machines side by side.
pub async fn run_on(port: u16, access_code: String) {
    let ctx = Arc::new(AgentCtx { access_code });
    let listener = match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
        Ok(l) => l,
        Err(_) => return, // another instance is already serving
    };
    let _ = axum::serve(listener, router(ctx)).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    fn test_router() -> Router {
        router(Arc::new(AgentCtx {
            access_code: "TEST-CODE".into(),
        }))
    }

    fn authed(uri: &str) -> Request<Body> {
        Request::builder()
            .uri(uri)
            .header("x-nodedesk-code", "TEST-CODE")
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test]
    async fn rejects_missing_or_wrong_code() {
        let resp = test_router()
            .oneshot(Request::builder().uri("/metrics").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        let resp = test_router()
            .oneshot(
                Request::builder()
                    .uri("/metrics")
                    .header("x-nodedesk-code", "WRONG")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn serves_metrics_with_code() {
        let resp = test_router().oneshot(authed("/metrics")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 1_000_000).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(v.get("hostName").is_some());
        assert!(v.get("services").is_some());
    }

    #[tokio::test]
    async fn file_upload_download_roundtrip_with_resume() {
        let dir = std::env::temp_dir().join("nodedesk-agent-test");
        let path = dir.join("roundtrip.bin");
        let _ = std::fs::remove_dir_all(&dir);
        let p = path.to_string_lossy().replace('\\', "/");

        let up = test_router()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/files/upload?path={p}&offset=0"))
                    .header("x-nodedesk-code", "TEST-CODE")
                    .body(Body::from("hello "))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(up.status(), StatusCode::OK);

        let up2 = test_router()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/files/upload?path={p}&offset=6"))
                    .header("x-nodedesk-code", "TEST-CODE")
                    .body(Body::from("world"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(up2.status(), StatusCode::OK);

        // Stat reports the resumed size.
        let stat = test_router()
            .oneshot(authed(&format!("/files/stat?path={p}")))
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(stat.into_body(), 1_000_000).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["size"].as_u64().unwrap(), 11);

        // Download from offset = resume.
        let down = test_router()
            .oneshot(authed(&format!("/files/download?path={p}&offset=6")))
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(down.into_body(), 1_000_000).await.unwrap();
        assert_eq!(&bytes[..], b"world");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn terminal_executes_and_reports_cwd() {
        let resp = test_router()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/terminal")
                    .header("content-type", "application/json")
                    .header("x-nodedesk-code", "TEST-CODE")
                    .body(Body::from(r#"{"command":"echo nodedesk-agent-ok"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 1_000_000).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(v["output"].as_str().unwrap_or("").contains("nodedesk-agent-ok"));
        assert!(!v["cwd"].as_str().unwrap_or("").is_empty());
    }

    #[test]
    fn constant_time_compare() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
    }
}
