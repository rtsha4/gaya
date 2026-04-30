---
name: pack-template
description: Generate a new desktopi character pack scaffold under assets/characters/<id>/ with a working manifest.json, pack.css, and renderer-specific starter files. Use this whenever the user asks to create, scaffold, bootstrap, copy, or template a new character pack / mascot / キャラクターパック / マスコット, or mentions adding a pack to desktopi/gaya. Supports SVG (default), image, and lottie renderers, and pre-scopes CSS so it won't leak into other packs.
---

# pack-template

新しいキャラクターパックの雛形を `assets/characters/<id>/` に生成するスキル。テンプレートはこのスキルの `templates/<renderer>/` 以下にあり、プレースホルダー `__PACK_ID__` / `__PACK_NAME__` を置換しながらコピーする。

## 何を作るか

renderer に応じて以下を出力する：

| renderer | 生成物 |
|---|---|
| `svg` (既定) | `manifest.json`, `mascot.svg`, `pack.css` — 9 状態すべてのフックが入った完動テンプレート |
| `image` | `manifest.json`, `pack.css`, `states/` フォルダ（中身は空、ユーザーが画像を入れる） |
| `lottie` | `manifest.json`, `pack.css`, `lottie/` フォルダ（中身は空、ユーザーが JSON を入れる） |

生成された SVG パックはそのままアプリに認識され、全状態が壊れずに表示できる状態になっていること。これが守れないテンプレートは出力しない。

## 起動時に確認すること

ユーザーから次のうち**指定されていないもの**を聞く：

1. **`id`** （必須）ディレクトリ名にもなる識別子。`^[a-z0-9][a-z0-9_-]*$` を満たすこと
2. **`name`** （任意）Tray メニュー表示名。省略時は id を Title Case 化（`my-pack` → `My Pack`）
3. **`renderer`** （任意）`svg` / `image` / `lottie` のいずれか。省略時は `svg`
4. **`bubble.anchor`** （任意）`top-right` / `top-left` / `top`。省略時は `top-right`

ユーザーが最初の発話でこれらを十分に示している場合は追加質問せずに進める。例：「`hopping-cat` という SVG パック作って」→ id と renderer は確定、name は `Hopping Cat`、anchor はデフォルト、これだけで生成して良い。

## 実行手順

### 1. 検証

- カレントディレクトリ（または明示されたプロジェクトルート）の `assets/characters/` が存在することを確認。無ければ desktopi のルートではない可能性があるので、ユーザーに確認する
- `assets/characters/<id>/` がすでに存在する場合は **既存パックを上書きしない**。別 id を提案するか、上書き許可をユーザーから明示的に得る
- id が `__PACK_ID__` のようなプレースホルダー文字列になっていないこと、命名規則に違反していないことを確認

### 2. テンプレートのコピーと置換

このスキルディレクトリの `templates/<renderer>/` 以下を `assets/characters/<id>/` に再帰的にコピーする。コピー時、テキストファイル（`*.json`, `*.svg`, `*.css`, `*.md`）の中身に対して以下の置換を適用：

- `__PACK_ID__` → 実際の id
- `__PACK_NAME__` → 実際の name
- `__BUBBLE_ANCHOR__` → 実際の anchor（`top-right` / `top-left` / `top`）

置換は単純な文字列リプレースで十分。Read → 置換 → Write の手順で行う。空ディレクトリ（`image/states/`, `lottie/lottie/`）も忘れずに作成すること。

### 3. 後処理

生成したら以下を伝える：

- 生成パスと renderer 種別
- アプリ再起動（`npm start`）で Tray の Character サブメニューに出ること
- `image` / `lottie` の場合、ユーザーが追加で配置すべきファイル（`states/idle.gif` 等）を箇条書きで提示
- Pack Preview ウィンドウ（Tray → Pack Preview…）を使うと編集しながら確認できることに軽く触れる

`README.md` のような付随ドキュメントは新規作成しない。

## 設計上の前提（迷ったときの参照）

- ウィンドウは 280×240、マスコット領域は 200×200。`viewBox="0 0 200 200"` を基本とし、体の中心は `(100, 100)` 付近に置く
- `pack.css` のセレクタは **必ず `.mascot[data-pack="__PACK_ID__"]` でスコープ**する。これを破ると別パックに切り替えた時に副作用が出る
- `@keyframes` 名は **必ずパック id をプレフィックス**にする（例: `__PACK_ID__-breathe`）。グローバル名前空間で衝突するため
- 9 状態：base 6 (`idle` / `thinking` / `working` / `waiting` / `done` / `error`) + overlay 3 (`dragging` / `falling` / `landed`)。SVG テンプレートは全部にフックを用意してある
- `landed` は約 280ms しか表示されないので、`animation-fill-mode: forwards` で最終フレームを保持する形で書く
- 詳細は `docs/animation-guide.md` を参照（このスキルから読み込む必要は基本なく、テンプレート自体がガイドの内容を反映している）

## ありがちな失敗

- **置換漏れ**：`__PACK_ID__` が残っているとアプリは読み込めるが CSS が当たらない。生成後に grep で確認するのが安全
- **ディレクトリ重複作成**：`assets/characters/<id>/` の親（`assets/characters/`）の存在は必ず先に確認
- **manifest の id とディレクトリ名の不一致**：必ず一致させる。runtime はディレクトリ名で識別する
