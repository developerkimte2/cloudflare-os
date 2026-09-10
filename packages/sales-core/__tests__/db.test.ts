import { beforeEach, describe, expect, it } from "vitest";
import { NodeSqliteExecutor } from "../src/db/node-sqlite.js";
import { migrate, MIGRATIONS } from "../src/db/migrations.js";
import { Repository } from "../src/db/repository.js";
import * as T from "../src/db/tables.js";
import { col, Table } from "../src/db/mapper.js";
import type { CustomerAccount, Opportunity, User } from "../src/domain/types.js";
import { newId } from "../src/domain/util.js";

function freshDb(): NodeSqliteExecutor {
  const db = new NodeSqliteExecutor();
  migrate(db);
  return db;
}

describe("migrate", () => {
  it("is idempotent: a second run applies nothing", () => {
    const db = new NodeSqliteExecutor();
    const first = migrate(db);
    expect(first).toEqual(MIGRATIONS.map(m => m.id));
    const second = migrate(db);
    expect(second).toEqual([]);
  });

  it("records applied migrations in schema_migrations", () => {
    const db = freshDb();
    const rows = db.all<{ id: string }>("SELECT id FROM schema_migrations");
    expect(rows.map(r => r.id)).toEqual(MIGRATIONS.map(m => m.id));
  });
});

describe("Table mapper round-trip", () => {
  it("round-trips JSON, boolean and null columns", () => {
    interface Widget { id: string; tags: string[]; flag: boolean; note?: string }
    const db = freshDb();
    db.run("CREATE TABLE widgets (id TEXT PRIMARY KEY, tags TEXT, flag INTEGER, note TEXT)");
    const table = new Table<Widget>("widgets", "id", [
      col("id", "id"), col("tags", "tags", "json"), col("flag", "flag", "bool"), col("note", "note"),
    ]);
    const withNote: Widget = { id: "w1", tags: ["a", "b"], flag: true, note: "hello" };
    const withoutNote: Widget = { id: "w2", tags: [], flag: false };
    table.insert(db, withNote);
    table.insert(db, withoutNote);

    const gotWithNote = table.get(db, "w1")!;
    expect(gotWithNote.tags).toEqual(["a", "b"]);
    expect(gotWithNote.flag).toBe(true);
    expect(gotWithNote.note).toBe("hello");

    const gotWithoutNote = table.get(db, "w2")!;
    expect(gotWithoutNote.tags).toEqual([]);
    expect(gotWithoutNote.flag).toBe(false);
    expect(gotWithoutNote.note).toBeUndefined();

    table.update(db, { ...withNote, tags: ["c"], flag: false, note: undefined });
    const updated = table.get(db, "w1")!;
    expect(updated.tags).toEqual(["c"]);
    expect(updated.flag).toBe(false);
    expect(updated.note).toBeUndefined();

    table.delete(db, "w2");
    expect(table.get(db, "w2")).toBeUndefined();
  });
});

function makeUser(overrides: Partial<User> = {}): User {
  const now = "2026-09-08T00:00:00.000Z";
  return {
    id: newId(), email: `${newId()}@example.com`, displayName: "太郎", role: "SALES",
    timezone: "Asia/Tokyo", active: true, createdAt: now, updatedAt: now, ...overrides,
  };
}

function makeAccount(overrides: Partial<CustomerAccount> = {}): CustomerAccount {
  const now = "2026-09-08T00:00:00.000Z";
  return {
    id: newId(), displayName: "ABC株式会社", resolutionStatus: "MANUAL",
    createdAt: now, updatedAt: now, ...overrides,
  };
}

function makeOpportunity(accountId: string, ownerUserId: string, overrides: Partial<Opportunity> = {}): Opportunity {
  const now = "2026-09-08T00:00:00.000Z";
  return {
    id: newId(), accountId, title: "案件", ownerUserId, collaboratorUserIds: [],
    lifecycleState: "OPEN", operationalState: "UNKNOWN", riskLevel: "NONE", version: 1,
    createdAt: now, updatedAt: now, ...overrides,
  };
}

describe("Repository optimistic concurrency", () => {
  let repo: Repository;
  beforeEach(() => { repo = new Repository(freshDb()); });

  it("updateOpportunity fails when the expected version is stale", () => {
    const owner = makeUser();
    repo.insertUser(owner);
    const account = makeAccount();
    repo.insertAccount(account);
    const opp = makeOpportunity(account.id, owner.id);
    repo.insertOpportunity(opp);

    // Correct version succeeds and bumps the stored version.
    expect(repo.updateOpportunity({ ...opp, title: "更新1" }, 1)).toBe(true);
    expect(repo.getOpportunity(opp.id)!.version).toBe(2);
    expect(repo.getOpportunity(opp.id)!.title).toBe("更新1");

    // Stale (wrong) version fails and leaves the row untouched.
    expect(repo.updateOpportunity({ ...opp, title: "更新2" }, 1)).toBe(false);
    expect(repo.getOpportunity(opp.id)!.title).toBe("更新1");
    expect(repo.getOpportunity(opp.id)!.version).toBe(2);
  });
});

