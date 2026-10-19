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
    request_id: String,
    controller_device_id: String,
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
                    request_id: token.to_string(),
                    controller_device_id: requester_device_id.to_string(),
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
            tokens.retain(|_, g| g.controller_device_id != requester_device_id);
        }
    }

    /// Revoke everything (hosting disabled, sign-out — HOST-04/AUTH-10).
    pub fn revoke_all(&self) {
        if let Ok(mut tokens) = self.tokens.lock() {
            tokens.clear();
        }
    }

    /// The permissions of a presented token, if valid and unexpired.
    /// Does not check controller identity — callers that enforce a session
    /// must use [`Self::authorize`].
    #[cfg(test)]
    pub fn permissions(&self, token: &str) -> Option<Permissions> {
        let mut tokens = self.tokens.lock().ok()?;
        let grant = tokens.get(token)?;
        if grant.expires <= Instant::now() {
            tokens.remove(token);
            return None;
        }
        Some(grant.permissions)
    }

    /// Permissions for this token only when the presenter is the controller
    /// the host accepted (APPROVAL-07). A forged token, a wrong device id,
    /// or an expired grant authorizes nothing.
    pub fn authorize(&self, token: &str, controller_device_id: &str) -> Option<Permissions> {
        let mut tokens = self.tokens.lock().ok()?;
        let grant = tokens.get(token)?;
        if grant.expires <= Instant::now() {
            tokens.remove(token);
            return None;
        }
        if grant.request_id != token || grant.controller_device_id != controller_device_id {
            return None;
        }
        Some(grant.permissions)
    }

    /// True when at least one unexpired account grant is outstanding.
    /// Sensitive agent endpoints refuse the access-code-only bypass while
    /// this is true.
    pub fn has_active(&self) -> bool {
        let Ok(mut tokens) = self.tokens.lock() else {
            return false;
        };
        let now = Instant::now();
        tokens.retain(|_, grant| grant.expires > now);
        !tokens.is_empty()
    }

    #[cfg(test)]
    pub fn expire_now(&self, token: &str) {
        if let Ok(mut tokens) = self.tokens.lock() {
            if let Some(grant) = tokens.get_mut(token) {
                grant.expires = Instant::now() - Duration::from_secs(1);
            }
        }
    }

    #[cfg(test)]
    pub fn request_id_of(&self, token: &str) -> Option<String> {
        self.tokens.lock().ok()?.get(token).map(|g| g.request_id.clone())
    }
}

pub static GRANT_HEADER: &str = "x-nodedesk-grant";
/// Controller device id that must match the grant (APPROVAL-07).
pub static CONTROLLER_HEADER: &str = "x-nodedesk-controller";

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

    #[test]
    fn authorize_requires_the_accepted_controller_and_expiry() {
        let store = GrantStore::new();
        store.issue(
            "req-1",
            "dev-c1",
            Permissions {
                control: false,
                files: true,
                clipboard: false,
                audio: false,
            },
        );
        assert_eq!(store.request_id_of("req-1").as_deref(), Some("req-1"));
        let perms = store.authorize("req-1", "dev-c1").expect("matching controller");
        assert!(perms.files && !perms.control);
        // A different device cannot reuse C1's request id (APPROVAL-07).
        assert!(store.authorize("req-1", "dev-c2").is_none());
        assert!(store.authorize("forged", "dev-c1").is_none());
        store.expire_now("req-1");
        assert!(store.authorize("req-1", "dev-c1").is_none());
        assert!(!store.has_active());
    }
}
