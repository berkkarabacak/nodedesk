//! Account device registry client.
//!
//! The registry is a presence list for the signed-in account: display name,
//! online flag, and address candidates. It is not a tunnel. NodeDesk never
//! asks it to open a port, and this client refuses to publish or dial a
//! public address, so Sunshine stays off the public internet.
//!
//! # Wire contract
//!
//! Base URL is owner-supplied (`NODEDESK_REGISTRY_URL` or settings). The
//! client sends `Authorization: Bearer <Google access token>` and never puts
//! an account id in the body — a real registry must derive the account by
//! validating that token. `mock://local` uses an in-process stub that keys
//! records by the raw bearer string and does **not** validate tokens. That
//! stub is for tests and single-process development, not a deployment.
//!
//! ```text
//! POST   {base}/v1/devices
//!        { "deviceId", "displayName", "os", "addresses": [{ "kind", "value" }] }
//!        → Device
//!
//! POST   {base}/v1/devices/{deviceId}/heartbeat
//!        same body → Device
//!
//! GET    {base}/v1/devices
//!        → { "devices": [ Device, ... ] }
//!
//! DELETE {base}/v1/devices/{deviceId}
//!        → 204 (404 is treated as already gone)
//! ```
//!
//! `kind` is `lan`, `tailscale`, or `other`. Device ids are 8–80 characters,
//! ASCII letters, digits, and hyphens.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

const REGISTRY_TIMEOUT: Duration = Duration::from_millis(2000);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum AddressKind {
    Lan,
    Tailscale,
    #[default]
    #[serde(other)]
    Other,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AddressCandidate {
    #[serde(default)]
    pub kind: AddressKind,
    pub value: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRegistration {
    pub device_id: String,
    pub display_name: String,
    pub os: String,
    pub addresses: Vec<AddressCandidate>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRecord {
    pub device_id: String,
    pub display_name: String,
    pub os: String,
    #[serde(default)]
    pub online: bool,
    #[serde(default)]
    pub addresses: Vec<AddressCandidate>,
}

/// A remote computer learned from the registry, after public addresses have
/// been removed. `address` is the one NodeDesk will try; empty means the
/// computer is on the account but has no path this app is willing to dial.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountSighting {
    pub device_id: String,
    pub name: String,
    pub os: String,
    pub registry_online: bool,
    pub address: String,
    pub candidates: Vec<String>,
}

#[derive(Debug)]
pub enum RegistryError {
    Expired,
    Unreachable,
    Rejected,
    Message(String),
}

impl RegistryError {
    pub fn message(&self) -> String {
        match self {
            Self::Expired => "Sign-in expired. Sign in again.".into(),
            Self::Unreachable => "Couldn't reach the account service.".into(),
            Self::Rejected => "The account service rejected the request.".into(),
            Self::Message(message) => message.clone(),
        }
    }
}

impl From<RegistryError> for String {
    fn from(err: RegistryError) -> Self {
        err.message()
    }
}

#[derive(Debug)]
pub enum RegistryBase {
    Http(String),
    InProcess,
}

pub fn parse_base(url: &str) -> Result<RegistryBase, RegistryError> {
    let url = url.trim();
    if url.is_empty() {
        return Err(RegistryError::Message(
            "no account service address configured".into(),
        ));
    }
    if url == "mock://local" {
        return Ok(RegistryBase::InProcess);
    }
    validate_http_base(url).map(RegistryBase::Http)
}

fn validate_http_base(url: &str) -> Result<String, RegistryError> {
    let url = url.trim().trim_end_matches('/');
    let (scheme, rest) = if let Some(rest) = url.strip_prefix("https://") {
        ("https", rest)
    } else if let Some(rest) = url.strip_prefix("http://") {
        ("http", rest)
    } else {
        return Err(RegistryError::Message(
            "account service address must be an https URL".into(),
        ));
    };
    if rest.is_empty()
        || rest.contains('@')
        || rest.contains(' ')
        || rest.contains('?')
        || rest.contains('#')
    {
        return Err(RegistryError::Message(
            "account service address is not valid".into(),
        ));
    }
    let host = rest.split('/').next().unwrap_or("");
    let host_name = if let Some(host) = host.strip_prefix('[') {
        host.split(']').next().unwrap_or("")
    } else {
        host.split(':').next().unwrap_or("")
    };
    if scheme == "http" {
        let loopback = host_name == "localhost" || host_name == "127.0.0.1" || host_name == "::1";
        if !loopback {
            return Err(RegistryError::Message(
                "account service must use https, except for a local test address".into(),
            ));
        }
    }
    if host_name.is_empty() {
        return Err(RegistryError::Message(
            "account service address is not valid".into(),
        ));
    }
    Ok(url.to_string())
}

pub fn is_device_id(id: &str) -> bool {
    (8..=80).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// True when NodeDesk may advertise this address or dial it.
///
/// Public addresses are rejected on purpose. The agent channel is signed but
/// not encrypted, and Sunshine must not be reached by publishing a public IP.
pub fn is_usable_address(candidate: &AddressCandidate) -> bool {
    let value = candidate.value.trim();
    if value.is_empty() || value.len() > 253 {
        return false;
    }
    match value.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => is_rfc1918(ip) || is_cgnat(ip),
        Ok(IpAddr::V6(ip)) => is_ula(ip),
        Err(_) => candidate.kind == AddressKind::Tailscale && is_safe_hostname(value),
    }
}

fn is_rfc1918(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 10 || (o[0] == 172 && (16..32).contains(&o[1])) || (o[0] == 192 && o[1] == 168)
}

/// Tailscale's IPv4 range (CGNAT). A carrier-grade NAT that is not Tailscale
/// could theoretically collide; it is still not a public address.
fn is_cgnat(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 100 && (64..128).contains(&o[1])
}

fn is_ula(ip: Ipv6Addr) -> bool {
    (ip.octets()[0] & 0xfe) == 0xfc
}

fn is_tailscale_v6(ip: Ipv6Addr) -> bool {
    let o = ip.octets();
    o[0] == 0xfd && o[1] == 0x7a && o[2] == 0x11 && o[3] == 0x5c && o[4] == 0xa1 && o[5] == 0xe0
}

fn is_safe_hostname(value: &str) -> bool {
    if value.len() > 253 || value.starts_with('.') || value.ends_with('.') || value.contains("..") {
        return false;
    }
    value.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    })
}

