import type { EvalFixture } from "./types.js";

/** The happy path: an established customer and contact, a plain meeting note. */
export const fixture: EvalFixture = {
  id: "fixture_001_simple_meeting",
  axes: ["Entity Precision", "Activity extraction", "Commitment extraction", "State agreement"],
  description:
    "通常の商談メモ。既存顧客・既存担当者に自動で紐付き、レビュー無しで処理される基本ケース。",
  sourceType: "TEXT",
  rawText:
    "ABC株式会社の山田様と定例のオンライン商談を実施。新機能の要望をヒアリングし、" +
    "来月中旬までに見積を送る約束をした。先方も前向きな反応。",
  seed: {
    account: { displayName: "ABC株式会社" },
    persons: [{ displayName: "山田太郎" }],
  },
  extraction: {
    entities: {
      account_candidates: [{ name: "ABC株式会社", confidence: 0.95 }],
      person_candidates: [{ name: "山田太郎", company: "ABC株式会社", confidence: 0.9 }],
    },
    opportunity: { match: "NEW", title: "新機能要望への見積対応", confidence: 0.85 },
    activity: {
      type: "MEETING", occurred_at: null,
      summary: "ABC株式会社の山田様とオンライン商談。新機能の要望をヒアリング。",
      confidence: 0.92,
    },
    facts: [
      { fact: "新機能の要望をヒアリングした", evidence: "新機能の要望をヒアリングし", confidence: 0.9 },
    ],
    decisions: [],
    unresolved: [],
    questions: [],
    objections: [],
    commitments: [
      {
        side: "OUR_COMPANY", description: "見積を送付する", due_at: null, due_confidence: 0.3,
        evidence: "来月中旬までに見積を送る約束をした", confidence: 0.85,
      },
    ],
    amounts: [],
    expected_close_date: null,
    state: { operational_state: "ACTIVE", lifecycle_state: "OPEN", reason: null, confidence: 0.9 },
    next_actions: [
      {
        action_type: "PROPOSAL", title: "見積書を送付", purpose: "新機能要望への対応",
        due_at: null, due_confidence: 0.3, priority: "NORMAL", confidence: 0.88,
      },
    ],
    risk: { level: "NONE", reason: null, confidence: 0.9 },
    context: {
      current_situation: "新機能の要望に対する見積提示待ち",
      latest_development: "定例商談で要望をヒアリング",
      customer_intent: "前向き",
    },
    not_sales_related: false,
  },
  expect: {
    processingStatus: "PROCESSED",
    reviewCount: 0,
    accountResolved: true,
    accountDisplayName: "ABC株式会社",
    activityType: "MEETING",
    operationalState: "ACTIVE",
    nextActionCount: 1,
    commitmentCount: 1,
  },
};
