<p align="center">
  <img src="apps/desktop/src-tauri/icons/128x128.png" width="72" alt="NodeDesk logo" />
</p>

<h1 align="center">NodeDesk</h1>

<p align="center"><strong>Your computers. One interface. Anywhere.</strong></p>

<p align="center">
  An open-source, one-click remote-computing application built around the
  <a href="https://github.com/LizardByte/Sunshine">Sunshine</a> /
  <a href="https://github.com/moonlight-stream">Moonlight</a> ecosystem.<br/>
  Use your desktops, laptops, workstations and AI machines remotely — without
  manually configuring remote-streaming infrastructure.
</p>

<p align="center">
  <code>Install → Find your computer → Connect</code>
</p>

<p align="center">
  <a href="https://github.com/berkkarabacak/nodedesk/actions/workflows/ci.yml"><img src="https://github.com/berkkarabacak/nodedesk/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/berkkarabacak/nodedesk/releases/latest"><img src="https://img.shields.io/github/v/release/berkkarabacak/nodedesk" alt="Latest release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="License" /></a>
</p>

<p align="center">
  <a href="https://berkkarabacak.github.io/nodedesk/">Website</a> ·
  <a href="docs/architecture.md">Architecture</a> ·
  <a href="docs/security.md">Security</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="#roadmap">Roadmap</a>
</p>

---

## What is NodeDesk?

NodeDesk turns the (excellent, but enthusiast-oriented) Sunshine + Moonlight
streaming stack into a product anyone can use:

> **The simplicity of Parsec, powered by open-source Sunshine/Moonlight,
> designed for computers rather than gaming.**

- **One application** — host and controller in a single installer. You never
  download, install, configure or pair Sunshine and Moonlight yourself.
- **Fresh PC → working remote desktop in under 2 minutes.**
- **General-purpose**: coding, browsers, office work, creative apps, terminals,
  AI interfaces — gaming works too, but it doesn't drive the UX.
- **AI-workstation aware**: GPU/VRAM monitoring, headless virtual displays,
  and (post-MVP) discovery of local services like Ollama, Open WebUI and
  ComfyUI.
- **Secure by default**: authenticated pairing, encrypted streaming sessions,
  signed and replay-protected agent requests, OS secure credential storage, no
  silent public-internet exposure.

You will never need to know what a codec, port, pairing PIN, firewall rule or
virtual display is — unless you open **Advanced Settings** on purpose.

## The dashboard

```text
MY COMPUTERS

🟢 AI Workstation
RTX 3090 • 64 GB RAM • Windows
CPU 14%   GPU 72%
[ CONNECT ]

🟢 Old Laptop
Intel i7 • 16 GB • Linux
CPU 8%
[ CONNECT ]

⚫ Bedroom PC
[ WAKE ]
```

## Install

