# Sales OS — 2026-09-14 案件ごとの窓口 + 顧客ページ 実装指示書

対象: ユーザー依頼「1 担当者・1 会社で複数案件が動くときの管理」への対応として合意した 2 項目。

1. **案件ごとの窓口担当者** — 案件ごとに、顧客側の担当者から「この案件の窓口」を指定できるようにする (複数可)。
2. **顧客ページ** — 会社名をクリックすると、会社情報・担当者・その会社の全案件をまとめて見られるページを開く。

**実行は Sonnet。サブエージェントは使わず 1 項目ずつ、1 項目 = 1 コミット。** 設計判断は本書で確定済みなので、迷ったら本書に従う。
本書にない判断が必要になったら、実装を止めてユーザーに聞く。

## 0. 現状 (2026-09-14 本書作成時)

| 項目 | 状態 |
|---|---|
| ブランチ / 最新 | `local-patches` / `7400939`。`fork/local-patches` (developerkimte2/cloudflare-os) に push 済み。**`origin` は本家 cloudflare/cloudflare-os なので絶対に push しない** |
| 未コミット (本書の前提となる変更) | ステータス統合バッジ `進行中（AI判定済）`、案件一覧の検索バー、顧客情報 (会社の住所/電話/URL・担当者の追加/編集)。ファイル一覧は §0.1 |
| 未追跡 | `fb/`, `dev-server.log`, `dev-server-err.log`, `dev-server.pid` — すべてコミット対象外 |
| テスト | sales-core **226 件**、gatekeeper-sales **44 件** (worker 5 + node 15 + app 24) すべて緑 |
| dev-server | `start-local.ps1` で起動中 (http://localhost:8787)。gatekeeper-sales の app / src は wrangler が watch して自動で再ビルド・再読込する (再起動不要) |
| 実機確認 | claude-in-chrome は Sales OS の iframe を撮影できない (1 回目以外 `Script injection timed out`)。**画面確認はユーザーに依頼する** |

### 0.1 着手前: 未コミットの変更をコミットする (ユーザーの OK を取ってから)

以下は 3 機能が同じファイルに混在していて部分ステージできないので、**1 コミットにまとめる**。

```
git add packages/gatekeeper-sales/app/components/Badges.tsx \
  packages/gatekeeper-sales/app/components/CustomerInfo.tsx \
  packages/gatekeeper-sales/app/labels.ts \
  packages/gatekeeper-sales/app/pages/ManagerPage.tsx \
  packages/gatekeeper-sales/app/pages/OpportunitiesPage.tsx \
  packages/gatekeeper-sales/app/pages/OpportunityDetailPage.tsx \
  packages/gatekeeper-sales/src/management-types.ts \
  packages/gatekeeper-sales/src/sales-core-do.ts \
  packages/gatekeeper-sales/src/sales.ts \
  packages/gatekeeper-sales/src/types.d.ts \
  packages/gatekeeper-sales/src/types.txt \
  packages/sales-core/__tests__/db.test.ts \
  packages/sales-core/__tests__/pipeline.test.ts \
  packages/sales-core/src/api/dto.ts \
  packages/sales-core/src/db/migrations.ts \
  packages/sales-core/src/db/repository.ts \
  packages/sales-core/src/db/tables.ts \
  packages/sales-core/src/domain/types.ts \
  packages/sales-core/src/service/sales-service.ts \
  plans/sales-os-20260914-customers.md
```

件名案: `Sales OS: one status badge, opportunity search, customer contact details`
本文に 3 点 (ステータスを「段階（AI判定済/未判定）」の 1 バッジに統合、案件一覧のサーバー側全文検索、migration 0004 で会社の住所/電話/URL と担当者の追加・編集) を書く。

### 進め方の共通ルール

- 1 項目ずつ進め、**1 項目 = 1 コミット**。各項目の最後に検証コマンドを全部通してからコミットする。
- 検証コマンド (リポジトリ直下):
  ```
  pnpm --filter @gadgets/sales-core exec tsc --noEmit -p tsconfig.json
  pnpm --filter @gadgets/sales-core exec tsc --noEmit -p tsconfig.test.json
  pnpm --filter @gadgets/sales-core test:run
  pnpm --filter @gadgets/gatekeeper-sales exec tsc --noEmit -p tsconfig.app.json
  pnpm --filter @gadgets/gatekeeper-sales exec tsc --noEmit -p tsconfig.json
  pnpm --filter @gadgets/gatekeeper-sales test:run
  grep -c "node:sqlite" packages/gatekeeper-sales/src/generated/app.txt   # 0 であること
  ```
- migration は **追記のみ**。適用済みの `0001`〜`0004` は 1 文字も変えない。本書で足すのは `0005` だけ。
- `packages/gatekeeper-sales/src/types.d.ts` を触ったら `src/types.txt` も同じ内容にする (`diff` で差分ゼロ)。**本書の項目はどちらも触らない。**
- `packages/sales-core/src/ai/skills.ts` のプロンプト文は触らない。
- app 側のテストは `app/` 直下の `*.test.ts(x)` にしか置けない (`vitest.app.config.ts` の include)。
- Sales OS の UI は `allow-forms` の無い sandbox iframe で動く。**`<form>` / submit は使わず `type="button"` + onClick**。localStorage も使えない。
- `git add` は対象ファイルを明示する (`git add -A` 禁止)。
- コミット末尾 (固定):
  ```
  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01G71441NhRvFF4iUdf61Fyd
  ```
- push はユーザーに言われてから `git push fork local-patches`。

### 現在のデータの持ち方 (前提知識)

```
customer_accounts (会社) 1 ──< opportunities (案件)        opportunities.account_id
customer_accounts (会社) 1 ──< customer_persons (担当者)   customer_persons.account_id
activities (商談記録) の person_ids (JSON 配列) = その記録に登場した担当者
```

- 担当者と案件の直接の紐付けは **無い**。一覧の「顧客窓口」は `sales-service.ts` の `summarize()` で
  `listPersonsForAccount(o.accountId)[0]` (会社の担当者の名前順 1 人目) を出しているだけ = 仮実装。
- 案件一覧の検索 (`repository.ts` `listOpportunitiesVisibleTo` の `text`) は、担当者名を **会社単位** で照合している
  (`account_id IN (SELECT account_id FROM customer_persons WHERE display_name LIKE ?)`)。

---

## 項目 1a. 窓口担当者のデータと API (sales-core)

### 1a-1. migration 0005 (`packages/sales-core/src/db/migrations.ts` の末尾に追記)

```sql
ALTER TABLE opportunities ADD COLUMN contact_person_ids TEXT;
UPDATE opportunities SET contact_person_ids = (
  SELECT json_group_array(person_id) FROM (
    SELECT DISTINCT je.value AS person_id
    FROM activities a, json_each(a.person_ids) je
    WHERE a.opportunity_id = opportunities.id
      AND je.value IN (SELECT id FROM customer_persons WHERE account_id = opportunities.account_id)
  )
);
```

- id は `"0005_opportunity_contact_person_ids"`。
- 2 文目は **既存案件の埋め戻し**: その案件の商談記録に登場した、同じ会社の担当者を窓口にする。該当が無ければ `'[]'`。
- 列は NULL 可 (NOT NULL にしない)。`Table` mapper は undefined を NULL で書くため、NOT NULL だと
  `contactPersonIds` を渡さない既存の insert (ingest.ts・テストヘルパー) が全部壊れる。

### 1a-2. 型と列

- `domain/types.ts` の `Opportunity` に `contactPersonIds?: string[];` (コメント: 顧客側の窓口担当者。同じ会社の customer_persons の id)。
- `db/tables.ts` の `opportunities` に `col("contact_person_ids", "contactPersonIds", "json")`。
- `api/dto.ts`
  - `OpportunitySummary` に `contactPersonIds: string[]` と `contactNames: string[]` を追加 (存在する担当者だけ、指定順)。
  - `primaryContactName` は残し、**`contactNames[0]`** を入れる (フォールバックは廃止。未指定なら undefined)。
    `summarize()` の「first alphabetically stands in」のコメントも削除。
  - `OpportunityPatch` に `contactPersonIds?: string[];`。

### 1a-3. サービス (`service/sales-service.ts`)

- `summarize(o)`: `o.contactPersonIds ?? []` の各 id を `repo.getPerson` で引き、**見つからない id と別会社の担当者は捨てる**
  (担当者削除・顧客統合の後にぶら下がりが残ってもよいように)。結果から `contactPersonIds` / `contactNames` / `primaryContactName` を作る。
- `updateOpportunity`: `patch.contactPersonIds !== undefined` のとき、
  - 重複を除く。
  - 全 id が `repo.getPerson(id)?.accountId === o.accountId` であることを確認し、違えば
    `TypeError("窓口に指定できるのはこの顧客の担当者だけです")`。
  - `next.contactPersonIds = ids`。監査ログは既存の `OPPORTUNITY_EDITED` の before/after に乗る (追加作業なし)。
- `resolveOpportunity` (OPPORTUNITY_AMBIGUOUS で案件を統合する所、`merged` を作っている箇所): `contactPersonIds` を
  `target` と `fresh` の和集合 (target の順を先に) にする。

### 1a-4. 取り込み時の自動追加 (`pipeline/ingest.ts`)

- 「2. Activity」で `activity.personIds` を作った後、「7. Persist」の `updateOpportunity` より前に:
  ```ts
  // Contacts who show up in a record become this deal's 窓口 (same customer only).
  const sameAccount = activity.personIds.filter(id => ctx.repo.getPerson(id)?.accountId === opportunity.accountId);
  opportunity.contactPersonIds = [...new Set([...(opportunity.contactPersonIds ?? []), ...sameAccount])];
  ```
  (新規担当者は同じ関数の前半で insert 済みなので `getPerson` で引ける。)
- 取り消し (`pipeline/undo.ts` `revertSource`) は `app.opportunityBefore` を丸ごと書き戻すので、自動追加も一緒に戻る。**undo.ts の変更は不要**
  (テストで確認する)。

### 1a-5. 検索 (`db/repository.ts` `listOpportunitiesVisibleTo`)

- 担当者名の条件を **その案件の窓口** に絞る:
  ```sql
  OR EXISTS (SELECT 1 FROM json_each(COALESCE(contact_person_ids, '[]')) j
             JOIN customer_persons p ON p.id = j.value
             WHERE p.display_name LIKE ? ESCAPE '\')
  ```
  を、今の `account_id IN (SELECT account_id FROM customer_persons ...)` と置き換える (プレースホルダの数は変わらない)。
- `OpportunityQuery.text` / `OpportunityFilter.query` のコメントの「customer contact」を「the deal's contacts (窓口)」に直す。

### 1a-6. テスト (sales-core)

- `__tests__/db.test.ts`
  - 既存の検索テスト (`text search matches title, customer, contact and owner names...`): 「山田」でヒットさせたい案件の
    `contactPersonIds` に山田さんの id を入れる形に直す。加えて「同じ会社だが窓口でない案件は担当者名でヒットしない」を 1 行足す。
  - 新規: 埋め戻し。`migrate(db, MIGRATIONS.slice(0, 4))` → 会社・担当者 2 人・案件・`person_ids` に 1 人だけ入った活動を
    SQL で insert → `migrate(db)` → その案件の `contactPersonIds` がその 1 人だけ。活動の無い案件は `[]`。
- `__tests__/pipeline.test.ts`
  - `updateOpportunity` で他社の担当者 id を渡すと TypeError、同じ会社なら保存され `summarize` の `contactNames` に出る。
  - 担当者を削除 (`repo.deletePerson`) した後も `getOpportunity` が落ちず、その人が `contactNames` から消える。
  - 取り込み: `extractionJson` ヘルパーで担当者候補入りの抽出を返す `FakeLlmProvider` を使い、`capture` 後の案件の
    `contactPersonIds` にその担当者が入る。続けて `revertCapture` すると元に戻る。(既存の capture / revert テストの書き方に合わせる)
  - 案件統合 (OPPORTUNITY_AMBIGUOUS の解決) で窓口が和集合になる — 既存の統合テストがあればそこに 1 アサーション足す程度でよい。

コミット件名案: `Sales OS: per-opportunity customer contacts (窓口)`

---

## 項目 1b. 窓口担当者の画面 (gatekeeper-sales app)

### 1b-1. `app/components/CustomerInfo.tsx`

- props を追加 (どちらも任意。顧客ページ (項目 2b) では窓口トグルを出さないため):
  ```ts
  contactPersonIds?: string[];
  onSetContacts?: (personIds: string[]) => Promise<boolean>;
  ```
- `PersonRow` の右側 (「編集」の左) に窓口トグルを置く。`onSetContacts` があるときだけ表示する。
  - 窓口のとき: `Badge` 風の「この案件の窓口 ✓」ボタン (tone success)。押すと外す。
  - 窓口でないとき: 枠線ボタン「窓口にする」。
  - 押したら `onSetContacts(新しい配列)`。
- 担当者の並びは **窓口の人を先頭** に (窓口の中は `contactPersonIds` の順、それ以外は今の順)。
- 「＋ 担当者を追加」のフォーム (`PersonForm`) に、`onSetContacts` があるときだけチェックボックス
  「この案件の窓口にする」(初期値 ON) を足す。ON なら追加成功後に窓口にも入れる (1b-2 の `createPerson` 側でやる)。

### 1b-2. `app/pages/OpportunityDetailPage.tsx`

- `<CustomerInfo>` に `contactPersonIds={data.contactPersonIds}` と
  `onSetContacts={(ids) => savePatch({ contactPersonIds: ids, version: data.version })}` を渡す。
  `savePatch` は今 `Promise<void>` なので、成功可否を返す形 (`runAction` の戻り値 !== undefined) に直すか、窓口用に別関数を作る。
- `createPerson` (今は `api.createPerson` → reload): 「この案件の窓口にする」が ON なら、作成成功後に
  `api.updateOpportunity(opportunityId, { contactPersonIds: [...data.contactPersonIds, created.id], version: data.version })`
  してから reload。`createPerson` は案件の version を変えないので `data.version` のままでよい。
  CustomerInfo → 詳細ページへは `onCreatePerson(input, { asContact: boolean })` のように第 2 引数で渡す。
- 見出し内の `顧客窓口: {primaryContactName}` の行を `顧客窓口: {contactNames.join("、")}` に。未指定なら
  `顧客窓口: 未指定（下の「顧客情報」で窓口を選べます）` を薄い色で出す。

### 1b-3. 一覧・報告文

- `app/pages/OpportunitiesPage.tsx` の「顧客窓口」列: `contactNames.join("、")`、空なら `—`。`title` 属性にも同じ文字列 (truncate されるため)。
- `app/report.ts` の `■ 顧客窓口:` を `contactNames.join("、") || "未登録"` に。`app/report.test.ts` のフィクスチャに
  `contactPersonIds` / `contactNames` を足し、期待値を合わせる。
- 検索欄の placeholder は「顧客名・案件名・窓口・担当者で検索」のままでよい (窓口 = 案件の窓口になったので意味が正しくなる)。

### 1b-4. 確認 (ユーザーに依頼)

1. 案件詳細の「顧客情報」で「窓口にする」を押すと、見出しの「顧客窓口」と案件一覧の列がその人になる。外すと消える。
2. 同じ会社の別案件では、その人は窓口になっていない (案件ごとに独立)。
3. 担当者を「この案件の窓口にする」ON で追加すると、最初から窓口になっている。
4. 案件一覧の検索で担当者名を入れると、その人が窓口の案件だけが出る。

コミット件名案: `Sales OS: pick the deal's contacts from the customer info panel`

---

## 項目 2a. 顧客ページの API (sales-core + gatekeeper-sales src)

### 2a-1. DTO (`packages/sales-core/src/api/dto.ts`)

```ts
export interface CustomerDetail {
  account: CustomerAccount;
  persons: CustomerPerson[];
  /** Every opportunity of this customer the caller can see, all lifecycle states, newest update first. */
  opportunities: OpportunitySummary[];
}
```

### 2a-2. サービス (`service/sales-service.ts` の `// ---- customers` 節)

```ts
getCustomer(actor: Actor, accountId: string): CustomerDetail
```
- `requireUser` → `repo.getAccount` → `canSeeAccount(user, accountId)` (前回追加済みの private) が偽なら `NotFoundError("顧客")`。
- `opportunities = repo.listOpportunitiesVisibleTo(user, { accountId, limit: 500 }).map(o => this.summarize(o))`。
  SALES は自分が担当/参加の案件だけ、MANAGER/ADMIN は全件 (既存の可視性ルールそのまま)。
- `persons = repo.listPersonsForAccount(accountId)`。

### 2a-3. RPC の配線 (gatekeeper-sales)

`updateAccount` を足したときと同じ 3 か所 + 型の import:
- `src/sales-core-do.ts`: `async getCustomer(caller, accountId): Promise<CustomerDetail>`
- `src/management-types.ts`: `SalesManagementApi` に `getCustomer(accountId: string): Promise<CustomerDetail>;` と型の re-export
- `src/sales.ts` の `SalesManagementApiImpl`: 1 行の委譲
(`@validateRpc()` が TS の型から検証コードを作るので、検証の手書きは不要。)

### 2a-4. テスト (`packages/sales-core/__tests__/pipeline.test.ts` の `customer contact details` の近く)

- MANAGER は他人の案件も含めて全件、SALES は自分の案件だけが `opportunities` に入る。受注・失注の案件も入る。
- その会社に案件を持たない SALES は `NotFoundError` (メッセージに「顧客」)。

コミット件名案: `Sales OS: getCustomer() for a per-customer view`

---

## 項目 2b. 顧客ページの画面 (gatekeeper-sales app)

### 2b-1. ルート (`app/App.tsx`)

- `Route` に `| { kind: "customer"; id: string }`。`ROUTE_LABEL.customer = "顧客"`。
- `sameRoute` を「`kind` が同じで、`id` を持つ kind は `id` も同じ」に一般化する (今は opportunity だけ id を見ている)。
- `openCustomer = useCallback((id) => navigate({ kind: "customer", id }), [navigate])` を作り、
  `OpportunitiesPage` / `OpportunityDetailPage` / `ManagerPage` / 新しい `CustomerPage` に渡す。
- サイドバー: `customer` 表示中も「案件」をアクティブにする (`opportunity` と同じ扱い)。
- 戻るバーの戻り先がない場合のフォールバック (`goBack` の else): `customer` も `opportunities` へ。
- `<main>` の中に `route.kind === "customer"` のとき `<CustomerPage key={route.id} ... />`。

### 2b-2. `app/pages/CustomerPage.tsx` (新規)

props: `api`, `user`, `accountId`, `onOpenOpportunity`。`useAsyncData(() => api.getCustomer(accountId), [api, accountId])`。
読み込み中・失敗・再試行は `OpportunityDetailPage` の `PageShell` と同じ見た目で。

レイアウト (上から、`mx-auto max-w-4xl px-6 py-8`):
1. 見出し: 会社名 (`text-xl font-semibold`)。`resolutionStatus === "UNRESOLVED"` なら `Badge` 「顧客未確定」(warning)。
   その下に件数の要約: `進行中 n 件・受注 n 件・失注 n 件・保留 n 件・終了 n 件` (0 件の状態は省く)。
2. `<CustomerInfo account persons onSaveAccount onCreatePerson onUpdatePerson contactOpportunities onOpenOpportunity />`
   - 会社情報の保存・担当者の追加/編集は詳細ページと同じ API (`updateAccount` / `createPerson` / `updatePerson`) → `reload()`。
   - 窓口トグル (`onSetContacts`) は **渡さない**。代わりに担当者ごとに「窓口の案件: 案件A、案件B」を出す:
     CustomerInfo に任意 prop `contactOpportunities?: Record<personId, { id: string; title: string }[]>` と
     `onOpenOpportunity?: (id) => void` を足し、あればリンク (`text-kumo-link`) で列挙、無い人は「窓口の案件: なし」。
     マップは `opportunities` の `contactPersonIds` から画面側で作る。
3. 「案件」節: その会社の案件の表 (`OpportunitiesPage` の表を小さくしたもの)。列 = 案件 / 状態 (`OpportunityStatusBadge`) /
   担当 / 顧客窓口 (`contactNames.join("、")`) / 次アクション / 見込金額 / 最終活動。
   並び = 進行中 (`lifecycleState === "OPEN"`) を先に、その中はサーバーの順 (更新が新しい順)。行クリックで `onOpenOpportunity`。
   0 件なら「表示できる案件がありません」。

### 2b-3. 入口 (会社名をクリックで顧客ページへ)

- `OpportunitiesPage` の「顧客」セル: 会社名を `<button type="button" className="text-left text-kumo-link hover:underline truncate">` にし、
  `onClick={(e) => { e.stopPropagation(); onOpenCustomer(opportunity.accountId); }}` (行クリック = 案件を開く、と衝突させない)。
- `OpportunityDetailPage` 見出しの会社名 (`<p className="mt-0.5 text-sm text-kumo-subtle">{opportunity.accountName}</p>`) を同様のボタンに。
  `OpportunityDetailPage` に `onOpenCustomer` prop を足す。
- 詳細ページの「顧客情報」節の見出しの右 (`Section` の `action`) に「この顧客の全案件 →」ボタン (同じ遷移)。
- `ManagerPage` の案件行の `{accountName} / {title}` は行ボタンの中なので **変えない** (ネストしたボタンになるため)。

### 2b-4. 確認 (ユーザーに依頼)

1. 案件一覧で会社名をクリック → 顧客ページが開く (行の他の場所をクリックすると今まで通り案件が開く)。
2. 顧客ページに会社情報・担当者 (窓口の案件つき)・その会社の案件 (受注/失注も) が出る。案件をクリック → 詳細 →「戻る（顧客）」で戻れる。
3. 顧客ページで会社情報や担当者を直すと、案件詳細の「顧客情報」にも反映されている。
4. 営業ロールのユーザーでは、自分が担当/参加している案件だけが一覧に出る。

コミット件名案: `Sales OS: customer page (company info, contacts, every deal)`

---

## 完了後

- ユーザーに 1b-4 と 2b-4 の確認を依頼し、結果を待つ。
- OK が出たら `git push fork local-patches` (ユーザーに言われてから)。
- 今回やらないこと (ユーザーに言われるまで手を付けない): 担当者の削除/無効化、顧客名の変更、顧客一覧ページ (サイドバーの「顧客」)、
  担当者の会社間の移動 (転職)。
