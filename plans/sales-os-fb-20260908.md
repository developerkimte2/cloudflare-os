# Sales OS — FB_20260908 対応指示書

対象フィードバック: `fb/FB_20260908.txt` (2026-09-08、レビュアーからの質問 6 件 + 営業日報サンプル 50 本)。
本書は **修正の指示のみ** を記す。コードは未変更。実装は 1 項目 = 1 コミットで、順番に進める。

## 0. 現状 (2026-09-08 時点)

| 項目 | 状態 |
|---|---|
| ブランチ / 最新コミット | `local-patches` / `78dd696 Add Sales OS Phase 0` (未 push) |
| 未追跡 | `fb/` (本 FB ファイル)、`dev-server.log` — どちらもコミット対象外 |
| テスト | sales-core 160 件、gatekeeper-sales 17 件 (worker 2 + node 1 + app 14) すべて緑 |
| dev-server | `start-local.ps1` で起動中 (http://localhost:8787)。Sales OS は登録済み、capture 1 件処理済み |
| 判定 AI (ローカル) | `packages/gatekeeper-sales/.dev.vars` = `ollama / qwen3-coder:30b` (gitignore 済み) |

### 進め方の共通ルール

- 実行は Sonnet で。サブエージェントは使わず 1 項目ずつ。各項目の最後に下の検証を回してからコミット。
- 検証コマンド (リポジトリ直下):
  ```
  pnpm --filter @gadgets/sales-core test:run
  pnpm --filter @gadgets/gatekeeper-sales test:run
  pnpm --filter @gadgets/gatekeeper-sales build      # typecheck:app + vite build + tsc
  ```
- `packages/gatekeeper-sales/src/types.d.ts` を触ったら `src/types.txt` も同じ内容にする (types-copy テストが落ちる)。
- `packages/sales-core/src/ai/skills.ts` のプロンプト文を 1 文字でも変えたら `EXTRACTION_PROMPT_VERSION` を `extract.v2` に上げる (設計書 §0-10)。本書の P1〜P2 はプロンプトを変えないので不要。
- レビュー文言を変える項目 (A, B) は `packages/sales-core/__tests__/` を `grep -rn "AI の解釈\|confidence\|と判断しました"` して、文字列一致しているテストを新文言に合わせる。

### 優先順位

| 優先 | 項目 | 大きさ | FB 番号 |
|---|---|---|---|
| P1 | A. レビュー文言から生の ISO 日時と confidence 数値を消す | 小 | 3 |
| P1 | E. 入力欄の「話す」プレースホルダを直す | 極小 | 1 |
| P1 | B. 画面に出ている英語 enum を日本語ラベルにする | 小 | 3 |
| P2 | C. 「判定している AI」を画面に出す | 小 (任意部分は中) | 4 |
| P3 | D. 複数件 (50 本の日報) の一括取り込み | 大・設計判断あり | 2 |
| P3 | G. Webhook 取り込み口 | 設計判断のみ (Phase 1) | 6 |
| 回答のみ | F. カレンダー連携 / 音声 | — | 5, 1 |

---

## A. レビュー文言から生の ISO 日時と confidence を消す (P1)

### 何が起きているか

曖昧な期限のレビューが次のように表示される (実機で確認済み):

> 約束「来月中旬までに見積を送る」の期限が曖昧です (AI の解釈: 2026-09-15T18:00:00+09:00, confidence 0.80)。期限を確定しますか？

生成箇所:

- `packages/sales-core/src/pipeline/ingest.ts:405-413` — DATE_AMBIGUOUS の `question` と選択肢ラベル `AI の解釈 (${c.due_at}) を採用` に `c.due_at` (ISO) と `c.due_confidence.toFixed(2)` を直接埋めている。
- `packages/sales-core/src/rules/business.ts:47-53` — ON_HOLD / CLOSED が閾値未満のときの `question` に `${s.lifecycle_state}` (英語 enum) と `confidence ${...toFixed(2)}` を埋めている。

### 修正

1. `packages/sales-core/src/domain/util.ts` に人間向け整形関数を追加する。
   ```ts
   /** 「9月15日(月) 18:00」。timeZone はユーザーの timezone。 */
   export function formatDateTimeJa(iso: string, timeZone: string): string
   ```
   `Intl.DateTimeFormat("ja-JP", { timeZone, month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })` をベースに組む。既存の `formatLocal()` (util.ts:77) は英語表記なのでそのまま残す (プロンプト用)。
2. `ingest.ts` の DATE_AMBIGUOUS 生成を次に変える。`applyExtraction()` の引数 `submitter: User` に `timezone` があるので `submitter.timezone || ctx.config.defaultTimezone` を使う。
   - question: `約束「${c.description}」の期限がはっきりしません。AI は「${formatDateTimeJa(c.due_at, tz)}」と読み取りましたが、自信がありません。期限を確定しますか？`
   - accept ラベル: `${formatDateTimeJa(c.due_at, tz)} にする`
   - `value: { dueAt: c.due_at }` は **変えない** (ISO のまま。`sales-service.ts:486` の解決処理が使う)。
   - confidence の数値は文言から外す。数値は `ai_decisions` に残っているので監査上は失われない。
3. `business.ts:47-53` を次に変える。`lifecycle_state` は `ON_HOLD → 保留`, `CLOSED → 終了` の日本語 (sales-core 側に小さな `LIFECYCLE_LABEL_JA` を置く。SPA の `labels.ts` とは別物でよい)。
   - question: `AI は本件を「${label}」と判断しましたが、自信がありません。適用しますか？`
   - confirm ラベル: `「${label}」にする`
4. 任意 (UX 改善): `packages/gatekeeper-sales/app/components/ReviewCard.tsx:84-104` の `needsInput === "dueAt"` 用 `datetime-local` の初期値を空ではなく AI の解釈にする。そのために `ingest.ts` の `set` オプションの value を `{ needsInput: "dueAt", suggestedDueAt: c.due_at }` にし、ReviewCard 側で `isoToLocalInput(suggestedDueAt, timezone)` を初期値にする。`sales-service.ts:486` は `input?.dueAt` しか見ないので影響なし。

### 受け入れ基準

- 画面のレビュー文言に `T18:00:00+09:00` 形式の ISO 文字列、`confidence 0.xx`、英語の enum (`ON_HOLD` 等) が出ない。
- `fixtures/008-relative-date.ts` を含む sales-core のテストが緑 (文字列アサーションを更新)。
- `optionsJson[].value` の中身 (ISO) は従来どおり。`resolveReview` の既存テスト (`__tests__/pipeline.test.ts`, `undo.test.ts`) が緑。

---

## E. 入力欄の「話す」プレースホルダ (P1)

`packages/gatekeeper-sales/app/components/CaptureBox.tsx:71` のプレースホルダが「話す、または貼る（…）」で、音声入力があるように読める。Phase 0 に音声は無い (計画書 §4)。

- 変更: `placeholder="貼る、または書く（メール、議事録、雑な一言でもOK）"`
- `packages/gatekeeper-sales/src/types.d.ts:6` のコメント「a voice-memo transcript」は「文字起こしを貼る」用途なのでそのままでよい。
- レビュアーへの回答: 音声は Phase 2。今は Windows の音声入力 (Win+H) でこの欄に口述すれば同じことができる。

---

## B. 画面の英語 enum を日本語ラベルに (P1)

`packages/gatekeeper-sales/app/pages/OpportunityDetailPage.tsx` に生の enum 表示が残っている。`app/labels.ts` に以下を追加して差し替える。

| 行 | 現在 | 追加するラベル表 |
|---|---|---|
| 793 | `decision.decisionType` | `DECISION_TYPE_LABEL`: ENTITY_RESOLUTION=顧客の特定, OPPORTUNITY_RESOLUTION=案件の特定, STATE_CHANGE=状態の判定, NEXT_ACTION=次アクション, RISK=リスク評価, COMMITMENT=約束の抽出, NOTIFICATION=通知 |
| 795 | `decision.status` | `DECISION_STATUS_LABEL`: AUTO_APPLIED=自動反映, REVIEW_REQUIRED=確認待ち, APPROVED=承認済み, REJECTED=却下, REVERTED=取消 |
| 820 | `entry.actorType` | `ACTOR_TYPE_LABEL`: USER=担当者, AI=AI, SYSTEM=システム, ADMIN=管理者 |
| 822 | `entry.action — entry.entityType` | `AUDIT_ACTION_LABEL` (下記 25 種) と `ENTITY_TYPE_LABEL` |
| 435 | `risk.level` | 既存の `RISK_LABEL` を使う (値は NONE/LOW/MEDIUM/HIGH) |
| 442, 803 | `modelProvider/modelName ・ promptVersion` | 残してよいが先頭に「判定AI: 」を付ける (項目 C と合わせる) |

`AUDIT_ACTION_LABEL` のキー (sales-core が実際に発行しているもの):
ACTIVITY_CREATED, ACTIVITY_DETACHED, COMMITMENT_DUE_SET, COMMITMENT_UPDATED, CONFIG_UPDATED, CONTEXT_RECOMPUTED, CUSTOMER_CONFIRMED_NEW, CUSTOMER_MERGED, NEXT_ACTION_CREATED, NEXT_ACTION_DUE_SET, NEXT_ACTION_UPDATED, OPPORTUNITY_DELETED, OPPORTUNITY_EDITED, OPPORTUNITY_MERGED, OPPORTUNITY_RESTORED, REVIEW_DISMISSED, REVIEW_RESOLVED, SOURCE_DISCARDED, SOURCE_FAILED, SOURCE_PROCESSED, SOURCE_RECEIVED, SOURCE_REVERTED, USER_CREATED, USER_ROLE_CHANGED, USER_UPDATED。
未知のキーは英語のまま表示するフォールバック (`label ?? raw`) を入れる。`ENTITY_TYPE_LABEL` のキーは `grep -rhoE 'entityType: "[a-z_]+"' packages/sales-core/src | sort -u` で採る。

型は `labels.ts` の既存パターン (DTO のフィールド型から `Record<..., string>` を導く) に合わせる。`AuditLog["action"]` は `string` なので `Record<string, string>` でよい。

日付入力について: レビュアーの「通常の日付選択にして」は、`ReviewCard.tsx:89` / `CaptureBox.tsx:112` / `OpportunityDetailPage.tsx:301,578` がすでにブラウザ標準の `date` / `datetime-local` ピッカーなので、指摘の実体は項目 A の生 ISO 表示と判断する。A の任意項目 (初期値に AI の解釈を入れる) をやれば体感はさらに改善する。

### 受け入れ基準

- 案件詳細の「AI判断履歴」「監査ログ」「リスク」に英語の大文字 enum が出ない。
- `pnpm --filter @gadgets/gatekeeper-sales build` が通る (labels.ts の `Record` 型で網羅漏れがあれば tsc が落ちる)。

---

## C. 「判定している AI は何？」を画面に出す (P2)

### 現状

- `WhoAmI.ai = { provider, model, configured }` は `sales.ts` が返しており、`App.tsx:108` は `configured` の警告バナーにしか使っていない。
- 設定ページ (`SettingsPage.tsx`) には provider/model を表示済み。案件詳細の AI コンテキストと AI 判断履歴には `modelName` を表示済み (項目 B で「判定AI:」を付ける)。
- レビューカード (`ReviewCard.tsx`) と Today の「確認してください」には出ていない。`ReviewItem` には `modelName` が無い (`AIDecision` と `AIContextSnapshot` にはある: `domain/types.ts:252, 282`)。

### 修正 (必須部分)

1. `App.tsx` から `TodayPage` と `ReviewPage` に `ai={who.ai}` を渡す (`ReviewPage` の props に追加。`ManagerPage` は不要)。
2. `TodayPage.tsx` の「確認してください (N)」セクション見出しの右に、`CaptureResultView.tsx` の結果ヘッダにも、小さく `判定AI: {ai.provider} / {ai.model}` を出す (`text-[11px] text-kumo-inactive`)。`ReviewPage.tsx` のヘッダ説明文にも同じ 1 行。
3. `configured === false` のときは「未設定」と出す。

### 修正 (任意: 判定時のモデルを履歴として残す)

モデルを切り替えたあとも「このレビューはどのモデルが出したか」を正確に出したい場合のみ:

- `db/migrations.ts` に `ALTER TABLE review_items ADD COLUMN model_name TEXT` の新マイグレーションを追加 (既存 DO の DB を壊さないよう追記型)。
- `db/tables.ts` の review_items テーブル定義に `col("model_name", "modelName")` を追加 (ai_decisions / context_snapshots の同名列が手本: tables.ts:101, 112)、`domain/types.ts` の `ReviewItem` に `modelName?: string`。
- `ingest.ts:215-227` の `review()` ヘルパで `modelName: meta.modelName` を入れる。
- `ReviewCard.tsx` で `review.modelName` があれば表示。
- `__tests__/db.test.ts` にマイグレーション後の列存在テスト、`pipeline.test.ts` に `reviews[].modelName === "fake-model"` の assert を足す。

### レビュアーへの回答

- ローカル検証環境: Ollama 上の `qwen3-coder:30b` (`.dev.vars`。gitignore 済み)。
- 本番想定: Anthropic Claude を AI Gateway 経由 (計画書 §2 "LLM")。`SALES_AI_PROVIDER` / `SALES_AI_MODEL` で切替。
- 各判断には model / prompt version / confidence / evidence が `ai_decisions` として残っている (設計書 §0-10)。

---

## D. 50 本の営業日報を入れたら 6 件しか残らなかった (P3)

### 原因

- 入力欄の上限ではない。`CaptureBox.tsx:68-74` の `<textarea>` に `maxLength` は無く、サーバ側の上限は 100,000 文字 (`ingest.ts` `captureText`)。50 本で約 7,500 文字なので余裕。
- 本質は設計: **1 回の取り込み = 1 SourceDocument = 1 Activity + 1 Opportunity**。抽出スキーマの `activity` と `opportunity` は配列ではなく単一オブジェクト (`ai/schema.ts:90-102`)、`applyExtraction()` は案件をちょうど 1 つ解決する (`ingest.ts:241-370`)。50 社分を 1 テキストとして投げると、1 つの (おそらく顧客未特定の) 案件に全部がぶら下がり、`facts` は最大 50、`next_actions` は最大 20 で切られ、モデルはその一部しか出さない。「6 件」はモデルの出力途中で止まった数で、コードからは再現できない。
- プロンプト (`skills.ts`) にも複数顧客が混在した場合の指示は無い。

### 方針 (推奨: 決定的な分割 + 1 件ずつ取り込み。設計書 §0-18「単純・監査可能」)

1. **分割関数** `packages/sales-core/src/pipeline/split.ts`
   ```ts
   export interface SplitResult { chunks: string[]; rule: "heading" | "blank-lines" | "none" }
   export function splitCaptureText(text: string): SplitResult
   ```
   - rule=heading: 行全体が `【…】` (1〜40 文字) の見出し行の直前で分割。FB ファイルの `【営業日報 01】` 形式が対象。見出し行はチャンクに含める。
   - rule=blank-lines: 見出しが無く、空行 2 つ以上で区切ると 2〜100 個のチャンクになり、かつ全チャンクが 20 文字以上のとき **候補として** 返す (自動では使わない。メールスレッドを誤分割しないため)。
   - それ以外は rule=none, chunks=[text]。
   - 各チャンクは trim、空は捨てる。上限 100 チャンク。
   - テスト `__tests__/split.test.ts`: (a) FB 形式 3 本のサンプルを埋め込み → 3 チャンク・見出し込み、(b) 空行で区切られたメール 1 通 → rule=blank-lines だが呼び出し側が採用しない前提、(c) 1 段落 → none、(d) 101 個以上 → 100 で打ち切り。`fb/` ディレクトリには依存しない (未追跡)。
2. **取り込みは UI 側で 1 件ずつ**。新しいサーバ API は作らない (50 × Ollama 数分 = 1 RPC では長すぎる。Anthropic でも 1 件 3〜10 秒なので逐次で十分)。
   - `CaptureBox.tsx`: テキスト変更時に `splitCaptureText` を評価し、`rule === "heading"` で 2 件以上なら入力欄の下に案内バーを出す:「N 件の記録が含まれているようです。[N 件に分けて取り込む] [1 件として取り込む]」。`rule === "blank-lines"` のときは「空行で N 件に分ける」を **オプション内** の選択肢としてだけ出す。
   - 分けて取り込む: `onCapture(chunk, options)` を直列に呼ぶ (Promise.all 禁止。DO と LLM の詰まりを避ける)。進捗「3 / 50 取り込み中…」、中止ボタン、失敗したチャンクは行ごとに「再試行」。完了後は 1 行 1 件の一覧 (顧客/案件名、レビュー件数、失敗) を出し、既存の `CaptureResultView` は 1 件のときだけ使う。
   - 重複はサーバ側 `content_hash` で弾かれる (`duplicate: true`)。一覧に「重複」と出す。
   - 分割関数を SPA から使うには `@gadgets/sales-core/src/pipeline/split.ts` を深い相対パスで import する (tsconfig.app.json の paths は `@gadgets/sales-core` → `../sales-core/src/index.ts` のみなので `paths` に `"@gadgets/sales-core/*": ["../sales-core/src/*"]` を足す)。`index.ts` 経由にすると `db/` が引きずられて `node:sqlite` がバンドルに入る恐れがあるので必ず深い import にし、ビルド後 `grep -c "node:sqlite" src/generated/app.txt` が 0 であることを確認する。
3. **防御層 (任意、後回し可)**: プロンプト rule 13「本文に明らかに別々の顧客・商談が複数含まれる場合は `multiple_records: true` を返す」+ スキーマに `multiple_records: z.boolean().default(false)` を追加し、`applyExtraction` でそれが true なら `OTHER` レビュー「複数の記録が 1 つの入力に含まれています。分けて取り込み直してください」を作って通常処理は続ける。**これをやる場合は `EXTRACTION_PROMPT_VERSION` を `extract.v2` に上げ、`__tests__/ai-skills.test.ts` のスナップショットを更新する。** 分割 UI が入れば発生頻度は低いので、まず 1〜2 だけで様子を見る。
4. エージェント経路 (`SalesSession.capture`) は変えない。`types.d.ts` の冒頭コメントに「複数の商談は 1 件ずつ capture する」を 1 行足す程度 (`types.txt` も同期)。

### 受け入れ基準

- FB ファイルの 50 本を入力欄に貼ると「50 件に分けて取り込む」が出て、実行すると 50 件の SourceDocument / Activity / Opportunity (顧客未特定のレビュー付き) ができる。途中で 1 件失敗しても残りは続く。
- 1 通のメール本文 (空行あり、見出し無し) を貼っても自動では分割されない。
- `split.test.ts` と既存テストが緑、`build` が通り、app.txt に `node:sqlite` が含まれない。

---

## G. 「アラートの Webhook 連携はどこから？」「Webhook に入らなかった」 (P3・設計判断)

### 現状

- gatekeeper-sales に HTTP 受け口は無い (`src/*.ts` に `fetch` ハンドラも webhook も無い)。Sales OS に入る経路は (1) 管理 UI、(2) エージェントの `SALES` バインディング、の 2 つだけ (計画書 §3)。
- Cloudflare OS 側にはメールで本人としてチャットを駆動する `ExternalMessageGateway.submitExternalMessage({ callerEmail, ... })` がある (計画書 §1) が、Sales OS へは「エージェントが `SALES.capture` を呼び、承認を通る」経路になり、日報の一括流し込みには重い。
- レビュアーがどの URL に送ったかは FB からは分からない。**まず確認すること: 送信先 URL と送信元 (Zapier / メール / 自作スクリプト)**。

### Phase 1 で作るなら (今は実装しない)

`POST /gatekeeper/sales/ingest` を gatekeeper-sales Worker の `fetch` に追加する案:

- 認証: `SALES_INGEST_TOKEN` (wrangler secret) を `Authorization: Bearer` で照合。Cloudflare Access が入るならそちら。
- 本人特定: body の `submitterEmail` を `external_identities` / `users.email` に引き当てる。未登録なら 403。
- 受付は `SalesService.receive()` (RECEIVED で保存、`content_hash` で重複排除) → `202 { sourceId }` を即返し、処理は `ctx.waitUntil(processSource)` か DO alarm で非同期に。失敗は `retryCapture` で再実行できる (既存)。
- 制限: 本文 100,000 文字 (既存)、1 リクエスト 1 件、レート制限、body は全部信頼しない (プロンプトの SOURCE ブロック規則は既存)。
- 複数件を 1 body で送る場合は項目 D の `splitCaptureText` をサーバ側でも使い、件数を返す。
- 通知 (「アラート」) は逆方向 (Sales OS → Slack 等) で Phase 1 の Slack 通知エンジンの話 (計画書 §2 "Slack")。Webhook 受け口とは別件として扱う。

### レビュアーへの回答

現状 Sales OS には Webhook の受け口は無い。入れる方法は画面の入力欄に貼るか、チャットでエージェントに「これを Sales OS に取り込んで」と渡すかの 2 つ。Webhook は Phase 1 で検討 (上記案)。送信先に使った URL を教えてほしい。

---

## F. カレンダー連携 / 音声 (回答のみ)

- カレンダー: 未連携。Phase 1 で (a) Sales Core 独自の Google OAuth + watch/webhook、(b) Scheduler + Google gatekeeper のポーリング、のどちらかを選ぶ (計画書 §2 "Calendar")。キャンセルを失注扱いにしないルールは実装・テスト済み (`fixtures/005-calendar-cancel.ts`)。
- 音声: Phase 2。項目 E の回答を参照。

---

## 着手順の提案

1. A → E → B (半日以内、1 コミットずつ。B は tsc が網羅チェックしてくれる)
2. C 必須部分 (小)。任意部分はモデル切替の予定が出てから。
3. D-1, D-2 (分割 + 逐次取り込み UI)。D-3 は様子を見てから。
4. G はレビュアーに送信先 URL を確認してから Phase 1 の設計に回す。

各コミットの末尾:
```
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PbkF1LCacCpy6Uhux6p4QC
```
(実行するモデルが Sonnet なら `Claude Sonnet 5` に読み替える。)
