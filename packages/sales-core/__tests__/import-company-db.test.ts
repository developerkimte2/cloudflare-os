import { describe, expect, it } from "vitest";
import { FakeLlmProvider } from "../src/ai/provider.js";
import { AuthorizationError } from "../src/service/sales-service.js";
import { makeAccount, makeService, makeUser } from "./helpers.js";

const NOW = "2026-09-08T01:00:00Z";
const HEADER = "会社名,会社名カナ,法人番号,業種,郵便番号,住所,会社電話,会社URL,部署,役職,氏名,氏名カナ,メールアドレス,携帯電話,名刺交換日";

function row(fields: Partial<Record<
  "会社名" | "会社名カナ" | "法人番号" | "業種" | "郵便番号" | "住所" | "会社電話" | "会社URL"
  | "部署" | "役職" | "氏名" | "氏名カナ" | "メールアドレス" | "携帯電話" | "名刺交換日", string
>>): string {
  const order = ["会社名", "会社名カナ", "法人番号", "業種", "郵便番号", "住所", "会社電話", "会社URL",
    "部署", "役職", "氏名", "氏名カナ", "メールアドレス", "携帯電話", "名刺交換日"] as const;
  return order.map(k => fields[k] ?? "").join(",");
}

describe("importCompanyDb (企業DB連携 from a Sansan-style sheet)", () => {
  it("creates a new account + person from a fresh row", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const admin = makeUser(svc.repo, "ADMIN");
    const csv = [HEADER, row({
      会社名: "株式会社ネオリンク", 法人番号: "1010001123456", 業種: "情報通信業", 住所: "東京都千代田区1-1",
      会社電話: "03-1234-5601", 会社URL: "https://neolink.example.com", 部署: "営業部", 役職: "課長",
      氏名: "田中 一郎", メールアドレス: "tanaka@neolink.example.com", 携帯電話: "090-1111-2201",
    })].join("\n");

    const result = svc.importCompanyDb({ userId: admin.id }, csv);
    expect(result).toMatchObject({ accountsCreated: 1, accountsUpdated: 0, personsCreated: 1, personsUpdated: 0, rowsRead: 1, errors: [] });

    const account = svc.repo.findAccountByCorporateNumber("1010001123456")!;
    expect(account.displayName).toBe("株式会社ネオリンク");
    expect(account.industry).toBe("情報通信業");
    const persons = svc.repo.listPersonsForAccount(account.id);
    expect(persons).toHaveLength(1);
    expect(persons[0]).toMatchObject({ displayName: "田中 一郎", title: "営業部 課長", email: "tanaka@neolink.example.com", phone: "090-1111-2201" });
  });

  it("matches an existing account by 法人番号 over name, and updates it", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const admin = makeUser(svc.repo, "ADMIN");
    const existing = makeAccount(svc.repo, { displayName: "旧・ネオリンク商会", corporateNumber: "1010001123456" });
    const csv = [HEADER, row({ 会社名: "株式会社ネオリンク", 法人番号: "1010001123456", 業種: "情報通信業" })].join("\n");

    const result = svc.importCompanyDb({ userId: admin.id }, csv);
    expect(result.accountsCreated).toBe(0);
    expect(result.accountsUpdated).toBe(1);
    expect(svc.repo.getAccount(existing.id)!.industry).toBe("情報通信業");
    // Display name from the CSV does NOT overwrite the existing one (a person renamed it on
    // purpose); only contact/industry fields sync.
    expect(svc.repo.getAccount(existing.id)!.displayName).toBe("旧・ネオリンク商会");
  });

  it("falls back to normalized name matching when there is no 法人番号 on either side", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const admin = makeUser(svc.repo, "ADMIN");
    const existing = makeAccount(svc.repo, { displayName: "株式会社ネオリンク" });
    const csv = [HEADER, row({ 会社名: "株式会社ネオリンク", 業種: "情報通信業" })].join("\n");

    const result = svc.importCompanyDb({ userId: admin.id }, csv);
    expect(result.accountsUpdated).toBe(1);
    expect(svc.repo.getAccount(existing.id)!.industry).toBe("情報通信業");
  });

  it("two rows for the same 法人番号 create one account with two persons", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const admin = makeUser(svc.repo, "ADMIN");
    const csv = [
      HEADER,
      row({ 会社名: "株式会社ネオリンク", 法人番号: "1010001123456", 氏名: "田中 一郎", メールアドレス: "tanaka@neolink.example.com" }),
      row({ 会社名: "株式会社ネオリンク", 法人番号: "1010001123456", 氏名: "松本 恵", メールアドレス: "matsumoto@neolink.example.com" }),
    ].join("\n");

    const result = svc.importCompanyDb({ userId: admin.id }, csv);
    expect(result.accountsCreated).toBe(1);
    expect(result.personsCreated).toBe(2);
    const account = svc.repo.findAccountByCorporateNumber("1010001123456")!;
    expect(svc.repo.listPersonsForAccount(account.id)).toHaveLength(2);
  });

  it("records a row-level error (blank company name) without aborting the rest of the sync", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const admin = makeUser(svc.repo, "ADMIN");
    const csv = [
      HEADER,
      row({ 会社名: "", 氏名: "誰か" }),
      row({ 会社名: "株式会社ネオリンク", 氏名: "田中 一郎", メールアドレス: "tanaka@neolink.example.com" }),
    ].join("\n");

    const result = svc.importCompanyDb({ userId: admin.id }, csv);
    expect(result.accountsCreated).toBe(1);
    expect(result.errors).toEqual([{ row: 2, message: "会社名が空です" }]);
  });

  it("flags a person whose email already belongs to a different account, instead of moving them", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const admin = makeUser(svc.repo, "ADMIN");
    const otherAccount = makeAccount(svc.repo, { displayName: "別の会社" });
    svc.repo.insertPerson({
      id: "p1", accountId: otherAccount.id, displayName: "田中 一郎", email: "tanaka@neolink.example.com",
      resolutionStatus: "MANUAL", createdAt: NOW, updatedAt: NOW,
    });
    const csv = [HEADER, row({ 会社名: "株式会社ネオリンク", 氏名: "田中 一郎", メールアドレス: "tanaka@neolink.example.com" })].join("\n");

    const result = svc.importCompanyDb({ userId: admin.id }, csv);
    expect(result.personsCreated).toBe(0);
    expect(result.personsUpdated).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toContain("既に別の顧客");
  });

  it("rejects a non-ADMIN caller", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const manager = makeUser(svc.repo, "MANAGER");
    expect(() => svc.importCompanyDb({ userId: manager.id }, `${HEADER}\n${row({ 会社名: "X" })}`))
      .toThrow(AuthorizationError);
  });
});
