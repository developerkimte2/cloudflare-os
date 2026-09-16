# 05 — F2 集計ページ (migration なし)

前提: 01〜04 がコミット済み。

## 目的
期間 × 軸 (担当者 / 顧客 / 商材 / フェーズ / 失注理由 / 月) で、受注件数・受注額・失注件数・失注額・進行中件数・見込額・受注率を表にする新ページ「集計」。

## 先に読むファイル
1. `packages/sales-core/src/rules/period.ts` (04)
2. `packages/sales-core/src/db/repository.ts` — `managerPerUserStats` (GROUP BY の書き方)、`listOpportunitiesVisibleTo` (SALES の可視性条件)
3. `packages/sales-core/src/service/sales-service.ts` — `getManagerSummary`
4. `packages/gatekeeper-sales/app/pages/ManagerPage.tsx` — 表の作り、`PeriodPicker` の使い方 (04)
5. `packages/gatekeeper-sales/app/App.tsx` — `Route`、`ROUTE_LABEL`、ナビ配列 (262 行付近)、各ページの描画 (159 行付近)
6. RPC 3 ファイル

## 手順

### 1. DTO (`api/dto.ts`)
```ts
export type ReportGroupBy = "OWNER" | "ACCOUNT" | "PRODUCT" | "PHASE" | "LOST_REASON" | "MONTH";
export const REPORT_GROUP_BYS: ReportGroupBy[] = ["OWNER", "ACCOUNT", "PRODUCT", "PHASE", "LOST_REASON", "MONTH"];

export interface ReportRow {
  key: string;            // user id / account id / product id / phase label / lost reason / YYYY-MM
  label: string;
  openCount: number;      // current, not period-bound
  expectedAmount: number; // current, tax-exclusive
  wonCount: number;       // closedAt in period
  wonAmount: number;
  lostCount: number;
  lostAmount: number;     // expectedAmount at the time (what was lost)
  winRate?: number;       // wonCount / (wonCount + lostCount); undefined when both are 0
}

export interface SalesReport {
  period: Period;
  periodLabel: string;
  groupBy: ReportGroupBy;
  rows: ReportRow[];
  total: ReportRow;       // key "TOTAL", label "合計"
}

export interface SalesReportQuery { period?: PeriodPreset | Period; groupBy: ReportGroupBy }
```

### 2. リポジトリ (`db/repository.ts`) — 新メソッド
```ts
  /**
   * Raw per-key aggregates for the 集計 page. `ownerUserId` restricts to one rep's deals (a SALES
   * user's own view); undefined = everyone. PRODUCT groups by line-item rows, so amounts there are
   * row subtotals (quantity*unit_price-discount), not the deal's expected/won amount.
   */
  reportAggregates(groupBy: ReportGroupBy, closedFrom: string, closedTo: string, ownerUserId?: string): Map<string, {
    openCount: number; expectedAmount: number; wonCount: number; wonAmount: number; lostCount: number; lostAmount: number;
  }> {
    const own = ownerUserId ? " AND o.owner_user_id = ?" : "";
    const ownArgs = ownerUserId ? [ownerUserId] : [];
    const keyExpr = {
      OWNER: "o.owner_user_id", ACCOUNT: "o.account_id", PHASE: "COALESCE(o.phase_label, '')",
      LOST_REASON: "COALESCE(o.lost_reason, '')", MONTH: "substr(o.closed_at, 1, 7)", PRODUCT: "COALESCE(li.product_id, '')",
    }[groupBy];
    const from = groupBy === "PRODUCT"
      ? "opportunities o JOIN opportunity_line_items li ON li.opportunity_id = o.id"
      : "opportunities o";
    const amount = groupBy === "PRODUCT"
      ? "(li.quantity * li.unit_price - li.discount_amount)"
      : "COALESCE(o.expected_amount, 0)";
    const wonAmount = groupBy === "PRODUCT" ? amount : "COALESCE(o.won_amount, 0)";
    const rows = new Map<string, { openCount: number; expectedAmount: number; wonCount: number; wonAmount: number; lostCount: number; lostAmount: number }>();
    const bump = (key: string) => rows.get(key) ?? (rows.set(key, { openCount: 0, expectedAmount: 0, wonCount: 0, wonAmount: 0, lostCount: 0, lostAmount: 0 }), rows.get(key)!);
    if (groupBy !== "MONTH" && groupBy !== "LOST_REASON") {
      for (const r of this.db.all<{ k: string; n: number; a: number }>(
        `SELECT ${keyExpr} AS k, COUNT(DISTINCT o.id) AS n, SUM(${amount}) AS a FROM ${from} WHERE o.lifecycle_state = 'OPEN'${own} GROUP BY k`, ...ownArgs)) {
        const row = bump(r.k); row.openCount = r.n; row.expectedAmount = r.a ?? 0;
      }
    }
    if (groupBy !== "LOST_REASON") {
      for (const r of this.db.all<{ k: string; n: number; a: number }>(
        `SELECT ${keyExpr} AS k, COUNT(DISTINCT o.id) AS n, SUM(${wonAmount}) AS a FROM ${from} WHERE o.lifecycle_state = 'WON' AND o.closed_at >= ? AND o.closed_at < ?${own} GROUP BY k`,
        closedFrom, closedTo, ...ownArgs)) {
        const row = bump(r.k); row.wonCount = r.n; row.wonAmount = r.a ?? 0;
      }
    }
    for (const r of this.db.all<{ k: string; n: number; a: number }>(
      `SELECT ${keyExpr} AS k, COUNT(DISTINCT o.id) AS n, SUM(${amount}) AS a FROM ${from} WHERE o.lifecycle_state = 'LOST' AND o.closed_at >= ? AND o.closed_at < ?${own} GROUP BY k`,
      closedFrom, closedTo, ...ownArgs)) {
      const row = bump(r.k); row.lostCount = r.n; row.lostAmount = r.a ?? 0;
    }
    return rows;
  }
```
注: PRODUCT の `COUNT(DISTINCT o.id)` は「その品目を含む案件数」。`this.db.all` の可変長引数の形は既存呼び出しに合わせる (`...params`)。

