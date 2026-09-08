// Sales OS (営業オペレーション OS) — the agent-facing session.
//
// This binding is the team's sales context: opportunities (案件), what happened (activities), what
// each side promised (commitments), what the user should do next (next actions), and the questions
// the AI could not settle on its own (reviews). The sales rep never fills in CRM forms: they throw
// text at `capture()` (a meeting recap, a pasted email, a voice-memo transcript, a one-liner such as
// "ABC の件、承認取れた。来週契約。") and Sales OS extracts the structure, links the customer and
// opportunity, and generates next actions.
//
// Typical usage from `executeCode`:
//
//   const me = await env.SALES.whoAmI();               // null → tell the user to open "Sales OS" and register
//   const today = await env.SALES.getToday();          // what to do now, upcoming, reviews, attention
//   const r = await env.SALES.capture("今日ABCの山田さんと話して、100万はOK。金曜に社内承認が出る。");
//   // r.opportunity, r.activity, r.nextActions, r.commitments, r.reviews
//   const opps = await env.SALES.listOpportunities({ lifecycleStates: ["OPEN"] });
//   const detail = await env.SALES.getOpportunity(opps[0].id);   // detail.context.currentSituation
//
// Answer questions from the returned data, not from memory: state facts (activities, commitments)
// separately from AI inferences (context, risk) and never tell the user a deal is WON or LOST
// unless `lifecycleState` says so. All timestamps are ISO 8601 in UTC; present them in the user's
// timezone (`whoAmI().timezone`, usually Asia/Tokyo).

/** Who the current user is inside Sales OS. */
export interface SalesUser {
  id: string;
  email: string;
  displayName: string;
  /** SALES sees their own opportunities; MANAGER and ADMIN see the whole team. */
  role: "SALES" | "MANAGER" | "ADMIN";
  timezone: string;
}

export type LifecycleState = "OPEN" | "WON" | "LOST" | "ON_HOLD" | "CLOSED";

/** What the deal is waiting on right now (an AI inference, refreshed on every capture). */
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

export interface OpportunitySummary {
  id: string;
  title: string;
  accountId: string;
  accountName: string;
  /** UNRESOLVED means the customer has not been confirmed yet (a review is pending). */
  accountResolutionStatus: "RESOLVED" | "UNRESOLVED" | "MANUAL";
  ownerUserId: string;
  ownerName: string;
  collaboratorUserIds: string[];
  lifecycleState: LifecycleState;
  operationalState: OperationalState;
  phaseLabel?: string;
  expectedAmount?: number;
  currency?: string;
  /** `YYYY-MM-DD` */
  expectedCloseDate?: string;
  riskLevel: RiskLevel;
  riskReason?: string;
  /** One-paragraph AI summary of where the deal stands. */
  currentSituation?: string;
  /** The earliest open next action, if any. */
  nextAction?: NextAction;
  lastMeaningfulActivityAt?: string;
  updatedAt: string;
  /** Pass back in `updateOpportunity()` for optimistic concurrency. */
  version: number;
}

export interface Activity {
  id: string;
  opportunityId?: string;
  type: "MEETING" | "CALL" | "EMAIL" | "CHAT" | "NOTE" | "FILE" | "CALENDAR" | "SYSTEM";
  occurredAt: string;
  /** The source document this activity was extracted from. */
  sourceId: string;
  summary: string;
  /** `[{fact, evidence, confidence}]` */
  factsJson: unknown;
  questionsJson: unknown;
  objectionsJson: unknown;
  commitmentsJson: unknown;
  decisionsJson: unknown;
  aiConfidence?: number;
  createdAt: string;
}

export interface Commitment {
  id: string;
  opportunityId: string;
  /** Who owes it: the customer, or our company. */
  side: "CUSTOMER" | "OUR_COMPANY";
  description: string;
  dueAt?: string;
  status: "OPEN" | "FULFILLED" | "OVERDUE" | "CANCELLED" | "UNKNOWN";
  createdAt: string;
}

export interface NextAction {
  id: string;
  opportunityId: string;
  assignedUserId: string;
  actionType:
    | "CALL" | "MEETING" | "EMAIL" | "FOLLOW_UP" | "PROPOSAL" | "NEGOTIATION" | "CONTRACT"
    | "INTERNAL_COORDINATION" | "REVIEW" | "OTHER";
  title: string;
  purpose: string;
  dueAt?: string;
  priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  status: "OPEN" | "DONE" | "SNOOZED" | "CANCELLED";
  generatedBy: "AI" | "USER" | "SYSTEM";
  createdAt: string;
}

