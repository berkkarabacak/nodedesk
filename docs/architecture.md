# NodeDesk Architecture

## Philosophy

**“The simplicity of Parsec, powered by open-source Sunshine/Moonlight,
designed for computers rather than gaming.”**

NodeDesk is one desktop application. Users never separately download, install,
configure, pair or understand Sunshine and Moonlight.

```text
Install → choose how this computer is used → see computers → Connect
```

Target: fresh PC → working remote desktop in **under 2 minutes**.

## High-level design

```text
                         ┌─────────────────────────────┐
                         │        NodeDesk app         │
                         │   (Tauri 2 shell + React)   │
                         └──────────────┬──────────────┘
                                        │
        ┌───────────────┬───────────────┼────────────────┬───────────────┐
        │               │               │                │               │
   Controller mode   Host mode      Discovery        Monitoring     File transfer
   (Moonlight        (managed        (LAN mDNS +      (CPU/RAM/     (authenticated,
    protocol client)  Sunshine host)  Tailscale)       GPU/VRAM)     resumable)
        │               │               │                │               │
        └───────────────┴───────┬───────┴────────────────┴───────────────┘
                                │
                    NodeDesk privileged agent
             (power actions, terminal, virtual displays,
              firewall/service management — minimal surface)
```

## Upstream strategy (decision)

NodeDesk **wraps** upstream components instead of forking them:

| Component | Strategy |
|---|---|
| Sunshine (host) | Managed service: the installer deploys an unmodified upstream Sunshine build, driven through its configuration API. No permanent fork. |
| Moonlight (client) | Protocol client embedded as a library where packaging allows; otherwise a managed, unmodified upstream component. |
| Virtual displays | Platform-specific, security-sensitive: managed drivers installed only with explicit consent, documented per platform. |

Rationale: the streaming stack is the hardest part to build and the easiest to
get subtly wrong. Sunshine and Moonlight are mature, audited-by-use, and
actively maintained. NodeDesk's value is the **product experience** —
installation, discovery, management, networking integration, monitoring and
workflow — not new streaming code.

- Upstream compatibility is a design goal; NodeDesk tracks upstream releases.
- Any downstream patch must be small, isolated, and proposed upstream first
  (see [upstream.md](upstream.md)).
- Large permanent forks require an ADR explaining why no alternative exists.

## Modes

On first run the app asks: **Control my computers / Allow this computer to be
controlled / Both** (default: Both). Internally the mode toggles which
components are installed and started. Mode can be changed at any time.

## Technology stack

**Rust + Tauri 2 shell, React + TypeScript UI** — see
[ADR 0001](adr/0001-technology-stack.md). Installer size, memory footprint,
GPU/native API access, and security all argue against Electron.

## Module map

| Path | Responsibility |
|---|---|
| `apps/desktop/` | Desktop application shell (Tauri) and all user-facing UI |
| `agent.rs` | Per-machine agent: power actions, remote terminal, file transfer, metrics. Every request signed - see docs/security.md |
| `sunshine.rs` | Sunshine lifecycle: install detection, configuration, health, upgrades |
| `moonlight.rs` | Moonlight client integration: session launch, input, reconnect |
| `networking/` (design notes) | Connection policy: LAN-first, Tailscale detection, NAT/firewall handling, reconnect strategy |
| `discovery.rs` | Computer discovery on LAN (UDP broadcast beacon on port 47800) and tailnet (`tailscale status --json`). mDNS is planned; broadcast does not cross subnets |
| `monitor.rs` | Hardware inventory + live CPU/RAM/GPU/VRAM (NVIDIA via nvidia-smi), AI service detection |
| `files.rs` | Authenticated, resumable, path-confined file transfer (independent of video stream). Not encrypted - see docs/security.md |
| `installer/` | Per-platform packaging and first-run machine configuration |

## UX principle

Whenever a technical concept is about to be exposed: **does the user actually
need to know this?** Errors are human (`Can't reach AI-PC. [Try Again]`), with
technical detail behind an expandable “Advanced details”. Expert configuration
lives in Settings → Advanced and is needed by ~5% of users.

## Reliability

The connection layer must survive: network interruption, Wi-Fi changes, IP
changes, sleeping hosts, app crashes, GPU driver resets, host/client reboots,
temporary Tailscale loss, monitor hotplug and resolution changes. Automatic
reconnection with exponential backoff is the default; a session should resume
without user action when the network recovers.
