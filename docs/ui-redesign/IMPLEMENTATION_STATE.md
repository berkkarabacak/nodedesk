# NodeDesk UI Redesign — Implementation State

Product: NodeDesk — free remote desktop, Google sign-in, saved PCs, one-click use.
Specification: `docs/ui-redesign/SPEC.txt` (durable copy of the BDD implementation prompt).
Design source: `Simple Remote Desktop App UI.zip` → `Simple Remote Desktop App.dc.html`, screens 01–08.

## Current position

- Current milestone: **HARDENING IN PROGRESS** — Rust compile pass DONE (69/69 tests, clippy clean); SECURITY-03 TLS channel DONE; permission enforcement on agent endpoints DONE; remaining: live OAuth config, hardware matrix, readiness/toolbar spike.
- Next single task: follow docs/ui-redesign/DEMO.md for the investor demo run; then the SPEC §11 real-machine matrix.

## Hardening log (2026-10-08, after the investor-demo push)

- **Rust toolchain installed** (stable 1.99, GNU + MinGW). Baseline `cargo check` found 6 real compile errors in the M-series code (Arc/Mutex mismatch, missing Manager import) — ALL FIXED.
- `cargo check --all-targets`: clean. `cargo clippy --all-targets -- -D warnings`: clean. `cargo test`: **69/69 pass** incl. the simulated two-machine end-to-end test. Issue #7 closed.
- **SECURITY-03 DONE**: agent channel now TLS with persistent self-signed per-device identity + HMAC-authenticated TOFU pinning; fingerprint displayed in This Computer; sim_test runs over TLS. docs/security.md updated. Issue #10 closed. (Found+fixed: the /agent/cert endpoint initially lacked the HMAC check — without it the pinning exchange was forgeable.)
- **APPROVAL-05/06 enforcement DONE (native half)**: grants.rs (token=request ID, exact approved permissions, TTL) checked by agent endpoints — view-only 403s on files/terminal, forged tokens denied; revocation cascades (session end, trust revoke, sign-out). Endpoint integration test included. 68→69 rust tests green.
- Remaining from #9: stream-readiness signal + toolbar-over-viewer + old-paired-client bypass on hardware.
- **Demo runbook**: docs/ui-redesign/DEMO.md (10-minute local investor demo, J1→J2).
- Source branch/commit: `main` @ `ff07bf2e171b9d3c247fe6c971c75c602f882abe` (matches spec snapshot; no pre-existing user changes, working tree was clean at start).

## Architecture decisions

1. **Design tokens as CSS custom properties** (`tokens.css`) with `[data-theme='dark']` overrides, mapped into Tailwind via arbitrary-value utilities (`bg-nd-bg`, etc. through `tailwind.config.js` extension). Rationale: one source of truth for both themes (SPEC §04 forbids scattered color values and parallel design systems per screen).
2. **New shell route state in `App.tsx`**: `login | my-computers | this-computer | file-transfer | settings` as the primary sidebar screens; existing `device`/`diagnostics` remain reachable as advanced/secondary surfaces (SPEC §03: preserve existing functionality).
3. **Account/directory/session/transfer domain types added to `lib/api.ts` as typed contracts** with honest `unavailable` results in the browser mock and explicit TODO wiring to native commands — no fake Google sign-in. Real OAuth + directory service is M2 (requires operator-provided Google OAuth client config; documented blocker).
4. Legacy local mode (existing access-code flow) is kept reachable as an advanced path per SPEC §08 Compatibility.
5. **M2: identity is verified by the directory service, not the desktop.** The desktop runs the OAuth code+PKCE loopback flow and forwards the Google ID token to the self-hostable directory service, which verifies it against Google's JWKS (issuer/audience/expiry/signature) and issues its own session+refresh tokens. Rationale: keeps account access tokens from becoming device-control credentials, centralizes isolation/rate-limiting server-side (SECURITY-01), and avoids an unverifiable JWT stack in the Tauri client.
6. **M2: directory service stack = zero-dependency Node.js** (`node:http` + `node:sqlite`, Node ≥22.5). Written decision: the repo already requires Node for the desktop build and website; a zero-dep service is trivially self-hostable and fully testable in CI without external services. No competing backend was added.
7. **M2: directory tokens in the OS keychain only when Stay signed in is on** (memory otherwise); only SHA-256 hashes server-side; refresh tokens rotate and reuse invalidates (AUTH-05/07).
8. **M2: mock backend has a generation guard** so in-flight simulated calls from a previous test can never mutate the next test's state — mirrors the epoch guard in the real `useAccount` state machine.