**Windows (first-class at MVP):** download `NodeDesk-Setup-x64.exe` from the
latest [release](https://github.com/berkkarabacak/nodedesk/releases) and run
it. The installer:

- installs the application and required host components
- configures the Sunshine-compatible host service automatically
- configures firewall rules and startup
- detects your GPU and supported encoders
- generates a secure device identity
- picks sensible defaults

Clean uninstall removes services, drivers, firewall rules and configuration.
Linux (AppImage/deb) and macOS (dmg) packages follow the MVP — see the
[roadmap](#roadmap).

## How it works

```text
                   NodeDesk app
                         │
             ┌───────────┴───────────┐
             │                       │
       Controller mode           Host mode
      (Moonlight technology)   (Sunshine technology)
             │                       │
             └──── Remote stream ────┘
```

NodeDesk wraps upstream Sunshine/Moonlight technology — managed, configured and
kept compatible — rather than re-implementing streaming. LAN discovery is
automatic; [Tailscale](https://tailscale.com) is a first-class *optional*
integration for reaching your machines anywhere. Details in
[docs/architecture.md](docs/architecture.md) and
[docs/networking.md](docs/networking.md).

## Security

- Authenticated pairing and certificate verification on every connection
- Encrypted streaming and clipboard channels (upstream Sunshine/Moonlight)
- NodeDesk's own agent channel - metrics, power, files, terminal - authenticates
  every request with an HMAC signature: the access code is never sent over the
  network, replays are rejected, and repeated failures lock the peer out
- File access from the network is confined to your own folders
- Access codes for this machine *and* every remote machine are stored in
  OS-provided secure storage, never in a config file
- Forget a computer to delete its code; regenerate yours to invalidate it
  everywhere, immediately
- Diagnostic exports redact all secrets
- Sunshine is **never** silently exposed to the public internet

The agent channel is authenticated and tamper-evident but **not encrypted** -
use Tailscale when the network itself is untrusted. The full model, including
what is *not* yet mitigated, is in [docs/security.md](docs/security.md). To
report a vulnerability, see [SECURITY.md](SECURITY.md).

## Roadmap

Priorities, in order: **stability → security → simplicity → performance →
features.**

**v1.0 (Windows) ships:** one installer · host + controller in one app ·
automatic Sunshine install & configuration · Moonlight-based desktop connect ·
LAN discovery · PIN pairing without the web UI · Tailscale detection ·
computer dashboard with live CPU/RAM/GPU · clipboard sync ·
wake/sleep/restart/shutdown/lock · diagnostics · update checks.

**v1.1 added:** drag & drop file transfer with automatic resume · integrated
remote terminal · AI service discovery.

**v1.2 adds:** Linux host packages (AppImage/deb, automatic Sunshine
bootstrap on Debian/Ubuntu) · macOS controller (dmg) · headless virtual
display support on Windows (consent-gated driver install).

**Next:** beta/nightly update channels · hardware compatibility matrix ·
in-place auto-updates.

The defining test of NodeDesk:

> Can a non-technical person install this on two computers and remotely control
> one from the other without knowing what Sunshine, Moonlight, codecs, ports,
> VPNs or streaming protocols are?

If the answer is no, we keep simplifying.

## Repository layout

All implementation currently lives under `apps/desktop/`:

```text
apps/desktop/src/            React UI (dashboard, device detail, settings)
apps/desktop/src-tauri/src/  Rust core:
  agent.rs                     host agent HTTP service (authenticated)
  auth.rs                      request signing, replay + brute-force defence
  client.rs                    signed client for talking to another host
  safepath.rs                  path confinement for network file requests
  files.rs                     resumable file transfer
  terminal.rs                  remote command execution
  discovery.rs                 LAN broadcast + tailnet discovery
  monitor.rs                   CPU/RAM/GPU/VRAM metrics, AI service detection
  sunshine.rs / moonlight.rs   upstream host and client integration
  headless.rs                  virtual display driver management
  release.rs                   upstream download origin checks
  state.rs                     settings file + OS secure storage
installer/                   Per-platform packaging notes
website/                     Project website (GitHub Pages)
docs/                        Architecture, security, networking, upstream, development
docs/adr/                    Architecture decision records
```

The top-level `agent/`, `streaming/`, `networking/`, `discovery/`,
`monitoring/` and `file-transfer/` directories hold **design notes** for those
subsystems, not code. They document intent and open questions; the working
implementation is the Rust modules listed above.

## Development

See [docs/development.md](docs/development.md). Quick start:

```bash
cd apps/desktop
npm install
npm run dev        # UI in a browser (mock backend)
npm run tauri dev  # full desktop shell (requires Rust)
```

Every change is checked by CI: Rust unit tests and clippy (warnings are errors)
on Windows, Linux and macOS, a **simulated two-machine end-to-end test** (a real
agent over real TCP plays the other computer - discovery, signed requests,
replay rejection, pairing approval, resumable file transfer, terminal), frontend
unit and component tests, and a dependency audit. Installer bundles for all
three platforms are built on tagged releases.

## Contributing

NodeDesk is a community open-source project. Read
[CONTRIBUTING.md](CONTRIBUTING.md), grab a
[`good first issue`](https://github.com/berkkarabacak/nodedesk/labels/good%20first%20issue),
and join the
[Discussions](https://github.com/berkkarabacak/nodedesk/discussions).

## License

GPL-3.0-only — see [LICENSE](LICENSE). NodeDesk is built on Sunshine (GPL-3.0)
and Moonlight (GPL-3.0); attribution and redistribution requirements are
documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). NodeDesk is
not affiliated with or endorsed by LizardByte or the Moonlight project.
