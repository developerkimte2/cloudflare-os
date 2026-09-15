# Sales OS — 販売管理 最小形 実装仕様書 (2026-09-15)

対象: `plans/sales-os-backlog.md` の ★ 11 項目。**実行順は C1 → D1 → D2 → F1 → F2 → F3 → L1 → A1 → A5 → A2 → E1**。
**1 項目 = 1 コミット、サブエージェントなし。** 設計判断は本書で確定。本書に無い判断が必要になったら実装を止めて聞く。
方針 (ユーザー指示 9/15): 一旦入れて後から改修する。よって本書は「動く最小形」を優先し、拡張余地は §9 に列挙するにとどめる。

## 0. 前提と共通ルール

| 項目 | 状態 |
|---|---|
| ブランチ / 最新 | `local-patches` / `b3c086c`。fork には `7400939` まで push 済み (22 コミット未 push) |
| テスト | sales-core 275 件、gatekeeper-sales 48 件 (worker 8 + node 15 + app 25) 全部緑 |
| migration | `0001`〜`0006` 適用済み。本書で足すのは `0007`〜`0012` (各項目に記載)。**追記のみ、既存は触らない** |
| dev-server | `start-local.ps1` で起動中。sales-core / app / src は wrangler が watch |
| 判定 AI | `.dev.vars` = ollama / qwen3-coder:30b |
| 実機確認 | claude-in-chrome は Sales OS の iframe を撮れない。**画面確認はユーザーに依頼** |

### 共通ルール (P0 指示書と同じ)

- 検証コマンド (リポジトリ直下、`npm_execpath` を pnpm.mjs に設定して実行):
  ```
  pnpm --filter @gadgets/sales-core exec tsc --noEmit -p tsconfig.json
  pnpm --filter @gadgets/sales-core exec tsc --noEmit -p tsconfig.test.json
  pnpm --filter @gadgets/sales-core test:run
  pnpm --filter @gadgets/gatekeeper-sales exec tsc --noEmit -p tsconfig.app.json
  pnpm --filter @gadgets/gatekeeper-sales exec tsc --noEmit -p tsconfig.json
  pnpm --filter @gadgets/gatekeeper-sales test:run
  pnpm --filter @gadgets/gatekeeper-sales build
  grep -c "node:sqlite" packages/gatekeeper-sales/src/generated/app.txt   # 0
  ```
- 新テーブル/列: `db/migrations.ts` に `{ id: "00NN_...", sql }` を追記 → `db/tables.ts` に `Table` 定義 (`col(snake, camel, codec?)`、codec は `"json"` / `"bool"`) → `db/repository.ts` に CRUD。
- 新 RPC は 3 か所: `src/sales-core-do.ts` (DO メソッド、`this.#service.x(this.#actor(caller), ...)`)、`src/management-types.ts` (`SalesManagementApi` + 型 re-export)、`src/sales.ts` (`SalesManagementApiImpl` の委譲 1 行)。手本は `getCustomer` (`e1799de`)。
- `src/types.d.ts` / `types.txt` (エージェント向け API) は **本書では触らない**。
- UI: `<form>` 禁止 (`type="button"` + onClick)、localStorage 禁止、ダウンロードリンク・`window.open` は sandbox (`allow-scripts allow-modals` のみ) で **動かない前提** (§F3 参照)。
- ラベルは `app/labels.ts` に集約。英語 enum を画面に出さない。
- 監査: 状態を変える操作は必ず `audit(ctx, { actorType: "USER", actorId, action, entityType, entityId, before, after })`。新しい `action` は `AUDIT_ACTION_LABEL` に日本語を足す。
- 権限: 断りが無ければ **閲覧 = 案件の可視性に従う (SALES は自分の案件のみ)、マスタ編集 = MANAGER/ADMIN、設定・入出力 = ADMIN**。
- 金額は `number` (円は整数、REAL 列)。表示は既存 `formatAmountJa` 相当 (桁区切り + 円)。
- `git add` は対象ファイルを明示。コミット末尾: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。push はユーザーの指示があるまでしない。

---

## 1. C1 受注/失注の確定記録 【中】 — migration 0007

### 背景
WON/LOST は `lifecycleState` の値でしかなく、受注額・受注日・失注理由が無い。KPI の「今月受注」は `updated_at` で数えていて、受注後に編集すると月が動く。

