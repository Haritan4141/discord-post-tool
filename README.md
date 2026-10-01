# discord-post-tool

Discordサーバーに、ローカルフォルダ構成どおりのカテゴリ/チャンネルを作り、`.zip` と `.pdf` を一括投稿するツールです。

## 初回セットアップ

clone直後は依存パッケージが入っていないため、最初にセットアップが必要です。

必要なもの:

- Node.js 20以上
- npm
- Git

Windows PowerShellでは次の手順で起動できます。

```powershell
git clone <repository-url>
cd discord-post-tool
npm install
copy .env.example .env
notepad .env
npm run app
```

`.env` にはDiscord Botの情報を入れます。

```env
DISCORD_BOT_TOKEN=Botのトークン
DISCORD_GUILD_ID=投稿先サーバーID
```

Windowsではプロジェクト直下の `start-gui.bat` からも起動できます。`node_modules` が無い場合は、初回だけ自動で `npm install` を実行します。ただし、Node.js/npm自体は事前にインストールされている必要があります。

起動しない場合は、まず次を確認してください。

- `npm` が見つからない: Node.js 20以上をインストールしてください。
- `electron` が見つからない: `npm install` を実行してください。
- サーバー名取得や投稿ができない: `.env` の `DISCORD_BOT_TOKEN` と `DISCORD_GUILD_ID` を確認してください。

## デスクトップアプリ

GUI版はElectronアプリとして起動できます。内部では既存CLIを呼び出すため、CLIで固めた投稿・変換仕様をそのまま使います。

```bash
npm run app
```

Windowsではプロジェクト直下の `start-gui.bat` からも起動できます。

画面には次の2つの機能があります。

- 画像変換: `raw_images` から10MiB未満のzip/pdfを生成
- Discord投稿: `optimized_webp_pdf` のカテゴリ/ファイル構成をDiscordへ投稿

`.env` の `DISCORD_BOT_TOKEN` と `DISCORD_GUILD_ID` はGUIからも利用されます。GUIのBot Token欄は一時指定用で、入力内容は保存しません。Guild ID欄の「確認」ボタンで、Botが参加しているサーバー名を取得できます。

## 複数プロジェクトで使う場合

別サーバーごとにプロジェクトフォルダを分けて使えます。

```txt
discord-post-tool-server-a/
discord-post-tool-server-b/
```

GUIの入力内容とElectronのキャッシュは、プロジェクトの絶対パスごとに別々に保存されます。そのため、フォルダが違えば前回入力したGuild ID、入力/出力フォルダ、各種オプションは混ざりません。

Windowsの保存先は `%APPDATA%\discord-post-tool\projects\<プロジェクトパスのハッシュ>` です。初回の更新後起動では、旧保存領域から入力設定だけをコピーして引き継ぎます。旧データは削除しません。**初回移行前には旧版のアプリをすべて終了してください。** プロジェクトフォルダを移動・改名すると別の保存領域になります。

各プロジェクトフォルダで必要な作業:

```powershell
cd path\to\discord-post-tool-server-b
npm install
copy .env.example .env
notepad .env
npm run app
```

既にclone済みの別フォルダへ最新の仕様を反映する場合は、そのフォルダで次を実行してください。

```powershell
git pull
npm install
```

### 同時実行のルール

更新前に両プロジェクトのGUIと実行中のCLIを終了し、両方を最新の同時実行対応版へ更新して、それぞれで `npm install` を実行してください。2026-10-01の修正版と、それ以前の同時実行対応版では内部ロックの方式が違います。異なる版を混在させて同時実行しないでください。

- 別プロジェクトのGUIは同時に起動できます。同じプロジェクトのGUIをもう一度起動した場合は、既存ウィンドウを表示します。
- 画像変換は、出力フォルダが別であれば同時実行できます。同じフォルダや親子関係のフォルダへの同時書き込みは停止します。
- 入力・出力フォルダ自体がJunctionの場合は実体パスで照合します。フォルダ配下のJunctionやシンボリックリンクは安全に保護できないため、変換・投稿を明示エラーで停止します。
- 変換中の出力フォルダから投稿することはできません。投稿中の入力フォルダを変換で上書きすることもできません。別のフォルダであれば、変換と投稿を同時に行えます。
- 別のGuild IDへの投稿は同時実行できます。同じGuild IDへの二重投稿は、Botが違っても停止します。投稿履歴のmanifestファイルも二重書き込みを禁止します。
- 同じBotを使う場合、APIリクエストをプロセス間で順番に送り、Discordのレート制限による待機時間を共有します。サーバー名の確認も対象です。

競合した処理は「同じ対象を別の処理が使用中」と表示して停止します。先の処理が終わってから再実行してください。PIDと作成時刻で所有者を照合し、終了済みプロセスの処理ロック・内部ロックは次回実行時に回収します。生存プロセスを時間だけで解除しません。作成時刻を確認できない場合や管理情報が壊れている場合は、安全のため停止します。ロックの保存先は `%LOCALAPPDATA%\discord-post-tool\runtime-v1` です。手動削除せず、処理を終了してから再実行してください。