/// Usable addresses, best connect target first.
///
/// Tailscale IPv4 wins over a private LAN address because an account device
/// is usually on someone else's LAN — that 192.168 address is not ours.
/// IPv4 wins over IPv6 so the existing `http://{ip}:{port}` agent URL stays
/// valid. When LAN discovery has already listed the same address, the caller
/// keeps that card and does not add a second one.
pub fn ordered_usable(addresses: &[AddressCandidate]) -> Vec<String> {
    let mut ranked: Vec<(u8, String)> = Vec::new();
    for candidate in addresses {
        if !is_usable_address(candidate) {
            continue;
        }
        let value = candidate.value.trim().to_string();
        if ranked.iter().any(|(_, existing)| existing == &value) {
            continue;
        }
        ranked.push((address_rank(&value, candidate), value));
    }
    ranked.sort_by_key(|(rank, _)| *rank);
    ranked.into_iter().map(|(_, value)| value).collect()
}

fn address_rank(value: &str, candidate: &AddressCandidate) -> u8 {
    match value.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) if is_cgnat(ip) => 0,
        Ok(IpAddr::V4(_)) => 1,
        Ok(IpAddr::V6(ip)) if is_tailscale_v6(ip) => 2,
        Ok(IpAddr::V6(_)) => 3,
        Err(_) if candidate.kind == AddressKind::Tailscale => 4,
        Err(_) => 5,
    }
}

pub fn sightings(devices: &[DeviceRecord], self_device_id: &str) -> Vec<AccountSighting> {
    devices
        .iter()
        .filter(|device| !device.device_id.is_empty())
        .filter(|device| self_device_id.is_empty() || device.device_id != self_device_id)
        .map(|device| {
            let candidates = ordered_usable(&device.addresses);
            let address = candidates.first().cloned().unwrap_or_default();
            AccountSighting {
                device_id: device.device_id.clone(),
                name: clean_label(&device.display_name, "Computer", 80),
                os: clean_label(&device.os, "unknown", 40),
                registry_online: device.online,
                address,
                candidates,
            }
        })
        .collect()
}

pub fn overlaps_known(known: &[String], sight: &AccountSighting) -> bool {
    sight
        .candidates
        .iter()
        .any(|candidate| known.iter().any(|known| known == candidate))
}

