//! Persistent state: settings file + OS secure storage for secrets.
//!
//! Secrets never go in `settings.json`. That file is plain JSON in the app
//! config directory, readable by anything running as the user; the access
//! codes it used to hold are the credentials for every machine this computer
//! can control. They live in the OS keychain instead, one entry per host.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

/// Length of a generated access code. 32 unambiguous characters per position,
/// so 12 gives ~60 bits — well beyond guessing, even before the agent's
/// lockout takes effect.
pub const ACCESS_CODE_LEN: usize = 12;

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
    /// Access codes written by versions that kept them in this file. Read once
    /// so an upgrade can migrate them into the keychain, then never written
    /// back — hence `skip_serializing`.
    #[serde(default, rename = "hostCodes", skip_serializing)]
    pub legacy_host_codes: HashMap<String, String>,
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
            legacy_host_codes: HashMap::new(),
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
    /// Cancellation flag for the active file transfer.
    pub transfer_cancel: std::sync::atomic::AtomicBool,
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
        let state = Self {
            config_dir,
            settings: RwLock::new(settings),
            http,
            http_local,
            stream_child: Mutex::new(None),
            transfer_cancel: std::sync::atomic::AtomicBool::new(false),
        };
        state.migrate_host_codes();
        state
    }

    /// Moves any codes left in `settings.json` by an older version into the
    /// keychain and rewrites the file without them.
    fn migrate_host_codes(&self) {
        let legacy = match self.settings.read() {
            Ok(s) if !s.legacy_host_codes.is_empty() => s.legacy_host_codes.clone(),
            _ => return,
        };
        let mut migrated = vec![];
        for (address, code) in &legacy {
            if store_host_code(address, code).is_ok() {
                migrated.push(address.clone());
            }
        }
        if let Ok(mut settings) = self.settings.write() {
            for address in &migrated {
                settings.legacy_host_codes.remove(address);
            }
        }
        // Rewrites the file; `skip_serializing` drops the codes on the way out.
        self.save_settings();
    }

    fn settings_path(config_dir: &Path) -> PathBuf {
        config_dir.join("settings.json")
    }

    fn load_settings(config_dir: &Path) -> Settings {
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

pub fn delete_secret(key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, key).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn host_code_key(address: &str) -> String {
    format!("host-code:{address}")
}

/// The access code for a remote host, from OS secure storage.
pub fn host_code(address: &str) -> Option<String> {
    read_secret(&host_code_key(address))
}

pub fn store_host_code(address: &str, code: &str) -> Result<(), String> {
    store_secret(&host_code_key(address), code)
}

pub fn forget_host_code(address: &str) -> Result<(), String> {
    delete_secret(&host_code_key(address))
}

/// The code for `address`, preferring secure storage but still honouring a
/// value the migration could not move (e.g. no keychain available on Linux).
pub fn code_for_host(state: &AppState, address: &str) -> Option<String> {
    host_code(address).or_else(|| {
        state
            .settings
            .read()
            .ok()
            .and_then(|s| s.legacy_host_codes.get(address).cloned())
    })
}

pub fn random_code(len: usize) -> String {
    use rand::Rng;
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
    let mut rng = rand::thread_rng();
    (0..len)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_json_roundtrip() {
        let mut s = Settings {
            bitrate_mbps: 77,
            ..Default::default()
        };
        s.manual_hosts.push(ManualHost {
            name: "Box".into(),
            address: "10.0.0.2".into(),
            mac: Some("AA:BB:CC:DD:EE:FF".into()),
        });
        let text = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&text).unwrap();
        assert_eq!(back.bitrate_mbps, 77);
        assert_eq!(back.manual_hosts[0].name, "Box");
        assert!(back.onboarded == s.onboarded);
    }

    #[test]
    fn access_codes_are_never_written_to_the_settings_file() {
        let mut s = Settings::default();
        s.legacy_host_codes
            .insert("10.0.0.2".into(), "SUPER-SECRET".into());
        let text = serde_json::to_string(&s).unwrap();
        assert!(
            !text.contains("SUPER-SECRET"),
            "codes must never be serialized back to settings.json"
        );
        assert!(!text.contains("hostCodes"));
    }

    #[test]
    fn legacy_codes_are_still_read_for_migration() {
        let text = r#"{"mode":"both","startOnBoot":true,"clipboardSync":true,
            "tailscaleEnabled":true,"codec":"auto","bitrateMbps":40,"fps":60,
            "resolution":"auto","hdr":false,"hostCodes":{"10.0.0.2":"OLD-CODE"}}"#;
        let s: Settings = serde_json::from_str(text).unwrap();
        assert_eq!(s.legacy_host_codes.get("10.0.0.2").unwrap(), "OLD-CODE");
    }

    #[test]
    fn defaults_match_spec() {
        let s = Settings::default();
        assert_eq!(s.mode, "both");
        assert!(s.clipboard_sync);
        assert!(s.tailscale_enabled);
        assert_eq!(s.codec, "auto");
    }

    #[test]
    fn access_codes_are_unambiguous() {
        let code = random_code(ACCESS_CODE_LEN);
        assert_eq!(code.len(), ACCESS_CODE_LEN);
        assert!(code.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()));
        assert!(!code.contains('0') && !code.contains('O') && !code.contains('1') && !code.contains('I'));
    }

    #[test]
    fn access_codes_carry_enough_entropy() {
        // 32 symbols per position; below ~50 bits an online guesser becomes
        // plausible even against the agent's lockout.
        let bits = (ACCESS_CODE_LEN as f64) * 32f64.log2();
        assert!(bits >= 50.0, "access code entropy too low: {bits} bits");
    }

    #[test]
    fn access_codes_do_not_repeat() {
        let a = random_code(ACCESS_CODE_LEN);
        let b = random_code(ACCESS_CODE_LEN);
        assert_ne!(a, b);
    }

    #[test]
    fn settings_file_persistence() {
        let dir = std::env::temp_dir().join(format!("nodedesk-state-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let state = AppState::new(dir.clone());
        {
            let mut s = state.settings.write().unwrap();
            s.fps = 144;
        }
        state.save_settings();
        let reloaded = AppState::new(dir.clone());
        assert_eq!(reloaded.settings.read().unwrap().fps, 144);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
pub mod testenv {
    use std::sync::{Mutex, MutexGuard, OnceLock};

    /// Several tests point `NODEDESK_*` at scratch directories. Environment
    /// variables are process-wide, so those tests must not overlap.
    pub fn lock() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