### データ (0007_opportunity_close_details)
```sql
ALTER TABLE opportunities ADD COLUMN won_amount REAL;
ALTER TABLE opportunities ADD COLUMN closed_at TEXT;           -- 受注日/失注日 (YYYY-MM-DD)
ALTER TABLE opportunities ADD COLUMN lost_reason TEXT;         -- PRICE|COMPETITOR|TIMING|BUDGET|NO_RESPONSE|NO_NEED|OTHER
ALTER TABLE opportunities ADD COLUMN lost_reason_note TEXT;
ALTER TABLE opportunities ADD COLUMN competitor TEXT;
CREATE INDEX idx_opportunities_closed_at ON opportunities(closed_at);
```
`domain/types.ts`: `Opportunity` に `wonAmount?`, `closedAt?`, `lostReason?: LostReason`, `lostReasonNote?`, `competitor?`。`export type LostReason = ...` (上の 7 値)。`tables.ts` に列を追加。

### DTO
- `OpportunityPatch` に同 5 項目 (`null` でクリア)。
- `OpportunitySummary` / `OpportunityDetail` に同 5 項目を載せる (`summarize()` で透過)。

### サービス (`updateOpportunity`)
- `lifecycleState` が **WON に遷移**するとき: `wonAmount` 未指定なら `expectedAmount` を採用、それも無ければ `TypeError("受注額を入力してください")`。`closedAt` 未指定なら今日 (ユーザー timezone の日付)。
- **LOST に遷移**: `lostReason` 必須 (無ければ `TypeError("失注理由を選んでください")`)。`closedAt` 同上。
- **OPEN / ON_HOLD に戻す**: `closedAt`, `wonAmount`, `lostReason*`, `competitor` を **null にクリア** (履歴は監査ログに残る)。
- 監査: 遷移時は `OPPORTUNITY_CLOSED` (before/after に上記項目を含む)、戻すときは `OPPORTUNITY_REOPENED`。通常編集は既存 `OPPORTUNITY_EDITED`。
- **確認 (review) 経由の WON/LOST** (`resolveReview` の STATE 系): 現状どおり遷移させ、`wonAmount = expectedAmount`、`closedAt = 今日`、LOST は `lostReason = "OTHER"`、`lostReasonNote = "(AI 判定の確認から確定。理由は未入力)"`。案件画面で後から直せる。**AI が受注額を書くことはしない** (原則維持)。

### KPI (`repository.managerKpiAggregates`)
- `wonThisMonth` / `lostThisMonth` の条件を `closed_at >= ? AND closed_at < ?` に変更 (F1 で期間化する前提の準備)。`updated_at` は使わない。
- `ManagerKpis` に `wonAmountThisMonth: number` を追加 (`SUM(won_amount)`)。チーム画面の KPI タイル「今月受注」を「n 件 / 1,234,000円」の 2 行表示に。

### UI (`OpportunityDetailPage`)
- 既存の WON/LOST 変更時の確認ダイアログ (`confirmText`) を **入力ダイアログ**に置き換える:
  - WON: 受注額 (初期値 = 見込金額)、受注日 (初期値 = 今日、`<input type="date">`)、競合 (任意)。
  - LOST: 失注日、失注理由 (select、`LOST_REASON_LABEL`)、理由メモ、競合 (任意)。
  - 「確定」ボタン (`type="button"`) で `updateOpportunity` を 1 回で呼ぶ (状態 + 上記項目 + version)。
- 終了済み案件のヘッダに「受注 2026-09-15 / 1,234,000円」または「失注 2026-09-15 / 価格」を表示。編集はフィールド行で可。
- `labels.ts`: `LOST_REASON_LABEL` (価格/競合/時期/予算/無反応/ニーズ消失/その他)、`AUDIT_ACTION_LABEL` に `OPPORTUNITY_CLOSED = "案件を確定"`, `OPPORTUNITY_REOPENED = "案件を再開"`。

### テスト (`pipeline.test.ts` または新規 `close.test.ts`)
- WON 遷移で wonAmount 未指定 → expectedAmount が入る / どちらも無い → throw。
- LOST 遷移で lostReason 無し → throw。
- OPEN に戻すと 5 項目がクリアされ、監査に `OPPORTUNITY_REOPENED`。
- KPI: closedAt が今月の WON だけ数える (先月 closedAt を今月 updated しても数えない)。

コミット件名案: `Sales OS: record won amount, close date and lost reason when a deal closes`

