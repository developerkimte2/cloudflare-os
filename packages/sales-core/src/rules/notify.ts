/**
 * Notification text templates (plans/sales-os-notify.md, 設計書 §20.1). Deterministic string
 * building only — no LLM call, no side effects, no DB access — so callers (the scheduler callback
 * in gatekeeper-sales) can format first and decide whether to send afterward (dedup, §20.2).
 */
import type { TodayView } from "../api/dto.js";
import { formatDateTimeJa } from "../domain/util.js";

export const MORNING_BRIEF_NOTIFICATION_TYPE = "morning_brief";

/** `messageHash` for a Morning Brief on `localDate` (the user's calendar date, e.g. "2026-09-10"). */
export function morningBriefMessageHash(localDate: string): string {
  return `${MORNING_BRIEF_NOTIFICATION_TYPE}:${localDate}`;
}

/**
 * Builds one user's Morning Brief (設計書 §20.1 A). Today ships without a 今日の予定 section — that
 * needs calendar data (plans/sales-os-calendar.md, not yet built) — and folds the remaining three
 * items (重要NextAction / 期限超過 / 注意案件) from the same `TodayView` the app's Today page already
 * shows, so nothing new has to be computed for it.
 */
export function buildMorningBrief(today: TodayView): string {
  const timezone = today.user.timezone || "Asia/Tokyo";
  const overdue = today.now.filter(a => a.overdue);
  const dueToday = today.now.filter(a => !a.overdue);

  const lines: string[] = [`【Morning Brief】${today.date} ${today.user.displayName}さん`];

  if (overdue.length > 0) {
    lines.push("", `期限超過 (${overdue.length}件)`);
    for (const item of overdue) {
      const due = item.action.dueAt ? formatDateTimeJa(item.action.dueAt, timezone) : "期限なし";
      lines.push(`・${item.action.title} - ${item.opportunity.accountName} (期限 ${due})`);
    }
  }

  if (dueToday.length > 0) {
    lines.push("", `今日やること (${dueToday.length}件)`);
    for (const item of dueToday) {
      const due = item.action.dueAt ? formatDateTimeJa(item.action.dueAt, timezone) : "期限なし";
      lines.push(`・${item.action.title} - ${item.opportunity.accountName} (期限 ${due})`);
    }
  }

  if (today.attention.length > 0) {
    lines.push("", `注意案件 (${today.attention.length}件)`);
    for (const item of today.attention) {
      lines.push(`・${item.opportunity.accountName}: ${item.message}`);
    }
  }

  if (overdue.length === 0 && dueToday.length === 0 && today.attention.length === 0) {
    lines.push("", "今日は特に注意事項はありません。");
  }

  return lines.join("\n");
}