保護の対象は、同じPC・同じWindowsユーザーで動かす対応版のGUI/CLIです。他PC・別ユーザー・別ツールによる操作は調整しません。Discord側の制限では待機やエラーが発生することがあります。

Windowsで内部ロックファイルの更新が一時的に拒否された場合は、ロックを保持したまま100ms間隔で最大20回再試行します。拒否が続く場合は安全のため停止します。これはファイル更新だけの再試行で、結果が不明なDiscord投稿を再送しません。投稿が途中で止まった場合は、manifestを保持して同じ入力・Guild IDで再実行してください。

同時変換はCPU・メモリ・ディスクを共有します。負荷が高い場合は、まず各アプリの「並列数」を2程度に下げてください。投稿先のGuild IDと入力/出力フォルダは各プロジェクトで確認してください。

## 入力フォルダ

カテゴリ名のフォルダを作り、その直下に同じベース名の `.zip` / `.pdf` を置きます。

```txt
example/
  カテゴリ1/
    作品名.zip
    作品名.pdf
  カテゴリ2/
    作品名.zip
    作品名.pdf
```

この場合、Discord上では次のようになります。

```txt
カテゴリ1
  # 作品名
カテゴリ2
  # 作品名
```

チャンネル名はDiscord用に自動整形します。空白、`：`、`:` などは `-` に変換します。

## Discord Bot設定

`.env.example` を参考に `.env` を作ります。

```env
DISCORD_BOT_TOKEN=Botのトークン
DISCORD_GUILD_ID=投稿先サーバーID
```

Botには最低限、対象サーバーで次の権限が必要です。

- チャンネルの管理
- チャンネルを見る
- メッセージを送信
- ファイルを添付
- メッセージ履歴を読む

## 事前確認

```bash
npm run plan -- --input ./example
```

1カテゴリだけ確認する場合:

```bash
npm run plan -- --input ./example --category カテゴリ1
```

最初の1チャンネルだけ確認する場合:

```bash
npm run plan -- --input ./example --limit 1
```

## 実行

最初は `--limit 1` で動作確認するのがおすすめです。

```bash
npm run run -- --input ./example --limit 1 --yes
```

問題なければ全体を実行します。

```bash
npm run run -- --input ./example --yes
```

`--yes` は誤実行防止用です。`run` はDiscord上にカテゴリ/チャンネルを作成し、ファイル投稿も行うため、実行コマンドには明示的な確認として `--yes` が必要です。

manifestに記録済みのカテゴリ/チャンネルがDiscord側で削除されていた場合は、入力フォルダに存在するものとして作り直します。作り直しを止めてエラーにしたい場合だけ `--no-recreate-missing` を付けます。

## ファイルサイズ上限

Bot投稿では、あなたのユーザーアカウントのNitro上限はBotに引き継がれません。Botは別ユーザーとしてDiscord APIに投稿します。

デフォルトでは安全側に倒して、1ファイル `10MiB`、同一メッセージの添付合計 `25MiB` として事前チェックします。

サーバーブースト等でBot投稿の上限が上がっている場合だけ、明示的に上限を上げてください。

```bash
npm run run -- --input ./example --max-file-mib 50 --max-request-mib 50 --yes
```

## 投稿モード

デフォルトは `auto` です。zip/pdfを同じメッセージで投稿しようとし、サイズ等でDiscordに拒否された場合は別々のメッセージで再試行します。

```bash
npm run run -- --input ./example --upload-mode auto --yes
npm run run -- --input ./example --upload-mode bundle --yes
npm run run -- --input ./example --upload-mode separate --yes
```

## 再実行

実行結果は `.discord-post-tool-manifest.json` に保存します。途中で止まった場合も同じコマンドを再実行すれば、作成済みチャンネルと投稿済みファイルをできるだけスキップします。

manifest保存時の一時ファイルは、manifestの隣にある `.discord-post-tool-manifest-staging` 内へ分離します。このフォルダはツール専用で、`--manifest` の保存先には指定できません。

既存チャンネルに同名の添付ファイルがあるかも直近100件から確認します。不要な場合は `--no-remote-check` を付けます。

## 注意

Discordのカテゴリには最大50チャンネルまでしか入れられません。50を超える場合はカテゴリを分けてください。

ファイルサイズ上限はサーバー状態やDiscord側の制限で変わります。必要なら `--max-file-mib` と `--max-request-mib` を調整してください。

## 画像から10MiB未満のzip/pdfを作る

`raw_images` に次のようなフォルダがある場合、投稿用のzip/pdfを自動生成できます。

```txt
raw_images/
  作品名_png/
    001.png
    002.png
  作品名_jpg/
    001.jpg
    002.jpg
```

`*_png` と `*_jpg` が両方ある場合は、品質劣化を避けるためPNG原本を優先します。

まず確認します。

```bash
npm run build-assets -- plan --input ./raw_images
```

生成します。

```bash
npm run build-assets -- run --input ./raw_images --output ./optimized_webp_pdf
```

出力は投稿CLIが読める形になります。

```txt
optimized_webp_pdf/
  カテゴリ1/
    作品名.zip
    作品名.pdf
    作品名.assets.json
```

