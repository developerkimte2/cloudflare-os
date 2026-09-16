import type { RpcStub } from "capnweb";
import { useEffect, useState } from "react";
// Deep import via its own package.json "exports" subpath: this leaf module has no DB/LLM code,
// unlike "@gadgets/sales-core" (the package index), which would drag db/node-sqlite's
// `node:sqlite` into the browser bundle (FB_20260908 D).
import { lineTotals } from "@gadgets/sales-core/rules/money";
import type {
  OpportunityDetail,
  OpportunityLineItem,
  Product,
  SalesManagementApi,
} from "../../src/management-types";
import { useApiAction, useAsyncData } from "../api";
import { TAX_CATEGORY_LABEL } from "../labels";

type TaxCategory = Product["taxCategory"];

const INPUT_CLASS =
  "h-8 w-full rounded-md border border-kumo-line bg-kumo-base px-2 text-sm text-kumo-default placeholder:text-kumo-inactive";
const TAX_CATEGORIES: TaxCategory[] = ["STANDARD", "REDUCED", "EXEMPT"];
// Kept in sync with sales-core's DEFAULT_CONFIG.taxRates/taxRounding (config isn't exposed to the
// app yet; 04 wires the real values through). Used only for a live preview while editing.
const PREVIEW_TAX_CONFIG = { taxRates: { STANDARD: 0.1, REDUCED: 0.08, EXEMPT: 0 }, taxRounding: "FLOOR" as const };

type Row = {
  key: string;
  productId?: string;
  name: string;
  quantity: string;
  unitPrice: string;
  discountAmount: string;
  taxCategory: TaxCategory;
};

let rowKeySeq = 0;
function newRowKey(): string {
  rowKeySeq += 1;
  return `row-${rowKeySeq}`;
}

function toRow(item: OpportunityLineItem): Row {
  return {
    key: item.id,
    productId: item.productId,
    name: item.name,
    quantity: String(item.quantity),
    unitPrice: String(item.unitPrice),
    discountAmount: String(item.discountAmount),
    taxCategory: item.taxCategory,
  };
}

function rowForTotals(row: Row): OpportunityLineItem {
  return {
    id: row.key, opportunityId: "", productId: row.productId, name: row.name,
    quantity: Number(row.quantity) || 0, unitPrice: Number(row.unitPrice) || 0,
    discountAmount: Number(row.discountAmount) || 0, taxCategory: row.taxCategory,
    sortOrder: 0, createdAt: "", updatedAt: "",
  };
}

/**
 * 案件明細 (D2): 品目 x 数量 x 単価 - 値引 per row. Saving replaces the whole table and re-derives
 * expectedAmount from the tax-exclusive total (locked to manual edits once there is at least one
 * row -- see OpportunityDetailPage's 見込金額 field).
 */