## Capability audit (M0, verified by reading code @ ff07bf2)

| Area | Reality | Gap |
|---|---|---|
| Google sign-in | Absent. `auth.rs` is agent HMAC request auth, not OAuth. | Full OAuth/OIDC PKCE flow + account service needed (M2). |
| Account directory | Absent. `list_computers` = LAN discovery + manual hosts keyed by IP. | Self-hostable directory service + stable device identity needed (M3). |
| Device identity | `Computer.id` is the host address — unstable. | Cryptographic device identity + 9-digit public ID needed. |
| Session readiness | `connect_computer` spawns external Moonlight; `stream-started` fires on process start, not stream readiness. | Native readiness signal needed (M5). |
| Session toolbar | None possible over external Moonlight window. | Native viewer integration spike required (M6); external viewer must be labeled interim. |
| File transfer | Native send/download/cancel exist; progress event has no transfer ID; single shared cancel flag. | Per-transfer IDs + correlation needed (M7). |
| Encrypted transport | Agent channel is HMAC-authenticated plaintext HTTP. | TLS/encrypted channel required for sensitive payloads (SECURITY-03). |
| Theme | Dark-only hardcoded (`bg-zinc-950`). | Light default + shared tokens + persisted theme (M1). |
| Trust/approval | Sunshine PIN pairing only; no per-session permission model. | Host-enforced grant/capability model (M4). |
| Internet routing | LAN + optional Tailscale. | Cross-network route documented honestly; no auto NAT traversal claim (M9). |

## Files changed so far

- `docs/ui-redesign/SPEC.txt` (new — durable spec copy)
- `docs/ui-redesign/IMPLEMENTATION_STATE.md` (this file)

M1 (app shell + tokens):
- `apps/desktop/src/styles/tokens.css` (new — Light/Dark design tokens, single source of truth)
- `apps/desktop/tailwind.config.js` (nd-* token colors, Archivo font, square corners)
- `apps/desktop/src/index.css` (token-based body, visible :focus-visible)
- `apps/desktop/src/lib/theme.ts` (new — resolve/apply theme)
- `apps/desktop/src/lib/api.ts` (Settings +theme/qualityPreset/unattendedAccess/localMode, auth contract stubs `getAuthState`/`signInWithGoogle` that honestly fail until M2, `isNativeShell` export)
- `apps/desktop/src/components/ui.tsx` (new — Button, Switch, accessible Dialog with focus trap/Escape/restore, Segmented, FieldRow, Notice)
- `apps/desktop/src/components/AppShell.tsx` (new — sidebar nav, account summary, visible "Preview — simulated data" badge)
- `apps/desktop/src/screens/Login.tsx` (new — Screen 01; honest sign-in error, local-mode entry)
- `apps/desktop/src/screens/MyComputers.tsx` (new — Screen 02; loading/empty/error states, search, Add dialog using the real local address+code contract)
- `apps/desktop/src/screens/ThisComputer.tsx` (new — Screen 04; real host status, access code, bootstrap hosting, shared unattended policy switch)
- `apps/desktop/src/screens/FileTransfer.tsx` (new — Screen 07; real native send/receive/progress/cancel; single-transfer limitation stated)
- `apps/desktop/src/screens/Settings.tsx` (rewritten — Screen 08; theme/quality preset/startup/unattended/clipboard persist via real save_settings)
- `apps/desktop/src/App.tsx` (rewritten — login → onboarding → shell routing, theme application, additive settings migration)
- `apps/desktop/src/App.test.tsx` (new — 10 tests)

Kept but not yet re-integrated into the new shell (recorded gap, not deleted):
- `src/screens/Dashboard.tsx` + `src/components/ComputerCard.tsx` (+ test): legacy dashboard with the PIN pairing flow. Pairing UI must be re-integrated in M4; the flows still compile and their tests pass.
- `src/screens/DeviceDetail.tsx`, `src/screens/Diagnostics.tsx`, `src/screens/Onboarding.tsx`: still on the old dark zinc styling. Reachable (device detail via Connect, diagnostics via Settings) but NOT yet tokenized — SETTINGS-02 covers the primary screens only so far.

