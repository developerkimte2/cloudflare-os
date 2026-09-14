import { beforeEach, describe, expect, it } from "vitest";
import { NodeSqliteExecutor } from "../src/db/node-sqlite.js";
import { migrate } from "../src/db/migrations.js";
import { Repository } from "../src/db/repository.js";
import { DEFAULT_CONFIG } from "../src/rules/config.js";
import { customerReviewOptions, resolveEntities } from "../src/rules/entity-resolution.js";
import { extractionSchema, type Extraction } from "../src/ai/schema.js";
import type { CustomerAccount, CustomerPerson } from "../src/domain/types.js";
import { newId, normalizeName } from "../src/domain/util.js";

function baseExtraction(overrides: {
  accounts?: { name: string; domain?: string | null; confidence?: number }[];
  persons?: { name: string; company?: string | null; email?: string | null; confidence?: number }[];
} = {}): Extraction {
  return extractionSchema.parse({
    entities: {
      account_candidates: (overrides.accounts ?? []).map(a => ({
        name: a.name, domain: a.domain ?? null, confidence: a.confidence ?? 0.9,
      })),
      person_candidates: (overrides.persons ?? []).map(p => ({
        name: p.name, company: p.company ?? null, email: p.email ?? null, confidence: p.confidence ?? 0.9,
      })),
    },
    opportunity: { match: "UNKNOWN", confidence: 0.5 },
    activity: { type: "NOTE", occurred_at: null, summary: "s", confidence: 0.5 },
    state: { operational_state: "UNKNOWN", lifecycle_state: "OPEN", confidence: 0.5 },
    risk: { level: "NONE", confidence: 0.5 },
    context: { current_situation: "s", latest_development: "d" },
  });
}

function makeAccount(overrides: Partial<CustomerAccount> = {}): CustomerAccount {
  const now = "2026-09-08T00:00:00.000Z";
  return {
    id: newId(), displayName: "ABC株式会社", resolutionStatus: "MANUAL",
    createdAt: now, updatedAt: now, ...overrides,
  };
}

function makePerson(accountId: string | undefined, overrides: Partial<CustomerPerson> = {}): CustomerPerson {
  const now = "2026-09-08T00:00:00.000Z";
  return {
    id: newId(), accountId, displayName: "山田", resolutionStatus: "MANUAL",
    createdAt: now, updatedAt: now, ...overrides,
  };
}

