import type { RpcStub } from "capnweb";
import { useKumoToastManager } from "@cloudflare/kumo";
import { useEffect, useState } from "react";
import type {
  AIContextSnapshot,
  AuditLog,
  Commitment,
  JsonValue,
  NextAction,
  NextActionInput,
  OpportunityDetail,
  OpportunityPatch,
  SalesManagementApi,
  SourceDocument,
  UserDto,
} from "../../src/management-types";
import { useApiAction, useAsyncData } from "../api";
import {
  Badge,
  CommitmentStatusBadge,
  LifecycleBadge,
  OperationalBadge,
  ProcessingStatusBadge,
  RiskBadge,
} from "../components/Badges";
import { ConfirmInline } from "../components/ConfirmInline";
import { NextActionRow } from "../components/NextActionRow";
import { ReviewCard } from "../components/ReviewCard";
import { formatDate, formatDateTime, isoToLocalInput, localInputToIso } from "../format";
import { buildOpportunityReport } from "../report";
import {
  ACTIVITY_TYPE_LABEL,
  ACTOR_TYPE_LABEL,
  AUDIT_ACTION_LABEL,
  COMMITMENT_SIDE_LABEL,
  DECISION_STATUS_LABEL,
  DECISION_TYPE_LABEL,
  ENTITY_TYPE_LABEL,
  LIFECYCLE_LABEL,
  NEXT_ACTION_TYPE_LABEL,
  PRIORITY_LABEL,
  RISK_LABEL,
} from "../labels";

type LifecycleState = OpportunityDetail["lifecycleState"];
const LIFECYCLE_STATES: LifecycleState[] = ["OPEN", "WON", "LOST", "ON_HOLD", "CLOSED"];

