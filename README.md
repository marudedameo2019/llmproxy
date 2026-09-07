# llmproxy

LLM API リクエストを記録しながらバックエンドに転送する、最小構成の HTTP リバースプロキシです。
自分の環境のみに対応した、自分ですぐ読める量のソースコードで、極力依存関係を排除したものです。

OpenAI互換APIのみに対応し、一部機能しか対応していません。

## 仕組み

```
[Client (opencode)]
       |
       |  HTTP リクエスト
       v
[llmproxy :8081]  --(/v1/chat/completions のリクエスト・レスポンスを request-N.json / response-N.json へ保存)
       |
       |  fetch() + 長時間タイムアウトの undici Agent
       v
[llama-server :8080]  (OpenAI 互換 API)
```

1. クライアントがポート **8081** でプロキシにリクエストを送る
2. プロキシがリクエストボディ全体を読み込む
3. URL が `/v1/chat/completions` の場合、ボディを `request-{N}.json`（N は自動採番）として保存する
4. リクエスト（メソッド・ヘッダー・ボディ）を `undici` の `fetch` でターゲットへ転送する
5. URL が `/v1/chat/completions` の場合、レスポンスボディも記録し `response-{N}.json` として保存する（SSE ストリームは単一の JSON に組み立て直す）
6. レスポンスを `WritableStream` 経由でストリームとしてクライアントへ返す

## 特徴

- **リクエスト記録** — `/v1/chat/completions` の全リクエストボディを採番した JSON ファイル（`request-{N}.json`）として保存
- **レスポンス記録** — 対応するレスポンスボディも `response-{N}.json` として保存（SSE ストリームは単一の JSON に組み立て直す）
- **透過的なプロキシ** — 他エンドポイントやヘッダーはそのまま転送
- **ストリーミング応答** — バックエンドのレスポンスをストリームでパストスルー
- **長時間タイムアウト** — undici Agent で headers timeout 2 時間・body timeout なし（長時間推論に対応）

## 技術スタック

| 項目 | 内容 |
|------|------|
| 言語 | JavaScript (ES Modules / `.mjs`) |
| ランタイム | Node.js |
| HTTP サーバー | Node.js 組み込み `http` モジュール |
| HTTP クライアント | `undici` |
| 依存関係 | `undici` のみ（フレームワーク不使用） |

## ディレクトリ構成

```
llmproxy/
├── index.js              # プロキシ本体
├── package.json           # プロジェクト定義
├── request-*.json         # 保存されたリクエスト（.gitignore 対象）
└── response-*.json        # 保存されたレスポンス（.gitignore 対象）
```

## セットアップ

```bash
npm install
```

## 起動

```bash
node index.js
```

npm スクリプトからも起動できます。

| コマンド | 内容 |
|------|------|
| `npm start` | `node index.js` と同様 |
| `npm run start:local` | `node index.js -t http://localhost:8080`（ローカルの llama-server 向け） |
| `npm run start:help` | 使い方表示（`node index.js --help`） |

オプションを渡す場合は `--` の後ろに続けます。

```bash
npm start -- -t http://192.168.1.10:8080 -p 9000
```

起動すると以下のようなログが出ます。

```
proxy listening on :8081 (target: http://localhost:8080)
```

リクエストが来ると、記録対象のものはファイルに保存されます。

```
requested: /v1/chat/completions, POST, { ... }
saved: request-1.json
...
saved: response-1.json
```

## 記録ファイル

`/v1/chat/completions` のリクエストごとに採番（N は 1 から自動採番）され、リクエスト・レスポンスが同じ番号でペアになります。

### request-{N}.json

クライアントから送られたリクエストボディをそのまま（1 行 JSON）保存したものです。

### response-{N}.json

バックエンドから返されたレスポンスボディを保存したものです。

- **レスポンスが SSE ストリーミングの場合**（`Content-Type` に `text/event-stream` が含まれる）— ストリームを分割・解析し、`data:` 行を順にマージして、非ストリーミングレスポンスと同形式の単一 JSON に組み立て直して保存します。`choices[].message` にマージされた `content`・`reasoning_content`・`tool_calls` が含まれ、`finish_reason` や `usage` も付与されます。
- **SSE 以外の場合** — レスポンスボディをそのまま保存します。

レスポンスの保存はクライアントへの返送と並行して行われ、完了すると `saved: response-{N}.json` がログ出力されます。

## リクエストの再送（curl）

保存された `request-*.json` をそのままリクエストボディとして使うことで、curl から再送できます。

```bash
curl http://localhost:8081/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d @request-1.json
```

保存されたリクエストは通常 `"stream": true` になっているため、このままだとレスポンスは SSE ストリームになります。非ストリーミング（単一 JSON）で受け取りたい場合は `stream` を除去します。

```bash
curl http://localhost:8081/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d "$(jq 'del(.stream, .stream_options)' request-1.json)"
```

注意点:

- プロキシ（`:8081`）経由で再送すると、新しい `request-{N}.json` / `response-{N}.json` が追加で記録されます。
- バックエンドを直接指定（例: `http://localhost:8080`）すると記録されません。

## 設定

接続先とリスニングポートは、起動時の引数または環境変数で指定できます。
優先度は **引数 > 環境変数 > デフォルト** です。

| オプション | 環境変数 | デフォルト | 説明 |
|------|------|------|------|
| `-t, --target <url>` | `LLMPROXY_TARGET` | `http://localhost:8080` | 接続先（バックエンド）の URL |
| `-p, --port <n>` | `LLMPROXY_PORT` | `8081` | リスニングポート |
| `-h, --help` | - | - | ヘルプ表示 |

### 例

```bash
# 引数で指定
node index.js -t http://192.168.1.10:8080 -p 9000

# 環境変数で指定
LLMPROXY_TARGET=http://192.168.1.10:8080 LLMPROXY_PORT=9000 node index.js

# 引数と環境変数を混在（ポートは環境変数、接続先は引数が優先）
LLMPROXY_PORT=9000 node index.js -t http://192.168.1.10:8080
```
