import type { EvalFixture } from "./types.js";

/**
 * A meeting cancellation. The scripted extraction is deliberately adversarial — it simulates a
 * model that (wrongly) leans toward LOST — to prove the safety net: RULE-02/RULE-05 never let a
 * cancellation auto-close an opportunity, no matter what state the model proposes or how confident
 * it claims to be. 禁止事項 §50-5「Calendar予定キャンセルでLost」.
 */
export const fixture: EvalFixture = {
  id: "fixture_005_calendar_cancel",
  axes: ["False WON/LOST", "Activity extraction"],
  description:
    "商談キャンセルの通知。AIが誤って失注寄りに判断しても、確定させず必ずレビューへ回すことを確認する安全網テスト (RULE-05)。",
  sourceType: "CALENDAR_EVENT",
  seed: {
    account: { displayName: "ゼータ通信" },
    persons: [{ displayName: "田中次郎" }],
  },
  rawText:
    "【キャンセル】ゼータ通信 田中様との定例商談 — 先方都合により本日の打合せはキャンセルとなりました。" +
    "次回日程は改めて調整。",
  extraction: {
    entities: {
      account_candidates: [{ name: "ゼータ通信", confidence: 0.95 }],
      person_candidates: [{ name: "田中次郎", company: "ゼータ通信", confidence: 0.9 }],
    },
    opportunity: { match: "NEW", title: "定例商談", confidence: 0.85 },
    activity: {
      type: "CALENDAR", occurred_at: null,
      summary: "ゼータ通信との定例商談が先方都合によりキャンセルされた。", confidence: 0.85,
    },
    facts: [
      { fact: "定例商談がキャンセルされた", evidence: "本日の打合せはキャンセルとなりました", confidence: 0.9 },
    ],
    decisions: [],
    unresolved: ["次回の日程"],
    questions: [],
    objections: [],
    commitments: [],
    amounts: [],
    expected_close_date: null,
    // Deliberately wrong: a cancellation is not a loss. The pipeline must not trust this.
    state: {
      operational_state: "BLOCKED", lifecycle_state: "LOST",
      reason: "商談がキャンセルされたため", confidence: 0.7,
    },
    next_actions: [
      {
        action_type: "MEETING", title: "再調整の打診", purpose: "キャンセルされた商談の日程を再調整する",
        due_at: null, due_confidence: 0.3, priority: "NORMAL", confidence: 0.86,
      },
    ],
    risk: { level: "LOW", reason: "日程調整の遅れ", confidence: 0.8 },
    context: {
      current_situation: "定例商談が先方都合でキャンセルされ、再調整が必要",
      latest_development: "商談キャンセルの連絡を受信",
      customer_intent: null,
    },
    not_sales_related: false,
  },
  expect: {
    processingStatus: "REVIEW_REQUIRED",
    reviewTypesInclude: ["STATE_AMBIGUOUS"],
    lifecycleState: "OPEN",
    activityType: "CALENDAR",
    nextActionCount: 1,
  },
};
