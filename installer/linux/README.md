# installer/linux/

**Shipping since v1.2:** `NodeDesk.AppImage` and `nodedesk.deb` (Tauri bundler,
built in CI on Ubuntu 22.04).

## What the package does

- Installs the NodeDesk app (host + controller in one)
- On first run with host/both mode: installs upstream Sunshine via its
  official Ubuntu/Debian `.deb` (needs root once — `sudo apt install`), enables
  its systemd **user** service, and generates secure credentials
- Autostart via `~/.config/autostart/nodedesk.desktop` (per Settings toggle)

## Notes

- Other distros (Fedora/Arch/…): Sunshine manual install for now; NodeDesk
  detects and manages it once present.
- Wayland vs X11 capture support follows upstream Sunshine.
- Headless servers: Sunshine's own X11/dummy-display guidance applies;
  automated virtual-display management is Windows-only in v1.2.
