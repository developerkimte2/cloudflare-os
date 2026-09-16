# 03 — D2 案件明細 (migration 0009)

前提: 01, 02 がコミット済み。

## 目的
案件に「品目 × 数量 × 単価 − 値引」の明細を持ち、明細合計 (税抜) を見込金額にする。明細がある案件は見込金額を手入力・AI 反映しない。

## 先に読むファイル
1. `packages/sales-core/src/domain/types.ts` — `Product` (02 で追加)
2. `packages/sales-core/src/db/migrations.ts` — 末尾 (0008)
3. `packages/sales-core/src/db/tables.ts` — `products`
4. `packages/sales-core/src/db/repository.ts` — products 節、`updateOpportunity(opp, expectedVersion)`
5. `packages/sales-core/src/api/dto.ts` — `OpportunityDetail`, `OpportunityPatch`
6. `packages/sales-core/src/service/sales-service.ts` — `updateOpportunity`, `getOpportunity` (detail を組み立てている所), `canSee`
7. `packages/sales-core/src/rules/business.ts` — `deriveAmount` (95 行付近) と、それを呼んでいる `pipeline/ingest.ts` の箇所 (`grep -n deriveAmount`)
8. `packages/sales-core/src/rules/config.ts` — `SalesConfig`, `DEFAULT_CONFIG`
9. `packages/gatekeeper-sales/app/pages/OpportunityDetailPage.tsx` — `Section`、次アクション節 (一覧 + 追加の作り)
10. RPC 3 ファイル (02 と同じ)

## 手順

### 1. ドメイン型 (`domain/types.ts`) — `Product` の後に追加
```ts
/** One row of a deal's 明細. Snapshots the product name so a rename never rewrites history. */
export interface OpportunityLineItem {
  id: string;
  opportunityId: string;
  productId?: string;
  name: string;
  quantity: number;
  /** Tax-exclusive. */
  unitPrice: number;
  /** Tax-exclusive discount on this row (>= 0). */
  discountAmount: number;
  taxCategory: TaxCategory;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}
```

### 2. migration (`db/migrations.ts`) — 末尾に追記
```ts
  {
    id: "0009_opportunity_line_items",
    sql: `
