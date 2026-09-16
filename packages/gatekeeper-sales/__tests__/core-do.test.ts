/**
 * Runs the tenant Durable Object under workerd with real DO SQLite, mocking only the LLM endpoint.
 * This is what proves the SqlExecutor adapter, migrations and the whole capture pipeline work on
 * the production storage engine (the sales-core suite runs them on node:sqlite).
 */
import type { CaptureResult } from "@gadgets/sales-core";
import { env, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Caller, SalesCoreDurableObject } from "../src/sales-core-do.js";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    SALES_CORE: DurableObjectNamespace<SalesCoreDurableObject>;
  }
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
  decisions: [], unresolved: ["契約開始日"], questions: [], objections: [],
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

// Scripted replies for the mocked OpenAI-compatible endpoint, consumed in order. The Response is
// built inside the stub, i.e. in the calling Durable Object's context: workerd forbids handing an
// I/O object created in one DO (or the test) to another.
type Reply = { status: number; body: unknown };
const replies: Reply[] = [];
// Slack sends (sendSlackTest / sendMorningBrief) are recorded here instead of scripted — every test
// that triggers one is expected to consume it via slackPosts.shift(), same discipline as `replies`.
const slackPosts: string[] = [];
const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url === "https://slack.com/api/chat.postMessage") {
    const body = JSON.parse(String(init?.body)) as { text: string };
    slackPosts.push(body.text);
    return Response.json({ ok: true });
  }
  if (!url.startsWith("http://llm.test/v1/chat/completions")) {
    throw new Error(`unexpected outbound fetch: ${url}`);
  }
  const next = replies.shift();
  if (!next) throw new Error("no scripted LLM reply left");
  return next.status === 200
    ? Response.json(next.body)
    : new Response(String(next.body), { status: next.status });
});
vi.stubGlobal("fetch", fetchSpy);

