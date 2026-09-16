# 04 — F1 期間指定・会計年度・税率設定 (migration なし)

前提: 01〜03 がコミット済み。

## 目的
チーム画面の KPI を「今月固定」から期間指定 (今月/先月/今四半期/今年度/前年度/任意) にする。会計年度の開始月と税率を設定画面から変えられるようにする。

## 先に読むファイル
1. `packages/sales-core/src/domain/util.ts` — `localDate`, `addDays`
2. `packages/sales-core/src/service/sales-service.ts` — `getManagerSummary` (01 で monthFrom/monthTo にした所)、`startOfLocalMonth` (末尾)
3. `packages/sales-core/src/db/repository.ts` — `managerKpiAggregates`, `managerPerUserStats`
4. `packages/sales-core/src/api/dto.ts` — `ManagerSummary`, `ManagerPerUserRow`, `ConfigDto`
5. `packages/sales-core/src/rules/config.ts`
6. `packages/gatekeeper-sales/app/pages/ManagerPage.tsx` — データ取得 (`useAsyncData(() => api.getManagerSummary(), …)`) とタイル、担当者別の表
7. `packages/gatekeeper-sales/app/pages/SettingsPage.tsx` — `NUMBER_FIELDS` と保存
8. RPC 3 ファイルの `getManagerSummary`

## 手順

### 1. 期間の純関数 (`rules/period.ts` 新規)
```ts
import { addDays, localDate } from "../domain/util.js";

/** [from, to) as YYYY-MM-DD local dates. */
export interface Period { from: string; to: string }
export type PeriodPreset = "THIS_MONTH" | "LAST_MONTH" | "THIS_QUARTER" | "THIS_FY" | "LAST_FY";
export const PERIOD_PRESETS: PeriodPreset[] = ["THIS_MONTH", "LAST_MONTH", "THIS_QUARTER", "THIS_FY", "LAST_FY"];

function ymd(y: number, m: number): string {           // m: 1..12, may overflow/underflow
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toISOString().slice(0, 10);
}

/** Resolves a preset (or passes a custom period through, validated) against a local "today". */
export function resolvePeriod(
  input: PeriodPreset | Period | undefined, nowIso: string, timeZone: string, fiscalYearStartMonth: number,
): Period {
  if (input && typeof input === "object") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.from) || !/^\d{4}-\d{2}-\d{2}$/.test(input.to) || input.from >= input.to) {
      throw new TypeError("期間は YYYY-MM-DD で、開始 < 終了 にしてください");
    }
    return input;
  }
  const today = localDate(nowIso, timeZone);
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  const fyStart = Math.min(12, Math.max(1, fiscalYearStartMonth || 1));
  // Fiscal year containing `today` starts in year fyYear, month fyStart.
  const fyYear = m >= fyStart ? y : y - 1;
  switch (input ?? "THIS_MONTH") {
    case "THIS_MONTH": return { from: ymd(y, m), to: ymd(y, m + 1) };
    case "LAST_MONTH": return { from: ymd(y, m - 1), to: ymd(y, m) };
    case "THIS_QUARTER": {
      const offset = (m - fyStart + 12) % 12;               // months since FY start
      const qStart = fyStart + Math.floor(offset / 3) * 3;    // may exceed 12; ymd handles overflow
      return { from: ymd(fyYear, qStart), to: ymd(fyYear, qStart + 3) };
    }
    case "THIS_FY": return { from: ymd(fyYear, fyStart), to: ymd(fyYear + 1, fyStart) };
    case "LAST_FY": return { from: ymd(fyYear - 1, fyStart), to: ymd(fyYear, fyStart) };
  }
}

/** "2026年9月", "2026年度 第2四半期", "2026年度", or "2026-04-01〜2026-06-30" for custom. */
export function periodLabel(period: Period, preset: PeriodPreset | undefined, fiscalYearStartMonth: number): string {
  const y = Number(period.from.slice(0, 4)), m = Number(period.from.slice(5, 7));
  const fyStart = Math.min(12, Math.max(1, fiscalYearStartMonth || 1));
  const fyYear = m >= fyStart ? y : y - 1;
  switch (preset) {
    case "THIS_MONTH": case "LAST_MONTH": return `${y}年${m}月`;
    case "THIS_QUARTER": return `${fyYear}年度 第${Math.floor(((m - fyStart + 12) % 12) / 3) + 1}四半期`;
    case "THIS_FY": case "LAST_FY": return `${fyYear}年度`;
    default: return `${period.from}〜${addDays(`${period.to}T00:00:00Z`, -1).slice(0, 10)}`;
  }
}
```
`rules/index.ts` に `export * from "./period.js";`。

### 2. 設定 (`rules/config.ts`)
`SalesConfig` に `fiscalYearStartMonth: number;` を追加、`DEFAULT_CONFIG` に `fiscalYearStartMonth: 4,`。(`taxRates` / `taxRounding` は 03 で追加済み。)

