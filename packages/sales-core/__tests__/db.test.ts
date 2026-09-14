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

describe("migration 0005_opportunity_contact_person_ids backfill", () => {
  it("sets contactPersonIds from activities.person_ids, restricted to the opportunity's own account", () => {
    const db = new NodeSqliteExecutor();
    migrate(db, MIGRATIONS.slice(0, 4)); // stop before 0005: contact_person_ids does not exist yet
    const now = "2026-09-08T00:00:00.000Z";
    db.run("INSERT INTO users (id, email, display_name, role, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      "u1", "u1@example.com", "太郎", "SALES", now, now);
    db.run("INSERT INTO customer_accounts (id, display_name, resolution_status, created_at, updated_at) VALUES (?,?,?,?,?)",
      "acc1", "ABC株式会社", "MANUAL", now, now);
    db.run("INSERT INTO customer_accounts (id, display_name, resolution_status, created_at, updated_at) VALUES (?,?,?,?,?)",
      "acc2", "他社", "MANUAL", now, now);
    db.run("INSERT INTO customer_persons (id, account_id, display_name, resolution_status, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      "p1", "acc1", "山田", "MANUAL", now, now);
    db.run("INSERT INTO customer_persons (id, account_id, display_name, resolution_status, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      "pOther", "acc2", "別会社の人", "MANUAL", now, now);
    db.run("INSERT INTO opportunities (id, account_id, title, owner_user_id, lifecycle_state, operational_state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
      "o1", "acc1", "案件1（記録あり）", "u1", "OPEN", "UNKNOWN", now, now);
    db.run("INSERT INTO opportunities (id, account_id, title, owner_user_id, lifecycle_state, operational_state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
      "o2", "acc1", "案件2（記録なし）", "u1", "OPEN", "UNKNOWN", now, now);
    db.run("INSERT INTO source_documents (id, source_type, content_hash, received_at, processing_status) VALUES (?,?,?,?,?)",
      "s1", "TEXT", "hash1", now, "PROCESSED");
    // o1's activity mentions both this account's person (p1) and, oddly, another account's person
    // (pOther) — the backfill must keep only p1.
    db.run("INSERT INTO activities (id, opportunity_id, person_ids, type, occurred_at, source_id, summary, created_at) VALUES (?,?,?,?,?,?,?,?)",
      "a1", "o1", JSON.stringify(["p1", "pOther"]), "NOTE", now, "s1", "summary", now);

    const applied = migrate(db, MIGRATIONS.slice(0, 5)); // stop after 0005: this test is only about that one
    expect(applied).toEqual(["0005_opportunity_contact_person_ids"]);
    const repo = new Repository(db);
    expect(repo.getOpportunity("o1")!.contactPersonIds).toEqual(["p1"]);
    expect(repo.getOpportunity("o2")!.contactPersonIds).toEqual([]);
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

  it("text search matches title, customer, this deal's contacts and owner names, and treats % and _ literally", () => {
    const other = makeAccount({ displayName: "ブルームワークス" });
    repo.insertAccount(other);
    const hanako = { id: newId(), accountId: other.id, displayName: "山田花子", resolutionStatus: "MANUAL" as const,
      createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z" };
    repo.insertPerson(hanako);
    // A second opportunity of the same company, with no contact set, to prove the match is
    // per-deal (窓口) rather than "any contact of this customer".
    repo.insertOpportunity(makeOpportunity(other.id, sales1.id, { title: "no-contact-set" }));
    repo.insertOpportunity(makeOpportunity(other.id, sales1.id, { title: "100%_導入", contactPersonIds: [hanako.id] }));
    const titles = (text: string) => repo.listOpportunitiesVisibleTo(manager, { text }).map(o => o.title).sort();

    expect(titles("collab")).toEqual(["collab-with-1"]);
    expect(titles("ブルーム")).toEqual(["100%_導入", "no-contact-set"]);
    expect(titles("山田")).toEqual(["100%_導入"]);
    expect(titles("sales2")).toEqual(["collab-with-1", "owned-by-2"]);
    expect(titles("%_")).toEqual(["100%_導入"]);
    expect(titles("_")).toEqual(["100%_導入"]);
    expect(titles("  ")).toHaveLength(5);
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

describe("Repository calendar events (plans/sales-os-calendar.md C1)", () => {
  let repo: Repository;
  beforeEach(() => { repo = new Repository(freshDb()); });

  function makeEvent(overrides: Partial<import("../src/domain/types.js").CalendarEventMirror> = {}) {
    return {
      id: newId(), googleCalendarId: "cal-1", googleEventId: "evt-1", ownerUserId: "user-1",
      title: "ABC株式会社 定例", attendeesJson: [], startAt: "2026-09-10T01:00:00Z",
      endAt: "2026-09-10T02:00:00Z", status: "confirmed", lastSyncedAt: "2026-09-10T00:00:00Z",
      ...overrides,
    };
  }

  it("findCalendarEvent is undefined until inserted, then round-trips", () => {
    expect(repo.findCalendarEvent("cal-1", "evt-1")).toBeUndefined();
    repo.upsertCalendarEvent(makeEvent());
    const found = repo.findCalendarEvent("cal-1", "evt-1");
    expect(found?.title).toBe("ABC株式会社 定例");
  });

  it("upsertCalendarEvent replaces the existing row instead of inserting a duplicate", () => {
    repo.upsertCalendarEvent(makeEvent({ status: "confirmed" }));
    repo.upsertCalendarEvent(makeEvent({ id: newId(), status: "cancelled" }));

    const found = repo.findCalendarEvent("cal-1", "evt-1");
    expect(found?.status).toBe("cancelled");
    expect(repo.listCalendarEventsForOwner("user-1", "2026-09-01T00:00:00Z", "2026-09-30T00:00:00Z")).toHaveLength(1);
  });

  it("listCalendarEventsForOwner filters by owner and the start-time range", () => {
    repo.upsertCalendarEvent(makeEvent({ googleEventId: "evt-1", startAt: "2026-09-10T01:00:00Z" }));
    repo.upsertCalendarEvent(makeEvent({ googleEventId: "evt-2", startAt: "2026-09-15T01:00:00Z" }));
    repo.upsertCalendarEvent(makeEvent({ googleEventId: "evt-3", ownerUserId: "user-2", startAt: "2026-09-10T01:00:00Z" }));

    const inRange = repo.listCalendarEventsForOwner("user-1", "2026-09-01T00:00:00Z", "2026-09-12T00:00:00Z");
    expect(inRange.map(e => e.googleEventId)).toEqual(["evt-1"]);
  });
});
