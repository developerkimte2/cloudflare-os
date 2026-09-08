import type { EvalFixture } from "./types.js";

/** A quote, a contract amount, and a customer budget in one note: they must not be conflated. */
export const fixture: EvalFixture = {
  id: "fixture_007_multiple_amounts",
  axes: ["RULE-04 金額種別の区別", "False notification"],
  description:
    "見積額・契約額・顧客予算の3種類の金額が混在する商談メモ。複数の確定額が並存する場合は" +
    "自動確定せずレビューに回すことを確認 (RULE-04)。",
  sourceType: "TEXT",
  seed: { account: { displayName: "オメガ電機" } },
  rawText:
    "オメガ電機との商談。当初の見積は300万円だったが、追加オプションを含めた契約額は450万円で先方合意。" +
    "ただし先方の予算上限は500万円とのこと。",
  extraction: {
    entities: {
      account_candidates: [{ name: "オメガ電機", confidence: 0.95 }],
      person_candidates: [],
    },
    opportunity: { match: "NEW", title: "追加オプション込み契約", confidence: 0.85 },
    activity: {
      type: "MEETING", occurred_at: null,
      summary: "オメガ電機と商談。追加オプション込みの契約額450万円で先方合意。", confidence: 0.9,
    },
    facts: [
      { fact: "契約額450万円で先方合意", evidence: "契約額は450万円で先方合意", confidence: 0.92 },
    ],
    decisions: [
      { fact: "追加オプション込みで契約する方向", evidence: "契約額は450万円で先方合意", confidence: 0.85 },
    ],
    unresolved: [],
    questions: [],
    objections: [],
    commitments: [],
    amounts: [
      { kind: "QUOTE", amount: 3000000, currency: "JPY", evidence: "当初の見積は300万円", confidence: 0.95 },
      { kind: "CONTRACT", amount: 4500000, currency: "JPY", evidence: "契約額は450万円で先方合意", confidence: 0.96 },
      { kind: "BUDGET", amount: 5000000, currency: "JPY", evidence: "予算上限は500万円", confidence: 0.9 },
    ],
    expected_close_date: null,
    state: {
      operational_state: "CONTRACTING", lifecycle_state: "OPEN",
      reason: "契約額で先方合意", confidence: 0.9,
    },
    next_actions: [
      {
        action_type: "CONTRACT", title: "契約書を準備", purpose: "合意内容の契約締結",
        due_at: null, due_confidence: 0.3, priority: "HIGH", confidence: 0.9,
      },
    ],
    risk: { level: "NONE", reason: null, confidence: 0.85 },
    context: {
      current_situation: "契約額450万円で先方合意、契約書準備中",
      latest_development: "追加オプション込みの契約額で合意",
      customer_intent: "契約前向き",
    },
    not_sales_related: false,
  },
  expect: {
    processingStatus: "REVIEW_REQUIRED",
    reviewTypesInclude: ["AMOUNT_AMBIGUOUS"],
    expectedAmount: null,
    operationalState: "CONTRACTING",
    nextActionCount: 1,
  },
};
