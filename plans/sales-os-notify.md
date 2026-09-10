# Sales OS — 通知エンジン (アラート/Webhook) 設計・実装指示書

対象: `fb/FB_20260908.txt` 行6「アラートのwebhook連携はどこから？」、`plans/sales-os-20260910.md` §1.5/項目5 の判断待ちに対する店主回答。設計書 §20 (Slack通知設計) が一次情報源。

## 0. 店主の決定 (2026-09-10)

最初に作る通知は **A. Morning Brief (毎朝ダイジェスト)**。`plans/sales-os-20260910.md` §項目5 で挙げた3択 (1. Slackへ自動通知/2. 任意URLへのOutgoing Webhook/3. 外部からの取り込みIncoming Webhook) のうち「1」、そのカテゴリの中でも A を最初に作る、という回答として扱う。
B (Pre-Meeting Brief) / C (Post-Meeting Capture) は `plans/sales-os-calendar.md` (カレンダー連携) が前提になるため、そちらの完了後に本書へ追記する。D (Due Reminder) / E (Escalation) / F (Manager Digest) / Outgoing Webhook / Incoming Webhook は本書の対象外 (要望が出たら別途)。

## 1. 現状

- 「アラートを出す側」は `packages/gatekeeper-sales/src/slack.ts` の `postToSlack()` と、`SettingsPage.tsx` の ADMIN 用「テスト送信」ボタンだけ。`slack.ts` 自身が「No triggers, no scheduling, no Notification Fatigue」と明記している。
- 自動トリガーが無い: `wrangler.jsonc` に `triggers.crons` 無し、DO に `alarm()` 無し。
- **DB スキーマは §11.14 どおりすでに存在する**が未使用: `packages/sales-core/src/domain/types.ts` の `NotificationLog`、`packages/sales-core/src/db/tables.ts:133` の `notificationLogs` テーブル。`Repository` にこのテーブルへの CRUD メソッドは無い (grep 0件)。
- 設定画面の「朝のダイジェスト時刻」(`SettingsPage.tsx:185`、`SalesConfig.morningDigestTime` 既定 `"08:50"`、`packages/sales-core/src/rules/config.ts`) は **保存されるだけでどこからも読まれていない** (grep で消費側ゼロ)。本書はこれを初めて実際に使う。
- 定期実行の手段: このリポジトリ内に cron はいらない。`packages/gatekeeper-scheduler` が「ワークスペースコードが持続的なコールバックを登録できる」ambient Gatekeeper を提供している (`packages/gatekeeper-scheduler/src/types.d.ts`)。Sales OS からはこれが初めての利用者になる。**登録はエージェント (executeCode) が `ctx.restore()` でコールバックを作り `SCHEDULER.calendarAt()` を呼ぶ操作で、登録後は Workshop の Connections 画面でユーザーが有効化するまで動かない** — コード側だけでは完結しない、一度きりの手動セットアップが要る。

## 2. 設計方針

### 2.1 スケジューリング — `gatekeeper-scheduler` を使う (cron を自前で作らない)

- `packages/gatekeeper-sales/src/sales-core-do.ts` の `SalesCoreDurableObject` に `[restore]()` を実装し、`{ type: "morningBrief", tenant }` を受けて `MorningBriefTask` (`RpcTarget`、`onSchedule(firing)` を実装) を返す。`onSchedule` の中で DO 自身の `SalesService` を使い、Morning Brief 本文を組み立てて `postToSlack()` する。
- 登録そのもの (`SCHEDULER.calendarAt(...)`) は **コードでは行わない**。店主 (または管理者) が Workshop 上でエージェントに「毎朝08:50にSales OSのMorning Briefを送って」と依頼し、エージェントが `ctx.restore({type:"morningBrief", tenant})` → `SCHEDULER.calendarAt({timeZone:"Asia/Tokyo", freq:"daily", hour:8, minute:50}, callback, {...})` を実行 → 店主が Connections 画面で有効化、という運用手順になる。この手順を README とレビュアーへの回答に明記する。
- **`morningDigestTime` を Settings で変更しても、すでに登録済みのスケジュールは自動的には動かない** (`ScheduleSession` に更新/削除APIが無く、`calendarAt` は登録時刻に固定される — `packages/gatekeeper-scheduler/src/types.d.ts` 全体を確認済み)。変更したときは「Connections で今のスケジュールを無効化し、エージェントに新しい時刻で登録し直してもらう」必要がある。この制約は Settings 画面の「朝のダイジェスト時刻」の説明文に明記する (実装項目 N4)。

### 2.2 Morning Brief の内容 — まず既存データだけで組み立てる

設計書 §20.1 A の内容は「今日の予定 / 重要NextAction / 期限超過 / 注意案件」。このうち「今日の予定」は `plans/sales-os-calendar.md` (カレンダー連携) が無いと出せない。

**カレンダー連携を待たずに v1 を出す**: `SalesService.getToday(actor)` (`packages/sales-core/src/service/sales-service.ts:275`) が返す `TodayView` の `now` (期限超過・今日期限) / `upcoming` / `attention` / `counts.overdue` だけで Morning Brief を組み立てる。カレンダー連携 (C7 まで) が完了したら「今日の予定」セクションを追記する (本書に追記)。