---

## 2. D1 品目 (商材) マスタ 【中】 — migration 0008

### データ (0008_products)
```sql
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  code TEXT,                       -- 任意。UNIQUE は付けない (空を許す)。重複はサービス側で拒否
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'SERVICE' CHECK (category IN ('GOODS','SERVICE','MAINTENANCE','SUBSCRIPTION','OTHER')),
  unit_price REAL,
  cost REAL,
  tax_category TEXT NOT NULL DEFAULT 'STANDARD' CHECK (tax_category IN ('STANDARD','REDUCED','EXEMPT')),
  unit_label TEXT,                 -- 「式」「台」「月」など
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_products_active ON products(active, sort_order);
```
`domain/types.ts`: `Product` インターフェース、`ProductCategory`, `TaxCategory`。`tables.ts` に `products`。

### DTO / サービス
- `ProductInput { code?, name, category, unitPrice?, cost?, taxCategory, unitLabel?, description?, active?, sortOrder? }`。
- `listProducts(actor, { includeInactive? })` (全ロール)、`createProduct(actor, input)` / `updateProduct(actor, id, patch)` (MANAGER/ADMIN、`AuthorizationError`)。削除はしない (**非アクティブ化のみ**、明細から参照されるため)。
- `code` が空でない場合、他の品目と重複したら `TypeError("品目コードが重複しています")`。
- 監査: `PRODUCT_CREATED`, `PRODUCT_UPDATED`。

### RPC
`listProducts`, `createProduct`, `updateProduct` を 3 か所に。

### UI
- `SettingsPage` に節「商材」: 一覧 (コード/名称/区分/単価/税区分/有効)、行クリックで編集、末尾に「＋ 商材を追加」。MANAGER/ADMIN 以外は読み取り表示。
- `labels.ts`: `PRODUCT_CATEGORY_LABEL` (物販/サービス/保守/サブスク/その他)、`TAX_CATEGORY_LABEL` (標準 10%/軽減 8%/非課税)。

### テスト
- 作成 → 一覧、非アクティブは `includeInactive` 無しで出ない、SALES の作成は `AuthorizationError`、コード重複 throw。

コミット件名案: `Sales OS: product master (code, price, tax category) managed from settings`

---

## 3. D2 案件明細 【中】 — migration 0009

### データ (0009_opportunity_line_items)
```sql
CREATE TABLE opportunity_line_items (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id),
  product_id TEXT REFERENCES products(id),   -- NULL = 自由入力行
  name TEXT NOT NULL,                         -- 品目名のスナップショット (マスタ改名の影響を受けない)
  quantity REAL NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  discount_amount REAL NOT NULL DEFAULT 0,    -- 行の値引額 (税抜)
  tax_category TEXT NOT NULL DEFAULT 'STANDARD',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_line_items_opportunity ON opportunity_line_items(opportunity_id, sort_order);
```
`OpportunityLineItem` 型。小計・税は **保存しない** (コードで計算: `subtotal = quantity*unitPrice - discountAmount`、税率は `config.taxRates` §4 参照、端数は切り捨て)。

### DTO / サービス
- `LineItemInput { productId?, name, quantity, unitPrice, discountAmount?, taxCategory?, sortOrder? }`。
- `setLineItems(actor, opportunityId, items: LineItemInput[], version: number): OpportunityDetail` — **全置換** (差分更新はしない。行 id は毎回振り直してよい)。案件の可視性チェック + 楽観ロック (version)。
- **見込金額の同期**: 明細が 1 行以上あるとき `expectedAmount = 明細合計 (税抜)` に上書きし、`OpportunityPatch.expectedAmount` の直接編集は `TypeError("明細がある案件の見込金額は明細から計算されます")`。明細を 0 行にしたら `expectedAmount` はそのまま残す (手入力に戻る)。
- **AI 抽出の金額との関係** (`rules/business.ts` の金額レビュー): 明細がある案件では金額変更レビューを **作らない** (`decision` は `AUTO_APPLIED` ではなく `REVIEW_REQUIRED` のまま「明細があるため反映しない」の reason で記録だけ)。
- `OpportunityDetail` に `lineItems: OpportunityLineItem[]` と `totals: { subtotal, tax, total }`。
- 監査: `LINE_ITEMS_UPDATED` (before/after に行配列)。

### RPC
`setLineItems` を 3 か所に。

