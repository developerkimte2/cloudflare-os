# Sales OS — Google Calendar 連携 設計・実装指示書

対象: `fb/FB_20260908.txt` 行5「calender連携はしている？」、`plans/sales-os-20260910.md` §1.4/項目4 の判断待ちに対する店主回答。設計書 §17 (Calendar統合) が一次情報源。

## 0. 店主の決定 (2026-09-10)

方式は **(a) Sales Core 独自の Google OAuth + `events.watch` + Webhook**。`plans/sales-os-phase0.md` §2 で保留されていた (a)/(b) の選択が確定。
(b) の「既存 Google gatekeeper (`packages/gatekeeper-google`) 経由のポーリング」は不採用— gatekeeper-google の共有 OAuth クライアント・Connections の仕組みは使わず、gatekeeper-sales が自分の Google Cloud OAuth クライアントと自分のトークン保管を持つ。

「最初に欲しい結果」「対象カレンダー」はまだ未回答。本書は (a) 方式のアーキテクチャと段階的な実装順序を示し、価値が出る最小単位 (フェーズA) から着手できるようにする。**フェーズB以降 (Pre-Meeting Brief 等) に入る前に、対象カレンダー (個人か共有か) だけは改めて確認する。**

## 1. 現状

- 両パッケージに Calendar 同期・OAuth・watch のコードは無い (`sales-os-20260910.md` §1.4 で確認済み)。あるのは列挙値とキャンセル処理のルールだけ:
  - `SourceType.CALENDAR_EVENT`、`ActivityType.CALENDAR` (`packages/sales-core/src/domain/types.ts`)
  - RULE-05 (予定キャンセル ≠ 失注) — `packages/sales-core/fixtures/005-calendar-cancel.ts` でテスト済み、変更不要
- **DB スキーマは §11.9 どおりすでに存在する**が、読み書きするコードが一切無い:
  - `packages/sales-core/src/domain/types.ts` の `CalendarEventMirror` インターフェース
  - `packages/sales-core/src/db/tables.ts:82` の `calendarEventMirrors` テーブル定義
  - `Repository` (`src/db/repository.ts`) にこのテーブルへの CRUD メソッドは無い (grep で0件)
- `packages/gatekeeper-google` は Gmail/Docs/Sheets/Drive/Calendar/BigQuery 共通の OAuth クライアントと Connections の仕組みを持つが、Calendar は read-write scope 止まりで `events.watch` は実装されていない (`grep -rn watch packages/gatekeeper-google/src` は 0 件)。今回はこれを使わない。
- `packages/gatekeeper-sales/src/worker.ts` は現在クラスのみを export しており、外部から叩ける HTTP エンドポイント (`fetch` ハンドラ) が無い。ただし `GatekeeperVendor` (`src/sales.ts:574`) は `WorkerEntrypoint` を継承しており、**`fetch(request)` メソッドを実装すれば Worker として実際に HTTP を受けられる** (`cloudflare:workers` の `WorkerEntrypoint` の標準機能)。OAuth コールバックと Push Notification Webhook はここに実装する。
- `env.d.ts` の `BASE_URL` (「Injected by run-dev-server / deploy: public base URL of this worker. Unused today.」) は、まさにこの用途 (OAuth redirect_uri と webhook URL の組み立て) のために予約されていたと考えられる。

## 2. アーキテクチャ

### 2.1 認可 (§17.1)

- Sales OS 専用の Google Cloud OAuth クライアント (`packages/gatekeeper-google` の README にある手順と同じ流れだが、**別のクライアントID/シークレット**)。scope は `https://www.googleapis.com/auth/calendar.events.readonly` のみ (write は今回不要)。
- 新規シークレット: `SALES_GOOGLE_CLIENT_ID` / `SALES_GOOGLE_CLIENT_SECRET`。
- 新規 DB テーブル (sales-core 側、`db/tables.ts` に追加): `google_calendar_tokens` — `userId`, `accessToken` (暗号化まではしない、DO SQLite はテナント専有ストレージなので既存の他シークレット類と同水準)、`refreshToken`, `expiresAt`, `scope`, `googleCalendarId` (対象カレンダー、既定 `primary`)、`watchChannelId`, `watchResourceId`, `watchExpiresAt`, `syncToken` (incremental sync 用)。
- フロー: `GET /oauth/google/calendar/start?state=...` (state は CSRF 用ランダム値、DO storage に一時保存) → Google の同意画面 → `GET /oauth/google/calendar/callback?code=...&state=...` でトークン交換 → 保存。開始点は `SettingsPage.tsx` に「Google カレンダーに接続」ボタンを追加し、`BASE_URL` を使って絶対 URL を組み立てる。

### 2.2 初期同期 (§17.2)

- 接続直後に過去30日〜未来90日を一括取得 (`events.list`)。`CalendarEventMirror` に upsert。件数が多いテナントを想定し、ページングしながら DO のトランザクション単位で分割コミット。
- 設定可能にする (`SalesConfig` に `calendarSyncPastDays` / `calendarSyncFutureDays` を追加、既定 30/90)。

### 2.3 Push Notification (§17.3) と Reconciliation

