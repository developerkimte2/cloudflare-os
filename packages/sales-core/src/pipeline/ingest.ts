/**
 * Source ingest pipeline (設計書 §15, WF-01):
 *
 *   receive → raw保存 → dedupe → Claude structured extraction → Zod validation →
 *   deterministic rules → auto apply / review → context snapshot → audit
 *
 * `captureText()` is synchronous and cheap (stores the raw source). `processSource()` does the AI
 * work and applies the result in one DB transaction, so a crash leaves the source RECEIVED/FAILED
 * and re-runnable (設計書 §47 Claude Down).
 */
import { completeJson, SchemaValidationError } from "../ai/json.js";
import { extractionSchema, SCHEMA_VERSION, type Extraction } from "../ai/schema.js";
import {
  buildExtractionRequest, EXTRACTION_PROMPT_VERSION, type KnownAccount, type OpenOpportunityRef,
} from "../ai/skills.js";
import type {
  AIContextSnapshot, AIDecision, AIDecisionStatus, AIDecisionType, Activity, Commitment,
  CustomerAccount, CustomerPerson, JsonValue, NextAction, Opportunity, ReviewItem,
  SourceApplication, SourceDocument, SourceType, User,
} from "../domain/types.js";
import {
  canonicalizeText, isIsoDateTime, newId, normalizeEmail, normalizeName, nowIso, sha256Hex,
} from "../domain/util.js";
import {
  acceptDueAt, deriveAmount, derivePriority, deriveState, type ReviewTrigger,
} from "../rules/business.js";
import { customerReviewOptions, resolveEntities } from "../rules/entity-resolution.js";
import { LlmError } from "../ai/provider.js";
import { audit } from "./audit.js";
import { logEvent, type CoreContext } from "./context.js";

export interface CaptureInput {
  userId: string;
  text: string;
  sourceType?: SourceType;
  /** When the user said when it happened (ISO). */
  occurredAt?: string;
  externalId?: string;
}

export interface CaptureReceipt {
  sourceId: string;
  /** True when an identical text was already captured; nothing new was stored (AC-009). */
  duplicate: boolean;
  status: SourceDocument["processingStatus"];
}

export const UNRESOLVED_ACCOUNT_NAME = "(顧客未特定)";

export async function captureText(ctx: CoreContext, input: CaptureInput): Promise<CaptureReceipt> {
  const text = input.text.trim();
  if (!text) throw new TypeError("capture: text is empty");
  if (text.length > 100_000) throw new TypeError("capture: text is too long (max 100,000 chars)");
  const user = ctx.repo.getUser(input.userId);
  if (!user) throw new Error(`capture: unknown user ${input.userId}`);
  if (input.occurredAt !== undefined && !isIsoDateTime(input.occurredAt)) {
    throw new TypeError("capture: occurredAt must be an ISO 8601 date-time");
  }

  const hash = await sha256Hex(`${input.userId}\n${canonicalizeText(text)}`);
  const existing = ctx.repo.findSourceByHash(hash);
  if (existing) return { sourceId: existing.id, duplicate: true, status: existing.processingStatus };

  const source: SourceDocument = {
    id: newId(),
    sourceType: input.sourceType ?? "TEXT",
    externalId: input.externalId,
    submittedByUserId: user.id,
    rawText: text,
    contentHash: hash,
    occurredAt: input.occurredAt ? new Date(input.occurredAt).toISOString() : undefined,
    receivedAt: nowIso(ctx.clock),
    processingStatus: "RECEIVED",
  };
  ctx.repo.transaction(() => {
    ctx.repo.insertSource(source);
    audit(ctx, {
      actorType: "USER", actorId: user.id, action: "SOURCE_RECEIVED",
      entityType: "source_document", entityId: source.id,
      after: { sourceType: source.sourceType, length: text.length },
    });
  });
  logEvent(ctx, "source.received", { sourceId: source.id, sourceType: source.sourceType });
  return { sourceId: source.id, duplicate: false, status: "RECEIVED" };
}

