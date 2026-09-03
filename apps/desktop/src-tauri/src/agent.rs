//! NodeDesk host agent: a small HTTP service answering metrics, power actions,
//! file transfer and terminal requests on the LAN/tailnet.
//!
//! Every request is authenticated by an HMAC over its method, path, timestamp,
//! nonce and body (see `auth`). The access code itself never crosses the
//! network, replays are refused, and repeated failures lock the peer out.
//! File paths are confined to the shared folders (see `safepath`).

use axum::{
    body::Bytes,
    extract::{ConnectInfo, DefaultBodyLimit, Query, State},
    http::{HeaderMap, Method, StatusCode, Uri},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use std::net::SocketAddr;
use std::sync::{Arc, RwLock};

use crate::auth::{self, ReplayGuard, Throttle};
use crate::{files, monitor, terminal};

pub struct AgentCtx {
    /// Behind a lock so regenerating the code takes effect immediately,
    /// without restarting the app. Revocation that needs a restart is not
    /// revocation.
    access_code: RwLock<String>,
    replay: ReplayGuard,
    throttle: Throttle,
}

impl AgentCtx {
    pub fn new(access_code: String) -> Self {
        Self {
            access_code: RwLock::new(access_code),
            replay: ReplayGuard::default(),
            throttle: Throttle::default(),
        }
    }

    pub fn set_access_code(&self, code: String) {
        if let Ok(mut current) = self.access_code.write() {
            *current = code;
        }
    }

    fn code(&self) -> Option<String> {
        self.access_code.read().ok().map(|c| c.clone())
    }
}

/// The live agent context, so `regenerate_access_code` can rotate the secret
/// on the running listener.
static AGENT: RwLock<Option<Arc<AgentCtx>>> = RwLock::new(None);

pub fn rotate_access_code(code: &str) {
    if let Ok(agent) = AGENT.read() {
        if let Some(ctx) = agent.as_ref() {
            ctx.set_access_code(code.to_string());
        }
    }
}

fn register(ctx: &Arc<AgentCtx>) {
    if let Ok(mut agent) = AGENT.write() {
        *agent = Some(ctx.clone());
    }
}

enum Denied {
    Throttled,
    Unauthorized,
}

impl IntoResponse for Denied {
    fn into_response(self) -> axum::response::Response {
        match self {
            // 429 tells an honest client to back off; it tells a guesser
            // nothing about whether the code was close.
            Denied::Throttled => (StatusCode::TOO_MANY_REQUESTS, "too many attempts").into_response(),
            Denied::Unauthorized => StatusCode::UNAUTHORIZED.into_response(),
        }
    }
}

/// Verifies the signature on a request. `body` must be the exact bytes the
/// handler will act on.
fn authorize(
    ctx: &AgentCtx,
    peer: &str,
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<(), Denied> {
    if !ctx.throttle.allowed(peer) {
        return Err(Denied::Throttled);
    }

    let fail = |ctx: &AgentCtx| {
        ctx.throttle.record_failure(peer);
        Denied::Unauthorized
    };

    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let (Some(ts), Some(nonce), Some(provided)) = (
        header(auth::TS_HEADER),
        header(auth::NONCE_HEADER),
        header(auth::AUTH_HEADER),
    ) else {
        return Err(fail(ctx));
    };

    let Ok(ts) = ts.parse::<i64>() else {
        return Err(fail(ctx));
    };
    if (auth::unix_now() - ts).abs() > auth::MAX_SKEW_SECS {
        return Err(fail(ctx));
    }

    let Some(code) = ctx.code() else {
        return Err(fail(ctx));
    };
    let path_and_query = uri.path_and_query().map(|p| p.as_str()).unwrap_or(uri.path());
    let expected = auth::signature(
        &code,
        method.as_str(),
        path_and_query,
        ts,
        nonce,
        &auth::body_digest(body),
    );
    if !auth::constant_time_eq(provided.as_bytes(), expected.as_bytes()) {
        return Err(fail(ctx));
    }

    // Only now, with a valid signature, is the nonce worth spending. Checking
    // it earlier would let an unauthenticated peer fill the replay cache.
    if !ctx.replay.accept(nonce, ts) {
        return Err(fail(ctx));
    }

    ctx.throttle.record_success(peer);
    Ok(())
}

fn peer_id(addr: Option<ConnectInfo<SocketAddr>>) -> String {
    addr.map(|ConnectInfo(a)| a.ip().to_string())
        .unwrap_or_else(|| "unknown".into())
}

macro_rules! auth {
    ($ctx:expr, $peer:expr, $method:expr, $uri:expr, $headers:expr, $body:expr) => {
        if let Err(denied) = authorize(&$ctx, &$peer, &$method, &$uri, &$headers, $body) {
            return denied.into_response();
        }
    };
}

async fn metrics(
    State(ctx): State<Arc<AgentCtx>>,
    addr: Option<ConnectInfo<SocketAddr>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> impl IntoResponse {
    let peer = peer_id(addr);
    auth!(ctx, peer, method, uri, headers, b"");
    // `collect` samples the CPU over ~120ms and probes local ports; doing that
    // on a runtime worker would stall every other request.
    match tokio::task::spawn_blocking(monitor::collect).await {
        Ok(m) => Json(m).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "metrics unavailable").into_response(),
    }
}

#[derive(Deserialize)]
struct PowerRequest {
    action: String,
}

async fn power(
    State(ctx): State<Arc<AgentCtx>>,
    addr: Option<ConnectInfo<SocketAddr>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let peer = peer_id(addr);
    auth!(ctx, peer, method, uri, headers, &body);
    let Ok(request) = serde_json::from_slice::<PowerRequest>(&body) else {
        return (StatusCode::BAD_REQUEST, "malformed request").into_response();
    };
    match run_power_action(&request.action) {
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
        "lock" => ("pmset", vec!["displaysleepnow"]),
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
    addr: Option<ConnectInfo<SocketAddr>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    Query(q): Query<PathQuery>,
) -> impl IntoResponse {
    let peer = peer_id(addr);
    auth!(ctx, peer, method, uri, headers, b"");
    match files::list_dir(q.path.as_deref().unwrap_or("")) {
        Ok(entries) => Json(entries).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

async fn files_stat(
    State(ctx): State<Arc<AgentCtx>>,
    addr: Option<ConnectInfo<SocketAddr>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    Query(q): Query<PathQuery>,
) -> impl IntoResponse {
    let peer = peer_id(addr);
    auth!(ctx, peer, method, uri, headers, b"");
    let Some(path) = q.path else {
        return (StatusCode::BAD_REQUEST, "missing path").into_response();
    };
    match files::stat(&path) {
        Ok(s) => Json(s).into_response(),
        // A resumable upload asks for the size of a file that may not exist
        // yet, so "not found" has to stay distinguishable from "refused".
        Err(files::StatError::Denied(e)) => (StatusCode::FORBIDDEN, e).into_response(),
        Err(files::StatError::Missing) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

#[derive(Deserialize)]
struct DownloadQuery {
    path: String,
    offset: Option<u64>,
}

async fn files_download(
    State(ctx): State<Arc<AgentCtx>>,
    addr: Option<ConnectInfo<SocketAddr>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    Query(q): Query<DownloadQuery>,
) -> impl IntoResponse {
    let peer = peer_id(addr);
    auth!(ctx, peer, method, uri, headers, b"");
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
    addr: Option<ConnectInfo<SocketAddr>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    Query(q): Query<UploadQuery>,
    body: Bytes,
) -> impl IntoResponse {
    let peer = peer_id(addr);
    auth!(ctx, peer, method, uri, headers, &body);
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
    addr: Option<ConnectInfo<SocketAddr>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let peer = peer_id(addr);
    auth!(ctx, peer, method, uri, headers, &body);
    let Ok(request) = serde_json::from_slice::<TerminalRequest>(&body) else {
        return (StatusCode::BAD_REQUEST, "malformed request").into_response();
    };
    if request.command.len() > 4096 {
        return (StatusCode::BAD_REQUEST, "command too long").into_response();
    }
    let cwd = request.cwd.unwrap_or_default();
    // The shell blocks for up to its timeout; keep it off the runtime workers.
    match tokio::task::spawn_blocking(move || terminal::execute(&request.command, &cwd)).await {
        Ok(result) => Json(result).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "command failed to run").into_response(),
    }
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
        // Uploads arrive in chunks; the default 2 MiB body limit would break them.
        .layer(DefaultBodyLimit::max(256 * 1024 * 1024))
        .with_state(ctx)
}

/// Starts the agent on the configured port. Runs for the app's lifetime.
pub async fn run(access_code: String) {
    run_on(crate::discovery::agent_port(), access_code).await
}

/// Port-parameterized so tests can run simulated machines side by side.
pub async fn run_on(port: u16, access_code: String) {
    let ctx = Arc::new(AgentCtx::new(access_code));
    register(&ctx);
    let listener = match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
        Ok(l) => l,
        Err(_) => return, // another instance is already serving
    };
    // ConnectInfo carries the peer address the throttle keys on.
    let _ = axum::serve(
        listener,
        router(ctx).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    const CODE: &str = "TEST-CODE";

    fn test_ctx() -> Arc<AgentCtx> {
        Arc::new(AgentCtx::new(CODE.into()))
    }

    /// Builds a correctly signed request, the way the client does.
    fn signed(code: &str, method: &str, uri: &str, body: &[u8]) -> Request<Body> {
        let ts = auth::unix_now();
        let nonce = auth::new_nonce();
        let sig = auth::signature(code, method, uri, ts, &nonce, &auth::body_digest(body));
        Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .header(auth::TS_HEADER, ts.to_string())
            .header(auth::NONCE_HEADER, nonce)
            .header(auth::AUTH_HEADER, sig)
            .body(Body::from(body.to_vec()))
            .unwrap()
    }

    fn authed(uri: &str) -> Request<Body> {
        signed(CODE, "GET", uri, b"")
    }

    #[tokio::test]
    async fn rejects_unsigned_and_wrongly_signed_requests() {
        let resp = router(test_ctx())
            .oneshot(Request::builder().uri("/metrics").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        let resp = router(test_ctx())
            .oneshot(signed("WRONG-CODE", "GET", "/metrics", b""))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn the_access_code_never_appears_in_a_request() {
        let request = signed(CODE, "GET", "/metrics", b"");
        for (_, value) in request.headers() {
            let text = value.to_str().unwrap_or_default();
            assert!(
                !text.contains(CODE),
                "the shared secret must never be sent over the wire"
            );
        }
    }

    #[tokio::test]
    async fn rejects_a_replayed_request() {
        let ctx = test_ctx();
        let ts = auth::unix_now();
        let nonce = auth::new_nonce();
        let sig = auth::signature(CODE, "GET", "/metrics", ts, &nonce, &auth::body_digest(b""));
        let build = || {
            Request::builder()
                .uri("/metrics")
                .header(auth::TS_HEADER, ts.to_string())
                .header(auth::NONCE_HEADER, nonce.clone())
                .header(auth::AUTH_HEADER, sig.clone())
                .body(Body::empty())
                .unwrap()
        };

        let first = router(ctx.clone()).oneshot(build()).await.unwrap();
        assert_eq!(first.status(), StatusCode::OK);

        // Byte-identical capture, sent again.
        let replay = router(ctx).oneshot(build()).await.unwrap();
        assert_eq!(
            replay.status(),
            StatusCode::UNAUTHORIZED,
            "a captured request must not work twice"
        );
    }

    #[tokio::test]
    async fn rejects_a_stale_timestamp() {
        let ts = auth::unix_now() - (auth::MAX_SKEW_SECS + 60);
        let nonce = auth::new_nonce();
        let sig = auth::signature(CODE, "GET", "/metrics", ts, &nonce, &auth::body_digest(b""));
        let resp = router(test_ctx())
            .oneshot(
                Request::builder()
                    .uri("/metrics")
                    .header(auth::TS_HEADER, ts.to_string())
                    .header(auth::NONCE_HEADER, nonce)
                    .header(auth::AUTH_HEADER, sig)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn a_signature_does_not_transfer_to_another_endpoint() {
        let ts = auth::unix_now();
        let nonce = auth::new_nonce();
        // Signed for /metrics, replayed against /power.
        let sig = auth::signature(CODE, "GET", "/metrics", ts, &nonce, &auth::body_digest(b""));
        let resp = router(test_ctx())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/power")
                    .header("content-type", "application/json")
                    .header(auth::TS_HEADER, ts.to_string())
                    .header(auth::NONCE_HEADER, nonce)
                    .header(auth::AUTH_HEADER, sig)
                    .body(Body::from(r#"{"action":"shutdown"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn locks_out_a_peer_after_repeated_failures() {
        let ctx = test_ctx();
        for _ in 0..12 {
            let _ = router(ctx.clone())
                .oneshot(signed("WRONG-CODE", "GET", "/metrics", b""))
                .await
                .unwrap();
        }
        // Even the correct code is refused while the lockout holds.
        let resp = router(ctx).oneshot(authed("/metrics")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn rotating_the_code_takes_effect_immediately() {
        let ctx = test_ctx();
        let resp = router(ctx.clone()).oneshot(authed("/metrics")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        ctx.set_access_code("ROTATED-CODE".into());

        let resp = router(ctx.clone()).oneshot(authed("/metrics")).await.unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::UNAUTHORIZED,
            "the old code must stop working the moment it is rotated"
        );

        let resp = router(ctx)
            .oneshot(signed("ROTATED-CODE", "GET", "/metrics", b""))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK, "the new code must work");
    }

    #[tokio::test]
    async fn serves_metrics_with_a_valid_signature() {
        let resp = router(test_ctx()).oneshot(authed("/metrics")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 1_000_000).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(v.get("hostName").is_some());
        assert!(v.get("services").is_some());
    }

    #[tokio::test]
    async fn refuses_file_access_outside_the_shared_folders() {
        // A real system file well outside the user's own folders. (Note that
        // the temp directory is *inside* home on Windows, so it would be a
        // legitimate read.)
        let system_file = if cfg!(windows) {
            "C:/Windows/System32/drivers/etc/hosts"
        } else {
            "/etc/hosts"
        };
        assert!(
            std::path::Path::new(system_file).exists(),
            "test needs {system_file} to exist"
        );
        let p = crate::client::path_with_query("/files/download", &[("path", system_file.into())]);

        let resp = router(test_ctx()).oneshot(authed(&p)).await.unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::BAD_REQUEST,
            "a signed request must still not read outside the shared folders"
        );
    }

    #[tokio::test]
    // The env lock deliberately spans the whole test; that is what serializes it.
    #[allow(clippy::await_holding_lock)]
    async fn refuses_an_upload_outside_the_incoming_folder() {
        let _env = crate::state::testenv::lock();
        let target = std::env::temp_dir().join("nodedesk-agent-escape.bin");
        let _ = std::fs::remove_file(&target);
        let p = target.to_string_lossy().replace('\\', "/");

        let uri = format!("/files/upload?path={p}&offset=0");
        let resp = router(test_ctx())
            .oneshot(signed(CODE, "POST", &uri, b"payload"))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert!(!target.exists(), "the file must not have been written");
    }

    #[tokio::test]
    // The env lock deliberately spans the whole test; that is what serializes it.
    #[allow(clippy::await_holding_lock)]
    async fn file_upload_download_roundtrip_with_resume() {
        let _env = crate::state::testenv::lock();
        let dir = std::env::temp_dir().join("nodedesk-agent-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("NODEDESK_INCOMING_DIR", dir.to_string_lossy().to_string());

        let path = dir.join("roundtrip.bin");
        let p = path.to_string_lossy().replace('\\', "/");

        let up = router(test_ctx())
            .oneshot(signed(CODE, "POST", &format!("/files/upload?path={p}&offset=0"), b"hello "))
            .await
            .unwrap();
        assert_eq!(up.status(), StatusCode::OK);

        let up2 = router(test_ctx())
            .oneshot(signed(CODE, "POST", &format!("/files/upload?path={p}&offset=6"), b"world"))
            .await
            .unwrap();
        assert_eq!(up2.status(), StatusCode::OK);

        // Stat reports the resumed size.
        let stat = router(test_ctx())
            .oneshot(authed(&format!("/files/stat?path={p}")))
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(stat.into_body(), 1_000_000).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["size"].as_u64().unwrap(), 11);

        // Download from offset = resume.
        let down = router(test_ctx())
            .oneshot(authed(&format!("/files/download?path={p}&offset=6")))
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(down.into_body(), 1_000_000).await.unwrap();
        assert_eq!(&bytes[..], b"world");

        std::env::remove_var("NODEDESK_INCOMING_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn terminal_executes_and_reports_cwd() {
        let resp = router(test_ctx())
            .oneshot(signed(
                CODE,
                "POST",
                "/terminal",
                br#"{"command":"echo nodedesk-agent-ok"}"#,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 1_000_000).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(v["output"].as_str().unwrap_or("").contains("nodedesk-agent-ok"));
        assert!(!v["cwd"].as_str().unwrap_or("").is_empty());
    }

    #[tokio::test]
    async fn rejects_a_tampered_body() {
        let ts = auth::unix_now();
        let nonce = auth::new_nonce();
        // Signed for a harmless command, sent with a different one.
        let sig = auth::signature(
            CODE,
            "POST",
            "/terminal",
            ts,
            &nonce,
            &auth::body_digest(br#"{"command":"echo hello"}"#),
        );
        let resp = router(test_ctx())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/terminal")
                    .header("content-type", "application/json")
                    .header(auth::TS_HEADER, ts.to_string())
                    .header(auth::NONCE_HEADER, nonce)
                    .header(auth::AUTH_HEADER, sig)
                    .body(Body::from(r#"{"command":"shutdown /s /t 0"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }
}
