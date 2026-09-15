import { describe, expect, it } from "vitest";
import { contextSnapshotSchema, extractionSchema, jsonSchemaOf } from "../src/ai/schema.js";

/** 設計書 §14.2 example, filled in with the fields our extractionSchema additionally requires
 *  (entities.person_candidates, opportunity, questions/objections/amounts, context, not_sales_related). */
const DESIGN_DOC_EXAMPLE = {
  entities: {
    account_candidates: [],
    person_candidates: [],
  },
  opportunity: { match: "EXISTING", existing_opportunity_id: "opp-1", title: null, confidence: 0.9 },
  activity: {
    type: "MEETING",
    occurred_at: "2026-09-08T10:00:00+09:00",
    summary: "新サービス提案を実施。価格条件は許容、社内承認待ち。",
    confidence: 0.95,
  },
  facts: [
    { fact: "提示価格は100万円", evidence: "source:12 lines:20-22", confidence: 0.99 },
  ],
  decisions: [],
  unresolved: ["契約開始日"],
  questions: [],
  objections: [],
  commitments: [
    {
      side: "CUSTOMER",
      description: "金曜日までに社内承認結果を回答",
      due_at: "2026-09-11T18:00:00+09:00",
      due_confidence: 0.95,
      evidence: "金曜までに回答する",
      confidence: 0.97,
    },
  ],
  amounts: [],
  state: { operational_state: "WAITING_CUSTOMER", lifecycle_state: "OPEN", confidence: 0.93 },
  next_actions: [
    {
      action_type: "FOLLOW_UP",
      title: "社内承認結果を確認",
      purpose: "契約可否と次工程を確定",
      due_at: "2026-09-14T10:00:00+09:00",
      due_confidence: 0.9,
      priority: "NORMAL",
      confidence: 0.95,
    },
  ],
  risk: { level: "LOW", reason: null, confidence: 0.84 },
  context: {
    current_situation: "100万円提示済み、社内承認待ち",
    latest_development: "顧客は条件を了承し稟議へ",
    customer_intent: "前向き",
  },
  not_sales_related: false,
};

describe("extractionSchema", () => {
  it("accepts the §14.2 example (with required additional fields filled in)", () => {
    const result = extractionSchema.safeParse(DESIGN_DOC_EXAMPLE);
    expect(result.success).toBe(true);
  });

  it("applies defaults for omitted optional arrays", () => {
    const minimal = {
      entities: { account_candidates: [], person_candidates: [] },
      opportunity: { match: "NEW", confidence: 0.5 },
      activity: { type: "NOTE", occurred_at: null, summary: "hi", confidence: 0.5 },
      state: { operational_state: "UNKNOWN", lifecycle_state: "OPEN", confidence: 0.5 },
      risk: { level: "NONE", confidence: 0.5 },
      context: { current_situation: "s", latest_development: "d" },
    };
    const result = extractionSchema.parse(minimal);
    expect(result.facts).toEqual([]);
    expect(result.commitments).toEqual([]);
    expect(result.not_sales_related).toBe(false);
  });

  it("accepts a person candidate's phone (as written, up to 50 chars) and tolerates its absence", () => {
    const withPhone = {
      ...DESIGN_DOC_EXAMPLE,
      entities: {
        account_candidates: [],
        person_candidates: [{ name: "田中", phone: "03-1234-5678", confidence: 0.9 }],
      },
    };
    const parsed = extractionSchema.parse(withPhone);
    expect(parsed.entities.person_candidates[0]?.phone).toBe("03-1234-5678");
    const withoutPhone = {
      ...withPhone,
      entities: { account_candidates: [], person_candidates: [{ name: "田中", confidence: 0.9 }] },
    };
    expect(extractionSchema.safeParse(withoutPhone).success).toBe(true);
  });

  it("rejects an invalid enum value", () => {
    const bad = { ...DESIGN_DOC_EXAMPLE, activity: { ...DESIGN_DOC_EXAMPLE.activity, type: "SMOKE_SIGNAL" } };
    expect(extractionSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an invalid lifecycle_state enum value", () => {
    const bad = { ...DESIGN_DOC_EXAMPLE, state: { ...DESIGN_DOC_EXAMPLE.state, lifecycle_state: "MAYBE" } };
    expect(extractionSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects confidence above 1", () => {
    const bad = { ...DESIGN_DOC_EXAMPLE, activity: { ...DESIGN_DOC_EXAMPLE.activity, confidence: 1.5 } };
    expect(extractionSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects confidence below 0", () => {
    const bad = { ...DESIGN_DOC_EXAMPLE, risk: { ...DESIGN_DOC_EXAMPLE.risk, confidence: -0.1 } };
    expect(extractionSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a due_at that is not null or a string of at least 16 chars", () => {
    const bad = {
      ...DESIGN_DOC_EXAMPLE,
      commitments: [{ ...DESIGN_DOC_EXAMPLE.commitments[0], due_at: "2026" }],
    };
    expect(extractionSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts a null due_at (ambiguous date, RULE-03)", () => {
    const ok = {
      ...DESIGN_DOC_EXAMPLE,
      commitments: [{ ...DESIGN_DOC_EXAMPLE.commitments[0], due_at: null }],
    };
    expect(extractionSchema.safeParse(ok).success).toBe(true);
  });
});

describe("contextSnapshotSchema", () => {
  it("accepts a minimal valid snapshot", () => {
    const result = contextSnapshotSchema.safeParse({
      current_situation: "a", latest_development: "b",
      operational_state: "ACTIVE", state_confidence: 0.9, confidence: 0.9,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid operational_state", () => {
    const result = contextSnapshotSchema.safeParse({
      current_situation: "a", latest_development: "b",
      operational_state: "SOMETHING_ELSE", state_confidence: 0.9, confidence: 0.9,
    });
    expect(result.success).toBe(false);
  });

  it("rejects confidence > 1 on a nested risk field is not applicable, but on top-level fields is", () => {
    const result = contextSnapshotSchema.safeParse({
      current_situation: "a", latest_development: "b",
      operational_state: "ACTIVE", state_confidence: 1.1, confidence: 0.9,
    });
    expect(result.success).toBe(false);
  });
});

describe("jsonSchemaOf", () => {
  it("produces a JSON Schema object with the expected top-level properties for extractionSchema", () => {
    const schema = jsonSchemaOf(extractionSchema) as { properties?: Record<string, unknown> };
    expect(schema.properties).toBeDefined();
    for (const key of ["entities", "opportunity", "activity", "state", "risk", "context", "not_sales_related"]) {
      expect(schema.properties).toHaveProperty(key);
    }
  });

  it("produces a JSON Schema object for contextSnapshotSchema", () => {
    const schema = jsonSchemaOf(contextSnapshotSchema) as { properties?: Record<string, unknown> };
    expect(schema.properties).toHaveProperty("operational_state");
    expect(schema.properties).toHaveProperty("recommended_actions");
  });
});
