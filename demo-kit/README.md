# NodeDesk Investor Demo — 10-Minute Run of Show

Two Windows machines on the same network: **HOST** (the "remote" one) and
**LAPTOP** (the one you drive from). Do the setup below before the meeting;
the flow itself needs no typing on stage.

## Pre-meeting (15 min, once)

1. On both machines: install from `demo-kit\NodeDesk-Setup-x64.exe`
   (SmartScreen → "More info → Run anyway").
2. Edit `demo-kit\demo-config.txt`: your Google OAuth client ID +
   `DIRECTORY_URL=http://<service-machine-LAN-IP>:8787`.
3. On the service machine: double-click `demo-kit\start-directory.cmd`
   (leave the window open).
4. On both machines: double-click `demo-kit\configure-app.cmd`.
5. Rehearse once fully (below) — fresh sign-ins make the best beats.

## The run of show

**0:00 — The problem (30 s).**
"Remote desktop tools are either expensive subscriptions or expert-only
open source. NodeDesk is free, self-hostable, and simple enough for anyone."

**0:30 — Sign in (30 s).** On HOST: open NodeDesk → Continue with Google →
complete in browser. "One sign-in. No IP addresses, no PINs, no ports."

**1:00 — Enroll (45 s).** HOST → This Computer → *Enroll this computer* →
show the Device ID (`482 913 705`-style) and the security fingerprint.
"Every computer gets a stable ID and a verifiable identity."

**1:45 — Enable hosting (30 s).** HOST → *Enable remote access* → turn on
**Unattended access**. "The owner is always in control — hosting is off
until they say so."

**2:15 — The sync moment (30 s).** On LAPTOP: sign in with the *same*
Google account → **the HOST appears in My Computers by itself.**
"No configuration file, no typing the ID. The account is the address book."

**2:45 — First connect + approval (90 s).** LAPTOP: click **Connect** →
HOST gets the Incoming Connection prompt: verified name/email, *New device*,
permission switches. On HOST: enable control + files, tick
**Trust this device**, **Accept**. "The host approves every capability
explicitly — and can trust its own devices."

**4:15 — Work remotely (2 min).** Drive the desktop. Open the session
toolbar: monitors (real list only), quality (Auto → Best speed, watch the
restart), stats, clipboard. "The controls are honest — if a capability
isn't granted, it says so instead of pretending."

**6:15 — File transfer (60 s).** Drag a file into File Transfer → show the
queue: per-item progress, cancel, retry. "Real bytes, per-file IDs, resumes
interrupted transfers safely."

**7:15 — The one-click moment (45 s).** Disconnect. Click **Connect** again:
instant, no prompt. "That's the daily experience — one click."

**8:00 — Owner control (60 s).** HOST → Settings → Trusted computers →
**Remove** the laptop. LAPTOP tries Connect again → request pending again.
"Revocation is real: access dies immediately, everywhere."

**9:00 — The substance (60 s).** "Free and self-hostable: the account
service is a thousand lines of dependency-free Node. Security is engineered,
not promised — TLS with pinned device certificates, host-enforced
permissions, and 180+ automated tests including a simulated two-machine
end-to-end run. Everything you've seen is on GitHub as PR #11."

## If something goes wrong on stage

- **Sign-in fails** → check `start-directory.cmd` window is open and the
  client ID in `demo-config.txt` has no spaces.
- **Computer doesn't appear** → HOST: This Computer shows "Enrolled"? Then
  both machines must reach the directory URL (same LAN).
- **Connect says "couldn't reach"** → expected answer: "NodeDesk is honest
  about routes — same network or Tailscale today, no fake Connected state."
- **Preview fallback** → `npm run dev` in `apps/desktop` shows the full UI
  with simulated data, clearly labeled as a preview.

## After the demo

- Stop the service window (Ctrl+C). Delete `demo-kit\demo-directory.db` to
  reset for a fresh run.