### UI (`OpportunityDetailPage`)
- 節「明細」: 表 (品目 (select: マスタ or 自由入力) / 数量 / 単価 / 値引 / 小計)、行の追加・削除・上下、末尾に 税抜合計 / 消費税 / 税込合計。「保存」で `setLineItems`。
- 品目を選ぶと名称・単価・税区分をマスタから複写 (その後の手修正可)。
- 明細がある案件では見込金額フィールドを読み取り専用にし「明細合計」と注記。

### テスト
- 2 行保存 → totals 計算 (10% と 8% 混在、端数切り捨て) と expectedAmount 同期。
- expectedAmount 直接編集 throw。0 行に戻すと編集可。
- 他ユーザーの案件 → `NotFoundError`。version 不一致 → 既存の競合エラー。

コミット件名案: `Sales OS: line items on a deal; expected amount follows the line total`

---

## 4. F1 期間指定と会計年度 【小〜中】 — migration なし (settings)

### 設定
`SalesConfig` に `fiscalYearStartMonth: number` (1〜12、既定 4)、`taxRates: { STANDARD: 0.10, REDUCED: 0.08, EXEMPT: 0 }`、`taxRounding: "FLOOR" | "ROUND" | "CEIL"` (既定 FLOOR)。`SettingsPage` の「その他のしきい値」節に会計年度開始月、税率を追加。

### DTO
```ts
export interface Period { from: string; to: string }   // YYYY-MM-DD (from 含む, to 含まない)
export type PeriodPreset = "THIS_MONTH" | "LAST_MONTH" | "THIS_QUARTER" | "THIS_FY" | "LAST_FY";
```
`rules/period.ts` (新規、純関数): `resolvePeriod(preset | Period, now, timezone, fiscalYearStartMonth): Period`。四半期・年度は会計年度基準。

### サービス
- `getManagerSummary(actor, period?: PeriodPreset | Period)` — 省略時 THIS_MONTH。`ManagerSummary` に `period: Period` と `periodLabel` (例「2026年9月」「2026年度 Q2」) を載せる。
- `managerKpiAggregates(from, to, now)` に変更: WON/LOST 件数・受注額は `closed_at` の範囲。open 件数・見込合計・期限超過は期間に依存しない (現在値)。
- `managerPerUserStats` も受注件数・受注額を期間で (列追加: `wonCount`, `wonAmount`)。

### UI (`ManagerPage`)
- 上部に期間セレクタ (今月 / 先月 / 今四半期 / 今年度 / 前年度 / 任意 (from, to の `<input type="date">`))。選択は URL やストレージに保存せず、ページ状態のみ。
- KPI タイルの見出しに `periodLabel`。担当者別の表に「受注 件/額」列。

### テスト
- `resolvePeriod` の境界 (年度開始 4 月で 3 月は前年度 Q4、1 月始まりの場合)。KPI が `closed_at` の範囲で切れること。

コミット件名案: `Sales OS: period selector (month / quarter / fiscal year) for team KPIs`

---

## 5. F2 集計軸 【中】 — migration なし

### DTO
```ts
export type ReportGroupBy = "OWNER" | "ACCOUNT" | "PRODUCT" | "PHASE" | "LOST_REASON" | "MONTH";
export interface ReportRow {
  key: string; label: string;
  openCount: number; expectedAmount: number;       // 現在値 (期間非依存)
  wonCount: number; wonAmount: number;             // 期間内 closed_at
  lostCount: number; lostAmount: number;           // lostAmount = 失注時の expectedAmount
  winRate?: number;                                // won / (won + lost)、分母 0 は undefined
}
export interface SalesReport { period: Period; periodLabel: string; groupBy: ReportGroupBy; rows: ReportRow[]; total: ReportRow }
```

### サービス / リポジトリ
- `getSalesReport(actor, { period?, groupBy }): SalesReport`。SALES は自分の案件のみ (可視性)、MANAGER/ADMIN は全体。
- `repository.reportAggregates(groupBy, from, to, visibleOwnerId?)`: `GROUP BY` を軸ごとに SQL で。PRODUCT は `opportunity_line_items` を JOIN (案件の受注額を明細比率で按分せず、**行の小計をそのまま**集計する。注記に明記)。MONTH は `substr(closed_at,1,7)`。
- ラベル解決 (ユーザー名・顧客名・品目名) はサービス側で。

