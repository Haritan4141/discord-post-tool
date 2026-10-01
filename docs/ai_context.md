# AI Context

## プロジェクト概要

このプロジェクトは、Discordサーバー向けにカテゴリ/チャンネルを自動作成し、zip/pdfファイルを一括投稿するためのローカルCLIツールです。あわせて、PNG/JPG画像群からDiscord Botのアップロード制限に収まるzip/pdfを生成する画像変換CLIも持っています。

主な目的は次の2つです。

- ローカルフォルダ構成をDiscordのカテゴリ/チャンネル構成へ反映する。
- 画像セットをzip/pdf化し、各ファイルを10MiB未満に収めてBot投稿できるようにする。

主な技術スタック:

- Node.js 20以上
- Discord REST API v10を直接利用
- `sharp`: ZIP用WebP変換、PDF用JPEG変換
- `pdf-lib`: PDF生成
- `yazl`: ZIP生成
- `Electron`: デスクトップGUI
- PID＋プロセス作成時刻、UUID claimとbakery順序による同一PC・同一ユーザーのプロセス間排他（追加依存なし）
- PowerShell環境での実行を前提に検証

主なコマンド:

```bash
npm run plan -- --input ./optimized_webp_pdf
npm run run -- --input ./optimized_webp_pdf --yes
npm run build-assets -- plan --input ./raw_images --output ./optimized_webp_pdf --chunk-size 100
npm run build-assets -- run --input ./raw_images --output ./optimized_webp_pdf --chunk-size 100 --force
```

環境変数:

- `DISCORD_BOT_TOKEN`: Discord Bot Token
- `DISCORD_GUILD_ID`: 投稿先DiscordサーバーID

`.env.example` を元に `.env` を作成する運用です。`.env` にはBot Tokenが入るため、内容をチャットやログに出さないでください。

GitHubリポジトリ:

- `https://github.com/Haritan4141/discord-post-tool`
- ローカル `main` は `origin/main` を追跡。
- 初回コミット `Initial commit` をGitHubへpush済み。

## 現在の作業目的

現在の作業は、CLI版の投稿ツールと画像変換ツールを安定させたうえで、ElectronデスクトップGUIを整備している段階です。

2026-09-30の作業: 別cloneの同時起動でElectronキャッシュが競合したため、保存領域をプロジェクト別へ分離し、画像変換・Discord投稿の同時実行を保護する。既存入力設定を引き継ぎ、画像・出力・manifestを保持する。変更対象はGUI初期化、CLI入口、共通排他/API処理、依存関係、テスト、README。この修正のcommit/pushは未依頼。

2026-10-01のレビュー: 修正前の両cloneの対象コードは一致。既存テストは各12件成功したが、内部mutex期限切れによる二重lease、出力配下Junctionの排他漏れ、manifestの一時パス衝突、中断出力の投稿を追加試験で確認した。PID再利用による回収不能もコードとモデル試験で確認。指摘5件と修正前の証拠は下のレビュー履歴に保持する。

2026-10-01の修正結果: ユーザー承認の5件を修正し、追加レビューで発見した孤児claim上書き・空Guild key・stagingのカテゴリ混入も修正した。main / rirrへ同じコード・テスト・資料・依存関係を反映し、両cloneの `npm test` は各39件PASS。隔離保存領域での非表示Electron同時起動と同一clone追加起動もPASS。**自動回帰テストと一時データ検証は合格、実Discord・実データ長時間処理は未確認**。既存ユーザーデータを保持している。

2026-10-01の公開承認: ユーザーからGitHubの `main` へのcommit/pushと、`C:\Users\Haritan\Documents\discord-post-tool-rirr` の最新化を明示承認された。公開対象は上記の検証済みコード・テスト・README・本資料のみ。`.env`、投稿manifest、画像・生成物、ユーザー作成未追跡フォルダはGitへ追加しない。rirrの同じ修正差分は対象ファイル限定のstashで保全してからfast-forward更新する。新規branch・force push・ユーザーデータ整理は行わない。下の「Git公開未実施」はレビュー・回帰検証時点の履歴である。

2026-10-01の投稿準備: ユーザー承認に基づき、mainの投稿入力 `限定作品0930` の63作品を `限定作品0930_1`（32作品）/ `限定作品0930_2`（31作品）へ振り分けた。分割作品の全ZIP/PDF/profileを同じ側に保持し、移動222ファイルのSHA-256不変・全体の投稿前検証PASSを確認。mainは5カテゴリ・160作品・378添付で、各カテゴリ50作品以下になった。実Discord投稿・投稿manifest更新・再変換は行っていない。rirrの生成物は変更していない。

2026-10-01の実投稿停止調査: ユーザーのGUIログで内部APIロックのticket更新renameがEPERMになり、終了コード1で停止した。mainの投稿manifestには限定作品0930_1の9作品・18添付が記録済み。Windowsの実ファイル占有で同じ停止を一時領域に再現し、失敗時はAPI action未到達・claim回収・次回取得成功を確認。ticket更新に短時間の再試行を実装済みで、実際の占有元は未特定。ユーザー承認を受けticket更新の短時間再試行を両cloneへ実装し、両cloneの全44テストPASSを確認。詳細は下の停止調査を参照。

2026-10-01のEPERM修正公開承認: ユーザーから今回修正のmainへのpushとrirrへの適用を明示承認された。修正コードは既に両cloneで一致し各44テストPASS。ユーザーは修正版で投稿を再開しmainのCLI実行中を確認したが、完走は未確認。稼働中mainのプロセス停止やコード再書換えはせず、検証済みコード/テスト/README/本資料のGit履歴を同期する。rirrはGUI/CLIがないことを確認し、対象5ファイルだけをstashで保全してfast-forward更新する。過去のstash・ユーザー未追跡フォルダ・.env・投稿manifest・画像/生成物は保持し、実Discordへの操作は行わない。下の未commit/push記述は、この追加公開承認より前の検証時点の履歴。

2026-10-01の投稿再停止: ユーザー提示の実投稿ログでHTTP400/code30013（サーバー全体のチャンネル上限500）により停止。内部mutexのEPERMとは別原因。ローカル履歴では限定作品0930_1は31/32作品・66添付が保存済み。現投稿入力の未投稿129作品と未作成4カテゴリには履歴上133枠が必要。全体500上限の事前検査が現行コードにないことを確認し、修正は提案のみ。空き確保または未投稿分の別Guild分配が必要。画像変換の高速化調査は、この停止調査を優先して保留中。

2026-10-01の2カテゴリ集約完了: ユーザーの「実行してよいです」という具体的な全工程承認に基づき、限定作品vp0901_キャラ単体_ヌルテカ/ノーマルを各1チャンネルへ集約した。2026-10-01T02:09:35.526Z（11:09 JST）に実Discordの最終照合完了。各25メッセージ/50添付、合計100添付のサイズ/SHA-256一致を確認してから旧48チャンネルを削除し、全体452チャンネル/48空きを確認。mainの履歴50 groups/100 filesの移行と現行isPosted判定PASS、その他履歴の不変を独立検証した。バックアップは保持。rirrのmanifestや別Guildは変更していない。private archived threadはAPI403のため独立確認できず、ユーザーの「作っていない」という明示確認を適用した。

2026-10-01の画像変換高速化導入: 導入前の100枚測定は31.753秒→16.696秒（約47.4%短縮）で画質/容量/画像hash一致。ユーザー承認後、画像並列8・UV pool未指定時8・sharp threads 2を既定化し、GUIの旧既定4は一度だけ8へ移行する実装を行った。両cloneで各49テストPASS、実100枚の一時コピーを両cloneから同時変換し、両方の100 WebP＋100 JPEGのhashと品質/解像度/容量が導入前測定と全件一致。長時間処理と他の重いアプリとの競合は未検証。品質探索/生成物profile/投稿形式/依存関係は維持。詳細と公開手順は下の導入記録を参照。

2026-10-01の絵柄サンプル内チャンネル削除完了（削除完了時の容量状態）: ユーザーの明示的な全配下チャンネル削除依頼に基づき、指定Guildの絵柄サンプル内30 text channelsを削除した。2026-10-01T02:29:03.070Z（11:29 JST）に最終GET検証完了。カテゴリ自体は残りchild 0、全体422 channels/78 free slots。この時点の未投稿129作品・312添付を既存の作品別チャンネル方式で投稿するには129作品チャンネル＋4カテゴリ=133枠が必要で、55枠不足だった。30投稿/60添付（162,394,899 bytes）のローカルバックアップと添付SHA-256 readback一致を確認してから削除した。mainのmanifestは変更せず、rirrのmanifest/別Guild/ユーザー生成物は変更していない。

2026-10-01の未投稿分抽出完了（最新の投稿状態）: ユーザーが元Guildで500チャンネル上限まで再実行し、残りを別サーバーへ投稿するための別フォルダ化を依頼。2026-10-01T02:53:46.164Z（11:53 JST）に最新manifestと実DiscordのGET照合を完了し、元Guild500 channels、現入力160作品のうち107作品/236添付は投稿済み、53作品/142添付は全件未投稿、部分投稿作品0と確認した。未投稿のみをC:\Users\Haritan\Documents\discord-post-tool\optimized_webp_pdf_unposted_20261001へコピーし、必要な71 assets.jsonも保持。2カテゴリ（限定作品vp0930_1:33作品/94添付、限定作品vp0930_2:20作品/48添付）、213コピー全てのSHA-256一致と現行CLIの投稿前検証PASS。元入力/manifestを保持し、Discord書込は0。新規カテゴリ/作品チャンネルを全て作る別サーバーでは55空き枠が必要。抽出フォルダを別サーバー側GUIの投稿入力として指定する。別Guildへの実投稿・容量確認は未実施。

達成したい状態:

- `raw_images` から10MiB未満のzip/pdfを生成できる。
- `optimized_webp_pdf` を投稿入力として、カテゴリ/チャンネル作成とファイル投稿ができる。
- 軽い100枚作品は1 zip＋1 pdf、最低設定でも上限を超える重い作品だけは自動分割した2組のzip/pdfを投稿できる。
- 投稿済みファイルは再実行時にスキップできる。
- Discord側でカテゴリ/チャンネルが削除されていた場合は、入力フォルダを正として作り直せる。
- GUIから実行しても、CLI仕様と制約が失われない。

変更対象の範囲:

- `src/cli.js`: Discord投稿CLI
- `src/build-assets.js`: 画像からzip/pdfを生成するCLI
- `README.md`: 利用手順
- `docs/ai_context.md`: AI引き継ぎ情報

GUIはElectronデスクトップアプリとして実装開始済みです。起動は `npm run app` です。GUIは既存CLIを子プロセスとして呼び出す構成で、投稿・変換ロジックをGUI側へ再実装しない方針です。

