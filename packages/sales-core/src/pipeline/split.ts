/**
 * Deterministic splitting of a pasted capture into multiple records (計画書 FB_20260908 item D).
 *
 * The capture pipeline is "1 取り込み = 1 Activity + 1 Opportunity" (`applyExtraction` in
 * `ingest.ts`); pasting many customers' notes as one block does not fan out into many
 * opportunities, and the LLM only extracts a handful of them before its output is truncated by
 * the schema's array caps. This module never talks to the LLM or the DB — it is a pure text
 * heuristic the UI uses to offer "captured N records, take them one at a time?" instead of
 * silently mangling a bulk paste. No rule here is applied automatically; the caller decides.
 */

/** How the text was recognized as multiple records, if at all. */
export type SplitRule = "heading" | "blank-lines" | "none";

export interface SplitResult {
  chunks: string[];
  rule: SplitRule;
}

/** A line that is *only* a `【...】`-style heading (1-40 chars inside), e.g. "【営業日報 01】". */
const HEADING_RE = /^【.{1,40}】$/;

/** Safety cap so a pathological paste cannot spawn hundreds of sequential captures. */
const MAX_CHUNKS = 100;

/** Below this, a blank-line-delimited "chunk" is probably a stray paragraph break, not a record. */
const MIN_BLANK_CHUNK_LENGTH = 20;

function nonEmpty(s: string): boolean {
  return s.trim().length > 0;
}

/**
 * Splits `text` into candidate records.
 *
 * - `rule: "heading"` — two or more lines are, by themselves, a `【...】` heading (the format the
 *   sample "営業日報" fixtures use). Each chunk starts at a heading line and runs to the next one
 *   (or the end); any text before the first heading becomes its own leading chunk if non-blank.
 *   Safe to offer automatically: a real heading line essentially never appears by accident.
 * - `rule: "blank-lines"` — no headings, but two-or-more blank lines split the text into 2-100
 *   pieces that are all at least `MIN_BLANK_CHUNK_LENGTH` characters. This is only a *candidate*:
 *   a single email or meeting note commonly has blank-line paragraphs, so the caller must offer
 *   this as an opt-in choice, never apply it by default.
 * - `rule: "none"` — nothing recognized; `chunks` is `[text]` unchanged.
 */
export function splitCaptureText(text: string): SplitResult {
  const lines = text.split(/\r\n|\r|\n/);
  const headingIndices: number[] = [];
  lines.forEach((line, i) => {
    if (HEADING_RE.test(line.trim())) headingIndices.push(i);
  });

  if (headingIndices.length >= 2) {
    const chunks: string[] = [];
    const firstHeading = headingIndices[0]!;
    if (firstHeading > 0) {
      const lead = lines.slice(0, firstHeading).join("\n").trim();
      if (lead) chunks.push(lead);
    }
    for (let k = 0; k < headingIndices.length; k++) {
      const start = headingIndices[k]!;
      const end = k + 1 < headingIndices.length ? headingIndices[k + 1]! : lines.length;
      const chunk = lines.slice(start, end).join("\n").trim();
      if (chunk) chunks.push(chunk);
    }
    return { chunks: chunks.slice(0, MAX_CHUNKS), rule: "heading" };
  }

  const blankPieces = text
    .split(/\n[ \t　]*\n+/)
    .map(piece => piece.trim())
    .filter(nonEmpty)
    .slice(0, MAX_CHUNKS);
  if (blankPieces.length >= 2 && blankPieces.every(piece => piece.length >= MIN_BLANK_CHUNK_LENGTH)) {
    return { chunks: blankPieces, rule: "blank-lines" };
  }

  return { chunks: [text], rule: "none" };
}
