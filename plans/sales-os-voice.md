# Sales OS — 音声機能 設計・実装指示書

対象: `fb/FB_20260908.txt` 行1「音声のFBしたいができない？」、`plans/sales-os-20260910.md` §1.1/項目3 の判断待ちに対する店主回答。

## 0. 店主の決定 (2026-09-10)

質問「(a) 商談後に話して取り込みたい」か「(b) レビュアーの感想を音声で残したい」かに対し、**「1、2両方」= (a) の中の2案 (a-1 ブラウザ録音 / a-2 ファイルアップロード) を両方作る**という回答。
(b) (ツールへの感想を音声で) は対象外のまま (`fb/` に文字起こしを置く運用で足りるとして扱う)。

したがって本書のスコープは **(a-1) ブラウザ録音による音声入力** と **(a-2) 音声ファイルのアップロードによる文字起こし取り込み** の両方。

## 1. 現状 (実装前の確認事項)

- 録音・文字起こし・マイク取得のコードは packages 内に 1 行も無い (`sales-os-20260910.md` §1.1 で確認済み)。
- `SourceType` (`packages/sales-core/src/domain/types.ts:186-194`) にはすでに `"VOICE"` `"AUDIO"` `"TRANSCRIPT"` が定義済みだが、`CaptureOptions.sourceType` として渡せる列挙値止まりで、音声ファイル自体を受け取る経路は無い。`SourceDocument.r2ObjectKey` (`types.ts:216` 付近) も定義だけで未使用、`wrangler.jsonc` に R2 バケットのバインディングも無い。
- `CaptureBox.tsx` の取り込みは常にテキスト (`onCapture(text, options)`)。バイナリ入力欄は無い。
- gadget / gatekeeper 管理 UI は `sandbox="allow-scripts allow-modals"` の opaque-origin iframe (memory `gadget-iframe-sandbox`)。`allow="microphone"` が iframe に無いため **`getUserMedia` はこの iframe の中では動かない**。これは Workshop ホスト側 (このリポジトリの外) の変更が必要で、本書のコード変更では直せない。
- `packages/gatekeeper-sales/src/llm.ts` の `buildLlm()` はテキスト補完 (chat completions 相当) 用のプロバイダ抽象で、音声書き起こし (ASR) には使えない。書き起こしは Cloudflare Workers AI の Whisper 系モデル (`@cf/openai/whisper` または `@cf/openai/whisper-large-v3-turbo`) への専用 REST 呼び出しが必要 — `SALES_AI_PROVIDER=ollama` (ローカル開発の既定) のときも Whisper だけは Cloudflare 側を叩く。

## 2. 設計方針: 文字起こしバックエンドを1つに集約する

**(a-1) と (a-2) は「音声データをどこから得るか」が違うだけで、得たあとの処理 (Whisper で文字起こし → テキストエリアに入れてユーザーが確認・編集 → 既存の取り込みボタンで送信) は完全に共通にする。**

- 新しい RPC は 1 本だけ: `transcribeAudio(audio: ArrayBuffer, mimeType: string): Promise<{ text: string; modelName: string }>`。
  `askQuestion` と同じ「何も保存しない読み取り専用操作」として扱う (承認キュー・`PendingAction` は不要)。ArrayBuffer は capnweb RPC でシリアライズ可能 (`gatekeeper-google` の `DriveFile.getContent(): Promise<ArrayBuffer>` が前例、`packages/gatekeeper-google/src/types.d.ts:534`)。
- 返ってきた `text` は **そのまま送信されない**。既存の `CaptureBox` のテキストエリアに入れてユーザーに見せ、確認・修正してから今まで通り「取り込む」ボタンを押してもらう。これにより:
  - Whisper の誤認識をレビューできる (このアプリの「AI の判断は人が確認する」という既存の思想と合う)。
  - `sales-core` 側 (capture / ingest / pipeline) は一切変更不要。`sourceType` は送信時に `AUDIO` を選べるようにするだけ (`SOURCE_TYPE_OPTIONS` に追加)。
  - 音声ファイル自体は保存しない (R2 バインディングを新設しない)。文字起こし後は破棄する。**将来「元音声を残したい」となったら R2 バケット追加が要る**が、今回のFBの要求 (取り込みたい) には文字起こしで足りるので保存しない。

## 3. 実装項目 (1項目 = 1コミット)

### 項目 V1: Whisper 文字起こしモジュール (バックエンド)

`packages/gatekeeper-sales/src/transcribe.ts` を新規作成。

```ts
export interface TranscribeInfo { configured: boolean; }

export function describeTranscription(env: Cloudflare.Env): TranscribeInfo { ... }

export async function transcribeAudio(
  env: Cloudflare.Env, audio: ArrayBuffer, mimeType: string,
): Promise<{ text: string; modelName: string }> { ... }
```

- 環境変数 (`src/env.d.ts` に追加): `SALES_TRANSCRIBE_ACCOUNT_ID` / `SALES_TRANSCRIBE_API_KEY` (省略時は `SALES_AI_PROVIDER === "workers-ai"` なら `SALES_AI_ACCOUNT_ID` / `SALES_AI_API_KEY` にフォールバック。Ollama など他プロバイダのときは専用の Workers AI 資格情報が別途必要 — README に明記)。
- 呼び出し先: `https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/run/@cf/openai/whisper-large-v3-turbo` に `Content-Type: audio/*` で生バイトを POST (Workers AI の ASR エンドポイントは chat completions と別 REST 形式なので `llm.ts` の `LlmProvider` は再利用しない、独立モジュールにする)。
- モデル名は固定文字列を返す (`"workers-ai/whisper-large-v3-turbo"`) — `AiAttribution` とは無関係 (これは文字起こしであって営業判定AIではない) なので `WhoAmI.ai` には混ぜない。
- テスト: `packages/gatekeeper-sales/__tests__/` (node 環境) にフェッチをモックした単体テスト。設定なし → `configured:false` かつ呼び出しは分かりやすいエラー、成功レスポンス → `text` を返す、失敗レスポンス → エラーを投げる。

