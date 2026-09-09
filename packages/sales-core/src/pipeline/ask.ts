/**
 * Deterministic support for the capture box's "ask a question" mode (「＊＊の状況どうなっている？」):
 * recognizing that pasted text is a question about existing opportunities rather than something to
 * capture, and picking which opportunities are relevant enough to hand to the LLM as context. No
 * LLM/DB calls happen here — `SalesService.askQuestion` does the LLM call; this module only decides
 * *whether* and *what* to send it, the same split as `split.ts` for capture batching.
 */

const QUESTION_KEYWORDS = ["状況", "どうなっている", "どうなってる", "どうなった", "進捗", "ステータス"];

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

/** Below this length, an account/title substring is too generic to match on reliably. */
const MIN_MATCH_LENGTH = 2;

/**
 * Opportunities the question is plausibly about: the account name or the opportunity title appears
 * verbatim in the question text. Substring matching only (no fuzzy/NLP matching) so the result is
 * auditable and reproducible; a name the user doesn't spell out won't match, and the caller
 * (`SalesService.askQuestion`) falls back to recently-updated opportunities in that case.
 */
export function matchOpportunities<T extends AskableOpportunity>(opportunities: T[], question: string): T[] {
  const q = question.trim();
  if (!q) return [];
  const hits = (s: string) => s.trim().length >= MIN_MATCH_LENGTH && q.includes(s.trim());
  return opportunities.filter((o) => hits(o.accountName) || hits(o.title));
}