## これまでに実施した作業

### 同時実行対応 (2026-09-30)

- `src/gui/project-profile.js` を追加し、実体プロジェクトパスのSHA-256から固有の保存領域を作成。`main.js` はready前に `userData` / `sessionData` を切り替え、同じプロジェクトのみ単一起動とする。
- 初回のみ旧 `Local Storage` をコピーして入力設定を維持。旧領域や新領域の既存設定は削除・上書きせず、共有GPUCache等は移行しない。初回移行は旧版の全ウィンドウを閉じてから行う。
- `src/runtime-locks.js` を追加。2026-10-01の修正後はUUID claimとbakery順序で内部mutexを保護し、内部mutexと長時間leaseの所有者はPID＋作成時刻で照合する。初期実装の `proper-lockfile` は廃止。親子パス/root Junction/大文字小文字を照合し、配下Junction・シンボリックリンクは安全停止、読取同士は許可、書込との重複は拒否。終了確認できた所有者を回収し、生存所有者は時間経過だけで解除しない。
- 変換CLIは入力読取・出力書込、投稿CLIは入力読取・Guild ID・manifest書込を確保してから実処理を開始。計画コマンドも入力読取を確保する。競合時はAPIアクセス・ファイル生成より前に日本語で安全停止。
- `src/discord-request.js` で同じBotのHTTPリクエストを順番に処理し、429/残数0の待機時間を全ルートで保守的に共有。Tokenはハッシュキーにするだけでファイルへ記録しない。GUIのサーバー名確認にも適用。
- GUI smokeは非表示で起動し、サーバー名照会を省略してrenderer初期化を確認する。テストでは実Discordへ書き込まない。
- 既存の品質探索、重い作品の自動分割、出力検証/再開、4ファイル同一チャンネル、本文なし、投稿済みスキップは維持する。

追加したファイル:

- `package.json`
- `package-lock.json`
- `.env.example`
- `.gitignore`
- `src/cli.js`
- `src/build-assets.js`
- `README.md`
- `docs/ai_context.md`
- `src/gui/main.js`
- `src/gui/preload.js`
- `src/gui/launch.js`
- `src/gui/renderer/index.html`
- `src/gui/renderer/styles.css`
- `src/gui/renderer/renderer.js`
- `start-gui.bat`

導入した依存関係:

- `sharp`
- `pdf-lib`
- `yazl`
- `electron` devDependency

投稿CLIで実装した内容:

- `plan` コマンドで入力フォルダを読み取り、カテゴリ/チャンネル/ファイル計画を表示。
- `run` コマンドでDiscordカテゴリ/テキストチャンネルを作成し、zip/pdfを投稿。
- `.env` から `DISCORD_BOT_TOKEN` と `DISCORD_GUILD_ID` を読み込み。
- `.discord-post-tool-manifest.json` にカテゴリID、チャンネルID、投稿済みファイルを記録。
- `--yes` を必須化し、誤実行を防止。
- Bot投稿ではユーザーNitroのアップロード上限が適用されないため、デフォルトの事前チェックを1ファイル10MiB、同一リクエスト25MiBに設定。
- 投稿本文を空にし、Discordには添付ファイルのみ投稿する仕様へ変更。
- `作品名_1-50.zip/pdf` と `作品名_51-100.zip/pdf` のような範囲付きファイルを、同じ `作品名` チャンネルにまとめる仕様を実装。
- 範囲付きファイルは末尾の `_数字-数字` だけを分割範囲として扱う。
- 投稿済みファイルはmanifestとファイルサイズを使ってスキップ。
- Discord側でカテゴリ/チャンネルが削除されていた場合、デフォルトでは入力フォルダを正として作り直す仕様に変更。
- 作り直しを止めたい場合のみ `--no-recreate-missing` を使う。

画像変換CLIで実装した内容:

- `raw_images` 内の画像セットを検出。
- `raw_images/カテゴリ/作品名_png/*.png` のような投稿カテゴリに近い入力構成に対応。
- `*_png` と `*_jpg` が両方ある場合は、再圧縮劣化を避けるためPNGを優先。
- 既定の`--chunk-size 100`で100枚を1組として処理。
- ZIP内画像は元解像度WebP。品質75を基準に、余裕があれば85まで引き上げ、超過時は65まで自動探索。
- PDF内画像は長辺1350px・JPEG品質70を基準に、余裕があれば長辺1600px・品質75まで同時に段階的に引き上げ、超過時は長辺900pxまで縮小。
- ZIPとPDFを独立した画像バッファから生成し、それぞれ完成サイズを検査。
- 出力時に`<作品名>.assets.json`へプロファイル、採用品質、採用長辺、完成サイズを保存。旧JPEG ZIPを完成済みと誤認しないためにも使用。
- WebP最低品質だけを70から65へ広げた場合、旧出力の採用品質が現在の最低品質以上ならプロファイル・入力署名・サイズ・ハッシュを確認して再利用する。GUIで上書きを外せば完了済み作品を再変換せず続行可能。
- GUIと変換CLIの既定出力先は`optimized_webp_pdf`。GUI保存スキーマv3への移行時、旧`optimized_split`の絶対パスも出力先・投稿入力先から新既定値へ置き換えて保存する。
- 選択した出力先に同一作品の旧範囲付きファイルがある場合、自動削除せずエラー停止する。
- ZIP/PDF/profileは一時ファイルへ書いてから確定し、profileへ各出力のSHA-256を記録。再利用時は入力署名、設定、サイズ、ハッシュを照合する。
- デフォルトの生成目標を `9.8MiB` に設定。
- `--concurrency <n>` を追加し、画像変換を並列化。追加当時のデフォルトは4（2026-10-01の高速化導入後は8）。
- 最大枚数の組がZIPまたはPDFの最低設定でも9.8MiBを超える場合、その組だけを半分へ自動分割して再試行する。100枚なら通常は2ファイル、重い作品だけ`_1-50`/`_51-100`の4ファイルになる。
- 自動分割済み出力を再実行時に検出し、正常な組はプロファイル・入力署名・サイズ・ハッシュ検証後にスキップする。不足または異常な組だけを再生成する。
- 画像破損などサイズ超過以外のエラーは、自動分割の対象にせず従来どおり停止する。

GUIで実装した内容:

- Electronデスクトップアプリを追加。
- `npm run app` で起動。
- `npm run app:smoke` で短時間起動スモークテスト。
- `src/gui/main.js` から既存CLIを子プロセス起動。
- 画像変換タブで入力/出力フォルダ、1組の最大枚数、目標サイズ、ZIP WebP最低/基準/上限品質、PDF JPEG基準/上限品質、PDF最低/基準/上限長辺、並列数、上書き有無を指定可能。
- 画像変換タブの既定値は100枚、9.8MiB、WebP 65/75/85、JPEG品質70/75、PDF長辺900/1350/1600px。
- 「PDF用JPGも保存する」は、PDFに埋め込んだ中間JPEGを `<作品名>_jpg` フォルダへ保存する確認用オプション。通常投稿には不要。
- Discord投稿タブで投稿入力フォルダ、Guild ID、Bot Token一時入力、投稿モード、サイズ上限、カテゴリ/件数フィルタを指定可能。
- ログ欄はアプリ全体を縦に伸ばさず、ログ本文だけがスクロールするCSSに調整済み。
- 起動時ウィンドウは `1280x900`、最小サイズは `1040x760`。メニューバーは自動非表示。フォーム余白を詰め、ログ欄に最低190px相当の表示領域を確保。
- clone直後は `npm install` が必要。READMEに初回セットアップ手順を記載済み。
- `start-gui.bat` は `node_modules\.bin\electron.cmd` が無い場合、初回だけ `npm install` を実行する。Node.js/npm自体は事前インストールが必要。
- GUIの入力内容は `localStorage` に保存するが、保存キーはプロジェクトの絶対パスを含める。別フォルダのプロジェクト同士でGuild IDや入力フォルダなどが混ざらないようにしている。
- Guild ID欄に「確認」ボタンとサーバー名表示を追加。Bot TokenとGuild IDを使ってDiscord API v10のGuild情報を取得し、Guild IDのそばにサーバー名を表示する。
- Bot Token欄は保存しない。`.env` のTokenを使う運用を基本とする。
- GUIログ欄にCLI stdout/stderrを表示。
- `ELECTRON_RUN_AS_NODE=1` が環境に存在していたため、`src/gui/launch.js` でこの環境変数を削除してElectronを起動する構成にした。
- Electron内の `process.execPath` はElectron本体を指すため、CLI子プロセス実行用のNodeパスを `DISCORD_POST_TOOL_NODE` としてランチャーから渡している。
- `start-gui.bat` をプロジェクト直下に追加。Windowsでダブルクリック起動するためのbatで、内部では `npm run app` を実行する。

調査して分かったこと:

- Discord Botには通常ユーザーのNitroアップロード上限は適用されない。
- Bot投稿ではサーバー側の制限に影響されるため、複数サーバー運用ではファイルを10MiB未満に抑える方針が現実的。
- 100枚の元解像度1248×1824画像はWebP品質75で9.6935MiBのZIPになり、品質76では10MiBを超える実測結果だった。
- PDFは元解像度のままJPEG品質を大きく下げるより、長辺1350px・品質70のほうが表示上のバランスが良く、最大級100枚で9.5630MiBだった。

採用した方針:

- 入力フォルダ構成を正とする。
- Discord側に存在しないカテゴリ/チャンネルは作り直す。
- 再実行可能性を重視し、manifestを使って作成済み/投稿済みを管理する。
- 画像変換は「ZIP＝元解像度WebP」「PDF＝縮小JPEG」の固定方針とし、各ファイルの実サイズを見ながら9.8MiB以内で品質を上げる。最低設定でも超える組だけを半分へ自動分割する。
- CLIで固めた動作をGUIから安全に呼び出す。

## 未完了タスク

残っている作業:

- 同時実行対応後の実データでの長時間変換・別Guild同時投稿はユーザー確認待ち。今回の投稿検証は模擬APIのみで、実Discordのカテゴリ/チャンネル/メッセージへ変更していない。
- この修正はmain/rirrへローカル反映済みだが、commit/pushは未実施。必要ならユーザー承認後に行う。
- GUI上での実操作確認。
- GUIのGuild ID確認ボタンで、実際のBot Token/Guild IDからサーバー名が表示されるか確認。
- GUIから画像変換計画/実行、投稿計画/実行が期待通り動くかの確認。
- GUIから実行したDiscord投稿で、投稿済みスキップと削除済みカテゴリ/チャンネル再作成が期待通り動くか確認。
- エラー表示の日本語化と、ユーザーが次に何をすべきか分かるUI設計。
- 重複カテゴリ/重複チャンネルがDiscord上に複数ある場合のGUI上の選択/解決方法。
- manifestのリセットや再リンクをGUIでどう提供するか。

