# installer/windows/

Produces `NodeDesk-Setup-x64.exe`.

## Approach

The installer is the **Tauri NSIS bundle** (`apps/desktop/src-tauri/tauri.conf.json`).

It installs **per user** (`installMode: currentUser`). A per-machine install
always raised a UAC prompt even though NodeDesk only writes HKCU autostart
and a user config directory. The installer does not add firewall rules and
does not install Sunshine. Those need administrator rights, so they happen
later, only after the user chooses host mode:

- Sunshine's own installer runs once, with a single consent prompt, silent
  (`/S`). It installs the service and its firewall rules. NodeDesk is not
  relaunched elevated.
- The virtual display driver is a separate consent prompt, and only after
  **Enable headless mode** in Settings.

An older per-machine NodeDesk install is not replaced in place by this
per-user package. Uninstall that copy first.

## Uninstall contract

Uninstall removes the per-user app. The host service and the virtual display
driver are installed separately (only after the user opts in) and are not
removed by the NodeDesk uninstaller. Deleting the NodeDesk config folder
removes paired-device data.

## Later

Evaluate migrating to a custom WiX/NSIS bootstrapper if the Tauri NSIS hooks
prove insufficient for driver (virtual display) installation.