### 3. DTO (`api/dto.ts`)
- `ManagerSummary` に `period: Period; periodLabel: string;` を追加。
- `ManagerPerUserRow` に `wonCount: number; wonAmount: number;` を追加。
- `ManagerKpis` の `wonThisMonth` / `wonAmountThisMonth` / `lostThisMonth` は **名前をそのまま残す** (改名すると UI/テストの修正が広がる)。コメントを「期間内 (period)」に直す。
- `ManagerSummaryQuery = { period?: PeriodPreset | Period }` を export。

### 4. サービス (`getManagerSummary(actor, query: ManagerSummaryQuery = {})`)
01 で入れた monthFrom/monthTo の計算を置き換え:
```ts
    const tz = this.config.defaultTimezone;
    const preset = typeof query.period === "string" ? query.period : query.period ? undefined : "THIS_MONTH";
    const period = resolvePeriod(query.period, now, tz, this.config.fiscalYearStartMonth);
    const aggregates = this.repo.managerKpiAggregates(period.from, period.to, now);
    const perUserStats = this.repo.managerPerUserStats(now, stalledBefore, weekAgo, period.from, period.to);
```
戻り値に `period, periodLabel: periodLabel(period, preset, this.config.fiscalYearStartMonth)`、`perUser` の各行に `wonCount: s?.wonCount ?? 0, wonAmount: s?.wonAmount ?? 0`。

### 5. リポジトリ (`managerPerUserStats`)
引数に `closedFrom: string, closedTo: string` を追加し、`GROUP BY owner_user_id` のクエリを 1 本足す:
```ts
    const won = this.db.all<{ owner_user_id: string; n: number; amount: number }>(
      "SELECT owner_user_id, COUNT(*) AS n, COALESCE(SUM(won_amount), 0) AS amount FROM opportunities " +
      "WHERE lifecycle_state = 'WON' AND closed_at >= ? AND closed_at < ? GROUP BY owner_user_id", closedFrom, closedTo);
```
結果 Map の型に `wonCount`, `wonAmount` を足し、JS で結合 (既存の他メトリクスと同じやり方)。

### 6. RPC (3 か所)
`getManagerSummary(query?: ManagerSummaryQuery): Promise<ManagerSummary>`。型 `Period`, `PeriodPreset`, `ManagerSummaryQuery` を management-types に追加。

### 7. 画面 — 期間セレクタ (`app/components/PeriodPicker.tsx` 新規)
```tsx
import { useState } from "react";
import type { Period, PeriodPreset } from "../../src/management-types";

export const PERIOD_PRESET_LABEL: Record<PeriodPreset, string> = {
  THIS_MONTH: "今月", LAST_MONTH: "先月", THIS_QUARTER: "今四半期", THIS_FY: "今年度", LAST_FY: "前年度",
};

export type PeriodChoice = { preset: PeriodPreset } | { custom: Period };

export function PeriodPicker({ value, onChange }: { value: PeriodChoice; onChange: (next: PeriodChoice) => void }) {
  const [from, setFrom] = useState("custom" in value ? value.custom.from : "");
  const [to, setTo] = useState("custom" in value ? value.custom.to : "");
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {(Object.keys(PERIOD_PRESET_LABEL) as PeriodPreset[]).map((p) => (
        <button key={p} type="button" onClick={() => onChange({ preset: p })}
          className={`press rounded-lg border px-2.5 py-1 text-xs font-medium ${"preset" in value && value.preset === p ? "border-kumo-brand text-kumo-brand" : "border-kumo-line text-kumo-subtle"}`}>
          {PERIOD_PRESET_LABEL[p]}
        </button>
      ))}
      <input type="date" value={from} onChange={(e) => setFrom(e.currentTarget.value)} className="h-7 rounded-md border border-kumo-line bg-kumo-base px-2 text-xs" />
      <span className="text-xs text-kumo-subtle">〜</span>
      <input type="date" value={to} onChange={(e) => setTo(e.currentTarget.value)} className="h-7 rounded-md border border-kumo-line bg-kumo-base px-2 text-xs" />
      <button type="button" disabled={!from || !to || from > to} onClick={() => onChange({ custom: { from, to: nextDay(to) } })}
        className="press rounded-lg border border-kumo-line px-2.5 py-1 text-xs font-medium text-kumo-subtle disabled:opacity-50">
        任意期間
      </button>
    </div>
  );
}

function nextDay(ymd: string): string {   // to is exclusive on the server; the user picks an inclusive end date
  const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10);
}
```
`ManagerPage`: state `choice: PeriodChoice` (初期 `{ preset: "THIS_MONTH" }`)、`useAsyncData(() => api.getManagerSummary("preset" in choice ? { period: choice.preset } : { period: choice.custom }), [api, choice])`。KPI 見出しに `data.periodLabel`。タイルのラベル「今月受注」「今月失注」→「受注」「失注」(期間は見出しで示す)。担当者別の表に列「受注 (件 / 金額)」。

