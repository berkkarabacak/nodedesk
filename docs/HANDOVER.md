# NodeDesk handover

Paused on **2026-09-29** by Berk. He will stop active work. Do not keep building.

This note sits on `main` (`ff07bf2e171b9d3c247fe6c971c75c602f882abe`). The useful unreleased work is on two open draft pull requests. Those branches are described below. They are not merged.

## What this is

NodeDesk is an open-source remote-computing app built on [Sunshine](https://github.com/LizardByte/Sunshine) and [Moonlight](https://github.com/moonlight-stream). License: GPL-3.0 (`LICENSE`). Public site: https://berkkarabacak.github.io/nodedesk/.

The application is the Tauri app in `apps/desktop/`. Top-level `agent/`, `networking/`, `discovery/`, `file-transfer/`, `monitoring/`, and `streaming/` are design notes, not the app. Working code is under `apps/desktop/src-tauri/src/`.

Released **v1.3.0** is the minimum safe baseline. That release includes merged security pull request [#1](https://github.com/berkkarabacak/nodedesk/pull/1) (`security: authenticate the agent channel, confine file access, fix revocation`, merge commit `37c932127af36ac05c0e0047678b1aedbf445730`). Tag `v1.3.0` is `f9ea8e2d953b4fe90855017731bcb7037c4fa44f`. `main` is that release plus one later CI commit (`ff07bf2`, cargo audit fails on vulnerabilities). Older releases (`v1.0.0`, `v1.1.0`, `v1.2.0`) are still downloadable. Use v1.3.0 or newer as the floor.

## What is merged vs draft

| State | Where | What a release install actually has |
|---|---|---|
| Merged | `main`, release [v1.3.0](https://github.com/berkkarabacak/nodedesk/releases/tag/v1.3.0) | Security baseline from PR #1, then the v1.3.0 release, then the cargo-audit CI commit on `main`. |
| Draft, unmerged | [PR #2](https://github.com/berkkarabacak/nodedesk/pull/2) | Windows pairing and installer fixes. **Not in release installs.** |
| Draft, unmerged | [PR #3](https://github.com/berkkarabacak/nodedesk/pull/3) | Incomplete account-fleet scaffolding. **Not in release installs.** |

Do not squash or merge PR #2 or PR #3 as part of closing this pause.

### PR #2 — Windows popup reliability

- URL: https://github.com/berkkarabacak/nodedesk/pull/2
- Branch: `cursor/windows-popup-reliability-a86d`
- Head: `02881d9256d136a1e8a59fd71ec95559341cc3f2` (`fix: complete Sunshine pairing with the current pin API`)
- CI on that commit was green (desktop front-end, desktop core on Windows/Ubuntu/macOS, website, dependency security audit).
- Still a draft. Release installs do not have these fixes.

What that branch changes:

- Hidden console tools on Windows, so background probes do not flash console windows.
- Per-user NSIS install.
- The Sunshine Windows installer is an MSI, launched with `msiexec`.
- In-app Approve posts `pairing_id`, the 4-digit PIN, and the client name to Sunshine `POST /api/pin`, and treats boolean `status: true` as success.

### PR #3 — account fleet scaffolding

- URL: https://github.com/berkkarabacak/nodedesk/pull/3
- Branch: `cursor/account-fleet-sync-a7ab`
- Head: `8c6999eb685a1242705f5a97ef83bf95b31d0670`
- Still a draft. Incomplete.

What is there: a Google sign-in placeholder (no live client id), a device-registry mock, and a dashboard. A click-through of the mock UI was verified. Berk wants the registry hosted on a server, not LAN-only. That server is not installed. See the hosting plan under known gaps.

## What was proven on hardware

Proven on Berk's PCs on **2026-09-29 ~23:04 Europe/Istanbul**.

| Role | Machine |
|---|---|
| Host | `DESKTOP-RFU96MA` (user `XPS13`) |
| Controller | Odin |
| Earlier host, offline for the `02881d9` retest | HD2 (`DESKTOP-HD2F11E`) |

Install on the host (Sunshine was not uninstalled):

- Silent `/S /CURRENTUSER` into `%LOCALAPPDATA%\NodeDesk`.
- Installer SHA256: `8D0AF4928480E5C6EA1F9E9C8A6715C5F3BB2E339A3BD866454FFBF381A9E514`
- `nodedesk.exe` SHA256: `DDC738A9BF62A529516148172617131A2663BA2C5C34FA4980D02789411A69C7`

In-app Approve on RFU reported **PIN approved** for PIN **5657**. The Moonlight window title was `DESKTOP-RFU96MA - Moonlight`. Sunshine logged **CLIENT CONNECTED**. At that moment the host IP was `192.168.1.9` and Odin was `192.168.1.2`.

The first Approve failed with Sunshine credentials not configured. It succeeded after one elevated `Sunshine --creds` and a `SunshineService` restart. HTTP **409** means a stuck pairing session. Clearing it means restarting `SunshineService`, which needs an administrator. Do not bypass UAC.

After video worked, **remote input failed**. Mouse clicks and keyboard from Odin did not change the host. Win+R opened Run on Odin. Moonlight captured the local cursor. This is the main open bug for a demo.

An earlier HD2 (`DESKTOP-HD2F11E`) to RFU stream used a manual pin API workaround, not in-app Approve. HD2 was offline for the `02881d9` retest.

Moonlight on the controller lives at `%APPDATA%\dev.nodedesk.app\moonlight\Moonlight.exe`. The real arguments are `pair <address>` and `stream <address> Desktop`. `Moonlight.exe --help` shows a usage dialog. That dialog is not a product bug.

## Known gaps

1. **Remote input.** Video and pairing can succeed while mouse and keyboard from the controller never reach the host. On the 2026-09-29 Odin → RFU session, Win+R opened Run on Odin and Moonlight captured the local cursor. This is the main open bug for a demo.
2. **Account sync is unfinished.** PR #3 is a mock: Google sign-in placeholder, device-registry mock, dashboard click-through. Berk wants the registry hosted on a server, not LAN-only. Nothing in that plan is installed.
3. **DNS is not in place.** Intended hostname: `https://nodedesk.berkkarabacak.com`. Server address: `2.28.215.22`. The Squarespace DNS A record `nodedesk` → `2.28.215.22` has not been added. Leave the apex, `www`, and `sync.berkkarabacak.com` unchanged.
4. **No Google OAuth client id yet.** Berk still needs a Google Cloud OAuth **Desktop** client ID. If a redirect URI is used, it is `https://nodedesk.berkkarabacak.com/auth/google/callback`. No client secret belongs in this repository.
5. **PR #2 is unmerged.** CI is green on `02881d9256d136a1e8a59fd71ec95559341cc3f2`, and the in-app Approve path above was exercised against that work, but release installs built from `main` / v1.3.0 do not contain the hidden-console, per-user NSIS, Sunshine MSI, or `POST /api/pin` fixes.

Account hosting plan, recorded so it is not lost, and **not installed**:

- Server `2.28.215.22`, hostname `https://nodedesk.berkkarabacak.com`.
- nginx listens on 443 and proxies to `127.0.0.1:8081`. Port **8080** is Notepad++ Sync. Leave it alone.
- Data directory: `/var/lib/nodedesk`.
- Secrets directory: `/etc/nodedesk`, mode `600`.
- Sunshine ports **47984, 47989, 47990, and 48010** stay unpublished.

## How to resume

Only if Berk asks to resume. Machines from the 2026-09-29 proof:

- Host: `DESKTOP-RFU96MA` (user `XPS13`). App installed per-user at `%LOCALAPPDATA%\NodeDesk`.
- Controller: Odin. Moonlight at `%APPDATA%\dev.nodedesk.app\moonlight\Moonlight.exe`.
- HD2 (`DESKTOP-HD2F11E`) was offline for the `02881d9` retest. Do not treat it as part of that result.

Installer path that was proven: silent `/S /CURRENTUSER` into `%LOCALAPPDATA%\NodeDesk`, matched by the SHA256 values in the hardware section. The Windows package the repo builds is `NodeDesk-Setup-x64.exe` (Tauri NSIS; see `installer/windows/README.md`). PR #2's per-user NSIS and MSI Sunshine install are only on `cursor/windows-popup-reliability-a86d`.

When Sunshine credentials are missing, run one elevated `Sunshine --creds`, then restart `SunshineService`. A stuck pairing session returns HTTP 409; restart `SunshineService` (administrator). Do not bypass UAC. Those prompts are the consent path.

To look at unreleased work without merging it:

```text
git fetch origin
git checkout 02881d9256d136a1e8a59fd71ec95559341cc3f2   # PR #2
git checkout 8c6999eb685a1242705f5a97ef83bf95b31d0670   # PR #3
```

## What not to do

- Do not keep building. The project is paused as of 2026-09-29.
- Do not squash or merge PR #2 or PR #3.
- Do not tell anyone that release installs include the PR #2 Windows fixes. They do not.
- Do not publish Sunshine ports 47984, 47989, 47990, or 48010.
- Do not add or change DNS for the apex, `www`, or `sync.berkkarabacak.com`. The `nodedesk` A record is not added yet.
- Do not commit secrets, passwords, OAuth client secrets, or `.env` files. A future Google client id is a Desktop client id only.
- Do not bypass UAC to configure Sunshine credentials or restart `SunshineService`.
- Do not treat `Moonlight.exe --help` (a usage dialog) as a product bug.
- Do not describe the earlier HD2 → RFU stream as in-app Approve. That stream used a manual pin API workaround, and HD2 was offline for the `02881d9` retest.
