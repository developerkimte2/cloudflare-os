import { describe, expect, it } from "vitest";
import { looksLikeQuestion, matchOpportunities } from "../src/pipeline/ask.js";

describe("looksLikeQuestion", () => {
  it("recognizes a short question ending in a full-width question mark", () => {
    expect(looksLikeQuestion("ABC社の状況どうなっている？")).toBe(true);
  });

  it("recognizes a short question ending in a half-width question mark", () => {
    expect(looksLikeQuestion("ABC社の件どうなった?")).toBe(true);
  });

  it("recognizes a status-asking keyword even without a question mark", () => {
    expect(looksLikeQuestion("ABC社の進捗")).toBe(true);
  });

  it("does not treat a long pasted report as a question, even if it ends with '？'", () => {
    const text = "ABC株式会社の山田様と定例のオンライン商談を実施した。新機能の要望を複数ヒアリングし、".repeat(3) + "次はどうする？";
    expect(text.length).toBeGreaterThan(100);
    expect(looksLikeQuestion(text)).toBe(false);
  });

  it("does not treat an ordinary capture as a question", () => {
    expect(looksLikeQuestion("ABCの山田さんと打合せをした")).toBe(false);
  });

  it("recognizes a request to the assistant even without a question mark", () => {
    expect(looksLikeQuestion("山田商事の情報を教えてほしい")).toBe(true);
    expect(looksLikeQuestion("ABC社の担当者を知りたい")).toBe(true);
  });

  it("recognizes the hiragana spelling of the same request phrasing", () => {
    expect(looksLikeQuestion("山田商事の情報をおしえて")).toBe(true);
    expect(looksLikeQuestion("ABC社の担当者をしりたい")).toBe(true);
  });

  it("handles empty text without throwing", () => {
    expect(looksLikeQuestion("")).toBe(false);
    expect(looksLikeQuestion("   ")).toBe(false);
  });
});

describe("matchOpportunities", () => {
  const opportunities = [
    { id: "1", accountName: "ABC株式会社", title: "ABC株式会社 新機能提案" },
    { id: "2", accountName: "合同会社ブルームワークス", title: "合同会社ブルームワークス 商談" },
  ];

  it("matches by account name appearing in the question", () => {
    expect(matchOpportunities(opportunities, "ABC株式会社の状況どうなっている？").map(o => o.id)).toEqual(["1"]);
  });

  it("matches by opportunity title appearing in the question", () => {
    expect(matchOpportunities(opportunities, "合同会社ブルームワークス 商談の進捗は？").map(o => o.id)).toEqual(["2"]);
  });

  it("returns nothing when no name is mentioned", () => {
    expect(matchOpportunities(opportunities, "今日の予定どうなっている？")).toEqual([]);
  });

  it("does not match on a 1-character name (too generic)", () => {
    const short = [{ id: "1", accountName: "A", title: "A" }];
    expect(matchOpportunities(short, "Aの状況は？")).toEqual([]);
  });

  it("matches by title alone when no account name is mentioned", () => {
    const opps = [
      { id: "1", accountName: "ABC株式会社", title: "新機能提案ヒアリング" },
      { id: "2", accountName: "合同会社ブルームワークス", title: "商談フォロー" },
    ];
    expect(matchOpportunities(opps, "新機能提案ヒアリングの進捗は？").map(o => o.id)).toEqual(["1"]);
  });

  it("does not match a 3-character title (title matching needs 4+ chars)", () => {
    const opps = [{ id: "1", accountName: "ネオリンク", title: "商談中" }];
    expect(matchOpportunities(opps, "商談中の状況は？")).toEqual([]);
  });

  it("prefers account-name matches over title matches for a different opportunity", () => {
    const opps = [
      { id: "1", accountName: "ABC株式会社", title: "見積送付" },
      // This opportunity's title happens to appear in the question, but it belongs to a
      // different, unnamed account — it must not be pulled in alongside the account match.
      { id: "2", accountName: "合同会社ブルームワークス", title: "ABC株式会社の紹介案件" },
    ];
    expect(matchOpportunities(opps, "ABC株式会社の状況どうなっている？").map(o => o.id)).toEqual(["1"]);
  });

  it("matches when the question drops the account's corporate suffix (株式会社 etc.)", () => {
    const opps = [{ id: "1", accountName: "株式会社ネオリンク", title: "新機能提案" }];
    // A colloquial question very often omits "株式会社" even though the registered name carries it.
    expect(matchOpportunities(opps, "ネオリンクの状況どうなっている？").map(o => o.id)).toEqual(["1"]);
  });

  it("does not use the corporate-suffix-stripped match when the core name is still too short", () => {
    const opps = [{ id: "1", accountName: "株式会社A", title: "新機能提案" }];
    expect(matchOpportunities(opps, "Aの状況は？")).toEqual([]);
  });

  it("still prefers an exact account-name match over the suffix-stripped fallback", () => {
    const opps = [
      { id: "1", accountName: "株式会社ネオリンク", title: "新機能提案" },
      { id: "2", accountName: "有限会社ネオリンク商会", title: "別件" },
    ];
    // The question spells out the full registered name of #1; #2's core name ("ネオリンク商会")
    // is not a substring of the (normalized) question, so it must not be pulled in.
    expect(matchOpportunities(opps, "株式会社ネオリンクの状況どうなっている？").map(o => o.id)).toEqual(["1"]);
  });

  it("handles an empty question without throwing", () => {
    expect(matchOpportunities(opportunities, "")).toEqual([]);
  });
});
