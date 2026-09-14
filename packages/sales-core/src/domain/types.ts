/**
 * Sales Context Core domain model. Mirrors 設計書 §11 (データモデル).
 *
 * All timestamps are ISO 8601 strings in UTC. Display-time conversion to the user's timezone
 * (default Asia/Tokyo) happens at the edge (設計書 NFR-06).
 */

/**
 * JSON-compatible value. Used for every free-form column so DTOs stay serializable over Workers RPC
 * (`unknown` is not; `undefined` is allowed because optional properties carry it).
 */
export type JsonValue =
  | string | number | boolean | null | undefined | JsonValue[] | { [key: string]: JsonValue };

export type UserRole = "SALES" | "MANAGER" | "ADMIN";

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  managerUserId?: string;
  timezone: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Binds an identity asserted by an outer system (e.g. a Cloudflare OS auto-provisioned account id,
 * or a Cloudflare Access email) to a Sales OS user. Not part of 設計書 §11; it is the seam that keeps
 * the Sales domain independent of any one identity provider (設計書 §7.3).
 */
export interface ExternalIdentity {
  provider: string;
  externalId: string;
  userId: string;
  createdAt: string;
}

export type ResolutionStatus = "RESOLVED" | "UNRESOLVED" | "MANUAL";

export interface CustomerAccount {
  id: string;
  displayName: string;
  normalizedName?: string;
  primaryDomain?: string;
  /** Company contact details, entered by hand from the opportunity page. */
  address?: string;
  phone?: string;
  websiteUrl?: string;
  externalProvider?: string;
  externalAccountId?: string;
  resolutionStatus: ResolutionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerPerson {
  id: string;
  accountId?: string;
  displayName: string;
  normalizedName?: string;
  email?: string;
  phone?: string;
  title?: string;
  externalProvider?: string;
  externalPersonId?: string;
  resolutionStatus: ResolutionStatus;
  createdAt: string;
  updatedAt: string;
}

export type LifecycleState = "OPEN" | "WON" | "LOST" | "ON_HOLD" | "CLOSED";

export type OperationalState =
  | "UNKNOWN"
  | "ACTIVE"
  | "WAITING_CUSTOMER"
  | "WAITING_INTERNAL"
  | "FOLLOWUP_REQUIRED"
  | "SCHEDULED"
  | "BLOCKED"
  | "CONTRACTING";

export type RiskLevel = "NONE" | "LOW" | "MEDIUM" | "HIGH";

export interface Opportunity {
  id: string;
  accountId: string;
  title: string;
  ownerUserId: string;
  collaboratorUserIds: string[];
  lifecycleState: LifecycleState;
  operationalState: OperationalState;
  /** Company-configurable phase name. Never a domain constraint (設計書 §11.4 重要). */
  phaseLabel?: string;
  expectedAmount?: number;
  currency?: string;
  expectedCloseDate?: string;
  /** Free-form link to the proposal/quote material for this deal (Drive, Slides, etc.). */
  proposalDocumentUrl?: string;
  /** This deal's 窓口: ids into customer_persons, always of this opportunity's own account. */
  contactPersonIds?: string[];
  nextActionId?: string;
  lastMeaningfulActivityAt?: string;
  lastContextRecomputedAt?: string;
  riskLevel: RiskLevel;
  riskReason?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type ActivityType =
  | "MEETING"
  | "CALL"
  | "EMAIL"
  | "CHAT"
  | "NOTE"
  | "FILE"
  | "CALENDAR"
  | "SYSTEM";

export interface Activity {
  id: string;
  opportunityId?: string;
  accountId?: string;
  personIds: string[];
  actorUserIds: string[];
  type: ActivityType;
  occurredAt: string;
  sourceId: string;
  summary: string;
  factsJson: JsonValue;
  questionsJson: JsonValue;
  objectionsJson: JsonValue;
  commitmentsJson: JsonValue;
  decisionsJson: JsonValue;
  aiConfidence?: number;
  createdAt: string;
}

export type CommitmentSide = "CUSTOMER" | "OUR_COMPANY";
export type CommitmentStatus = "OPEN" | "FULFILLED" | "OVERDUE" | "CANCELLED" | "UNKNOWN";

export interface Commitment {
  id: string;
  opportunityId: string;
  side: CommitmentSide;
  ownerPersonId?: string;
  ownerUserId?: string;
  description: string;
  dueAt?: string;
  status: CommitmentStatus;
  sourceEvidenceId: string;
  createdAt: string;
  updatedAt: string;
}

export type NextActionType =
  | "CALL"
  | "MEETING"
  | "EMAIL"
  | "FOLLOW_UP"
  | "PROPOSAL"
  | "NEGOTIATION"
  | "CONTRACT"
  | "INTERNAL_COORDINATION"
  | "REVIEW"
  | "OTHER";

export type Priority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export type NextActionStatus = "OPEN" | "DONE" | "SNOOZED" | "CANCELLED";
export type GeneratedBy = "AI" | "USER" | "SYSTEM";

export interface NextAction {
  id: string;
  opportunityId: string;
  assignedUserId: string;
  actionType: NextActionType;
  title: string;
  purpose: string;
  dueAt?: string;
  recommendedAt?: string;
  priority: Priority;
  status: NextActionStatus;
  /** While SNOOZED, the action stays off the Today view until this instant. Unset = no wake-up. */
  snoozedUntil?: string;
  generatedBy: GeneratedBy;
  sourceDecisionId?: string;
  createdAt: string;
  updatedAt: string;
}

export type SourceType =
  | "VOICE"
  | "AUDIO"
  | "TRANSCRIPT"
  | "EMAIL"
  | "CALENDAR_EVENT"
  | "CHAT"
  | "TEXT"
  | "FILE";

export type ProcessingStatus =
  | "RECEIVED"
  | "PROCESSING"
  | "PROCESSED"
  | "REVIEW_REQUIRED"
  | "FAILED"
  | "REVERTED";

export interface SourceDocument {
  id: string;
  sourceType: SourceType;
  externalId?: string;
  submittedByUserId?: string;
  r2ObjectKey?: string;
  rawText?: string;
  contentHash: string;
  occurredAt?: string;
  receivedAt: string;
  processingStatus: ProcessingStatus;
  processingError?: string;
  processedAt?: string;
  /**
   * When set, this memo is pinned to a specific opportunity: applyExtraction skips customer/deal
   * resolution entirely and attaches the activity there directly (CaptureOptions.opportunityId, or
   * a MEMO_TARGET review answered with an existing deal).
   */
  targetOpportunityId?: string;
}

export interface CalendarEventMirror {
  id: string;
  googleCalendarId: string;
  googleEventId: string;
  ownerUserId: string;
  title: string;
  description?: string;
  attendeesJson: JsonValue;
  organizerEmail?: string;
  meetingUrl?: string;
  startAt: string;
  endAt: string;
  status: string;
  accountId?: string;
  opportunityId?: string;
  resolutionConfidence?: number;
  etag?: string;
  lastSyncedAt: string;
}

export interface AIContextSnapshot {
  id: string;
  opportunityId: string;
  currentSituation: string;
  latestDevelopment: string;
  customerIntent?: string;
  decidedJson: JsonValue;
  unresolvedJson: JsonValue;
  risksJson: JsonValue;
  commitmentsJson: JsonValue;
  recommendedActionsJson: JsonValue;
  evidenceIdsJson: string[];
  modelProvider: string;
  modelName: string;
  promptVersion: string;
  schemaVersion: string;
  confidenceJson: JsonValue;
  createdAt: string;
}

export type AIDecisionType =
  | "ENTITY_RESOLUTION"
  | "OPPORTUNITY_RESOLUTION"
  | "STATE_CHANGE"
  | "NEXT_ACTION"
  | "RISK"
  | "COMMITMENT"
  | "NOTIFICATION";

export type AIDecisionStatus = "AUTO_APPLIED" | "REVIEW_REQUIRED" | "APPROVED" | "REJECTED" | "REVERTED";

export interface AIDecision {
  id: string;
  entityType: string;
  entityId: string;
  decisionType: AIDecisionType;
  inputSourceIds: string[];
  proposedJson: JsonValue;
  appliedJson?: JsonValue;
  confidence: number;
  status: AIDecisionStatus;
  reasoningSummary: string;
  evidenceJson: JsonValue;
  modelName: string;
  promptVersion: string;
  createdAt: string;
}

export type ReviewItemType =
  | "CUSTOMER_AMBIGUOUS"
  | "OPPORTUNITY_AMBIGUOUS"
  | "DATE_AMBIGUOUS"
  | "AMOUNT_AMBIGUOUS"
  | "STATE_AMBIGUOUS"
  | "HIGH_RISK_ACTION"
  /** A person was mentioned but no company at all — "which deal is this?" instead of guessing. */
  | "MEMO_TARGET"
  | "OTHER";

export type ReviewStatus = "OPEN" | "RESOLVED" | "DISMISSED";

export interface ReviewOption {
  id: string;
  label: string;
  /** Free-form payload the resolver applies (e.g. `{accountId}` or `{lifecycleState:"WON"}`). */
  value?: JsonValue;
}

export interface ReviewItem {
  id: string;
  type: ReviewItemType;
  assignedUserId?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  question: string;
  optionsJson?: ReviewOption[];
  sourceEvidenceIds: string[];
  status: ReviewStatus;
  resolutionJson?: JsonValue;
  createdAt: string;
  resolvedAt?: string;
}

export type ActorType = "USER" | "AI" | "SYSTEM" | "ADMIN";

export interface AuditLog {
  id: string;
  actorType: ActorType;
  actorId?: string;
  action: string;
  entityType: string;
  entityId: string;
  beforeJson?: JsonValue;
  afterJson?: JsonValue;
  sourceIds?: string[];
  aiDecisionId?: string;
  createdAt: string;
}

export interface NotificationLog {
  id: string;
  userId: string;
  channel: "SLACK" | "IN_APP" | "EMAIL";
  notificationType: string;
  entityType?: string;
  entityId?: string;
  messageHash: string;
  sentAt: string;
  status: "SENT" | "FAILED" | "SKIPPED_DUPLICATE";
}

/**
 * Records what one processed source produced, so the whole application can be reverted as a unit
 * (設計書 AC-008). Implementation detail, not a §11 entity.
 */
export interface SourceApplication {
  sourceId: string;
  opportunityId?: string;
  activityId?: string;
  createdCommitmentIds: string[];
  createdNextActionIds: string[];
  createdReviewIds: string[];
  createdAccountId?: string;
  createdPersonIds: string[];
  createdOpportunity: boolean;
  snapshotId?: string;
  opportunityBefore?: Opportunity;
  decisionIds: string[];
  appliedAt: string;
  revertedAt?: string;
}
