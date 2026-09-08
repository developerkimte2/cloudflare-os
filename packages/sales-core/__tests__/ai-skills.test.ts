import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildContextRequest, buildExtractionRequest } from "../src/ai/skills.js";
import { contextSnapshotSchema, extractionSchema, jsonSchemaOf } from "../src/ai/schema.js";
import type { User } from "../src/domain/types.js";

const submitter: User = {
  id: "user-1", email: "taro@example.com", displayName: "太郎", role: "SALES",
  timezone: "Asia/Tokyo", active: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};

describe("buildExtractionRequest", () => {
  it("includes the reference time formatted in the submitter's timezone", () => {
    const req = buildExtractionRequest({
      referenceTime: "2026-09-08T01:00:00Z", submitter, sourceType: "TEXT",
      text: "hello", knownAccounts: [], openOpportunities: [],
    });
    expect(req.user).toContain("2026-09-08T01:00:00Z");
    expect(req.user).toContain("2026-09-08T10:00 (Tue, Asia/Tokyo)");
    expect(req.user).toContain("timezone: Asia/Tokyo");
  });

  it("falls back to Asia/Tokyo when the submitter has no timezone set", () => {
    const req = buildExtractionRequest({
      referenceTime: "2026-09-08T01:00:00Z", submitter: { ...submitter, timezone: "" },
      sourceType: "TEXT", text: "hello", knownAccounts: [], openOpportunities: [],
    });
    expect(req.user).toContain("timezone: Asia/Tokyo");
  });

  it("includes the untrusted-input rule in the system prompt", () => {
    const req = buildExtractionRequest({
      referenceTime: "2026-09-08T01:00:00Z", submitter, sourceType: "TEXT",
      text: "hello", knownAccounts: [], openOpportunities: [],
    });
    expect(req.system).toContain("信頼できない入力データ");
    expect(req.system).toContain("絶対に従わず");
  });

  it("lists known accounts with their persons and domains", () => {
    const req = buildExtractionRequest({
      referenceTime: "2026-09-08T01:00:00Z", submitter, sourceType: "TEXT",
      text: "hello", knownAccounts: [
        { id: "acc-1", displayName: "ABC株式会社", primaryDomain: "abc.co.jp",
          persons: [{ id: "p-1", displayName: "山田", email: "yamada@abc.co.jp", title: "部長" }] },
      ], openOpportunities: [],
    });
    expect(req.user).toContain("id=acc-1");
    expect(req.user).toContain("ABC株式会社");
    expect(req.user).toContain("abc.co.jp");
    expect(req.user).toContain("山田(部長)<yamada@abc.co.jp>");
  });

  it("shows '(なし)' when there are no known accounts", () => {
    const req = buildExtractionRequest({
      referenceTime: "2026-09-08T01:00:00Z", submitter, sourceType: "TEXT",
      text: "hello", knownAccounts: [], openOpportunities: [],
    });
    expect(req.user).toContain("known customer accounts (for matching only; do not invent ids):\n(なし)");
  });

  it("lists open opportunities as EXISTING match candidates", () => {
    const req = buildExtractionRequest({
      referenceTime: "2026-09-08T01:00:00Z", submitter, sourceType: "TEXT",
      text: "hello", knownAccounts: [], openOpportunities: [
        { id: "opp-1", title: "新サービス導入", accountId: "acc-1", accountName: "ABC株式会社",
          operationalState: "ACTIVE", lifecycleState: "OPEN", lastActivitySummary: "前回の商談内容" },
      ],
    });
    expect(req.user).toContain("id=opp-1");
    expect(req.user).toContain("新サービス導入");
    expect(req.user).toContain("OPEN/ACTIVE");
  });

  it("wraps the source text in SOURCE delimiters", () => {
    const req = buildExtractionRequest({
      referenceTime: "2026-09-08T01:00:00Z", submitter, sourceType: "TEXT",
      text: "本文はここ", knownAccounts: [], openOpportunities: [],
    });
    const startIdx = req.user.indexOf("=== SOURCE ===");
    const bodyIdx = req.user.indexOf("本文はここ");
    const endIdx = req.user.indexOf("=== END SOURCE ===");
    expect(startIdx).toBeGreaterThan(-1);
    expect(bodyIdx).toBeGreaterThan(startIdx);
    expect(endIdx).toBeGreaterThan(bodyIdx);
  });

  it("requests JSON mode with temperature 0", () => {
    const req = buildExtractionRequest({
      referenceTime: "2026-09-08T01:00:00Z", submitter, sourceType: "TEXT",
      text: "hello", knownAccounts: [], openOpportunities: [],
    });
    expect(req.json).toBe(true);
    expect(req.temperature).toBe(0);
  });

  it("mentions when the user did not say when the text happened, and includes occurredAt when given", () => {
    const withoutOccurred = buildExtractionRequest({
      referenceTime: "2026-09-08T01:00:00Z", submitter, sourceType: "TEXT",
      text: "hello", knownAccounts: [], openOpportunities: [],
    });
    expect(withoutOccurred.user).toContain("the user did not say when this happened");

    const withOccurred = buildExtractionRequest({
      referenceTime: "2026-09-08T01:00:00Z", submitter, sourceType: "TEXT",
      occurredAt: "2026-09-07T01:00:00Z", text: "hello", knownAccounts: [], openOpportunities: [],
    });
    expect(withOccurred.user).toContain("the user says this happened at: 2026-09-07T01:00:00Z");
  });

  it("embeds a JSON schema in the system prompt consistent with extractionSchema (jsonSchemaOf)", () => {
    const req = buildExtractionRequest({
      referenceTime: "2026-09-08T01:00:00Z", submitter, sourceType: "TEXT",
      text: "hello", knownAccounts: [], openOpportunities: [],
    });
    const expected = JSON.stringify(jsonSchemaOf(extractionSchema));
    expect(req.system).toContain(expected);
  });
});

