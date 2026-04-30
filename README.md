# gaya

Claude Code の状態に反応してデスクトップに常駐するマスコット（macOS 向け Electron アプリ）。Claude Code の hooks がローカル HTTP サーバーへ状態を POST すると、透明ウィンドウのキャラクターが `idle` / `thinking` / `working` / `waiting` / `done` / `error` の各状態にアニメーションで反応します。アプリ名は `gaya`、リポジトリ名も `gaya` です。

## 特徴

- Claude Code の hooks 経由で状態を受け取り、キャラクターがリアルタイムに反応
- **マルチセッション対応**：1 セッション = 1 マスコット（最大 6 体、15 分で自動退去）
- **3 種類のレンダラー**：`svg` / `image`（GIF・APNG 等） / `lottie` の好きな方式でキャラを実装
- **キャラクターパック**：`assets/characters/<id>/` にフォルダを置くだけで認識／ Tray メニューから切替
- Dock に常駐して **自動歩行**（Random walk / Pacing、idle のみ／常時／オフを切替可能）
- ドラッグで持ち上げ → 落下 → 着地の **オーバーレイ演出**（dragging / falling / landed）
- メニューバーに常駐する **Tray アイコン**で全機能を制御（Dock アイコンは出ない）
- Claude Code 設定ファイル (`~/.claude/settings.json`) への hooks 自動インストール
- 一部設定（Movement、Click-through）の永続化
- macOS の `screen-saver` レベル + Panel ウィンドウで **最前面 / 全 Space に表示**

---

## クイックスタート

### 前提

- macOS（Panel ウィンドウ・`screen-saver` レベルに依存）
- Node.js 18+
- Claude Code（hooks 連携を使う場合）

### インストール

```bash
git clone git@github.com:rtsha4/gaya.git
cd gaya
npm install
npm run install-hooks
npm start
```

`npm install` の postinstall で `lottie-web` の UMD ビルドが `renderer/vendor/lottie.min.js` に配置されます（Lottie パック用）。`npm start` を実行すると、メインディスプレイ右下にデフォルトのマスコットが現れます。Dock アイコンは出ず、メニューバーの絵文字（`🤖` など）から制御します。

別ターミナルで Claude Code を起動すれば、その session_id 用に新しいマスコットが追加され、hooks 経由で状態が反映されます。

### 動作確認（curl）

`npm start` を立ち上げたまま、別ターミナルで：

```bash
# サーバーが起動しているか
curl http://127.0.0.1:39999/health

# デフォルトマスコットを動かす（session_id 省略 → __default__ 宛）
curl -X POST -H 'Content-Type: application/json' \
  -d '{"state":"thinking"}' \
  http://127.0.0.1:39999/state

curl -X POST -H 'Content-Type: application/json' \
  -d '{"state":"working"}' \
  http://127.0.0.1:39999/state

# 仮想セッションを spawn（左隣にマスコットが増える）
curl -X POST -H 'Content-Type: application/json' \
  -d '{"state":"working","session_id":"demo","cwd":"/tmp/demo"}' \
  http://127.0.0.1:39999/state

# その仮想セッションを終了（2.5s 余韻のあとウィンドウ破棄）
curl -X POST -H 'Content-Type: application/json' \
  -d '{"state":"idle","session_id":"demo","session_end":true}' \
  http://127.0.0.1:39999/state
```

有効な state は `idle` / `thinking` / `working` / `waiting` / `done` / `error`。`done` は約 2.5 秒で自動的に `idle` へ戻ります。

---

## 機能の説明

### Claude Code との連携

`npm start` 中はローカル HTTP サーバーが `127.0.0.1:39999`（ビジー時は `40010` まで順に試行）で待ち受けます。Claude Code の hooks が以下のエンドポイントへ POST すると、対応する session のマスコットが状態を切り替えます。

| エンドポイント | メソッド | 用途 |
|---|---|---|
| `/health` | GET | 稼働確認。`{ok:true, sessions:N}` を返す |
| `/state` | POST | 状態更新。下記 JSON を受け取る |

`/state` のリクエスト本文：

```json
{
  "state": "working",
  "message": "任意の補足テキスト",
  "session_id": "abc123",
  "cwd": "/path/to/project",
  "session_end": false
}
```

- `state` 必須（無効値は 400）。
- `session_id` を省略すると `__default__` セッションへルーティング。
- `cwd` の basename がマスコット下のラベルになる。
- `session_end: true`（または `event: "SessionEnd"`）でそのマスコットを退去させる。

同梱の hooks スクリプト（`hooks/on-*.sh`）は、Claude Code が stdin に渡す JSON から `session_id` / `cwd` / `message` を取り出して上記形式で POST します。Claude Code の hook イベントとの対応は次の通り：