function mockLlmOnce(body: unknown) {
  replies.push({ status: 200, body: {
    model: "test-model",
    choices: [{ message: { content: JSON.stringify(body) } }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  } });
}

describe("SalesCoreDurableObject (workerd + DO SQLite)", () => {
  afterEach(() => {
    expect(replies).toHaveLength(0);
    expect(slackPosts).toHaveLength(0);
  });

  it("registers, captures, reviews and reverts on real DO storage", async () => {
    const core = env.SALES_CORE.getByName(`tenant-${crypto.randomUUID()}`);
    const caller = { accountId: "acct-1", isAdmin: false };

    const before = await core.whoAmI(caller);
    expect(before.user).toBeUndefined();
    expect(before.firstUser).toBe(true);
    expect(before.ai).toEqual({ provider: "ollama", model: "test-model", configured: true });

    const user = await core.register(caller, { email: "kimura@example.com", displayName: "木村" });
    expect(user.role).toBe("ADMIN");
    expect((await core.whoAmI(caller)).user?.id).toBe(user.id);

    mockLlmOnce(EXTRACTION);
    const result = await core.capture(caller,
      "今日ABCの山田さんと話して、100万はOK。金曜に社内承認が出る。通れば来週契約。月曜に電話する。");
    expect(result.error).toBeUndefined();
    expect(result.source.processingStatus).toBe("REVIEW_REQUIRED");
    expect(result.opportunity?.operationalState).toBe("WAITING_CUSTOMER");
    expect(result.opportunity?.expectedAmount).toBe(1_000_000);
    expect(result.commitments).toHaveLength(1);
    expect(result.nextActions).toHaveLength(1);
    expect(result.reviews.map(r => r.type)).toEqual(["CUSTOMER_AMBIGUOUS"]);

    const today = await core.getToday(caller);
    expect(today.counts.openOpportunities).toBe(1);
    expect(today.reviews).toHaveLength(1);

    const resolved = await core.resolveReview(caller, today.reviews[0]!.id, { optionId: "new" });
    expect(resolved.status).toBe("RESOLVED");
    const detail = await core.getOpportunity(caller, result.opportunity!.id);
    expect(detail.account.resolutionStatus).toBe("MANUAL");
    expect(detail.context?.currentSituation).toContain("稟議待ち");
    expect(detail.activities).toHaveLength(1);
    expect(detail.audit.length).toBeGreaterThan(0);

    // A second, unregistered account cannot act.
    await expect(core.getToday({ accountId: "acct-2" })).rejects.toThrow(/登録されていません/);

    // Approval-style flow: receive → process → discard is rejected once processed.
    mockLlmOnce({ ...EXTRACTION, not_sales_related: true });
    const received = await core.receive(caller, "こんにちは");
    expect(received.duplicate).toBe(false);
    const processed = await core.process(caller, received.sourceId);
    expect(processed.notSalesRelated).toBe(true);
    await expect(core.discard(caller, received.sourceId)).rejects.toThrow();

    await core.revertCapture(caller, result.source.id);
    expect(await core.listOpportunities(caller)).toHaveLength(0);
    expect((await core.getCapture(caller, result.source.id)).source.processingStatus).toBe("REVERTED");
  });

  it("keeps a failed AI run retryable", async () => {
    const core = env.SALES_CORE.getByName(`tenant-${crypto.randomUUID()}`);
    const caller = { accountId: "acct-9" };
    await core.register(caller, { email: "a@example.com", displayName: "A" });

    replies.push({ status: 500, body: "boom" });
    const failed = await core.capture(caller, "XYZ社と打合せ。来月に延期。");
    expect(failed.source.processingStatus).toBe("FAILED");
    expect(failed.error).toMatch(/status 500/);

    mockLlmOnce({ ...EXTRACTION, entities: { account_candidates: [{ name: "XYZ社", confidence: 0.9 }], person_candidates: [] } });
    const retried = await core.retryCapture(caller, failed.source.id);
    expect(retried.source.processingStatus).toBe("REVIEW_REQUIRED");
    expect(retried.opportunity?.accountName).toBe("XYZ社");
  });

  describe("sendMorningBrief (plans/sales-os-notify.md N3)", () => {
    it("rejects a non-admin caller", async () => {
      const core = env.SALES_CORE.getByName(`tenant-${crypto.randomUUID()}`);
      const caller = { accountId: "acct-1", isAdmin: false };
      await core.register(caller, { email: "kimura@example.com", displayName: "木村" });
      await expect(core.sendMorningBrief(caller)).rejects.toThrow(/管理者のみ/);
    });

    it("sends once and dedups a same-day retry, but a different day sends again", async () => {
      const core = env.SALES_CORE.getByName(`tenant-${crypto.randomUUID()}`);
      const admin = { accountId: "acct-1", isAdmin: true };
      await core.register(admin, { email: "kimura@example.com", displayName: "木村" });

      const first = await core.sendMorningBrief(admin);
      expect(first).toEqual({ sent: true, recipientCount: 1 });
      expect(slackPosts.shift()).toContain("木村さん");

      const second = await core.sendMorningBrief(admin);
      expect(second).toEqual({ sent: false, recipientCount: 1 });
      // No Slack post for the deduped retry — slackPosts stays empty (checked by afterEach).
    });

    it("is a no-op with zero active users", async () => {
      const core = env.SALES_CORE.getByName(`tenant-${crypto.randomUUID()}`);
      // Never registered, so isAdmin doesn't matter for the "no users" branch specifically -
      // requireUser-based methods would reject first, but sendMorningBrief checks user count, not
      // identity, so an accountId that happens to be flagged admin still hits the empty-users path.
      const result = await core.sendMorningBrief({ accountId: "ghost", isAdmin: true });
      expect(result).toEqual({ sent: false, recipientCount: 0 });
    });
  });

  describe("captureAsync + alarm (instant-accept queue)", () => {
    // captureAsync arms the alarm for `Date.now()` (fire ASAP), so under real workerd timers the
    // runtime's own background scheduler can win the race against an explicit runDurableObjectAlarm
    // call -- both are valid triggers for the same alarm. Poll for the outcome instead of asserting
    // on which one actually fired it (runDurableObjectAlarm is still called, as a best-effort nudge,
    // and legitimately returns false when the background scheduler got there first).
    async function waitUntilProcessed(
      core: { getCapture(caller: Caller, sourceId: string): Promise<CaptureResult> } & DurableObjectStub,
      caller: Caller, sourceId: string,
    ): Promise<CaptureResult> {
      for (let i = 0; i < 50; i++) {
        await runDurableObjectAlarm(core);
        const current = await core.getCapture(caller, sourceId);
        if (current.source.processingStatus !== "RECEIVED") return current;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error(`timed out waiting for source ${sourceId} to leave RECEIVED`);
    }

    it("returns immediately with the memo RECEIVED, then the alarm processes it", async () => {
      const core = env.SALES_CORE.getByName(`tenant-${crypto.randomUUID()}`);
      const caller = { accountId: "acct-1", isAdmin: false };
      await core.register(caller, { email: "kimura@example.com", displayName: "木村" });

      mockLlmOnce(EXTRACTION);
      const receipt = await core.captureAsync(caller,
        "今日ABCの山田さんと話して、100万はOK。金曜に社内承認が出る。通れば来週契約。月曜に電話する。");
      expect(receipt.duplicate).toBe(false);

      const done = await waitUntilProcessed(core, caller, receipt.sourceId);
      expect(done.source.processingStatus).toBe("REVIEW_REQUIRED");
      expect(done.opportunity?.operationalState).toBe("WAITING_CUSTOMER");
    });

    it("drains multiple queued memos", async () => {
      const core = env.SALES_CORE.getByName(`tenant-${crypto.randomUUID()}`);
      const caller = { accountId: "acct-1", isAdmin: false };
      await core.register(caller, { email: "kimura@example.com", displayName: "木村" });

      mockLlmOnce({ ...EXTRACTION, entities: { account_candidates: [{ name: "ABC株式会社", confidence: 0.9 }], person_candidates: [] } });
      const first = await core.captureAsync(caller, "ABCの山田さんと打合せ。100万で提示。");
      mockLlmOnce({ ...EXTRACTION, entities: { account_candidates: [{ name: "XYZ社", confidence: 0.9 }], person_candidates: [] } });
      const second = await core.captureAsync(caller, "XYZの鈴木さんと打合せ。来月また連絡。");

      expect((await waitUntilProcessed(core, caller, first.sourceId)).source.processingStatus).toBe("REVIEW_REQUIRED");
      expect((await waitUntilProcessed(core, caller, second.sourceId)).source.processingStatus).toBe("REVIEW_REQUIRED");
    });

    it("does not re-run the LLM for a duplicate capture", async () => {
      const core = env.SALES_CORE.getByName(`tenant-${crypto.randomUUID()}`);
      const caller = { accountId: "acct-1", isAdmin: false };
      await core.register(caller, { email: "kimura@example.com", displayName: "木村" });

      const text = "ABCの山田さんと打合せ。100万で提示。";
      mockLlmOnce({ ...EXTRACTION, entities: { account_candidates: [{ name: "ABC株式会社", confidence: 0.9 }], person_candidates: [] } });
      const first = await core.captureAsync(caller, text);
      await waitUntilProcessed(core, caller, first.sourceId);

      const again = await core.captureAsync(caller, text);
      expect(again.duplicate).toBe(true);
      expect(again.sourceId).toBe(first.sourceId);
      // No alarm should have been (re-)armed for a duplicate -- nothing left RECEIVED to drain, and
      // no LLM reply was scripted for it (the afterEach `replies` check would fail if one ran).
      expect(await runDurableObjectAlarm(core)).toBe(false);
    });
  });

  describe("closing a deal (C1) over the real RPC boundary", () => {
    it("WON requires an amount, records close details, and shows up in the audit log", async () => {
      const core = env.SALES_CORE.getByName(`tenant-${crypto.randomUUID()}`);
      const caller = { accountId: "acct-1", isAdmin: true };
      await core.register(caller, { email: "kimura@example.com", displayName: "木村" });

      mockLlmOnce(EXTRACTION);
      const captured = await core.capture(caller,
        "今日ABCの山田さんと話して、100万はOK。金曜に社内承認が出る。通れば来週契約。月曜に電話する。");
      const opp = captured.opportunity!;

      const won = await core.updateOpportunity(caller, opp.id, { lifecycleState: "WON", version: opp.version });
      expect(won.wonAmount).toBe(1_000_000);
      expect(won.closedAt).toBeTruthy();

      const detail = await core.getOpportunity(caller, opp.id);
      expect(detail.audit.some(a => a.action === "OPPORTUNITY_CLOSED")).toBe(true);

      const reopened = await core.updateOpportunity(caller, opp.id, { lifecycleState: "OPEN", version: won.version });
      expect(reopened.wonAmount).toBeUndefined();
      expect(reopened.closedAt).toBeUndefined();
    });
  });

  describe("product master (D1) over the real RPC boundary", () => {
    it("ADMIN creates/updates a product; a second (SALES-default) user can list but not create", async () => {
      const core = env.SALES_CORE.getByName(`tenant-${crypto.randomUUID()}`);
      const admin = { accountId: "acct-1", isAdmin: true };
      await core.register(admin, { email: "kimura@example.com", displayName: "木村" });
      const sales = { accountId: "acct-2", isAdmin: false };
      await core.register(sales, { email: "sato@example.com", displayName: "佐藤" });

      const product = await core.createProduct(admin, { code: "SV-001", name: "導入支援", unitPrice: 300_000 });
      expect(product.category).toBe("SERVICE");

      const updated = await core.updateProduct(admin, product.id, { unitPrice: 350_000 });
      expect(updated.unitPrice).toBe(350_000);

      expect(await core.listProducts(sales)).toHaveLength(1);
      await expect(core.createProduct(sales, { name: "無断作成" })).rejects.toThrow(/マネージャー以上/);

      await core.updateProduct(admin, product.id, { active: false });
      expect(await core.listProducts(admin)).toHaveLength(0);
      expect(await core.listProducts(admin, { includeInactive: true })).toHaveLength(1);
    });
  });

  describe("line items (D2) over the real RPC boundary", () => {
    it("saving line items over RPC re-derives expectedAmount and locks direct edits", async () => {
      const core = env.SALES_CORE.getByName(`tenant-${crypto.randomUUID()}`);
      const caller = { accountId: "acct-1", isAdmin: true };
      await core.register(caller, { email: "kimura@example.com", displayName: "木村" });

      mockLlmOnce(EXTRACTION);
      const captured = await core.capture(caller,
        "今日ABCの山田さんと話して、100万はOK。金曜に社内承認が出る。通れば来週契約。月曜に電話する。");
      const opp = captured.opportunity!;

      const withItems = await core.setLineItems(caller, opp.id, [
        { name: "導入支援", quantity: 1, unitPrice: 300_000 },
        { name: "保守", quantity: 12, unitPrice: 10_000, discountAmount: 20_000 },
      ], opp.version);
      expect(withItems.lineItems).toHaveLength(2);
      expect(withItems.expectedAmount).toBe(300_000 + 120_000 - 20_000);
      expect(withItems.hasLineItems).toBe(true);

      await expect(
        core.updateOpportunity(caller, opp.id, { expectedAmount: 1, version: withItems.version }),
      ).rejects.toThrow(/明細/);

      const cleared = await core.setLineItems(caller, opp.id, [], withItems.version);
      expect(cleared.lineItems).toHaveLength(0);
      expect(cleared.hasLineItems).toBe(false);
      const manualAmount = await core.updateOpportunity(caller, opp.id, { expectedAmount: 42, version: cleared.version });
      expect(manualAmount.expectedAmount).toBe(42);
    });
  });

  describe("team KPI period selector (F1) over the real RPC boundary", () => {
    it("a LAST_MONTH query counts a deal closed last month, not this month's default", async () => {
      const core = env.SALES_CORE.getByName(`tenant-${crypto.randomUUID()}`);
      const caller = { accountId: "acct-1", isAdmin: true };
      await core.register(caller, { email: "kimura@example.com", displayName: "木村" });

      mockLlmOnce(EXTRACTION);
      const captured = await core.capture(caller,
        "今日ABCの山田さんと話して、100万はOK。金曜に社内承認が出る。通れば来週契約。月曜に電話する。");
      const opp = captured.opportunity!;

      const now = new Date();
      const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
      const closedAt = lastMonth.toISOString().slice(0, 10);
      await core.updateOpportunity(caller, opp.id, { lifecycleState: "WON", closedAt, version: opp.version });

      const thisMonth = await core.getManagerSummary(caller);
      expect(thisMonth.kpis.wonThisMonth).toBe(0);

      const summary = await core.getManagerSummary(caller, { period: "LAST_MONTH" });
      expect(summary.kpis.wonThisMonth).toBe(1);
      expect(summary.kpis.wonAmountThisMonth).toBe(1_000_000);
      expect(summary.perUser.find(r => r.userId)?.wonCount).toBe(1);
    });
  });

  describe("accountSummary (企業サマリ) over the real RPC boundary", () => {
    // Multi-deal aggregation (D1's account-summary.test.ts covers that against the repository
    // directly, unaffected by entity-resolution's confidence threshold for re-matching a customer
    // name across captures). This just proves getOpportunity actually returns accountSummary, live,
    // through the real RPC path -- not a hand-built DTO that happens to satisfy the type.
    it("returns this deal's own numbers as the account's only OPEN deal, once confirmed", async () => {
      const core = env.SALES_CORE.getByName(`tenant-${crypto.randomUUID()}`);
      const caller = { accountId: "acct-1", isAdmin: true };
      await core.register(caller, { email: "kimura@example.com", displayName: "木村" });

      mockLlmOnce(EXTRACTION);
      const captured = await core.capture(caller,
        "今日ABCの山田さんと話して、100万はOK。金曜に社内承認が出る。通れば来週契約。月曜に電話する。");
      // Confirm the CUSTOMER_AMBIGUOUS review as "new" so the account is a real, confirmed
      // customer_account (not an UNRESOLVED placeholder) -- accountSummaryFor counts its OPEN deals.
      const reviews = await core.listReviews(caller);
      await core.resolveReview(caller, reviews[0]!.id, { optionId: "new" });

      // stalledCount is not asserted here: this suite runs against the real wall clock while
      // EXTRACTION's activity.occurred_at is a fixed date, so "stalled" depends on when the test
      // happens to run. account-summary.test.ts covers stalledCount against a fixed clock instead.
      const detail = await core.getOpportunity(caller, captured.opportunity!.id);
      expect(detail.accountSummary.openCount).toBe(1);
      expect(detail.accountSummary.expectedAmountTotal).toBe(1_000_000);
      expect(detail.accountSummary.currency).toBe("JPY");
      expect(detail.accountSummary.highRiskCount).toBe(0);
    });
  });

  describe("mergeOpportunities (manual fix for AI mis-matches / spelling variants) over the real RPC boundary", () => {
    it("folds a wrongly-separated deal into the correct one; the source is closed, not deleted", async () => {
      const core = env.SALES_CORE.getByName(`tenant-${crypto.randomUUID()}`);
      const caller = { accountId: "acct-1", isAdmin: true };
      await core.register(caller, { email: "kimura@example.com", displayName: "木村" });

      mockLlmOnce(EXTRACTION);
      const source = await core.capture(caller,
        "今日ABCの山田さんと話して、100万はOK。金曜に社内承認が出る。通れば来週契約。月曜に電話する。");
      const sourceReviews = await core.listReviews(caller);
      await core.resolveReview(caller, sourceReviews[0]!.id, { optionId: "new" });

      mockLlmOnce({
        ...EXTRACTION,
        entities: { account_candidates: [{ name: "XYZ商事", confidence: 0.95 }], person_candidates: [] },
        opportunity: { match: "NEW", title: "XYZ商事 別件", confidence: 0.9 },
      });
      const target = await core.capture(caller, "XYZ商事の鈴木さんと商談。来月また連絡。");
      const targetReviews = (await core.listReviews(caller)).filter(r => r.id !== sourceReviews[0]!.id);
      await core.resolveReview(caller, targetReviews[0]!.id, { optionId: "new" });

      const merged = await core.mergeOpportunities(caller, source.opportunity!.id, target.opportunity!.id);
      expect(merged.id).toBe(target.opportunity!.id);

      const closedSource = await core.getOpportunity(caller, source.opportunity!.id);
      expect(closedSource.lifecycleState).toBe("CLOSED");
      expect(closedSource.title).toContain("統合済み");

      const targetDetail = await core.getOpportunity(caller, target.opportunity!.id);
      expect(targetDetail.activities.length).toBeGreaterThanOrEqual(1);
      expect(targetDetail.audit.some(a => a.action === "OPPORTUNITY_MERGED")).toBe(true);
    });
  });
});
