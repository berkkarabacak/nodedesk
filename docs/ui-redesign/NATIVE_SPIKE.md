# Native spike: stream readiness, toolbar, and permission enforcement (M5/M6)

Status: **written from code inspection, not verified on hardware** (no Rust
toolchain / real hosts in the authoring environment). Commands below must be
run on a Windows dev machine before any claim is made.

## Findings at ff07bf2 + M-series changes

1. `connect_computer` spawns external Moonlight; `stream-started` fires on
   process spawn — explicitly NOT readiness (SESSION-02). No stdout parsing
   exists for a readiness marker.
2. `stream_child` was overwritten on a second spawn (leaked process). Fixed
   in M5: `start_stream` kills+reaps a previous child first (SESSION-06).
3. No exit watcher existed. M5 adds `watch_stream` emitting `stream-exited`
   (SESSION-11). The UI reconciles state from it.
4. Moonlight-Qt is a separate fullscreen window; a React overlay cannot float
   above it reliably. TOOLBAR-01 therefore requires one of:
   a. Run Moonlight non-fullscreen (borderless window) with a NodeDesk-owned
      overlay bar above it — smallest change, uses upstream as-is.
   b. Embed streaming via the Moonlight Embedded library — larger change,
      needed for the final Screen-06 design with in-app toolbar/panels.
   Decision recorded: (a) as the interim milestone, (b) tracked for M6 final.
5. Permission enforcement gap (APPROVAL-05/06): accepted request permissions
   are authoritative on the directory service, but the host's Sunshine/agent
   paths do not consume them yet. Smallest validated path:
   - On `host_accept_request`, the host records an active grant
     `{ requestId, controllerDeviceId, permissions, expiresAt }` in a new
     `grants.rs` (in-memory + audit log; never in settings.json).
   - `agent.rs` file/terminal endpoints check the grant before serving
     (files only when `perm_files`), keyed by the controller's verified
     device identity on the agent channel.
   - Input blocking (view-only) requires Sunshine-side control; interim:
     NodeDesk launches Moonlight with input disabled upstream flags where
     available, else the session is clearly labeled "control always granted"
     and view-only is marked unsupported until the Sunshine integration.
   - Old paired Moonlight clients bypass: revoke on policy change via
     Sunshine's API (unpair) — needs verification on hardware.

## Verification commands (Windows dev machine)

```
cd apps/desktop/src-tauri
cargo check --all-targets
cargo clippy --all-targets -- -D warnings
cargo test
npm run tauri dev   # real two-machine J1/J2 walkthrough
```

## Explicitly not claimed

- Stream readiness detection (SESSION-02 full) — needs the upstream signal
  verified on hardware.
- Live quality/monitor/clipboard/audio control of the stream (TOOLBAR-02..07).
- Cross-network routing beyond LAN/Tailscale (NETWORK-02).