次に確認すべきこと:

- `npm run run -- --input ./optimized_webp_pdf --yes` で、現在のユーザー環境でも投稿済みスキップと削除済み再作成が期待通りに動くか。
- `npm run build-assets -- run --input ./raw_images --output ./optimized_webp_pdf --chunk-size 100 --force` の全体実行で、全ファイルが9.8MiB以下になるか。
- 1枚単位へ分割してもWebPまたはPDFが9.8MiBを超える極端な入力がないか。

保留中の判断:

- GUI技術スタックはElectronを採用。
- GUIのBot Token入力は保存しない方針。基本は `.env` を使う。
- 変換済み出力フォルダはGUIで選択可能。新方式のデフォルトは `optimized_webp_pdf`。

既知の問題や注意:

- 2026-09-30の `npm audit --json` は既存の `electron` / `extract-zip` / `sharp` にhigh 3件を報告。2026-10-01は不要になった `proper-lockfile` とその専用依存だけを削除し、Electron/sharp等のバージョンは維持した。audit fix・大幅更新は行っていない。警告の解消は別途更新と互換検証を検討する。
- `.discord-post-tool-manifest.json` はローカル状態を保持する。Discord側で手動削除や重複作成を繰り返すと、manifestとDiscord側の状態がずれる可能性がある。
- 投稿済み判定はmanifest中心。Discord側で投稿メッセージだけ削除した場合、manifestが投稿済みと判断してスキップする可能性がある。必要ならmanifest削除/編集や再検出機能を検討する。
- 同名カテゴリ/同名チャンネルが複数ある場合、意図しない対象を避けるため停止または明示的な解決が必要。
- 自動探索では候補ごとに100枚を再変換するため、旧固定基準より処理時間が増える。WebPは基準75を最初に試してから上限85側または最低65側を二分探索し、PDFは1600px/q75から1350px/q70までバランスよく下げ、その後900pxまで縮小する。

## 動作確認・検証状況

### 同時実行対応のコードレビュー (2026-09-30〜2026-10-01 JST)

レビュー範囲: main / rirrの未commit差分、新規runtime/API/profileヘルパー、GUI、変換・投稿CLI、依存関係、テスト、README。Global AGENTSを適用し、両projectと親directoryにはProject AGENTSを確認できなかった。実機はMAIN `DESKTOP-5NPLIIV`、検証Nodeはv24.18.1。以下の問題は両cloneに共通。

修正前のレビュー指摘（当時の行番号・再現証拠、重要度順。現在の修正状態は後続の修正検証記録を参照）:

1. **P1: 生存プロセスの内部mutexが時間だけで回収され、競合leaseを二重登録できる。**
   - `src/runtime-locks.js:22-27` の `stale: 30000` / `update: 5000` と、`104-130` の競合検査からlease確定までの処理が対象。mutexは所有PIDの生存を確認しない。installed `proper-lockfile` はmtimeだけでstale回収する。
   - テストでlease確定rename直前に33秒のイベントループ停止を注入し、約31秒後に別プロセスが同じ出力を取得すると、復帰した先行プロセスも取得に成功。同一出力に2つの生存PIDのwrite leaseが登録された。初期の別境界への停止注入ではcompromised検出で終了したため、すべての停止位置で再現するとは断定しない。
   - 影響: 同じ出力、Guild、manifestの排他が破れ、同時書込・重複投稿が起き得る。`src/discord-request.js:17` も同じmutexを使うため、API直列化にも同じ所有権喪失リスクがある（API側の長時間停止は独立再現していない）。
   - 修正案: 内部mutexもPID＋プロセス作成時刻等の所有者を照合し、生存所有者を時間だけで奪わない設計へ変更する。解放時も所有IDを照合する。停止・復帰をcommit境界に注入する回帰テストが必要。

2. **P1: 出力root配下のJunction先がwrite leaseから漏れる。**
   - `src/build-assets.js:128-130` はinput/output rootのみを資源登録し、`src/runtime-locks.js:42-58,89-94` は指定されたroot自身しかrealpath解決しない。出力は `outputRoot/category` 経由で配下Junctionを辿る。
   - 一時データで `outputRoot/category` を `targetRoot/category` へのJunctionにし、`targetRoot` のread lease保持中に実変換を実行したところ、成功して同じ実体ZIP/PDF/profileを書き込んだ。
   - 影響: 別名のフォルダでも、投稿入力の上書きや2変換の競合書込が可能。rootそのものがJunctionの場合と通常の親子パスは既存テストが成功。Windowsの大文字小文字を変えた別名の競合拒否は今回の追加試験で確認した。
   - 修正案: 実際にアクセスするカテゴリ・出力パスの実体もleaseへ追加し、実処理前にまとめて競合確認する。対応が難しい配下reparse pointは明示エラーで停止する。配下Junctionでの実変換と投稿の相互排他テストが必要。

3. **P1: 中断した変換の新ZIP＋旧PDFを投稿できる（既存コードの問題）。**
   - `src/build-assets.js:965-982` はZIP/PDF/profileを個別renameする。`src/cli.js:217-259` の投稿計画はprofileのhash整合性を確認しない。この部分は今回の差分前から存在し、今回の正常系の退行とは区別する。
   - 一時画像を変更して `--force` で再生成し、ZIP rename後・PDF rename前にエラーを注入。ZIPのhashが旧profileと不一致、旧PDFのhashは旧profileと一致する状態になった。変換終了・lease解放後の実投稿CLIは、模擬APIへ2添付を通常投稿した。
   - 影響: 変換中は排他できても、中断・異常終了後は異なる生成世代のファイルを投稿できる。単純な存在・サイズ検査では防げない。
   - 修正案: 生成世代／完了状態を保存し、投稿前に生成出力のpair・profile・hashを検証する。従来の手動ZIP/PDF入力との互換方針を決めてから実装する。rename途中終了と、その後の投稿拒否をテストする。

4. **P2: manifest本体と別ジョブの一時ファイルが衝突する。**
   - `src/cli.js:143-145` のleaseはmanifest本体だけだが、`866-870` の保存は固定の `${manifestPath}.tmp` に書く。別Guild・別manifest `a.json` / `a.json.tmp` は両方のleaseを取得できる。
   - 模擬APIを使った実CLIの2プロセス試験で、Aの最初のmanifest rename前に停止し、Bを `a.json.tmp` で正常完了、Aを続行して最初のsave後にfixtureエラーで停止。AのmanifestにGuild Bの情報が混入し、正常終了したBのmanifestは消失した。両者とも一時データのみ。
   - 修正案: 本体と固定一時パスの両方をleaseする、またはmanifest専用の保護されたstaging領域へ移す。固定tmp名を廃止する場合も、別ジョブの正式manifestと実書込先が衝突しない設計にする。2つのmanifestパスの交差試験が必要。

5. **P2: PID再利用で終了済みジョブのleaseが回収されない。**
   - `src/runtime-locks.js:97-100,110-117` はPIDしか記録・照合しない。古い所有者のPIDが無関係のプロセスへ再利用された場合、古いleaseを生存ジョブと判断する。
   - 再利用されたPIDを模した古いleaseに現在生存中の別所有者相当のPIDを入れるモデル試験で、取得が「使用中」と拒否された。Windows上で実際のPID再利用を誘発した試験ではない。
   - 影響: 終了済みジョブの出力／Guild／manifestが無関係なプロセスの終了まで利用できない。危険な強制解除につながらないようにする必要がある。
   - 修正案: PIDとプロセス作成時刻等の組で所有者を照合し、同じPIDでも別プロセスと確認できた場合だけ回収する。照合不能は生存扱いのまま安全停止する。

確認した正常動作:

- main / rirrの `npm test` は各12件PASS。テスト起動時の `LOCALAPPDATA` も一時directoryに分離した。品質探索、重い組の自動分割、出力hash検証と再開、4添付の同一チャンネル集約、本文なし、投稿済みスキップは通常パスの範囲で維持。
- 模擬fetchで通信例外後のmutex再取得、短縮したAbortSignal timeout後のmutex再取得、429が連続したときの8回上限を確認。実HTTPの120秒timeoutを経過させた試験ではない。コード上、POSTの通信例外を自動再試行する処理はない。
- profileヘルパーテストと構文検査は成功。追加の一時user-dataを使ったElectron起動でJunction／case別名が同じprofileと保存キーを使うことを確認。旧Local StorageコピーによるGPUCache非移行・旧領域と既存新設定の保持は既存テストの範囲で確認。

残る検証不足・既存挙動:

- 既存テストは内部mutexの期限切れ／復帰、実際のPID再利用、配下Junction、manifestと固定tmp名の交差、変換rename途中終了をカバーしていない。今回の再現ドライバーは一時directoryだけに作成し、repositoryのテストコードは変更していない。
- 実LevelDBの旧renderer設定が初回移行後に復元されること、コピー中の異常終了、Electronの2clone同時起動／second-instanceの継続的な自動回帰テストは不足。通常GUIの初期化失敗時の表示不足は既存コードにもある。
- 入力rootの配下Junctionは既存 `Dirent.isDirectory()` 判定で探索から除外される。zip/pdf片方欠損をwarningで続行すること、remote-checkの通信失敗時にmanifestのみで続行することも既存挙動。今回の退行とはしないが、途中出力の投稿拒否や通信失敗後の重複防止を設計する際に整理が必要。
- 実Discordへのアクセス／投稿／カテゴリ・チャンネル作成削除、実ユーザーデータの長時間同時処理、既存AppDataの移行は今回実施していない。Token／`.env` 内容を出力していない。依存関係のaudit fix・更新、commit／push／pull／branch作成も未実施。
- 更新した管理資料はmainの本ファイルのみ。rirrのアプリコード・資料・ユーザーデータは未変更。前セッションのPASS記録は通常系の実測履歴として保持し、今回の安全性合格と混同しない。

### レビュー指摘修正と最終検証 (2026-10-01 JST)

修正したコード上の事実:

