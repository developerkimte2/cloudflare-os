# 11 — E1 受注伝票 (migration 0011)

前提: 01〜10 がコミット済み。

## 目的
案件が WON になった時点で受注伝票 (受注番号・受注日・金額・明細スナップショット・納期・支払条件) を自動作成し、一覧・詳細・CSV で扱えるようにする。請求・入金は対象外 (受注 CSV を会計側に渡す運用)。

## 先に読むファイル
1. `packages/sales-core/src/service/sales-service.ts` — `updateOpportunity` + `applyCloseRules` (01)、`setOpportunityField` (確認経由の WON)、`setLineItems` (03)
2. `packages/sales-core/src/rules/money.ts` (03)
3. `packages/sales-core/src/db/migrations.ts` (末尾), `db/tables.ts` — `opportunityLineItems`
4. `packages/gatekeeper-sales/app/pages/ReportPage.tsx` (05) — タブの作り
5. `packages/gatekeeper-sales/app/pages/OpportunityDetailPage.tsx` — ヘッダの受注/失注表示 (01)
6. 06 の `exportCsv` の switch

## 手順

### 1. ドメイン型
```ts
export type OrderStatus = "CONFIRMED" | "CANCELLED";
export interface OrderLineSnapshot { name: string; productId?: string; quantity: number; unitPrice: number; discountAmount: number; taxCategory: TaxCategory; subtotal: number }
export interface Order {
  id: string;
  orderNo: string;              // "YYYYMM-0001", per-month sequence
  opportunityId: string;
  accountId: string;
  orderedAt: string;            // YYYY-MM-DD (= opportunity.closedAt)
  amount: number;               // tax-exclusive (= wonAmount)
  taxAmount: number;
  lineItems: OrderLineSnapshot[];
  deliveryDue?: string;
  paymentTerms?: string;
  status: OrderStatus;
  note?: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}
```

### 2. migration (`0011_orders`)
```sql
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id),
  account_id TEXT NOT NULL REFERENCES customer_accounts(id),
  ordered_at TEXT NOT NULL,
  amount REAL NOT NULL,
  tax_amount REAL NOT NULL DEFAULT 0,
  line_items_json TEXT NOT NULL DEFAULT '[]',
  delivery_due TEXT,
  payment_terms TEXT,
  status TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED','CANCELLED')),
  note TEXT,
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_orders_ordered_at ON orders(ordered_at);
CREATE INDEX idx_orders_opportunity ON orders(opportunity_id);
```
`tables.ts`: `orders` (`line_items_json` ↔ `lineItems` は `"json"`)。

### 3. リポジトリ
`getOrder(id)`, `getConfirmedOrderForOpportunity(opportunityId)`, `listOrders({ from?, to?, accountId?, status?, ownerUserId? })` (ownerUserId は `JOIN opportunities` で SALES の可視性)、`insertOrder`, `updateOrder`, `nextOrderSequence(yyyymm: string): number` (`SELECT COUNT(*) FROM orders WHERE order_no LIKE 'YYYYMM-%'` + 1)。DO 内は逐次実行なので競合しない。

### 4. サービス
- 受注作成を 1 つの private に集約:
```ts
  /** Called whenever a deal becomes WON (form or review). Idempotent: one CONFIRMED order per deal. */
  private ensureOrderForWon(user: User, o: Opportunity, now: string): Order {
    const existing = this.repo.getConfirmedOrderForOpportunity(o.id);
    if (existing) return existing;
    const items = this.repo.listLineItems(o.id);
    const totals = lineTotals(items, this.config);
    const account = this.repo.getAccount(o.accountId);
    const orderedAt = o.closedAt ?? localDate(now, this.config.defaultTimezone);
    const yyyymm = orderedAt.slice(0, 7).replace("-", "");
    const order: Order = {
      id: newId(), orderNo: `${yyyymm}-${String(this.repo.nextOrderSequence(yyyymm)).padStart(4, "0")}`,
      opportunityId: o.id, accountId: o.accountId, orderedAt,
      amount: items.length > 0 ? totals.subtotal : (o.wonAmount ?? 0),
      taxAmount: items.length > 0 ? totals.tax : 0,
      lineItems: items.map(i => ({ name: i.name, productId: i.productId, quantity: i.quantity, unitPrice: i.unitPrice, discountAmount: i.discountAmount, taxCategory: i.taxCategory, subtotal: lineSubtotal(i) })),
      paymentTerms: account?.paymentTerms, status: "CONFIRMED", createdByUserId: user.id, createdAt: now, updatedAt: now,
    };
    this.repo.insertOrder(order);
    audit(this.ctx, { actorType: "USER", actorId: user.id, action: "ORDER_CREATED", entityType: "order", entityId: order.id, after: order });
    return order;
  }
  private cancelOrderForReopened(user: User, opportunityId: string, now: string): void {
    const order = this.repo.getConfirmedOrderForOpportunity(opportunityId);
    if (!order) return;
    const next = { ...order, status: "CANCELLED" as const, updatedAt: now };
    this.repo.updateOrder(next);
    audit(this.ctx, { actorType: "USER", actorId: user.id, action: "ORDER_CANCELLED", entityType: "order", entityId: order.id, before: order, after: next });
  }
```
- `updateOpportunity` のトランザクション内、`repo.updateOpportunity` 成功後に: `closeChange === "CLOSED" && next.lifecycleState === "WON"` なら `ensureOrderForWon(user, next, now)`; `closeChange === "REOPENED"` なら `cancelOrderForReopened(user, id, now)`。
- 確認経由 (`resolveReview` の STATE_AMBIGUOUS、01 で手を入れた所): `setOpportunityField` の後で同じ 2 つを呼ぶ (`o.lifecycleState` の前後を見て)。`setOpportunityField` がトランザクションを持つなら、その外で呼んでも可 (別トランザクションで良い)。
- `listOrders(actor, { period?, accountId?, status? })`: SALES は自分の案件の受注のみ。`getOrder(actor, id)`: 同じ可視性。`updateOrder(actor, id, { deliveryDue?, paymentTerms?, note? })`: MANAGER/ADMIN。**金額・明細は編集不可** (直すときは案件を OPEN に戻して再確定)。監査 `ORDER_UPDATED`。
- 受注伝票の `OrderSummary` DTO: `Order` + `accountName`, `opportunityTitle`, `ownerName`。
- KPI の受注額は引き続き `opportunities.won_amount` を正とする (受注伝票の金額と一致するよう作っている)。
- `OpportunityDetail` に `order?: OrderSummary`。

