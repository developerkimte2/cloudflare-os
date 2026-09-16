import { describe, expect, it } from "vitest";
import { FakeLlmProvider } from "../src/ai/provider.js";
import { addDays } from "../src/domain/util.js";
import { makeAccount, makeOpportunity, makeService, makeUser } from "./helpers.js";

const NOW = "2026-09-08T01:00:00Z";

describe("getOpportunity: accountSummary (企業サマリ on the deal page)", () => {
  it("counts only this account's OPEN deals visible to the caller, summing expected amounts", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const owner = makeUser(svc.repo, "SALES");
    const other = makeUser(svc.repo, "SALES");
    const account = makeAccount(svc.repo);
    const otherAccount = makeAccount(svc.repo, { displayName: "別会社" });
    const target = makeOpportunity(svc.repo, account.id, owner.id, { expectedAmount: 100_000, lastMeaningfulActivityAt: NOW });
    makeOpportunity(svc.repo, account.id, owner.id, { expectedAmount: 200_000, lastMeaningfulActivityAt: NOW });
    // Not counted: WON (closed), a different account, and a deal owned by someone else that
    // `owner` (SALES) cannot see.
    makeOpportunity(svc.repo, account.id, owner.id, { lifecycleState: "WON", closedAt: "2026-09-01", wonAmount: 999_999 });
    makeOpportunity(svc.repo, otherAccount.id, owner.id, { expectedAmount: 999_999 });
    makeOpportunity(svc.repo, account.id, other.id, { expectedAmount: 999_999 });

    const detail = svc.getOpportunity({ userId: owner.id }, target.id);
    expect(detail.accountSummary).toEqual({
      openCount: 2, expectedAmountTotal: 300_000, currency: "JPY", stalledCount: 0, highRiskCount: 0,
    });
  });

  it("flags stalled and high-risk deals the same way the team page does", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const manager = makeUser(svc.repo, "MANAGER");
    const account = makeAccount(svc.repo);
    const target = makeOpportunity(svc.repo, account.id, manager.id, { lastMeaningfulActivityAt: NOW });
    makeOpportunity(svc.repo, account.id, manager.id, {
      lastMeaningfulActivityAt: addDays(NOW, -30), riskLevel: "HIGH",
    });

    const detail = svc.getOpportunity({ userId: manager.id }, target.id);
    expect(detail.accountSummary.openCount).toBe(2);
    expect(detail.accountSummary.stalledCount).toBe(1);
    expect(detail.accountSummary.highRiskCount).toBe(1);
  });

  it("is zero for a customer's only (and this) deal", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const user = makeUser(svc.repo, "SALES");
    const account = makeAccount(svc.repo);
    const opp = makeOpportunity(svc.repo, account.id, user.id, { expectedAmount: 50_000, lastMeaningfulActivityAt: NOW });

    const detail = svc.getOpportunity({ userId: user.id }, opp.id);
    expect(detail.accountSummary).toEqual({
      openCount: 1, expectedAmountTotal: 50_000, currency: "JPY", stalledCount: 0, highRiskCount: 0,
    });
  });
});
