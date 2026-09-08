import { describe, expect, it } from "vitest";
import {
  acceptDueAt, amountKindLabel, deriveAmount, derivePriority, deriveState,
} from "../src/rules/business.js";
import { DEFAULT_CONFIG } from "../src/rules/config.js";
import { extractionSchema, type Extraction } from "../src/ai/schema.js";
import type { Opportunity } from "../src/domain/types.js";
import { newId } from "../src/domain/util.js";

function baseExtraction(overrides: Record<string, unknown> = {}): Extraction {
  return extractionSchema.parse({
    entities: { account_candidates: [], person_candidates: [] },
    opportunity: { match: "NEW", confidence: 0.9 },
    activity: { type: "MEETING", occurred_at: null, summary: "s", confidence: 0.9 },
    state: { operational_state: "UNKNOWN", lifecycle_state: "OPEN", confidence: 0.9 },
    risk: { level: "NONE", confidence: 0.9 },
    context: { current_situation: "s", latest_development: "d" },
    ...overrides,
  });
}

function makeOpportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  const now = "2026-09-01T00:00:00.000Z";
  return {
    id: newId(), accountId: "acc-1", title: "案件", ownerUserId: "user-1", collaboratorUserIds: [],
    lifecycleState: "OPEN", operationalState: "UNKNOWN", riskLevel: "NONE", version: 1,
    createdAt: now, updatedAt: now, ...overrides,
  };
}

describe("deriveState", () => {
  it("never auto-applies WON: a review is created and lifecycleState stays undefined", () => {
    const x = baseExtraction({ state: { operational_state: "CONTRACTING", lifecycle_state: "WON", confidence: 0.99 } });
    const proposal = deriveState(x, undefined, DEFAULT_CONFIG);
    expect(proposal.lifecycleState).toBeUndefined();
    expect(proposal.reviews).toHaveLength(1);
    expect(proposal.reviews[0]!.type).toBe("STATE_AMBIGUOUS");
    expect(proposal.reviews[0]!.options?.map(o => o.id)).toEqual(["confirm", "keep-open"]);
    expect(proposal.reviews[0]!.options?.find(o => o.id === "confirm")?.value).toEqual({ lifecycleState: "WON" });
  });

  it("never auto-applies LOST even at maximum confidence", () => {
    const x = baseExtraction({ state: { operational_state: "UNKNOWN", lifecycle_state: "LOST", confidence: 1 } });
    const proposal = deriveState(x, undefined, DEFAULT_CONFIG);
    expect(proposal.lifecycleState).toBeUndefined();
    expect(proposal.reviews.some(r => r.type === "STATE_AMBIGUOUS")).toBe(true);
  });

  it("applies operational state only at or above the confidence threshold", () => {
    const confident = baseExtraction({ state: { operational_state: "ACTIVE", lifecycle_state: "OPEN", confidence: 0.9 } });
    expect(deriveState(confident, undefined, DEFAULT_CONFIG).operationalState).toBe("ACTIVE");

    const unsure = baseExtraction({ state: { operational_state: "ACTIVE", lifecycle_state: "OPEN", confidence: 0.5 } });
    expect(deriveState(unsure, undefined, DEFAULT_CONFIG).operationalState).toBeUndefined();
  });

  it("does not apply operational state UNKNOWN even at high confidence", () => {
    const x = baseExtraction({ state: { operational_state: "UNKNOWN", lifecycle_state: "OPEN", confidence: 0.99 } });
    expect(deriveState(x, undefined, DEFAULT_CONFIG).operationalState).toBeUndefined();
  });

  it("auto-applies ON_HOLD/CLOSED above threshold, and reviews below it", () => {
    const confident = baseExtraction({ state: { operational_state: "UNKNOWN", lifecycle_state: "ON_HOLD", confidence: 0.9 } });
    const p1 = deriveState(confident, undefined, DEFAULT_CONFIG);
    expect(p1.lifecycleState).toBe("ON_HOLD");
    expect(p1.reviews).toHaveLength(0);

    const unsure = baseExtraction({ state: { operational_state: "UNKNOWN", lifecycle_state: "CLOSED", confidence: 0.5 } });
    const p2 = deriveState(unsure, undefined, DEFAULT_CONFIG);
    expect(p2.lifecycleState).toBeUndefined();
    expect(p2.reviews).toHaveLength(1);
  });

  it("reopening a non-OPEN opportunity requires review, not auto-apply", () => {
    const current = makeOpportunity({ lifecycleState: "LOST" });
    const x = baseExtraction({ state: { operational_state: "UNKNOWN", lifecycle_state: "OPEN", confidence: 0.99 } });
    const proposal = deriveState(x, current, DEFAULT_CONFIG);
    expect(proposal.lifecycleState).toBeUndefined();
    expect(proposal.reviews.some(r => r.type === "STATE_AMBIGUOUS")).toBe(true);
  });
});

describe("acceptDueAt", () => {
  it("accepts a confident, valid ISO date-time", () => {
    expect(acceptDueAt("2026-09-11T18:00:00+09:00", 0.97, DEFAULT_CONFIG))
      .toBe(new Date("2026-09-11T18:00:00+09:00").toISOString());
  });

  it("rejects a confidence below the threshold", () => {
    expect(acceptDueAt("2026-09-11T18:00:00+09:00", 0.5, DEFAULT_CONFIG)).toBeUndefined();
  });

  it("rejects a non-ISO string", () => {
    expect(acceptDueAt("来週の金曜日", 0.99, DEFAULT_CONFIG)).toBeUndefined();
  });

  it("rejects null / undefined", () => {
    expect(acceptDueAt(null, 0.99, DEFAULT_CONFIG)).toBeUndefined();
    expect(acceptDueAt(undefined, 0.99, DEFAULT_CONFIG)).toBeUndefined();
  });
});