### 3. サービス
```ts
  getSalesReport(actor: Actor, query: SalesReportQuery): SalesReport {
    const user = this.requireUser(actor);
    const now = nowIso(this.ctx.clock);
    const tz = this.config.defaultTimezone;
    const preset = typeof query.period === "string" ? query.period : query.period ? undefined : "THIS_MONTH";
    const period = resolvePeriod(query.period, now, tz, this.config.fiscalYearStartMonth);
    const raw = this.repo.reportAggregates(query.groupBy, period.from, period.to, user.role === "SALES" ? user.id : undefined);
    const label = (key: string): string => {
      switch (query.groupBy) {
        case "OWNER": return this.repo.getUser(key)?.displayName ?? "(不明)";
        case "ACCOUNT": return this.repo.getAccount(key)?.displayName ?? "(不明)";
        case "PRODUCT": return key ? (this.repo.getProduct(key)?.name ?? "(削除された品目)") : "(自由入力)";
        case "PHASE": return key || "(フェーズ未設定)";
        case "LOST_REASON": return key ? LOST_REASON_LABEL_JA[key as LostReason] : "(理由なし)";
        case "MONTH": return key ? `${key.slice(0, 4)}年${Number(key.slice(5, 7))}月` : "(日付なし)";
      }
    };
    const rows: ReportRow[] = [...raw.entries()].map(([key, v]) => ({
      key, label: label(key), ...v,
      winRate: v.wonCount + v.lostCount > 0 ? v.wonCount / (v.wonCount + v.lostCount) : undefined,
    })).sort((a, b) => b.wonAmount - a.wonAmount || b.expectedAmount - a.expectedAmount || a.label.localeCompare(b.label, "ja"));
    const total = rows.reduce((t, r) => ({
      ...t, openCount: t.openCount + r.openCount, expectedAmount: t.expectedAmount + r.expectedAmount,
      wonCount: t.wonCount + r.wonCount, wonAmount: t.wonAmount + r.wonAmount, lostCount: t.lostCount + r.lostCount, lostAmount: t.lostAmount + r.lostAmount,
    }), { key: "TOTAL", label: "合計", openCount: 0, expectedAmount: 0, wonCount: 0, wonAmount: 0, lostCount: 0, lostAmount: 0 } as ReportRow);
    total.winRate = total.wonCount + total.lostCount > 0 ? total.wonCount / (total.wonCount + total.lostCount) : undefined;
    return { period, periodLabel: periodLabel(period, preset, this.config.fiscalYearStartMonth), groupBy: query.groupBy, rows, total };
  }
```
`LOST_REASON_LABEL_JA` は sales-core 側に無いので `domain/types.ts` の `LOST_REASONS` の隣に日本語表 `LOST_REASON_LABEL_JA: Record<LostReason, string>` を追加し、`app/labels.ts` の `LOST_REASON_LABEL` は **それを re-export する形に変える** (二重管理を避ける)。

### 4. RPC (3 か所)
`getSalesReport(query: SalesReportQuery): Promise<SalesReport>`。型 `ReportGroupBy`, `ReportRow`, `SalesReport`, `SalesReportQuery` を追加。

