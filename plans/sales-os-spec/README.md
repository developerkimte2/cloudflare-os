# Sales OS 販売管理 最小形 — Sonnet 向け実装指示書 (2026-09-16)

このディレクトリは `plans/sales-os-20260915-spec.md` (設計) を **Sonnet が 1 セッション 1 項目で実装できる粒度** に分解したもの。
設計判断はすべて済んでいる。指示書に無い判断が必要になったら **実装を止めてユーザーに聞く**。

## 実行順 (1 ファイル = 1 コミット = 1 セッション)

| # | ファイル | 内容 | migration | 規模 |
|---|---|---|---|---|
| 1 | `01-C1-close-details.md` | 受注額・受注日・失注理由 | 0007 | 中 |
| 2 | `02-D1-products.md` | 品目 (商材) マスタ | 0008 | 中 |
| 3 | `03-D2-line-items.md` | 案件明細 → 見込金額 | 0009 | 中 |
| 4 | `04-F1-period.md` | 期間指定・会計年度・税率設定 | なし | 小〜中 |
| 5 | `05-F2-report.md` | 集計ページ | なし | 中 |
| 6 | `06-F3-csv.md` | CSV 出力 (コピー方式) | なし | 小〜中 |
| 7 | `07-L1-export-import.md` | JSON 入出力・CSV 取込 | なし | 中 |
| 8 | `08-A1-customer-master.md` | 顧客マスタ項目 | 0010 | 中 |
| 9 | `09-A5-customer-list.md` | 顧客一覧・手動作成 | なし | 中 |
| 10 | `10-A2-merge-rename.md` | 顧客の統合・改名 | なし | 中 |
| 11 | `11-E1-orders.md` | 受注伝票 | 0011 | 中 |

前の番号が終わっていないと次は着手しない (列や関数を前提にしている)。

## Sonnet セッションの開始プロンプト (ユーザーがコピーして使う)

```
plans/sales-os-spec/README.md を読んでから plans/sales-os-spec/NN-XXX.md を読み、その手順どおりに実装してください。
- 手順の「先に読むファイル」を必ず Read してから編集する
- 指示書に無い判断が必要になったら止めて質問する
- サブエージェントは使わない。1 ステップずつ進める
- 最後に「検証」のコマンドを全部通してからコミットし、結果 (件数) を報告する
```

## 全項目に共通するルール

