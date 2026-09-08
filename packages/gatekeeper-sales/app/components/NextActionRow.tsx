import type { NextAction, NextActionPatch } from "../../src/management-types";
import { formatDueLabel } from "../format";
import { PRIORITY_LABEL } from "../labels";
import { Badge, NextActionStatusBadge } from "./Badges";

export function NextActionRow({
  action,
  timezone,
  now,
  overdue,
  opportunityTitle,
  onOpenOpportunity,
  onUpdate,
  showCancel,
}: {
  action: NextAction;
  timezone: string;
  now: Date;
  overdue?: boolean;
  /** Shown as a link above the action when the row isn't already scoped to one opportunity. */
  opportunityTitle?: string;
  onOpenOpportunity?: () => void;
  onUpdate: (patch: NextActionPatch) => void | Promise<void>;
  showCancel?: boolean;
}) {
  const isOpenOrSnoozed = action.status === "OPEN" || action.status === "SNOOZED";
  return (
    <div
      className={`flex items-start gap-3 rounded-lg px-2.5 py-2.5 ${
        overdue ? "bg-kumo-danger-tint/40" : "hover:bg-kumo-tint"
      }`}
    >
      <div className="min-w-0 flex-1">
        {opportunityTitle && (
          <button
            type="button"
            onClick={onOpenOpportunity}
            className="block truncate text-left text-sm font-medium text-kumo-link hover:underline"
          >
            {opportunityTitle}
          </button>
        )}
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          <p className="truncate text-sm text-kumo-default">{action.title}</p>
          {action.priority !== "NORMAL" && (
            <Badge
              label={PRIORITY_LABEL[action.priority]}
              tone={action.priority === "URGENT" ? "danger" : action.priority === "HIGH" ? "warning" : "neutral"}
            />
          )}
          {action.generatedBy === "AI" && <Badge label="AI提案" tone="info" />}
        </div>
        {action.purpose && <p className="mt-0.5 truncate text-xs text-kumo-subtle">{action.purpose}</p>}
        <p className={`mt-1 text-xs ${overdue ? "font-medium text-kumo-danger" : "text-kumo-inactive"}`}>
          {formatDueLabel(action.dueAt, timezone, now)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {isOpenOrSnoozed ? (
          <>
            <RowButton onClick={() => onUpdate({ status: "DONE" })}>完了</RowButton>
            {action.status !== "SNOOZED" && (
              <RowButton onClick={() => onUpdate({ status: "SNOOZED" })}>スヌーズ</RowButton>
            )}
            {showCancel && <RowButton onClick={() => onUpdate({ status: "CANCELLED" })}>取消</RowButton>}
          </>
        ) : (
          <NextActionStatusBadge status={action.status} />
        )}
      </div>
    </div>
  );
}

function RowButton({ children, onClick }: { children: React.ReactNode; onClick: () => void | Promise<void> }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="press rounded-md border border-kumo-line bg-kumo-control px-2 py-1 text-xs font-medium text-kumo-default hover:bg-kumo-tint"
    >
      {children}
    </button>
  );
}