- 初期同期後に `events.watch` を呼び、`POST {BASE_URL}/webhooks/google/calendar` を通知先として登録。`GatekeeperVendor.fetch()` にルートを追加してこれを受ける。
- 通知本文には変更内容が入らない (Google の仕様どおり「変わった」という事実だけ) ので、受信したら対象カレンダーを incremental sync (`syncToken` を使う) する。
- **通知は100%保証されない**ので、定期 reconciliation sync も必要。cron trigger は `wrangler.jsonc` に無く追加しない方針 (`sales-os-20260910.md` の既存方針と合わせ、外部トリガーは `gatekeeper-scheduler` の ambient `SCHEDULER` バインディングに統一する)。`plans/sales-os-notify.md` 項目N1 で作る「定期実行の登録」の仕組みをここでも再利用し、1日1回のフル reconciliation を登録する。
- `watch` のチャンネルには有効期限がある (Google Calendar は最大30日)。期限切れ前の再登録も同じ日次 reconciliation ジョブの中でチェックする (`watchExpiresAt` が近ければ re-watch)。

### 2.4 Calendar Event Resolution (§17.4)

- 抽出項目: title / description / attendees / organizer / start・end / Meet URL / location。
- 顧客候補判定: attendee email → `CustomerPerson.email` 検索 → account 候補 → 既存 Opportunity 候補、という既存のエンティティ解決ロジック (`packages/sales-core/src/rules/entity-resolution.ts`) をそのまま再利用する。**新しいマッチングロジックは作らない** — 予定のテキスト (title + description + attendees) を組み立てて既存の `capture()` パイプラインに `sourceType: "CALENDAR_EVENT"`, `occurredAt: event.start` で渡すだけにできないか、を最初の実装単位で検証する (§2.5)。

### 2.5 予定 → Activity 変換 (店主の「最初に欲しい結果」候補 その1: 転記不要にする)

一番小さく価値が出る単位。Pre-Meeting Brief や Post-Meeting Follow-up (§17.5/17.6、通知エンジンとセット、`plans/sales-os-notify.md` 側) より先にここだけ作る。

- 新規予定を検知したら、`title` + `description` + 参加者名を1本のテキストに整形し、**既存の `SalesService.capture()` にそのまま投げる** (`sourceType: "CALENDAR_EVENT"`)。AI 分類・エンティティ解決・レビュー生成は既存パイプラインに任せる。これなら sales-core 本体は一切変更不要。
- 予定の変更・キャンセル (§17.7): `CalendarEventMirror.status` が変わったら、
  - 変更 (時刻ずれ) → 関連 `NextAction`/`Commitment` の `dueAt` を人手で確認できるよう `ReviewItem` を1件起こす (新しい `ReviewItemType` は増やさず既存の `"DATE_AMBIGUOUS"` を流用できるか、または `"OTHER"` にする — 実装時に既存の `resolveReview` の入力形式に合わせて決める)。
  - キャンセル → RULE-05 (実装済み) により失注扱いにしない。「Meeting cancelled」の Activity を1件残す。

## 3. 実装項目 (段階的、1項目 = 1コミット目安)

| # | 内容 | 備考 |
|---|---|---|
| C1 | `google_calendar_tokens` テーブル追加 + migration + Repository CRUD | sales-core |
| C2 | OAuth 開始/コールバック (`GatekeeperVendor.fetch()`) + `SettingsPage` の接続ボタン + `WhoAmI.calendar: {connected: boolean}` | gatekeeper-sales |
| C3 | 初期同期 (`events.list`、ページング、`CalendarEventMirror` upsert) | sales-core に `Repository` の CRUD、gatekeeper-sales に Google Calendar API 呼び出し |
| C4 | 予定 → `capture()` 変換 (§2.5、新規予定のみ) + RULE-05 の再確認テスト | 既存パイプラインへの一番小さい接続 |
| C5 | `events.watch` 登録 + Webhook 受信 (`POST /webhooks/google/calendar`) + incremental sync | 外部 HTTP 受け口を初めて開ける、慎重にテスト |
| C6 | 日次 reconciliation + watch 再登録 (`gatekeeper-scheduler` 経由、`sales-os-notify.md` 項目N1 に依存) | N1 が先 |
| C7 | 予定変更・キャンセルの Activity/Review 反映 (§2.5 後半) | |

Pre-Meeting Brief (§17.5) と Post-Meeting Follow-up (§17.6) は通知エンジンそのものなので、本書ではなく `plans/sales-os-notify.md` 側の項目として実装する (このドキュメントは C7 までで一区切り)。

## 4. 未確認・要検証事項

- **対象カレンダー**: 個人カレンダーか共有営業カレンダーか、店主に確認が要る (C1着手前)。個人の場合、ユーザーごとに OAuth 接続が要る (`SettingsPage` の接続ボタンは1ユーザー1回)。
- **Sales OS Worker への外部到達性**: `BASE_URL` が実際にインターネットから到達可能かどうか (Cloudflare OS のルーティング/デプロイ方式次第)。C2 着手前にプラットフォーム側 (Cloudflare OS 本体) に確認が必要 — 本パッケージのコードだけでは検証できない。
- Google Cloud OAuth クライアントの新規作成・同意画面の公開設定は店主 (または管理者) が Google Cloud Console 側で行う必要がある (`packages/gatekeeper-google/README.md` の手順が参考になる)。

---

```
Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015A2opEEGgeD2dy8ChiVU8d
```
