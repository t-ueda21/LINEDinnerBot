# LINE 晩ごはん Bot 調査報告書

> 家族の LINE グループで夕食をテキストと写真から記録し、翌日の献立を提案できる。写真は利用者が指定した1枚から料理名の候補を出し、本人が確認した内容を保存する。LINE は無料プランで始められる。OpenAI Responses API では画像も入力トークンとして課金されるため、追加支出なしで使える条件を確認する。

## 文書管理（必須）

| 記録項目 | 内容 |
| --- | --- |
| 文書版または更新日 | v1.1 · 2026-11-22 JST |
| 作成・更新者（該当時） | Codex |
| 関連資料・版の参照先（該当時） | 依頼原文と API キー方式の回答は開発時のチャット。回答はローカルの課題管理表 Q-001 に記録。 |

## 調査概要（必須）

| 記録項目 | 内容 |
| --- | --- |
| 調査の背景・発生事象（該当時） | 家族が既存の LINE グループで夕食を日々記録し、蓄積した履歴から翌日の献立を決めやすくしたい。対象フォルダにアプリ実装や既存の献立データは見当たらなかった。 |
| 調査目的 | 家族限定で実現できる機能と、LINE・ホスティング・AI それぞれの無料運用条件を把握し、本番要件を定める。 |
| 判断したい事項 | グループ参加・受信・返信・定期通知の可否、履歴の取得範囲、写真からの料理名の読み取り、費用とプライバシーの境界。 |
| 対象範囲 | 日本の LINE 公式アカウント、Messaging API、Cloudflare Workers・D1、OpenAI Platform の Responses API、Codex SDK／CLI との違い。 |
| 対象外（該当時） | アカウント開設・契約変更、配備、実データの送信・閲覧、実機試験、開発工数や外貨換算を含む費用見積もり。 |
| 確認方法 | 提供元の公開仕様と料金表を確認。LINE の月間通数は同ガイドの受信人数による計算方法で照合。 |
| 調査対象の期間（該当時） | 2026-11-22 JST に公開資料を確認。契約・料金・モデルは本番設定時に再確認する。 |
| 対象の版・環境（該当時） | 日本向け LINE 料金、Workers Free、D1 Free、OpenAI Platform 標準料金。個別アカウントの状態は対象外。 |

## 確認結果と根拠（必須）

