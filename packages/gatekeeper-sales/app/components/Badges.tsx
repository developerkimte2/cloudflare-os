import type { Commitment, NextAction, OpportunitySummary, ReviewDto, SourceDocument } from "../../src/management-types";
import {
  COMMITMENT_STATUS_LABEL,
  LIFECYCLE_LABEL,
  NEXT_ACTION_STATUS_LABEL,
  OPERATIONAL_LABEL,
  PROCESSING_STATUS_LABEL,
  RISK_LABEL,
} from "../labels";

type Tone = "neutral" | "warning" | "danger" | "success" | "info";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-kumo-fill text-kumo-subtle",
  warning: "bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-300",
  danger: "bg-kumo-danger-tint text-kumo-danger",
  success: "bg-emerald-100 text-emerald-900 dark:bg-emerald-500/20 dark:text-emerald-300",
  info: "bg-kumo-tint text-kumo-default",
};

export function Badge({ label, tone = "neutral" }: { label: string; tone?: Tone }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium leading-4 ${TONE_CLASS[tone]}`}
    >
      {label}
    </span>
  );
}

/**
 * One status per opportunity: the lifecycle stage (set by a person or by AI) plus whether AI has
 * judged how the deal is moving. The operational state itself only shows on hover — two badges
 * side by side ("進行中" + "不明") read as contradictory.
 */
export function OpportunityStatusBadge({
  lifecycleState,
  operationalState,
}: {
  lifecycleState: OpportunitySummary["lifecycleState"];
  operationalState: OpportunitySummary["operationalState"];
}) {
  const judged = operationalState !== "UNKNOWN";
  const tone: Tone =
    lifecycleState === "WON"
      ? "success"
      : lifecycleState === "LOST"
        ? "danger"
        : lifecycleState === "ON_HOLD"
          ? "warning"
          : lifecycleState === "CLOSED" || !judged
            ? "neutral"
            : "info";
  const hint = judged
    ? `AI の見立て: ${OPERATIONAL_LABEL[operationalState]}`
    : "AI はまだこの案件の動きを判定していません（記録が少ないか、判断に自信がない状態です）";
  return (
    <span title={hint} className="inline-flex">
      <Badge label={judged ? LIFECYCLE_LABEL[lifecycleState] : `${LIFECYCLE_LABEL[lifecycleState]}（AI未判定）`} tone={tone} />
    </span>
  );
}

export function RiskBadge({ level }: { level: OpportunitySummary["riskLevel"] }) {
  const tone: Tone = level === "HIGH" ? "danger" : level === "MEDIUM" ? "warning" : level === "LOW" ? "info" : "neutral";
  if (level === "NONE") return null;
  return <Badge label={RISK_LABEL[level]} tone={tone} />;
}

export function NextActionStatusBadge({ status }: { status: NextAction["status"] }) {
  const tone: Tone = status === "DONE" ? "success" : status === "SNOOZED" ? "warning" : status === "CANCELLED" ? "neutral" : "info";
  return <Badge label={NEXT_ACTION_STATUS_LABEL[status]} tone={tone} />;
}

export function CommitmentStatusBadge({ status }: { status: Commitment["status"] }) {
  const tone: Tone =
    status === "FULFILLED" ? "success" : status === "OVERDUE" ? "danger" : status === "CANCELLED" ? "neutral" : "info";
  return <Badge label={COMMITMENT_STATUS_LABEL[status]} tone={tone} />;
}

export function ProcessingStatusBadge({ status }: { status: SourceDocument["processingStatus"] }) {
  const tone: Tone =
    status === "PROCESSED"
      ? "success"
      : status === "FAILED"
        ? "danger"
        : status === "REVIEW_REQUIRED"
          ? "warning"
          : status === "REVERTED"
            ? "neutral"
            : "info";
  return <Badge label={PROCESSING_STATUS_LABEL[status]} tone={tone} />;
}

export function ReviewStatusBadge({ status }: { status: ReviewDto["status"] }) {
  const tone: Tone = status === "RESOLVED" ? "success" : status === "DISMISSED" ? "neutral" : "warning";
  const label = status === "OPEN" ? "未確認" : status === "RESOLVED" ? "解決済み" : "却下";
  return <Badge label={label} tone={tone} />;
}
