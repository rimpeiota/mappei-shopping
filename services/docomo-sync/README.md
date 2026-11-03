# ドコモメール取得 Worker（未接続の試作）

このフォルダは本番の買い物アプリとは独立したCloudflare Workerです。**メールアカウントの接続・実メール取得は未確認です。** 初期設定のCronは空で、D1の実IDと認証情報は配備先で設定します。実メールの形式と真正性を検証していないため、出力はすべて`explicitConfirmed: false`です。配達らしい文面があっても購入完了・在庫加算・商品の自動照合はしません。

## 最小構成と境界

```text
ドコモ IMAP → 独立WorkerのCron → 独立D1（要確認イベントだけ）
                                      ↓ HTTPS・イベント読取専用キー
                               Sitesの認証済みサーバー
                                      ↓
                            本人の買い物データへ安全に反映
```

最後のSites連携はこのWorkerには含みません。想定は、アプリを開いたときにSitesサーバーがイベントを取り込む方式です。アプリを閉じている間にSitesの買い物データまで更新する実装ではありません。

Sitesサーバー側で、認証済みの`requireOwner()`と固定のintegration IDを対応付けます。ブラウザから渡されたowner・メールアドレスで取得先を選んではいけません。読取キーをブラウザへ返さず、他のSites利用者に本人のイベントを渡さないことが接続条件です。このWorkerにSitesのログイン情報やサービス用bypass tokenは渡しません。

## 実装した範囲

- 接続先は`imap.spmode.ne.jp:993`に固定し、最初からTLSを使用します。
- IMAPは`LOGIN`、`EXAMINE`、`UID SEARCH`、`UID FETCH ... BODY.PEEK`だけ。送信・既読化・削除・移動を行う機能はありません。
- 直近30日、1回100 UIDまで、ヘッダー32KiB・本文256KiBまで。100件を超えた場合は、次回に続きを読みます。初回は古い順です。
- 件名と差出人ドメインで通販関連の候補を選び、候補だけ本文を読みます。大きすぎるメールはヘッダーから要確認イベントにします。
- raw本文・件名・ヘッダー・宛先・住所・認証情報は保存・ログ出力しません。MIME解析はメモリ内だけです。
- 永続データは固定形式のイベント、取得UID、UIDVALIDITY、時刻、固定エラーコードだけです。原メールが必要な場合はドコモ側で確認します。
- Message-IDのダイジェストで再取得を抑止します。Message-IDがない場合はintegration・UIDVALIDITY・UIDのダイジェストです。この代替方式では、UIDVALIDITY変更後の要確認イベントが重複する場合があります。
- IMAP認証失敗は1回で停止し、以後のCronは接続しません。認証情報を直してから管理者が停止状態を解除します。
- `GET /v1/events?cursor=0&limit=50`がイベント読取API。Bearerキー必須、最大100件、任意ownerや取得先URLは指定できません。取得は非破壊で、カーソルとイベントIDを利用側が保持します。
- 初回検証用の`POST /v1/collect`は、読取キーとは別の`COLLECT_TOKEN`が必要です。入力本文・クエリ・任意コマンドは受け付けません。Cronを有効にする前の1回の取得確認に使用します。未設定ではメールへ接続しません。
- 管理者用の`POST /v1/probe`は同じ取得用キーだけで使える、実例の限定診断です。短い商品キーワード・直近30日以内の開始日・逆順UID境界だけを受け付け、固定INBOXを新しい順に最大100 UID/本文20件まで確認します。バックフィルのカーソルや保存イベントは変えません。キーワードに一致した通知の分類ヒント・注文番号のダイジェスト・公開商品キーだけを返し、本文/件名/宛先/住所/注文番号原値を返しません。認証結果の文言も診断ヒントであり、全結果は未確認です。
- 商品名のない配達通知は、先に得た追跡番号ダイジェストを最大5個指定し、一致する場合だけ診断結果に含められます。追跡番号は明示ラベルのある10〜14桁だけをメモリ内で正規化してダイジェスト化し、原値を返しません。追跡一致だけで商品行や数量の確定・自動完了はしません。
- 本文のないPOSTが空のストリームとして届く場合も受け付けます。本文がある要求・終端しないストリームは、上限1秒でメール接続前に拒否します。認証停止の確認と接続用ロックの取得は同じ更新条件にし、並行実行でも認証失敗後の再接続を防ぎます。

