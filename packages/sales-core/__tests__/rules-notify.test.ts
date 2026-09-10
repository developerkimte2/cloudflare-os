import { describe, expect, it } from "vitest";
import { buildMorningBrief, morningBriefMessageHash } from "../src/rules/notify.js";
import type { OpportunitySummary, TodayView } from "../src/api/dto.js";

function opportunity(overrides: Partial<OpportunitySummary> = {}): OpportunitySummary {
  return {
    id: "opp-1", title: "新機能提案", accountId: "acc-1", accountName: "ABC株式会社",
    accountResolutionStatus: "MANUAL", ownerUserId: "user-1", ownerName: "太郎",
    collaboratorUserIds: [], lifecycleState: "OPEN", operationalState: "ACTIVE",
    riskLevel: "MEDIUM", updatedAt: "2026-09-08T01:00:00Z", version: 1,
    ...overrides,
  };
}

function today(overrides: Partial<TodayView> = {}): TodayView {
  return {
    user: {
      id: "user-1", email: "taro@example.com", displayName: "太郎", role: "SALES",
      timezone: "Asia/Tokyo", active: true,
    },
    date: "2026-09-10", generatedAt: "2026-09-10T00:00:00Z",
    now: [], upcoming: [], undated: [], reviews: [], attention: [], recentCaptures: [],
    counts: { openOpportunities: 0, openActions: 0, overdue: 0, openReviews: 0 },
    ...overrides,
  };
}

describe("morningBriefMessageHash", () => {
  it("differs by date so a new day is never treated as a duplicate", () => {
    expect(morningBriefMessageHash("2026-09-10")).not.toBe(morningBriefMessageHash("2026-09-11"));
  });
});

describe("buildMorningBrief", () => {
  it("says nothing is outstanding when everything is empty", () => {
    const text = buildMorningBrief(today());
    expect(text).toContain("太郎さん");
    expect(text).toContain("2026-09-10");
    expect(text).toContain("今日は特に注意事項はありません。");
    expect(text).not.toContain("期限超過");
  });

  it("splits now[] into overdue vs. due-today sections by the overdue flag", () => {
    const text = buildMorningBrief(today({
      now: [
        {
          action: {
            id: "na-1", opportunityId: "opp-1", assignedUserId: "user-1", actionType: "CALL",
            title: "架電する", purpose: "確認", dueAt: "2026-09-09T09:00:00Z", priority: "HIGH",
            status: "OPEN", generatedBy: "USER", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
          },
          opportunity: opportunity(), overdue: true,
        },
        {
          action: {
            id: "na-2", opportunityId: "opp-1", assignedUserId: "user-1", actionType: "EMAIL",
            title: "見積送付", purpose: "提案", dueAt: "2026-09-10T18:00:00Z", priority: "NORMAL",
            status: "OPEN", generatedBy: "USER", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
          },
          opportunity: opportunity(), overdue: false,
        },
      ],
    }));
    expect(text).toContain("期限超過 (1件)");
    expect(text).toContain("架電する - ABC株式会社");
    expect(text).toContain("今日やること (1件)");
    expect(text).toContain("見積送付 - ABC株式会社");
    expect(text).not.toContain("今日は特に注意事項はありません。");
  });

  it("includes attention items with their message", () => {
    const text = buildMorningBrief(today({
      attention: [{ opportunity: opportunity({ accountName: "XYZ商事" }), kind: "STALLED", message: "7日間動きがありません" }],
    }));
    expect(text).toContain("注意案件 (1件)");
    expect(text).toContain("XYZ商事: 7日間動きがありません");
  });
});
