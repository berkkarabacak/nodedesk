//! Active session grants (APPROVAL-05/06 enforcement half).
//!
//! When the host accepts an incoming request, the native layer records a
//! grant: a random per-session token bound to the requester and the exact
//! permission set the host approved. Agent endpoints that carry a grant token
//! enforce those permissions — a view-only session cannot pull files or run
//! terminal commands, no matter what its UI shows. Requests authenticated the
//! legacy way (shared access code) keep their existing semantics: the access
//! code IS the local-mode authorization.
//!
//! Grants live in memory only — never in settings.json — and die with the
//! session, revocation, hosting disable, or app exit.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Default)]
pub struct Permissions {
    pub control: bool,
    pub files: bool,
    pub clipboard: bool,
    pub audio: bool,
}

struct Grant {
    requester_device_id: String,
    permissions: Permissions,
    expires: Instant,
}

/// Default grant lifetime; refreshed while the session is active.
const GRANT_TTL: Duration = Duration::from_secs(60 * 60 * 8);

pub struct GrantStore {
    /// token -> grant
    tokens: Mutex<HashMap<String, Grant>>,
}

impl GrantStore {
    pub fn new() -> Self {
        Self {
            tokens: Mutex::new(HashMap::new()),
        }
    }

    /// Record a grant for an accepted request. The token is the request ID
    /// itself — the controller already holds it and presents it as proof;
    /// nothing extra crosses the network.
    pub fn issue(&self, token: &str, requester_device_id: &str, permissions: Permissions) {
        if let Ok(mut tokens) = self.tokens.lock() {
            tokens.insert(
                token.to_string(),
                Grant {
                    requester_device_id: requester_device_id.to_string(),
                    permissions,
                    expires: Instant::now() + GRANT_TTL,
                },
            );
        }
    }

    /// Revoke one token (session ended).
    pub fn revoke(&self, token: &str) {
        if let Ok(mut tokens) = self.tokens.lock() {
            tokens.remove(token);
        }
    }

    /// Revoke every grant belonging to one controller device (TRUST-02).
    pub fn revoke_device(&self, requester_device_id: &str) {
        if let Ok(mut tokens) = self.tokens.lock() {
            tokens.retain(|_, g| g.requester_device_id != requester_device_id);
        }
    }

    /// Revoke everything (hosting disabled, sign-out — HOST-04/AUTH-10).
    pub fn revoke_all(&self) {
        if let Ok(mut tokens) = self.tokens.lock() {
            tokens.clear();
        }
    }

    /// The permissions of a presented token, if valid and unexpired.
    pub fn permissions(&self, token: &str) -> Option<Permissions> {
        let mut tokens = self.tokens.lock().ok()?;
        let grant = tokens.get(token)?;
        if grant.expires < Instant::now() {
            tokens.remove(token);
            return None;
        }
        Some(grant.permissions)
    }
}

pub static GRANT_HEADER: &str = "x-nodedesk-grant";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issued_grant_enforces_exactly_its_permissions() {
        let store = GrantStore::new();
        store.issue(
            "req-token-1",
            "dev-helper",
            Permissions {
                control: false,
                files: false,
                clipboard: false,
                audio: false,
            },
        );
        let perms = store.permissions("req-token-1").expect("grant is valid");
        assert!(!perms.control && !perms.files && !perms.clipboard && !perms.audio);
        // An unknown token has no permissions at all.
        assert!(store.permissions("forged-token").is_none());
        store.revoke("req-token-1");
        assert!(store.permissions("req-token-1").is_none());
    }

    #[test]
    fn revoke_device_and_revoke_all_work() {
        let store = GrantStore::new();
        store.issue("t1", "dev-a", Permissions::default());
        store.issue("t2", "dev-b", Permissions::default());
        store.revoke_device("dev-a");
        assert!(store.permissions("t1").is_none());
        assert!(store.permissions("t2").is_some());
        store.revoke_all();
        assert!(store.permissions("t2").is_none());
    }
}
