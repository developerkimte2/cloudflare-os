import { useState } from "react";
import type { NextAction, NextActionPatch } from "../../src/management-types";
import { formatDueLabel, localDateAhead, snoozeEndIso } from "../format";
import { PRIORITY_LABEL } from "../labels";
import { Badge, NextActionStatusBadge } from "./Badges";

const SNOOZE_PRESETS: Array<{ label: string; days: number }> = [
  { label: "明日", days: 1 },
  { label: "3日後", days: 3 },
  { label: "1週間後", days: 7 },
];

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
  const [choosingSnooze, setChoosingSnooze] = useState(false);
  const [pickedDate, setPickedDate] = useState("");
  const minDate = localDateAhead(1, timezone, now);
  const isOpenOrSnoozed = action.status === "OPEN" || action.status === "SNOOZED";
  const snoozed = action.status === "SNOOZED";

  const snoozeUntil = async (ymd: string) => {
    const until = snoozeEndIso(ymd, timezone);
    if (!until) return;
    setChoosingSnooze(false);
    await onUpdate({ status: "SNOOZED", snoozedUntil: until });
  };

  return (
    <div
      className={`rounded-lg px-2.5 py-2.5 ${overdue ? "bg-kumo-danger-tint/40" : "hover:bg-kumo-tint"}`}
    >
      <div className="flex items-start gap-3">
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
            {snoozed && <NextActionStatusBadge status={action.status} />}
          </div>
          {action.purpose && <p className="mt-0.5 truncate text-xs text-kumo-subtle">{action.purpose}</p>}
          <p className={`mt-1 text-xs ${overdue ? "font-medium text-kumo-danger" : "text-kumo-inactive"}`}>
            {formatDueLabel(action.dueAt, timezone, now)}
            {snoozed && (
              <span className="text-kumo-inactive">
                {" ・ "}
                {action.snoozedUntil
                  ? `${formatDueLabel(action.snoozedUntil, timezone, now)} に再表示`
                  : "再表示日なし"}
              </span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {isOpenOrSnoozed ? (
            <>
              <RowButton onClick={() => onUpdate({ status: "DONE" })}>完了</RowButton>
              {snoozed ? (
                <RowButton onClick={() => onUpdate({ status: "OPEN" })}>再開</RowButton>
              ) : (
                <RowButton onClick={() => setChoosingSnooze((open) => !open)}>スヌーズ</RowButton>
              )}
              {showCancel && <RowButton onClick={() => onUpdate({ status: "CANCELLED" })}>取消</RowButton>}
            </>
          ) : (
            <NextActionStatusBadge status={action.status} />
          )}
        </div>
      </div>
      {choosingSnooze && !snoozed && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-kumo-line pt-2 text-xs text-kumo-subtle">
          <span>再表示日:</span>
          {SNOOZE_PRESETS.map((preset) => (
            <RowButton key={preset.days} onClick={() => snoozeUntil(localDateAhead(preset.days, timezone, now))}>
              {preset.label}
            </RowButton>
          ))}
          <input
            type="date"
            aria-label="再表示日を指定"
            min={minDate}
            value={pickedDate}
            onChange={(event) => setPickedDate(event.target.value)}
            className="rounded-md border border-kumo-line bg-kumo-control px-1.5 py-0.5 text-xs text-kumo-default"
          />
          {/* Typing into a date field emits intermediate dates, so a picked date needs confirming. */}
          {pickedDate >= minDate && <RowButton onClick={() => snoozeUntil(pickedDate)}>この日にする</RowButton>}
          <span className="text-kumo-inactive">（9:00 に再表示）</span>
          <button
            type="button"
            onClick={() => setChoosingSnooze(false)}
            className="ml-auto text-xs text-kumo-subtle hover:text-kumo-default"
          >
            やめる
          </button>
        </div>
      )}
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
