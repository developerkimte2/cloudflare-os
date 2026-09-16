# 09 — A5 顧客一覧ページ・手動の顧客作成 (migration なし)

前提: 01〜08 がコミット済み。

## 目的
顧客を一覧で探せる新ページ「顧客」。ランク/ステータス/業種/主担当/休眠日数で絞り、案件数・見込合計・年度受注額・最終活動を列に。名前だけで顧客を手動作成できる。

## 先に読むファイル
1. `packages/sales-core/src/db/repository.ts` — `listOpportunitiesVisibleTo`, `managerPerUserStats` (GROUP BY → Map 結合の手本), `findAccountByCode` (08)
2. `packages/sales-core/src/service/sales-service.ts` — `canSeeAccount`, `getCustomer`, `resolveReview` の「新規顧客として登録」処理 (`CUSTOMER_CONFIRMED_NEW` を出している所: 顧客を MANUAL で作る手本)
3. `packages/gatekeeper-sales/app/pages/OpportunitiesPage.tsx` — 検索欄・絞り込み・表・行クリック・CSV ボタン (06)
4. `packages/gatekeeper-sales/app/pages/CustomerPage.tsx`
5. `packages/gatekeeper-sales/app/App.tsx` — `Route`, ナビ、`openCustomer`

## 手順

### 1. DTO
```ts
export interface CustomerListFilter {
  query?: string;                 // displayName / code / primary owner name (部分一致)
  rank?: AccountRank;
  status?: AccountStatus;
  industry?: string;
  primaryOwnerUserId?: string;
  /** Only customers with no activity for at least this many days (undefined = all). */
  dormantDays?: number;
  limit?: number;                 // default 500
}
export interface CustomerSummary {
  id: string; displayName: string; code?: string; rank?: AccountRank; status: AccountStatus; industry?: string;
  primaryOwnerName?: string; resolutionStatus: ResolutionStatus;
  openOpportunities: number; expectedAmountTotal: number; wonAmountThisFY: number;
  contactCount: number; lastActivityAt?: string; updatedAt: string;
}
export interface CreateAccountInput extends AccountPatch { displayName: string }
```

### 2. リポジトリ
```ts
  /** Per-account aggregates for the 顧客 list, one GROUP BY per metric, merged in JS by the service. */
  accountListStats(fyFrom: string, fyTo: string): Map<string, { openOpportunities: number; expectedAmountTotal: number; wonAmountThisFY: number; contactCount: number; lastActivityAt?: string }>
```
SQL 4 本: OPEN 件数+見込合計 (`GROUP BY account_id`)、WON 受注額 (`closed_at` 範囲)、担当者数 (`customer_persons GROUP BY account_id`)、最終活動 (`MAX(last_meaningful_activity_at) FROM opportunities GROUP BY account_id`)。
`listAccountsVisibleTo(user: User): CustomerAccount[]` — SALES は `EXISTS (SELECT 1 FROM opportunities o WHERE o.account_id = a.id AND (o.owner_user_id = ? OR o.collaborator_user_ids LIKE ?))` (collaborator の判定は `listOpportunitiesVisibleTo` と同じ書き方に合わせる)、他は全件。

