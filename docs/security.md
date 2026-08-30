# NodeDesk Security Model

Security is a launch blocker, not a follow-up. NodeDesk never weakens
Sunshine/Moonlight security to make onboarding easier — it automates the hard
parts instead.

## Trust model

Users see exactly one security concept: **Trusted Computers**.

```text
Trusted Computers
✓ Main-PC
✓ Laptop
✓ AI-PC
[ Revoke ]
```

- No unauthenticated remote-desktop access, ever.
- Pairing = explicit user approval on both devices, backed by the upstream
  Sunshine/Moonlight certificate handshake.
- Revoking a device deletes its credentials and breaks all future sessions.

## Mechanisms

| Area | Approach |
|---|---|
| Pairing | Authenticated pairing reusing the upstream certificate exchange; approval UX simplified, cryptography unchanged |
| Transport | Encrypted streaming, file-transfer and clipboard channels; certificate verification on every session |
| Device identity | Unique per-machine identity generated at install; private keys never leave the device |
| Credential storage | OS-provided secure storage: Windows Credential Manager, macOS Keychain, libsecret on Linux |
| Host authorization | Host service accepts sessions only from paired, non-revoked device certificates |
| Session authorization | Each session is individually established and logged |
| Updates | Signed releases only; signature verification before install; HTTPS transport; rollback on failure |
| Internet exposure | LAN-first. Tailscale (optional) for remote access. NodeDesk does **not** silently expose the host to the public internet |

## Threat model (summary)

| Threat | Mitigation |
|---|---|
| Rogue device on LAN attempts pairing | Explicit approval on the *host* screen; no silent pairing |
| Stolen credentials | Keys in OS secure storage; revocation invalidates them remotely |
| MITM on untrusted network | Mutual certificate verification; pinned device identities |
| Malicious update | Signed artifacts, verified client-side, fail-closed |
| Diagnostic report leaks | Export redacts passwords, private keys, tokens, clipboard contents |
| Privileged agent abuse | Minimal agent surface; actions require an authenticated, paired peer; all actions logged |
| Virtual display driver risk | Signed drivers only, explicit consent, platform-specific review |

## Clipboard

Clipboard sync (text/URLs at MVP; images/files under investigation) can be
disabled globally in Settings. Clipboard contents are never logged or exported.

## Reporting

See [SECURITY.md](../SECURITY.md) for coordinated vulnerability disclosure.
