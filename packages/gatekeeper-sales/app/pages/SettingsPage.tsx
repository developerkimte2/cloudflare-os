import { useKumoToastManager } from "@cloudflare/kumo";
import type { RpcStub } from "capnweb";
import { useEffect, useRef, useState } from "react";
import type {
  BulkImportPayload, BulkImportResult, CompanyDbSyncResult, ConfigDto, CustomerAccount, SalesManagementApi,
  TenantResetResult,
} from "../../src/management-types";
import { errorMessage, useApiAction, useAsyncData } from "../api";
import { ConfirmInline } from "../components/ConfirmInline";
import { ProductTable } from "../components/ProductTable";

/** Percentage-displayed confidence thresholds (設計書 §16). Stored as 0..1 fractions. */
const CONFIDENCE_FIELDS: { key: keyof ConfigDto; label: string; hint: string }[] = [
  { key: "entityAutoConfidence", label: "顧客の自動紐付け", hint: "この確信度以上で顧客を自動的に確定します。" },
  { key: "activitySummaryConfidence", label: "活動要約の採用", hint: "この確信度以上で活動要約をそのまま記録します。" },
  { key: "dateConfidence", label: "日付の確定", hint: "この確信度以上で期限を確定日として記録します。" },
  { key: "nextActionAutoConfidence", label: "次アクションの自動生成", hint: "この確信度以上でAIが次アクションを自動作成します。" },
  { key: "stateAutoConfidence", label: "状態変更の自動反映", hint: "この確信度以上で案件の状態変更を自動反映します。" },
  { key: "amountAutoConfidence", label: "金額の自動反映", hint: "この確信度以上で見込金額を自動反映します。" },
  { key: "opportunityAutoConfidence", label: "案件の自動照合", hint: "この確信度以上で既存案件に自動的に紐付けます。" },
];

const NUMBER_FIELDS: { key: keyof ConfigDto; label: string; unit: string; min: number; max?: number; step: number }[] = [
  { key: "stalledDays", label: "停滞とみなす日数", unit: "日", min: 1, step: 1 },
  { key: "preMeetingMinutes", label: "商談前リマインド", unit: "分前", min: 0, step: 5 },
  { key: "postMeetingCaptureMinutes", label: "商談後の記録リマインド", unit: "分後", min: 0, step: 5 },
  { key: "managerEscalationHours", label: "上長へのエスカレーション", unit: "時間", min: 1, step: 1 },
  { key: "fiscalYearStartMonth", label: "会計年度の開始月", unit: "月", min: 1, max: 12, step: 1 },
];

const TAX_ROUNDING_LABEL: Record<ConfigDto["taxRounding"], string> = {
  FLOOR: "切り捨て",
  ROUND: "四捨五入",
  CEIL: "切り上げ",
};
const TAX_ROUNDINGS: ConfigDto["taxRounding"][] = ["FLOOR", "ROUND", "CEIL"];

