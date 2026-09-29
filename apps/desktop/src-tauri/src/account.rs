//! Google account session for fleet discovery.
//!
//! Phase A (see docs/adr/0002-account-based-fleet.md) stores a Google sign-in
//! on this computer and publishes private address candidates to an
//! owner-supplied registry. It does not punch a hole to Sunshine.
//!
//! The OAuth client id is configuration (`NODEDESK_GOOGLE_CLIENT_ID` or
//! settings), not a secret baked into the binary. There is no client secret:
//! a desktop app is a public client and uses PKCE. Access tokens, refresh
//! tokens, and the signed-in email live in OS secure storage, same as access
//! codes.

use crate::registry::{self, DeviceRegistration, Registry};
use crate::state::{self, Settings};
use base64::Engine;
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

const SESSION_KEY: &str = "account-session";
const LINKED_DEVICE_KEY: &str = "account-linked-device";
const SIGN_IN_WAIT: Duration = Duration::from_secs(180);
const OAUTH_TIMEOUT: Duration = Duration::from_secs(15);

const DEFAULT_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const DEFAULT_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const DEFAULT_USERINFO_URL: &str = "https://openidconnect.googleapis.com/v1/userinfo";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub subject: String,
    pub email: String,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at_unix: Option<i64>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub configured: bool,
    pub registry_configured: bool,
    pub signed_in: bool,
    pub email: Option<String>,
    pub linked: bool,
}

#[derive(Clone, Debug)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

impl Pkce {
    pub fn generate() -> Self {
        Self::from_verifier(&random_token(64))
    }

    pub fn from_verifier(verifier: &str) -> Self {
        Self {
            challenge: code_challenge(verifier),
            verifier: verifier.to_string(),
        }
    }
}

pub struct SignInExchange {
    pub client_id: String,
    pub token_url: String,
    pub userinfo_url: String,
    pub code: String,
    pub verifier: String,
    pub redirect_uri: String,
}

pub fn resolve_client_id(settings: &Settings) -> String {
    env_nonempty("NODEDESK_GOOGLE_CLIENT_ID")
        .unwrap_or_else(|| settings.google_client_id.trim().to_string())
}

pub fn resolve_registry_url(settings: &Settings) -> String {
    env_nonempty("NODEDESK_REGISTRY_URL")
        .unwrap_or_else(|| settings.registry_base_url.trim().to_string())
}

pub fn require_client_id(settings: &Settings) -> Result<String, String> {
    require_client_id_str(&resolve_client_id(settings))
}

fn require_client_id_str(client_id: &str) -> Result<String, String> {
    let client_id = client_id.trim();
    if client_id.is_empty() {
        return Err("Sign-in isn't configured on this computer yet.".into());
    }
    if !client_id_looks_valid(client_id) {
        return Err("Sign-in client ID is not valid.".into());
    }
    Ok(client_id.to_string())
}

fn client_id_looks_valid(id: &str) -> bool {
    (1..=200).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_'))
}

pub fn status(settings: &Settings) -> AccountStatus {
    let session = load_session();
    let device_id = settings.device_id.trim();
    let linked =
        session.is_some() && linked_device().as_deref() == Some(device_id) && !device_id.is_empty();
    AccountStatus {
        configured: require_client_id_str(&resolve_client_id(settings)).is_ok(),
        registry_configured: registry::parse_base(&resolve_registry_url(settings)).is_ok(),
        signed_in: session.is_some(),
        email: session.map(|session| session.email),
        linked,
    }
}

pub fn load_session() -> Option<Session> {
    let text = state::read_secret(SESSION_KEY)?;
    session_from_json(&text)
}

fn session_from_json(text: &str) -> Option<Session> {
    let session = serde_json::from_str::<Session>(text).ok()?;
    if session.subject.is_empty() || session.email.is_empty() || session.access_token.is_empty() {
        return None;
    }
    Some(session)
}

pub fn store_session(session: &Session) -> Result<(), String> {
    if session.subject.is_empty() || session.email.is_empty() || session.access_token.is_empty() {
        return Err("Sign-in response was incomplete.".into());
    }
    let text =
        serde_json::to_string(session).map_err(|_| "Couldn't store the sign-in.".to_string())?;
    state::store_secret(SESSION_KEY, &text)
}

pub fn sign_out() -> Result<(), String> {
    state::delete_secret(SESSION_KEY)?;
    state::delete_secret(LINKED_DEVICE_KEY)?;
    Ok(())
}