describe("Repository.listOpportunitiesVisibleTo role filtering", () => {
  let repo: Repository;
  let sales1: User, sales2: User, manager: User;
  let account: CustomerAccount;
  let ownedBySales1: Opportunity, collabBySales1: Opportunity, ownedBySales2: Opportunity;

  beforeEach(() => {
    repo = new Repository(freshDb());
    sales1 = makeUser({ role: "SALES", displayName: "sales1" });
    sales2 = makeUser({ role: "SALES", displayName: "sales2" });
    manager = makeUser({ role: "MANAGER", displayName: "mgr" });
    [sales1, sales2, manager].forEach(u => repo.insertUser(u));
    account = makeAccount();
    repo.insertAccount(account);
    ownedBySales1 = makeOpportunity(account.id, sales1.id, { title: "owned-by-1" });
    collabBySales1 = makeOpportunity(account.id, sales2.id, { title: "collab-with-1", collaboratorUserIds: [sales1.id] });
    ownedBySales2 = makeOpportunity(account.id, sales2.id, { title: "owned-by-2" });
    [ownedBySales1, collabBySales1, ownedBySales2].forEach(o => repo.insertOpportunity(o));
  });

  it("SALES sees only opportunities they own or collaborate on", () => {
    const visible = repo.listOpportunitiesVisibleTo(sales1);
    expect(new Set(visible.map(o => o.title))).toEqual(new Set(["owned-by-1", "collab-with-1"]));
  });

  it("SALES does not see another SALES user's unrelated opportunity", () => {
    const visible = repo.listOpportunitiesVisibleTo(sales1);
    expect(visible.some(o => o.id === ownedBySales2.id)).toBe(false);
  });

  it("MANAGER sees all opportunities", () => {
    const visible = repo.listOpportunitiesVisibleTo(manager);
    expect(visible).toHaveLength(3);
  });
});

describe("Repository.findAccountCandidates", () => {
  let repo: Repository;
  beforeEach(() => { repo = new Repository(freshDb()); });

  it("finds substring matches in either direction (normalized)", () => {
    const abc = makeAccount({ displayName: "ABC株式会社" });
    const abcSystems = makeAccount({ displayName: "ABC Systems株式会社" });
    const unrelated = makeAccount({ displayName: "XYZ商事" });
    [abc, abcSystems, unrelated].forEach(a => repo.insertAccount(a));

    const candidates = repo.findAccountCandidates("ABC");
    const ids = candidates.map(c => c.id);
    expect(ids).toContain(abc.id);
    expect(ids).toContain(abcSystems.id);
    expect(ids).not.toContain(unrelated.id);
  });

  it("returns an empty array for an empty/whitespace name", () => {
    expect(repo.findAccountCandidates("   ")).toEqual([]);
  });

  it("respects the limit", () => {
    for (let i = 0; i < 8; i++) repo.insertAccount(makeAccount({ displayName: `ABC-${i}株式会社` }));
    expect(repo.findAccountCandidates("ABC", 3)).toHaveLength(3);
  });
});

describe("Repository settings", () => {
  it("putSetting / getSetting round-trip and upsert", () => {
    const repo = new Repository(freshDb());
    repo.putSetting("k", { a: 1 }, "2026-09-08T00:00:00Z");
    expect(repo.getSetting("k")).toEqual({ a: 1 });
    repo.putSetting("k", { a: 2 }, "2026-09-08T01:00:00Z");
    expect(repo.getSetting("k")).toEqual({ a: 2 });
    expect(repo.getSetting("missing")).toBeUndefined();
  });
});

describe("Repository notification logs (plans/sales-os-notify.md N1)", () => {
  let repo: Repository;
  beforeEach(() => { repo = new Repository(freshDb()); });

  it("findSentNotification is undefined until a matching SENT log exists", () => {
    expect(repo.findSentNotification("u1", "morning_brief:2026-09-10")).toBeUndefined();
    repo.insertNotificationLog({
      id: newId(), userId: "u1", channel: "SLACK", notificationType: "morning_brief",
      messageHash: "morning_brief:2026-09-10", sentAt: "2026-09-10T00:00:00Z", status: "SENT",
    });
    const found = repo.findSentNotification("u1", "morning_brief:2026-09-10");
    expect(found?.status).toBe("SENT");
  });

  it("does not match a different user, or a FAILED/SKIPPED_DUPLICATE log", () => {
    repo.insertNotificationLog({
      id: newId(), userId: "u1", channel: "SLACK", notificationType: "morning_brief",
      messageHash: "morning_brief:2026-09-10", sentAt: "2026-09-10T00:00:00Z", status: "FAILED",
    });
    expect(repo.findSentNotification("u1", "morning_brief:2026-09-10")).toBeUndefined();
    expect(repo.findSentNotification("u2", "morning_brief:2026-09-10")).toBeUndefined();
  });

  it("a different day's messageHash is a separate entry (no false-positive dedup)", () => {
    repo.insertNotificationLog({
      id: newId(), userId: "u1", channel: "SLACK", notificationType: "morning_brief",
      messageHash: "morning_brief:2026-09-10", sentAt: "2026-09-10T00:00:00Z", status: "SENT",
    });
    expect(repo.findSentNotification("u1", "morning_brief:2026-09-11")).toBeUndefined();
  });
});
