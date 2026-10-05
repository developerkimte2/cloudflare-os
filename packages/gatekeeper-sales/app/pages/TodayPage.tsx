import type { RpcStub } from "capnweb";
import { useState } from "react";
import type {
  CaptureOptions,
  CaptureResult,
  JsonValue,
  NextActionPatch,
  SalesManagementApi,
  TodayAction,
  TodayView,
  UserDto,
  WhoAmI,
} from "../../src/management-types";
import { pollCapture, useApiAction, useAsyncData } from "../api";
import { AiAttribution } from "../components/AiAttribution";
import { CaptureBox } from "../components/CaptureBox";
import { CaptureResultView } from "../components/CaptureResultView";
import { NextActionRow } from "../components/NextActionRow";
import { ReviewCard } from "../components/ReviewCard";
import { Badge } from "../components/Badges";
import { formatDateTime } from "../format";
import { ATTENTION_LABEL, PROCESSING_STATUS_LABEL, SOURCE_TYPE_LABEL } from "../labels";

export default function TodayPage({
  api,
  user,
  ai,
  transcription,
  onOpenOpportunity,
  onReviewsChanged,
}: {
  api: RpcStub<SalesManagementApi>;
  user: UserDto;
  ai: WhoAmI["ai"];
  transcription: WhoAmI["transcription"];
  onOpenOpportunity: (id: string) => void;
  onReviewsChanged: () => void;
}) {
  const timezone = user.timezone || "Asia/Tokyo";
  const now = new Date();
  const runAction = useApiAction();
  const { loading, error, data, reload } = useAsyncData<TodayView>(() => api.getToday(), [api]);

  const [retrying, setRetrying] = useState<Record<string, boolean>>({});
  const [retryResults, setRetryResults] = useState<Record<string, CaptureResult>>({});

  const refresh = () => {
    reload();
    onReviewsChanged();
  };

  const updateNextAction = async (id: string, patch: NextActionPatch) => {
    await runAction(() => api.updateNextAction(id, patch), "次アクションの更新に失敗しました");
    refresh();
  };

  const resolveReview = async (id: string, optionId: string, input?: Record<string, unknown>) => {
    await runAction(
      () => api.resolveReview(id, { optionId, input: input as Record<string, JsonValue> | undefined }),
      "確認の解決に失敗しました",
    );
    refresh();
  };

  const dismissReview = async (id: string) => {
    await runAction(() => api.dismissReview(id), "確認の却下に失敗しました");
    refresh();
  };

  const adoptSuggestion = async (decisionId: string, index: number) => {
    const created = await runAction(() => api.adoptSuggestion(decisionId, index), "提案の採用に失敗しました");
    refresh();
    return created;
  };

  const dismissSuggestion = async (decisionId: string, index: number) => {
    await runAction(() => api.dismissSuggestion(decisionId, index), "提案の却下に失敗しました");
    refresh();
  };

  const capture = async (text: string, options?: CaptureOptions, onAccepted?: () => void) => {
    const receipt = await runAction(() => api.captureAsync(text, options), "取り込みに失敗しました");
    if (!receipt) return undefined;
    refresh(); // shows the memo as "受付済み" in 最近の取込 right away
    if (receipt.duplicate) {
      return runAction(() => api.getCapture(receipt.sourceId), "取込状況の取得に失敗しました");
    }
    onAccepted?.();
    const result = await runAction(() => pollCapture(api, receipt.sourceId), "取り込み結果の取得に失敗しました");
    refresh();
    return result;
  };

  // Read-only: unlike capture(), never mutates data, so no refresh() after it.
  const ask = (question: string) => runAction(() => api.askQuestion(question), "検索に失敗しました");

  // Read-only: nothing is stored, so no refresh() after it either.
  const transcribe = (audio: ArrayBuffer, mimeType: string) =>
    runAction(() => api.transcribeAudio(audio, mimeType), "文字起こしに失敗しました");

  const retryCapture = async (sourceId: string) => {
    setRetrying((current) => ({ ...current, [sourceId]: true }));
    const result = await runAction(() => api.retryCapture(sourceId), "再試行に失敗しました");
    setRetrying((current) => ({ ...current, [sourceId]: false }));
    if (result) setRetryResults((current) => ({ ...current, [sourceId]: result }));
    refresh();
  };

  if (loading && !data) {
    return <PageShell>読み込み中…</PageShell>;
  }
  if (error) {
    return (
      <PageShell>
        <p className="text-sm text-kumo-danger">読み込みに失敗しました。</p>
        <p className="mt-1 text-xs text-kumo-subtle">{error}</p>
        <button
          type="button"
          onClick={reload}
          className="press mt-3 rounded-lg border border-kumo-line px-3 py-1.5 text-sm hover:bg-kumo-tint"
        >
          再試行
        </button>
      </PageShell>
    );
  }
  if (!data) return null;

  // `now` mixes due-today and overdue items (in due order); split so today's work shows first.
  const todayActions = data.now.filter((item) => !item.overdue);
  const overdueActions = data.now.filter((item) => item.overdue);

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header>
        <h1 className="text-xl font-semibold text-kumo-default">
          おはようございます、{data.user.displayName} さん。
        </h1>
        <p className="mt-1 text-sm text-kumo-subtle">
          今やること {data.counts.openActions} 件（うち期限超過 {data.counts.overdue} 件）
          {data.counts.snoozed > 0 && `・スヌーズ中 ${data.counts.snoozed} 件`}・確認待ち{" "}
          {data.counts.openReviews} 件・進行中の案件 {data.counts.openOpportunities} 件
        </p>
      </header>

      <div className="mt-5">
        <CaptureBox
          timezone={timezone}
          ai={ai}
          transcription={transcription}
          onCapture={capture}
          onAsk={ask}
          onTranscribe={transcribe}
          onOpenOpportunity={onOpenOpportunity}
          onResolveReview={resolveReview}
          onDismissReview={dismissReview}
          onAdoptSuggestion={adoptSuggestion}
          onDismissSuggestion={dismissSuggestion}
        />
      </div>

      <NextStepBanner
        reviewCount={data.reviews.length}
        first={todayActions[0] ?? data.upcoming[0] ?? overdueActions[0]}
        onOpenOpportunity={onOpenOpportunity}
      />

      {data.reviews.length > 0 && (
        <Section id="today-reviews" title={`確認してください (${data.reviews.length})`} action={<AiAttribution ai={ai} />}>
          <div className="space-y-2">
            {data.reviews.map((review) => (
              <ReviewCard
                key={review.id}
                review={review}
                timezone={timezone}
                onResolve={(optionId, input) => resolveReview(review.id, optionId, input)}
                onDismiss={() => dismissReview(review.id)}
                onOpenOpportunity={review.opportunityId ? () => onOpenOpportunity(review.opportunityId!) : undefined}
              />
            ))}
          </div>
        </Section>
      )}

      <TodayActionSection
        title="今日"
        actions={todayActions}
        collapseAfter={5}
        timezone={timezone}
        now={now}
        onOpenOpportunity={onOpenOpportunity}
        onUpdate={updateNextAction}
      />
      <TodayActionSection
        title="期限超過"
        actions={overdueActions}
        collapsedByDefault
        timezone={timezone}
        now={now}
        onOpenOpportunity={onOpenOpportunity}
        onUpdate={updateNextAction}
      />
      <TodayActionSection
        title="今日・今週"
        actions={data.upcoming}
        timezone={timezone}
        now={now}
        onOpenOpportunity={onOpenOpportunity}
        onUpdate={updateNextAction}
      />
      <TodayActionSection
        title="期限なし"
        actions={data.undated}
        timezone={timezone}
        now={now}
        onOpenOpportunity={onOpenOpportunity}
        onUpdate={updateNextAction}
      />

      {data.attention.length > 0 && (
        <Section title="注意">
          <div className="divide-y divide-kumo-line rounded-lg border border-kumo-line">
            {data.attention.map((item, index) => (
              <button
                key={`${item.opportunity.id}-${index}`}
                type="button"
                onClick={() => onOpenOpportunity(item.opportunity.id)}
                className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-kumo-tint"
              >
                <Badge label={ATTENTION_LABEL[item.kind]} tone="warning" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-kumo-default">
                    {item.opportunity.accountName} / {item.opportunity.title}
                  </span>
                  <span className="block truncate text-xs text-kumo-subtle">{item.message}</span>
                </span>
              </button>
            ))}
          </div>
        </Section>
      )}

      {data.recentCaptures.length > 0 && (
        <Section title="最近の取込">
          <div className="space-y-2">
            {data.recentCaptures.map((source) => (
              <div key={source.id} className="rounded-lg border border-kumo-line px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <Badge label={SOURCE_TYPE_LABEL[source.sourceType]} tone="neutral" />
                  <Badge
                    label={PROCESSING_STATUS_LABEL[source.processingStatus]}
                    tone={
                      source.processingStatus === "PROCESSED"
                        ? "success"
                        : source.processingStatus === "FAILED"
                          ? "danger"
                          : source.processingStatus === "REVIEW_REQUIRED"
                            ? "warning"
                            : "info"
                    }
                  />
                  <span className="text-xs text-kumo-inactive">{formatDateTime(source.receivedAt, timezone)}</span>
                  {source.processingStatus === "FAILED" && (
                    <button
                      type="button"
                      disabled={!!retrying[source.id]}
                      onClick={() => void retryCapture(source.id)}
                      className="press ml-auto rounded-md border border-kumo-line px-2 py-1 text-xs font-medium hover:bg-kumo-tint disabled:opacity-50"
                    >
                      {retrying[source.id] ? "再試行中…" : "再試行"}
                    </button>
                  )}
                </div>
                {source.rawText && (
                  <p className="mt-1.5 line-clamp-2 text-xs text-kumo-subtle">{source.rawText}</p>
                )}
                {retryResults[source.id] && (
                  <CaptureResultView
                    result={retryResults[source.id]!}
                    timezone={timezone}
                    ai={ai}
                    onOpenOpportunity={onOpenOpportunity}
                    onResolveReview={resolveReview}
                    onDismissReview={dismissReview}
                    onAdoptSuggestion={adoptSuggestion}
                    onDismissSuggestion={dismissSuggestion}
                    onRetry={() => void retryCapture(source.id)}
                  />
                )}
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function TodayActionSection({
  title,
  actions,
  collapseAfter,
  collapsedByDefault,
  timezone,
  now,
  onOpenOpportunity,
  onUpdate,
}: {
  title: string;
  actions: TodayAction[];
  /** Show only this many rows until the user asks for the rest (long backlogs). */
  collapseAfter?: number;
  /** Start with no rows shown (a summary and a 表示する button instead); wins over `collapseAfter`. */
  collapsedByDefault?: boolean;
  timezone: string;
  now: Date;
  onOpenOpportunity: (id: string) => void;
  onUpdate: (id: string, patch: NextActionPatch) => void | Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  if (actions.length === 0) return null;
  if (collapsedByDefault && !expanded) {
    return (
      <Section title={`${title} (${actions.length})`}>
        <div className="flex items-center justify-between gap-3 rounded-lg border border-kumo-line px-3 py-2.5">
          <p className="text-sm text-kumo-subtle">
            期限を過ぎたアクションが {actions.length} 件あります。
          </p>
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="press shrink-0 rounded-lg border border-kumo-line px-3 py-1.5 text-xs text-kumo-subtle hover:bg-kumo-tint"
          >
            表示する
          </button>
        </div>
      </Section>
    );
  }
  const shown = collapseAfter && !expanded ? actions.slice(0, collapseAfter) : actions;
  return (
    <Section title={`${title} (${actions.length})`}>
      <div className="divide-y divide-kumo-line">
        {shown.map((item) => (
          <NextActionRow
            key={item.action.id}
            action={item.action}
            timezone={timezone}
            now={now}
            overdue={item.overdue}
            opportunityTitle={`${item.opportunity.accountName} / ${item.opportunity.title}`}
            onOpenOpportunity={() => onOpenOpportunity(item.opportunity.id)}
            onUpdate={(patch) => onUpdate(item.action.id, patch)}
          />
        ))}
      </div>
      {shown.length < actions.length && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="press mt-2 rounded-lg border border-kumo-line px-3 py-1.5 text-xs text-kumo-subtle hover:bg-kumo-tint"
        >
          残り {actions.length - shown.length} 件を表示
        </button>
      )}
    </Section>
  );
}

/** One prominent answer to "what should I do first?": pending reviews block the AI, so they win. */
function NextStepBanner({
  reviewCount,
  first,
  onOpenOpportunity,
}: {
  reviewCount: number;
  first: TodayAction | undefined;
  onOpenOpportunity: (id: string) => void;
}) {
  let label: string;
  let hint: string;
  let onClick: () => void;
  if (reviewCount > 0) {
    label = `まず確認：AI の判断待ちが ${reviewCount} 件あります`;
    hint = "回答すると、案件や次アクションに反映されます";
    onClick = () => document.getElementById("today-reviews")?.scrollIntoView({ behavior: "smooth" });
  } else if (first) {
    label = `次の一手：${first.action.title}`;
    hint = `${first.opportunity.accountName} / ${first.opportunity.title}`;
    onClick = () => onOpenOpportunity(first.opportunity.id);
  } else {
    label = "今日のタスクはありません";
    hint = "営業メモや日報を取り込むと、次アクションが作られます";
    onClick = () => {};
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="press mt-6 block w-full rounded-xl border border-kumo-line bg-kumo-tint px-4 py-3 text-left hover:bg-kumo-line"
    >
      <span className="block text-base font-semibold text-kumo-default">{label}</span>
      <span className="mt-0.5 block text-sm text-kumo-subtle">{hint}</span>
    </button>
  );
}

function Section({
  id, title, action, children,
}: {
  id?: string;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mt-7">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-kumo-inactive">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6 py-10 text-sm text-kumo-subtle">{children}</div>;
}