fn clean_label(value: &str, fallback: &str, max: usize) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.chars().take(max).collect()
    }
}

fn publishable(addresses: &[AddressCandidate]) -> Vec<AddressCandidate> {
    let mut out = Vec::new();
    for candidate in addresses {
        if !is_usable_address(candidate) {
            continue;
        }
        let value = candidate.value.trim().to_string();
        if out
            .iter()
            .any(|existing: &AddressCandidate| existing.value == value)
        {
            continue;
        }
        out.push(AddressCandidate {
            kind: candidate.kind.clone(),
            value,
        });
        if out.len() == 8 {
            break;
        }
    }
    out
}

/// In-process stand-in for the registry. Records are keyed by bearer token.
/// A production server keys them by the Google `sub` inside a validated token
/// instead — this type does not check tokens.
#[derive(Debug, Default)]
pub struct MemoryRegistry {
    inner: Mutex<HashMap<String, HashMap<String, DeviceRecord>>>,
}

impl MemoryRegistry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, HashMap<String, DeviceRecord>>> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn register(
        &self,
        account: &str,
        registration: &DeviceRegistration,
    ) -> Result<DeviceRecord, RegistryError> {
        self.upsert(account, registration, true)
    }

    pub fn heartbeat(
        &self,
        account: &str,
        registration: &DeviceRegistration,
    ) -> Result<DeviceRecord, RegistryError> {
        self.upsert(account, registration, false)
    }

    fn upsert(
        &self,
        account: &str,
        registration: &DeviceRegistration,
        create: bool,
    ) -> Result<DeviceRecord, RegistryError> {
        if account.is_empty() {
            return Err(RegistryError::Message("missing account".into()));
        }
        if !is_device_id(&registration.device_id) {
            return Err(RegistryError::Message("device id is not valid".into()));
        }
        let mut guard = self.lock();
        let account_devices = guard.entry(account.to_string()).or_default();
        if !create && !account_devices.contains_key(&registration.device_id) {
            return Err(RegistryError::Message("this computer is not linked".into()));
        }
        let record = DeviceRecord {
            device_id: registration.device_id.clone(),
            display_name: clean_label(&registration.display_name, "Computer", 80),
            os: clean_label(&registration.os, "unknown", 40),
            online: true,
            addresses: registration.addresses.clone(),
        };
        account_devices.insert(record.device_id.clone(), record.clone());
        Ok(record)
    }

    pub fn list(&self, account: &str) -> Result<Vec<DeviceRecord>, RegistryError> {
        if account.is_empty() {
            return Err(RegistryError::Message("missing account".into()));
        }
        let guard = self.lock();
        let mut devices: Vec<DeviceRecord> = guard
            .get(account)
            .map(|map| map.values().cloned().collect())
            .unwrap_or_default();
        devices.sort_by(|a, b| a.device_id.cmp(&b.device_id));
        Ok(devices)
    }

    pub fn unlink(&self, account: &str, device_id: &str) -> Result<(), RegistryError> {
        if account.is_empty() {
            return Err(RegistryError::Message("missing account".into()));
        }
        if !is_device_id(device_id) {
            return Err(RegistryError::Message("device id is not valid".into()));
        }
        let mut guard = self.lock();
        if let Some(devices) = guard.get_mut(account) {
            devices.remove(device_id);
        }
        Ok(())
    }
}

fn process_registry() -> Arc<MemoryRegistry> {
    static REGISTRY: OnceLock<Arc<MemoryRegistry>> = OnceLock::new();
    REGISTRY
        .get_or_init(|| Arc::new(MemoryRegistry::new()))
        .clone()
}

enum RegistryInner {
    Http { http: reqwest::Client, base: String },
    Memory(Arc<MemoryRegistry>),
}

pub struct Registry {
    inner: RegistryInner,
}

impl Registry {
    pub fn from_base_url(http: reqwest::Client, url: &str) -> Result<Self, RegistryError> {
        match parse_base(url)? {
            RegistryBase::InProcess => Ok(Self::in_memory(process_registry())),
            RegistryBase::Http(base) => Ok(Self {
                inner: RegistryInner::Http { http, base },
            }),
        }
    }

    /// Isolated stub. Tests use this so they do not share `mock://local`.
    pub fn in_memory(memory: Arc<MemoryRegistry>) -> Self {
        Self {
            inner: RegistryInner::Memory(memory),
        }
    }

