import type { EvalFixture } from "./types.js";

/** Waiting on the seller's own side (an internal approval), not the customer: WAITING_INTERNAL. */
export const fixture: EvalFixture = {
  id: "fixture_004_internal_waiting",
  axes: ["State agreement", "Commitment extraction"],
  description:
    "自社側の決裁待ちであることを WAITING_INTERNAL として、顧客待ちと区別するケース (RULE-06)。",
  sourceType: "TEXT",
  rawText:
    "イプシロン工業の高橋様より特別値引きの相談があり、社内の決裁待ちで先方への回答を保留中。",
  seed: {
    account: { displayName: "イプシロン工業" },
    persons: [{ displayName: "高橋一郎" }],
  },
  extraction: {
    entities: {
      account_candidates: [{ name: "イプシロン工業", confidence: 0.95 }],
      person_candidates: [{ name: "高橋一郎", company: "イプシロン工業", confidence: 0.9 }],
    },
    opportunity: { match: "NEW", title: "特別値引きの相談", confidence: 0.85 },
    activity: {
      type: "CALL", occurred_at: null,
      summary: "イプシロン工業の高橋様より特別値引きの相談。社内決裁待ち。", confidence: 0.9,
    },
    facts: [
      { fact: "特別値引きの相談を受けた", evidence: "特別値引きの相談があり", confidence: 0.9 },
    ],
    decisions: [],
    unresolved: [],
    questions: [],
    objections: [],
    commitments: [
      {
        side: "OUR_COMPANY", description: "値引きの可否を回答する", due_at: null, due_confidence: 0.3,
        evidence: "先方への回答を保留中", confidence: 0.85,
      },
    ],
    amounts: [],
    expected_close_date: null,
    state: {
      operational_state: "WAITING_INTERNAL", lifecycle_state: "OPEN",
      reason: "社内決裁待ち", confidence: 0.9,
    },
    next_actions: [
      {
        action_type: "INTERNAL_COORDINATION", title: "値引き決裁を社内で確認",
        purpose: "顧客への回答のため", due_at: null, due_confidence: 0.3, priority: "HIGH", confidence: 0.88,
      },
    ],
    risk: { level: "LOW", reason: "回答が遅れると心証を損ねる可能性", confidence: 0.85 },
    context: {
      current_situation: "特別値引きの社内決裁待ち",
      latest_development: "値引き相談を受け、社内確認中",
      customer_intent: "値引き次第で導入前向き",
    },
    not_sales_related: false,
  },
  expect: {
    processingStatus: "PROCESSED",
    reviewCount: 0,
    operationalState: "WAITING_INTERNAL",
    nextActionCount: 1,
    commitmentCount: 1,
  },
};
