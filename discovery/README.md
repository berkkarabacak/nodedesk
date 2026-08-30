# discovery/

Finds your computers so you never type an IP address.

## Responsibilities

- **LAN:** mDNS announcements + passive listening + active scan
- **Tailnet:** enumerate tailnet peers running NodeDesk via the Tailscale
  local API (only when Tailscale is present)
- Merge results into the unified computer list consumed by the dashboard:
  name, OS, online/offline, address candidates, pairing state
- Feed the "Scan network for computers" flow in the UI

**Status:** design stage.
