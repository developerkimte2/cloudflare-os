# AI Sales Operations OS — Phase 0 実装計画

設計書: `AI_Sales_Operations_OS_Design_v1.0.md` (以下「設計書」)。本書は設計書 §58 の手順 1〜9 に対応する。

## 1. Cloudflare OS リポジトリ構造の確認結果 (§58-1)

| 事実 | 出典 |
|---|---|
| 外部連携は全て **gatekeeper** = 独立した Worker (`packages/gatekeeper-*`、`wrangler.jsonc` があれば deployable) | AGENTS.md:23-24 |
| `scripts/run-dev-server.ts` が `packages/gatekeeper-*/wrangler.jsonc` を自動発見し、dev-router / workshop-backend への service binding を生成する。**登録のためのコード変更は不要** | run-dev-server.ts:85-102, 560-570 |
| `autoProvisionsAccount` な gatekeeper は OAuth 無しにユーザーごとのアカウントを作り、`AccountDescription.singleton` でエージェント環境に ambient binding として注入、`providesUi` で `/gatekeepers/<id>` に管理 UI を持てる。実例: gatekeeper-context, gatekeeper-scheduler | AGENTS.md:26, scheduler.ts |
| エージェントは gatekeeper を **`describeBinding` + `executeCode`** でしか呼べない。`types.d.ts` の JSDoc が LLM 向け唯一のドキュメント | agent.ts:2843, 3091 |
| 書き込みは `ApprovalQueue.submitAction` → `applyAction` の承認モデル。`actionKind` + `autoApprovable` でユーザーが自動承認を opt-in できる | gatekeeper.ts:985-1290 |
| gadget も gatekeeper 管理 UI もネットワーク遮断 (`globalOutbound: null`, CSP `connect-src 'none'`)。外部到達は gatekeeper Worker 内のみ | overseer.ts:4930, GadgetUI.tsx |
| **D1 (`d1_databases`) はリリースマニフェスト生成器が未対応** (`HANDLED_CONFIG_KEYS`)。リポジトリ内で D1 を使う Worker は無い。全 gatekeeper は DO SQLite (`ctx.storage.sql` / `kv`) | scripts/release/manifest-lib.ts:244 |
| R2 / KV は対応済み (`r2_buckets`, `kv_namespaces`)。ローカルは miniflare が `.wrangler/state` に自動作成 | 同上 |
| Slack gatekeeper は **読み取り専用** (投稿 API 無し、user token) | gatekeeper-slack/README.md |
| Google gatekeeper: Calendar は read-write scope、**push/watch 無し**、hook 無し。別 Worker がユーザーの Google 接続を借りる手段は無い (capability stub のみ) | gatekeeper-google/src/google.ts:2290 |
| gatekeeper-scheduler で DO alarm ベースの every / calendarAt / runAt が使える (登録後ユーザーが Connections で有効化) | gatekeeper-scheduler/README.md |
| `createAccount()` は **ユーザー識別情報を受け取らない**。管理 UI には `isAdmin` のみ渡る | gatekeeper.ts:513-523, AppUiContext |
| 外部 Worker → Workshop 方向には `ExternalMessageGateway.submitExternalMessage({callerEmail,...})` がある (メールで本人として chat を駆動) | workshop-backend/src/external-message-gateway.ts |
| この Windows checkout は `core.symlinks=false` のため `src/types.txt` シンボリックリンクが壊れており、既存 gatekeeper はローカルでは LLM に `"types.d.ts"` という 10 バイト文字列を返している | `git config core.symlinks` |

## 2. 設計書と Cloudflare OS v2 の差分 (§58-2) — **設計差分**

設計書の目的を維持しつつ、現行 Cloudflare OS で実装不可能／不適切な点は以下の代替を採る (設計書 §58 末尾の許容範囲)。

