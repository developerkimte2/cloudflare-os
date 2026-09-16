# 02 — D1 品目 (商材) マスタ (migration 0008)

前提: 01 (C1) がコミット済み。

## 目的
案件明細 (03) の元になる品目マスタ。設定ページで MANAGER/ADMIN が管理する。削除は無く、非アクティブ化のみ (明細から参照されるため)。

## 先に読むファイル
1. `packages/sales-core/src/domain/types.ts` — `CustomerPerson` (型の書き方の手本)
2. `packages/sales-core/src/db/migrations.ts` — 末尾 (0007)
3. `packages/sales-core/src/db/tables.ts` — `customerPersons`
4. `packages/sales-core/src/db/repository.ts` — `getPerson`, `listPersonsForAccount`, `insertPerson`, `updatePerson` (100〜130 行)
5. `packages/sales-core/src/api/dto.ts` — `PersonInput`, `PersonPatch`
6. `packages/sales-core/src/service/sales-service.ts` — `createPerson`, `updatePerson`, `requireUser`, `AuthorizationError` の使い方 (`getManagerSummary` 冒頭)
7. `packages/gatekeeper-sales/src/sales-core-do.ts` — `createPerson` / `updatePerson`
8. `packages/gatekeeper-sales/src/management-types.ts` — 先頭の import/export と `createPerson`
9. `packages/gatekeeper-sales/src/sales.ts` — `createPerson` の委譲行
10. `packages/gatekeeper-sales/app/pages/SettingsPage.tsx` — `Section` / `Field`、`NUMBER_FIELDS`、保存の流れ (`runAction`, `toasts`)
11. `packages/gatekeeper-sales/app/components/CustomerInfo.tsx` — 担当者の一覧 + 追加/編集フォーム (`PersonForm`) の作り (`type="button"` で送信している)

## 手順

### 1. ドメイン型 (`domain/types.ts`) — `CustomerPerson` の後に追加
```ts
export type ProductCategory = "GOODS" | "SERVICE" | "MAINTENANCE" | "SUBSCRIPTION" | "OTHER";
export const PRODUCT_CATEGORIES: ProductCategory[] = ["GOODS", "SERVICE", "MAINTENANCE", "SUBSCRIPTION", "OTHER"];
/** 消費税区分. Rates live in config (04) so a rate change never rewrites products. */
export type TaxCategory = "STANDARD" | "REDUCED" | "EXEMPT";
export const TAX_CATEGORIES: TaxCategory[] = ["STANDARD", "REDUCED", "EXEMPT"];

/** A sellable item (商材). Deactivated, never deleted: line items keep pointing at it. */
export interface Product {
  id: string;
  code?: string;
  name: string;
  category: ProductCategory;
  /** Tax-exclusive standard unit price. Line items copy it and may override. */
  unitPrice?: number;
  cost?: number;
  taxCategory: TaxCategory;
  unitLabel?: string;
  description?: string;
  active: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}
```

### 2. migration (`db/migrations.ts`) — 末尾に追記
```ts
  {
    id: "0008_products",
    sql: `
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  code TEXT,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'SERVICE' CHECK (category IN ('GOODS','SERVICE','MAINTENANCE','SUBSCRIPTION','OTHER')),
  unit_price REAL,
  cost REAL,
  tax_category TEXT NOT NULL DEFAULT 'STANDARD' CHECK (tax_category IN ('STANDARD','REDUCED','EXEMPT')),
  unit_label TEXT,
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_products_active ON products(active, sort_order);
`,
  },
```

### 3. 列マッピング (`db/tables.ts`)
import に `Product` を足し、`customerPersons` の後に:
```ts
export const products = new Table<Product>("products", "id", [
  col("id", "id"), col("code", "code"), col("name", "name"), col("category", "category"),
  col("unit_price", "unitPrice"), col("cost", "cost"), col("tax_category", "taxCategory"),
  col("unit_label", "unitLabel"), col("description", "description"), col("active", "active", "bool"),
  col("sort_order", "sortOrder"), col("created_at", "createdAt"), col("updated_at", "updatedAt"),
]);
```

### 4. リポジトリ (`db/repository.ts`) — `deletePerson` の後に追加
```ts
  // ---- products -------------------------------------------------------------------------------

  getProduct(id: string): Product | undefined {
    return T.products.get(this.db, id);
  }

  listProducts(includeInactive: boolean): Product[] {
    return T.products.select(this.db,
      includeInactive ? "ORDER BY sort_order, name" : "WHERE active = 1 ORDER BY sort_order, name");
  }

  findProductByCode(code: string): Product | undefined {
    return T.products.select(this.db, "WHERE code = ? LIMIT 1", code)[0];
  }

  insertProduct(product: Product): void {
    T.products.insert(this.db, product);
  }

  updateProduct(product: Product): void {
    T.products.update(this.db, product);
  }
```
`Product` を import に追加。

