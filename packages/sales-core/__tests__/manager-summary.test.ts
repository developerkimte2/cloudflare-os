import { describe, expect, it } from "vitest";
import { FakeLlmProvider } from "../src/ai/provider.js";
import { AuthorizationError } from "../src/service/sales-service.js";
import { newId } from "../src/domain/util.js";
import { makeAccount, makeOpportunity, makeService, makeUser } from "./helpers.js";
import type { NextAction, ReviewItem, SourceDocument } from "../src/domain/types.js";

// 2026-09-14T01:00:00Z is 2026-09-14T10:00 JST, a Monday in September.
const NOW = "2026-09-14T01:00:00Z";

describe("getManagerSummary: KPIs and per-rep table", () => {
  it("aggregates across reps and rejects a SALES caller", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const repo = svc.repo;
    const manager = makeUser(repo, "MANAGER");
    const taro = makeUser(repo, "SALES", { displayName: "太郎" });
    const hanako = makeUser(repo, "SALES", { displayName: "花子" });
    const account = makeAccount(repo, { displayName: "ABC株式会社" });
    const unresolvedAccount = makeAccount(repo, { displayName: "不明な会社", resolutionStatus: "UNRESOLVED" });

    // 太郎: one healthy OPEN deal with an amount, one long-stalled OPEN deal with no amount, one
    // overdue next action, and a capture from today.
    makeOpportunity(repo, account.id, taro.id, {
      expectedAmount: 1_000_000, lastMeaningfulActivityAt: NOW,
    });
    const stalledOpp = makeOpportunity(repo, account.id, taro.id, {
      lastMeaningfulActivityAt: "2026-01-01T00:00:00.000Z",
    });
    const overdueAction: NextAction = {
      id: newId(), opportunityId: stalledOpp.id, assignedUserId: taro.id, actionType: "CALL",
      title: "電話する", purpose: "状況確認", dueAt: "2026-09-01T00:00:00.000Z", priority: "NORMAL",
      status: "OPEN", generatedBy: "USER", createdAt: NOW, updatedAt: NOW,
    };
    repo.insertNextAction(overdueAction);
    const source: SourceDocument = {
      id: newId(), sourceType: "TEXT", submittedByUserId: taro.id, contentHash: newId(),
      receivedAt: NOW, processingStatus: "PROCESSED",
    };
    repo.insertSource(source);

    // 花子: one HIGH risk deal, one WON this month, one LOST last month (must not count), and an
    // open review assigned to her.
    makeOpportunity(repo, account.id, hanako.id, {
      expectedAmount: 500_000, riskLevel: "HIGH", lastMeaningfulActivityAt: NOW,
    });
    makeOpportunity(repo, account.id, hanako.id, {
      lifecycleState: "WON", updatedAt: "2026-09-10T00:00:00.000Z",
      closedAt: "2026-09-10", wonAmount: 300_000,
    });
    makeOpportunity(repo, account.id, hanako.id, {
      lifecycleState: "LOST", updatedAt: "2026-08-01T00:00:00.000Z",
      closedAt: "2026-08-01", lostReason: "PRICE",
    });
    const review: ReviewItem = {
      id: newId(), type: "OTHER", assignedUserId: hanako.id, question: "確認してください",
      sourceEvidenceIds: [], status: "OPEN", createdAt: NOW,
    };
    repo.insertReview(review);

    // An UNRESOLVED customer with an OPEN deal counts toward unresolvedCustomers; the account
    // itself has no rep-specific effect.
    makeOpportunity(repo, unresolvedAccount.id, taro.id, { lastMeaningfulActivityAt: NOW });

    const summary = svc.getManagerSummary({ userId: manager.id });

    expect(summary.kpis).toEqual({
      openOpportunities: 4, // 太郎2件 + 花子1件(HIGH) + 太郎の不明顧客1件。WON/LOSTはOPENに含まない
      expectedAmountTotal: 1_500_000,
      currency: "JPY",
      wonThisMonth: 1,
      wonAmountThisMonth: 300_000,
      lostThisMonth: 0,
      stalled: 1,
      highRisk: 1,
      overdueActions: 1,
      unresolvedCustomers: 1,
      openReviews: 1,
    });

    const byName = new Map(summary.perUser.map(r => [r.displayName, r]));
    expect(byName.get("太郎")).toEqual({
      userId: taro.id, displayName: "太郎", active: true,
      openOpportunities: 3, expectedAmountTotal: 1_000_000, overdueActions: 1, stalledOpportunities: 1,
      openReviews: 0, lastCaptureAt: NOW, capturesLast7Days: 1,
    });
    expect(byName.get("花子")).toEqual({
      userId: hanako.id, displayName: "花子", active: true,
      openOpportunities: 1, expectedAmountTotal: 500_000, overdueActions: 0, stalledOpportunities: 0,
      openReviews: 1, lastCaptureAt: undefined, capturesLast7Days: 0,
    });

    expect(() => svc.getManagerSummary({ userId: taro.id })).toThrow(AuthorizationError);
  });

  it("lists every inactive user after every active one", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const repo = svc.repo;
    const manager = makeUser(repo, "MANAGER");
    makeUser(repo, "SALES", { displayName: "乙", active: false });
    makeUser(repo, "SALES", { displayName: "甲" });

    const summary = svc.getManagerSummary({ userId: manager.id });
    const activeFlags = summary.perUser.map(r => r.active);
    const firstInactive = activeFlags.indexOf(false);
    expect(firstInactive).toBeGreaterThanOrEqual(0);
    expect(activeFlags.slice(firstInactive).every(a => a === false)).toBe(true);
  });
});
