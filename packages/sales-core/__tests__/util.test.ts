import { describe, expect, it } from "vitest";
import {
  addDays, canonicalizeText, clamp01, domainOfEmail, fixedClock, formatDateTimeJa, formatLocal,
  isIsoDate, isIsoDateTime, localDate, newId, normalizeEmail, normalizeName, nowIso, sha256Hex,
} from "../src/domain/util.js";

describe("normalizeName", () => {
  it("strips 株式会社 and matches an equivalent (株) form", () => {
    expect(normalizeName("ABC株式会社")).toBe(normalizeName("(株)ABC"));
    expect(normalizeName("ABC株式会社")).toBe("abc");
  });

  it("strips other Japanese corporate suffixes", () => {
    expect(normalizeName("サンプル㈱")).toBe("サンプル");
    expect(normalizeName("有限会社サンプル")).toBe("サンプル");
    expect(normalizeName("合同会社サンプル")).toBe("サンプル");
  });

  it("strips English corporate suffixes case-insensitively", () => {
    expect(normalizeName("Acme Inc.")).toBe(normalizeName("acme inc"));
    expect(normalizeName("Acme Co., Ltd.")).toBe("acme");
    expect(normalizeName("Acme Corp")).toBe("acme");
  });

  it("strips honorifics 様 and さん", () => {
    expect(normalizeName("山田様")).toBe("山田");
    expect(normalizeName("山田さん")).toBe("山田");
    expect(normalizeName("山田")).toBe("山田");
  });

  it("is whitespace and case insensitive", () => {
    expect(normalizeName("  ABC 株式会社  ")).toBe("abc");
    expect(normalizeName("ａｂｃ")).toBe("abc"); // full-width via NFKC
  });

  it("treats different companies as different", () => {
    expect(normalizeName("ABC株式会社")).not.toBe(normalizeName("XYZ株式会社"));
  });
});

describe("normalizeEmail / domainOfEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Foo@Example.COM ")).toBe("foo@example.com");
  });

  it("extracts the domain", () => {
    expect(domainOfEmail("yamada@abc.co.jp")).toBe("abc.co.jp");
    expect(domainOfEmail("no-at-sign")).toBeUndefined();
  });
});

describe("canonicalizeText", () => {
  it("normalizes CRLF to LF", () => {
    expect(canonicalizeText("a\r\nb")).toBe("a\nb");
  });

  it("collapses runs of spaces/tabs/fullwidth spaces to one", () => {
    expect(canonicalizeText("a   b\tc　d")).toBe("a b c d");
  });

  it("trims leading/trailing whitespace", () => {
    expect(canonicalizeText("  hello  ")).toBe("hello");
  });

  it("makes texts differing only in whitespace canonicalize identically", () => {
    expect(canonicalizeText("今日  ABC の山田さんと話した"))
      .toBe(canonicalizeText("今日 ABC の山田さんと話した"));
  });
});

describe("sha256Hex", () => {
  it("produces a 64-char hex digest", async () => {
    const hash = await sha256Hex("hello");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", async () => {
    expect(await sha256Hex("abc")).toBe(await sha256Hex("abc"));
  });

  it("differs for different input", async () => {
    expect(await sha256Hex("abc")).not.toBe(await sha256Hex("abd"));
  });
});

describe("isIsoDateTime / isIsoDate", () => {
  it("accepts valid ISO date-times", () => {
    expect(isIsoDateTime("2026-09-08T10:00:00+09:00")).toBe(true);
    expect(isIsoDateTime("2026-09-08T10:00:00Z")).toBe(true);
  });

  it("rejects non-ISO or invalid values", () => {
    expect(isIsoDateTime("来週")).toBe(false);
    expect(isIsoDateTime(null)).toBe(false);
    expect(isIsoDateTime("2026-13-40T99:99:99")).toBe(false);
  });

  it("validates plain ISO dates", () => {
    expect(isIsoDate("2026-09-08")).toBe(true);
    expect(isIsoDate("2026-09-08T10:00:00Z")).toBe(false);
    expect(isIsoDate("not-a-date")).toBe(false);
  });
});

describe("formatLocal / localDate (Asia/Tokyo)", () => {
  it("converts a UTC instant to Asia/Tokyo local time with offset info", () => {
    // 2026-09-08T01:00:00Z = 2026-09-08T10:00 JST (UTC+9), a Tuesday.
    const formatted = formatLocal("2026-09-08T01:00:00Z", "Asia/Tokyo");
    expect(formatted).toBe("2026-09-08T10:00 (Tue, Asia/Tokyo)");
  });

  it("rolls the calendar date over at the Tokyo midnight boundary", () => {
    // 2026-09-07T15:30:00Z = 2026-09-08T00:30 JST -> local date is the 8th, not the 7th.
    expect(localDate("2026-09-07T15:30:00Z", "Asia/Tokyo")).toBe("2026-09-08");
    expect(localDate("2026-09-07T10:00:00Z", "Asia/Tokyo")).toBe("2026-09-07");
  });
});

describe("formatDateTimeJa (Asia/Tokyo)", () => {
  it("renders an on-the-hour instant without minutes (e.g. the extraction prompt's 18:00 default)", () => {
    // 2026-09-15T09:00:00Z = 2026-09-15T18:00 JST.
    expect(formatDateTimeJa("2026-09-15T09:00:00Z", "Asia/Tokyo")).toBe("2026年9月15日18時");
  });

  it("includes minutes when not on the hour", () => {
    // 2026-09-15T09:30:00Z = 2026-09-15T18:30 JST.
    expect(formatDateTimeJa("2026-09-15T09:30:00Z", "Asia/Tokyo")).toBe("2026年9月15日18時30分");
  });

  it("never leaks a raw ISO timestamp or a confidence number", () => {
    const formatted = formatDateTimeJa("2026-09-15T09:00:00+09:00", "Asia/Tokyo");
    expect(formatted).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(formatted).not.toContain("confidence");
  });
});

describe("addDays", () => {
  it("adds whole days preserving time-of-day", () => {
    expect(addDays("2026-09-08T01:00:00.000Z", 3)).toBe("2026-09-11T01:00:00.000Z");
  });

  it("supports negative offsets", () => {
    expect(addDays("2026-09-08T01:00:00.000Z", -1)).toBe("2026-09-07T01:00:00.000Z");
  });
});

describe("clamp01", () => {
  it("clamps into [0,1] and maps NaN to 0", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(NaN)).toBe(0);
  });
});

describe("fixedClock / nowIso / newId", () => {
  it("fixedClock always returns the same instant", () => {
    const clock = fixedClock("2026-09-08T01:00:00Z");
    expect(clock.now()).toBe(clock.now());
    expect(nowIso(clock)).toBe("2026-09-08T01:00:00.000Z");
  });

  it("throws for an invalid ISO string", () => {
    expect(() => fixedClock("not-a-date")).toThrow(TypeError);
  });

  it("newId returns unique-looking UUIDs", () => {
    const a = newId();
    const b = newId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
  });
});
