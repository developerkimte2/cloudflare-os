# 08 — A1 顧客マスタ項目の拡充 (migration 0010)

前提: 01〜07 がコミット済み。

## 目的
顧客に販売管理で必要な項目 (顧客コード、業種、取引条件、与信限度、ランク、ステータス、タグ、固定メモ) を持たせ、案件画面・顧客画面で編集できるようにする。検索 (AI 回答) にも FAX と固定メモを渡す。

## 先に読むファイル
1. `packages/sales-core/src/domain/types.ts` — `CustomerAccount`
2. `packages/sales-core/src/db/migrations.ts` (末尾), `db/tables.ts` — `customerAccounts`
3. `packages/sales-core/src/api/dto.ts` — `AccountPatch`, `OpportunitySummary`
4. `packages/sales-core/src/service/sales-service.ts` — `updateAccount`, `summarize`, `answerContext` (窓口・顧客連絡先を回答に渡している所)
5. `packages/sales-core/src/ai/skills.ts` — `AnswerOpportunity`, `buildAnswerRequest` の `顧客連絡先:` 行、`ANSWER_PROMPT_VERSION`
6. `packages/gatekeeper-sales/app/components/CustomerInfo.tsx` — 会社編集フォーム (`address/phone/websiteUrl`)
7. `packages/sales-core/__tests__/ai-skills.test.ts` — `buildAnswerRequest` のテスト

## 手順

### 1. ドメイン型 (`CustomerAccount` の `websiteUrl?: string;` の後)
```ts
  /** Sales-admin master fields (08). All optional; entered by hand. */
  code?: string;
  corporateNumber?: string;
  industry?: string;
  sizeLabel?: string;
  region?: string;
  postalCode?: string;
  fax?: string;
  fiscalYearEndMonth?: number;
  /** 締め日: 1..31, or 99 for 末日. */
  closingDay?: number;
  paymentTerms?: string;
  creditLimit?: number;
  startedAt?: string;
  primaryOwnerUserId?: string;
  rank?: AccountRank;
  status: AccountStatus;
  tags: string[];
  /** Hand-written standing notes (社風・注意点). Also handed to the 検索 answer prompt. */
  notes?: string;
```
```ts
export type AccountRank = "A" | "B" | "C";
export type AccountStatus = "LEAD" | "ACTIVE" | "DORMANT" | "STOPPED";
export const ACCOUNT_STATUSES: AccountStatus[] = ["LEAD", "ACTIVE", "DORMANT", "STOPPED"];
export const ACCOUNT_STATUS_LABEL_JA: Record<AccountStatus, string> = { LEAD: "見込客", ACTIVE: "取引中", DORMANT: "休眠", STOPPED: "取引停止" };
```
`status` と `tags` は必須にするので、**`CustomerAccount` を生成している全箇所** (`grep -rn "resolutionStatus:" packages/sales-core/src packages/sales-core/__tests__ | grep -v Person`) に `status: "ACTIVE", tags: []` を足す (ingest のプレースホルダ、テストの `makeAccount` は overrides の前に既定値として)。

### 2. migration (`0010_customer_account_master_fields`)
```sql
ALTER TABLE customer_accounts ADD COLUMN code TEXT;
ALTER TABLE customer_accounts ADD COLUMN corporate_number TEXT;
ALTER TABLE customer_accounts ADD COLUMN industry TEXT;
ALTER TABLE customer_accounts ADD COLUMN size_label TEXT;
ALTER TABLE customer_accounts ADD COLUMN region TEXT;
ALTER TABLE customer_accounts ADD COLUMN postal_code TEXT;
ALTER TABLE customer_accounts ADD COLUMN fax TEXT;
ALTER TABLE customer_accounts ADD COLUMN fiscal_year_end_month INTEGER;
ALTER TABLE customer_accounts ADD COLUMN closing_day INTEGER;
ALTER TABLE customer_accounts ADD COLUMN payment_terms TEXT;
ALTER TABLE customer_accounts ADD COLUMN credit_limit REAL;
ALTER TABLE customer_accounts ADD COLUMN started_at TEXT;
ALTER TABLE customer_accounts ADD COLUMN primary_owner_user_id TEXT;
ALTER TABLE customer_accounts ADD COLUMN rank TEXT;
ALTER TABLE customer_accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE customer_accounts ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE customer_accounts ADD COLUMN notes TEXT;
CREATE INDEX idx_customer_accounts_code ON customer_accounts(code);
```
`tables.ts` の `customerAccounts` に全列を追加 (`tags` は `"json"`)。

