import { Toasty } from "@cloudflare/kumo";
import type { RpcStub } from "capnweb";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { Product, SalesManagementApi } from "../../src/management-types";
import { ProductTable } from "./ProductTable";

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "p1", name: "導入支援", category: "SERVICE", taxCategory: "STANDARD",
    active: true, sortOrder: 0, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
});

async function mount(api: Partial<SalesManagementApi>, canEdit: boolean): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <Toasty>
        <ProductTable api={api as unknown as RpcStub<SalesManagementApi>} canEdit={canEdit} />
      </Toasty>,
    );
  });
  return container;
}

describe("ProductTable (D1)", () => {
  it("lists products with category/price/tax labels once loaded", async () => {
    const el = await mount({ listProducts: async () => [product({ code: "SV-001", unitPrice: 300000 })] }, false);
    expect(el.textContent).toContain("導入支援");
    expect(el.textContent).toContain("SV-001");
    expect(el.textContent).toContain("サービス");
    expect(el.textContent).toContain("300,000円");
    expect(el.textContent).toContain("標準 10%");
  });

  it("shows the empty state when there are no products", async () => {
    const el = await mount({ listProducts: async () => [] }, true);
    expect(el.textContent).toContain("まだ商材が登録されていません。");
  });

  it("marks an inactive product and hides edit controls when canEdit is false", async () => {
    const el = await mount({ listProducts: async () => [product({ active: false })] }, false);
    expect(el.textContent).toContain("無効");
    expect(el.querySelector("button")).toBeNull(); // no 編集/無効化/追加 buttons for a read-only viewer
  });

  it("canEdit shows a add button and per-row edit/toggle controls", async () => {
    const el = await mount({ listProducts: async () => [product()] }, true);
    const buttonLabels = [...el.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttonLabels).toContain("＋ 商材を追加");
    expect(buttonLabels).toContain("編集");
    expect(buttonLabels).toContain("無効化");
  });

  it("clicking 無効化 calls updateProduct with active:false and reloads", async () => {
    let updateCalls: [string, unknown][] = [];
    let listCallCount = 0;
    const el = await mount(
      {
        listProducts: async () => {
          listCallCount += 1;
          return [product()];
        },
        updateProduct: async (id, patch) => {
          updateCalls.push([id, patch]);
          return product({ active: false });
        },
      },
      true,
    );
    const toggleButton = [...el.querySelectorAll("button")].find((b) => b.textContent === "無効化")!;
    await act(async () => {
      toggleButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      // toggleActive awaits updateProduct then reload() (another async fetch); flush a macrotask
      // so both microtask chains resolve inside this act() call.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(updateCalls).toEqual([["p1", { active: false }]]);
    expect(listCallCount).toBe(2); // initial load + reload after the toggle
  });
});
