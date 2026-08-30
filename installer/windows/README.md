# installer/windows/

Produces `NodeDesk-Setup-x64.exe`.

## Approach

The MVP installer is the **Tauri NSIS bundle** (see
`apps/desktop/src-tauri/tauri.conf.json`), extended with NSIS hooks that:

- install the application and required host components
- deploy and configure the managed Sunshine host service
- add required firewall rules
- register startup behavior (per Settings)
- trigger hardware/encoder detection on first run
- generate the secure device identity

The user never installs Sunshine separately.

## Uninstall contract

Clean uninstall removes: the app, NodeDesk-managed services, firewall rules
added by the installer, device certificates and configuration — unless the
user explicitly chooses to keep paired-device data.

## Later

Evaluate migrating to a custom WiX/NSIS bootstrapper if the Tauri NSIS hooks
prove insufficient for driver (virtual display) installation.