イベント型はアプリの`lib/commerce-model.ts`の`NormalizedCommerceEvent`と同じ構造です。商品・注文行・配送・数量の対応を安全に確定できないため、関連する項目は`null`です。取得した`kind: delivered`も文面上の候補に過ぎず、`explicitConfirmed: false`を外してはいけません。

## オフライン検証

Node 22.13以降でこのフォルダを作業場所にします。

```sh
npm ci --ignore-scripts
npm test
npm run check
npm run dry-run
```

テストは人工メールと偽ソケットのみです。`dry-run`はバンドル作成だけで、公開・認証・メール接続はしません。

依存はMIME解析の[`postal-mime`](https://github.com/postalsys/postal-mime)、ビルド用Wrangler・TypeScript・Cloudflare型定義です。

## 接続手順

1. 本人のCloudflareアカウントで独立WorkerとD1を用意します。`wrangler d1 create docomo-sync-events`で返された実IDを`wrangler.jsonc`の`d1_databases`へ、binding名`DB`として設定し、`schema.sql`を適用します。実IDを推測で埋めないでください。
2. `INTEGRATION_ID`に、メールアドレスを含まないランダムな識別子を設定します。Sites側にも同じ識別子を保持します。
3. WorkerのSecretsへ`DOCOMO_ACCOUNT_ID`、`DOCOMO_IMAP_PASSWORD`、32文字以上の十分ランダムな`EVENT_READ_TOKEN`と、それとは異なる初回確認用の`COLLECT_TOKEN`を登録します。値はCloudflareの設定画面などに直接入力し、チャット・ソース・ログへ貼り付けないでください。
4. ドコモの「dアカウントでドコモメールを利用する」が有効であることを確認します。必要なのはdアカウントの通常パスワードではなく、IMAP専用パスワードです。既存のIMAP専用パスワードを再発行する場合、利用中の他メールアプリにも変更の影響があります。
5. 本人の明示的な接続操作後に1回だけ読み取りを検証します。メールの既読・件数が変わらず、イベントに本文や住所が残らず、他の利用者に見えないことを確認します。実メールをGitへ保存して検証しないでください。
6. 検証後にのみCronを設定します。例として15分ごとなら`triggers.crons`を`["*/15 * * * *"]`にします。現ファイルの空配列では定期実行されません。

`auth_blocked=1`の場合は、原因を直してから管理者が`collector_state`の`auth_blocked`を0へ戻します。自動でパスワードを試し続ける処理はありません。メールボックスは初版で`INBOX`だけです。別フォルダを対象に変える場合は、既存カーソルを流用せず接続設定と取得範囲を再確認してください。

## Sites側へつなぐときの条件

- 接続先WorkerのURLはサーバー設定から固定し、読取キーはSitesのSecretへ登録する。
- `GET /v1/events`の`integrationId/accountScope`が本人に紐付いた設定と一致することを検査する。
- sequenceは受信カーソル、event.idは重複防止として使う。未照合イベントを保管し、まだ商品と結び付かないという理由だけで捨てない。
- 更新対象は最新のD1 snapshotを読み、現在revisionへのCASで更新する。読み取り失敗を空データに置き換えず、既存商品・買う予定・在庫・調理履歴を保持する。
- 適用済みイベントの記録と買い物データの変更は一つの原子的な更新として扱う。競合時は最新データで再計算する。イベントの再取得・再実行で購入数量や在庫を加算しない。
- この試作の`explicitConfirmed: false`イベントは要確認へ保存するだけ。配達の根拠・正しい注文行・当該配送数量を検証できる後続実装ができるまで、自動完了を有効にしない。

## 一次資料

- [ドコモ：その他のメールアプリからの利用](https://www.docomo.ne.jp/service/docomo_mail/other/)
- [ドコモ：IMAP専用パスワード](https://www.docomo.ne.jp/faq/detail?categoryId=136&faqId=248285)
- [ドコモ：IMAP仕様 2026-01-26](https://www.docomo.ne.jp/binary/pdf/service/developer/smart_phone/application/imap/mail_imap_spec_260126.pdf)（検索はSINCEとUIDを使用。FROM/SUBJECT/TEXT/BODYによる検索は非対応のため、商品キーワードは取得した候補のメモリ内だけで確認）
- [Cloudflare：TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
- [Cloudflare：Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare：Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