### RPC
`getSalesReport` を 3 か所に。

### UI
- 新ページ `ReportPage.tsx`、ナビに「集計」(MANAGER/ADMIN は全体、SALES は自分)。期間セレクタ (F1 の部品を共通化 `components/PeriodPicker.tsx`) + 軸タブ。表 + 合計行。金額は桁区切り、受注率は %。
- 行クリック: OWNER → チーム画面の担当者、ACCOUNT → 顧客ページ、他は案件一覧をその条件で開く (絞り込みパラメータは既存 `OpportunityFilter` の範囲で)。

### テスト
- 軸ごとに 1 ケース (owner 2 人、product 2 品目、lost_reason 2 種、month 2 か月)。SALES が他人の行を見ないこと。

コミット件名案: `Sales OS: 集計 page — won/lost/pipeline by rep, customer, product, phase, reason, month`

---

## 6. F3 CSV 出力 【小〜中】 — migration なし

### 制約と方式
gatekeeper UI の iframe は `sandbox="allow-scripts allow-modals"`。`<a download>`、`window.open`、blob/data URL は **動かない前提**で設計する。
- **主経路: クリップボードにコピー**。`exportCsv` の結果 (文字列) を `<textarea readonly>` に出し、「コピー」ボタンで `navigator.clipboard.writeText` → 失敗時は `document.execCommand("copy")` (textarea を select して)。ユーザーは Excel/スプレッドシートに貼る。
- **副経路 (要確認・後回し可)**: worker (`src/worker.ts`) に `GET /export/:token` を足し、DO に 10 分有効のワンタイムトークンを保存、`<a href target="_blank">` で開く。`CustomerInfo.tsx` の `target="_blank"` リンクが sandbox 内で開けるかを **先にユーザーに確認**してから着手。

### DTO / サービス
- `ExportKind = "OPPORTUNITIES" | "LINE_ITEMS" | "ACCOUNTS" | "PERSONS" | "NEXT_ACTIONS" | "ACTIVITIES" | "REPORT"`。
- `exportCsv(actor, { kind, filter?: OpportunityFilter, period?, groupBy? }): { filename: string; csv: string; rows: number }`。
- CSV 仕様: UTF-8 **BOM 付き**、CRLF、RFC 4180 の引用、先頭行は日本語見出し (labels に合わせる)、日時はユーザー timezone の `YYYY-MM-DD HH:mm`、金額は数値のまま (桁区切りなし)、enum は日本語ラベル。上限 5,000 行 (超えたら `TypeError("5,000 行を超えています。期間や条件で絞ってください")`)。
- 可視性は各 list 系と同じ。`rules/csv.ts` (新規、純関数) に `toCsv(headers, rows)`。

### RPC
`exportCsv` を 3 か所に。

### UI
- 案件一覧・顧客一覧 (A5)・集計ページに「CSV」ボタン → モーダル (textarea + コピー + 行数)。
- 設定ページに「一括出力」節 (全 kind を順に)。

### テスト
- `toCsv` の引用 (カンマ・改行・ダブルクォート)、BOM、CRLF。OPPORTUNITIES が SALES の可視性で絞られる。5,001 行で throw。

コミット件名案: `Sales OS: CSV export (copy-to-clipboard) for deals, line items, customers, contacts, actions, reports`

---

## 7. L1 エクスポート / インポート 【中】 — migration なし

### 目的
バックアップ・復元・他システムからの移行。ADMIN のみ。

### DTO / サービス
- `exportAll(actor): { version: "sales-os.export.v1"; exportedAt; tenantNote?; data: { users, accounts, persons, products, opportunities, lineItems, nextActions, commitments, activities, sources (rawText 含む) } }`。AI 判定・スナップショット・監査・通知ログは **含めない** (再計算可能 or 機微)。
- `importAll(actor, payload, { mode: "DRY_RUN" | "MERGE" | "REPLACE" }): ImportResult { counts per table (created / updated / skipped), errors: string[] }`。
  - `MERGE`: id 一致は更新、無ければ作成。ユーザーは email で照合 (id は作り直す)。
  - `REPLACE`: 全テーブルを削除してから投入 (**確認ダイアログ 2 段**、監査 `DATA_REPLACED`)。
  - `DRY_RUN`: 検証と件数のみ。
  - 外部キー整合 (account が無い opportunity 等) はエラーにして全体を中止 (トランザクション)。
