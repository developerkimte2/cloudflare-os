import type { EvalFixture } from "./types.js";

/**
 * A vague relative date ("来週中"). Even when the model guesses a concrete ISO instant for it, a
 * low `due_confidence` must keep the pipeline from treating that guess as a confirmed deadline.
 */
export const fixture: EvalFixture = {
  id: "fixture_008_relative_date",
  axes: ["Date accuracy", "Commitment extraction"],
  description:
    "「来週中には」という曖昧な相対日付表現。AIが具体的なISO日時を出力しても確信度が閾値未満なら" +
    "期限を確定せずレビューに回すことを確認 (RULE-03)。",
  sourceType: "TEXT",
  seed: {
    account: { displayName: "カッパ商会" },
    persons: [{ displayName: "渡辺健" }],
  },
  rawText:
    "カッパ商会の渡辺様と電話。来週中には先方社内の意思決定が出るとのことで、" +
    "その後改めて連絡をもらう約束。",
  extraction: {
    entities: {
      account_candidates: [{ name: "カッパ商会", confidence: 0.95 }],
      person_candidates: [{ name: "渡辺健", company: "カッパ商会", confidence: 0.9 }],
    },
    opportunity: { match: "NEW", title: "意思決定待ち", confidence: 0.85 },
    activity: {
      type: "CALL", occurred_at: null,
      summary: "カッパ商会の渡辺様と電話。来週中に社内意思決定の見込み。", confidence: 0.88,
    },
    facts: [
      { fact: "来週中に社内意思決定が出る見込み", evidence: "来週中には先方社内の意思決定が出る", confidence: 0.85 },
    ],
    decisions: [],
    unresolved: [],
    questions: [],
    objections: [],
    commitments: [
      {
        side: "CUSTOMER", description: "意思決定の結果を連絡する",
        // The model guesses a specific date from "来週中" but is not confident in it — RULE-03
        // requires the pipeline to not accept this guess as a confirmed deadline.
        due_at: "2026-09-15T09:00:00.000Z", due_confidence: 0.4,
        evidence: "来週中には先方社内の意思決定が出る", confidence: 0.85,
      },
    ],
    amounts: [],
    expected_close_date: null,
    state: {
      operational_state: "WAITING_CUSTOMER", lifecycle_state: "OPEN",
      reason: "先方社内の意思決定待ち", confidence: 0.88,
    },
    next_actions: [],
    risk: { level: "NONE", reason: null, confidence: 0.8 },
    context: {
      current_situation: "先方社内の意思決定待ち",
      latest_development: "来週中に結果連絡をもらう約束",
      customer_intent: "検討中",
    },
    not_sales_related: false,
  },
  expect: {
    processingStatus: "REVIEW_REQUIRED",
    reviewTypesInclude: ["DATE_AMBIGUOUS"],
    operationalState: "WAITING_CUSTOMER",
    commitmentCount: 1,
  },
};
