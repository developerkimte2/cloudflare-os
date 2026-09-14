import type { RpcStub } from "capnweb";
import { useMemo } from "react";
import type { CustomerDetail, SalesManagementApi, UserDto } from "../../src/management-types";
import { useApiAction, useAsyncData } from "../api";
import { Badge, OpportunityStatusBadge } from "../components/Badges";
import { CustomerInfo } from "../components/CustomerInfo";
import { formatDate } from "../format";
import { LIFECYCLE_LABEL } from "../labels";

export default function CustomerPage({
  api,
  user,
  accountId,
  onOpenOpportunity,
}: {
  api: RpcStub<SalesManagementApi>;
  user: UserDto;
  accountId: string;
  onOpenOpportunity: (id: string) => void;
}) {
  const timezone = user.timezone || "Asia/Tokyo";
  const runAction = useApiAction();
  const { loading, error, data, reload } = useAsyncData<CustomerDetail>(
    () => api.getCustomer(accountId),
    [api, accountId],
  );

  const saveAccount = async (patch: Parameters<SalesManagementApi["updateAccount"]>[1]) => {
    const saved = await runAction(() => api.updateAccount(accountId, patch), "会社情報の保存に失敗しました");
    if (saved) reload();
    return saved !== undefined;
  };

  const createPerson = async (input: Parameters<SalesManagementApi["createPerson"]>[1]) => {
    const created = await runAction(() => api.createPerson(accountId, input), "担当者の追加に失敗しました");
    if (created) reload();
    return created !== undefined;
  };

  const updatePerson = async (personId: string, patch: Parameters<SalesManagementApi["updatePerson"]>[1]) => {
    const saved = await runAction(() => api.updatePerson(personId, patch), "担当者の保存に失敗しました");
    if (saved) reload();
    return saved !== undefined;
  };

  // Which of this customer's opportunities each person is 窓口 for, derived client-side — the
  // customer page shows this per person instead of the single-deal toggle the detail page shows.
  const contactOpportunities = useMemo(() => {
    const map: Record<string, { id: string; title: string }[]> = {};
    for (const person of data?.persons ?? []) map[person.id] = [];
    for (const o of data?.opportunities ?? []) {
      for (const personId of o.contactPersonIds) (map[personId] ??= []).push({ id: o.id, title: o.title });
    }
    return map;
  }, [data]);

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

  const counts = new Map<string, number>();
  for (const o of data.opportunities) counts.set(o.lifecycleState, (counts.get(o.lifecycleState) ?? 0) + 1);
  const summary = (["OPEN", "WON", "LOST", "ON_HOLD", "CLOSED"] as const)
    .filter((state) => counts.get(state))
    .map((state) => `${LIFECYCLE_LABEL[state]} ${counts.get(state)} 件`)
    .join("・");

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-kumo-default">{data.account.displayName}</h1>
          {data.account.resolutionStatus === "UNRESOLVED" && <Badge label="顧客未確定" tone="warning" />}
        </div>
        {summary && <p className="mt-1 text-sm text-kumo-subtle">{summary}</p>}
      </header>

      <div className="mt-5">
        <CustomerInfo
          account={data.account}
          persons={data.persons}
          onSaveAccount={saveAccount}
          onCreatePerson={createPerson}
          onUpdatePerson={updatePerson}
          contactOpportunities={contactOpportunities}
          onOpenOpportunity={onOpenOpportunity}
        />
      </div>

      <section className="mt-7">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-kumo-inactive">
          案件 ({data.opportunities.length})
        </h2>
        <div className="overflow-x-auto rounded-lg border border-kumo-line">
          {data.opportunities.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-kumo-subtle">表示できる案件がありません。</p>
          ) : (
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-kumo-line bg-kumo-elevated text-left text-xs text-kumo-subtle">
                  <Th>案件</Th>
                  <Th>状態</Th>
                  <Th>担当</Th>
                  <Th>顧客窓口</Th>
                  <Th>次アクション</Th>
                  <Th align="right">見込金額</Th>
                  <Th>最終活動</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-kumo-line">
                {data.opportunities.map((opportunity) => (
                  <tr
                    key={opportunity.id}
                    onClick={() => onOpenOpportunity(opportunity.id)}
                    className="cursor-pointer hover:bg-kumo-tint"
                  >
                    <Td className="max-w-[220px] truncate font-medium text-kumo-default">{opportunity.title}</Td>
                    <Td className="whitespace-nowrap">
                      <OpportunityStatusBadge
                        lifecycleState={opportunity.lifecycleState}
                        operationalState={opportunity.operationalState}
                      />
                    </Td>
                    <Td>{opportunity.ownerName}</Td>
                    <Td className="max-w-[140px] truncate text-kumo-subtle" title={opportunity.contactNames.join("、") || undefined}>
                      {opportunity.contactNames.join("、") || "—"}
                    </Td>
                    <Td className="max-w-[180px] truncate">{opportunity.nextAction?.title ?? "—"}</Td>
                    <Td align="right" className="whitespace-nowrap">
                      {opportunity.expectedAmount != null
                        ? `${opportunity.currency ?? "JPY"} ${opportunity.expectedAmount.toLocaleString("ja-JP")}`
                        : "—"}
                    </Td>
                    <Td className="whitespace-nowrap">
                      {opportunity.lastMeaningfulActivityAt ? formatDate(opportunity.lastMeaningfulActivityAt, timezone) : "—"}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <p className="text-sm text-kumo-subtle">{children}</p>
    </div>
  );
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return <th className={`px-3 py-2 font-medium ${align === "right" ? "text-right" : "text-left"}`}>{children}</th>;
}

function Td({
  children,
  className = "",
  align = "left",
  title,
}: {
  children: React.ReactNode;
  className?: string;
  align?: "left" | "right";
  title?: string;
}) {
  return (
    <td title={title} className={`px-3 py-2.5 ${align === "right" ? "text-right" : ""} ${className}`}>
      {children}
    </td>
  );
}
