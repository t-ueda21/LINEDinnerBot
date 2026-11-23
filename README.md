# LINE 晩ごはん Bot

家族で夕食を記録し、直近の履歴から今日・明日の候補を返す LINE Bot。承認済みの1グループで利用できる。写真から読み取った候補は、投稿者が確定してから保存する。

## 家族が使うコマンド

| 投稿 | 結果 |
| --- | --- |
| `晩ごはん カレー、サラダ` | その日の晩ごはんを記録 |
| `晩ごはん 2026-11-21 焼き魚` | 指定日を記録 |
| `晩ごはん修正 2026-11-21 親子丼` / `晩ごはん削除 2026-11-21` | 指定日の記録を更新／削除 |
| `献立履歴` / `献立傾向` | 直近7日／30日の状況を確認 |
| `今日の献立` | 今日の候補を取得 |
| `明日の献立` | 翌日の候補を取得 |
| `写真で晩ごはん` | 本人が宣言から5分以内に投稿する JPEG または PNG を1枚取得。上限5 MB |
| `晩ごはん確定` / `晩ごはん確定 料理名` / `晩ごはん取消` | 返信後10分以内に本人が写真候補を確定・修正付き確定・取消 |

写真機能の指定がない投稿は取得しない。候補を判別できない場合や写真機能を停止している場合は、料理名をテキストで送れば記録できる。

提案の対象日は投稿時の日本時間で決まる。返信は候補を1件ずつ並べ、補足は最後の1行にまとめる。同じ対象日のAI提案が有効なら再利用する。

## ローカルで確認

Node.js 24 以降を使用する。PowerShell の実行ポリシーで `npm` が使えない場合は `npm.cmd` に読み替える。

```powershell
npm ci
npm run typecheck
npm test
npm run smoke
npx wrangler d1 migrations apply line-dinner-bot --local
npm run dev
```

`npm test` は SQLite と模擬 API を使う。`npm run smoke` はバンドル済み Worker とローカル D1 を起動し、LINE への送信をテスト内で受け止める。実際のアカウントや鍵は不要。

## 実環境のセットアップ

1. テスト用の Cloudflare Worker、D1、LINE 公式アカウントとグループを用意する。本番用にも別接続・別データを使う。本リポジトリの D1 ID はローカル用のプレースホルダーなので、実環境の設定では対象 DB ID に置き換える。移行の対象 DB を確認し、Wrangler の `d1 migrations apply` に `--remote` を付けて適用する。
2. Worker に `LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`、`LINE_BOT_USER_ID`、`LINE_ADMIN_USER_ID`、`EVENT_KEY_SECRET` を設定する。照合用の `EVENT_KEY_SECRET` は環境別に暗号学的乱数で作る。AI を使う環境だけ、専用の OpenAI プロジェクトの `OPENAI_API_KEY` を追加する。鍵は Wrangler の Secret または管理画面に入れる。
3. 配備した HTTPS URL の `/line/webhook` を LINE Developers に設定し、Webhook を検証する。公式アカウントのグループ参加と Webhook を許可し、意図しない標準自動応答は停止する。グループに Bot を招待して管理操作で登録する。
4. テキストによる記録・履歴・簡易提案を先に確認する。AI・写真・定時通知の初期値は無効。対象のクレジット・請求経路・自動チャージ設定と、写真の外部処理に対する家族の了承を確認してから必要な機能を有効にする。写真認識の前処理には Cloudflare Images Free の適用確認も必要。

## 管理操作

本番設定の変更は LINE 通常チャットのコマンドからは行えない。管理端末で対象アカウントと DB を選び、`CLOUDFLARE_ACCOUNT_ID`、`D1_DATABASE_ID`、対象アカウントの D1 を操作できる `CLOUDFLARE_API_TOKEN` を環境変数に設定する。読み取りに限定する運用では読み取り権限だけで実行する。

```powershell
node scripts/admin.mjs claim
node scripts/admin.mjs status
node scripts/admin.mjs approve <group-id> "LINE側の参加者を確認"
node scripts/admin.mjs pause "参加者変更を確認"
node scripts/admin.mjs feature push on 21:00 "専用公式アカウントの通数枠を確認"
node scripts/admin.mjs feature push off - "定時配信を停止"
```

`claim` で表示された確認コードを、指定した LINE 管理者本人が対象グループに10分以内に投稿する。`status` で候補が対象グループであることを確認し、期限内に `approve` する。参加者変更で停止した場合は同じグループを確認して再承認する。退出状態からの再登録には新しいコードが必要。承認直後は送信機能が停止状態に戻る。

`feature suggestions on <時差付きISO期限> "<費用の確認結果>"` で提案を有効にする。`feature photos on <時差付きISO期限> "<費用と説明の確認結果>" <Imagesの時差付きISO期限>` で写真を有効にする。期限には確認済みクレジットや条件の終了を超えない時刻を設定する。API の予算通知だけでは自動停止にならない。追加支出の条件を確認できなければ有効化しない。

## 保管と復旧

- `export-csv <path>` は日付と料理の閲覧用。`export-backup <path.backup.json>` は削除照合用の識別情報を含む復旧用。どちらも管理者の暗号化された領域に保存し、復旧用ファイルは28日で破棄する。
- 復旧時は旧 Worker の受信・配信を止めて、未処理の取消がないことを確認する。`pause` と `export-journal <path.backup.json>` で停止後の削除照合を取得する。最新の照合情報を取れない場合は旧バックアップを公開せず、空の履歴で再開する。
- `restore-preview <backup> <journal> <group-id>` で適用対象と除外数を確認する。復旧が必要な場合は、隔離した空の復旧先 DB 上で同じグループを承認して停止する。設定が復旧先を指していることを確認し、`restore <backup> <journal> <group-id> EMPTY_PAUSED_TARGET` を使う。同じ環境の取消照合用 Secret を保持する。再接続前にデータと参加者を確認し、AI・定時通知は利用量を確認した次の JST 月から必要に応じて再開する。

[要件定義書](docs/requirements.md) · [基本設計書](docs/basic-design.md) · [詳細設計書](docs/detailed-design.md)