pub fn linked_device() -> Option<String> {
    state::read_secret(LINKED_DEVICE_KEY).filter(|id| registry::is_device_id(id))
}

pub fn store_link(device_id: &str) -> Result<(), String> {
    if !registry::is_device_id(device_id) {
        return Err("device id is not valid".into());
    }
    state::store_secret(LINKED_DEVICE_KEY, device_id)
}

pub fn ensure_device_id(settings: &mut Settings) -> String {
    if !registry::is_device_id(settings.device_id.trim()) {
        settings.device_id = new_device_id();
    }
    settings.device_id.clone()
}

pub fn new_device_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7], bytes[8], bytes[9], bytes[10],
        bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    )
}

pub fn access_token_current(session: &Session) -> bool {
    match session.expires_at_unix {
        Some(expires) => now_unix().saturating_add(30) < expires,
        None => true,
    }
}

pub fn authorization_url(
    auth_endpoint: &str,
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    challenge: &str,
) -> String {
    let query = form_pairs(&[
        ("client_id", client_id),
        ("redirect_uri", redirect_uri),
        ("response_type", "code"),
        ("scope", "openid email"),
        ("state", state),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256"),
        ("access_type", "offline"),
        ("prompt", "consent"),
    ]);
    format!("{auth_endpoint}?{query}")
}

pub async fn finish_sign_in(
    http: &reqwest::Client,
    exchange: &SignInExchange,
) -> Result<Session, String> {
    let client_id = require_client_id_str(&exchange.client_id)?;
    let tokens = request_token(
        http,
        &exchange.token_url,
        &[
            ("grant_type", "authorization_code"),
            ("code", &exchange.code),
            ("client_id", &client_id),
            ("redirect_uri", &exchange.redirect_uri),
            ("code_verifier", &exchange.verifier),
        ],
    )
    .await
    .map_err(token_error_message)?;
    let identity = fetch_identity(http, &exchange.userinfo_url, &tokens.access_token).await?;
    let session = Session {
        subject: identity.subject,
        email: identity.email,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at_unix: tokens.expires_at_unix,
    };
    store_session(&session)?;
    Ok(session)
}

pub async fn ensure_fresh_token(
    http: &reqwest::Client,
    settings: &Settings,
    session: Session,
) -> Result<Session, String> {
    if access_token_current(&session) {
        return Ok(session);
    }
    let Some(refresh) = session.refresh_token.clone() else {
        let _ = sign_out();
        return Err("Sign in again.".into());
    };
    let client_id = require_client_id(settings)?;
    match request_token(
        http,
        &token_endpoint(),
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", &refresh),
            ("client_id", &client_id),
        ],
    )
    .await
    {
        Ok(tokens) => {
            let updated = Session {
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token.or(session.refresh_token),
                expires_at_unix: tokens.expires_at_unix,
                ..session
            };
            store_session(&updated)?;
            Ok(updated)
        }
        Err(TokenError::Rejected) => {
            let _ = sign_out();
            Err("Sign in again.".into())
        }
        Err(TokenError::Unreachable) => Err("Couldn't reach the sign-in service.".into()),
    }
}

pub async fn sign_in_with_google(state: &state::AppState) -> Result<AccountStatus, String> {
    let settings = state.settings.read().map_err(|e| e.to_string())?.clone();
    let client_id = require_client_id(&settings)?;
    sign_in_interactive(&state.http, &client_id).await?;
    if registry::parse_base(&resolve_registry_url(&settings)).is_ok() {
        let _ = link_this_computer(state).await;
    }
    let settings = state.settings.read().map_err(|e| e.to_string())?.clone();
    Ok(status(&settings))
}

pub async fn sign_out_account(state: &state::AppState) -> Result<AccountStatus, String> {
    let settings = state.settings.read().map(|s| s.clone()).unwrap_or_default();
    if let (Some(session), Some(device_id)) = (load_session(), linked_device()) {
        if let Ok(registry) =
            Registry::from_base_url(state.http.clone(), &resolve_registry_url(&settings))
        {
            let _ = registry.unlink(&session.access_token, &device_id).await;
        }
    }
    sign_out()?;
    Ok(status(&settings))
}

