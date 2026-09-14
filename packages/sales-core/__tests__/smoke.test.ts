import { describe, expect, it } from "vitest";
import { NodeSqliteExecutor } from "../src/db/node-sqlite.js";
import {
  FakeLlmProvider, Repository, SalesService, fixedClock, loadConfig, migrate, type CoreContext,
} from "../src/index.js";

function makeService(llm: FakeLlmProvider, now = "2026-09-08T01:00:00Z") {
  const db = new NodeSqliteExecutor();
  migrate(db);
  const repo = new Repository(db);
  const ctx: CoreContext = { repo, llm, config: loadConfig(repo), clock: fixedClock(now) };
  return new SalesService(ctx);
}

const EXTRACTION = {
  entities: {
    account_candidates: [{ name: "ABC株式会社", confidence: 0.95 }],
    person_candidates: [{ name: "山田", company: "ABC株式会社", confidence: 0.9 }],
  },
  opportunity: { match: "NEW", title: "ABC株式会社 新サービス導入", confidence: 0.9 },
  activity: {
    type: "MEETING", occurred_at: "2026-09-08T10:00:00+09:00",
    summary: "新サービス提案を実施。100万円提示、社内稟議待ち。", confidence: 0.95,
  },
  facts: [{ fact: "提示価格は100万円", evidence: "100万はOK", confidence: 0.99 }],
  decisions: [],
  unresolved: ["契約開始日"],
  questions: [], objections: [],
  commitments: [{
    side: "CUSTOMER", description: "金曜日までに社内承認結果を回答",
    due_at: "2026-09-11T18:00:00+09:00", due_confidence: 0.97, evidence: "金曜に社内承認が出る", confidence: 0.97,
  }],
  amounts: [{ kind: "QUOTE", amount: 1000000, currency: "JPY", evidence: "100万はOK", confidence: 0.99 }],
  state: { operational_state: "WAITING_CUSTOMER", lifecycle_state: "OPEN", confidence: 0.93 },
  next_actions: [{
    action_type: "CALL", title: "月曜に稟議結果を電話で確認", purpose: "契約可否と次工程を確定",
    due_at: "2026-09-14T10:00:00+09:00", due_confidence: 0.95, priority: "NORMAL", confidence: 0.95,
  }],
  risk: { level: "LOW", reason: null, confidence: 0.84 },
  context: {
    current_situation: "100万円提示済み、社内稟議待ち",
    latest_development: "顧客は条件を了承し稟議へ",
    customer_intent: "前向き",
  },
  not_sales_related: false,
};

describe("smoke: capture → extraction → today", () => {
  it("creates opportunity, activity, commitment, next action and review for a new customer", async () => {
    const llm = new FakeLlmProvider([EXTRACTION]);
    const svc = makeService(llm);
    const user = svc.registerIdentity("test", "acct-1", { email: "kimura@example.com", displayName: "木村" });
    expect(user.role).toBe("ADMIN");

    const result = await svc.capture({ userId: user.id },
      "今日ABCの山田さんと話して、100万はOK。金曜に社内承認が出る。通れば来週契約。月曜に電話する。");
    expect(result.error).toBeUndefined();
    expect(result.source.processingStatus).toBe("REVIEW_REQUIRED"); // new customer → CUSTOMER_AMBIGUOUS
    expect(result.opportunity?.title).toBe("ABC株式会社 新サービス導入");
    expect(result.opportunity?.operationalState).toBe("WAITING_CUSTOMER");
    expect(result.opportunity?.expectedAmount).toBe(1000000);
    expect(result.activity?.type).toBe("MEETING");
    expect(result.commitments).toHaveLength(1);
    expect(result.commitments[0]!.dueAt).toBe("2026-09-11T09:00:00.000Z");
    expect(result.nextActions).toHaveLength(1);
    expect(result.reviews.map(r => r.type)).toEqual(["CUSTOMER_AMBIGUOUS"]);
    expect(llm.requests[0]!.user).toContain("=== SOURCE ===");

    const today = svc.getToday({ userId: user.id });
    expect(today.upcoming).toHaveLength(1);
    expect(today.reviews).toHaveLength(1);
    expect(today.attention.some(a => a.kind === "UNRESOLVED_CUSTOMER")).toBe(true);

    // Resolve the customer review as a new account → source becomes PROCESSED.
    const review = today.reviews[0]!;
    await svc.resolveReview({ userId: user.id }, review.id, { optionId: "new" });
    expect(svc.getCapture({ userId: user.id }, result.source.id).source.processingStatus).toBe("PROCESSED");
    const detail = svc.getOpportunity({ userId: user.id }, result.opportunity!.id);
    expect(detail.account.resolutionStatus).toBe("MANUAL");
    expect(detail.context?.currentSituation).toContain("稟議待ち");

    // Duplicate capture is a no-op.
    const dup = await svc.capture({ userId: user.id },
      "今日ABCの山田さんと話して、100万はOK。金曜に社内承認が出る。通れば来週契約。月曜に電話する。");
    expect(dup.duplicate).toBe(true);
    expect(llm.requests).toHaveLength(1);

    // Undo removes everything the source produced.
    svc.revertCapture({ userId: user.id }, result.source.id);
    expect(svc.listOpportunities({ userId: user.id })).toHaveLength(0);
    expect(svc.getToday({ userId: user.id }).upcoming).toHaveLength(0);
  });
});
