import type { RpcStub } from "capnweb";
import { ChatCircleDots } from "@phosphor-icons/react";
import { useState } from "react";
import type { ManagerSummary, OpportunitySummary, SalesManagementApi, UserDto } from "../../src/management-types";
import { useApiAction, useAsyncData } from "../api";
import { LifecycleBadge, RiskBadge } from "../components/Badges";
import { formatDate, formatDateTime } from "../format";
import { LIFECYCLE_LABEL, ROLE_LABEL } from "../labels";

const ROLES: UserDto["role"][] = ["SALES", "MANAGER", "ADMIN"];

export default function ManagerPage({
  api,
  openPrompt,
  onOpenOpportunity,
}: {
  api: RpcStub<SalesManagementApi>;
  openPrompt: (prompt: string) => void | Promise<void>;
  onOpenOpportunity: (id: string) => void;
}) {
  const runAction = useApiAction();
  const { loading, error, data, reload } = useAsyncData<ManagerSummary>(() => api.getManagerSummary(), [api]);
  const { data: users, reload: reloadUsers } = useAsyncData<UserDto[]>(
    () => api.listUsers().catch(() => [] as UserDto[]),
    [api],
  );
  const timezone = "Asia/Tokyo";

  const updateUser = async (userId: string, patch: Parameters<SalesManagementApi["updateUser"]>[1]) => {
    await runAction(() => api.updateUser(userId, patch), "メンバー情報の更新に失敗しました");
    reloadUsers();
  };

  const askAi = () => {
    void openPrompt("停滞案件と高リスク案件について、状況とリスクの要点をまとめて教えてください。");
  };

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

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-kumo-default">チーム</h1>
          <p className="mt-1 text-sm text-kumo-subtle">
            {formatDateTime(data.generatedAt, timezone)} 時点・確認待ち {data.openReviews} 件
          </p>
        </div>
        <button
          type="button"
          onClick={askAi}
          className="press inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-kumo-line px-3 py-1.5 text-sm font-medium text-kumo-default hover:bg-kumo-tint"
        >
          <ChatCircleDots size={14} /> AIに相談
        </button>
      </header>

      <div className="mt-5 flex flex-wrap gap-2">
        {data.byLifecycle.map((row) => (
          <div
            key={row.lifecycleState}
            className="rounded-lg border border-kumo-line bg-kumo-control px-3.5 py-2.5"
          >
            <p className="text-xs text-kumo-subtle">{LIFECYCLE_LABEL[row.lifecycleState]}</p>
            <p className="mt-0.5 text-lg font-semibold text-kumo-default">{row.count}</p>
          </div>
        ))}
      </div>

      <OpportunityListSection
        title={`停滞案件 (${data.stalled.length})`}
        opportunities={data.stalled}
        timezone={timezone}
        onOpenOpportunity={onOpenOpportunity}
        empty="停滞している案件はありません。"
      />

      <OpportunityListSection
        title={`高リスク (${data.highRisk.length})`}
        opportunities={data.highRisk}
        timezone={timezone}
        onOpenOpportunity={onOpenOpportunity}
        empty="高リスクの案件はありません。"
      />

      <OpportunityListSection
        title={`契約手続き中 (${data.contracting.length})`}
        opportunities={data.contracting}
        timezone={timezone}
        onOpenOpportunity={onOpenOpportunity}
        empty="契約手続き中の案件はありません。"
      />

      <section className="mt-7">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-kumo-inactive">
          メンバー ({(users ?? []).length})
        </h2>
        <TeamRoster users={users ?? []} onUpdate={updateUser} />
      </section>
    </div>
  );
}