| # | 設計書 | 現状 | 採用する代替 |
|---|---|---|---|
| D1 | Operational DB = Cloudflare D1 (§8.1, §8.2) | D1 はリリース基盤が未対応 | **Sales Context Core = 1 テナント 1 つの SQLite-backed Durable Object** (`SalesCoreDurableObject`, `ctx.storage.sql`)。スキーマ/マイグレーションは D1 互換の素の SQLite DDL、リポジトリ層は `SqlExecutor` インタフェース経由で D1 アダプタに差し替え可能にする。20 名規模では DO SQLite (10GB) で十分であり、設計書 §0-18「単純・監査可能」に沿う |
| R2 | 原文は R2 (§32) | Phase 0 は自由文のみ | Phase 0 は `source_documents.raw_text` に保存。音声/ファイル (Phase 2) で `r2_buckets` を追加 |
| Workflows | Cloudflare Workflows (§26) | 未使用・マニフェスト未対応 | 取込パイプラインは DO 内の逐次処理 + `processing_status` で再開可能にする。Human Review は `review_items` テーブル (WF-04 の `waitForEvent` 相当) |
| 認証 | Cloudflare Access / SSO (§SEC-01) | gatekeeper のアカウントは無名 | 本人性は「Cloudflare OS のユーザー ↔ 自動プロビジョニングされた account」の対応で担保 (Workshop が authority)。Sales Core 側の User 行との紐付けは **初回 UI オープン時の自己申告 (氏名・メール)** + `isAdmin` で ADMIN。本番では Access のメールを `external_identities` に結び直す |
| Slack | Slack 通知 (§20) | Slack gatekeeper は read-only | Phase 1 で Sales Core Worker が Slack Web API (`chat.postMessage`, bot token) を直接呼ぶ通知エンジンを持つ。設計書の「Slack は出口であって DB ではない」に整合 |
| Calendar | `events.watch` + webhook (§17.3) | Google gatekeeper に watch 無し、接続を借りられない | Phase 1 は (a) Sales Core Worker が独自 Google OAuth (calendar.events.readonly) + watch/webhook を持つ (設計書どおり)、または (b) Scheduler + Google gatekeeper によるポーリングを gadget から流し込む。Phase 0 では決めない |
| LLM | Claude via AI Gateway (§8.1) | Sales Core は独立 Worker | `LlmProvider` インタフェースに `anthropic` (AI Gateway 経由可) / `workers-ai` / `ollama` の 3 実装。ローカル PoC は既存の Workers AI BYOK または Ollama で動かし、本番は Anthropic |
| 書込承認 | AI 判断に承認 (§30) | Cloudflare OS 側にも承認キューがある | **二重承認を避ける**: エージェント経由の `capture` は Cloudflare OS の action として提出 (`actionKind: sales.capture`, `autoApprovable: true`、ユーザーが自動承認を opt-in 可)。営業判断の承認 (顧客曖昧・WON/LOST 等) は Sales Core の Review Queue が担う。管理 UI からの入力は Workshop の承認キューを通らない (Context Library の管理 UI と同じ) |
| types.txt | — | symlink 不可 | `types.txt` を実ファイルとし、`types.d.ts` と同一内容であることをテストで担保 |

## 3. core 改造と外部実装の分離 (§58-3)

Cloudflare OS 本体 (workshop-backend / workshop-shared / frontend) は **変更しない**。

```
packages/sales-core/        ← 営業ドメイン (Cloudflare OS 非依存の純 TS ライブラリ)
  src/domain/               Domain types (§11)
  src/db/                   SQL migrations, SqlExecutor, repository
  src/ai/                   Zod structured-output schema (§14.2), prompt skills (§28), LlmProvider
  src/rules/                Deterministic rules (§27), confidence 閾値 (§16), entity resolution (§13)
  src/pipeline/             Source ingest (§15), context recompute (WF-03), undo
  src/api/                  UI / エージェント向け DTO と Service (API contract §24 相当)
  fixtures/                 Evaluation fixtures (§35)
  __tests__/                node:sqlite による単体テスト、FakeLlm によるパイプラインテスト

packages/gatekeeper-sales/  ← Cloudflare OS への Adapter (Worker)
  src/sales.ts              GatekeeperVendor / SalesAccount / SalesGatekeeper / SalesSessionImpl
  src/sales-core-do.ts      SalesCoreDurableObject (テナント単位、SQLite、sales-core を駆動)
  src/types.d.ts (+.txt)    エージェント向け SalesSession API
  app/                      管理 UI (React SPA): /today, /capture, /review, /opportunities
```