export interface ProcessResult {
  sourceId: string;
  status: SourceDocument["processingStatus"];
  opportunityId?: string;
  activityId?: string;
  reviewIds: string[];
  nextActionIds: string[];
  commitmentIds: string[];
  notSalesRelated?: boolean;
  error?: string;
  model?: string;
  repairs?: number;
}

/** Runs the AI extraction + rules for one RECEIVED/FAILED source. Safe to retry. */
export async function processSource(ctx: CoreContext, sourceId: string): Promise<ProcessResult> {
  const source = ctx.repo.getSource(sourceId);
  if (!source) throw new Error(`processSource: unknown source ${sourceId}`);
  if (source.processingStatus !== "RECEIVED" && source.processingStatus !== "FAILED") {
    throw new Error(`processSource: source ${sourceId} is ${source.processingStatus}`);
  }
  if (!source.rawText) throw new Error(`processSource: source ${sourceId} has no text`);
  const submitter = source.submittedByUserId ? ctx.repo.getUser(source.submittedByUserId) : undefined;
  if (!submitter) throw new Error(`processSource: source ${sourceId} has no submitter`);

  ctx.repo.updateSource({ ...source, processingStatus: "PROCESSING", processingError: undefined });
  const referenceTime = nowIso(ctx.clock);

  let extraction: Extraction;
  let modelName: string;
  let repairs = 0;
  try {
    const request = buildExtractionRequest({
      referenceTime,
      submitter,
      sourceType: source.sourceType,
      occurredAt: source.occurredAt,
      text: source.rawText,
      knownAccounts: knownAccountsFor(ctx),
      openOpportunities: openOpportunitiesFor(ctx, submitter),
    });
    const result = await completeJson(ctx.llm, request, extractionSchema, { maxRepairs: 1 });
    extraction = result.value;
    modelName = `${result.response.provider}/${result.response.model}`;
    repairs = result.repairs;
  } catch (err) {
    const message = err instanceof SchemaValidationError
      ? `AI output failed validation: ${err.issues.slice(0, 3).join("; ")}`
      : err instanceof LlmError
        ? `AI request failed: ${err.message}`
        : `AI processing failed: ${(err as Error).message}`;
    ctx.repo.updateSource({ ...source, processingStatus: "FAILED", processingError: message });
    audit(ctx, {
      actorType: "SYSTEM", action: "SOURCE_FAILED", entityType: "source_document",
      entityId: source.id, after: { error: message },
    });
    logEvent(ctx, "source.failed", { sourceId: source.id, kind: (err as Error).name });
    return { sourceId: source.id, status: "FAILED", reviewIds: [], nextActionIds: [], commitmentIds: [], error: message };
  }

  return ctx.repo.transaction(() =>
    applyExtraction(ctx, source, submitter, extraction, { referenceTime, modelName, repairs }));
}

// ---------------------------------------------------------------------------------------------

function knownAccountsFor(ctx: CoreContext): KnownAccount[] {
  return ctx.repo.listAccounts(100)
    .filter(a => a.displayName !== UNRESOLVED_ACCOUNT_NAME)
    .map(a => ({
      id: a.id,
      displayName: a.displayName,
      primaryDomain: a.primaryDomain,
      persons: ctx.repo.listPersonsForAccount(a.id).slice(0, 20).map(p => ({
        id: p.id, displayName: p.displayName, email: p.email, title: p.title,
      })),
    }));
}

function openOpportunitiesFor(ctx: CoreContext, user: User): OpenOpportunityRef[] {
  const opps = ctx.repo.listOpportunitiesVisibleTo(
    { ...user, role: "SALES" }, { lifecycleStates: ["OPEN", "ON_HOLD"], limit: 50 });
  return opps.map(o => {
    const account = ctx.repo.getAccount(o.accountId);
    const last = ctx.repo.listActivitiesForOpportunity(o.id, 1)[0];
    return {
      id: o.id, title: o.title, accountId: o.accountId,
      accountName: account?.displayName ?? "?",
      operationalState: o.operationalState, lifecycleState: o.lifecycleState,
      lastActivitySummary: last?.summary,
    };
  });
}

