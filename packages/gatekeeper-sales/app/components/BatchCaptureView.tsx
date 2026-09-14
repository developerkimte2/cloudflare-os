import { useEffect, useRef, useState } from "react";
import type { CaptureOptions, CaptureResult, WhoAmI } from "../../src/management-types";
import { AiAttribution } from "./AiAttribution";

type RowState = "pending" | "running" | "accepted" | "done" | "failed";

interface Row {
  chunk: string;
  state: RowState;
  result?: CaptureResult;
}

/** First non-empty line of a chunk, trimmed for display (a 【…】 heading if the split found one). */
function chunkLabel(chunk: string): string {
  const line = chunk.split(/\r?\n/).find((l) => l.trim().length > 0) ?? chunk;
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

function rowSummary(result: CaptureResult): { text: string; tone: "default" | "subtle" | "warning" } {
  if (result.error) return { text: `失敗: ${result.error}`, tone: "warning" };
  if (result.notSalesRelated) return { text: "営業に無関係と判断、取り込みなし", tone: "subtle" };
  if (result.duplicate) return { text: "重複（変更なし）", tone: "subtle" };
  const parts: string[] = [];
  if (result.opportunity) parts.push(`${result.opportunity.accountName} / ${result.opportunity.title}`);
  if (result.reviews.length > 0) parts.push(`確認 ${result.reviews.length} 件`);
  return { text: parts.length > 0 ? parts.join(" ・ ") : "取り込み済み", tone: "default" };
}

/**
 * Runs a set of pre-split capture chunks one at a time (never Promise.all — each capture is its
 * own approval-queue submission and LLM call), with progress, cancel, and a per-chunk summary
 * with retry (FB_20260908 item D). `onCapture` already reports failures via a toast and returns
 * `undefined`; a failed chunk never stops the rest.
 */
export function BatchCaptureView({
  chunks,
  ai,
  onCapture,
  onOpenOpportunity,
  onDone,
}: {
  chunks: string[];
  ai: WhoAmI["ai"];
  onCapture: (
    text: string, options?: CaptureOptions, onAccepted?: () => void,
  ) => Promise<CaptureResult | undefined>;
  onOpenOpportunity: (opportunityId: string) => void;
  onDone: () => void;
}) {
  const [rows, setRows] = useState<Row[]>(() => chunks.map((chunk) => ({ chunk, state: "pending" })));
  const [running, setRunning] = useState(false);
  const cancelledRef = useRef(false);

  const runFrom = async (startIndex: number) => {
    setRunning(true);
    cancelledRef.current = false;
    for (let i = startIndex; i < chunks.length; i++) {
      if (cancelledRef.current) break;
      setRows((current) => current.map((r, idx) => (idx === i ? { ...r, state: "running" } : r)));
      const result = await onCapture(chunks[i]!, undefined, () =>
        setRows((current) => current.map((r, idx) => (idx === i && r.state === "running" ? { ...r, state: "accepted" } : r))));
      setRows((current) =>
        current.map((r, idx) =>
          idx === i ? { ...r, state: result ? "done" : "failed", result } : r,
        ),
      );
    }
    setRunning(false);
  };

  useEffect(() => {
    void runFrom(0);
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once for this fixed chunk set
  }, []);

  const doneCount = rows.filter((r) => r.state === "done" || r.state === "failed").length;
  const failedCount = rows.filter((r) => r.state === "failed").length;
  const finished = !running && doneCount === rows.length;

  const retryOne = (index: number) => {
    setRows((current) => current.map((r, idx) => (idx === index ? { ...r, state: "running" } : r)));
    void onCapture(chunks[index]!, undefined, () =>
      setRows((current) => current.map((r, idx) => (idx === index && r.state === "running" ? { ...r, state: "accepted" } : r))))
      .then((result) => {
        setRows((current) =>
          current.map((r, idx) => (idx === index ? { ...r, state: result ? "done" : "failed", result } : r)),
        );
      });
  };

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-kumo-line bg-kumo-elevated px-3.5 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-kumo-default">
          {finished
            ? `${rows.length} 件の取り込みが完了しました${failedCount > 0 ? `（失敗 ${failedCount} 件）` : ""}`
            : `${doneCount} / ${rows.length} 取り込み中…`}
        </p>
        <div className="flex items-center gap-2">
          <AiAttribution ai={ai} />
          {running && (
            <button
              type="button"
              onClick={() => {
                cancelledRef.current = true;
              }}
              className="press rounded-md border border-kumo-line px-2 py-1 text-xs font-medium hover:bg-kumo-tint"
            >
              中止
            </button>
          )}
          {finished && (
            <button
              type="button"
              onClick={onDone}
              className="press rounded-md bg-kumo-brand px-2.5 py-1 text-xs font-medium text-white hover:bg-kumo-brand-hover"
            >
              閉じる
            </button>
          )}
        </div>
      </div>

      <div className="divide-y divide-kumo-line rounded-lg border border-kumo-line">
        {rows.map((row, index) => {
          const summary = row.result ? rowSummary(row.result) : undefined;
          return (
            <div key={index} className="flex items-center gap-3 px-3 py-2 text-xs">
              <span className="w-6 shrink-0 text-right text-kumo-inactive">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate text-kumo-default" title={row.chunk}>
                {chunkLabel(row.chunk)}
              </span>
              <span className="shrink-0">
                {row.state === "pending" && <span className="text-kumo-inactive">待機中</span>}
                {row.state === "running" && <span className="text-kumo-inactive">取り込み中…</span>}
                {row.state === "accepted" && <span className="text-kumo-inactive">受付済み・処理中…</span>}
                {row.state === "done" && summary && (
                  <button
                    type="button"
                    disabled={!row.result?.opportunity}
                    onClick={() => row.result?.opportunity && onOpenOpportunity(row.result.opportunity.id)}
                    className={`truncate text-left ${
                      row.result?.opportunity ? "text-kumo-link hover:underline" : "text-kumo-subtle"
                    }`}
                  >
                    {summary.text}
                  </button>
                )}
                {row.state === "failed" && (
                  <span className="flex items-center gap-2">
                    <span className="text-kumo-danger">{summary?.text ?? "失敗"}</span>
                    <button
                      type="button"
                      onClick={() => retryOne(index)}
                      className="press rounded-md border border-kumo-line px-1.5 py-0.5 font-medium hover:bg-kumo-tint"
                    >
                      再試行
                    </button>
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
