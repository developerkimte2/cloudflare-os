import type { RpcStub } from "capnweb";
import { useState } from "react";
import type { CaptureResult, SalesManagementApi, WhoAmI } from "../../src/management-types";
import { useApiAction } from "../api";
import { CaptureResultView } from "./CaptureResultView";

/**
 * A small "take a note against this deal" box for the opportunity detail page. Unlike the main
 * capture box (Today page), this always pins the memo to `opportunityId` — customer/deal
 * resolution is skipped entirely server-side (CaptureOptions.opportunityId), so a memo with no
 * company name at all (or one that happens to mention an unrelated company) still attaches here
 * with no "which customer/deal is this?" review at all: the destination was never in question
 * (2026-09-14 finding: this is the intended way to avoid the "no company name → stray placeholder
 * deal" problem, by letting the rep say where a memo goes instead of asking the AI to guess).
 * No question-mode / audio / batch-paste here — that's the main capture box's job.
 */
export function PinnedCaptureBox({
  api,
  opportunityId,
  timezone,
  ai,
  onOpenOpportunity,
  onResolveReview,
  onDismissReview,
  onAdoptSuggestion,
  onDismissSuggestion,
  onCaptured,
}: {
  api: RpcStub<SalesManagementApi>;
  opportunityId: string;
  timezone: string;
  ai: WhoAmI["ai"];
  onOpenOpportunity: (opportunityId: string) => void;
  onResolveReview: (id: string, optionId: string, input?: Record<string, unknown>) => void | Promise<void>;
  onDismissReview: (id: string) => void | Promise<void>;
  onAdoptSuggestion: (decisionId: string, index: number) => void | Promise<void>;
  onDismissSuggestion: (decisionId: string, index: number) => void | Promise<void>;
  /** Called after a successful (non-duplicate) capture, so the page refreshes its own data. */
  onCaptured: () => void;
}) {
  const runAction = useApiAction();
  const [text, setText] = useState("");
  const [lastText, setLastText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CaptureResult>();

  const submit = async (body: string) => {
    if (!body.trim() || submitting) return;
    setSubmitting(true);
    setLastText(body);
    try {
      const captured = await runAction(() => api.capture(body, { opportunityId }), "取り込みに失敗しました");
      if (captured) {
        setResult(captured);
        setText("");
        onCaptured();
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-xl border border-kumo-line bg-kumo-control p-3.5">
      <label className="block text-xs font-medium text-kumo-inactive">この案件のメモを取り込む</label>
      <textarea
        rows={3}
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        placeholder="電話・訪問の内容を貼り付け…（この案件に確定で紐付きます）"
        className="mt-1.5 w-full resize-none rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default placeholder:text-kumo-inactive"
      />
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          disabled={!text.trim() || submitting}
          onClick={() => void submit(text)}
          className="press rounded-lg bg-kumo-brand px-3.5 py-1.5 text-sm font-medium text-white hover:bg-kumo-brand-hover disabled:opacity-50"
        >
          {submitting ? "取り込み中…" : "この案件に取り込む"}
        </button>
      </div>
      {result && (
        <CaptureResultView
          result={result}
          timezone={timezone}
          ai={ai}
          onOpenOpportunity={onOpenOpportunity}
          onResolveReview={onResolveReview}
          onDismissReview={onDismissReview}
          onAdoptSuggestion={onAdoptSuggestion}
          onDismissSuggestion={onDismissSuggestion}
          onRetry={() => void submit(lastText)}
        />
      )}
    </div>
  );
}
