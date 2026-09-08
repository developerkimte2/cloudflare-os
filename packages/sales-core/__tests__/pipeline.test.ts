import { describe, expect, it } from "vitest";
import { FakeLlmProvider } from "../src/ai/provider.js";
import { captureText, processSource } from "../src/pipeline/ingest.js";
import { AuthorizationError, NotFoundError } from "../src/service/sales-service.js";
import { addDays } from "../src/domain/util.js";
import { extractionJson, makeAccount, makeOpportunity, makeService, makeUser } from "./helpers.js";

const NOW = "2026-09-08T01:00:00Z"; // 2026-09-08T10:00 JST, a Tuesday

describe("Phase 0 acceptance criteria", () => {
  it("AC-001: free text alone produces an Activity", async () => {
    const llm = new FakeLlmProvider([extractionJson({ activity: { type: "MEETING", summary: "ABCと打合せ" } })]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const result = await svc.capture({ userId: user.id }, "ABCの山田さんと打合せをした");
    expect(result.activity?.type).toBe("MEETING");
    expect(result.activity?.summary).toBe("ABCと打合せ");
  });

  it("AC-002: AI output must pass JSON Schema validation before rules run (repair round works)", async () => {
    const llm = new FakeLlmProvider([
      "not json at all",
      extractionJson({}),
    ]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const receipt = await captureText(svc.ctx, { userId: user.id, text: "何かテキスト" });
    const result = await processSource(svc.ctx, receipt.sourceId);
    expect(result.repairs).toBe(1);
    expect(result.status).not.toBe("FAILED");
  });

  it("AC-003: an ambiguous customer is not auto-confirmed", async () => {
    const llm = new FakeLlmProvider([extractionJson({ accounts: [{ name: "新規株式会社", confidence: 0.9 }] })]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const result = await svc.capture({ userId: user.id }, "新規株式会社さんと話した");
    expect(result.source.processingStatus).toBe("REVIEW_REQUIRED");
    expect(result.reviews.map(r => r.type)).toContain("CUSTOMER_AMBIGUOUS");
    expect(result.opportunity?.accountResolutionStatus).toBe("UNRESOLVED");
  });

  it("AC-004: AI decisions can be traced back to their source", async () => {
    const llm = new FakeLlmProvider([extractionJson({})]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const result = await svc.capture({ userId: user.id }, "テキスト");
    expect(result.activity?.sourceId).toBe(result.source.id);
    expect(result.decisions.length).toBeGreaterThan(0);
    for (const d of result.decisions) expect(d.inputSourceIds).toContain(result.source.id);
    const detail = svc.getOpportunity({ userId: user.id }, result.opportunity!.id);
    expect(detail.sources.map(s => s.id)).toContain(result.source.id);
  });

  it("AC-005: a NextAction is generated", async () => {
    const llm = new FakeLlmProvider([extractionJson({
      next_actions: [{
        action_type: "CALL", title: "電話で確認", purpose: "状況確認",
        due_at: null, due_confidence: 0.5, priority: "NORMAL", confidence: 0.9,
      }],
    })]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const result = await svc.capture({ userId: user.id }, "テキスト");
    expect(result.nextActions).toHaveLength(1);
    expect(result.nextActions[0]!.title).toBe("電話で確認");
  });

  it("AC-006: the generated NextAction shows up in the Today view", async () => {
    const llm = new FakeLlmProvider([extractionJson({
      next_actions: [{
        action_type: "CALL", title: "電話で確認", purpose: "状況確認",
        due_at: null, due_confidence: 0.5, priority: "NORMAL", confidence: 0.9,
      }],
    })]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const result = await svc.capture({ userId: user.id }, "テキスト");
    const today = svc.getToday({ userId: user.id });
    const allActions = [...today.now, ...today.upcoming, ...today.undated];
    expect(allActions.some(a => a.action.id === result.nextActions[0]!.id)).toBe(true);
  });

  it("AC-007: AI changes are visible in the audit log", async () => {
    const llm = new FakeLlmProvider([extractionJson({})]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const result = await svc.capture({ userId: user.id }, "テキスト");
    const audit = svc.listAudit({ userId: user.id }, "opportunity", result.opportunity!.id);
    expect(audit.some(a => a.action === "OPPORTUNITY_CREATED")).toBe(true);
  });

  it("AC-008: AI decisions can be undone, and reviews can be resolved", async () => {
    const llm = new FakeLlmProvider([extractionJson({ accounts: [{ name: "新規株式会社", confidence: 0.9 }] })]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const result = await svc.capture({ userId: user.id }, "新規株式会社さんと話した");
    const review = result.reviews[0]!;
    svc.resolveReview({ userId: user.id }, review.id, { optionId: "new" });
    expect(svc.getCapture({ userId: user.id }, result.source.id).source.processingStatus).toBe("PROCESSED");

    svc.revertCapture({ userId: user.id }, result.source.id);
    expect(svc.listOpportunities({ userId: user.id })).toHaveLength(0);
  });

  it("AC-009: submitting the same source text twice does not duplicate the Activity", async () => {
    const llm = new FakeLlmProvider([extractionJson({})]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const first = await svc.capture({ userId: user.id }, "同じテキスト");
    const second = await svc.capture({ userId: user.id }, "同じテキスト");
    expect(second.duplicate).toBe(true);
    expect(llm.requests).toHaveLength(1);
    const activities = svc.repo.listActivitiesForOpportunity(first.opportunity!.id);
    expect(activities).toHaveLength(1);
  });

  it("AC-010: capture requires nothing but the raw text", async () => {
    const llm = new FakeLlmProvider([extractionJson({})]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const result = await svc.capture({ userId: user.id }, "テキストだけ投げ込む");
    expect(result.error).toBeUndefined();
  });
});

describe("customer / opportunity resolution scenarios", () => {
  it("an existing customer matched by email requires no review and stays resolved", async () => {
    const llm = new FakeLlmProvider([extractionJson({ persons: [{ name: "山田", email: "yamada@abc.co.jp", confidence: 0.9 }] })]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const account = makeAccount(svc.repo, { resolutionStatus: "RESOLVED" });
    svc.repo.insertPerson({
      id: "p1", accountId: account.id, displayName: "山田", email: "yamada@abc.co.jp",
      resolutionStatus: "RESOLVED", createdAt: NOW, updatedAt: NOW,
    });
    const result = await svc.capture({ userId: user.id }, "山田さんと話した");
    expect(result.source.processingStatus).toBe("PROCESSED");
    expect(result.reviews).toHaveLength(0);
    expect(result.opportunity?.accountId).toBe(account.id);
    expect(svc.getOpportunity({ userId: user.id }, result.opportunity!.id).account.resolutionStatus).toBe("RESOLVED");
  });

  it("reuses the single existing open opportunity for a resolved account", async () => {
    const llm = new FakeLlmProvider([extractionJson({
      persons: [{ name: "山田", email: "yamada@abc.co.jp", confidence: 0.9 }],
      opportunity: { match: "UNKNOWN", confidence: 0.5 },
    })]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const account = makeAccount(svc.repo, { resolutionStatus: "RESOLVED" });
    svc.repo.insertPerson({
      id: "p1", accountId: account.id, displayName: "山田", email: "yamada@abc.co.jp",
      resolutionStatus: "RESOLVED", createdAt: NOW, updatedAt: NOW,
    });
    const existingOpp = makeOpportunity(svc.repo, account.id, user.id, { title: "既存案件" });
    const result = await svc.capture({ userId: user.id }, "山田さんと話した");
    expect(result.opportunity?.id).toBe(existingOpp.id);
    expect(svc.listOpportunities({ userId: user.id })).toHaveLength(1);
  });

  it("two open opportunities create a new one plus an OPPORTUNITY_AMBIGUOUS review; resolving merges everything into the chosen opportunity", async () => {
    const llm = new FakeLlmProvider([extractionJson({
      persons: [{ name: "山田", email: "yamada@abc.co.jp", confidence: 0.9 }],
      commitments: [{
        side: "CUSTOMER", description: "回答する", due_at: null, due_confidence: 0.3,
        evidence: "評価", confidence: 0.9,
      }],
      next_actions: [{
        action_type: "CALL", title: "確認電話", purpose: "状況確認",
        due_at: null, due_confidence: 0.5, priority: "NORMAL", confidence: 0.9,
      }],
    })]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const account = makeAccount(svc.repo, { resolutionStatus: "RESOLVED" });
    svc.repo.insertPerson({
      id: "p1", accountId: account.id, displayName: "山田", email: "yamada@abc.co.jp",
      resolutionStatus: "RESOLVED", createdAt: NOW, updatedAt: NOW,
    });
    const oppA = makeOpportunity(svc.repo, account.id, user.id, { title: "案件A" });
    const oppB = makeOpportunity(svc.repo, account.id, user.id, { title: "案件B" });

    const result = await svc.capture({ userId: user.id }, "山田さんと話した");
    expect(result.source.processingStatus).toBe("REVIEW_REQUIRED");
    expect(result.reviews.map(r => r.type)).toEqual(["OPPORTUNITY_AMBIGUOUS"]);
    const freshOppId = result.opportunity!.id;
    expect([oppA.id, oppB.id]).not.toContain(freshOppId);
    expect(svc.listOpportunities({ userId: user.id })).toHaveLength(3);

    const review = result.reviews[0]!;
    const chooseOption = review.optionsJson!.find(o => o.id === `opportunity:${oppA.id}`)!;
    svc.resolveReview({ userId: user.id }, review.id, { optionId: chooseOption.id });

    expect(svc.repo.getOpportunity(freshOppId)).toBeUndefined();
    expect(svc.listOpportunities({ userId: user.id })).toHaveLength(2);
    const mergedActivities = svc.repo.listActivitiesForOpportunity(oppA.id);
    expect(mergedActivities).toHaveLength(1);
    const mergedCommitments = svc.repo.listCommitmentsForOpportunity(oppA.id);
    expect(mergedCommitments).toHaveLength(1);
    const mergedActions = svc.repo.listNextActionsForOpportunity(oppA.id);
    expect(mergedActions).toHaveLength(1);
  });

  it("not_sales_related input is PROCESSED with no opportunity created", async () => {
    const llm = new FakeLlmProvider([extractionJson({ not_sales_related: true, activity: { type: "NOTE", summary: "雑談" } })]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const result = await svc.capture({ userId: user.id }, "こんにちは、元気ですか");
    expect(result.source.processingStatus).toBe("PROCESSED");
    expect(result.notSalesRelated).toBe(true);
    expect(result.opportunity).toBeUndefined();
    expect(svc.listOpportunities({ userId: user.id })).toHaveLength(0);
  });
});

describe("state and date review flows", () => {
  it("a WON proposal creates a STATE_AMBIGUOUS review; confirming it sets WON", async () => {
    const llm = new FakeLlmProvider([]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const account = makeAccount(svc.repo, { resolutionStatus: "RESOLVED" });
    svc.repo.insertPerson({
      id: "p1", accountId: account.id, displayName: "山田", email: "yamada@abc.co.jp",
      resolutionStatus: "RESOLVED", createdAt: NOW, updatedAt: NOW,
    });
    const opp = makeOpportunity(svc.repo, account.id, user.id);
    llm.push(extractionJson({
      persons: [{ name: "山田", email: "yamada@abc.co.jp", confidence: 0.9 }],
      opportunity: { match: "EXISTING", existing_opportunity_id: opp.id, confidence: 0.95 },
      state: { operational_state: "CONTRACTING", lifecycle_state: "WON", confidence: 0.98 },
    }));

    const result = await svc.capture({ userId: user.id }, "受注確定です！");
    expect(result.source.processingStatus).toBe("REVIEW_REQUIRED");
    const review = result.reviews.find(r => r.type === "STATE_AMBIGUOUS")!;
    expect(review).toBeDefined();
    expect(svc.repo.getOpportunity(opp.id)!.lifecycleState).toBe("OPEN");

    svc.resolveReview({ userId: user.id }, review.id, { optionId: "confirm" });
    expect(svc.repo.getOpportunity(opp.id)!.lifecycleState).toBe("WON");
  });

  it("DATE_AMBIGUOUS with needsInput is resolved by supplying input.dueAt", async () => {
    const llm = new FakeLlmProvider([extractionJson({
      commitments: [{
        side: "CUSTOMER", description: "来週回答", due_at: "2026-09-15T18:00:00+09:00",
        due_confidence: 0.5, evidence: "来週には回答する", confidence: 0.9,
      }],
    })]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const result = await svc.capture({ userId: user.id }, "来週には回答するとのこと");
    expect(result.commitments[0]!.dueAt).toBeUndefined();
    const review = result.reviews.find(r => r.type === "DATE_AMBIGUOUS")!;
    expect(review).toBeDefined();
    const setOption = review.optionsJson!.find(o => o.id === "set")!;

    svc.resolveReview({ userId: user.id }, review.id, {
      optionId: setOption.id, input: { dueAt: "2026-09-19T18:00:00+09:00" },
    });
    const commitment = svc.repo.getCommitment(result.commitments[0]!.id)!;
    expect(commitment.dueAt).toBe(new Date("2026-09-19T18:00:00+09:00").toISOString());
  });
});

describe("failure handling", () => {
  it("an LLM failure marks the source FAILED with an error, and retryCapture can recover it", async () => {
    const llm = new FakeLlmProvider([]); // no scripted response: every complete() throws
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const result = await svc.capture({ userId: user.id }, "テキスト");
    expect(result.source.processingStatus).toBe("FAILED");
    expect(result.error).toBeDefined();

    llm.push(extractionJson({}));
    const retried = await svc.retryCapture({ userId: user.id }, result.source.id);
    expect(retried.source.processingStatus).not.toBe("FAILED");
    expect(retried.error).toBeUndefined();
    expect(retried.activity).toBeDefined();
  });
});

describe("recompute", () => {
  it("produces a new snapshot and applies the operational state from the context skill output", async () => {
    const llm = new FakeLlmProvider([extractionJson({})]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const captured = await svc.capture({ userId: user.id }, "初回の記録");
    const opportunityId = captured.opportunity!.id;

    llm.push({
      current_situation: "再計算後の状況", latest_development: "新しい進展",
      customer_intent: "前向き", decided: ["価格合意"], unresolved: ["契約日"],
      risks: [], recommended_actions: [],
      operational_state: "ACTIVE", state_confidence: 0.95, confidence: 0.95,
    });
    const snapshot = await svc.recompute({ userId: user.id }, opportunityId);
    expect(snapshot.currentSituation).toBe("再計算後の状況");
    expect(svc.repo.getOpportunity(opportunityId)!.operationalState).toBe("ACTIVE");
  });
});

describe("authorization", () => {
  it("a SALES user cannot see another SALES user's opportunity", async () => {
    const llm = new FakeLlmProvider([]);
    const svc = makeService(llm, NOW);
    const owner = makeUser(svc.repo, "SALES");
    const stranger = makeUser(svc.repo, "SALES");
    const account = makeAccount(svc.repo);
    const opp = makeOpportunity(svc.repo, account.id, owner.id);
    expect(() => svc.getOpportunity({ userId: stranger.id }, opp.id)).toThrow(NotFoundError);
    expect(() => svc.getOpportunity({ userId: owner.id }, opp.id)).not.toThrow();
  });

  it("a SALES user cannot updateConfig", () => {
    const llm = new FakeLlmProvider([]);
    const svc = makeService(llm, NOW);
    const sales = makeUser(svc.repo, "SALES");
    expect(() => svc.updateConfig({ userId: sales.id }, { stalledDays: 3 })).toThrow(AuthorizationError);
  });

  it("a MANAGER sees opportunities owned by any SALES user", () => {
    const llm = new FakeLlmProvider([]);
    const svc = makeService(llm, NOW);
    const salesA = makeUser(svc.repo, "SALES");
    const salesB = makeUser(svc.repo, "SALES");
    const manager = makeUser(svc.repo, "MANAGER");
    const account = makeAccount(svc.repo);
    makeOpportunity(svc.repo, account.id, salesA.id);
    makeOpportunity(svc.repo, account.id, salesB.id);
    expect(svc.listOpportunities({ userId: manager.id })).toHaveLength(2);
  });
});

describe("getToday bucketing", () => {
  it("buckets actions into now (overdue/due today), upcoming, and undated", () => {
    const llm = new FakeLlmProvider([]);
    const svc = makeService(llm, NOW);
    const user = makeUser(svc.repo, "SALES");
    const account = makeAccount(svc.repo);
    const opp = makeOpportunity(svc.repo, account.id, user.id);

    const overdue = { id: "a-overdue", opportunityId: opp.id, assignedUserId: user.id,
      actionType: "CALL" as const, title: "overdue", purpose: "p", dueAt: "2026-09-07T00:00:00.000Z",
      priority: "NORMAL" as const, status: "OPEN" as const, generatedBy: "AI" as const,
      createdAt: NOW, updatedAt: NOW };
    const dueToday = { ...overdue, id: "a-today", title: "today", dueAt: "2026-09-08T10:00:00.000Z" };
    const dueSoon = { ...overdue, id: "a-soon", title: "soon", dueAt: addDays(NOW, 3) };
    const undated = { ...overdue, id: "a-undated", title: "undated", dueAt: undefined };

    for (const a of [overdue, dueToday, dueSoon, undated]) svc.repo.insertNextAction(a);

    const today = svc.getToday({ userId: user.id });
    expect(today.now.map(a => a.action.id).sort()).toEqual(["a-overdue", "a-today"].sort());
    expect(today.now.find(a => a.action.id === "a-overdue")!.overdue).toBe(true);
    expect(today.now.find(a => a.action.id === "a-today")!.overdue).toBe(false);
    expect(today.upcoming.map(a => a.action.id)).toEqual(["a-soon"]);
    expect(today.undated.map(a => a.action.id)).toEqual(["a-undated"]);
  });

  it("flags STALLED opportunities once past stalledDays, and COMMITMENT_OVERDUE for overdue commitments", () => {
    const llm = new FakeLlmProvider([]);
    const svc = makeService(llm, NOW);
    const user = makeUser(svc.repo, "SALES");
    const account = makeAccount(svc.repo);
    const stalledOpp = makeOpportunity(svc.repo, account.id, user.id, {
      title: "放置案件", lastMeaningfulActivityAt: addDays(NOW, -8), // stalledDays default = 7
    });
    const freshOpp = makeOpportunity(svc.repo, account.id, user.id, {
      title: "最近動いた案件", lastMeaningfulActivityAt: addDays(NOW, -1),
    });
    svc.repo.insertCommitment({
      id: "c1", opportunityId: freshOpp.id, side: "CUSTOMER", description: "回答する",
      dueAt: addDays(NOW, -2), status: "OPEN", sourceEvidenceId: "ev1", createdAt: NOW, updatedAt: NOW,
    });

    const today = svc.getToday({ userId: user.id });
    expect(today.attention.some(a => a.kind === "STALLED" && a.opportunity.id === stalledOpp.id)).toBe(true);
    expect(today.attention.some(a => a.kind === "STALLED" && a.opportunity.id === freshOpp.id)).toBe(false);
    expect(today.attention.some(a => a.kind === "COMMITMENT_OVERDUE" && a.opportunity.id === freshOpp.id)).toBe(true);
  });
});
