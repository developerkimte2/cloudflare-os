# 01 — C1 受注/失注の確定記録 (migration 0007)

## 目的
WON/LOST は今 `lifecycleState` の値でしかない。受注額・受注日・失注理由・競合を **人が** 入力して残す。チーム画面の「今月受注」を受注日 (closed_at) と受注額で数える。

## 先に読むファイル (Read してから編集)
1. `packages/sales-core/src/domain/types.ts` — `LifecycleState` と `Opportunity` (88 行付近)
2. `packages/sales-core/src/db/migrations.ts` — 末尾の `0006_source_document_target_opportunity`
3. `packages/sales-core/src/db/tables.ts` — `opportunities`
4. `packages/sales-core/src/api/dto.ts` — `OpportunityPatch`, `OpportunitySummary`, `ManagerKpis`
5. `packages/sales-core/src/service/sales-service.ts` — `updateOpportunity`, `summarize`, `getManagerSummary`, `resolveReview` の `case "STATE_AMBIGUOUS"`, ファイル末尾の `cleanText` / `startOfLocalMonth`
6. `packages/sales-core/src/db/repository.ts` — `managerKpiAggregates`
7. `packages/sales-core/src/domain/util.ts` — `localDate(iso, timeZone)` (YYYY-MM-DD を返す)
8. `packages/gatekeeper-sales/app/pages/OpportunityDetailPage.tsx` — `closingOut` (385 行付近) と `ConfirmInline` を使っている保存ボタン (490 行付近)
9. `packages/gatekeeper-sales/app/pages/ManagerPage.tsx` — KPI タイルの配列 (125 行付近)
10. `packages/gatekeeper-sales/app/labels.ts` — `LIFECYCLE_LABEL`, `AUDIT_ACTION_LABEL`
11. `packages/sales-core/__tests__/pipeline.test.ts` — `updateOpportunity(` を使っているテスト 1 つ (書き方の手本)

## 手順

### 1. ドメイン型 (`domain/types.ts`)
`export type LifecycleState = ...` の直後に追加:
```ts
/** Why a deal was lost. Chosen by a person when the deal is marked LOST -- never by the AI. */
export type LostReason = "PRICE" | "COMPETITOR" | "TIMING" | "BUDGET" | "NO_RESPONSE" | "NO_NEED" | "OTHER";
export const LOST_REASONS: LostReason[] = ["PRICE", "COMPETITOR", "TIMING", "BUDGET", "NO_RESPONSE", "NO_NEED", "OTHER"];
```
`Opportunity` の `proposalDocumentUrl?: string;` の直後に追加:
```ts
  /**
   * Close details, entered by a person when the deal becomes WON/LOST and cleared when it is
   * reopened. The AI never writes these (it may only propose a lifecycle change for review).
   */
  wonAmount?: number;
  /** YYYY-MM-DD in the closing user's timezone. Drives "won this period" KPIs, not updatedAt. */
  closedAt?: string;
  lostReason?: LostReason;
  lostReasonNote?: string;
  competitor?: string;
```

### 2. migration (`db/migrations.ts`)
`MIGRATIONS` 配列の **末尾** (0006 の `},` の後、`];` の前) に追記:
```ts
  {
    id: "0007_opportunity_close_details",
    sql: `
ALTER TABLE opportunities ADD COLUMN won_amount REAL;
ALTER TABLE opportunities ADD COLUMN closed_at TEXT;
ALTER TABLE opportunities ADD COLUMN lost_reason TEXT;
ALTER TABLE opportunities ADD COLUMN lost_reason_note TEXT;
ALTER TABLE opportunities ADD COLUMN competitor TEXT;
CREATE INDEX idx_opportunities_closed_at ON opportunities(closed_at);
`,
  },
```

### 3. 列マッピング (`db/tables.ts`)
`opportunities` の `col("risk_reason", "riskReason"),` の後に追加:
```ts
  col("won_amount", "wonAmount"), col("closed_at", "closedAt"), col("lost_reason", "lostReason"),
  col("lost_reason_note", "lostReasonNote"), col("competitor", "competitor"),
```

