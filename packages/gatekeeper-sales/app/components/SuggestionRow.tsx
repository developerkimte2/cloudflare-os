import { useState } from "react";
import type { NextActionSuggestion } from "../../src/management-types";
import { formatDueLabel } from "../format";
import { PRIORITY_LABEL } from "../labels";
import { Badge } from "./Badges";

/**
 * A next action the AI proposed but didn't create outright (confidence below
 * nextActionAutoConfidence — see pipeline/ingest.ts "5. Next actions"). Shown instead of silently
 * discarded, with one-tap 採用 (adopt: turns it into a real NextAction) / 却下 (dismiss).
 */
export function SuggestionRow({
  suggestion,
  timezone,
  now,
  onAdopt,
  onDismiss,
}: {
  suggestion: NextActionSuggestion;
  timezone: string;
  now: Date;
  onAdopt: () => void | Promise<void>;
  onDismiss: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState<"adopt" | "dismiss" | undefined>();

  const run = async (which: "adopt" | "dismiss", action: () => void | Promise<void>) => {
    setBusy(which);
    try {
      await action();
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="flex items-start gap-3 rounded-lg border border-dashed border-kumo-line px-2.5 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="truncate text-sm text-kumo-default">{suggestion.title}</p>
          {suggestion.priority !== "NORMAL" && (
            <Badge
              label={PRIORITY_LABEL[suggestion.priority]}
              tone={suggestion.priority === "URGENT" ? "danger" : suggestion.priority === "HIGH" ? "warning" : "neutral"}
            />
          )}
          <Badge label="AI提案（未確定）" tone="info" />
        </div>
        {suggestion.purpose && <p className="mt-0.5 truncate text-xs text-kumo-subtle">{suggestion.purpose}</p>}
        <p className="mt-1 text-xs text-kumo-inactive">
          {suggestion.dueAt ? formatDueLabel(suggestion.dueAt, timezone, now) : "期限なし"}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void run("adopt", onAdopt)}
          className="press rounded-md border border-kumo-line bg-kumo-control px-2 py-1 text-xs font-medium text-kumo-default hover:bg-kumo-tint disabled:opacity-50"
        >
          {busy === "adopt" ? "採用中…" : "採用"}
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void run("dismiss", onDismiss)}
          className="press rounded-md border border-kumo-line bg-kumo-control px-2 py-1 text-xs font-medium text-kumo-subtle hover:bg-kumo-tint disabled:opacity-50"
        >
          {busy === "dismiss" ? "却下中…" : "却下"}
        </button>
      </div>
    </div>
  );
}