### 項目 V2: RPC 配線 (`transcribeAudio` を app から呼べるようにする)

- `packages/gatekeeper-sales/src/management-types.ts`: `SalesManagementApi` に `transcribeAudio(audio: ArrayBuffer, mimeType: string): Promise<{ text: string; modelName: string }>` を追加。`WhoAmI` に `transcription: { configured: boolean }` を追加 (UI がボタンの活性/非表示を判断する)。
- `packages/gatekeeper-sales/src/types.d.ts` に同じシグネチャを追記し、**`src/types.txt` も同じ内容にする** (types-copy テストの制約、`sales-os-20260910.md` の共通ルール参照)。
- `packages/gatekeeper-sales/src/sales.ts` の `SalesSessionImpl`: `whoAmI()` の返り値に `transcription` を足し、新メソッド `transcribeAudio()` を追加。これは「読み取り専用」なので `#observe()` は呼ばない (何も変更しない操作)。
- テスト: `packages/gatekeeper-sales/__tests__/worker.ts` 系の既存テストに `transcribeAudio` の往復を1件追加。

### 項目 V3: CaptureBox — 音声ファイルのアップロード (a-2、ホスト変更不要ですぐ使える)

- `app/components/CaptureBox.tsx` に「🎙 音声ファイル」ボタン + `<input type="file" accept="audio/*" hidden>` を追加。選んだファイルを `file.arrayBuffer()` (sandbox 内でも動く、`FileReader`/`File` API はホストの許可を要らない) で読み、`api.transcribeAudio(buffer, file.type)` を呼ぶ。
- 成功: 返ってきた `text` を既存のテキストエリアに入れる (空なら置換、既に何か書いてあれば末尾に追記して本人に確認させる)。`sourceType` を自動で `AUDIO` にセット。
- 失敗 (Whisper 未設定・エラー): トースト表示 (「文字起こしに失敗しました。手入力してください。」)。処理は中断せず、テキストエリアはそのまま使える。
- `whoAmI().transcription.configured === false` のときはボタン自体を出さない (設定してある場合だけ機能を露出)。
- `SOURCE_TYPE_OPTIONS` に `{ value: "VOICE", label: "音声" }` は追加しない (実体は文字起こし済みテキストなので `AUDIO` 1本で十分。`VOICE` は将来ライブ入力用に予約のまま残す)。

### 項目 V4: CaptureBox — ブラウザ録音 (a-1、Workshop ホストの変更が前提)

- 同じボタン列に「🎤 話す」を追加するが、**まず `navigator.mediaDevices?.getUserMedia` の有無と実際の許可取得を try/catch で確認**してから表示する。取得できない環境 (今の iframe sandbox) では自動的にボタンを隠し、V3 の「音声ファイル」だけを見せる (エラーを画面に出してユーザーを混乱させない)。
- 取得できた場合: `MediaRecorder` で開始/停止し、できた `Blob` を V3 と同じ `arrayBuffer()` → `transcribeAudio()` の経路に流す。録音時間の上限を60秒程度に (設計書 §19.1「30秒程度で話せること」を参考に、余裕を見て60秒でタイムアウト)。
- **前提条件 (このリポジトリの外、ブロッカー)**: gadget / gatekeeper 管理 UI の iframe に `allow="microphone"` を Workshop ホスト側で追加してもらう必要がある。本項目のコードは前提条件が満たされるまで「録音」ボタンが出ない状態でマージしてよい (V3 だけで音声取り込みは機能する)。ホスト変更を店主経由でプラットフォーム側に依頼する。
- テスト: `MediaRecorder`/`getUserMedia` は jsdom に無いので、feature-detect 分岐 (「非対応環境ではボタンが出ない」) だけを `app/` 直下のテストで確認する。録音の実機テストは Chrome で `allow="microphone"` が付いたあとにユーザー側で行う。

### 項目 V5: ドキュメント

- `packages/gatekeeper-sales/README.md` の「Not in Phase 0」から voice の記述を更新: 「文字起こしアップロードは実装済み、ブラウザ録音は Workshop ホストの iframe 許可待ち」。
- `.dev.vars.example` があれば `SALES_TRANSCRIBE_ACCOUNT_ID` / `SALES_TRANSCRIBE_API_KEY` の説明を追加。

## 4. テスト・受け入れ基準

- 検証コマンドは `sales-os-20260910.md` §0 と同じ (`test:run` ×2、`build`、`node:sqlite` grep)。
- 実機: Workers AI の資格情報を設定した状態で音声ファイル (m4a/mp3 など) をアップロード → テキストエリアに文字起こし結果が入る → 内容を確認・修正して送信 → 通常の取り込み結果 (判定AI表示含む) が出る。
- 実機: 資格情報未設定のときは「音声ファイル」ボタンが出ない、または押しても分かりやすいエラーで手入力に戻れる。
- 実機: 現状の iframe (マイク許可なし) では「話す」ボタンが出ないことを確認 (V4 のガードが機能している証拠)。

## 5. 残課題 (本書の対象外)

- 元音声ファイルの保存 (R2) — 要望が出たら別途。
- ライブ入力 (話しながら逐次テキスト化、Web Speech API) — 設計書 §19.1 の将来案、`SourceType.VOICE` はそのために予約のまま。
- Workshop ホストの `allow="microphone"` 対応状況の追跡 — 店主から先方に依頼した後、返答が来たら本書に追記。

---

```
Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015A2opEEGgeD2dy8ChiVU8d
```
