import type { WhoAmI } from "../../src/management-types";

/**
 * "Which AI is judging this?" attribution line (設計書 §0-10 の透明性; FB_20260908 item C).
 * Shown next to captures and reviews so it is always clear which model produced them.
 */
export function AiAttribution({ ai }: { ai: WhoAmI["ai"] }) {
  return (
    <span className="text-[11px] text-kumo-inactive">
      判定AI: {ai.configured ? `${ai.provider} / ${ai.model}` : "未設定"}
    </span>
  );
}
