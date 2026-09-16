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
