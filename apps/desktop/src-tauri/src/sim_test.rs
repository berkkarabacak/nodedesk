//! Simulated two-machine end-to-end test.
//!
//! "Machine B" is a real NodeDesk agent served over real TCP on 127.0.0.1
//! with its own access code. "Machine A" (the controller) drives it through
//! the exact client code paths the app uses, with ports and the Sunshine API
//! redirected through env overrides. A mock Sunshine server validates the
//! pairing-approval flow without real Sunshine installed.
//!
//! What this proves: discovery, auth, metrics, pairing approval, resumable
//! file transfer (both directions, incl. mid-transfer resume), and terminal
//! execution all work machine-to-machine. What it cannot prove: the video
//! stream itself (that is upstream Sunshine/Moonlight's domain).

#![cfg(test)]

use crate::{agent, auth, client, discovery, files, state, sunshine, terminal};
use axum::{extract::State, response::IntoResponse, routing::post, Json, Router};
use std::sync::mpsc;

/// Starts a simulated machine: a NodeDesk agent on an ephemeral port.
/// Returns its port.
async fn spawn_machine(code: &str) -> u16 {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let ctx = std::sync::Arc::new(agent::AgentCtx::new(code.to_string()));
    tokio::spawn(async move {
        let _ = axum::serve(listener, agent::router(ctx)).await;
    });
    port
}

/// Starts a mock Sunshine API that records approved PINs.
async fn spawn_mock_sunshine() -> (u16, mpsc::Receiver<String>) {
    let (tx, rx) = mpsc::channel::<String>();
    async fn pin_handler(
        State(tx): State<mpsc::Sender<String>>,
        Json(body): Json<serde_json::Value>,
    ) -> impl IntoResponse {
        let pin = body.get("pin").and_then(|p| p.as_str()).unwrap_or("").to_string();
        let _ = tx.send(pin);
        Json(serde_json::json!({ "status": "true" }))
    }
    let app = Router::new().route("/api/pin", post(pin_handler)).with_state(tx);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (port, rx)
}

