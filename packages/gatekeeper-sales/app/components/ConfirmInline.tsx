import { useState } from "react";

/**
 * A destructive or otherwise consequential action rendered as a plain link that, on click, swaps
 * itself for an inline confirm/cancel pair. The sandboxed iframe has no `window.confirm`, so this is
 * the app's only confirmation affordance.
 */
export function ConfirmInline({
  label,
  confirmText,
  confirmLabel = "実行",
  cancelLabel = "キャンセル",
  tone = "danger",
  disabled,
  onConfirm,
}: {
  label: string;
  confirmText: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "neutral";
  disabled?: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        disabled={disabled}
        className={`text-xs font-medium hover:underline disabled:opacity-40 ${
          tone === "danger" ? "text-kumo-danger" : "text-kumo-subtle"
        }`}
        onClick={() => setConfirming(true)}
      >
        {label}
      </button>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2 rounded-lg bg-kumo-elevated px-2.5 py-1.5 text-xs">
      <span className="text-kumo-subtle">{confirmText}</span>
      <button
        type="button"
        disabled={busy}
        className="press font-semibold text-kumo-danger hover:underline disabled:opacity-50"
        onClick={async () => {
          setBusy(true);
          try {
            await onConfirm();
          } finally {
            setBusy(false);
            setConfirming(false);
          }
        }}
      >
        {busy ? "実行中…" : confirmLabel}
      </button>
      <button
        type="button"
        disabled={busy}
        className="text-kumo-subtle hover:underline disabled:opacity-50"
        onClick={() => setConfirming(false)}
      >
        {cancelLabel}
      </button>
    </span>
  );
}
