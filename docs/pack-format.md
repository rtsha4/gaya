# Character pack format reference

> **このドキュメントは現時点のパック仕様に対するリファレンスです。** マニフェストのフィールド・レンダラ種別・状態名・CSS スコープ規約・パック探索順を変更したら、その実装変更と同じコミットで本ファイルを更新してください。パックは外部からも作成されうるため、ここの記述が事実上の API になります。

## Discovery

- Packs live under `assets/characters/<id>/`.
- On startup, `main.js` walks `assets/characters/*` and reads each `manifest.json`. There is no separate registry — adding a directory with a valid manifest is sufficient.
- Startup default is chosen by the `PREFERRED_DEFAULTS` array in `main.js` (currently: `grave-ghost` → `pop` → `classic` → first discovered).
- Pack switching at runtime: Tray menu → Character submenu → click. This sends a `switch-pack` IPC to all mascot windows. **Selection is not persisted across restarts.**

## Pack id

- Must match the directory name exactly.
- Must match `manifest.id` exactly.
- Must match `^[a-z0-9][a-z0-9_-]*$` (kebab-case, lowercase).

## Manifest schema

`assets/characters/<id>/manifest.json`:

```json
{
  "id": "grave-ghost",
  "name": "Grave Ghost",
  "version": "1.0.0",
  "renderer": "svg",
  "viewBox": "0 0 200 200",
  "size": { "width": 200, "height": 200 },
  "bubble": {
    "anchor": "top-right",
    "offsetX": -8,
    "offsetY": -6
  },
  "defaultState": "idle",
  "fallbackState": "idle",
  "states": {
    "idle": "states/idle.svg",
    "thinking": "states/thinking.svg",
    "working": "states/working.svg",
    "waiting": "states/waiting.svg",
    "done": "states/done.svg",
    "error": "states/error.svg"
  }
}
```

| Field | Required | Default | Notes |
|---|---|---|---|
| `id` | yes | — | Must equal the directory name. |
| `name` | yes | — | Human-readable label shown in the Tray menu. |
| `version` | recommended | — | Free-form. |
| `renderer` | no | `"svg"` | One of `svg \| image \| lottie`. |
| `viewBox` | svg only | — | Standard SVG viewBox string. |
| `size` | recommended | `{200, 200}` | Mascot content area in pixels. |
| `bubble.anchor` | no | `"top-right"` | One of `top-right \| top-left \| top`. |
| `bubble.offsetX` / `offsetY` | no | `0` | Pixel offset for the speech bubble. |
| `defaultState` | no | `"idle"` | Starting state when the renderer mounts. |
| `fallbackState` | no | `"idle"` | Used by `image` / `lottie` renderers when a state's asset is missing. Ignored by `svg`. |
| `states` | image / lottie | — | Map of base-state name → relative asset path. SVG packs do not need this. |

Base states: `idle | thinking | working | waiting | done | error`. Overlay states (`dragging | falling | landed`) are styled via CSS, not declared in the manifest.

## Renderer types

### SVG (`renderer: "svg"`)

- `mascot.svg` — single SVG file containing all state visuals. The renderer mounts it once.
- `pack.css` — required. Visual changes between states are driven by `.state-<name>` classes that the renderer applies to the mascot root.
- No `states` map needed.

### Image (`renderer: "image"`)

- One file per state under `states/<state>.<ext>`. Supported extensions: `.svg`, `.png`, `.gif`, `.apng`, `.webp`.
- `manifest.states` maps each base state to its relative path.
- The renderer swaps the `<img>` `src` when the state changes.
- If a requested state has no entry, falls back to `fallbackState`.

### Lottie (`renderer: "lottie"`)

- One Lottie JSON per state under `lottie/<state>.json`.
- `manifest.states` maps each base state to its relative path.
- The renderer plays the corresponding animation via `lottie-web` (loaded from `renderer/vendor/lottie.min.js`, populated by `scripts/postinstall.js`).
- If a requested state has no entry, falls back to `fallbackState`.

## CSS scoping (load-bearing)

All packs share the same DOM and the same stylesheet scope. CSS without proper scoping **will silently break other packs**. Two rules:

1. **Selector prefix.** Every selector must be scoped by the pack id:

   ```css
   .mascot[data-pack="grave-ghost"] .body { /* ... */ }
   .mascot[data-pack="grave-ghost"].state-thinking .eye { /* ... */ }
   ```

2. **Keyframe namespacing.** Every `@keyframes` name must be prefixed with the pack id:

   ```css
   @keyframes grave-ghost-breathe { /* ... */ }

   .mascot[data-pack="grave-ghost"] .body {
     animation: grave-ghost-breathe 2s ease-in-out infinite;
   }
   ```

Existing packs follow this pattern; copy them when in doubt.

## State class hooks

The renderer applies a single `.state-<name>` class to the mascot root and updates it on every state change. Both base and overlay states use this convention. CSS hooks look like:

```css
.mascot[data-pack="grave-ghost"].state-idle    { /* ... */ }
.mascot[data-pack="grave-ghost"].state-working { /* ... */ }
.mascot[data-pack="grave-ghost"].state-dragging{ /* overlay */ }
.mascot[data-pack="grave-ghost"].state-landed  { /* overlay */ }
```

Overlay state takes visual precedence; the underlying base-state class is replaced for the duration of the overlay.

## Bubble

The speech bubble is rendered by the host (not the pack). `bubble.anchor` and `bubble.offsetX/Y` in the manifest position it relative to the mascot box. Bubble text is supplied by the HTTP `message` field, or the built-in Japanese label table when `message` is absent.

## Scaffolding

Use the `pack-template` skill (`.claude/skills/pack-template/`) to generate a new pack directory for the chosen renderer. It produces a working `manifest.json`, a renderer-appropriate skeleton, and a `pack.css` that already follows the scoping rules above.
