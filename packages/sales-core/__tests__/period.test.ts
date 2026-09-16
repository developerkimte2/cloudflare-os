import { describe, expect, it } from "vitest";
import { periodLabel, resolvePeriod } from "../src/rules/period.js";

const TZ = "Asia/Tokyo";

describe("resolvePeriod (F1)", () => {
  const sep8 = "2026-09-08T01:00:00Z";
  it("this / last month", () => {
    expect(resolvePeriod("THIS_MONTH", sep8, TZ, 4)).toEqual({ from: "2026-09-01", to: "2026-10-01" });
    expect(resolvePeriod("LAST_MONTH", sep8, TZ, 4)).toEqual({ from: "2026-08-01", to: "2026-09-01" });
    expect(resolvePeriod("LAST_MONTH", "2026-01-15T00:00:00Z", TZ, 4)).toEqual({ from: "2025-12-01", to: "2026-01-01" });
  });
  it("fiscal year starting in April: September is Q2 of FY2026; March 2027 is Q4 of FY2026", () => {
    expect(resolvePeriod("THIS_QUARTER", sep8, TZ, 4)).toEqual({ from: "2026-07-01", to: "2026-10-01" });
    expect(resolvePeriod("THIS_FY", sep8, TZ, 4)).toEqual({ from: "2026-04-01", to: "2027-04-01" });
    expect(resolvePeriod("LAST_FY", sep8, TZ, 4)).toEqual({ from: "2025-04-01", to: "2026-04-01" });
    expect(resolvePeriod("THIS_QUARTER", "2027-03-10T00:00:00Z", TZ, 4)).toEqual({ from: "2027-01-01", to: "2027-04-01" });
    expect(resolvePeriod("THIS_FY", "2027-03-10T00:00:00Z", TZ, 4)).toEqual({ from: "2026-04-01", to: "2027-04-01" });
  });
  it("fiscal year starting in January", () => {
    expect(resolvePeriod("THIS_QUARTER", sep8, TZ, 1)).toEqual({ from: "2026-07-01", to: "2026-10-01" });
    expect(resolvePeriod("THIS_FY", sep8, TZ, 1)).toEqual({ from: "2026-01-01", to: "2027-01-01" });
  });
  it("custom period is validated", () => {
    expect(resolvePeriod({ from: "2026-01-01", to: "2026-02-01" }, sep8, TZ, 4)).toEqual({ from: "2026-01-01", to: "2026-02-01" });
    expect(() => resolvePeriod({ from: "2026-02-01", to: "2026-01-01" }, sep8, TZ, 4)).toThrow();
  });
  it("labels", () => {
    expect(periodLabel({ from: "2026-09-01", to: "2026-10-01" }, "THIS_MONTH", 4)).toBe("2026年9月");
    expect(periodLabel({ from: "2026-07-01", to: "2026-10-01" }, "THIS_QUARTER", 4)).toBe("2026年度 第2四半期");
    expect(periodLabel({ from: "2026-04-01", to: "2026-06-30" }, undefined, 4)).toBe("2026-04-01〜2026-06-29");
  });
});
