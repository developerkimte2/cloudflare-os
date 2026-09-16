import { describe, expect, it } from "vitest";
import { parseCsv, parseCsvRecords, toCsv } from "../src/rules/csv.js";
import { toCsvExportUrl } from "../src/rules/google-sheets.js";

describe("toCsv (F3)", () => {
  it("quotes commas, quotes and newlines; BOM + CRLF", () => {
    const csv = toCsv(["a", "b"], [["x,y", 'say "hi"'], ["line\nbreak", 12]]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toBe('﻿a,b\r\n"x,y","say ""hi"""\r\n"line\nbreak",12\r\n');
  });
});

describe("parseCsv (企業DB import)", () => {
  it("round-trips toCsv's own output, including quoted commas/quotes/newlines", () => {
    const original = [["x,y", 'say "hi"'], ["line\nbreak", "12"]];
    const csv = toCsv(["a", "b"], original);
    expect(parseCsv(csv)).toEqual([["a", "b"], ...original]);
  });

  it("parses plain LF and bare CR line endings without a BOM", () => {
    expect(parseCsv("a,b\n1,2\n3,4")).toEqual([["a", "b"], ["1", "2"], ["3", "4"]]);
    expect(parseCsv("a,b\r1,2")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("ignores a trailing blank line but keeps an unterminated last row", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("a,b\r\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
  });
});

describe("parseCsvRecords", () => {
  it("keys rows by the header row and skips blank rows", () => {
    const text = "会社名,業種\n株式会社ABC,卸売業\n\n株式会社XYZ,小売業\n";
    expect(parseCsvRecords(text)).toEqual([
      { 会社名: "株式会社ABC", 業種: "卸売業" },
      { 会社名: "株式会社XYZ", 業種: "小売業" },
    ]);
  });

  it("tolerates a row shorter than the header (missing trailing columns become \"\")", () => {
    const text = "会社名,業種,住所\n株式会社ABC,卸売業\n";
    expect(parseCsvRecords(text)).toEqual([{ 会社名: "株式会社ABC", 業種: "卸売業", 住所: "" }]);
  });
});

describe("toCsvExportUrl (Google Sheets share link -> CSV export URL)", () => {
  it("converts a normal /edit URL, keeping no gid when the sheet has none", () => {
    expect(toCsvExportUrl("https://docs.google.com/spreadsheets/d/ABC123/edit?usp=sharing"))
      .toBe("https://docs.google.com/spreadsheets/d/ABC123/export?format=csv");
  });

  it("carries a #gid= fragment or ?gid= query param through", () => {
    expect(toCsvExportUrl("https://docs.google.com/spreadsheets/d/ABC123/edit#gid=456"))
      .toBe("https://docs.google.com/spreadsheets/d/ABC123/export?format=csv&gid=456");
    expect(toCsvExportUrl("https://docs.google.com/spreadsheets/d/ABC123/export?format=csv&gid=456"))
      .toBe("https://docs.google.com/spreadsheets/d/ABC123/export?format=csv&gid=456");
  });

  it("rejects a blank URL, a non-URL string, and a non-Google-Sheets host", () => {
    expect(() => toCsvExportUrl("")).toThrow(/入力してください/);
    expect(() => toCsvExportUrl("not a url")).toThrow(/形式/);
    expect(() => toCsvExportUrl("https://example.com/spreadsheets/d/ABC123/edit")).toThrow(/docs\.google\.com/);
    expect(() => toCsvExportUrl("https://docs.google.com/document/d/ABC123/edit")).toThrow(/形式/);
  });
});