export interface ContextSnapshot {
  id: string;
  opportunityId: string;
  currentSituation: string;
  latestDevelopment: string;
  customerIntent?: string;
  /** string[] */
  decidedJson: unknown;
  /** string[] */
  unresolvedJson: unknown;
  /** `[{level, reason}]` */
  risksJson: unknown;
  /** `[{side, description, dueAt}]` */
  commitmentsJson: unknown;
  recommendedActionsJson: unknown;
  /** IDs of the sources / activities this view was built from. */
  evidenceIdsJson: string[];
  modelName: string;
  promptVersion: string;
  createdAt: string;
}

/** A question the AI could not settle; the user answers by picking one of `optionsJson`. */
export interface ReviewItem {
  id: string;
  type:
    | "CUSTOMER_AMBIGUOUS" | "OPPORTUNITY_AMBIGUOUS" | "DATE_AMBIGUOUS" | "AMOUNT_AMBIGUOUS"
    | "STATE_AMBIGUOUS" | "HIGH_RISK_ACTION" | "OTHER";
  question: string;
  optionsJson?: { id: string; label: string; value?: unknown }[];
  /** Title of the opportunity or customer the question is about. */
  relatedTitle?: string;
  opportunityId?: string;
  status: "OPEN" | "RESOLVED" | "DISMISSED";
  createdAt: string;
}

export interface SourceDocument {
  id: string;
  sourceType: "VOICE" | "AUDIO" | "TRANSCRIPT" | "EMAIL" | "CALENDAR_EVENT" | "CHAT" | "TEXT" | "FILE";
  rawText?: string;
  receivedAt: string;
  processingStatus: "RECEIVED" | "PROCESSING" | "PROCESSED" | "REVIEW_REQUIRED" | "FAILED" | "REVERTED";
  processingError?: string;
}

export interface CaptureOptions {
  /** Defaults to TEXT. Use EMAIL for pasted mail, TRANSCRIPT for meeting transcripts. */
  sourceType?: SourceDocument["sourceType"];
  /** ISO 8601 date-time of when the reported activity happened, if the user said so. */
  occurredAt?: string;
}

export interface CaptureResult {
  source: SourceDocument;
  /** True when the same text was already captured; nothing new was created. */
  duplicate: boolean;
  opportunity?: OpportunitySummary;
  activity?: Activity;
  nextActions: NextAction[];
  commitments: Commitment[];
  /** Questions the user must answer (e.g. which customer this is). */
  reviews: ReviewItem[];
  /** True when the AI judged the text unrelated to sales. */
  notSalesRelated?: boolean;
  /** Set when AI processing failed; the source is kept and can be retried. */
  error?: string;
}

export interface OpportunityDetail extends OpportunitySummary {
  account: { id: string; displayName: string; primaryDomain?: string; resolutionStatus: string };
  persons: { id: string; displayName: string; email?: string; title?: string }[];
  /** Latest AI context view, or undefined for a brand-new deal. */
  context?: ContextSnapshot;
  nextActions: NextAction[];
  commitments: Commitment[];
  /** Newest first. */
  activities: Activity[];
  reviews: ReviewItem[];
}

export interface OpportunityFilter {
  lifecycleStates?: LifecycleState[];
  ownerUserId?: string;
  accountId?: string;
  expectedAmountGte?: number;
  /** Only deals with no meaningful activity for at least this many days. */
  stalledDays?: number;
  limit?: number;
}

export interface NextActionFilter {
  opportunityId?: string;
  /** MANAGER/ADMIN only; SALES always see their own. */
  assignedUserId?: string;
  statuses?: NextAction["status"][];
  /** ISO instant; only actions due at or before it. */
  dueBefore?: string;
  limit?: number;
}

export interface TodayAction {
  action: NextAction;
  opportunity: OpportunitySummary;
  overdue: boolean;
}

export interface TodayView {
  user: SalesUser;
  /** Local calendar date (`YYYY-MM-DD`) in the user's timezone. */
  date: string;
  /** Overdue or due today — do these first. */
  now: TodayAction[];
  /** Due within the next 7 days. */
  upcoming: TodayAction[];
  /** Open actions without a due date. */
  undated: TodayAction[];
  reviews: ReviewItem[];
  attention: {
    opportunity: OpportunitySummary;
    kind: "STALLED" | "HIGH_RISK" | "COMMITMENT_OVERDUE" | "UNRESOLVED_CUSTOMER";
    message: string;
  }[];
  counts: { openOpportunities: number; openActions: number; overdue: number; openReviews: number };
}

export interface ManagerSummary {
  byLifecycle: { lifecycleState: LifecycleState; count: number }[];
  /** Open deals with no meaningful activity for the configured number of days. */
  stalled: OpportunitySummary[];
  highRisk: OpportunitySummary[];
  /** Open deals whose operational state is CONTRACTING. */
  contracting: OpportunitySummary[];
  openReviews: number;
}

