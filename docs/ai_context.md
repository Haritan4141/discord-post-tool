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
- `--concurrency <n>` を追加し、画像変換を並列化。デフォルトは4。
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
