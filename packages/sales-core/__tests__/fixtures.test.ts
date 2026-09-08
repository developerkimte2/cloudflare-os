/**
 * Runs every evaluation fixture (設計書 §35, `fixtures/`) through `SalesService.capture()` with a
 * `FakeLlmProvider` scripted to the fixture's extraction, and checks its declarative expectations.
 * This is the "10 fixtures + FakeLlm regression tests" item from 計画書 §4.
 */
import { describe, expect, it } from "vitest";
import type { SalesService } from "../src/index.js";
import type { CustomerAccount, CustomerPerson } from "../src/domain/types.js";
import { extractionSchema } from "../src/ai/schema.js";
import { FakeLlmProvider } from "../src/ai/provider.js";
import { newId } from "../src/domain/util.js";
import { ALL_FIXTURES, type EvalFixture } from "../fixtures/index.js";
import { makeService } from "./helpers.js";

const SEED_TIME = "2026-01-01T00:00:00.000Z";

function applySeed(svc: SalesService, fixture: EvalFixture): void {
  if (!fixture.seed) return;
  const account: CustomerAccount = {
    id: newId(), displayName: fixture.seed.account.displayName,
    primaryDomain: fixture.seed.account.primaryDomain,
    resolutionStatus: "MANUAL", createdAt: SEED_TIME, updatedAt: SEED_TIME,
  };
  svc.ctx.repo.insertAccount(account);
  for (const p of fixture.seed.persons ?? []) {
    const person: CustomerPerson = {
      id: newId(), accountId: account.id, displayName: p.displayName, email: p.email,
      resolutionStatus: "MANUAL", createdAt: SEED_TIME, updatedAt: SEED_TIME,
    };
    svc.ctx.repo.insertPerson(person);
  }
}

describe("fixture catalog (設計書 §35)", () => {
  it("has the 10 named fixtures, each schema-valid", () => {
    expect(ALL_FIXTURES).toHaveLength(10);
    expect(new Set(ALL_FIXTURES.map(f => f.id)).size).toBe(10);
    for (const f of ALL_FIXTURES) {
      expect(f.id).toMatch(/^fixture_\d{3}_[a-z_]+$/);
      // A typo in a fixture's scripted extraction should fail loudly here, not as a confusing
      // pipeline assertion failure inside the per-fixture test below.
      expect(() => extractionSchema.parse(f.extraction)).not.toThrow();
    }
  });
});

describe.each(ALL_FIXTURES)("$id", (fixture: EvalFixture) => {
  it(fixture.description, async () => {
    const llm = new FakeLlmProvider([fixture.extraction]);
    const svc = makeService(llm);
    const user = svc.registerIdentity("test", "u1", { email: "sales@example.com", displayName: "テスト太郎" });
    applySeed(svc, fixture);

    const result = await svc.capture(
      { userId: user.id },
      fixture.rawText,
      { sourceType: fixture.sourceType, occurredAt: fixture.occurredAt },
    );

    // Evidence integrity (AC-004): the raw input is stored verbatim, whatever it contains.
    expect(result.source.rawText).toBe(fixture.rawText);
    expect(result.source.sourceType).toBe(fixture.sourceType);

    const e = fixture.expect;
    if (e.processingStatus) expect(result.source.processingStatus).toBe(e.processingStatus);
    if (e.reviewTypesInclude) {
      const types = result.reviews.map(r => r.type);
      for (const type of e.reviewTypesInclude) expect(types).toContain(type);
    }
    if (e.reviewCount !== undefined) expect(result.reviews).toHaveLength(e.reviewCount);
    if (e.notSalesRelated !== undefined) expect(!!result.notSalesRelated).toBe(e.notSalesRelated);
    if (e.notSalesRelated) return; // no opportunity/activity to check further

    if (e.accountResolved !== undefined) {
      expect(result.opportunity?.accountResolutionStatus !== "UNRESOLVED").toBe(e.accountResolved);
    }
    if (e.accountDisplayName !== undefined) {
      expect(result.opportunity?.accountName).toBe(e.accountDisplayName);
    }
    if (e.lifecycleState) expect(result.opportunity?.lifecycleState).toBe(e.lifecycleState);
    if (e.operationalState) expect(result.opportunity?.operationalState).toBe(e.operationalState);
    if (e.activityType) expect(result.activity?.type).toBe(e.activityType);
    if (e.expectedAmount !== undefined) {
      expect(result.opportunity?.expectedAmount ?? null).toBe(e.expectedAmount);
    }
    if (e.nextActionCount !== undefined) expect(result.nextActions).toHaveLength(e.nextActionCount);
    if (e.commitmentCount !== undefined) expect(result.commitments).toHaveLength(e.commitmentCount);
  });
});