### 3. DTO
`AccountPatch` に同項目 (テキストは `string | null`、数値は `number | null`、`tags?: string[]`、`rank?: AccountRank | null`、`status?: AccountStatus`)。
`OpportunitySummary` に `creditWarning?: string;`。

### 4. サービス
- `updateAccount`: 各項目を `cleanText` / 数値検証 (`closingDay` は 1..31 か 99、`fiscalYearEndMonth` は 1..12、`creditLimit` は 0 以上) で反映。`code` は他の顧客と重複したら `TypeError("顧客コードが重複しています")` (`repo.findAccountByCode` を追加)。`primaryOwnerUserId` は `repo.getUser` で存在確認。`tags` は trim して空を除き重複排除。
- `summarize()`: `creditWarning` を計算 — `account.creditLimit` があるとき、`repo.openExpectedAmountForAccount(accountId)` (SQL: OPEN の expected_amount 合計) が上限を超えていれば `与信限度 ${limit}円 を超過 (進行中の見込合計 ${sum}円)`。**注意**: summarize は一覧で件数分呼ばれる。SQL 1 本追加で許容。
- `answerContext` / `buildAnswerRequest` (answer.v7): `AnswerOpportunity` に `accountFax?`, `accountNotes?` を追加。`顧客連絡先:` 行に FAX を足し、`顧客メモ: ${notes ?? "(なし)"}` 行を `顧客連絡先` の直後に追加。プロンプトの項目列に「顧客メモ」を足す。`ANSWER_PROMPT_VERSION = "answer.v7"` に上げ、テストの `answer.v6` を置換。

### 5. RPC
`updateAccount` の型が広がるだけ。追加メソッドなし。

### 6. ラベル
`ACCOUNT_STATUS_LABEL` (types の JA 表を re-export)、`ACCOUNT_RANK_LABEL = { A: "A", B: "B", C: "C" }`。

### 7. 画面 (`CustomerInfo.tsx` の会社編集フォーム)
グループ 4 つに分けて入力を追加 (すべて `Field` + 既存 `INPUT_CLASS`):
- 基本: 顧客コード / 法人番号 / 業種 / 規模 / 地域 / ランク (select) / ステータス (select) / タグ (カンマ区切り 1 欄 → 保存時に split)
- 連絡先: 郵便番号 / 住所 / 電話 / FAX / Web
- 取引条件: 決算月 (1〜12) / 締め日 (1〜31, 99=末日) / 支払条件 / 与信限度 / 取引開始日 (date) / 主担当 (select: `listUsers`)
- メモ: textarea
`dirty` 判定と patch 組み立てを既存 3 項目と同じ形で拡張。案件ヘッダに `creditWarning` があれば黄色い注記 (06 の CsvModal と同じ `border-kumo-line bg-kumo-tint`)。

06 の `exportCsv(ACCOUNTS)` の列にこれらを追加 (顧客コード, 業種, ランク, ステータス, タグ, 決算月, 締め日, 支払条件, 与信限度, 主担当)。07 の `importCsv(ACCOUNTS)` も同じ列を読む。

## テスト
- `pipeline.test.ts` か新規 `accounts.test.ts`: patch → `getCustomer` で往復、code 重複 throw、closingDay 40 throw、creditWarning (limit 100, open 150 → 文字列あり / open 50 → undefined)。
- `ai-skills.test.ts`: `accountFax` / `accountNotes` が dump に出る、`顧客メモ: (なし)`。

## 検証
共通コマンド。期待: sales-core +4 前後。

## コミット件名
`Sales OS: customer master fields (code, industry, terms, credit limit, rank, status, tags, notes)`

## 完了チェック
- [ ] 案件画面・顧客画面の「顧客情報」で新項目を保存できる (ユーザー確認)
- [ ] 検索で「〇〇の顧客メモは？」に固定メモが出る

## 止まって聞く
- `CustomerAccount` の必須項目化 (`status`, `tags`) で型エラーが 10 か所以上に広がる場合は、optional に緩めてよいか聞く (`summarize`/画面側で既定値を補う案)。
