//! Request authentication for the NodeDesk agent.
//!
//! The access code is a shared secret that must never cross the network. The
//! agent speaks plain HTTP on the LAN, so a code sent in a header would be
//! readable by anyone sniffing the segment — and replayable forever.
//!
//! Instead every request carries an HMAC-SHA256 over its method, path, query,
//! timestamp, nonce and body digest. The host recomputes it with the code it
//! holds. A captured request proves nothing about the code, authorizes no
//! other request, and cannot be replayed: timestamps outside a short window
//! are rejected, and each nonce is accepted exactly once.

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const TS_HEADER: &str = "x-nodedesk-ts";
pub const NONCE_HEADER: &str = "x-nodedesk-nonce";
pub const AUTH_HEADER: &str = "x-nodedesk-auth";

/// How far a request timestamp may drift from the host clock, in seconds.
/// Also bounds how long a captured request stays replayable in the worst case.
pub const MAX_SKEW_SECS: i64 = 120;

type HmacSha256 = Hmac<Sha256>;

pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 0x0f) as usize] as char);
    }
    out
}

pub fn body_digest(body: &[u8]) -> String {
    hex(&Sha256::digest(body))
}

pub fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn new_nonce() -> String {
    use rand::Rng;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill(&mut bytes);
    hex(&bytes)
}

