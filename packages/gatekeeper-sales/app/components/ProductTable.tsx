import type { RpcStub } from "capnweb";
import { useEffect, useState } from "react";
import type { Product, ProductInput, ProductPatch, SalesManagementApi } from "../../src/management-types";
import { useApiAction, useAsyncData } from "../api";
import { PRODUCT_CATEGORY_LABEL, TAX_CATEGORY_LABEL } from "../labels";

const INPUT_CLASS =
  "h-8 w-full rounded-md border border-kumo-line bg-kumo-base px-2 text-sm text-kumo-default placeholder:text-kumo-inactive";

const PRODUCT_CATEGORIES: Product["category"][] = ["GOODS", "SERVICE", "MAINTENANCE", "SUBSCRIPTION", "OTHER"];
const TAX_CATEGORIES: Product["taxCategory"][] = ["STANDARD", "REDUCED", "EXEMPT"];

/**
 * 商材 (品目) master, edited from the settings page. Everyone can see it (D2's line-item picker
 * needs the active list); only MANAGER/ADMIN can add or change entries -- `canEdit` hides the
 * mutating controls for everyone else, and the service enforces the same rule server-side.
 */
export function ProductTable({ api, canEdit }: { api: RpcStub<SalesManagementApi>; canEdit: boolean }) {
  const runAction = useApiAction();
  const { loading, error, data, reload } = useAsyncData<Product[]>(() => api.listProducts({ includeInactive: true }), [api]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  if (loading) return <p className="text-sm text-kumo-subtle">読み込み中…</p>;
  if (error) return <p className="text-sm text-kumo-danger">{error}</p>;
  const products = data ?? [];

  const saveNew = async (values: ProductValues) => {
    const ok = await runAction(() => api.createProduct(toInput(values)), "商材の登録に失敗しました");
    if (ok) {
      setAdding(false);
      reload();
    }
  };

  const saveEdit = async (id: string, values: ProductValues) => {
    const ok = await runAction(() => api.updateProduct(id, toPatch(values)), "商材の更新に失敗しました");
    if (ok) {
      setEditingId(null);
      reload();
    }
  };

  const toggleActive = async (product: Product) => {
    const ok = await runAction(() => api.updateProduct(product.id, { active: !product.active }), "商材の更新に失敗しました");
    if (ok) reload();
  };

  return (
    <div>
      {products.length === 0 ? (
        <p className="text-sm text-kumo-subtle">まだ商材が登録されていません。</p>
      ) : (
        <div className="divide-y divide-kumo-line">
          {products.map((product) =>
            editingId === product.id ? (
              <ProductForm
                key={product.id}
                initial={product}
                submitLabel="保存"
                onCancel={() => setEditingId(null)}
                onSubmit={(values) => saveEdit(product.id, values)}
              />
            ) : (
              <ProductRow
                key={product.id}
                product={product}
                canEdit={canEdit}
                onEdit={() => setEditingId(product.id)}
                onToggleActive={() => void toggleActive(product)}
              />
            ),
          )}
        </div>
      )}

      {canEdit &&
        (adding ? (
          <ProductForm submitLabel="追加" onCancel={() => setAdding(false)} onSubmit={saveNew} />
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="press mt-2 rounded-lg border border-kumo-line px-3 py-1.5 text-sm font-medium text-kumo-default hover:bg-kumo-tint"
          >
            ＋ 商材を追加
          </button>
        ))}
    </div>
  );
}

function ProductRow({
  product,
  canEdit,
  onEdit,
  onToggleActive,
}: {
  product: Product;
  canEdit: boolean;
  onEdit: () => void;
  onToggleActive: () => void;
}) {
  return (
    <div className="flex items-start gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-kumo-default">
          {product.name}
          {product.code && <span className="ml-2 text-xs text-kumo-subtle">{product.code}</span>}
          {!product.active && <span className="ml-2 text-xs text-kumo-danger">無効</span>}
        </p>
        <p className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-kumo-subtle">
          <span>{PRODUCT_CATEGORY_LABEL[product.category]}</span>
          <span>{product.unitPrice != null ? `${product.unitPrice.toLocaleString("ja-JP")}円` : "単価未設定"}</span>
          <span>{TAX_CATEGORY_LABEL[product.taxCategory]}</span>
          {product.unitLabel && <span>単位: {product.unitLabel}</span>}
        </p>
      </div>
      {canEdit && (
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onToggleActive}
            className="press rounded-md border border-kumo-line bg-kumo-base px-2 py-1 text-xs font-medium text-kumo-default hover:bg-kumo-tint"
          >
            {product.active ? "無効化" : "有効化"}
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="press rounded-md border border-kumo-line bg-kumo-base px-2 py-1 text-xs font-medium text-kumo-default hover:bg-kumo-tint"
          >
            編集
          </button>
        </div>
      )}
    </div>
  );
}

type ProductValues = {
  code: string;
  name: string;
  category: Product["category"];
  unitPrice: string;
  cost: string;
  taxCategory: Product["taxCategory"];
  unitLabel: string;
  description: string;
};

