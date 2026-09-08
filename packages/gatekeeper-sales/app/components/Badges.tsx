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

export function LifecycleBadge({ state }: { state: OpportunitySummary["lifecycleState"] }) {
  const tone: Tone =
    state === "WON" ? "success" : state === "LOST" ? "danger" : state === "ON_HOLD" ? "warning" : "info";
  return <Badge label={LIFECYCLE_LABEL[state]} tone={state === "CLOSED" ? "neutral" : tone} />;
}

export function OperationalBadge({ state }: { state: OpportunitySummary["operationalState"] }) {
  const tone: Tone = state === "BLOCKED" ? "danger" : state === "CONTRACTING" ? "success" : "neutral";
  return <Badge label={OPERATIONAL_LABEL[state]} tone={tone} />;
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