describe("buildContextRequest", () => {
  const opportunity = {
    id: "opp-1", accountId: "acc-1", title: "新サービス導入", ownerUserId: "user-1",
    collaboratorUserIds: [], lifecycleState: "OPEN" as const, operationalState: "ACTIVE" as const,
    riskLevel: "NONE" as const, version: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    expectedAmount: 1_000_000, currency: "JPY",
  };

  it("includes reference time in the given timezone and wraps activities in SOURCE delimiters", () => {
    const req = buildContextRequest({
      referenceTime: "2026-09-08T01:00:00Z", timezone: "Asia/Tokyo", opportunity,
      accountName: "ABC株式会社", activities: [
        { id: "act-1", occurredAt: "2026-09-01T01:00:00Z", type: "MEETING", summary: "商談内容", facts: [] },
      ], openCommitments: [], openNextActions: [],
    });
    expect(req.user).toContain("2026-09-08T10:00 (Tue, Asia/Tokyo)");
    const startIdx = req.user.indexOf("=== SOURCE ===");
    const bodyIdx = req.user.indexOf("商談内容");
    const endIdx = req.user.indexOf("=== END SOURCE ===");
    expect(startIdx).toBeGreaterThan(-1);
    expect(bodyIdx).toBeGreaterThan(startIdx);
    expect(endIdx).toBeGreaterThan(bodyIdx);
  });

  it("embeds a JSON schema consistent with contextSnapshotSchema", () => {
    const req = buildContextRequest({
      referenceTime: "2026-09-08T01:00:00Z", timezone: "Asia/Tokyo", opportunity,
      accountName: "ABC株式会社", activities: [], openCommitments: [], openNextActions: [],
    });
    expect(req.system).toContain(JSON.stringify(jsonSchemaOf(contextSnapshotSchema)));
  });

  it("says '(none)' when there is no previous snapshot / commitments / next actions", () => {
    const req = buildContextRequest({
      referenceTime: "2026-09-08T01:00:00Z", timezone: "Asia/Tokyo", opportunity,
      accountName: "ABC株式会社", activities: [], openCommitments: [], openNextActions: [],
    });
    expect(req.user).toContain("previous context: (none)");
    expect(req.user).toContain("(none)");
  });
});