### 4. DTO (`api/dto.ts`)
- `OpportunityPatch` の `lifecycleState?: LifecycleState;` の直後に追加 (`LostReason` を import に足す):
```ts
  /** Close details (see Opportunity). Required by the service when the state changes to WON/LOST. */
  wonAmount?: number | null;
  closedAt?: string | null;
  lostReason?: LostReason | null;
  lostReasonNote?: string | null;
  competitor?: string | null;
```
- `OpportunitySummary` に同じ 5 項目を **optional (null なし)** で追加 (`riskReason?: string;` の後)。
- `ManagerKpis`: `wonThisMonth` の上のコメントを次に書き換え、`wonAmountThisMonth: number;` を `wonThisMonth` の直後に追加:
```ts
  /** Deals whose closedAt falls in the current local month (a person's close date, not updatedAt). */
  wonThisMonth: number;
  wonAmountThisMonth: number;
  lostThisMonth: number;
```

### 5. サービス (`service/sales-service.ts`)

5-1. `summarize()` の返すオブジェクトに `riskLevel: o.riskLevel, riskReason: o.riskReason,` の直後で追加:
```ts
      wonAmount: o.wonAmount, closedAt: o.closedAt, lostReason: o.lostReason,
      lostReasonNote: o.lostReasonNote, competitor: o.competitor,
```

5-2. `updateOpportunity()`:
- `if (patch.lifecycleState !== undefined) next.lifecycleState = patch.lifecycleState;` の直後に追加:
```ts
    if (patch.wonAmount !== undefined) next.wonAmount = patch.wonAmount ?? undefined;
    if (patch.closedAt !== undefined) next.closedAt = patch.closedAt ?? undefined;
    if (patch.lostReason !== undefined) next.lostReason = patch.lostReason ?? undefined;
    if (patch.lostReasonNote !== undefined) next.lostReasonNote = cleanText(patch.lostReasonNote);
    if (patch.competitor !== undefined) next.competitor = cleanText(patch.competitor);
    const closeChange = this.applyCloseRules(o, next, user.timezone || this.config.defaultTimezone);
```
- 監査の `action: "OPPORTUNITY_EDITED"` を次に変更:
```ts
      audit(this.ctx, { actorType: "USER", actorId: user.id,
        action: closeChange === "CLOSED" ? "OPPORTUNITY_CLOSED"
          : closeChange === "REOPENED" ? "OPPORTUNITY_REOPENED" : "OPPORTUNITY_EDITED",
        entityType: "opportunity", entityId: id, before: diffable(before), after: diffable(next) });
```
- `updateOpportunity` の直後に private メソッドを追加:
```ts
  /**
   * What a person must supply when a deal closes, and what gets cleared when it reopens.
   * Returns which of the two happened so the caller can pick the audit action.
   */
  private applyCloseRules(before: Opportunity, next: Opportunity, timezone: string): "CLOSED" | "REOPENED" | undefined {
    const isClosed = (s: LifecycleState) => s === "WON" || s === "LOST";
    if (next.lifecycleState === before.lifecycleState) return undefined;
    if (isClosed(next.lifecycleState)) {
      if (!next.closedAt) next.closedAt = localDate(nowIso(this.ctx.clock), timezone);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(next.closedAt)) throw new TypeError("日付は YYYY-MM-DD で入力してください");
      if (next.lifecycleState === "WON") {
        if (next.wonAmount === undefined) next.wonAmount = next.expectedAmount;
        if (next.wonAmount === undefined) throw new TypeError("受注額を入力してください");
        next.lostReason = undefined; next.lostReasonNote = undefined;
      } else {
        if (!next.lostReason) throw new TypeError("失注理由を選んでください");
        next.wonAmount = undefined;
      }
      return "CLOSED";
    }
    if (isClosed(before.lifecycleState)) {
      next.closedAt = undefined; next.wonAmount = undefined; next.lostReason = undefined;
      next.lostReasonNote = undefined; next.competitor = undefined;
      return "REOPENED";
    }
    return undefined;
  }
```
`localDate` を `../domain/util.js` から import する (既に import 行があれば追記)。`LifecycleState` の import も確認。

