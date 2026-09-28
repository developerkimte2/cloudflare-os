/**
 * Application service: the single entry point adapters (Cloudflare OS gatekeeper, future HTTP API,
 * tests) call. Enforces authorization (SEC-02), wraps the pipeline, and shapes DTOs. Everything
 * here is synchronous except the steps that call the LLM.
 */
import type {
  AccountPatch, AccountSummary, Actor, AnswerResult, AttentionItem, CaptureOptions,
  CaptureResult, CompanyDbSyncResult, ConfigDto,
  CustomerDetail, LineItemInput, ManagerPerUserRow, ManagerSummary, ManagerSummaryQuery,
  NextActionFilter, NextActionInput,
  NextActionPatch, NextActionSuggestion, OpportunityDetail, OpportunityFilter, OpportunityPatch,
  OpportunitySummary, PersonInput, PersonPatch, ProductInput, ProductPatch, RegisterIdentityInput,
  ReviewDto, ReviewResolution, TodayAction, TodayView, UserDto,
} from "../api/dto.js";
import { toUserDto } from "../api/dto.js";
import type {
  AIDecision, Commitment, CustomerAccount, CustomerPerson, JsonValue, LifecycleState, LostReason,
  NextAction, NextActionType, Opportunity, OpportunityLineItem, Priority, Product, ReviewItem,
  SourceDocument, User, UserRole,
} from "../domain/types.js";
import { CSV_MAX_ROWS, parseCsvRecords } from "../rules/csv.js";
import { lineTotals } from "../rules/money.js";
import { periodLabel, resolvePeriod } from "../rules/period.js";
import {
  addDays, isIsoDateTime, localDate, newId, normalizeEmail, normalizeName, nowIso,
} from "../domain/util.js";
import { loadConfig, saveConfig, type SalesConfig } from "../rules/config.js";
import { ANSWER_PROMPT_VERSION, buildAnswerRequest, type AnswerOpportunity } from "../ai/skills.js";
import { LlmError } from "../ai/provider.js";
import { audit } from "../pipeline/audit.js";
import { logEvent, type CoreContext } from "../pipeline/context.js";
import { captureText, diffable, processSource, UNRESOLVED_ACCOUNT_NAME } from "../pipeline/ingest.js";
import { matchOpportunities } from "../pipeline/ask.js";
import { recomputeContext } from "../pipeline/recompute.js";
import { revertSource } from "../pipeline/undo.js";