M2 (real account sign-in slice):
- `apps/desktop/src-tauri/src/google_auth.rs` (new — PKCE OAuth via system browser + loopback, directory session, keychain persistence, commands `auth_get_state/auth_sign_in/auth_sign_out/auth_set_stay_signed_in/dir_list_computers`)
- `apps/desktop/src-tauri/src/state.rs` (Settings +theme/quality_preset/unattended_access/local_mode/stay_signed_in with safe defaults — additive migration)
- `apps/desktop/src-tauri/src/main.rs` (module + managed AccountState + 5 new commands registered)
- `apps/desktop/src-tauri/account.example.json` (new — sample config, no credentials)
- `apps/desktop/src/lib/api.ts` (real account contract + simulated preview with generation guard, `listDirectoryComputers`, Settings +staySignedIn, `__resetMockBackend` test hook)
- `apps/desktop/src/lib/useAccount.ts` (new — auth state machine with epoch guard)
- `apps/desktop/src/App.tsx` (login/local-mode/shell routing on real account state)
- `apps/desktop/src/screens/Login.tsx`, `Settings.tsx`, `MyComputers.tsx` (wired to the account contract; Settings has real profile/sign-out/switch/stay-signed-in)
- `services/directory/` (new self-hostable service: `src/server.js`, `src/db.js`, `src/google.js`, `test/service.test.js`, `package.json`)
- `docs/ui-redesign/GOOGLE_SETUP.md` (new — exact Google Cloud + service + desktop configuration)
- `apps/desktop/src/App.test.tsx` (extended — 25 tests total in the file)

## Scenario status (M2 additions)

- AUTH-01 PASS (component) — Login is first launch with Google action, Stay signed in, local mode; no fixture profile.
- AUTH-02 BLOCKED (live) — real Google round-trip requires operator OAuth client + running directory service (GOOGLE_SETUP.md). State-machine + service sides are tested; no hardware/browser OAuth performed.
- AUTH-03 PASS (component) — cancel stays signed out, no error.
- AUTH-04 PASS (component) — single attempt guard; late callback from a superseded attempt rejected (epoch).
- AUTH-05 PASS (component, preview) — stay-off leaves no durable session across relaunch; stay-on restores. Native keychain semantics need cargo run to confirm (BLOCKED).
- AUTH-06 PASS (service) — wrong audience/issuer/expired/alg=none/tampered tokens all rejected with a detail-free `invalid_identity`.
- AUTH-07 partial PASS — refresh rotation + old-pair rejection tested on the service; desktop restore-retry path written, unverified (cargo BLOCKED).
- AUTH-08/09 partial PASS (component) — sign-out returns to Login and clears account context; late events discarded via epoch. Active-work interruption confirm lands with M5 (no account-authorized sessions exist yet).
- AUTH-10 NOT STARTED (host-side disable on sign-out is M4).
- LIST-02 PASS (component + service) — signed-in account gets a real empty, actionable directory.
- LIST-03 PASS (component) — loading vs error-with-Retry vs stale.
- SECURITY-01 PASS (service) — account A cannot read B's list/profile; unknown/bearer-less tokens 401.
- SECURITY-04 PASS (component) — settings persisted through the UI contain no token/secret fields; service errors carry no token material.
- COMPAT-01 partial — existing onboarded installs land in local mode (no forced login); legacy host codes migration untouched and covered by existing Rust tests (cargo BLOCKED here).

M3 (device enrollment + synchronized computer management):
- `services/directory/src/db.js` (migration v2: devices table, TEXT public IDs)
- `services/directory/src/server.js` (enroll/heartbeat/resolve/add/rename/remove routes, tombstones, presence staleness 30 s, resolve rate limit 10/min, ownership conflict 409)
- `services/directory/test/devices.test.js` (new — 11 tests)
- `apps/desktop/src/lib/api.ts` (DeviceIdentity/ResolvedDevice/SavedComputer contract + commands, `formatPublicId`, preview mock directory with enrollment, generation-guarded)
- `apps/desktop/src/screens/ThisComputer.tsx` (enrollment + grouped Device ID + Copy ID)
- `apps/desktop/src/screens/MyComputers.tsx` (signed-in mode: Add-by-ID with resolve, row menu Rename/Remove dialogs with scope copy, This-computer label, honest M5 Connect note)
- `apps/desktop/src/App.tsx` (heartbeat every 15 s while signed in; signedIn passed to This Computer)
- `apps/desktop/src-tauri/src/google_auth.rs` (device.json stable identity; commands device_get_identity/device_enroll/device_heartbeat/dir_resolve_device_id/dir_add_computer/dir_rename_computer/dir_remove_computer; authed_call with PATCH/DELETE + x-device-id header)
- `apps/desktop/src-tauri/src/main.rs` (7 new commands registered)
- `apps/desktop/src/M3.test.tsx` (new — 7 tests)

