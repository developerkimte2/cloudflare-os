/**
 * Deterministic support for the capture box's "ask a question" mode (「＊＊の状況どうなっている？」):
 * recognizing that pasted text is a question about existing opportunities rather than something to
 * capture, and picking which opportunities are relevant enough to hand to the LLM as context. No
 * LLM/DB calls happen here — `SalesService.askQuestion` does the LLM call; this module only decides
 * *whether* and *what* to send it, the same split as `split.ts` for capture batching.
 */
import { normalizeName } from "../domain/util.js";

const QUESTION_KEYWORDS = [
  "状況", "どうなっている", "どうなってる", "どうなった", "進捗", "ステータス",
  // A request directed at the assistant ("ABC社の情報を教えてほしい") rather than a report of a
  // customer interaction -- without this, it falls through to a capture and the AI, seeing a real
  // company name in the text, creates a phantom opportunity for it (2026-09-14 finding).
  "教えて", "知りたい",
];

/** Above this length, treat the text as a capture even if it happens to contain a question mark. */
const MAX_QUESTION_LENGTH = 100;

/**
 * True when `text` reads as a short question about a case ("ABC社の状況どうなっている？") rather than
 * something to capture (a pasted email, meeting note, or daily report). Deliberately conservative:
 * requires a question mark or one of a small set of status-asking phrases, and a short length.
 * Anything longer, or without either signal, stays a capture — a false positive here would silently
 * drop a real capture instead of extracting it.
 */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > MAX_QUESTION_LENGTH) return false;
  if (t.endsWith("?") || t.endsWith("？")) return true;
  return QUESTION_KEYWORDS.some((k) => t.includes(k));
}

export interface AskableOpportunity {
  id: string;
  accountName: string;
  title: string;
}

/** Below this length, an account name substring is too generic to match on reliably. */
const MIN_ACCOUNT_MATCH_LENGTH = 2;
/**
 * Titles are more likely to contain generic words (a default "案件", a repeated product name
 * shared across many opportunities) than account names, so title-only matches need a longer,
 * more specific substring before they're trusted.
 */
const MIN_TITLE_MATCH_LENGTH = 4;

/**
 * Opportunities the question is plausibly about: the account name or the opportunity title appears
 * in the question text. Substring matching only (no fuzzy/NLP matching) so the result is auditable
 * and reproducible; a name the user doesn't spell out won't match, and the caller
 * (`SalesService.askQuestion`) falls back to recently-updated opportunities in that case.
 *
 * Account name matches take priority over title matches: when the question names an account, every
 * opportunity for a *different* account is almost certainly not what was asked about, so title hits
 * elsewhere would only dilute the answer with irrelevant cases. Title matching only kicks in when no
 * account name matched at all.
 *
 * Account names are tried two ways: verbatim first, then with the corporate suffix stripped
 * (`normalizeName`, e.g. "株式会社ネオリンク" -> "ネオリンク") against a same-normalized question — a
 * spoken/colloquial question very often drops "株式会社" ("ネオリンクの状況は？") even though the
 * registered name carries it.
 */
export function matchOpportunities<T extends AskableOpportunity>(opportunities: T[], question: string): T[] {
  const q = question.trim();
  if (!q) return [];
  const hits = (s: string, minLength: number, text: string) => s.trim().length >= minLength && text.includes(s.trim());

  const byAccount = opportunities.filter((o) => hits(o.accountName, MIN_ACCOUNT_MATCH_LENGTH, q));
  if (byAccount.length > 0) return byAccount;

  const normalizedQuestion = normalizeName(q);
  const byAccountCore = opportunities.filter(
    (o) => hits(normalizeName(o.accountName), MIN_ACCOUNT_MATCH_LENGTH, normalizedQuestion));
  if (byAccountCore.length > 0) return byAccountCore;

  return opportunities.filter((o) => hits(o.title, MIN_TITLE_MATCH_LENGTH, q));
}
