import { useMemo, useRef, useState } from "react";
// Deep import via its own package.json "exports" subpath: this leaf module has no DB/LLM code,
// unlike "@gadgets/sales-core" (the package index), which would drag db/node-sqlite's
// `node:sqlite` into the browser bundle (FB_20260908 D).
import { splitCaptureText } from "@gadgets/sales-core/pipeline/split";
import type { AnswerResult, CaptureOptions, CaptureResult, NextAction, WhoAmI } from "../../src/management-types";
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
  { value: "AUDIO", label: "音声" },
];

/**
 * The "話す/貼る" capture box (設計書 UX-02/03): a single textarea plus optional, collapsed metadata.
 * Nothing here is required beyond the text itself.
 *
 * Also doubles as a search box, via a separate 検索 button that sends the same text to `onAsk`
 * (read-only, nothing stored) instead of `onCapture`. The rep chooses, explicitly: an earlier
 * version guessed with a keyword heuristic and got it wrong both ways —
 * "山田商事の情報をおしえて" became a phantom opportunity, and a real email recap ending in
 * "...教えてください" was silently dropped as a question (2026-09-14). No keyword list can enumerate
 * every phrasing; two buttons remove the guess entirely, and the extraction prompt's rule 10 still
 * catches a question that gets sent as a capture by mistake.
 */