## Scenario status (M3 additions)

- HOST-01 PASS (service + component) — stable ID allocation, idempotent re-enroll, grouped display, copy-after-success.
- HOST-02 PASS (service + component) — explicit enrollment only; failure shows retryable error without a fake ID; ownership conflict rejected (409).
- LIST-01 PASS (service + component) — enrolled owner device appears for a same-account controller without typing IDs; no trust implied.
- LIST-04 PASS (component + service) — search matches name and ID digits with/without spaces; normalization preserves leading zeroes.
- LIST-10 partial — stable device identity survives address change by construction (identity ≠ address); route re-resolution is M5/M9.
- LIST-11 PASS (service + component) — caller device labeled This computer, no self-Connect.
- DEVICE-01/02/03/04 PASS (component + service) — dialog explains the ID, validates/normalizes, resolves via the service, distinct unknown/duplicate errors, no duplicate rows.
- DEVICE-05 NOT STARTED (cancel-during-add race) — planned with M4/M5 request lifecycle work.
- DEVICE-06/07 PASS (service + component) — per-account alias rename; failure keeps old name with correctable error.
- DEVICE-08/10 PASS (service + component) — tombstone removal with scope copy; re-enrollment sync does not recreate; explicit re-add clears tombstone.
- DEVICE-09 NOT STARTED (active-work confirm) — no account-authorized sessions exist yet (M5).
- COMPAT-01 partial — settings migration additive (Rust defaults added); legacy host trust intentionally untouched.

M4 (host trust, approval, permissions):
- `services/directory/src/db.js` (migration v3: `unattended` policy column, `trusted_controllers`, `connection_requests`)
- `services/directory/src/server.js` (request lifecycle with atomic state-guarded decisions, 30 s host-issued deadline, busy rule, lazy expiry, accept-bound-to-request, same-account-only trust, unattended auto-accept, trusted list + revoke; injectable `nowFn` clock)
- `services/directory/test/approval.test.js` (new — 11 tests)
- `apps/desktop/src/lib/api.ts` (ConnectionRequest/SessionPermissions/TrustedController contract + 11 commands; preview simulation: one clearly-labeled simulated helper request ~6 s after host polling starts)
- `apps/desktop/src/screens/IncomingConnection.tsx` (new — Screen 05: verified requester identity, New device, permission switches with audio off by default, live countdown, Accept/Reject, owner-only trust option, honest race error)
- `apps/desktop/src/screens/Settings.tsx` (real trusted-computers list + revoke with confirmation and failure honesty; unattended switch syncs the service policy and reverts on failure)
- `apps/desktop/src/screens/ThisComputer.tsx` (unattended switch syncs the service policy, reverts on failure)
- `apps/desktop/src/App.tsx` (host-side pending-request polling every 5 s while signed in; IncomingConnection overlay)
- `apps/desktop/src-tauri/src/google_auth.rs` (11 thin native commands over the service contract) + `main.rs` registration
- `apps/desktop/src/M4.test.tsx` (new — 9 tests)

M5 (one-click session lifecycle):
- `apps/desktop/src/lib/useConnection.ts` (new — connection state machine: authorizing/awaitingApproval/connecting/connected/failed/cancelled/disconnecting; synchronous in-flight guard; attempt-ID late-event rejection; centralized injectable timers)
- `apps/desktop/src/lib/sessionConstants.ts` (new — 30 s timeout, 1/2/4 s reconnect schedule, poll interval)
- `apps/desktop/src/screens/RemoteSession.tsx` (new — interim external-viewer session screen labeled honestly + ConnectionOverlay with Cancel/Retry/Back)
- `apps/desktop/src/screens/MyComputers.tsx` (directory Connect wired to the real flow; endpoint route hints carried)
- `apps/desktop/src/App.tsx` (connection overlays, SESSION-06 explicit replacement dialog, AUTH-09 sign-out-with-active-session confirm)
- `apps/desktop/src-tauri/src/moonlight.rs` (start_stream kills+reaps a previous child instead of leaking it — SESSION-06; watch_stream emits `stream-exited` — SESSION-11) + `main.rs` (watcher started; stream-started documented as process-start, not readiness)
- `services/directory` (migration v4: self-reported `endpoints` route hints on devices; heartbeat stores them; computer list returns them to account members only)
- `docs/ui-redesign/NATIVE_SPIKE.md` (new — spike findings, toolbar decision (a) interim borderless viewer + overlay bar, (b) embedded viewer for the final design; permission-enforcement adapter plan; verification commands)
- `apps/desktop/src/M5.test.tsx` (new — 8 tests)

