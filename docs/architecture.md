# Architecture reference

> **このドキュメントは現時点のコードに対するリファレンスです。** 状態名・IPC チャネル・HTTP ペイロード・セッション挙動・物理パラメータなどを変更したら、その実装変更と同じコミットで本ファイルを更新してください。古くなったまま放置すると、未来の Claude や人間が誤った前提で作業します。

## Processes

| Process | File | Responsibility |
|---|---|---|
| Main | `main.js` | HTTP server, session map, BrowserWindow lifecycle, Tray, movement loop (50 ms), drag/fall physics, session reaper (60 s), pack discovery (built-ins + external folders), settings persistence |
| Preload | `preload.js` | Sandbox-mode `contextBridge`. Exposes the entire `window.api` surface; renderers have no direct `ipcRenderer` access. |
| Renderer (mascot) | `renderer/renderer.js` | One window per session. Owns the active `MascotRenderer` instance and the speech bubble. |
| Renderer (preview) | `renderer/preview.js`, `renderer/preview.html` | Optional pack-authoring window. Singleton. Watches pack files for live reload. |
| Shared | `renderer/pack-renderer.js` | The three `MascotRenderer` classes (SVG / image / Lottie) plus `applyPackCss`, used by both renderer windows. |

## HTTP server

- Tries ports `39999..40010`, first free wins. The chosen port is logged at startup.
- Endpoint: `POST /state`
- Payload (all fields except `state` are optional):

  ```json
  {
    "state": "working",
    "message": "optional bubble text",
    "session_id": "abc123",
    "cwd": "/path/to/project",
    "session_end": true,
    "event": "SessionEnd"
  }
  ```

- `state` must be one of the base states (see below). Empty/missing `session_id` routes to the `__default__` session. `session_end: true` or `event: "SessionEnd"` plays a 2.5 s farewell, then destroys the window.

## State machine

Two orthogonal axes combine into the visible state:

- **Base states** (driven by HTTP): `idle | thinking | working | waiting | done | error`. `done` auto-reverts to `idle` after 2.5 s.
- **Overlay states** (driven by physics): `dragging | falling | landed`. When set, the overlay wins visually; the base state continues progressing underneath.

`VALID_STATES` and `OVERLAY_STATES` are defined in `renderer/pack-renderer.js`. Every renderer applies a single `.state-<name>` class to the mascot root — packs hook visuals through these classes (see `docs/pack-format.md`).

The Tray title shows an emoji that reflects the **aggregate** state across all sessions. Priority order: `error > waiting > working > thinking > done > idle`.

## Sessions

- Keyed by `session_id`. The empty/missing key maps to a special `__default__` session that is **never** evicted.
- Cap: 6 concurrent sessions (including `__default__`).
- Reaper: runs every 60 s, evicts non-default sessions idle for 15 minutes.
- `session_end` triggers a 2.5 s farewell animation and then destroys the window.
- `session-info` IPC carries `{sessionId, isDefault, displayName, cwd}` to the renderer for display.

## Window layout

- Per-session window: 280×240 px, transparent, panel-type on macOS (always-on-top across Spaces, screen-saver level).
- Mascot content area: 200×200 px, centered.
- Multi-mascot tiling: bottom-right anchor, 220 px stride leftward, wraps upward when the row fills.
- Click-through is a setting (see Settings).

## IPC channels

All channels live on `preload.js` and are fanned out from `main.js`. Channel names are strings; keep this table aligned with the code.

### Main → renderer (one-way)

| Channel | Payload | Notes |
|---|---|---|
| `state` | `{state, message}` | Base state update. |
| `switch-pack` | `packId` | Sent to all mascot windows on Tray pack change. |
| `movement` | `{walking, direction}` | `direction` is `'left'` or `'right'`. |
| `overlay` | `{overlay}` | `overlay` is one of `'dragging' \| 'falling' \| 'landed' \| null`. |
| `session-info` | `{sessionId, isDefault, displayName, cwd}` | Sent once after `renderer-ready`. |
| `preview:pack-changed` | `{packId}` | Preview window only. Fired by file watcher. |

