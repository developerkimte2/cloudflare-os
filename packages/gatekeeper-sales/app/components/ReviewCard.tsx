import { useState } from "react";
import type { ReviewDto } from "../../src/management-types";
import { localInputToIso } from "../format";
import { REVIEW_TYPE_LABEL } from "../labels";
import { Badge } from "./Badges";
import { ConfirmInline } from "./ConfirmInline";

type ReviewOption = NonNullable<ReviewDto["optionsJson"]>[number];

export function ReviewCard({
  review,
  timezone,
  onResolve,
  onDismiss,
  onOpenOpportunity,
}: {
  review: ReviewDto;
  timezone: string;
  onResolve: (optionId: string, input?: Record<string, unknown>) => void | Promise<void>;
  onDismiss: () => void | Promise<void>;
  onOpenOpportunity?: () => void;
}) {
  const [busyOption, setBusyOption] = useState<string | null>(null);

  const choose = async (optionId: string, input?: Record<string, unknown>) => {
    setBusyOption(optionId);
    try {
      await onResolve(optionId, input);
    } finally {
      setBusyOption(null);
    }
  };

  return (
    <div className="rounded-lg border border-kumo-line bg-kumo-control px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Badge label={REVIEW_TYPE_LABEL[review.type]} tone="warning" />
          <p className="mt-1.5 text-sm text-kumo-default">{review.question}</p>
          {review.relatedTitle && (
            <button
              type="button"
              onClick={onOpenOpportunity}
              disabled={!onOpenOpportunity}
              className="mt-0.5 text-xs text-kumo-link hover:underline disabled:no-underline disabled:text-kumo-subtle"
            >
              {review.relatedTitle}
            </button>
          )}
        </div>
        <ConfirmInline label="却下" confirmText="この確認を却下しますか？" tone="neutral" onConfirm={onDismiss} />
      </div>
      {review.optionsJson && review.optionsJson.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {review.optionsJson.map((option) => (
            <OptionControl
              key={option.id}
              option={option}
              timezone={timezone}
              busy={busyOption === option.id}
              onChoose={(input) => choose(option.id, input)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function OptionControl({
  option,
  timezone,
  busy,
  onChoose,
}: {
  option: ReviewOption;
  timezone: string;
  busy: boolean;
  onChoose: (input?: Record<string, unknown>) => void;
}) {
  const [local, setLocal] = useState("");
  const value = option.value as { needsInput?: string } | undefined;

  if (value?.needsInput === "dueAt") {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-kumo-line px-2.5 py-1.5">
        <span className="text-xs text-kumo-default">{option.label}</span>
        <input
          type="datetime-local"
          value={local}
          onChange={(event) => setLocal(event.currentTarget.value)}
          className="h-7 rounded-md border border-kumo-line bg-kumo-base px-1.5 text-xs text-kumo-default"
        />
        <button
          type="button"
          disabled={!local || busy}
          onClick={() => onChoose({ dueAt: localInputToIso(local, timezone) })}
          className="press rounded-md bg-kumo-brand px-2 py-1 text-xs font-medium text-white hover:bg-kumo-brand-hover disabled:opacity-50"
        >
          設定
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => onChoose()}
      className="press rounded-lg border border-kumo-line px-2.5 py-1.5 text-xs font-medium text-kumo-default hover:bg-kumo-tint disabled:opacity-50"
    >
      {busy ? "…" : option.label}
    </button>
  );
}
