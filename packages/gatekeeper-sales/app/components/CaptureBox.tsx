import { useState } from "react";
import type { CaptureOptions, CaptureResult } from "../../src/management-types";
import { localInputToIso } from "../format";
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
  onCapture,
  onOpenOpportunity,
  onResolveReview,
  onDismissReview,
}: {
  timezone: string;
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

  return (
    <div className="rounded-xl border border-kumo-line bg-kumo-control p-3.5">
      <textarea
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        placeholder="貼る、または書く（メール、議事録、雑な一言でもOK）"
        rows={4}
        className="w-full resize-none rounded-lg border border-kumo-line bg-kumo-base p-2.5 text-sm text-kumo-default outline-none placeholder:text-kumo-inactive focus:border-kumo-ring focus:ring-1 focus:ring-kumo-ring/20"
      />
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
        </div>
      )}
      {result && (
        <CaptureResultView
          result={result}
          timezone={timezone}
          onOpenOpportunity={onOpenOpportunity}
          onResolveReview={onResolveReview}
          onDismissReview={onDismissReview}
          onRetry={() => void submit(lastText, lastOptions)}
        />
      )}
    </div>
  );
}
