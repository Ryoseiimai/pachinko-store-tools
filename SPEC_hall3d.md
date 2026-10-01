# hall3d — AIホール 1日営業シミュレーター（3D）仕様

公開先: https://ryoseiimai.github.io/pachinko-store-tools/hall3d.html （GitHub Pages・静的）
ファイル構成（すべて `hall3d/` 配下、ES modules、ビルド工程なし）
- `hall3d.html` … 入口。左=2Dレイアウトエディタ、右=3Dビュー、下=タイムライン/KPI
- `hall3d/engine.js` … レイアウト・機種・来店/着席/OUTのシミュレーション（DOM非依存、純JS）
- `hall3d/editor.js` … 2Dレイアウト編集UI（canvas）
- `hall3d/view3d.js` … three.js 3Dビュー・一人称ウォーク・1日再生・WebM書き出し
- `hall3d/machines.js` … 架空機種カタログ（実在機種名禁止）
- `hall3d/app.js` … 結線

## 禁止事項（恒久）
「設定」「出玉」「還元」「勝てる」「甘い」「回収」を画面・コメントに出さない。
使ってよい経営語: アウト(OUT)、稼働率、売上、粗利、客数、滞在時間、台移動。
「アウト」= 台に打ち込まれた玉数（営業上の稼働指標）。出玉・払い出しは扱わない。

## データ契約（engine.js が公開する型・JSON）
```js
// 機種カタログ machines.js
Machine = { id:'m01', name:'CR AIホール 桜', kind:'P'|'S', rate:4|1|20|5,
  popularity:0.0-1.0,        // 集客力(新台=高)
  stayMin:[min,max],         // 1人あたり滞在分の範囲
  outPerMin:number,          // 稼働中1分あたりアウト玉数(P:約100〜120, S:メダルは50玉換算)
  salesPerMin:number,        // 稼働中1分あたり貸玉売上(円) = rate×消費玉/分
  genre:'海物語系'|'アニメ版権'|'ホラー'|'萌え'|'甘デジ風'|'ジャグラー風'|'6.5号機AT' 等の架空表記 }
// レイアウト
Layout = { w:number, d:number /*グリッド幅・奥行(1マス=0.5m)*/, entrance:[{x,z}], counter:{x,z,w,d},
  islands:[{ id, x, z, w, d, dir:'h'|'v',
     slots:[{ i, machineId|null, side:'A'|'B' }] }],   // 島(シマ)。1島=両面に台
  decor:{ wallColor, floorPattern:'tile'|'carpet-red'|'carpet-blue'|'wood', lighting:'bright'|'warm'|'dim',
          banners:[{islandId, text, color}], signboard:{text,color}, ceilingPops:boolean } }
// シミュ入力
SimInput = { layout, machines, dayParams:{ weekday:0-6, event:'none'|'newMachine'|'payday'|'rain'|'holiday',
  tradeAreaPop, rivals, openHour:10, closeHour:23, seed } }
// シミュ出力（1分刻み）
SimResult = { minutes: number, // 780
  timeline:[ { t, customers:[{id, x, z, state:'walk'|'sit'|'leave', slotRef|null}], kpi:{inStore, out, sales} } ], // 1分ごと
  perSlot:[ { islandId, i, machineId, occupiedMin, out, sales, grossProfit, visits, heat:0-1 } ],
  summary:{ visitors, peakInStore, peakHour, totalOut, totalSales, grossProfit, avgStayMin, utilization }
}
```

## シミュレーション（engine.js）
- 来客数モデルは raiten.html と同じ骨格（商圏×参加率7.4%×来店確率×立地/曜日/イベント係数÷(競合+1)）。時間帯分布は10時開店ピーク・17〜20時ピークの二峰。
- 着席モデル（多項ロジット）: 各空き台のスコア = 機種popularity×W1 + 入口からの近さ×W2 + 角台(島端)×W3 + 通路幅/視認性×W4 + 隣接台の稼働(にぎわい)×W5 − 隣が両側埋まりのペナルティ。W はコード上部に定数で置き、「モデル説明」に日本語で根拠を書く。
- 客は滞在後に離席、20%は別の台へ移動。粗利 = 売上×粗利率(既定15%・調整可)。
- 乱数はseed付きxorshiftで再現可能。A/B比較で同seed。
- 性能: 500台・780分を1秒以内（O(客×空き台)を避け、島単位のバケットで候補を絞る）。

