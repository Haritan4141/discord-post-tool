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

GUIの入力内容は、プロジェクトの絶対パスごとに別々に保存されます。そのため、フォルダが違えば前回入力したGuild ID、入力/出力フォルダ、各種オプションは混ざりません。

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

標準プロファイルは、100枚を分割せず次の2形式を独立して生成します。

- zip: 元解像度のWebP。品質75を基準に、余裕があれば85まで引き上げ、超過時は70まで自動調整
- pdf: 長辺1350px・JPEG品質70を基準に、余裕があれば長辺1600px・品質75までバランスよく引き上げ、超過時は長辺900pxまで段階的に縮小

`作品名.assets.json` は、実際に採用した品質・解像度・完成サイズを記録するプロファイルです。投稿CLIはこのファイルを添付しません。

GUIと変換CLIの既定出力先は `optimized_webp_pdf` です。GUIの旧保存設定が `optimized_split` の場合は、新しいプロファイルへの更新時に出力先・投稿入力先を自動移行します。旧50枚分割ファイルと混在すると重複投稿につながるため、古い範囲付き出力を検出した場合は削除せず安全停止します。

```bash
npm run build-assets -- run --input ./raw_images --output ./optimized_webp_pdf --chunk-size 100 --force
```

基準値を明示する場合は次のようにします。

```bash
npm run build-assets -- run --input ./raw_images --output ./optimized_webp_pdf \
  --chunk-size 100 \
  --zip-webp-quality 75 \
  --zip-webp-max-quality 85 \
  --zip-webp-min-quality 70 \
  --pdf-jpeg-quality 70 \
  --pdf-jpeg-max-quality 75 \
  --pdf-long-edge 1350 \
  --pdf-max-long-edge 1600 \
  --pdf-min-long-edge 900 \
  --force
```

GUIにも同じ既定値が入っています。zipとpdfは完成後の実サイズを別々に検査し、どちらかが目標を超える場合は出力を確定せず停止します。

「PDF用JPGも保存する」は、PDFへ埋め込んだ変換後JPEGを確認用として `<作品名>_jpg` フォルダにも保存するオプションです。zip内のWebPと投稿用zip/pdfだけが必要なら、通常はオフで問題ありません。

出力は次のようになります。

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

100枚以下なら範囲付きの名前にならず、1 zip＋1 pdfとして投稿されます。100枚を超えるセットだけ、`--chunk-size`に従って範囲付きファイルへ分けられます。最後の余りが10%以下の場合は直前の組へまとめます。

### `Input file contains unsupported image format` で停止する場合

入力画像の中に、破損したファイル、0バイトのファイル、または拡張子と実際の形式が一致しないファイルがあります。変換実行時に全入力画像を事前検査し、ログへ該当ファイルのパスを表示します。該当画像を元データから再コピーまたは再出力してから、もう一度変換してください。