| Claude Code イベント | スクリプト | 送信する state |
|---|---|---|
| `UserPromptSubmit` | `on-user-prompt-submit.sh` | `thinking` |
| `PreToolUse` | `on-pre-tool-use.sh` | `working` |
| `PostToolUse` | `on-post-tool-use.sh` | `working` |
| `Notification` | `on-notification.sh` | `waiting`（+ `message`） |
| `Stop` | `on-stop.sh` | `done` |
| `SessionStart` | `on-session-start.sh` | `idle`（マスコット生成のトリガ） |
| `SessionEnd` | `on-session-end.sh` | `idle` + `session_end:true` |

すべてのスクリプトは `curl --max-time 1 || true` で送信し、必ず `exit 0` するため、gaya 側が落ちていても Claude Code を阻害しません。

hooks 単体のテスト：

```bash
echo '{"session_id":"abc123","cwd":"/tmp/proj","tool_name":"Bash"}' \
  | hooks/on-pre-tool-use.sh
```

### マルチセッション

- 1 セッション 1 マスコット。`session_id` ごとに専用の透明ウィンドウが立ち上がる。
- 起動時に常設の `__default__` セッション（ラベルなし、退去しない）が必ず存在し、`session_id` を持たない POST はここに入る。
- 同時表示の上限は **6 体**。7 体目が来ると、`__default__` を除く中で最も古いセッションが退去させられる。
- **15 分**活動が無いセッションは自動退去（1 分間隔でチェック、`__default__` は対象外）。
- `SessionEnd` 受信後はおよそ **2.5 秒**だけ表示を残し、その後ウィンドウを破棄。
- マスコット下に `cwd` の basename を表示（最大 16 文字、超過は `…` で省略）。
- レイアウトは右下から左へ 220px 間隔で並び、横幅が足りなくなると上の段へ折り返す。

### キャラクターパック

`assets/characters/<id>/` にフォルダ単位で同梱されます。同梱されているのは次の 4 種：

| パック | renderer | 用途 |
|---|---|---|
| `pop` | svg | 起動時のデフォルト |
| `classic` | svg | フォールバック |
| `example-image` | image | image renderer の最小サンプル（`states/*.svg`） |
| `example-lottie` | lottie | lottie renderer の最小サンプル（`lottie/*.json`） |

切替は Tray メニュー → `Character`（ラジオ選択）。**起動毎に必ずデフォルト（`pop`）から始まり**、選択は永続化されません。

新しいパックは `assets/characters/<id>/` を追加してアプリを再起動するだけ。**自作したい場合は [docs/animation-guide.md](docs/animation-guide.md) を参照**してください（manifest スキーマ、各 renderer のファイル構成、CSS 命名規約、9 種の state 一覧などを詳説しています）。

### Movement（自動歩行）

マスコットは Dock 上を歩き回ります。Tray メニュー → `Movement` から制御：

| 設定 | 選択肢 | 既定 |
|---|---|---|
| When | `Always` / `Idle only` / `Off` | `Idle only` |
| Style | `Random walk` / `Pacing` | `Random walk` |

- **Random walk**：1〜3 秒のランダム停止を挟みつつ向きを変えながら歩く。
- **Pacing**：一定速度で左右往復。画面端で折り返す。

ドラッグ中はもちろん、ドラッグ終了から **1.5 秒**は自動歩行が停止し、解放後は床までゆっくり戻ります。`Idle only` 設定下では、状態が `idle` 以外になった瞬間に歩行が止まります。

### オーバーレイ状態（dragging / falling / landed）

ユーザーがマスコットをドラッグした瞬間、realState の上にオーバーレイ状態が乗ります：

1. **`dragging`** — ドラッグ中。最初の OS 由来の `move` イベントで点灯し、200ms 入力が途切れたら確定。
2. **`falling`** — 解放時に床より上にいた場合の落下中。ティックループで床まで補間。
3. **`landed`** — 着地直後の押しつぶされ姿勢を約 280ms 保持してからクリア。床に十分近い状態で離した場合は `falling` を飛ばして直接 `landed`。

オーバーレイ表示中も realState はバックグラウンドで進行（`done → idle` の 2.5 秒タイマー等）し、オーバーレイ解除時は最新の realState に即時スナップします。落下〜着地中に再びドラッグで掴むとオーバーレイは即 `dragging` へ戻ります。

各 renderer の対応方法：

- **svg**：`pack.css` で `.mascot[data-pack="<id>"].state-dragging` などのセレクタを定義。
- **image / lottie**：`manifest.json` の `states` に `"dragging"` / `"falling"` / `"landed"` を追加。

未指定なら直前の realState の見た目をそのまま表示するだけで、何もしなくても破綻しません。詳細は [docs/animation-guide.md](docs/animation-guide.md) を参照。

### Tray メニュー

メニューバーの絵文字をクリックするとメニューが開きます。タイトルの絵文字は全セッションを集約した最高優先度の状態を反映（`error > waiting > working > thinking > done > idle`）し、複数アクティブな場合は `⚙️×3` のような形で件数を付記します。左クリックで全マスコットの表示／非表示をトグル。

