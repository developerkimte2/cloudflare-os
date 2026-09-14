import {
  Calendar,
  CaretLeft,
  Gear,
  ListChecks,
  Question,
  SquaresFour,
  UsersThree,
} from "@phosphor-icons/react";
import type { RpcStub } from "capnweb";
import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "./api";
import type { ReviewDto, SalesManagementApi, WhoAmI } from "../src/management-types";
import OnboardingPage from "./pages/OnboardingPage";
import TodayPage from "./pages/TodayPage";
import OpportunitiesPage from "./pages/OpportunitiesPage";
import OpportunityDetailPage from "./pages/OpportunityDetailPage";
import ReviewPage from "./pages/ReviewPage";
import ManagerPage from "./pages/ManagerPage";
import SettingsPage from "./pages/SettingsPage";

export type Route =
  | { kind: "today" }
  | { kind: "opportunities" }
  | { kind: "opportunity"; id: string }
  | { kind: "review" }
  | { kind: "manager" }
  | { kind: "settings" };

type Props = {
  api: RpcStub<SalesManagementApi>;
  openPrompt: (prompt: string) => void | Promise<void>;
};

export default function App({ api, openPrompt }: Props) {
  const [who, setWho] = useState<WhoAmI>();
  const [whoError, setWhoError] = useState<string>();
  const [route, setRoute] = useState<Route>({ kind: "today" });
  // In-app history. The iframe has no URL of its own, so the browser's back button leaves Sales OS
  // entirely; the back bar walks this stack instead.
  const [history, setHistory] = useState<Route[]>([]);
  const [openReviewCount, setOpenReviewCount] = useState(0);

  const navigate = useCallback(
    (next: Route) => {
      if (sameRoute(next, route)) return;
      setHistory((stack) => [...stack, route].slice(-50));
      setRoute(next);
    },
    [route],
  );

  const goBack = useCallback(() => {
    const previous = history[history.length - 1];
    if (previous) {
      setHistory(history.slice(0, -1));
      setRoute(previous);
    } else {
      setRoute(route.kind === "opportunity" ? { kind: "opportunities" } : { kind: "today" });
    }
  }, [history, route]);

  const loadWhoAmI = useCallback(() => {
    setWhoError(undefined);
    api
      .whoAmI()
      .then(setWho)
      .catch((caught) => setWhoError(errorMessage(caught)));
  }, [api]);

  useEffect(() => {
    loadWhoAmI();
  }, [loadWhoAmI]);

  const refreshReviewCount = useCallback(() => {
    api
      .listReviews()
      .then((reviews: ReviewDto[]) => setOpenReviewCount(reviews.filter((r) => r.status === "OPEN").length))
      .catch(() => {});
  }, [api]);

  useEffect(() => {
    if (who?.user) refreshReviewCount();
  }, [who?.user, refreshReviewCount]);

  const openOpportunity = useCallback((id: string) => navigate({ kind: "opportunity", id }), [navigate]);

  if (whoError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-kumo-danger">読み込みに失敗しました。</p>
        <p className="max-w-md text-xs text-kumo-subtle">{whoError}</p>
        <button
          type="button"
          className="press rounded-lg border border-kumo-line bg-kumo-control px-3.5 py-2 text-sm font-medium text-kumo-default hover:bg-kumo-tint"
          onClick={loadWhoAmI}
        >
          再試行
        </button>
      </div>
    );
  }

  if (!who) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-kumo-subtle">読み込み中…</p>
      </div>
    );
  }

  if (!who.user) {
    return (
      <OnboardingPage
        api={api}
        isAdmin={who.isAdmin}
        firstUser={who.firstUser}
        onRegistered={loadWhoAmI}
      />
    );
  }

  const user = who.user;
  const canManage = user.role === "MANAGER" || user.role === "ADMIN";
  const canAdminister = user.role === "ADMIN";

  return (
    <div className="flex h-full flex-col bg-kumo-base text-kumo-default">
      {!who.ai.configured && (
        <div className="flex shrink-0 items-center gap-2 border-b border-kumo-danger-tint bg-kumo-danger-tint px-4 py-2 text-xs text-kumo-danger">
          <Question size={14} className="shrink-0" />
          AI プロバイダが未設定です。管理者は wrangler の SALES_AI_* 設定を確認してください。
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <Sidebar
          route={route}
          setRoute={navigate}
          canManage={canManage}
          canAdminister={canAdminister}
          openReviewCount={openReviewCount}
          userDisplayName={user.displayName}
        />
        <main className="min-w-0 flex-1 overflow-y-auto">
          {(history.length > 0 || route.kind !== "today") && (
            <BackBar
              label={
                history.length > 0
                  ? ROUTE_LABEL[history[history.length - 1]!.kind]
                  : ROUTE_LABEL[route.kind === "opportunity" ? "opportunities" : "today"]
              }
              onBack={goBack}
            />
          )}
          {route.kind === "today" && (
            <TodayPage
              api={api}
              user={user}
              ai={who.ai}
              transcription={who.transcription}
              onOpenOpportunity={openOpportunity}
              onReviewsChanged={refreshReviewCount}
            />
          )}
          {route.kind === "opportunities" && (
            <OpportunitiesPage api={api} user={user} onOpenOpportunity={openOpportunity} />
          )}
          {route.kind === "opportunity" && (
            <OpportunityDetailPage
              key={route.id}
              api={api}
              user={user}
              opportunityId={route.id}
            />
          )}
          {route.kind === "review" && (
            <ReviewPage api={api} ai={who.ai} onReviewsChanged={refreshReviewCount} onOpenOpportunity={openOpportunity} />
          )}
          {route.kind === "manager" && canManage && (
            <ManagerPage api={api} openPrompt={openPrompt} onOpenOpportunity={openOpportunity} />
          )}
          {route.kind === "settings" && canAdminister && <SettingsPage api={api} who={who} />}
        </main>
      </div>
    </div>
  );
}

const ROUTE_LABEL: Record<Route["kind"], string> = {
  today: "今日",
  opportunities: "案件",
  opportunity: "案件詳細",
  review: "確認",
  manager: "チーム",
  settings: "設定",
};

function sameRoute(a: Route, b: Route): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== "opportunity" || (b.kind === "opportunity" && a.id === b.id);
}

