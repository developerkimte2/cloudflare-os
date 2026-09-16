# 10 — A2 顧客の統合・改名・重複候補 (migration なし)

前提: 01〜09 がコミット済み。

## 目的
重複した顧客を 1 つにまとめる (案件・担当者・活動を付け替え、元は「統合済み」として残す)。名前の変更。統合の取り消し。重複候補の一覧。MANAGER/ADMIN のみ。

## 先に読むファイル
1. `packages/sales-core/src/service/sales-service.ts` — `resolveReview` の `CUSTOMER_MERGED` を出している箇所 (確認からの統合。**既にある処理を流用する**)、`updateAccount`, `applyAccountPatch` (09)
2. `packages/sales-core/src/db/repository.ts` — `updateAccount`, `updatePerson`, `updateOpportunity`, activities の更新関数、`getAuditLog` 系 (`grep -n "audit" repository.ts`)
3. `packages/sales-core/src/domain/util.ts` — `normalizeName`
4. `packages/gatekeeper-sales/app/pages/CustomerPage.tsx` — ヘッダ
5. `packages/gatekeeper-sales/app/pages/OpportunityDetailPage.tsx` — 監査ログの表示部分 (`audit` 一覧)
6. `packages/gatekeeper-sales/app/components/ConfirmInline.tsx`

## 手順

### 1. DTO
```ts
export interface MergeAccountsResult { targetId: string; sourceId: string; moved: { opportunities: number; persons: number; activities: number; sources: number }; auditId: string }
export interface DuplicateAccountCandidate { a: CustomerSummary; b: CustomerSummary; reason: "NAME" | "DOMAIN" | "CODE" }
```

### 2. リポジトリ
- `reassignAccount(fromAccountId: string, toAccountId: string): { opportunities: string[]; persons: string[]; activities: string[]; sources: string[] }` — 各テーブルで `UPDATE … SET account_id = ? WHERE account_id = ?` を実行し、**更新前に id を SELECT して返す** (取り消しに使う)。対象: `opportunities`, `customer_persons`, `activities`, `source_documents` (account_id 列があれば。無ければ除く)。
- `reassignAccountByIds(toAccountId: string, ids: { opportunities: string[]; persons: string[]; activities: string[]; sources: string[] }): void` — 取り消し用 (`WHERE id IN (…)`)。
- `getAuditEntry(id: string): AuditLog | undefined` (無ければ追加)。

### 3. サービス
```ts
  renameAccount(actor: Actor, accountId: string, displayName: string): CustomerAccount {
    const user = this.requireAccountEditor(actor);   // MANAGER/ADMIN
    const account = this.repo.getAccount(accountId); if (!account) throw new NotFoundError("顧客");
    const name = displayName.trim(); if (!name) throw new TypeError("顧客名を入力してください");
    const next = { ...account, displayName: name, normalizedName: normalizeName(name), updatedAt: nowIso(this.ctx.clock) };
    this.repo.transaction(() => { this.repo.updateAccount(next);
      audit(this.ctx, { actorType: "USER", actorId: user.id, action: "CUSTOMER_RENAMED", entityType: "customer_account", entityId: accountId, before: { displayName: account.displayName }, after: { displayName: name } }); });
    return next;
  }

  mergeAccounts(actor: Actor, sourceId: string, targetId: string): MergeAccountsResult {
    const user = this.requireAccountEditor(actor);
    if (sourceId === targetId) throw new TypeError("同じ顧客は統合できません");
    const source = this.repo.getAccount(sourceId), target = this.repo.getAccount(targetId);
    if (!source || !target) throw new NotFoundError("顧客");
    if (source.displayName.includes("(統合済み")) throw new TypeError("既に統合済みの顧客です");
    return this.repo.transaction(() => {
      const moved = this.repo.reassignAccount(sourceId, targetId);
      // target の空欄を source で補完 (08 の項目 + address/phone/websiteUrl/primaryDomain)
      const filled: CustomerAccount = { ...target, updatedAt: nowIso(this.ctx.clock) };
      for (const key of FILLABLE_ACCOUNT_KEYS) if (filled[key] === undefined && source[key] !== undefined) (filled as any)[key] = source[key];
      filled.tags = [...new Set([...(target.tags ?? []), ...(source.tags ?? [])])];
      if (target.resolutionStatus === "UNRESOLVED" && source.resolutionStatus !== "UNRESOLVED") filled.resolutionStatus = source.resolutionStatus;
      this.repo.updateAccount(filled);
      this.repo.updateAccount({ ...source, status: "STOPPED", displayName: `${source.displayName} (統合済み → ${target.displayName})`, updatedAt: filled.updatedAt });
      const entry = audit(this.ctx, { actorType: "USER", actorId: user.id, action: "CUSTOMER_MERGED", entityType: "customer_account", entityId: targetId,
        before: { source: source, target: target }, after: { sourceId, targetId, moved } });
      return { targetId, sourceId, moved: { opportunities: moved.opportunities.length, persons: moved.persons.length, activities: moved.activities.length, sources: moved.sources.length }, auditId: entry.id };
    });
  }

  unmergeAccounts(actor: Actor, auditId: string): void {
    const user = this.requireAccountEditor(actor);
    const entry = this.repo.getAuditEntry(auditId);
    if (!entry || entry.action !== "CUSTOMER_MERGED") throw new NotFoundError("統合の記録");
    const after = entry.afterJson as { sourceId: string; targetId: string; moved: {...} };
    const before = entry.beforeJson as { source: CustomerAccount; target: CustomerAccount };
    this.repo.transaction(() => {
      this.repo.reassignAccountByIds(after.sourceId, after.moved);
      this.repo.updateAccount({ ...before.source, updatedAt: nowIso(this.ctx.clock) });   // 名前・status を戻す
      // target は戻さない (統合後の編集を壊さない)。補完した項目もそのまま。
      audit(this.ctx, { actorType: "USER", actorId: user.id, action: "CUSTOMER_UNMERGED", entityType: "customer_account", entityId: after.targetId, before: after, sourceIds: [] });
    });
  }

  findDuplicateAccounts(actor: Actor): DuplicateAccountCandidate[] {
    this.requireAccountEditor(actor);
    // 全顧客 (統合済み・STOPPED を除く) を normalizedName / primaryDomain / code でグループ化し、2 件以上のグループから (a, b) の組を作る。
    // 上限 200 組。CustomerSummary は listCustomers の map 関数を再利用 (private に切り出す)。
  }
```
`FILLABLE_ACCOUNT_KEYS` は `CustomerAccount` の optional なテキスト/数値項目名の配列 (`address`, `phone`, `fax`, `websiteUrl`, `primaryDomain`, `code`, `corporateNumber`, `industry`, `sizeLabel`, `region`, `postalCode`, `fiscalYearEndMonth`, `closingDay`, `paymentTerms`, `creditLimit`, `startedAt`, `primaryOwnerUserId`, `rank`, `notes`)。`code` は重複を作らないよう、target に無く source にあるときだけ。
`requireAccountEditor` = `requireProductEditor` と同じ (MANAGER/ADMIN)。名前を `requireManager` に統一してもよい (02 の分も改名して構わない)。

