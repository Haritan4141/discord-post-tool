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

達成したい状態:

- `raw_images` から10MiB未満のzip/pdfを生成できる。
- `optimized_webp_pdf` を投稿入力として、カテゴリ/チャンネル作成とファイル投稿ができる。
- 100枚を分割せず、1作品につき1 zip＋1 pdfを投稿できる。
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
- 画像変換は「ZIP＝元解像度WebP」「PDF＝縮小JPEG」の固定方針とし、各ファイルの実サイズを見ながら9.8MiB以内で品質を上げ、重いセットでは基準以下へ戻す。
- CLIで固めた動作をGUIから安全に呼び出す。

## 未完了タスク

残っている作業:

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
- WebP品質65でも超過する例や、PDF長辺900pxでも超過する例がないか。

保留中の判断:

- GUI技術スタックはElectronを採用。
- GUIのBot Token入力は保存しない方針。基本は `.env` を使う。
- 変換済み出力フォルダはGUIで選択可能。新方式のデフォルトは `optimized_webp_pdf`。

既知の問題や注意:

- `.discord-post-tool-manifest.json` はローカル状態を保持する。Discord側で手動削除や重複作成を繰り返すと、manifestとDiscord側の状態がずれる可能性がある。
- 投稿済み判定はmanifest中心。Discord側で投稿メッセージだけ削除した場合、manifestが投稿済みと判断してスキップする可能性がある。必要ならmanifest削除/編集や再検出機能を検討する。
- 同名カテゴリ/同名チャンネルが複数ある場合、意図しない対象を避けるため停止または明示的な解決が必要。
- 自動探索では候補ごとに100枚を再変換するため、旧固定基準より処理時間が増える。WebPは基準75を最初に試してから上限85側または最低65側を二分探索し、PDFは1600px/q75から1350px/q70までバランスよく下げ、その後900pxまで縮小する。

## 動作確認・検証状況

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
- `npm test`で軽いデータがWebP q85・PDF 1600px/q75へ上がることと、重い疑似データでWebPが基準q75未満へ戻ることを自動確認。
- 現行テスト最大セット（100枚、元225.13MiB）はWebP q81で9.39MiB、PDF 1504px/q73で9.32MiB。
- 保管データ最大セット（100枚、元235.12MiB）はWebP q83で9.61MiB、PDF 1552px/q74で9.47MiB。
- Discord投稿はカテゴリ作成、チャンネル作成、ファイル投稿まで動作した。
- 投稿本文なしの添付のみ投稿へ変更済み。
- Electronアプリの短時間起動スモークテストが成功した。
- Guild ID確認機能追加後も `node --check` と `npm run app:smoke` は成功。
- `npm run app:smoke` 実行時、GUIが既に開いている場合はElectronのキャッシュ作成警告がstderrに出ることがあるが、終了コードは0。
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

このプロジェクトは、確認時点ではGitリポジトリではなかった。今後Git管理を開始する場合も、上記ルールを守ること。

## 運用ルール

- 次回以降のAIエージェントは、作業開始時にまずこの `docs/ai_context.md` を読むこと。
- 重要な進捗があったら `docs/ai_context.md` を随時更新すること。
- 方針変更、重要な実装完了、問題の発見、未完了タスクの追加・解決があった場合は必ず追記すること。
- 作業を中断する前、または一段落したタイミングで、最新状況を反映すること。
- 次回セッションのAIエージェントがこのファイルを最初に読む前提で、簡潔かつ具体的に書くこと。
- このファイルを更新する場合、既存内容を尊重し、必要な情報を追記・整理すること。
- 既存内容を大きく削除・置換する場合は、事前に理由を説明すること。

## 更新履歴

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