M6 (session toolbar + control adapters):
- `apps/desktop/src/screens/RemoteSession.tsx` (session toolbar: Monitors/Quality/Files/Clipboard/Audio panels + live-stats slot + Disconnect; ConnectionOverlay kept)
- `apps/desktop/src/lib/useConnection.ts` (connected state carries host-granted permissions + applied quality; `changeQuality` = controlled restart keeping the grant open; indicator changes only after success)
- `apps/desktop/src/lib/api.ts` (session_list_displays / session_stats / session clipboard / connectWithQuality contract + preview mock)
- `apps/desktop/src/screens/FileTransfer.tsx` (signed-in directory source + session-target preselect)
- `apps/desktop/src/App.tsx` (wiring: quality change, Files from session)
- `apps/desktop/src-tauri/src/main.rs` (quality override on connect_computer; session_list_displays/stats/clipboard commands; clipboard send/receive truthfully unimplemented until the embedded viewer)
- `apps/desktop/src-tauri/src/state.rs` (session_clipboard flag)
- `apps/desktop/src/M6.test.tsx` (new — 10 tests)

M7 (file transfer):
- `apps/desktop/src-tauri/src/files_queue.rs` (new — Transfer/TransferQueue with per-item cancel, identity, collision resolution, terminal-state guard)
- `apps/desktop/src-tauri/src/files.rs` (send_transfer/download_transfer: per-transfer cancel, identity-checked resume, verifying step, accurate interrupted state)
- `apps/desktop/src-tauri/src/main.rs` (send_files/download_file return IDs, cancel_transfer(id), retry_transfer, list_transfers; folder rejection; TransferContext so spawned tasks never borrow AppState)
- `apps/desktop/src-tauri/src/state.rs` (Arc<TransferQueue>)
- `apps/desktop/src/lib/api.ts` (TransferItem/queue contract; mock per-file serial progress with IDs/cancel/retry)
- `apps/desktop/src/lib/useTransfers.ts` (new — queue model, optimistic queued rows, cancel-late-event guard)
- `apps/desktop/src/screens/FileTransfer.tsx` (queue UI: per-row state/progress/cancel/retry, collision policy selector, Clear finished)
- `apps/desktop/src/screens/DeviceDetail.tsx` (updated to the new event shape)
- `apps/desktop/src/M7.test.tsx` (new — 7 tests)

M8 (settings/migration finish):
- `apps/desktop/src/App.tsx` (connectTo seeds new sessions with the persisted quality default)
- `apps/desktop/src/M8.test.tsx` (new — 4 tests)

## Scenario status (M8 additions)

- SETTINGS-01 PASS — Login and Settings Stay-signed-in read/write one persisted preference (test asserts the Login toggle reflects a Settings change after sign-out).
- SETTINGS-03 PASS — a saved default seeds the next session (connectWithQuality 'speed' asserted end-to-end); session overrides never write the default.
- SETTINGS-04 PASS (contract) — toggle persists via the real save path; native registration is wired in save_settings → set_autostart (line 570 main.rs); live registration check on Windows is manual/BLOCKED.
- COMPAT-01 PASS (migration) — a legacy settings file gains safe defaults (light theme) while explicit codec/bitrate/fps choices survive.
- Advanced tools: DeviceDetail (desktop/files/terminal/system) and Diagnostics remain reachable; terminal/power stay local-mode + access-code gated — no account view-only helper path exists to expose them to (recorded).

## Scenario status (M7 additions)

