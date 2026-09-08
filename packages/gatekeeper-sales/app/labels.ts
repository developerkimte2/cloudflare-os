/**
 * Japanese display labels for the domain's fixed enums. `management-types.ts` re-exports only the
 * DTO interfaces (not their nested enum types), so each enum is derived from the field that carries
 * it rather than imported by name.
 */
import type {
  Commitment,
  NextAction,
  OpportunityDetail,
  OpportunitySummary,
  ReviewDto,
  SourceDocument,
  UserDto,
} from "../src/management-types";

type LifecycleState = OpportunitySummary["lifecycleState"];
type OperationalState = OpportunitySummary["operationalState"];
type RiskLevel = OpportunitySummary["riskLevel"];
type ReviewItemType = ReviewDto["type"];
type ActivityType = OpportunityDetail["activities"][number]["type"];
type UserRole = UserDto["role"];

export const LIFECYCLE_LABEL: Record<LifecycleState, string> = {
  OPEN: "進行中",
  WON: "受注",
  LOST: "失注",
  ON_HOLD: "保留",
  CLOSED: "終了",
};

export const OPERATIONAL_LABEL: Record<OperationalState, string> = {
  UNKNOWN: "不明",
  ACTIVE: "動いている",
  WAITING_CUSTOMER: "客先回答待ち",
  WAITING_INTERNAL: "社内対応待ち",
  FOLLOWUP_REQUIRED: "要フォロー",
  SCHEDULED: "予定あり",
  BLOCKED: "停滞",
  CONTRACTING: "契約手続き中",
};

export const RISK_LABEL: Record<RiskLevel, string> = {
  NONE: "なし",
  LOW: "低",
  MEDIUM: "中",
  HIGH: "高",
};

export const NEXT_ACTION_STATUS_LABEL: Record<NextAction["status"], string> = {
  OPEN: "未完了",
  DONE: "完了",
  SNOOZED: "スヌーズ中",
  CANCELLED: "取消",
};

export const NEXT_ACTION_TYPE_LABEL: Record<NextAction["actionType"], string> = {
  CALL: "電話",
  MEETING: "商談",
  EMAIL: "メール",
  FOLLOW_UP: "フォローアップ",
  PROPOSAL: "提案",
  NEGOTIATION: "交渉",
  CONTRACT: "契約",
  INTERNAL_COORDINATION: "社内調整",
  REVIEW: "レビュー",
  OTHER: "その他",
};

export const PRIORITY_LABEL: Record<NextAction["priority"], string> = {
  LOW: "低",
  NORMAL: "通常",
  HIGH: "高",
  URGENT: "至急",
};

export const COMMITMENT_STATUS_LABEL: Record<Commitment["status"], string> = {
  OPEN: "未履行",
  FULFILLED: "履行済み",
  OVERDUE: "期限超過",
  CANCELLED: "取消",
  UNKNOWN: "不明",
};

export const COMMITMENT_SIDE_LABEL: Record<Commitment["side"], string> = {
  CUSTOMER: "顧客",
  OUR_COMPANY: "自社",
};

export const REVIEW_TYPE_LABEL: Record<ReviewItemType, string> = {
  CUSTOMER_AMBIGUOUS: "顧客の特定",
  OPPORTUNITY_AMBIGUOUS: "案件の特定",
  DATE_AMBIGUOUS: "日付の確認",
  AMOUNT_AMBIGUOUS: "金額の確認",
  STATE_AMBIGUOUS: "状態の確認",
  HIGH_RISK_ACTION: "重要な確認",
  OTHER: "その他の確認",
};

export const SOURCE_TYPE_LABEL: Record<SourceDocument["sourceType"], string> = {
  VOICE: "音声",
  AUDIO: "録音",
  TRANSCRIPT: "議事録",
  EMAIL: "メール",
  CALENDAR_EVENT: "カレンダー",
  CHAT: "チャット",
  TEXT: "テキスト",
  FILE: "ファイル",
};

export const PROCESSING_STATUS_LABEL: Record<SourceDocument["processingStatus"], string> = {
  RECEIVED: "受付済み",
  PROCESSING: "処理中",
  PROCESSED: "処理済み",
  REVIEW_REQUIRED: "要確認",
  FAILED: "失敗",
  REVERTED: "取消済み",
};

export const ACTIVITY_TYPE_LABEL: Record<ActivityType, string> = {
  MEETING: "商談",
  CALL: "電話",
  EMAIL: "メール",
  CHAT: "チャット",
  NOTE: "メモ",
  FILE: "ファイル",
  CALENDAR: "カレンダー",
  SYSTEM: "システム",
};

export const ROLE_LABEL: Record<UserRole, string> = {
  SALES: "営業",
  MANAGER: "マネージャー",
  ADMIN: "管理者",
};

export const ATTENTION_LABEL: Record<
  "STALLED" | "HIGH_RISK" | "COMMITMENT_OVERDUE" | "UNRESOLVED_CUSTOMER",
  string
> = {
  STALLED: "停滞",
  HIGH_RISK: "高リスク",
  COMMITMENT_OVERDUE: "約束の期限超過",
  UNRESOLVED_CUSTOMER: "顧客未確定",
};