/// The signed message. Binding method and path+query stops a captured
/// signature being moved to a different endpoint; the body digest stops the
/// payload being swapped underneath it.
pub fn signature(
    code: &str,
    method: &str,
    path_and_query: &str,
    ts: i64,
    nonce: &str,
    body_digest: &str,
) -> String {
    let mut mac = HmacSha256::new_from_slice(code.as_bytes()).expect("HMAC accepts any key length");
    for part in [
        method,
        path_and_query,
        &ts.to_string(),
        nonce,
        body_digest,
    ] {
        mac.update(part.as_bytes());
        mac.update(b"\n");
    }
    hex(&mac.finalize().into_bytes())
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b.iter()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

// ---------------------------------------------------------------------------
// Replay protection
// ---------------------------------------------------------------------------

/// Remembers recently seen nonces so a captured request cannot be replayed
/// inside the timestamp window. Entries older than the window are dropped, so
/// the map stays bounded by the request rate rather than by uptime.
#[derive(Default)]
pub struct ReplayGuard {
    seen: Mutex<HashMap<String, i64>>,
}

impl ReplayGuard {
    /// Records `nonce`, returning false if it was already used.
    pub fn accept(&self, nonce: &str, ts: i64) -> bool {
        let Ok(mut seen) = self.seen.lock() else {
            return false; // poisoned: fail closed
        };
        let cutoff = unix_now() - MAX_SKEW_SECS;
        seen.retain(|_, seen_ts| *seen_ts >= cutoff);
        // A hostile peer could otherwise grow this map without bound.
        if seen.len() > 100_000 {
            return false;
        }
        seen.insert(nonce.to_string(), ts).is_none()
    }
}

// ---------------------------------------------------------------------------
// Brute-force throttling
// ---------------------------------------------------------------------------

/// Failures allowed from one peer before it is locked out.
const MAX_FAILURES: u32 = 10;
/// How long a locked-out peer stays locked out.
const LOCKOUT: Duration = Duration::from_secs(60);
/// Failures are forgotten after this long without one.
const FAILURE_TTL: Duration = Duration::from_secs(300);

struct Attempts {
    failures: u32,
    last_failure: Instant,
    locked_until: Option<Instant>,
}

/// Per-peer failure throttle. The access code is short enough to guess given
/// unlimited attempts, so unlimited attempts are what we take away.
#[derive(Default)]
pub struct Throttle {
    peers: Mutex<HashMap<String, Attempts>>,
}

impl Throttle {
    /// Whether `peer` is currently allowed to attempt a request.
    pub fn allowed(&self, peer: &str) -> bool {
        let Ok(mut peers) = self.peers.lock() else {
            return false;
        };
        let now = Instant::now();
        peers.retain(|_, a| {
            a.locked_until.map(|until| until > now).unwrap_or(false)
                || now.duration_since(a.last_failure) < FAILURE_TTL
        });
        match peers.get(peer) {
            Some(a) => a.locked_until.map(|until| until <= now).unwrap_or(true),
            None => true,
        }
    }

    pub fn record_failure(&self, peer: &str) {
        let Ok(mut peers) = self.peers.lock() else {
            return;
        };
        let now = Instant::now();
        let entry = peers.entry(peer.to_string()).or_insert(Attempts {
            failures: 0,
            last_failure: now,
            locked_until: None,
        });
        // A lockout that has expired starts the count again.
        if entry
            .locked_until
            .map(|until| until <= now)
            .unwrap_or(false)
        {
            entry.failures = 0;
            entry.locked_until = None;
        }
        entry.failures += 1;
        entry.last_failure = now;
        if entry.failures >= MAX_FAILURES {
            entry.locked_until = Some(now + LOCKOUT);
        }
    }

    pub fn record_success(&self, peer: &str) {
        if let Ok(mut peers) = self.peers.lock() {
            peers.remove(peer);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_is_stable_and_key_dependent() {
        let a = signature("CODE", "GET", "/metrics", 1000, "n1", &body_digest(b""));
        let b = signature("CODE", "GET", "/metrics", 1000, "n1", &body_digest(b""));
        assert_eq!(a, b, "same inputs must produce the same signature");
        let other = signature("OTHER", "GET", "/metrics", 1000, "n1", &body_digest(b""));
        assert_ne!(a, other, "a different code must produce a different signature");
    }

    #[test]
    fn signature_binds_method_path_body_and_nonce() {
        let base = signature("CODE", "GET", "/metrics", 1000, "n1", &body_digest(b""));
        assert_ne!(base, signature("CODE", "POST", "/metrics", 1000, "n1", &body_digest(b"")));
        assert_ne!(base, signature("CODE", "GET", "/power", 1000, "n1", &body_digest(b"")));
        assert_ne!(base, signature("CODE", "GET", "/metrics", 1001, "n1", &body_digest(b"")));
        assert_ne!(base, signature("CODE", "GET", "/metrics", 1000, "n2", &body_digest(b"")));
        assert_ne!(base, signature("CODE", "GET", "/metrics", 1000, "n1", &body_digest(b"x")));
    }

    #[test]
    fn nonces_are_accepted_once() {
        let guard = ReplayGuard::default();
        let now = unix_now();
        assert!(guard.accept("nonce-a", now));
        assert!(!guard.accept("nonce-a", now), "replayed nonce must be rejected");
        assert!(guard.accept("nonce-b", now));
    }

    #[test]
    fn throttle_locks_out_after_repeated_failures() {
        let throttle = Throttle::default();
        assert!(throttle.allowed("10.0.0.9"));
        for _ in 0..MAX_FAILURES {
            throttle.record_failure("10.0.0.9");
        }
        assert!(!throttle.allowed("10.0.0.9"), "peer must be locked out");
        assert!(throttle.allowed("10.0.0.10"), "lockout must not affect other peers");
    }

    #[test]
    fn throttle_forgets_a_peer_after_success() {
        let throttle = Throttle::default();
        for _ in 0..(MAX_FAILURES - 1) {
            throttle.record_failure("10.0.0.11");
        }
        throttle.record_success("10.0.0.11");
        for _ in 0..(MAX_FAILURES - 1) {
            throttle.record_failure("10.0.0.11");
        }
        assert!(throttle.allowed("10.0.0.11"), "success must reset the failure count");
    }

    #[test]
    fn constant_time_compare() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
    }

    #[test]
    fn hex_encoding() {
        assert_eq!(hex(&[0x00, 0x0f, 0xff]), "000fff");
    }
}