### 2.3 宛先 — 個人DMではなく、まずチーム共有チャンネルへの集約ダイジェスト

現在の Slack 連携は 1 Bot トークン + 1 固定チャンネル (`SALES_SLACK_CHANNEL`) のみで、ユーザーごとの Slack ID マッピングが無い (`User` に `slackUserId` 相当のフィールドが無い)。設計書 §20.1 A の文面は個人向け (「今日の予定」等) だが、個人 DM を今回作るのは大きすぎる (Slack スコープ追加・ユーザー同定の仕組みが要る)。

**v1 は「アクティブな営業担当者ごとのセクションをまとめた1通」を、既存の共有チャンネルに送る** (`ManagerSummary` に近い集約だが、Manager Digest (F) ではなく「今日やることリスト」に寄せる)。担当者個人へのDM配信は要望が出たら別途 (Slack `im:write` スコープ追加 + `User.slackUserId` 追加が必要になる大きめの変更)。

### 2.4 重複防止 (§20.2, `NotificationLog`)

- `messageHash` = 送信日 (JST) + `notificationType` ("morning_brief") + 本文のハッシュ。送信前に同じ日・同じ種別のログが `SENT` で存在するかを確認し、あれば送らない (`status: "SKIPPED_DUPLICATE"` を記録)。
- これは `ScheduledTaskHook.onSchedule` の再試行 (`runId` が同じまま再実行されうる) に対する冪等性の担保も兼ねる。送信前チェック → 送信 → ログ書き込み、の順で行い、途中で失敗したら `status:"FAILED"` を記録して例外を投げ (スケジューラのリトライに任せる)。

## 3. 実装項目 (1項目 = 1コミット)

### 項目 N1: `NotificationLog` の Repository 実装

- `packages/sales-core/src/db/repository.ts` に `insertNotificationLog` / `findRecentNotificationLog(userId, notificationType, since)` を追加。
- テスト: `packages/sales-core/__tests__/` に repository の単体テスト (重複判定・`SKIPPED_DUPLICATE` の記録)。

### 項目 N2: Morning Brief 本文の組み立て (`sales-core` 側、純粋関数)

- `packages/sales-core/src/pipeline/` か `src/rules/` に `buildMorningBrief(today: TodayView): string` を追加 (LLM 呼び出し無し、決定的なテンプレート整形。設計書 §17.5 の Slack 例のような箇条書き形式)。
- 空データ (期限超過0件・注意案件0件) のときの文面も決める (「今日は特に注意事項はありません」等)。
- テスト: fixture 的な `TodayView` を渡して出力を固定するテスト (`app/format.test.ts` と同じ考え方)。

### 項目 N3: `SalesCoreDurableObject` に `[restore]` + `MorningBriefTask` を実装

- `packages/gatekeeper-sales/src/sales-core-do.ts`: `[restore](params)` で `{type:"morningBrief"}` を受け、`MorningBriefTask` (`RpcTarget`) を返す。`onSchedule(firing)`:
  1. 全アクティブユーザー分の `getToday()` 相当を集約 (SYSTEM actor、承認キュー無し — Slack へ送るだけで DB に書き込まない読み取り専用処理)。
  2. `buildMorningBrief()` で担当者ごとのセクションを組み立てて1通にまとめる。
  3. N1 の重複チェック → `postToSlack()` → ログ記録。
- テスト: DO レベルのテスト (`__tests__/worker.ts` 系) で `onSchedule` を直接呼び、Slack 送信のモックとログ記録を確認。

### 項目 N4: Settings 画面の説明更新

- `SettingsPage.tsx` の「朝のダイジェスト時刻」欄に、§2.1 の運用上の注意 (時刻変更は Connections での再登録が要る) を短い説明文として追加。
- README に「Morning Brief の有効化手順」(エージェントに依頼 → Connections で有効化) を追記。

### 項目 N5: 実機セットアップ手順の実行 (コード変更なし)

- 店主 (または管理者) が実際に Workshop でエージェントに登録を依頼し、Connections で有効化する。翌朝の送信を確認して本書に結果を追記する。

## 4. 受け入れ基準

- sales-core / gatekeeper-sales の既存テストスイートが緑のまま (`sales-os-20260910.md` §0 の検証コマンド)。
- 実機: N5 の手順どおり登録・有効化したあと、翌朝 `morningDigestTime` (既定 08:50) 頃に Slack チャンネルへ1通届く。同じ日にもう一度スケジュールが (リトライ等で) 発火しても2通目は届かない。
- 実機: 期限超過・注意案件が無い日でも空文面ではなく「特になし」の一文が入る。

## 5. 残課題 (本書の対象外)

- Pre-Meeting Brief (B) / Post-Meeting Capture (C) — `plans/sales-os-calendar.md` 完了後に着手。
- Due Reminder (D) / Escalation (E、§20.3 のデフォルト例) / Manager Digest (F)。
- 担当者ごとの Slack DM 配信 (`User.slackUserId` の追加、`im:write` スコープ)。
- Outgoing Webhook (任意URLへのPOST) / Incoming Webhook (`POST /gatekeeper/sales/ingest`、前回書G) — 送信元・宛先が決まっていない。

---

```
Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015A2opEEGgeD2dy8ChiVU8d
```