describe("resolveEntities", () => {
  let repo: Repository;
  beforeEach(() => {
    const db = new NodeSqliteExecutor();
    migrate(db);
    repo = new Repository(db);
  });

  it("EMAIL_EXACT: a matching email resolves the account with confidence 1 and no review", () => {
    const account = makeAccount();
    repo.insertAccount(account);
    const person = makePerson(account.id, { email: "yamada@abc.co.jp" });
    repo.insertPerson(person);

    const x = baseExtraction({ persons: [{ name: "山田", email: "YAMADA@abc.co.jp" }] });
    const res = resolveEntities(repo, x, DEFAULT_CONFIG);
    expect(res.method).toBe("EMAIL_EXACT");
    expect(res.account?.id).toBe(account.id);
    expect(res.confidence).toBe(1);
    expect(res.needsReview).toBe(false);
    expect(res.persons.map(p => p.id)).toEqual([person.id]);
  });

  it("EMAIL_EXACT: a matching email against an UNRESOLVED (unconfirmed) account still requires review", () => {
    // 2026-09-14 finding: an UNRESOLVED account's own identity is itself an unconfirmed AI guess —
    // matching a new mention to one via email must not silently stack a second guess on top.
    const account = makeAccount({ resolutionStatus: "UNRESOLVED" });
    repo.insertAccount(account);
    const person = makePerson(account.id, { email: "yamada@abc.co.jp", resolutionStatus: "UNRESOLVED" });
    repo.insertPerson(person);

    const x = baseExtraction({ persons: [{ name: "山田", email: "yamada@abc.co.jp" }] });
    const res = resolveEntities(repo, x, DEFAULT_CONFIG);
    expect(res.method).toBe("EMAIL_EXACT");
    expect(res.account).toBeUndefined();
    expect(res.needsReview).toBe(true);
    expect(res.candidates.map(c => c.id)).toEqual([account.id]);
    expect(res.reason).toContain("未確定");
  });

  it("DOMAIN_AND_NAME: matching domain and person name resolves without review", () => {
    const account = makeAccount({ primaryDomain: "abc.co.jp" });
    repo.insertAccount(account);
    const person = makePerson(account.id, { displayName: "山田太郎" });
    repo.insertPerson(person);

    const x = baseExtraction({ persons: [{ name: "山田太郎", email: "yamada@abc.co.jp" }] });
    const res = resolveEntities(repo, x, DEFAULT_CONFIG);
    expect(res.method).toBe("DOMAIN_AND_NAME");
    expect(res.account?.id).toBe(account.id);
    expect(res.needsReview).toBe(false);
  });

  it("DOMAIN_AND_NAME: matching domain and person against an UNRESOLVED account still requires review", () => {
    const account = makeAccount({ primaryDomain: "abc.co.jp", resolutionStatus: "UNRESOLVED" });
    repo.insertAccount(account);
    const person = makePerson(account.id, { displayName: "山田太郎", resolutionStatus: "UNRESOLVED" });
    repo.insertPerson(person);

    const x = baseExtraction({ persons: [{ name: "山田太郎", email: "yamada@abc.co.jp" }] });
    const res = resolveEntities(repo, x, DEFAULT_CONFIG);
    expect(res.method).toBe("DOMAIN_AND_NAME");
    expect(res.account).toBeUndefined();
    expect(res.needsReview).toBe(true);
  });

  it("DOMAIN_AND_NAME: matching domain but unknown person still needs review", () => {
    const account = makeAccount({ primaryDomain: "abc.co.jp" });
    repo.insertAccount(account);

    const x = baseExtraction({ persons: [{ name: "知らない人", email: "someone@abc.co.jp" }] });
    const res = resolveEntities(repo, x, DEFAULT_CONFIG);
    expect(res.method).toBe("DOMAIN_AND_NAME");
    expect(res.account).toBeUndefined();
    expect(res.needsReview).toBe(true);
    expect(res.candidates.map(c => c.id)).toEqual([account.id]);
  });

  it("COMPANY_AND_PERSON: exact company + matching person resolves without review", () => {
    const account = makeAccount({ displayName: "ABC株式会社" });
    repo.insertAccount(account);
    const person = makePerson(account.id, { displayName: "山田" });
    repo.insertPerson(person);

    const x = baseExtraction({ accounts: [{ name: "ABC株式会社" }], persons: [{ name: "山田", company: "ABC株式会社" }] });
    const res = resolveEntities(repo, x, DEFAULT_CONFIG);
    expect(res.method).toBe("COMPANY_AND_PERSON");
    expect(res.account?.id).toBe(account.id);
    expect(res.needsReview).toBe(false);
  });

  it("COMPANY_AND_PERSON: exact match against an UNRESOLVED account still requires review", () => {
    const account = makeAccount({ displayName: "ABC株式会社", resolutionStatus: "UNRESOLVED" });
    repo.insertAccount(account);
    const person = makePerson(account.id, { displayName: "山田", resolutionStatus: "UNRESOLVED" });
    repo.insertPerson(person);

    const x = baseExtraction({ accounts: [{ name: "ABC株式会社" }], persons: [{ name: "山田", company: "ABC株式会社" }] });
    const res = resolveEntities(repo, x, DEFAULT_CONFIG);
    expect(res.method).toBe("COMPANY_AND_PERSON");
    expect(res.account).toBeUndefined();
    expect(res.needsReview).toBe(true);
    expect(res.candidates.map(c => c.id)).toEqual([account.id]);
  });

  it("COMPANY_ONLY: exact company match with no matching person requires review", () => {
    const account = makeAccount({ displayName: "ABC株式会社" });
    repo.insertAccount(account);

    const x = baseExtraction({ accounts: [{ name: "ABC株式会社" }], persons: [{ name: "知らない人" }] });
    const res = resolveEntities(repo, x, DEFAULT_CONFIG);
    expect(res.method).toBe("COMPANY_ONLY");
    expect(res.account).toBeUndefined(); // not auto-resolved
    expect(res.needsReview).toBe(true);
    expect(res.candidates.map(c => c.id)).toEqual([account.id]);
  });

  it("multiple accounts with the same normalized name require review with all as candidates", () => {
    const a1 = makeAccount({ displayName: "ABC株式会社" });
    const a2 = makeAccount({ displayName: "ABC(株)" }); // same normalized name
    repo.insertAccount(a1);
    repo.insertAccount(a2);

    const x = baseExtraction({ accounts: [{ name: "ABC株式会社" }] });
    const res = resolveEntities(repo, x, DEFAULT_CONFIG);
    expect(res.method).toBe("COMPANY_ONLY");
    expect(res.account).toBeUndefined();
    expect(res.needsReview).toBe(true);
    expect(new Set(res.candidates.map(c => c.id))).toEqual(new Set([a1.id, a2.id]));
  });

  it("nothing mentioned in the text produces no review and no account", () => {
    const x = baseExtraction();
    const res = resolveEntities(repo, x, DEFAULT_CONFIG);
    expect(res.account).toBeUndefined();
    expect(res.needsReview).toBe(false);
    expect(res.method).toBe("NONE");
  });

  it("a mentioned company with no matches at all still requires review (possible new lead)", () => {
    const x = baseExtraction({ accounts: [{ name: "誰も知らない会社" }] });
    const res = resolveEntities(repo, x, DEFAULT_CONFIG);
    expect(res.account).toBeUndefined();
    expect(res.needsReview).toBe(true);
    expect(res.mentionedCompanyName).toBe("誰も知らない会社");
  });

  it("fuzzy substring candidates are surfaced for review", () => {
    const account = makeAccount({ displayName: "ABC Systems株式会社" });
    repo.insertAccount(account);
    const x = baseExtraction({ accounts: [{ name: "ABC" }] });
    const res = resolveEntities(repo, x, DEFAULT_CONFIG);
    expect(res.account).toBeUndefined();
    expect(res.needsReview).toBe(true);
    expect(res.candidates.map(c => c.id)).toContain(account.id);
  });

  it("collects unmatched persons for placeholder creation", () => {
    const x = baseExtraction({ persons: [{ name: "新しい人" }] });
    const res = resolveEntities(repo, x, DEFAULT_CONFIG);
    expect(res.unmatchedPersons.map(p => p.name)).toEqual(["新しい人"]);
  });
});

