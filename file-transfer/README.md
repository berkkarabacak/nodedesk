# file-transfer/

> **Design notes, not code.** The working implementation lives in
> `apps/desktop/src-tauri/src/` - see the repository layout in the README.
> This subsystem is implemented in `files.rs`. Transfers are authenticated
> and path-confined, but the channel is not encrypted - see docs/security.md.

Move files between your computers without installing anything else.

## Responsibilities

- Send file / send folder / receive file
- Drag and drop into a session or device page
- Clipboard file transfer where practical
- Transfer progress, pause/cancel
- **Resume interrupted transfers**; large-file support
- Uses the authenticated, encrypted device channel — independent of the video
  stream, so transfers work without an open desktop session

**Status:** design stage (targeted for NodeDesk 0.2).