#[tokio::test]
// The env lock deliberately spans the whole test; that is what serializes it.
#[allow(clippy::await_holding_lock)]
async fn two_machine_end_to_end() {
    let _env = crate::state::testenv::lock();
    // --- Machine B boots: host agent with its own access code ---
    let machine_b_port = spawn_machine("SIMB-CODE").await;
    std::env::set_var("NODEDESK_AGENT_PORT", machine_b_port.to_string());

    // --- Machine A boots: fresh state in a temp config dir ---
    let dir_a = std::env::temp_dir().join(format!("nodedesk-simA-{}", std::process::id()));
    let machine_a = state::AppState::new(dir_a.clone());
    state::store_host_code("127.0.0.1", "SIMB-CODE").expect("store B's access code");

    // --- 1. Discovery: B answers a LAN scan on a test port ---
    let discovery_port = 49990u16;
    discovery::start_responder_on(discovery_port);
    std::thread::sleep(std::time::Duration::from_millis(200));
    let found = discovery::scan_on(discovery_port, 900, true);
    assert!(!found.is_empty(), "discovery scan should find the simulated host");
    assert!(!found[0].name.is_empty());

    // --- 2. Metrics: A sees B's live system info ---
    let resp = client::AgentRequest::get("127.0.0.1", machine_b_port, "/metrics")
        .send(&machine_a.http, "SIMB-CODE")
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let metrics: serde_json::Value = resp.json().await.unwrap();
    assert!(metrics.get("hostName").is_some());
    assert!(metrics.get("cpuPct").is_some());

    // Wrong code is rejected.
    let resp = client::AgentRequest::get("127.0.0.1", machine_b_port, "/metrics")
        .send(&machine_a.http, "WRONG-CODE")
        .await
        .unwrap();
    assert_eq!(resp.status(), 401);

    // The access code itself is never transmitted: a peer capturing the wire
    // sees only a signature over this one request.
    let target = client::path_with_query("/metrics", &[]);
    let ts = auth::unix_now();
    let nonce = auth::new_nonce();
    let signature = auth::signature(
        "SIMB-CODE",
        "GET",
        &target,
        ts,
        &nonce,
        &auth::body_digest(b""),
    );
    assert!(!signature.contains("SIMB-CODE"));
    // ...and that capture cannot be replayed.
    let replay = |sig: String, nonce: String, ts: i64| {
        machine_a
            .http
            .get(format!("http://127.0.0.1:{machine_b_port}/metrics"))
            .header(auth::TS_HEADER, ts.to_string())
            .header(auth::NONCE_HEADER, nonce)
            .header(auth::AUTH_HEADER, sig)
            .send()
    };
    let first = replay(signature.clone(), nonce.clone(), ts).await.unwrap();
    assert_eq!(first.status(), 200, "the signed request itself works once");
    let second = replay(signature, nonce, ts).await.unwrap();
    assert_eq!(second.status(), 401, "a captured request must not replay");

    // --- 3. Pairing: A approves a PIN on B's (mock) Sunshine ---
    let (sun_port, pin_rx) = spawn_mock_sunshine().await;
    std::env::set_var("NODEDESK_SUNSHINE_API", format!("http://127.0.0.1:{sun_port}"));
    let _ = state::store_secret("sunshine-credentials", "nodedesk:sim-test");
    sunshine::approve_pin(&machine_a.http_local, "12 34")
        .await
        .expect("PIN approval should succeed against mock Sunshine");
    let received = pin_rx
        .recv_timeout(std::time::Duration::from_secs(2))
        .expect("mock Sunshine should receive the PIN");
    assert_eq!(received, "1234", "PIN must be normalized before sending");

    // --- 4. File transfer A → B, with a mid-transfer resume ---
    let work = std::env::temp_dir().join(format!("nodedesk-sim-files-{}", std::process::id()));
    let incoming = work.join("incoming");
    let downloads = work.join("downloads");
    std::fs::create_dir_all(&incoming).unwrap();
    std::env::set_var("NODEDESK_INCOMING_DIR", incoming.to_string_lossy().to_string());
    std::env::set_var("NODEDESK_DOWNLOAD_DIR", downloads.to_string_lossy().to_string());

    // 6 MiB of patterned content forces multiple chunks.
    let content: Vec<u8> = (0..6 * 1024 * 1024).map(|i| (i % 251) as u8).collect();
    let local_file = work.join("bigfile.bin");
    std::fs::write(&local_file, &content).unwrap();

    let noop = |_: &files::TransferProgress| {};
    files::send_files(&machine_a, "127.0.0.1", vec![local_file.to_string_lossy().to_string()], &noop)
        .await
        .expect("upload should succeed");
    let remote_file = incoming.join("bigfile.bin");
    assert_eq!(std::fs::read(&remote_file).unwrap(), content, "uploaded file must match byte-for-byte");

    // Simulate an interrupted upload: remote keeps only the first 3 MiB.
    let truncated = &content[..3 * 1024 * 1024];
    std::fs::write(&remote_file, truncated).unwrap();
    files::send_files(&machine_a, "127.0.0.1", vec![local_file.to_string_lossy().to_string()], &noop)
        .await
        .expect("resumed upload should succeed");
    assert_eq!(std::fs::read(&remote_file).unwrap(), content, "resumed upload must complete correctly");

    // --- 5. File transfer B → A, resuming a partial download ---
    let partial = downloads.join("NodeDesk");
    std::fs::create_dir_all(&partial).unwrap();
    std::fs::write(partial.join("bigfile.bin"), &content[..2 * 1024 * 1024]).unwrap();
    let saved = files::download_file(&machine_a, "127.0.0.1", &remote_file.to_string_lossy(), &noop)
        .await
        .expect("download should succeed");
    assert_eq!(std::fs::read(&saved).unwrap(), content, "resumed download must match byte-for-byte");

    // --- 6. Terminal on B from A ---
    let resp = client::AgentRequest::post("127.0.0.1", machine_b_port, "/terminal")
        .json(&serde_json::json!({ "command": "echo nodedesk-sim-ok" }))
        .unwrap()
        .send_ok(&machine_a.http, "SIMB-CODE")
        .await
        .unwrap();
    let result: terminal::TerminalResult = resp.json().await.unwrap();
    assert!(result.output.contains("nodedesk-sim-ok"), "terminal output: {}", result.output);
    assert!(!result.cwd.is_empty());

    let _ = std::fs::remove_dir_all(&work);
    let _ = std::fs::remove_dir_all(&dir_a);
}
