import type { AnswerResult, WhoAmI } from "../../src/management-types";
import { AiAttribution } from "./AiAttribution";

/**
 * Renders the result of the capture box's "ask a question" mode
 * (「＊＊の状況どうなっている？」) — a natural-language answer plus links to the
 * opportunities it was based on. Mirrors `CaptureResultView`'s layout/tone.
 */
export function AnswerView({
  result,
  ai,
  onOpenOpportunity,
  onRetry,
}: {
  result: AnswerResult;
  ai: WhoAmI["ai"];
  onOpenOpportunity: (opportunityId: string) => void;
  onRetry: () => void | Promise<void>;
}) {
  if (result.error) {
    return (
      <div className="mt-3 rounded-lg border border-kumo-danger-tint bg-kumo-danger-tint px-3.5 py-3">
        <p className="text-sm font-medium text-kumo-danger">回答の取得に失敗しました。</p>
        <p className="mt-1 text-xs text-kumo-danger">{result.error}</p>
        <button
          type="button"
          onClick={onRetry}
          className="press mt-2 rounded-lg border border-kumo-danger px-3 py-1.5 text-xs font-medium text-kumo-danger hover:bg-kumo-base"
        >
          再試行
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-kumo-line bg-kumo-elevated px-3.5 py-3">
      <AiAttribution ai={ai} />
      {!result.matchedByName && result.references.length > 0 && (
        <p className="text-xs text-kumo-subtle">
          名前に一致する案件が見つからなかったため、直近の案件をもとに回答しています。
        </p>
      )}
      <p className="whitespace-pre-wrap text-sm text-kumo-default">{result.answer}</p>
      {result.references.length > 0 && (
        <div>
          <p className="text-xs font-medium text-kumo-subtle">参照した案件</p>
          <ul className="mt-1 space-y-0.5">
            {result.references.map((ref) => (
              <li key={ref.id}>
                <button
                  type="button"
                  onClick={() => onOpenOpportunity(ref.id)}
                  className="text-sm font-medium text-kumo-link hover:underline"
                >
                  {ref.accountName} / {ref.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
