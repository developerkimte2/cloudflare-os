/**
 * Japanese display labels for the domain's fixed enums. `management-types.ts` re-exports only the
 * DTO interfaces (not their nested enum types), so each enum is derived from the field that carries
 * it rather than imported by name.
 */
import type {
  AuditLog,
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
type AIDecisionType = OpportunityDetail["decisions"][number]["decisionType"];
type AIDecisionStatus = OpportunityDetail["decisions"][number]["status"];
type ActorType = AuditLog["actorType"];

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
  MEMO_TARGET: "宛先の確認",
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

export const DECISION_TYPE_LABEL: Record<AIDecisionType, string> = {
  ENTITY_RESOLUTION: "顧客の特定",
  OPPORTUNITY_RESOLUTION: "案件の特定",
  STATE_CHANGE: "状態の判定",
  NEXT_ACTION: "次アクション",
  RISK: "リスク評価",
  COMMITMENT: "約束の抽出",
  NOTIFICATION: "通知",
};

export const DECISION_STATUS_LABEL: Record<AIDecisionStatus, string> = {
  AUTO_APPLIED: "自動反映",
  REVIEW_REQUIRED: "確認待ち",
  APPROVED: "承認済み",
  REJECTED: "却下",
  REVERTED: "取消",
};

export const ACTOR_TYPE_LABEL: Record<ActorType, string> = {
  USER: "担当者",
  AI: "AI",
  SYSTEM: "システム",
  ADMIN: "管理者",
};

/**
 * `AuditLog.action` / `.entityType` are plain `string` in the domain (not a closed union), so these
 * are lookup tables with an English fallback for anything not listed rather than exhaustive Records.
 */
export const AUDIT_ACTION_LABEL: Record<string, string> = {
  ACTIVITY_CREATED: "活動を記録",
  ACTIVITY_DETACHED: "活動の紐付けを解除",
  COMMITMENT_DUE_SET: "約束の期限を設定",
  COMMITMENT_UPDATED: "約束を更新",
  CONFIG_UPDATED: "設定を変更",
  CONTEXT_RECOMPUTED: "AI整理を再計算",
  CUSTOMER_CONFIRMED_NEW: "新規顧客として確定",
  CUSTOMER_MERGED: "顧客を統合",
  CUSTOMER_UPDATED: "会社情報を更新",
  NEXT_ACTION_CREATED: "次アクションを作成",
  NEXT_ACTION_DUE_SET: "次アクションの期限を設定",
  NEXT_ACTION_UPDATED: "次アクションを更新",
  OPPORTUNITY_DELETED: "案件を削除",
  OPPORTUNITY_EDITED: "案件を編集",
  OPPORTUNITY_MERGED: "案件を統合",
  OPPORTUNITY_RESTORED: "案件を復元",
  PERSON_CREATED: "顧客担当者を追加",
  PERSON_UPDATED: "顧客担当者を更新",
  REVIEW_DISMISSED: "確認を却下",
  REVIEW_RESOLVED: "確認を解決",
  SOURCE_DISCARDED: "取込を破棄",
  SOURCE_FAILED: "取込が失敗",
  SOURCE_KEPT_AS_MEMO: "メモとして保存（案件に紐付けなし）",
  SOURCE_PROCESSED: "取込を処理",
  SOURCE_RECEIVED: "取込を受付",
  SOURCE_REVERTED: "取込を取消",
  SUGGESTION_DISMISSED: "AI提案を却下",
  USER_CREATED: "メンバーを作成",
  USER_ROLE_CHANGED: "役割を変更",
  USER_UPDATED: "メンバーを更新",
};

export const ENTITY_TYPE_LABEL: Record<string, string> = {
  activity: "活動",
  commitment: "約束",
  customer_account: "顧客",
  customer_person: "顧客担当者",
  next_action: "次アクション",
  opportunity: "案件",
  review_item: "確認",
  settings: "設定",
  source_document: "取込",
  user: "メンバー",
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
