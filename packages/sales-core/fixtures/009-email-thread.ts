import type { EvalFixture } from "./types.js";

/** An EMAIL-sourced reply that resolves the contact by their exact email address (EMAIL_EXACT). */
export const fixture: EvalFixture = {
  id: "fixture_009_email_thread",
  axes: ["Entity Precision", "Activity extraction", "Next Action usefulness"],
  description:
    "メールスレッドからの取り込み。ソース種別が EMAIL であること、担当者のメールアドレスによる" +
    "自動紐付け (EMAIL_EXACT) を確認する。",
  sourceType: "EMAIL",
  seed: {
    account: { displayName: "ラムダシステムズ", primaryDomain: "lambda-systems.co.jp" },
    persons: [{ displayName: "佐藤美咲", email: "m.sato@lambda-systems.co.jp" }],
  },
  rawText:
    "件名: Re: 見積のご相談\n" +
    "佐藤様(m.sato@lambda-systems.co.jp)より返信あり。追加要件として管理者向けダッシュボードの" +
    "実装希望とのこと。来週火曜に打合せを設定したい。",
  extraction: {
    entities: {
      account_candidates: [{ name: "ラムダシステムズ", domain: "lambda-systems.co.jp", confidence: 0.9 }],
      person_candidates: [
        { name: "佐藤美咲", company: "ラムダシステムズ", email: "m.sato@lambda-systems.co.jp", confidence: 0.95 },
      ],
    },
    opportunity: { match: "NEW", title: "管理者ダッシュボードの追加要件", confidence: 0.85 },
    activity: {
      type: "EMAIL", occurred_at: null,
      summary: "佐藤様より返信。管理者向けダッシュボードの追加要件と来週火曜の打合せ希望。",
      confidence: 0.9,
    },
    facts: [
      { fact: "管理者向けダッシュボードの追加要望", evidence: "管理者向けダッシュボードの実装希望", confidence: 0.9 },
    ],
    decisions: [],
    unresolved: [],
    questions: [],
    objections: [],
    commitments: [],
    amounts: [],
    expected_close_date: null,
    state: { operational_state: "ACTIVE", lifecycle_state: "OPEN", reason: null, confidence: 0.88 },
    next_actions: [
      {
        action_type: "MEETING", title: "追加要件のヒアリング打合せを設定",
        purpose: "管理者ダッシュボードの要件確認", due_at: null, due_confidence: 0.3,
        priority: "NORMAL", confidence: 0.87,
      },
    ],
    risk: { level: "NONE", reason: null, confidence: 0.8 },
    context: {
      current_situation: "管理者向けダッシュボードの追加要件について打合せ設定待ち",
      latest_development: "佐藤様より追加要件の連絡",
      customer_intent: "機能拡張に前向き",
    },
    not_sales_related: false,
  },
  expect: {
    processingStatus: "PROCESSED",
    reviewCount: 0,
    accountResolved: true,
    accountDisplayName: "ラムダシステムズ",
    activityType: "EMAIL",
    nextActionCount: 1,
  },
};