export class AuthorizationError extends Error {
  constructor(message = "この操作を行う権限がありません") {
    super(message);
    this.name = "AuthorizationError";
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} が見つかりません`);
    this.name = "NotFoundError";
  }
}

export class SalesService {
  constructor(readonly ctx: CoreContext) {}

  get repo() {
    return this.ctx.repo;
  }

  get config(): SalesConfig {
    return this.ctx.config;
  }

  // ---- identity ---------------------------------------------------------------------------------

  /** Returns the user bound to an outer identity, or undefined when not yet registered. */
  resolveIdentity(provider: string, externalId: string): User | undefined {
    const identity = this.repo.getIdentity(provider, externalId);
    return identity ? this.repo.getUser(identity.userId) : undefined;
  }

  /**
   * Binds an outer identity to a user, creating the user when the email is new. The very first
   * user of a tenant becomes ADMIN; an `isAdmin` caller may choose any role; everyone else is SALES.
   */
  registerIdentity(
    provider: string, externalId: string, input: RegisterIdentityInput, opts: { isAdmin?: boolean } = {},
  ): User {
    return this.repo.transaction(() => {
      const existingIdentity = this.repo.getIdentity(provider, externalId);
      if (existingIdentity) {
        const bound = this.repo.getUser(existingIdentity.userId);
        if (bound) return bound;
        this.repo.deleteIdentity(provider, externalId);
      }
      const email = normalizeEmail(input.email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new TypeError("メールアドレスの形式が不正です");
      const displayName = input.displayName.trim();
      if (!displayName) throw new TypeError("表示名は必須です");
      const now = nowIso(this.ctx.clock);
      const firstUser = this.repo.listUsers().length === 0;
      let user = this.repo.getUserByEmail(email);
      if (!user) {
        const role: UserRole = firstUser ? "ADMIN" : (opts.isAdmin && input.role) ? input.role : "SALES";
        user = {
          id: newId(), email, displayName, role,
          timezone: input.timezone ?? this.config.defaultTimezone, active: true,
          createdAt: now, updatedAt: now,
        };
        this.repo.insertUser(user);
        audit(this.ctx, { actorType: opts.isAdmin ? "ADMIN" : "USER", actorId: user.id,
          action: "USER_CREATED", entityType: "user", entityId: user.id, after: toUserDto(user) });
      } else if (opts.isAdmin && user.role !== "ADMIN") {
        // A Workshop admin claiming an existing SALES row is promoted (only ever upwards).
        const before = toUserDto(user);
        user = { ...user, role: "ADMIN", updatedAt: now };
        this.repo.updateUser(user);
        audit(this.ctx, { actorType: "ADMIN", actorId: user.id, action: "USER_ROLE_CHANGED",
          entityType: "user", entityId: user.id, before, after: toUserDto(user) });
      }
      this.repo.insertIdentity({ provider, externalId, userId: user.id, createdAt: now });
      return user;
    });
  }

  requireUser(actor: Actor): User {
    const user = this.repo.getUser(actor.userId);
    if (!user || !user.active) throw new AuthorizationError("ユーザーが登録されていません");
    return user;
  }

  listUsers(actor: Actor): UserDto[] {
    this.requireUser(actor);
    return this.repo.listUsers().map(toUserDto);
  }

  updateUser(actor: Actor, userId: string, patch: Partial<Pick<User, "displayName" | "role" | "managerUserId" | "timezone" | "active">>): UserDto {
    const me = this.requireUser(actor);
    if (me.role !== "ADMIN" && me.id !== userId) throw new AuthorizationError();
    if (me.role !== "ADMIN" && (patch.role !== undefined || patch.active !== undefined)) throw new AuthorizationError();
    const user = this.repo.getUser(userId);
    if (!user) throw new NotFoundError("ユーザー");
    const before = toUserDto(user);
    const next: User = { ...user, ...stripUndefined(patch), updatedAt: nowIso(this.ctx.clock) };
    this.repo.updateUser(next);
    audit(this.ctx, { actorType: me.role === "ADMIN" ? "ADMIN" : "USER", actorId: me.id,
      action: "USER_UPDATED", entityType: "user", entityId: userId, before, after: toUserDto(next) });
    return toUserDto(next);
  }

  // ---- capture ----------------------------------------------------------------------------------

  /** Stores the raw text and runs the pipeline. Never throws on AI failure (see `error`). */
  async capture(actor: Actor, text: string, options: CaptureOptions = {}): Promise<CaptureResult> {
    const user = this.requireUser(actor);
    const opportunityId = this.requireCaptureTarget(user, options.opportunityId);
    const receipt = await captureText(this.ctx, {
      userId: user.id, text, sourceType: options.sourceType, occurredAt: options.occurredAt, opportunityId,
    });
    if (!receipt.duplicate) await processSource(this.ctx, receipt.sourceId);
    return { ...this.getCapture(actor, receipt.sourceId), duplicate: receipt.duplicate };
  }

  /** Stores the raw text only (RECEIVED). Processing happens later via `retryCapture`. */
  async receive(actor: Actor, text: string, options: CaptureOptions = {}): Promise<{ sourceId: string; duplicate: boolean }> {
    const user = this.requireUser(actor);
    const opportunityId = this.requireCaptureTarget(user, options.opportunityId);
    const receipt = await captureText(this.ctx, {
      userId: user.id, text, sourceType: options.sourceType, occurredAt: options.occurredAt, opportunityId,
    });
    return { sourceId: receipt.sourceId, duplicate: receipt.duplicate };
  }

  /** Validates CaptureOptions.opportunityId (pinned capture), if given; undefined otherwise. */
  private requireCaptureTarget(user: User, opportunityId: string | undefined): string | undefined {
    if (opportunityId === undefined) return undefined;
    const o = this.repo.getOpportunity(opportunityId);
    if (!o || !this.canSee(user, o)) throw new NotFoundError("案件");
    return opportunityId;
  }

  /**
   * Answers a free-text question about existing opportunities ("ABC社の状況どうなっている？") instead
   * of capturing the text. Never throws on AI failure (mirrors `capture`'s `error` field) — the
   * caller (the capture box) always gets something to show.
   */
  async askQuestion(actor: Actor, question: string): Promise<AnswerResult> {
    const user = this.requireUser(actor);
    const q = question.trim();
    if (!q) throw new TypeError("質問を入力してください");
    const visible = this.repo.listOpportunitiesVisibleTo(user, { limit: 500 });
    if (visible.length === 0) {
      return {
        answer: "まだ案件データがありません。取り込みを行うと、ここで状況を聞けるようになります。",
        references: [], matchedByName: false, contactsMissing: [],
      };
    }
    // Match on lightweight {id, accountName, title} refs first (one deduped account lookup per
    // distinct account, not summarize()'s ~4 queries per opportunity for all 500) and only
    // summarize() the handful actually chosen as context, below.
    const accountCache = new Map<string, CustomerAccount | undefined>();
    const accountOf = (accountId: string): CustomerAccount | undefined => {
      if (!accountCache.has(accountId)) accountCache.set(accountId, this.repo.getAccount(accountId));
      return accountCache.get(accountId);
    };
    const refs = visible.map(o => ({
      id: o.id, accountName: accountOf(o.accountId)?.displayName ?? UNRESOLVED_ACCOUNT_NAME, title: o.title,
    }));
    const matchedRefs = matchOpportunities(refs, q);
    // Nothing named in the question matched: fall back to recent activity so the AI can still say
    // something useful (or honestly say it couldn't find the case) instead of answering from nothing.
    // matchedByName tells both the prompt and the UI which case this is, so neither one presents an
    // unrelated recent opportunity as if it were the one asked about.
    const matchedByName = matchedRefs.length > 0;
    const byId = new Map(visible.map(o => [o.id, o]));
    const chosen = matchedByName
      ? matchedRefs.map(r => byId.get(r.id)!)
      : [...visible].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);
    const context = chosen.map(o => this.answerContext(this.summarize(o), accountOf(o.accountId)));
    const references = context.map(o => ({ id: o.id, accountName: o.accountName, title: o.title }));
    // Only for cases the rep actually asked about: a fallback list is context, not a to-do.
    const contactsMissing = matchedByName
      ? context.filter(o => o.contacts.length === 0).map(o => ({ id: o.id, accountName: o.accountName, title: o.title }))
      : [];
    const request = buildAnswerRequest({
      referenceTime: nowIso(this.ctx.clock), timezone: user.timezone || this.config.defaultTimezone,
      question: q, opportunities: context, matchedByName,
    });
    // Never the question or answer text itself (CoreContext.log's contract: no prompts/raw text).
    logEvent(this.ctx, "question.asked", {
      kind: matchedByName ? "matched" : "fallback", candidates: context.length,
      promptVersion: ANSWER_PROMPT_VERSION,
    });
    try {
      const res = await this.ctx.llm.complete(request);
      logEvent(this.ctx, "question.answered", {
        status: "ok", model: res.model, promptVersion: ANSWER_PROMPT_VERSION,
        outputTokens: res.usage?.outputTokens,
      });
      return {
        answer: res.text.trim(), references, matchedByName, contactsMissing,
        modelProvider: res.provider, modelName: res.model,
      };
    } catch (err) {
      const message = err instanceof LlmError ? err.message : "AI の呼び出しに失敗しました";
      logEvent(this.ctx, "question.answered", { status: "failed", error: message });
      return { answer: "", references, matchedByName, contactsMissing, error: message };
    }
  }

  /**
   * `summarize()` plus how to actually reach the 窓口 (title / email / phone) and the company
   * (phone / website) — the summary only carries names. `contactPersonIds` is already filtered to
   * persons of this same account by `summarize()`.
   */
  private answerContext(summary: OpportunitySummary, account: CustomerAccount | undefined): AnswerOpportunity {
    const contacts = summary.contactPersonIds
      .map(id => this.repo.getPerson(id))
      .filter((p): p is CustomerPerson => !!p)
      .map(p => ({ name: p.displayName, title: p.title, email: p.email, phone: p.phone }));
    return { ...summary, contacts, accountPhone: account?.phone, accountWebsiteUrl: account?.websiteUrl };
  }

  /** Drops a source that was received but never processed (e.g. an approval was rejected). */
  discardReceived(actor: Actor, sourceId: string): void {
    const user = this.requireUser(actor);
    const source = this.visibleSource(actor, sourceId);
    if (source.processingStatus !== "RECEIVED") {
      throw new Error(`処理済みの取込は破棄できません (${source.processingStatus})`);
    }
    this.repo.transaction(() => {
      this.repo.updateSource({ ...source, processingStatus: "REVERTED", processingError: "承認されなかったため破棄" });
      audit(this.ctx, { actorType: "USER", actorId: user.id, action: "SOURCE_DISCARDED",
        entityType: "source_document", entityId: sourceId, sourceIds: [sourceId] });
    });
  }

  /** Re-runs a FAILED (or still RECEIVED) source. */
  async retryCapture(actor: Actor, sourceId: string): Promise<CaptureResult> {
    const source = this.visibleSource(actor, sourceId);
    if (source.processingStatus !== "FAILED" && source.processingStatus !== "RECEIVED") {
      throw new Error(`この取込は再実行できません (${source.processingStatus})`);
    }
    await processSource(this.ctx, sourceId);
    return this.getCapture(actor, sourceId);
  }

  getCapture(actor: Actor, sourceId: string): CaptureResult {
    const source = this.visibleSource(actor, sourceId);
    const app = this.repo.getApplication(sourceId);
    const activity = app?.activityId ? this.repo.getActivity(app.activityId) : undefined;
    const opportunity = app?.opportunityId ? this.repo.getOpportunity(app.opportunityId) : undefined;
    const decisions = this.repo.listDecisionsForSource(sourceId);
    return {
      source, duplicate: false,
      opportunity: opportunity ? this.summarize(opportunity) : undefined,
      activity,
      nextActions: (app?.createdNextActionIds ?? []).map(id => this.repo.getNextAction(id)).filter(isDefined),
      commitments: (app?.createdCommitmentIds ?? []).map(id => this.repo.getCommitment(id)).filter(isDefined),
      reviews: this.repo.listReviewsForSource(sourceId).map(r => this.reviewDto(r)),
      decisions,
      suggestions: nextActionSuggestions(decisions),
      notSalesRelated: decisions.some(d => (d.proposedJson as { not_sales_related?: boolean })?.not_sales_related === true),
      error: source.processingError,
    };
  }

  listCaptures(actor: Actor, limit = 30): SourceDocument[] {
    const user = this.requireUser(actor);
    return this.repo.listRecentSources(user.role === "SALES" ? user.id : undefined, limit);
  }

  revertCapture(actor: Actor, sourceId: string): void {
    const user = this.requireUser(actor);
    const source = this.visibleSource(actor, sourceId);
    if (user.role === "SALES" && source.submittedByUserId !== user.id) throw new AuthorizationError();
    revertSource(this.ctx, sourceId, user.id);
  }

  // ---- views ------------------------------------------------------------------------------------

  getToday(actor: Actor): TodayView {
    const user = this.requireUser(actor);
    const now = nowIso(this.ctx.clock);
    const today = localDate(now, user.timezone);
    const endOfToday = endOfLocalDay(now, user.timezone);
    const weekAhead = addDays(endOfToday, 7);

    // A snooze with a wake-up time hides the action until then; once it passes, the action comes
    // back (still SNOOZED, so the row shows it was put off) and counts toward overdue again.
    const isSleeping = (a: NextAction) => a.status === "SNOOZED" && !!a.snoozedUntil && a.snoozedUntil > now;
    const listed = this.repo.listOpenNextActionsForUser(user.id);
    const actions = listed.filter(a => !isSleeping(a));
    const snoozedCount = listed.length - actions.length;
    const nowList: TodayAction[] = [];
    const upcoming: TodayAction[] = [];
    const undated: TodayAction[] = [];
    const summaries = new Map<string, OpportunitySummary>();
    const summaryOf = (id: string): OpportunitySummary | undefined => {
      if (!summaries.has(id)) {
        const o = this.repo.getOpportunity(id);
        if (o) summaries.set(id, this.summarize(o));
      }
      return summaries.get(id);
    };
    let overdueCount = 0;
    for (const action of actions) {
      const opportunity = summaryOf(action.opportunityId);
      if (!opportunity) continue;
      if (!action.dueAt) {
        undated.push({ action, opportunity, overdue: false });
        continue;
      }
      const overdue = action.dueAt < now;
      if (overdue) overdueCount++;
      if (overdue || action.dueAt <= endOfToday) nowList.push({ action, opportunity, overdue });
      else if (action.dueAt <= weekAhead) upcoming.push({ action, opportunity, overdue: false });
    }

    const reviews = this.listReviews(actor);
    const visible = this.repo.listOpportunitiesVisibleTo(user, { lifecycleStates: ["OPEN"], limit: 500 });
    const attention: AttentionItem[] = [];
    const stalledBefore = addDays(now, -this.config.stalledDays);
    for (const o of visible) {
      const s = summaryOf(o.id);
      if (!s) continue;
      if (s.accountResolutionStatus === "UNRESOLVED") {
        attention.push({ opportunity: s, kind: "UNRESOLVED_CUSTOMER", message: "顧客が未確定です" });
      }
      if (o.riskLevel === "HIGH") {
        attention.push({ opportunity: s, kind: "HIGH_RISK", message: o.riskReason ?? "高リスク" });
      }
      const last = o.lastMeaningfulActivityAt ?? o.createdAt;
      if (last < stalledBefore) {
        const days = Math.floor((Date.parse(now) - Date.parse(last)) / 86_400_000);
        attention.push({ opportunity: s, kind: "STALLED", message: `${days} 日間動きがありません` });
      }
    }
    for (const c of this.repo.listOverdueCommitments(now)) {
      const s = summaryOf(c.opportunityId);
      if (!s || !this.canSee(user, this.repo.getOpportunity(c.opportunityId)!)) continue;
      attention.push({
        opportunity: s, kind: "COMMITMENT_OVERDUE",
        message: `${c.side === "CUSTOMER" ? "顧客" : "自社"}の約束「${c.description}」が期限超過`,
      });
    }

    return {
      user: toUserDto(user), date: today, generatedAt: now,
      now: nowList, upcoming, undated, reviews, attention,
      recentCaptures: this.repo.listRecentSources(user.id, 5),
      counts: {
        openOpportunities: visible.length, openActions: actions.length,
        overdue: overdueCount, snoozed: snoozedCount, openReviews: reviews.length,
      },
    };
  }

  listOpportunities(actor: Actor, filter: OpportunityFilter = {}): OpportunitySummary[] {
    const user = this.requireUser(actor);
    const now = nowIso(this.ctx.clock);
    return this.repo.listOpportunitiesVisibleTo(user, {
      lifecycleStates: filter.lifecycleStates,
      ownerUserId: filter.ownerUserId,
      accountId: filter.accountId,
      expectedAmountGte: filter.expectedAmountGte,
      notUpdatedSince: filter.stalledDays !== undefined ? addDays(now, -filter.stalledDays) : undefined,
      text: filter.query,
      limit: filter.limit,
    }).map(o => this.summarize(o));
  }

  getOpportunity(actor: Actor, id: string): OpportunityDetail {
    const user = this.requireUser(actor);
    const o = this.repo.getOpportunity(id);
    if (!o || !this.canSee(user, o)) throw new NotFoundError("案件");
    const account = this.repo.getAccount(o.accountId)!;
    const decisions = this.repo.listDecisionsForEntity("opportunity", id);
    const lineItems = this.repo.listLineItems(id);
    return {
      ...this.summarize(o),
      account,
      accountSummary: this.accountSummaryFor(user, account.id),
      persons: this.repo.listPersonsForAccount(account.id),
      lineItems,
      totals: lineTotals(lineItems, this.config),
      context: this.repo.latestSnapshot(id),
      nextActions: this.repo.listNextActionsForOpportunity(id),
      suggestions: nextActionSuggestions(decisions),
      commitments: this.repo.listCommitmentsForOpportunity(id),
      activities: this.repo.listActivitiesForOpportunity(id),
      sources: this.repo.listSourcesForOpportunity(id),
      decisions,
      reviews: this.repo.listReviews("OPEN").filter(r => this.reviewOpportunityId(r) === id).map(r => this.reviewDto(r)),
      audit: this.repo.listAuditForEntity("opportunity", id),
    };
  }

  updateOpportunity(actor: Actor, id: string, patch: OpportunityPatch): OpportunitySummary {
    const user = this.requireUser(actor);
    const o = this.repo.getOpportunity(id);
    if (!o || !this.canSee(user, o)) throw new NotFoundError("案件");
    if (patch.ownerUserId !== undefined && user.role === "SALES" && o.ownerUserId !== user.id) {
      throw new AuthorizationError("担当者の変更は担当者本人か管理者のみ行えます");
    }
    const before = { ...o };
    const next: Opportunity = { ...o };
    if (patch.title !== undefined) next.title = patch.title.trim() || o.title;
    if (patch.phaseLabel !== undefined) next.phaseLabel = patch.phaseLabel ?? undefined;
    if (patch.expectedAmount !== undefined) {
      if (this.repo.countLineItems(id) > 0) throw new TypeError("明細がある案件の見込金額は明細の合計から計算されます");
      next.expectedAmount = patch.expectedAmount ?? undefined;
    }
    if (patch.currency !== undefined) next.currency = patch.currency;
    if (patch.expectedCloseDate !== undefined) next.expectedCloseDate = patch.expectedCloseDate ?? undefined;
    if (patch.proposalDocumentUrl !== undefined) next.proposalDocumentUrl = patch.proposalDocumentUrl?.trim() || undefined;
    if (patch.contactPersonIds !== undefined) {
      const ids = [...new Set(patch.contactPersonIds)];
      for (const personId of ids) {
        const person = this.repo.getPerson(personId);
        if (!person || person.accountId !== o.accountId) {
          throw new TypeError("窓口に指定できるのはこの顧客の担当者だけです");
        }
      }
      next.contactPersonIds = ids;
    }
    if (patch.lifecycleState !== undefined) next.lifecycleState = patch.lifecycleState;
    if (patch.ownerUserId !== undefined) {
      if (!this.repo.getUser(patch.ownerUserId)) throw new NotFoundError("担当者");
      next.ownerUserId = patch.ownerUserId;
    }
    if (patch.collaboratorUserIds !== undefined) next.collaboratorUserIds = patch.collaboratorUserIds;
    if (patch.wonAmount !== undefined) next.wonAmount = patch.wonAmount ?? undefined;
    if (patch.closedAt !== undefined) next.closedAt = patch.closedAt ?? undefined;
    if (patch.lostReason !== undefined) next.lostReason = patch.lostReason ?? undefined;
    if (patch.lostReasonNote !== undefined) next.lostReasonNote = cleanText(patch.lostReasonNote);
    if (patch.competitor !== undefined) next.competitor = cleanText(patch.competitor);
    const closeChange = this.applyCloseRules(o, next, user.timezone || this.config.defaultTimezone);
    next.updatedAt = nowIso(this.ctx.clock);
    return this.repo.transaction(() => {
      if (!this.repo.updateOpportunity(next, patch.version)) {
        throw new Error("案件が他のユーザーによって更新されています。再読込してください");
      }
      audit(this.ctx, { actorType: "USER", actorId: user.id,
        action: closeChange === "CLOSED" ? "OPPORTUNITY_CLOSED"
          : closeChange === "REOPENED" ? "OPPORTUNITY_REOPENED" : "OPPORTUNITY_EDITED",
        entityType: "opportunity", entityId: id, before: diffable(before), after: diffable(next) });
      return this.summarize(this.repo.getOpportunity(id)!);
    });
  }

  /**
   * What a person must supply when a deal closes, and what gets cleared when it reopens.
   * Returns which of the two happened so the caller can pick the audit action.
   */
  private applyCloseRules(before: Opportunity, next: Opportunity, timezone: string): "CLOSED" | "REOPENED" | undefined {
    const isClosed = (s: LifecycleState) => s === "WON" || s === "LOST";
    if (next.lifecycleState === before.lifecycleState) return undefined;
    if (isClosed(next.lifecycleState)) {
      if (!next.closedAt) next.closedAt = localDate(nowIso(this.ctx.clock), timezone);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(next.closedAt)) throw new TypeError("日付は YYYY-MM-DD で入力してください");
      if (next.lifecycleState === "WON") {
        if (next.wonAmount === undefined) next.wonAmount = next.expectedAmount;
        if (next.wonAmount === undefined) throw new TypeError("受注額を入力してください");
        next.lostReason = undefined; next.lostReasonNote = undefined;
      } else {
        if (!next.lostReason) throw new TypeError("失注理由を選んでください");
        next.wonAmount = undefined;
      }
      return "CLOSED";
    }
    if (isClosed(before.lifecycleState)) {
      next.closedAt = undefined; next.wonAmount = undefined; next.lostReason = undefined;
      next.lostReasonNote = undefined; next.competitor = undefined;
      return "REOPENED";
    }
    return undefined;
  }

  /**
   * Manual fix for AI mis-matches and spelling variants (「山田商事」 vs 「株式会社山田商事」等):
   * a person picks the *correct* existing deal (company -> deal, two steps in the UI) and folds
   * `sourceId` into it. Unlike resolveOpportunity's auto-merge (a fresh, still-empty duplicate the
   * AI itself created during capture), `source` here may already carry real history, so it is kept
   * -- closed and relabelled, never deleted -- rather than dropped.
   */
  mergeOpportunities(actor: Actor, sourceId: string, targetId: string): OpportunitySummary {
    const user = this.requireUser(actor);
    if (sourceId === targetId) throw new TypeError("同じ案件は統合できません");
    const source = this.repo.getOpportunity(sourceId);
    const target = this.repo.getOpportunity(targetId);
    if (!source || !this.canSee(user, source)) throw new NotFoundError("案件");
    if (!target || !this.canSee(user, target)) throw new NotFoundError("統合先の案件");
    const now = nowIso(this.ctx.clock);
    return this.repo.transaction(() => {
      this.repo.moveOpportunityContents(sourceId, targetId);
      const mergedContacts = [...new Set([...(target.contactPersonIds ?? []), ...(source.contactPersonIds ?? [])])]
        .filter(id => this.repo.getPerson(id)?.accountId === target.accountId);
      const merged: Opportunity = {
        ...target,
        expectedAmount: target.expectedAmount ?? source.expectedAmount,
        contactPersonIds: mergedContacts,
        lastMeaningfulActivityAt: [source.lastMeaningfulActivityAt, target.lastMeaningfulActivityAt]
          .filter(isDefined).sort().at(-1),
        updatedAt: now,
      };
      if (!this.repo.updateOpportunity(merged, target.version)) {
        throw new Error("統合先の案件が他のユーザーによって更新されています。再読込してください");
      }
      const closedSource: Opportunity = {
        ...source, lifecycleState: "CLOSED",
        title: `${source.title} (統合済み → ${target.title})`,
        updatedAt: now,
      };
      if (!this.repo.updateOpportunity(closedSource, source.version)) {
        throw new Error("統合元の案件が他のユーザーによって更新されています。再読込してください");
      }
      this.refreshNextActionPointer(targetId);
      audit(this.ctx, { actorType: "USER", actorId: user.id, action: "OPPORTUNITY_MERGED",
        entityType: "opportunity", entityId: targetId,
        before: { sourceId, sourceTitle: source.title, sourceAccountId: source.accountId },
        after: diffable(merged) });
      return this.summarize(this.repo.getOpportunity(targetId)!);
    });
  }

  /**
   * Replaces a deal's 明細 wholesale and re-derives expectedAmount from the tax-exclusive total.
   * With zero rows the deal goes back to a hand-entered expectedAmount (kept as-is).
   */
  setLineItems(actor: Actor, opportunityId: string, inputs: LineItemInput[], version: number): OpportunityDetail {
    const user = this.requireUser(actor);
    const o = this.repo.getOpportunity(opportunityId);
    if (!o || !this.canSee(user, o)) throw new NotFoundError("案件");
    const now = nowIso(this.ctx.clock);
    const items: OpportunityLineItem[] = inputs.map((input, i) => {
      const name = input.name.trim();
      if (!name) throw new TypeError(`${i + 1} 行目: 品目名を入力してください`);
      if (!Number.isFinite(input.quantity) || input.quantity <= 0) throw new TypeError(`${i + 1} 行目: 数量は 0 より大きい数値で入力してください`);
      if (!Number.isFinite(input.unitPrice) || input.unitPrice < 0) throw new TypeError(`${i + 1} 行目: 単価は 0 以上で入力してください`);
      const discount = input.discountAmount ?? 0;
      if (!Number.isFinite(discount) || discount < 0) throw new TypeError(`${i + 1} 行目: 値引は 0 以上で入力してください`);
      if (input.productId && !this.repo.getProduct(input.productId)) throw new NotFoundError("品目");
      return {
        id: newId(), opportunityId, productId: input.productId, name, quantity: input.quantity,
        unitPrice: input.unitPrice, discountAmount: discount, taxCategory: input.taxCategory ?? "STANDARD",
        sortOrder: input.sortOrder ?? i, createdAt: now, updatedAt: now,
      };
    });
    const before = this.repo.listLineItems(opportunityId);
    return this.repo.transaction(() => {
      this.repo.replaceLineItems(opportunityId, items);
      const next: Opportunity = { ...o, updatedAt: now };
      if (items.length > 0) next.expectedAmount = lineTotals(items, this.config).subtotal;
      if (!this.repo.updateOpportunity(next, version)) {
        throw new Error("案件が他のユーザーによって更新されています。再読込してください");
      }
      audit(this.ctx, { actorType: "USER", actorId: user.id, action: "LINE_ITEMS_UPDATED",
        entityType: "opportunity", entityId: opportunityId,
        before: { lineItems: before, expectedAmount: o.expectedAmount },
        after: { lineItems: items, expectedAmount: next.expectedAmount } });
      return this.getOpportunity(actor, opportunityId);
    });
  }

  // ---- customers -------------------------------------------------------------------------------------

  updateAccount(actor: Actor, accountId: string, patch: AccountPatch): CustomerAccount {
    const user = this.requireUser(actor);
    const account = this.repo.getAccount(accountId);
    if (!account || !this.canSeeAccount(user, accountId)) throw new NotFoundError("顧客");
    const next: CustomerAccount = { ...account, updatedAt: nowIso(this.ctx.clock) };
    if (patch.address !== undefined) next.address = cleanText(patch.address);
    if (patch.phone !== undefined) next.phone = cleanText(patch.phone);
    if (patch.websiteUrl !== undefined) next.websiteUrl = cleanUrl(patch.websiteUrl);
    if (patch.corporateNumber !== undefined) next.corporateNumber = cleanText(patch.corporateNumber);
    if (patch.industry !== undefined) next.industry = cleanText(patch.industry);
    this.repo.transaction(() => {
      this.repo.updateAccount(next);
      audit(this.ctx, { actorType: "USER", actorId: user.id, action: "CUSTOMER_UPDATED",
        entityType: "customer_account", entityId: accountId, before: account, after: next });
    });
    return next;
  }

  /**
   * Groups every account by a freshly recomputed normalizeName(displayName) (never the possibly
   * stale stored column) and returns only groups with more than one account, oldest first within
   * each group -- the likely merge target, since it is the one other records tend to reference.
   * Surfaces exactly the failure mode 企業DB連携 can hit: two accounts for the same company under
   * slightly different spellings or suffixes.
   */
  findDuplicateAccountGroups(actor: Actor): { normalizedName: string; accounts: CustomerAccount[] }[] {
    const user = this.requireUser(actor);
    if (user.role !== "ADMIN") throw new AuthorizationError("重複顧客の一覧は管理者のみ参照できます");
    const groups = new Map<string, CustomerAccount[]>();
    for (const account of this.repo.listAccounts(5000)) {
      const key = normalizeName(account.displayName);
      if (!key) continue;
      const group = groups.get(key);
      if (group) group.push(account); else groups.set(key, [account]);
    }
    return [...groups.entries()]
      .filter(([, accounts]) => accounts.length > 1)
      .map(([normalizedName, accounts]) => ({
        normalizedName,
        accounts: accounts.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      }))
      .sort((a, b) => a.normalizedName.localeCompare(b.normalizedName, "ja"));
  }

  /**
   * Manual dedup for customer accounts (表記ゆれ, or two records created for the same company --
   * e.g. by 企業DB連携 matching on a stale normalized name). Folds `sourceId`'s persons,
   * opportunities and activities into `targetId` (repo.reassignAccount), backfills any company-DB
   * fields `target` is missing from `source`, and deletes `source`. Unlike mergeOpportunities there
   * is no separate deal history worth preserving on the source account itself, so it is removed
   * outright rather than kept around closed.
   */
  mergeAccounts(actor: Actor, sourceId: string, targetId: string): CustomerAccount {
    const user = this.requireUser(actor);
    if (user.role !== "ADMIN") throw new AuthorizationError("顧客の統合は管理者のみ実行できます");
    if (sourceId === targetId) throw new TypeError("同じ顧客は統合できません");
    const source = this.repo.getAccount(sourceId);
    const target = this.repo.getAccount(targetId);
    if (!source) throw new NotFoundError("統合元の顧客");
    if (!target) throw new NotFoundError("統合先の顧客");
    const now = nowIso(this.ctx.clock);
    return this.repo.transaction(() => {
      this.repo.reassignAccount(sourceId, targetId);
      const merged: CustomerAccount = {
        ...target,
        address: target.address ?? source.address,
        phone: target.phone ?? source.phone,
        websiteUrl: target.websiteUrl ?? source.websiteUrl,
        corporateNumber: target.corporateNumber ?? source.corporateNumber,
        industry: target.industry ?? source.industry,
        updatedAt: now,
      };
      this.repo.updateAccount(merged);
      this.repo.deleteAccount(sourceId);
      audit(this.ctx, { actorType: "USER", actorId: user.id, action: "CUSTOMER_MERGED",
        entityType: "customer_account", entityId: targetId,
        before: { sourceId, sourceDisplayName: source.displayName }, after: merged });
      return merged;
    });
  }

  /**
   * 企業DB連携: imports/updates customer_accounts and customer_persons from a company-DB CSV
   * (Sansan-style export: see SalesConfig.companyDbSheetUrl's column list). Matches accounts by
   * 法人番号 first (precise), falling back to normalized company name; matches persons by email.
   * Row-level errors (bad data, a person already tied to a different account) are collected rather
   * than aborting the whole sync -- one bad row shouldn't block the other 49.
   */
  importCompanyDb(actor: Actor, csvText: string): CompanyDbSyncResult {
    const user = this.requireUser(actor);
    if (user.role !== "ADMIN") throw new AuthorizationError("企業DB連携は管理者のみ実行できます");
    const records = parseCsvRecords(csvText);
    if (records.length > CSV_MAX_ROWS) {
      throw new TypeError(`${CSV_MAX_ROWS.toLocaleString()} 行を超えています。シートを分けてください`);
    }
    const now = nowIso(this.ctx.clock);
    const result: CompanyDbSyncResult = {
      accountsCreated: 0, accountsUpdated: 0, personsCreated: 0, personsUpdated: 0,
      rowsRead: records.length, errors: [],
    };
    return this.repo.transaction(() => {
      for (let i = 0; i < records.length; i++) {
        const r = records[i]!;
        const rowNum = i + 2; // header is row 1
        try {
          const companyName = (r["会社名"] ?? "").trim();
          if (!companyName) { result.errors.push({ row: rowNum, message: "会社名が空です" }); continue; }
          const corporateNumber = cleanText(r["法人番号"]);

          let account = corporateNumber ? this.repo.findAccountByCorporateNumber(corporateNumber) : undefined;
          if (!account) account = this.repo.findAccountsByComputedName(companyName)[0];

          if (account) {
            const next: CustomerAccount = {
              ...account,
              address: cleanText(r["住所"]) ?? account.address,
              phone: cleanText(r["会社電話"]) ?? account.phone,
              websiteUrl: cleanUrl(r["会社URL"]) ?? account.websiteUrl,
              corporateNumber: corporateNumber ?? account.corporateNumber,
              industry: cleanText(r["業種"]) ?? account.industry,
              updatedAt: now,
            };
            this.repo.updateAccount(next);
            result.accountsUpdated += 1;
            account = next;
          } else {
            account = {
              id: newId(), displayName: companyName, normalizedName: normalizeName(companyName),
              address: cleanText(r["住所"]), phone: cleanText(r["会社電話"]), websiteUrl: cleanUrl(r["会社URL"]),
              corporateNumber, industry: cleanText(r["業種"]),
              resolutionStatus: "MANUAL", createdAt: now, updatedAt: now,
            };
            this.repo.insertAccount(account);
            result.accountsCreated += 1;
          }

          const personName = (r["氏名"] ?? "").trim();
          if (!personName) continue;
          const email = cleanEmail(r["メールアドレス"]);
          const title = [cleanText(r["部署"]), cleanText(r["役職"])].filter((s): s is string => !!s).join(" ") || undefined;
          const phone = cleanText(r["携帯電話"]);
          const existing = email ? this.repo.findPersonByEmail(email) : undefined;
          if (existing) {
            if (existing.accountId && existing.accountId !== account.id) {
              result.errors.push({ row: rowNum, message: `担当者「${personName}」は既に別の顧客に登録されています（メール重複）` });
            } else {
              this.repo.updatePerson({
                ...existing, accountId: account.id, displayName: personName,
                title: title ?? existing.title, phone: phone ?? existing.phone, updatedAt: now,
              });
              result.personsUpdated += 1;
            }
          } else {
            this.repo.insertPerson({
              id: newId(), accountId: account.id, displayName: personName, email, phone, title,
              resolutionStatus: "MANUAL", createdAt: now, updatedAt: now,
            });
            result.personsCreated += 1;
          }
        } catch (err) {
          result.errors.push({ row: rowNum, message: err instanceof Error ? err.message : String(err) });
        }
      }
      audit(this.ctx, { actorType: "USER", actorId: user.id, action: "COMPANY_DB_SYNCED",
        entityType: "tenant", entityId: "tenant", after: result });
      return result;
    });
  }

  createPerson(actor: Actor, accountId: string, input: PersonInput): CustomerPerson {
    const user = this.requireUser(actor);
    const account = this.repo.getAccount(accountId);
    if (!account || !this.canSeeAccount(user, accountId)) throw new NotFoundError("顧客");
    const displayName = input.displayName.trim();
    if (!displayName) throw new TypeError("担当者名は必須です");
    const now = nowIso(this.ctx.clock);
    const person: CustomerPerson = {
      id: newId(), accountId, displayName, title: cleanText(input.title),
      email: cleanEmail(input.email), phone: cleanText(input.phone),
      resolutionStatus: "MANUAL", createdAt: now, updatedAt: now,
    };
    this.repo.transaction(() => {
      this.repo.insertPerson(person);
      audit(this.ctx, { actorType: "USER", actorId: user.id, action: "PERSON_CREATED",
        entityType: "customer_person", entityId: person.id, after: person });
    });
    return this.repo.getPerson(person.id) ?? person;
  }

  updatePerson(actor: Actor, personId: string, patch: PersonPatch): CustomerPerson {
    const user = this.requireUser(actor);
    const person = this.repo.getPerson(personId);
    if (!person?.accountId || !this.canSeeAccount(user, person.accountId)) throw new NotFoundError("担当者");
    const next: CustomerPerson = { ...person, updatedAt: nowIso(this.ctx.clock) };
    if (patch.displayName !== undefined) {
      const displayName = patch.displayName.trim();
      if (!displayName) throw new TypeError("担当者名は必須です");
      next.displayName = displayName;
      next.normalizedName = normalizeName(displayName);
    }
    if (patch.title !== undefined) next.title = cleanText(patch.title);
    if (patch.email !== undefined) next.email = cleanEmail(patch.email);
    if (patch.phone !== undefined) next.phone = cleanText(patch.phone);
    this.repo.transaction(() => {
      this.repo.updatePerson(next);
      audit(this.ctx, { actorType: "USER", actorId: user.id, action: "PERSON_UPDATED",
        entityType: "customer_person", entityId: personId, before: person, after: next });
    });
    return next;
  }

  // ---- products -------------------------------------------------------------------------------

  listProducts(actor: Actor, options: { includeInactive?: boolean } = {}): Product[] {
    this.requireUser(actor);
    return this.repo.listProducts(options.includeInactive ?? false);
  }

  createProduct(actor: Actor, input: ProductInput): Product {
    const user = this.requireProductEditor(actor);
    const name = input.name.trim();
    if (!name) throw new TypeError("品目名を入力してください");
    const code = cleanText(input.code);
    if (code && this.repo.findProductByCode(code)) throw new TypeError("品目コードが重複しています");
    const now = nowIso(this.ctx.clock);
    const product: Product = {
      id: newId(), code, name, category: input.category ?? "SERVICE",
      unitPrice: nonNegative(input.unitPrice, "単価"), cost: nonNegative(input.cost, "原価"),
      taxCategory: input.taxCategory ?? "STANDARD", unitLabel: cleanText(input.unitLabel),
      description: cleanText(input.description), active: input.active ?? true,
      sortOrder: input.sortOrder ?? 0, createdAt: now, updatedAt: now,
    };
    this.repo.transaction(() => {
      this.repo.insertProduct(product);
      audit(this.ctx, { actorType: "USER", actorId: user.id, action: "PRODUCT_CREATED",
        entityType: "product", entityId: product.id, after: product });
    });
    return product;
  }

  updateProduct(actor: Actor, id: string, patch: ProductPatch): Product {
    const user = this.requireProductEditor(actor);
    const current = this.repo.getProduct(id);
    if (!current) throw new NotFoundError("品目");
    const next: Product = { ...current, updatedAt: nowIso(this.ctx.clock) };
    if (patch.name !== undefined) next.name = patch.name.trim() || current.name;
    if (patch.code !== undefined) {
      next.code = cleanText(patch.code);
      if (next.code) {
        const dup = this.repo.findProductByCode(next.code);
        if (dup && dup.id !== id) throw new TypeError("品目コードが重複しています");
      }
    }
    if (patch.category !== undefined) next.category = patch.category;
    if (patch.unitPrice !== undefined) next.unitPrice = patch.unitPrice === null ? undefined : nonNegative(patch.unitPrice, "単価");
    if (patch.cost !== undefined) next.cost = patch.cost === null ? undefined : nonNegative(patch.cost, "原価");
    if (patch.taxCategory !== undefined) next.taxCategory = patch.taxCategory;
    if (patch.unitLabel !== undefined) next.unitLabel = cleanText(patch.unitLabel);
    if (patch.description !== undefined) next.description = cleanText(patch.description);
    if (patch.active !== undefined) next.active = patch.active;
    if (patch.sortOrder !== undefined) next.sortOrder = patch.sortOrder;
    this.repo.transaction(() => {
      this.repo.updateProduct(next);
      audit(this.ctx, { actorType: "USER", actorId: user.id, action: "PRODUCT_UPDATED",
        entityType: "product", entityId: id, before: current, after: next });
    });
    return next;
  }

  /** Product master is shared by everyone, so only MANAGER/ADMIN may change it. */
  private requireProductEditor(actor: Actor): User {
    const user = this.requireUser(actor);
    if (user.role === "SALES") throw new AuthorizationError("商材の編集はマネージャー以上の権限が必要です");
    return user;
  }

  getCustomer(actor: Actor, accountId: string): CustomerDetail {
    const user = this.requireUser(actor);
    const account = this.repo.getAccount(accountId);
    if (!account || !this.canSeeAccount(user, accountId)) throw new NotFoundError("顧客");
    return {
      account,
      persons: this.repo.listPersonsForAccount(accountId),
      opportunities: this.repo.listOpportunitiesVisibleTo(user, { accountId, limit: 500 })
        .map(o => this.summarize(o)),
    };
  }

  async recompute(actor: Actor, opportunityId: string) {
    const user = this.requireUser(actor);
    const o = this.repo.getOpportunity(opportunityId);
    if (!o || !this.canSee(user, o)) throw new NotFoundError("案件");
    return recomputeContext(this.ctx, opportunityId, user.id);
  }

  // ---- next actions --------------------------------------------------------------------------------

  listNextActions(actor: Actor, filter: NextActionFilter = {}): NextAction[] {
    const user = this.requireUser(actor);
    const statuses = filter.statuses ?? ["OPEN", "SNOOZED"];
    let actions: NextAction[];
    if (filter.opportunityId) {
      const o = this.repo.getOpportunity(filter.opportunityId);
      if (!o || !this.canSee(user, o)) throw new NotFoundError("案件");
      actions = this.repo.listNextActionsForOpportunity(filter.opportunityId, statuses);
    } else if (user.role === "SALES" || filter.assignedUserId) {
      const target = user.role === "SALES" ? user.id : filter.assignedUserId!;
      actions = this.repo.listOpenNextActionsForUser(target, filter.limit ?? 200)
        .filter(a => statuses.includes(a.status));
    } else {
      actions = this.repo.listOpenNextActions(filter.limit ?? 500).filter(a => statuses.includes(a.status));
    }
    if (filter.dueBefore) actions = actions.filter(a => a.dueAt !== undefined && a.dueAt <= filter.dueBefore!);
    return actions.slice(0, filter.limit ?? 200);
  }

  createNextAction(actor: Actor, input: NextActionInput): NextAction {
    const user = this.requireUser(actor);
    const o = this.repo.getOpportunity(input.opportunityId);
    if (!o || !this.canSee(user, o)) throw new NotFoundError("案件");
    if (input.dueAt !== undefined && !isIsoDateTime(input.dueAt)) throw new TypeError("dueAt は ISO 8601 で指定してください");
    const now = nowIso(this.ctx.clock);
    const action: NextAction = {
      id: input.id ?? newId(), opportunityId: o.id, assignedUserId: input.assignedUserId ?? user.id,
      actionType: input.actionType ?? "OTHER", title: input.title.trim(), purpose: input.purpose?.trim() ?? "",
      dueAt: input.dueAt ? new Date(input.dueAt).toISOString() : undefined,
      priority: input.priority ?? "NORMAL", status: "OPEN", generatedBy: "USER",
      createdAt: now, updatedAt: now,
    };
    if (!action.title) throw new TypeError("title は必須です");
    this.repo.transaction(() => {
      this.repo.insertNextAction(action);
      this.refreshNextActionPointer(o.id);
      audit(this.ctx, { actorType: "USER", actorId: user.id, action: "NEXT_ACTION_CREATED",
        entityType: "next_action", entityId: action.id, after: action });
    });
    return action;
  }

  updateNextAction(actor: Actor, id: string, patch: NextActionPatch): NextAction {
    const user = this.requireUser(actor);
    const action = this.repo.getNextAction(id);
    if (!action) throw new NotFoundError("次アクション");
    const o = this.repo.getOpportunity(action.opportunityId);
    if (!o || !this.canSee(user, o)) throw new NotFoundError("次アクション");
    if (patch.dueAt !== undefined && patch.dueAt !== null && !isIsoDateTime(patch.dueAt)) {
      throw new TypeError("dueAt は ISO 8601 で指定してください");
    }
    if (patch.snoozedUntil !== undefined && patch.snoozedUntil !== null && !isIsoDateTime(patch.snoozedUntil)) {
      throw new TypeError("snoozedUntil は ISO 8601 で指定してください");
    }
    const status = patch.status ?? action.status;
    const snoozedUntil = status !== "SNOOZED"
      ? undefined
      : patch.snoozedUntil !== undefined
        ? (patch.snoozedUntil ? new Date(patch.snoozedUntil).toISOString() : undefined)
        : action.snoozedUntil;
    const next: NextAction = {
      ...action,
      status,
      snoozedUntil,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.purpose !== undefined ? { purpose: patch.purpose } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.dueAt !== undefined ? { dueAt: patch.dueAt ? new Date(patch.dueAt).toISOString() : undefined } : {}),
      updatedAt: nowIso(this.ctx.clock),
    };
    this.repo.transaction(() => {
      this.repo.updateNextAction(next);
      this.refreshNextActionPointer(o.id);
      audit(this.ctx, { actorType: "USER", actorId: user.id, action: "NEXT_ACTION_UPDATED",
        entityType: "next_action", entityId: id, before: action, after: next });
    });
    return next;
  }

  /**
   * Adopts a NEXT_ACTION suggestion the AI proposed but didn't create (confidence below
   * nextActionAutoConfidence, so it sat in the decision's appliedJson.skipped instead of becoming a
   * real NextAction). The human decides; that's the whole point of surfacing it instead of silently
   * discarding it.
   */
  adoptSuggestion(actor: Actor, decisionId: string, index: number): NextAction {
    const user = this.requireUser(actor);
    const { decision, opportunity, raw, applied } = this.requireSuggestion(user, decisionId, index);
    const now = nowIso(this.ctx.clock);
    const action: NextAction = {
      id: newId(), opportunityId: opportunity.id, assignedUserId: user.id,
      actionType: raw.action_type ?? "OTHER", title: raw.title, purpose: raw.purpose ?? "",
      dueAt: isIsoDateTime(raw.due_at) ? new Date(raw.due_at).toISOString() : undefined,
      priority: raw.priority ?? "NORMAL", status: "OPEN", generatedBy: "AI",
      sourceDecisionId: decisionId, recommendedAt: decision.createdAt, createdAt: now, updatedAt: now,
    };
    this.repo.transaction(() => {
      this.repo.insertNextAction(action);
      this.repo.updateDecision({
        ...decision,
        appliedJson: { ...applied, adopted: [...(applied.adopted ?? []), index] } as unknown as JsonValue,
      });
      this.refreshNextActionPointer(opportunity.id);
      audit(this.ctx, { actorType: "USER", actorId: user.id, action: "NEXT_ACTION_CREATED",
        entityType: "next_action", entityId: action.id, after: action,
        sourceIds: decision.inputSourceIds });
    });
    return action;
  }

  dismissSuggestion(actor: Actor, decisionId: string, index: number): void {
    const user = this.requireUser(actor);
    const { decision, opportunity, applied } = this.requireSuggestion(user, decisionId, index);
    this.repo.updateDecision({
      ...decision,
      appliedJson: { ...applied, dismissed: [...(applied.dismissed ?? []), index] } as unknown as JsonValue,
    });
    audit(this.ctx, { actorType: "USER", actorId: user.id, action: "SUGGESTION_DISMISSED",
      entityType: "opportunity", entityId: opportunity.id, before: { decisionId, index } });
  }

  /** Shared lookup + guards for adoptSuggestion/dismissSuggestion. */
  private requireSuggestion(user: User, decisionId: string, index: number): {
    decision: AIDecision; opportunity: Opportunity; applied: NextActionDecisionApplied;
    raw: NextActionSuggestionRaw;
  } {
    const decision = this.repo.getDecision(decisionId);
    if (!decision || decision.decisionType !== "NEXT_ACTION") throw new NotFoundError("提案");
    const opportunity = this.repo.getOpportunity(decision.entityId);
    if (!opportunity || !this.canSee(user, opportunity)) throw new NotFoundError("提案");
    const applied = (decision.appliedJson ?? {}) as NextActionDecisionApplied;
    const raw = applied.skipped?.[index];
    if (!raw?.title) throw new NotFoundError("提案");
    if (applied.adopted?.includes(index) || applied.dismissed?.includes(index)) {
      throw new Error("この提案は既に処理されています");
    }
    return { decision, opportunity, applied, raw };
  }

  // ---- commitments ---------------------------------------------------------------------------------

  updateCommitment(actor: Actor, id: string, patch: { status?: Commitment["status"]; dueAt?: string | null }): Commitment {
    const user = this.requireUser(actor);
    const c = this.repo.getCommitment(id);
    if (!c) throw new NotFoundError("約束");
    const o = this.repo.getOpportunity(c.opportunityId);
    if (!o || !this.canSee(user, o)) throw new NotFoundError("約束");
    const next: Commitment = {
      ...c,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.dueAt !== undefined ? { dueAt: patch.dueAt ? new Date(patch.dueAt).toISOString() : undefined } : {}),
      updatedAt: nowIso(this.ctx.clock),
    };
    this.repo.transaction(() => {
      this.repo.updateCommitment(next);
      audit(this.ctx, { actorType: "USER", actorId: user.id, action: "COMMITMENT_UPDATED",
        entityType: "commitment", entityId: id, before: c, after: next });
    });
    return next;
  }

  // ---- reviews ---------------------------------------------------------------------------------------

  listReviews(actor: Actor): ReviewDto[] {
    const user = this.requireUser(actor);
    const items = user.role === "SALES"
      ? this.repo.listReviews("OPEN", user.id)
      : this.repo.listReviews("OPEN");
    return items.map(r => this.reviewDto(r));
  }

  /**
   * async because MEMO_TARGET (pin the memo to a chosen deal, then re-run extraction against it)
   * calls the LLM — which cannot happen inside the synchronous DB transaction the rest of this
   * method runs in. That reprocessing step, if any, happens after the transaction commits.
   */
  async resolveReview(actor: Actor, reviewId: string, resolution: ReviewResolution): Promise<ReviewDto> {
    const user = this.requireUser(actor);
    const review = this.repo.getReview(reviewId);
    if (!review) throw new NotFoundError("確認項目");
    if (review.status !== "OPEN") throw new Error("この確認項目は既に処理済みです");
    if (user.role === "SALES" && review.assignedUserId !== user.id) throw new AuthorizationError();
    const option = review.optionsJson?.find(o => o.id === resolution.optionId);
    if (!option) throw new TypeError(`不明な選択肢: ${resolution.optionId}`);
    const value = (option.value ?? {}) as Record<string, JsonValue>;
    const now = nowIso(this.ctx.clock);
    let reprocessSourceId: string | undefined;

    const resolvedDto = this.repo.transaction(() => {
      switch (review.type) {
        case "CUSTOMER_AMBIGUOUS":
          this.resolveCustomer(user, review, value);
          break;
        case "OPPORTUNITY_AMBIGUOUS":
          this.resolveOpportunity(user, review, value);
          break;
        case "MEMO_TARGET":
          reprocessSourceId = this.resolveMemoTarget(user, review, value, now);
          break;
        case "PERSON_AMBIGUOUS":
          this.resolvePerson(user, review, value, now);
          break;
        case "STATE_AMBIGUOUS":
          if (typeof value.lifecycleState === "string") {
            const today = localDate(now, user.timezone || this.config.defaultTimezone);
            this.setOpportunityField(user, review.relatedEntityId!, o => {
              const next = value.lifecycleState as LifecycleState;
              const wasClosed = o.lifecycleState === "WON" || o.lifecycleState === "LOST";
              o.lifecycleState = next;
              if (next === "WON") {
                o.closedAt = o.closedAt ?? today; o.wonAmount = o.wonAmount ?? o.expectedAmount;
                o.lostReason = undefined; o.lostReasonNote = undefined;
              } else if (next === "LOST") {
                o.closedAt = o.closedAt ?? today; o.lostReason = o.lostReason ?? "OTHER";
                o.lostReasonNote = o.lostReasonNote ?? "AI 判定の確認から確定 (理由は未入力)"; o.wonAmount = undefined;
              } else if (wasClosed) {
                o.closedAt = undefined; o.wonAmount = undefined; o.lostReason = undefined;
                o.lostReasonNote = undefined; o.competitor = undefined;
              }
            }, "LIFECYCLE_CONFIRMED");
          }
          break;
        case "AMOUNT_AMBIGUOUS":
          if (typeof value.expectedAmount === "number") {
            this.setOpportunityField(user, review.relatedEntityId!, o => {
              o.expectedAmount = value.expectedAmount as number;
              if (typeof value.currency === "string") o.currency = value.currency;
            }, "AMOUNT_CONFIRMED");
          }
          break;
        case "DATE_AMBIGUOUS": {
          const dueAt = value.needsInput === "dueAt" ? resolution.input?.dueAt : value.dueAt;
          if (dueAt !== undefined) {
            if (!isIsoDateTime(dueAt)) throw new TypeError("期限は ISO 8601 の日時で入力してください");
            this.setDueDate(user, review, new Date(dueAt).toISOString());
          }
          break;
        }
        default:
          break;
      }
      const resolved: ReviewItem = {
        ...review, status: "RESOLVED", resolvedAt: now,
        resolutionJson: { optionId: option.id, label: option.label, input: resolution.input, by: user.id },
      };
      this.repo.updateReview(resolved);
      for (const d of review.sourceEvidenceIds.flatMap(id => this.repo.listDecisionsForSource(id))) {
        if (d.status === "REVIEW_REQUIRED" && d.entityId === review.relatedEntityId) {
          this.repo.updateDecision({ ...d, status: option.id === "none" || option.id === "keep" ? "REJECTED" : "APPROVED" });
        }
      }
      // A pending reprocess (MEMO_TARGET → pinned) settles the source itself once it finishes.
      if (!reprocessSourceId) this.settleSourceStatus(review.sourceEvidenceIds);
      audit(this.ctx, { actorType: "USER", actorId: user.id, action: "REVIEW_RESOLVED",
        entityType: "review_item", entityId: review.id, after: resolved.resolutionJson,
        sourceIds: review.sourceEvidenceIds });
      return this.reviewDto(resolved);
    });

    if (reprocessSourceId) await processSource(this.ctx, reprocessSourceId);
    return resolvedDto;
  }

  /**
   * MEMO_TARGET: `value.opportunityId` pins the memo to that deal (returns the source id so the
   * caller re-runs extraction against it, outside this synchronous transaction); `value.memo`
   * leaves it as a plain note, attached to nothing.
   */
  private resolveMemoTarget(
    user: User, review: ReviewItem, value: Record<string, JsonValue>, now: string,
  ): string | undefined {
    const sourceId = review.relatedEntityId!;
    const source = this.repo.getSource(sourceId);
    if (!source) throw new NotFoundError("取込");
    if (typeof value.opportunityId === "string") {
      const o = this.repo.getOpportunity(value.opportunityId);
      if (!o || !this.canSee(user, o)) throw new NotFoundError("案件");
      // RECEIVED, not PROCESSING: processSource (called after this transaction commits) requires
      // RECEIVED/FAILED and does its own PROCESSING transition.
      this.repo.updateSource({ ...source, targetOpportunityId: value.opportunityId, processingStatus: "RECEIVED" });
      return sourceId;
    }
    if (value.memo === true) {
      this.repo.updateSource({ ...source, processingStatus: "PROCESSED", processedAt: now });
      audit(this.ctx, { actorType: "USER", actorId: user.id, action: "SOURCE_KEPT_AS_MEMO",
        entityType: "source_document", entityId: sourceId });
    }
    return undefined;
  }

  dismissReview(actor: Actor, reviewId: string): ReviewDto {
    const user = this.requireUser(actor);
    const review = this.repo.getReview(reviewId);
    if (!review) throw new NotFoundError("確認項目");
    if (user.role === "SALES" && review.assignedUserId !== user.id) throw new AuthorizationError();
    const now = nowIso(this.ctx.clock);
    const dismissed: ReviewItem = { ...review, status: "DISMISSED", resolvedAt: now, resolutionJson: { dismissedBy: user.id } };
    this.repo.transaction(() => {
      this.repo.updateReview(dismissed);
      this.settleSourceStatus(review.sourceEvidenceIds);
      audit(this.ctx, { actorType: "USER", actorId: user.id, action: "REVIEW_DISMISSED",
        entityType: "review_item", entityId: review.id, sourceIds: review.sourceEvidenceIds });
    });
    return this.reviewDto(dismissed);
  }

  // ---- manager / admin -------------------------------------------------------------------------------

  getManagerSummary(actor: Actor, query: ManagerSummaryQuery = {}): ManagerSummary {
    const user = this.requireUser(actor);
    if (user.role === "SALES") throw new AuthorizationError("マネージャー以上の権限が必要です");
    const now = nowIso(this.ctx.clock);
    const open = this.repo.listOpportunitiesVisibleTo(user, { lifecycleStates: ["OPEN"], limit: 1000 });
    const stalledBefore = addDays(now, -this.config.stalledDays);
    const stalled = open.filter(o => (o.lastMeaningfulActivityAt ?? o.createdAt) < stalledBefore);
    const highRisk = open.filter(o => o.riskLevel === "HIGH");
    const openReviews = this.repo.listReviews("OPEN").length;

    const tz = this.config.defaultTimezone;
    const preset = typeof query.period === "string" ? query.period : query.period ? undefined : "THIS_MONTH";
    const period = resolvePeriod(query.period, now, tz, this.config.fiscalYearStartMonth);
    const weekAgo = addDays(now, -7);
    const aggregates = this.repo.managerKpiAggregates(period.from, period.to, now);
    const perUserStats = this.repo.managerPerUserStats(now, stalledBefore, weekAgo, period.from, period.to);
    const users = this.repo.listUsers();
    const perUser: ManagerPerUserRow[] = users
      .map(u => {
        const s = perUserStats.get(u.id);
        return {
          userId: u.id, displayName: u.displayName, active: u.active,
          openOpportunities: s?.openOpportunities ?? 0, expectedAmountTotal: s?.expectedAmountTotal ?? 0,
          overdueActions: s?.overdueActions ?? 0, stalledOpportunities: s?.stalledOpportunities ?? 0,
          openReviews: s?.openReviews ?? 0, lastCaptureAt: s?.lastCaptureAt, capturesLast7Days: s?.capturesLast7Days ?? 0,
          wonCount: s?.wonCount ?? 0, wonAmount: s?.wonAmount ?? 0,
        };
      })
      .sort((a, b) => Number(b.active) - Number(a.active));

    return {
      generatedAt: now,
      byLifecycle: this.repo.countOpportunitiesByState(),
      stalled: stalled.map(o => this.summarize(o)),
      highRisk: highRisk.map(o => this.summarize(o)),
      contracting: open.filter(o => o.operationalState === "CONTRACTING").map(o => this.summarize(o)),
      openReviews,
      period, periodLabel: periodLabel(period, preset, this.config.fiscalYearStartMonth),
      kpis: {
        openOpportunities: open.length, expectedAmountTotal: aggregates.expectedAmountTotal,
        currency: this.config.defaultCurrency, wonThisMonth: aggregates.wonThisMonth,
        wonAmountThisMonth: aggregates.wonAmountThisMonth,
        lostThisMonth: aggregates.lostThisMonth, stalled: stalled.length, highRisk: highRisk.length,
        overdueActions: aggregates.overdueActions, unresolvedCustomers: aggregates.unresolvedCustomers,
        openReviews,
      },
      perUser,
    };
  }

  getConfig(actor: Actor): ConfigDto {
    this.requireUser(actor);
    return loadConfig(this.repo);
  }

  updateConfig(actor: Actor, patch: Partial<SalesConfig>): ConfigDto {
    const user = this.requireUser(actor);
    if (user.role !== "ADMIN") throw new AuthorizationError("設定の変更は管理者のみ行えます");
    const before = loadConfig(this.repo);
    const after = saveConfig(this.repo, patch, nowIso(this.ctx.clock));
    this.ctx.config = after;
    audit(this.ctx, { actorType: "ADMIN", actorId: user.id, action: "CONFIG_UPDATED",
      entityType: "settings", entityId: "config", before, after });
    return after;
  }

  listAudit(actor: Actor, entityType?: string, entityId?: string, limit = 100) {
    const user = this.requireUser(actor);
    if (user.role === "SALES" && !(entityType && entityId)) throw new AuthorizationError();
    if (entityType && entityId) {
      if (entityType === "opportunity") {
        const o = this.repo.getOpportunity(entityId);
        if (!o || !this.canSee(user, o)) throw new NotFoundError("案件");
      }
      return this.repo.listAuditForEntity(entityType, entityId, limit);
    }
    return this.repo.listAudit(limit);
  }

  // ---- internals -------------------------------------------------------------------------------------

  canSee(user: User, o: Opportunity): boolean {
    if (user.role !== "SALES") return true;
    return o.ownerUserId === user.id || o.collaboratorUserIds.includes(user.id);
  }

  /** A SALES user may edit a customer only through an opportunity they can see. */
  private canSeeAccount(user: User, accountId: string): boolean {
    if (user.role !== "SALES") return true;
    return this.repo.listOpportunitiesVisibleTo(user, { accountId, limit: 1 }).length > 0;
  }

  /**
   * This account's OPEN deals, scoped to what `user` can see (mirrors getManagerSummary's stalled
   * / high-risk rules so the two screens never disagree about what counts as stalled).
   */
  private accountSummaryFor(user: User, accountId: string): AccountSummary {
    const now = nowIso(this.ctx.clock);
    const stalledBefore = addDays(now, -this.config.stalledDays);
    const open = this.repo.listOpportunitiesVisibleTo(user, { accountId, lifecycleStates: ["OPEN"], limit: 500 });
    return {
      openCount: open.length,
      expectedAmountTotal: open.reduce((sum, o) => sum + (o.expectedAmount ?? 0), 0),
      currency: this.config.defaultCurrency,
      stalledCount: open.filter(o => (o.lastMeaningfulActivityAt ?? o.createdAt) < stalledBefore).length,
      highRiskCount: open.filter(o => o.riskLevel === "HIGH").length,
    };
  }

  summarize(o: Opportunity): OpportunitySummary {
    const account = this.repo.getAccount(o.accountId);
    const owner = this.repo.getUser(o.ownerUserId);
    const snapshot = this.repo.latestSnapshot(o.id);
    const nextAction = o.nextActionId ? this.repo.getNextAction(o.nextActionId) : undefined;
    // Drop ids that no longer resolve to a person of this same account (deleted contact, or a
    // stale id left over from a customer merge) rather than let them leak into the DTO.
    const contacts = (o.contactPersonIds ?? [])
      .map(id => this.repo.getPerson(id))
      .filter((p): p is CustomerPerson => !!p && p.accountId === o.accountId);
    return {
      id: o.id, title: o.title, accountId: o.accountId,
      accountName: account?.displayName ?? UNRESOLVED_ACCOUNT_NAME,
      accountResolutionStatus: account?.resolutionStatus ?? "UNRESOLVED",
      ownerUserId: o.ownerUserId, ownerName: owner?.displayName ?? "?",
      collaboratorUserIds: o.collaboratorUserIds,
      contactPersonIds: contacts.map(p => p.id),
      contactNames: contacts.map(p => p.displayName),
      primaryContactName: contacts[0]?.displayName,
      lifecycleState: o.lifecycleState, operationalState: o.operationalState,
      phaseLabel: o.phaseLabel, expectedAmount: o.expectedAmount, currency: o.currency,
      expectedCloseDate: o.expectedCloseDate, proposalDocumentUrl: o.proposalDocumentUrl,
      riskLevel: o.riskLevel, riskReason: o.riskReason,
      wonAmount: o.wonAmount, closedAt: o.closedAt, lostReason: o.lostReason,
      lostReasonNote: o.lostReasonNote, competitor: o.competitor,
      hasLineItems: this.repo.countLineItems(o.id) > 0,
      currentSituation: snapshot?.currentSituation,
      nextAction: nextAction && nextAction.status === "OPEN" ? nextAction : undefined,
      lastMeaningfulActivityAt: o.lastMeaningfulActivityAt,
      lastContextRecomputedAt: o.lastContextRecomputedAt,
      updatedAt: o.updatedAt, version: o.version,
    };
  }

  private visibleSource(actor: Actor, sourceId: string): SourceDocument {
    const user = this.requireUser(actor);
    const source = this.repo.getSource(sourceId);
    if (!source) throw new NotFoundError("取込");
    if (user.role === "SALES" && source.submittedByUserId !== user.id) {
      const app = this.repo.getApplication(sourceId);
      const o = app?.opportunityId ? this.repo.getOpportunity(app.opportunityId) : undefined;
      if (!o || !this.canSee(user, o)) throw new NotFoundError("取込");
    }
    return source;
  }

  private reviewOpportunityId(r: ReviewItem): string | undefined {
    if (r.relatedEntityType === "opportunity") return r.relatedEntityId;
    if (r.relatedEntityType === "commitment" && r.relatedEntityId) {
      return this.repo.getCommitment(r.relatedEntityId)?.opportunityId;
    }
    if (r.relatedEntityType === "customer_account" && r.relatedEntityId) {
      return this.repo.listOpenOpportunitiesForAccount(r.relatedEntityId)[0]?.id;
    }
    return undefined;
  }

  private reviewDto(r: ReviewItem): ReviewDto {
    const opportunityId = this.reviewOpportunityId(r);
    let relatedTitle: string | undefined;
    if (opportunityId) relatedTitle = this.repo.getOpportunity(opportunityId)?.title;
    else if (r.relatedEntityType === "customer_account" && r.relatedEntityId) {
      relatedTitle = this.repo.getAccount(r.relatedEntityId)?.displayName;
    }
    const sources = r.sourceEvidenceIds
      .map(id => this.repo.getSource(id))
      .filter((s): s is SourceDocument => s !== undefined)
      .map(s => ({ id: s.id, sourceType: s.sourceType, rawText: s.rawText, occurredAt: s.occurredAt }));
    return { ...r, relatedTitle, opportunityId, sources };
  }

  private refreshNextActionPointer(opportunityId: string): void {
    const o = this.repo.getOpportunity(opportunityId);
    if (!o) return;
    const first = this.repo.listNextActionsForOpportunity(opportunityId, ["OPEN"])[0];
    if (o.nextActionId === first?.id) return;
    this.repo.updateOpportunity({ ...o, nextActionId: first?.id, updatedAt: nowIso(this.ctx.clock) }, o.version);
  }

  private setOpportunityField(
    user: User, opportunityId: string, mutate: (o: Opportunity) => void, action: string,
  ): void {
    const o = this.repo.getOpportunity(opportunityId);
    if (!o) throw new NotFoundError("案件");
    const before = { ...o };
    const next = { ...o };
    mutate(next);
    next.updatedAt = nowIso(this.ctx.clock);
    if (!this.repo.updateOpportunity(next, o.version)) throw new Error("案件が同時に更新されました");
    audit(this.ctx, { actorType: "USER", actorId: user.id, action, entityType: "opportunity",
      entityId: opportunityId, before: diffable(before), after: diffable(next) });
  }

  private setDueDate(user: User, review: ReviewItem, dueAt: string): void {
    if (review.relatedEntityType === "commitment" && review.relatedEntityId) {
      const c = this.repo.getCommitment(review.relatedEntityId);
      if (!c) return;
      const next = { ...c, dueAt, updatedAt: nowIso(this.ctx.clock) };
      this.repo.updateCommitment(next);
      audit(this.ctx, { actorType: "USER", actorId: user.id, action: "COMMITMENT_DUE_SET",
        entityType: "commitment", entityId: c.id, before: c, after: next });
    } else if (review.relatedEntityType === "next_action" && review.relatedEntityId) {
      const a = this.repo.getNextAction(review.relatedEntityId);
      if (!a) return;
      const next = { ...a, dueAt, updatedAt: nowIso(this.ctx.clock) };
      this.repo.updateNextAction(next);
      audit(this.ctx, { actorType: "USER", actorId: user.id, action: "NEXT_ACTION_DUE_SET",
        entityType: "next_action", entityId: a.id, before: a, after: next });
    }
  }

  /** CUSTOMER_AMBIGUOUS: merge the placeholder into the chosen account, or promote it. */
  private resolveCustomer(user: User, review: ReviewItem, value: Record<string, JsonValue>): void {
    if (review.relatedEntityType === "opportunity") {
      // "customer of the text vs customer of the opportunity" conflict.
      if (value.detach === true) {
        const o = this.repo.getOpportunity(review.relatedEntityId!);
        if (!o) return;
        const now = nowIso(this.ctx.clock);
        const app = review.sourceEvidenceIds.map(id => this.repo.getApplication(id)).find(isDefined);
        if (!app?.activityId) return;
        const activity = this.repo.getActivity(app.activityId);
        if (!activity) return;
        const placeholder: CustomerAccount = {
          id: newId(), displayName: UNRESOLVED_ACCOUNT_NAME, resolutionStatus: "UNRESOLVED",
          createdAt: now, updatedAt: now,
        };
        this.repo.insertAccount(placeholder);
        const fresh: Opportunity = {
          id: newId(), accountId: placeholder.id, title: activity.summary.slice(0, 60),
          ownerUserId: user.id, collaboratorUserIds: [], lifecycleState: "OPEN",
          operationalState: "UNKNOWN", riskLevel: "NONE", version: 1, createdAt: now, updatedAt: now,
        };
        this.repo.insertOpportunity(fresh);
        this.repo.db.run("UPDATE activities SET opportunity_id = ?, account_id = ? WHERE id = ?",
          fresh.id, placeholder.id, activity.id);
        for (const id of app.createdCommitmentIds) {
          const c = this.repo.getCommitment(id);
          if (c) this.repo.updateCommitment({ ...c, opportunityId: fresh.id });
        }
        for (const id of app.createdNextActionIds) {
          const a = this.repo.getNextAction(id);
          if (a) this.repo.updateNextAction({ ...a, opportunityId: fresh.id });
        }
        this.repo.updateApplication({ ...app, opportunityId: fresh.id, createdOpportunity: true, createdAccountId: placeholder.id });
        audit(this.ctx, { actorType: "USER", actorId: user.id, action: "ACTIVITY_DETACHED",
          entityType: "opportunity", entityId: fresh.id, before: { from: o.id }, after: diffable(fresh) });
      }
      return;
    }
    const placeholderId = review.relatedEntityId!;
    const placeholder = this.repo.getAccount(placeholderId);
    if (!placeholder) return;
    const now = nowIso(this.ctx.clock);
    if (typeof value.accountId === "string") {
      const target = this.repo.getAccount(value.accountId);
      if (!target) throw new NotFoundError("顧客");
      this.repo.reassignAccount(placeholder.id, target.id);
      this.repo.deleteAccount(placeholder.id);
      // A human just vouched that this new mention is the same customer as `target` — that
      // confirmation applies to `target` itself too, not only to its persons, so later mentions
      // that match it (entity-resolution.ts's isConfirmed) stop asking again for no reason.
      if (target.resolutionStatus === "UNRESOLVED") {
        this.repo.updateAccount({ ...target, resolutionStatus: "MANUAL", updatedAt: now });
      }
      for (const p of this.repo.listPersonsForAccount(target.id)) {
        if (p.resolutionStatus === "UNRESOLVED") this.repo.updatePerson({ ...p, resolutionStatus: "MANUAL", updatedAt: now });
      }
      audit(this.ctx, { actorType: "USER", actorId: user.id, action: "CUSTOMER_MERGED",
        entityType: "customer_account", entityId: target.id,
        before: { placeholder: placeholder.displayName }, after: { accountId: target.id } });
    } else if (value.newAccount === true) {
      const promoted: CustomerAccount = { ...placeholder, resolutionStatus: "MANUAL", updatedAt: now };
      this.repo.updateAccount(promoted);
      for (const p of this.repo.listPersonsForAccount(placeholder.id)) {
        this.repo.updatePerson({ ...p, resolutionStatus: "MANUAL", updatedAt: now });
      }
      audit(this.ctx, { actorType: "USER", actorId: user.id, action: "CUSTOMER_CONFIRMED_NEW",
        entityType: "customer_account", entityId: placeholder.id, before: placeholder, after: promoted });
    }
    // value.none: leave the placeholder as UNRESOLVED.
  }

  /**
   * PERSON_AMBIGUOUS: `value.personId` confirms an existing contact was the one meant (nothing to
   * write — the account already has that record); `value.newPerson` creates one from the mention's
   * own name/title/email/phone; `value.none` leaves it unlinked.
   */
  private resolvePerson(user: User, review: ReviewItem, value: Record<string, JsonValue>, now: string): void {
    if (value.newPerson !== true) return;
    const accountId = review.relatedEntityId!;
    if (!this.repo.getAccount(accountId)) return;
    const name = typeof value.name === "string" ? value.name.trim() : "";
    if (!name) return;
    const person: CustomerPerson = {
      id: newId(), accountId, displayName: name, normalizedName: normalizeName(name),
      title: typeof value.title === "string" ? value.title : undefined,
      email: typeof value.email === "string" ? normalizeEmail(value.email) : undefined,
      phone: typeof value.phone === "string" ? value.phone : undefined,
      resolutionStatus: "MANUAL", createdAt: now, updatedAt: now,
    };
    this.repo.insertPerson(person);
    audit(this.ctx, { actorType: "USER", actorId: user.id, action: "PERSON_CREATED",
      entityType: "customer_person", entityId: person.id, after: person, sourceIds: review.sourceEvidenceIds });
  }

  /** OPPORTUNITY_AMBIGUOUS: fold the freshly created opportunity into the chosen one. */
  private resolveOpportunity(user: User, review: ReviewItem, value: Record<string, JsonValue>): void {
    if (typeof value.opportunityId !== "string") return;
    const fresh = this.repo.getOpportunity(review.relatedEntityId!);
    const target = this.repo.getOpportunity(value.opportunityId);
    if (!fresh || !target || fresh.id === target.id) return;
    this.repo.moveOpportunityContents(fresh.id, target.id);
    this.repo.deleteOpportunity(fresh.id);
    const now = nowIso(this.ctx.clock);
    const merged: Opportunity = {
      ...target,
      operationalState: fresh.operationalState !== "UNKNOWN" ? fresh.operationalState : target.operationalState,
      expectedAmount: fresh.expectedAmount ?? target.expectedAmount,
      lastMeaningfulActivityAt: [fresh.lastMeaningfulActivityAt, target.lastMeaningfulActivityAt]
        .filter(isDefined).sort().at(-1),
      contactPersonIds: [...new Set([...(target.contactPersonIds ?? []), ...(fresh.contactPersonIds ?? [])])],
      updatedAt: now,
    };
    this.repo.updateOpportunity(merged, target.version);
    this.refreshNextActionPointer(target.id);
    audit(this.ctx, { actorType: "USER", actorId: user.id, action: "OPPORTUNITY_MERGED",
      entityType: "opportunity", entityId: target.id, before: { merged: fresh.id }, after: diffable(merged) });
  }

  /** When every review for a source is closed, its status becomes PROCESSED. */
  private settleSourceStatus(sourceIds: string[]): void {
    for (const id of sourceIds) {
      const source = this.repo.getSource(id);
      if (!source || source.processingStatus !== "REVIEW_REQUIRED") continue;
      const open = this.repo.listReviewsForSource(id).some(r => r.status === "OPEN");
      if (!open) this.repo.updateSource({ ...source, processingStatus: "PROCESSED" });
    }
  }
}

/** A raw `next_actions[]` entry from the extraction JSON, as stored in appliedJson.skipped. */
interface NextActionSuggestionRaw {
  action_type?: NextActionType;
  title: string;
  purpose?: string;
  due_at?: string | null;
  priority?: Priority;
  confidence?: number;
}

/** Shape of a NEXT_ACTION decision's appliedJson (see pipeline/ingest.ts "5. Next actions"). */
interface NextActionDecisionApplied {
  nextActionIds?: string[];
  skipped?: NextActionSuggestionRaw[];
  /** Indices into `skipped` already turned into a real NextAction or explicitly dismissed. */
  adopted?: number[];
  dismissed?: number[];
}

/** Suggestions still pending a human decision, across every NEXT_ACTION decision given. */
function nextActionSuggestions(decisions: AIDecision[]): NextActionSuggestion[] {
  const suggestions: NextActionSuggestion[] = [];
  for (const d of decisions) {
    if (d.decisionType !== "NEXT_ACTION") continue;
    const applied = (d.appliedJson ?? {}) as NextActionDecisionApplied;
    (applied.skipped ?? []).forEach((raw, index) => {
      if (!raw?.title) return;
      if (applied.adopted?.includes(index) || applied.dismissed?.includes(index)) return;
      suggestions.push({
        decisionId: d.id, index,
        actionType: raw.action_type ?? "OTHER", title: raw.title, purpose: raw.purpose ?? "",
        dueAt: isIsoDateTime(raw.due_at) ? new Date(raw.due_at).toISOString() : undefined,
        priority: raw.priority ?? "NORMAL", confidence: raw.confidence ?? 0, createdAt: d.createdAt,
      });
    });
  }
  return suggestions;
}

function isDefined<T>(v: T | undefined | null): v is T {
  return v !== undefined && v !== null;
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Trimmed text, or undefined for null / blank (so the column is cleared). */
function cleanText(value: string | null | undefined): string | undefined {
  return value?.trim() || undefined;
}

function nonNegative(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${label}は 0 以上の数値で入力してください`);
  return value;
}