export default function SettingsPage({
  api,
  who,
  canAdminister,
}: {
  api: RpcStub<SalesManagementApi>;
  who: {
    isAdmin: boolean;
    ai: { provider: string; model: string; configured: boolean };
    slack: { configured: boolean; channel?: string };
  };
  /**
   * Sales OS's own ADMIN role (App.tsx's `user.role === "ADMIN"`) -- NOT `who.isAdmin`, which is
   * Workshop's deployment-admin flag and unrelated to Sales OS roles. A Sales OS ADMIN who isn't a
   * Workshop deployment admin could open this page (that gate already checks canAdminister) but
   * then see none of its ADMIN-only sections if they were keyed off who.isAdmin instead.
   */
  canAdminister: boolean;
}) {
  const runAction = useApiAction();
  const toasts = useKumoToastManager();
  const { loading, error, data, reload } = useAsyncData(() => api.getConfig(), [api]);
  const [form, setForm] = useState<ConfigDto>();
  const [phaseLabelsText, setPhaseLabelsText] = useState("");
  const [saving, setSaving] = useState(false);
  const [sendingSlackTest, setSendingSlackTest] = useState(false);
  const [sendingMorningBrief, setSendingMorningBrief] = useState(false);
  const [syncingCompanyDb, setSyncingCompanyDb] = useState(false);
  const [companyDbResult, setCompanyDbResult] = useState<CompanyDbSyncResult>();

  const sendSlackTest = async () => {
    setSendingSlackTest(true);
    try {
      await api.sendSlackTest();
      toasts.add({ title: "Slack にテスト送信しました", description: "チャンネルを確認してください。", variant: "success" });
    } catch (caught) {
      toasts.add({ title: "Slack へのテスト送信に失敗しました", description: errorMessage(caught), variant: "error" });
    } finally {
      setSendingSlackTest(false);
    }
  };

  const sendMorningBrief = async () => {
    setSendingMorningBrief(true);
    try {
      const result = await api.sendMorningBrief();
      toasts.add(
        result.sent
          ? { title: "Morning Brief を送信しました", description: `対象 ${result.recipientCount} 名分。`, variant: "success" }
          : { title: "本日分は送信済みでした", description: "同じ日に二重送信しないための仕様です。", variant: "info" },
      );
    } catch (caught) {
      toasts.add({ title: "Morning Brief の送信に失敗しました", description: errorMessage(caught), variant: "error" });
    } finally {
      setSendingMorningBrief(false);
    }
  };

  const syncCompanyDb = async () => {
    if (!form) return;
    setSyncingCompanyDb(true);
    setCompanyDbResult(undefined);
    try {
      // Save the URL first so the DO's fetch uses what's on screen, not a stale saved value.
      await api.updateConfig({ companyDbSheetUrl: form.companyDbSheetUrl });
      const result = await api.syncCompanyDb();
      setCompanyDbResult(result);
      toasts.add({
        title: "企業DBを同期しました",
        description: `顧客 ${result.accountsCreated}件登録・${result.accountsUpdated}件更新、担当者 ${result.personsCreated}件登録・${result.personsUpdated}件更新。`,
        variant: result.errors.length > 0 ? "info" : "success",
      });
      reload();
    } catch (caught) {
      toasts.add({ title: "企業DBの同期に失敗しました", description: errorMessage(caught), variant: "error" });
    } finally {
      setSyncingCompanyDb(false);
    }
  };

  useEffect(() => {
    if (data) {
      setForm(data);
      setPhaseLabelsText(data.phaseLabels.join(", "));
    }
  }, [data]);

  if (loading && !form) {
    return <PageShell>読み込み中…</PageShell>;
  }
  if (error || !form) {
    return (
      <PageShell>
        <p className="text-sm text-kumo-danger">読み込みに失敗しました。</p>
        {error && <p className="mt-1 text-xs text-kumo-subtle">{error}</p>}
        <button type="button" onClick={reload} className="mt-2 text-sm text-kumo-link hover:underline">
          再試行
        </button>
      </PageShell>
    );
  }

  const dirty =
    !!data &&
    (JSON.stringify({ ...form, phaseLabels: undefined }) !==
      JSON.stringify({ ...data, phaseLabels: undefined }) ||
      phaseLabelsText !== data.phaseLabels.join(", "));

  const save = async () => {
    if (!data) return;
    setSaving(true);
    const phaseLabels = phaseLabelsText
      .split(",")
      .map((label) => label.trim())
      .filter(Boolean);
    const patch: Partial<ConfigDto> = {};
    for (const key of Object.keys(form) as (keyof ConfigDto)[]) {
      if (key === "phaseLabels") continue;
      if (form[key] !== data[key]) (patch as Record<string, unknown>)[key] = form[key];
    }
    if (JSON.stringify(phaseLabels) !== JSON.stringify(data.phaseLabels)) patch.phaseLabels = phaseLabels;
    await runAction(() => api.updateConfig(patch), "設定の保存に失敗しました");
    setSaving(false);
    reload();
  };

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <header>
        <h1 className="text-xl font-semibold text-kumo-default">設定</h1>
        <p className="mt-1 text-sm text-kumo-subtle">
          AIの確信度しきい値や停滞判定など、組織全体の挙動を調整します。
        </p>
      </header>

      <section className="mt-5 rounded-lg border border-kumo-line bg-kumo-control px-3.5 py-3">
        <p className="text-xs font-medium text-kumo-subtle">AIプロバイダ</p>
        <p className="mt-1 text-sm text-kumo-default">
          {who.ai.provider} / {who.ai.model}
        </p>
        {!who.ai.configured && (
          <p className="mt-1 text-xs text-kumo-danger">
            未設定です。wrangler の SALES_AI_* 変数とシークレットを確認してください。
          </p>
        )}
        <p className="mt-2 text-xs text-kumo-inactive">
          AIプロバイダの切り替えは wrangler.jsonc / secrets の変更が必要です（この画面では変更できません）。
        </p>
      </section>

      <section className="mt-3 rounded-lg border border-kumo-line bg-kumo-control px-3.5 py-3">
        <p className="text-xs font-medium text-kumo-subtle">Slack 連携</p>
        {who.slack.configured ? (
          <p className="mt-1 text-sm text-kumo-default">送信先: {who.slack.channel}</p>
        ) : (
          <p className="mt-1 text-xs text-kumo-danger">
            未設定です。wrangler の SALES_SLACK_BOT_TOKEN（シークレット）と SALES_SLACK_CHANNEL を設定してください。
          </p>
        )}
        <p className="mt-2 text-xs text-kumo-inactive">
          Morning Brief（下記）は手動送信のみ実装済みです。毎朝自動で送る仕組み（スケジューラ連携）はまだ無く
          （plans/sales-os-notify.md）、下のボタンを押した時だけ送信されます。
        </p>
        <div className="mt-2.5 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={sendingSlackTest}
            onClick={() => void sendSlackTest()}
            className="press rounded-lg border border-kumo-line px-3 py-1.5 text-xs font-medium text-kumo-default hover:bg-kumo-tint disabled:opacity-50"
          >
            {sendingSlackTest ? "送信中…" : "テスト送信"}
          </button>
          <button
            type="button"
            disabled={sendingMorningBrief}
            onClick={() => void sendMorningBrief()}
            className="press rounded-lg border border-kumo-line px-3 py-1.5 text-xs font-medium text-kumo-default hover:bg-kumo-tint disabled:opacity-50"
          >
            {sendingMorningBrief ? "送信中…" : "Morning Brief を今すぐ送信"}
          </button>
        </div>
      </section>

      <Section title="確信度のしきい値">
        <div className="space-y-3">
          {CONFIDENCE_FIELDS.map((field) => (
            <ConfidenceField
              key={field.key}
              label={field.label}
              hint={field.hint}
              value={form[field.key] as number}
              onChange={(value) => setForm((current) => (current ? { ...current, [field.key]: value } : current))}
            />
          ))}
        </div>
      </Section>

      <Section title="その他のしきい値">
        <div className="grid grid-cols-2 gap-3">
          {NUMBER_FIELDS.map((field) => (
            <Field key={field.key} label={field.label}>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  value={form[field.key] as number}
                  onChange={(event) =>
                    setForm((current) =>
                      current ? { ...current, [field.key]: Number(event.currentTarget.value) } : current,
                    )
                  }
                  className="h-8 w-24 rounded-md border border-kumo-line bg-kumo-base px-2 text-sm text-kumo-default"
                />
                <span className="text-xs text-kumo-subtle">{field.unit}</span>
              </div>
            </Field>
          ))}
          <Field label="朝のダイジェスト時刻">
            <input
              type="time"
              value={form.morningDigestTime}
              onChange={(event) =>
                setForm((current) => (current ? { ...current, morningDigestTime: event.currentTarget.value } : current))
              }
              className="h-8 rounded-md border border-kumo-line bg-kumo-base px-2 text-sm text-kumo-default"
            />
            <p className="mt-1 text-[11px] text-kumo-inactive">
              保存されますが、まだこの時刻に自動送信する仕組みには接続されていません。上の「Morning Brief を今すぐ送信」を使ってください。
            </p>
          </Field>
          <Field label="既定通貨">
            <input
              value={form.defaultCurrency}
              onChange={(event) =>
                setForm((current) => (current ? { ...current, defaultCurrency: event.currentTarget.value } : current))
              }
              className="h-8 w-24 rounded-md border border-kumo-line bg-kumo-base px-2 text-sm text-kumo-default"
            />
          </Field>
          <Field label="既定タイムゾーン">
            <input
              value={form.defaultTimezone}
              onChange={(event) =>
                setForm((current) => (current ? { ...current, defaultTimezone: event.currentTarget.value } : current))
              }
              className="h-8 w-full rounded-md border border-kumo-line bg-kumo-base px-2 text-sm text-kumo-default"
            />
          </Field>
        </div>
      </Section>

      <Section title="消費税">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="標準税率">
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={100}
                step={0.1}
                value={Math.round(form.taxRates.STANDARD * 1000) / 10}
                onChange={(event) =>
                  setForm((current) =>
                    current
                      ? { ...current, taxRates: { ...current.taxRates, STANDARD: Number(event.currentTarget.value) / 100 } }
                      : current,
                  )
                }
                className="h-8 w-20 rounded-md border border-kumo-line bg-kumo-base px-2 text-sm text-kumo-default"
              />
              <span className="text-xs text-kumo-subtle">%</span>
            </div>
          </Field>
          <Field label="軽減税率">
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={100}
                step={0.1}
                value={Math.round(form.taxRates.REDUCED * 1000) / 10}
                onChange={(event) =>
                  setForm((current) =>
                    current
                      ? { ...current, taxRates: { ...current.taxRates, REDUCED: Number(event.currentTarget.value) / 100 } }
                      : current,
                  )
                }
                className="h-8 w-20 rounded-md border border-kumo-line bg-kumo-base px-2 text-sm text-kumo-default"
              />
              <span className="text-xs text-kumo-subtle">%</span>
            </div>
          </Field>
          <Field label="端数処理">
            <select
              value={form.taxRounding}
              onChange={(event) =>
                setForm((current) =>
                  current ? { ...current, taxRounding: event.currentTarget.value as ConfigDto["taxRounding"] } : current,
                )
              }
              className="h-8 w-full rounded-md border border-kumo-line bg-kumo-base px-2 text-sm text-kumo-default"
            >
              {TAX_ROUNDINGS.map((r) => (
                <option key={r} value={r}>
                  {TAX_ROUNDING_LABEL[r]}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Section>

      <Section title="フェーズラベル">
        <p className="mb-1.5 text-xs text-kumo-subtle">
          案件の「フェーズ」欄で使う自社独自のラベル。カンマ区切りで入力してください（案件の状態を制約するものではありません）。
        </p>
        <input
          value={phaseLabelsText}
          onChange={(event) => setPhaseLabelsText(event.currentTarget.value)}
          placeholder="初回商談, 提案, 見積提示, 稟議中"
          className="h-9 w-full rounded-lg border border-kumo-line bg-kumo-base px-3 text-sm text-kumo-default"
        />
      </Section>

      <Section title="商材">
        <ProductTable api={api} canEdit={canAdminister} />
      </Section>

      {canAdminister && (
        <Section title="企業DB連携 (Google スプレッドシート)">
          <p className="mb-1.5 text-xs text-kumo-subtle">
            会社名・法人番号・業種・住所・担当者（氏名・部署・役職・メール・電話）の一覧を持つ Google スプレッドシートの URL
            を指定すると、「今すぐ同期」で顧客・担当者としてまとめて取り込みます（法人番号または会社名で既存と照合、無ければ新規登録）。
            シートは「リンクを知っている全員が閲覧者」に共有しておく必要があります。
          </p>
          <input
            value={form.companyDbSheetUrl}
            onChange={(event) => setForm((current) => (current ? { ...current, companyDbSheetUrl: event.currentTarget.value } : current))}
            placeholder="https://docs.google.com/spreadsheets/d/.../edit"
            className="h-9 w-full rounded-lg border border-kumo-line bg-kumo-base px-3 text-sm text-kumo-default"
          />
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              disabled={syncingCompanyDb || !form.companyDbSheetUrl.trim()}
              onClick={() => void syncCompanyDb()}
              className="press rounded-lg bg-kumo-brand px-3.5 py-1.5 text-sm font-medium text-white hover:bg-kumo-brand-hover disabled:opacity-50"
            >
              {syncingCompanyDb ? "同期中…" : "今すぐ同期"}
            </button>
          </div>
          {companyDbResult && (
            <div className="mt-3 rounded-lg border border-kumo-line bg-kumo-elevated px-3.5 py-3 text-sm text-kumo-default">
              <p>
                読み込み {companyDbResult.rowsRead} 行 ／ 顧客 登録 {companyDbResult.accountsCreated} 件・更新 {companyDbResult.accountsUpdated} 件
                ／ 担当者 登録 {companyDbResult.personsCreated} 件・更新 {companyDbResult.personsUpdated} 件
              </p>
              {companyDbResult.errors.length > 0 && (
                <div className="mt-2">
                  <p className="text-xs font-medium text-kumo-danger">エラー {companyDbResult.errors.length} 件</p>
                  <ul className="mt-1 list-inside list-disc text-xs text-kumo-subtle">
                    {companyDbResult.errors.map((e, i) => (
                      <li key={i}>{e.row} 行目: {e.message}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </Section>
      )}

      {canAdminister && (
        <Section title="重複顧客の統合">
          <DuplicateAccountsSection api={api} />
        </Section>
      )}

      {canAdminister && (
        <Section title="データ移行（エクスポート / インポート / 初期化）">
          <DataMigrationSection api={api} />
        </Section>
      )}

      <div className="mt-6 flex justify-end">
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={() => void save()}
          className="press rounded-lg bg-kumo-brand px-4 py-2 text-sm font-medium text-white hover:bg-kumo-brand-hover disabled:opacity-50"
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
    </div>
  );
}

function ConfidenceField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const percent = Math.round(value * 100);
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-kumo-default">{label}</span>
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            value={percent}
            onChange={(event) => {
              const next = Number(event.currentTarget.value);
              if (Number.isFinite(next)) onChange(Math.min(100, Math.max(0, next)) / 100);
            }}
            className="h-8 w-16 rounded-md border border-kumo-line bg-kumo-base px-2 text-right text-sm text-kumo-default"
          />
          <span className="text-xs text-kumo-subtle">%</span>
        </div>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={percent}
        onChange={(event) => onChange(Number(event.currentTarget.value) / 100)}
        className="mt-1.5 w-full"
      />
      <p className="mt-0.5 text-[11px] text-kumo-inactive">{hint}</p>
    </div>
  );
}

/**
 * Same normalized name (法人格 stripped, whitespace/case folded) across two or more accounts --
 * either a genuine 表記ゆれ, or a second record 企業DB連携 created because the stored
 * normalized_name of the original had drifted. Each group merges everything into its oldest
 * account (the one other data is most likely to already reference).
 */
function DuplicateAccountsSection({ api }: { api: RpcStub<SalesManagementApi> }) {
  const toasts = useKumoToastManager();
  const { loading, error, data: groups, reload } = useAsyncData<{ normalizedName: string; accounts: CustomerAccount[] }[]>(
    () => api.findDuplicateAccountGroups(),
    [api],
  );
  const [mergingKey, setMergingKey] = useState<string>();

  const mergeGroup = async (normalizedName: string, accounts: CustomerAccount[]) => {
    setMergingKey(normalizedName);
    const [target, ...sources] = accounts;
    if (!target) return;
    try {
      for (const source of sources) {
        await api.mergeAccounts(source.id, target.id);
      }
      toasts.add({
        title: "統合しました",
        description: `「${target.displayName}」に ${sources.length} 件を統合しました。`,
        variant: "success",
      });
      reload();
    } catch (caught) {
      toasts.add({ title: "統合に失敗しました", description: errorMessage(caught), variant: "error" });
    } finally {
      setMergingKey(undefined);
    }
  };

  if (loading) return <p className="text-sm text-kumo-subtle">確認中…</p>;
  if (error) return <p className="text-sm text-kumo-danger">{error}</p>;
  if (!groups || groups.length === 0) {
    return <p className="text-sm text-kumo-subtle">重複は見つかりませんでした。</p>;
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-kumo-subtle">
        表記ゆれなどで同じ会社が複数登録されている可能性がある組み合わせです。統合すると、担当者・案件・活動はすべて
        （作成日が一番古い）1件にまとまり、残りは削除されます。取り消せません。
      </p>
      {groups.map(({ normalizedName, accounts }) => (
        <div key={normalizedName} className="rounded-lg border border-kumo-line bg-kumo-base p-3">
          <ul className="space-y-0.5 text-sm text-kumo-default">
            {accounts.map((a, i) => (
              <li key={a.id}>
                {a.displayName}
                {i === 0 && <span className="ml-1.5 text-[11px] text-kumo-inactive">（統合先）</span>}
              </li>
            ))}
          </ul>
          <div className="mt-2 flex justify-end">
            <ConfirmInline
              label="統合する"
              confirmText={`「${accounts[0]!.displayName}」に他 ${accounts.length - 1} 件を統合しますか？取り消せません。`}
              confirmLabel="統合して削除"
              tone="danger"
              disabled={mergingKey === normalizedName}
              onConfirm={() => void mergeGroup(normalizedName, accounts)}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Japanese labels for the export payload's collections, in display order. */
const EXPORT_COLLECTION_LABELS: [keyof BulkImportPayload, string][] = [
  ["accounts", "顧客"], ["persons", "担当者"], ["sourceDocuments", "元メモ"], ["opportunities", "案件"],
  ["activities", "活動"], ["nextActions", "次アクション"], ["commitments", "コミットメント"],
];

/** Japanese labels for the tables a tenant reset clears. */
const RESET_TABLE_LABELS: Record<TenantResetResult["removed"][number]["table"], string> = {
  customer_accounts: "顧客", customer_persons: "担当者", opportunities: "案件",
  opportunity_line_items: "明細", activities: "活動", next_actions: "次アクション",
  commitments: "コミットメント", review_items: "確認事項", source_documents: "元メモ",
  source_applications: "取り込み記録", ai_decisions: "AI 判断", ai_context_snapshots: "AI 状況要約",
  notification_logs: "通知履歴", calendar_event_mirrors: "カレンダー予定",
};

/**
 * Admin data migration: export (backup), import (migration in) and reset (clear test data before a
 * real pilot). Export and reset share whether an export has been shown in this session, so the reset
 * area can nudge the admin to back up first.
 */
function DataMigrationSection({ api }: { api: RpcStub<SalesManagementApi> }) {
  const [exportShown, setExportShown] = useState(false);
  return (
    <div className="space-y-6">
      <div>
        <h3 className="mb-2 text-sm font-semibold text-kumo-default">エクスポート</h3>
        <BulkExportSection api={api} onExported={() => setExportShown(true)} />
      </div>
      <div>
        <h3 className="mb-2 text-sm font-semibold text-kumo-default">インポート</h3>
        <BulkImportSection api={api} />
      </div>
      <div>
        <h3 className="mb-2 text-sm font-semibold text-kumo-danger">初期化</h3>
        <TenantResetSection api={api} exportShown={exportShown} />
      </div>
    </div>
  );
}

/**
 * Shows the whole tenant as `BulkImportPayload` JSON in a read-only textarea. The app runs in a
 * sandboxed iframe without `allow-downloads`/`allow-popups`, so there is no file download: the admin
 * selects (or, where the clipboard is permitted, copies) the text and saves it themselves.
 */
function BulkExportSection({ api, onExported }: { api: RpcStub<SalesManagementApi>; onExported: () => void }) {
  const toasts = useKumoToastManager();
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<{ json: string; counts: [string, number][] }>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canCopy = typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function";

  const runExport = async () => {
    setExporting(true);
    try {
      const payload = await api.adminBulkExport();
      setExported({
        json: JSON.stringify(payload),
        counts: EXPORT_COLLECTION_LABELS.map(([key, label]) => [label, payload[key].length]),
      });
      onExported();
    } catch (caught) {
      toasts.add({ title: "エクスポートに失敗しました", description: errorMessage(caught), variant: "error" });
    } finally {
      setExporting(false);
    }
  };

  const selectAll = () => {
    textareaRef.current?.focus();
    textareaRef.current?.select();
  };

  const copy = async () => {
    if (!exported) return;
    try {
      await navigator.clipboard.writeText(exported.json);
      toasts.add({ title: "コピーしました", variant: "success" });
    } catch (caught) {
      toasts.add({
        title: "コピーできませんでした",
        description: `「全選択」してから手動でコピーしてください（${errorMessage(caught)}）`,
        variant: "error",
      });
    }
  };

  return (
    <div className="space-y-2.5">
      <p className="text-xs text-kumo-subtle">
        このテナントの顧客・担当者・元メモ・案件・活動・次アクション・コミットメントを、下の「インポート」でそのまま読み込める
        JSON として表示します。表示された内容を全選択してコピーし、ファイルに保存してください（明細・確認事項・AI 要約は含まれません）。
      </p>
      <div className="flex justify-end">
        <button
          type="button"
          disabled={exporting}
          onClick={() => void runExport()}
          className="press rounded-lg bg-kumo-brand px-3.5 py-1.5 text-sm font-medium text-white hover:bg-kumo-brand-hover disabled:opacity-50"
        >
          {exporting ? "エクスポート中…" : "エクスポート"}
        </button>
      </div>
      {exported && (
        <>
          <p className="text-xs text-kumo-default">
            {exported.counts.map(([label, n]) => `${label} ${n}`).join("・")} 件
          </p>
          <textarea
            ref={textareaRef}
            readOnly
            value={exported.json}
            rows={6}
            onFocus={(event) => event.currentTarget.select()}
            className="w-full rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 font-mono text-xs text-kumo-default"
          />
          <div className="flex justify-end gap-2">
            {canCopy && (
              <button
                type="button"
                onClick={() => void copy()}
                className="press rounded-lg border border-kumo-line px-3 py-1.5 text-xs font-medium text-kumo-default hover:bg-kumo-tint"
              >
                コピー
              </button>
            )}
            <button
              type="button"
              onClick={selectAll}
              className="press rounded-lg border border-kumo-line px-3 py-1.5 text-xs font-medium text-kumo-default hover:bg-kumo-tint"
            >
              全選択
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Danger area: clears the tenant's business data and keeps its setup. Gated on typing RESET (the
 * server checks the same string), and warns, without blocking, when no export was shown this session.
 */
function TenantResetSection({ api, exportShown }: { api: RpcStub<SalesManagementApi>; exportShown: boolean }) {
  const toasts = useKumoToastManager();
  const [confirmation, setConfirmation] = useState("");
  const [resetting, setResetting] = useState(false);
  const [result, setResult] = useState<TenantResetResult>();

  const runReset = async () => {
    setResetting(true);
    setResult(undefined);
    try {
      const res = await api.adminResetTenant(confirmation);
      setResult(res);
      setConfirmation("");
      toasts.add({ title: "業務データを削除しました", variant: "success" });
    } catch (caught) {
      toasts.add({ title: "初期化に失敗しました", description: errorMessage(caught), variant: "error" });
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="space-y-2.5 rounded-lg border border-kumo-danger-tint bg-kumo-danger-tint px-3.5 py-3">
      <p className="text-xs text-kumo-default">
        試験運用のデータを消して本番運用を始めるための操作です。元に戻せません。
      </p>
      <ul className="list-inside list-disc text-xs text-kumo-subtle">
        <li>削除するもの: 顧客・担当者・案件・明細・活動・次アクション・コミットメント・確認事項・元メモ・AI の判断と要約・通知履歴・カレンダー予定</li>
        <li>残すもの: ユーザー・設定・商材マスタ・監査ログ</li>
      </ul>
      {!exportShown && (
        <p className="text-xs font-medium text-kumo-warning">先にエクスポートしてバックアップを取ってください</p>
      )}
      <label className="block text-xs text-kumo-default">
        確認のため <span className="font-mono font-semibold">RESET</span> と入力してください
        <input
          type="text"
          value={confirmation}
          onChange={(event) => setConfirmation(event.currentTarget.value)}
          autoComplete="off"
          spellCheck={false}
          className="mt-1 block w-48 rounded-lg border border-kumo-line bg-kumo-base px-3 py-1.5 font-mono text-sm text-kumo-default"
        />
      </label>
      <div className="flex justify-end">
        <button
          type="button"
          disabled={resetting || confirmation !== "RESET"}
          onClick={() => void runReset()}
          className="press rounded-lg bg-kumo-danger px-3.5 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {resetting ? "削除中…" : "業務データを削除する"}
        </button>
      </div>
      {result && (
        <p className="text-xs text-kumo-default">
          削除しました:{" "}
          {result.removed.filter(r => r.count > 0).map(r => `${RESET_TABLE_LABELS[r.table]} ${r.count}`).join("・") ||
            "削除対象のデータはありませんでした"}
        </p>
      )}
    </div>
  );
}

/**
 * One-time migration tool: pastes or uploads a JSON `BulkImportPayload` (exported from another
 * tenant, e.g. a local dev instance) and inserts it verbatim, keyed by id. Not linked from anywhere
 * but this admin section -- there is no ongoing use for it once a tenant has its own real data.
 */
function BulkImportSection({ api }: { api: RpcStub<SalesManagementApi> }) {
  const toasts = useKumoToastManager();
  const [text, setText] = useState("");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<BulkImportResult>();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const runImport = async () => {
    let payload: BulkImportPayload;
    try {
      payload = JSON.parse(text);
    } catch {
      toasts.add({ title: "JSON を解析できません", description: "貼り付けた内容を確認してください。", variant: "error" });
      return;
    }
    setImporting(true);
    setResult(undefined);
    try {
      const res = await api.adminBulkImport(payload);
      setResult(res);
      toasts.add({
        title: "インポートしました",
        description:
          `顧客 ${res.accountsInserted}・担当者 ${res.personsInserted}・案件 ${res.opportunitiesInserted}・` +
          `活動 ${res.activitiesInserted} 件などを登録しました。`,
        variant: res.errors.length > 0 ? "info" : "success",
      });
    } catch (caught) {
      toasts.add({ title: "インポートに失敗しました", description: errorMessage(caught), variant: "error" });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-2.5">
      <p className="text-xs text-kumo-subtle">
        別環境からエクスポートした JSON（BulkImportPayload 形式）を貼り付けるか、ファイルを選択して読み込みます。
        id をそのまま使って挿入するため、既にこのテナントに存在する id とは衝突しません（新規テナントでの一度きりの移行を想定）。
      </p>
      <textarea
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        placeholder="{ &quot;accounts&quot;: [...], &quot;persons&quot;: [...], ... }"
        rows={6}
        className="w-full rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 font-mono text-xs text-kumo-default"
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void file.text().then(setText);
        }}
      />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="press rounded-lg border border-kumo-line px-3 py-1.5 text-xs font-medium text-kumo-default hover:bg-kumo-tint"
        >
          ファイルを選択
        </button>
        <button
          type="button"
          disabled={importing || !text.trim()}
          onClick={() => void runImport()}
          className="press rounded-lg bg-kumo-brand px-3.5 py-1.5 text-sm font-medium text-white hover:bg-kumo-brand-hover disabled:opacity-50"
        >
          {importing ? "インポート中…" : "インポート実行"}
        </button>
      </div>
      {result && (
        <div className="mt-1 rounded-lg border border-kumo-line bg-kumo-elevated px-3.5 py-3 text-sm text-kumo-default">
          <p>
            顧客 {result.accountsInserted}・担当者 {result.personsInserted}・元メモ {result.sourceDocumentsInserted}・
            案件 {result.opportunitiesInserted}・活動 {result.activitiesInserted}・
            次アクション {result.nextActionsInserted}・コミットメント {result.commitmentsInserted} 件を登録しました。
          </p>
          {result.errors.length > 0 && (
            <div className="mt-2">
              <p className="text-xs font-medium text-kumo-danger">エラー {result.errors.length} 件</p>
              <ul className="mt-1 list-inside list-disc text-xs text-kumo-subtle">
                {result.errors.map((e, i) => (
                  <li key={i}>{e.entityType} {e.id}: {e.message}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-7">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-kumo-inactive">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-kumo-inactive">{label}</span>
      {children}
    </label>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-2xl px-6 py-10 text-sm text-kumo-subtle">{children}</div>;
}