Sales Core への到達経路は 2 つだけ: (1) エージェントの ambient binding `SALES` (session, 承認キュー経由)、(2) 管理 UI の account-scoped API。どちらも `SalesCoreDurableObject` の RPC に集約する。

## 4. Phase 0 スコープ (§37, §38)

実装する:
- 自由文 capture → Claude 構造化抽出 (Zod 検証 + 1 回修復リトライ) → 顧客候補 (内部 Provider) → Opportunity 解決 → Activity / Commitment / NextAction / Context Snapshot → Review Queue → AuditLog → Today UI。
- Deduplication (`content_hash`)、AIDecision (evidence / confidence / model / prompt version)、Undo (`revertSource`)。
- Rules: WON/LOST は Review 必須、曖昧日付は断定しない、金額種別の区別、Calendar キャンセル ≠ 失注 (テーブルのみ)、顧客/自社待ちの区別。
- 権限: SALES = 自分の担当/共同担当、MANAGER = 全体閲覧、ADMIN = 全体 + 設定。
- Evaluation fixtures 10 本 (§35) と FakeLlm による回帰テスト。

実装しない (§37 Phase 0「まだ実装しない」): Gmail/Calendar 自動連携、Slack 通知、音声、Manager Digest、高度ダッシュボード。

### Acceptance Criteria の対応

| AC | 実装箇所 |
|---|---|
| AC-001 自由文→Activity | `pipeline/ingest.ts` |
| AC-002 Schema validation | `ai/schema.ts` (Zod) |
| AC-003 顧客曖昧→確定しない | `rules/entity-resolution.ts` → `review_items(CUSTOMER_AMBIGUOUS)` + UNRESOLVED account |
| AC-004 根拠 Source へ戻れる | `ai_decisions.input_source_ids`, `activities.source_id`, UI の Evidence 表示 |
| AC-005 NextAction 生成 | `pipeline/apply.ts` |
| AC-006 Today に NextAction | `app/TodayPage.tsx`, `SalesSession.getToday()` |
| AC-007 Audit | `audit_logs` + UI |
| AC-008 Undo/Review | `pipeline/undo.ts`, `review_items` の resolve |
| AC-009 重複 Source | `source_documents.content_hash` UNIQUE |
| AC-010 フォーム入力なし | capture は text のみ。必須項目ゼロ |

## 5. エージェント向け API 提案 (`SalesSession`)

```ts
interface SalesSession {
  whoAmI(): Promise<SalesUser | null>;                       // 未登録なら null (UI で登録を促す)
  capture(text: string, options?: CaptureOptions): Promise<CaptureReceipt>;   // action (sales.capture)
  getCapture(sourceId: string): Promise<CaptureResult>;      // 処理結果・生成物・Review
  getToday(): Promise<TodayView>;
  listOpportunities(filter?: OpportunityFilter): Promise<OpportunitySummary[]>;
  getOpportunity(id: string): Promise<OpportunityDetail>;    // context, next actions, commitments, timeline, evidence
  listNextActions(filter?: NextActionFilter): Promise<NextAction[]>;
  completeNextAction(id: string): Promise<void>;             // action (sales.next-action)
  listReviews(): Promise<ReviewItem[]>;
  resolveReview(id: string, resolution: ReviewResolution): Promise<void>;   // action (sales.review)
  recomputeContext(opportunityId: string): Promise<AIContextSnapshot>;      // action (sales.recompute)
  revertSource(sourceId: string): Promise<void>;             // action (sales.revert) = AC-008
}
```

## 6. 作業順序 (§49)

1. Domain types → 2. DB schema → 3. Migration → 4. Repository → 5. API contract (DTO) → 6. Source ingest → 7. AI schema → 8. AI extraction → 9. Rules → 10. Audit → 11. Review Queue → 12. Today UI。

13 以降 (Calendar, Slack, Voice, Gmail, Manager) は Phase 1〜4。

## 7. 未解決リスク

- ローカルの LLM 品質: Workers AI (gpt-oss-120b / qwen3-30b) で structured output の JSON 精度が Claude より低い可能性。修復リトライと fixtures で計測する。
- 本人性の自己申告は PoC 限定。本番前に Access メール連携に置き換える。
- Cloudflare OS upstream 更新への追従は pin 運用 (設計書 §44)。gatekeeper-sales は kernel を触らないため衝突面は小さい。
