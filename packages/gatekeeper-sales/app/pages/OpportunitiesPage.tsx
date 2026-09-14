import { MagnifyingGlass } from "@phosphor-icons/react";
import type { RpcStub } from "capnweb";
import { useEffect, useMemo, useState } from "react";
import type {
  OpportunityFilter,
  OpportunitySummary,
  SalesManagementApi,
  UserDto,
} from "../../src/management-types";
import { useAsyncData } from "../api";
import { OpportunityStatusBadge, RiskBadge } from "../components/Badges";
import { formatDate, formatDateTime, formatDueLabel } from "../format";
import { LIFECYCLE_LABEL } from "../labels";

type LifecycleState = NonNullable<OpportunityFilter["lifecycleStates"]>[number];
const LIFECYCLE_STATES: LifecycleState[] = ["OPEN", "WON", "LOST", "ON_HOLD", "CLOSED"];

export default function OpportunitiesPage({
  api,
  user,
  onOpenOpportunity,
  onOpenCustomer,
}: {
  api: RpcStub<SalesManagementApi>;
  user: UserDto;
  onOpenOpportunity: (id: string) => void;
  onOpenCustomer: (accountId: string) => void;
}) {
  const timezone = user.timezone || "Asia/Tokyo";
  const now = new Date();
  const [lifecycle, setLifecycle] = useState<LifecycleState | "ALL">("OPEN");
  const [ownerUserId, setOwnerUserId] = useState<string>("");
  const [stalledOnly, setStalledOnly] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [query, setQuery] = useState("");

  // Search runs server-side (the list is capped), so wait for a pause in typing before querying.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(searchText.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchText]);

  const { data: config } = useAsyncData(() => api.getConfig().catch(() => undefined), [api]);
  const { data: users } = useAsyncData<UserDto[]>(() => api.listUsers().catch(() => [] as UserDto[]), [api]);
  const stalledDays = config?.stalledDays ?? 7;

  const filter: OpportunityFilter = useMemo(
    () => ({
      lifecycleStates: lifecycle === "ALL" ? undefined : [lifecycle],
      ownerUserId: ownerUserId || undefined,
      stalledDays: stalledOnly ? stalledDays : undefined,
      query: query || undefined,
    }),
    [lifecycle, ownerUserId, stalledOnly, stalledDays, query],
  );

  const { loading, error, data, reload } = useAsyncData<OpportunitySummary[]>(
    () => api.listOpportunities(filter),
    [api, filter.lifecycleStates?.[0], filter.ownerUserId, filter.stalledDays, filter.query],
  );

  return (
    <div className="px-6 py-8">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-kumo-default">案件</h1>
          <p className="mt-1 text-sm text-kumo-subtle">管理・検索用の一覧です。</p>
        </div>
      </header>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-sm">
          <MagnifyingGlass
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-kumo-inactive"
          />
          <input
            type="search"
            value={searchText}
            onChange={(event) => setSearchText(event.currentTarget.value)}
            placeholder="顧客名・案件名・窓口・担当者で検索"
            aria-label="案件を検索"
            className="h-8 w-full rounded-md border border-kumo-line bg-kumo-base pl-8 pr-2 text-sm text-kumo-default placeholder:text-kumo-inactive"
          />
        </div>
        <select
          value={lifecycle}
          onChange={(event) => setLifecycle(event.currentTarget.value as LifecycleState | "ALL")}
          className="h-8 rounded-md border border-kumo-line bg-kumo-base px-2 text-sm text-kumo-default"
        >
          <option value="ALL">すべての状態</option>
          {LIFECYCLE_STATES.map((state) => (
            <option key={state} value={state}>
              {LIFECYCLE_LABEL[state]}
            </option>
          ))}
        </select>
        {users && users.length > 0 && (
          <select
            value={ownerUserId}
            onChange={(event) => setOwnerUserId(event.currentTarget.value)}
            className="h-8 rounded-md border border-kumo-line bg-kumo-base px-2 text-sm text-kumo-default"
          >
            <option value="">担当者: すべて</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName}
              </option>
            ))}
          </select>
        )}
        <label className="flex items-center gap-1.5 text-sm text-kumo-subtle">
          <input
            type="checkbox"
            checked={stalledOnly}
            onChange={(event) => setStalledOnly(event.currentTarget.checked)}
          />
          停滞のみ（{stalledDays}日以上）
        </label>
      </div>

      <div className="mt-4 overflow-x-auto rounded-lg border border-kumo-line">
        {/* Keep the previous rows up while a new search/filter loads, so typing doesn't flash. */}
        {loading && !data ? (
          <p className="px-4 py-8 text-center text-sm text-kumo-subtle">読み込み中…</p>
        ) : error ? (
          <div className="px-4 py-8 text-center">
            <p className="text-sm text-kumo-danger">読み込みに失敗しました。</p>
            <button type="button" onClick={reload} className="mt-2 text-sm text-kumo-link hover:underline">
              再試行
            </button>
          </div>
        ) : !data || data.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-kumo-subtle">該当する案件がありません。</p>
        ) : (
          <table className="w-full min-w-[1120px] text-sm">
            <thead>
              <tr className="border-b border-kumo-line bg-kumo-elevated text-left text-xs text-kumo-subtle">
                <Th>顧客</Th>
                <Th>案件</Th>
                <Th>担当</Th>
                <Th>顧客窓口</Th>
                <Th>現在状況</Th>
                <Th>状態</Th>
                <Th>次アクション</Th>
                <Th>資料</Th>
                <Th>期限</Th>
                <Th>最終活動</Th>
                <Th>リスク</Th>
                <Th align="right">見込金額</Th>
                <Th>AI更新</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-kumo-line">
              {data.map((opportunity) => (
                <tr
                  key={opportunity.id}
                  onClick={() => onOpenOpportunity(opportunity.id)}
                  className="cursor-pointer hover:bg-kumo-tint"
                >
                  <Td className="max-w-[160px] truncate" onClick={(event) => event.stopPropagation()}>
                    <button
                      type="button"
                      onClick={() => onOpenCustomer(opportunity.accountId)}
                      className="truncate text-left text-kumo-link hover:underline"
                    >
                      {opportunity.accountName}
                    </button>
                  </Td>
                  <Td className="max-w-[200px] truncate font-medium text-kumo-default">{opportunity.title}</Td>
                  <Td>{opportunity.ownerName}</Td>
                  <Td className="max-w-[140px] truncate text-kumo-subtle" title={opportunity.contactNames.join("、") || undefined}>
                    {opportunity.contactNames.join("、") || "—"}
                  </Td>
                  <Td className="max-w-[240px] truncate text-kumo-subtle">{opportunity.currentSituation ?? "—"}</Td>
                  <Td className="whitespace-nowrap">
                    <OpportunityStatusBadge
                      lifecycleState={opportunity.lifecycleState}
                      operationalState={opportunity.operationalState}
                    />
                  </Td>
                  <Td className="max-w-[200px] truncate">{opportunity.nextAction?.title ?? "—"}</Td>
                  <Td onClick={(event) => opportunity.proposalDocumentUrl && event.stopPropagation()}>
                    {opportunity.proposalDocumentUrl ? (
                      <a
                        href={opportunity.proposalDocumentUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm text-kumo-link hover:underline"
                      >
                        資料
                      </a>
                    ) : (
                      <span className="text-kumo-subtle">—</span>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap">
                    {opportunity.nextAction ? formatDueLabel(opportunity.nextAction.dueAt, timezone, now) : "—"}
                  </Td>
                  <Td className="whitespace-nowrap">
                    {opportunity.lastMeaningfulActivityAt
                      ? formatDate(opportunity.lastMeaningfulActivityAt, timezone)
                      : "—"}
                  </Td>
                  <Td>
                    <RiskBadge level={opportunity.riskLevel} />
                  </Td>
                  <Td align="right" className="whitespace-nowrap">
                    {opportunity.expectedAmount != null
                      ? `${opportunity.currency ?? "JPY"} ${opportunity.expectedAmount.toLocaleString("ja-JP")}`
                      : "—"}
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-kumo-inactive">
                    {opportunity.lastContextRecomputedAt
                      ? formatDateTime(opportunity.lastContextRecomputedAt, timezone)
                      : "—"}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th className={`px-3 py-2 font-medium ${align === "right" ? "text-right" : "text-left"}`}>{children}</th>
  );
}

function Td({
  children,
  className = "",
  align = "left",
  onClick,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  align?: "left" | "right";
  onClick?: (event: React.MouseEvent) => void;
  title?: string;
}) {
  return (
    <td onClick={onClick} title={title} className={`px-3 py-2.5 ${align === "right" ? "text-right" : ""} ${className}`}>
      {children}
    </td>
  );
}
