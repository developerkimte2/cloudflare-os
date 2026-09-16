# 07 — L1 JSON エクスポート/インポート・CSV 取込 (migration なし)

前提: 01〜06 がコミット済み。

## 目的
バックアップ・復元・他システムからの移行。ADMIN のみ。JSON は「全部」、CSV はマスタ (顧客・担当者・品目) の取込。**06 の CSV 出力と同じ列で戻せる**。

## 先に読むファイル
1. `packages/sales-core/src/db/repository.ts` — 各テーブルの insert/update/list、`transaction`
2. `packages/sales-core/src/db/tables.ts` — テーブル一覧 (何を出すか)
3. `packages/sales-core/src/service/sales-service.ts` — `registerIdentity` (ユーザー作成の流れ)、`createPerson`, `createProduct`
4. `packages/sales-core/src/rules/csv.ts` (06)
5. `packages/gatekeeper-sales/app/pages/SettingsPage.tsx`, `app/components/CsvModal.tsx` (06)

## 手順

### 1. DTO (`api/dto.ts`)
```ts
export const EXPORT_FORMAT_VERSION = "sales-os.export.v1";
export interface ExportBundle {
  version: typeof EXPORT_FORMAT_VERSION;
  exportedAt: string;
  data: {
    users: User[]; accounts: CustomerAccount[]; persons: CustomerPerson[]; products: Product[];
    opportunities: Opportunity[]; lineItems: OpportunityLineItem[]; nextActions: NextAction[];
    commitments: Commitment[]; activities: Activity[]; sources: SourceDocument[];
  };
}
export type ImportMode = "DRY_RUN" | "MERGE" | "REPLACE";
export interface ImportResult {
  mode: ImportMode;
  counts: Record<keyof ExportBundle["data"], { created: number; updated: number; skipped: number }>;
  errors: string[];        // non-empty => nothing was written
}
export type CsvImportKind = "ACCOUNTS" | "PERSONS" | "PRODUCTS";
```
含めない: AI 判定・スナップショット・確認・監査・通知ログ・外部 ID (再計算可能 or 機微)。

### 2. リポジトリ — 一覧と全削除
- 無ければ足す: `listAllUsers()`, `listAllAccounts()`, `listAllPersons()`, `listAllOpportunities()`, `listAllLineItems()`, `listAllNextActions()`, `listAllCommitments()`, `listAllActivities()`, `listAllSources()` (全部 `T.x.select(this.db, "WHERE 1=1")` の薄い関数。既存に同等があれば使う)。
- `deleteAllData(): void` — REPLACE 用。外部キー順に `DELETE FROM` を並べる: `opportunity_line_items, next_actions, commitments, activities, ai_context_snapshots, ai_decisions, review_items, source_applications, source_documents, calendar_event_mirrors, notification_logs, opportunities, customer_persons, customer_accounts, products`。**users / external_identities / settings / audit_logs は消さない** (ログインが壊れる。監査は残す)。