function OpportunityListSection({
  title,
  opportunities,
  timezone,
  onOpenOpportunity,
  empty,
}: {
  title: string;
  opportunities: OpportunitySummary[];
  timezone: string;
  onOpenOpportunity: (id: string) => void;
  empty: string;
}) {
  return (
    <section className="mt-7">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-kumo-inactive">{title}</h2>
      {opportunities.length === 0 ? (
        <p className="text-sm text-kumo-subtle">{empty}</p>
      ) : (
        <div className="divide-y divide-kumo-line rounded-lg border border-kumo-line">
          {opportunities.map((opportunity) => (
            <button
              key={opportunity.id}
              type="button"
              onClick={() => onOpenOpportunity(opportunity.id)}
              className="flex w-full items-start gap-3 px-3.5 py-2.5 text-left hover:bg-kumo-tint"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-kumo-default">
                    {opportunity.accountName} / {opportunity.title}
                  </span>
                  <LifecycleBadge state={opportunity.lifecycleState} />
                  <RiskBadge level={opportunity.riskLevel} />
                </div>
                <p className="mt-0.5 truncate text-xs text-kumo-subtle">
                  {opportunity.riskReason ?? opportunity.currentSituation ?? "—"}
                </p>
              </div>
              <div className="shrink-0 text-right text-xs text-kumo-inactive">
                <p>{opportunity.ownerName}</p>
                <p className="mt-0.5">
                  {opportunity.lastMeaningfulActivityAt
                    ? formatDate(opportunity.lastMeaningfulActivityAt, timezone)
                    : "—"}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function TeamRoster({
  users,
  onUpdate,
}: {
  users: UserDto[];
  onUpdate: (userId: string, patch: Parameters<SalesManagementApi["updateUser"]>[1]) => void | Promise<void>;
}) {
  if (users.length === 0) {
    return <p className="text-sm text-kumo-subtle">メンバーがいません。</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-kumo-line">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-kumo-line bg-kumo-elevated text-left text-xs text-kumo-subtle">
            <th className="px-3 py-2 font-medium">氏名</th>
            <th className="px-3 py-2 font-medium">メール</th>
            <th className="px-3 py-2 font-medium">役割</th>
            <th className="px-3 py-2 font-medium">上長</th>
            <th className="px-3 py-2 font-medium">状態</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-kumo-line">
          {users.map((user) => (
            <TeamRosterRow key={user.id} user={user} users={users} onUpdate={onUpdate} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TeamRosterRow({
  user,
  users,
  onUpdate,
}: {
  user: UserDto;
  users: UserDto[];
  onUpdate: (userId: string, patch: Parameters<SalesManagementApi["updateUser"]>[1]) => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  const apply = async (patch: Parameters<SalesManagementApi["updateUser"]>[1]) => {
    setBusy(true);
    try {
      await onUpdate(user.id, patch);
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr className={user.active ? "" : "opacity-50"}>
      <td className="px-3 py-2 font-medium text-kumo-default">{user.displayName}</td>
      <td className="px-3 py-2 text-kumo-subtle">{user.email}</td>
      <td className="px-3 py-2">
        <select
          value={user.role}
          disabled={busy}
          onChange={(event) => apply({ role: event.currentTarget.value as UserDto["role"] })}
          className="h-8 rounded-md border border-kumo-line bg-kumo-base px-2 text-sm text-kumo-default"
        >
          {ROLES.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABEL[role]}
            </option>
          ))}
        </select>
      </td>
      <td className="px-3 py-2">
        <select
          value={user.managerUserId ?? ""}
          disabled={busy}
          onChange={(event) => apply({ managerUserId: event.currentTarget.value || undefined })}
          className="h-8 rounded-md border border-kumo-line bg-kumo-base px-2 text-sm text-kumo-default"
        >
          <option value="">なし</option>
          {users
            .filter((candidate) => candidate.id !== user.id)
            .map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.displayName}
              </option>
            ))}
        </select>
      </td>
      <td className="px-3 py-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => apply({ active: !user.active })}
          className="press rounded-md border border-kumo-line px-2 py-1 text-xs hover:bg-kumo-tint disabled:opacity-50"
        >
          {user.active ? "有効" : "無効"}
        </button>
      </td>
    </tr>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-4xl px-6 py-10 text-sm text-kumo-subtle">{children}</div>;
}
