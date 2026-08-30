# Contributing to NodeDesk

Welcome! NodeDesk aims to be a genuine community open-source project, and
contributions of all kinds are valued: code, docs, design, testing on real
hardware, and thoughtful issue reports.

## Ground rules

1. Read the [Code of Conduct](CODE_OF_CONDUCT.md).
2. Read [docs/architecture.md](docs/architecture.md) before large changes.
3. Priority order when trade-offs appear:
   **stability → security → simplicity → performance → features.**
4. Keep `main` buildable. Every PR passes CI.

## Ways to start

- [`good first issue`](https://github.com/berkkarabacak/nodedesk/labels/good%20first%20issue)
  — curated, small, well-described tasks
- Bug reports: use the bug-report template; include a diagnostic export
  (Help → Diagnostics → Export Diagnostic Report)
- Feature ideas: open a Discussion first for anything beyond a small change
- Hardware compatibility reports (NVIDIA / AMD / Intel, headless, HiDPI) are
  extremely valuable even without code

## Development workflow

```bash
git clone https://github.com/berkkarabacak/nodedesk.git
cd nodedesk/apps/desktop
npm install
npm run dev
```

See [docs/development.md](docs/development.md) for the full setup.

## Pull requests

- Small and focused; one logical change per PR
- Fill out the PR template
- Architectural changes need an ADR in `docs/adr/`
- UI text must pass the jargon test: would a non-technical user understand it?

## Upstream etiquette

NodeDesk depends on Sunshine and Moonlight. If your change fixes something
generally useful in an upstream component, propose it upstream first and link
the upstream PR in your NodeDesk PR. See [docs/upstream.md](docs/upstream.md).