### 3. サービス
```ts
  listCustomers(actor: Actor, filter: CustomerListFilter = {}): CustomerSummary[] {
    const user = this.requireUser(actor);
    const now = nowIso(this.ctx.clock);
    const fy = resolvePeriod("THIS_FY", now, this.config.defaultTimezone, this.config.fiscalYearStartMonth);
    const stats = this.repo.accountListStats(fy.from, fy.to);
    const dormantBefore = filter.dormantDays ? addDays(now, -filter.dormantDays) : undefined;
    const q = filter.query?.trim().toLowerCase();
    return this.repo.listAccountsVisibleTo(user)
      .map(a => { const s = stats.get(a.id); const owner = a.primaryOwnerUserId ? this.repo.getUser(a.primaryOwnerUserId) : undefined; return { …CustomerSummary… }; })
      .filter(c => (!filter.rank || c.rank === filter.rank) && (!filter.status || c.status === filter.status)
        && (!filter.industry || c.industry === filter.industry) && (!filter.primaryOwnerUserId || /* account.primaryOwnerUserId */)
        && (!dormantBefore || !c.lastActivityAt || c.lastActivityAt < dormantBefore)
        && (!q || [c.displayName, c.code, c.primaryOwnerName].some(v => v?.toLowerCase().includes(q))))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, "ja"))
      .slice(0, filter.limit ?? 500);
  }

  createAccount(actor: Actor, input: CreateAccountInput): CustomerAccount {
    const user = this.requireUser(actor);
    const displayName = input.displayName.trim();
    if (!displayName) throw new TypeError("顧客名を入力してください");
    const now = nowIso(this.ctx.clock);
    const account: CustomerAccount = { id: newId(), displayName, normalizedName: normalizeName(displayName),
      resolutionStatus: "MANUAL", status: "ACTIVE", tags: [], createdAt: now, updatedAt: now };
    this.repo.transaction(() => {
      this.repo.insertAccount(account);
      audit(this.ctx, { actorType: "USER", actorId: user.id, action: "CUSTOMER_CREATED", entityType: "customer_account", entityId: account.id, after: account });
    });
    // Reuse updateAccount for the optional fields so validation lives in one place.
    const { displayName: _n, ...patch } = input;
    return Object.keys(patch).length > 0 ? this.updateAccountAsCreator(user, account.id, patch) : account;
  }
```
`updateAccountAsCreator`: `updateAccount` は `canSeeAccount` (SALES は案件がある顧客のみ) で弾くため、作成直後の SALES ユーザーが自分で作った顧客を編集できない。**作成直後だけ可視性チェックを飛ばす private 版** を作る (本体を `private applyAccountPatch(user, account, patch)` に切り出し、`updateAccount` と `createAccount` の両方から呼ぶ)。
同名顧客が既にある場合は **作成を許す** が、戻り値とは別に画面側で `listCustomers({ query })` の結果を先に見せる (下記 5)。

### 4. RPC
`listCustomers(filter?: CustomerListFilter): Promise<CustomerSummary[]>`, `createAccount(input: CreateAccountInput): Promise<CustomerAccount>`。型を追加。

### 5. 画面 — `app/pages/CustomersPage.tsx` 新規
- 検索欄 (顧客名・コード・主担当)、絞り込み (ランク / ステータス / 業種 (自由入力) / 主担当 (select) / 休眠 (30/90/180 日))、CSV ボタン (`ACCOUNTS`)。
- 表: 顧客名 / コード / ランク / ステータス / 業種 / 主担当 / 進行中 / 見込合計 / 今年度受注 / 担当者数 / 最終活動。列ヘッダクリックでクライアント側ソート (▲▼)。行クリック → `onOpenCustomer(id)`。
- 「＋ 顧客を追加」: 顧客名 1 欄のインライン入力 → 入力中に `listCustomers({ query })` で **同名候補を下に表示** (誤登録防止) → 「作成」`type="button"` → `api.createAccount({ displayName })` → 顧客ページへ。
- `App.tsx`: `Route` に `{ kind: "customers" }`、`ROUTE_LABEL.customers = "顧客"`、ナビの「案件」の次に `{ route: { kind: "customers" }, label: "顧客", icon: Buildings }` (無ければ `UsersThree`)。戻る先の fallback (`fallsBackToOpportunities`) に `customer` ルートから `customers` へ戻る分岐を追加。
- `labels.ts`: `CUSTOMER_SORT`… は不要。`AUDIT_ACTION_LABEL` に `CUSTOMER_CREATED: "顧客を登録"`。

## テスト (`packages/sales-core/__tests__/customers.test.ts` 新規)
- SALES は自分の案件がある顧客だけ、MANAGER は全件。
- stats: OPEN 2 件 (見込 100+200)、今年度 WON 300、前年度 WON は含まない、担当者数 2。
- フィルタ: rank, status, dormantDays (lastActivity 100 日前 → 90 で出る、180 で出ない)、query が code に当たる。
- createAccount: 空名 throw、作成後に `getCustomer` で読める、SALES が作った顧客を自分で `updateAccount` できないのは仕様 (案件が無いので不可視) — テストで明示。

## 検証
共通コマンド。期待: sales-core +5 前後。

## コミット件名
`Sales OS: 顧客 list page with rank/status/owner filters and manual customer creation`

## 完了チェック
- [ ] ナビ「顧客」から一覧 → 行クリックで顧客ページ (ユーザー確認)
- [ ] 「顧客を追加」で同名候補が出る

## 止まって聞く
- `listOpportunitiesVisibleTo` の collaborator 判定が SQL で再現しにくい (JSON 配列の LIKE)。その場合は「SALES は JS 側で `listOpportunitiesVisibleTo` から account_id を集めて絞る」方式に変えてよい。
