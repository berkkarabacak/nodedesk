//! TLS identity for the agent channel (SECURITY-03).
//!
//! Each device generates a self-signed certificate once and keeps it in the
//! app config directory (user-only). Controllers pin the certificate at first
//! contact — the pinning exchange itself travels over the HMAC-authenticated
//! channel, so a network attacker cannot substitute their own certificate
//! without knowing the access code. This is key-pinning TOFU, documented in
//! docs/security.md; hostname verification stays disabled in favour of the
//! pinned key (the SAN of a LAN device is not meaningful).

use sha2::Digest;

/// rustls cannot auto-pick a crypto provider when several are in the
/// dependency graph (reqwest + axum-server). Install ring explicitly once,
/// before any TLS use. Idempotent.
pub fn ensure_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

pub struct TlsIdentity {
    pub cert_pem: String,
    pub key_pem: String,
    /// SHA-256 fingerprint of the DER certificate, hex — safe to display for
    /// out-of-band verification.
    pub fingerprint: String,
}

const CERT_FILE: &str = "agent-cert.pem";
const KEY_FILE: &str = "agent-key.pem";

fn make() -> Result<TlsIdentity, String> {
    let certified = rcgen::generate_simple_self_signed(vec!["nodedesk-agent".to_string()])
        .map_err(|e| format!("could not create the device certificate: {e}"))?;
    let cert_pem = certified.cert.pem();
    let key_pem = certified.key_pair.serialize_pem();
    let fingerprint = hex_sha256(certified.cert.der());
    Ok(TlsIdentity {
        cert_pem,
        key_pem,
        fingerprint,
    })
}

fn hex_sha256(bytes: &[u8]) -> String {
    let digest = sha2::Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Persistent identity: stable across restarts so pinned controllers do not
/// see spurious mismatches.
pub fn load_or_create(config_dir: &std::path::Path) -> Result<TlsIdentity, String> {
    let cert_path = config_dir.join(CERT_FILE);
    let key_path = config_dir.join(KEY_FILE);
    if let (Ok(cert_pem), Ok(key_pem)) = (
        std::fs::read_to_string(&cert_path),
        std::fs::read_to_string(&key_path),
    ) {
        let der = pem_der(&cert_pem)?;
        return Ok(TlsIdentity {
            cert_pem,
            key_pem,
            fingerprint: hex_sha256(&der),
        });
    }
    let identity = make()?;
    std::fs::write(&cert_path, &identity.cert_pem).map_err(|e| e.to_string())?;
    std::fs::write(&key_path, &identity.key_pem).map_err(|e| e.to_string())?;
    Ok(identity)
}

/// Ephemeral identity for tests: no disk, unique per call.
#[cfg(test)]
pub fn ephemeral() -> Result<TlsIdentity, String> {
    make()
}

fn pem_der(pem: &str) -> Result<Vec<u8>, String> {
    let body: String = pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .collect::<Vec<_>>()
        .join("");
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(body)
        .map_err(|e| format!("stored certificate is unreadable: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_has_a_stable_fingerprint() {
        let a = ephemeral().unwrap();
        let der = pem_der(&a.cert_pem).unwrap();
        assert_eq!(a.fingerprint, hex_sha256(&der));
        assert_eq!(a.fingerprint.len(), 64);
    }
}