## エディタ（editor.js）
- 上から見た2Dグリッドcanvas。島の追加/削除/移動/回転、島のスロットをクリック→機種選択（カタログからドロップダウン、または「島ごと一括」）。入口・カウンター位置のドラッグ。
- シミュ後は台ごとの稼働率ヒートマップを塗り重ね（凡例つき）。ホバーで台のKPIツールチップ。
- テンプレ3種（駅前小型120台/郊外中型320台/大型500台）をワンクリックで読み込み。
- レイアウトA/Bの保存・比較（同seedで両方走らせ、summaryの差分表）。localStorage保存・JSON書き出し/読み込み。

## 3Dビュー（view3d.js） three.js r160系を cdnjs から `<script>`（UMD/またはimportmap+jsdelivr）
- レイアウトJSONから店内を生成: 床(パターン)、壁(色)、島(台=箱+液晶面のエミッシブ+機種名テキストスプライト)、椅子、入口自動ドア、カウンター、天井照明(lightingで色温度・明るさ)、島端バナー(text)、看板、天吊りPOP。
- 視点2つ: 俯瞰(OrbitControls) / 一人称(ストリートビュー風。PC=WASD+マウスドラッグ、スマホ=左下バーチャルスティック+右側スワイプ)。島の中は通れない簡易コリジョン。
- 1日再生: タイムラインのスクラバー(10:00〜23:00)、再生/一時停止/倍速(1x/10x/60x)。客はカプセル型の簡易人物で歩く/座る。稼働中の台は液晶が点灯、稼働率に応じて色。画面右上に時刻・在店客数・累計アウト・累計売上のHUD。
- 動画書き出し: 「動画にする」ボタン→ canvas.captureStream(30) + MediaRecorder(webm; vp9→vp8フォールバック)で、選んだ倍速で10:00→23:00を自動再生しながら録画、HUD込み。終了後にダウンロードリンク(.webm)。俯瞰→一人称のカメラ自動パン(3カット)モードも用意。
- decorの変更は即時に3Dに反映（装飾の事前確認用途）。

## 受入条件
1. テンプレ「郊外中型320台」で「1日を走らせる」→ 1秒以内にsummaryが出て、ヒートマップと3Dの点灯が変わる
2. 新台(popularity高)の島を入口付近に置いた場合と最奥に置いた場合で totalOut/売上 に差が出る（A/B表に差分表示）
3. 一人称で入口から島の間を歩ける（スマホ幅でもスティックで動く）
4. 動画書き出しで .webm が生成され、ffprobeで再生時間>5秒、フレーム差分で動いている
5. 禁止語ゼロ、コンソールエラーゼロ、390px/1280pxで横はみ出しなし

## 両丸水産 新台コーナー
- ページ読み込み時に `https://ryoseiimai.github.io/ai-pachinko-maker/machines/index.json` を `cache: no-store` で取得（5秒で打ち切り）。失敗・不正データ・空一覧では同梱の `hall3d/ryomaru-machines.json` を使う。両方を取得できなければ既存ホールで継続する。
- `published` / `published_at` / `publishedAt` / `date` / `created_at` の日付がある項目を新しい順、日付なし・同日付は配列の後ろを優先。slugの重複を除き最大8機種を入口に最も近い島へ1台ずつ配置する（島がなければ新設）。入口側の面から順に並べ、余った既存台は保持する。
- 毎日、公開元が一覧に機種を追加すると、次回アクセス／再読み込みで自動導入される。ホール側のコード更新は不要。保存済みレイアウトも対象台の元の機種IDを復元してから最新分を導入するため、古い新台や重複は蓄積しない。通常の島移動・回転・機種編集は維持する。
- 利用者が機種を変えた台は `ryomaruOptOut` を保存し、以後の自動導入から除外する。残る対象台で最大8台を埋め、空一覧でも元の機種への復元とコーナー情報の削除を行う。
- 編集でコーナーの島を削除すると `ryomaruCornerDisabled` を保存して無効にし、別の島へ移設しない。全島を削除しても編集経路で島を新設しない。
- 再導入はページ読み込み・JSONインポート・テンプレート切替時のみ。読み込み・インポートでは無効の旗を尊重し、テンプレート切替では旗を下ろす。一覧は描画を止めずに取得し、取得前の営業実行は一覧の確定を待つ。
- 筐体は各機種の `images/cabinet.jpg` を匿名CORSで読み込み、読めない間・失敗時は機種名のcanvas画像を表示。「新台」の赤札と入口上の両面看板を追加する。クリック／タップ、ポインタロック中は中央照準＋Eキーで下部に機種情報と新規タブのリンクを表示する。
- 営業データは既存P新台の数値を継承し、対象台だけ専用の機種IDへ割り当てる。`engine.js` の `layoutAppeal`・着席モデル・各係数は変更しない。店内一周ツアーには新台の入口側通路を1地点追加する。新台固有の処理は `ryomaru.js` と `ryomaru-view.js` に分離する。