describe("deriveAmount", () => {
  it("returns no proposal and no reviews when there are no amounts", () => {
    const x = baseExtraction({ amounts: [] });
    expect(deriveAmount(x, undefined, DEFAULT_CONFIG)).toEqual({ reviews: [] });
  });

  it("picks CONTRACT over QUOTE when both are confident and consistent", () => {
    const x = baseExtraction({
      amounts: [
        { kind: "QUOTE", amount: 1_000_000, currency: "USD", evidence: "見積", confidence: 0.96 },
        { kind: "CONTRACT", amount: 1_000_000, currency: "JPY", evidence: "契約", confidence: 0.96 },
      ],
    });
    const proposal = deriveAmount(x, undefined, DEFAULT_CONFIG);
    expect(proposal.expectedAmount).toBe(1_000_000);
    expect(proposal.currency).toBe("JPY"); // contract's currency, not quote's
    expect(proposal.reviews).toHaveLength(0);
  });

  it("accepts a lone confident QUOTE", () => {
    const x = baseExtraction({
      amounts: [{ kind: "QUOTE", amount: 500_000, currency: "JPY", evidence: "見積", confidence: 0.95 }],
    });
    const proposal = deriveAmount(x, undefined, DEFAULT_CONFIG);
    expect(proposal.expectedAmount).toBe(500_000);
    expect(proposal.reviews).toHaveLength(0);
  });

  it("creates AMOUNT_AMBIGUOUS when multiple conflicting amounts are present", () => {
    const x = baseExtraction({
      amounts: [
        { kind: "QUOTE", amount: 500_000, currency: "JPY", evidence: "見積A", confidence: 0.96 },
        { kind: "QUOTE", amount: 800_000, currency: "JPY", evidence: "見積B", confidence: 0.96 },
      ],
    });
    const proposal = deriveAmount(x, undefined, DEFAULT_CONFIG);
    expect(proposal.expectedAmount).toBeUndefined();
    expect(proposal.reviews).toHaveLength(1);
    expect(proposal.reviews[0]!.type).toBe("AMOUNT_AMBIGUOUS");
    expect(proposal.reviews[0]!.options?.length).toBe(3); // 2 amounts + "keep"
  });

  it("creates AMOUNT_AMBIGUOUS when an amount below threshold is present", () => {
    const x = baseExtraction({
      amounts: [{ kind: "QUOTE", amount: 500_000, currency: "JPY", evidence: "見積", confidence: 0.5 }],
    });
    const proposal = deriveAmount(x, undefined, DEFAULT_CONFIG);
    expect(proposal.expectedAmount).toBeUndefined();
    expect(proposal.reviews).toHaveLength(1);
  });

  it("creates AMOUNT_AMBIGUOUS instead of silently overwriting a changed existing amount", () => {
    const current = makeOpportunity({ expectedAmount: 500_000 });
    const x = baseExtraction({
      amounts: [{ kind: "QUOTE", amount: 900_000, currency: "JPY", evidence: "新しい見積", confidence: 0.97 }],
    });
    const proposal = deriveAmount(x, current, DEFAULT_CONFIG);
    expect(proposal.expectedAmount).toBeUndefined();
    expect(proposal.reviews).toHaveLength(1);
    expect(proposal.reviews[0]!.type).toBe("AMOUNT_AMBIGUOUS");
    expect(proposal.reviews[0]!.question).toContain("500,000");
    expect(proposal.reviews[0]!.question).toContain("900,000");
  });

  it("does not flag a review when the new amount equals the existing amount", () => {
    const current = makeOpportunity({ expectedAmount: 500_000 });
    const x = baseExtraction({
      amounts: [{ kind: "QUOTE", amount: 500_000, currency: "JPY", evidence: "見積", confidence: 0.97 }],
    });
    const proposal = deriveAmount(x, current, DEFAULT_CONFIG);
    expect(proposal.expectedAmount).toBe(500_000);
    expect(proposal.reviews).toHaveLength(0);
  });

  it("ignores BUDGET-only amounts for automatic application", () => {
    const x = baseExtraction({
      amounts: [{ kind: "BUDGET", amount: 1_000_000, currency: "JPY", evidence: "予算感", confidence: 0.99 }],
    });
    const proposal = deriveAmount(x, undefined, DEFAULT_CONFIG);
    expect(proposal.expectedAmount).toBeUndefined();
    expect(proposal.reviews).toHaveLength(1);
  });
});

describe("amountKindLabel", () => {
  it("labels each kind in Japanese", () => {
    expect(amountKindLabel("QUOTE")).toBe("見積提示額");
    expect(amountKindLabel("CONTRACT")).toBe("契約額");
    expect(amountKindLabel("BUDGET")).toBe("顧客予算");
    expect(amountKindLabel("OTHER")).toBe("その他");
  });
});

describe("derivePriority", () => {
  const ref = "2026-09-08T00:00:00Z";

  it("passes through a non-NORMAL model priority unchanged", () => {
    expect(derivePriority("URGENT", "2026-09-20T00:00:00Z", ref)).toBe("URGENT");
    expect(derivePriority("LOW", undefined, ref)).toBe("LOW");
  });

  it("keeps NORMAL when there is no due date", () => {
    expect(derivePriority("NORMAL", undefined, ref)).toBe("NORMAL");
  });

  it("escalates NORMAL to HIGH when due within 24 hours", () => {
    expect(derivePriority("NORMAL", "2026-09-08T12:00:00Z", ref)).toBe("HIGH");
  });

  it("keeps NORMAL when due more than 24 hours out", () => {
    expect(derivePriority("NORMAL", "2026-09-11T00:00:00Z", ref)).toBe("NORMAL");
  });
});