### 8. 画面 — 設定 (`SettingsPage`)
- `NUMBER_FIELDS` に `{ key: "fiscalYearStartMonth", label: "会計年度の開始月", unit: "月", min: 1, step: 1 }` (max 12 は input に `max={12}` を足す。無理なら保存時に `saveConfig` 側で 1〜12 に丸める → `rules/config.ts` の `saveConfig` に `if (key === "fiscalYearStartMonth") …` の検証を追加)。
- 新しい節「消費税」: 標準税率 (%) / 軽減税率 (%) / 端数処理 (select: 切り捨て/四捨五入/切り上げ)。保存は `api.updateConfig({ taxRates: { STANDARD: s/100, REDUCED: r/100, EXEMPT: 0 }, taxRounding })`。

## テスト (`packages/sales-core/__tests__/period.test.ts` 新規)
```ts
import { describe, expect, it } from "vitest";
import { periodLabel, resolvePeriod } from "../src/rules/period.js";

const TZ = "Asia/Tokyo";

describe("resolvePeriod (F1)", () => {
  const sep8 = "2026-09-08T01:00:00Z";
  it("this / last month", () => {
    expect(resolvePeriod("THIS_MONTH", sep8, TZ, 4)).toEqual({ from: "2026-09-01", to: "2026-10-01" });
    expect(resolvePeriod("LAST_MONTH", sep8, TZ, 4)).toEqual({ from: "2026-08-01", to: "2026-09-01" });
    expect(resolvePeriod("LAST_MONTH", "2026-01-15T00:00:00Z", TZ, 4)).toEqual({ from: "2025-12-01", to: "2026-01-01" });
  });
  it("fiscal year starting in April: September is Q2 of FY2026; March 2027 is Q4 of FY2026", () => {
    expect(resolvePeriod("THIS_QUARTER", sep8, TZ, 4)).toEqual({ from: "2026-07-01", to: "2026-10-01" });
    expect(resolvePeriod("THIS_FY", sep8, TZ, 4)).toEqual({ from: "2026-04-01", to: "2027-04-01" });
    expect(resolvePeriod("LAST_FY", sep8, TZ, 4)).toEqual({ from: "2025-04-01", to: "2026-04-01" });
    expect(resolvePeriod("THIS_QUARTER", "2027-03-10T00:00:00Z", TZ, 4)).toEqual({ from: "2027-01-01", to: "2027-04-01" });
    expect(resolvePeriod("THIS_FY", "2027-03-10T00:00:00Z", TZ, 4)).toEqual({ from: "2026-04-01", to: "2027-04-01" });
  });
  it("fiscal year starting in January", () => {
    expect(resolvePeriod("THIS_QUARTER", sep8, TZ, 1)).toEqual({ from: "2026-07-01", to: "2026-10-01" });
    expect(resolvePeriod("THIS_FY", sep8, TZ, 1)).toEqual({ from: "2026-01-01", to: "2027-01-01" });
  });
  it("custom period is validated", () => {
    expect(resolvePeriod({ from: "2026-01-01", to: "2026-02-01" }, sep8, TZ, 4)).toEqual({ from: "2026-01-01", to: "2026-02-01" });
    expect(() => resolvePeriod({ from: "2026-02-01", to: "2026-01-01" }, sep8, TZ, 4)).toThrow();
  });
  it("labels", () => {
    expect(periodLabel({ from: "2026-09-01", to: "2026-10-01" }, "THIS_MONTH", 4)).toBe("2026年9月");
    expect(periodLabel({ from: "2026-07-01", to: "2026-10-01" }, "THIS_QUARTER", 4)).toBe("2026年度 第2四半期");
    expect(periodLabel({ from: "2026-04-01", to: "2026-06-30" }, undefined, 4)).toBe("2026-04-01〜2026-06-29");
  });
});
```
`pipeline.test.ts` の C1 KPI テストはそのまま通るはず (既定 THIS_MONTH)。`getManagerSummary` に期間を渡すテストを 1 つ追加: `{ period: "LAST_MONTH" }` で 8/30 の受注だけ数える。

## 検証
共通コマンド。期待: sales-core 292 前後 (286 + 5 + 1)、gatekeeper-sales 48。

## コミット件名
`Sales OS: period selector (month / quarter / fiscal year) for team KPIs, tax and FY settings`

## 完了チェック
- [ ] チーム画面で「先月」「今年度」「任意期間」を切り替えると KPI と担当者別の受注が変わる (ユーザー確認)
- [ ] 設定で会計年度開始月と税率を変えて保存できる

## 止まって聞く
- `managerPerUserStats` の結合方法が上記の想定 (メトリクスごとの Map 結合) と違う。