pub async fn link_this_computer(state: &state::AppState) -> Result<AccountStatus, String> {
    let settings = state.settings.read().map_err(|e| e.to_string())?.clone();
    let session = load_session().ok_or("Sign in before linking this computer.")?;
    let session = ensure_fresh_token(&state.http, &settings, session).await?;
    let registry = Registry::from_base_url(state.http.clone(), &resolve_registry_url(&settings))
        .map_err(|_| {
            "Add an account service address before this computer can be linked.".to_string()
        })?;
    let (device_id, created) = {
        let mut guard = state.settings.write().map_err(|e| e.to_string())?;
        let created = !registry::is_device_id(guard.device_id.trim());
        let id = ensure_device_id(&mut guard);
        (id, created)
    };
    if created {
        state.save_settings();
    }
    let registration = DeviceRegistration {
        device_id: device_id.clone(),
        display_name: sysinfo::System::host_name().unwrap_or_else(|| "This computer".into()),
        os: std::env::consts::OS.to_string(),
        addresses: advertised_addresses(),
    };
    registry
        .register(&session.access_token, &registration)
        .await?;
    store_link(&device_id)?;
    let settings = state.settings.read().map_err(|e| e.to_string())?.clone();
    Ok(status(&settings))
}

pub async fn heartbeat_if_linked(state: &state::AppState) -> Result<(), String> {
    let settings = state.settings.read().map_err(|e| e.to_string())?.clone();
    let Some(device_id) = linked_device() else {
        return Ok(());
    };
    if settings.device_id != device_id {
        return Ok(());
    }
    let Some(session) = load_session() else {
        return Ok(());
    };
    let session = ensure_fresh_token(&state.http, &settings, session).await?;
    let registry = Registry::from_base_url(state.http.clone(), &resolve_registry_url(&settings))?;
    let registration = DeviceRegistration {
        device_id,
        display_name: sysinfo::System::host_name().unwrap_or_else(|| "This computer".into()),
        os: std::env::consts::OS.to_string(),
        addresses: advertised_addresses(),
    };
    registry
        .heartbeat(&session.access_token, &registration)
        .await?;
    Ok(())
}

/// Other computers on this account. Empty when nobody is signed in, when no
/// registry is configured, or when the registry cannot be reached — LAN
/// discovery must keep working either way.
pub async fn remote_devices(
    http: reqwest::Client,
    settings: Settings,
) -> Vec<registry::AccountSighting> {
    let Some(session) = load_session() else {
        return Vec::new();
    };
    let Ok(registry) = Registry::from_base_url(http.clone(), &resolve_registry_url(&settings))
    else {
        return Vec::new();
    };
    let Ok(session) = ensure_fresh_token(&http, &settings, session).await else {
        return Vec::new();
    };
    match registry.list_devices(&session.access_token).await {
        Ok(devices) => registry::sightings(&devices, &settings.device_id),
        Err(registry::RegistryError::Expired) => {
            let _ = sign_out();
            Vec::new()
        }
        Err(_) => Vec::new(),
    }
}

pub fn advertised_addresses() -> Vec<registry::AddressCandidate> {
    let mut out = Vec::new();
    if let Some(ip) = crate::discovery::local_ip() {
        push_advertised(
            &mut out,
            registry::AddressCandidate {
                kind: registry::AddressKind::Lan,
                value: ip,
            },
        );
    }
    for ip in crate::discovery::tailscale_self_ips() {
        push_advertised(
            &mut out,
            registry::AddressCandidate {
                kind: registry::AddressKind::Tailscale,
                value: ip,
            },
        );
    }
    out
}

fn push_advertised(
    out: &mut Vec<registry::AddressCandidate>,
    candidate: registry::AddressCandidate,
) {
    if registry::is_usable_address(&candidate)
        && !out.iter().any(|existing| existing.value == candidate.value)
    {
        out.push(candidate);
    }
}

