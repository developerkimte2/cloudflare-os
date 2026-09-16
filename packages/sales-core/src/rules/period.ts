/**
 * Reporting periods (F1): month / quarter / fiscal year presets resolved against a fiscal year
 * start month, plus a validated custom range. Pure functions -- no LLM/DB access.
 */
import { addDays, localDate } from "../domain/util.js";

/** [from, to) as YYYY-MM-DD local dates. */
export interface Period { from: string; to: string }
export type PeriodPreset = "THIS_MONTH" | "LAST_MONTH" | "THIS_QUARTER" | "THIS_FY" | "LAST_FY";
export const PERIOD_PRESETS: PeriodPreset[] = ["THIS_MONTH", "LAST_MONTH", "THIS_QUARTER", "THIS_FY", "LAST_FY"];

function ymd(y: number, m: number): string {           // m: 1..12, may overflow/underflow
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toISOString().slice(0, 10);
}

/** Resolves a preset (or passes a custom period through, validated) against a local "today". */
export function resolvePeriod(
  input: PeriodPreset | Period | undefined, nowIso: string, timeZone: string, fiscalYearStartMonth: number,
): Period {
  if (input && typeof input === "object") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.from) || !/^\d{4}-\d{2}-\d{2}$/.test(input.to) || input.from >= input.to) {
      throw new TypeError("期間は YYYY-MM-DD で、開始 < 終了 にしてください");
    }
    return input;
  }
  const today = localDate(nowIso, timeZone);
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  const fyStart = Math.min(12, Math.max(1, fiscalYearStartMonth || 1));
  // Fiscal year containing `today` starts in year fyYear, month fyStart.
  const fyYear = m >= fyStart ? y : y - 1;
  switch (input ?? "THIS_MONTH") {
    case "THIS_MONTH": return { from: ymd(y, m), to: ymd(y, m + 1) };
    case "LAST_MONTH": return { from: ymd(y, m - 1), to: ymd(y, m) };
    case "THIS_QUARTER": {
      const offset = (m - fyStart + 12) % 12;               // months since FY start
      const qStart = fyStart + Math.floor(offset / 3) * 3;    // may exceed 12; ymd handles overflow
      return { from: ymd(fyYear, qStart), to: ymd(fyYear, qStart + 3) };
    }
    case "THIS_FY": return { from: ymd(fyYear, fyStart), to: ymd(fyYear + 1, fyStart) };
    case "LAST_FY": return { from: ymd(fyYear - 1, fyStart), to: ymd(fyYear, fyStart) };
  }
}

/** "2026年9月", "2026年度 第2四半期", "2026年度", or "2026-04-01〜2026-06-30" for custom. */
export function periodLabel(period: Period, preset: PeriodPreset | undefined, fiscalYearStartMonth: number): string {
  const y = Number(period.from.slice(0, 4)), m = Number(period.from.slice(5, 7));
  const fyStart = Math.min(12, Math.max(1, fiscalYearStartMonth || 1));
  const fyYear = m >= fyStart ? y : y - 1;
  switch (preset) {
    case "THIS_MONTH": case "LAST_MONTH": return `${y}年${m}月`;
    case "THIS_QUARTER": return `${fyYear}年度 第${Math.floor(((m - fyStart + 12) % 12) / 3) + 1}四半期`;
    case "THIS_FY": case "LAST_FY": return `${fyYear}年度`;
    default: return `${period.from}〜${addDays(`${period.to}T00:00:00Z`, -1).slice(0, 10)}`;
  }
}