| 項目 | 説明 |
|---|---|
| `Show / Hide Mascots` | 全マスコットの表示・非表示を一括切替 |
| `Sessions` | アクティブセッション一覧（`<displayName> · <state>`、表示のみ） |
| `gaya (port NNNN)` | 待ち受け中のポート番号（表示のみ） |
| `Character` | キャラクターパックの切替（ラジオ） |
| `Movement` | When / Style の切替 |
| `Reset Position` | 全マスコットを画面右下から再配置 |
| `Click-through: ON/OFF` | クリック透過の切替（マスコット背後のアイコン等を操作したい時に） |
| `Toggle DevTools` | デフォルトセッションのウィンドウで DevTools を開閉 |
| `Quit` | アプリ終了 |

`Character` / `Movement` / `Reset Position` / `Click-through` / `Show / Hide` は **全マスコットに一括適用**されます（v1 ではセッション単位での操作は未提供）。

---

## 設定

永続化される設定は次の 1 ファイルのみ：

```
~/Library/Application Support/gaya/settings.json
```

| キー | 型 | 値 |
|---|---|---|
| `movementWhen` | string | `"always"` / `"idle"` / `"off"` |
| `movementStyle` | string | `"random"` / `"pacing"` |
| `clickThrough` | boolean | `true` / `false` |

**永続化されない**もの：

- `Character` のパック選択（毎回 `pop` で起動）
- ウィンドウ位置（`Reset Position` 時に画面右下から再計算）
- マスコットの表示・非表示状態

---

## hooks の管理

`~/.claude/settings.json` への hooks 設定マージは Node 標準モジュールのみで動く専用スクリプトが行います。

```bash
npm run install-hooks                  # 追加（冪等）
npm run install-hooks -- --dry-run     # 何が書き換わるか表示のみ
npm run uninstall-hooks                # 取り外し
npm run uninstall-hooks -- --dry-run   # 取り外し内容の表示のみ
```

スクリプトの挙動：

- `~/.claude/settings.json` が存在しなければ新規作成。あれば `~/.claude/settings.json.backup-YYYYMMDD-HHMMSS` にバックアップしてから atomic に書き換え。
- このリポジトリの `hooks/on-*.sh` への絶対パスを書き込むので、リポジトリを移動した場合は **移動前に `uninstall-hooks`、移動後に `install-hooks`** を実行する。
- 既に同じ command が登録されていれば再追加しない（冪等）。他人の hook エントリは保持。
- `hooks/*.sh` に実行ビットが無ければ自動で `chmod +x` する。

手動でマージしたい場合は `hooks/claude-settings-snippet.json` の `hooks` キーをそのままコピーしても OK。

---

## トラブルシュート

- **マスコットが見えない / 透明のまま動かない**：Tray メニュー → `gaya (port NNNN)` 行で待ち受けポートを確認（39999 が埋まっていると順に 40010 まで上がる）。`Toggle DevTools` で DevTools を開きコンソールにエラーが出ていないか確認。
- **hooks が動かない**：
  - サーバーが立ち上がっているか：`curl http://127.0.0.1:39999/health`
  - hooks 単体テスト：`echo '{"session_id":"x","cwd":"/tmp/y","tool_name":"Bash"}' | hooks/on-pre-tool-use.sh`
  - `~/.claude/settings.json` に絶対パスが書かれているか
  - hooks スクリプトに実行権限があるか（`ls -l hooks/`）
- **Lottie パックが「lottie 未読込」と表示される**：`renderer/vendor/lottie.min.js` が無い。`npm install` を再実行（`scripts/postinstall.js` がコピーする）。
- **フルスクリーンアプリの上に出ない**：Space を切替えてから戻す、もしくはアプリを再起動。
- **背後のデスクトップアイコンをクリックできない**：Tray メニュー → `Click-through: ON`。
- **画面構成変更後に位置がおかしい**：Tray メニュー → `Reset Position`。

---

## 開発 / ディレクトリ構成

```
main.js                          Electron main process（HTTP サーバー、セッション管理、Tray、Movement）
preload.js                       contextBridge（window.api）
renderer/
  index.html                     ウィンドウのレイアウト
  renderer.js                    レンダラー本体（svg / image / lottie の切替実装）
  styles.css                     パック非依存のスタイル（吹き出し・ラベル等）
  vendor/lottie.min.js           lottie-web の UMD ビルド（postinstall でコピー）
assets/characters/<id>/          キャラクターパック
hooks/
  on-*.sh                        Claude Code hook 用のスクリプト
  claude-settings-snippet.json   手動マージ用の参考スニペット
scripts/
  install-hooks.js               hooks 自動インストーラ（冪等、バックアップ付き）
  postinstall.js                 lottie-web を renderer/vendor/ にコピー
docs/
  animation-guide.md             キャラクターパック作成者向けの詳細ガイド
```

開発中の便利コマンド：

```bash
npm start          # 通常起動
npm run dev        # --inspect 付き起動（main プロセスのデバッグ）
```

---

## 関連ドキュメント

- [docs/animation-guide.md](docs/animation-guide.md) — キャラクターパックを自作する際の詳細ガイド（manifest スキーマ、各 renderer の作り方、9 種の state、CSS 命名規約など）

---

## ライセンス

MIT
