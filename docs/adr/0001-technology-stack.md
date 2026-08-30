# ADR 0001: Desktop technology stack

- Status: Accepted
- Date: 2026-08-30

## Context

NodeDesk is one desktop application that must feel like a native product:
small installer, low memory use, GPU/native API access, secure credential
storage, and clean integration with Sunshine/Moonlight host components.

Options considered:

| Stack | Pros | Cons |
|---|---|---|
| **Rust + Tauri 2** | Small installers (~10 MB), low memory, Rust core fits Sunshine/Moonlight integration, strong security posture, cross-platform | WebView dependency; younger ecosystem than Qt |
| **C++/Qt** | Mature, native performance, close to upstream codebases (both are C++) | Large installers, heavier UI iteration, licensing considerations (LGPL/commercial), slower product velocity |
| **Electron** | Fast UI iteration, huge ecosystem | ~150 MB+ installers, high memory — contradicts product goals; explicitly excluded by product brief |
| Native per-platform | Best platform fidelity | Three codebases; unsustainable for a young OSS project |

## Decision

**Rust + Tauri 2 shell, React + TypeScript UI, Tailwind for styling.**

- The Rust core owns: discovery, monitoring, file transfer, networking policy,
  Sunshine lifecycle, secure storage, agent IPC.
- The web UI owns: dashboard, onboarding, settings, diagnostics.
- Windows is the MVP target; Tauri's NSIS bundler produces
  `NodeDesk-Setup-x64.exe`. Linux (AppImage/deb) and macOS (dmg) follow
  without UI rewrites.

## Consequences

- CI must build Rust + Node; release workflow signs artifacts.
- UI runs against a mock backend in a plain browser, which keeps front-end
  iteration fast and testable.
- If a Moonlight client library integration proves impractical from Rust, the
  fallback is a managed unmodified upstream client process — the architecture
  accommodates either without changing the UI contract.
