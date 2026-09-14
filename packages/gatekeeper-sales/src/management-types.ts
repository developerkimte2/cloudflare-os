/**
 * RPC contract between the sandboxed management app (`app/`) and the account-scoped
 * `SalesManagementApi` the Worker hands to the Workshop host frame. Environment-neutral DTOs only:
 * the browser bundle imports this file, so nothing here may reference Worker types.
 *
 * Every method acts as the calling user; the Worker resolves who that is from the account. When the
 * account is not yet bound to a Sales OS user, only `whoAmI()` and `register()` succeed.
 */
import type {
  AccountPatch, AIContextSnapshot, AnswerResult, AuditLog, CaptureOptions, CaptureResult, Commitment,
  ConfigDto, CustomerAccount, CustomerPerson, JsonValue, ManagerSummary, NextAction, NextActionFilter,
  NextActionInput, NextActionPatch, OpportunityDetail, OpportunityFilter, OpportunityPatch,
  OpportunitySummary, PersonInput, PersonPatch, RegisterIdentityInput, ReviewDto, ReviewResolution,
  SalesConfig, SourceDocument, TodayAction, TodayView, UserDto,
} from "@gadgets/sales-core";

export type {
  AccountPatch, AIContextSnapshot, AnswerResult, AuditLog, CaptureOptions, CaptureResult, Commitment,
  ConfigDto, CustomerAccount, CustomerPerson, JsonValue, ManagerSummary, NextAction, NextActionFilter,
  NextActionInput, NextActionPatch, OpportunityDetail, OpportunityFilter, OpportunityPatch,
  OpportunitySummary, PersonInput, PersonPatch, RegisterIdentityInput, ReviewDto, ReviewResolution,
  SalesConfig, SourceDocument, TodayAction, TodayView, UserDto,
};

/** What the app learns about the caller on load. */
export interface WhoAmI {
  /** Undefined until the account has been bound to a Sales OS user via `register()`. */
  user?: UserDto;
  /** True when the Workshop reports the viewer as a deployment admin. */
  isAdmin: boolean;
  /** True when no user exists yet in this tenant (the first registrant becomes ADMIN). */
  firstUser: boolean;
  /** Configured AI provider/model, for display and troubleshooting. */
  ai: { provider: string; model: string; configured: boolean };
  /** Whether Slack (`chat.postMessage`) is configured, and which channel — never the token. */
  slack: { configured: boolean; channel?: string };
  /** Whether voice-capture transcription (Workers AI Whisper) is configured. */
  transcription: { configured: boolean };
}

export interface SalesManagementApi {
  whoAmI(): Promise<WhoAmI>;
  register(input: RegisterIdentityInput): Promise<UserDto>;

  getToday(): Promise<TodayView>;

  capture(text: string, options?: CaptureOptions): Promise<CaptureResult>;
  /** Answers a question about existing opportunities instead of capturing the text (does not store anything). */
  askQuestion(question: string): Promise<AnswerResult>;
  /**
   * Transcribes a recorded/uploaded audio clip (plans/sales-os-voice.md). Read-only: nothing is
   * stored. The caller (CaptureBox) puts the returned text in the textarea for the user to review
   * before calling `capture()`.
   */
  transcribeAudio(audio: ArrayBuffer, mimeType: string): Promise<{ text: string; modelName: string }>;
  getCapture(sourceId: string): Promise<CaptureResult>;
  listCaptures(limit?: number): Promise<SourceDocument[]>;
  retryCapture(sourceId: string): Promise<CaptureResult>;
  revertCapture(sourceId: string): Promise<void>;

  listOpportunities(filter?: OpportunityFilter): Promise<OpportunitySummary[]>;
  getOpportunity(id: string): Promise<OpportunityDetail>;
  updateOpportunity(id: string, patch: OpportunityPatch): Promise<OpportunitySummary>;
  recomputeContext(id: string): Promise<AIContextSnapshot>;

  /** Company address / phone / URL. Shared by every opportunity of that customer. */
  updateAccount(accountId: string, patch: AccountPatch): Promise<CustomerAccount>;
  /** Adds a customer-side contact (担当者) with their title, email and phone. */
  createPerson(accountId: string, input: PersonInput): Promise<CustomerPerson>;
  updatePerson(personId: string, patch: PersonPatch): Promise<CustomerPerson>;

  listNextActions(filter?: NextActionFilter): Promise<NextAction[]>;
  createNextAction(input: NextActionInput): Promise<NextAction>;
  updateNextAction(id: string, patch: NextActionPatch): Promise<NextAction>;
  updateCommitment(id: string, patch: { status?: Commitment["status"]; dueAt?: string | null }): Promise<Commitment>;

  listReviews(): Promise<ReviewDto[]>;
  resolveReview(id: string, resolution: ReviewResolution): Promise<ReviewDto>;
  dismissReview(id: string): Promise<ReviewDto>;

  getManagerSummary(): Promise<ManagerSummary>;
  listUsers(): Promise<UserDto[]>;
  updateUser(userId: string, patch: Partial<Pick<UserDto, "displayName" | "role" | "managerUserId" | "timezone" | "active">>): Promise<UserDto>;
  getConfig(): Promise<ConfigDto>;
  updateConfig(patch: Partial<SalesConfig>): Promise<ConfigDto>;
  listAudit(entityType?: string, entityId?: string, limit?: number): Promise<AuditLog[]>;

  /** ADMIN only. Sends a fixed test message to the configured Slack channel; throws if unconfigured. */
  sendSlackTest(): Promise<void>;
  /**
   * ADMIN only, manual trigger (plans/sales-os-notify.md N3). Sends today's Morning Brief (all
   * active users, one combined Slack message) right now; a no-op (`sent: false`) if one was already
   * sent today (設計書 §20.2 dedup).
   */
  sendMorningBrief(): Promise<{ sent: boolean; recipientCount: number }>;
}