| 確認事項 | 情報源・参照先 | 確認方法・条件 | 確認した事実 | 判断への影響 |
| --- | --- | --- | --- | --- |
| L1 グループ参加と応答 | [LINE のグループ仕様](https://developers.line.biz/ja/docs/messaging-api/group-chats/)・[初期設定](https://developers.line.biz/ja/docs/messaging-api/getting-started/) | 公式ガイド | LINE 公式アカウントで Messaging API とグループ参加を有効にすれば招待でき、グループ ID 付きイベントを受信し、返信やプッシュを送信できる。同時に参加できる LINE 公式アカウントはグループごとに1つ。グループ宛の投稿は全員に表示される。 | 既存公式アカウントの有無と、招待メンバーの管理を開始時に確認する。 |
| L2 取得できる履歴 | [Webhook 受信](https://developers.line.biz/ja/docs/messaging-api/receiving-messages/)・[API リファレンス](https://developers.line.biz/en/reference/messaging-api/nojs) | イベント一覧と公開エンドポイントを確認 | 参加中に発生するメッセージイベントからテキストを受け取れる。過去のグループ投稿一覧を取得する公開 API は確認できなかった。送信取消はイベントとして受信できる。メンバー ID 一覧の取得には認証済またはプレミアムアカウントが必要。 | Bot 導入後に記録を蓄積する。過去分は必要なら日付指定で手入力。アクセス単位は管理者が承認したグループにする。 |
| L3 料金・通数 | [LINE 公式アカウント料金](https://www.lycbiz.com/jp/service/line-official-account/plan/)・[Messaging API の通数計算](https://developers.line.biz/en/tips/2026/05/28/how-to-count-messages/) | 日本のプランと Messaging API の数え方を照合 | コミュニケーションプランは月額0円、月200通、超過分の追加配信不可。Reply API の応答は通数に含まれない。プッシュは送信先の人数で計上される。 | 日々の記録確認・手動提案は応答で行う。定時通知だけをプッシュ候補とする。 |
| L4 期限・再送・署名 | [LINE 署名検証](https://developers.line.biz/ja/docs/messaging-api/verify-webhook-signature/)・[Webhook 受信](https://developers.line.biz/en/docs/messaging-api/receiving-messages/)・[API リファレンス](https://developers.line.biz/en/reference/messaging-api/nojs#send-reply-message)・[送信の再試行](https://developers.line.biz/en/docs/messaging-api/retrying-api-request/) | 正常時と再送時の仕様を確認 | 未加工のリクエストボディで署名を検証する。応答トークンは一度限りで、受信後1分を超える使用は保証されない。Webhook 再送は保証されず、重複・順序逆転も考慮が必要。プッシュは同一の再試行キーで二重受付を防げる。 | 保存と返信を分けて失敗を扱う。AI が遅ければ履歴ベースの候補を応答し、遅延を理由にプッシュしない。 |
| O1 API 接続方法 | [Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)・[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)・[非対話実行](https://learn.chatgpt.com/docs/non-interactive-mode) | 公開 API と Codex の実行方式を比較 | Responses API はプロジェクト API キーで呼び出せる。Codex SDK／CLI は Codex エージェントを稼働させる別の経路。今回の分析はテキストを入力して結果を生成する処理で完結する。 | ユーザーが選んだ API キー方式で、Responses API の直接呼び出しを推奨する。 |
| O2 モデル | [モデルの廃止予定](https://developers.openai.com/api/docs/deprecations)・[GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)・[GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol) | 稼働候補と単価を確認。USD・100万トークン・標準の非キャッシュ入力／出力 | 旧 `gpt-5.3-codex` は2027-04-01停止予定。公式の移行先 `gpt-6-sol` は入力 $2.00、出力 $10.00。テキスト分析用の低価格候補 `gpt-6-luna` は入力 $0.10、出力 $0.50。双方が Responses API に対応する。 | 低価格候補を家族向けの日本語とサンプル履歴で評価する。Codex の後継モデル名を重視する場合は Sol を同じ評価条件で比較。モデルは設定で切り替え可能にする。 |
| O3 API クレジットと上限 | [API クレジットの条件](https://developers.openai.com/api/docs/guides/chatgpt-api-credits)・[API プロジェクト管理](https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform) | 対象契約、対象 API、残高枯渇時の仕様を確認 | 対象の有料 ChatGPT Pro・Business は申請して連携 API 組織にクレジットを付与できる。Responses API は対象。Codex エージェントの API キー利用は同特典の対象外。付与分終了後は購入済み残高があれば消費され、残高がなければ同特典の案内上は429になる。プロジェクト予算は通知であり、遮断機能ではない。 | 無料寄りの運用でも実際の組織・残高・自動チャージ設定を確認。追加支出0円を確認できるまで Bot の AI 呼び出しを停止できるようにする。 |
| O4 API に送る情報 | [OpenAI Platform データ管理](https://developers.openai.com/api/docs/guides/your-data) | Responses API の標準設定と保持条件を確認 | API データは標準で学習に使われない。応答のアプリケーション状態は `store:false` で保存を抑制できるが、標準の不正利用監視ログは通常最大30日。 | 送信は食事情報・集計に限定。外部処理と保持の可能性を家族に説明する。 |
| C1 ホストと保存 | [Workers 制限](https://developers.cloudflare.com/workers/platform/limits/)・[D1 料金](https://developers.cloudflare.com/d1/platform/pricing/)・[定期実行](https://developers.cloudflare.com/workers/configuration/cron-triggers/)・[workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/) | Workers Free・D1 Free を確認 | Workers Free は10万リクエスト／日、D1 Free は500万行読取／日・10万行書込／日・アカウント総容量5 GB。定期実行は UTC。個人用途向けの公開 HTTPS の `workers.dev` URL を使える。 | 小規模用途の候補。公開 URL への LINE 到達性、CPU 制限、保存と定期実行の動作は段階的に検証する。 |
| L5 写真データの取得 | [LINE Get content](https://developers.line.biz/en/reference/messaging-api/nojs#get-content) | 画像イベントと取得条件を確認 | LINE が提供する画像は Webhook のメッセージ ID を使って取得できる。保持期間の保証はない。外部提供の画像 URL には別の取得経路が必要。 | 指定した投稿だけを早めに取得する。初版は LINE 提供の画像のみ。取得不能時はテキスト入力を案内する。 |
| O5 写真からの料理名の候補 | [OpenAI 画像入力](https://developers.openai.com/api/docs/guides/images-vision)・[GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)・[データ管理](https://developers.openai.com/api/docs/guides/your-data) | Responses API、モデルの入力形式、料金と保持を確認 | 画像入力対応モデルに画像を直接送信できる。画像入力もトークン課金の対象で、見た目が似た料理や写っていない材料は正確に判定できる保証がない。標準の監視ログや画像固有の保持例外がある。 | 画像の保存・公開 URL は不要。料理名は確認候補とし、画像解析の回数・サイズを制限する。家族が理解した上で写真を送る。 |

## 定期配信が LINE の無料枠に収まる条件

専用アカウントで他のカウント対象送信が0件、31日間に1日1回送信し、全員に届く場合。応答メッセージは下表の枠を消費しない。運用時は無料枠の残量と実際の人数で判定する。

| 家族の人数（Bot を除く） | 毎日1回の最大通数 | 月200通との差 |
| --- | ---: | ---: |
| 4人 | 124通 | 76通 |
| 6人 | 186通 | 14通 |
| 7人 | 217通 | 17通超過 |

## 本番初版の後に検討できること

- 週次の振り返り、曜日別の傾向、よく出る主菜や久しぶりの献立は、蓄積した記録を使って追加できる。曜日別は比較できる記録日数が揃ってから表示する。
- 1日に複数の写真をまとめて認識する運用は、解析回数・選択操作・保存単位が増えるため、初版の1枚入力を評価してから検討する。
- LINE の投稿編集はグループでイベントを受信できる。初版の記録訂正は Bot の明示コマンドで行う。 [LINE の Webhook イベント一覧](https://developers.line.biz/en/docs/messaging-api/receiving-messages/)

## 結論（必須）

| 判断事項 | 調査結果・結論 | 根拠の参照先 |
| --- | --- | --- |
| 家族用の記録・提案 | 実現可能。専用アカウントを承認済みの1グループに追加し、指定形式の記録だけを保存。手動の提案は Reply API を使い、定時配信は希望と無料残量に応じて有効にする。 | L1〜L4 |
| OpenAI Platform の利用 | プロジェクトキーで Responses API を呼び、履歴の集計と献立候補の作成を組み合わせる案を推奨。GPT-6 Luna を第一評価候補とする。 | O1・O2、Q-001 |
| 無料目標 | LINE・ホストを無料枠内に収める経路はある。AI の追加支出0円はクレジット等の適用条件を確認できた場合に成立する。AI を停止しても手動記録・履歴と簡易提案を続けられる構成を推奨。 | L3・O3・C1 |
| 写真による記録 | 実現可能。先に「写真で晩ごはん」と宣言した本人の次の1枚を解析し、料理名の確認・修正後に記録する運用を推奨。日常の写真は画像データを取得しない。 | L5・O5 |

## 未確認事項（補足）

| 未確認事項 | 確認できていない理由 | 判断への影響 | 次の確認・課題 ID（該当時） |
| --- | --- | --- | --- |
| API 組織・クレジット・購入済み残高・自動チャージ | 公開資料を対象とした調査 | AI の追加支出0円が成立するかを左右する。 | 本番設定前に専用の API プロジェクトと所属組織の請求設定を確認する。 |
| 家族の人数、他の公式アカウント、定期通知の希望 | 実グループの設定やメンバー情報を参照していない。 | 招待と定期プッシュの可否に影響する。 | 本番前に管理者が確認。初期設定は手動呼び出し。 |
| API および LINE での実測 | 未実施（今回の範囲は調査・要件定義）。 | 応答時間・提案品質・実際の通数は確定していない。 | テスト用グループと架空の献立で受け入れ条件を検証する。 |
| 写真認識と無料枠 | 料理写真による API 実行・Worker 計測は対象外。 | 認識品質、画像トークン数、レスポンス、画像処理に必要な CPU は実測が必要。 | 非公開のテストグループで同意済みのサンプルを使い、形式・プライバシー・無料枠内の処理を確認する。 |

## 再現確認（補足）

未実施（今回の確認対象は公式仕様。実アカウントと Bot 実装は後続工程で使用する）。

## 原因分析（補足）

対象外（新規開発の実現性調査）。

## 実現可能性の比較（補足）

| 選択肢 | 成立条件 | 期待効果 | 費用・制約・リスク | 比較結果・判断理由 |
| --- | --- | --- | --- | --- |
| A Workers・D1＋Responses API | Workers Free・D1 Free で負荷を処理。API の利用権限および課金条件を確認。 | 自宅 PC の稼働に依存せず、記録・提案・定時配信を動かせる。 | LINE・ホストは無料枠。API は従量課金。Workers の CPU・実行制約と無料枠を管理する。 | 推奨。API キー方式と運用負担の両方に合う。 |
| B 自宅の常時稼働機・SQLite＋Responses API | 常時稼働機、固定の公開 HTTPS 入口、電源・バックアップ・復旧を確保。 | 記録の保存場所を自宅に限定できる。 | API は引き続き従量課金。追加の電気代・停止時の対応・入口の維持が必要。トンネルを使う場合も稼働機が必要。 | 自宅保管が優先の場合の候補。 [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/) |
| C A の構成で API を無効にする | 月額無料枠を維持し、候補を履歴ベースのルールで選ぶ。 | API への送信がなくても、記録・集計・簡易提案が使える。 | AI による柔軟な提案は表示できない。 | 本番の障害・費用対策として採用候補。通常時の AI 要件は A で満たす。 |

## 図・補足資料（補足）

| 業務フロー図・補足資料 | 確認できる事項 | 参照先 |
| --- | --- | --- |
| 家族の投稿 → LINE のイベント → Bot の記録 → 履歴集計 → AI または簡易候補 → 同じグループへの返信 | 通常会話は保存せず、Web の公開入口と利用者の範囲を分けられる。 | L1〜L4・O1・O4 |

## 影響範囲と条件（補足）

| 影響対象・利用者 | 影響が発生する条件 | 確認した影響・程度 | 未確認範囲（該当時） | 根拠 |
| --- | --- | --- | --- | --- |
| 家族グループ | Bot を招待する。 | 通常会話も LINE から Webhook に届く。Bot が保存・分析する投稿は限定できる。Bot の発言はグループ全員に表示される。 | 実グループのメンバーと運用への同意。 | L1・L2 |
| 管理者 | AI 処理と定期配信を許可する。 | API の利用量と LINE の残量を把握する必要がある。 | 個別の利用可能枠と頻度。 | L3・O3 |

## 制約・依存・対応判断（補足）

| 制約・依存する項目 | 判断に必要な条件 | 対応候補・判断理由 | 次の確認・課題 ID（該当時） |
| --- | --- | --- | --- |
| 家族限定運用 | 承認したグループに家族だけがいる。 | グループ ID の固定・管理者による開始／停止・参加者変更時の一時停止。LINE 側の既送信メッセージの閲覧範囲は Bot から制御できないため、招待は管理者が管理する。 | 実グループの招待設定・既存公式アカウントの確認。 |
| ログ・保存と同意 | LINE・ホスト・OpenAI の処理範囲が説明されている。 | 通常会話を保存せず、家族名や LINE ID を API に送らない。 | 本番開始前に管理者が家族へ説明する。 |

## 変更・レビュー履歴（補足）

| 版・日付 | 変更理由・対象項目 | 確認内容・結果 | 差分やレビューの参照先（該当時） |
| --- | --- | --- | --- |
| v1.0 · 2026-11-22 | 新規調査 | 公開資料と依頼の API キー条件を照合。 | L1〜L4・O1〜O4・C1 |
| v1.1 · 2026-11-22 | 初版に画像入力を追加 | 画像取得・画像認識・プライバシー・課金の条件を確認。写真投稿だけでは分析せず、事前宣言した本人の写真を対象とする案を選択。 | L5・O5 |