生成後はそのまま投稿確認できます。

```bash
npm run plan -- --input ./optimized_webp_pdf
```

標準プロファイルは、1組あたり最大100枚として次の2形式を独立して生成します。100枚のまま両方が目標サイズに収まれば、1作品につき1 zip＋1 pdfになります。

- zip: 元解像度のWebP。品質75を基準に、余裕があれば85まで引き上げ、超過時は65まで自動調整
- pdf: 長辺1350px・JPEG品質70を基準に、余裕があれば長辺1600px・品質75までバランスよく引き上げ、超過時は長辺900pxまで段階的に縮小

`作品名.assets.json` は、実際に採用した品質・解像度・完成サイズを記録するプロファイルです。投稿CLIはこのファイルを添付しません。

変換中は作品全体と各zip/pdf組に完了確認用の `.pending` ファイルを残し、全出力の検証が完了してから取り除きます。中断後は同じ変換を再実行してください。投稿は未完了の作品や、`assets.json` とサイズ・SHA-256が一致しない生成物を停止します。`.pending` や `assets.json` を手動削除して投稿を通さないでください。プロファイルのない従来の手動zip/pdf入力は引き続き利用できます。

ZIPまたはPDFが最低設定でも目標サイズを超える場合、その作品の組だけを半分に自動分割して再試行します。例えば100枚なら通常は `作品名.zip/pdf` の2ファイル、重い作品だけ `作品名_1-50.zip/pdf` と `作品名_51-100.zip/pdf` の4ファイルになります。半分でも収まらない極端に重い作品は、収まるまで同じ方法で再分割します。

GUIと変換CLIの既定出力先は `optimized_webp_pdf` です。GUIの旧保存設定が `optimized_split` の場合は、新しいプロファイルへの更新時に出力先・投稿入力先を自動移行します。分割構成と一致しない旧出力が混在すると重複投稿につながるため、自動削除せず安全停止します。

```bash
npm run build-assets -- run --input ./raw_images --output ./optimized_webp_pdf --chunk-size 100 --force
```

基準値を明示する場合は次のようにします。

```bash
npm run build-assets -- run --input ./raw_images --output ./optimized_webp_pdf \
  --chunk-size 100 \
  --zip-webp-quality 75 \
  --zip-webp-max-quality 85 \
  --zip-webp-min-quality 65 \
  --pdf-jpeg-quality 70 \
  --pdf-jpeg-max-quality 75 \
  --pdf-long-edge 1350 \
  --pdf-max-long-edge 1600 \
  --pdf-min-long-edge 900 \
  --force
```

GUIにも同じ既定値が入っています。zipとpdfは完成後の実サイズを別々に検査し、どちらかが目標を超える場合はその組だけを自動分割します。画像破損や読み取り失敗など、サイズ以外のエラーは分割で隠さず停止します。

WebPの最低品質は探索範囲の下限です。通常の画像を常に品質65へ下げる設定ではなく、目標サイズに収まる範囲で最も高い品質を自動採用します。旧GUI設定の最低品質70は、新しい既定値65へ一度だけ移行します。

最低品質70で正常生成済みの出力は、採用品質が新しい下限を満たしていれば再利用できます。エラーや中断後に全体を再実行する場合、「既存出力を上書きする」を外すと、完了済みの通常出力と自動分割出力を検証してスキップし、不足・異常な組だけを再生成します。

「PDF用JPGも保存する」は、PDFへ埋め込んだ変換後JPEGを確認用として `<作品名>_jpg` フォルダにも保存するオプションです。zip内のWebPと投稿用zip/pdfだけが必要なら、通常はオフで問題ありません。

軽い作品の出力は次のようになります。

```txt
optimized_webp_pdf/
  カテゴリ1/
    作品名.zip
    作品名.pdf
    作品名.assets.json
```

そのまま投稿確認できます。

```bash
npm run plan -- --input ./optimized_webp_pdf
```

重い作品が自動分割された場合は次のようになります。

```txt
optimized_webp_pdf/
  カテゴリ1/
    作品名_1-50.zip
    作品名_1-50.pdf
    作品名_1-50.assets.json
    作品名_51-100.zip
    作品名_51-100.pdf
    作品名_51-100.assets.json
```

末尾の `_数字-数字` は分割範囲として扱われるため、投稿ツールは上記4ファイルを同じ作品の1チャンネルへまとめます。`auto`投稿モードでは合計が最大リクエストサイズを超える場合、各ファイルを個別メッセージとして投稿します。

100枚以下でも、サイズ超過時は自動分割されます。100枚を超えるセットは、まず`--chunk-size`に従って分け、重い組だけをさらに半分へ分割します。最後の余りが10%以下の場合は直前の組へまとめます。

### `Input file contains unsupported image format` で停止する場合

入力画像の中に、破損したファイル、0バイトのファイル、または拡張子と実際の形式が一致しないファイルがあります。変換実行時に全入力画像を事前検査し、ログへ該当ファイルのパスを表示します。該当画像を元データから再コピーまたは再出力してから、もう一度変換してください。