- FILE-01 PASS (contract) — send returns one ID per file; native drag-drop supplies real paths; browser preview declines Send honestly.
- FILE-02 partial — remote browse confined to safepath roots (existing); "Open folder" for completed downloads not yet wired.
- FILE-03 PASS — progress = acknowledged/total bytes from real events; zero-byte safe; Done requires verified completion (upload re-stats the remote size).
- FILE-04 PASS — same-name files are distinct rows by transfer ID; zero-byte completes cleanly.
- FILE-05 PASS — per-item cancel; other items proceed; late events can't reopen cancelled rows (test caught and fixed the missing optimistic-row race).
- FILE-06 PASS (native written, cargo BLOCKED) — resume only for the same transfer record with unchanged identity (path+size+mtime+head hash); mismatch fails safely.
- FILE-07 PASS (policy plumbed) — keep-both/overwrite selector; native resolve_collision picks `name (n).ext` or replaces whole-file; never blind-append.
- FILE-08 PASS (honest) — folders rejected pre-enqueue with guidance in UI and natively; folder support not claimed.
- FILE-09 partial — interrupted state + Retry exist; revocation mid-transfer enforcement awaits the grant wiring (M5 spike).
- FILE-10/11 PASS (contract) — target/account bound at enqueue; per-operation failures don't bleed across rows.
- SECURITY-03 NOT STARTED (encryption upgrade) — decision pending: wrap the agent channel in TLS (self-signed per device identity pinned at pairing) vs WireGuard-style transport. Recorded as required before "finished".

## Scenario status (M6 additions)

- TOOLBAR-01 partial — in-app toolbar controls the session and offers Disconnect; reachability *over the fullscreen viewer* needs the borderless/embedded viewer work (NATIVE_SPIKE decision a→b). Recorded, not claimed.
- TOOLBAR-02 PASS (contract) — displays come from a real command; a one-display host shows exactly one entry; switching displays is honestly marked as needing the integrated viewer.
- TOOLBAR-03 PASS (contract) — quality applies a documented native policy via controlled restart; failure keeps the old indicator; no label-only switch exists.
- TOOLBAR-04 PASS — stats are measured-or-placeholder; the mockup's 24 ms/30 fps never appear as production constants.
- TOOLBAR-05 PASS (contract) — toggle gates NodeDesk's clipboard channel both directions; re-enable never pushes stale content; viewer clipboard behavior documented.
- TOOLBAR-06 PASS (contract) — manual Send/Get gated by the toggle AND the host grant; host denial shows an explanation.
- TOOLBAR-07 PASS (honest state) — interim viewer handles audio itself; in-app volume/mute explicitly marked as arriving with the integrated viewer; denial explains.
- TOOLBAR-08 PASS — Files opens File Transfer with the session target preselected; changing targets there does not retarget queued transfers (queue binds target at enqueue time).

## Scenario status (M5 additions)

- SESSION-01 PASS (contract level) — one click → single authorized attempt → viewer launch. Real-hardware readiness evidence BLOCKED.
- SESSION-02 partial — `stream-started` is explicitly labeled process-start, not readiness, in code and UI ("Viewer running" interim, not "Connected" claims of stream health). Verified readiness signal needs the hardware spike (NATIVE_SPIKE.md).
- SESSION-03 PASS — synchronous in-flight guard; test found and fixed a real stale-state race (three fast clicks spawned three attempts before the fix).
- SESSION-04/05 PASS (contract) — timeout/native failure → failed with Retry/Back; cancel kills the pending approval and ignores late acceptance.
- SESSION-06 PASS — no child-handle overwrite (native fix) + explicit replacement dialog.
- SESSION-07/08 NOT STARTED — reconnect-on-drop needs a real network-loss signal; the bounded 1/2/4 s schedule is centralized and ready.
- SESSION-09/11 PASS (contract) — disconnect ends viewer + grant once; viewer exit reconciles state.
- COMPAT-02 / NETWORK-01 BLOCKED — need real Windows machines.

## Scenario status (M4 additions)

- APPROVAL-01/02/03/04/07/08/09/10 PASS (service + component) — verified requester identity, host-issued 30 s deadline with injected clock, atomic accept/expiry single-winner, binding to request+device+account, cancel invalidation, Busy on second request, no helper trust.
- APPROVAL-05/06 partial — the granted permission set is recorded and returned exactly; **native enforcement on the streaming/agent paths is the recorded M4/M5 spike (BLOCKED here, no Rust toolchain + needs real hosts)**. See "Known gap" below.
- HOST-06/07 PASS (service + component) — one shared unattended policy on both screens, service-enforced; new same-account device requires initial authorization before auto-accept.
- TRUST-01/02/03 PASS (service + component) — real trusted list by device identity, per-controller revoke ending active grants, failure is not false success.
- SECURITY-02 PASS (service) — privileged paths reject unauthenticated (401) and non-owner (403) callers; knowing a public ID yields metadata only.
- SECURITY-05 partial — existing local safeguards untouched; account-path permission enforcement on native endpoints remains (M5 spike).

