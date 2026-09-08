/**
 * Deterministic business rules over a validated extraction (設計書 §27, §16). Pure functions: they
 * return *proposals* plus review triggers; the pipeline applies them.
 */
import type { Extraction } from "../ai/schema.js";
import type {
  JsonValue, LifecycleState, OperationalState, Opportunity, Priority, ReviewItemType,
} from "../domain/types.js";
import { clamp01, isIsoDateTime } from "../domain/util.js";
import type { SalesConfig } from "./config.js";

/** Japanese labels for review/question text (§ FB_20260908: no raw English enums in front of users). */
const LIFECYCLE_LABEL_JA: Record<LifecycleState, string> = {
  OPEN: "進行中", WON: "受注", LOST: "失注", ON_HOLD: "保留", CLOSED: "終了",
};

export interface ReviewTrigger {
  type: ReviewItemType;
  question: string;
  options?: { id: string; label: string; value?: JsonValue }[];
}

export interface StateProposal {
  operationalState?: OperationalState;
  lifecycleState?: LifecycleState;
  confidence: number;
  reviews: ReviewTrigger[];
  reason?: string;
}

/** RULE-01 / RULE-02 / RULE-06: never auto-apply WON/LOST; apply operational state by confidence. */
export function deriveState(
  extraction: Extraction, current: Opportunity | undefined, config: SalesConfig,
): StateProposal {
  const s = extraction.state;
  const reviews: ReviewTrigger[] = [];
  const proposal: StateProposal = { confidence: clamp01(s.confidence), reviews, reason: s.reason ?? undefined };

  if (s.lifecycle_state === "WON" || s.lifecycle_state === "LOST") {
    reviews.push({
      type: "STATE_AMBIGUOUS",
      question: `AI は本件を「${s.lifecycle_state === "WON" ? "受注" : "失注"}」と判断しました` +
        `${s.reason ? ` (${s.reason})` : ""}。確定しますか？`,
      options: [
        { id: "confirm", label: s.lifecycle_state === "WON" ? "受注として確定" : "失注として確定",
          value: { lifecycleState: s.lifecycle_state } },
        { id: "keep-open", label: "まだ確定しない (OPEN のまま)", value: { lifecycleState: "OPEN" } },
      ],
    });
  } else if (s.lifecycle_state === "ON_HOLD" || s.lifecycle_state === "CLOSED") {
    if (s.confidence >= config.stateAutoConfidence) proposal.lifecycleState = s.lifecycle_state;
    else {
      const label = LIFECYCLE_LABEL_JA[s.lifecycle_state];
      reviews.push({
        type: "STATE_AMBIGUOUS",
        question: `AI は本件を「${label}」と判断しましたが、自信がありません。適用しますか？`,
        options: [
          { id: "confirm", label: `「${label}」にする`, value: { lifecycleState: s.lifecycle_state } },
          { id: "keep", label: "現状維持", value: {} },
        ],
      });
    }
  } else if (current && current.lifecycleState !== "OPEN" && s.lifecycle_state === "OPEN") {
    // Re-opening a closed opportunity is also a human call.
    reviews.push({
      type: "STATE_AMBIGUOUS",
      question: `「${LIFECYCLE_LABEL_JA[current.lifecycleState]}」の案件に新しい動きがありました。OPEN に戻しますか？`,
      options: [
        { id: "reopen", label: "OPEN に戻す", value: { lifecycleState: "OPEN" } },
        { id: "keep", label: "現状維持", value: {} },
      ],
    });
  }

  if (s.operational_state !== "UNKNOWN" && s.confidence >= config.stateAutoConfidence) {
    proposal.operationalState = s.operational_state;
  }
  return proposal;
}

/** RULE-03: keep a due date only when the model was confident and it is a real ISO instant. */
export function acceptDueAt(
  dueAt: string | null | undefined, dueConfidence: number, config: SalesConfig,
): string | undefined {
  if (!isIsoDateTime(dueAt)) return undefined;
  if (dueConfidence < config.dateConfidence) return undefined;
  return new Date(dueAt).toISOString();
}

export interface AmountProposal {
  expectedAmount?: number;
  currency?: string;
  reviews: ReviewTrigger[];
}

/** RULE-04: distinguish quote / contract / budget; only confident QUOTE/CONTRACT set the amount. */
export function deriveAmount(
  extraction: Extraction, current: Opportunity | undefined, config: SalesConfig,
): AmountProposal {
  const reviews: ReviewTrigger[] = [];
  const amounts = extraction.amounts;
  if (amounts.length === 0) return { reviews };

  const decisive = amounts.filter(a => a.kind === "QUOTE" || a.kind === "CONTRACT");
  const confident = decisive.filter(a => a.confidence >= config.amountAutoConfidence);
  const contract = confident.find(a => a.kind === "CONTRACT");
  const quote = confident.find(a => a.kind === "QUOTE");
  const pick = contract ?? quote;

  if (pick && confident.length === decisive.length && distinctAmounts(decisive).length === 1) {
    if (current?.expectedAmount !== undefined && current.expectedAmount !== pick.amount) {
      reviews.push({
        type: "AMOUNT_AMBIGUOUS",
        question: `見込金額が ${current.expectedAmount.toLocaleString()} から ` +
          `${pick.amount.toLocaleString()} ${pick.currency} に変わりました (${pick.kind}: 「${pick.evidence}」)。更新しますか？`,
        options: [
          { id: "update", label: "更新する", value: { expectedAmount: pick.amount, currency: pick.currency } },
          { id: "keep", label: "現状維持", value: {} },
        ],
      });
      return { reviews };
    }
    return { expectedAmount: pick.amount, currency: pick.currency, reviews };
  }

  reviews.push({
    type: "AMOUNT_AMBIGUOUS",
    question: "本文に複数または不確かな金額があります。見込金額として採用するものを選んでください。",
    options: [
      ...amounts.map((a, i) => ({
        id: `amount:${i}`,
        label: `${a.amount.toLocaleString()} ${a.currency} (${amountKindLabel(a.kind)}: 「${a.evidence}」)`,
        value: { expectedAmount: a.amount, currency: a.currency },
      })),
      { id: "keep", label: "見込金額は変更しない", value: {} },
    ],
  });
  return { reviews };
}

function distinctAmounts(items: { amount: number }[]): number[] {
  return [...new Set(items.map(i => i.amount))];
}

export function amountKindLabel(kind: string): string {
  switch (kind) {
    case "QUOTE": return "見積提示額";
    case "CONTRACT": return "契約額";
    case "BUDGET": return "顧客予算";
    default: return "その他";
  }
}

/** Priority derived from due date proximity when the model left it at NORMAL. */
export function derivePriority(
  modelPriority: Priority, dueAt: string | undefined, referenceTime: string,
): Priority {
  if (modelPriority !== "NORMAL" || !dueAt) return modelPriority;
  const hours = (Date.parse(dueAt) - Date.parse(referenceTime)) / 3_600_000;
  if (hours <= 24) return "HIGH";
  return "NORMAL";
}
