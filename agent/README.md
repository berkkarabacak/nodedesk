# agent/

> **Design notes, not code.** The working implementation lives in
> `apps/desktop/src-tauri/src/` - see the repository layout in the README.
> This subsystem is implemented in `agent.rs`. Terminal access is a plain
> agent shell, not an SSH bridge.

The **NodeDesk host agent**: a small, privileged, per-machine service that does
what the unprivileged UI cannot.

## Responsibilities

- Power actions: sleep, restart, shutdown, lock (authenticated peers only)
- Wake-on-LAN assistance and host readiness
- Secure remote terminal (Windows: PowerShell/SSH bridge or agent shell; Linux: SSH where appropriate)
- Virtual display management for headless machines (driver install is
  security-sensitive, platform-specific, and consent-gated)
- Supervision of the managed Sunshine host service (start/stop/health/upgrade)

## Rules

- Minimal surface area; every action requires an authenticated, paired,
  non-revoked peer (see [docs/security.md](../docs/security.md)).
- All privileged actions are logged.
- Never accepts connections from the public internet.

**Status:** design stage — interface contract is defined by the Tauri commands
in `apps/desktop/src-tauri/src/main.rs`.
