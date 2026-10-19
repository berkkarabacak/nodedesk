# Native spike: stream readiness, toolbar, and permission enforcement (M5/M6)

Status: **native behavior is unit-tested. Hardware acceptance is not done.**
A green `cargo test` does not mean two Windows machines were used.

## What the code does now

1. `stream-started` fires when the Moonlight process spawns. That is not
   Connected. `stream-ready` fires only when a log line matches Moonlight-Qt's
   `Video stream is <width>x<height>x<fps>` (`Session::drSetup`). The UI stays
   on Connecting until that line, and a process exit before it is a failure
   (SESSION-02).
2. After a ready stream, a non-clean exit retries at 1s, 2s, then 4s and then
   stops. A clean quit does not retry. Revocation sets a flag, kills the
   viewer, and does not relaunch (SESSION-07/08).
3. Grants are enforced on the agent. See `grants.rs` and the agent tests:
   wrong controller, missing grant while one is active, view-only terminal,
   and a denied download whose body is not the file.
4. Policy changes call Sunshine `POST /api/clients/unpair-all`. View-only
   acceptance turns `mouse`, `keyboard`, and `controller` off via a full
   config round-trip plus restart, and restores them when the session ends.
   This is not verified against a running Sunshine in CI (the HTTP shape is
   tested with a local stub).

## Still not claimed

1. `connect_computer` cannot see a real Moonlight window in CI. The readiness
   marker is the upstream log line; it has not been captured from a hardware
   session in this change.
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