### 5. DTO (`api/dto.ts`) — `PersonPatch` の後に追加
```ts
export interface ProductInput {
  code?: string;
  name: string;
  category?: ProductCategory;
  unitPrice?: number;
  cost?: number;
  taxCategory?: TaxCategory;
  unitLabel?: string;
  description?: string;
  active?: boolean;
  sortOrder?: number;
}
/** null or "" clears a text field; numbers: null clears. */
export interface ProductPatch {
  code?: string | null;
  name?: string;
  category?: ProductCategory;
  unitPrice?: number | null;
  cost?: number | null;
  taxCategory?: TaxCategory;
  unitLabel?: string | null;
  description?: string | null;
  active?: boolean;
  sortOrder?: number;
}
```

### 6. サービス (`service/sales-service.ts`) — `updatePerson` の後に追加
```ts
  // ---- products -------------------------------------------------------------------------------

  listProducts(actor: Actor, options: { includeInactive?: boolean } = {}): Product[] {
    this.requireUser(actor);
    return this.repo.listProducts(options.includeInactive ?? false);
  }

  createProduct(actor: Actor, input: ProductInput): Product {
    const user = this.requireProductEditor(actor);
    const name = input.name.trim();
    if (!name) throw new TypeError("品目名を入力してください");
    const code = cleanText(input.code);
    if (code && this.repo.findProductByCode(code)) throw new TypeError("品目コードが重複しています");
    const now = nowIso(this.ctx.clock);
    const product: Product = {
      id: newId(), code, name, category: input.category ?? "SERVICE",
      unitPrice: nonNegative(input.unitPrice, "単価"), cost: nonNegative(input.cost, "原価"),
      taxCategory: input.taxCategory ?? "STANDARD", unitLabel: cleanText(input.unitLabel),
      description: cleanText(input.description), active: input.active ?? true,
      sortOrder: input.sortOrder ?? 0, createdAt: now, updatedAt: now,
    };
    this.repo.transaction(() => {
      this.repo.insertProduct(product);
      audit(this.ctx, { actorType: "USER", actorId: user.id, action: "PRODUCT_CREATED",
        entityType: "product", entityId: product.id, after: product });
    });
    return product;
  }

  updateProduct(actor: Actor, id: string, patch: ProductPatch): Product {
    const user = this.requireProductEditor(actor);
    const current = this.repo.getProduct(id);
    if (!current) throw new NotFoundError("品目");
    const next: Product = { ...current, updatedAt: nowIso(this.ctx.clock) };
    if (patch.name !== undefined) next.name = patch.name.trim() || current.name;
    if (patch.code !== undefined) {
      next.code = cleanText(patch.code);
      if (next.code) {
        const dup = this.repo.findProductByCode(next.code);
        if (dup && dup.id !== id) throw new TypeError("品目コードが重複しています");
      }
    }
    if (patch.category !== undefined) next.category = patch.category;
    if (patch.unitPrice !== undefined) next.unitPrice = patch.unitPrice === null ? undefined : nonNegative(patch.unitPrice, "単価");
    if (patch.cost !== undefined) next.cost = patch.cost === null ? undefined : nonNegative(patch.cost, "原価");
    if (patch.taxCategory !== undefined) next.taxCategory = patch.taxCategory;
    if (patch.unitLabel !== undefined) next.unitLabel = cleanText(patch.unitLabel);
    if (patch.description !== undefined) next.description = cleanText(patch.description);
    if (patch.active !== undefined) next.active = patch.active;
    if (patch.sortOrder !== undefined) next.sortOrder = patch.sortOrder;
    this.repo.transaction(() => {
      this.repo.updateProduct(next);
      audit(this.ctx, { actorType: "USER", actorId: user.id, action: "PRODUCT_UPDATED",
        entityType: "product", entityId: id, before: current, after: next });
    });
    return next;
  }

  /** Product master is shared by everyone, so only MANAGER/ADMIN may change it. */
  private requireProductEditor(actor: Actor): User {
    const user = this.requireUser(actor);
    if (user.role === "SALES") throw new AuthorizationError("商材の編集はマネージャー以上の権限が必要です");
    return user;
  }
```
ファイル末尾のヘルパー群 (`cleanText` の近く) に追加:
```ts
function nonNegative(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${label}は 0 以上の数値で入力してください`);
  return value;
}
```
import: `Product` (domain), `ProductInput`, `ProductPatch` (dto)。`newId` は既に import 済みか確認。

### 7. RPC (3 か所)
- `sales-core-do.ts` (`createPerson` の近く):
```ts
  async listProducts(caller: Caller, options?: { includeInactive?: boolean }): Promise<Product[]> {
    return this.#service.listProducts(this.#actor(caller), options ?? {});
  }
  async createProduct(caller: Caller, input: ProductInput): Promise<Product> {
    return this.#service.createProduct(this.#actor(caller), input);
  }
  async updateProduct(caller: Caller, id: string, patch: ProductPatch): Promise<Product> {
    return this.#service.updateProduct(this.#actor(caller), id, patch);
  }
```
- `management-types.ts`: import/export に `Product, ProductInput, ProductPatch` を追加。`SalesManagementApi` に:
```ts
  /** Product master (商材). Everyone can list; MANAGER/ADMIN edit. */
  listProducts(options?: { includeInactive?: boolean }): Promise<Product[]>;
  createProduct(input: ProductInput): Promise<Product>;
  updateProduct(id: string, patch: ProductPatch): Promise<Product>;
