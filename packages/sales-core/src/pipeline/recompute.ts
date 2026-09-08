/**
 * Context recompute (WF-03, 設計書 §54): rebuild the AI view of an opportunity from its facts.
 * Because activities are the record and the snapshot is derived, this can be re-run after a prompt
 * change to refresh every opportunity.
 */
import { completeJson } from "../ai/json.js";
import { contextSnapshotSchema, SCHEMA_VERSION } from "../ai/schema.js";
import { buildContextRequest, CONTEXT_PROMPT_VERSION } from "../ai/skills.js";
import type { AIContextSnapshot } from "../domain/types.js";
import { newId, nowIso } from "../domain/util.js";
import { audit } from "./audit.js";
import type { CoreContext } from "./context.js";
import { diffable } from "./ingest.js";

export async function recomputeContext(
  ctx: CoreContext, opportunityId: string, actorUserId?: string,
): Promise<AIContextSnapshot> {
  const opportunity = ctx.repo.getOpportunity(opportunityId);
  if (!opportunity) throw new Error(`recomputeContext: unknown opportunity ${opportunityId}`);
  const account = ctx.repo.getAccount(opportunity.accountId);
  const owner = ctx.repo.getUser(opportunity.ownerUserId);
  const activities = ctx.repo.listActivitiesForOpportunity(opportunityId, 30);
  const previous = ctx.repo.latestSnapshot(opportunityId);
  const referenceTime = nowIso(ctx.clock);

  const request = buildContextRequest({
    referenceTime,
    timezone: owner?.timezone ?? ctx.config.defaultTimezone,
    opportunity,
    accountName: account?.displayName ?? "?",
    activities: activities.map(a => ({
      id: a.id, occurredAt: a.occurredAt, type: a.type, summary: a.summary, facts: a.factsJson,
    })),
    openCommitments: ctx.repo.listCommitmentsForOpportunity(opportunityId, true)
      .map(c => ({ side: c.side, description: c.description, dueAt: c.dueAt, status: c.status })),
    openNextActions: ctx.repo.listNextActionsForOpportunity(opportunityId, ["OPEN", "SNOOZED"])
      .map(a => ({ title: a.title, purpose: a.purpose, dueAt: a.dueAt, status: a.status })),
    previousSnapshot: previous
      ? { currentSituation: previous.currentSituation, unresolved: previous.unresolvedJson,
          createdAt: previous.createdAt }
      : undefined,
  });
  const { value, response } = await completeJson(ctx.llm, request, contextSnapshotSchema, { maxRepairs: 1 });

  return ctx.repo.transaction(() => {
    const now = nowIso(ctx.clock);
    const current = ctx.repo.getOpportunity(opportunityId)!;
    const snapshot: AIContextSnapshot = {
      id: newId(), opportunityId,
      currentSituation: value.current_situation,
      latestDevelopment: value.latest_development,
      customerIntent: value.customer_intent ?? undefined,
      decidedJson: value.decided, unresolvedJson: value.unresolved, risksJson: value.risks,
      commitmentsJson: ctx.repo.listCommitmentsForOpportunity(opportunityId, true)
        .map(c => ({ side: c.side, description: c.description, dueAt: c.dueAt })),
      recommendedActionsJson: value.recommended_actions,
      evidenceIdsJson: activities.map(a => a.id),
      modelProvider: response.provider, modelName: `${response.provider}/${response.model}`,
      promptVersion: CONTEXT_PROMPT_VERSION, schemaVersion: SCHEMA_VERSION,
      confidenceJson: { state: value.state_confidence, overall: value.confidence },
      createdAt: now,
    };
    ctx.repo.insertSnapshot(snapshot);

    const before = { ...current };
    if (current.lifecycleState === "OPEN" && value.operational_state !== "UNKNOWN" &&
        value.state_confidence >= ctx.config.stateAutoConfidence) {
      current.operationalState = value.operational_state;
    }
    const worst = value.risks.map(r => r.level)
      .sort((a, b) => riskRank(b) - riskRank(a))[0];
    if (worst && value.confidence >= ctx.config.stateAutoConfidence) {
      current.riskLevel = worst;
      current.riskReason = value.risks.find(r => r.level === worst)?.reason;
    }
    current.lastContextRecomputedAt = now;
    current.updatedAt = now;
    if (!ctx.repo.updateOpportunity(current, before.version)) {
      throw new Error("recomputeContext: opportunity changed concurrently");
    }
    ctx.repo.insertDecision({
      id: newId(), entityType: "opportunity", entityId: opportunityId, decisionType: "STATE_CHANGE",
      inputSourceIds: activities.map(a => a.sourceId),
      proposedJson: { operational_state: value.operational_state, risks: value.risks },
      appliedJson: { operationalState: current.operationalState, riskLevel: current.riskLevel },
      confidence: value.state_confidence, status: "AUTO_APPLIED",
      reasoningSummary: "コンテキスト再計算", evidenceJson: activities.map(a => a.id),
      modelName: snapshot.modelName, promptVersion: CONTEXT_PROMPT_VERSION, createdAt: now,
    });
    audit(ctx, { actorType: actorUserId ? "USER" : "AI", actorId: actorUserId,
      action: "CONTEXT_RECOMPUTED", entityType: "opportunity", entityId: opportunityId,
      before: diffable(before), after: diffable(current), sourceIds: activities.map(a => a.sourceId) });
    return snapshot;
  });
}

function riskRank(level: string): number {
  return ["NONE", "LOW", "MEDIUM", "HIGH"].indexOf(level);
}