### Renderer → main

| Channel | Direction | Purpose |
|---|---|---|
| `renderer-ready` | send | Renderer announces it's ready to receive `state`/`session-info`. |
| `pack:list` | invoke | Returns metadata for all discovered packs. Each entry includes `{id, name, dir, external}`; `external: true` flags packs registered from arbitrary folders via Tray → "Add Pack from Folder…". |
| `pack:load` | invoke | Returns manifest + asset payload for a given pack id. Resolves the pack directory through the discovered list, so external packs work. |
| `preview:open` | invoke | Opens the singleton preview window. |
| `preview:reveal` | invoke | Reveals a pack directory in Finder. |
| `preview:validate` | invoke | Validates a pack's structure, returns errors. |
| `pack:watch` / `pack:unwatch` | send | Start/stop file watching for live reload (preview window). |

## Movement & drag physics

Single 50 ms tick in `main.js`. Driven by two settings:

- `movementWhen`: `always | idle | off`. `idle` walks only when base state is `idle`.
- `movementStyle`:
  - `random` — 1–3 s pauses, occasional direction changes (constants: `RW_PAUSE_MIN/MAX_MS = 1000/3000`, `RW_TURN_MIN/MAX_MS = 1500/4000`).
  - `pacing` — constant 50 px/s, wraps at screen edge.

User-initiated drag pauses auto-walk for `USER_DRAG_PAUSE_MS = 1500` after release.

Drag/fall/land sequence:

1. Mouse-down on mascot → `overlayState = 'dragging'`, movement paused.
2. Release:
   - If `posY > floor + FLOOR_THRESHOLD` (1.5 px) → ease toward floor with `FLOOR_EASE = 0.18` per tick, `overlayState = 'falling'`.
   - Otherwise → straight to `overlayState = 'landed'`.
3. On reaching floor → `overlayState = 'landed'` for `LANDED_DURATION_MS = 280`, then cleared.

## Settings persistence

Path: `~/Library/Application Support/gaya/settings.json`.

Persisted keys:

- `movementWhen` (`always | idle | off`)
- `movementStyle` (`random | pacing`)
- `clickThrough` (boolean)
- `externalPackPaths` (array of absolute folder paths registered via Tray → "Add Pack from Folder…"; missing paths at startup are logged and skipped silently, but kept in the file so the registration survives a temporarily-unavailable disk)

Pack selection is **not** persisted — startup always uses the hardcoded `PREFERRED_DEFAULTS` order in `main.js` (currently prefers `grave-ghost`, then `pop`, then `classic`, then the first discovered pack).

## Hooks integration

`hooks/on-*.sh` are **Claude Code hooks**, not Electron hooks. Each script POSTs to gaya's `/state` endpoint with `curl --max-time 1 || true`, so a missing or dead gaya never blocks Claude Code. Payloads are parsed in Python (no `jq` dependency).

| Script | State posted |
|---|---|
| `on-session-start.sh` | `idle` (spawns mascot window) |
| `on-user-prompt-submit.sh` | `thinking` |
| `on-pre-tool-use.sh` | `working` |
| `on-post-tool-use.sh` | `working` |
| `on-notification.sh` | `waiting` (with `message`) |
| `on-stop.sh` | `done` |
| `on-session-end.sh` | `idle` with `session_end: true` |

Installation is handled exclusively by `scripts/install-hooks.js`:

- Merges absolute hook paths into `~/.claude/settings.json` under `hooks[]`.
- Idempotent (won't re-add existing entries).
- Backs up the previous `settings.json` with a timestamp before writing.
- Supports `--dry-run` and `--uninstall`.

## Build-time gotcha

`scripts/postinstall.js` runs on `npm install` and copies `node_modules/lottie-web/dist/lottie.min.js` into `renderer/vendor/`. The Lottie renderer fails at runtime without it. If you reproduce a Lottie issue and `renderer/vendor/lottie.min.js` is absent, re-run `npm install` first.
