# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`gaya` is a macOS Electron desktop mascot that reacts in real time to Claude Code session state. Hook scripts in `hooks/` POST state changes to a local HTTP server, and one transparent mascot window animates per active session. Single Electron app, no monorepo.

## Commands

```bash
npm install                       # postinstall stages lottie-web for the renderer
npm start                         # launch the app
npm run dev                       # launch with --inspect for main-process debugging
npm run install-hooks             # merge hooks/*.sh into ~/.claude/settings.json (idempotent)
npm run install-hooks -- --dry-run
npm run uninstall-hooks
```

There is **no test runner, linter, or packaging step** configured. Validate changes by running `npm start` and exercising state via `curl` (see README) or the Tray menu.

## High-level shape

- `main.js` — single-file main process. Owns the HTTP server, session/window lifecycle, Tray, movement loop, drag physics, and pack discovery.
- `preload.js` — sandbox-mode contextBridge surface. All renderer↔main traffic flows through `window.api`.
- `renderer/` — the mascot window and the optional pack-preview window, plus the shared `MascotRenderer` classes used by both.
- `assets/characters/<id>/` — character packs. Three renderer types are supported (SVG / image / Lottie).
- `hooks/` — Claude Code hook scripts (not Electron hooks) that POST state to gaya.
- `scripts/` — `postinstall.js` and `install-hooks.js`.

## Reference documents

Detailed, implementation-level information lives in dedicated reference files under `docs/`. **These references describe the code as it exists today and must be updated whenever the underlying implementation changes** — treat keeping them in sync as part of the change, not a follow-up.

- [`docs/architecture.md`](docs/architecture.md) — process model, state machine, IPC channel map, session lifecycle, movement/drag physics, hooks integration, settings persistence.
- [`docs/pack-format.md`](docs/pack-format.md) — character pack manifest schema, renderer-specific layouts, CSS scoping conventions, pack switching/discovery rules.
- [`docs/animation-guide.md`](docs/animation-guide.md) — pre-existing authoring guide for pack animations.

Before relying on a specific constant, channel name, or schema field from a reference doc, spot-check the file it points to — drift is expected.

## When making changes

- Adding or renaming an IPC channel, manifest field, state name, or HTTP payload key → update `docs/architecture.md` or `docs/pack-format.md` in the same change.
- Adding a new character pack → use the `pack-template` skill (`.claude/skills/pack-template/`); it scaffolds the correct directory layout for the chosen renderer.
- Touching CSS in a pack → keep the per-pack scoping rules in `docs/pack-format.md` intact; collisions break other packs silently.
