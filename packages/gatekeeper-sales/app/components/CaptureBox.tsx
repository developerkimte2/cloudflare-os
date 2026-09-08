import { useMemo, useState } from "react";
// Deep import via its own package.json "exports" subpath: this leaf module has no DB/LLM code,
// unlike "@gadgets/sales-core" (the package index), which would drag db/node-sqlite's
// `node:sqlite` into the browser bundle (FB_20260908 D).
import { splitCaptureText } from "@gadgets/sales-core/pipeline/split";
import type { CaptureOptions, CaptureResult, WhoAmI } from "../../src/management-types";
import { localInputToIso } from "../format";
import { BatchCaptureView } from "./BatchCaptureView";
import { CaptureResultView } from "./CaptureResultView";

type SourceTypeOption = NonNullable<CaptureOptions["sourceType"]>;

const SOURCE_TYPE_OPTIONS: Array<{ value: SourceTypeOption; label: string }> = [
  { value: "TEXT", label: "テキスト" },
  { value: "EMAIL", label: "メール" },
  { value: "TRANSCRIPT", label: "議事録" },
  { value: "CHAT", label: "チャット" },
];

/**
 * The "話す/貼る" capture box (設計書 UX-02/03): a single textarea plus optional, collapsed metadata.
 * Nothing here is required beyond the text itself.
 */
export function CaptureBox({
  timezone,
  ai,
  onCapture,
  onOpenOpportunity,
  onResolveReview,
  onDismissReview,
}: {
  timezone: string;
  ai: WhoAmI["ai"];
  onCapture: (text: string, options?: CaptureOptions) => Promise<CaptureResult | undefined>;
  onOpenOpportunity: (opportunityId: string) => void;
  onResolveReview: (id: string, optionId: string, input?: Record<string, unknown>) => void | Promise<void>;
  onDismissReview: (id: string) => void | Promise<void>;
}) {
  const [text, setText] = useState("");
  const [showOptions, setShowOptions] = useState(false);
  const [sourceType, setSourceType] = useState<SourceTypeOption | "">("");
  const [occurredAtLocal, setOccurredAtLocal] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CaptureResult>();
  const [lastText, setLastText] = useState("");
  const [lastOptions, setLastOptions] = useState<CaptureOptions | undefined>();
  // Set once the user opts into taking a multi-record paste one record at a time; while set, the
  // normal textarea/submit UI is replaced by BatchCaptureView (FB_20260908 item D).
  const [batchChunks, setBatchChunks] = useState<string[]>();

  const split = useMemo(() => splitCaptureText(text), [text]);
  const headingSplit = split.rule === "heading" && split.chunks.length >= 2 ? split.chunks : undefined;
  const blankLinesSplit = split.rule === "blank-lines" ? split.chunks : undefined;

  const startBatch = (chunks: string[]) => {
    setBatchChunks(chunks);
    setText("");
    setResult(undefined);
  };

  const submit = async (overrideText?: string, overrideOptions?: CaptureOptions) => {
    const body = overrideText ?? text;
    if (!body.trim() || submitting) return;
    const options: CaptureOptions | undefined =
      overrideOptions ??
      (sourceType || occurredAtLocal
        ? {
            sourceType: sourceType || undefined,
            occurredAt: occurredAtLocal ? localInputToIso(occurredAtLocal, timezone) : undefined,
          }
        : undefined);
    setSubmitting(true);
    setLastText(body);
    setLastOptions(options);
    try {
      const captured = await onCapture(body, options);
      if (captured) {
        setResult(captured);
        setText("");
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (batchChunks) {
    return (
      <div className="rounded-xl border border-kumo-line bg-kumo-control p-3.5">
        <BatchCaptureView
          chunks={batchChunks}
          ai={ai}
          onCapture={onCapture}
          onOpenOpportunity={onOpenOpportunity}
          onDone={() => setBatchChunks(undefined)}
        />
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-kumo-line bg-kumo-control p-3.5">
      <textarea
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        placeholder="貼る、または書く（メール、議事録、雑な一言でもOK）"
        rows={4}
        className="w-full resize-none rounded-lg border border-kumo-line bg-kumo-base p-2.5 text-sm text-kumo-default outline-none placeholder:text-kumo-inactive focus:border-kumo-ring focus:ring-1 focus:ring-kumo-ring/20"
      />
      {headingSplit && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-kumo-tint px-2.5 py-2 text-xs text-kumo-subtle">
          <span>{headingSplit.length} 件の記録が含まれているようです。</span>
          <button
            type="button"
            onClick={() => startBatch(headingSplit)}
            className="press rounded-md bg-kumo-brand px-2 py-1 font-medium text-white hover:bg-kumo-brand-hover"
          >
            {headingSplit.length} 件に分けて取り込む
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            className="press rounded-md border border-kumo-line px-2 py-1 font-medium text-kumo-default hover:bg-kumo-base"
          >
            1 件として取り込む
          </button>
        </div>
      )}
      <div className="mt-2 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setShowOptions((v) => !v)}
          className="text-xs text-kumo-subtle hover:text-kumo-default hover:underline"
        >
          {showOptions ? "オプションを隠す" : "オプション"}
        </button>
        <button
          type="button"
          disabled={!text.trim() || submitting}
          onClick={() => void submit()}
          className="press rounded-lg bg-kumo-brand px-4 py-2 text-sm font-medium text-white hover:bg-kumo-brand-hover disabled:opacity-50"
        >
          {submitting ? "取り込み中…" : "取り込む"}
        </button>
      </div>
      {showOptions && (
        <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-kumo-line pt-2.5">
          <label className="flex items-center gap-1.5 text-xs text-kumo-subtle">
            種類
            <select
              value={sourceType}
              onChange={(event) => setSourceType(event.currentTarget.value as SourceTypeOption | "")}
              className="h-7 rounded-md border border-kumo-line bg-kumo-base px-1.5 text-xs text-kumo-default"
            >
              <option value="">自動判定</option>
              {SOURCE_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-kumo-subtle">
            発生日時
            <input
              type="datetime-local"
              value={occurredAtLocal}
              onChange={(event) => setOccurredAtLocal(event.currentTarget.value)}
              className="h-7 rounded-md border border-kumo-line bg-kumo-base px-1.5 text-xs text-kumo-default"
            />
          </label>
          {blankLinesSplit && (
            <button
              type="button"
              onClick={() => startBatch(blankLinesSplit)}
              className="text-xs text-kumo-link hover:underline"
            >
              空行で {blankLinesSplit.length} 件に分けて取り込む
            </button>
          )}
        </div>
      )}
      {result && (
        <CaptureResultView
          result={result}
          timezone={timezone}
          ai={ai}
          onOpenOpportunity={onOpenOpportunity}
          onResolveReview={onResolveReview}
          onDismissReview={onDismissReview}
          onRetry={() => void submit(lastText, lastOptions)}
        />
      )}
    </div>
  );
}