### 環境
- リポジトリ: `C:\Users\right\claude\develop\CloudflareOS`、ブランチ `local-patches`。`origin` には push しない。push はユーザーの指示があるときだけ `git push fork local-patches`。
- pnpm は Windows で `npm_execpath` が要る。Bash なら先頭で `export npm_execpath="$APPDATA/npm/node_modules/pnpm/bin/pnpm.mjs"`。
- dev サーバー (http://localhost:8787) は起動済みのことが多い。sales-core / app / src は wrangler が watch する。**再起動は不要**。落ちていたら `start-local.ps1` (ユーザーに依頼)。
- 画面確認: claude-in-chrome は Sales OS の iframe を撮れない。**画面はユーザーに見てもらう**。

### コードの場所
| 何 | どこ |
|---|---|
| ドメイン型 | `packages/sales-core/src/domain/types.ts` |
| migration | `packages/sales-core/src/db/migrations.ts` (`MIGRATIONS` 配列の末尾に追記。既存は触らない) |
| 列マッピング | `packages/sales-core/src/db/tables.ts` (`new Table<T>(table, pk, [col("snake", "camel", codec?)])`、codec は `"json"` / `"bool"` / 省略) |
| DB アクセス | `packages/sales-core/src/db/repository.ts` (`T.xxx.insert/update/get/select/delete(this.db, …)`) |
| DTO | `packages/sales-core/src/api/dto.ts` |
| ルール (純関数) | `packages/sales-core/src/rules/*.ts` (LLM も DB も呼ばない) |
| サービス | `packages/sales-core/src/service/sales-service.ts` (`SalesService`。`this.repo`, `this.config`, `this.ctx.clock`) |
| 監査 | `audit(this.ctx, { actorType: "USER", actorId: user.id, action, entityType, entityId, before, after })` |
| エラー | `NotFoundError("案件")`, `AuthorizationError("…")`, 入力不備は `TypeError("…日本語…")` |
| RPC (3 か所) | `packages/gatekeeper-sales/src/sales-core-do.ts` (DO: `async x(caller: Caller, …) { return this.#service.x(this.#actor(caller), …); }`) → `src/management-types.ts` (`SalesManagementApi` にメソッド、先頭の `import type` と `export type` に型を追加) → `src/sales.ts` (`x(…) { return this.core.x(this.caller, …); }`) |
| 画面 | `packages/gatekeeper-sales/app/pages/*.tsx`, `app/components/*.tsx`, ラベルは `app/labels.ts`、ルートとナビは `app/App.tsx` (`Route` 型、`ROUTE_LABEL`、ナビ配列) |
| テスト | `packages/sales-core/__tests__/*.test.ts` (helpers: `makeService(llm, NOW)`, `makeUser(repo, role)`, `makeAccount(repo, overrides)`, `makeOpportunity(repo, accountId, ownerId, overrides)`, `extractionJson()`), `packages/gatekeeper-sales/app/*.test.tsx` |

sales-core の `src/index.ts` は各ディレクトリを `export *` しているので、**dto.ts / types.ts に足した型は自動で `@gadgets/sales-core` から使える**。

### 触ってはいけないもの
- `packages/gatekeeper-sales/src/types.d.ts` と `types.txt` (エージェント向け API)。
- `packages/sales-core/src/ai/skills.ts` のプロンプト文 (指示書が明示する場合を除く)。
- 既存 migration `0001`〜`0006`。

### UI の制約 (sandbox iframe)
- `<form>` と submit は使わない → `<button type="button" onClick>`。
- localStorage / cookie は使わない。
- ダウンロードリンク・`window.open` は動かない前提 (06 で扱う)。
- 英語の enum 値を画面に出さない → `labels.ts` に日本語を足す。
- 既存の見た目に合わせる: 入力は `className="h-8 w-full rounded-md border border-kumo-line bg-kumo-base px-2 text-sm text-kumo-default"`、ボタンは `className="press rounded-lg …"`、節見出しは既存ページの `Section` / `Field` を再利用。

### 検証 (全項目共通。全部通ってからコミット)
```
pnpm --filter @gadgets/sales-core exec tsc --noEmit -p tsconfig.json
pnpm --filter @gadgets/sales-core exec tsc --noEmit -p tsconfig.test.json
pnpm --filter @gadgets/sales-core test:run
pnpm --filter @gadgets/gatekeeper-sales exec tsc --noEmit -p tsconfig.app.json
pnpm --filter @gadgets/gatekeeper-sales exec tsc --noEmit -p tsconfig.json
pnpm --filter @gadgets/gatekeeper-sales test:run
pnpm --filter @gadgets/gatekeeper-sales build
grep -c "node:sqlite" packages/gatekeeper-sales/src/generated/app.txt   # 0 であること
```
開始時点の件数: sales-core 275、gatekeeper-sales 48 (worker 8 + node 15 + app 25)。減っていたら壊している。

### コミット
- `git add` は触ったファイルを明示 (`git add -A` 禁止。`fb/`, `dev-server*.log`, `dev-server.pid` は絶対に入れない)。
- 件名は各指示書の「コミット件名」。本文に「何が困っていて、どう直したか」を 3〜6 行。
- 末尾: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` (実際に使ったモデル名に合わせる)。

### 止まって聞く条件
- 指示書のコード片が現在のコードと食い違っていて、どちらが正しいか判断できない。
- テストが赤で、原因が指示書の設計にある。
- 指示書に無い列・関数・画面を足したくなった。
