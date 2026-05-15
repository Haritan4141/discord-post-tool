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
git clone https://github.com/Haritan4141/discord-post-tool.git
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
- Discord投稿: `optimized_split` のカテゴリ/ファイル構成をDiscordへ投稿

`.env` の `DISCORD_BOT_TOKEN` と `DISCORD_GUILD_ID` はGUIからも利用されます。GUIのBot Token欄は一時指定用で、入力内容は保存しません。Guild ID欄の「確認」ボタンで、Botが参加しているサーバー名を取得できます。

## 複数プロジェクトで使う場合

別サーバーごとにプロジェクトフォルダを分けて使えます。

```txt
C:\Users\Haritan\Documents\discord-post-tool
C:\Users\Haritan\Documents\discord-post-tool-rirr
```

GUIの入力内容は、プロジェクトの絶対パスごとに別々に保存されます。そのため、フォルダが違えば前回入力したGuild ID、入力/出力フォルダ、各種オプションは混ざりません。

各プロジェクトフォルダで必要な作業:

```powershell
cd C:\Users\Haritan\Documents\discord-post-tool-rirr
npm install
copy .env.example .env
notepad .env
npm run app
```

既にclone済みの別フォルダへこの仕様を反映する場合は、そのフォルダで次を実行してください。

```powershell
git pull
npm install
```

## 入力フォルダ

カテゴリ名のフォルダを作り、その直下に同じベース名の `.zip` / `.pdf` を置きます。

```txt
example/
  カテゴリ1/
    akr：ヌルテカ.zip
    akr：ヌルテカ.pdf
  カテゴリ2/
    akr：ノーマル.zip
    akr：ノーマル.pdf
```

この場合、Discord上では次のようになります。

```txt
カテゴリ1
  # akr-ヌルテカ
カテゴリ2
  # akr-ノーマル
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
npm run build-assets -- run --input ./raw_images --output ./optimized
```

出力は投稿CLIが読める形になります。

```txt
optimized/
  カテゴリ1/
    作品名.zip
    作品名.pdf
```

生成後はそのまま投稿確認できます。

```bash
npm run plan -- --input ./optimized
```

標準では各zip/pdfが `9.8MiB` 以下になるように、JPEG品質と長辺サイズを自動調整します。JPEG品質は最大95まで試します。

```bash
npm run build-assets -- run --input ./raw_images --min-long-edge 1100 --force
```

解像度を落とさず、50枚ずつに分けてJPEG品質だけで圧縮する場合は次のようにします。

```bash
npm run build-assets -- run --input ./raw_images --output ./optimized_split --chunk-size 50 --preserve-resolution --force
```

変換を速くしたい場合は、品質を固定できます。サイズ上限に収まる品質がわかっている時向けです。

```bash
npm run build-assets -- run --input ./raw_images --output ./optimized_split --chunk-size 50 --preserve-resolution --quality 89 --force
```

`--quality` を指定しない場合は、各分割ごとに10MiB未満へ収まる最大品質を探索します。探索は同じ画像を複数回変換するため遅くなります。

GUIでは「品質固定で高速化する」にチェックを入れた時だけ「固定品質」欄が有効になります。未チェック時は「最低品質」から「最高品質」の範囲で自動探索します。

「zip/pdf用JPGも保存する」は、zip/pdfの中に入れるために生成した変換後JPEGを、確認用として `<作品名>_jpg` フォルダにも保存するオプションです。投稿に必要なのはzip/pdfだけなので、通常はオフで問題ありません。

出力は次のようになります。

```txt
optimized_split/
  カテゴリ1/
    作品名_1-50.zip
    作品名_1-50.pdf
    作品名_51-100.zip
    作品名_51-100.pdf
```

そのまま投稿確認できます。

```bash
npm run plan -- --input ./optimized_split
```

`_1-50` や `_51-100` のような範囲付きファイルは、投稿CLI側で同じ作品名のチャンネルにまとめます。上の例では `作品名` という1チャンネルに4ファイルを投稿します。

画像枚数が99枚や101枚のように少しずれても対応します。`--chunk-size 50` の場合、99枚は `1-50` / `51-99`、101枚は `1-50` / `51-101` になります。最後の余りが小さい場合は直前の分割にまとめます。
