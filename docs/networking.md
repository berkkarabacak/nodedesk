# NodeDesk Networking

## Principles

1. **LAN first.** Computers on the same network discover each other
   automatically and connect directly.
2. **Tailscale is first-class but optional.** If Tailscale is installed,
   NodeDesk detects it and lists application nodes reachable through the
   tailnet. NodeDesk never requires Tailscale.
3. **No silent public exposure.** NodeDesk never punches the Sunshine host
   through to the public internet.
4. **Extensible.** The networking layer is an interface; additional secure
   networking backends (e.g. other overlay networks, explicit port-forwarding
   with warnings) can be added later.

## Discovery

```text
Network scan
Found:  Office-PC   AI-PC   Laptop   Server
```

- **LAN:** UDP broadcast (mDNS planned)-based announcements from each NodeDesk host; passive listening
  plus active scan on demand.
- **Tailnet:** Tailscale local API enumerates peers running NodeDesk.
- Each discovered computer shows name, OS, online status and — once paired —
  live metrics.

## Pairing

Dramatically simpler than stock Sunshine/Moonlight:

1. Both machines run NodeDesk.
2. Controller selects a discovered computer → “Pair”.
3. Host shows an approval prompt; user approves.
4. Certificates are exchanged and stored in OS secure storage. Done, forever.

No PIN transcription, no web UI visit, no port knowledge.

## Connection policy

- Prefer direct LAN path; fall back to tailnet path automatically.
- A session survives temporary network problems: reconnect with exponential
  backoff, resume without user action.
- Handle Wi-Fi changes, IP changes, sleeping hosts (offer Wake), host/client
  reboots and temporary Tailscale loss gracefully.

## What users see when it fails

```text
Can't reach AI-PC.
[ Try Again ]
Advanced details >
```

Never: `Sunshine host unreachable on UDP xxxx`.