async fn sign_in_interactive(http: &reqwest::Client, client_id: &str) -> Result<Session, String> {
    let port = configured_redirect_port();
    let listener = match std::net::TcpListener::bind(("127.0.0.1", port)) {
        Ok(listener) => listener,
        Err(_) if port != 0 => return Err("The sign-in port is already in use.".into()),
        Err(_) => return Err("Couldn't start sign-in on this computer.".into()),
    };
    listener
        .set_nonblocking(true)
        .map_err(|_| "Couldn't start sign-in on this computer.".to_string())?;
    let bound = listener
        .local_addr()
        .map_err(|_| "Couldn't start sign-in on this computer.".to_string())?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{bound}/callback");
    let pkce = Pkce::generate();
    let state = random_token(32);
    let url = authorization_url(
        &auth_endpoint(),
        client_id,
        &redirect_uri,
        &state,
        &pkce.challenge,
    );
    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_wait = cancel.clone();
    let expected = state.clone();
    let verifier = pkce.verifier.clone();
    let wait =
        tokio::task::spawn_blocking(move || accept_oauth_code(listener, &expected, &cancel_wait));
    if let Err(err) = open_browser(&url) {
        cancel.store(true, Ordering::SeqCst);
        let _ = wait.await;
        return Err(err);
    }
    let code = wait
        .await
        .map_err(|_| "Sign-in was interrupted.".to_string())??;
    finish_sign_in(
        http,
        &SignInExchange {
            client_id: client_id.to_string(),
            token_url: token_endpoint(),
            userinfo_url: userinfo_endpoint(),
            code,
            verifier,
            redirect_uri,
        },
    )
    .await
}

