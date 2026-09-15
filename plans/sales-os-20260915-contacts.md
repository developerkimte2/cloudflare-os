# Sales OS — 2026-09-15 検索回答に連絡先 (問い合わせ窓口) が出ない件

ユーザー指摘 (2026-09-15): 「担当者の情報が入っていない場合、問い合わせ窓口がどこなのか、等が入ってないね。」

## 1. 現象

検索 (`askQuestion`) の回答は、窓口の**氏名**しか出ない。担当者が登録されていても
メール・電話・役職は出ず、登録が無ければ「窓口: (未設定)」で終わる。
「どこに問い合わせればよいか」が回答から分からない。

## 2. 原因 (コードで確認済み)

| # | 箇所 | 内容 |
|---|---|---|
| 1 | `packages/sales-core/src/ai/skills.ts` `buildAnswerRequest` (answer.v5) | 案件ダンプの窓口は `o.contactNames.join("、")`、社内担当は `o.ownerName` だけ。`CustomerPerson` には `email` / `phone` / `title` があるのに渡していない |
| 2 | 同上 | 顧客 (`CustomerAccount`) の `phone` / `address` / `websiteUrl` も渡していない (これらは案件画面から手入力のみ) |
| 3 | `packages/sales-core/src/ai/schema.ts` `personCandidateSchema` | 抽出は `name` / `company` / `email` / `title` まで。**`phone` が無い**ので、メモに電話番号があっても捨てられる。`pipeline/ingest.ts` の担当者作成 (2 箇所、L324〜 / L424〜) も phone を入れていない |
| 4 | UI 導線 | メモに人名が無い案件は `contactPersonIds` が空のまま。埋めるには案件画面 / 顧客画面 (`CustomerInfo.tsx`) で担当者を追加し「窓口にする」を押すしかなく、検索回答からは辿れない |

参考: `OpportunitySummary` (`service/sales-service.ts` `summarize`) は `contactPersonIds` / `contactNames` /
`primaryContactName` を持つが、連絡先そのものは持っていない。回答に載せるなら summary に連絡先を足すか、
`askQuestion` 側で person / account を引き直す。

## 3. 対応案

### 案 A (小、1 コミット): 回答用データに連絡先を載せる — answer.v6
- `AnswerInput` の案件に `contacts: { name, title?, email?, phone? }[]` と
  `account: { phone?, websiteUrl? }` を追加 (`askQuestion` で `repo.getPerson` / `repo.getAccount` から詰める)。
- ダンプの `窓口:` 行を「氏名 (役職) メール / 電話」の形に。会社の電話 / Web サイトは `顧客連絡先:` 行を追加。
- プロンプト原則 5 の項目列に「連絡先」を足す。無ければ「(未設定)」のまま (推測禁止は現状通り)。
- `ANSWER_PROMPT_VERSION` を上げる。テスト: FakeLlm に渡る user メッセージに email / phone が含まれること。

### 案 B (中、別コミット): 取り込み時に電話番号も拾う
- `personCandidateSchema` に `phone` (nullable, max 50) を追加、抽出プロンプト (extract.vN) に電話の抽出を明記。
- `ingest.ts` の担当者作成 2 箇所で `phone` を保存。既存担当者に一致した場合、空欄なら補完するかは要判断 (未決)。
- `types.d.ts` / `types.txt` は触らないで済む想定 (エージェント向け API に person の形は出していない)。

### 案 C (小、任意): 窓口未設定のときの導線
- 回答の末尾に「この案件の窓口が未設定です → 案件画面で登録」の一文を**コードで**付ける (LLM には書かせない)。
  `AnswerView` に案件へのリンクを出せるかは UI を見てから。

推奨順: A → (ユーザー判断で) B → C。

## 4. 状態

- 2026-09-15 時点: 調査のみ。**実装は未着手**。ユーザーの指示待ち (A だけか、B まで含めるか)。