CREATE TABLE opportunity_line_items (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id),
  product_id TEXT REFERENCES products(id),
  name TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  discount_amount REAL NOT NULL DEFAULT 0,
  tax_category TEXT NOT NULL DEFAULT 'STANDARD' CHECK (tax_category IN ('STANDARD','REDUCED','EXEMPT')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_line_items_opportunity ON opportunity_line_items(opportunity_id, sort_order);
`,
  },
```

### 3. 列マッピング (`db/tables.ts`)
```ts
export const opportunityLineItems = new Table<OpportunityLineItem>("opportunity_line_items", "id", [
  col("id", "id"), col("opportunity_id", "opportunityId"), col("product_id", "productId"),
  col("name", "name"), col("quantity", "quantity"), col("unit_price", "unitPrice"),
  col("discount_amount", "discountAmount"), col("tax_category", "taxCategory"),
  col("sort_order", "sortOrder"), col("created_at", "createdAt"), col("updated_at", "updatedAt"),
]);
```

### 4. リポジトリ (`db/repository.ts`) — products 節の後
```ts
  // ---- line items -----------------------------------------------------------------------------

  listLineItems(opportunityId: string): OpportunityLineItem[] {
    return T.opportunityLineItems.select(this.db, "WHERE opportunity_id = ? ORDER BY sort_order, created_at", opportunityId);
  }

  /** Replace-all: the UI always sends the whole table, so no per-row diffing. */
  replaceLineItems(opportunityId: string, items: OpportunityLineItem[]): void {
    this.db.run("DELETE FROM opportunity_line_items WHERE opportunity_id = ?", opportunityId);
    for (const item of items) T.opportunityLineItems.insert(this.db, item);
  }

  countLineItems(opportunityId: string): number {
    return this.db.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM opportunity_line_items WHERE opportunity_id = ?", opportunityId)!.n;
  }
```

### 5. 税計算の純関数 (`rules/money.ts` 新規)
```ts
import type { OpportunityLineItem, TaxCategory } from "../domain/types.js";
import type { SalesConfig } from "./config.js";

export interface LineTotals { subtotal: number; tax: number; total: number }

export function lineSubtotal(item: Pick<OpportunityLineItem, "quantity" | "unitPrice" | "discountAmount">): number {
  return item.quantity * item.unitPrice - item.discountAmount;
}

/** Tax per row (rounded per config), summed. Amounts are tax-exclusive; `total` adds the tax. */
export function lineTotals(items: OpportunityLineItem[], config: Pick<SalesConfig, "taxRates" | "taxRounding">): LineTotals {
  let subtotal = 0, tax = 0;
  for (const item of items) {
    const s = lineSubtotal(item);
    subtotal += s;
    tax += roundTax(s * (config.taxRates[item.taxCategory] ?? 0), config.taxRounding);
  }
  return { subtotal, tax, total: subtotal + tax };
}

function roundTax(value: number, mode: SalesConfig["taxRounding"]): number {
  return mode === "CEIL" ? Math.ceil(value) : mode === "ROUND" ? Math.round(value) : Math.floor(value);
}

export const DEFAULT_TAX_RATES: Record<TaxCategory, number> = { STANDARD: 0.1, REDUCED: 0.08, EXEMPT: 0 };
```
`rules/index.ts` に `export * from "./money.js";` を追加。

### 6. 設定 (`rules/config.ts`)
`SalesConfig` に追加: `taxRates: Record<TaxCategory, number>; taxRounding: "FLOOR" | "ROUND" | "CEIL";`。`DEFAULT_CONFIG` に `taxRates: { STANDARD: 0.1, REDUCED: 0.08, EXEMPT: 0 }, taxRounding: "FLOOR",`。
`loadConfig` / `saveConfig` は `typeof` で型を見ている。`taxRates` は object なので通る。**設定画面への露出は 04 で行う** (ここでは既定値だけ)。

### 7. DTO (`api/dto.ts`)
```ts
export interface LineItemInput {
  productId?: string;
  name: string;
  quantity: number;
  unitPrice: number;
  discountAmount?: number;
  taxCategory?: TaxCategory;
  sortOrder?: number;
}
```
`OpportunityDetail` に `lineItems: OpportunityLineItem[]; totals: LineTotals;` を追加 (`LineTotals` は `../rules/money.js` から import)。
`OpportunitySummary` に `hasLineItems: boolean;` を追加 (一覧で「明細あり」を出すため。`summarize()` で `this.repo.countLineItems(o.id) > 0`。**注意**: `summarize` は一覧で件数分呼ばれる。500 件で 500 クエリになるが、今回はこれで良い。遅ければ後で `listOpportunities` 側で一括カウントに変える。)

### 8. サービス (`service/sales-service.ts`)

8-1. `getOpportunity()` の detail 組み立てに:
```ts
      lineItems: this.repo.listLineItems(id),
      totals: lineTotals(this.repo.listLineItems(id), this.config),
```
(2 回呼ぶのが嫌なら変数に取る。)

8-2. `updateOpportunity()` の `if (patch.expectedAmount !== undefined) …` を:
```ts
    if (patch.expectedAmount !== undefined) {
      if (this.repo.countLineItems(id) > 0) throw new TypeError("明細がある案件の見込金額は明細の合計から計算されます");
      next.expectedAmount = patch.expectedAmount ?? undefined;
    }
```

8-3. 新メソッド (`updateOpportunity` の後):
```ts
  /**
   * Replaces a deal's 明細 wholesale and re-derives expectedAmount from the tax-exclusive total.
   * With zero rows the deal goes back to a hand-entered expectedAmount (kept as-is).
   */
  setLineItems(actor: Actor, opportunityId: string, inputs: LineItemInput[], version: number): OpportunityDetail {
    const user = this.requireUser(actor);
    const o = this.repo.getOpportunity(opportunityId);
    if (!o || !this.canSee(user, o)) throw new NotFoundError("案件");
    const now = nowIso(this.ctx.clock);
    const items: OpportunityLineItem[] = inputs.map((input, i) => {
      const name = input.name.trim();
      if (!name) throw new TypeError(`${i + 1} 行目: 品目名を入力してください`);
      if (!Number.isFinite(input.quantity) || input.quantity <= 0) throw new TypeError(`${i + 1} 行目: 数量は 0 より大きい数値で入力してください`);
      if (!Number.isFinite(input.unitPrice) || input.unitPrice < 0) throw new TypeError(`${i + 1} 行目: 単価は 0 以上で入力してください`);
      const discount = input.discountAmount ?? 0;
      if (!Number.isFinite(discount) || discount < 0) throw new TypeError(`${i + 1} 行目: 値引は 0 以上で入力してください`);
      if (input.productId && !this.repo.getProduct(input.productId)) throw new NotFoundError("品目");
      return {
        id: newId(), opportunityId, productId: input.productId, name, quantity: input.quantity,
        unitPrice: input.unitPrice, discountAmount: discount, taxCategory: input.taxCategory ?? "STANDARD",
        sortOrder: input.sortOrder ?? i, createdAt: now, updatedAt: now,
      };
    });
    const before = this.repo.listLineItems(opportunityId);
    return this.repo.transaction(() => {
      this.repo.replaceLineItems(opportunityId, items);
      const next: Opportunity = { ...o, updatedAt: now };
      if (items.length > 0) next.expectedAmount = lineTotals(items, this.config).subtotal;
      if (!this.repo.updateOpportunity(next, version)) {
        throw new Error("案件が他のユーザーによって更新されています。再読込してください");
      }
      audit(this.ctx, { actorType: "USER", actorId: user.id, action: "LINE_ITEMS_UPDATED",
        entityType: "opportunity", entityId: opportunityId,
        before: { lineItems: before, expectedAmount: o.expectedAmount },
        after: { lineItems: items, expectedAmount: next.expectedAmount } });
      return this.getOpportunity(actor, opportunityId);
    });
  }
```
import: `OpportunityLineItem`, `LineItemInput`, `lineTotals`。

8-4. AI 金額反映との関係 — `pipeline/ingest.ts` で `deriveAmount(...)` を呼んでいる箇所を見つけ、**既存案件で明細がある場合はスキップ**する:
```ts
  const amount = (opportunity && ctx.repo.countLineItems(opportunity.id) > 0)
    ? { reviews: [] as ReviewTrigger[] }   // 明細がある案件: 金額は明細が正。AI は触らない
    : deriveAmount(x, opportunity, ctx.config);
```
(変数名は実コードに合わせる。`ReviewTrigger` の型名は business.ts を見て合わせる。) 併せて `decide("AMOUNT", …)` 相当の記録があれば reason を「明細があるため反映しない」にする。**無ければ足さなくてよい。**

### 9. RPC (3 か所)
`setLineItems(opportunityId: string, items: LineItemInput[], version: number): Promise<OpportunityDetail>`。型 `LineItemInput`, `OpportunityLineItem`, `LineTotals` を management-types の import/export に追加。

### 10. ラベル
`AUDIT_ACTION_LABEL` に `LINE_ITEMS_UPDATED: "明細を更新"`。

### 11. 画面 — 案件詳細に「明細」節 (`app/components/LineItemsSection.tsx` 新規)
props: `detail: OpportunityDetail`, `api`, `onSaved: () => void`。
- 読み込み時に `api.listProducts()` で品目一覧 (active のみ) を取得。
- 表の行 state: `{ productId, name, quantity, unitPrice, discountAmount, taxCategory }[]` (初期値 = `detail.lineItems`)。
- 行: 品目 `<select>` (「自由入力」+ 品目一覧。選ぶと name / unitPrice / taxCategory を複写) / 名称 / 数量 / 単価 / 値引 / 税区分 / 小計 (表示のみ `lineSubtotal`) / 削除ボタン / ↑↓。
- 末尾「＋ 行を追加」。表の下に 税抜合計 / 消費税 / 税込合計 (`detail.totals` を保存後に反映。編集中はクライアント側で `lineTotals` 相当を計算: `rules/money.ts` は sales-core からブラウザにも import できる。**`@gadgets/sales-core` の import がブラウザ bundle で node:sqlite を引き込まないか**、build 後の `grep -c "node:sqlite" app.txt` が 0 のままであることを必ず確認。0 でなくなったら `lineSubtotal` / `lineTotals` を `app/format.ts` に複製して止める。)
- 「保存」`type="button"` → `api.setLineItems(detail.id, rows, detail.version)` → `onSaved()`。
- `OpportunityDetailPage` の「見込金額」入力は `detail.lineItems.length > 0` のとき `readOnly` + 注記「明細合計から自動計算」。
- 節の配置: 「顧客情報」節の上。

## テスト (`packages/sales-core/__tests__/line-items.test.ts` 新規)
```ts
import { describe, expect, it } from "vitest";
import { FakeLlmProvider } from "../src/ai/provider.js";
import { lineTotals } from "../src/rules/money.js";
import { makeAccount, makeOpportunity, makeService, makeUser } from "./helpers.js";

const NOW = "2026-09-08T01:00:00Z";

describe("line items (D2)", () => {
  it("computes per-row tax with floor rounding and mixed rates", () => {
    const totals = lineTotals([
      { id: "a", opportunityId: "o", name: "x", quantity: 3, unitPrice: 333, discountAmount: 0, taxCategory: "STANDARD", sortOrder: 0, createdAt: NOW, updatedAt: NOW },
      { id: "b", opportunityId: "o", name: "y", quantity: 1, unitPrice: 1000, discountAmount: 100, taxCategory: "REDUCED", sortOrder: 1, createdAt: NOW, updatedAt: NOW },
    ], { taxRates: { STANDARD: 0.1, REDUCED: 0.08, EXEMPT: 0 }, taxRounding: "FLOOR" });
    expect(totals.subtotal).toBe(999 + 900);
    expect(totals.tax).toBe(99 + 72);
    expect(totals.total).toBe(1899 + 171);
  });

  it("saving rows sets expectedAmount to the tax-exclusive total and locks direct edits", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const user = makeUser(svc.repo, "SALES");
    const actor = { userId: user.id };
    const account = makeAccount(svc.repo);
    const opp = makeOpportunity(svc.repo, account.id, user.id, { expectedAmount: 1 });
    const detail = svc.setLineItems(actor, opp.id, [
      { name: "導入支援", quantity: 1, unitPrice: 300000 },
      { name: "保守", quantity: 12, unitPrice: 10000, discountAmount: 20000 },
    ], 1);
    expect(detail.lineItems).toHaveLength(2);
    expect(detail.expectedAmount).toBe(300000 + 120000 - 20000);
    expect(detail.totals.subtotal).toBe(400000);
    expect(() => svc.updateOpportunity(actor, opp.id, { expectedAmount: 5, version: detail.version })).toThrow(/明細/);
    const cleared = svc.setLineItems(actor, opp.id, [], detail.version);
    expect(cleared.expectedAmount).toBe(400000);   // kept as-is once rows are gone
    expect(svc.updateOpportunity(actor, opp.id, { expectedAmount: 5, version: cleared.version }).expectedAmount).toBe(5);
  });

  it("rejects bad rows and other users' deals", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const owner = makeUser(svc.repo, "SALES");
    const other = makeUser(svc.repo, "SALES");
    const account = makeAccount(svc.repo);
    const opp = makeOpportunity(svc.repo, account.id, owner.id);
    expect(() => svc.setLineItems({ userId: owner.id }, opp.id, [{ name: "", quantity: 1, unitPrice: 1 }], 1)).toThrow(/品目名/);
    expect(() => svc.setLineItems({ userId: owner.id }, opp.id, [{ name: "x", quantity: 0, unitPrice: 1 }], 1)).toThrow(/数量/);
    expect(() => svc.setLineItems({ userId: other.id }, opp.id, [{ name: "x", quantity: 1, unitPrice: 1 }], 1)).toThrow();
  });
});
```

## 検証
共通コマンド。期待: sales-core 286、gatekeeper-sales 48。`grep -c "node:sqlite" … app.txt` が **0** (ブラウザ側で `@gadgets/sales-core` の純関数を import した場合は特に確認)。

## コミット件名
`Sales OS: line items on a deal; expected amount follows the line total`

## 完了チェック
- [ ] 明細節で行の追加・削除・保存ができ、見込金額が読み取り専用になる (ユーザー確認)
- [ ] 明細がある案件へメモを取り込んでも金額の確認質問が出ない

## 止まって聞く
- `pipeline/ingest.ts` の `deriveAmount` 呼び出しが本指示の形に当てはめにくい。
- ブラウザ bundle に `node:sqlite` が混入した (上記 11 の対応で解決しない場合)。
