/**
 * Runs the tenant Durable Object under workerd with real DO SQLite, mocking only the LLM endpoint.
 * This is what proves the SqlExecutor adapter, migrations and the whole capture pipeline work on
 * the production storage engine (the sales-core suite runs them on node:sqlite).
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SalesCoreDurableObject } from "../src/sales-core-do.js";

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
const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
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
});
