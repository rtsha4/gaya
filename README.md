# desktopi

A small always-on-top desktop mascot (Electron, macOS) that animates in response
to Claude Code agent state. Claude Code hooks POST state updates to a local
HTTP server running inside the app, and a transparent window shows the mascot
reacting (idle / thinking / working / waiting / done / error). The current
state is also shown as a small speech bubble next to the mascot.

**Multi-session support**: desktopi shows one mascot per active Claude Code
session. Each `session_id` seen on the HTTP server gets its own transparent
window, with a small label below the mascot showing the project name (the
basename of the session's `cwd`). A built-in default mascot is always present
so manual `curl` tests still work.

## Setup

```bash
npm install
npm start
```

The default window appears in the bottom-right of the primary display. There
is no Dock icon — use the Tray menu (the `🤖` in the menu bar) to Quit, Reset
Position, or toggle Click-through. New session mascots arrive to the left of
the default mascot (220px stride, wrapping to a new row if a wide screen
fills up).

Drag the mascot by clicking anywhere on it. While you drag (and for ~1.5s
after release), automatic walking is paused so the mascot does not fight
your input; on resume it eases smoothly back down to the floor.

### Overlay states (`dragging`, `falling`, `landed`)

While dragging — and for a brief moment afterwards — the renderer overlays
one of three states on top of the underlying realState (`idle`, `working`,
…). The sequence is:

1. **`dragging`** — the user is holding the window. Activated on the first
   user-driven `move` event and held until release (a 200ms gap between
   user moves declares the drag finished).
2. **`falling`** — on release, if the window is above the floor the
   overlay flips to `falling` while the tick loop eases the window back
   down. If the window is already on the floor (within `FLOOR_THRESHOLD`),
   `falling` is skipped entirely and we go straight to `landed`.
3. **`landed`** — the moment posY reaches the floor we play a short
   squash pose for `LANDED_DURATION_MS` (~280ms), then clear the overlay.

If the user re-grabs the mascot during `falling` or `landed`, all pending
overlay timers are torn down and the overlay snaps back to `dragging`.

The realState keeps progressing in the background throughout the entire
sequence — the `done -> idle` 2.5s timer keeps running, etc. — and the
moment the overlay clears, the visual snaps back to whatever realState
has become. Automatic walking is paused for the entire overlay sequence
so the walk animation doesn't fight the overlay.

Packs can opt in to custom looks for any of the three overlay states:

- `svg` packs: define
  `.mascot[data-pack="<id>"].state-dragging`,
  `.mascot[data-pack="<id>"].state-falling`, and
  `.mascot[data-pack="<id>"].state-landed`
  selectors in `pack.css`. Without those, the pack falls back to its
  current realState appearance.
- `image` / `lottie` packs: add `"dragging"`, `"falling"`, and/or
  `"landed"` entries under `manifest.states`. Without one, the renderer
  falls back to the realState's asset (or `fallbackState`).

You can hide every mascot into the menu bar via Tray menu → `Hide Mascots`
(left-clicking the Tray icon also toggles show/hide for all of them — Hide /
Show is applied globally; per-session hide is not exposed in v1). The Tray
emoji reflects the highest-priority state across all sessions
(`error > waiting > working > thinking > done > idle`), with an `×N` suffix
when more than one session is active (e.g. `⚙️×3`). The Tray's `Sessions`
submenu lists every active session as `<displayName> · <state>`.

## Movement (walking around the dock)

The mascot can walk back and forth along the bottom of the primary display
(on top of the Dock). Configure it from Tray menu → `Movement`:

- **When**: `Always` (walks in every state) / `Idle only` (walks only while
  the agent is idle; default) / `Off` (no automatic motion).
- **Style**: `Random walk` (random direction changes and 1–3s pauses;
  default) / `Pacing` (steady left/right loop, reverses at screen edges).

Selections persist across restarts. Click-through is also persisted now;
character pack selection is intentionally not persisted (still always boots
on the default).

Settings are stored at `~/Library/Application Support/desktopi/settings.json`
(macOS).

## Character Packs

The mascot's visuals are loaded from a "character pack" — a folder under
`assets/characters/<id>/` containing three files:

```
assets/characters/
  pop/
    manifest.json
    mascot.svg
    pack.css
  classic/
    manifest.json
    mascot.svg
    pack.css
```

Switch between installed packs from the Tray menu → `Character` (radio
selection). The default at launch is `pop`, falling back to `classic`. The
selection is **not** persisted across restarts — it always starts on the
default.

キャラクターを自作したい場合は [docs/animation-guide.md](docs/animation-guide.md) を参照。

### Adding a new pack

1. Create a new folder `assets/characters/<your-id>/`.
2. Add `manifest.json`, `mascot.svg`, and `pack.css` (see below).
3. Restart the app — the Tray's `Character` submenu will list it.

That is the entire install path: drop a folder in, restart.

### `manifest.json`

Required keys: `id`, `name`. Everything else is optional and defaults are
applied by the loader.

```json
{
  "id": "pop",
  "name": "Pop",
  "version": "1.0.0",
  "renderer": "svg",
  "viewBox": "0 0 200 200",
  "size": { "width": 200, "height": 200 },
  "bubble": {
    "anchor": "top-right",
    "offsetX": -8,
    "offsetY": -6
  },
  "defaultState": "idle"
}
```

- `bubble.anchor` accepts `"top-right"`, `"top-left"`, or `"top"`.
- `renderer` accepts `"svg"` (default — backwards compatible), `"image"`,
  or `"lottie"`. See **Pack renderer types** below.

### Pack renderer types

A pack declares how it wants to be drawn via the `renderer` key in its
manifest. The default (and what `pop` / `classic` use) is `svg` — packs
authored before this key existed continue to work unchanged.

#### `renderer: "svg"` (default)

Files: `manifest.json`, `mascot.svg`, `pack.css`.

A single SVG with state-class-driven animations in CSS. This is the most
flexible option and what the bundled `pop` / `classic` packs use. See the
sections below for `mascot.svg` and `pack.css` conventions.

#### `renderer: "image"`

Files: `manifest.json`, per-state image files (any of GIF, APNG, PNG, WEBP,
SVG — anything `<img>` can decode), and an optional `pack.css`.

```json
{
  "id": "my-image-pack",
  "name": "My Image Pack",
  "renderer": "image",
  "size": { "width": 200, "height": 200 },
  "bubble": { "anchor": "top-right" },
  "defaultState": "idle",
  "fallbackState": "idle",
  "states": {
    "idle":     "states/idle.gif",
    "thinking": "states/thinking.gif",
    "working":  "states/working.gif",
    "waiting":  "states/waiting.gif",
    "done":     "states/done.gif",
    "error":    "states/error.gif"
  }
}
```

- Paths are relative to the pack folder.
- A missing state falls back to `fallbackState` (default `"idle"`).
- The renderer uses a single `<img class="mascot" data-pack="...">`. State
  classes (`state-<name>`) are applied to the `<img>`, so `pack.css` can
  e.g. tweak filters / drop-shadows per state.
- Optional `"dragging"`, `"falling"`, and `"landed"` entries under
  `states` can be added for the overlay visuals; any omitted overlay
  falls back to the `fallbackState` asset.
  `assets/characters/example-image/` ships minimal demo
  `dragging.svg` / `falling.svg` / `landed.svg`.
- Limitation: `<img>` cannot apply external CSS animations to GIF/APNG
  internals — it just plays the encoded frames.

#### `renderer: "lottie"`

Files: `manifest.json`, per-state Lottie JSON files, and an optional
`pack.css`.

```json
{
  "id": "my-lottie-pack",
  "name": "My Lottie Pack",
  "renderer": "lottie",
  "size": { "width": 200, "height": 200 },
  "bubble": { "anchor": "top-right" },
  "defaultState": "idle",
  "fallbackState": "idle",
  "states": {
    "idle":     "lottie/idle.json",
    "thinking": "lottie/thinking.json",
    "working":  "lottie/working.json",
    "waiting":  "lottie/waiting.json",
    "done":     "lottie/done.json",
    "error":    "lottie/error.json"
  }
}
```

- Paths are relative to the pack folder.
- main reads and parses each JSON, then ships them to the renderer over IPC
  (sandbox + `file://` blocks `fetch` from the renderer side).
- The renderer hosts one `lottie.loadAnimation` instance at a time and
  destroys / recreates it on every state change.
- A missing or unparsable state falls back to `fallbackState`. You can
  add optional `"dragging"`, `"falling"`, and `"landed"` entries to the
  `states` map for custom overlay animations; with no entry the renderer
  keeps showing realState's animation through that overlay phase.
- See `assets/characters/example-lottie/` for a working sample (minimal
  hand-written Lottie JSON — color/shape varies per state).
- Limitations: external file references inside the Lottie JSON (e.g. image
  assets in `assets[]`) are not supported — the renderer only sees the
  JSON, no companion files. Only the `svg` lottie renderer is enabled.

#### lottie-web setup

Lottie support depends on `lottie-web`, which is declared as a runtime
dependency. After `npm install`, a `postinstall` script copies
`node_modules/lottie-web/build/player/lottie.min.js` to
`renderer/vendor/lottie.min.js` so the renderer can `<script src>` it
without `fetch()`. If this file is missing, `svg` and `image` packs still
work and lottie packs just show an error in the speech bubble.

### `mascot.svg`

A single SVG with `class="mascot"` on the root `<svg>`. Include all the
state-specific decorations you need (thinking dots, gear, "!", "✓", hearts,
etc.) and let `pack.css` show/hide them based on the state class on the root.

### `pack.css` selector convention

Every selector **must** be scoped under `.mascot[data-pack="<your-id>"]`. The
loader sets that attribute on the injected `<svg>` so multi-pack runtime
swaps cannot leak rules across packs:

```css
.mascot[data-pack="pop"] .body { fill: #ffd6a5; }
.mascot[data-pack="pop"].state-thinking .think { opacity: 1; }
```

To avoid `@keyframes` name collisions across packs, prefix yours (e.g.
`pop-breathe`, `classic-hop`).

In addition to the six realStates, the renderer applies one of three
overlay state classes (`state-dragging`, `state-falling`, `state-landed`)
to the mascot root during the drag sequence. Define
`.mascot[data-pack="<your-id>"].state-dragging`,
`.mascot[data-pack="<your-id>"].state-falling`, and
`.mascot[data-pack="<your-id>"].state-landed` rules to give your pack
custom looks for "held up", "in the air", and "squashed on landing".
If you don't define them, no harm done — the mascot just keeps showing
its previous realState animation through that phase. See the **Overlay
states** section above for the full state machine.

### Speech bubble

The status text is shown as a speech bubble whose anchor is taken from the
manifest. If the state update has a `message` field, that is shown verbatim;
otherwise a Japanese label per state is used (`待機中` / `考え中…` /
`作業中` / `確認待ち` / `完了！` / `エラー`).

## Multi-session behaviour

- The HTTP `POST /state` endpoint accepts an optional `session_id` (and `cwd`)
  in the request body. The bundled `hooks/on-*.sh` scripts read those values
  from the JSON Claude Code passes on stdin and forward them automatically.
- Any new `session_id` POSTed for the first time spawns a fresh mascot
  window. The renderer shows a small label under the mascot with the
  project name (basename of `cwd`); long names are truncated at 16 chars.
- A built-in `__default__` session is always present and is the target of
  any POST that omits `session_id`. The default mascot has no label and is
  never auto-evicted.
- **Cap**: at most **6** mascot windows. When a 7th session arrives, the
  oldest non-default session is evicted (its window is destroyed).
- **Idle timeout**: a session with no activity for **15 minutes** is
  evicted automatically (checked once per minute). The default session is
  exempt.
- **SessionEnd**: when Claude Code's `SessionEnd` hook fires, the mascot
  stays visible for ~2.5s as a farewell beat, then the window is destroyed.
- **Tray actions** (`Character`, `Movement`, `Reset Position`,
  `Click-through`, `Hide / Show`) are applied to **every** mascot at once.
  `Reset Position` re-lays out all mascots from the right edge of the
  display. `Toggle DevTools` opens DevTools for the default session window.

You can verify a hook locally without Claude Code by piping a synthetic
event:

```bash
echo '{"session_id":"abc123","cwd":"/tmp/proj","tool_name":"Bash"}' \
  | hooks/on-pre-tool-use.sh
```

The script always exits 0; if desktopi is running you'll see a new mascot
labelled `proj` slide in next to the default one.

## hooks のインストール／アンインストール

`~/.claude/settings.json` に hooks 設定をマージするスクリプトを同梱しています。

```bash
npm run install-hooks
```

これで `~/.claude/settings.json` にこのリポジトリの `hooks/on-*.sh` への
絶対パスが追記されます。既存の設定はタイムスタンプ付きで
`~/.claude/settings.json.backup-YYYYMMDD-HHMMSS` にバックアップされ、他人の
hook エントリは保持されます。すでに同じ command が登録されていれば再追加
されません（冪等）。

```bash
npm run install-hooks -- --dry-run    # 何が変更されるか確認だけ
npm run uninstall-hooks               # 取り外し
npm run uninstall-hooks -- --dry-run  # 取り外し内容の確認だけ
```

スクリプトは Node 標準モジュールのみで動くので、追加の依存は不要です。
プロジェクトを移動した場合は、`npm run uninstall-hooks` してから移動先で
もう一度 `npm run install-hooks` してください（絶対パスが書き換わります）。

### Enable Claude Code hooks (manual alternative)

If you'd rather merge by hand, the legacy snippet is still in
`hooks/claude-settings-snippet.json` — copy the `hooks` key into
`~/.claude/settings.json` and `chmod +x hooks/*.sh`.

## Quick check

With `npm start` running, verify the HTTP server is reachable and the mascot
reacts:

```bash
# Health
curl http://127.0.0.1:39999/health

# Drive the default mascot manually (no session_id => __default__)
curl -X POST -H 'Content-Type: application/json' \
  -d '{"state":"thinking"}' \
  http://127.0.0.1:39999/state

curl -X POST -H 'Content-Type: application/json' \
  -d '{"state":"working"}' \
  http://127.0.0.1:39999/state

curl -X POST -H 'Content-Type: application/json' \
  -d '{"state":"done"}' \
  http://127.0.0.1:39999/state

# Spawn a second mascot for a fake session
curl -X POST -H 'Content-Type: application/json' \
  -d '{"state":"working","session_id":"demo","cwd":"/tmp/demo"}' \
  http://127.0.0.1:39999/state

# Retire that mascot (waits 2.5s before destroying the window)
curl -X POST -H 'Content-Type: application/json' \
  -d '{"state":"idle","session_id":"demo","session_end":true}' \
  http://127.0.0.1:39999/state
```

Valid states: `idle`, `thinking`, `working`, `waiting`, `done`, `error`.
`done` auto-returns to `idle` after ~2.5s.

## Troubleshooting

- **Port conflict**: the server tries `39999`→`40010` in order. If none are
  free, it will log an error on stdout and hooks will silently no-op. Check
  the Tray menu — the first label shows the bound port.
- **Hooks don't hit the server**: hooks use `curl --max-time 1 || true` so
  they never block Claude Code. If the app isn't running, nothing happens —
  by design.
- **Not on top of a fullscreen app**: macOS Panel + `screen-saver` level
  normally handles this, but some games/spaces can still cover it. Toggle
  to another Space and back, or restart the app.
- **Can't click through to desktop icons behind the mascot**: Tray menu →
  `Click-through: ON`.
- **Mascot position is off-screen after display changes**: Tray menu →
  `Reset Position`.