- **P1 内部mutex期限切れ:** UUIDごとのclaimを完全なJSONとして排他的linkで公開し、ticket更新はrenameで確定するbakery方式へ変更。時間で所有権を奪わず、PID＋作成時刻で終了・別所有者を確認したclaimだけを回収する。同じPIDの並行呼出も直列化し、再帰取得は拒否する。解放失敗は `ELOCKCLEANUP` を返し、自分の全孤児claimをSetで保持して次の取得・待機中に回収する。
- **P1 配下Junction:** root資源を取得した状態で配下を検査し、Junction/シンボリックリンクを明示エラーで停止する。rootそのものがJunctionの場合は実体パスで保護する。
- **P1 中断生成物:** 全作品の `.assets.pending` と各zip/pdf組の `.pending` を最終出力書込前に置き、全chunk検証後に全体markerを解除する。投稿前にmarker、生成profileのpair・サイズ・SHA-256を確認する。従来のprofileなし手動入力は許可する。
- **P2 manifest一時パス:** canonical manifestごとのhashとUUIDを使った専用stagingへ分離し、manifest本体とstaging directoryの両方をleaseする。予約staging内への正式manifest指定を拒否し、投稿カテゴリ探索から予約stagingを除外する。manifestが入力直下にある運用も維持する。
- **P2 PID再利用:** `src/process-identity.js` を追加。Windowsは非表示の読み取り専用PowerShellでPID・StartTimeだけを取得する。別作成時刻なら旧所有者を回収し、観測不能は解除しない。旧PID-only leaseは生存PIDの場合に保持する。空Guild key、不正な資源・所有者情報も保存・処理前に拒否する。

テストで確認した事実:

- main / rirrの `npm test`: **各39/39 PASS**（従来12件＋新規27件）。最終mainは通常の環境で実行し、テストの画像・出力・manifestと各明示runtimeは一時directoryを使用。最終rirrは全体の `LOCALAPPDATA` も一時directoryへ分離した。先行の両36件検証でも全体の `LOCALAPPDATA` を分離した。
- 実子プロセスのregistry確定直前を33秒停止しても、同じ出力への生存write leaseは1つだけ。強制終了した実子プロセスの内部mutexは期限待ちなしで回収した。PID再利用相当の作成時刻差、観測失敗、壊れた管理情報、ticket確定失敗、同一PIDの複数解放失敗とその後の回収も確認。
- 実変換・投稿入口で配下Junctionを拒否し、Junction先へ変換せず、投稿APIクライアントも生成せず、取得済みleaseを解放した。
- 実変換のZIP最終rename後・PDF最終rename前に停止を注入し、新ZIP＋旧PDFを投稿前に拒否、再変換で復旧した。分割part1だけ確定した停止も作品全体markerで拒否し、再変換後の4添付同一チャンネル投稿を模擬APIで確認した。
- 同じruntimeの実CLI子プロセスで、Aの `a.json` 最終rename前に停止、Bの `a.json.tmp` を正常完了させてからAを再開。両manifestの保持・Guild混入なしを確認した。入力直下manifestでの2回目実行にもstagingカテゴリが混入しない。
- 通信例外・abort時のPOST自動再試行なしとmutex解放、429の8回上限、待機共有、別Botの独立実行を模擬fetchで確認。既存の品質探索、出力検証・再開、重い組の自動分割、4添付集約、本文なし投稿、投稿済みスキップもPASS。
- 両cloneの非表示Electronを同じ一時legacy領域から同時起動し、別userData/sessionData、renderer初期化、cache error 0を確認。同じcloneの追加起動はrendererを作らず終了。3プロセスともexit code 0。
- 両cloneのJavaScript全17ファイル構文検査、`git diff --check`、依存関係整合性検査を確認。`proper-lockfile` / `retry` / `signal-exit` のみ削除し、Electron 41.5.2 / sharp 0.34.5 / pdf-lib 1.17.1 / yazl 3.3.1を維持。

推測・残る検証不足:

- Windowsの実PID再利用を強制する試験、実ACL/AVによる解放失敗は行っていない。作成時刻差・権限エラーを注入した回帰テストによる確認。Linuxの `/proc`・zombie分岐はコード確認のみで、今回の実機検証対象はWindows。
- 実LevelDBの旧入力設定を初回移行後のrendererで読み戻す試験、移行コピー中の異常終了、実HTTPの120秒timeoutは未確認。profileのコピー・旧設定保持・GPUCache非移行はfixtureと既存テストの範囲で確認。
- profile/markerのない旧版・手動生成物の完全性は判定しない。旧版で中断した可能性がある出力は再変換する。remote-check失敗時にmanifestだけで続行する既存挙動と、結果不明のPOST後の重複可能性は今回の変更範囲外。
- 実Discordへのアクセス・投稿・カテゴリ/チャンネル作成削除、実ユーザーデータの長時間同時処理、既存AppDataの移行は未実施。`.env` / 投稿manifest / 入力画像 / 既存生成物 / ユーザー作成未追跡フォルダを保持。commit / push / pull / branch作成とaudit fixは未実施。

一時検証証拠（OS一時フォルダのため将来保持は保証しない）:

- 両cloneの修正前バックアップ: `C:\Users\Haritan\AppData\Local\Temp\discord-concurrency-fix-68a64ca308624767baaf9d8cdf8c336e`
- rirr最終39件ログ: `C:\Users\Haritan\AppData\Local\Temp\discord-final-test-816173d0eb564fe18fb20c9a0aa18db5\npm-test.log`
- 隔離Electron確認: `C:\Users\Haritan\AppData\Local\Temp\discord-final-gui-X0nKLq\result.json`

### 修正前に生成した既存出力の投稿前検証 (2026-10-01 JST)

ユーザー指定の両 `optimized_webp_pdf` を、現行 `src/cli.js` の計画・実行可否・生成物検証関数でオフライン検査した。入力read leaseを保持し、runtimeと検査結果はOS一時directoryへ分離。Discord APIは使用せず、`.env`・投稿manifest・生成物・入力画像は変更していない。

- **main（分割前の検査）:** 4カテゴリ、160作品、189組（378添付）。全profileはv3で、全ZIP/PDFのサイズ・SHA-256一致、pair欠損なし、pendingなし、孤立profileなし、分割範囲のgap/overlapなし。最大ファイルは約9.7999MiBで10MiB以下。生成物自体の再変換は不要だが、`限定作品0930` が63作品のため、当時は現行CLIの50チャンネル制限で入力全体のrunがAPIアクセス前に停止した。この制限は、次節のユーザー承認済みカテゴリ分割で解消した。
- **rirr:** 2カテゴリ、35作品、35組（70添付）。全profileはv3で、全ZIP/PDFのサイズ・SHA-256一致、pair欠損・pending・孤立profileなし。カテゴリ別23作品/12作品、最大ファイル約9.7995MiB。現行CLIの投稿前検証に合格し、生成物はそのまま利用可能。
- mainの25分割作品は添付合計が25MiBを超えるため、従来どおりautoモードでは各ファイルを同一作品チャンネルへ個別投稿する。今回の合格はローカルファイルと計画の検証であり、実Discordの権限・現在状態・投稿成功を確認した結果ではない。
- 検査結果: main `C:\Users\Haritan\AppData\Local\Temp\discord-existing-output-check-pj7yna\result.json`、rirr `C:\Users\Haritan\AppData\Local\Temp\discord-existing-output-check-VxqwIs\result.json`。OS一時directoryのため将来の保持は保証しない。

### メイン投稿カテゴリの32/31作品分割 (2026-10-01 JST)

- ユーザーが用意した `optimized_webp_pdf/限定作品0930_1` と `限定作品0930_2` が空で、標準manifestに元/移動先カテゴリの記録がないことを確認。現行CLIの作品名順で63作品を32/31に分けた。投稿・変換と同じ共有runtimeのwrite leaseで出力rootを保護し、移動中は各作品のpending markerを元/移動先へ置いた。
- `_1`: 32作品、34組（68添付＋34 profile）。`_2`: 31作品、40組（80添付＋40 profile）。自動分割された作品の全part・ZIP・PDF・profileを同一カテゴリへ移動。222ファイルすべての移動前後SHA-256一致を確認し、内容は変更していない。
- 空になった元カテゴリは削除せず、`C:\Users\Haritan\Documents\discord-post-tool\tmp\category-split-3a994370-d0df-456a-9ac2-03a1c3c07203\限定作品0930` へ退避した。元カテゴリを投稿入力から外すことで空のDiscordカテゴリ作成を避けた。同directoryの `plan.json` / `progress.ndjson` / `result.json` に移動対応・検証結果を保存（Git対象外）。
- 事後のmain全体は5カテゴリ、160作品、189組（378添付）。カテゴリ別32/31/33/44/20作品で全て50以下。現行CLIの `assertRunnablePlan` と `validateGeneratedOutputs` に合格、pending marker 0、標準manifestのhash不変を確認。原本画像・`.env`・他カテゴリ・rirr生成物は変更していない。実Discordへの接続・投稿は未実施。
- 今回は投稿用生成物だけのカテゴリ配置変更。将来再変換する場合、入力側のカテゴリ指定/構成が旧 `限定作品0930` のままだと旧カテゴリへ再出力されるため、再変換の出力配置を合わせる必要がある。今回原本入力フォルダは移動していない。

### 実投稿中の内部APIロック更新EPERM (2026-10-01 JST、修正検証済み)

- **ユーザー提示ログの事実:** mainの限定作品0930_1への投稿中、request.mutex-v2内のUUID claimを一時ファイルから正式ファイルへrenameする処理でEPERMが発生し、CLIが終了コード1で停止。API待機が継続している状態ではない。カテゴリを32/31作品へ分けたことやZIP/PDFのサイズ超過を示すエラーではない。
- **コード上の事実:** src/runtime-locks.js:35のticket公開renameには再試行がない。unlinkにはEPERM/EACCES/EBUSYの再試行がある。ticket公開はwithFileMutexのaction実行より前なので、この失敗に対応するAPI呼出はまだ送信されていない。現在のtest/runtime-safety.test.jsは恒久的なrename失敗時の安全停止/回収を検証するが、一時占有からの自動復帰は未対応。
- **読み取り調査の事実:** mainの標準投稿manifestはJSONとして読み取り可能で、限定作品0930_1の9作品・18添付を記録。限定作品0930_2の記録はまだない。調査時の共有runtimeにはBot request claim/一時ファイル/job leaseはいずれも0件。履歴・生成物・入力・.env・runtimeは変更していない。Discordへの照会や投稿はしていないので、remote側の現在状態は独立確認していない。
- **追加試験の事実:** Node v24.18.1/Windowsで、現行withFileMutexのclaimを隠しPowerShell子プロセスのFileStream（FileShare.ReadWrite、Delete共有なし）で一時的に開き、実fs.renameを実行。EPERM/renameを再現し、action未到達、失敗後claim/一時ファイル0、子プロセスがhandleを解放した後の次回mutex取得成功を確認。全てOS一時directory内で実施。証拠: C:\Users\Haritan\AppData\Local\Temp\discord-mutex-sharing-review-96zjn3\result.json。
- **推測・未確認:** 実停止もWindowsの一時ファイル占有/共有条件による可能性があるが、占有したプロセスやEPERMの直接原因は特定できていない。Microsoft CreateFile公式仕様では、Delete共有がないopen handleはrenameも妨げる（https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea）。Defender無効化やACL変更で対処しない。
- **修正提案（承認前の記録）:** 自分のclaimを維持してEPERM/EACCES/EBUSY時のticket公開renameだけを短時間・回数制限付きで再試行し、継続失敗は現在どおり安全停止/回収する。unlinkして置換したりAPI POSTそのものを再試行したりしない。一時失敗後成功・継続失敗・実Windows共有違反・他プロセスとの相互排他の回帰試験を追加し、両cloneへ反映する。API待機state/lease/manifestにも同種のrenameがあるので修正時に適用範囲を確認する。今回は資料更新のみでソース変更/commit/pushはしていない。
- **承認後の実装・検証結果:** ユーザーのOKを受け、src/runtime-locks.jsのticket公開renameだけにEPERM/EACCES/EBUSYの100ms間隔・最大20回再試行を追加した。choosing claimを削除せず保持し、API送信/保存形式/排他方式は変更しない。Windows実handleからの復帰、継続失敗21試行で停止/回収、非対象エラー即停止、別プロセス生存owner維持、Bot POST1回の追加回帰が合格。両cloneへ対象コード/テスト/READMEを反映済み。各npm testは44件PASS（既存39件＋追加5件、fail/skip 0）。変更JavaScript 3ファイルの構文検査・両cloneのgit diff --checkもPASS、対象5ファイルのclone間一致を確認。lease/rate/manifestのrenameは今回の停止箇所ではないので変更していない。commit/push、実Discord、ユーザーデータの変更は行わない。
- **再開方針:** 標準manifestを保持し、同じ投稿入力・Guild・manifestで実行すれば既存の投稿済み判定とremote-checkを使用する。9作品・18添付はmanifest上の保存件数であり、Discord側の完全な成功証明ではない。現行コードの再実行だけでは一時占有の再発を防げない。

