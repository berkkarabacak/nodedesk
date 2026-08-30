# streaming/

NodeDesk's streaming integration layers. We wrap upstream — we don't rewrite it.

## `sunshine/`

Sunshine host lifecycle management:

- detect / deploy the managed Sunshine build (unmodified upstream)
- generate configuration from NodeDesk's automatic hardware detection
  (GPU, encoders, displays, network)
- health monitoring and safe upgrades
- downstream patches, when unavoidable, live in `patches/` — one commit per
  logical change, each mirrored as an upstream PR
  (see [docs/upstream.md](../docs/upstream.md))

## `moonlight/`

Moonlight client integration:

- session launch against paired hosts (desktop mode; no game-launcher UX)
- input, audio, clipboard channel wiring
- automatic reconnect with the policy from
  [docs/networking.md](../docs/networking.md)
- automatic codec/resolution/FPS selection (H.264 / HEVC / AV1, 4K, HDR,
  high refresh) with an Advanced override surface

**Status:** design stage — the UI contract already exists in
`apps/desktop/src/lib/api.ts`.
