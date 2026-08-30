# Upstream & Licensing

NodeDesk exists because of open-source upstream work. This document tracks how
upstream projects are used and what their licenses require. The machine-facing
list of attributions lives in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

## Upstream components

| Project | Role in NodeDesk | License (verify each release) |
|---|---|---|
| [Sunshine](https://github.com/LizardByte/Sunshine) | Managed host: gamestream-compatible capture/encode/stream server | GPL-3.0 |
| [Moonlight](https://github.com/moonlight-stream) | Client protocol implementation for desktop sessions | GPL-3.0 |
| Sunshine/Moonlight dependencies (ffmpeg, NVENC/AMF/QSV wrappers, opus, etc.) | Inherited via upstream builds | Mixed (LGPL/GPL/BSD/MIT — see their notices) |
| Virtual display drivers (platform-specific) | Headless display creation | Per-driver; documented before shipping |

## Obligations checklist (re-run before every release)

- [ ] Attribution: upstream named in README, website footer, THIRD_PARTY_NOTICES
- [ ] Source distribution: NodeDesk source is public under GPL-3.0 (this repo)
- [ ] Modifications: any downstream patch is isolated in a clearly marked
      directory/branch, documented here, and proposed upstream
- [ ] Binary redistribution: GPL-3.0 notices + source offer shipped with installers
- [ ] License compatibility: all bundled components compatible with GPL-3.0
- [ ] Trademark/name: NodeDesk does not use “Sunshine”/“Moonlight” in its
      product name; references are descriptive, with no implied endorsement

## Policy

1. Prefer contributing generally useful fixes **upstream** over maintaining
   downstream patches.
2. Keep upstream modifications easy to identify and synchronize
   (`streaming/*/patches/` with one commit per logical change, mirrored as
   upstream PRs).
3. Do not violate upstream licenses. When in doubt, stop and ask in
   Discussions before shipping.
4. Upgrade upstream components on a regular cadence; upstream compatibility
   is a design goal, not an afterthought.

## Credit

NodeDesk prominently credits Sunshine (LizardByte) and Moonlight (Moonlight
project contributors). NodeDesk did not create the underlying streaming
technology and does not claim to.
