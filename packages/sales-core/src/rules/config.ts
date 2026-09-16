/**
 * Tunable policy (設計書 §16 confidence 設計, §46 設定項目). Defaults here; overrides come from the
 * `settings` table so nothing is hard-coded into prompts or rules.
 */
import type { Repository } from "../db/repository.js";
import type { TaxCategory } from "../domain/types.js";

export interface SalesConfig {
  /** Auto-link a customer only at or above this (設計書: 0.99). */
  entityAutoConfidence: number;
  /** Accept an activity summary at or above this (設計書: 0.90). */
  activitySummaryConfidence: number;
  /** Store an explicit due date at or above this (設計書: 0.95). */
  dateConfidence: number;
  /** Create an AI next action at or above this (設計書: 0.85). */
  nextActionAutoConfidence: number;
  /** Apply an operational-state change at or above this. */
  stateAutoConfidence: number;
  /** Set expected_amount from a QUOTE/CONTRACT amount at or above this. */
  amountAutoConfidence: number;
  /** Match an existing opportunity at or above this. */
  opportunityAutoConfidence: number;
  /** Days without meaningful activity before an opportunity counts as stalled (設計書: 7). */
  stalledDays: number;
  preMeetingMinutes: number;
  postMeetingCaptureMinutes: number;
  morningDigestTime: string;
  managerEscalationHours: number;
  defaultCurrency: string;
  defaultTimezone: string;
  /** Company-specific phase labels offered in the UI; never a domain constraint. */
  phaseLabels: string[];
  /** Tax rate per 消費税区分 (D2). A rate change here never rewrites existing line items. */
  taxRates: Record<TaxCategory, number>;
  taxRounding: "FLOOR" | "ROUND" | "CEIL";
}

export const DEFAULT_CONFIG: SalesConfig = {
  entityAutoConfidence: 0.99,
  activitySummaryConfidence: 0.9,
  dateConfidence: 0.95,
  nextActionAutoConfidence: 0.85,
  stateAutoConfidence: 0.85,
  amountAutoConfidence: 0.95,
  opportunityAutoConfidence: 0.85,
  stalledDays: 7,
  preMeetingMinutes: 30,
  postMeetingCaptureMinutes: 15,
  morningDigestTime: "08:50",
  managerEscalationHours: 48,
  defaultCurrency: "JPY",
  defaultTimezone: "Asia/Tokyo",
  phaseLabels: [],
  taxRates: { STANDARD: 0.1, REDUCED: 0.08, EXEMPT: 0 },
  taxRounding: "FLOOR",
};

export const CONFIG_SETTING_KEY = "config";

export function loadConfig(repo: Repository): SalesConfig {
  const stored = repo.getSetting<Partial<SalesConfig>>(CONFIG_SETTING_KEY) ?? {};
  const merged: SalesConfig = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(stored)) {
    if (!(key in DEFAULT_CONFIG)) continue;
    const expected = typeof (DEFAULT_CONFIG as unknown as Record<string, unknown>)[key];
    if (typeof value === expected && value !== null && value !== undefined) {
      (merged as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

export function saveConfig(repo: Repository, patch: Partial<SalesConfig>, updatedAt: string): SalesConfig {
  const current = repo.getSetting<Partial<SalesConfig>>(CONFIG_SETTING_KEY) ?? {};
  const next: Partial<SalesConfig> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_CONFIG)) throw new TypeError(`Unknown config key: ${key}`);
    const expected = typeof (DEFAULT_CONFIG as unknown as Record<string, unknown>)[key];
    if (typeof value !== expected) throw new TypeError(`Config ${key} must be a ${expected}`);
    (next as Record<string, unknown>)[key] = value;
  }
  repo.putSetting(CONFIG_SETTING_KEY, next, updatedAt);
  return loadConfig(repo);
}