5-3. `resolveReview()` の `case "STATE_AMBIGUOUS"` の mutator を次に変更 (AI 判定の確認から確定した場合の既定値。**throw はしない**):
```ts
        case "STATE_AMBIGUOUS":
          if (typeof value.lifecycleState === "string") {
            const today = localDate(now, user.timezone || this.config.defaultTimezone);
            this.setOpportunityField(user, review.relatedEntityId!, o => {
              const next = value.lifecycleState as LifecycleState;
              const wasClosed = o.lifecycleState === "WON" || o.lifecycleState === "LOST";
              o.lifecycleState = next;
              if (next === "WON") {
                o.closedAt = o.closedAt ?? today; o.wonAmount = o.wonAmount ?? o.expectedAmount;
                o.lostReason = undefined; o.lostReasonNote = undefined;
              } else if (next === "LOST") {
                o.closedAt = o.closedAt ?? today; o.lostReason = o.lostReason ?? "OTHER";
                o.lostReasonNote = o.lostReasonNote ?? "AI 判定の確認から確定 (理由は未入力)"; o.wonAmount = undefined;
              } else if (wasClosed) {
                o.closedAt = undefined; o.wonAmount = undefined; o.lostReason = undefined;
                o.lostReasonNote = undefined; o.competitor = undefined;
              }
            }, "LIFECYCLE_CONFIRMED");
          }
          break;
```
`now` がそのスコープに無ければ、`resolveReview` 冒頭の変数名 (`nowIso(this.ctx.clock)` を入れているもの) を使う。

5-4. `getManagerSummary()`:
- `const monthStart = startOfLocalMonth(now, this.config.defaultTimezone);` を次に置き換え:
```ts
    const tz = this.config.defaultTimezone;
    const monthStart = startOfLocalMonth(now, tz);
    const monthFrom = localDate(monthStart, tz);                        // YYYY-MM-01
    const monthTo = localDate(startOfLocalMonth(addDays(monthStart, 35), tz), tz);  // 翌月 01
    const aggregates = this.repo.managerKpiAggregates(monthFrom, monthTo, now);
```
(元の `const aggregates = ...` 行は削除。`addDays` は既に import 済み。)
- `kpis` に `wonAmountThisMonth: aggregates.wonAmountThisMonth,` を追加。

### 6. リポジトリ (`db/repository.ts` の `managerKpiAggregates`)
シグネチャと WON/LOST の SQL を変更:
```ts
  managerKpiAggregates(closedFrom: string, closedTo: string, now: string): {
    expectedAmountTotal: number; wonThisMonth: number; wonAmountThisMonth: number; lostThisMonth: number;
    overdueActions: number; unresolvedCustomers: number;
  } {
    ...
    const won = this.db.one<{ count: number; amount: number }>(
      "SELECT COUNT(*) AS count, COALESCE(SUM(won_amount), 0) AS amount FROM opportunities " +
      "WHERE lifecycle_state = 'WON' AND closed_at >= ? AND closed_at < ?", closedFrom, closedTo)!;
    const lost = this.db.one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM opportunities WHERE lifecycle_state = 'LOST' AND closed_at >= ? AND closed_at < ?",
      closedFrom, closedTo)!;
    ...
    return { ..., wonThisMonth: won.count, wonAmountThisMonth: won.amount, lostThisMonth: lost.count, ... };
```
コメント「monthStart」への言及があれば closedFrom/closedTo に直す。

### 7. ラベル (`app/labels.ts`)
```ts
export const LOST_REASON_LABEL: Record<LostReason, string> = {
  PRICE: "価格", COMPETITOR: "競合", TIMING: "時期", BUDGET: "予算", NO_RESPONSE: "無反応", NO_NEED: "ニーズ消失", OTHER: "その他",
};
```
(`LostReason` を `@gadgets/sales-core` から type import。他のラベルと同じ書き方。)
`AUDIT_ACTION_LABEL` に追加: `OPPORTUNITY_CLOSED: "案件を確定 (受注/失注)"`, `OPPORTUNITY_REOPENED: "案件を再開"`。

