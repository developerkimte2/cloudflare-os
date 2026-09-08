import type { EvalFixture } from "./types.js";

/** A brand-new company name with no existing record: must never auto-link, even at high stated confidence. */
export const fixture: EvalFixture = {
  id: "fixture_002_ambiguous_customer",
  axes: ["Entity Precision", "False notification"],
  description:
    "新規の企業名のみで担当者情報が薄いケース。AIは高い確信度を主張するが、" +
    "既存顧客に無いため自動紐付けせずレビューに回すことを確認する (AC-003, RULE §13)。",
  sourceType: "TEXT",
  rawText: "新規で問い合わせのあったグローバルテック社と初回の電話を行った。導入検討中とのこと。",
  extraction: {
    entities: {
      account_candidates: [{ name: "グローバルテック社", confidence: 0.97 }],
      person_candidates: [],
    },
    opportunity: { match: "NEW", title: "導入検討", confidence: 0.8 },
    activity: {
      type: "CALL", occurred_at: null,
      summary: "グローバルテック社と初回架電。導入検討中とのこと。", confidence: 0.85,
    },
    facts: [],
    decisions: [],
    unresolved: ["先方の予算・導入時期は未確認"],
    questions: [],
    objections: [],
    commitments: [],
    amounts: [],
    expected_close_date: null,
    state: { operational_state: "ACTIVE", lifecycle_state: "OPEN", reason: null, confidence: 0.8 },
    next_actions: [],
    risk: { level: "NONE", reason: null, confidence: 0.8 },
    context: {
      current_situation: "新規リードとの初回接触",
      latest_development: "初回架電を実施",
      customer_intent: "導入検討中",
    },
    not_sales_related: false,
  },
  expect: {
    processingStatus: "REVIEW_REQUIRED",
    reviewTypesInclude: ["CUSTOMER_AMBIGUOUS"],
    accountResolved: false,
  },
};