```
- `sales.ts` (`createPerson` の行の近く):
```ts
  listProducts(options?: { includeInactive?: boolean }): Promise<Product[]> { return this.core.listProducts(this.caller, options); }
  createProduct(input: ProductInput): Promise<Product> { return this.core.createProduct(this.caller, input); }
  updateProduct(id: string, patch: ProductPatch): Promise<Product> { return this.core.updateProduct(this.caller, id, patch); }
```
`sales-core-do.ts` / `sales.ts` の import に型を足す (既存の import 行と同じ経路)。

### 8. ラベル (`app/labels.ts`)
```ts
export const PRODUCT_CATEGORY_LABEL: Record<ProductCategory, string> = {
  GOODS: "物販", SERVICE: "サービス", MAINTENANCE: "保守", SUBSCRIPTION: "サブスク", OTHER: "その他",
};
export const TAX_CATEGORY_LABEL: Record<TaxCategory, string> = { STANDARD: "標準 10%", REDUCED: "軽減 8%", EXEMPT: "非課税" };
```
`AUDIT_ACTION_LABEL` に `PRODUCT_CREATED: "商材を登録"`, `PRODUCT_UPDATED: "商材を更新"`。

### 9. 画面 — 設定ページに「商材」節
新規 `app/components/ProductTable.tsx` を作り、`SettingsPage` の「フェーズラベル」節の後に `<Section title="商材"><ProductTable api={api} canEdit={who.isAdmin || who.isManager} /></Section>` を置く。
`who` に `isManager` が無ければ `SettingsPage` の props に足す (App.tsx で `who.role !== "SALES"` から渡す。`whoAmI` の戻りに role がある。無ければ `listUsers` ではなく `whoAmI` を確認)。**判断できなければ止める。**

`ProductTable` の仕様:
- 読み込み: `api.listProducts({ includeInactive: true })`。
- 表: コード / 名称 / 区分 / 単価 / 税区分 / 単位 / 有効。行クリックで下に編集フォーム (CustomerInfo の `PersonForm` と同じ作り: 入力 state を持ち、「保存」`type="button"` → `api.updateProduct` → 再読込)。
- 末尾「＋ 商材を追加」→ 空のフォーム → `api.createProduct`。
- `canEdit` が false なら表のみ。
- エラーは `runAction` / toast の既存パターンで表示 (SettingsPage の保存と同じ)。

## テスト (`packages/sales-core/__tests__/products.test.ts` 新規)
```ts
import { describe, expect, it } from "vitest";
import { FakeLlmProvider } from "../src/ai/provider.js";
import { AuthorizationError } from "../src/service/sales-service.js";
import { makeService, makeUser } from "./helpers.js";

const NOW = "2026-09-08T01:00:00Z";

describe("product master (D1)", () => {
  it("MANAGER creates, lists (active only by default), and deactivates a product", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const manager = makeUser(svc.repo, "MANAGER");
    const actor = { userId: manager.id };
    const p = svc.createProduct(actor, { code: "SV-001", name: "導入支援", unitPrice: 300000 });
    expect(p.category).toBe("SERVICE");
    expect(p.taxCategory).toBe("STANDARD");
    expect(svc.listProducts(actor)).toHaveLength(1);
    svc.updateProduct(actor, p.id, { active: false });
    expect(svc.listProducts(actor)).toHaveLength(0);
    expect(svc.listProducts(actor, { includeInactive: true })).toHaveLength(1);
  });

  it("rejects a duplicate code and a negative price", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const actor = { userId: makeUser(svc.repo, "ADMIN").id };
    svc.createProduct(actor, { code: "A", name: "x" });
    expect(() => svc.createProduct(actor, { code: "A", name: "y" })).toThrow(/重複/);
    expect(() => svc.createProduct(actor, { name: "z", unitPrice: -1 })).toThrow(/0 以上/);
  });

  it("SALES can list but not edit", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const manager = { userId: makeUser(svc.repo, "MANAGER").id };
    const sales = { userId: makeUser(svc.repo, "SALES").id };
    svc.createProduct(manager, { name: "x" });
    expect(svc.listProducts(sales)).toHaveLength(1);
    expect(() => svc.createProduct(sales, { name: "y" })).toThrow(AuthorizationError);
  });
});
```

## 検証
共通コマンド。期待: sales-core 283 (280 + 3)、gatekeeper-sales 48。

## コミット件名
`Sales OS: product master (code, price, tax category) managed from settings`

## 完了チェック
- [ ] 設定ページに「商材」節が出て、追加・編集・無効化できる (ユーザー確認)
- [ ] SALES ユーザーには表のみ

## 止まって聞く
- `SettingsPage` の `who` に role 判定を足す経路が分からない。
- `Table.select` に `WHERE` 無しの `ORDER BY` だけを渡せない (mapper の実装を見て、`where` 引数が `WHERE` 前提なら `"WHERE 1=1 ORDER BY …"` にしてよい)。