function cleanEmail(value: string | null | undefined): string | undefined {
  const email = cleanText(value);
  if (email === undefined) return undefined;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new TypeError("メールアドレスの形式が正しくありません");
  return normalizeEmail(email);
}

/** Accepts "example.co.jp" as well as a full URL; only http(s) links are stored. */
function cleanUrl(value: string | null | undefined): string | undefined {
  const text = cleanText(value);
  if (text === undefined) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new TypeError("会社URLの形式が正しくありません");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError("会社URLは http(s) で指定してください");
  return url.toString();
}

/** Last instant of the local calendar day containing `iso`, as an ISO UTC string. */
export function endOfLocalDay(iso: string, timeZone: string): string {
  const date = localDate(iso, timeZone);
  // Find the UTC instant of local 23:59:59.999 by probing the offset at local noon.
  const noonUtc = Date.parse(`${date}T12:00:00Z`);
  const offsetMinutes = tzOffsetMinutes(noonUtc, timeZone);
  return new Date(Date.parse(`${date}T23:59:59.999Z`) - offsetMinutes * 60_000).toISOString();
}

/** First instant of the local calendar month containing `iso`, as an ISO UTC string. */
export function startOfLocalMonth(iso: string, timeZone: string): string {
  const [year, month] = localDate(iso, timeZone).split("-");
  const date = `${year}-${month}-01`;
  const noonUtc = Date.parse(`${date}T12:00:00Z`);
  const offsetMinutes = tzOffsetMinutes(noonUtc, timeZone);
  return new Date(Date.parse(`${date}T00:00:00.000Z`) - offsetMinutes * 60_000).toISOString();
}

function tzOffsetMinutes(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - utcMs) / 60_000);
}