### 5. RPC
`listOrders(query?: OrderListQuery): Promise<OrderSummary[]>`, `getOrder(id): Promise<OrderSummary>`, `updateOrder(id, patch: OrderPatch): Promise<OrderSummary>`。型を追加。

### 6. 06 の CSV
`ExportKind` に `"ORDERS"` を追加: 受注番号 / 受注日 / 顧客 / 案件 / 担当 / 金額 (税抜) / 消費税 / 税込 / 納期 / 支払条件 / 状態 / 明細 (「名前×数量」を「;」区切りで 1 セル)。

### 7. ラベル
`ORDER_STATUS_LABEL = { CONFIRMED: "確定", CANCELLED: "取消" }`、`AUDIT_ACTION_LABEL` に `ORDER_CREATED: "受注伝票を作成"`, `ORDER_CANCELLED: "受注伝票を取消"`, `ORDER_UPDATED: "受注伝票を更新"`。

### 8. 画面
- `ReportPage` (05) に「受注一覧」タブ: `PeriodPicker` を共用、表 (受注番号 / 受注日 / 顧客 / 案件 / 担当 / 金額 / 税込 / 納期 / 状態)、行クリックで下に詳細 (明細スナップショット表、納期・支払条件・メモの編集フォーム = MANAGER/ADMIN のみ、`updateOrder`)。CSV ボタン (`ORDERS`)。
- `OpportunityDetailPage` ヘッダの「受注 2026-09-15 / 1,234,000円」の横に受注番号 (`detail.order?.orderNo`)。クリックで集計ページの受注一覧へ (ルート `{ kind: "report", tab: "orders", orderId }` を足すか、まずはテキストのみ。**テキストのみで可**)。

## テスト (`packages/sales-core/__tests__/orders.test.ts` 新規)
- 明細ありの案件を WON → 受注 1 件、`orderNo` が `202609-0001`、`amount` = 明細税抜合計、`taxAmount` = 税、`lineItems[0].subtotal`。2 件目の同月 WON は `202609-0002`。
- 明細なし → `amount = wonAmount`、`lineItems = []`。
- OPEN に戻す → CANCELLED。再 WON → **新しい** 受注 (CANCELLED は数えない。`getConfirmedOrderForOpportunity` は CONFIRMED のみ) で `202609-0003`。
- 品目マスタを改名しても `lineItems[].name` は変わらない。
- `updateOrder` で `amount` を渡しても型で弾かれる (patch 型に無い)。SALES の `updateOrder` → `AuthorizationError`。SALES の `listOrders` は自分の案件分だけ。
- 確認 (review) 経由の WON でも受注ができる: `STATE_AMBIGUOUS` の review を作って `resolveReview` → 受注 1 件。(review の作り方は `pipeline.test.ts` の既存テストを参考に。難しければ `setOpportunityField` を直接呼ぶテストでも可。)

## 検証
共通コマンド。期待: sales-core +6 前後、gatekeeper-sales 48。

## コミット件名
`Sales OS: order record (number, date, line snapshot) created when a deal is won`

## 完了チェック
- [ ] 案件を受注にすると集計ページの「受注一覧」に出る (ユーザー確認)
- [ ] 案件を再開すると受注が「取消」になる

## 止まって聞く
- `setOpportunityField` の中で受注作成を呼ぶと二重トランザクションになる等、構造上の問題がある場合。

---

## 全 11 項目が終わったら
1. `plans/sales-os-backlog.md` の ★ 11 項目を「済 (コミット id)」に更新。
2. `plans/sales-os-spec/README.md` の表に完了日を書く。
3. ユーザーに「次の候補」を提示: C2 確度、C3 金額履歴、F4 推移グラフ、G1/G2 取込精度、B2 既存担当者への補完。