export function CaptureBox({
  timezone,
  ai,
  transcription,
  onCapture,
  onAsk,
  onTranscribe,
  onOpenOpportunity,
  onResolveReview,
  onDismissReview,
  onAdoptSuggestion,
  onDismissSuggestion,
}: {
  timezone: string;
  ai: WhoAmI["ai"];
  /** 未設定 (Workers AI 未構成) なら「音声ファイル」ボタンを出さない (plans/sales-os-voice.md V3)。 */
  transcription: WhoAmI["transcription"];
  /**
   * `onAccepted` fires as soon as the memo is durably stored (captureAsync's instant-accept), well
   * before the AI has run -- lets this box show a "受付済み・処理中…" placeholder instead of a bare
   * spinner for however long the alarm-driven queue takes.
   */
  onCapture: (
    text: string, options?: CaptureOptions, onAccepted?: () => void,
  ) => Promise<CaptureResult | undefined>;
  onAsk: (question: string) => Promise<AnswerResult | undefined>;
  /** 何も保存しない: 文字起こし結果をテキストエリアに入れるだけで、送信は既存の取り込みボタンに任せる。 */
  onTranscribe: (audio: ArrayBuffer, mimeType: string) => Promise<{ text: string; modelName: string } | undefined>;
  onOpenOpportunity: (opportunityId: string) => void;
  onResolveReview: (id: string, optionId: string, input?: Record<string, unknown>) => void | Promise<void>;
  onDismissReview: (id: string) => void | Promise<void>;
  onAdoptSuggestion: (decisionId: string, index: number) => Promise<NextAction | undefined>;
  onDismissSuggestion: (decisionId: string, index: number) => void | Promise<void>;
}) {
  const [text, setText] = useState("");
  const [showOptions, setShowOptions] = useState(false);
  const [sourceType, setSourceType] = useState<SourceTypeOption | "">("");
  const [occurredAtLocal, setOccurredAtLocal] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Which of the two buttons is in flight, so each shows its own busy label.
  const [asking, setAsking] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const [recording, setRecording] = useState(false);
  // Basic existence check only (no permission prompt) — a real attempt happens on click, and its
  // failure (sandbox block or user denial) is what actually hides this button (see startRecording).
  const [micSupported, setMicSupported] = useState(
    () => typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia,
  );
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const recordTimeoutRef = useRef<number | undefined>(undefined);
  const [result, setResult] = useState<CaptureResult>();
  const [answer, setAnswer] = useState<AnswerResult>();
  const [lastText, setLastText] = useState("");
  const [lastOptions, setLastOptions] = useState<CaptureOptions | undefined>();
  // Set once the user opts into taking a multi-record paste one record at a time; while set, the
  // normal textarea/submit UI is replaced by BatchCaptureView (FB_20260908 item D).
  const [batchChunks, setBatchChunks] = useState<string[]>();

  const split = useMemo(() => splitCaptureText(text), [text]);
  // "heading" (【…】 lines) and "numbered" (5+ sequentially-numbered paragraphs) are both safe to
  // offer automatically — see split.ts's own docs for why each is low-risk for a false positive.
  const autoSplit =
    (split.rule === "heading" || split.rule === "numbered") && split.chunks.length >= 2
      ? split.chunks
      : undefined;
  const blankLinesSplit = split.rule === "blank-lines" ? split.chunks : undefined;

  const startBatch = (chunks: string[]) => {
    setBatchChunks(chunks);
    setText("");
    setResult(undefined);
    setAnswer(undefined);
  };

  const runCapture = async (body: string, options?: CaptureOptions) => {
    setSubmitting(true);
    setAccepted(false);
    setLastText(body);
    setLastOptions(options);
    try {
      const captured = await onCapture(body, options, () => setAccepted(true));
      if (captured) {
        setResult(captured);
        setAnswer(undefined);
        setText("");
      }
    } finally {
      setSubmitting(false);
      setAccepted(false);
    }
  };

  // Wraps the parent's API call to also drop the suggestion from this inline result once it's
  // handled — without this the row would keep showing 採用/却下 after already being resolved.
  const adoptSuggestion = async (decisionId: string, index: number) => {
    const created = await onAdoptSuggestion(decisionId, index);
    if (!created) return;
    setResult((current) => current && {
      ...current,
      suggestions: current.suggestions.filter((s) => !(s.decisionId === decisionId && s.index === index)),
      nextActions: [...current.nextActions, created],
    });
  };

  const dismissSuggestion = async (decisionId: string, index: number) => {
    await onDismissSuggestion(decisionId, index);
    setResult((current) => current && {
      ...current,
      suggestions: current.suggestions.filter((s) => !(s.decisionId === decisionId && s.index === index)),
    });
  };

  const runAsk = async (question: string) => {
    setSubmitting(true);
    setAsking(true);
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
      setAsking(false);
    }
  };

  // Shared by both voice entry points (a-1 録音 / a-2 ファイル): a File is already a Blob, so the
  // uploaded file and the MediaRecorder output go through the same transcription call.
  const handleAudioBlob = async (blob: Blob) => {
    setTranscribing(true);
    try {
      const buffer = await blob.arrayBuffer();
      const transcribed = await onTranscribe(buffer, blob.type || "application/octet-stream");
      if (transcribed) {
        setText((current) => (current.trim() ? `${current}\n${transcribed.text}` : transcribed.text));
        setSourceType("AUDIO");
      }
    } finally {
      setTranscribing(false);
    }
  };

  const stopRecording = () => {
    if (recordTimeoutRef.current !== undefined) window.clearTimeout(recordTimeoutRef.current);
    recorderRef.current?.stop();
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        void handleAudioBlob(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      // 設計書 §19.1「30秒程度で話せること」を踏まえ、余裕をみて60秒で自動停止する。
      recordTimeoutRef.current = window.setTimeout(stopRecording, 60_000);
    } catch {
      // Workshop の iframe に allow="microphone" が無い、またはユーザーが拒否した場合。ここで
      // マイク機能を隠し、以降は音声ファイルのアップロードだけを案内する (plans/sales-os-voice.md V4)。
      setMicSupported(false);
    }
  };

  const submit = () => {
    if (!text.trim() || submitting) return;
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
        placeholder="記録したいことは「取り込む」（メール、議事録、雑な一言でもOK）。聞きたいことは「検索」（「ABC社の状況どうなっている？」など）"
        rows={4}
        className="w-full resize-none rounded-lg border border-kumo-line bg-kumo-base p-2.5 text-sm text-kumo-default outline-none placeholder:text-kumo-inactive focus:border-kumo-ring focus:ring-1 focus:ring-kumo-ring/20"
      />
      {autoSplit && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-kumo-tint px-2.5 py-2 text-xs text-kumo-subtle">
          <span>{autoSplit.length} 件の記録が含まれているようです。</span>
          <button
            type="button"
            onClick={() => startBatch(autoSplit)}
            className="press rounded-md bg-kumo-brand px-2 py-1 font-medium text-white hover:bg-kumo-brand-hover"
          >
            {autoSplit.length} 件に分けて取り込む
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
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowOptions((v) => !v)}
            className="text-xs text-kumo-subtle hover:text-kumo-default hover:underline"
          >
            {showOptions ? "オプションを隠す" : "オプション"}
          </button>
          {transcription.configured && (
            <>
              <input
                ref={audioInputRef}
                type="file"
                accept="audio/*"
                hidden
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) void handleAudioBlob(file);
                }}
              />
              <button
                type="button"
                disabled={transcribing || recording}
                onClick={() => audioInputRef.current?.click()}
                className="text-xs text-kumo-subtle hover:text-kumo-default hover:underline disabled:opacity-50"
              >
                {transcribing ? "文字起こし中…" : "🎙 音声ファイル"}
              </button>
              {micSupported && (
                <button
                  type="button"
                  disabled={transcribing}
                  onClick={() => (recording ? stopRecording() : void startRecording())}
                  className="text-xs text-kumo-subtle hover:text-kumo-default hover:underline disabled:opacity-50"
                >
                  {recording ? "⏹ 停止" : "🎤 話す"}
                </button>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!text.trim() || submitting}
            onClick={() => void runAsk(text)}
            className="press rounded-lg border border-kumo-line px-4 py-2 text-sm font-medium text-kumo-default hover:bg-kumo-tint disabled:opacity-50"
          >
            {asking ? "検索中…" : "検索"}
          </button>
          <button
            type="button"
            disabled={!text.trim() || submitting}
            onClick={submit}
            className="press rounded-lg bg-kumo-brand px-4 py-2 text-sm font-medium text-white hover:bg-kumo-brand-hover disabled:opacity-50"
          >
            {submitting && !asking ? (accepted ? "受付済み・処理中…" : "取り込み中…") : "取り込む"}
          </button>
        </div>
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
          onAdoptSuggestion={adoptSuggestion}
          onDismissSuggestion={dismissSuggestion}
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
