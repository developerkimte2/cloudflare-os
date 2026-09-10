import type { WhoAmI } from "../../src/management-types";

/**
 * "Which AI is judging this?" attribution line (設計書 §0-10 の透明性; FB_20260908 item C).
 * Shown next to captures and reviews so it is always clear which model produced them.
 *
 * `actual` is the model that actually produced the result at hand (from an `AIDecision`,
 * `AIContextSnapshot`, or `AnswerResult`, already formatted as "provider/model"). It takes
 * priority over the currently-configured model, which may have changed since — pass it
 * whenever a concrete result is available; omit it only when nothing has been judged yet.
 */
export function AiAttribution({ ai, actual }: { ai: WhoAmI["ai"]; actual?: string }) {
  const label = actual ?? (ai.configured ? `${ai.provider}/${ai.model}` : "未設定");
  return <span className="text-[11px] text-kumo-inactive">判定AI: {label}</span>;
}
