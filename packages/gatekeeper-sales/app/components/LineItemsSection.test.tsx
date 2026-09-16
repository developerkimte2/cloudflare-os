import { Toasty } from "@cloudflare/kumo";
import type { RpcStub } from "capnweb";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { OpportunityDetail, OpportunityLineItem, SalesManagementApi } from "../../src/management-types";
import { LineItemsSection } from "./LineItemsSection";

function lineItem(overrides: Partial<OpportunityLineItem> = {}): OpportunityLineItem {
  return {
    id: "li1", opportunityId: "o1", name: "導入支援", quantity: 1, unitPrice: 300000,
    discountAmount: 0, taxCategory: "STANDARD", sortOrder: 0,
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function detail(overrides: Partial<OpportunityDetail> = {}): OpportunityDetail {
  return {
    id: "o1", title: "新機能提案", accountId: "a1", accountName: "ABC株式会社",
    accountResolutionStatus: "MANUAL", ownerUserId: "u1", ownerName: "太郎",
    collaboratorUserIds: [], contactPersonIds: [], contactNames: [], lifecycleState: "OPEN",
    operationalState: "ACTIVE", riskLevel: "NONE", hasLineItems: false, updatedAt: "2026-09-01T00:00:00.000Z",
    version: 1, account: { id: "a1" } as OpportunityDetail["account"], persons: [],
    lineItems: [], totals: { subtotal: 0, tax: 0, total: 0 }, nextActions: [], suggestions: [],
    commitments: [], activities: [], sources: [], decisions: [], reviews: [], audit: [],
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

async function mount(
  detailValue: OpportunityDetail, api: Partial<SalesManagementApi>, onSaved: () => void = () => {},
): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <Toasty>
        <LineItemsSection detail={detailValue} api={api as unknown as RpcStub<SalesManagementApi>} onSaved={onSaved} />
      </Toasty>,
    );
    // useAsyncData's effect kicks off api.listProducts() and resolves it in a .then() outside this
    // callback's own synchronous body; flush a macrotask so that resolution lands inside act().
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

describe("LineItemsSection (D2)", () => {
  it("shows the empty-state message when the deal has no line items", async () => {
    const el = await mount(detail(), { listProducts: async () => [] });
    expect(el.textContent).toContain("明細はまだありません。見込金額は手入力のままです。");
  });

  it("renders existing rows with computed subtotal/tax/total", async () => {
    const d = detail({
      hasLineItems: true,
      lineItems: [
        lineItem({ id: "li1", name: "導入支援", quantity: 1, unitPrice: 300000, taxCategory: "STANDARD" }),
        lineItem({ id: "li2", name: "保守", quantity: 12, unitPrice: 10000, discountAmount: 20000, taxCategory: "STANDARD" }),
      ],
    });
    const el = await mount(d, { listProducts: async () => [] });
    const names = [...el.querySelectorAll<HTMLInputElement>("input")]
      .filter((input) => input.type !== "number")
      .map((input) => input.value);
    expect(names).toEqual(["導入支援", "保守"]);
    // subtotal = 300,000 + (120,000 - 20,000) = 400,000; tax (10% floor) = 40,000; total = 440,000
    expect(el.textContent).toContain("税抜合計: 400,000円");
    expect(el.textContent).toContain("消費税: 40,000円");
    expect(el.textContent).toContain("税込合計: 440,000円");
  });

  it("＋ 行を追加 adds a blank row; 削除 removes it", async () => {
    const el = await mount(detail(), { listProducts: async () => [] });
    expect(el.textContent).toContain("明細はまだありません");

    const addButton = [...el.querySelectorAll("button")].find((b) => b.textContent === "＋ 行を追加")!;
    await act(async () => {
      addButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.textContent).not.toContain("明細はまだありません");
    expect(el.querySelectorAll("select").length).toBeGreaterThan(0); // 品目/税区分 selects for the new row

    const removeButton = [...el.querySelectorAll("button")].find((b) => b.textContent === "削除")!;
    await act(async () => {
      removeButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.textContent).toContain("明細はまだありません");
  });

  it("保存 calls setLineItems with the tax-exclusive total and version, then onSaved fires", async () => {
    const d = detail({
      hasLineItems: true,
      version: 3,
      lineItems: [lineItem({ id: "li1", name: "導入支援", quantity: 1, unitPrice: 300000 })],
    });
    let savedArgs: unknown[] = [];
    let saved = false;
    const el = await mount(
      d,
      {
        listProducts: async () => [],
        setLineItems: async (...args: unknown[]) => {
          savedArgs = args;
          return d;
        },
      },
      () => { saved = true; },
    );

    const saveButton = [...el.querySelectorAll("button")].find((b) => b.textContent === "保存")!;
    await act(async () => {
      saveButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(savedArgs[0]).toBe("o1");
    expect(savedArgs[1]).toEqual([
      { productId: undefined, name: "導入支援", quantity: 1, unitPrice: 300000, discountAmount: 0, taxCategory: "STANDARD", sortOrder: 0 },
    ]);
    expect(savedArgs[2]).toBe(3);
    expect(saved).toBe(true);
  });
});
