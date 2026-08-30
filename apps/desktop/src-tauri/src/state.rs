//! Persistent state: settings file + OS secure storage for secrets.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, RwLock};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ManualHost {
    pub name: String,
    pub address: String,
    pub mac: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub mode: String, // "controller" | "host" | "both"
    pub start_on_boot: bool,
    pub clipboard_sync: bool,
    pub tailscale_enabled: bool,
    pub codec: String,      // "auto" | "h264" | "hevc" | "av1"
    pub bitrate_mbps: u32,
    pub fps: u32,
    pub resolution: String, // "auto" | "1080p" | "1440p" | "4k"
    pub hdr: bool,
    #[serde(default)]
    pub onboarded: bool,
    #[serde(default)]
    pub manual_hosts: Vec<ManualHost>,
    /// Per-host agent access codes entered during pairing/add.
    #[serde(default)]
    pub host_codes: HashMap<String, String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            mode: "both".into(),
            start_on_boot: true,
            clipboard_sync: true,
            tailscale_enabled: true,
            codec: "auto".into(),
            bitrate_mbps: 40,
            fps: 60,
            resolution: "auto".into(),
            hdr: false,
            onboarded: false,
            manual_hosts: vec![],
            host_codes: HashMap::new(),
        }
    }
}

pub struct AppState {
    pub config_dir: PathBuf,
    pub settings: RwLock<Settings>,
    pub http: reqwest::Client,
    /// Insecure (self-signed-accepting) client — ONLY for 127.0.0.1 Sunshine API.
    pub http_local: reqwest::Client,
    /// Running Moonlight stream process, if we started one.
    pub stream_child: Mutex<Option<std::process::Child>>,
}

impl AppState {
    pub fn new(config_dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&config_dir);
        let settings = Self::load_settings(&config_dir);
        let http = reqwest::Client::builder()
            .user_agent("NodeDesk/1.0")
            .build()
            .expect("http client");
        let http_local = reqwest::Client::builder()
            .user_agent("NodeDesk/1.0")
            .danger_accept_invalid_certs(true)
            .build()
            .expect("local http client");
        Self {
            config_dir,
            settings: RwLock::new(settings),
            http,
            http_local,
            stream_child: Mutex::new(None),
        }
    }

    fn settings_path(config_dir: &PathBuf) -> PathBuf {
        config_dir.join("settings.json")
    }

    fn load_settings(config_dir: &PathBuf) -> Settings {
        let path = Self::settings_path(config_dir);
        match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
            Err(_) => Settings::default(),
        }
    }

    pub fn save_settings(&self) {
        let path = Self::settings_path(&self.config_dir);
        if let Ok(settings) = self.settings.read() {
            if let Ok(text) = serde_json::to_string_pretty(&*settings) {
                let _ = std::fs::write(path, text);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Secrets in OS secure storage (Windows Credential Manager, Keychain, etc.)
// ---------------------------------------------------------------------------

const SERVICE: &str = "dev.nodedesk.app";

pub fn store_secret(key: &str, value: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, key).map_err(|e| e.to_string())?;
    entry.set_password(value).map_err(|e| e.to_string())
}

pub fn read_secret(key: &str) -> Option<String> {
    keyring::Entry::new(SERVICE, key)
        .ok()
        .and_then(|e| e.get_password().ok())
}

pub fn random_code(len: usize) -> String {
    use rand::Rng;
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
    let mut rng = rand::thread_rng();
    (0..len)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
}
