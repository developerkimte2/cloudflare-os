/**
 * Revert everything one processed source produced (AC-008). Activities are append-only by design
 * (設計書 §54), so an undo is the one sanctioned way to remove one — and it is itself audited.
 */
import type { Opportunity } from "../domain/types.js";
import { nowIso } from "../domain/util.js";
import { audit } from "./audit.js";
import type { CoreContext } from "./context.js";
import { diffable } from "./ingest.js";

export function revertSource(ctx: CoreContext, sourceId: string, actorUserId?: string): void {
  ctx.repo.transaction(() => {
    const source = ctx.repo.getSource(sourceId);
    if (!source) throw new Error(`revertSource: unknown source ${sourceId}`);
    const app = ctx.repo.getApplication(sourceId);
    if (!app) throw new Error(`revertSource: source ${sourceId} has not been applied`);
    if (app.revertedAt) throw new Error(`revertSource: source ${sourceId} was already reverted`);
    const now = nowIso(ctx.clock);

    for (const id of app.createdNextActionIds) ctx.repo.deleteNextAction(id);
    for (const id of app.createdCommitmentIds) ctx.repo.deleteCommitment(id);
    for (const id of app.createdReviewIds) {
      const r = ctx.repo.getReview(id);
      if (r && r.status === "OPEN") ctx.repo.updateReview({ ...r, status: "DISMISSED", resolvedAt: now,
        resolutionJson: { reverted: true } });
    }
    if (app.snapshotId) ctx.repo.deleteSnapshot(app.snapshotId);
    if (app.activityId) ctx.repo.deleteActivity(app.activityId);

    if (app.opportunityId) {
      const current = ctx.repo.getOpportunity(app.opportunityId);
      if (current && app.createdOpportunity) {
        // Only safe when nothing else has attached to it since.
        const stillEmpty = ctx.repo.listActivitiesForOpportunity(current.id, 1).length === 0;
        if (stillEmpty) {
          ctx.repo.deleteOpportunity(current.id);
          audit(ctx, { actorType: actorUserId ? "USER" : "SYSTEM", actorId: actorUserId,
            action: "OPPORTUNITY_DELETED", entityType: "opportunity", entityId: current.id,
            before: diffable(current), sourceIds: [sourceId] });
        }
      } else if (current && app.opportunityBefore) {
        const restored: Opportunity = {
          ...app.opportunityBefore,
          // Keep the next-action pointer coherent with what still exists.
          nextActionId: ctx.repo.listNextActionsForOpportunity(current.id, ["OPEN"])[0]?.id,
          updatedAt: now,
        };
        if (!ctx.repo.updateOpportunity(restored, current.version)) {
          throw new Error("revertSource: opportunity changed concurrently");
        }
        audit(ctx, { actorType: actorUserId ? "USER" : "SYSTEM", actorId: actorUserId,
          action: "OPPORTUNITY_RESTORED", entityType: "opportunity", entityId: current.id,
          before: diffable(current), after: diffable(restored), sourceIds: [sourceId] });
      }
    }

    for (const id of app.createdPersonIds) ctx.repo.deletePerson(id);
    if (app.createdAccountId) {
      const account = ctx.repo.getAccount(app.createdAccountId);
      const inUse = account && (
        ctx.repo.listOpenOpportunitiesForAccount(account.id).length > 0 ||
        ctx.repo.listPersonsForAccount(account.id).length > 0);
      if (account && !inUse) ctx.repo.deleteAccount(account.id);
    }

    for (const id of app.decisionIds) {
      const d = ctx.repo.getDecision(id);
      if (d) ctx.repo.updateDecision({ ...d, status: "REVERTED" });
    }

    ctx.repo.updateApplication({ ...app, revertedAt: now });
    ctx.repo.updateSource({ ...source, processingStatus: "REVERTED", processedAt: now });
    audit(ctx, { actorType: actorUserId ? "USER" : "SYSTEM", actorId: actorUserId,
      action: "SOURCE_REVERTED", entityType: "source_document", entityId: sourceId,
      sourceIds: [sourceId] });
  });
}
