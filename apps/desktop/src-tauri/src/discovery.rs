//! LAN + Tailscale discovery. Users never type an IP unless they want to.

use serde::{Deserialize, Serialize};
use std::io::ErrorKind;
use std::net::UdpSocket;
use std::time::Duration;

pub const DISCOVERY_PORT: u16 = 47800;
pub const AGENT_PORT: u16 = 47801;
const MAGIC: &[u8] = b"NODEDESK_DISCOVER_V1";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FoundHost {
    pub name: String,
    pub os: String,
    pub address: String,
    pub via: String, // "lan" | "tailscale" | "manual"
}

/// Answers discovery beacons forever. Started once at app launch.
pub fn start_responder() {
    std::thread::spawn(|| {
        let Ok(socket) = UdpSocket::bind(("0.0.0.0", DISCOVERY_PORT)) else {
            return; // another NodeDesk instance already answers
        };
        let name = sysinfo::System::host_name().unwrap_or_else(|| "NodeDesk PC".into());
        let os = std::env::consts::OS;
        let reply = serde_json::json!({ "name": name, "os": os }).to_string();
        let mut buf = [0u8; 1024];
        loop {
            let Ok((len, peer)) = socket.recv_from(&mut buf) else {
                continue;
            };
            if &buf[..len] == MAGIC {
                let _ = socket.send_to(reply.as_bytes(), peer);
            }
        }
    });
}

/// Broadcasts a beacon and collects answers for `timeout_ms`.
pub fn scan(timeout_ms: u64) -> Vec<FoundHost> {
    let mut found: Vec<FoundHost> = vec![];
    let Ok(socket) = UdpSocket::bind(("0.0.0.0", 0)) else {
        return found;
    };
    if socket.set_broadcast(true).is_err() {
        return found;
    }
    let _ = socket.send_to(MAGIC, ("255.255.255.255", DISCOVERY_PORT));
    let _ = socket.set_read_timeout(Some(Duration::from_millis(150)));

    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    let mut buf = [0u8; 1024];
    while std::time::Instant::now() < deadline {
        match socket.recv_from(&mut buf) {
            Ok((len, peer)) => {
                if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&buf[..len]) {
                    let name = v.get("name").and_then(|s| s.as_str()).unwrap_or("Computer");
                    let os = v.get("os").and_then(|s| s.as_str()).unwrap_or("unknown");
                    let address = peer.ip().to_string();
                    if !found.iter().any(|h| h.address == address) {
                        found.push(FoundHost {
                            name: name.to_string(),
                            os: os.to_string(),
                            address,
                            via: "lan".into(),
                        });
                    }
                }
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::TimedOut => {}
            Err(_) => break,
        }
    }
    found
}

#[derive(Deserialize)]
struct TailscaleStatus {
    #[serde(rename = "Peer", default)]
    peers: Vec<TailscalePeer>,
}

#[derive(Deserialize)]
struct TailscalePeer {
    #[serde(rename = "HostName", default)]
    host_name: String,
    #[serde(rename = "TailscaleIPs", default)]
    ips: Vec<String>,
    #[serde(rename = "Online", default)]
    online: bool,
}

/// Online tailnet peers (if Tailscale is installed). Presence of the NodeDesk
/// agent is probed separately — a closed agent port just means "not NodeDesk".
pub fn tailscale_peers() -> Vec<FoundHost> {
    let out = std::process::Command::new("tailscale")
        .args(["status", "--json"])
        .output();
    let Ok(out) = out else { return vec![] };
    let Ok(status) = serde_json::from_slice::<TailscaleStatus>(&out.stdout) else {
        return vec![];
    };
    status
        .peers
        .into_iter()
        .filter(|p| p.online)
        .filter_map(|p| {
            p.ips.first().map(|ip| FoundHost {
                name: if p.host_name.is_empty() { ip.clone() } else { p.host_name },
                os: "unknown".into(),
                address: ip.clone(),
                via: "tailscale".into(),
            })
        })
        .collect()
}

/// Quick check whether a NodeDesk agent answers at this address. Any HTTP
/// response (even 401) proves a NodeDesk host is there.
pub async fn agent_present(client: &reqwest::Client, address: &str) -> bool {
    client
        .get(format!("http://{address}:{AGENT_PORT}/metrics"))
        .timeout(Duration::from_millis(700))
        .send()
        .await
        .is_ok()
}

pub fn local_ip() -> Option<String> {
    // No packets are actually sent; this just asks the OS which interface
    // would be used to reach the internet.
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    Some(socket.local_addr().ok()?.ip().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn found_host_serde_camel_case() {
        let h = FoundHost {
            name: "AI-PC".into(),
            os: "windows".into(),
            address: "192.168.1.20".into(),
            via: "lan".into(),
        };
        let text = serde_json::to_string(&h).unwrap();
        let back: FoundHost = serde_json::from_str(&text).unwrap();
        assert_eq!(back.name, "AI-PC");
        assert_eq!(back.via, "lan");
    }

    #[test]
    fn local_ip_does_not_panic_offline() {
        // May return None without network; must never panic.
        let _ = local_ip();
    }
}
