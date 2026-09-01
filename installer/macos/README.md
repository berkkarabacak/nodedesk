# installer/macos/

**Shipping since v1.2:** `NodeDesk.dmg` (Tauri bundler, built in CI on macOS).

macOS is **controller-first**: connect to your Windows/Linux hosts from a Mac.
Sunshine host mode on macOS follows upstream's maturing macOS support.

## Notes

- The dmg is unsigned in v1.x — first launch requires right-click → Open
  (Gatekeeper). Developer ID signing + notarization land before stable.
- NodeDesk uses an existing Moonlight install (`/Applications/Moonlight.app`)
  for streaming; install it from moonlight-stream.org when prompted.
- Autostart via a LaunchAgent (per Settings toggle).
