//! Google account sign-in and the account-scoped directory (M2).
//!
//! Flow (SPEC §08):
//! 1. `auth_sign_in` starts a system-browser OAuth/OIDC flow with PKCE and a
//!    per-attempt state nonce, and waits for the loopback callback.
//! 2. The authorization code is exchanged directly with Google.
//! 3. The Google ID token is sent to the configured NodeDesk directory
//!    service, which verifies it server-side and issues its own session +
//!    refresh tokens. Account access tokens never become device-control
//!    credentials.
//! 4. Directory tokens live in the OS keychain when "Stay signed in" is on;
//!    otherwise only in memory. They never touch settings.json, logs, or
//!    diagnostics (SECURITY-04).
//!
//! Configuration: `account.json` in the app config directory:
//! { "clientId": "…apps.googleusercontent.com", "directoryUrl": "https://…" }
//! A missing/invalid file yields a truthful "not configured" result — never
//! a simulated account. See docs/ui-redesign/GOOGLE_SETUP.md.

use crate::state::{self, AppState};
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::Mutex;
use tauri::State;

const SESSION_KEY: &str = "account-session";
const REFRESH_KEY: &str = "account-refresh";
const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const LOOPBACK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountConfig {
    pub client_id: String,
    pub directory_url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountProfile {
    pub account_id: String,
    pub email: String,
    pub name: String,
}

#[derive(Clone)]
struct Session {
    session_token: String,
    refresh_token: String,
    profile: AccountProfile,
}

pub struct AccountState {
    config: Option<AccountConfig>,
    session: Mutex<Option<Session>>,
}

impl AccountState {
    pub fn new(config_dir: &Path) -> Self {
        let config = std::fs::read_to_string(config_dir.join("account.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<AccountConfig>(&text).ok())
            .filter(|c| !c.client_id.is_empty() && !c.directory_url.is_empty());
        Self {
            config,
            session: Mutex::new(None),
        }
    }

    fn not_configured() -> String {
        "Google sign-in is not configured in this build yet. See docs/ui-redesign/GOOGLE_SETUP.md — you can use local network mode in the meantime.".into()
    }

    fn cached(&self) -> Option<Session> {
        self.session.lock().ok().and_then(|g| g.clone())
    }

    fn cache(&self, session: Session) {
        if let Ok(mut g) = self.session.lock() {
            *g = Some(session);
        }
    }

    fn clear_cache(&self) {
        if let Ok(mut g) = self.session.lock() {
            *g = None;
        }
    }
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum AuthStateDto {
    SignedOut,
    SignedIn { profile: AccountProfile },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum SignInResultDto {
    SignedIn { profile: AccountProfile },
    Cancelled,
    NotConfigured { reason: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedComputerDto {
    device_id: String,
    public_id: String,
    name: String,
    online: serde_json::Value, // boolean or "unknown"
    is_this_device: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryAuthResponse {
    profile: DirectoryProfile,
    session_token: String,
    refresh_token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryProfile {
    account_id: String,
    email: String,
    name: String,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random_token(n: usize) -> String {
    let mut bytes = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut bytes);
    b64url(&bytes)
}

fn urlencoded(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn open_in_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let status = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url])
        .status();
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("open").arg(url).status();
    #[cfg(all(unix, not(target_os = "macos")))]
    let status = std::process::Command::new("xdg-open").arg(url).status();
    status
        .map_err(|e| format!("could not open the browser: {e}"))
        .and_then(|s| {
            if s.success() {
                Ok(())
            } else {
                Err("could not open the browser".into())
            }
        })
}

enum CallbackError {
    Cancelled,
    Failed(String),
}

/// Wait for exactly one loopback callback and return its query string.
/// Blocking I/O runs on a thread so the async runtime stays responsive.
async fn await_callback(listener: std::net::TcpListener) -> Result<String, CallbackError> {
    use std::io::{Read, Write};
    let (mut stream, _) = tokio::task::spawn_blocking(move || listener.accept())
        .await
        .map_err(|_| CallbackError::Failed("sign-in listener failed".into()))?
        .map_err(|e| CallbackError::Failed(format!("sign-in listener failed: {e}")))?;
    let _ = stream.set_read_timeout(Some(LOOPBACK_TIMEOUT));
    let mut buf = vec![0u8; 8192];
    let n = stream
        .read(&mut buf)
        .map_err(|_| CallbackError::Cancelled)?; // timeout = user gave up
    let request = String::from_utf8_lossy(&buf[..n]).to_string();
    let path = request
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| CallbackError::Failed("malformed sign-in response".into()))?
        .to_string();
    let page = "<html><body style=\"font-family:sans-serif;text-align:center;padding-top:4em\"><h2>Sign-in complete</h2><p>You can return to NodeDesk.</p></body></html>";
    let response = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
        page.len(),
        page
    );
    let _ = stream.write_all(response.as_bytes());
    Ok(path.split('?').nth(1).unwrap_or("").to_string())
}

fn query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        let mut it = pair.splitn(2, '=');
        if it.next() == Some(key) {
            return it.next().map(|v| v.replace('+', " "));
        }
    }
    None
}

fn persist_session(session: &Session, persist: bool) {
    if persist {
        let _ = state::store_secret(SESSION_KEY, &session.session_token);
        let _ = state::store_secret(REFRESH_KEY, &session.refresh_token);
    } else {
        let _ = state::delete_secret(SESSION_KEY);
        let _ = state::delete_secret(REFRESH_KEY);
    }
}

enum DirectoryError {
    Offline,
    Unauthorized,
    Failed(String),
}

/// One HTTP call against the directory service. Errors carry no token
/// material or response bodies (SECURITY-04).
async fn directory_call(
    app: &AppState,
    config: &AccountConfig,
    method: &str,
    path: &str,
    bearer: Option<&str>,
    body: Option<serde_json::Value>,
    extra_header: Option<(&str, &str)>,
) -> Result<reqwest::Response, DirectoryError> {
    let url = format!("{}{}", config.directory_url.trim_end_matches('/'), path);
    let mut req = match method {
        "GET" => app.http.get(&url),
        "PATCH" => app.http.patch(&url),
        "DELETE" => app.http.delete(&url),
        _ => app.http.post(&url),
    };
    if let Some(token) = bearer {
        req = req.bearer_auth(token);
    }
    if let Some((k, v)) = extra_header {
        req = req.header(k, v);
    }
    if let Some(json) = body {
        req = req.json(&json);
    }
    let res = req.send().await.map_err(|_| DirectoryError::Offline)?;
    if res.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(DirectoryError::Unauthorized);
    }
    if !res.status().is_success() {
        return Err(DirectoryError::Failed(format!(
            "The account service returned an error (HTTP {}).",
            res.status().as_u16()
        )));
    }
    Ok(res)
}

/// Exchange the stored refresh token for a new session, cache and persist it.
async fn refresh_session(acc: &AccountState, app: &AppState) -> Result<(), String> {
    let config = acc.config.clone().ok_or_else(AccountState::not_configured)?;
    let refresh = state::read_secret(REFRESH_KEY).ok_or("signed out")?;
    let res = directory_call(
        app,
        &config,
        "POST",
        "/auth/refresh",
        None,
        Some(serde_json::json!({ "refreshToken": refresh })),
        None,
    )
    .await
    .map_err(|e| match e {
        DirectoryError::Offline => "We couldn't reach the account service. Try again.".to_string(),
        _ => "reauth".to_string(),
    })?;
    let tokens: DirectoryAuthResponse = res
        .json()
        .await
        .map_err(|_| "The account service returned an unexpected response.".to_string())?;
    let persist = app.settings.read().map(|s| s.stay_signed_in).unwrap_or(true);
    let session = Session {
        session_token: tokens.session_token,
        refresh_token: tokens.refresh_token,
        profile: AccountProfile {
            account_id: tokens.profile.account_id,
            email: tokens.profile.email,
            name: tokens.profile.name,
        },
    };
    persist_session(&session, persist);
    acc.cache(session);
    Ok(())
}

/// Resolve a usable session token: memory, then keychain, then refresh.
async fn session_token(acc: &AccountState, app: &AppState) -> Result<String, String> {
    if let Some(s) = acc.cached() {
        return Ok(s.session_token);
    }
    if let Some(t) = state::read_secret(SESSION_KEY) {
        return Ok(t);
    }
    refresh_session(acc, app).await?;
    acc.cached().map(|s| s.session_token).ok_or("signed out".into())
}

/// GET a JSON resource with one automatic refresh-and-retry on 401.
/// `device_header` carries the local device identity when the endpoint needs
/// it (e.g. isThisDevice on the computer list).
async fn authed_get<T: serde::de::DeserializeOwned>(
    acc: &AccountState,
    app: &AppState,
    path: &str,
    device_header: Option<String>,
) -> Result<T, String> {
    let config = acc.config.clone().ok_or_else(AccountState::not_configured)?;
    let token = session_token(acc, app).await?;
    let header = device_header.as_deref().map(|id| ("x-device-id", id));
    match directory_call(app, &config, "GET", path, Some(&token), None, header).await {
        Ok(res) => res
            .json::<T>()
            .await
            .map_err(|_| "The account service returned an unexpected response.".into()),
        Err(DirectoryError::Unauthorized) => {
            refresh_session(acc, app).await?;
            let token = acc.cached().map(|s| s.session_token).ok_or("signed out")?;
            let header = device_header.as_deref().map(|id| ("x-device-id", id));
            let res = directory_call(app, &config, "GET", path, Some(&token), None, header)
                .await
                .map_err(|_| "The account service returned an error.".to_string())?;
            res.json::<T>()
                .await
                .map_err(|_| "The account service returned an unexpected response.".into())
        }
        Err(DirectoryError::Offline) => Err("We couldn't reach the account service. Try again.".into()),
        Err(DirectoryError::Failed(m)) => Err(m),
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn auth_get_state(
    acc: State<'_, AccountState>,
    app: State<'_, AppState>,
) -> Result<AuthStateDto, String> {
    if let Some(session) = acc.cached() {
        return Ok(AuthStateDto::SignedIn {
            profile: session.profile,
        });
    }
    if acc.config.is_none() {
        // No account integration configured: signedOut is the truthful state.
        return Ok(AuthStateDto::SignedOut);
    }
    if state::read_secret(SESSION_KEY).is_none() && state::read_secret(REFRESH_KEY).is_none() {
        return Ok(AuthStateDto::SignedOut);
    }
    // Restore: validate stored credentials, refreshing if needed (AUTH-05).
    match authed_get::<DirectoryProfile>(&acc, &app, "/v1/me", None).await {
        Ok(profile) => {
            let profile = AccountProfile {
                account_id: profile.account_id,
                email: profile.email,
                name: profile.name,
            };
            if let Some(mut session) = acc.cached() {
                session.profile = profile.clone();
                acc.cache(session);
            } else if let (Some(st), Some(rt)) =
                (state::read_secret(SESSION_KEY), state::read_secret(REFRESH_KEY))
            {
                acc.cache(Session {
                    session_token: st,
                    refresh_token: rt,
                    profile: profile.clone(),
                });
            }
            Ok(AuthStateDto::SignedIn { profile })
        }
        Err(m) if m.contains("account service") => Err(m), // temporary failure: offer retry (AUTH-07)
        Err(_) => {
            // Invalid/revoked credentials: drop them and require reauth.
            let _ = state::delete_secret(SESSION_KEY);
            let _ = state::delete_secret(REFRESH_KEY);
            Ok(AuthStateDto::SignedOut)
        }
    }
}

#[tauri::command]
pub async fn auth_sign_in(
    acc: State<'_, AccountState>,
    app: State<'_, AppState>,
) -> Result<SignInResultDto, String> {
    let config = match acc.config.clone() {
        Some(c) => c,
        None => {
            return Ok(SignInResultDto::NotConfigured {
                reason: AccountState::not_configured(),
            })
        }
    };

    // PKCE + per-attempt state: only the callback bound to THIS attempt is
    // accepted (AUTH-04/06).
    let verifier = random_token(32);
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    let oauth_state = random_token(16);

    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("could not start the sign-in listener: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("could not start the sign-in listener: {e}"))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}");

    let auth_url = format!(
        "{}?client_id={}&redirect_uri={}&response_type=code&scope=openid%20email%20profile&state={}&code_challenge={}&code_challenge_method=S256",
        GOOGLE_AUTH_URL,
        urlencoded(&config.client_id),
        urlencoded(&redirect_uri),
        urlencoded(&oauth_state),
        urlencoded(&challenge),
    );
    open_in_browser(&auth_url)?;

    let query = match await_callback(listener).await {
        Ok(q) => q,
        Err(CallbackError::Cancelled) => return Ok(SignInResultDto::Cancelled),
        Err(CallbackError::Failed(m)) => return Err(m),
    };
    if query_param(&query, "error").is_some() {
        // User dismissed the provider flow (AUTH-03).
        return Ok(SignInResultDto::Cancelled);
    }
    if query_param(&query, "state").as_deref() != Some(oauth_state.as_str()) {
        return Err("The sign-in response did not match this attempt. Try again.".into());
    }
    let code = query_param(&query, "code").ok_or("The sign-in response was incomplete. Try again.")?;

    // Exchange the code with Google. Token material is never logged or
    // included in error strings (SECURITY-04).
    let token_res = app
        .http
        .post(GOOGLE_TOKEN_URL)
        .form(&[
            ("client_id", config.client_id.as_str()),
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|_| "We couldn't reach Google to finish sign-in. Try again.")?;
    if !token_res.status().is_success() {
        return Err("Google sign-in did not complete. Try again.".into());
    }
    let tokens: serde_json::Value = token_res
        .json()
        .await
        .map_err(|_| "Google returned an unexpected response. Try again.")?;
    let id_token = tokens
        .get("id_token")
        .and_then(|v| v.as_str())
        .ok_or("Google returned an unexpected response. Try again.")?
        .to_string();

    // The directory verifies the identity server-side and issues our session.
    let res = directory_call(
        &app,
        &config,
        "POST",
        "/auth/google",
        None,
        Some(serde_json::json!({ "idToken": id_token })),
        None,
    )
    .await
    .map_err(|e| match e {
        DirectoryError::Offline => "We couldn't reach the account service. Try again.".to_string(),
        DirectoryError::Unauthorized => "Your Google identity could not be verified. Try again.".to_string(),
        DirectoryError::Failed(m) => m,
    })?;
    let dir_res: DirectoryAuthResponse = res
        .json()
        .await
        .map_err(|_| "The account service returned an unexpected response.".to_string())?;

    let profile = AccountProfile {
        account_id: dir_res.profile.account_id,
        email: dir_res.profile.email,
        name: dir_res.profile.name,
    };
    let persist = app.settings.read().map(|s| s.stay_signed_in).unwrap_or(true);
    let session = Session {
        session_token: dir_res.session_token,
        refresh_token: dir_res.refresh_token,
        profile: profile.clone(),
    };
    persist_session(&session, persist);
    acc.cache(session);
    Ok(SignInResultDto::SignedIn { profile })
}

#[tauri::command]
pub async fn auth_sign_out(acc: State<'_, AccountState>, app: State<'_, AppState>) -> Result<(), String> {
    // Best-effort service revocation; local clearing is authoritative.
    if let Some(config) = acc.config.clone() {
        let token = acc.cached().map(|s| s.session_token).or_else(|| state::read_secret(SESSION_KEY));
        if let Some(t) = token {
            let _ = directory_call(&app, &config, "POST", "/auth/logout", Some(&t), None, None).await;
        }
    }
    acc.clear_cache();
    let _ = state::delete_secret(SESSION_KEY);
    let _ = state::delete_secret(REFRESH_KEY);
    Ok(())
}

#[tauri::command]
pub async fn auth_set_stay_signed_in(
    acc: State<'_, AccountState>,
    app: State<'_, AppState>,
    stay: bool,
) -> Result<(), String> {
    if let Ok(mut settings) = app.settings.write() {
        settings.stay_signed_in = stay;
    }
    app.save_settings();
    // AUTH-05: turning it off removes durable restoration credentials; the
    // current in-memory session stays valid (SETTINGS-01).
    if !stay {
        let _ = state::delete_secret(SESSION_KEY);
        let _ = state::delete_secret(REFRESH_KEY);
    } else if let Some(session) = acc.cached() {
        persist_session(&session, true);
    }
    Ok(())
}

#[tauri::command]
pub async fn dir_list_computers(
    acc: State<'_, AccountState>,
    app: State<'_, AppState>,
) -> Result<Vec<SavedComputerDto>, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Wire {
        device_id: String,
        public_id: String,
        name: String,
        online: serde_json::Value,
        #[serde(default)]
        is_this_device: bool,
    }
    #[derive(Deserialize)]
    struct ListResponse {
        computers: Vec<Wire>,
    }
    let device_id = load_or_create_device(&app)?.device_id;
    let res: ListResponse = authed_get(&acc, &app, "/v1/computers", Some(device_id)).await?;
    Ok(res
        .computers
        .into_iter()
        .map(|c| SavedComputerDto {
            device_id: c.device_id,
            public_id: c.public_id,
            name: c.name,
            online: c.online,
            is_this_device: c.is_this_device,
        })
        .collect())
}

// ---------------------------------------------------------------------------
// M3: local device identity, enrollment, directory management
// ---------------------------------------------------------------------------

/// Stable local device identity, persisted in the app config directory as
/// `device.json`. Generated once; survives IP/name changes and restarts
/// (HOST-01). The public ID is assigned by the service at enrollment.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceIdentityFile {
    device_id: String,
    name: String,
    #[serde(default)]
    public_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentityDto {
    device_id: String,
    name: String,
    enrolled: bool,
    public_id: Option<String>,
}

fn device_file_path(app: &AppState) -> std::path::PathBuf {
    app.config_dir.join("device.json")
}

fn load_or_create_device(app: &AppState) -> Result<DeviceIdentityFile, String> {
    let path = device_file_path(app);
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(parsed) = serde_json::from_str::<DeviceIdentityFile>(&text) {
            return Ok(parsed);
        }
    }
    let created = DeviceIdentityFile {
        device_id: random_token(18),
        name: std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_else(|_| "This computer".into()),
        public_id: None,
    };
    save_device_file(app, &created)?;
    Ok(created)
}

fn save_device_file(app: &AppState, device: &DeviceIdentityFile) -> Result<(), String> {
    let text = serde_json::to_string_pretty(device).map_err(|_| "could not store the device identity")?;
    std::fs::write(device_file_path(app), text).map_err(|e| format!("could not store the device identity: {e}"))
}

/// Authenticated JSON call of any method with one refresh-and-retry on 401.
async fn authed_call(
    acc: &AccountState,
    app: &AppState,
    method: &str,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let config = acc.config.clone().ok_or_else(AccountState::not_configured)?;
    let token = session_token(acc, app).await?;
    match directory_call(app, &config, method, path, Some(&token), body.clone(), None).await {
        Ok(res) => res
            .json::<serde_json::Value>()
            .await
            .map_err(|_| "The account service returned an unexpected response.".into()),
        Err(DirectoryError::Unauthorized) => {
            refresh_session(acc, app).await?;
            let token = acc.cached().map(|s| s.session_token).ok_or("signed out")?;
            let res = directory_call(app, &config, method, path, Some(&token), body, None)
                .await
                .map_err(|_| "The account service returned an error.".to_string())?;
            res.json::<serde_json::Value>()
                .await
                .map_err(|_| "The account service returned an unexpected response.".into())
        }
        Err(DirectoryError::Offline) => Err("We couldn't reach the account service. Try again.".into()),
        Err(DirectoryError::Failed(m)) => Err(m),
    }
}

#[tauri::command]
pub async fn device_get_identity(app: State<'_, AppState>) -> Result<DeviceIdentityDto, String> {
    let device = load_or_create_device(&app)?;
    Ok(DeviceIdentityDto {
        device_id: device.device_id,
        name: device.name,
        enrolled: device.public_id.is_some(),
        public_id: device.public_id,
    })
}

#[tauri::command]
pub async fn device_enroll(
    acc: State<'_, AccountState>,
    app: State<'_, AppState>,
    name: String,
) -> Result<DeviceIdentityDto, String> {
    // HOST-02: explicit owner action enrolls the device. The local file is
    // updated only after the service confirms — a failed enrollment never
    // reports a valid ID.
    let mut device = load_or_create_device(&app)?;
    if !name.trim().is_empty() {
        device.name = name.trim().to_string();
    }
    let res = authed_call(
        &acc,
        &app,
        "POST",
        "/v1/devices/enroll",
        Some(serde_json::json!({ "deviceId": device.device_id, "name": device.name })),
    )
    .await?;
    let public_id = res
        .get("publicId")
        .and_then(|v| v.as_str())
        .ok_or("The account service returned an unexpected response.")?
        .to_string();
    device.public_id = Some(public_id);
    save_device_file(&app, &device)?;
    Ok(DeviceIdentityDto {
        device_id: device.device_id,
        name: device.name,
        enrolled: true,
        public_id: device.public_id,
    })
}

#[tauri::command]
pub async fn device_heartbeat(acc: State<'_, AccountState>, app: State<'_, AppState>) -> Result<(), String> {
    let device = load_or_create_device(&app)?;
    if device.public_id.is_none() {
        return Ok(()); // not enrolled: nothing to report
    }
    let _ = authed_call(
        &acc,
        &app,
        "POST",
        "/v1/devices/heartbeat",
        Some(serde_json::json!({ "deviceId": device.device_id })),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn dir_resolve_device_id(
    acc: State<'_, AccountState>,
    app: State<'_, AppState>,
    public_id: String,
) -> Result<serde_json::Value, String> {
    authed_call(
        &acc,
        &app,
        "POST",
        "/v1/computers/resolve",
        Some(serde_json::json!({ "publicId": public_id })),
    )
    .await
}

#[tauri::command]
pub async fn dir_add_computer(
    acc: State<'_, AccountState>,
    app: State<'_, AppState>,
    public_id: String,
    name: String,
) -> Result<serde_json::Value, String> {
    let device = load_or_create_device(&app)?;
    authed_call(
        &acc,
        &app,
        "POST",
        "/v1/computers",
        Some(serde_json::json!({ "publicId": public_id, "name": name, "ownDeviceId": device.device_id })),
    )
    .await
}

#[tauri::command]
pub async fn dir_rename_computer(
    acc: State<'_, AccountState>,
    app: State<'_, AppState>,
    device_id: String,
    name: String,
) -> Result<(), String> {
    let _ = authed_call(
        &acc,
        &app,
        "PATCH",
        "/v1/computers",
        Some(serde_json::json!({ "deviceId": device_id, "name": name })),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn dir_remove_computer(
    acc: State<'_, AccountState>,
    app: State<'_, AppState>,
    device_id: String,
) -> Result<(), String> {
    let _ = authed_call(
        &acc,
        &app,
        "DELETE",
        "/v1/computers",
        Some(serde_json::json!({ "deviceId": device_id })),
    )
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// M4: host policy, connection requests, trust — thin wrappers over the
// directory service. The service owns deadlines, decisions, and trust
// records; the native host agent consumes the granted permissions when a
// session actually starts (native enforcement wiring is the M4/M5 spike).
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn host_get_policy(acc: State<'_, AccountState>, app: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let device = load_or_create_device(&app)?;
    authed_call(&acc, &app, "GET", &format!("/v1/devices/policy?deviceId={}", device.device_id), None).await
}

#[tauri::command]
pub async fn host_set_policy(
    acc: State<'_, AccountState>,
    app: State<'_, AppState>,
    unattended: bool,
) -> Result<(), String> {
    let device = load_or_create_device(&app)?;
    if device.public_id.is_none() {
        return Err("Enroll this computer first.".into());
    }
    let _ = authed_call(
        &acc,
        &app,
        "POST",
        "/v1/devices/policy",
        Some(serde_json::json!({ "deviceId": device.device_id, "unattended": unattended })),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn host_pending_requests(
    acc: State<'_, AccountState>,
    app: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let device = load_or_create_device(&app)?;
    if device.public_id.is_none() {
        return Ok(serde_json::json!({ "requests": [] }));
    }
    let res = authed_call(
        &acc,
        &app,
        "GET",
        &format!("/v1/requests/pending?deviceId={}", device.device_id),
        None,
    )
    .await?;
    Ok(res.get("requests").cloned().unwrap_or(serde_json::json!([])))
}

#[tauri::command]
pub async fn host_accept_request(
    acc: State<'_, AccountState>,
    app: State<'_, AppState>,
    id: String,
    permissions: serde_json::Value,
    trust: bool,
) -> Result<serde_json::Value, String> {
    authed_call(
        &acc,
        &app,
        "POST",
        "/v1/requests/accept",
        Some(serde_json::json!({
            "id": id,
            "control": permissions.get("control").and_then(|v| v.as_bool()).unwrap_or(false),
            "files": permissions.get("files").and_then(|v| v.as_bool()).unwrap_or(false),
            "clipboard": permissions.get("clipboard").and_then(|v| v.as_bool()).unwrap_or(false),
            "audio": permissions.get("audio").and_then(|v| v.as_bool()).unwrap_or(false),
            "trust": trust,
        })),
    )
    .await
}

#[tauri::command]
pub async fn host_reject_request(acc: State<'_, AccountState>, app: State<'_, AppState>, id: String) -> Result<(), String> {
    let _ = authed_call(&acc, &app, "POST", "/v1/requests/reject", Some(serde_json::json!({ "id": id }))).await?;
    Ok(())
}

#[tauri::command]
pub async fn request_create(
    acc: State<'_, AccountState>,
    app: State<'_, AppState>,
    host_device_id: String,
    label: String,
) -> Result<serde_json::Value, String> {
    authed_call(
        &acc,
        &app,
        "POST",
        "/v1/requests",
        Some(serde_json::json!({ "hostDeviceId": host_device_id, "label": label })),
    )
    .await
}

#[tauri::command]
pub async fn request_status(acc: State<'_, AccountState>, app: State<'_, AppState>, id: String) -> Result<serde_json::Value, String> {
    authed_call(&acc, &app, "GET", &format!("/v1/requests/status?id={}", id), None).await
}

#[tauri::command]
pub async fn request_cancel(acc: State<'_, AccountState>, app: State<'_, AppState>, id: String) -> Result<(), String> {
    let _ = authed_call(&acc, &app, "POST", "/v1/requests/cancel", Some(serde_json::json!({ "id": id }))).await?;
    Ok(())
}

#[tauri::command]
pub async fn request_end(acc: State<'_, AccountState>, app: State<'_, AppState>, id: String) -> Result<(), String> {
    let _ = authed_call(&acc, &app, "POST", "/v1/requests/end", Some(serde_json::json!({ "id": id }))).await?;
    Ok(())
}

#[tauri::command]
pub async fn trust_list(acc: State<'_, AccountState>, app: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let device = load_or_create_device(&app)?;
    if device.public_id.is_none() {
        return Ok(serde_json::json!([]));
    }
    let res = authed_call(
        &acc,
        &app,
        "GET",
        &format!("/v1/devices/trusted?deviceId={}", device.device_id),
        None,
    )
    .await?;
    Ok(res.get("controllers").cloned().unwrap_or(serde_json::json!([])))
}

#[tauri::command]
pub async fn trust_revoke(
    acc: State<'_, AccountState>,
    app: State<'_, AppState>,
    controller_device_id: String,
) -> Result<(), String> {
    let device = load_or_create_device(&app)?;
    let _ = authed_call(
        &acc,
        &app,
        "POST",
        "/v1/devices/trusted/revoke",
        Some(serde_json::json!({ "deviceId": device.device_id, "controllerDeviceId": controller_device_id })),
    )
    .await?;
    Ok(())
}
