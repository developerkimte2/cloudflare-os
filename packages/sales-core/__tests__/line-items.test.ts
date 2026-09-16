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