### 5. 画面 — `app/pages/ReportPage.tsx` 新規
- props: `api`, `onOpenOpportunity`, `onOpenCustomer` (App.tsx から渡す。既存の `openCustomer` を利用)。
- state: `choice: PeriodChoice` (04)、`groupBy: ReportGroupBy` (初期 OWNER)。
- 上部: `PeriodPicker` + 軸タブ (`REPORT_GROUP_LABEL`: 担当者/顧客/商材/フェーズ/失注理由/月)。
- 表: ラベル / 進行中 (件) / 見込額 / 受注 (件) / 受注額 / 失注 (件) / 失注額 / 受注率 (%)。最後に合計行 (太字)。金額は `toLocaleString("ja-JP")` + 円。受注率は `Math.round(r*100)`。
- 行クリック: ACCOUNT → `onOpenCustomer(row.key)`。それ以外はクリック無し (案件一覧の絞り込みは後回し)。
- `labels.ts` に `REPORT_GROUP_LABEL`。
- `App.tsx`: `Route` に `{ kind: "report" }`、`ROUTE_LABEL.report = "集計"`、ナビに `{ route: { kind: "report" }, label: "集計", icon: ChartBar }` (アイコンは既存 import 元 phosphor から。無ければ `SquaresFour` を流用)。**全ロールに表示** (SALES は自分の分だけ返る)。

## テスト (`packages/sales-core/__tests__/report.test.ts` 新規)
```ts
import { describe, expect, it } from "vitest";
import { FakeLlmProvider } from "../src/ai/provider.js";
import { makeAccount, makeOpportunity, makeService, makeUser } from "./helpers.js";

const NOW = "2026-09-08T01:00:00Z";

describe("sales report (F2)", () => {
  function seed() {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const manager = makeUser(svc.repo, "MANAGER", { displayName: "上司" });
    const rep = makeUser(svc.repo, "SALES", { displayName: "営業A" });
    const abc = makeAccount(svc.repo, { displayName: "ABC" });
    const xyz = makeAccount(svc.repo, { displayName: "XYZ" });
    const m = { userId: manager.id }, r = { userId: rep.id };
    const won = makeOpportunity(svc.repo, abc.id, rep.id, { expectedAmount: 100, phaseLabel: "提案" });
    svc.updateOpportunity(r, won.id, { lifecycleState: "WON", closedAt: "2026-09-03", version: 1 });
    const lost = makeOpportunity(svc.repo, xyz.id, manager.id, { expectedAmount: 50, phaseLabel: "提案" });
    svc.updateOpportunity(m, lost.id, { lifecycleState: "LOST", lostReason: "PRICE", closedAt: "2026-09-04", version: 1 });
    makeOpportunity(svc.repo, xyz.id, manager.id, { expectedAmount: 70, phaseLabel: "見込" });   // open
    const oldWon = makeOpportunity(svc.repo, abc.id, rep.id, { expectedAmount: 999 });
    svc.updateOpportunity(r, oldWon.id, { lifecycleState: "WON", closedAt: "2026-08-20", version: 1 });
    return { svc, m, r, rep, manager, abc, xyz };
  }

  it("groups by owner within the period, with totals and win rate", () => {
    const { svc, m, rep } = seed();
    const report = svc.getSalesReport(m, { groupBy: "OWNER" });
    const a = report.rows.find(x => x.key === rep.id)!;
    expect(a.label).toBe("営業A");
    expect(a.wonCount).toBe(1); expect(a.wonAmount).toBe(100);
    expect(report.total.wonCount).toBe(1); expect(report.total.lostCount).toBe(1);
    expect(report.total.winRate).toBe(0.5);
    expect(report.total.openCount).toBe(1); expect(report.total.expectedAmount).toBe(70);
  });

  it("groups by phase, lost reason and month", () => {
    const { svc, m } = seed();
    expect(svc.getSalesReport(m, { groupBy: "PHASE" }).rows.find(x => x.key === "提案")!.lostCount).toBe(1);
    expect(svc.getSalesReport(m, { groupBy: "LOST_REASON" }).rows.find(x => x.key === "PRICE")!.label).toBe("価格");
    const months = svc.getSalesReport(m, { groupBy: "MONTH", period: "LAST_MONTH" }).rows;
    expect(months.find(x => x.key === "2026-08")!.wonAmount).toBe(999);
  });

  it("a SALES user only sees their own deals", () => {
    const { svc, r } = seed();
    const report = svc.getSalesReport(r, { groupBy: "ACCOUNT" });
    expect(report.rows.map(x => x.label)).toEqual(["ABC"]);
    expect(report.total.lostCount).toBe(0);
  });
});
```
PRODUCT 軸は 03 の `setLineItems` で 2 案件に明細を入れたケースを 1 つ追加 (行の小計が集計されること)。

## 検証
共通コマンド。期待: sales-core 296 前後、gatekeeper-sales 48。

## コミット件名
`Sales OS: 集計 page — won/lost/pipeline by rep, customer, product, phase, reason, month`

## 完了チェック
- [ ] ナビに「集計」が出て、期間と軸を切り替えられる (ユーザー確認)
- [ ] SALES で開くと自分の分だけ

## 止まって聞く
- `this.db.all` が可変長引数を取らない (配列渡し等) 場合は既存の呼び出しに合わせて書き換えてよいが、SQL 文字列の組み立てで迷ったら止める。
