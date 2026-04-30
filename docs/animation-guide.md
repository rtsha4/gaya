# gaya キャラクターパック作成ガイド

このドキュメントは、gaya に独自キャラクターを追加したい人のための実装ガイドです。同梱の `pop` / `classic` パックを参考にしつつ、最低限ここに書かれていることだけ押さえれば自分のパックを作り始められます。

---

## 1. はじめに

gaya はキャラクターの見た目を **「キャラクターパック」** という単位で差し替えできるようになっています。パックは `assets/characters/<id>/` ディレクトリ単位で管理され、起動中に Tray メニュー → `Character` から切り替えできます。

### どんなキャラが作れるか

`manifest.json` の `renderer` キーで描画方式を 3 種類から選べます。

| renderer | 概要 | 必要なファイル |
|---|---|---|
| `svg` (デフォルト) | 1 枚の SVG に全状態の要素を内包し、CSS で見た目を切り替える | `mascot.svg`, `pack.css` |
| `image` | state ごとに 1 ファイル（GIF / APNG / PNG / WEBP / SVG） | 各 state のファイル群 |
| `lottie` | state ごとに 1 つの Lottie JSON | 各 state の JSON ファイル群 |

### 最低限知っておくこと

- パックは `assets/characters/<id>/` に置く（**フォルダ単位**で完結）
- `manifest.json` だけは必須。他は renderer 種別による
- 切替は **Tray → Character** から（再起動するとフォルダが再スキャンされる）
- パック切替は永続化されない。起動時は常に `pop`（無ければ `classic`、それも無ければ最初に見つかったパック）から始まる

---

## 2. パックの構成

### フォルダ構造

renderer ごとに必要なファイル構成が異なります。

```
# svg パック
assets/characters/<id>/
  manifest.json
  mascot.svg
  pack.css        (任意だが実質必須)

# image パック
assets/characters/<id>/
  manifest.json
  pack.css        (任意)
  states/
    idle.gif
    thinking.gif
    ...

# lottie パック
assets/characters/<id>/
  manifest.json
  pack.css        (任意)
  lottie/
    idle.json
    thinking.json
    ...
```

### 共通 `manifest.json` スキーマ