function BackBar({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <div className="sticky top-0 z-10 border-b border-kumo-line bg-kumo-base px-6 py-2">
      <button
        type="button"
        onClick={onBack}
        className="press inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-sm text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
      >
        <CaretLeft size={14} /> 戻る（{label}）
      </button>
    </div>
  );
}

function Sidebar({
  route,
  setRoute,
  canManage,
  canAdminister,
  openReviewCount,
  userDisplayName,
}: {
  route: Route;
  setRoute: (route: Route) => void;
  canManage: boolean;
  canAdminister: boolean;
  openReviewCount: number;
  userDisplayName: string;
}) {
  const items: Array<{
    route: Route;
    label: string;
    icon: React.ComponentType<{ size?: number }>;
    badge?: number;
    show?: boolean;
  }> = [
    { route: { kind: "today" }, label: "今日", icon: Calendar },
    { route: { kind: "opportunities" }, label: "案件", icon: SquaresFour },
    { route: { kind: "review" }, label: "確認", icon: ListChecks, badge: openReviewCount },
    { route: { kind: "manager" }, label: "チーム", icon: UsersThree, show: canManage },
    { route: { kind: "settings" }, label: "設定", icon: Gear, show: canAdminister },
  ];

  return (
    <nav className="flex w-48 shrink-0 flex-col gap-1 border-r border-kumo-line bg-kumo-elevated px-2 py-4">
      <div className="mb-3 px-2 text-sm font-semibold tracking-tight text-kumo-default">Sales OS</div>
      {items
        .filter((item) => item.show !== false)
        .map((item) => {
          const active =
            route.kind === item.route.kind ||
            (item.route.kind === "opportunities" && route.kind === "opportunity");
          const Icon = item.icon;
          return (
            <button
              key={item.label}
              type="button"
              onClick={() => setRoute(item.route)}
              aria-current={active ? "page" : undefined}
              className={`press flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm ${
                active
                  ? "bg-kumo-fill font-medium text-kumo-default"
                  : "text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
              }`}
            >
              <Icon size={16} />
              <span className="flex-1">{item.label}</span>
              {!!item.badge && (
                <span className="rounded-full bg-kumo-brand px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      <div className="mt-auto truncate px-2.5 pt-3 text-xs text-kumo-inactive" title={userDisplayName}>
        {userDisplayName}
      </div>
    </nav>
  );
}
