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
import { useApiAction, useAsyncData } from "../api";
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

  const capture = async (text: string, options?: CaptureOptions) => {
    const result = await runAction(() => api.capture(text, options), "取り込みに失敗しました");
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

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header>
        <h1 className="text-xl font-semibold text-kumo-default">
          おはようございます、{data.user.displayName} さん。
        </h1>
        <p className="mt-1 text-sm text-kumo-subtle">
          今やること {data.counts.openActions} 件（うち期限超過 {data.counts.overdue} 件）・確認待ち{" "}
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
        />
      </div>

      <TodayActionSection
        title="今やる"
        actions={data.now}
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

      {data.reviews.length > 0 && (
        <Section title={`確認してください (${data.reviews.length})`} action={<AiAttribution ai={ai} />}>
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
  timezone,
  now,
  onOpenOpportunity,
  onUpdate,
}: {
  title: string;
  actions: TodayAction[];
  timezone: string;
  now: Date;
  onOpenOpportunity: (id: string) => void;
  onUpdate: (id: string, patch: NextActionPatch) => void | Promise<void>;
}) {
  if (actions.length === 0) return null;
  return (
    <Section title={`${title} (${actions.length})`}>
      <div className="divide-y divide-kumo-line">
        {actions.map((item) => (
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
    </Section>
  );
}

function Section({
  title, action, children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
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

function PageShell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6 py-10 text-sm text-kumo-subtle">{children}</div>;
}
