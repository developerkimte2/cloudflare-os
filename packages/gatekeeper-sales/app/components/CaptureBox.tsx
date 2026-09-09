import { useMemo, useState } from "react";
// Deep import via its own package.json "exports" subpath: this leaf module has no DB/LLM code,
// unlike "@gadgets/sales-core" (the package index), which would drag db/node-sqlite's
// `node:sqlite` into the browser bundle (FB_20260908 D).
import { splitCaptureText } from "@gadgets/sales-core/pipeline/split";
import { looksLikeQuestion } from "@gadgets/sales-core/pipeline/ask";
import type { AnswerResult, CaptureOptions, CaptureResult, WhoAmI } from "../../src/management-types";
import { localInputToIso } from "../format";
import { AnswerView } from "./AnswerView";
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
 *
 * Also doubles as a search box: a short line that reads as a question ("ABC社の状況どうなっている？")
 * is routed to `onAsk` instead of `onCapture` (`looksLikeQuestion`, deterministic — see
 * `pipeline/ask.ts`), so the same input answers questions about existing opportunities instead of
 * being captured as a new record.
 */
export function CaptureBox({
  timezone,
  ai,
  onCapture,
  onAsk,
  onOpenOpportunity,
  onResolveReview,
  onDismissReview,
}: {
  timezone: string;
  ai: WhoAmI["ai"];
  onCapture: (text: string, options?: CaptureOptions) => Promise<CaptureResult | undefined>;
  onAsk: (question: string) => Promise<AnswerResult | undefined>;
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
  const [answer, setAnswer] = useState<AnswerResult>();
  const [lastText, setLastText] = useState("");
  const [lastOptions, setLastOptions] = useState<CaptureOptions | undefined>();
  // Set once the user opts into taking a multi-record paste one record at a time; while set, the
  // normal textarea/submit UI is replaced by BatchCaptureView (FB_20260908 item D).
  const [batchChunks, setBatchChunks] = useState<string[]>();

  const split = useMemo(() => splitCaptureText(text), [text]);
  const headingSplit = split.rule === "heading" && split.chunks.length >= 2 ? split.chunks : undefined;
  const blankLinesSplit = split.rule === "blank-lines" ? split.chunks : undefined;
  // Explicit options (source type / occurred-at) signal an intentional capture, so a question-like
  // text with options set is still captured rather than treated as a search.
  const isQuestion = !sourceType && !occurredAtLocal && looksLikeQuestion(text);

  const startBatch = (chunks: string[]) => {
    setBatchChunks(chunks);
    setText("");
    setResult(undefined);
    setAnswer(undefined);
  };

  const runCapture = async (body: string, options?: CaptureOptions) => {
    setSubmitting(true);
    setLastText(body);
    setLastOptions(options);
    try {
      const captured = await onCapture(body, options);
      if (captured) {
        setResult(captured);
        setAnswer(undefined);
        setText("");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const runAsk = async (question: string) => {
    setSubmitting(true);
    setLastText(question);
    try {
      const answered = await onAsk(question);
      if (answered) {
        setAnswer(answered);
        setResult(undefined);
        setText("");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const submit = () => {
    if (!text.trim() || submitting) return;
    if (isQuestion) return void runAsk(text);
    const options: CaptureOptions | undefined =
      sourceType || occurredAtLocal
        ? {
            sourceType: sourceType || undefined,
            occurredAt: occurredAtLocal ? localInputToIso(occurredAtLocal, timezone) : undefined,
          }
        : undefined;
    return void runCapture(text, options);
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
        placeholder="貼る、または書く（メール、議事録、雑な一言でもOK）。「ABC社の状況どうなっている？」のように聞くこともできます"
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
            onClick={submit}
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
          onClick={submit}
          className="press rounded-lg bg-kumo-brand px-4 py-2 text-sm font-medium text-white hover:bg-kumo-brand-hover disabled:opacity-50"
        >
          {submitting ? (isQuestion ? "検索中…" : "取り込み中…") : isQuestion ? "検索する" : "取り込む"}
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
          onRetry={() => void runCapture(lastText, lastOptions)}
        />
      )}
      {answer && (
        <AnswerView
          result={answer}
          ai={ai}
          onOpenOpportunity={onOpenOpportunity}
          onRetry={() => void runAsk(lastText)}
        />
      )}
    </div>
  );
}