### 実投稿のサーバー全体500チャンネル上限 (2026-10-01 JST、対応方針待ち)

- **提示ログ・公式仕様:** POST /guilds/.../channelsがHTTP400、code30013、Maximum number of server channels reached (500)で拒否され、終了コード1で停止。カテゴリ内50枠とサーバー全体500枠は別の制約。全体500にはテキスト・ボイス・カテゴリを含み、Boostでも同じ（https://support.discord.com/hc/en-us/articles/33694251638295-Discord-Account-Caps-Server-Caps-and-More、https://docs.discord.com/developers/topics/opcodes-and-status-codes）。カテゴリ分割だけでは全体の空きは増えない。
- **ローカル読み取り調査:** CLIは終了しmain Electronだけが残る。標準manifestはJSONとして読み取り可能。対象Guildの履歴にはカテゴリ17 ID・作品チャンネル479 ID、重複除外496 IDがあるが、現在のDiscord上の存在は独立照会していない。限定作品0930_1は31作品・66添付の投稿記録あり、残り1作品/2添付。限定作品0930_2は未記録。これはローカル履歴の事実で、全サーバーの最新一覧を確認した数ではない。
- **現入力の残り（履歴基準）:** 現行buildLocalPlan/isPosted/groupFilesをメモリ内で読み取り利用し、全5カテゴリ160作品/378添付のうち31作品/66添付が保存済み、未投稿129作品/312添付を確認。カテゴリ別の未作成作品チャンネルは1/31/33/44/20、未作成カテゴリは4。履歴が現在のサーバー状態に一致すれば新規133枠が必要。最初の分割2カテゴリだけでも33枠（1作品＋31作品＋1カテゴリ）必要。Discord照会・.env読み取り・履歴/生成物の書換えは行っていない。
- **コード上の不足・修正提案:** src/cli.js:619で一覧を取得し、同:639でカテゴリ内50を検査するが、サーバー全体500と計画に必要な追加枠の事前検査がない。投稿前に取得したサーバー一覧と既存ID/名称再利用を使って新規カテゴリ＋作品チャンネルの必要数を算出し、空き不足を具体的な日本語で表示する案。外部ツール/ユーザーによる実行中の追加もあるため、30013の実行時エラー案内も必要。今回ソース修正は未実施・実装前確認待ち。
- **再開条件・保護:** 待機や同じ設定の再実行だけでは500枠不足を解消しない。不要チャンネルの整理（削除は投稿履歴/添付を失うため対象を事前確認）か、未投稿分だけを別Guildへ分配する。Guild変更だけで同じ全入力を実行すると新Guildでは投稿履歴が別なので投稿済み31作品も再投稿するため、分配する入力を先に確定する。勝手なサーバー操作、チャンネル/カテゴリ削除、入力移動、manifest編集は行わない。
- **別件の保留:** ユーザー依頼の画像変換速度の調査は読み取りを開始した段階で、本件停止報告を優先。測定・実装は未実施。投稿側の容量対応方針が決まった後、画質/容量/既存出力再利用への影響と一時画像での測定を調べる。

### vp0901の2カテゴリを各1チャンネルへ集約 (2026-10-01 JST、実行・最終検証完了)

- **選択された対象/形:** 限定作品vp0901_キャラ単体_ヌルテカと限定作品vp0901_キャラ単体_ノーマルを、それぞれ1チャンネルへ集約する（カテゴリは2つ維持）。カテゴリだけ統合して作品別チャンネルを残す方法ではない。
- **実Discordの読み取り事実:** 2026-10-01T01:42:56.742Zの開始時に、GUI画面/ローカルmanifestで特定したGuildへGETのみを使用。全体500チャンネル、対象各25 text channels/25 messages/50 attachments、合計50 messages/100 attachmentsを確認。全50メッセージは設定済みBotの投稿で、本文・他作者・pin・reaction・可視thread referenceなし。category内のchild IDは履歴と完全一致。各カテゴリ内でpermission_overwritesとNSFW flagが揃う。active target threadsとarchived public threadsは0。archived private threadsは50箇所とも403で未確認（0と断定しない）；ユーザーはprivate threadを作っていないと明示回答した。
- **添付名照合:** 履歴の元ファイル名（例の全角コロン以降の日本語）とDiscord側のfilenameが、対象100添付全てで異なる。message IDを特定した上でサイズ・拡張子による一意対応を取り、実CDNからバックアップした。移行の検証をfilenameの一致だけに依存させない。現行uploadGroupはisPostedの履歴判定を優先するので、正しいmessage/channel IDとサイズを保持したmanifestがあれば、この添付名差だけで再投稿する実装ではない。集約後は全25作品のgroup/filesのchannelIdと新messageIdを正しく移す。
- **復旧用データ:** C:\Users\Haritan\Documents\discord-post-tool\tmp\channel-consolidation-audit-8a20ea09-dcda-457b-9235-2d6be5a5d86a\ にaudit.json、summary.json、manifest-before.json、attachments/、backup-result.json、plan.jsonを保持（Git対象外）。100ファイル/997675777 bytes（約952MiB）を変換せず取得し、保存後に全ファイルを読み直してサイズ/SHA-256一致。Tokenや認証headerは保存していない。auditには投稿内容/添付URL等があるため、Gitやチャットへそのまま出さない。
- **具体的な移行案:** 既存akr-ヌルテカ/akr-ノーマルの各1チャンネルを残し、キャラ単体-ヌルテカ-まとめ/キャラ単体-ノーマル-まとめへ変更。残る24チャンネルずつの96添付を、本文なし・再変換なしで集約先へ移し、移行先実データをサイズ/hashで照合して履歴を更新した後、旧48チャンネルを削除する。新規チャンネルは0なので500枠でも着手可能。カテゴリと権限/NSFW設定は維持。コピーされた投稿は新message ID/日時となり、削除した旧チャンネル/メッセージURLは復元できない。バックアップから内容の復元は可能だが旧ID/日時の完全rollbackはできない。
- **容量の限界:** 500から452へ減り48枠が空く見込み。限定作品0930_1の残り1作品と限定作品0930_2の31作品＋1カテゴリに必要な33枠には足りる。現入力全体の履歴上の追加133枠には不足し、さらに85枠相当の対応が必要。全入力で再実行すると後続カテゴリで再び不足するので、再開範囲を絞るか追加の容量対応を決める。
- **承認/実行条件:** ユーザーが投稿/rename/manifest更新/旧48削除を含む具体的な計画に「実行してよいです」と明示承認。Guildとmanifest/stagingを共有leaseで保護し、開始時に対象ID・名前・権限・投稿内容とmanifest hashを再照合する。差分や曖昧なPOSTは停止し、blind retryしない。新投稿ID/添付hashとdurable journalを保存し、100添付の移行先SHA-256検証・履歴更新・集約先権限照合後に削除へ進む。個々のsource削除直前にも会話/public threadと対応する検証済み移行先メッセージを再確認する。対象GuildはGUI/manifestで特定したIDへ固定し、別の.env既定Guildに流用しない。今回ソースコード変更・commit/pushはしていない。
- **実行で確認した事実:** 直前GET照合は50 sources/100 backup files/全体500でPASS。独立の読み取り専用verify-plan.jsでもplan/audit/manifest-before/100 backup実体の全対応を照合し、2 operations/50 sources/48 delete IDs/100 attachments、failures 0でPASS。48本文なしメッセージ・96添付を既存2チャンネルへコピーし、元から残る4添付を含む100添付をCDNから再取得して全サイズ/SHA-256一致を確認。その後main manifestをatomic保存、集約先2チャンネルをrenameし、権限/NSFW等の不変をGET確認。各削除直前にsourceの投稿・権限・public archived/active threadsと対応する検証済みdestinationを再確認し、指定旧48 IDだけを削除してGET404とjournal receiptを保存した。
- **最終実機/履歴検証:** 2026-10-01T02:09:35.526Zに、サーバーの最終channel ID集合が開始時から指定48 IDのみを除いた集合と一致し、452 channels/48 free slotsを確認。各対象カテゴリのchildは1、各25 messages/50 attachmentsをfresh GETで照合。残した既存チャンネルはキャラ単体-ヌルテカ-まとめ（1543883449058992210）とキャラ単体-ノーマル-まとめ（1543884214611746937）。独立のverify-final.jsで現在manifestの50 groups/100 file recordsが新message/channel IDsと一致し、現行isPostedが全件true、他カテゴリ/他Guildの履歴不変を確認。実行中の例外・曖昧なPOST・未完了削除はなし。
- **保全/再開:** tmp/channel-consolidation-audit-8a20ea09-dcda-457b-9235-2d6be5a5d86aに100添付（997,675,777 bytes）、元manifest/投稿snapshot、plan、durable execution.ndjson、execution-result.json、独立照合スクリプト/証拠を保持する。snapshotは期限付き添付URLを含む私的ローカル資料でありGit/公開資料へ追加しない。移行は完了済みの一回限りで、migrate.jsを再実行しない。rirrのmanifest/生成物、別Guild、他カテゴリへのDiscord書込は行っていない。残り投稿は未実行。集約完了時点の48空きは限定作品0930_1→限定作品0930_2の再開に必要な33枠を満たすが、その時点では全入力に85枠不足だった。最新の容量は後述の絵柄サンプル削除結果を参照。今回本番ソース・依存関係の変更、Git操作はなし。