export function LineItemsSection({
  detail,
  api,
  onSaved,
}: {
  detail: OpportunityDetail;
  api: RpcStub<SalesManagementApi>;
  onSaved: () => void;
}) {
  const runAction = useApiAction();
  const { data: products } = useAsyncData<Product[]>(() => api.listProducts(), [api]);
  const [rows, setRows] = useState<Row[]>(() => detail.lineItems.map(toRow));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setRows(detail.lineItems.map(toRow));
  }, [detail.lineItems]);

  const update = (key: string, patch: Partial<Row>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const addRow = () => {
    setRows((current) => [
      ...current,
      { key: newRowKey(), name: "", quantity: "1", unitPrice: "0", discountAmount: "0", taxCategory: "STANDARD" },
    ]);
  };

  const removeRow = (key: string) => {
    setRows((current) => current.filter((row) => row.key !== key));
  };

  const moveRow = (key: string, direction: -1 | 1) => {
    setRows((current) => {
      const index = current.findIndex((row) => row.key === key);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  };

  const pickProduct = (key: string, productId: string) => {
    const product = products?.find((p) => p.id === productId);
    if (!product) {
      update(key, { productId: undefined });
      return;
    }
    update(key, {
      productId: product.id,
      name: product.name,
      unitPrice: product.unitPrice != null ? String(product.unitPrice) : "0",
      taxCategory: product.taxCategory,
    });
  };

  const previewTotals = lineTotals(rows.map(rowForTotals), PREVIEW_TAX_CONFIG);

  const save = async () => {
    setSaving(true);
    const ok = await runAction(
      () =>
        api.setLineItems(
          detail.id,
          rows.map((row, i) => ({
            productId: row.productId,
            name: row.name.trim(),
            quantity: Number(row.quantity),
            unitPrice: Number(row.unitPrice),
            discountAmount: Number(row.discountAmount) || 0,
            taxCategory: row.taxCategory,
            sortOrder: i,
          })),
          detail.version,
        ),
      "明細の保存に失敗しました",
    );
    setSaving(false);
    if (ok) onSaved();
  };

  return (
    <div>
      {rows.length === 0 ? (
        <p className="text-sm text-kumo-subtle">明細はまだありません。見込金額は手入力のままです。</p>
      ) : (
        <div className="space-y-2">
          {rows.map((row, i) => (
            <div key={row.key} className="rounded-lg border border-kumo-line bg-kumo-base p-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
                <div className="sm:col-span-2">
                  <span className="mb-1 block text-[11px] font-medium text-kumo-inactive">品目</span>
                  <select
                    value={row.productId ?? ""}
                    onChange={(event) => pickProduct(row.key, event.currentTarget.value)}
                    className={INPUT_CLASS}
                  >
                    <option value="">自由入力</option>
                    {(products ?? []).map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <span className="mb-1 block text-[11px] font-medium text-kumo-inactive">名称</span>
                  <input value={row.name} onChange={(event) => update(row.key, { name: event.currentTarget.value })} className={INPUT_CLASS} />
                </div>
                <div>
                  <span className="mb-1 block text-[11px] font-medium text-kumo-inactive">数量</span>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    value={row.quantity}
                    onChange={(event) => update(row.key, { quantity: event.currentTarget.value })}
                    className={INPUT_CLASS}
                  />
                </div>
                <div>
                  <span className="mb-1 block text-[11px] font-medium text-kumo-inactive">単価</span>
                  <input
                    type="number"
                    min={0}
                    value={row.unitPrice}
                    onChange={(event) => update(row.key, { unitPrice: event.currentTarget.value })}
                    className={INPUT_CLASS}
                  />
                </div>
                <div>
                  <span className="mb-1 block text-[11px] font-medium text-kumo-inactive">値引</span>
                  <input
                    type="number"
                    min={0}
                    value={row.discountAmount}
                    onChange={(event) => update(row.key, { discountAmount: event.currentTarget.value })}
                    className={INPUT_CLASS}
                  />
                </div>
                <div>
                  <span className="mb-1 block text-[11px] font-medium text-kumo-inactive">税区分</span>
                  <select
                    value={row.taxCategory}
                    onChange={(event) => update(row.key, { taxCategory: event.currentTarget.value as TaxCategory })}
                    className={INPUT_CLASS}
                  >
                    {TAX_CATEGORIES.map((t) => (
                      <option key={t} value={t}>
                        {TAX_CATEGORY_LABEL[t]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <span className="mb-1 block text-[11px] font-medium text-kumo-inactive">小計</span>
                  <p className="h-8 text-sm text-kumo-default">
                    {((Number(row.quantity) || 0) * (Number(row.unitPrice) || 0) - (Number(row.discountAmount) || 0)).toLocaleString("ja-JP")}円
                  </p>
                </div>
              </div>
              <div className="mt-2 flex justify-end gap-1.5">
                <button
                  type="button"
                  disabled={i === 0}
                  onClick={() => moveRow(row.key, -1)}
                  className="press rounded-md border border-kumo-line bg-kumo-base px-2 py-1 text-xs text-kumo-default hover:bg-kumo-tint disabled:opacity-40"
                >
                  ↑
                </button>
                <button
                  type="button"
                  disabled={i === rows.length - 1}
                  onClick={() => moveRow(row.key, 1)}
                  className="press rounded-md border border-kumo-line bg-kumo-base px-2 py-1 text-xs text-kumo-default hover:bg-kumo-tint disabled:opacity-40"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => removeRow(row.key)}
                  className="press rounded-md border border-kumo-line bg-kumo-base px-2 py-1 text-xs text-kumo-danger hover:bg-kumo-tint"
                >
                  削除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={addRow}
        className="press mt-2 rounded-lg border border-kumo-line px-3 py-1.5 text-sm font-medium text-kumo-default hover:bg-kumo-tint"
      >
        ＋ 行を追加
      </button>

      {rows.length > 0 && (
        <div className="mt-3 space-y-0.5 text-right text-sm text-kumo-default">
          <p>税抜合計: {previewTotals.subtotal.toLocaleString("ja-JP")}円</p>
          <p>消費税: {previewTotals.tax.toLocaleString("ja-JP")}円</p>
          <p className="font-medium">税込合計: {previewTotals.total.toLocaleString("ja-JP")}円</p>
        </div>
      )}

      <div className="mt-3 flex justify-end">
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="press rounded-lg bg-kumo-brand px-3.5 py-1.5 text-sm font-medium text-white hover:bg-kumo-brand-hover disabled:opacity-50"
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
    </div>
  );
}
