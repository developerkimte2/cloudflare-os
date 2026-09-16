import { useState } from "react";
import type { Period, PeriodPreset } from "../../src/management-types";

export const PERIOD_PRESET_LABEL: Record<PeriodPreset, string> = {
  THIS_MONTH: "今月",
  LAST_MONTH: "先月",
  THIS_QUARTER: "今四半期",
  THIS_FY: "今年度",
  LAST_FY: "前年度",
};

export type PeriodChoice = { preset: PeriodPreset } | { custom: Period };

export function PeriodPicker({ value, onChange }: { value: PeriodChoice; onChange: (next: PeriodChoice) => void }) {
  const [from, setFrom] = useState("custom" in value ? value.custom.from : "");
  const [to, setTo] = useState("custom" in value ? value.custom.to : "");
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {(Object.keys(PERIOD_PRESET_LABEL) as PeriodPreset[]).map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange({ preset: p })}
          className={`press rounded-lg border px-2.5 py-1 text-xs font-medium ${
            "preset" in value && value.preset === p ? "border-kumo-brand text-kumo-brand" : "border-kumo-line text-kumo-subtle"
          }`}
        >
          {PERIOD_PRESET_LABEL[p]}
        </button>
      ))}
      <input
        type="date"
        value={from}
        onChange={(e) => setFrom(e.currentTarget.value)}
        className="h-7 rounded-md border border-kumo-line bg-kumo-base px-2 text-xs"
      />
      <span className="text-xs text-kumo-subtle">〜</span>
      <input
        type="date"
        value={to}
        onChange={(e) => setTo(e.currentTarget.value)}
        className="h-7 rounded-md border border-kumo-line bg-kumo-base px-2 text-xs"
      />
      <button
        type="button"
        disabled={!from || !to || from > to}
        onClick={() => onChange({ custom: { from, to: nextDay(to) } })}
        className="press rounded-lg border border-kumo-line px-2.5 py-1 text-xs font-medium text-kumo-subtle disabled:opacity-50"
      >
        任意期間
      </button>
    </div>
  );
}

function nextDay(ymd: string): string {
  // to is exclusive on the server; the user picks an inclusive end date
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
