# 買い物

モバイルファーストの買い物管理Webアプリ。黒基調のLiquid Glass UI、即時入力、商品カードのフリック、在庫・履歴・お気に入りを備えます。

- ソースコード：[GitHub](https://github.com/rimpeiota/mappei-shopping)
- Sites公開先予定：[買い物](https://mappei-shopping.feyfairy2048.chatgpt.site) — **本資料の作成時点では未公開。予定URLと公開・動作確認の完了は別です。**
- 選定理由と利用範囲：[技術構成](docs/技術構成.md)

## 保存と接続の範囲

入力は先に端末へ保存し、認証後にCloudflare D1へ同期します。端末キャッシュもowner別に分け、匿名下書きの同期は採用の選択を求めます。D1はユーザー別に保存し、revisionの一致を条件に書き込むことで、古い端末からの上書きを防ぎます。競合時は端末側とクラウド側の選択を求めます。

既存の買い物ノートを自動取得・外部送信する処理はありません。必要な内容だけを画面で選んでインポートし、MarkdownまたはJSONへエクスポートする方式です。JSONの復元とMarkdownの追加取り込みを分けています。ローカルノートとクラウドの自動双方向同期はありません。

AI整理用のSites秘密設定は登録済みです。Cloudflare Workers AIの実REST APIでHTTP 200・成功応答を確認し、「牛乳2本、卵1パック」の商品・数量解析が成功しています。本番アプリ経由の呼び出しは公開後に確認します。AI接続に失敗した場合は通常の文字解析へフォールバックし、先に記録したメモは残ります。

家族とのリアルタイム共有、通知配信、画像・レシートOCR、価格の自動監視は未接続です。関連する記入欄や添付機能があることを、連携の完成とは扱いません。

## ローカル起動

Node.js 22.13.0以上、npm、Gitを使います。リポジトリのルートで実行します。

```sh
npm ci
npm run build
```

`build`で`dist/server/wrangler.json`を生成します。初回のローカルD1には、同梱のマイグレーションを一度だけ適用します。

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_massive_mercury.sql
npm run dev
```

開発サーバーの既定ポートは5173です。起動ログのURLを使ってください。適用済みSQLは繰り返し実行しません。スキーマ変更時は`npm run db:generate`で次のSQLを生成し、順に適用します。保存先は`.wrangler/state`です。

localhostの開発プレビューでは、`/signin-with-chatgpt?return_to=/`で模擬ログインができます。模擬認証はループバック限定で、本番ビルドには入りません。

ビルドしたWorkerをローカルで動かす場合は、別の起動方法を使います。

```sh
npm start -- --port 8787
```

このWorkerプレビューはD1・R2のローカル状態を利用します。開発用の模擬ログインは提供しません。本番の認証はSitesのdispatchが担当するため、localhostの模擬認証とは分けて確認します。

## 検証コマンド

```sh
npx tsc --noEmit
node --experimental-strip-types --test scripts/parser.test.ts
npm run build
```

ビルド後、ポート8787でWorkerプレビューを起動した状態で、API検証を実行できます。

```sh
node scripts/api-check.mjs
```

API検証はループバック以外の宛先を拒否します。テスト専用ユーザーのD1スナップショットとR2添付をローカルに作り、認証拒否、ユーザー分離、更新競合、数量解析、添付の許可・拒否を確認します。本番URLへ認証ヘッダーを送るためのスクリプトではありません。結果は`outputs/api-check.json`へ保存します。

コマンドの合格と実ブラウザ操作の確認は別です。入力、再読み込み、フリック、訂正、オフライン、アカウント切替、モバイル幅・デスクトップ幅を実際に操作し、環境と結果を検証記録へ残します。本資料だけで全テスト合格を宣言しません。

## クラウドの設定

Sitesのアクセス設定はprivateを既定とし、認証ユーザーのIDをD1の保存単位に使います。`.openai/hosting.json`がD1の`DB`とR2の`BUCKET`を宣言し、公開時にSitesが実際のbindingを設定します。ローカルD1のマイグレーションは本番へ影響しません。

AI接続はSitesの秘密設定を使うREST API方式で設定済みです。再設定する場合は次のいずれかを使います。

- Workerへ`AI` bindingを設定する。
- Worker側のSecretに`CLOUDFLARE_ACCOUNT_ID`と`CLOUDFLARE_AI_TOKEN`を設定する。

モデルは`@cf/meta/llama-3.1-8b-instruct`です。トークンはWorkerのサーバー側だけで利用します。[Cloudflare公式のWorkers AI REST API手順](https://developers.cloudflare.com/workers-ai/get-started/rest-api/)

`.env*`、`.dev.vars*`、依存パッケージ、端末データ、生成ビルド、検証出力はGit管理から除外しています。個人の買い物記録や認証情報はリポジトリへ含めません。`npm run build`と`npm start`はサイトの公開を実行しません。

## 主なソース

| 場所 | 役割 |
|---|---|
| `app/page.tsx` | 入力、リスト、在庫、履歴、設定、フリック。 |
| `app/components/` | 商品編集シートとモーダル。 |
| `lib/client-model.ts`・`lib/client-store.ts` | 商品モデル、端末保存、同期。 |
| `app/api/` | 状態保存、文章解析、添付、診断。 |
| `lib/server-*.ts` | 認証・入力制限、文字解析、AI、添付検証。 |
| `db/`・`drizzle/` | D1スキーマとSQL。 |
| `public/sw.js`・`public/manifest.webmanifest` | オフラインシェルとPWA。 |
| `worker/index.ts`・`vite.config.ts` | Workerとビルド・プレビュー設定。 |

SitesのVinextスターターを土台にしています。同梱の未使用コンポーネントやライブラリを本アプリの機能として数えません。直接依存は`package.json`、全推移依存と解決バージョンは`package-lock.json`を参照してください。第三者ライセンスは`vendor/`と`scripts/vite/`に保持しています。