### 絵柄サンプル内30チャンネルの削除 (2026-10-01 JST、削除・最終検証完了)

- **承認/対象:** ユーザーから絵柄サンプルのカテゴリ内全チャンネルの削除を明示依頼された。同じGUI/manifestで特定したGuildへ固定し、同名category type 4が1件だけであることと、配下30件が全てtype 0であることをGET確認。category ID 1543882466538950729と30 child IDsをローカルplanに固定。カテゴリ自体の削除、別Guild/カテゴリの削除、投稿/カテゴリ作成等は許可しない一回限りの操作とした。
- **削除前の保全/範囲:** Guildと投稿input/manifestのread leasesを保持。30 channels/30 messages/60 attachmentsをsnapshotし、162,394,899 bytesの添付を取得・fsync・readback SHA-256照合した。可視active/public archived threadsは0（private archivedの完全なバックアップは保証しない）。各DELETE直前にsource channelのGuild/parent/権限/名前/投稿と可視threadを再照合。指定30 IDのみDELETEし、各GET404とdurable intent/ackを記録。保存snapshotは期限付きURLを含む私的ローカル資料のため公開/Gitへ追加しない。
- **最終実機事実:** 2026-10-01T02:29:03.070Zに最終channel ID集合が開始時の集合から指定30 IDだけを除いたものと完全一致。カテゴリとその設定は維持、配下は0、422 channels/78 free slotsをGET確認。main manifestのSHA-256不変を確認。rirrのmanifest、他Guild、画像/生成物、.env、実行中GUI、本番ソース/依存関係は変更していない。Git操作なし。tmp/style-sample-delete-20261001にplan、元channels/messages/manifest、60添付/hash、journal、execution-result.jsonを保持。完了済みのoperate.jsを再実行しない。
- **残り投稿容量:** 最新ローカルplanと実Discordの既存ID/同名チャンネル再利用を照合した必要追加枠は、限定作品0930_1が1、限定作品0930_2が32、限定作品0930_ランダムが34、限定作品vp0930_1が45、限定作品vp0930_2が21、合計133。既存方式で全て投稿するには、78空きに対して55不足。例えば0930_1→0930_2→vp0930_1の3カテゴリ分は1+32+45=78枠で収まるが全体上限ちょうどになり、後続ランダム/vp0930_2の34+21=55枠がない。追加の旧チャンネル集約/整理か、新規投稿分のチャンネル集約/別Guild分配が必要。今回残り投稿を自動実行していない。
- **履歴を保持する理由/再作成:** 削除したサンプルの過去manifest entriesは保全のため残した。現在の投稿入力5カテゴリには絵柄サンプルが含まれないので、通常の現入力再開では再作成されない。別途サンプルの元入力を投稿すると、現行recreateMissing既定動作でチャンネル/添付が作り直され得る点に注意する。

### 元Guild上限到達後の未投稿分を別サーバー用へ抽出 (2026-10-01 JST、コピー・検証完了)

- **依頼/対象:** ユーザーの再実行ログはHTTP400/code30013で停止。既存の元Guildへもう一度投稿できる限界まで進めたあと、未投稿分だけを別フォルダへまとめるよう依頼された。元のoptimized_webp_pdf/manifestは保持し、別Guildへの実投稿やGUI設定変更は行わず、データコピーだけ実施した。
- **照合の事実:** 元Guild IDをGUI/manifestの1510449199622131742へ固定し、Guildの排他lease、input/manifestのread leases、コピー先write leasesを保持。現行CLIのbuildLocalPlanで160作品/378添付を探索し、GETで元Guild500 channelsを確認。既存category/group ID・名前による再利用を照合し、履歴の各message IDを実message historyと対応させ、設定済みBotの作者ID、channel ID、添付サイズ/拡張子の一意一致を確認して投稿済みを除外した。Discord側でfilenameが正規化されるため、名前一致だけで判定しない。未記録の成功投稿は必要時のみ実添付hashで確認する設計だが、今回は該当0。結果は投稿済み107作品/236添付、全未投稿53作品/142添付、部分投稿作品0。Discord APIはGETのみ。
- **完成した入力:** C:\Users\Haritan\Documents\discord-post-tool\optimized_webp_pdf_unposted_20261001。限定作品vp0930_1は33作品/94添付、限定作品vp0930_2は20作品/48添付。142 ZIP/PDF（1,338,658,505 bytes）＋対応する71 assets.json=213ファイルをカテゴリ/元ファイル名/範囲番号のままCOPYFILE_EXCLでコピーした。投稿済み107作品や元manifest/.envはコピー先へ含めない。元ファイルの移動/削除・再変換なし。
- **検証/公開範囲:** stagingで現行assertRunnablePlan/validateGeneratedOutputsを通し、全コピーの元/先SHA-256一致を確認してから完成フォルダへrename。完成後も全213ファイルのhash、投稿計画2カテゴリ/53作品/142添付、profile/pending検査を再確認した。元manifestのSHA-256不変、元Guildのchannel ID集合不変、元ファイル保持を確認。既存optimized_*/ ignoreで抽出フォルダはGit対象外。tmp/unposted-export-20261001に元manifest、channel snapshot、classification.json、copy-proof.json、result.jsonと一回限りのexport.jsを保持。完成済みexport.jsを再実行しない。分類記録は投稿履歴に基づくサイズ/ID照合であり、既存投稿全236添付をCDNからhash再照合したという主張はしない。
- **次回投稿:** 別サーバー側GUIで、上記完成フォルダを投稿入力に指定し、投稿先Guild IDを確認する。新規に全カテゴリ/作品チャンネルを作る場合は2+53=55枠が必要（各カテゴリ33/20作品で50枠制限内）。別Guildの空き/権限は今回未確認。元の全入力を新Guildへ指定すると投稿済み107作品も新Guildでは未投稿扱いになり重複するため、必ず抽出フォルダを使用する。元Guild/別Guildへの追加POST、カテゴリ/チャンネル作成/削除、本番ソース変更、Git操作、rirrの入力/manifest変更は今回行っていない。

### 画像変換速度の調査 (2026-10-01 JST、以下は導入前の調査記録)

- **コード上の事実:** src/build-assets.js:95の画像並列数は既定4。src/build-assets.js:552-556でZIP探索とPDF探索を順番に実行し、636-722の各候補ごとに全画像を再エンコードする。WebPは品質だけ指定（sharp既定effort 4）、JPEGはmozjpeg:true/progressive:true/4:2:0。sharp.concurrency()やUV_THREADPOOL_SIZEを本番コードから設定していない。品質を固定する既存機能は探索回数を減らすが、容量に余裕がある作品の品質向上や重い作品の容量調整に影響するため、今回の第一候補にはしない。
- **実機/公式資料:** MAIN DESKTOP-5NPLIIV、32 logical processors、installed sharp 0.34.5/libvips 8.17.3、sharp.concurrency()=32、シェルのUV_THREADPOOL_SIZEは未設定を確認。公式資料では画像の同時処理上限はlibuv pool（既定4）、1画像内のthreadsはsharp.concurrency()で管理する別の設定（https://sharp.pixelplumbing.com/performance/、https://sharp.pixelplumbing.com/api-utility/#concurrency、2026-10-01参照）。WebP effort 4とmozjpegの速度/容量のトレードオフはhttps://sharp.pixelplumbing.com/api-output/で確認。依存関係更新やGPU/Driver変更は不要な案。
- **測定方法:** raw_imagesの既存1248×1824 PNGを一時フォルダへコピーしSHA-256一致を確認。元画像への書込なし。32枚のWebP q75＋JPEG q75/1600pxを各構成2回、別Node子プロセスで測定。次に同じsource folderの100枚をコピーし、現行build-assets mainを一時input/output/runtimeだけで実行（計測wrapperによるstage timing以外は現行処理）。現構成と候補構成を各2回、2回目は順番を反転して測定。Discord APIは呼ばず、ユーザー生成物の上書き・forceはなし。元32/100画像の処理後SHA-256不変と、現行の最終出力検証成功を確認。

| 32枚・1候補ずつの構成 | UV pool / 画像並列 / 1画像threads | 平均秒 | ピークRSS最大MiB |
| --- | --- | ---: | ---: |
| 現設定 | 4 / 4 / 32 | 1.990 | 254.8 |
| 画像並列数だけ8 | 4 / 8 / 32 | 1.955 | 258.6 |
| 1画像threadsだけ2 | 4 / 4 / 2 | 1.798 | 199.5 |
| UV poolと画像並列を8 | 8 / 8 / 32 | 1.206 | 366.7 |
| 推奨候補 | 8 / 8 / 2 | 1.002 | 246.8 |
| より強い並列候補 | 12 / 12 / 2 | 0.812 | 338.2 |

- **100枚セット全体の確認事実:** 現設定31.360/32.146秒（平均31.753）、8/8/2候補16.651/16.741秒（平均16.696）。約47.4%時間短縮、約1.90倍の処理速度。両構成ともZIP探索5回/採用品質80/10,062,601 bytes、PDF探索3回/品質73/長辺1504px/10,275,935 bytesで一致。選択された100 WebP＋100 JPEGのエンコード済みbuffer hashが全件一致し、サンプルでは画質/容量/分割条件を変えていない。ZIP/PDFコンテナ自体のhash同一は主張しない（作成時刻等のmetadataが異なり得る）。ピークRSS最大は現設定347.1MiB、候補370.0MiB（約22.9MiB増）。32枚単一パスでも全構成の画像hashが一致。
- **提案/推測:** まず変換子プロセスだけUV pool=8、画像並列=8、sharp threads=2に設定する案が有望。品質探索・出力検証・再開・自動分割・投稿形式のアルゴリズムは維持できる見込み。GUIの並列数だけ8へ変えても、UV pool=4のままでは今回ほぼ改善しなかった。12並列は32枚でより速いがメモリ/CPU負荷が増え、100枚全体未測定なので既定の第一候補は8。CPU利用が増えるため、他の重い処理や両clone同時変換での負荷は別途測定する。PDF/ZIPを同時探索する案はピークメモリと並列数をさらに増やし、raw image cacheは100枚で大きくメモリを使うため優先度を下げる。effort低下/mozjpeg無効化は出力容量・画質が変わり得るため第一候補から外す。
- **限界/未実装:** 上記は同PC・同一100枚セットの一時データ測定であり、全作品・他PC・両clone同時処理に47%を保証しない。重い自動分割セット、長時間処理、CLI/GUIへの設定導入と回帰検証は未実施。本番コード・GUIの保存値・依存関係・.envは未変更。実装する場合はユーザー確認後、対応設定だけ変更して両cloneへ反映し、品質/容量/hash、スキップ/分割/排他を検証する。tmp/conversion-speed-probe-20261001に一時画像、source hash proof、bench.js/full-bench.js、results.json/full-results.json、生成物を保持。新しいGit操作は未実施。