### 8. 画面 — 案件詳細 (`app/pages/OpportunityDetailPage.tsx`)
ヘッダ編集コンポーネント (`lifecycleState` の state がある関数) に:
- state を追加: `wonAmount` (string, 初期 `opportunity.wonAmount ?? opportunity.expectedAmount ?? ""`)、`closedAt` (string, 初期 `opportunity.closedAt ?? ""`)、`lostReason` (`LostReason | ""`, 初期 `opportunity.lostReason ?? ""`)、`lostReasonNote`, `competitor` (string)。`opportunity` が変わったときのリセット (既存の `useEffect` で `setLifecycleState(...)` している所) にも同様に追加。
- `dirty` の条件に 5 項目の差分を追加。patch (`doSave` で組み立てている所) に追加:
```ts
    wonAmount: wonAmount === "" ? null : Number(wonAmount),
    closedAt: closedAt || null,
    lostReason: lostReason || null,
    lostReasonNote: lostReasonNote || null,
    competitor: competitor || null,
```
  (**閉じていない案件 (OPEN 等) のときはこれらを patch に含めない**: `closingOut || opportunity.lifecycleState === "WON" || opportunity.lifecycleState === "LOST"` のときだけ含める。)
- `closingOut` のときの `ConfirmInline` を、次の入力パネル + 確定ボタンに置き換える (`type="button"`、`<form>` 禁止):
```tsx
        {closingOut ? (
          <div className="w-full rounded-lg border border-kumo-line bg-kumo-tint p-3">
            <p className="text-sm font-medium text-kumo-default">
              「{LIFECYCLE_LABEL[lifecycleState]}」として確定します。
            </p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <Field label={lifecycleState === "WON" ? "受注日" : "失注日"}>
                <input type="date" value={closedAt} onChange={(e) => setClosedAt(e.currentTarget.value)} className={INPUT} />
              </Field>
              {lifecycleState === "WON" ? (
                <Field label="受注額 (税抜・円)">
                  <input type="number" min={0} step={1} value={wonAmount} onChange={(e) => setWonAmount(e.currentTarget.value)} className={INPUT} />
                </Field>
              ) : (
                <Field label="失注理由">
                  <select value={lostReason} onChange={(e) => setLostReason(e.currentTarget.value as LostReason | "")} className={INPUT}>
                    <option value="">選んでください</option>
                    {LOST_REASONS.map((r) => <option key={r} value={r}>{LOST_REASON_LABEL[r]}</option>)}
                  </select>
                </Field>
              )}
              {lifecycleState === "LOST" && (
                <Field label="理由メモ">
                  <input value={lostReasonNote} onChange={(e) => setLostReasonNote(e.currentTarget.value)} className={INPUT} />
                </Field>
              )}
              <Field label="競合 (任意)">
                <input value={competitor} onChange={(e) => setCompetitor(e.currentTarget.value)} className={INPUT} />
              </Field>
            </div>
            <div className="mt-3 flex justify-end">
              <button type="button" disabled={saving || (lifecycleState === "LOST" && !lostReason) || (lifecycleState === "WON" && wonAmount === "")}
                onClick={doSave} className="press rounded-lg bg-kumo-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-kumo-brand-hover disabled:opacity-50">
                確定して保存
              </button>
            </div>
          </div>
        ) : ( …既存の保存ボタン… )}
```
  `INPUT` は既存の input の className を定数化したもの (無ければファイル内に `const INPUT = "h-8 w-full rounded-md …"` を足す)。`Field` は同ファイル既存。
- 閉じた案件のヘッダ (状態バッジの横) に 1 行: WON なら `受注 {closedAt} / {wonAmount 桁区切り}円`、LOST なら `失注 {closedAt} / {LOST_REASON_LABEL}`。既存の `format.ts` に金額整形があれば使う。
- 閉じた案件では上記 5 項目を通常のフィールド行としても編集できるようにする (同じ入力を「状態」の下に常時表示、`closingOut` 時と二重にならないよう `closingOut` のときは非表示)。

### 9. 画面 — チーム (`app/pages/ManagerPage.tsx`)
タイル `{ label: "今月受注", value: String(kpis.wonThisMonth) }` を:
```ts
    { label: "今月受注", value: `${kpis.wonThisMonth} 件 / ${kpis.wonAmountThisMonth.toLocaleString("ja-JP")}円` },
```

