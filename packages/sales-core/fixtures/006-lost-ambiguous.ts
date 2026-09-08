import type { EvalFixture } from "./types.js";

/** A customer signals they may pass this time. Even a confident model call must go to review. */
export const fixture: EvalFixture = {
  id: "fixture_006_lost_ambiguous",
  axes: ["False WON/LOST", "Next Action usefulness"],
  description:
    "顧客が「今回は見送り」と発言した商談メモ。AIがLOSTと判定してもレビュー必須で確定しないことを確認 (RULE-02)。",
  sourceType: "TEXT",
  seed: {
    account: { displayName: "シータ物産" },
    persons: [{ displayName: "伊藤さくら" }],
  },
  rawText:
    "シータ物産の伊藤様と最終確認の電話。今回は予算の都合で見送りたいとのお話があった。" +
    "来期また検討したいとのこと。",
  extraction: {
    entities: {
      account_candidates: [{ name: "シータ物産", confidence: 0.95 }],
      person_candidates: [{ name: "伊藤さくら", company: "シータ物産", confidence: 0.9 }],
    },
    opportunity: { match: "NEW", title: "導入検討", confidence: 0.85 },
    activity: {
      type: "CALL", occurred_at: null,
      summary: "シータ物産の伊藤様と電話。今回は予算都合で見送りの意向。来期改めて検討したいとのこと。",
      confidence: 0.9,
    },
    facts: [
      { fact: "予算都合で今回は見送りの意向", evidence: "今回は予算の都合で見送りたい", confidence: 0.9 },
      { fact: "来期改めて検討したいとの意向", evidence: "来期また検討したい", confidence: 0.85 },
    ],
    decisions: [],
    unresolved: [],
    questions: [],
    objections: ["予算都合"],
    commitments: [],
    amounts: [],
    expected_close_date: null,
    state: {
      operational_state: "BLOCKED", lifecycle_state: "LOST",
      reason: "予算都合で見送りの意向", confidence: 0.88,
    },
    next_actions: [
      {
        action_type: "FOLLOW_UP", title: "来期の予算状況を確認", purpose: "来期の再提案に向けて",
        due_at: null, due_confidence: 0.3, priority: "LOW", confidence: 0.85,
      },
    ],
    risk: { level: "HIGH", reason: "失注の可能性が高い", confidence: 0.85 },
    context: {
      current_situation: "予算都合により今回は見送りの意向、来期の再検討に期待",
      latest_development: "見送りの意向を確認",
      customer_intent: "来期また検討したい",
    },
    not_sales_related: false,
  },
  expect: {
    processingStatus: "REVIEW_REQUIRED",
    reviewTypesInclude: ["STATE_AMBIGUOUS"],
    lifecycleState: "OPEN",
    nextActionCount: 1,
  },
};