### 画像変換高速化の既定設定導入 (2026-10-01 JST)

- **承認/実装:** ユーザーが上記候補をデフォルト化しmainへpush、rirrへ同期することを明示承認。画像並列数8、1画像内のsharp threads 2、UV pool未指定時8を導入。GUIは変換子プロセスのspawn環境で設定し、直接CLIはnative module読込/非同期処理より前に設定する。明示的なUV_THREADPOOL_SIZEは尊重し、投稿子プロセスへ変換設定を追加しない。wrapper/孫プロセスは追加せず、既存の停止・PID leaseの構造を維持する。
- **GUI保存値:** assetPerformanceVersion=1を独立追加し、旧既定値4と未指定値だけ一度8へ移行する。並列数2/6/12などのカスタム値、入力/出力パス、画質、Guild、選択タブは保持。移行後に4へ変更しても再移行しない。既存assetProfileVersionは4のままで、出力profileVersionも3を維持し、既存生成物を高速化設定の変更だけで再生成しない。
- **回帰検証:** 追加5テストでCLIの既定8、直列設定との品質/容量/ZIP・JPEG hash一致、既存生成物のスキップ、GUI設定移行/カスタム値保持/移行後4の保持、変換専用envと明示envの尊重を確認。メイン側npm testは49件PASS。独立レビューでは直接CLIの冒頭設定と起動時env設定の両方でUV pool 8相当の動作をpbkdf2比較で確認し、コード上の要修正点なし。両cloneでの最終検証/同期結果は下に記録する。
- **両cloneの最終検証:** 各npm testは49件PASS/fail・skip 0。両cloneの実CLIを同時に起動し、保存していた実100枚のテストコピーを共通読取入力・独立出力・private runtimeで変換した。両方とも生成100 WebPと100 JPEGのhash集合、ZIP/PDF容量、採用品質/解像度が導入前測定と一致、pending markerなし、入力コピー/.env/manifest不変を確認。旧測定の元画像パスはユーザー側の現配置に存在しないため元画像hashの再確認はせず、保持済みコピー100枚を既存proofと照合した。今回の同時変換は品質・安全性検証で、所要時間の比較測定は主張しない。変更JavaScript構文検査、両cloneのdiff --check、独立レビューPASS。証拠はtmp/conversion-default-rollout-20261001（Git対象外）に保持。
- **公開/同期:** 承認範囲のコード/テスト/README/本資料をmainへcommit/pushし、rirrは今回の変更と従来の未commit資料を対象パス限定のstashに保全してfast-forward同期する。従来のstash、ユーザー未追跡フォルダ、認証情報、manifest、入力/生成物は保持する。依存関係変更なし。
- **残る限界:** 導入前の約47.4%短縮は同一100枚セットの測定値で全作品の保証ではない。長時間処理、他の重いアプリとの競合は未検証。CPU負荷が高い場合はGUIの並列数を下げる。稼働中GUI/CLIを停止・再起動せず、GUI保存値の実移行は更新後の次回起動で行う。依存関係/.env/ユーザー画像・生成物・manifestは変更しない。

### 同時実行対応の最終確認 (2026-09-30、修正前の履歴)

- main/rirrの両方で `npm test`: 12件すべて成功。
- 実Nodeプロセス2つで同じ出力先の競合、独立出力の実画像変換、変換と投稿の相互排他、同じGuildの投稿拒否、別Guildの同時投稿、同じmanifestの競合、投稿済み4添付の再実行スキップを確認。
- 強制終了した子プロセスのlease回収と再実行を確認。フォルダ親子関係・Junctionの別名も排他対象。
- 模擬HTTPで同じBotのプロセス間429/残数0の待機共有を確認。Bot Tokenが管理ファイルに含まれないことを確認。
- 2つの実cloneで非表示Electronを同時に起動: 終了コード0、別のuserData/sessionData、キャッシュエラー0。mainの追加起動は2つ目のrendererを作らず終了。
- `node --check`: 変更したJavaScript 9ファイル成功。`git diff --check` 成功。
- 両cloneへコード/テスト/README/本ファイルと依存関係を反映。既存 `.env` / manifest / ユーザー画像・生成物は維持。実サーバーへの投稿、commit/pushは行っていない。

実行済みコマンド:

```bash
node --check src/cli.js
node --check src/build-assets.js
node --check src/gui/launch.js
node --check src/gui/main.js
node --check src/gui/preload.js
node --check src/gui/renderer/renderer.js
npm run app:smoke
npm run plan -- --input ./optimized_webp_pdf
npm test
npm run build-assets -- plan --input ./raw_images --chunk-size 100
npm run build-assets -- run --input ./raw_images --output ./optimized_webp_pdf --set <現行最大セット> --chunk-size 100 --force
npm run build-assets -- run --input ./_8月ランダムえすえー --output ./tmp/profile-v3-heavy-regression --set <保管データ最大セット> --chunk-size 100 --force
```

確認できたこと:

- `optimized_split` は範囲付きファイルを同一チャンネルへまとめて読み取れる。
- `raw_images` はカテゴリ配下の作品フォルダを検出できる。
- 最大級100枚は範囲名なしの1 zip＋1 pdfとして生成される。
- ZIPは100件すべて`.webp`で、1248×1824の元解像度を維持。品質75で10,164,390 bytes（9.6935MiB）。
- PDFは100ページ、各ページ924×1350。JPEG品質70で10,027,539 bytes（約9.5630MiB）。
- 投稿CLIは上記を1チャンネル・2添付・合計約19.3MiBとして認識し、10MiB/25MiBの事前検査を通過。
- 実データ`健屋花那 ランダム：mot`（100枚、元268.21MiB）は100枚ZIPがWebP品質60でも上限超過するが、自動的に50枚＋50枚へ分割し、ZIP 9.72/9.75MiB、PDF 9.59/9.59MiBで生成できた。
- 上記自動分割出力の再実行では2組とも検証後にスキップし、投稿計画は1カテゴリ・1チャンネル・4ファイルとして認識した。`auto`投稿モードでは25MiBを超えるため各ファイルを個別投稿する。
- 自動テストで、通常の2ファイル生成、自動分割、分割済み再開、片方のPDF欠損時の再生成、4ファイルの同一チャンネル集約を確認。
- `npm test`で軽いデータがWebP q85・PDF 1600px/q75へ上がることと、重い疑似データでWebPが基準q75未満へ戻ることを自動確認。
- 現行テスト最大セット（100枚、元225.13MiB）はWebP q81で9.39MiB、PDF 1504px/q73で9.32MiB。
- 保管データ最大セット（100枚、元235.12MiB）はWebP q83で9.61MiB、PDF 1552px/q74で9.47MiB。
- Discord投稿はカテゴリ作成、チャンネル作成、ファイル投稿まで動作した。
- 投稿本文なしの添付のみ投稿へ変更済み。
- Electronアプリの短時間起動スモークテストが成功した。
- Guild ID確認機能追加後も `node --check` と `npm run app:smoke` は成功。
- 2026-09-30より前の版は、GUIが既に開いている場合に `npm run app:smoke` でキャッシュ作成警告が出た。現行版は保存領域分離と単一起動で、2つのcloneの同時起動でも警告が出ないことを確認。
- ログ欄スクロールCSS変更後も `npm run app:smoke` は成功。
- ウィンドウサイズ拡大とUI余白調整後も `node --check src/gui/main.js` と `npm run app:smoke` は成功。
- clone後セットアップ手順README追記と `start-gui.bat` 初回install対応後も `npm run app:smoke` は成功。
- GUI保存キーのプロジェクト別分離後も `node --check src/gui/renderer/renderer.js` と `npm run app:smoke` は成功。

まだ確認できていないこと:

- GUI上での実操作。
- GUIのGuild ID確認ボタンによる実サーバー名取得。
- すべての現行実データを新プロファイルで一括生成した場合に、WebP品質65またはPDF長辺900pxまで下げても超過する作品がないか。
- 大量サーバー/大量カテゴリでのDiscordレート制限の実運用安定性。
- manifestとDiscord側の状態が大きくずれた場合のGUIでの復旧操作。

現在把握しているエラー履歴:

- Bot投稿で20MiB級ファイルを送ると `HTTP 413 {"message": "Request entity too large", "code": 40005}` が発生した。BotにはユーザーNitro上限が適用されないため、10MiB未満へ圧縮する方針になった。
- 投稿済みスキップ周りで、manifestとDiscord側の状態がずれて重複投稿/安全停止した履歴がある。現在は入力フォルダを正として削除済みカテゴリ/チャンネルを作り直す仕様に変更済み。
- 品質90固定では9.8MiBを超過し、正常にエラー停止した。
- 2026-07-21、`raw_images` の全5,100画像を検査し、`755765.png` 1件が画像データとして読めないことを確認。ファイルは2,423,012バイトすべてが `0x00` で、元データからの再コピーまたは再出力が必要。

## 重要なファイル・ディレクトリ

- `src/runtime-locks.js`: フォルダ/Guild/manifestの同時実行保護。
- `src/process-identity.js`: PID＋作成時刻の所有者照合。観測不能は安全側に保持する。
- `src/discord-request.js`: 同じBotのプロセス間API待機共有。
- `src/gui/project-profile.js`: プロジェクト別Electron保存領域と旧設定の移行。
- `test/concurrency.test.js`: 複数プロセス、同時変換、模擬Discord投稿、429待機の回帰テスト。
- `test/project-profile.test.js`: 保存領域分離、旧設定コピー、既存設定保持の回帰テスト。
- `test/runtime-safety.test.js`: 33秒停止、生存所有者、強制終了、PID再利用モデル、解放失敗・管理情報異常の回帰テスト。
- `test/artifact-safety.test.js`: 中断生成物の投稿拒否・再変換復旧、manifest staging・正式パス衝突の回帰テスト。
- `test/discord-request.test.js`: 通信例外・abort・429上限・別Bot独立実行の回帰テスト。
- `test/path-safety.test.js`: 変換・投稿入口で配下Junctionを安全停止する回帰テスト。
- `src/cli.js`: Discord投稿CLI本体。
- `src/build-assets.js`: 画像変換、zip/pdf生成CLI本体。
- `src/gui/launch.js`: Electron起動ランチャー。環境変数 `ELECTRON_RUN_AS_NODE` を削除し、CLI実行用Nodeパスを `DISCORD_POST_TOOL_NODE` で渡す。
- `src/gui/main.js`: Electronメインプロセス。CLIを子プロセス起動し、ログをrendererへ送る。
- `src/gui/preload.js`: renderer向け安全API。
- `src/gui/renderer/index.html`: GUI画面。
- `src/gui/renderer/styles.css`: GUIスタイル。
- `src/gui/renderer/renderer.js`: GUI操作とIPC連携。
- `README.md`: ユーザー向け手順。
- `docs/ai_context.md`: AI引き継ぎ用ドキュメント。このファイル。
- `package.json`: npm scriptsと依存関係。
- `start-gui.bat`: Windows向けGUI起動bat。
- `.env.example`: 環境変数サンプル。
- `.env`: 実トークンを含むローカル設定。内容を外部に出さない。
- `.discord-post-tool-manifest.json`: Discord作成済み/投稿済み状態。ローカル状態ファイル。
- `raw_images/`: 画像変換前の入力。カテゴリ/作品フォルダ構成。
- `optimized_webp_pdf/`: 現行の非分割変換出力・投稿入力。
- `optimized_split/`: 旧50枚分割方式の生成済み出力。ユーザーデータとして保持し、新出力と混在させない。
- `example/`: 初期検証用のzip/pdf入力。
- `tmp/`: 検証用一時出力。

