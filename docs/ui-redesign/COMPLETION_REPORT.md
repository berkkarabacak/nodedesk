# UI Redesign — Completion Report (M0–M9)

Date: 2026-10-06. Basis: SPEC.txt §15. This report separates **verified**
behavior from **simulated preview** and **outstanding** work. Nothing below
claims hardware success that was not observed.

## 1. Real functionality verified by automated tests

- **Directory service** (30/30 tests, real RSA/JWKS crypto, injected clock):
  Google ID-token verification, account isolation, session/refresh rotation,
  revocation, enrollment + stable 9-digit public IDs, tombstones, presence,
  request lifecycle (deadline, busy, atomic accept/expiry, binding), trust
  list/revoke, unattended auto-accept, rate limiting.
- **Desktop UI** (82/82 tests, Vitest + Testing Library): login entry,
  cancel/duplicate/late-callback auth handling, stay-signed-in semantics,
  sign-out isolation, empty/loading/error directory states, search, add /
  rename / remove with real lookup, enrollment UI, incoming-connection dialog
  with permissions + countdown, trust management, connection state machine
  (single attempt, cancel, distinct failure causes, disconnect, viewer-exit
  reconciliation, explicit session replacement), session toolbar (real
  displays only, honest stats placeholders, controlled quality restart,
  clipboard gating), transfer queue (per-ID rows, per-item cancel, retry
  gating, folder rejection, conflict policy), settings single-source-of-truth,
  legacy migration defaults, FREE-01 no paid gating.
- **Native Rust changes written** (not compiler-verified here): OAuth PKCE
  flow, directory client commands, device identity file, transfer queue
  engine, stream child leak fix + exit watcher, quality override, session
  clipboard gate, startup registration wiring.

## 2. Simulated preview coverage

The browser preview (`npm run dev`) exercises every screen and flow against a
deterministic mock backend that preserves the real command contracts. It is
visibly labeled "Preview — simulated data/session". A packaged build never
falls back to mocks.

## 3. Outstanding required behavior / verification (BLOCKED)

| Item | Missing dependency | Next action |
|---|---|---|
| Live Google sign-in round-trip (AUTH-02) | Operator OAuth client ID + hosted directory | Follow docs/ui-redesign/GOOGLE_SETUP.md |
| `cargo check/clippy/test` for ALL Rust changes (google_auth.rs, files_queue.rs, files.rs, moonlight.rs, main.rs, state.rs) | No Rust toolchain in the authoring environment | Run on a Rust-capable machine; fix any compile errors before merge |
| Real two-machine J1/J2 on Windows Home (SESSION, COMPAT-02, NETWORK-01) | Hardware | Run the acceptance matrix in SPEC §11 |
| Stream-readiness signal, toolbar-over-viewer, live monitor/quality/audio control (SESSION-02 full, TOOLBAR-01/02 native) | Native spike on hardware | NATIVE_SPIKE.md decision (a) interim borderless + overlay, (b) embedded viewer |
| Native permission enforcement on agent/Sunshine paths (APPROVAL-05/06 enforcement half) | grants.rs wiring per NATIVE_SPIKE.md | Implement + verify; old paired-client bypass must be closed |
| Cross-network "anywhere" route (NETWORK-02) | NAT traversal/relay is not implemented; Tailscale is the supported route today | Document requirement (done in docs/networking.md); do not claim anywhere-access |
| Encrypted agent channel (SECURITY-03) | TLS upgrade for the HMAC channel | Pick pinned-self-signed TLS; until then file/clipboard/terminal traffic is authenticated but not encrypted |
| Folder transfer (FILE-08 full) | Recursive engine | Currently rejected truthfully |

## 4. Setup / run / build

```bash
# Desktop (Windows-first)
cd apps/desktop
npm ci
npm test                 # 82 tests
npm run dev              # browser preview (simulated, labeled)
npm run tauri dev        # real desktop shell (requires Rust)
npm run tauri build      # packaging

# Directory service (self-hosted; Node >= 22.5, zero dependencies)
cd services/directory
GOOGLE_CLIENT_ID="….apps.googleusercontent.com" PORT=8787 DB_PATH=directory.db node src/server.js
npm test                 # 30 tests
```

Desktop account configuration: `account.json` in the app config dir — see
docs/ui-redesign/GOOGLE_SETUP.md. No credentials ship in the repo.

## Traceability

Journey/scenario → implementation → evidence mapping lives in
IMPLEMENTATION_STATE.md (per-scenario PASS/partial/BLOCKED with test names).
