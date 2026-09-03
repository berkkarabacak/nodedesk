# NodeDesk Security Model

Security is a launch blocker, not a follow-up. NodeDesk never weakens
Sunshine/Moonlight security to make onboarding easier — it automates the hard
parts instead.

This document describes **what is implemented today**, and marks anything that
is not yet built as *planned*. A security document that describes intentions as
if they were mechanisms is worse than none, because it is what a reviewer
trusts before installing.

## Two channels, two trust models

NodeDesk has two separate paths between computers, and they are not equally
protected:

| Channel | What it carries | Protection |
|---|---|---|
| **Streaming** (Sunshine ↔ Moonlight) | video, audio, input, clipboard | Upstream: certificate-pinned pairing and encrypted transport, unchanged by NodeDesk |
| **Agent** (NodeDesk's own) | metrics, power actions, file transfer, remote terminal | Signed requests over plain HTTP on the LAN/tailnet — see below |

## Trust model

Users see exactly one security concept: **Trusted Computers**.

- No unauthenticated remote-desktop access, ever.
- Pairing = explicit user approval on both devices, backed by the upstream
  Sunshine/Moonlight certificate handshake.
- Forgetting a computer deletes its stored access code from this machine.

## The agent channel

The agent is the powerful part of NodeDesk: it can run commands, move files
and power the machine off. It is worth being precise about how it is guarded.

**Authentication.** Every request carries an HMAC-SHA256 over its method, path,
query, timestamp, nonce and body digest, keyed by the host's access code. The
access code itself is **never transmitted**. Someone capturing traffic learns a
signature over one specific request, which authorizes nothing else.

**Replay.** Timestamps more than 120 seconds from the host clock are rejected,
and every nonce is accepted exactly once. A captured request cannot be sent
twice.

**Guessing.** Access codes are 12 characters from a 32-symbol alphabet (~60
bits). After 10 failed attempts a peer is locked out for a minute, so an online
search is not viable.

**Rotation.** Regenerating the access code takes effect on the running listener
immediately. The previous code stops working at once, without a restart.

**File access.** Paths arriving from the network are resolved and confined
before they reach the filesystem: reads to the user's own folders, writes to
the incoming-transfer folder only. Traversal (`..`, mixed separators, symlinks
pointing outward) is rejected.

**What the agent channel does _not_ do.** Its payloads are **not encrypted**.
The signature proves who sent a request and that it was not altered, but an
observer on the same LAN segment can read file contents in transit and see
which commands are run. Treat the agent channel as authenticated and
tamper-evident, not confidential. For confidentiality across an untrusted
network, run NodeDesk over Tailscale, which encrypts the path end to end.
*Planned: TLS with per-device certificates on the agent channel, which would
remove this caveat.*

## Mechanisms

| Area | Approach | Status |
|---|---|---|
| Pairing | Upstream certificate exchange; approval UX simplified, cryptography unchanged | Implemented |
| Streaming transport | Encrypted by upstream Sunshine/Moonlight | Implemented |
| Agent transport | Signed, replay-protected, throttled; **not encrypted** | Implemented |
| Credential storage | OS secure storage — for this host's code and every remote host's code. Windows Credential Manager, macOS Keychain, and Secret Service (GNOME Keyring / KWallet) on Linux | Implemented |
| Path confinement | Network-supplied paths confined to shared folders | Implemented |
| Upstream downloads | Origin-verified against the expected GitHub repository before an installer is written or run | Implemented |
| Diagnostic exports | Contain no credentials, keys, tokens or clipboard contents | Implemented |
| Internet exposure | LAN-first. Tailscale (optional) for remote access. NodeDesk does **not** silently expose the host to the public internet | Implemented |
| Release signing | Windows/macOS binaries are **unsigned** in v1.x | *Planned* |
| Update verification | Update check links to the release page; there is no in-place auto-update to verify yet | *Planned* |
| Session audit log | Per-session logging of agent actions | *Planned* |

## Threat model

| Threat | Mitigation | Status |
|---|---|---|
| Rogue device on LAN attempts pairing | Explicit approval on the *host* screen; no silent pairing | Implemented |
| Attacker guesses the access code | ~60-bit code; lockout after 10 failures | Implemented |
| Attacker sniffs the code off the wire | The code is never transmitted; only per-request signatures are | Implemented |
| Attacker replays a captured request | Timestamp window plus single-use nonces | Implemented |
| Attacker reads file contents off the wire | **Not mitigated** — the agent channel is not encrypted; use Tailscale | *Planned (TLS)* |
| Compromised code used to read the whole disk | Reads confined to the user's folders, writes to the incoming folder | Implemented |
| Stolen credentials | Codes in OS secure storage; forgetting a host deletes its code, regenerating invalidates it immediately | Implemented |
| Tampered upstream installer URL | Asset origin verified against the expected GitHub repository | Implemented |
| Malicious upstream release (correct URL, bad contents) | **Not mitigated** — upstream publishes no signatures NodeDesk can verify | *Planned* |
| Malicious NodeDesk update | **Not mitigated** — releases are unsigned in v1.x | *Planned* |
| Virtual display driver risk | Origin-verified download, explicit UAC consent, never silent | Partially — the driver itself is third-party and unsigned by us |

### A note on Linux

Secure storage on Linux is provided by a Secret Service daemon — GNOME Keyring
or KWallet — which desktop installs normally have running. On a system without
one (a bare server, some minimal window managers), NodeDesk will report that no
secure credential store is available and refuse to save an access code, rather
than falling back to writing it somewhere unprotected.

## Clipboard

Clipboard sync (text/URLs at MVP; images/files under investigation) is handled
by upstream Moonlight over its encrypted channel and can be disabled globally
in Settings. Clipboard contents are never logged or exported.

## Reporting

See [SECURITY.md](../SECURITY.md) for coordinated vulnerability disclosure.
