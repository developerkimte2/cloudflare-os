# 06 — F3 CSV 出力 (migration なし)

前提: 01〜05 がコミット済み。

## 目的
案件・明細・顧客・担当者・次アクション・活動・集計を CSV で出せるようにする。**sandbox iframe ではダウンロードも `window.open` も動かない前提**なので、CSV 文字列を画面に出して **クリップボードにコピー** する方式。

## 先に読むファイル
1. `packages/sales-core/src/service/sales-service.ts` — `listOpportunities`, `listNextActions`, `getCustomer`, `getSalesReport`, `summarize`
2. `packages/sales-core/src/db/repository.ts` — `listOpportunitiesVisibleTo`, `listPersonsForAccount`, `listLineItems`, activities の一覧関数 (`grep -n "listActivities"`)
3. `packages/sales-core/src/domain/util.ts` — `formatLocal`
4. `packages/gatekeeper-sales/app/labels.ts` — 各ラベル表
5. `packages/gatekeeper-sales/app/pages/OpportunitiesPage.tsx` — ヘッダのボタン配置
6. `packages/gatekeeper-sales/app/components/AnswerView.tsx` — モーダル的な枠の作り (参考)
7. RPC 3 ファイル

## 手順

### 1. CSV の純関数 (`rules/csv.ts` 新規)
```ts
/** RFC 4180 with CRLF and a UTF-8 BOM so Excel on Windows opens it as UTF-8. */
export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(esc).join(","), ...rows.map(r => r.map(esc).join(","))];
  return "﻿" + lines.join("\r\n") + "\r\n";
}

export const CSV_MAX_ROWS = 5000;
```
`rules/index.ts` に `export * from "./csv.js";`。

### 2. DTO (`api/dto.ts`)
```ts
export type ExportKind = "OPPORTUNITIES" | "LINE_ITEMS" | "ACCOUNTS" | "PERSONS" | "NEXT_ACTIONS" | "ACTIVITIES" | "REPORT";
export const EXPORT_KINDS: ExportKind[] = ["OPPORTUNITIES", "LINE_ITEMS", "ACCOUNTS", "PERSONS", "NEXT_ACTIONS", "ACTIVITIES", "REPORT"];
export interface ExportQuery {
  kind: ExportKind;
  filter?: OpportunityFilter;              // OPPORTUNITIES / LINE_ITEMS / ACTIVITIES
  period?: PeriodPreset | Period;          // REPORT
  groupBy?: ReportGroupBy;                 // REPORT
}
export interface ExportResult { filename: string; csv: string; rows: number }
```

### 3. 日本語ラベルを sales-core 側に置く
`app/labels.ts` の `LIFECYCLE_LABEL`, `OPERATIONAL_LABEL`, `RISK_LABEL`, `NEXT_ACTION_STATUS_LABEL`, `NEXT_ACTION_TYPE_LABEL`, `PRIORITY_LABEL`, `ACTIVITY_TYPE_LABEL` の **値をそのまま** `packages/sales-core/src/domain/labels-ja.ts` (新規) に移し、`app/labels.ts` はそれを import して re-export する (05 の `LOST_REASON_LABEL_JA` と同じやり方)。画面側の import 元は変えない。

### 4. サービス — `exportCsv(actor, query): ExportResult`
```ts
  exportCsv(actor: Actor, query: ExportQuery): ExportResult {
    const user = this.requireUser(actor);
    const tz = user.timezone || this.config.defaultTimezone;
    const dt = (iso: string | undefined) => iso ? formatLocal(iso, tz) : "";
    const stamp = localDate(nowIso(this.ctx.clock), tz).replace(/-/g, "");
    let headers: string[] = [], rows: (string | number | null | undefined)[][] = [];
    switch (query.kind) {
      case "OPPORTUNITIES": {
        const list = this.listOpportunities(actor, { ...query.filter, limit: CSV_MAX_ROWS + 1 });
        headers = ["案件ID", "顧客", "案件名", "担当", "窓口", "状態", "運用状態", "フェーズ", "見込金額", "通貨", "受注予定日", "受注額", "確定日", "失注理由", "競合", "リスク", "最終活動", "更新日時"];
        rows = list.map(o => [o.id, o.accountName, o.title, o.ownerName, o.contactNames.join("、"), LIFECYCLE_LABEL_JA[o.lifecycleState],
          OPERATIONAL_LABEL_JA[o.operationalState], o.phaseLabel, o.expectedAmount, o.currency ?? this.config.defaultCurrency, o.expectedCloseDate,
          o.wonAmount, o.closedAt, o.lostReason ? LOST_REASON_LABEL_JA[o.lostReason] : "", o.competitor, RISK_LABEL_JA[o.riskLevel],
          dt(o.lastMeaningfulActivityAt), dt(o.updatedAt)]);
        break;
      }
      case "LINE_ITEMS": { /* 案件ごとに listLineItems: 案件ID, 顧客, 案件名, 品目ID, 品目名, 数量, 単価, 値引, 小計, 税区分 */ break; }
      case "ACCOUNTS": { /* 可視な顧客 (SALES は自分の案件がある顧客): 顧客ID, 顧客名, 電話, 住所, Web, 確定状態, 作成日時 (08 の項目は 08 で追加) */ break; }
      case "PERSONS": { /* 可視な顧客の担当者: 顧客名, 氏名, 役職, メール, 電話 */ break; }
      case "NEXT_ACTIONS": { /* listNextActions(actor, {}) : 案件, 顧客, 種類, タイトル, 目的, 期限, 優先度, 状態, 担当, 生成元 */ break; }
      case "ACTIVITIES": { /* 可視案件の活動: 案件, 顧客, 日時, 種類, 要約 */ break; }
      case "REPORT": {
        if (!query.groupBy) throw new TypeError("集計軸を指定してください");
        const report = this.getSalesReport(actor, { period: query.period, groupBy: query.groupBy });
        headers = ["区分", "進行中件数", "見込額", "受注件数", "受注額", "失注件数", "失注額", "受注率"];
        rows = [...report.rows, report.total].map(r => [r.label, r.openCount, r.expectedAmount, r.wonCount, r.wonAmount, r.lostCount, r.lostAmount,
          r.winRate === undefined ? "" : Math.round(r.winRate * 100)]);
        break;
      }
    }
    if (rows.length > CSV_MAX_ROWS) throw new TypeError(`${CSV_MAX_ROWS.toLocaleString()} 行を超えています。期間や条件で絞ってください`);
    return { filename: `sales-os_${query.kind.toLowerCase()}_${stamp}.csv`, csv: toCsv(headers, rows), rows: rows.length };
  }
```
コメント部分は実装する (列は書いてあるとおり)。可視性は各 list 関数に任せ、**自分で SQL を書かない**。

