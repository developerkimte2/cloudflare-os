/**
 * API contract (設計書 §24 相当). These DTOs are what the Cloudflare OS adapter exposes to the agent
 * (`SalesSession`) and to the management UI. They are plain JSON: no class instances, no stubs.
 */
import type {
  AIContextSnapshot, AIDecision, Activity, AuditLog, Commitment, CustomerAccount, CustomerPerson,
  JsonValue, LifecycleState, LostReason, NextAction, NextActionStatus, NextActionType, Opportunity,
  OpportunityLineItem, Priority, Product, ProductCategory, ReviewItem, SourceDocument, SourceType,
  TaxCategory, User, UserRole,
} from "../domain/types.js";
import type { LineTotals } from "../rules/money.js";
import type { Period, PeriodPreset } from "../rules/period.js";
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
  /** Close details (see Opportunity). Set once the deal is WON/LOST; cleared on reopen. */
  wonAmount?: number;
  closedAt?: string;
  lostReason?: LostReason;
  lostReasonNote?: string;
  competitor?: string;
  /** True when this deal has 明細 rows (D2); expectedAmount then follows their tax-exclusive total. */
  hasLineItems: boolean;
  currentSituation?: string;
  nextAction?: NextAction;
  lastMeaningfulActivityAt?: string;
  lastContextRecomputedAt?: string;
  updatedAt: string;
  version: number;
}

/**
 * This deal's customer at a glance, scoped to what the caller can see (a SALES user only sees
 * their own/collaborated deals for this account). Shown on the deal page next to 顧客情報 so a
 * rep doesn't have to open the customer page just to see how big this account is.
 */
export interface AccountSummary {
  openCount: number;
  expectedAmountTotal: number;
  currency: string;
  stalledCount: number;
  highRiskCount: number;
}

export interface OpportunityDetail extends OpportunitySummary {
  account: CustomerAccount;
  accountSummary: AccountSummary;
  persons: CustomerPerson[];
  lineItems: OpportunityLineItem[];
  totals: LineTotals;
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
  /** Close details (see Opportunity). Required by the service when the state changes to WON/LOST. */
  wonAmount?: number | null;
  closedAt?: string | null;
  lostReason?: LostReason | null;
  lostReasonNote?: string | null;
  competitor?: string | null;
  /** Optimistic concurrency: must equal the version the caller last saw. */
  version: number;
}

/** Company contact details; null or "" clears a field. */
export interface AccountPatch {
  address?: string | null;
  phone?: string | null;
  websiteUrl?: string | null;
  corporateNumber?: string | null;
  industry?: string | null;
}

/** One imported row that couldn't be applied (a validation error, not a fetch/network failure). */
export interface CompanyDbSyncError { row: number; message: string }

export interface CompanyDbSyncResult {
  accountsCreated: number;
  accountsUpdated: number;
  personsCreated: number;
  personsUpdated: number;
  rowsRead: number;
  errors: CompanyDbSyncError[];
}

/**
 * A one-time, admin-only migration payload: whole rows exported from another tenant (e.g. a local
 * dev instance), inserted verbatim with their original ids so foreign keys stay intact. Every
 * user-reference field (ownerUserId, assignedUserId, actorUserIds, submittedByUserId) is remapped to
 * the importing admin, since the source tenant's own user ids don't exist in this one.
 */
export interface BulkImportPayload {
  accounts: CustomerAccount[];
  persons: CustomerPerson[];
  sourceDocuments: SourceDocument[];
  opportunities: Opportunity[];
  activities: Activity[];
  nextActions: NextAction[];
  commitments: Commitment[];
}

/** One row that couldn't be inserted (e.g. an id already present in this tenant). */
export interface BulkImportError { entityType: string; id: string; message: string }

export interface BulkImportResult {
  accountsInserted: number;
  personsInserted: number;
  sourceDocumentsInserted: number;
  opportunitiesInserted: number;
  activitiesInserted: number;
  nextActionsInserted: number;
  commitmentsInserted: number;
  errors: BulkImportError[];
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

export interface ProductInput {
  code?: string;
  name: string;
  category?: ProductCategory;
  unitPrice?: number;
  cost?: number;
  taxCategory?: TaxCategory;
  unitLabel?: string;
  description?: string;
  active?: boolean;
  sortOrder?: number;
}
/** null or "" clears a text field; numbers: null clears. */
export interface ProductPatch {
  code?: string | null;
  name?: string;
  category?: ProductCategory;
  unitPrice?: number | null;
  cost?: number | null;
  taxCategory?: TaxCategory;
  unitLabel?: string | null;
  description?: string | null;
  active?: boolean;
  sortOrder?: number;
}

export interface LineItemInput {
  productId?: string;
  name: string;
  quantity: number;
  unitPrice: number;
  discountAmount?: number;
  taxCategory?: TaxCategory;
  sortOrder?: number;
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

/** The source text a review's `sourceEvidenceIds` point at, for display alongside the question. */
export interface ReviewSourceExcerpt {
  id: string;
  sourceType: SourceType;
  rawText?: string;
  occurredAt?: string;
}

export interface ReviewDto extends ReviewItem {
  relatedTitle?: string;
  opportunityId?: string;
  sources: ReviewSourceExcerpt[];
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
  /** Deals whose closedAt falls in the requested period (F1; a person's close date, not updatedAt). */
  wonThisMonth: number;
  wonAmountThisMonth: number;
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
  /** WON deals whose closedAt falls in the requested period (F1). */
  wonCount: number;
  wonAmount: number;
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
  /** The period wonThisMonth/lostThisMonth/perUser's won counts were computed over (F1). */
  period: Period;
  periodLabel: string;
}

export interface ManagerSummaryQuery { period?: PeriodPreset | Period }

export type ConfigDto = SalesConfig;

export function toUserDto(u: User): UserDto {
  return {
    id: u.id, email: u.email, displayName: u.displayName, role: u.role,
    managerUserId: u.managerUserId, timezone: u.timezone, active: u.active,
  };
}