想定する `raw_images` 構成:

```txt
raw_images/
  カテゴリ1/
    作品名_png/
      001.png
      002.png
    作品名_jpg/
      001.jpg
      002.jpg
  カテゴリ2/
    作品名_png/
      001.png
```

想定する `optimized_webp_pdf` 構成:

```txt
optimized_webp_pdf/
  カテゴリ1/
    作品名.zip
    作品名.pdf
    作品名.assets.json
```

投稿CLIは後方互換として旧出力の範囲ファイルも判定する:

- `<作品名>_<開始番号>-<終了番号>.zip`
- `<作品名>_<開始番号>-<終了番号>.pdf`

末尾が `_数字-数字` の場合だけ、その部分を外してチャンネル名の元にする。単純に最初の `_` より前で分けるわけではない。

例:

- `作品名_1-50.zip` と `作品名_51-100.pdf` は同じ `作品名` チャンネル。
- `作品名_通常_1-50.zip` と `作品名_通常_51-100.pdf` は同じ `作品名_通常` チャンネル。
- `作品名_1-50.zip` と `作品名_修正版_51-100.zip` は別チャンネル。

## 注意事項・制約

- 既存仕様を壊さないこと。
- GUI化時もCLIの基本仕様を維持すること。
- 影響範囲が大きい変更は、理由と影響範囲を明確にすること。
- ユーザーが作成・変更したファイルを勝手に上書きしないこと。
- 自分が変更していない差分を勝手に修正・削除しないこと。
- `.env` のBot Tokenを出力しないこと。
- `.discord-post-tool-manifest.json` はローカル状態として重要。削除や大幅編集はユーザー確認なしに行わないこと。
- `raw_images`、`optimized_webp_pdf`、`optimized_split` はユーザーデータを含む可能性がある。勝手に削除しないこと。
- 画像変換で `--force` を使うと既存出力を上書きする。実行前に入力/出力フォルダを確認すること。
- Discord APIのレート制限を考慮すること。大量投稿時は急がせすぎない。
- 同時実行保護は対応版・同一PC・同一Windowsユーザーのみ。両cloneへ同じ修正を反映すること。更新時は両GUI/CLIを終了する。2026-10-01の修正版とそれ以前の同時実行対応版はmutex方式が異なるため混在させない。旧版、他PC、別ユーザー、外部ツールとの排他は保証しない。
- `%LOCALAPPDATA%\discord-post-tool\runtime-v1` の実行中leaseやAPIロックを手動削除しない。PID＋作成時刻で所有者を照合し、生存所有者は時間で解除しない。終了確認できた所有者は次回実行時に回収し、観測失敗は安全停止する。旧PID-only leaseのPIDが生存している場合は回収しない。
- rootのJunctionは実体パスで対応するが、入力/出力配下のJunction・シンボリックリンクは安全停止する。生成物のpending markerやhash不一致は再変換で復旧し、marker/profile削除による投稿回避は行わない。profileなしの旧・手動入力は互換維持のため許可するので、旧版が中断した生成物の完全性は保証できない。
- 同じ出力フォルダへの変換と投稿は同時実行を止める。変換完了後に投稿する。別フォルダ・別Guildでの同時実行でもCPU/メモリ負荷とDiscord側の制限は残る。
- 不明点がある場合は推測で大きく進めず、必要に応じて確認すること。

## Git 操作に関する厳守事項

危険なGit操作は絶対に行わないこと。

特に以下は禁止:

- `git reset`
- `git reset --hard`
- `git clean`
- `git checkout -- .`
- `git restore .`
- `git push --force`
- `git push -f`
- `git rebase`
- 履歴を書き換える操作
- ユーザーの許可なくファイルを削除する操作

コミット、ブランチ作成、push、pull、merge、rebaseなどが必要そうな場合は、実行前に必ずユーザーに確認すること。

既存の変更を勝手に破棄しないこと。

Git操作を提案する場合は、実行内容とリスクを説明すること。

このプロジェクトはGitHubでGit管理済み。今後の操作にも上記ルールを適用すること。

## 運用ルール

- 次回以降のAIエージェントは、作業開始時にまずこの `docs/ai_context.md` を読むこと。
- 重要な進捗があったら `docs/ai_context.md` を随時更新すること。
- 方針変更、重要な実装完了、問題の発見、未完了タスクの追加・解決があった場合は必ず追記すること。
- 作業を中断する前、または一段落したタイミングで、最新状況を反映すること。
- 次回セッションのAIエージェントがこのファイルを最初に読む前提で、簡潔かつ具体的に書くこと。
- このファイルを更新する場合、既存内容を尊重し、必要な情報を追記・整理すること。
- 既存内容を大きく削除・置換する場合は、事前に理由を説明すること。

## 更新履歴

- 2026-10-01: ユーザーが検証済み同時実行対応のmainへのcommit/pushとrirr最新化を承認。実Discord・ユーザーデータは公開/更新の対象外とし、rirrの同一修正差分を保全してfast-forward更新する手順を採用。
- 2026-10-01: 未commitの同時実行対応をコードレビューし、当初は修正を提案のみとした。その後ユーザー承認を受け、指摘5件と修正中に見つかった孤児claim管理・Guild key・staging探索を修正。両cloneに反映し、各39テストPASS、隔離Electron同時起動PASS。実Discord・実データ長時間検証・commit/push/pull/branch作成は未実施。
- 2026-05-14: 初版作成。CLI投稿ツール、画像変換CLI、Discord制約、品質探索/固定品質モード、manifest運用、GUI化前の未完了タスクを整理。
- 2026-05-14: Electronデスクトップアプリを追加。画像変換/Discord投稿タブ、フォルダ選択、CLI実行ログ表示、`npm run app` / `npm run app:smoke` を追加。
- 2026-05-14: Windows向けGUI起動用 `start-gui.bat` を追加。
- 2026-05-14: GUIのGuild ID欄にサーバー名確認機能を追加。Discord APIからGuild名を取得して表示する。
- 2026-05-14: GUIの固定品質欄を「品質固定で高速化する」チェック時のみ有効化。JPG保存オプションの表示名を「zip/pdf用JPGも保存する」に変更。
- 2026-05-14: GUIのログ表示欄がアプリ全体を縦に伸ばさないよう、ログ本文のみスクロールするCSSへ修正。
- 2026-05-14: 起動時ウィンドウを大きくし、メニューバー自動非表示とフォーム余白調整でログ欄の可視領域を拡大。
- 2026-05-14: GitHub管理開始準備。リポジトリURLを記録し、`.gitignore` に `raw_images/` と `example/` などの実データ/生成物除外を追加。
- 2026-05-14: Git初期化、`Initial commit` 作成、`origin` 設定、`main` ブランチをGitHubへpush完了。
- 2026-05-14: READMEにclone直後の初回セットアップ手順を追加。`start-gui.bat` は依存関係未導入時に `npm install` を実行するよう変更。
- 2026-05-16: GUIの入力内容保存をプロジェクト絶対パスごとに分離。別サーバー用にフォルダを分けた場合、前回別プロジェクトの入力内容が残らないように変更。
- 2026-05-16: READMEからユーザー名、ローカルパス、実データ由来の固有名詞を除去。複数プロジェクト運用の説明は汎用例に置き換えて維持。
- 2026-07-21: 画像変換前の入力画像検査を追加。破損画像や形式不一致がある場合、該当ファイルのパスと理由をGUI/CLIログへ表示して、出力生成前に停止するよう変更。変換中の読み取りエラーにもファイルパスを付与し、READMEへ対処方法を追記。
- 2026-08-23: 100枚を分割しない新プロファイルへ変更。ZIPは元解像度WebP品質75～70、PDFはJPEG品質70・長辺1350～900pxとして独立生成・判定する。GUI既定値、CLI引数、README、出力プロファイル、Node組み込みテストを更新。最大級100枚でZIP 9.6935MiB、PDF約9.5630MiB、投稿事前検査成功を確認。
- 2026-08-23: 出力プロファイルv3へ更新。出力先を`optimized_webp_pdf`へ統一し、GUIの旧保存パスも移行。WebPはq75基準・q70～85、PDFは1350px/q70基準・900～1600px/q70～75として、9.8MiB以内で上方向・下方向へ自動探索する。現行100枚最大セットと保管データ100枚最大セットで各1 ZIP＋1 PDF、いずれも9.8MiB以内を確認。
- 2026-08-31: 新規100枚セットでWebP q70が9.96MiB、q69が9.84MiBとなり9.8MiBを超える事例を確認。q68では9.71MiBで収まったため、元解像度と100枚1組を維持したまま必要なセットだけ品質を下げられるよう、WebP探索下限の既定値を70から65へ変更。GUI保存スキーマv4で旧既定値70を65へ移行し、上限超過エラーを日本語化。旧最低品質70の正常出力は、採用品質が現行下限以上なら再利用できるよう互換判定を追加。
- 2026-09-10: 軽い作品は1 zip＋1 pdfを維持し、最低設定でも上限を超える重い組だけを半分へ自動分割する処理を追加。分割済み再開・欠損再生成・Discord上の1チャンネル4ファイル集約をテストし、実データ100枚でも50枚＋50枚への自動切替を確認。
- 2026-09-30: Electronの保存/キャッシュ領域分離、旧設定のコピー移行、GUI同一プロジェクト単一起動、変換出力/投稿入力/Guild/manifestのプロセス間排他、同じBotのAPI待機共有を実装。両cloneへ反映し、それぞれ自動テスト12件成功。両clone同時GUI起動はキャッシュエラーなし、同一プロジェクトの追加GUIも抑止。実Discord投稿とcommit/pushは未実施。既存依存関係のaudit警告3件は別途対応候補。
