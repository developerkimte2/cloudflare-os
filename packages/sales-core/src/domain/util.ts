/** Small, dependency-free helpers shared by every layer. */

export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(clock: Clock = systemClock): string {
  return new Date(clock.now()).toISOString();
}

/** Injectable time source so tests and fixtures are deterministic. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export function fixedClock(iso: string): Clock {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new TypeError(`fixedClock: invalid ISO time ${iso}`);
  return { now: () => ms };
}

/**
 * Normalizes a company / person name for exact-match comparison (設計書 §13 表記揺れ対策):
 * NFKC, lowercase, strips whitespace and common Japanese/English corporate suffixes.
 */
export function normalizeName(name: string): string {
  let s = name.normalize("NFKC").toLowerCase();
  s = s.replace(/[\s　]+/g, "");
  s = s.replace(/[()（）「」『』・,.，．'’"“”-]/g, "");
  const suffixes = [
    "株式会社", "(株)", "㈱", "有限会社", "合同会社", "合資会社", "一般社団法人", "一般財団法人",
    "kabushikigaisha", "co,ltd", "coltd", "co.,ltd.", "inc", "incorporated", "corp", "corporation",
    "ltd", "limited", "llc", "gk", "kk",
  ].map(x => x.replace(/[()（）,.]/g, ""));
  for (const suffix of suffixes) {
    if (s.startsWith(suffix)) s = s.slice(suffix.length);
    if (s.endsWith(suffix)) s = s.slice(0, s.length - suffix.length);
  }
  s = s.replace(/(様|さん|殿|氏)$/u, "");
  return s;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function domainOfEmail(email: string): string | undefined {
  const at = email.lastIndexOf("@");
  return at < 0 ? undefined : email.slice(at + 1).toLowerCase();
}

/** SHA-256 hex of a UTF-8 string, for content deduplication (設計書 NFR-04). */
export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Whitespace-insensitive canonical form used before hashing a captured text. */
export function canonicalizeText(text: string): string {
  return text.normalize("NFKC").replace(/\r\n?/g, "\n").replace(/[ \t　]+/g, " ").trim();
}

export function isIsoDateTime(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) &&
    !Number.isNaN(Date.parse(value));
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value));
}

/** Formats an instant in a timezone as `YYYY-MM-DDTHH:mm` plus the zone's offset (for prompts). */
export function formatLocal(iso: string, timeZone: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short",
  }).formatToParts(d);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")} (${get("weekday")}, ${timeZone})`;
}

/** Human-facing Japanese rendering for review/question text, e.g. "9月15日(火) 18:00". */
export function formatDateTimeJa(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone, hourCycle: "h23",
    month: "long", day: "numeric", weekday: "short",
    hour: "2-digit", minute: "2-digit",
  }).format(new Date(iso));
}

/** Calendar date (`YYYY-MM-DD`) of an instant in a timezone. */
export function localDate(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
