import { describe, expect, it } from "vitest";
import { FakeLlmProvider } from "../src/ai/provider.js";
import { captureText, processPending, processSource } from "../src/pipeline/ingest.js";
import { AuthorizationError, NotFoundError } from "../src/service/sales-service.js";
import { addDays, newId } from "../src/domain/util.js";
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
    // The gatekeeper-sales UI reads decisions[].modelName straight through as "provider/model"
    // (AiAttribution) — pin the format so a provider.ts change can't silently break the display.
    expect(result.decisions[0]!.modelName).toBe("fake/fake-model");
    const detail = svc.getOpportunity({ userId: user.id }, result.opportunity!.id);
    expect(detail.sources.map(s => s.id)).toContain(result.source.id);
    // AIContextSnapshot.modelName is also already "provider/model" — same UI assumption.
    expect(detail.context?.modelName).toBe("fake/fake-model");
    expect(detail.context?.modelProvider).toBe("fake");
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
    await svc.resolveReview({ userId: user.id }, review.id, { optionId: "new" });
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
    await svc.resolveReview({ userId: user.id }, review.id, { optionId: chooseOption.id });

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

    await svc.resolveReview({ userId: user.id }, review.id, { optionId: "confirm" });
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

    await svc.resolveReview({ userId: user.id }, review.id, {
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

describe("processPending (alarm-driven queue)", () => {
  it("drains RECEIVED sources oldest-first, leaves a failure as FAILED, and reports no remaining", async () => {
    const llm = new FakeLlmProvider([extractionJson({}), extractionJson({})]); // 2 of 3 succeed
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const first = await captureText(svc.ctx, { userId: user.id, text: "1件目" });
    const second = await captureText(svc.ctx, { userId: user.id, text: "2件目" });
    const third = await captureText(svc.ctx, { userId: user.id, text: "3件目" }); // no response left for this one
    expect(svc.repo.getSource(first.sourceId)!.processingStatus).toBe("RECEIVED"); // captureText alone never processes

    const result = await processPending(svc.ctx);
    expect(result.processed).toEqual([first.sourceId, second.sourceId, third.sourceId]);
    expect(result.remaining).toBe(0);
    expect(svc.repo.getSource(first.sourceId)!.processingStatus).not.toBe("RECEIVED");
    expect(svc.repo.getSource(second.sourceId)!.processingStatus).not.toBe("RECEIVED");
    expect(svc.repo.getSource(third.sourceId)!.processingStatus).toBe("FAILED");
  });

  it("does not pick up a FAILED source — that still needs an explicit retryCapture", async () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const failed = await svc.capture({ userId: user.id }, "テキスト");
    expect(failed.source.processingStatus).toBe("FAILED");

    const result = await processPending(svc.ctx);
    expect(result.processed).toEqual([]);
    expect(svc.repo.getSource(failed.source.id)!.processingStatus).toBe("FAILED");
  });

  it("respects limit and reports how many are still waiting", async () => {
    const llm = new FakeLlmProvider([extractionJson({}), extractionJson({})]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const first = await captureText(svc.ctx, { userId: user.id, text: "1件目" });
    await captureText(svc.ctx, { userId: user.id, text: "2件目" });

    const result = await processPending(svc.ctx, 1);
    expect(result.processed).toEqual([first.sourceId]);
    expect(result.remaining).toBe(1);
  });

  it("a source already PROCESSING (mid-flight) is not picked up again", async () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const receipt = await captureText(svc.ctx, { userId: user.id, text: "テキスト" });
    const source = svc.repo.getSource(receipt.sourceId)!;
    svc.repo.updateSource({ ...source, processingStatus: "PROCESSING" });

    const result = await processPending(svc.ctx);
    expect(result.processed).toEqual([]);
    expect(result.remaining).toBe(0); // PROCESSING is not RECEIVED, so it isn't "waiting" either
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

  it("hides a snoozed action until snoozedUntil, and un-snoozing clears the wake-up time", () => {
    const llm = new FakeLlmProvider([]);
    const svc = makeService(llm, NOW);
    const user = makeUser(svc.repo, "SALES");
    const account = makeAccount(svc.repo);
    const opp = makeOpportunity(svc.repo, account.id, user.id);
    const base = { opportunityId: opp.id, assignedUserId: user.id, actionType: "CALL" as const,
      purpose: "p", dueAt: "2026-09-07T00:00:00.000Z", priority: "NORMAL" as const,
      status: "OPEN" as const, generatedBy: "USER" as const, createdAt: NOW, updatedAt: NOW };
    svc.repo.insertNextAction({ ...base, id: "a-sleep", title: "sleeping" });
    svc.repo.insertNextAction({ ...base, id: "a-woke", title: "woken" });

    svc.updateNextAction({ userId: user.id }, "a-sleep", { status: "SNOOZED", snoozedUntil: addDays(NOW, 2) });
    svc.updateNextAction({ userId: user.id }, "a-woke", { status: "SNOOZED", snoozedUntil: addDays(NOW, -1) });

    const today = svc.getToday({ userId: user.id });
    expect(today.now.map(a => a.action.id)).toEqual(["a-woke"]);
    expect(today.counts).toMatchObject({ openActions: 1, overdue: 1, snoozed: 1 });

    const reopened = svc.updateNextAction({ userId: user.id }, "a-sleep", { status: "OPEN" });
    expect(reopened.snoozedUntil).toBeUndefined();
    expect(svc.repo.getNextAction("a-sleep")!.snoozedUntil).toBeUndefined();
    expect(svc.getToday({ userId: user.id }).counts.snoozed).toBe(0);
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

describe("next-action suggestions (below nextActionAutoConfidence)", () => {
  const lowConfidenceExtraction = extractionJson({
    next_actions: [{
      action_type: "CALL", title: "電話で確認", purpose: "状況確認",
      due_at: null, due_confidence: 0.5, priority: "HIGH", confidence: 0.7, // < nextActionAutoConfidence (0.85)
    }],
  });

  it("capture() surfaces a below-threshold proposal as a suggestion instead of discarding it", async () => {
    const llm = new FakeLlmProvider([lowConfidenceExtraction]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });

    const result = await svc.capture({ userId: user.id }, "テキスト");
    expect(result.nextActions).toHaveLength(0);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({ title: "電話で確認", purpose: "状況確認", priority: "HIGH", confidence: 0.7 });

    const detail = svc.getOpportunity({ userId: user.id }, result.opportunity!.id);
    expect(detail.suggestions).toHaveLength(1);
    expect(detail.suggestions[0]!.decisionId).toBe(result.suggestions[0]!.decisionId);
  });

  it("adoptSuggestion creates a real NextAction and removes it from suggestions", async () => {
    const llm = new FakeLlmProvider([lowConfidenceExtraction]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const result = await svc.capture({ userId: user.id }, "テキスト");
    const suggestion = result.suggestions[0]!;

    const adopted = svc.adoptSuggestion({ userId: user.id }, suggestion.decisionId, suggestion.index);
    expect(adopted).toMatchObject({
      title: "電話で確認", generatedBy: "AI", status: "OPEN", sourceDecisionId: suggestion.decisionId,
    });

    const detail = svc.getOpportunity({ userId: user.id }, result.opportunity!.id);
    expect(detail.nextActions.map(a => a.id)).toContain(adopted.id);
    expect(detail.suggestions).toHaveLength(0);

    // Adopting the same suggestion twice is refused, not silently duplicated.
    expect(() => svc.adoptSuggestion({ userId: user.id }, suggestion.decisionId, suggestion.index)).toThrow();
  });

  it("dismissSuggestion removes it without creating a NextAction", async () => {
    const llm = new FakeLlmProvider([lowConfidenceExtraction]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const result = await svc.capture({ userId: user.id }, "テキスト");
    const suggestion = result.suggestions[0]!;

    svc.dismissSuggestion({ userId: user.id }, suggestion.decisionId, suggestion.index);

    const detail = svc.getOpportunity({ userId: user.id }, result.opportunity!.id);
    expect(detail.suggestions).toHaveLength(0);
    expect(detail.nextActions).toHaveLength(0);
  });

  it("refuses to adopt/dismiss a suggestion on an opportunity the caller cannot see", async () => {
    const llm = new FakeLlmProvider([lowConfidenceExtraction]);
    const svc = makeService(llm, NOW);
    const owner = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const outsider = makeUser(svc.repo, "SALES");
    const result = await svc.capture({ userId: owner.id }, "テキスト");
    const suggestion = result.suggestions[0]!;

    expect(() => svc.adoptSuggestion({ userId: outsider.id }, suggestion.decisionId, suggestion.index)).toThrow(NotFoundError);
    expect(() => svc.dismissSuggestion({ userId: outsider.id }, suggestion.decisionId, suggestion.index)).toThrow(NotFoundError);
  });
});

describe("pinned capture (CaptureOptions.opportunityId)", () => {
  it("skips customer/deal resolution entirely and attaches the activity to that opportunity", async () => {
    const llm = new FakeLlmProvider([extractionJson({
      // Deliberately mentions an unrelated company — pinning must ignore it, not create a second
      // opportunity or ask which customer this is.
      accounts: [{ name: "全然別の会社", confidence: 0.9 }],
      opportunity: { match: "NEW", confidence: 0.9 },
    })]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const actor = { userId: user.id };
    const account = makeAccount(svc.repo);
    const opp = makeOpportunity(svc.repo, account.id, user.id, { title: "既存案件" });

    const result = await svc.capture(actor, "来週訪問予定。詳細は未定。", { opportunityId: opp.id });
    expect(result.source.processingStatus).not.toBe("REVIEW_REQUIRED");
    expect(result.opportunity?.id).toBe(opp.id);
    expect(result.activity?.opportunityId).toBe(opp.id);
    expect(result.reviews.some(r => r.type === "CUSTOMER_AMBIGUOUS" || r.type === "MEMO_TARGET")).toBe(false);
    expect(svc.listOpportunities(actor)).toHaveLength(1); // no second opportunity created
    const pinDecision = result.decisions.find(d => d.decisionType === "OPPORTUNITY_RESOLUTION")!;
    expect(pinDecision.reasoningSummary).toContain("宛先指定");
  });

  it("rejects an opportunityId the caller cannot see", async () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const owner = makeUser(svc.repo, "SALES");
    const outsider = makeUser(svc.repo, "SALES");
    const account = makeAccount(svc.repo);
    const opp = makeOpportunity(svc.repo, account.id, owner.id);

    await expect(svc.capture({ userId: outsider.id }, "メモ", { opportunityId: opp.id })).rejects.toThrow(NotFoundError);
  });
});

describe("MEMO_TARGET: a person is mentioned but there is no company signal at all", () => {
  it("no opportunity/customer placeholder is created; the review asks which deal instead", async () => {
    const llm = new FakeLlmProvider([extractionJson({
      // The extractor did the 2026-09-14-observed thing: echoed a "company unknown" phrase back
      // as the company. looksLikeCompanyName strips it before resolution ever sees it, so this
      // capture ends up with a person but no company signal at all — exactly MEMO_TARGET's trigger.
      accounts: [{ name: "会社名は聞きそびれた", confidence: 0.6 }],
      persons: [{ name: "鈴木", confidence: 0.6 }],
      opportunity: { match: "NEW", confidence: 0.6 },
    })]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });

    const text = "新規のお問い合わせ。会社名は聞きそびれた。担当者名は鈴木さん。";
    const result = await svc.capture({ userId: user.id }, text);
    expect(result.source.processingStatus).toBe("REVIEW_REQUIRED");
    expect(result.opportunity).toBeUndefined();
    expect(result.activity).toBeUndefined();
    expect(svc.listOpportunities({ userId: user.id })).toHaveLength(0);

    const review = result.reviews.find(r => r.type === "MEMO_TARGET")!;
    expect(review).toBeDefined();
    // The memo itself is quoted verbatim (so it naturally still contains the rep's own words) — what
    // must NOT happen is the system asserting that phrase as a determined company name.
    expect(review.question).toBe(`メモ「${text}」はどの案件の話ですか？`);
    expect(review.optionsJson!.map(o => o.id)).toEqual(["memo"]); // no existing open opportunities yet
  });

  it("offers the user's own recently-updated open opportunities as candidates", async () => {
    const llm = new FakeLlmProvider([extractionJson({
      persons: [{ name: "鈴木", confidence: 0.6 }],
      opportunity: { match: "NEW", confidence: 0.6 },
    })]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const account = makeAccount(svc.repo);
    const opp = makeOpportunity(svc.repo, account.id, user.id, { title: "既存案件" });

    const result = await svc.capture({ userId: user.id }, "鈴木さんから電話。詳細は未定。");
    const review = result.reviews.find(r => r.type === "MEMO_TARGET")!;
    expect(review.optionsJson!.map(o => o.id)).toEqual([`opportunity:${opp.id}`, "memo"]);
  });

  it("resolving with 'memo' keeps the source as a note, attached to nothing", async () => {
    const llm = new FakeLlmProvider([extractionJson({
      persons: [{ name: "鈴木", confidence: 0.6 }],
      opportunity: { match: "NEW", confidence: 0.6 },
    })]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const actor = { userId: user.id };

    const result = await svc.capture(actor, "鈴木さんから電話。詳細は未定。");
    const review = result.reviews.find(r => r.type === "MEMO_TARGET")!;
    await svc.resolveReview(actor, review.id, { optionId: "memo" });

    expect(svc.getCapture(actor, result.source.id).source.processingStatus).toBe("PROCESSED");
    expect(svc.listOpportunities(actor)).toHaveLength(0);
  });

  it("resolving with an existing opportunity reprocesses the memo pinned to it", async () => {
    const llm = new FakeLlmProvider([
      extractionJson({ persons: [{ name: "鈴木", confidence: 0.6 }], opportunity: { match: "NEW", confidence: 0.6 } }),
      extractionJson({ next_actions: [{
        action_type: "CALL", title: "折り返し電話", purpose: "詳細確認",
        due_at: null, due_confidence: 0.3, priority: "NORMAL", confidence: 0.9,
      }] }),
    ]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const actor = { userId: user.id };
    const account = makeAccount(svc.repo);
    const opp = makeOpportunity(svc.repo, account.id, user.id, { title: "既存案件" });

    const result = await svc.capture(actor, "鈴木さんから電話。詳細は未定。");
    const review = result.reviews.find(r => r.type === "MEMO_TARGET")!;
    await svc.resolveReview(actor, review.id, { optionId: `opportunity:${opp.id}` });

    const reprocessed = svc.getCapture(actor, result.source.id);
    expect(reprocessed.source.processingStatus).toBe("PROCESSED");
    expect(reprocessed.opportunity?.id).toBe(opp.id);
    expect(reprocessed.nextActions.map(a => a.title)).toEqual(["折り返し電話"]);
  });

  it("an unresolved MEMO_TARGET capture can still be reverted (dismisses the review)", async () => {
    const llm = new FakeLlmProvider([extractionJson({
      persons: [{ name: "鈴木", confidence: 0.6 }], opportunity: { match: "NEW", confidence: 0.6 },
    })]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const actor = { userId: user.id };

    const result = await svc.capture(actor, "鈴木さんから電話。詳細は未定。");
    const review = result.reviews.find(r => r.type === "MEMO_TARGET")!;
    expect(review.status).toBe("OPEN");

    svc.revertCapture(actor, result.source.id);
    expect(svc.getCapture(actor, result.source.id).source.processingStatus).toBe("REVERTED");
    expect(svc.listReviews(actor)).toHaveLength(0); // the MEMO_TARGET review was dismissed, not left dangling
  });
});

describe("CUSTOMER_AMBIGUOUS question wording quotes the memo, not the AI's guessed name", () => {
  it("a plausible but unmatched company name is quoted as the AI's guess, not stated as fact", async () => {
    const llm = new FakeLlmProvider([extractionJson({
      accounts: [{ name: "テスト商事", confidence: 0.6 }],
      persons: [{ name: "田中", company: "テスト商事", confidence: 0.6 }],
      opportunity: { match: "NEW", confidence: 0.6 },
    })]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });

    const text = "テスト商事の田中さんから初めて連絡があった。";
    const result = await svc.capture({ userId: user.id }, text);
    const review = result.reviews.find(r => r.type === "CUSTOMER_AMBIGUOUS")!;
    expect(review.question).toContain(text.slice(0, 60));
    expect(review.question).toContain("テスト商事");
    expect(review.question).toContain("まだ登録がありません");
  });
});

describe("customer resolution does not silently reuse an unconfirmed placeholder", () => {
  // 2026-09-14 finding: a real local-LLM batch run showed the AI sometimes fabricating a
  // plausible-looking company name across unrelated captures (the looksLikeCompanyName guard added
  // afterward catches the *meta-phrase* variant of this — see the "customer question wording" tests
  // below — but a normal-looking invented name like this one sails right through it). Because the
  // string happened to exact-match an UNRESOLVED placeholder from an earlier unrelated capture,
  // COMPANY_AND_PERSON silently merged two unrelated leads with no review.
  it("asks again instead of merging, then trusts the account once a human confirms it", async () => {
    const bogusCompany = "山田商事";
    const extraction = (personName: string) => extractionJson({
      accounts: [{ name: bogusCompany, confidence: 0.6 }],
      persons: [{ name: personName, company: bogusCompany, confidence: 0.6 }],
      opportunity: { match: "NEW", confidence: 0.6 },
    });
    const llm = new FakeLlmProvider([extraction("鈴木"), extraction("鈴木"), extraction("鈴木")]);
    const svc = makeService(llm, NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const actor = { userId: user.id };

    // 1st capture: nothing exists yet → new UNRESOLVED placeholder + review, as always.
    const first = await svc.capture(actor, "新規のお問い合わせ。山田商事、担当者名は鈴木さん。");
    expect(first.source.processingStatus).toBe("REVIEW_REQUIRED");
    const account1Id = first.opportunity!.accountId;
    expect(svc.repo.getAccount(account1Id)!.resolutionStatus).toBe("UNRESOLVED");

    // 2nd capture: same bogus company string AND same person name → exact COMPANY_AND_PERSON
    // match against account1. Before the fix this auto-merged with no review; now it must ask.
    const second = await svc.capture(actor, "名刺交換した鈴木さん、部署とか肩書は聞いてない。");
    expect(second.source.processingStatus).toBe("REVIEW_REQUIRED");
    expect(second.opportunity!.accountId).not.toBe(account1Id); // its own fresh placeholder, not merged
    expect(svc.listOpportunities(actor)).toHaveLength(2); // still two separate leads

    // A human confirms it actually is the same customer as account1.
    const review = second.reviews.find(r => r.type === "CUSTOMER_AMBIGUOUS")!;
    const pick = review.optionsJson!.find(o => o.value && (o.value as { accountId?: string }).accountId === account1Id)!;
    await svc.resolveReview(actor, review.id, { optionId: pick.id });
    expect(svc.repo.getAccount(account1Id)!.resolutionStatus).toBe("MANUAL"); // promoted, not left UNRESOLVED
    expect(svc.listOpportunities(actor)).toHaveLength(2); // merged account, still 2 opportunities under it

    // 3rd capture: same signal again, but account1 is now MANUAL → the customer match is trusted
    // (account1 now has two open opportunities, so OPPORTUNITY_AMBIGUOUS may still ask which one —
    // a separate, already-correct concern; what this test checks is that ENTITY_RESOLUTION itself
    // no longer needs review).
    const third = await svc.capture(actor, "鈴木さんからまた連絡。");
    expect(third.opportunity?.accountId).toBe(account1Id);
    expect(third.reviews.some(r => r.type === "CUSTOMER_AMBIGUOUS")).toBe(false);
    const entityDecision = third.decisions.find(d => d.decisionType === "ENTITY_RESOLUTION");
    expect(entityDecision?.status).toBe("AUTO_APPLIED");
  });
});

describe("customer contact details", () => {
  it("saves company address / phone / URL, and adds and edits customer contacts", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const user = makeUser(svc.repo, "SALES");
    const account = makeAccount(svc.repo);
    makeOpportunity(svc.repo, account.id, user.id);
    const actor = { userId: user.id };

    const saved = svc.updateAccount(actor, account.id, {
      address: " 東京都千代田区1-1 ", phone: "03-1234-5678", websiteUrl: "example.co.jp",
    });
    expect(saved).toMatchObject({ address: "東京都千代田区1-1", phone: "03-1234-5678", websiteUrl: "https://example.co.jp/" });
    expect(svc.repo.getAccount(account.id)!.websiteUrl).toBe("https://example.co.jp/");
    expect(svc.updateAccount(actor, account.id, { phone: "" }).phone).toBeUndefined();
    expect(() => svc.updateAccount(actor, account.id, { websiteUrl: "javascript:alert(1)" })).toThrow(TypeError);

    const person = svc.createPerson(actor, account.id, { displayName: "山田 太郎", email: "Taro@Example.co.jp", phone: "090-1111-2222" });
    expect(person).toMatchObject({ accountId: account.id, email: "taro@example.co.jp", phone: "090-1111-2222" });
    expect(() => svc.createPerson(actor, account.id, { displayName: "x", email: "not-an-email" })).toThrow(TypeError);

    const edited = svc.updatePerson(actor, person.id, { title: "部長", email: null });
    expect(edited).toMatchObject({ displayName: "山田 太郎", title: "部長", email: undefined });
    expect(svc.getOpportunity(actor, svc.repo.listOpportunitiesVisibleTo(svc.repo.getUser(user.id)!)[0]!.id).persons)
      .toEqual([expect.objectContaining({ id: person.id, title: "部長", phone: "090-1111-2222" })]);
  });

  it("does not let a SALES user edit a customer they have no opportunity with", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const owner = makeUser(svc.repo, "SALES");
    const outsider = makeUser(svc.repo, "SALES");
    const account = makeAccount(svc.repo);
    makeOpportunity(svc.repo, account.id, owner.id);

    expect(() => svc.updateAccount({ userId: outsider.id }, account.id, { phone: "03" })).toThrow(/顧客/);
    expect(() => svc.createPerson({ userId: outsider.id }, account.id, { displayName: "x" })).toThrow(/顧客/);
  });
});

describe("getCustomer (customer page)", () => {
  it("MANAGER sees every opportunity of the customer; SALES sees only their own", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const manager = makeUser(svc.repo, "MANAGER");
    const salesUser = makeUser(svc.repo, "SALES");
    const otherSales = makeUser(svc.repo, "SALES");
    const account = makeAccount(svc.repo);
    const own = makeOpportunity(svc.repo, account.id, salesUser.id, { title: "own", lifecycleState: "WON" });
    const others = makeOpportunity(svc.repo, account.id, otherSales.id, { title: "others", lifecycleState: "LOST" });
    svc.createPerson({ userId: manager.id }, account.id, { displayName: "山田" });

    const asManager = svc.getCustomer({ userId: manager.id }, account.id);
    expect(asManager.account.id).toBe(account.id);
    expect(asManager.persons.map(p => p.displayName)).toEqual(["山田"]);
    expect(new Set(asManager.opportunities.map(o => o.id))).toEqual(new Set([own.id, others.id]));

    const asSales = svc.getCustomer({ userId: salesUser.id }, account.id);
    expect(asSales.opportunities.map(o => o.id)).toEqual([own.id]);
  });

  it("throws for a SALES user with no opportunity for this customer", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const owner = makeUser(svc.repo, "SALES");
    const outsider = makeUser(svc.repo, "SALES");
    const account = makeAccount(svc.repo);
    makeOpportunity(svc.repo, account.id, owner.id);

    expect(() => svc.getCustomer({ userId: outsider.id }, account.id)).toThrow(/顧客/);
  });
});

describe("per-opportunity contacts (窓口)", () => {
  it("updateOpportunity accepts this customer's contacts and rejects another customer's", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const user = makeUser(svc.repo, "SALES");
    const account = makeAccount(svc.repo);
    const other = makeAccount(svc.repo, { displayName: "別会社" });
    const opp = makeOpportunity(svc.repo, account.id, user.id);
    const actor = { userId: user.id };
    const contact = svc.createPerson(actor, account.id, { displayName: "山田" });
    // Direct repo insert: this SALES user has no opportunity with `other`, so svc.createPerson
    // would (correctly) refuse — irrelevant to what this test checks (updateOpportunity's own guard).
    const outsideContact = { id: newId(), accountId: other.id, displayName: "佐藤", resolutionStatus: "MANUAL" as const,
      createdAt: NOW, updatedAt: NOW };
    svc.repo.insertPerson(outsideContact);

    const saved = svc.updateOpportunity(actor, opp.id, { contactPersonIds: [contact.id, contact.id], version: 1 });
    expect(saved.contactPersonIds).toEqual([contact.id]); // duplicates collapsed
    expect(saved.contactNames).toEqual(["山田"]);
    expect(saved.primaryContactName).toBe("山田");

    expect(() => svc.updateOpportunity(actor, opp.id, { contactPersonIds: [outsideContact.id], version: saved.version }))
      .toThrow(/窓口/);
  });

  it("summarize() silently drops a contact id that no longer resolves (deleted person)", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const user = makeUser(svc.repo, "SALES");
    const account = makeAccount(svc.repo);
    const opp = makeOpportunity(svc.repo, account.id, user.id);
    const actor = { userId: user.id };
    const contact = svc.createPerson(actor, account.id, { displayName: "山田" });
    const saved = svc.updateOpportunity(actor, opp.id, { contactPersonIds: [contact.id], version: 1 });

    svc.repo.deletePerson(contact.id);
    const detail = svc.getOpportunity(actor, saved.id);
    expect(detail.contactPersonIds).toEqual([]);
    expect(detail.contactNames).toEqual([]);
    expect(detail.primaryContactName).toBeUndefined();
  });

  it("capture() adds a matched contact as this deal's 窓口, and revertCapture() undoes it", async () => {
    const svc = makeService(new FakeLlmProvider([
      extractionJson({
        accounts: [{ name: "ABC株式会社", confidence: 0.9 }],
        persons: [{ name: "山田", company: "ABC株式会社", confidence: 0.9 }],
        // Not "NEW": lets ingest reuse the account's one existing open opportunity instead of
        // creating a fresh one (a created opportunity is deleted wholesale on revert, which would
        // not exercise the "restore contactPersonIds to what it was" path this test is for).
        opportunity: { match: "EXISTING", confidence: 0.9 },
      }),
    ]), NOW);
    const user = svc.registerIdentity("test", "u1", { email: "a@example.com", displayName: "太郎" });
    const account = makeAccount(svc.repo, { displayName: "ABC株式会社" });
    const contact = svc.createPerson({ userId: user.id }, account.id, { displayName: "山田" });
    const opp = makeOpportunity(svc.repo, account.id, user.id);
    expect(opp.contactPersonIds ?? []).toEqual([]);

    const result = await svc.capture({ userId: user.id }, "ABCの山田さんと打合せ");
    expect(result.opportunity?.id).toBe(opp.id);
    expect(result.opportunity?.contactPersonIds).toEqual([contact.id]);
    expect(result.opportunity?.contactNames).toEqual(["山田"]);

    svc.revertCapture({ userId: user.id }, result.source.id);
    expect(svc.repo.getOpportunity(opp.id)!.contactPersonIds ?? []).toEqual([]);
  });

  it("merging opportunities (OPPORTUNITY_AMBIGUOUS resolution) unions their contacts", async () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const user = makeUser(svc.repo, "SALES");
    const account = makeAccount(svc.repo);
    const actor = { userId: user.id };
    // A visible opportunity must exist before createPerson (canSeeAccount) will allow it.
    const targetOpp = makeOpportunity(svc.repo, account.id, user.id, { title: "target" });
    const contactA = svc.createPerson(actor, account.id, { displayName: "山田" });
    const contactB = svc.createPerson(actor, account.id, { displayName: "鈴木" });
    const target = svc.updateOpportunity(actor, targetOpp.id, { contactPersonIds: [contactA.id], version: 1 });
    const fresh = svc.updateOpportunity(
      actor,
      makeOpportunity(svc.repo, account.id, user.id, { title: "fresh" }).id,
      { contactPersonIds: [contactB.id], version: 1 },
    );
    svc.repo.insertReview({
      id: "review-merge", type: "OPPORTUNITY_AMBIGUOUS", assignedUserId: user.id,
      relatedEntityType: "opportunity", relatedEntityId: fresh.id, question: "q",
      optionsJson: [{ id: "pick-target", label: "target", value: { opportunityId: target.id } }],
      sourceEvidenceIds: [], status: "OPEN", createdAt: NOW,
    });
    await svc.resolveReview(actor, "review-merge", { optionId: "pick-target" });

    const merged = svc.getOpportunity(actor, target.id);
    expect(new Set(merged.contactPersonIds)).toEqual(new Set([contactA.id, contactB.id]));
  });
});

describe("askQuestion (capture box search mode)", () => {
  it("answers using only the name-matched opportunity as context", async () => {
    const llm = new FakeLlmProvider(["ABC株式会社の案件は見積送付待ちです。"]);
    const svc = makeService(llm, NOW);
    const user = makeUser(svc.repo, "SALES");
    const abc = makeAccount(svc.repo, { displayName: "ABC株式会社" });
    const other = makeAccount(svc.repo, { displayName: "合同会社ブルームワークス" });
    const target = makeOpportunity(svc.repo, abc.id, user.id, { title: "ABC株式会社 新機能提案" });
    makeOpportunity(svc.repo, other.id, user.id, { title: "合同会社ブルームワークス 商談" });

    const result = await svc.askQuestion({ userId: user.id }, "ABC株式会社の状況どうなっている？");

    expect(result.answer).toBe("ABC株式会社の案件は見積送付待ちです。");
    expect(result.references.map(r => r.id)).toEqual([target.id]);
    expect(result.matchedByName).toBe(true);
    expect(result.modelProvider).toBe("fake");
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]!.user).toContain("ABC株式会社");
    expect(llm.requests[0]!.user).toContain("question に名前が一致した案件:");
    expect(llm.requests[0]!.json).toBeFalsy();
  });

  it("falls back to recently-updated opportunities when no name matches, and tells the model/UI so", async () => {
    const llm = new FakeLlmProvider(["該当する案件は見つかりませんでしたが、直近の案件はこちらです。"]);
    const svc = makeService(llm, NOW);
    const user = makeUser(svc.repo, "SALES");
    const account = makeAccount(svc.repo);
    makeOpportunity(svc.repo, account.id, user.id, { title: "案件1" });
    makeOpportunity(svc.repo, account.id, user.id, { title: "案件2" });

    const result = await svc.askQuestion({ userId: user.id }, "全体としてどうなっている？");

    expect(result.references).toHaveLength(2);
    expect(result.matchedByName).toBe(false);
    expect(result.error).toBeUndefined();
    expect(llm.requests[0]!.user).toContain("質問に一致する案件名は見つからなかった");
  });

  it("returns a canned answer without calling the AI when there is no data yet", async () => {
    const llm = new FakeLlmProvider([]);
    const svc = makeService(llm, NOW);
    const user = makeUser(svc.repo, "SALES");

    const result = await svc.askQuestion({ userId: user.id }, "何か動きある？");

    expect(result.references).toEqual([]);
    expect(result.matchedByName).toBe(false);
    expect(result.answer).toContain("案件データがありません");
    expect(llm.requests).toHaveLength(0);
  });

  it("returns an error result (not a thrown error) when the AI call fails", async () => {
    const llm = new FakeLlmProvider([]); // no scripted response -> FakeLlmProvider throws
    const svc = makeService(llm, NOW);
    const user = makeUser(svc.repo, "SALES");
    const account = makeAccount(svc.repo);
    makeOpportunity(svc.repo, account.id, user.id, { title: "案件" });

    const result = await svc.askQuestion({ userId: user.id }, "状況は？");

    expect(result.answer).toBe("");
    expect(result.error).toBeTruthy();
  });

  it("rejects a blank question", async () => {
    const llm = new FakeLlmProvider([]);
    const svc = makeService(llm, NOW);
    const user = makeUser(svc.repo, "SALES");
    await expect(svc.askQuestion({ userId: user.id }, "   ")).rejects.toThrow();
  });

  it("logs question.asked then question.answered(ok), with the prompt version but never the question/answer text", async () => {
    const events: [string, Record<string, unknown> | undefined][] = [];
    const llm = new FakeLlmProvider(["ABC株式会社の案件は見積送付待ちです。"]);
    const svc = makeService(llm, NOW, (event, fields) => events.push([event, fields]));
    const user = makeUser(svc.repo, "SALES");
    const account = makeAccount(svc.repo, { displayName: "ABC株式会社" });
    makeOpportunity(svc.repo, account.id, user.id, { title: "ABC株式会社 新機能提案" });

    await svc.askQuestion({ userId: user.id }, "ABC株式会社の状況どうなっている？");

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(["question.asked",
      { kind: "matched", candidates: 1, promptVersion: "answer.v4" }]);
    expect(events[1]).toEqual(["question.answered",
      { status: "ok", model: "fake-model", promptVersion: "answer.v4", outputTokens: undefined }]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("ABC株式会社の状況どうなっている");
    expect(serialized).not.toContain("見積送付待ち");
  });

  it("logs question.answered(failed) with the error, when the AI call fails", async () => {
    const events: [string, Record<string, unknown> | undefined][] = [];
    const llm = new FakeLlmProvider([]); // no scripted response -> FakeLlmProvider throws
    const svc = makeService(llm, NOW, (event, fields) => events.push([event, fields]));
    const user = makeUser(svc.repo, "SALES");
    const account = makeAccount(svc.repo);
    makeOpportunity(svc.repo, account.id, user.id, { title: "案件" });

    await svc.askQuestion({ userId: user.id }, "状況は？");

    expect(events.map(([event]) => event)).toEqual(["question.asked", "question.answered"]);
    expect(events[1]![1]).toMatchObject({ status: "failed" });
    expect(events[1]![1]!.error).toBeTruthy();
  });

  it("does not log when there is no data yet (no AI call is made)", async () => {
    const events: string[] = [];
    const llm = new FakeLlmProvider([]);
    const svc = makeService(llm, NOW, (event) => events.push(event));
    const user = makeUser(svc.repo, "SALES");

    await svc.askQuestion({ userId: user.id }, "何か動きある？");

    expect(events).toEqual([]);
  });

  it("stays fast with 500 opportunities and only hands the model a handful of them", async () => {
    const llm = new FakeLlmProvider(["ABC株式会社の案件は見積送付待ちです。"]);
    const svc = makeService(llm, NOW);
    const user = makeUser(svc.repo, "SALES");
    const account = makeAccount(svc.repo, { displayName: "ABC株式会社" });
    const target = makeOpportunity(svc.repo, account.id, user.id, { title: "ABC株式会社 新機能提案" });
    const otherAccount = makeAccount(svc.repo, { displayName: "その他株式会社" });
    for (let i = 0; i < 499; i++) {
      makeOpportunity(svc.repo, otherAccount.id, user.id, { title: `案件${i}` });
    }

    const start = performance.now();
    const result = await svc.askQuestion({ userId: user.id }, "ABC株式会社の状況どうなっている？");
    const elapsedMs = performance.now() - start;

    expect(result.references.map(r => r.id)).toEqual([target.id]);
    expect(llm.requests[0]!.user.split("- id=").length - 1).toBeLessThanOrEqual(5);
    expect(elapsedMs).toBeLessThan(1000);
  });
});
