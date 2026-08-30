# installer/linux/

Planned artifacts: `NodeDesk.AppImage` and `NodeDesk.deb` (via Tauri bundler).

Linux host support lands after the Windows MVP. Notes:

- systemd user/system service for the host agent
- distro-specific virtual display approaches (e.g. evdi) need per-distro review
- Sunshine on Linux has its own packaging guidance we must respect
  (see [docs/upstream.md](../../docs/upstream.md))

**Status:** planned.
