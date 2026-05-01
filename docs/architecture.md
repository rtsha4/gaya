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
- Payload (`state` and `session_id` are required; the rest are optional):

  ```json
  {
    "state": "working",
    "session_id": "abc123",
    "message": "optional bubble text",
    "cwd": "/path/to/project",
    "session_end": true,
    "event": "SessionEnd"
  }
  ```

- `state` must be one of the base states (see below).
- `session_id` is required. A missing or empty value is rejected with `400 { ok: false, error: "session_id required" }`.
- `session_end: true` or `event: "SessionEnd"` plays a 2.5 s farewell, then destroys the window.

## State machine

Two orthogonal axes combine into the visible state:

- **Base states** (driven by HTTP): `idle | thinking | working | waiting | done | error`. `done` auto-reverts to `idle` after 2.5 s.
- **Overlay states** (driven by physics): `dragging | falling | landed`. When set, the overlay wins visually; the base state continues progressing underneath.

`VALID_STATES` and `OVERLAY_STATES` are defined in `renderer/pack-renderer.js`. Every renderer applies a single `.state-<name>` class to the mascot root — packs hook visuals through these classes (see `docs/pack-format.md`).

The Tray title shows an emoji that reflects the **aggregate** state across all sessions. Priority order: `error > waiting > working > thinking > done > idle`.

## Sessions

- Keyed by `session_id`. No mascot windows exist at startup; each session is created lazily on the first POST that supplies its id.
- Cap: 6 concurrent sessions. When a 7th arrives, the session with the oldest `lastActivity` is evicted.
- Reaper: runs every 60 s, evicts sessions idle for 15 minutes.
- `session_end` triggers a 2.5 s farewell animation and then destroys the window.
- `session-info` IPC carries `{sessionId, displayName, cwd}` to the renderer. The renderer does **not** show a permanent session label; instead, while the mouse hovers the mascot, the speech-bubble text is temporarily replaced with the truncated `displayName`. When `displayName` is empty the hover swap is suppressed and the bubble keeps showing state text.

Each session carries its own `packId` and can show a different character. The initial `packId` for a new session is resolved in this order: (1) if the session was created with a known `cwd` and `cwdPackMap[cwd]` points at a registered pack, use it; (2) otherwise use `activePackId` — the Tray's *Default Character (new sessions)* radio choice. Switching `activePackId` from Tray therefore only affects future sessions; existing windows keep whatever pack they already have.

The user changes a single session's pack via Tray → **Sessions** → *<session>* → **Character**. That call goes through `switchSessionPack`, which records `cwdPackMap[session.cwd] = packId` (when the session has a cwd) and persists `settings.json`. It also sets `session.packIdLocked = true`, so a later cwd-derived auto-switch in `ensureSession` won't override the user's deliberate choice. When a session is created without a cwd and the cwd later arrives on a subsequent POST, `ensureSession` consults `cwdPackMap` and — only when `packIdLocked` is still `false` — issues a one-time `switch-pack` to bring the session to the remembered pack.

## Window layout

- Per-session window: 360×280 px, transparent, panel-type on macOS (always-on-top across Spaces, screen-saver level).
- Mascot content area: 200×200 px, centered (left-/right-aligned when the active bubble anchor is `right`/`left`, so the bubble has room to extend horizontally on the opposite side).
- Multi-mascot tiling: bottom-right anchor, 280 px stride leftward, wraps upward when the row fills.
- Click-through is a setting (see Settings).

## IPC channels

All channels live on `preload.js` and are fanned out from `main.js`. Channel names are strings; keep this table aligned with the code.

### Main → renderer (one-way)

| Channel | Payload | Notes |
|---|---|---|
| `state` | `{state, message}` | Base state update. |
| `switch-pack` | `packId` | Sent to a single session window when its `packId` changes (per-session pack switch via Tray, or a cwd-derived auto-switch when the cwd first arrives, or to align the renderer with the session's stored `packId` on `renderer-ready`). The Tray's *Default Character* radio no longer broadcasts. |
| `movement` | `{walking, direction}` | `direction` is `'left'` or `'right'`. |
| `overlay` | `{overlay}` | `overlay` is one of `'dragging' \| 'falling' \| 'landed' \| null`. |
| `session-info` | `{sessionId, displayName, cwd}` | Sent once after `renderer-ready`. |
| `bubble-position` | `{position}` | Global bubble-anchor override. `position` is one of `'auto' \| 'top-right' \| 'top-left' \| 'top' \| 'right' \| 'left'`. `'auto'` defers to the active pack's `manifest.bubble.anchor`. Sent once after `renderer-ready` and again on every Tray → Bubble Position change. |
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
- `bubblePosition` (`auto | top-right | top-left | top | right | left`; `auto` defers to the active pack's `manifest.bubble.anchor`, anything else overrides every session window)
- `clickThrough` (boolean)
- `externalPackPaths` (array of absolute folder paths registered via Tray → "Add Pack from Folder…"; missing paths at startup are logged and skipped silently, but kept in the file so the registration survives a temporarily-unavailable disk)
- `cwdPackMap` (`{ [absoluteCwd: string]: packId }`; populated by Tray → Sessions → *<session>* → Character. Lets a project re-open with the same pack on the next run. Entries pointing at a now-removed pack are cleaned up by `removeExternalPack`.)

The Tray's *Default Character (new sessions)* radio (`activePackId`) is **not** persisted — startup always uses the hardcoded `PREFERRED_DEFAULTS` order in `main.js` (currently prefers `grave-ghost`, then `pop`, then `classic`, then the first discovered pack). Per-session pack assignments **are** persisted, but indirectly: the choice is keyed by cwd in `cwdPackMap` and re-applied to a future session that opens with the same cwd.

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