interface ApplyMeta {
  referenceTime: string;
  modelName: string;
  repairs: number;
}

function applyExtraction(
  ctx: CoreContext, source: SourceDocument, submitter: User, x: Extraction, meta: ApplyMeta,
): ProcessResult {
  const now = nowIso(ctx.clock);
  const decisions: AIDecision[] = [];
  const reviews: ReviewItem[] = [];
  const app: SourceApplication = {
    sourceId: source.id,
    createdCommitmentIds: [], createdNextActionIds: [], createdReviewIds: [], createdPersonIds: [],
    createdOpportunity: false, decisionIds: [], appliedAt: now,
  };

  const decide = (
    type: AIDecisionType, entityType: string, entityId: string, proposed: JsonValue, applied: JsonValue,
    confidence: number, status: AIDecisionStatus, reasoning: string, evidence: JsonValue = [],
  ): AIDecision => {
    const d: AIDecision = {
      id: newId(), entityType, entityId, decisionType: type, inputSourceIds: [source.id],
      proposedJson: proposed, appliedJson: applied, confidence, status,
      reasoningSummary: reasoning, evidenceJson: evidence, modelName: meta.modelName,
      promptVersion: EXTRACTION_PROMPT_VERSION, createdAt: now,
    };
    ctx.repo.insertDecision(d);
    decisions.push(d);
    app.decisionIds.push(d.id);
    return d;
  };

  const review = (
    trigger: ReviewTrigger, relatedEntityType: string, relatedEntityId: string,
  ): ReviewItem => {
    const r: ReviewItem = {
      id: newId(), type: trigger.type, assignedUserId: submitter.id,
      relatedEntityType, relatedEntityId, question: trigger.question,
      optionsJson: trigger.options, sourceEvidenceIds: [source.id], status: "OPEN", createdAt: now,
    };
    ctx.repo.insertReview(r);
    reviews.push(r);
    app.createdReviewIds.push(r.id);
    return r;
  };

  // --- Not sales related: record the decision and stop (no placeholder customers for chit-chat).
  if (x.not_sales_related) {
    decide("ENTITY_RESOLUTION", "source_document", source.id, { not_sales_related: true }, null,
      x.activity.confidence, "AUTO_APPLIED", "営業活動に関係しない入力と判断");
    ctx.repo.updateSource({ ...source, processingStatus: "PROCESSED", processedAt: now, processingError: undefined });
    ctx.repo.insertApplication(app);
    audit(ctx, { actorType: "AI", action: "SOURCE_PROCESSED", entityType: "source_document",
      entityId: source.id, after: { notSalesRelated: true }, sourceIds: [source.id] });
    return { sourceId: source.id, status: "PROCESSED", reviewIds: [], nextActionIds: [],
      commitmentIds: [], notSalesRelated: true, model: meta.modelName, repairs: meta.repairs };
  }

  // --- 1. Opportunity / customer resolution -----------------------------------------------------
  const resolution = resolveEntities(ctx.repo, x, ctx.config);
  const visible = openOpportunitiesFor(ctx, submitter);
  const visibleIds = new Set(visible.map(v => v.id));

  let opportunity: Opportunity | undefined;
  let opportunityBefore: Opportunity | undefined;
  let account: CustomerAccount | undefined;

  const matchedExisting = x.opportunity.match === "EXISTING" &&
    x.opportunity.existing_opportunity_id && visibleIds.has(x.opportunity.existing_opportunity_id) &&
    x.opportunity.confidence >= ctx.config.opportunityAutoConfidence
    ? ctx.repo.getOpportunity(x.opportunity.existing_opportunity_id) : undefined;

  if (matchedExisting) {
    opportunity = matchedExisting;
    opportunityBefore = { ...matchedExisting };
    account = ctx.repo.getAccount(matchedExisting.accountId);
    decide("OPPORTUNITY_RESOLUTION", "opportunity", matchedExisting.id,
      { match: "EXISTING", id: matchedExisting.id }, { opportunityId: matchedExisting.id },
      x.opportunity.confidence, "AUTO_APPLIED", "既存案件に一致 (本文と案件一覧の照合)");
    if (resolution.account && resolution.account.id !== matchedExisting.accountId) {
      review({
        type: "CUSTOMER_AMBIGUOUS",
        question: `本文の顧客「${resolution.account.displayName}」と案件「${matchedExisting.title}」の顧客が一致しません。案件の紐付けを確認してください。`,
        options: [
          { id: "keep", label: "この案件のままにする", value: {} },
          { id: "detach", label: "案件から切り離して新規案件にする", value: { detach: true } },
        ],
      }, "opportunity", matchedExisting.id);
    }
  } else {
    // Customer first.
    if (resolution.account) {
      account = resolution.account;
      decide("ENTITY_RESOLUTION", "customer_account", account.id,
        { method: resolution.method, candidates: resolution.candidates.map(c => c.id) },
        { accountId: account.id }, resolution.confidence, "AUTO_APPLIED", resolution.reason,
        x.entities);
    } else {
      // Placeholder (設計書 §13.4). Named after the mention so the review reads naturally.
      const placeholder: CustomerAccount = {
        id: newId(),
        displayName: resolution.mentionedCompanyName ?? UNRESOLVED_ACCOUNT_NAME,
        normalizedName: resolution.mentionedCompanyName
          ? normalizeName(resolution.mentionedCompanyName) : undefined,
        resolutionStatus: "UNRESOLVED",
        createdAt: now, updatedAt: now,
      };
      ctx.repo.insertAccount(placeholder);
      app.createdAccountId = placeholder.id;
      account = placeholder;
      const d = decide("ENTITY_RESOLUTION", "customer_account", placeholder.id,
        { method: resolution.method, candidates: resolution.candidates.map(c => c.id) },
        { placeholderAccountId: placeholder.id },
        resolution.confidence, resolution.needsReview ? "REVIEW_REQUIRED" : "AUTO_APPLIED",
        resolution.reason, x.entities);
      if (resolution.needsReview) {
        review({
          type: "CUSTOMER_AMBIGUOUS",
          question: resolution.candidates.length > 0
            ? `「${placeholder.displayName}」はどの顧客ですか？ (${resolution.reason})`
            : `「${placeholder.displayName}」は既存顧客に見つかりません。新規顧客として登録しますか？`,
          options: customerReviewOptions(resolution, placeholder.id),
        }, "customer_account", placeholder.id).id;
        void d;
      }
    }

    // Persons that did not match an existing record are created under the account.
    for (const p of resolution.unmatchedPersons) {
      if (!p.name || p.confidence < 0.5) continue;
      const person: CustomerPerson = {
        id: newId(), accountId: account.id, displayName: p.name,
        normalizedName: normalizeName(p.name),
        email: p.email ? normalizeEmail(p.email) : undefined,
        title: p.title ?? undefined,
        resolutionStatus: account.resolutionStatus === "UNRESOLVED" ? "UNRESOLVED" : "MANUAL",
        createdAt: now, updatedAt: now,
      };
      ctx.repo.insertPerson(person);
      app.createdPersonIds.push(person.id);
    }

    // Opportunity under that account.
    const openForAccount = account.resolutionStatus === "UNRESOLVED"
      ? [] : ctx.repo.listOpenOpportunitiesForAccount(account.id);
    const wantsNew = x.opportunity.match === "NEW" && x.opportunity.confidence >= ctx.config.opportunityAutoConfidence;
    const llmPick = x.opportunity.existing_opportunity_id
      ? openForAccount.find(o => o.id === x.opportunity.existing_opportunity_id) : undefined;
    if (!wantsNew && llmPick && x.opportunity.confidence >= ctx.config.opportunityAutoConfidence) {
      opportunity = llmPick;
    } else if (!wantsNew && openForAccount.length === 1) {
      opportunity = openForAccount[0];
    }
    if (opportunity) {
      opportunityBefore = { ...opportunity };
      decide("OPPORTUNITY_RESOLUTION", "opportunity", opportunity.id,
        { match: x.opportunity.match, id: opportunity.id }, { opportunityId: opportunity.id },
        Math.max(x.opportunity.confidence, openForAccount.length === 1 ? 0.9 : 0), "AUTO_APPLIED",
        openForAccount.length === 1 ? "顧客の唯一の進行中案件に紐付け" : "AI が既存案件を選択");
    } else {
      opportunity = {
        id: newId(), accountId: account.id,
        title: x.opportunity.title?.trim() || defaultTitle(account, x),
        ownerUserId: submitter.id, collaboratorUserIds: [],
        lifecycleState: "OPEN", operationalState: "UNKNOWN",
        riskLevel: "NONE", version: 1, createdAt: now, updatedAt: now,
        currency: ctx.config.defaultCurrency,
      };
      ctx.repo.insertOpportunity(opportunity);
      app.createdOpportunity = true;
      const status: AIDecisionStatus = openForAccount.length > 1 ? "REVIEW_REQUIRED" : "AUTO_APPLIED";
      decide("OPPORTUNITY_RESOLUTION", "opportunity", opportunity.id,
        { match: x.opportunity.match, candidates: openForAccount.map(o => o.id) },
        { createdOpportunityId: opportunity.id }, x.opportunity.confidence, status,
        openForAccount.length > 1 ? "複数の進行中案件があり判断できないため新規案件を作成" : "新規案件を作成");
      if (openForAccount.length > 1) {
        review({
          type: "OPPORTUNITY_AMBIGUOUS",
          question: `「${account.displayName}」には進行中の案件が ${openForAccount.length} 件あります。この記録はどの案件のものですか？`,
          options: [
            ...openForAccount.map(o => ({ id: `opportunity:${o.id}`, label: o.title, value: { opportunityId: o.id } })),
            { id: "keep-new", label: `新規案件「${opportunity.title}」のままにする`, value: {} },
          ],
        }, "opportunity", opportunity.id);
      }
    }
  }
  if (!opportunity || !account) throw new Error("applyExtraction: opportunity resolution failed");

  // --- 2. Activity (fact record; append-only) --------------------------------------------------
  const occurredAt = isIsoDateTime(x.activity.occurred_at)
    ? new Date(x.activity.occurred_at).toISOString()
    : source.occurredAt ?? source.receivedAt;
  const activity: Activity = {
    id: newId(), opportunityId: opportunity.id, accountId: account.id,
    personIds: [...resolution.persons.map(p => p.id), ...app.createdPersonIds],
    actorUserIds: [submitter.id], type: x.activity.type, occurredAt, sourceId: source.id,
    summary: x.activity.summary,
    factsJson: x.facts, questionsJson: x.questions, objectionsJson: x.objections,
    commitmentsJson: x.commitments, decisionsJson: x.decisions,
    aiConfidence: x.activity.confidence, createdAt: now,
  };
  ctx.repo.insertActivity(activity);
  app.activityId = activity.id;
  app.opportunityId = opportunity.id;
  audit(ctx, { actorType: "AI", action: "ACTIVITY_CREATED", entityType: "activity",
    entityId: activity.id, after: { type: activity.type, summary: activity.summary },
    sourceIds: [source.id] });

  // --- 3. Commitments -------------------------------------------------------------------------------
  const commitmentIds: string[] = [];
  for (const c of x.commitments) {
    const dueAt = acceptDueAt(c.due_at, c.due_confidence, ctx.config);
    const commitment: Commitment = {
      id: newId(), opportunityId: opportunity.id, side: c.side,
      ownerUserId: c.side === "OUR_COMPANY" ? submitter.id : undefined,
      description: c.description, dueAt, status: "OPEN", sourceEvidenceId: activity.id,
      createdAt: now, updatedAt: now,
    };
    ctx.repo.insertCommitment(commitment);
    commitmentIds.push(commitment.id);
    if (c.due_at && !dueAt) {
      review({
        type: "DATE_AMBIGUOUS",
        question: `約束「${c.description}」の期限が曖昧です (AI の解釈: ${c.due_at}, confidence ${c.due_confidence.toFixed(2)})。期限を確定しますか？`,
        options: [
          { id: "accept", label: `AI の解釈 (${c.due_at}) を採用`, value: { dueAt: c.due_at } },
          { id: "set", label: "期限を入力する", value: { needsInput: "dueAt" } },
          { id: "none", label: "期限なしのまま", value: {} },
        ],
      }, "commitment", commitment.id);
    }
  }
  app.createdCommitmentIds = commitmentIds;
  if (x.commitments.length > 0) {
    decide("COMMITMENT", "opportunity", opportunity.id, x.commitments, { commitmentIds },
      Math.min(...x.commitments.map(c => c.confidence)), "AUTO_APPLIED",
      `${x.commitments.length} 件の約束を記録`, x.commitments.map(c => c.evidence));
  }

  // --- 4. State / amount / close date / risk ------------------------------------------------------
  const before = { ...opportunity };
  const state = deriveState(x, opportunityBefore, ctx.config);
  if (state.operationalState) opportunity.operationalState = state.operationalState;
  if (state.lifecycleState) opportunity.lifecycleState = state.lifecycleState;
  for (const trigger of state.reviews) review(trigger, "opportunity", opportunity.id);
  decide("STATE_CHANGE", "opportunity", opportunity.id, x.state,
    { operationalState: state.operationalState, lifecycleState: state.lifecycleState },
    state.confidence, state.reviews.length ? "REVIEW_REQUIRED" : "AUTO_APPLIED",
    state.reason ?? "状態を推定");

  const amount = deriveAmount(x, opportunityBefore, ctx.config);
  if (amount.expectedAmount !== undefined) {
    opportunity.expectedAmount = amount.expectedAmount;
    opportunity.currency = amount.currency ?? ctx.config.defaultCurrency;
  }
  for (const trigger of amount.reviews) review(trigger, "opportunity", opportunity.id);
  if (x.expected_close_date && opportunity.lifecycleState === "OPEN") {
    opportunity.expectedCloseDate = x.expected_close_date;
  }
  if (x.risk.confidence >= ctx.config.stateAutoConfidence) {
    opportunity.riskLevel = x.risk.level;
    opportunity.riskReason = x.risk.reason ?? undefined;
    decide("RISK", "opportunity", opportunity.id, x.risk, { riskLevel: x.risk.level },
      x.risk.confidence, "AUTO_APPLIED", x.risk.reason ?? "リスク評価");
  }

  // --- 5. Next actions ----------------------------------------------------------------------------
  const nextActionIds: string[] = [];
  const skipped: JsonValue[] = [];
  for (const a of x.next_actions) {
    if (a.confidence < ctx.config.nextActionAutoConfidence) {
      skipped.push(a);
      continue;
    }
    const dueAt = acceptDueAt(a.due_at, a.due_confidence, ctx.config);
    const action: NextAction = {
      id: newId(), opportunityId: opportunity.id, assignedUserId: submitter.id,
      actionType: a.action_type, title: a.title, purpose: a.purpose, dueAt,
      recommendedAt: meta.referenceTime, priority: derivePriority(a.priority, dueAt, meta.referenceTime),
      status: "OPEN", generatedBy: "AI", createdAt: now, updatedAt: now,
    };
    ctx.repo.insertNextAction(action);
    nextActionIds.push(action.id);
  }
  app.createdNextActionIds = nextActionIds;
  if (x.next_actions.length > 0) {
    const d = decide("NEXT_ACTION", "opportunity", opportunity.id, x.next_actions,
      { nextActionIds, skipped }, Math.max(...x.next_actions.map(a => a.confidence)),
      "AUTO_APPLIED", `${nextActionIds.length} 件の次アクションを作成 (${skipped.length} 件は confidence 不足で保留)`);
    for (const id of nextActionIds) {
      const a = ctx.repo.getNextAction(id)!;
      ctx.repo.updateNextAction({ ...a, sourceDecisionId: d.id });
    }
  }
  const openActions = ctx.repo.listNextActionsForOpportunity(opportunity.id, ["OPEN"]);
  opportunity.nextActionId = openActions[0]?.id;

  // --- 6. Snapshot (re-generable AI view; the activity above is the fact) --------------------------
  const openCommitments = ctx.repo.listCommitmentsForOpportunity(opportunity.id, true);
  const snapshot: AIContextSnapshot = {
    id: newId(), opportunityId: opportunity.id,
    currentSituation: x.context.current_situation,
    latestDevelopment: x.context.latest_development,
    customerIntent: x.context.customer_intent ?? undefined,
    decidedJson: x.decisions.map(d => d.fact),
    unresolvedJson: x.unresolved,
    risksJson: x.risk.level === "NONE" ? [] : [{ level: x.risk.level, reason: x.risk.reason ?? "" }],
    commitmentsJson: openCommitments.map(c => ({ side: c.side, description: c.description, dueAt: c.dueAt })),
    recommendedActionsJson: x.next_actions,
    evidenceIdsJson: [source.id, activity.id],
    modelProvider: meta.modelName.split("/")[0] ?? "unknown",
    modelName: meta.modelName,
    promptVersion: EXTRACTION_PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    confidenceJson: {
      activity: x.activity.confidence, state: x.state.confidence, risk: x.risk.confidence,
      opportunity: x.opportunity.confidence, entity: resolution.confidence,
    },
    createdAt: now,
  };
  ctx.repo.insertSnapshot(snapshot);
  app.snapshotId = snapshot.id;

  // --- 7. Persist opportunity with optimistic concurrency --------------------------------------------
  opportunity.lastMeaningfulActivityAt = maxIso(opportunity.lastMeaningfulActivityAt, occurredAt);
  opportunity.lastContextRecomputedAt = now;
  opportunity.updatedAt = now;
  if (app.createdOpportunity) {
    // Fresh row: version 1 was inserted above; write the enriched fields at version 2.
    if (!ctx.repo.updateOpportunity(opportunity, 1)) throw new Error("opportunity insert race");
  } else if (!ctx.repo.updateOpportunity(opportunity, opportunityBefore!.version)) {
    throw new Error(`opportunity ${opportunity.id} was modified concurrently; retry the source`);
  }
  app.opportunityBefore = opportunityBefore;
  audit(ctx, {
    actorType: "AI", action: app.createdOpportunity ? "OPPORTUNITY_CREATED" : "OPPORTUNITY_UPDATED",
    entityType: "opportunity", entityId: opportunity.id,
    before: app.createdOpportunity ? undefined : diffable(before),
    after: diffable(ctx.repo.getOpportunity(opportunity.id)!), sourceIds: [source.id],
  });

  // --- 8. Source bookkeeping ----------------------------------------------------------------------
  const status: SourceDocument["processingStatus"] = reviews.length ? "REVIEW_REQUIRED" : "PROCESSED";
  ctx.repo.updateSource({ ...source, processingStatus: status, processedAt: now, processingError: undefined });
  ctx.repo.insertApplication(app);
  audit(ctx, { actorType: "AI", action: "SOURCE_PROCESSED", entityType: "source_document",
    entityId: source.id, after: { status, opportunityId: opportunity.id, activityId: activity.id,
      reviews: reviews.length, model: meta.modelName, repairs: meta.repairs }, sourceIds: [source.id] });
  logEvent(ctx, "source.processed", { sourceId: source.id, status, reviews: reviews.length, repairs: meta.repairs });

  return {
    sourceId: source.id, status, opportunityId: opportunity.id, activityId: activity.id,
    reviewIds: reviews.map(r => r.id), nextActionIds, commitmentIds,
    model: meta.modelName, repairs: meta.repairs,
  };
}

function defaultTitle(account: CustomerAccount, x: Extraction): string {
  const base = account.displayName === UNRESOLVED_ACCOUNT_NAME ? "" : `${account.displayName} `;
  return `${base}${x.activity.summary.slice(0, 40)}`.trim();
}

function maxIso(a: string | undefined, b: string): string {
  if (!a) return b;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/** Opportunity fields worth diffing in the audit log (drops volatile bookkeeping columns). */
export function diffable(o: Opportunity): Partial<Opportunity> {
  const { updatedAt: _u, version: _v, lastContextRecomputedAt: _l, ...rest } = o;
  return rest;
}
