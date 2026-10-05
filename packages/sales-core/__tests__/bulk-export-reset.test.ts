import { describe, expect, it } from "vitest";
import { FakeLlmProvider } from "../src/ai/provider.js";
import { AuthorizationError, type SalesService } from "../src/service/sales-service.js";
import { BUSINESS_DATA_TABLES } from "../src/db/repository.js";
import { newId } from "../src/domain/util.js";
import type { BulkImportPayload } from "../src/api/dto.js";
import type { User } from "../src/domain/types.js";
import { extractionJson, makeAccount, makeOpportunity, makeService, makeUser } from "./helpers.js";

const NOW = "2026-09-08T01:00:00Z";

function count(svc: SalesService, table: string): number {
  return Number(svc.repo.db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n);
}

/**
 * Seeds at least one row of every business-data table: the seven export collections directly, one
 * captured memo (source application, AI decisions, snapshot), and the rest by hand.
 */
async function seedTenant(svc: SalesService, llm: FakeLlmProvider, admin: User): Promise<void> {
  const sales = makeUser(svc.repo, "SALES");
  const account = makeAccount(svc.repo, { displayName: "シード株式会社", createdAt: NOW, updatedAt: NOW });
  const personId = newId();
  svc.repo.insertPerson({
    id: personId, accountId: account.id, displayName: "シード 花子", email: "hanako@seed.example",
    resolutionStatus: "MANUAL", createdAt: NOW, updatedAt: NOW,
  });
  const sourceId = newId();
  svc.repo.insertSource({
    id: sourceId, sourceType: "TEXT", contentHash: "seed-hash", receivedAt: NOW, rawText: "シードのメモ",
    processingStatus: "PROCESSED", submittedByUserId: sales.id,
  });
  const opp = makeOpportunity(svc.repo, account.id, sales.id, {
    title: "シード案件", collaboratorUserIds: [admin.id], contactPersonIds: [personId],
    expectedAmount: 1_200_000, currency: "JPY", createdAt: NOW, updatedAt: NOW,
  });
  svc.repo.insertActivity({
    id: newId(), opportunityId: opp.id, accountId: account.id, personIds: [personId],
    actorUserIds: [sales.id], type: "NOTE", occurredAt: NOW, sourceId, summary: "シードの活動",
    factsJson: [], questionsJson: [], objectionsJson: [], commitmentsJson: [], decisionsJson: [],
    createdAt: NOW,
  });
  svc.repo.insertNextAction({
    id: newId(), opportunityId: opp.id, assignedUserId: sales.id, actionType: "FOLLOW_UP",
    title: "見積の確認", purpose: "回答を得る", priority: "HIGH", status: "OPEN", generatedBy: "USER",
    createdAt: NOW, updatedAt: NOW,
  });
  svc.repo.insertCommitment({
    id: newId(), opportunityId: opp.id, side: "OUR_COMPANY", ownerUserId: sales.id,
    description: "見積送付", status: "OPEN", sourceEvidenceId: sourceId, createdAt: NOW, updatedAt: NOW,
  });

  // A real capture leaves the AI artefacts and the undo record behind.
  llm.push(extractionJson({ accounts: [{ name: "キャプチャ株式会社", confidence: 0.9 }] }));
  await svc.capture({ userId: sales.id }, "キャプチャ株式会社を訪問した");

  svc.repo.insertProduct({
    id: newId(), name: "保守サービス", category: "MAINTENANCE", taxCategory: "STANDARD", active: true,
    sortOrder: 0, createdAt: NOW, updatedAt: NOW,
  });
  svc.repo.replaceLineItems(opp.id, [{
    id: newId(), opportunityId: opp.id, name: "保守", quantity: 1, unitPrice: 100_000,
    discountAmount: 0, taxCategory: "STANDARD", sortOrder: 0, createdAt: NOW, updatedAt: NOW,
  }]);
  svc.repo.insertReview({
    id: newId(), type: "DATE_AMBIGUOUS", assignedUserId: sales.id, relatedEntityType: "opportunity",
    relatedEntityId: opp.id, question: "日付は？", sourceEvidenceIds: [sourceId], status: "OPEN",
    createdAt: NOW,
  });
  svc.repo.insertNotificationLog({
    id: newId(), userId: sales.id, channel: "SLACK", notificationType: "MORNING_BRIEF",
    messageHash: "h", sentAt: NOW, status: "SENT",
  });
  svc.repo.upsertCalendarEvent({
    id: newId(), googleCalendarId: "cal", googleEventId: "ev", ownerUserId: sales.id, title: "訪問",
    attendeesJson: [], startAt: NOW, endAt: NOW, status: "confirmed", lastSyncedAt: NOW,
  });
  svc.repo.putSetting("defaultTimezone", "Asia/Tokyo", NOW);
}

function byId<T extends { id: string }>(rows: T[]): T[] {
  return rows.toSorted((a, b) => a.id.localeCompare(b.id));
}