## Known gap (recorded, not hidden)

- Accepted permissions are authoritative on the service, and the desktop contract carries them — but the native host agent does not yet enforce them on the Sunshine/Moonlight/agent paths. Connecting this grant model to `agent.rs`/`moonlight.rs` (and ending old paired-client bypass) is required before any session can be called secure. Tracked as the M5 native spike.
- Directory rows' Connect action shows an explanatory notice instead of a session: there is no verified route from a directory entry until M5. No fake session or fake Connected state exists.

## Scenario status (M1 scope)

- AUTH-01 IN PROGRESS — Login is the first-launch screen with Google action + Stay signed in + local mode; real Google flow is M2.
- AUTH-04 partial — duplicate sign-in clicks guarded (single attempt); provider errors show retryable alert. Test: "reports sign-in honestly instead of simulating an account".
- LIST-03 PASS (component level) — loading placeholders vs Retry error vs stale list. Test: "shows an understandable error with Retry when loading fails".
- LIST-04/05 partial PASS — search by name; no-match state with clear. Test: "search filters by name…". ID-formatted search pending real Device IDs (M3).
- LIST-07 partial PASS — offline rows explain instead of Connect. Test: "offline computers explain instead of offering Connect".
- SETTINGS-02 PASS (primary screens) — Dark applies to shell/screens immediately, persists via save_settings, restores on launch. Tests: "switches every app-owned surface…", "restores a saved dark theme on launch". Gap: DeviceDetail/Diagnostics/Onboarding not tokenized yet.
- SETTINGS-03 partial — quality presets map onto real codec/bitrate/fps and persist; per-session override is M6.
- SETTINGS-04 partial — startOnBoot switch persists via real command; native registration verified only by existing backend (no new check).
- HOST-05 partial — unattended switch disabled with "Turn on remote access first" when hosting is off.
- ACCESS-01 partial — focus-visible outlines, aria-current nav, switch radiogroup/switch roles, Dialog focus trap/Escape/restore, status announcements via role=status/alert. Full screen-reader pass not done.
- ACCESS-02 partial — layout uses flex/max-width, min 720x560 respected by shell; high-DPI not verified.
- All other scenarios: NOT STARTED.

## Baseline checks (M0)

- `npm ci` / `npm test` / `npm run build` / `cargo check` results: see "Checks run" below — recorded before first code change.

## Known blockers

1. **Google OAuth client configuration** — the flow is implemented (desktop PKCE + verifying directory service); going live needs an operator-created Desktop-app client ID and `account.json` per GOOGLE_SETUP.md. Action: operator follows that doc; no code change needed.
2. **Rust toolchain** — `cargo check/clippy/test` cannot run here. All M2 Rust changes are unverified by a compiler; run them on a Rust-capable machine before merging.
3. **Real two-machine Windows verification** — not possible from this environment; all native session behavior stays BLOCKED for live verification until run on two real Windows machines.
4. **Moonlight toolbar integration** — needs a native spike (M6); external viewer is an explicitly interim path only.

## Native features still requiring real-machine verification

Everything in SPEC §11 tiers 4–5: real video/input, toolbar reachability, monitor switch, clipboard/audio, host Stop, startup integration, cross-network route.

## Restart instruction

Read this file first, then SPEC §13 for the current milestone. Continue with the "Next single task" above. Do not redo completed slices; do not treat a scenario as PASS without recorded evidence.

## Checks run (log)

Baseline (before any code change, 2026-10-04):
- `npm ci` — OK (Node v24.16.0)
- `npm test` — 18/18 passed (2 files)
- `npm run build` — OK
- `cargo check/clippy/test` — **BLOCKED: no Rust toolchain in this environment** (`cargo`/`rustc` not installed). Run on a machine with Rust before merging native changes. No Rust files were modified in M1.

