/**
 * API contract (設計書 §24 相当). These DTOs are what the Cloudflare OS adapter exposes to the agent
 * (`SalesSession`) and to the management UI. They are plain JSON: no class instances, no stubs.
 */
import type {
  AIContextSnapshot, AIDecision, Activity, AuditLog, Commitment, CustomerAccount, CustomerPerson,
  JsonValue, LifecycleState, NextAction, NextActionStatus, NextActionType, Opportunity, Priority,
  ReviewItem, SourceDocument, SourceType, User, UserRole,
} from "../domain/types.js";
import type { SalesConfig } from "../rules/config.js";

/** Who is calling. Resolved by the adapter from its own identity mechanism. */
export interface Actor {
  userId: string;
}

export interface UserDto {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  managerUserId?: string;
  timezone: string;
  active: boolean;
}

export interface RegisterIdentityInput {
  email: string;
  displayName: string;
  timezone?: string;
  /** Only honoured when `isAdmin` is true; otherwise SALES. The first user ever becomes ADMIN. */
  role?: UserRole;
}

export interface CaptureOptions {
  sourceType?: SourceType;
  /** ISO 8601 date-time of when the reported activity happened, if the user said so. */
  occurredAt?: string;
  /**
   * Pins this memo to a specific opportunity (e.g. captured from that opportunity's own page):
   * customer/deal resolution is skipped entirely and the activity attaches there directly. The
   * caller must be able to see the opportunity.
   */
  opportunityId?: string;
}

/** Result of `SalesService.askQuestion` (「＊＊の状況どうなっている？」). */
export interface AnswerResult {
  /** Empty when `error` is set. */
  answer: string;
  /**
   * Opportunities used as context for the answer — name-matched against the question, or (when
   * nothing matched) the most recently updated ones — so the UI can link straight to them.
   */
  references: { id: string; accountName: string; title: string }[];
  /**
   * True when `references` was matched by name against the question; false when nothing matched
   * and the answer falls back to recently-updated opportunities instead (the UI shows a note).
   */
  matchedByName: boolean;
  /**
   * Name-matched opportunities that have no 窓口 on file, so the answer could not say who to
   * contact. Computed in code (never by the model) so the UI can nudge the rep to register one.
   * Empty on a recent-activity fallback: those cases weren't asked about.
   */
  contactsMissing: { id: string; accountName: string; title: string }[];
  modelProvider?: string;
  modelName?: string;
  error?: string;
}

export interface CaptureResult {
  source: SourceDocument;
  duplicate: boolean;
  opportunity?: OpportunitySummary;
  activity?: Activity;
  nextActions: NextAction[];
  commitments: Commitment[];
  reviews: ReviewDto[];
  decisions: AIDecision[];
  /** AI-proposed next actions below nextActionAutoConfidence — not created, but not thrown away either. */
  suggestions: NextActionSuggestion[];
  notSalesRelated?: boolean;
  error?: string;
}

/**
 * A next action the AI proposed but didn't create outright (confidence below
 * `nextActionAutoConfidence`) — surfaced instead of silently discarded, for one-tap adoption.
 */
export interface NextActionSuggestion {
  /** The NEXT_ACTION AIDecision this came from. */
  decisionId: string;
  /** Index into that decision's appliedJson.skipped — pass back to adopt/dismiss this suggestion. */
  index: number;
  actionType: NextActionType;
  title: string;
  purpose: string;
  dueAt?: string;
  priority: Priority;
  confidence: number;
  /** When the decision (i.e. the capture that proposed this) was made. */
  createdAt: string;
}

export interface OpportunitySummary {
  id: string;
  title: string;
  accountId: string;
  accountName: string;
  accountResolutionStatus: CustomerAccount["resolutionStatus"];
  ownerUserId: string;
  ownerName: string;
  collaboratorUserIds: string[];
  /** This deal's 窓口 (contactPersonIds resolved to names), in the order they were set. */
  contactPersonIds: string[];
  contactNames: string[];
  /** First of contactNames, kept for existing callers; undefined when no contact is set. */
  primaryContactName?: string;
  lifecycleState: LifecycleState;
  operationalState: Opportunity["operationalState"];
  phaseLabel?: string;
  expectedAmount?: number;
  currency?: string;
  expectedCloseDate?: string;
  proposalDocumentUrl?: string;
  riskLevel: Opportunity["riskLevel"];
  riskReason?: string;
  currentSituation?: string;
  nextAction?: NextAction;
  lastMeaningfulActivityAt?: string;
  lastContextRecomputedAt?: string;
  updatedAt: string;
  version: number;
}

export interface OpportunityDetail extends OpportunitySummary {
  account: CustomerAccount;
  persons: CustomerPerson[];
  context?: AIContextSnapshot;
  nextActions: NextAction[];
  /** Not-yet-adopted/dismissed AI proposals, newest first. */
  suggestions: NextActionSuggestion[];
  commitments: Commitment[];
  activities: Activity[];
  sources: SourceDocument[];
  decisions: AIDecision[];
  reviews: ReviewDto[];
  audit: AuditLog[];
}

export interface CustomerDetail {
  account: CustomerAccount;
  persons: CustomerPerson[];
  /** Every opportunity of this customer the caller can see, all lifecycle states, newest update first. */
  opportunities: OpportunitySummary[];
}

