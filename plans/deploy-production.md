# 本番デプロイ計画 (Cloudflare OS + Sales OS / 20 名利用)

作成: 2026-09-13 / 対象ブランチ: `local-patches`

いまはローカル PC (`http://localhost:8787`, 127.0.0.1 のみ) で動かしている。これを Cloudflare に置き、
社外・スマホからも使える状態にする。最終的な利用者は **20 名**を想定する。

---

## 1. 結論

- **置き場所は自分の Cloudflare アカウント**(Workers)。README が案内している正式な方法。
  自前サーバー (`workerd` 単体) は README 上「COMING SOON」で手順が無いので採らない。
- **ワンクリックデプロイ (https://os.cloudflare.app/deploy) は使えない。** Sales OS
  (`packages/gatekeeper-sales`, `packages/sales-core`) は `local-patches` にしか無い自作コード
  (main より 39 コミット先) なので、本家コードしか入らないワンクリックでは載らない。
- **`cloudflare-os-starter` を土台にし、Cloudflare OS 本体は自分のフォーク
  (`developerkimte2/cloudflare-os`) の `local-patches` を submodule として固定する。** starter の README も
  「上流の変更が必要なら fork/commit を pin する」方針。
- ただし starter が標準でデプロイする Worker は 6 つ (router / workshop / context / scheduler /
  customGatekeeper / errorReporter) だけで、**`gatekeeper-sales` を追加する作業が必要**(§4 の Phase 1)。
- ログインは **Cloudflare Access** 必須構成になる。20 名なら Zero Trust の無料枠 (50 名まで) に収まる。
- 月額費用の目安は **約 20〜50 ドル** (AI をどれだけ使うかで変わる)。詳細は §6。

---

## 2. 本番の構成

```
利用者 (社内・社外・スマホ)
   │  https://os.<自社ドメイン>
   ▼
Cloudflare Access  ── 許可したメールの人だけ通す (ワンタイム PIN / Google 等でログイン)
   │
   ▼
router Worker (公開はここだけ)
   ├─ workshop-backend   … OS 本体 (アカウント・ワークスペース・チャット)
   ├─ context / scheduler / error-reporter
   └─ gatekeeper-sales   … Sales OS (★追加が必要)
         └─ SalesCoreDurableObject (SQLite, テナント 1 つ = 全案件データ)
```

- router 以外の Worker は非公開で、service binding 経由でしか呼べない (starter の設計)。
- Access 構成では **パスワードログインは無効**になる (`workshop-backend/src/server.ts` の `login()` は
  `CF_ACCESS_AUD` が設定されていると例外を投げる)。

---

## 3. メンバー追加の流れ (本番)

ローカルのように `/signup` でアカウントを作る方式ではなくなる。

1. **管理者が Cloudflare Access のポリシーに相手のメールアドレスを追加する。**
   - 全員が同じ会社ドメインのメールを使うなら「`@<ドメイン>` を許可」の 1 行で済む。
2. 相手が URL を開く → Access のログイン (メールに届く PIN など) を通る。
3. **初回アクセスで Cloudflare OS のアカウントが自動で作られる** (`authenticateFromCfAccess`、
   Access のメールアドレスがそのままアカウントになる)。
   - 管理画面の「Allow new sign-ups」がオフだと自動作成されないので、Access で絞った上でオンのままにする。
4. 相手がサイドバーの「Sales OS」を開き、表示名とメールを入力して登録する (役割は SALES)。
5. 管理者がマネージャー画面の「メンバー」表で役割・上長を設定する。

外すときは Access のポリシーから削除すれば入口で止まる。

> 課題: Sales OS の登録は、本人が手入力したメールで行われる。Access のメールとは紐付いていないので、
> 別のアドレスを打たれても通ってしまう。`gatekeeper-sales/README.md` にも
> 「本番では Access のメールで紐付けるべき」と書いてある。20 名に広げる前に直すことを推奨 (§4 の Phase 1)。

---

## 4. 作業手順

### Phase 0: 事前準備

- [ ] Cloudflare アカウントを **Workers Paid プラン ($5/月)** にする。Dynamic Workers (ガジェット実行の仕組み) は
      有料プラン専用。
- [ ] **ドメインを決める。** 例: `os.<自社ドメイン>`。そのドメインの DNS が Cloudflare で管理されている必要がある。
      まだなら Cloudflare にゾーンを追加する (ネームサーバー変更)。
      - 検証だけなら `workers.dev` でも動かせる (starter の `"workersDev": true`)。
- [ ] **Zero Trust (Access) の初期設定**: チーム名を決める (`https://<チーム名>.cloudflareaccess.com`)、
      ログイン方法を選ぶ (一番簡単なのはメールのワンタイム PIN。Google Workspace / Microsoft 365 を使っていれば
      そちらと連携も可)。
- [ ] `local-patches` をフォーク (`fork` リモート) に push する。いまは未 push。
      `.dev.vars` などの秘密情報は gitignore 済みであることを push 前に確認する。

### Phase 1: デプロイ構成を作る

- [ ] `cloudflare-os-starter` を clone し、submodule `cloudflare-os` の参照先を
      `developerkimte2/cloudflare-os` の `local-patches` の commit に変える。
- [ ] `deployment.jsonc` を埋める: アカウント ID、各 Worker 名、ホスト名、Access の audience、
      管理者メール (`access.admins`)。
- [ ] **`gatekeeper-sales` をデプロイ対象に加える** (starter の標準構成には無い)。必要なこと:
      - Worker として build・deploy する (`capnweb-validate` のカスタムビルドと、`app/` → `src/generated/app.txt` の生成を含む)
      - Durable Object のマイグレーション (`SalesCoreDurableObject`, `SalesGatekeeper`, SQLite)
      - router / workshop から `GATEKEEPER_SALES` の service binding と `/gatekeeper/sales/*` のルーティング
        (ローカルでは `scripts/run-dev-server.ts` が自動でやっている部分を、本番の設定に落とす)
- [ ] Sales OS の設定値を本番用に入れる:
      - vars: `SALES_TENANT`, `SALES_AI_PROVIDER` (`workers-ai`), `SALES_AI_MODEL` (`@cf/openai/gpt-oss-120b`),
        `SALES_AI_ACCOUNT_ID`
      - secrets (`wrangler secret put`): `SALES_AI_API_KEY`。Slack 送信を使うなら `SALES_SLACK_BOT_TOKEN`
- [ ] (推奨) Sales OS の本人登録を Access のメールに紐付ける改修。
- [ ] Workers AI 用ローカルパッチ (モデルカタログ追加、content の文字列化) が本番でも要るか確認する。
      OS のチャットに Workers AI を使うなら必要。`[WAI DEBUG]` ログは本番前に外す。

### Phase 2: 検証デプロイ

- [ ] `pnpm check` → `pnpm deploy` (starter の手順)。Windows から実行する場合、ローカル起動と同じく
      `npm_execpath` 問題で pnpm の呼び出しが失敗する可能性があるので、`start-local.ps1` と同様に設定して実行する。
- [ ] 確認項目:
      - Access のログインが通る / 許可していないメールでは入れない
      - `/admin` に管理者として入れる
      - サイドバーの Sales OS が開き、登録 → 案件の記録 → AI 判定まで動く
      - 販管の Web アプリ (ワークスペース) を作成・共有できる
      - スマホのブラウザで表示・操作できる
- [ ] 2〜3 名で 1〜2 週間試す。

### Phase 3: データの扱い

- [ ] ローカルのデータ (`.wrangler/` 内の案件・メンバー・ワークスペース) は本番に自動では移らない。
      **新しく作り直す**か、**移行ツールを作る**かを決める。検証データだけなら作り直しが早い。

### Phase 4: 本番運用開始

- [ ] 20 名を Access ポリシーに追加 → §3 の流れで登録してもらう。
- [ ] 役割 (ADMIN / MANAGER / SALES) と上長を設定する。
- [ ] Cloudflare のダッシュボードで利用額アラート (Billing notifications) を設定する。

---

## 5. 決めること

| # | 項目 | 選択肢 / メモ |
|---|---|---|
| 1 | ドメイン | 自社ドメインのサブドメイン (要 Cloudflare DNS) / 当面 `workers.dev` |
| 2 | Access のログイン方法 | メールのワンタイム PIN (簡単) / Google Workspace・Microsoft 365 連携 |
| 3 | 許可の単位 | 個別メールを列挙 / 会社ドメイン一括 |
| 4 | OS チャットの AI モデル | Workers AI (安い) / Claude (高品質、費用増) — §6 参照 |
| 5 | ローカルデータ | 作り直し / 移行 |
| 6 | 管理者 | `access.admins` に入れる人 (最低 2 名推奨) |

---

## 6. 費用の目安 (月額・20 名)

※ 利用量は仮定。実際の使い方で大きく変わるので、最初の 1 か月の実績で見直す。

| 項目 | 金額 (USD/月) | 根拠 |
|---|---|---|
| Workers Paid プラン | **5** | 固定。リクエスト 1,000 万件・CPU 3,000 万 ms 込み。20 名なら込み分で足りる見込み |
| Durable Objects / KV / R2 | 0 (込み分内の見込み) | Paid に Durable Objects (SQLite) の無料枠あり。案件データ程度なら収まる |
| Dynamic Workers | 0〜5 | 月 1,000 個まで込み、超過は 1 個・1 日あたり $0.002。仮に 20 名×5 ガジェット×22 日 = 2,200 → 超過分で約 $2.4 |
| Cloudflare Access | **0** | Zero Trust Free は 50 名まで無料 |
| Sales OS の AI 判定 (Workers AI `gpt-oss-120b`) | 10〜30 | 入力 $0.35 / 出力 $0.75 (100 万トークンあたり)。仮に 20 名×1 日 10 件×22 日、1 件 5,000+1,000 トークンで約 $11 |
| 音声の文字起こし (Whisper) | 〜1 | 1 分 $0.0005 |
| OS チャット (ガジェットを作る AI) | 0〜200 | 使う人数とモデル次第 (下記) |
| ドメイン | 0〜1 | 既存ドメインを使うなら 0。新規取得なら年 $10 前後 |

**OS チャットの AI モデル** (主に Web アプリを作る・直す人が使う。一般の営業担当はほぼ使わない想定):

- Workers AI (例: `@cf/qwen/qwen3-30b-a3b-fp8` 入力 $0.051 / 出力 $0.335): ローカル検証で三目並べ 1 本 約 $0.003。ほぼ無視できる額。
- Claude Sonnet 5 (入力 $2 / 出力 $10、100 万トークンあたり): 作り込みをする人が 1〜2 名なら月 $50〜200 程度の幅。

**合計の目安**: Workers AI 中心で **約 $20〜50/月** (1 ドル 150 円で約 3,000〜7,500 円)。
Claude でガジェット開発もするなら **+$50〜200**。

未確認: Browser Rendering (OS が使用) の込み分と超過料金。料金ページの取得に失敗したので要確認。

---

## 7. リスク・注意点

- **Cloudflare OS 自体が early access。** README に「まだ粗い部分が多い」と明記されている。業務データを
  載せる前提なら、Sales OS のデータのバックアップ方法 (エクスポート等) を決めておく。
- **上流の更新に追従しにくい。** フォークに 39 コミットの独自変更があり、特に Workers AI パッチ
  (`workshop-shared/src/api.ts`, `workshop-backend/src/ai-models.ts`) は上流と衝突しやすい。更新時は starter の
  upgrade checklist に沿って検証環境で先に試す。
- **Sales OS の本人登録が Access と未連携** (§3 の課題)。
- **マイク録音は未対応**のまま (ガジェット iframe に `allow="microphone"` が無い)。音声はファイルアップロードで代替。
- **朝のダイジェストの自動送信は未実装** (手動の「今すぐ送信」のみ)。
- 公開 URL になるので、**Access を外した状態で公開しない**こと。

---

## 参考

- Cloudflare OS README (`README.md` の "Get Started")
- cloudflare-os-starter: https://github.com/cloudflare/cloudflare-os-starter
- Workers 料金: https://developers.cloudflare.com/workers/platform/pricing/
- Dynamic Workers 料金: https://developers.cloudflare.com/dynamic-workers/pricing/
- Workers AI 料金: https://developers.cloudflare.com/workers-ai/platform/pricing/
- Zero Trust プラン: https://www.cloudflare.com/plans/zero-trust-services/
- Sales OS の設定値: `packages/gatekeeper-sales/README.md`