M1 (after the shell work):
- `npx tsc -b` — clean
- `npm test` — 28/28 passed (3 files; 10 new App tests)
- `npm run build` — OK
- Live browser check (vite dev, mock backend): Login renders; local mode enters shell; sidebar navigation works; preview badge visible; Dark theme applies live (`data-theme="dark"`, body #201e1d). Screenshot capture via the automation browser timed out (panel not visible); verification done via DOM snapshot/read instead.
- Dev server was stopped after verification; nothing left running.

M2 (account slice, 2026-10-04):
- `npx tsc -b` — clean
- `npm test` (apps/desktop) — 35/35 passed (3 files; App.test.tsx now 25 tests)
- `npm run build` — OK
- `npm test` (services/directory, Node 24.16) — 8/8 passed: account isolation, empty directory, invalid-identity matrix (aud/iss/exp/alg=none), tampered signature, refresh rotation + reuse rejection, logout revocation, unauthenticated denial, rate limiting. Real RSA keypair + local JWKS server; verification itself is not mocked.
- `cargo check/clippy/test` — **BLOCKED: no Rust toolchain in this environment.** `google_auth.rs`, `state.rs`, `main.rs` changed and MUST be compiled on a Rust-capable machine before merge. Rust was written against the existing dependency set (no new crates).
- Live Google OAuth round-trip — **BLOCKED: requires operator client ID + hosted directory** (see GOOGLE_SETUP.md); not simulated in production code.

M3 (device/directory slice, 2026-10-05):
- `npm test` (services/directory) — 19/19 passed (8 auth + 11 device scenarios, real RSA/JWKS)
- `npx tsc -b` — clean
- `npm test` (apps/desktop) — 42/42 passed (4 files)
- `npm run build` — OK
- `cargo check/clippy/test` — **BLOCKED: no Rust toolchain.** All Rust changes (google_auth.rs, state.rs, main.rs) remain compiler-unverified; run on a Rust-capable machine before merge.

M4 (trust/approval slice, 2026-10-05):
- `npm test` (services/directory) — 30/30 passed (11 new approval/trust tests, injected clock, no real-time sleeps)
- `npm test` (apps/desktop) — 51/51 passed (5 files; 9 new M4 tests)
- `npm run build` — OK
- `cargo check/clippy/test` — BLOCKED (same environment limitation)

M5 (session lifecycle slice, 2026-10-05):
- `npm test` (apps/desktop) — 59/59 passed (6 files; 8 new M5 tests)
- `npm test` (services/directory) — 30/30 passed
- `npx tsc -b` — clean; `npm run build` — OK
- `cargo check/clippy/test` — BLOCKED (moonlight.rs/main.rs changed this slice; verify on a Rust machine before merge)

M9 (routing honesty + completion, 2026-10-06):
- `npm test` (apps/desktop) — 82/82 passed (10 files; 2 new M9 tests)
- `npm test` (services/directory) — 30/30 passed
- `npm run build` — OK
- `docs/ui-redesign/COMPLETION_REPORT.md` written (verified vs simulated vs outstanding)
- NETWORK-02: Tailscale remains the documented supported cross-network route (docs/networking.md); no anywhere-access is claimed.
- NETWORK-03 PASS — granted-but-unroutable targets fail with named remedies, no viewer launch, no fake Connected.
- FREE-01 PASS — source scan: no pricing/subscription/trial gating in app UI.

M8 (settings/migration slice, 2026-10-06):
- `npm test` (apps/desktop) — 80/80 passed (9 files; 4 new M8 tests)
- `npm test` (services/directory) — 30/30 passed
- `npx tsc -b` — clean; `npm run build` — OK
- `cargo check/clippy/test` — BLOCKED (no new Rust changes this slice; prior changes still pending verification)

M7 (file-transfer slice, 2026-10-05):
- `npm test` (apps/desktop) — 76/76 passed (8 files; 7 new M7 tests)
- `npm test` (services/directory) — 30/30 passed
- `npx tsc -b` — clean; `npm run build` — OK
- `cargo check/clippy/test` — BLOCKED (files.rs/files_queue.rs/main.rs/state.rs changed; verify before merge)

M6 (toolbar slice, 2026-10-05):
- `npm test` (apps/desktop) — 69/69 passed (7 files; 10 new M6 tests)
- `npm test` (services/directory) — 30/30 passed
- `npx tsc -b` — clean; `npm run build` — OK
- `cargo check/clippy/test` — BLOCKED (main.rs/state.rs changed; verify before merge)
