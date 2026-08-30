# Development

## Prerequisites

- Node.js 20+ and npm
- Rust (stable) — for the Tauri shell and core: <https://rustup.rs>
- Windows: Microsoft C++ Build Tools; the WebView2 runtime ships with modern Windows
- For host-side streaming work: a checkout of upstream Sunshine docs helps

## Repository layout

```text
apps/desktop/     Tauri 2 + React + TypeScript desktop app
agent/            Privileged host agent (design stage)
streaming/        Sunshine / Moonlight integration layers (design stage)
networking/       Connection management (design stage)
discovery/        LAN + tailnet discovery (design stage)
monitoring/       System + AI service metrics (design stage)
file-transfer/    Resumable file transfer (design stage)
installer/        Platform packaging
website/          Project website (GitHub Pages)
docs/             Architecture, security, networking, upstream, development
```

## Run the desktop app UI (no Rust required)

```bash
cd apps/desktop
npm install
npm run dev          # http://localhost:1420 — mock backend, fully interactive
```

The UI talks to the Rust core through the command contract in
`apps/desktop/src/lib/api.ts`. In a browser it falls back to a deterministic
mock, which is also how CI exercises the front-end.

## Run the full desktop shell

```bash
cd apps/desktop
npm run tauri dev    # requires Rust toolchain
```

## Build

```bash
cd apps/desktop
npm run build        # front-end type-check + production build
npm run tauri build  # NSIS installer (Windows) — runs in CI
```

## Website

```bash
cd website
npm install
npm run dev          # local dev server
npm run build        # static site in website/dist (deployed to GitHub Pages by CI)
```

## Testing & CI

Every PR runs (see `.github/workflows/ci.yml`):

- formatting and linting (front-end and Rust)
- type-check + production build of `apps/desktop` and `website`
- `cargo check`/`clippy`/`cargo test` for `src-tauri`
- dependency security audit (`npm audit`, `cargo audit`)

Critical behaviors that must grow automated tests as modules land:
installation/upgrade/uninstall, pairing, authentication, LAN + Tailscale
discovery, streaming startup, reconnection, file transfer, clipboard,
sleep/wake, host reboot, multi-GPU, display changes, headless operation.

## Conventions

- Keep the repository buildable on `main` at all times.
- Small, reviewable PRs. ADRs for architectural decisions (`docs/adr/`).
- UI copy rule: no jargon a non-technical user must decode.
