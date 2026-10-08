# Investor demo runbook (local, ~10 minutes)

Goal: two Windows machines running NodeDesk with real Google sign-in, synced
computers, approval flow, and one-click connect. Everything below is local;
nothing needs public hosting for the demo.

## 0. Prerequisites (once)

- Node.js ≥ 22.5 and Rust stable on the build machine.
- A Google Cloud OAuth client (Desktop app type) — see
  `docs/ui-redesign/GOOGLE_SETUP.md` §1 (5 minutes, no secret needed).

## 1. Start the directory service (build machine or any LAN box)

```powershell
cd services\directory
$env:GOOGLE_CLIENT_ID = "YOUR_CLIENT_ID.apps.googleusercontent.com"
$env:PORT = "8787"
$env:DB_PATH = "demo-directory.db"
node src\server.js
```

For demo-over-LAN put it behind the machine's LAN IP; for same-machine dev,
`http://127.0.0.1:8787` works. Production demos should put it behind TLS.

## 2. Configure each demo machine's desktop app

Create `account.json` in the app config directory (`%APPDATA%\dev.nodedesk.app\`):

```json
{
  "clientId": "YOUR_CLIENT_ID.apps.googleusercontent.com",
  "directoryUrl": "http://YOUR-LAN-IP:8787"
}
```

(`apps/desktop/src-tauri/account.example.json` is a template.)

## 3. Build and run

```powershell
cd apps\desktop
npm ci
npm run tauri dev     # or: npm run tauri build for an installer
```

## 4. The demo flow (J1 → J2)

1. Machine H: sign in with Google → This Computer → **Enroll this computer**
   → **Enable remote access** → turn **Unattended access** on.
2. Machine C: sign in with the *same* account → **Office PC appears
   automatically** (that's the sync moment).
3. Click **Connect** — first time, H gets the Incoming Connection prompt;
   accept with permissions and tick **Trust this device**.
4. Disconnect, click **Connect** again — instant, no prompt (the one-click
   moment).
5. Show: file transfer queue, session toolbar, Settings theme switch,
   and the security fingerprint comparison.

## 5. Demo talking points (all verifiable in the repo)

- Free and self-hostable: the account service is ~1000 lines of zero-dependency
  Node; no paid infrastructure.
- Security: TLS agent channel with pinned per-device certificates
  (`docs/security.md`), host-enforced session permissions, approval deadlines,
  trusted-device revocation — 69 Rust tests + 82 UI tests + 30 service tests
  in CI style, including a simulated two-machine end-to-end test over TLS.

## Known limits (say them out loud)

- Cross-internet access needs Tailscale today (LAN/tailnet routes are real;
  NAT traversal is on the roadmap — issue #6).
- The integrated in-app viewer (toolbar over the stream) is the next
  milestone; today the proven Moonlight viewer opens the stream.