describe("customerReviewOptions", () => {
  it("offers each candidate, then 'new' and 'none', excluding the placeholder itself", () => {
    const placeholderId = "placeholder-1";
    const candidate = { id: "acc-1", displayName: "ABC株式会社" } as CustomerAccount;
    const placeholderAsCandidate = { id: placeholderId, displayName: "(顧客未特定)" } as CustomerAccount;
    const resolution = {
      account: undefined, persons: [], method: "NONE" as const, confidence: 0.5, needsReview: true,
      reason: "test", candidates: [candidate, placeholderAsCandidate], mentionedCompanyName: "ABC株式会社",
      unmatchedPersons: [],
    };
    const options = customerReviewOptions(resolution, placeholderId);
    expect(options.map(o => o.id)).toEqual(["account:acc-1", "new", "none"]);
    expect(options[0]!.label).toBe("ABC株式会社");
    expect(options[0]!.value).toEqual({ accountId: "acc-1" });
    expect(options[1]!.label).toContain("ABC株式会社");
    expect(options[1]!.value).toEqual({ newAccount: true });
    expect(options[2]!.value).toEqual({ none: true });
  });

  it("still offers 'new' and 'none' when there are no candidates", () => {
    const resolution = {
      account: undefined, persons: [], method: "NONE" as const, confidence: 0, needsReview: false,
      reason: "test", candidates: [], mentionedCompanyName: undefined, unmatchedPersons: [],
    };
    const options = customerReviewOptions(resolution, "placeholder-1");
    expect(options.map(o => o.id)).toEqual(["new", "none"]);
  });
});

describe("normalizeName consistency used by resolution", () => {
  it("normalizes ABC株式会社 and ABC(株) to the same key", () => {
    expect(normalizeName("ABC株式会社")).toBe(normalizeName("ABC(株)"));
  });
});