既存の `resolveReview` の統合処理 (`CUSTOMER_MERGED`) があれば、**`mergeAccounts` の中身に置き換えて 1 本にする** (二重実装を避ける)。その際、既存テストの期待値 (source が残るか消えるか) を確認し、**消していた場合は「残す」に変わる**ので該当テストを更新する。

### 4. RPC
`renameAccount(accountId, displayName)`, `mergeAccounts(sourceId, targetId)`, `unmergeAccounts(auditId)`, `findDuplicateAccounts()` を 3 か所に。型を追加。

### 5. ラベル
`AUDIT_ACTION_LABEL` に `CUSTOMER_RENAMED: "顧客名を変更"`, `CUSTOMER_UNMERGED: "顧客の統合を取り消し"`。

### 6. 画面
- `CustomerPage` ヘッダ (MANAGER/ADMIN のみ):
  - 「名前を変更」→ インライン入力 + 保存。
  - 「別の顧客に統合」→ 検索欄 (`listCustomers({ query })`) → 候補から選択 → `ConfirmInline` (`confirmText`: 「この顧客の案件・担当者・活動を「{target}」に移し、この顧客は「統合済み」として残します。」) → `mergeAccounts(thisId, targetId)` → target の顧客ページへ。
- `SettingsPage` 「データ」節に「重複候補」: `findDuplicateAccounts()` の一覧 (a / b / 理由) と「b を a に統合」「a を b に統合」ボタン (各 `ConfirmInline`)。
- 監査ログ表示 (案件詳細と顧客ページにある `audit` 一覧) で `action === "CUSTOMER_MERGED"` の行に「取り消す」ボタン (MANAGER/ADMIN) → `unmergeAccounts(entry.id)`。

## テスト (`packages/sales-core/__tests__/merge.test.ts` 新規)
- merge: source の案件 2・担当者 1・活動 1 が target に移る。source は残り `status === "STOPPED"`、名前に「(統合済み」。target の空欄 (phone) が source で埋まる。監査 `CUSTOMER_MERGED` の `afterJson.moved` に id 配列。
- unmerge: 案件・担当者が source に戻り、source の名前・status が戻る。target で統合後に変えた phone はそのまま。
- 二重統合・同一 id → throw。SALES → `AuthorizationError`。
- findDuplicateAccounts: 「株式会社ABC」と「ABC株式会社」(normalizeName 一致)、同 primaryDomain、同 code の 3 組。

## 検証
共通コマンド。期待: sales-core +5 前後。

## コミット件名
`Sales OS: merge / rename customers with one-tap undo, duplicate candidates in settings`

## 完了チェック
- [ ] 顧客ページから統合 → 元の顧客が「統合済み」で残り、案件が移っている (ユーザー確認)
- [ ] 監査ログの「取り消す」で戻る

## 止まって聞く
- 既存の確認 (review) 経由の統合処理が `mergeAccounts` と噛み合わない (source を削除している等) 場合、どちらの挙動にするか。
- `source_documents` に account_id 列が無い (その場合は対象から外してよい。聞かなくてよい)。
