# 買い物

モバイルファーストの買い物管理Webアプリ。商品名・数量・チェックを読みやすく並べ、追加と購入済みの切り替えを中心にしています。在庫・履歴・お気に入りも同じ記録から扱います。

- ソースコード：[GitHub](https://github.com/rimpeiota/mappei-shopping)
- 公開サイト：[買い物](https://mappei-shopping.feyfairy2048.chatgpt.site) — 公開済み初版で、本人確認後の2商品の追加・同期済み表示・再読み込み後の復元を確認しています。2026-10-26の操作性改善は、変更後のブラウザ確認と分けて記録します。
- 選定理由と利用範囲：[技術構成](docs/技術構成.md)

## 一覧の操作とURL入力

一覧のチェックを1回押すと購入済みになり、購入済み欄のチェックを外すと未購入へ戻せます。フリック・ドラッグを商品行の操作から外し、ガラス表現と行のアニメーションを抑えています。商品情報・価格・在庫は詳細画面、並び順の変更は詳細の上下ボタン、予定総額・予算・会計前確認・最近の操作は「その他」から扱います。会計前確認の入口はかごの商品があるときに表示します。この説明は最新コードの操作仕様で、未確認の端末や新しい変更のブラウザ合格を示すものではありません。

商品URLは文字列を保全して登録し、対応するHTTPSの商品ページからタイトルを取得します。対象はAmazon、楽天市場、Yahoo!ショッピング、無印良品、ユニクロ、ニトリ、ヨドバシ、ビックカメラ、IKEA、ロフト、ZOZOTOWN、Qoo10、コストコ、Apple、Google ストア、メルカリの16サイト群に属する指定ホストです。すべてのページから取得できる保証はなく、認証が必要なページ、取得拒否、未対応サイト、オフライン等では行内で商品名を手入力できます。

URL文字列やドメイン名だけが品名になっている旧記録も、URLを保持していれば取得候補にします。元URLは商品ページへのリンクとして残します。取得するのはページのタイトルで、価格・仕様・在庫の自動収集や定期監視ではありません。新しい取得経路と失敗時の手入力は、ブラウザ確認結果を別に記録します。

## 保存と接続の範囲

入力は先に端末へ保存し、認証後にCloudflare D1へ同期します。端末キャッシュもowner別に分け、匿名下書きの同期は採用の選択を求めます。オフラインでは最後のownerの端末キャッシュを復元し、再接続時はGETで現在の認証ownerを確認してから同期します。D1はユーザー別に保存し、revisionの一致を条件に書き込むことで、古い端末からの上書きを防ぎます。競合時は端末側とクラウド側の選択を求めます。

既存の買い物ノートを自動取得・外部送信する処理はありません。必要な内容だけを画面で選んでインポートし、MarkdownまたはJSONへエクスポートする方式です。JSONの復元とMarkdownの追加取り込みを分けています。ローカルノートとクラウドの自動双方向同期はありません。

AI整理用のSites秘密設定は登録済みです。Cloudflare Workers AIの直接REST APIでHTTP 200・成功応答を確認し、「牛乳2本、卵1パック」の商品・数量解析が成功しています。公開済みアプリの設定画面にも「AI接続を確認」ボタンを追加済みで、実Chromeの操作で「Workers AIの応答を確認しました」の成功表示を確認しています。AI接続に失敗した場合は通常の文字解析へフォールバックし、先に記録したメモは残ります。

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

コマンドの合格と実ブラウザ操作の確認は別です。入力、直接チェックと解除、Undo、URL取得と手入力、再読み込み、縦・斜めスクロール、訂正、オフライン、アカウント切替、モバイル幅・デスクトップ幅を実際に操作し、環境と結果を検証記録へ残します。旧フリックUIでの合格を新UIの合格へ流用せず、本資料だけで全テスト合格を宣言しません。

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
| `app/page.tsx` | 入力、チェックリスト、URL品名補完、在庫、履歴、設定。 |
| `app/components/` | 商品編集シートとモーダル。 |
| `lib/client-model.ts`・`lib/client-store.ts` | 商品モデル、端末保存、同期。 |
| `app/api/` | 状態保存、文章解析、商品ページのタイトル取得、添付、診断。 |
| `lib/server-*.ts` | 認証・入力制限、文字解析、AI、URL/HTMLの制限付き読み取り、添付検証。 |
| `db/`・`drizzle/` | D1スキーマとSQL。 |
| `public/sw.js`・`public/manifest.webmanifest` | オフラインシェルとPWA。 |
| `worker/index.ts`・`vite.config.ts` | Workerとビルド・プレビュー設定。 |

SitesのVinextスターターを土台にしています。同梱の未使用コンポーネントやライブラリを本アプリの機能として数えません。直接依存は`package.json`、全推移依存と解決バージョンは`package-lock.json`を参照してください。第三者ライセンスは`vendor/`と`scripts/vite/`に保持しています。