fn configured_redirect_port() -> u16 {
    std::env::var("NODEDESK_OAUTH_REDIRECT_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

fn auth_endpoint() -> String {
    env_nonempty("NODEDESK_OAUTH_AUTH_URL").unwrap_or_else(|| DEFAULT_AUTH_URL.to_string())
}

fn token_endpoint() -> String {
    env_nonempty("NODEDESK_OAUTH_TOKEN_URL").unwrap_or_else(|| DEFAULT_TOKEN_URL.to_string())
}

fn userinfo_endpoint() -> String {
    env_nonempty("NODEDESK_OAUTH_USERINFO_URL").unwrap_or_else(|| DEFAULT_USERINFO_URL.to_string())
}

fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

struct TokenSet {
    access_token: String,
    refresh_token: Option<String>,
    expires_at_unix: Option<i64>,
}

enum TokenError {
    Rejected,
    Unreachable,
}

fn token_error_message(err: TokenError) -> String {
    match err {
        TokenError::Rejected => "Sign-in was rejected. Try again.".into(),
        TokenError::Unreachable => "Couldn't reach the sign-in service.".into(),
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
}

#[derive(Deserialize)]
struct UserInfo {
    sub: String,
    email: String,
    #[serde(default)]
    email_verified: Option<bool>,
}

struct Identity {
    subject: String,
    email: String,
}

async fn request_token(
    http: &reqwest::Client,
    url: &str,
    fields: &[(&str, &str)],
) -> Result<TokenSet, TokenError> {
    let response = http
        .post(url)
        .header("content-type", "application/x-www-form-urlencoded")
        .body(form_pairs(fields))
        .timeout(OAUTH_TIMEOUT)
        .send()
        .await
        .map_err(|_| TokenError::Unreachable)?;
    if !response.status().is_success() {
        return Err(TokenError::Rejected);
    }
    let parsed: TokenResponse = response.json().await.map_err(|_| TokenError::Rejected)?;
    if parsed.access_token.is_empty() {
        return Err(TokenError::Rejected);
    }
    Ok(TokenSet {
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token.filter(|token| !token.is_empty()),
        expires_at_unix: parsed.expires_in.and_then(|secs| {
            if secs <= 0 {
                None
            } else {
                now_unix().checked_add(secs)
            }
        }),
    })
}

async fn fetch_identity(
    http: &reqwest::Client,
    url: &str,
    access_token: &str,
) -> Result<Identity, String> {
    let response = http
        .get(url)
        .bearer_auth(access_token)
        .timeout(OAUTH_TIMEOUT)
        .send()
        .await
        .map_err(|_| "Couldn't reach the sign-in service.".to_string())?;
    if !response.status().is_success() {
        return Err("Sign-in was rejected. Try again.".into());
    }
    let info: UserInfo = response
        .json()
        .await
        .map_err(|_| "Sign-in response was incomplete.".to_string())?;
    if info.email_verified == Some(false) {
        return Err("That account has no verified email.".into());
    }
    if info.sub.is_empty() || !info.email.contains('@') {
        return Err("Sign-in response was incomplete.".into());
    }
    Ok(Identity {
        subject: info.sub,
        email: info.email,
    })
}

fn open_browser(url: &str) -> Result<(), String> {
    let mut command = browser_command(url);
    let mut child = command
        .spawn()
        .map_err(|_| "Couldn't open the browser to sign in.".to_string())?;
    // Reap the browser process when it exits. Waiting here would freeze sign-in.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

fn browser_command(url: &str) -> std::process::Command {
    #[cfg(target_os = "windows")]
    {
        let mut command = std::process::Command::new("rundll32");
        command.args(["url.dll,FileProtocolHandler", url]);
        return command;
    }
    #[cfg(target_os = "macos")]
    {
        let mut command = std::process::Command::new("open");
        command.arg(url);
        return command;
    }
    #[cfg(target_os = "linux")]
    {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(url);
        command
    }
}

fn accept_oauth_code(
    listener: std::net::TcpListener,
    expected_state: &str,
    cancel: &AtomicBool,
) -> Result<String, String> {
    let deadline = std::time::Instant::now() + SIGN_IN_WAIT;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("Sign-in was cancelled.".into());
        }
        if std::time::Instant::now() >= deadline {
            return Err("Sign-in timed out. Try again.".into());
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                if let Ok(text) = read_request(&mut stream) {
                    match parse_redirect(&text, expected_state) {
                        RedirectOutcome::Code(code) => {
                            write_html(
                                &mut stream,
                                "200 OK",
                                "Signed in. You can close this window and return to NodeDesk.",
                            );
                            return Ok(code);
                        }
                        RedirectOutcome::Denied => {
                            write_html(
                                &mut stream,
                                "200 OK",
                                "Sign-in was cancelled. You can close this window.",
                            );
                            return Err("Sign-in was cancelled.".into());
                        }
                        RedirectOutcome::StateMismatch => {
                            write_html(
                                &mut stream,
                                "400 Bad Request",
                                "Sign-in didn't match this computer. Close this window and try again.",
                            );
                            return Err("Sign-in didn't match this computer. Try again.".into());
                        }
                        RedirectOutcome::Ignore => {
                            write_html(&mut stream, "404 Not Found", "");
                        }
                    }
                }
            }
            Err(err)
                if err.kind() == std::io::ErrorKind::WouldBlock
                    || err.kind() == std::io::ErrorKind::TimedOut =>
            {
                std::thread::sleep(Duration::from_millis(30));
            }
            Err(_) => return Err("Sign-in was interrupted.".into()),
        }
    }
}

fn read_request(stream: &mut std::net::TcpStream) -> Result<String, std::io::Error> {
    use std::io::Read;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    let mut buf = Vec::new();
    let mut tmp = [0u8; 1024];
    while !buf.windows(4).any(|window| window == b"\r\n\r\n") && buf.len() < 8192 {
        match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
            Err(err)
                if err.kind() == std::io::ErrorKind::WouldBlock
                    || err.kind() == std::io::ErrorKind::TimedOut =>
            {
                break
            }
            Err(err) => return Err(err),
        }
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

enum RedirectOutcome {
    Code(String),
    Denied,
    StateMismatch,
    Ignore,
}

fn parse_redirect(request: &str, expected_state: &str) -> RedirectOutcome {
    let first = request.lines().next().unwrap_or("");
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    if method != "GET" {
        return RedirectOutcome::Ignore;
    }
    let query = target.split_once('?').map(|(_, query)| query).unwrap_or("");
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let value = percent_decode(value);
        match key {
            "code" => code = Some(value),
            "state" => state = Some(value),
            "error" => error = Some(value),
            _ => {}
        }
    }
    if code.is_some() || error.is_some() {
        if state.as_deref() != Some(expected_state) {
            return RedirectOutcome::StateMismatch;
        }
    } else {
        return RedirectOutcome::Ignore;
    }
    if error.is_some() {
        return RedirectOutcome::Denied;
    }
    match code {
        Some(code) if !code.is_empty() => RedirectOutcome::Code(code),
        _ => RedirectOutcome::Ignore,
    }
}

fn write_html(stream: &mut std::net::TcpStream, status: &str, body: &str) {
    use std::io::Write;
    let bytes = body.as_bytes();
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        bytes.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(bytes);
}

fn code_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

fn form_pairs(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(key, value)| format!("{}={}", form_encode(key), form_encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

fn form_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(decoded) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                out.push(decoded);
                index += 3;
                continue;
            }
        }
        if bytes[index] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[index]);
        }
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn random_token(len: usize) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let mut rng = rand::thread_rng();
    (0..len)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
}

