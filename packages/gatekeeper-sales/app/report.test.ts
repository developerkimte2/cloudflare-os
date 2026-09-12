import { describe, expect, it } from "vitest";
import type { OpportunityDetail } from "../src/management-types";
import { buildOpportunityReport } from "./report";

function opportunity(overrides: Partial<OpportunityDetail>): OpportunityDetail {
  return {
    id: "o1", title: "モバイルオーダー導入", accountId: "a1", accountName: "株式会社グリーンテーブル",
    accountResolutionStatus: "RESOLVED", ownerUserId: "u1", ownerName: "田中",
    collaboratorUserIds: [], lifecycleState: "OPEN", operationalState: "ACTIVE",
    riskLevel: "LOW", account: { id: "a1" } as OpportunityDetail["account"], persons: [],
    nextActions: [], commitments: [], activities: [], sources: [], decisions: [], reviews: [], audit: [],
    ...overrides,
  } as OpportunityDetail;
}

describe("buildOpportunityReport", () => {
  it("(a) fills every section from a fully-populated opportunity", () => {
    const text = buildOpportunityReport(
      opportunity({
        primaryContactName: "小林様",
        riskLevel: "HIGH",
        riskReason: "通信障害への回答が不安",
        nextAction: { id: "n1", title: "障害時運用資料を送付", dueAt: "2026-09-15T00:00:00.000Z" } as OpportunityDetail["nextAction"],
        lastMeaningfulActivityAt: "2026-09-08T00:00:00.000Z",
        expectedAmount: 1200000,
        currency: "JPY",
        expectedCloseDate: "2026-09-30",
        proposalDocumentUrl: "https://example.com/proposal",
        currentSituation: "通信障害時の運用を懸念されている",
      }),
      "Asia/Tokyo",
    );

    expect(text).toContain("【案件状況報告】株式会社グリーンテーブル様 モバイルオーダー導入");
    expect(text).toContain("■ 顧客窓口:    小林様");
    expect(text).toContain("■ 現在の状況:  順調に進行中");
    expect(text).toContain("■ リスク:      高（通信障害への回答が不安）");
    expect(text).toContain("■ 次のアクション: 障害時運用資料を送付");
    expect(text).toContain("■ 見込金額:     JPY 1,200,000");
    expect(text).toContain("■ 提案資料:     https://example.com/proposal");
    expect(text).toContain("■ 補足:");
    expect(text).toContain("通信障害時の運用を懸念されている");
  });

  it("(b) shows 未登録/なし/未設定 fallbacks when nothing is set", () => {
    const text = buildOpportunityReport(opportunity({}), "Asia/Tokyo");

    expect(text).toContain("■ 顧客窓口:    未登録");
    expect(text).toContain("■ 次のアクション: なし");
    expect(text).toContain("■ 見込金額:     未設定");
    expect(text).toContain("■ 受注予定日:   未設定");
    expect(text).toContain("■ 提案資料:     なし");
    expect(text).not.toContain("■ 補足:");
  });

  it("(c) reports won/lost/on-hold/closed lifecycle states instead of the operational state", () => {
    expect(buildOpportunityReport(opportunity({ lifecycleState: "WON" }), "Asia/Tokyo")).toContain(
      "■ 現在の状況:  受注",
    );
    expect(buildOpportunityReport(opportunity({ lifecycleState: "LOST" }), "Asia/Tokyo")).toContain(
      "■ 現在の状況:  失注",
    );
  });
});
