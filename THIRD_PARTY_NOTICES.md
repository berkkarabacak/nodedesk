# Third-Party Notices

NodeDesk is built on and distributes open-source software. This file is the
canonical attribution list; it is regenerated and verified before each
release.

## Streaming stack

### Sunshine

- <https://github.com/LizardByte/Sunshine>
- License: **GPL-3.0** — © LizardByte and contributors
- Use in NodeDesk: managed host component (unmodified upstream build),
  deployed and configured by the NodeDesk installer.

### Moonlight

- <https://github.com/moonlight-stream>
- License: **GPL-3.0** — © Moonlight project contributors
- Use in NodeDesk: client protocol technology for remote desktop sessions.

NodeDesk is not affiliated with or endorsed by LizardByte or the Moonlight
project. “Sunshine” and “Moonlight” are referenced descriptively.

## Application framework

### Tauri

- <https://tauri.app> — License: Apache-2.0 / MIT

### React

- <https://react.dev> — License: MIT

### Tailwind CSS

- <https://tailwindcss.com> — License: MIT

### lucide-react (icons)

- <https://lucide.dev> — License: ISC

## Inherited via upstream builds

Sunshine/Moonlight builds bundle components under their own licenses
(including but not limited to ffmpeg (LGPL/GPL), Opus (BSD), and
vendor encoder SDKs such as NVENC/AMF/Quick Sync wrappers). Refer to the
upstream projects' own THIRD-PARTY notices for the authoritative list.

## Optional integrations

### Tailscale

- <https://tailscale.com> — Tailscale client is **not** distributed with
  NodeDesk. When a user has Tailscale installed, NodeDesk detects it and uses
  its local API. Tailscale's own terms and licenses apply to its software.

---

*This list must be reviewed per [docs/upstream.md](docs/upstream.md) before
every tagged release.*
