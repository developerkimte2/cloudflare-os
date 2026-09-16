import { describe, expect, it } from "vitest";
import { FakeLlmProvider } from "../src/ai/provider.js";
import { NotFoundError } from "../src/service/sales-service.js";
import { newId } from "../src/domain/util.js";
import { makeAccount, makeOpportunity, makeService, makeUser } from "./helpers.js";
import type { Activity, SourceDocument } from "../src/domain/types.js";

const NOW = "2026-09-08T01:00:00Z";

describe("mergeOpportunities (manual fix for AI mis-matches / spelling variants)", () => {
  function seedActivity(svc: ReturnType<typeof makeService>, opportunityId: string, occurredAt = NOW): Activity {
    const source: SourceDocument = {
      id: newId(), sourceType: "TEXT", contentHash: newId(), receivedAt: NOW, processingStatus: "PROCESSED",
    };
    svc.repo.insertSource(source);
    const activity: Activity = {
      id: newId(), opportunityId, personIds: [], actorUserIds: [], type: "NOTE",
      occurredAt, sourceId: source.id, summary: "テスト活動", factsJson: [], questionsJson: [],
      objectionsJson: [], commitmentsJson: [], decisionsJson: [], createdAt: NOW,
    };
    svc.repo.insertActivity(activity);
    return activity;
  }

  it("moves the source's activities into the target and closes+relabels the source (kept, not deleted)", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const user = makeUser(svc.repo, "SALES");
    const actor = { userId: user.id };
    // Two accounts standing in for a spelling variant ("山田商事" vs "株式会社山田商事"): the rep
    // wants to fold the wrongly-separated deal into the correct one.
    const wrongAccount = makeAccount(svc.repo, { displayName: "山田商事" });
    const rightAccount = makeAccount(svc.repo, { displayName: "株式会社山田商事" });
    const source = makeOpportunity(svc.repo, wrongAccount.id, user.id, { title: "山田商事 新規商談" });
    const target = makeOpportunity(svc.repo, rightAccount.id, user.id, {
      title: "株式会社山田商事 導入検討", expectedAmount: 100_000,
    });
    seedActivity(svc, source.id);

    const result = svc.mergeOpportunities(actor, source.id, target.id);
    expect(result.id).toBe(target.id);
    expect(result.expectedAmount).toBe(100_000); // target's own amount wins over source's undefined

    expect(svc.repo.listActivitiesForOpportunity(target.id)).toHaveLength(1);
    expect(svc.repo.listActivitiesForOpportunity(source.id)).toHaveLength(0);

    const closedSource = svc.getOpportunity(actor, source.id);
    expect(closedSource.lifecycleState).toBe("CLOSED");
    expect(closedSource.title).toBe(`山田商事 新規商談 (統合済み → ${target.title})`);

    const audit = svc.getOpportunity(actor, target.id).audit;
    expect(audit.some(a => a.action === "OPPORTUNITY_MERGED")).toBe(true);
  });

  it("target's own amount is kept; source's amount only fills in when target has none", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const user = makeUser(svc.repo, "SALES");
    const actor = { userId: user.id };
    const account = makeAccount(svc.repo);
    const source = makeOpportunity(svc.repo, account.id, user.id, { expectedAmount: 50_000 });
    const target = makeOpportunity(svc.repo, account.id, user.id, {}); // no amount yet

    const result = svc.mergeOpportunities(actor, source.id, target.id);
    expect(result.expectedAmount).toBe(50_000);
  });

  it("rejects merging a deal into itself, and a target the caller cannot see", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const owner = makeUser(svc.repo, "SALES");
    const other = makeUser(svc.repo, "SALES");
    const account = makeAccount(svc.repo);
    const mine = makeOpportunity(svc.repo, account.id, owner.id);
    const theirs = makeOpportunity(svc.repo, account.id, other.id);

    expect(() => svc.mergeOpportunities({ userId: owner.id }, mine.id, mine.id)).toThrow(/同じ案件/);
    expect(() => svc.mergeOpportunities({ userId: owner.id }, mine.id, theirs.id)).toThrow(NotFoundError);
  });
});
