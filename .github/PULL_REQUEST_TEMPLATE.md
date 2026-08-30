## What & why

<!-- One paragraph. Link the issue or Discussion. -->

## How

<!-- Key implementation notes. Link an ADR if this changes architecture. -->

## Testing

<!-- What did you run? Which hardware? Check all that apply: -->

- [ ] `npm run build` passes in `apps/desktop`
- [ ] `cargo clippy` / `cargo test` pass for `src-tauri`
- [ ] Tested on real hardware: <!-- e.g. NVIDIA RTX 4070 host, Intel client -->
- [ ] Upgrade path from previous release verified (if touching installer)

## Checklist

- [ ] Keeps `main` buildable
- [ ] UI copy passes the jargon test (no Sunshine/Moonlight/codec/ports terms in normal UI)
- [ ] Security impact considered (see docs/security.md)
- [ ] If it touches upstream components: followed docs/upstream.md (patch isolated + proposed upstream)
- [ ] Docs updated if behavior changed