/** Drops the fields `adminBulkImport` remaps to the importing admin, and sorts each collection. */
function withoutUserRefs(p: BulkImportPayload): unknown {
  return {
    accounts: byId(p.accounts),
    persons: byId(p.persons),
    sourceDocuments: byId(p.sourceDocuments).map(({ submittedByUserId: _, ...rest }) => rest),
    opportunities: byId(p.opportunities)
      .map(({ ownerUserId: _o, collaboratorUserIds: _c, ...rest }) => rest),
    activities: byId(p.activities).map(({ actorUserIds: _, ...rest }) => rest),
    nextActions: byId(p.nextActions).map(({ assignedUserId: _, ...rest }) => rest),
    commitments: byId(p.commitments).map(({ ownerUserId: _, ...rest }) => rest),
  };
}

describe("adminBulkExport / adminResetTenant", () => {
  it("rejects a non-ADMIN caller for both", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const manager = makeUser(svc.repo, "MANAGER");
    expect(() => svc.adminBulkExport({ userId: manager.id })).toThrow(AuthorizationError);
    expect(() => svc.adminResetTenant({ userId: manager.id }, "RESET")).toThrow(AuthorizationError);
  });

  it("exports every collection unfiltered and round-trips through adminBulkImport", async () => {
    const llm = new FakeLlmProvider([]);
    const svc = makeService(llm, NOW);
    const admin = makeUser(svc.repo, "ADMIN");
    await seedTenant(svc, llm, admin);

    const exported = svc.adminBulkExport({ userId: admin.id });
    for (const rows of Object.values(exported)) expect(rows.length).toBeGreaterThan(0);
    expect(exported.opportunities).toHaveLength(count(svc, "opportunities"));
    expect(exported.nextActions).toHaveLength(count(svc, "next_actions"));
    expect(exported.commitments).toHaveLength(count(svc, "commitments"));
    expect(svc.repo.listAudit(1)[0]).toMatchObject({
      action: "BULK_EXPORTED",
      afterJson: { opportunities: exported.opportunities.length, commitments: exported.commitments.length },
    });

    const fresh = makeService(new FakeLlmProvider([]), NOW);
    const freshAdmin = makeUser(fresh.repo, "ADMIN");
    // JSON round-trip, as the payload travels through the Settings page's textarea.
    const result = fresh.adminBulkImport({ userId: freshAdmin.id }, JSON.parse(JSON.stringify(exported)));
    expect(result.errors).toEqual([]);

    const reExported = fresh.adminBulkExport({ userId: freshAdmin.id });
    expect(withoutUserRefs(reExported)).toEqual(withoutUserRefs(exported));
  });

  it("refuses a wrong confirmation without removing anything", async () => {
    const llm = new FakeLlmProvider([]);
    const svc = makeService(llm, NOW);
    const admin = makeUser(svc.repo, "ADMIN");
    await seedTenant(svc, llm, admin);
    const before = BUSINESS_DATA_TABLES.map(t => count(svc, t));

    expect(() => svc.adminResetTenant({ userId: admin.id }, "reset")).toThrow(/RESET/);
    expect(BUSINESS_DATA_TABLES.map(t => count(svc, t))).toEqual(before);
  });

  it("clears every business table and keeps users, settings, products and the audit log", async () => {
    const llm = new FakeLlmProvider([]);
    const svc = makeService(llm, NOW);
    const admin = makeUser(svc.repo, "ADMIN");
    await seedTenant(svc, llm, admin);
    const users = count(svc, "users");
    const identities = count(svc, "external_identities");
    const audits = count(svc, "audit_logs");

    const result = svc.adminResetTenant({ userId: admin.id }, "RESET");

    expect(result.removed.map(r => r.table)).toEqual([...BUSINESS_DATA_TABLES]);
    for (const { table, count: removed } of result.removed) {
      expect(removed, table).toBeGreaterThan(0);
      expect(count(svc, table), table).toBe(0);
    }
    expect(svc.repo.listAllAccounts()).toEqual([]);
    expect(svc.repo.listOpenNextActions()).toEqual([]);

    expect(count(svc, "users")).toBe(users);
    expect(count(svc, "external_identities")).toBe(identities);
    expect(svc.repo.getSetting("defaultTimezone")).toBe("Asia/Tokyo");
    expect(svc.repo.listProducts(true)).toHaveLength(1);
    expect(count(svc, "audit_logs")).toBe(audits + 1);
    const [entry] = svc.repo.listAudit(1);
    expect(entry).toMatchObject({ action: "TENANT_RESET", actorId: admin.id });
    expect((entry!.afterJson as Record<string, number>).opportunities).toBe(
      result.removed.find(r => r.table === "opportunities")!.count);
  });

  it("refuses while a memo is still waiting to be processed", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const admin = makeUser(svc.repo, "ADMIN");
    const account = makeAccount(svc.repo);
    svc.repo.insertSource({
      id: newId(), sourceType: "TEXT", contentHash: "pending", receivedAt: NOW, rawText: "未処理",
      processingStatus: "RECEIVED", submittedByUserId: admin.id,
    });

    expect(() => svc.adminResetTenant({ userId: admin.id }, "RESET")).toThrow(/処理待ち/);
    expect(svc.repo.getAccount(account.id)).toBeDefined();
    expect(svc.repo.listAudit(5).some(a => a.action === "TENANT_RESET")).toBe(false);
  });
});
