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

Every PR and push runs (see `.github/workflows/ci.yml`):

- **Rust**: `cargo check` / `clippy` / `cargo test` — unit tests for every
  module (file transfer offsets and resume, WoL packets, PIN normalization,
  stream-arg mapping, settings persistence, semver, access-code charset)
- **Two-machine simulation** (`src-tauri/src/sim_test.rs`): a real agent over
  real TCP plays "the other computer" while the controller drives it through
  the production code paths — discovery, metrics, access-code auth (401 on a
  wrong code), PIN approval against a mock Sunshine, resumable file transfer
  in both directions (including mid-transfer interruption), and terminal
  execution. Ports and API endpoints are env-overridable
  (`NODEDEK_AGENT_PORT`, `NODEDEK_DISCOVERY_PORT`, `NODEDEK_SUNSHINE_API`,
  `NODEDEK_INCOMING_DIR`, `NODEDEK_DOWNLOAD_DIR`).
- **Frontend**: `npm test` (Vitest) — mock-backend contract tests for every
  command the UI uses
- type-check + production build of `apps/desktop` and `website`
- dependency security audit (`npm audit`)

Not covered by automation (needs real hardware): the video stream itself
(upstream Sunshine/Moonlight domain), real GPU encoder paths, and physical
multi-machine runs.

## Conventions

- Keep the repository buildable on `main` at all times.
- Small, reviewable PRs. ADRs for architectural decisions (`docs/adr/`).
- UI copy rule: no jargon a non-technical user must decode.
- New core logic ships with tests; simulation-friendly code (injectable
  ports/emitters) is preferred over test-only mocks.
