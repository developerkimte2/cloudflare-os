import type { EvalFixture } from "./types.js";

/** Proposal sent, waiting on the customer's internal approval: must land as WAITING_CUSTOMER. */
export const fixture: EvalFixture = {
  id: "fixture_003_customer_waiting",
  axes: ["State agreement", "Next Action usefulness"],
  description:
    "提案後、先方の社内稟議待ちであることを WAITING_CUSTOMER として正しく区別するケース (RULE-06)。",
  sourceType: "TEXT",
  rawText:
    "デルタ商事の鈴木様に提案書を送付済み。先方で稟議にかけるとのことで、返答待ちの状態。",
  seed: {
    account: { displayName: "デルタ商事" },
    persons: [{ displayName: "鈴木花子" }],
  },
  extraction: {
    entities: {
      account_candidates: [{ name: "デルタ商事", confidence: 0.95 }],
      person_candidates: [{ name: "鈴木花子", company: "デルタ商事", confidence: 0.9 }],
    },
    opportunity: { match: "NEW", title: "提案検討", confidence: 0.85 },
    activity: {
      type: "EMAIL", occurred_at: null,
      summary: "デルタ商事の鈴木様へ提案書を送付。先方社内稟議待ち。", confidence: 0.9,
    },
    facts: [
      { fact: "提案書を送付済み", evidence: "提案書を送付済み", confidence: 0.9 },
      { fact: "先方社内で稟議中", evidence: "先方で稟議にかけるとのことで", confidence: 0.88 },
    ],
    decisions: [],
    unresolved: [],
    questions: [],
    objections: [],
    commitments: [],
    amounts: [],
    expected_close_date: null,
    state: {
      operational_state: "WAITING_CUSTOMER", lifecycle_state: "OPEN",
      reason: "先方社内稟議待ち", confidence: 0.92,
    },
    next_actions: [
      {
        action_type: "FOLLOW_UP", title: "稟議状況の確認", purpose: "提案の検討状況を確認する",
        due_at: null, due_confidence: 0.3, priority: "NORMAL", confidence: 0.87,
      },
    ],
    risk: { level: "LOW", reason: "検討が長引く可能性", confidence: 0.86 },
    context: {
      current_situation: "先方社内稟議待ち",
      latest_development: "提案書送付済み",
      customer_intent: "導入前向き、社内調整中",
    },
    not_sales_related: false,
  },
  expect: {
    processingStatus: "PROCESSED",
    reviewCount: 0,
    operationalState: "WAITING_CUSTOMER",
    nextActionCount: 1,
  },
};