### 3. サービス
```ts
  exportAll(actor: Actor): ExportBundle {
    this.requireAdmin(actor);
    return { version: EXPORT_FORMAT_VERSION, exportedAt: nowIso(this.ctx.clock), data: {
      users: this.repo.listAllUsers(), accounts: this.repo.listAllAccounts(), persons: this.repo.listAllPersons(),
      products: this.repo.listAllProducts(), opportunities: this.repo.listAllOpportunities(), lineItems: this.repo.listAllLineItems(),
      nextActions: this.repo.listAllNextActions(), commitments: this.repo.listAllCommitments(),
      activities: this.repo.listAllActivities(), sources: this.repo.listAllSources(),
    } };
  }

  importAll(actor: Actor, bundle: ExportBundle, mode: ImportMode): ImportResult {
    const user = this.requireAdmin(actor);
    if (bundle?.version !== EXPORT_FORMAT_VERSION) throw new TypeError(`対応していない形式です (${String(bundle?.version)})`);
    const errors = validateBundle(bundle);          // rules/import-validate.ts (純関数): 必須項目、参照整合 (account→opportunity→lineItem/activity/nextAction/commitment、person.accountId、opportunity.ownerUserId は users の id または email で解決可能)
    const counts = emptyCounts();
    if (errors.length > 0 || mode === "DRY_RUN") { /* DRY_RUN は counts を「作成予定/更新予定」として数えて返す */ return { mode, counts, errors }; }
    this.repo.transaction(() => {
      if (mode === "REPLACE") this.repo.deleteAllData();
      // users: email で照合。無ければ作成 (role/timezone はバンドルの値)。id はバンドル→実 id の対応表を作る
      // accounts/persons/products/opportunities/lineItems/nextActions/commitments/activities/sources: id 一致で update、無ければ insert
      // opportunities.ownerUserId / collaboratorUserIds / nextActions.assignedUserId は対応表で置換
      audit(this.ctx, { actorType: "ADMIN", actorId: user.id, action: mode === "REPLACE" ? "DATA_REPLACED" : "DATA_IMPORTED",
        entityType: "tenant", entityId: "tenant", after: counts });
    });
    return { mode, counts, errors: [] };
  }

  importCsv(actor: Actor, kind: CsvImportKind, csv: string, mode: "DRY_RUN" | "MERGE"): ImportResult {
    // rules/csv.ts に parseCsv(text): string[][] を追加 (toCsv の逆。BOM 除去、"" エスケープ、CRLF/LF)
    // 見出し行を 06 の日本語列名で照合。ACCOUNTS: 顧客名 必須 (顧客ID があれば更新、無ければ normalizedName 一致で更新、それも無ければ作成)
    // PERSONS: 顧客名 + 氏名 必須。顧客が無ければエラー行。PRODUCTS: 品目名 必須、品目コード一致で更新
    // 1 行でもエラーがあれば errors に「n 行目: …」を積み、何も書かない
  }

  private requireAdmin(actor: Actor): User {
    const user = this.requireUser(actor);
    if (user.role !== "ADMIN") throw new AuthorizationError("管理者のみ実行できます");
    return user;
  }
```
コメント部分は実装する。`validateBundle` と `parseCsv` は純関数として `rules/` に置き、単体テストを書く。

### 4. RPC (3 か所)
`exportAll(): Promise<ExportBundle>`, `importAll(bundle: ExportBundle, mode: ImportMode): Promise<ImportResult>`, `importCsv(kind: CsvImportKind, csv: string, mode: "DRY_RUN" | "MERGE"): Promise<ImportResult>`。型を追加。

### 5. ラベル
`AUDIT_ACTION_LABEL` に `DATA_IMPORTED: "データを取り込み"`, `DATA_REPLACED: "データを全置換"`。

### 6. 画面 (`SettingsPage` 「データ」節、ADMIN のみ表示)
- 「JSON を書き出す」→ `api.exportAll()` → `JSON.stringify(bundle, null, 2)` を `CsvModal` (タイトルだけ変える。ファイル名 `sales-os_export_YYYYMMDD.json`) で表示 + コピー。
- 「JSON を取り込む」: textarea に貼り付け → 「検証」(DRY_RUN、結果の件数とエラー一覧を表示) → 「取り込む (統合)」/「取り込む (全置換)」。全置換は `ConfirmInline` を **2 段** (`confirmText` に「既存の顧客・案件・活動をすべて削除して置き換えます。監査ログとユーザーは残ります。」)。
- 「CSV を取り込む」: 種類 (顧客/担当者/品目) select + textarea + 「検証」「取り込む」。
- `<input type="file">` は使わない (sandbox で未確認)。

## テスト (`packages/sales-core/__tests__/export-import.test.ts` 新規)
- 往復: seed (顧客 2, 担当者 2, 品目 1, 案件 2 + 明細, 次アクション 1) → `exportAll` → 別の `makeService` に ADMIN を作って `importAll(bundle, "REPLACE")` → `exportAll` の `data` (`exportedAt` を除く) が deep equal。
- MERGE: 同じバンドルを 2 回 → 2 回目は `updated` のみ増え、`created` 0。
- 参照切れ (opportunities に無い account_id) → `errors` 1 件、何も書かれない。
- SALES → `AuthorizationError`。
- `parseCsv`: `toCsv` の出力を `parseCsv` で戻すと同じ 2 次元配列。
- `importCsv(ACCOUNTS)`: 顧客名だけの 2 行 → created 2、再実行で updated 2。

## 検証
共通コマンド。期待: sales-core +6 前後、gatekeeper-sales 48。

## コミット件名
`Sales OS: JSON export/import (dry-run, merge, replace) and CSV import for masters`

## 完了チェック
- [ ] 設定 → データ で JSON 書き出し・検証・取り込みが動く (ユーザー確認)
- [ ] 全置換後もログインしたままで、監査ログに DATA_REPLACED が残る

## 止まって聞く
- `deleteAllData` の順序で外部キー制約に引っかかる (テーブル一覧と REFERENCES を見ても解決しない)。
- `registerIdentity` を経由しないユーザー作成が既存の不変条件を壊しそう。
