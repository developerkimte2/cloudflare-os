import { describe, expect, it } from "vitest";
import { FakeLlmProvider } from "../src/ai/provider.js";
import { extractionJson, makeAccount, makeOpportunity, makeService } from "./helpers.js";

const NOW = "2026-09-08T01:00:00Z";

describe("pipeline/undo revertSource", () => {
  it("deletes an opportunity that was created by the source", async () => {
    const llm = new FakeLlmProvider([extractionJson({})]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const result = await svc.capture({ userId: user.id }, "初回の記録");
    const opportunityId = result.opportunity!.id;
    expect(svc.repo.getOpportunity(opportunityId)).toBeDefined();

    svc.revertCapture({ userId: user.id }, result.source.id);
    expect(svc.repo.getOpportunity(opportunityId)).toBeUndefined();
  });

  it("restores the opportunity's previous fields (expectedAmount/operationalState) when it pre-existed", async () => {
    const llm = new FakeLlmProvider([]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const account = makeAccount(svc.repo, { resolutionStatus: "RESOLVED" });
    svc.repo.insertPerson({
      id: "p1", accountId: account.id, displayName: "山田", email: "yamada@abc.co.jp",
      resolutionStatus: "RESOLVED", createdAt: NOW, updatedAt: NOW,
    });
    const opp = makeOpportunity(svc.repo, account.id, user.id, {
      operationalState: "ACTIVE", // no pre-existing expectedAmount, so the new one is auto-applied
    });
    llm.push(extractionJson({
      persons: [{ name: "山田", email: "yamada@abc.co.jp", confidence: 0.9 }],
      opportunity: { match: "EXISTING", existing_opportunity_id: opp.id, confidence: 0.95 },
      state: { operational_state: "WAITING_CUSTOMER", lifecycle_state: "OPEN", confidence: 0.95 },
      amounts: [{ kind: "QUOTE", amount: 900_000, currency: "JPY", evidence: "新見積", confidence: 0.97 }],
    }));

    const result = await svc.capture({ userId: user.id }, "新しい見積を提示した");
    expect(svc.repo.getOpportunity(opp.id)!.expectedAmount).toBe(900_000);
    expect(svc.repo.getOpportunity(opp.id)!.operationalState).toBe("WAITING_CUSTOMER");

    svc.revertCapture({ userId: user.id }, result.source.id);
    const restored = svc.repo.getOpportunity(opp.id)!;
    expect(restored.expectedAmount).toBeUndefined();
    expect(restored.operationalState).toBe("ACTIVE");
  });

  it("marks the source's AI decisions REVERTED", async () => {
    const llm = new FakeLlmProvider([extractionJson({})]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const result = await svc.capture({ userId: user.id }, "テキスト");
    expect(result.decisions.every(d => d.status !== "REVERTED")).toBe(true);

    svc.revertCapture({ userId: user.id }, result.source.id);
    for (const d of result.decisions) {
      const fresh = svc.repo.getDecision(d.id)!;
      expect(fresh.status).toBe("REVERTED");
    }
  });

  it("marks the source REVERTED and open reviews DISMISSED", async () => {
    const llm = new FakeLlmProvider([extractionJson({ accounts: [{ name: "新規株式会社", confidence: 0.9 }] })]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const result = await svc.capture({ userId: user.id }, "新規株式会社さんと話した");
    const reviewId = result.reviews[0]!.id;

    svc.revertCapture({ userId: user.id }, result.source.id);
    expect(svc.getCapture({ userId: user.id }, result.source.id).source.processingStatus).toBe("REVERTED");
    expect(svc.repo.getReview(reviewId)!.status).toBe("DISMISSED");
  });

  it("throws when reverting the same source twice", async () => {
    const llm = new FakeLlmProvider([extractionJson({})]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const result = await svc.capture({ userId: user.id }, "テキスト");
    svc.revertCapture({ userId: user.id }, result.source.id);
    expect(() => svc.revertCapture({ userId: user.id }, result.source.id)).toThrow();
  });
});
