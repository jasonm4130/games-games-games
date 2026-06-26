# Contributing

Thanks for your interest! This is a personal portfolio project, so the bar for new features is
"does it make the demo better" — but issues, fixes, and game requests are very welcome.

## Ground rules

- **Open an issue first** for anything non-trivial, so we can agree on the approach before you build.
- **`pnpm check` and `pnpm test` must pass** before a PR is ready (CI runs both).
- Keep changes surgical and match the surrounding style (Biome enforces formatting).

## Want a game added to the catalogue?

Use the **[Request a game](https://github.com/jasonm4130/games-games-games/issues/new?template=game-request.md)**
issue template (the in-app "Request a game" button links here too). Note: rulebook PDFs are
copyrighted and are **not** committed to this repo — see the README for why `rulebooks/` is gitignored.

## Local setup

See the README's *Getting started* and *Operator toolchain* sections. In short:

```bash
pnpm install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # fill in what you need (all optional for a basic run)
pnpm dev                         # SPA + Worker + agent locally with HMR
pnpm check && pnpm test          # before opening a PR
```

The offline PDF→markdown conversion tooling is Python (`uv`), under `tools/rulebook-prep/`; its
tests run with `uv run pytest` from that directory.