    pub async fn register(
        &self,
        token: &str,
        registration: &DeviceRegistration,
    ) -> Result<DeviceRecord, RegistryError> {
        require_token(token)?;
        if !is_device_id(&registration.device_id) {
            return Err(RegistryError::Message("device id is not valid".into()));
        }
        let registration = DeviceRegistration {
            addresses: publishable(&registration.addresses),
            ..registration.clone()
        };
        match &self.inner {
            RegistryInner::Memory(memory) => memory.register(token, &registration),
            RegistryInner::Http { http, base } => {
                let url = format!("{base}/v1/devices");
                let body = serde_json::to_string(&registration).map_err(|_| {
                    RegistryError::Message("Couldn't prepare the account request.".into())
                })?;
                let response = send(http, reqwest::Method::POST, url, token, Some(body)).await?;
                response.json().await.map_err(|_| RegistryError::Rejected)
            }
        }
    }

    pub async fn heartbeat(
        &self,
        token: &str,
        registration: &DeviceRegistration,
    ) -> Result<(), RegistryError> {
        require_token(token)?;
        if !is_device_id(&registration.device_id) {
            return Err(RegistryError::Message("device id is not valid".into()));
        }
        let registration = DeviceRegistration {
            addresses: publishable(&registration.addresses),
            ..registration.clone()
        };
        match &self.inner {
            RegistryInner::Memory(memory) => {
                memory.heartbeat(token, &registration)?;
                Ok(())
            }
            RegistryInner::Http { http, base } => {
                let url = format!("{base}/v1/devices/{}/heartbeat", registration.device_id);
                let body = serde_json::to_string(&registration).map_err(|_| {
                    RegistryError::Message("Couldn't prepare the account request.".into())
                })?;
                let _response = send(http, reqwest::Method::POST, url, token, Some(body)).await?;
                Ok(())
            }
        }
    }

    pub async fn list_devices(&self, token: &str) -> Result<Vec<DeviceRecord>, RegistryError> {
        require_token(token)?;
        match &self.inner {
            RegistryInner::Memory(memory) => memory.list(token),
            RegistryInner::Http { http, base } => {
                let url = format!("{base}/v1/devices");
                let response = send(http, reqwest::Method::GET, url, token, None).await?;
                let parsed: DeviceList =
                    response.json().await.map_err(|_| RegistryError::Rejected)?;
                Ok(parsed.devices)
            }
        }
    }

    pub async fn unlink(&self, token: &str, device_id: &str) -> Result<(), RegistryError> {
        require_token(token)?;
        if !is_device_id(device_id) {
            return Err(RegistryError::Message("device id is not valid".into()));
        }
        match &self.inner {
            RegistryInner::Memory(memory) => memory.unlink(token, device_id),
            RegistryInner::Http { http, base } => {
                let url = format!("{base}/v1/devices/{device_id}");
                let response = http
                    .request(reqwest::Method::DELETE, &url)
                    .bearer_auth(token)
                    .timeout(REGISTRY_TIMEOUT)
                    .send()
                    .await
                    .map_err(|_| RegistryError::Unreachable)?;
                let status = response.status();
                if status.as_u16() == 401 {
                    return Err(RegistryError::Expired);
                }
                if status.as_u16() == 404 || status.is_success() {
                    return Ok(());
                }
                Err(RegistryError::Rejected)
            }
        }
    }
}

#[derive(Deserialize)]
struct DeviceList {
    devices: Vec<DeviceRecord>,
}

fn require_token(token: &str) -> Result<(), RegistryError> {
    if token.is_empty() {
        Err(RegistryError::Message(
            "Sign in before using the account service.".into(),
        ))
    } else {
        Ok(())
    }
}