- CSV 取込 (顧客・担当者・品目) は `importCsv(actor, { kind, csv, mode })`。列は日本語見出しで F3 の出力と同じ (**F3 で出したものをそのまま戻せる**)。

### RPC
`exportAll`, `importAll`, `importCsv` を 3 か所に。

### UI (`SettingsPage` 「データ」節、ADMIN のみ)
- エクスポート: JSON を textarea に表示 + コピー (F3 と同じ部品)。
- インポート: textarea に貼り付け → 「検証」(DRY_RUN) → 結果表示 → 「取り込む」。`<input type="file">` はサンドボックスで動くか未確認のため **貼り付けを主**にする。

### テスト
- export → 空 DB に REPLACE import → 同じ export が得られる (往復)。MERGE で更新/作成の件数。参照切れで中止。SALES は `AuthorizationError`。

コミット件名案: `Sales OS: JSON export/import (dry-run, merge, replace) and CSV import for masters`

---

## 8. A1 顧客マスタ項目の拡充 【中】 — migration 0010

### データ (0010_customer_account_master_fields)
```sql
ALTER TABLE customer_accounts ADD COLUMN code TEXT;
ALTER TABLE customer_accounts ADD COLUMN corporate_number TEXT;
ALTER TABLE customer_accounts ADD COLUMN industry TEXT;
ALTER TABLE customer_accounts ADD COLUMN size_label TEXT;
ALTER TABLE customer_accounts ADD COLUMN region TEXT;
ALTER TABLE customer_accounts ADD COLUMN postal_code TEXT;
ALTER TABLE customer_accounts ADD COLUMN fax TEXT;
ALTER TABLE customer_accounts ADD COLUMN fiscal_year_end_month INTEGER;
ALTER TABLE customer_accounts ADD COLUMN closing_day INTEGER;         -- 締め日 (1..31, 99=末日)
ALTER TABLE customer_accounts ADD COLUMN payment_terms TEXT;          -- 「翌月末振込」など自由記述
ALTER TABLE customer_accounts ADD COLUMN credit_limit REAL;
ALTER TABLE customer_accounts ADD COLUMN started_at TEXT;             -- 取引開始日
ALTER TABLE customer_accounts ADD COLUMN primary_owner_user_id TEXT;  -- 顧客レベルの主担当
ALTER TABLE customer_accounts ADD COLUMN rank TEXT;                   -- A|B|C
ALTER TABLE customer_accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE';  -- LEAD|ACTIVE|DORMANT|STOPPED
ALTER TABLE customer_accounts ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE customer_accounts ADD COLUMN notes TEXT;                  -- 固定メモ (A8 相当。AI 回答にも渡す)
CREATE INDEX idx_customer_accounts_code ON customer_accounts(code);
```
`CustomerAccount` に同項目 (`tags: string[]`)。`AccountPatch` に同項目 (`null` でクリア)。`code` 重複はサービスで拒否。

### サービス
- `updateAccount` を拡張。`primaryOwnerUserId` は存在するユーザーのみ。
- 検索 (`askQuestion` の `answerContext`) の `顧客連絡先:` 行に FAX、`顧客メモ:` 行に `notes` を追加 (answer.v7)。
- 与信警告 (A9 の最小版): `OpportunitySummary` に `creditWarning?: string` — `creditLimit` があり、その顧客の OPEN 見込合計 + 期間内受注額が上限を超えるとき「与信限度 5,000,000円 を超過 (見込 6,200,000円)」。案件画面のヘッダに表示するだけ (ブロックしない)。

### UI (`CustomerInfo.tsx` の会社編集フォーム、`CustomerPage`)
- 項目をグループ化: 基本 (コード/法人番号/業種/規模/地域/ランク/ステータス/タグ)、連絡先 (郵便番号/住所/電話/FAX/Web)、取引条件 (決算月/締め日/支払条件/与信限度/取引開始日/主担当)、メモ。
- `labels.ts`: `ACCOUNT_STATUS_LABEL`, `ACCOUNT_RANK_LABEL`。

### テスト
- patch → getCustomer で全項目が往復。code 重複 throw。creditWarning の計算。

コミット件名案: `Sales OS: customer master fields (code, industry, terms, credit limit, rank, status, tags, notes)`

---

## 9. A5 顧客一覧ページ 【中】 — migration なし

