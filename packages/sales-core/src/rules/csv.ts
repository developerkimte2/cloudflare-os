/**
 * CSV encode/decode (F3 export, and the company-DB sheet import). Pure functions -- no LLM/DB
 * access -- so both directions can be unit-tested without a database.
 */

/** RFC 4180 with CRLF and a UTF-8 BOM so Excel on Windows opens it as UTF-8. */
export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(esc).join(","), ...rows.map(r => r.map(esc).join(","))];
  return "﻿" + lines.join("\r\n") + "\r\n";
}

export const CSV_MAX_ROWS = 5000;

/**
 * Parses RFC 4180 CSV (as produced by `toCsv`, Excel, or Google Sheets' CSV export) into rows of
 * cells. Handles a leading BOM, CRLF/LF/CR line endings, quoted fields (with embedded commas,
 * newlines, and doubled `""` for a literal quote), and a trailing blank line.
 */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  while (i < src.length) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"') { inQuotes = true; i += 1; continue; }
    if (c === ",") { pushField(); i += 1; continue; }
    if (c === "\r") {
      pushRow(); i += 1;
      if (src[i] === "\n") i += 1; // CRLF: the \n is part of the same line break, don't double it
      continue;
    }
    if (c === "\n") { pushRow(); i += 1; continue; } // bare LF (no preceding \r)
    field += c; i += 1;
  }
  // Trailing row: only if there's a field in progress or a non-empty row already started (avoids
  // an extra [""], [] row for input that ends with a newline).
  if (field !== "" || row.length > 0) pushRow();
  return rows;
}

/** Rows as {header: value} objects, keyed by the first row. Extra/missing columns are tolerated. */
export function parseCsvRecords(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  const headers = rows[0] ?? [];
  return rows.slice(1)
    .filter(r => r.some(cell => cell.trim() !== ""))
    .map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
}