async fn send(
    http: &reqwest::Client,
    method: reqwest::Method,
    url: String,
    token: &str,
    body: Option<String>,
) -> Result<reqwest::Response, RegistryError> {
    let mut request = http
        .request(method, &url)
        .bearer_auth(token)
        .timeout(REGISTRY_TIMEOUT);
    if let Some(body) = body {
        request = request
            .header("content-type", "application/json")
            .body(body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| RegistryError::Unreachable)?;
    let status = response.status();
    if status.as_u16() == 401 {
        return Err(RegistryError::Expired);
    }
    if !status.is_success() {
        return Err(RegistryError::Rejected);
    }
    Ok(response)
}

#[cfg(test)]
pub async fn spawn_stub_registry() -> String {
    tests::spawn_stub_registry().await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(kind: AddressKind, value: &str) -> AddressCandidate {
        AddressCandidate {
            kind,
            value: value.into(),
        }
    }

    fn registration(id: &str, name: &str, addresses: Vec<AddressCandidate>) -> DeviceRegistration {
        DeviceRegistration {
            device_id: id.into(),
            display_name: name.into(),
            os: "linux".into(),
            addresses,
        }
    }

    #[test]
    fn base_url_rules() {
        assert!(matches!(
            parse_base("mock://local").unwrap(),
            RegistryBase::InProcess
        ));
        assert!(parse_base("").is_err());
        assert!(parse_base("mock://other").is_err());
        assert!(parse_base("http://registry.example.com").is_err());
        assert!(parse_base("https://user:secret@registry.example.com").is_err());
        match parse_base("https://registry.example.com/fleet/").unwrap() {
            RegistryBase::Http(url) => assert_eq!(url, "https://registry.example.com/fleet"),
            RegistryBase::InProcess => panic!("https base should stay http"),
        }
        assert!(parse_base("http://127.0.0.1:9/registry").is_ok());
        assert!(parse_base("http://localhost:9").is_ok());
        assert!(parse_base("http://[::1]:9").is_ok());
    }

    #[test]
    fn public_addresses_are_not_usable() {
        assert!(is_usable_address(&candidate(
            AddressKind::Lan,
            "192.168.1.10"
        )));
        assert!(is_usable_address(&candidate(AddressKind::Lan, "10.1.2.3")));
        assert!(is_usable_address(&candidate(
            AddressKind::Lan,
            "172.16.0.1"
        )));
        assert!(!is_usable_address(&candidate(
            AddressKind::Lan,
            "172.32.0.1"
        )));
        assert!(is_usable_address(&candidate(
            AddressKind::Tailscale,
            "100.64.0.1"
        )));
        assert!(!is_usable_address(&candidate(
            AddressKind::Other,
            "100.63.0.1"
        )));
        assert!(!is_usable_address(&candidate(
            AddressKind::Other,
            "100.128.0.1"
        )));
        assert!(!is_usable_address(&candidate(AddressKind::Lan, "8.8.8.8")));
        assert!(!is_usable_address(&candidate(
            AddressKind::Tailscale,
            "1.1.1.1"
        )));
        assert!(!is_usable_address(&candidate(
            AddressKind::Lan,
            "127.0.0.1"
        )));
        assert!(!is_usable_address(&candidate(
            AddressKind::Lan,
            "169.254.1.1"
        )));
        assert!(is_usable_address(&candidate(
            AddressKind::Tailscale,
            "fd7a:115c:a1e0::1"
        )));
        assert!(is_usable_address(&candidate(AddressKind::Lan, "fd00::1")));
        assert!(!is_usable_address(&candidate(AddressKind::Lan, "fe80::1")));
        assert!(!is_usable_address(&candidate(
            AddressKind::Lan,
            "2001:db8::1"
        )));
        assert!(is_usable_address(&candidate(
            AddressKind::Tailscale,
            "laptop.tailnet.ts.net"
        )));
        assert!(!is_usable_address(&candidate(
            AddressKind::Other,
            "evil.example.com"
        )));
        assert!(!is_usable_address(&candidate(
            AddressKind::Lan,
            "evil.example.com"
        )));
        assert!(!is_usable_address(&candidate(
            AddressKind::Tailscale,
            "not a host"
        )));
        assert!(!is_usable_address(&candidate(AddressKind::Lan, "")));
    }

    #[test]
    fn connect_address_prefers_tailscale_ipv4_and_drops_public() {
        let ordered = ordered_usable(&[
            candidate(AddressKind::Other, "8.8.8.8"),
            candidate(AddressKind::Lan, "192.168.0.5"),
            candidate(AddressKind::Tailscale, "100.64.0.2"),
            candidate(AddressKind::Tailscale, "fd7a:115c:a1e0::9"),
        ]);
        assert_eq!(
            ordered,
            vec!["100.64.0.2", "192.168.0.5", "fd7a:115c:a1e0::9"]
        );

        let public_only = ordered_usable(&[candidate(AddressKind::Other, "203.0.113.8")]);
        assert!(public_only.is_empty());

        let name_only =
            ordered_usable(&[candidate(AddressKind::Tailscale, "cabin.tailnet.ts.net")]);
        assert_eq!(name_only, vec!["cabin.tailnet.ts.net"]);
    }

    #[test]
    fn sightings_skip_self_and_keep_unreachable_names() {
        let devices = vec![
            DeviceRecord {
                device_id: "self-device".into(),
                display_name: "This computer".into(),
                os: "linux".into(),
                online: true,
                addresses: vec![candidate(AddressKind::Lan, "10.0.0.2")],
            },
            DeviceRecord {
                device_id: "cabin-pc".into(),
                display_name: "Cabin".into(),
                os: "windows".into(),
                online: true,
                addresses: vec![candidate(AddressKind::Other, "198.51.100.4")],
            },
        ];
        let sightings = sightings(&devices, "self-device");
        assert_eq!(sightings.len(), 1);
        assert_eq!(sightings[0].name, "Cabin");
        assert!(sightings[0].address.is_empty());
        assert!(sightings[0].registry_online);
        assert!(!overlaps_known(&["10.0.0.2".into()], &sightings[0]));
    }

    #[test]
    fn overlap_detects_an_address_discovery_already_found() {
        let sight = AccountSighting {
            device_id: "other-1".into(),
            name: "Office".into(),
            os: "linux".into(),
            registry_online: true,
            address: "100.64.0.4".into(),
            candidates: vec!["100.64.0.4".into(), "192.168.1.20".into()],
        };
        assert!(overlaps_known(&["192.168.1.20".into()], &sight));
        assert!(!overlaps_known(&["192.168.1.21".into()], &sight));
    }

    #[tokio::test]
    async fn memory_registry_isolates_accounts_and_filters_public_addresses() {
        let registry = Registry::in_memory(Arc::new(MemoryRegistry::new()));
        let body = registration(
            "device-aaaa",
            "Office",
            vec![
                candidate(AddressKind::Other, "8.8.8.8"),
                candidate(AddressKind::Lan, "10.1.0.5"),
            ],
        );
        registry.register("token-a", &body).await.unwrap();
        registry
            .register(
                "token-b",
                &registration("device-bbbb", "Other account", vec![]),
            )
            .await
            .unwrap();

        let listed = registry.list_devices("token-a").await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].addresses.len(), 1);
        assert_eq!(listed[0].addresses[0].value, "10.1.0.5");
        assert!(registry
            .list_devices("token-b")
            .await
            .unwrap()
            .iter()
            .all(|d| d.device_id != "device-aaaa"));

        let err = registry.list_devices("").await.unwrap_err();
        assert!(err.message().contains("Sign in"));

        let err = registry
            .heartbeat("token-a", &registration("missing-1", "Nope", vec![]))
            .await
            .unwrap_err();
        assert!(err.message().contains("not linked"));

        registry
            .heartbeat(
                "token-a",
                &registration(
                    "device-aaaa",
                    "Office renamed",
                    vec![candidate(AddressKind::Lan, "10.1.0.9")],
                ),
            )
            .await
            .unwrap();
        let listed = registry.list_devices("token-a").await.unwrap();
        assert_eq!(listed[0].display_name, "Office renamed");
        assert_eq!(listed[0].addresses[0].value, "10.1.0.9");

        registry.unlink("token-a", "device-aaaa").await.unwrap();
        assert!(registry.list_devices("token-a").await.unwrap().is_empty());
        registry.unlink("token-a", "device-aaaa").await.unwrap();
    }

    #[tokio::test]
    async fn http_registry_round_trip_matches_the_contract() {
        let base = spawn_stub_registry().await;
        let http = reqwest::Client::new();
        let registry = Registry::from_base_url(http, &base).unwrap();

        registry
            .register(
                "token-a",
                &registration(
                    "device-http-1",
                    "Studio",
                    vec![
                        candidate(AddressKind::Other, "203.0.113.9"),
                        candidate(AddressKind::Tailscale, "100.70.0.3"),
                    ],
                ),
            )
            .await
            .unwrap();
        registry
            .register("token-b", &registration("device-http-2", "Secret", vec![]))
            .await
            .unwrap();

        let mine = registry.list_devices("token-a").await.unwrap();
        assert_eq!(mine.len(), 1);
        assert_eq!(mine[0].display_name, "Studio");
        assert_eq!(mine[0].addresses.len(), 1);
        assert_eq!(mine[0].addresses[0].value, "100.70.0.3");
        assert!(mine[0].online);

        let text = serde_json::to_string(&registration("device-http-1", "Studio", vec![])).unwrap();
        assert!(!text.contains("email"));
        assert!(!text.contains("accessToken"));

        registry
            .heartbeat(
                "token-a",
                &registration(
                    "device-http-1",
                    "Studio",
                    vec![candidate(AddressKind::Tailscale, "100.70.0.8")],
                ),
            )
            .await
            .unwrap();
        let mine = registry.list_devices("token-a").await.unwrap();
        assert_eq!(mine[0].addresses[0].value, "100.70.0.8");

        let expired = registry.list_devices("expired").await.unwrap_err();
        assert!(matches!(expired, RegistryError::Expired));

        registry.unlink("token-a", "device-http-1").await.unwrap();
        assert!(registry.list_devices("token-a").await.unwrap().is_empty());
        assert_eq!(registry.list_devices("token-b").await.unwrap().len(), 1);
    }

    #[cfg(test)]
    pub async fn spawn_stub_registry() -> String {
        let app = stub_router(Arc::new(MemoryRegistry::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://127.0.0.1:{port}")
    }

    fn stub_router(memory: Arc<MemoryRegistry>) -> axum::Router {
        use axum::extract::{Path, State};
        use axum::http::{HeaderMap, StatusCode};
        use axum::routing::{delete, get, post};
        use axum::{Json, Router};

        async fn list_route(
            State(memory): State<Arc<MemoryRegistry>>,
            headers: HeaderMap,
        ) -> impl axum::response::IntoResponse {
            let Some(token) = bearer(&headers) else {
                return StatusCode::UNAUTHORIZED.into_response();
            };
            if token == "expired" {
                return StatusCode::UNAUTHORIZED.into_response();
            }
            match memory.list(token) {
                Ok(devices) => Json(serde_json::json!({ "devices": devices })).into_response(),
                Err(_) => StatusCode::BAD_REQUEST.into_response(),
            }
        }

        async fn register_route(
            State(memory): State<Arc<MemoryRegistry>>,
            headers: HeaderMap,
            Json(body): Json<DeviceRegistration>,
        ) -> impl axum::response::IntoResponse {
            let Some(token) = bearer(&headers) else {
                return StatusCode::UNAUTHORIZED.into_response();
            };
            match memory.register(token, &body) {
                Ok(record) => Json(record).into_response(),
                Err(_) => StatusCode::BAD_REQUEST.into_response(),
            }
        }

        async fn heartbeat_route(
            State(memory): State<Arc<MemoryRegistry>>,
            Path(device_id): Path<String>,
            headers: HeaderMap,
            Json(mut body): Json<DeviceRegistration>,
        ) -> impl axum::response::IntoResponse {
            let Some(token) = bearer(&headers) else {
                return StatusCode::UNAUTHORIZED.into_response();
            };
            body.device_id = device_id;
            match memory.heartbeat(token, &body) {
                Ok(record) => Json(record).into_response(),
                Err(_) => StatusCode::NOT_FOUND.into_response(),
            }
        }

        async fn unlink_route(
            State(memory): State<Arc<MemoryRegistry>>,
            Path(device_id): Path<String>,
            headers: HeaderMap,
        ) -> impl axum::response::IntoResponse {
            let Some(token) = bearer(&headers) else {
                return StatusCode::UNAUTHORIZED.into_response();
            };
            match memory.unlink(token, &device_id) {
                Ok(()) => StatusCode::NO_CONTENT.into_response(),
                Err(_) => StatusCode::NOT_FOUND.into_response(),
            }
        }

        Router::new()
            .route("/v1/devices", get(list_route).post(register_route))
            .route("/v1/devices/:id", delete(unlink_route))
            .route("/v1/devices/:id/heartbeat", post(heartbeat_route))
            .with_state(memory)
    }

    fn bearer(headers: &axum::http::HeaderMap) -> Option<&str> {
        headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .filter(|token| !token.is_empty())
    }

    use axum::response::IntoResponse;
}