### 5. RPC (3 か所)
`exportCsv(query: ExportQuery): Promise<ExportResult>`。型 `ExportKind`, `ExportQuery`, `ExportResult` を追加。

### 6. 画面 — `app/components/CsvModal.tsx` 新規
```tsx
import { useState } from "react";

export function CsvModal({ title, result, onClose }: { title: string; result: { filename: string; csv: string; rows: number }; onClose: () => void }) {
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  const copy = async () => {
    try { await navigator.clipboard.writeText(result.csv); setCopied("ok"); return; } catch { /* fall through */ }
    const ta = document.getElementById("csv-modal-text") as HTMLTextAreaElement | null;
    if (ta) { ta.select(); setCopied(document.execCommand("copy") ? "ok" : "fail"); } else setCopied("fail");
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-xl border border-kumo-line bg-kumo-control p-4">
        <p className="text-sm font-medium text-kumo-default">{title} — {result.rows.toLocaleString()} 行 ({result.filename})</p>
        <p className="mt-1 text-xs text-kumo-subtle">
          この画面ではファイル保存ができません。「コピー」してテキストエディタや Excel に貼り付け、{result.filename} として保存してください。
        </p>
        <textarea id="csv-modal-text" readOnly value={result.csv} className="mt-2 h-64 w-full rounded-md border border-kumo-line bg-kumo-base p-2 font-mono text-xs" />
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={copy} className="press rounded-lg bg-kumo-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-kumo-brand-hover">
            {copied === "ok" ? "コピーしました" : copied === "fail" ? "コピーできません (手動で選択)" : "コピー"}
          </button>
          <button type="button" onClick={onClose} className="press rounded-lg border border-kumo-line px-3 py-1.5 text-sm text-kumo-subtle">閉じる</button>
        </div>
      </div>
    </div>
  );
}
```
配置:
- `OpportunitiesPage`: 検索欄の横に「CSV」ボタン → `api.exportCsv({ kind: "OPPORTUNITIES", filter: 現在のフィルタ })` → `CsvModal`。
- `ReportPage` (05): 「CSV」→ `{ kind: "REPORT", period, groupBy }`。
- `SettingsPage`: 節「データ出力」に kind ごとのボタン (案件 / 明細 / 顧客 / 担当者 / 次アクション / 活動)。`labels.ts` に `EXPORT_KIND_LABEL`。

## テスト
`packages/sales-core/__tests__/csv.test.ts` 新規:
```ts
import { describe, expect, it } from "vitest";
import { FakeLlmProvider } from "../src/ai/provider.js";
import { toCsv } from "../src/rules/csv.js";
import { makeAccount, makeOpportunity, makeService, makeUser } from "./helpers.js";

describe("toCsv (F3)", () => {
  it("quotes commas, quotes and newlines; BOM + CRLF", () => {
    const csv = toCsv(["a", "b"], [["x,y", 'say "hi"'], ["line\nbreak", 12]]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toBe('﻿a,b\r\n"x,y","say ""hi"""\r\n"line\nbreak",12\r\n');
  });
});

describe("exportCsv (F3)", () => {
  it("exports the deals a SALES user can see, with Japanese labels", () => {
    const svc = makeService(new FakeLlmProvider([]), "2026-09-08T01:00:00Z");
    const rep = makeUser(svc.repo, "SALES"); const other = makeUser(svc.repo, "SALES");
    const account = makeAccount(svc.repo, { displayName: "ABC" });
    makeOpportunity(svc.repo, account.id, rep.id, { title: "mine", expectedAmount: 100 });
    makeOpportunity(svc.repo, account.id, other.id, { title: "theirs" });
    const out = svc.exportCsv({ userId: rep.id }, { kind: "OPPORTUNITIES" });
    expect(out.rows).toBe(1);
    expect(out.csv).toContain("mine");
    expect(out.csv).not.toContain("theirs");
    expect(out.csv).toContain("進行中");        // LIFECYCLE label, not "OPEN"
    expect(out.csv).not.toMatch(/\bOPEN\b/);
    expect(out.filename).toBe("sales-os_opportunities_20260908.csv");
  });
});
```

## 検証
共通コマンド。期待: sales-core +2、gatekeeper-sales 48。`node:sqlite` 0。

## コミット件名
`Sales OS: CSV export (copy-to-clipboard) for deals, line items, customers, contacts, actions, reports`

## 完了チェック
- [ ] 案件一覧の「CSV」でモーダルが出て、コピーして Excel に貼れる (ユーザー確認)。文字化けしない (BOM)

## 止まって聞く
- ラベル表を sales-core 側へ移すときに、`app/labels.ts` が型を `@gadgets/sales-core` の enum 型で宣言していて循環や型不一致になる。
