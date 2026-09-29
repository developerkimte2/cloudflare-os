import { describe, expect, it } from "vitest";
import { FakeLlmProvider } from "../src/ai/provider.js";
import { AuthorizationError } from "../src/service/sales-service.js";
import { newId } from "../src/domain/util.js";
import type { BulkImportPayload } from "../src/api/dto.js";
import { makeAccount, makeService, makeUser } from "./helpers.js";

const NOW = "2026-09-08T01:00:00Z";

/** A minimal but referentially-consistent payload: one account, one person, one deal chain. */
function payload(overrides: Partial<BulkImportPayload> = {}, accountId = newId()): BulkImportPayload {
  const personId = newId();
  const sourceId = newId();
  const opportunityId = newId();
  return {
    accounts: [{
      id: accountId, displayName: "移行元株式会社", resolutionStatus: "RESOLVED",
      createdAt: NOW, updatedAt: NOW,
    }],
    persons: [{
      id: personId, accountId, displayName: "移行 太郎", resolutionStatus: "MANUAL",
      createdAt: NOW, updatedAt: NOW,
    }],
    sourceDocuments: [{
      id: sourceId, sourceType: "TEXT", contentHash: "hash1", receivedAt: NOW,
      processingStatus: "PROCESSED", submittedByUserId: "someone-elses-user-id",
    }],
    opportunities: [{
      id: opportunityId, accountId, title: "移行案件", ownerUserId: "someone-elses-user-id",
      collaboratorUserIds: ["someone-elses-user-id"], lifecycleState: "OPEN", operationalState: "ACTIVE",
      contactPersonIds: [personId], riskLevel: "NONE", version: 1, createdAt: NOW, updatedAt: NOW,
    }],
    activities: [{
      id: newId(), opportunityId, accountId, personIds: [personId],
      actorUserIds: ["someone-elses-user-id"], type: "NOTE", occurredAt: NOW, sourceId,
      summary: "移行された活動", factsJson: [], questionsJson: [], objectionsJson: [],
      commitmentsJson: [], decisionsJson: [], createdAt: NOW,
    }],
    nextActions: [{
      id: newId(), opportunityId, assignedUserId: "someone-elses-user-id", actionType: "FOLLOW_UP",
      title: "フォローアップ", purpose: "確認", priority: "NORMAL", status: "OPEN",
      generatedBy: "USER", createdAt: NOW, updatedAt: NOW,
    }],
    commitments: [{
      id: newId(), opportunityId, side: "OUR_COMPANY", ownerUserId: "someone-elses-user-id",
      description: "見積送付", status: "OPEN", sourceEvidenceId: sourceId, createdAt: NOW, updatedAt: NOW,
    }],
    ...overrides,
  };
}

describe("adminBulkImport (migration from another tenant)", () => {
  it("inserts every table and remaps owner/assigned/actor references to the calling admin", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const admin = makeUser(svc.repo, "ADMIN");
    const p = payload();

    const result = svc.adminBulkImport({ userId: admin.id }, p);

    expect(result).toMatchObject({
      accountsInserted: 1, personsInserted: 1, sourceDocumentsInserted: 1, opportunitiesInserted: 1,
      activitiesInserted: 1, nextActionsInserted: 1, commitmentsInserted: 1, errors: [],
    });
    expect(svc.repo.getAccount(p.accounts[0]!.id)).toBeDefined();
    expect(svc.repo.getOpportunity(p.opportunities[0]!.id)).toMatchObject({
      ownerUserId: admin.id, collaboratorUserIds: [],
    });
    const [activity] = svc.repo.listActivitiesForOpportunity(p.opportunities[0]!.id);
    expect(activity).toMatchObject({ actorUserIds: [admin.id] });
    const [nextAction] = svc.repo.listNextActionsForOpportunity(p.opportunities[0]!.id);
    expect(nextAction).toMatchObject({ assignedUserId: admin.id });
    const [commitment] = svc.repo.listCommitmentsForOpportunity(p.opportunities[0]!.id);
    expect(commitment).toMatchObject({ ownerUserId: admin.id });
    expect(svc.repo.getSource(p.sourceDocuments[0]!.id)).toMatchObject({ submittedByUserId: admin.id });
  });

  it("collects a row-level id collision as an error instead of aborting the whole import", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const admin = makeUser(svc.repo, "ADMIN");
    const existing = makeAccount(svc.repo, { displayName: "既存の会社" });
    // Colliding account id, but every cross-reference (person/opportunity/activity) still points at
    // it correctly -- this is purely a duplicate-id conflict, not a dangling foreign key.
    const p = payload({}, existing.id);

    const result = svc.adminBulkImport({ userId: admin.id }, p);

    expect(result.accountsInserted).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ entityType: "customer_account", id: existing.id });
    // The rest of the batch still lands even though its account row failed.
    expect(result.personsInserted).toBe(1);
  });

  it("rejects a non-ADMIN caller", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const manager = makeUser(svc.repo, "MANAGER");
    expect(() => svc.adminBulkImport({ userId: manager.id }, payload())).toThrow(AuthorizationError);
  });
});