function toInput(values: ProductValues): ProductInput {
  return {
    code: values.code.trim() || undefined,
    name: values.name.trim(),
    category: values.category,
    unitPrice: values.unitPrice.trim() ? Number(values.unitPrice) : undefined,
    cost: values.cost.trim() ? Number(values.cost) : undefined,
    taxCategory: values.taxCategory,
    unitLabel: values.unitLabel.trim() || undefined,
    description: values.description.trim() || undefined,
  };
}

function toPatch(values: ProductValues): ProductPatch {
  return {
    code: values.code.trim() || null,
    name: values.name.trim(),
    category: values.category,
    unitPrice: values.unitPrice.trim() ? Number(values.unitPrice) : null,
    cost: values.cost.trim() ? Number(values.cost) : null,
    taxCategory: values.taxCategory,
    unitLabel: values.unitLabel.trim() || null,
    description: values.description.trim() || null,
  };
}

function ProductForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: Product;
  submitLabel: string;
  onSubmit: (values: ProductValues) => Promise<void>;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<ProductValues>({
    code: initial?.code ?? "",
    name: initial?.name ?? "",
    category: initial?.category ?? "SERVICE",
    unitPrice: initial?.unitPrice != null ? String(initial.unitPrice) : "",
    cost: initial?.cost != null ? String(initial.cost) : "",
    taxCategory: initial?.taxCategory ?? "STANDARD",
    unitLabel: initial?.unitLabel ?? "",
    description: initial?.description ?? "",
  });
  const [saving, setSaving] = useState(false);

  const trimmedName = values.name.trim();

  // No <form>: the app runs in a sandboxed iframe without allow-forms, where submit is dropped.
  const submit = async () => {
    if (!trimmedName) return;
    setSaving(true);
    await onSubmit(values);
    setSaving(false);
  };

  return (
    <div className="my-2 rounded-lg border border-kumo-line bg-kumo-base p-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Labeled label="品目名（必須）">
          <input
            value={values.name}
            onChange={(event) => setValues((current) => ({ ...current, name: event.currentTarget.value }))}
            placeholder="導入支援"
            className={INPUT_CLASS}
          />
        </Labeled>
        <Labeled label="品目コード">
          <input
            value={values.code}
            onChange={(event) => setValues((current) => ({ ...current, code: event.currentTarget.value }))}
            placeholder="SV-001"
            className={INPUT_CLASS}
          />
        </Labeled>
        <Labeled label="区分">
          <select
            value={values.category}
            onChange={(event) =>
              setValues((current) => ({ ...current, category: event.currentTarget.value as Product["category"] }))
            }
            className={INPUT_CLASS}
          >
            {PRODUCT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {PRODUCT_CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </Labeled>
        <Labeled label="税区分">
          <select
            value={values.taxCategory}
            onChange={(event) =>
              setValues((current) => ({ ...current, taxCategory: event.currentTarget.value as Product["taxCategory"] }))
            }
            className={INPUT_CLASS}
          >
            {TAX_CATEGORIES.map((t) => (
              <option key={t} value={t}>
                {TAX_CATEGORY_LABEL[t]}
              </option>
            ))}
          </select>
        </Labeled>
        <Labeled label="単価（税抜・円）">
          <input
            type="number"
            min={0}
            value={values.unitPrice}
            onChange={(event) => setValues((current) => ({ ...current, unitPrice: event.currentTarget.value }))}
            className={INPUT_CLASS}
          />
        </Labeled>
        <Labeled label="原価（任意）">
          <input
            type="number"
            min={0}
            value={values.cost}
            onChange={(event) => setValues((current) => ({ ...current, cost: event.currentTarget.value }))}
            className={INPUT_CLASS}
          />
        </Labeled>
        <Labeled label="単位">
          <input
            value={values.unitLabel}
            onChange={(event) => setValues((current) => ({ ...current, unitLabel: event.currentTarget.value }))}
            placeholder="式 / 台 / 月"
            className={INPUT_CLASS}
          />
        </Labeled>
        <Labeled label="説明" className="sm:col-span-2">
          <input
            value={values.description}
            onChange={(event) => setValues((current) => ({ ...current, description: event.currentTarget.value }))}
            className={INPUT_CLASS}
          />
        </Labeled>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="press rounded-lg border border-kumo-line px-3 py-1.5 text-sm text-kumo-default hover:bg-kumo-tint"
        >
          キャンセル
        </button>
        <button
          type="button"
          disabled={!trimmedName || saving}
          onClick={() => void submit()}
          className="press rounded-lg bg-kumo-brand px-3.5 py-1.5 text-sm font-medium text-white hover:bg-kumo-brand-hover disabled:opacity-50"
        >
          {saving ? "保存中…" : submitLabel}
        </button>
      </div>
    </div>
  );
}

function Labeled({ label, className = "", children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-[11px] font-medium text-kumo-inactive">{label}</span>
      {children}
    </label>
  );
}
