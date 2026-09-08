/** Audit helpers (設計書 §11.13, SEC-07). Every mutation the pipeline makes goes through here. */
import type { ActorType, AuditLog, JsonValue } from "../domain/types.js";
import { newId, nowIso } from "../domain/util.js";
import type { CoreContext } from "./context.js";

export interface AuditInput {
  actorType: ActorType;
  actorId?: string;
  action: string;
  entityType: string;
  entityId: string;
  /** Any JSON-serializable snapshot (interfaces welcome; stored as JSON text). */
  before?: object | JsonValue;
  after?: object | JsonValue;
  sourceIds?: string[];
  aiDecisionId?: string;
}

export function audit(ctx: CoreContext, input: AuditInput): AuditLog {
  const entry: AuditLog = {
    id: newId(),
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    beforeJson: input.before as JsonValue,
    afterJson: input.after as JsonValue,
    sourceIds: input.sourceIds,
    aiDecisionId: input.aiDecisionId,
    createdAt: nowIso(ctx.clock),
  };
  ctx.repo.insertAudit(entry);
  return entry;
}
