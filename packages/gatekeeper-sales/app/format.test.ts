import { describe, expect, it } from "vitest";
import {
  daysSince,
  formatDate,
  formatDateTime,
  formatDueLabel,
  formatRelativeDay,
  formatTime,
  isOverdue,
  isoToLocalInput,
  localInputToIso,
} from "./format";

describe("isoToLocalInput / localInputToIso", () => {
  it("round-trips a wall-clock time through a timezone", () => {
    const iso = "2026-07-30T14:00:00.000Z"; // 23:00 JST
    expect(isoToLocalInput(iso, "Asia/Tokyo")).toBe("2026-07-30T23:00");
    expect(localInputToIso("2026-07-30T23:00", "Asia/Tokyo")).toBe(iso);
  });

  it("accounts for daylight saving when converting back to UTC", () => {
    // Jul 30 2026 is EDT (UTC-4): 09:00 local == 13:00Z.
    expect(localInputToIso("2026-07-30T09:00", "America/New_York")).toBe("2026-07-30T13:00:00.000Z");
  });

  it("returns empty/undefined for missing or malformed values", () => {
    expect(isoToLocalInput(undefined, "Asia/Tokyo")).toBe("");
    expect(isoToLocalInput(null, "Asia/Tokyo")).toBe("");
    expect(isoToLocalInput("not-a-date", "Asia/Tokyo")).toBe("");
    expect(localInputToIso("", "Asia/Tokyo")).toBeUndefined();
    expect(localInputToIso("garbage", "Asia/Tokyo")).toBeUndefined();
  });
});

describe("formatDate / formatDateTime / formatTime", () => {
  const iso = "2026-07-30T14:05:00.000Z"; // 23:05 JST

  it("renders in the given timezone and locale", () => {
    expect(formatDate(iso, "Asia/Tokyo")).toBe("2026年7月30日");
    expect(formatTime(iso, "Asia/Tokyo")).toBe("23:05");
    expect(formatDateTime(iso, "Asia/Tokyo")).toContain("23:05");
  });

  it("returns an empty string for no value", () => {
    expect(formatDate(undefined, "Asia/Tokyo")).toBe("");
    expect(formatDateTime(null, "Asia/Tokyo")).toBe("");
    expect(formatTime(undefined, "Asia/Tokyo")).toBe("");
  });
});

describe("formatRelativeDay", () => {
  // Fixed "now": 2026-07-30 12:00 JST.
  const now = new Date("2026-07-30T03:00:00.000Z");
  const tz = "Asia/Tokyo";
  const atJstMidnightPlusDays = (days: number) =>
    new Date(Date.UTC(2026, 6, 30 + days, 3, 0, 0)).toISOString();

  it("labels today, tomorrow, and the day after", () => {
    expect(formatRelativeDay(atJstMidnightPlusDays(0), tz, now)).toBe("今日");
    expect(formatRelativeDay(atJstMidnightPlusDays(1), tz, now)).toBe("明日");
    expect(formatRelativeDay(atJstMidnightPlusDays(2), tz, now)).toBe("明後日");
  });

  it("labels yesterday and other days within a week as relative", () => {
    expect(formatRelativeDay(atJstMidnightPlusDays(-1), tz, now)).toBe("昨日");
    expect(formatRelativeDay(atJstMidnightPlusDays(3), tz, now)).toBe("3日後");
    expect(formatRelativeDay(atJstMidnightPlusDays(-5), tz, now)).toBe("5日前");
  });

  it("falls back to an absolute date beyond a week out", () => {
    expect(formatRelativeDay(atJstMidnightPlusDays(8), tz, now)).toBe("2026年8月7日");
    expect(formatRelativeDay(atJstMidnightPlusDays(-8), tz, now)).toBe("2026年7月22日");
  });
});

describe("formatDueLabel", () => {
  it("combines the relative day and clock time", () => {
    const now = new Date("2026-07-30T03:00:00.000Z");
    expect(formatDueLabel("2026-07-30T05:30:00.000Z", "Asia/Tokyo", now)).toBe("今日 14:30");
  });

  it("reports no due date", () => {
    expect(formatDueLabel(undefined, "Asia/Tokyo")).toBe("期限なし");
    expect(formatDueLabel(null, "Asia/Tokyo")).toBe("期限なし");
  });
});

describe("isOverdue", () => {
  const now = new Date("2026-07-30T12:00:00.000Z");

  it("is true for a past instant and false for a future one", () => {
    expect(isOverdue("2026-07-30T11:00:00.000Z", now)).toBe(true);
    expect(isOverdue("2026-07-30T13:00:00.000Z", now)).toBe(false);
  });

  it("is false for no due date", () => {
    expect(isOverdue(undefined, now)).toBe(false);
    expect(isOverdue(null, now)).toBe(false);
  });
});

describe("daysSince", () => {
  it("computes fractional days between an instant and now", () => {
    const now = new Date("2026-08-01T00:00:00.000Z");
    expect(daysSince("2026-07-30T00:00:00.000Z", now)).toBe(2);
    expect(daysSince("2026-07-31T12:00:00.000Z", now)).toBe(0.5);
  });

  it("is undefined for no timestamp", () => {
    expect(daysSince(undefined)).toBeUndefined();
    expect(daysSince(null)).toBeUndefined();
  });
});