export interface SalesSession {
  /**
   * The current user, or null when this Cloudflare OS account has not been registered in Sales OS
   * yet. In that case, tell the user to open the "Sales OS" page from the sidebar and register;
   * every other method throws until they do.
   */
  whoAmI(): Promise<SalesUser | null>;

  /**
   * Throw sales information in as free text: a meeting recap, a pasted email, a transcript, a short
   * note. Sales OS extracts the activity, links or creates the customer and opportunity, records
   * commitments and next actions, and refreshes the deal's context. Nothing is required from the
   * user beyond the text. Returns what was created; check `reviews` for questions to relay to the
   * user (e.g. which of two customers this is) and `error` for a failed AI run (retry later).
   *
   * One call is one deal: if the text plainly covers several separate customers or meetings (e.g.
   * several pasted daily reports), call `capture()` once per record instead of pasting them all
   * together — a single call only ever produces one activity and one opportunity.
   */
  capture(text: string, options?: CaptureOptions): Promise<CaptureResult>;

  /** The result of an earlier capture, by its `source.id`. */
  getCapture(sourceId: string): Promise<CaptureResult>;

  /** Undo everything one capture produced (activity, commitments, next actions, deal changes). */
  revertCapture(sourceId: string): Promise<void>;

  /** The user's day: what to do now, what is coming, open questions, deals needing attention. */
  getToday(): Promise<TodayView>;

  /** Deals visible to the user (own deals for SALES; everything for MANAGER/ADMIN). */
  listOpportunities(filter?: OpportunityFilter): Promise<OpportunitySummary[]>;

  /** Full picture of one deal: AI context, next actions, commitments, activity timeline, reviews. */
  getOpportunity(opportunityId: string): Promise<OpportunityDetail>;

  /**
   * Edit deal fields a human owns (title, phase label, expected amount / close date, lifecycle
   * state, owner). Pass the `version` from the last read; the call fails if someone else edited
   * the deal in between. Confirm with the user before setting WON or LOST.
   */
  updateOpportunity(opportunityId: string, patch: {
    title?: string;
    phaseLabel?: string | null;
    expectedAmount?: number | null;
    currency?: string;
    expectedCloseDate?: string | null;
    lifecycleState?: LifecycleState;
    ownerUserId?: string;
    collaboratorUserIds?: string[];
    version: number;
  }): Promise<OpportunitySummary>;

  /** Rebuild the deal's AI context from all its activities (after a prompt change, or on request). */
  recomputeContext(opportunityId: string): Promise<ContextSnapshot>;

  /** Open next actions, soonest first. */
  listNextActions(filter?: NextActionFilter): Promise<NextAction[]>;

  /** Add a next action the user asked for explicitly. */
  createNextAction(input: {
    opportunityId: string;
    title: string;
    purpose?: string;
    actionType?: NextAction["actionType"];
    /** ISO 8601 */
    dueAt?: string;
    priority?: NextAction["priority"];
  }): Promise<NextAction>;

  /** Mark done / snooze / cancel, or change title, purpose, due date or priority. */
  updateNextAction(nextActionId: string, patch: {
    status?: NextAction["status"];
    dueAt?: string | null;
    title?: string;
    purpose?: string;
    priority?: NextAction["priority"];
  }): Promise<NextAction>;

  /** Mark a commitment fulfilled / cancelled, or set its due date. */
  updateCommitment(commitmentId: string, patch: {
    status?: Commitment["status"];
    dueAt?: string | null;
  }): Promise<Commitment>;

  /** Questions waiting for the user (assigned to them; all of them for MANAGER/ADMIN). */
  listReviews(): Promise<ReviewItem[]>;

  /**
   * Answer a review by choosing one of its `optionsJson[].id`. Some options need extra input, e.g.
   * a DATE_AMBIGUOUS option whose `value.needsInput === "dueAt"` takes `input: { dueAt }`.
   * Always ask the user before resolving a WON/LOST (STATE_AMBIGUOUS) or customer question.
   */
  resolveReview(reviewId: string, resolution: { optionId: string; input?: Record<string, unknown> }): Promise<ReviewItem>;

  /** Close a review without acting on it. */
  dismissReview(reviewId: string): Promise<ReviewItem>;

  /** Team overview for MANAGER/ADMIN: stalled, high-risk, contracting deals and open reviews. */
  getManagerSummary(): Promise<ManagerSummary>;

  /** Team members (id, name, role) — useful for reassigning or filtering by owner. */
  listUsers(): Promise<SalesUser[]>;
}