export interface OpportunityFilter {
  lifecycleStates?: LifecycleState[];
  ownerUserId?: string;
  accountId?: string;
  expectedAmountGte?: number;
  /** Only opportunities with no meaningful activity for this many days. */
  stalledDays?: number;
  /** Free-text search over title, phase, customer name, the deal's contacts (窓口) and owner name. */
  query?: string;
  limit?: number;
}

export interface OpportunityPatch {
  title?: string;
  phaseLabel?: string | null;
  expectedAmount?: number | null;
  currency?: string;
  expectedCloseDate?: string | null;
  proposalDocumentUrl?: string | null;
  /** Must all be customer_persons of this opportunity's own account, or the update is rejected. */
  contactPersonIds?: string[];
  lifecycleState?: LifecycleState;
  ownerUserId?: string;
  collaboratorUserIds?: string[];
  /** Optimistic concurrency: must equal the version the caller last saw. */
  version: number;
}

/** Company contact details; null or "" clears a field. */
export interface AccountPatch {
  address?: string | null;
  phone?: string | null;
  websiteUrl?: string | null;
}

export interface PersonInput {
  displayName: string;
  title?: string;
  email?: string;
  phone?: string;
}

/** null or "" clears a field; displayName cannot be cleared. */
export interface PersonPatch {
  displayName?: string;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface NextActionFilter {
  assignedUserId?: string;
  opportunityId?: string;
  statuses?: NextActionStatus[];
  /** Due at or before this ISO instant. */
  dueBefore?: string;
  limit?: number;
}

export interface NextActionPatch {
  status?: NextActionStatus;
  /** Only meaningful with SNOOZED; any other status clears it. */
  snoozedUntil?: string | null;
  dueAt?: string | null;
  title?: string;
  purpose?: string;
  priority?: NextAction["priority"];
}

export interface NextActionInput {
  /** Optional caller-chosen id (adapters that must announce the id before the write lands). */
  id?: string;
  opportunityId: string;
  title: string;
  purpose?: string;
  actionType?: NextAction["actionType"];
  dueAt?: string;
  priority?: NextAction["priority"];
  assignedUserId?: string;
}

export interface ReviewDto extends ReviewItem {
  relatedTitle?: string;
  opportunityId?: string;
}

export interface ReviewResolution {
  /** One of the `optionsJson[].id` values. */
  optionId: string;
  /** Free-form input some options require (e.g. `{dueAt}` for DATE_AMBIGUOUS "set"). */
  input?: Record<string, JsonValue>;
}

export interface TodayView {
  user: UserDto;
  /** Local calendar date in the user's timezone. */
  date: string;
  generatedAt: string;
  /** Overdue or due today. */
  now: TodayAction[];
  /** Due within the next 7 days. */
  upcoming: TodayAction[];
  /** Open actions without a due date. */
  undated: TodayAction[];
  reviews: ReviewDto[];
  attention: AttentionItem[];
  recentCaptures: SourceDocument[];
  /** `snoozed`: actions hidden from this view until their snoozedUntil passes. */
  counts: { openOpportunities: number; openActions: number; overdue: number; snoozed: number; openReviews: number };
}

export interface TodayAction {
  action: NextAction;
  opportunity: OpportunitySummary;
  overdue: boolean;
}

export interface AttentionItem {
  opportunity: OpportunitySummary;
  kind: "STALLED" | "HIGH_RISK" | "COMMITMENT_OVERDUE" | "UNRESOLVED_CUSTOMER";
  message: string;
}

export interface ManagerKpis {
  openOpportunities: number;
  expectedAmountTotal: number;
  currency: string;
  /** Lifecycle flipped to WON/LOST this month, approximated by `updatedAt` (there's no separate
   * close-date field) -- the UI labels this "更新月ベース". */
  wonThisMonth: number;
  lostThisMonth: number;
  stalled: number;
  highRisk: number;
  overdueActions: number;
  /** UNRESOLVED customers that still have an OPEN opportunity (an ignorable UNRESOLVED account with
   * no open deal doesn't need a manager's attention). */
  unresolvedCustomers: number;
  openReviews: number;
}

export interface ManagerPerUserRow {
  userId: string;
  displayName: string;
  active: boolean;
  openOpportunities: number;
  expectedAmountTotal: number;
  overdueActions: number;
  stalledOpportunities: number;
  openReviews: number;
  lastCaptureAt?: string;
  capturesLast7Days: number;
}

export interface ManagerSummary {
  generatedAt: string;
  byLifecycle: { lifecycleState: LifecycleState; count: number }[];
  stalled: OpportunitySummary[];
  highRisk: OpportunitySummary[];
  openReviews: number;
  contracting: OpportunitySummary[];
  kpis: ManagerKpis;
  /** Active users first, in the order `listUsers()` returns them; inactive users last. */
  perUser: ManagerPerUserRow[];
}

export type ConfigDto = SalesConfig;

export function toUserDto(u: User): UserDto {
  return {
    id: u.id, email: u.email, displayName: u.displayName, role: u.role,
    managerUserId: u.managerUserId, timezone: u.timezone, active: u.active,
  };
}
