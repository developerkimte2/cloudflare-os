import { useKumoToastManager } from "@cloudflare/kumo";
import type { RpcStub } from "capnweb";
import { useEffect, useState } from "react";
import type { ConfigDto, SalesManagementApi } from "../../src/management-types";
import { errorMessage, useApiAction, useAsyncData } from "../api";

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

const NUMBER_FIELDS: { key: keyof ConfigDto; label: string; unit: string; min: number; step: number }[] = [
  { key: "stalledDays", label: "停滞とみなす日数", unit: "日", min: 1, step: 1 },
  { key: "preMeetingMinutes", label: "商談前リマインド", unit: "分前", min: 0, step: 5 },
  { key: "postMeetingCaptureMinutes", label: "商談後の記録リマインド", unit: "分後", min: 0, step: 5 },
  { key: "managerEscalationHours", label: "上長へのエスカレーション", unit: "時間", min: 1, step: 1 },
];

export default function SettingsPage({
  api,
  who,
}: {
  api: RpcStub<SalesManagementApi>;
  who: {
    isAdmin: boolean;
    ai: { provider: string; model: string; configured: boolean };
    slack: { configured: boolean; channel?: string };
  };
}) {
  const runAction = useApiAction();
  const toasts = useKumoToastManager();
  const { loading, error, data, reload } = useAsyncData(() => api.getConfig(), [api]);
  const [form, setForm] = useState<ConfigDto>();
  const [phaseLabelsText, setPhaseLabelsText] = useState("");
  const [saving, setSaving] = useState(false);
  const [sendingSlackTest, setSendingSlackTest] = useState(false);
  const [sendingMorningBrief, setSendingMorningBrief] = useState(false);

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