```json
{
  "id": "my-pack",
  "name": "My Pack",
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

| キー | 必須 | 説明 |
|---|---|---|
| `id` | はい | パック識別子。ディレクトリ名と一致させること（英数 / `_` / `-` のみ） |
| `name` | 推奨 | Tray メニューに出る表示名。省略時は `id` |
| `renderer` | 任意 | `"svg"` / `"image"` / `"lottie"`。省略時は `"svg"` |
| `viewBox` | svg | SVG の `viewBox`（実体は `mascot.svg` 側でセット） |
| `size` | 任意 | 想定描画サイズ。実際のレイアウトは `200×200` 前提 |
| `bubble.anchor` | 任意 | `"top-right"` / `"top-left"` / `"top"` のいずれか |
| `defaultState` | 任意 | `"idle"` 推奨 |
| `fallbackState` | image/lottie | 該当 state が無いときに代替表示する state（省略時 `"idle"`） |
| `states` | image/lottie | state 名 → ファイル相対パスのマップ |

### `pack.css` の役割と命名規約

`pack.css` は、**パック切替時に動的に差し替えられる単一の `<style>`** です。差し替え時の漏れを防ぐため、必ず以下のルールを守ってください。

- **すべてのセレクタを `.mascot[data-pack="<id>"]` でスコープ**する
  - これは renderer がルート要素に `data-pack` 属性を付けるため、安全に名前空間を切れる仕組み
- **`@keyframes` 名にプレフィックスを付ける**（例: `pop-breathe`, `classic-spin`）
  - グローバル名前空間なのでパック間で衝突する

```css
/* OK: data-pack でスコープされている */
.mascot[data-pack="pop"] .body { fill: #ffd6a5; }
.mascot[data-pack="pop"].state-thinking .think { opacity: 1; }

/* NG: 全パックに漏れる */
.body { fill: #ffd6a5; }
.state-thinking .think { opacity: 1; }
```

---

## 3. 状態（State）一覧

gaya は **base state**（main.js が POST する 6 種）と **overlay state**（ユーザー操作で発火する 3 種）を持ちます。

| state | 種別 | 発火条件 | 推奨アニメ |
|---|---|---|---|
| `idle` | base | 待機（POST 'idle' / SessionStart / `done` 自動復帰） | ゆったり呼吸・瞬き |
| `thinking` | base | UserPromptSubmit | 考え込む / 目キョロキョロ |
| `working` | base | PreToolUse / PostToolUse | ぴょこぴょこ / 元気な動き |
| `waiting` | base | Notification | 注意を引く / 点滅 |
| `done` | base | Stop（2.5 秒後 `idle` に自動復帰） | 嬉しい / 達成感 |
| `error` | base | （手動 POST のみ） | 困り顔 / プルプル |
| `dragging` | overlay | ユーザーがドラッグ中 | 驚き / 持ち上げられた感 |
| `falling` | overlay | リリース後、床に向かって落下中 | 落ちてる感 / 風に煽られる |
| `landed` | overlay | 床に着地した瞬間（約 280ms） | ペシャっと潰れる / 着地ポーズ |

### base state と overlay state の違い

- **base state** は `realState` として常に裏で進行している（例: `done` の 2.5 秒タイマーなど）
- **overlay state** は active な間、base state を一時的に上書きする
  - overlay が解除されると、その時点の base state にスナップで戻る
- overlay 中は自動歩行も停止する（歩行アニメと overlay が競合しないように）

### フォールバック規則

overlay state（`dragging` / `falling` / `landed`）が pack に定義されていない場合：

- **svg パック**: `state-dragging` 等のセレクタが存在しなければ何も上書きされず、直前の base state の見た目のまま
- **image / lottie パック**: `manifest.states` にエントリが無ければ `fallbackState` の素材で表示される（壊れない）

つまり overlay は **「定義しなければ何も起きない」**。気にしなくても基本動作は壊れません。

---

## 4. SVG パックの作り方

最も柔軟で、`pop` / `classic` で採用されている方式です。

### 基本構造

1 枚の `mascot.svg` に全状態の装飾要素（思考バブル、歯車、ハート、涙など）を含めておき、CSS で `opacity` や `animation` を state クラスに応じて切り替えます。

```svg
<svg class="mascot" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <!-- 影（床に落とす影） -->
  <ellipse class="shadow" cx="100" cy="172" rx="48" ry="7" />

  <!-- 体まわり（呼吸・ジャンプなどでまとめて動かす単位） -->
  <g class="body-group">
    <circle class="body" cx="100" cy="100" r="62" />
    <g class="eyes"> ... </g>
    <path class="mouth" d="..." />
    <!-- 状態ごとの装飾（普段は opacity: 0、state-* クラスで表示） -->
    <g class="eyes-surprise"> ... </g>
    <g class="eyes-sad"> ... </g>
    <ellipse class="mouth-o" .../>
  </g>

  <!-- thinking 時に表示する「？」 -->
  <g class="think"> ... </g>

  <!-- waiting 時に表示する「！」 -->
  <g class="bang"> ... </g>

  <!-- done 時のお祝いハート / 星 -->
  <g class="celebrate"> ... </g>
</svg>
```

renderer は読み込み時に root の `<svg>` に `class="mascot"` と `data-pack="<id>"` を付与し、state が変わるたびに `state-<name>` クラスを差し替えます。

### state ごとの切替（CSS）

```css
/* 装飾類は普段は不可視 */
.mascot[data-pack="myid"] .think,
.mascot[data-pack="myid"] .bang,
.mascot[data-pack="myid"] .celebrate {
  opacity: 0;
  pointer-events: none;
  transition: opacity 200ms ease;
}

/* idle: ゆったり呼吸 */
.mascot[data-pack="myid"].state-idle .body-group {
  animation: myid-breathe 3.6s ease-in-out infinite;
  transform-origin: 100px 140px;
}
@keyframes myid-breathe {
  0%, 100% { transform: translateY(0) scale(1, 1); }
  50%      { transform: translateY(-3px) scale(1.025, 0.975); }
}

/* thinking: ?を出す */
.mascot[data-pack="myid"].state-thinking .think {
  opacity: 1;
}
```

### `transform-origin` と左向き反転

歩行時は `mascot-wrap.facing-left` クラスが付くと、styles.css の以下のルールが効いて mascot 全体が水平反転されます：

```css
.mascot-wrap.facing-left .mascot {
  transform: scaleX(-1);
  transform-origin: 50% 50%;
}
```

注意点：

- 体の中身に **絶対座標で `transform` をかける場合**、`transform-origin` を必ず明示すること（SVG 内では `transform-box: fill-box` も併用すると楽）
- 歩行時に `scaleX(-1)` と `pack-walk` のような追加 transform を **同時にかけたい場合**、`facing-left` 用の keyframes を別に書く必要がある（`pop` 参照）

```css
/* 通常歩行: 上下のバウンドだけ */
.mascot-wrap.walking .mascot[data-pack="pop"] {
  animation: pop-walk 0.45s ease-in-out infinite;
}
@keyframes pop-walk {
  0%, 100% { transform: translateY(0); }
  50%      { transform: translateY(-2px); }
}

/* facing-left の時は scaleX(-1) と合成 */
.mascot-wrap.walking.facing-left .mascot[data-pack="pop"] {
  animation: pop-walk-left 0.45s ease-in-out infinite;
}
@keyframes pop-walk-left {
  0%, 100% { transform: scaleX(-1) translateY(0); }
  50%      { transform: scaleX(-1) translateY(-2px); }
}
```

### state クラスの排他性と overlay の上書き

- 一度に root に付く `state-*` クラスは **常に 1 つだけ**（renderer 側で前のものを必ず外してから付ける）
- overlay 中（`dragging` / `falling` / `landed`）は base state の代わりに `state-dragging` などが付く
- これにより `pop` の例では「`state-working` の歯車・スパークルは overlay 中は自動で消える」（`state-working` クラスが外れるため、デフォルトの `opacity: 0` に戻る）

### landed のように 1 回だけ再生して止める

`landed` は約 280ms しか表示されないため、**「アニメを 1 回再生して最終フレームで止める」** のがおすすめです。

```css
.mascot[data-pack="pop"].state-landed .body-group {
  animation: pop-squash 0.3s ease-out 1;
  transform-origin: 100px 170px;
  animation-fill-mode: forwards;   /* ← 最終フレームで止める */
}
@keyframes pop-squash {
  0%   { transform: scale(0.9, 1.15) translateY(-4px); }
  35%  { transform: scale(1.18, 0.78) translateY(10px); }
  70%  { transform: scale(1.15, 0.85) translateY(8px); }
  100% { transform: scale(1.15, 0.85) translateY(8px); }
}
```

### やってはいけないこと

- **グローバルに影響するセレクタ**（`.body { ... }` のようにスコープ無し）
  - 切替時に他パックの要素に効いてしまう
- **`@keyframes` 名の衝突**
  - パック間で同じ名前を使うと、後勝ちで予期しない動きになる
- **`position: fixed` などレイアウトを破壊する CSS**
  - styles.css 側のレイアウト（`.stage` / `.mascot-wrap` / `.bubble` の位置関係）を壊さないこと
- **吹き出しやラベルの位置にマスコットの体を被せる**（後述）

---

## 5. Image パックの作り方

state ごとに 1 ファイル（GIF / APNG / PNG / WEBP / SVG）を用意する方式です。アニメーションは画像ファイル自体に含める前提です。

### `manifest.json`

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
    "error":    "states/error.gif",
    "dragging": "states/dragging.gif",
    "falling":  "states/falling.gif",
    "landed":   "states/landed.png"
  }
}
```

- パスはパックフォルダからの相対
- 該当 state が無いときは `fallbackState`（省略時 `"idle"`）の素材で代用
- overlay 用の `dragging` / `falling` / `landed` も任意で追加可

### 描画の仕組み

renderer は単一の `<img class="mascot" data-pack="<id>">` を作って `src` を差し替えるだけです。`state-<name>` クラスは `<img>` に付与されるので、`pack.css` で軽い修飾（`filter`, `drop-shadow` 等）はかけられます。

### 注意

- `<img>` 経由で読み込まれるため、SVG ファイル内の SMIL や CSS アニメーションは **効かないことが多い**（`<img>` 描画は静的）。動かしたいなら GIF / APNG にするか、svg renderer を選ぶこと
- 推奨解像度は **200×200**。ファイルサイズが大きすぎると state 切替時に一瞬ちらつく可能性あり
- `manifest.size` で表示サイズは指示できるが、ウィンドウ自体は 280×240px 固定なので大きすぎる素材は意味がない

---

## 6. Lottie パックの作り方

After Effects + Bodymovin、または LottieFiles からエクスポートした Lottie JSON を 1 state あたり 1 ファイル使う方式です。

### `manifest.json`

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

### 描画の仕組み

main プロセスが各 JSON を読み込んでパースし、IPC で renderer に渡します。renderer は `lottie.loadAnimation` を 1 インスタンスだけ持ち、state 切替のたびに `destroy` → 再生成しています。読み込み時は **`autoplay: true, loop: true`** 固定です。

### 制限

- **外部画像 / フォントを参照しないこと**（Lottie JSON 内の `assets[]` で外部ファイルを指す形式は非対応）。インラインのベクター描画のみ使えます
- renderer は `svg` レンダラのみ（Canvas / HTML レンダラは無効）
- `lottie-web` は `npm install` の `postinstall` で `renderer/vendor/lottie.min.js` にコピーされる。これが無いと吹き出しに「lottie 未読込」と表示される

### パフォーマンス

複雑すぎる Lottie（パスが多い、エフェクトが重い）は CPU 使用率が上がります。常時表示のマスコットなので、**シンプル＆軽量**を心がけてください。

---

## 7. 吹き出しとラベルとの関係

styles.css で以下のレイアウトが固定されており、パックは **そのスペースを侵食しないこと**：

| 要素 | 位置（`.mascot-wrap` 200×200 を基準） |
|---|---|
| 吹き出し | `top-right`（既定） / `top-left` / `top` のいずれか。manifest の `bubble.anchor` で指定 |
| セッションラベル（cwd basename） | マスコット直下（`bottom: -16px`）。`__default__` 以外で表示される |
| マスコット本体 | `viewBox` の中央付近に配置するのが無難 |

ガイドライン：

- **マスコット本体のアニメで吹き出し / ラベル領域を覆わない**こと
  - 例: 吹き出しが `top-right` の時、`viewBox` の右上付近（`x > 130`, `y < 50` あたり）は吹き出しと重なる
- **viewBox の中央に体を配置**するのが安全（`pop` / `classic` は中心が `(100, 100)` 付近）
- 体が viewBox からはみ出す場合は `overflow: visible`（styles.css 既定）に頼って良い

---

## 8. オーバーレイシーケンス（dragging → falling → landed）

ユーザーがマスコットをドラッグすると、以下の遷移が発生します：

```
[ドラッグ開始]
   ↓
 dragging  ← ユーザーがマウスを離すまで継続
   ↓
[リリース]
   ↓
 床に着いてる？─Yes→ landed (約280ms) → null（base state に戻る）
   │
   No
   ↓
 falling ← tick loop が posY を床まで補間
   ↓
[床到達]
   ↓
 landed (約280ms) → null
```

`falling` / `landed` 中に再ドラッグされた場合は即座に `dragging` に戻ります。

### 一連のストーリーとして演出する

3 つの overlay は **「持ち上げ → 落下 → 着地」の 3 幕劇** として演出できます。

| state | ストーリー上の役割 | アニメ例 |
|---|---|---|
| `dragging` | 持ち上げられた驚き | 体が縦に伸びる / 目が「O」になる / 口が開く |
| `falling` | 風に煽られて落ちている | 体がさらに伸びる / 細かくジターする / 髪がなびく |
| `landed` | ペシャっと潰れて起き上がる | 横に潰れる / 目を閉じる / 1 回だけ再生 |

### タイミングについて

- `dragging` / `falling` の **active 期間は実装が制御**するため、各 state のアニメ長は気にしなくてよい（`infinite` ループにしておけば、active な間ずっと再生される）
- ただし **`landed` は約 280ms しか表示されない**。それより長いアニメは途中で打ち切られる
  - したがって `landed` は **短めの 1 回再生 + `animation-fill-mode: forwards` で最終フレームを保持**するのが定石（`pop` の `pop-squash` を参照）

---

## 9. テスト方法

### 起動

```bash
npm install
npm start
```

### state を curl で切り替え

```bash
# thinking に切り替え
curl -X POST -H 'Content-Type: application/json' \
  -d '{"state":"thinking"}' \
  http://127.0.0.1:39999/state
```

すべての state を順に試すワンライナー：

```bash
for s in idle thinking working waiting done error idle; do
  echo "=== $s ==="
  curl -s -X POST -H 'Content-Type: application/json' \
    -d "{\"state\":\"$s\"}" http://127.0.0.1:39999/state
  echo
  sleep 2
done
```

### overlay 系の確認

`dragging` / `falling` / `landed` は HTTP では発火しません。**実際にマスコットをドラッグして確認**してください：

- `dragging`: マスコットをマウスでつまんで動かす
- `falling`: 床から離した位置でドロップ
- `landed`: 床近くまで戻ってきた瞬間（または床上でドロップした瞬間）

### DevTools

Tray メニュー → `Toggle DevTools` で renderer 側のコンソールを開けます。`console.warn` / `console.error` の出力や、CSS の効き具合のデバッグに使えます（DevTools が開くのは `__default__` セッションのウィンドウ）。

### パック切替

Tray メニュー → `Character` から radio 選択で切り替え。再起動なしで反映されます。

---

## 10. 新規パックを作る最短手順

1. `assets/characters/classic/` をフォルダごとコピーして `assets/characters/<新ID>/` にする
2. `manifest.json` の `id` と `name` を新 ID に変更
3. `pack.css` 内のセレクタの `data-pack="classic"` を **すべて** `data-pack="<新ID>"` に置換
4. `@keyframes` 名の `classic-*` も新 ID プレフィックスに置換（衝突防止）
5. アプリを再起動（`npm start`）→ Tray の `Character` サブメニューに新パックが出る
6. 切替して、`curl` で各 state を順に確認しながら見た目を調整
7. ドラッグして `dragging` / `falling` / `landed` の動きを確認・調整

---

## 11. よくあるハマりどころ

| 症状 | 原因 | 対処 |
|---|---|---|
| 他パックに切り替えたら見た目が崩れた | `pack.css` のセレクタが `.mascot[data-pack="..."]` でスコープされていない | すべてのセレクタを必ずスコープする |
| 同じ keyframes 名で別の動きが混ざる | パック間で `@keyframes` 名が衝突 | パック ID をプレフィックスに付ける |
| 影が二重になる | 要素に `filter: drop-shadow` と `box-shadow` を併用 | どちらか片方にする（透過 SVG では `drop-shadow` 推奨） |
| `<image>` を使ったら表示されない | `file://` で外部画像を参照 | SVG にインラインで描画する |
| マスコットが画面外にはみ出る | viewBox が極端 | `viewBox="0 0 200 200"` を基本に、体の中心を `(100, 100)` あたりに |
| Lottie が真っ白 | 外部画像参照がある／lottie-web が未配置 | JSON をインラインだけにする／`npm install` で `lottie.min.js` を再配置 |
| 歩行中に左右反転がおかしい | `scaleX(-1)` と他の `transform` の合成漏れ | `facing-left` 用の keyframes を別に書く（`pop` 参照） |
| `landed` のアニメが最後まで再生されない | 280ms より長い | アニメを 0.3s 以下に / `animation-fill-mode: forwards` で固定 |
| state 切替時に装飾が残る | `opacity: 1` を `state-*` で付けて、解除を忘れている | 装飾類はデフォルト `opacity: 0` にして、特定 state だけ `opacity: 1` |

---

## 12. 参考

- 同梱の **`pop` パック**（`assets/characters/pop/`）: SVG renderer のフル実装例。overlay の `pop-dangle` / `pop-fall` / `pop-squash` を含む
- 同梱の **`classic` パック**（`assets/characters/classic/`）: シンプルな SVG renderer の実装例
- **`assets/characters/example-image/`**: image renderer の最小サンプル（overlay 含む）
- **`assets/characters/example-lottie/`**: lottie renderer の最小サンプル

実装で迷ったら、まず `pop` の `pack.css` を読むのが最短です。
