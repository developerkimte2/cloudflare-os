/**
 * Turns whatever a person pastes for a Google Sheets share link (the normal /edit URL, one with a
 * #gid= fragment, or the /export?format=csv URL itself) into the CSV export URL. Pure string
 * handling -- no fetch here, so it's testable without a network.
 */
export function toCsvExportUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new TypeError("Google スプレッドシートの URL を入力してください");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new TypeError("URL の形式が正しくありません");
  }
  if (url.hostname !== "docs.google.com") {
    throw new TypeError("docs.google.com のスプレッドシート URL を入力してください");
  }
  const match = url.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
  if (!match) throw new TypeError("スプレッドシートの URL の形式が正しくありません");
  const id = match[1];
  const gid = url.searchParams.get("gid") ?? url.hash.match(/gid=(\d+)/)?.[1];
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ""}`;
}