fn now_unix() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::{Mutex, OnceLock};

    fn session_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    struct EnvGuard {
        key: &'static str,
        previous: Option<String>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let previous = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self { key, previous }
        }

        fn clear(key: &'static str) -> Self {
            let previous = std::env::var(key).ok();
            std::env::remove_var(key);
            Self { key, previous }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.previous {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }

    #[test]
    fn pkce_matches_the_rfc_vector() {
        // RFC 7636 appendix B.
        let pkce = Pkce::from_verifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
        assert_eq!(
            pkce.challenge,
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn authorization_url_is_a_public_client() {
        let url = authorization_url(
            DEFAULT_AUTH_URL,
            "client-1.apps.googleusercontent.com",
            "http://127.0.0.1:9/callback",
            "state-1",
            "challenge-1",
        );
        assert!(url.contains("client_id=client-1.apps.googleusercontent.com"));
        assert!(url.contains("code_challenge=challenge-1"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(!url.contains("client_secret"));
        assert!(url.starts_with(DEFAULT_AUTH_URL));
    }

    #[test]
    fn redirect_parser_checks_state_and_decodes_the_code() {
        let ok = "GET /callback?state=abc&code=hello%2Fworld HTTP/1.1\r\n\r\n";
        match parse_redirect(ok, "abc") {
            RedirectOutcome::Code(code) => assert_eq!(code, "hello/world"),
            _ => panic!("expected a code"),
        }
        assert!(matches!(
            parse_redirect("GET /callback?state=nope&code=x HTTP/1.1", "abc"),
            RedirectOutcome::StateMismatch
        ));
        assert!(matches!(
            parse_redirect(
                "GET /callback?error=access_denied&state=abc HTTP/1.1",
                "abc"
            ),
            RedirectOutcome::Denied
        ));
        assert!(matches!(
            parse_redirect("GET /favicon.ico HTTP/1.1", "abc"),
            RedirectOutcome::Ignore
        ));
    }

    #[test]
    fn loopback_returns_the_code_for_a_matching_state() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let cancel = Arc::new(AtomicBool::new(false));
        let handle = std::thread::spawn(move || accept_oauth_code(listener, "state-1", &cancel));
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .write_all(
                b"GET /callback?state=state-1&code=auth-code HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            )
            .unwrap();
        assert_eq!(handle.join().unwrap().unwrap(), "auth-code");
    }

    #[test]
    fn loopback_cancel_does_not_wait_for_the_browser() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let cancel = Arc::new(AtomicBool::new(true));
        let err = accept_oauth_code(listener, "state", &cancel).unwrap_err();
        assert!(err.contains("cancelled"));
    }

    #[test]
    fn missing_or_blank_client_id_refuses_sign_in() {
        let _env = crate::state::testenv::lock();
        let _client = EnvGuard::clear("NODEDESK_GOOGLE_CLIENT_ID");
        let settings = Settings {
            google_client_id: "  ".into(),
            ..Settings::default()
        };
        let err = require_client_id(&settings).unwrap_err();
        assert!(err.contains("isn't configured"));
        let settings = Settings {
            google_client_id: "not a client".into(),
            ..Settings::default()
        };
        assert!(require_client_id(&settings)
            .unwrap_err()
            .contains("not valid"));
    }

    #[test]
    fn env_overrides_settings_for_client_id_and_registry() {
        let _env = crate::state::testenv::lock();
        let _client = EnvGuard::set(
            "NODEDESK_GOOGLE_CLIENT_ID",
            "env-client.apps.googleusercontent.com",
        );
        let _registry = EnvGuard::set(
            "NODEDESK_REGISTRY_URL",
            "https://registry.example.com/fleet",
        );
        let settings = Settings {
            google_client_id: "settings-client.apps.googleusercontent.com".into(),
            registry_base_url: "https://settings.example.com".into(),
            ..Settings::default()
        };
        assert_eq!(
            resolve_client_id(&settings),
            "env-client.apps.googleusercontent.com"
        );
        assert_eq!(
            resolve_registry_url(&settings),
            "https://registry.example.com/fleet"
        );
        assert!(status(&settings).configured);
        assert!(status(&settings).registry_configured);
    }

    #[test]
    fn device_ids_are_uuid_shaped() {
        let id = new_device_id();
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(
            parts.iter().map(|part| part.len()).collect::<Vec<_>>(),
            vec![8, 4, 4, 4, 12]
        );
        assert!(parts[2].starts_with('4'));
        assert!(registry::is_device_id(&id));
    }

    #[test]
    fn session_round_trip_and_malformed_storage() {
        let _guard = session_lock();
        sign_out().unwrap();
        assert!(load_session().is_none());
        state::store_secret(SESSION_KEY, "not-json").unwrap();
        assert!(
            load_session().is_none(),
            "malformed storage must look signed out"
        );
        let session = Session {
            subject: "sub-1".into(),
            email: "owner@example.com".into(),
            access_token: "access-token-value".into(),
            refresh_token: Some("refresh-1".into()),
            expires_at_unix: Some(9_999_999_999),
        };
        store_session(&session).unwrap();
        assert_eq!(load_session().unwrap().email, "owner@example.com");
        assert!(access_token_current(&load_session().unwrap()));
        let expired = Session {
            expires_at_unix: Some(0),
            ..session.clone()
        };
        assert!(!access_token_current(&expired));
        store_link("device-aaaa").unwrap();
        sign_out().unwrap();
        assert!(load_session().is_none());
        assert!(linked_device().is_none());
    }

    #[test]
    fn session_secrets_are_not_written_to_settings_json() {
        let _guard = session_lock();
        sign_out().unwrap();
        let mut suffix = random_token(8);
        suffix.retain(|c| c.is_ascii_alphanumeric());
        let dir =
            std::env::temp_dir().join(format!("nodedesk-acct-{}-{suffix}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let state = state::AppState::new(dir.clone());
        store_session(&Session {
            subject: "sub-1".into(),
            email: "owner@example.com".into(),
            access_token: "access-token-value".into(),
            refresh_token: Some("refresh-secret".into()),
            expires_at_unix: Some(9_999_999_999),
        })
        .unwrap();
        {
            let mut settings = state.settings.write().unwrap();
            settings.google_client_id = "client-1.apps.googleusercontent.com".into();
        }
        state.save_settings();
        let text = std::fs::read_to_string(dir.join("settings.json")).unwrap();
        assert!(text.contains("client-1.apps.googleusercontent.com"));
        assert!(!text.contains("access-token-value"));
        assert!(!text.contains("refresh-secret"));
        assert!(!text.contains("owner@example.com"));
        sign_out().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn advertised_addresses_are_never_public() {
        for candidate in advertised_addresses() {
            assert!(
                registry::is_usable_address(&candidate),
                "refused to advertise {}",
                candidate.value
            );
        }
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn exchange_stores_a_session_and_refresh_replaces_the_access_token() {
        let _env = crate::state::testenv::lock();
        let _guard = session_lock();
        let _client = EnvGuard::clear("NODEDESK_GOOGLE_CLIENT_ID");
        let _token = EnvGuard::clear("NODEDESK_OAUTH_TOKEN_URL");
        sign_out().unwrap();
        let base = spawn_oauth().await;
        let http = reqwest::Client::new();
        let err = finish_sign_in(
            &http,
            &SignInExchange {
                client_id: "client-1".into(),
                token_url: format!("{base}/token"),
                userinfo_url: format!("{base}/userinfo"),
                code: "bad-code".into(),
                verifier: "verifier-1".into(),
                redirect_uri: "http://127.0.0.1:9/callback".into(),
            },
        )
        .await
        .unwrap_err();
        assert!(err.contains("rejected"));
        assert!(load_session().is_none());

        let session = finish_sign_in(
            &http,
            &SignInExchange {
                client_id: "client-1".into(),
                token_url: format!("{base}/token"),
                userinfo_url: format!("{base}/userinfo"),
                code: "good-code".into(),
                verifier: "verifier-1".into(),
                redirect_uri: "http://127.0.0.1:9/callback".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(session.email, "owner@example.com");
        assert_eq!(session.access_token, "access-1");
        assert!(session.expires_at_unix.unwrap() > now_unix());

        let expired = Session {
            expires_at_unix: Some(0),
            ..load_session().unwrap()
        };
        store_session(&expired).unwrap();
        let _token_url = EnvGuard::set("NODEDESK_OAUTH_TOKEN_URL", &format!("{base}/token"));
        let settings = Settings {
            google_client_id: "client-1".into(),
            ..Settings::default()
        };
        let refreshed = ensure_fresh_token(&http, &settings, expired).await.unwrap();
        assert_eq!(refreshed.access_token, "access-2");
        assert_eq!(refreshed.refresh_token.as_deref(), Some("refresh-1"));
        assert_eq!(load_session().unwrap().access_token, "access-2");

        let no_refresh = Session {
            refresh_token: None,
            expires_at_unix: Some(0),
            ..refreshed
        };
        store_session(&no_refresh).unwrap();
        let err = ensure_fresh_token(&http, &settings, no_refresh)
            .await
            .unwrap_err();
        assert!(err.contains("Sign in again"));
        assert!(load_session().is_none());
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn remote_devices_follow_the_signed_in_account_only() {
        let _env = crate::state::testenv::lock();
        let _guard = session_lock();
        let _registry_env = EnvGuard::clear("NODEDESK_REGISTRY_URL");
        let _client = EnvGuard::clear("NODEDESK_GOOGLE_CLIENT_ID");
        sign_out().unwrap();
        let http = reqwest::Client::new();
        assert!(remote_devices(http.clone(), Settings::default())
            .await
            .is_empty());

        store_session(&Session {
            subject: "sub-1".into(),
            email: "owner@example.com".into(),
            access_token: "tok-a".into(),
            refresh_token: None,
            expires_at_unix: Some(9_999_999_999),
        })
        .unwrap();
        assert!(
            remote_devices(http.clone(), Settings::default())
                .await
                .is_empty(),
            "a session without a registry must not change discovery"
        );

        let base = crate::registry::spawn_stub_registry().await;
        let registry = Registry::from_base_url(http.clone(), &base).unwrap();
        registry
            .register(
                "tok-a",
                &DeviceRegistration {
                    device_id: "device-self".into(),
                    display_name: "This".into(),
                    os: "linux".into(),
                    addresses: vec![registry::AddressCandidate {
                        kind: registry::AddressKind::Lan,
                        value: "10.0.0.2".into(),
                    }],
                },
            )
            .await
            .unwrap();
        registry
            .register(
                "tok-a",
                &DeviceRegistration {
                    device_id: "device-cabin".into(),
                    display_name: "Cabin".into(),
                    os: "windows".into(),
                    addresses: vec![
                        registry::AddressCandidate {
                            kind: registry::AddressKind::Other,
                            value: "8.8.8.8".into(),
                        },
                        registry::AddressCandidate {
                            kind: registry::AddressKind::Tailscale,
                            value: "100.64.1.8".into(),
                        },
                    ],
                },
            )
            .await
            .unwrap();

        let settings = Settings {
            device_id: "device-self".into(),
            registry_base_url: base,
            ..Settings::default()
        };
        let sightings = remote_devices(http, settings).await;
        assert_eq!(sightings.len(), 1);
        assert_eq!(sightings[0].name, "Cabin");
        assert_eq!(sightings[0].address, "100.64.1.8");
        assert!(!sightings[0]
            .candidates
            .iter()
            .any(|address| address == "8.8.8.8"));
        sign_out().unwrap();
    }

    async fn spawn_oauth() -> String {
        use axum::http::{HeaderMap, StatusCode};
        use axum::response::IntoResponse;
        use axum::routing::{get, post};
        use axum::{Json, Router};

        async fn token(body: String) -> impl axum::response::IntoResponse {
            let refresh = body.contains("grant_type=refresh_token");
            if refresh {
                if !body.contains("refresh_token=refresh-1") || !body.contains("client_id=client-1")
                {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(serde_json::json!({ "error": "invalid_grant" })),
                    )
                        .into_response();
                }
                return Json(serde_json::json!({
                    "access_token": "access-2",
                    "expires_in": 3600,
                    "token_type": "Bearer"
                }))
                .into_response();
            }
            if !body.contains("code=good-code")
                || !body.contains("code_verifier=verifier-1")
                || !body.contains("client_id=client-1")
            {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "error": "invalid_grant" })),
                )
                    .into_response();
            }
            Json(serde_json::json!({
                "access_token": "access-1",
                "refresh_token": "refresh-1",
                "expires_in": 3600,
                "token_type": "Bearer"
            }))
            .into_response()
        }

        async fn userinfo(headers: HeaderMap) -> impl axum::response::IntoResponse {
            let token = headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.strip_prefix("Bearer "));
            match token {
                Some("access-1" | "access-2") => Json(serde_json::json!({
                    "sub": "google-sub-1",
                    "email": "owner@example.com",
                    "email_verified": true
                }))
                .into_response(),
                _ => StatusCode::UNAUTHORIZED.into_response(),
            }
        }

        let app = Router::new()
            .route("/token", post(token))
            .route("/userinfo", get(userinfo));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://127.0.0.1:{port}")
    }
}