export default function OpportunityDetailPage({
  api,
  user,
  opportunityId,
}: {
  api: RpcStub<SalesManagementApi>;
  user: UserDto;
  opportunityId: string;
}) {
  const timezone = user.timezone || "Asia/Tokyo";
  const runAction = useApiAction();
  const { loading, error, data, reload } = useAsyncData<OpportunityDetail>(
    () => api.getOpportunity(opportunityId),
    [api, opportunityId],
  );
  const { data: users } = useAsyncData<UserDto[]>(() => api.listUsers().catch(() => [] as UserDto[]), [api]);
  const [recomputing, setRecomputing] = useState(false);

  if (loading && !data) {
    return <PageShell>読み込み中…</PageShell>;
  }
  if (error || !data) {
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

  const savePatch = async (patch: OpportunityPatch) => {
    await runAction(() => api.updateOpportunity(opportunityId, patch), "案件の更新に失敗しました");
    reload();
  };

  const recompute = async () => {
    setRecomputing(true);
    await runAction(() => api.recomputeContext(opportunityId), "再計算に失敗しました");
    setRecomputing(false);
    reload();
  };

  const updateNextAction = async (id: string, patch: Parameters<SalesManagementApi["updateNextAction"]>[1]) => {
    await runAction(() => api.updateNextAction(id, patch), "次アクションの更新に失敗しました");
    reload();
  };

  const createNextAction = async (input: NextActionInput) => {
    await runAction(() => api.createNextAction(input), "次アクションの作成に失敗しました");
    reload();
  };

  const updateCommitment = async (id: string, patch: { status?: Commitment["status"] }) => {
    await runAction(() => api.updateCommitment(id, patch), "約束の更新に失敗しました");
    reload();
  };

  const resolveReview = async (id: string, optionId: string, input?: Record<string, unknown>) => {
    await runAction(
      () => api.resolveReview(id, { optionId, input: input as Record<string, JsonValue> | undefined }),
      "確認の解決に失敗しました",
    );
    reload();
  };

  const dismissReview = async (id: string) => {
    await runAction(() => api.dismissReview(id), "確認の却下に失敗しました");
    reload();
  };

  const revertCapture = async (sourceId: string) => {
    await runAction(() => api.revertCapture(sourceId), "取り消しに失敗しました");
    reload();
  };

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <OpportunityHeader opportunity={data} users={users ?? []} timezone={timezone} onSave={savePatch} />

      <ContextSection context={data.context} timezone={timezone} onRecompute={recompute} recomputing={recomputing} />

      <NextActionsSection
        opportunityId={opportunityId}
        actions={data.nextActions}
        timezone={timezone}
        onUpdate={updateNextAction}
        onCreate={createNextAction}
      />

      <CommitmentsSection commitments={data.commitments} timezone={timezone} onUpdate={updateCommitment} />

      {data.reviews.length > 0 && (
        <Section title={`確認待ち (${data.reviews.length})`}>
          <div className="space-y-2">
            {data.reviews.map((review) => (
              <ReviewCard
                key={review.id}
                review={review}
                timezone={timezone}
                onResolve={(optionId, input) => resolveReview(review.id, optionId, input)}
                onDismiss={() => dismissReview(review.id)}
              />
            ))}
          </div>
        </Section>
      )}

      <ActivityTimeline
        activities={data.activities}
        sources={data.sources}
        timezone={timezone}
        onRevertCapture={revertCapture}
      />

      <DecisionHistory decisions={data.decisions} timezone={timezone} />

      <AuditSection audit={data.audit} timezone={timezone} />
    </div>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <p className="text-sm text-kumo-subtle">{children}</p>
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mt-7">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-kumo-inactive">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function OpportunityHeader({
  opportunity,
  users,
  timezone,
  onSave,
}: {
  opportunity: OpportunityDetail;
  users: UserDto[];
  timezone: string;
  onSave: (patch: OpportunityPatch) => void | Promise<void>;
}) {
  const toasts = useKumoToastManager();
  const copyReport = async () => {
    const text = buildOpportunityReport(opportunity, timezone);
    try {
      await navigator.clipboard.writeText(text);
      toasts.add({ title: "報告文をコピーしました", variant: "success" });
    } catch (caught) {
      toasts.add({
        title: "コピーに失敗しました",
        description: caught instanceof Error ? caught.message : String(caught),
        variant: "error",
      });
    }
  };
  const [title, setTitle] = useState(opportunity.title);
  const [phaseLabel, setPhaseLabel] = useState(opportunity.phaseLabel ?? "");
  const [expectedAmount, setExpectedAmount] = useState(
    opportunity.expectedAmount != null ? String(opportunity.expectedAmount) : "",
  );
  const [expectedCloseDate, setExpectedCloseDate] = useState(opportunity.expectedCloseDate ?? "");
  const [proposalDocumentUrl, setProposalDocumentUrl] = useState(opportunity.proposalDocumentUrl ?? "");
  const [lifecycleState, setLifecycleState] = useState<LifecycleState>(opportunity.lifecycleState);
  const [ownerUserId, setOwnerUserId] = useState(opportunity.ownerUserId);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setTitle(opportunity.title);
    setPhaseLabel(opportunity.phaseLabel ?? "");
    setExpectedAmount(opportunity.expectedAmount != null ? String(opportunity.expectedAmount) : "");
    setExpectedCloseDate(opportunity.expectedCloseDate ?? "");
    setProposalDocumentUrl(opportunity.proposalDocumentUrl ?? "");
    setLifecycleState(opportunity.lifecycleState);
    setOwnerUserId(opportunity.ownerUserId);
  }, [opportunity]);

  const amountChanged =
    expectedAmount.trim() !== (opportunity.expectedAmount != null ? String(opportunity.expectedAmount) : "");
  const dirty =
    title !== opportunity.title ||
    phaseLabel !== (opportunity.phaseLabel ?? "") ||
    amountChanged ||
    expectedCloseDate !== (opportunity.expectedCloseDate ?? "") ||
    proposalDocumentUrl !== (opportunity.proposalDocumentUrl ?? "") ||
    lifecycleState !== opportunity.lifecycleState ||
    ownerUserId !== opportunity.ownerUserId;

  const buildPatch = (): OpportunityPatch => ({
    title: title !== opportunity.title ? title : undefined,
    phaseLabel: phaseLabel !== (opportunity.phaseLabel ?? "") ? phaseLabel || null : undefined,
    expectedAmount: amountChanged ? (expectedAmount.trim() ? Number(expectedAmount) : null) : undefined,
    expectedCloseDate:
      expectedCloseDate !== (opportunity.expectedCloseDate ?? "") ? expectedCloseDate || null : undefined,
    proposalDocumentUrl:
      proposalDocumentUrl !== (opportunity.proposalDocumentUrl ?? "") ? proposalDocumentUrl || null : undefined,
    lifecycleState: lifecycleState !== opportunity.lifecycleState ? lifecycleState : undefined,
    ownerUserId: ownerUserId !== opportunity.ownerUserId ? ownerUserId : undefined,
    version: opportunity.version,
  });

  const doSave = async () => {
    setSaving(true);
    try {
      await onSave(buildPatch());
    } finally {
      setSaving(false);
    }
  };

  const closingOut =
    lifecycleState !== opportunity.lifecycleState && (lifecycleState === "WON" || lifecycleState === "LOST");

  return (
    <header className="rounded-xl border border-kumo-line bg-kumo-control p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <input
          value={title}
          onChange={(event) => setTitle(event.currentTarget.value)}
          className="min-w-0 flex-1 border-0 bg-transparent text-lg font-semibold text-kumo-default outline-none"
        />
        <div className="flex items-center gap-1.5">
          <LifecycleBadge state={opportunity.lifecycleState} />
          <OperationalBadge state={opportunity.operationalState} />
          <RiskBadge level={opportunity.riskLevel} />
          <button
            type="button"
            onClick={() => void copyReport()}
            className="press rounded-md border border-kumo-line px-2.5 py-1 text-xs font-medium hover:bg-kumo-tint"
          >
            報告文をコピー
          </button>
        </div>
      </div>
      <p className="mt-0.5 text-sm text-kumo-subtle">{opportunity.accountName}</p>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="フェーズ">
          <input
            value={phaseLabel}
            onChange={(event) => setPhaseLabel(event.currentTarget.value)}
            className="h-8 w-full rounded-md border border-kumo-line bg-kumo-base px-2 text-sm text-kumo-default"
          />
        </Field>
        <Field label="見込金額">
          <input
            type="number"
            value={expectedAmount}
            onChange={(event) => setExpectedAmount(event.currentTarget.value)}
            className="h-8 w-full rounded-md border border-kumo-line bg-kumo-base px-2 text-sm text-kumo-default"
          />
        </Field>
        <Field label="受注予定日">
          <input
            type="date"
            value={expectedCloseDate}
            onChange={(event) => setExpectedCloseDate(event.currentTarget.value)}
            className="h-8 w-full rounded-md border border-kumo-line bg-kumo-base px-2 text-sm text-kumo-default"
          />
        </Field>
        <Field label="状態">
          <select
            value={lifecycleState}
            onChange={(event) => setLifecycleState(event.currentTarget.value as LifecycleState)}
            className="h-8 w-full rounded-md border border-kumo-line bg-kumo-base px-2 text-sm text-kumo-default"
          >
            {LIFECYCLE_STATES.map((state) => (
              <option key={state} value={state}>
                {LIFECYCLE_LABEL[state]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="担当">
          <select
            value={ownerUserId}
            onChange={(event) => setOwnerUserId(event.currentTarget.value)}
            className="h-8 w-full rounded-md border border-kumo-line bg-kumo-base px-2 text-sm text-kumo-default"
          >
            {!users.some((u) => u.id === ownerUserId) && <option value={ownerUserId}>{opportunity.ownerName}</option>}
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="提案資料URL">
          <input
            type="url"
            value={proposalDocumentUrl}
            onChange={(event) => setProposalDocumentUrl(event.currentTarget.value)}
            placeholder="https://..."
            className="h-8 w-full rounded-md border border-kumo-line bg-kumo-base px-2 text-sm text-kumo-default"
          />
        </Field>
      </div>
      {opportunity.primaryContactName && (
        <p className="mt-3 text-xs text-kumo-subtle">
          顧客窓口: <span className="text-kumo-default">{opportunity.primaryContactName}</span>
        </p>
      )}

      <div className="mt-4 flex justify-end">
        {closingOut ? (
          <ConfirmInline
            label="保存"
            confirmText={`本当に「${LIFECYCLE_LABEL[lifecycleState]}」に変更しますか？`}
            confirmLabel="変更して保存"
            tone="neutral"
            disabled={!dirty || saving}
            onConfirm={doSave}
          />
        ) : (
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={() => void doSave()}
            className="press rounded-lg bg-kumo-brand px-3.5 py-1.5 text-sm font-medium text-white hover:bg-kumo-brand-hover disabled:opacity-50"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        )}
      </div>
    </header>
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

// ---------------------------------------------------------------------------
// AI context (FACT is the activity timeline; this section is INFERENCE)
// ---------------------------------------------------------------------------

function asStringList(json: unknown): string[] {
  if (!Array.isArray(json)) return [];
  return json.filter((item): item is string => typeof item === "string");
}

function asRiskList(json: unknown): Array<{ level?: string; reason?: string }> {
  if (!Array.isArray(json)) return [];
  return json.filter((item): item is { level?: string; reason?: string } => typeof item === "object" && item !== null);
}

function ContextSection({
  context,
  timezone,
  onRecompute,
  recomputing,
}: {
  context: AIContextSnapshot | undefined;
  timezone: string;
  onRecompute: () => void;
  recomputing: boolean;
}) {
  const recomputeButton = (
    <button
      type="button"
      disabled={recomputing}
      onClick={onRecompute}
      className="press rounded-md border border-kumo-line px-2.5 py-1 text-xs font-medium hover:bg-kumo-tint disabled:opacity-50"
    >
      {recomputing ? "再計算中…" : "再計算"}
    </button>
  );

  return (
    <Section title="現在の状況 (AI整理・推論)" action={recomputeButton}>
      {!context ? (
        <p className="rounded-lg border border-kumo-line bg-kumo-elevated px-3.5 py-3 text-sm text-kumo-subtle">
          まだAIによる整理がありません。
        </p>
      ) : (
        <div className="rounded-lg border border-kumo-line bg-kumo-elevated px-3.5 py-3">
          <p className="text-sm text-kumo-default">{context.currentSituation}</p>
          {context.latestDevelopment && (
            <p className="mt-2 text-sm text-kumo-subtle">
              <span className="font-medium text-kumo-default">最新の動き: </span>
              {context.latestDevelopment}
            </p>
          )}
          {context.customerIntent && (
            <p className="mt-1 text-sm text-kumo-subtle">
              <span className="font-medium text-kumo-default">顧客の意向: </span>
              {context.customerIntent}
            </p>
          )}
          <MiniList label="決定事項" items={asStringList(context.decidedJson)} />
          <MiniList label="未解決" items={asStringList(context.unresolvedJson)} />
          {asRiskList(context.risksJson).length > 0 && (
            <div className="mt-2">
              <p className="text-xs font-medium text-kumo-subtle">リスク</p>
              <ul className="mt-1 list-inside list-disc text-sm text-kumo-default">
                {asRiskList(context.risksJson).map((risk, index) => (
                  <li key={index}>
                    {risk.level && (
                      <Badge label={(RISK_LABEL as Record<string, string>)[risk.level] ?? risk.level} tone="warning" />
                    )}{" "}
                    {risk.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="mt-3 text-[11px] text-kumo-inactive" title={`prompt: ${context.promptVersion}`}>
            判定AI: {context.modelName} ・ {formatDateTime(context.createdAt, timezone)}
          </p>
        </div>
      )}
    </Section>
  );
}

function MiniList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-2">
      <p className="text-xs font-medium text-kumo-subtle">{label}</p>
      <ul className="mt-1 list-inside list-disc text-sm text-kumo-default">
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Next actions
// ---------------------------------------------------------------------------

function NextActionsSection({
  opportunityId,
  actions,
  timezone,
  onUpdate,
  onCreate,
}: {
  opportunityId: string;
  actions: NextAction[];
  timezone: string;
  onUpdate: (id: string, patch: Parameters<SalesManagementApi["updateNextAction"]>[1]) => void | Promise<void>;
  onCreate: (input: NextActionInput) => void | Promise<void>;
}) {
  const now = new Date();
  const open = actions.filter((a) => a.status === "OPEN" || a.status === "SNOOZED");
  const done = actions.filter((a) => a.status === "DONE" || a.status === "CANCELLED");
  const [adding, setAdding] = useState(false);

  return (
    <Section
      title="次アクション"
      action={
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="text-xs font-medium text-kumo-link hover:underline"
        >
          {adding ? "閉じる" : "追加"}
        </button>
      }
    >
      {adding && (
        <AddNextActionForm
          opportunityId={opportunityId}
          timezone={timezone}
          onCreate={async (input) => {
            await onCreate(input);
            setAdding(false);
          }}
        />
      )}
      {open.length === 0 && done.length === 0 ? (
        <p className="text-sm text-kumo-subtle">次アクションはありません。</p>
      ) : (
        <div className="divide-y divide-kumo-line rounded-lg border border-kumo-line">
          {[...open, ...done].map((action) => (
            <NextActionRow
              key={action.id}
              action={action}
              timezone={timezone}
              now={now}
              showCancel
              onUpdate={(patch) => onUpdate(action.id, patch)}
            />
          ))}
        </div>
      )}
    </Section>
  );
}

function AddNextActionForm({
  opportunityId,
  timezone,
  onCreate,
}: {
  opportunityId: string;
  timezone: string;
  onCreate: (input: NextActionInput) => void | Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [purpose, setPurpose] = useState("");
  const [dueLocal, setDueLocal] = useState("");
  const [priority, setPriority] = useState<NextAction["priority"]>("NORMAL");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    try {
      await onCreate({
        opportunityId,
        title: title.trim(),
        purpose: purpose.trim() || undefined,
        dueAt: dueLocal ? localInputToIso(dueLocal, timezone) : undefined,
        priority,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mb-3 flex flex-wrap items-end gap-2 rounded-lg border border-kumo-line bg-kumo-elevated p-2.5">
      <div className="min-w-[160px] flex-1">
        <input
          value={title}
          onChange={(event) => setTitle(event.currentTarget.value)}
          placeholder="やること"
          className="h-8 w-full rounded-md border border-kumo-line bg-kumo-base px-2 text-sm"
        />
      </div>
      <input
        value={purpose}
        onChange={(event) => setPurpose(event.currentTarget.value)}
        placeholder="目的（任意）"
        className="h-8 min-w-[140px] flex-1 rounded-md border border-kumo-line bg-kumo-base px-2 text-sm"
      />
      <input
        type="datetime-local"
        value={dueLocal}
        onChange={(event) => setDueLocal(event.currentTarget.value)}
        className="h-8 rounded-md border border-kumo-line bg-kumo-base px-2 text-sm"
      />
      <select
        value={priority}
        onChange={(event) => setPriority(event.currentTarget.value as NextAction["priority"])}
        className="h-8 rounded-md border border-kumo-line bg-kumo-base px-2 text-sm"
      >
        {(Object.keys(PRIORITY_LABEL) as NextAction["priority"][]).map((p) => (
          <option key={p} value={p}>
            {PRIORITY_LABEL[p]}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={!title.trim() || submitting}
        onClick={() => void submit()}
        className="press h-8 rounded-md bg-kumo-brand px-3 text-sm font-medium text-white hover:bg-kumo-brand-hover disabled:opacity-50"
      >
        追加
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Commitments
// ---------------------------------------------------------------------------

function CommitmentsSection({
  commitments,
  timezone,
  onUpdate,
}: {
  commitments: Commitment[];
  timezone: string;
  onUpdate: (id: string, patch: { status?: Commitment["status"] }) => void | Promise<void>;
}) {
  if (commitments.length === 0) return null;
  return (
    <Section title="約束">
      <div className="space-y-2">
        {(["CUSTOMER", "OUR_COMPANY"] as const).map((side) => {
          const rows = commitments.filter((c) => c.side === side);
          if (rows.length === 0) return null;
          return (
            <div key={side}>
              <p className="mb-1 text-xs font-medium text-kumo-subtle">{COMMITMENT_SIDE_LABEL[side]}</p>
              <div className="divide-y divide-kumo-line rounded-lg border border-kumo-line">
                {rows.map((commitment) => (
                  <div key={commitment.id} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-kumo-default">{commitment.description}</p>
                      {commitment.dueAt && (
                        <p className="mt-0.5 text-xs text-kumo-inactive">
                          期限: {formatDate(commitment.dueAt, timezone)}
                        </p>
                      )}
                    </div>
                    <CommitmentStatusBadge status={commitment.status} />
                    {commitment.status === "OPEN" || commitment.status === "OVERDUE" ? (
                      <div className="flex shrink-0 gap-1.5">
                        <button
                          type="button"
                          onClick={() => onUpdate(commitment.id, { status: "FULFILLED" })}
                          className="press rounded-md border border-kumo-line px-2 py-1 text-xs hover:bg-kumo-tint"
                        >
                          履行
                        </button>
                        <button
                          type="button"
                          onClick={() => onUpdate(commitment.id, { status: "CANCELLED" })}
                          className="press rounded-md border border-kumo-line px-2 py-1 text-xs hover:bg-kumo-tint"
                        >
                          取消
                        </button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Activity timeline (FACT)
// ---------------------------------------------------------------------------

function jsonList(json: unknown): string[] {
  if (!Array.isArray(json)) return [];
  return json.map((item) => (typeof item === "string" ? item : JSON.stringify(item)));
}

function ActivityTimeline({
  activities,
  sources,
  timezone,
  onRevertCapture,
}: {
  activities: OpportunityDetail["activities"];
  sources: SourceDocument[];
  timezone: string;
  onRevertCapture: (sourceId: string) => void | Promise<void>;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [showSource, setShowSource] = useState<Set<string>>(() => new Set());
  if (activities.length === 0) return null;
  const sorted = [...activities].sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));

  const toggle = (set: Set<string>, setSet: (s: Set<string>) => void, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSet(next);
  };

  return (
    <Section title="活動タイムライン（事実）">
      <div className="space-y-2">
        {sorted.map((activity) => {
          const details = [
            ...jsonList(activity.factsJson).map((v) => `事実: ${v}`),
            ...jsonList(activity.decisionsJson).map((v) => `決定: ${v}`),
            ...jsonList(activity.commitmentsJson).map((v) => `約束: ${v}`),
            ...jsonList(activity.objectionsJson).map((v) => `懸念: ${v}`),
            ...jsonList(activity.questionsJson).map((v) => `質問: ${v}`),
          ];
          const source = sources.find((s) => s.id === activity.sourceId);
          return (
            <div key={activity.id} className="rounded-lg border border-kumo-line px-3.5 py-3">
              <div className="flex items-center gap-2">
                <Badge label={ACTIVITY_TYPE_LABEL[activity.type]} tone="info" />
                <span className="text-xs text-kumo-inactive">{formatDateTime(activity.occurredAt, timezone)}</span>
              </div>
              <p className="mt-1.5 text-sm text-kumo-default">{activity.summary}</p>
              {details.length > 0 && (
                <button
                  type="button"
                  onClick={() => toggle(expanded, setExpanded, activity.id)}
                  className="mt-1.5 text-xs text-kumo-link hover:underline"
                >
                  {expanded.has(activity.id) ? "詳細を隠す" : "詳細を見る"}
                </button>
              )}
              {expanded.has(activity.id) && (
                <ul className="mt-1.5 list-inside list-disc text-xs text-kumo-subtle">
                  {details.map((line, index) => (
                    <li key={index}>{line}</li>
                  ))}
                </ul>
              )}
              {source && (
                <div className="mt-2 border-t border-kumo-line pt-2">
                  <button
                    type="button"
                    onClick={() => toggle(showSource, setShowSource, activity.id)}
                    className="text-xs text-kumo-link hover:underline"
                  >
                    元の入力
                  </button>
                  {showSource.has(activity.id) && (
                    <div className="mt-1.5 rounded-lg bg-kumo-elevated p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <ProcessingStatusBadge status={source.processingStatus} />
                        {source.processingStatus !== "REVERTED" && (
                          <ConfirmInline
                            label="取り消す"
                            confirmText="この取込を取り消しますか？関連するデータも削除されます。"
                            confirmLabel="取り消す"
                            onConfirm={() => onRevertCapture(source.id)}
                          />
                        )}
                      </div>
                      <p className="mt-1.5 whitespace-pre-wrap text-xs text-kumo-subtle">
                        {source.rawText ?? "（本文なし）"}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// AI decision history + audit (RECOMMENDATION / trace)
// ---------------------------------------------------------------------------

function DecisionHistory({
  decisions,
  timezone,
}: {
  decisions: OpportunityDetail["decisions"];
  timezone: string;
}) {
  if (decisions.length === 0) return null;
  const sorted = [...decisions].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return (
    <Section title="AI判断履歴（提案）">
      <div className="divide-y divide-kumo-line rounded-lg border border-kumo-line">
        {sorted.map((decision) => (
          <div key={decision.id} className="px-3.5 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge label={DECISION_TYPE_LABEL[decision.decisionType]} tone="neutral" />
              <Badge
                label={DECISION_STATUS_LABEL[decision.status]}
                tone={decision.status === "REJECTED" || decision.status === "REVERTED" ? "danger" : "info"}
              />
              <span className="text-xs text-kumo-inactive">確信度 {Math.round(decision.confidence * 100)}%</span>
              <span className="ml-auto text-xs text-kumo-inactive">{formatDateTime(decision.createdAt, timezone)}</span>
            </div>
            <p className="mt-1 text-sm text-kumo-default">{decision.reasoningSummary}</p>
            <p className="mt-0.5 text-[11px] text-kumo-inactive" title={`prompt: ${decision.promptVersion}`}>
              判定AI: {decision.modelName}
            </p>
          </div>
        ))}
      </div>
    </Section>
  );
}

function AuditSection({ audit, timezone }: { audit: AuditLog[]; timezone: string }) {
  if (audit.length === 0) return null;
  const sorted = [...audit].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return (
    <Section title="監査ログ">
      <div className="divide-y divide-kumo-line rounded-lg border border-kumo-line">
        {sorted.map((entry) => (
          <div key={entry.id} className="flex items-center gap-3 px-3.5 py-2 text-xs">
            <Badge label={ACTOR_TYPE_LABEL[entry.actorType]} tone="neutral" />
            <span className="min-w-0 flex-1 truncate text-kumo-default">
              {AUDIT_ACTION_LABEL[entry.action] ?? entry.action} — {ENTITY_TYPE_LABEL[entry.entityType] ?? entry.entityType}
            </span>
            <span className="shrink-0 text-kumo-inactive">{formatDateTime(entry.createdAt, timezone)}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}