## テスト (`packages/sales-core/__tests__/pipeline.test.ts` 末尾に追加)
```ts
describe("closing a deal (C1)", () => {
  function setup() {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const user = makeUser(svc.repo, "SALES");
    const account = makeAccount(svc.repo);
    const opp = makeOpportunity(svc.repo, account.id, user.id, { expectedAmount: 500000 });
    return { svc, actor: { userId: user.id }, opp };
  }

  it("WON defaults wonAmount to expectedAmount and closedAt to today; audit says OPPORTUNITY_CLOSED", () => {
    const { svc, actor, opp } = setup();
    const saved = svc.updateOpportunity(actor, opp.id, { lifecycleState: "WON", version: 1 });
    expect(saved.wonAmount).toBe(500000);
    expect(saved.closedAt).toBe("2026-09-08");   // NOW = 2026-09-08T01:00Z → JST 10:00
    const audit = svc.getOpportunity(actor, opp.id).audit;
    expect(audit.some(a => a.action === "OPPORTUNITY_CLOSED")).toBe(true);
  });

  it("WON without any amount is rejected", () => {
    const { svc, actor, opp } = setup();
    svc.updateOpportunity(actor, opp.id, { expectedAmount: null, version: 1 });
    expect(() => svc.updateOpportunity(actor, opp.id, { lifecycleState: "WON", version: 2 })).toThrow(/受注額/);
  });

  it("LOST requires a reason", () => {
    const { svc, actor, opp } = setup();
    expect(() => svc.updateOpportunity(actor, opp.id, { lifecycleState: "LOST", version: 1 })).toThrow(/失注理由/);
    const saved = svc.updateOpportunity(actor, opp.id, { lifecycleState: "LOST", lostReason: "PRICE", competitor: "X社", version: 1 });
    expect(saved.lostReason).toBe("PRICE");
    expect(saved.wonAmount).toBeUndefined();
  });

  it("reopening clears every close detail and audits OPPORTUNITY_REOPENED", () => {
    const { svc, actor, opp } = setup();
    const won = svc.updateOpportunity(actor, opp.id, { lifecycleState: "WON", closedAt: "2026-08-31", version: 1 });
    const reopened = svc.updateOpportunity(actor, opp.id, { lifecycleState: "OPEN", version: won.version });
    expect(reopened.closedAt).toBeUndefined();
    expect(reopened.wonAmount).toBeUndefined();
    expect(svc.getOpportunity(actor, opp.id).audit.some(a => a.action === "OPPORTUNITY_REOPENED")).toBe(true);
  });

  it("team KPIs count WON by closedAt in the current month, with the won amount", () => {
    const svc = makeService(new FakeLlmProvider([]), NOW);
    const manager = makeUser(svc.repo, "MANAGER");
    const account = makeAccount(svc.repo);
    const thisMonth = makeOpportunity(svc.repo, account.id, manager.id, { expectedAmount: 100 });
    const lastMonth = makeOpportunity(svc.repo, account.id, manager.id, { expectedAmount: 900 });
    svc.updateOpportunity({ userId: manager.id }, thisMonth.id, { lifecycleState: "WON", closedAt: "2026-09-02", version: 1 });
    svc.updateOpportunity({ userId: manager.id }, lastMonth.id, { lifecycleState: "WON", closedAt: "2026-08-30", version: 1 });
    const kpis = svc.getManagerSummary({ userId: manager.id }).kpis;
    expect(kpis.wonThisMonth).toBe(1);
    expect(kpis.wonAmountThisMonth).toBe(100);
  });
});
```
`NOW` はファイル先頭で定義済み (`"2026-09-08T01:00:00Z"`)。`FakeLlmProvider`, `makeService` 等は既に import 済み。
既存テストで `wonThisMonth` を見ているものがあれば (grep)、`closedAt` を渡す形に直す。

## 検証
README の共通コマンドを全部。期待: sales-core 280 (275 + 5)、gatekeeper-sales 48。

## コミット件名
`Sales OS: record won amount, close date and lost reason when a deal closes`

## 完了チェック
- [ ] 0007 が `MIGRATIONS` 末尾にある。既存 migration は未変更
- [ ] `types.d.ts` / `types.txt` は未変更 (`git status` で確認)
- [ ] 画面: WON を選ぶと受注日・受注額・競合の入力が出て「確定して保存」で保存できる (ユーザーに確認依頼)
- [ ] チーム画面の「今月受注」が「n 件 / 金額」

## 止まって聞く
- `resolveReview` の構造が上記と大きく違う (mutator 方式でない)。
- `OpportunityDetailPage` のヘッダが別コンポーネントに分かれていて state の置き場が判断できない。
