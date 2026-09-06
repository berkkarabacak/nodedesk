# networking/

> **Design notes, not code.** The working implementation lives in
> `apps/desktop/src-tauri/src/` - see the repository layout in the README.

Connection policy and transport selection for NodeDesk.

## Responsibilities

- LAN-first direct connections
- Tailscale detection and tailnet path selection (optional, first-class)
- Never silently exposing the host to the public internet
- Reconnection with exponential backoff; sessions survive network blips,
  Wi-Fi changes, IP changes, host/client reboots and temporary Tailscale loss
- Extensible backend interface so additional secure networking solutions can
  be added later

Design details: [docs/networking.md](../docs/networking.md).

**Status:** design stage.