### DTO / サービス
- `CustomerListFilter { query?, rank?, status?, industry?, primaryOwnerUserId?, dormantDays?, limit?, cursor? }`。
- `CustomerSummary { id, displayName, code, rank, status, industry, primaryOwnerName, openOpportunities, expectedAmountTotal, wonAmountThisFY, lastActivityAt, contactCount }`。
- `listCustomers(actor, filter): CustomerSummary[]` — SALES は自分の案件がある顧客のみ (既存 `canSeeAccount` と同じ規則)。集計は `GROUP BY account_id` の SQL 2 本 (案件、活動) を JS で結合。

### RPC
`listCustomers` を 3 か所に。

### UI
- 新ページ `CustomersPage.tsx`、ナビに「顧客」(「案件」の隣)。検索欄 (名前/コード/担当者名)、絞り込み (ランク/ステータス/業種/主担当/休眠 N 日)、列ヘッダで並び替え (クライアント側)。行クリックで既存 `CustomerPage`。
- 「＋ 顧客を追加」(名前だけで作成 → 顧客ページへ)。`createAccount(actor, { displayName, ...AccountPatch })` を追加 (RPC 3 か所)。resolutionStatus は `MANUAL`。
- CSV ボタン (F3 の ACCOUNTS)。

### テスト
- listCustomers の可視性 (SALES)、集計値、休眠フィルタ。createAccount の重複名は作成を許す (名寄せは既存の流れに任せる) が `warning` を返す。

コミット件名案: `Sales OS: 顧客 list page with rank/status/owner filters and manual customer creation`

---

## 10. A2 顧客の統合・改名 【中】 — migration なし

### サービス
- `renameAccount(actor, id, displayName)` (MANAGER/ADMIN): `normalizedName` 再計算、監査 `CUSTOMER_RENAMED`。
- `mergeAccounts(actor, sourceId, targetId)` (MANAGER/ADMIN): source の opportunities / persons / activities / sources(target_opportunity 経由は不要) の `account_id` を target に付け替え、source は `status = "STOPPED"`, `displayName` に「(統合済み → target名)」を付けて残す (削除しない)。target の空欄項目は source の値で補完。監査 `CUSTOMER_MERGED` (既存ラベルあり) に `{ sourceId, targetId, moved: { opportunities, persons, activities } }`。
- 取り消し: 監査の `moved` 一覧から `unmergeAccounts(actor, auditId)` で戻す (source の status/名前を戻し、id リストで account_id を戻す)。統合後に target 側で編集された行はそのまま (完全復元は保証しない旨を UI に)。
- 重複候補: `findDuplicateAccounts(actor): { a, b, reason }[]` — normalizedName 一致 / primaryDomain 一致 / code 一致。

### RPC
`renameAccount`, `mergeAccounts`, `unmergeAccounts`, `findDuplicateAccounts` を 3 か所に。

### UI
- `CustomerPage` ヘッダに「名前を変更」「別の顧客に統合」(検索 → 選択 → 確認ダイアログに移動件数)。
- `SettingsPage` 「データ」節に「重複候補」一覧 → 「統合」。
- 監査ログ表示 (既存) の `CUSTOMER_MERGED` 行に「取り消す」。

### テスト
- merge で案件・担当者が移る、source が残る、unmerge で戻る。SALES は `AuthorizationError`。重複候補の 3 条件。

コミット件名案: `Sales OS: merge / rename customers with one-tap undo, duplicate candidates in settings`

---

## 11. E1 受注伝票 【中】 — migration 0011

### データ (0011_orders)
```sql
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,                 -- 'YYYYMM-0001' (月内連番)
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id),
  account_id TEXT NOT NULL REFERENCES customer_accounts(id),
  ordered_at TEXT NOT NULL,                      -- = opportunities.closed_at
  amount REAL NOT NULL,                          -- 税抜 (= won_amount)
  tax_amount REAL NOT NULL DEFAULT 0,
  line_items_json TEXT NOT NULL DEFAULT '[]',    -- 受注時点の明細スナップショット
  delivery_due TEXT,                             -- 納期
  payment_terms TEXT,                            -- 顧客マスタから複写
  status TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED','CANCELLED')),
  note TEXT,
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_orders_ordered_at ON orders(ordered_at);
CREATE INDEX idx_orders_opportunity ON orders(opportunity_id);
```

