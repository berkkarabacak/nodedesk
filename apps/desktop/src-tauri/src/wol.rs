//! Wake-on-LAN: craft and broadcast the magic packet.

use std::net::UdpSocket;

pub fn parse_mac(mac: &str) -> Option<[u8; 6]> {
    let parts: Vec<&str> = mac.split([':', '-']).collect();
    if parts.len() != 6 {
        return None;
    }
    let mut out = [0u8; 6];
    for (i, p) in parts.iter().enumerate() {
        out[i] = u8::from_str_radix(p, 16).ok()?;
    }
    Some(out)
}

pub fn build_packet(mac: [u8; 6]) -> Vec<u8> {
    let mut packet = vec![0xFFu8; 6];
    for _ in 0..16 {
        packet.extend_from_slice(&mac);
    }
    packet
}

pub fn wake(mac: &str) -> Result<(), String> {
    let mac = parse_mac(mac).ok_or("invalid MAC address")?;
    let packet = build_packet(mac);
    let socket = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    socket.set_broadcast(true).map_err(|e| e.to_string())?;
    for port in [9u16, 7] {
        let _ = socket.send_to(&packet, ("255.255.255.255", port));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_mac_formats() {
        assert!(parse_mac("AA:BB:CC:DD:EE:FF").is_some());
        assert!(parse_mac("aa-bb-cc-dd-ee-ff").is_some());
        assert!(parse_mac("not-a-mac").is_none());
    }

    #[test]
    fn magic_packet_shape() {
        let packet = build_packet([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
        assert_eq!(packet.len(), 102);
        assert!(packet[..6].iter().all(|b| *b == 0xFF));
        assert_eq!(&packet[6..12], &[0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
    }
}
