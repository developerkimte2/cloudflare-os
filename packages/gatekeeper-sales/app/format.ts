/** Date/time and label helpers, all rendered in a caller-supplied IANA timezone (the user's own). */

const DAY_MS = 24 * 60 * 60 * 1000;

function ymdInZone(date: Date, timeZone: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get("year"), m: get("month"), d: get("day") };
}

/** Milliseconds between the UTC instant that reads as `date`'s wall-clock time in `timeZone`. */
function tzOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asIfUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asIfUtc - date.getTime();
}

/** `YYYY-MM-DDTHH:mm` for an `<input type="datetime-local">`, in `timeZone`. Empty for no value. */
export function isoToLocalInput(iso: string | undefined | null, timeZone: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** Reads back an `<input type="datetime-local">` value as an ISO 8601 UTC instant. */
export function localInputToIso(value: string, timeZone: string): string | undefined {
  if (!value) return undefined;
  const [datePart, timePart] = value.split("T");
  if (!datePart || !timePart) return undefined;
  const [y, m, d] = datePart.split("-").map(Number);
  const [hh, mm] = timePart.split(":").map(Number);
  if ([y, m, d, hh, mm].some((n) => Number.isNaN(n))) return undefined;
  const asUtc = Date.UTC(y, m - 1, d, hh, mm);
  const offset = tzOffsetMs(new Date(asUtc), timeZone);
  return new Date(asUtc - offset).toISOString();
}

export function formatDate(iso: string | undefined | null, timeZone: string, locale = "ja-JP"): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(iso));
}

export function formatDateTime(
  iso: string | undefined | null,
  timeZone: string,
  locale = "ja-JP",
): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function formatTime(iso: string | undefined | null, timeZone: string, locale = "ja-JP"): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** 今日 / 明日 / 明後日 / 昨日 / N日前 / N日後, falling back to an absolute date beyond a week out. */
export function formatRelativeDay(
  iso: string,
  timeZone: string,
  now: Date = new Date(),
  locale = "ja-JP",
): string {
  const target = ymdInZone(new Date(iso), timeZone);
  const today = ymdInZone(now, timeZone);
  const targetUtc = Date.UTC(target.y, target.m - 1, target.d);
  const todayUtc = Date.UTC(today.y, today.m - 1, today.d);
  const diffDays = Math.round((targetUtc - todayUtc) / DAY_MS);
  if (diffDays === 0) return "今日";
  if (diffDays === 1) return "明日";
  if (diffDays === 2) return "明後日";
  if (diffDays === -1) return "昨日";
  if (diffDays > 0 && diffDays <= 7) return `${diffDays}日後`;
  if (diffDays < 0 && diffDays >= -7) return `${-diffDays}日前`;
  return formatDate(iso, timeZone, locale);
}

/** A compact due-date label combining the relative day and the clock time, e.g. "今日 10:00". */
export function formatDueLabel(
  iso: string | undefined | null,
  timeZone: string,
  now: Date = new Date(),
  locale = "ja-JP",
): string {
  if (!iso) return "期限なし";
  return `${formatRelativeDay(iso, timeZone, now, locale)} ${formatTime(iso, timeZone, locale)}`;
}

export function isOverdue(iso: string | undefined | null, now: Date = new Date()): boolean {
  return !!iso && new Date(iso).getTime() < now.getTime();
}

/** Days (can be fractional) since `iso`, or undefined when there is no timestamp. */
export function daysSince(iso: string | undefined | null, now: Date = new Date()): number | undefined {
  if (!iso) return undefined;
  return (now.getTime() - new Date(iso).getTime()) / DAY_MS;
}