### サービス
- **WON 確定時 (C1 の遷移) に自動生成**: 明細があれば snapshot + 税計算、無ければ `amount = wonAmount`、明細なし。`order_no` は `YYYYMM-` + その月の件数+1 (DO 内は逐次なので競合しない)。既に CONFIRMED の受注がある案件を再度 WON にしたら新規は作らず既存を返す。
- OPEN に戻したら受注は `CANCELLED` (削除しない)。監査 `ORDER_CREATED` / `ORDER_CANCELLED` / `ORDER_UPDATED`。
- `listOrders(actor, { period?, accountId?, status? })`, `getOrder`, `updateOrder(actor, id, { deliveryDue?, paymentTerms?, note? })` (MANAGER/ADMIN。金額・明細は **受注後に直接編集しない**。直すときは案件を OPEN に戻して再確定)。
- KPI の受注額は **orders ではなく opportunities.won_amount を正** とする (E1 未導入でも KPI が成立するため)。両者は生成時に一致する。

### RPC
`listOrders`, `getOrder`, `updateOrder` を 3 か所に。

### UI
- 集計ページ (F2) に「受注一覧」タブ: 受注番号/受注日/顧客/案件/金額/納期/状態。行クリックで詳細 (明細スナップショット、納期・支払条件・メモの編集)。CSV (F3 に `ORDERS` を追加)。
- 案件画面のヘッダに受注番号リンク。

### テスト
- WON で受注が 1 件でき、番号が月内連番。OPEN に戻すと CANCELLED。再 WON で既存を返す。明細スナップショットがマスタ改名の影響を受けない。

コミット件名案: `Sales OS: order record (number, date, line snapshot) created when a deal is won`

---

## 12. 横断事項

- **`OpportunityFilter` の拡張** (F2 の行クリック・A5 から使う): `closedFrom?`, `closedTo?`, `lostReason?`, `productId?` を追加 (C1/D2 の後、必要になった時点で)。
- **`labels.ts` の追加まとめ**: `LOST_REASON_LABEL`, `PRODUCT_CATEGORY_LABEL`, `TAX_CATEGORY_LABEL`, `ACCOUNT_STATUS_LABEL`, `ACCOUNT_RANK_LABEL`, `ORDER_STATUS_LABEL`, `REPORT_GROUP_LABEL`, `EXPORT_KIND_LABEL`、`AUDIT_ACTION_LABEL` に `OPPORTUNITY_CLOSED / OPPORTUNITY_REOPENED / PRODUCT_CREATED / PRODUCT_UPDATED / LINE_ITEMS_UPDATED / CUSTOMER_RENAMED / DATA_REPLACED / DATA_IMPORTED / ORDER_CREATED / ORDER_CANCELLED / ORDER_UPDATED`。
- **ナビ** (最終形): 今日 / 案件 / 顧客 / 集計 / 確認 / チーム / 設定。
- **共通部品**: `PeriodPicker.tsx` (F1)、`CsvModal.tsx` (F3、textarea + コピー)、`MoneyInput.tsx` (桁区切り表示・数値保持)。
- **AI 抽出との境界** (再掲): AI は受注額・受注日・明細・受注伝票を **書かない**。書くのは人だけ。抽出 (`extract.v4`) は変更しない。

## 13. 未決事項 (実装中に出たら止めて聞く)

1. 税込/税抜のどちらを「見込金額」「受注額」の正とするか → 本書は **税抜** で統一。画面には税込も併記。
2. `order_no` の書式 (`YYYYMM-0001`) と、年度またぎでの連番リセット → 本書は月ごとリセット。
3. 統合 (A2) の取り消しをいつまで許すか → 本書は無期限 (監査ログがある限り)。
4. CSV の副経路 (worker 経由ダウンロード) を作るか → `target="_blank"` の動作確認結果次第。
5. 受注後の請求・入金 (E4/E5) は本書の対象外。orders の CSV を会計側に渡す運用でまず回す。

## 14. 進め方

1. C1 から順に、**1 項目ごとにテスト緑 → コミット → ユーザーに画面確認を依頼** して次へ。
2. 各項目の着手前に本書の該当節を読み直し、既存コードとの差 (列名・関数名) があれば本書側を直してからコードを書く。
3. 全 11 項目が終わったら `plans/sales-os-backlog.md` の ★ を「済」に更新し、次の候補 (C2 確度、C3 金額履歴、F4 推移グラフ、G1/G2) を選ぶ。
