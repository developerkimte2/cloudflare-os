import type { RpcStub } from "capnweb";
import { useMemo, useState } from "react";
import type { JsonValue, ReviewDto, SalesManagementApi, WhoAmI } from "../../src/management-types";
import { useApiAction, useAsyncData } from "../api";
import { AiAttribution } from "../components/AiAttribution";
import { Badge, ReviewStatusBadge } from "../components/Badges";
import { ReviewCard } from "../components/ReviewCard";
import { formatDateTime } from "../format";
import { REVIEW_TYPE_LABEL, SOURCE_TYPE_LABEL } from "../labels";

type Tab = "OPEN" | "RESOLVED" | "DISMISSED";
const TABS: { key: Tab; label: string }[] = [
  { key: "OPEN", label: "未確認" },
  { key: "RESOLVED", label: "解決済み" },
  { key: "DISMISSED", label: "却下" },
];

export default function ReviewPage({
  api,
  ai,
  onReviewsChanged,
  onOpenOpportunity,
}: {
  api: RpcStub<SalesManagementApi>;
  ai: WhoAmI["ai"];
  onReviewsChanged: () => void;
  onOpenOpportunity: (id: string) => void;
}) {
  // ReviewPage is reached without a `user`, so `timezone` for the rare option that asks for a due
  // date falls back to the org-wide default (設計書 §46 defaultTimezone), same as other pages'
  // `user.timezone || "Asia/Tokyo"` fallback.
  const timezone = "Asia/Tokyo";
  const runAction = useApiAction();
  const { loading, error, data, reload } = useAsyncData<ReviewDto[]>(() => api.listReviews(), [api]);
  const [tab, setTab] = useState<Tab>("OPEN");
  const [detailId, setDetailId] = useState<string | null>(null);
  const detail = useMemo(() => (data ?? []).find((review) => review.id === detailId) ?? null, [data, detailId]);

  const refresh = () => {
    reload();
    onReviewsChanged();
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

  const filtered = useMemo(() => (data ?? []).filter((review) => review.status === tab), [data, tab]);
  const openCount = useMemo(() => (data ?? []).filter((review) => review.status === "OPEN").length, [data]);

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-kumo-default">確認</h1>
          <p className="mt-1 text-sm text-kumo-subtle">
            AIが自動で確定しなかった内容です。内容を確認し、選択肢から解決してください。
          </p>
        </div>
        <AiAttribution ai={ai} />
      </header>

      <div className="mt-4 flex gap-1 border-b border-kumo-line">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className={`press -mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              tab === item.key
                ? "border-kumo-brand text-kumo-default"
                : "border-transparent text-kumo-subtle hover:text-kumo-default"
            }`}
          >
            {item.label}
            {item.key === "OPEN" && openCount > 0 && (
              <span className="ml-1.5 rounded-full bg-kumo-brand px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
                {openCount}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {loading && !data ? (
          <p className="px-1 py-8 text-center text-sm text-kumo-subtle">読み込み中…</p>
        ) : error ? (
          <div className="px-1 py-8 text-center">
            <p className="text-sm text-kumo-danger">読み込みに失敗しました。</p>
            <p className="mt-1 text-xs text-kumo-subtle">{error}</p>
            <button type="button" onClick={reload} className="mt-2 text-sm text-kumo-link hover:underline">
              再試行
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <p className="px-1 py-8 text-center text-sm text-kumo-subtle">
            {tab === "OPEN" ? "未確認の項目はありません。" : "該当する項目はありません。"}
          </p>
        ) : tab === "OPEN" ? (
          <div className="space-y-2">
            {filtered.map((review) => (
              <ReviewCard
                key={review.id}
                review={review}
                timezone={timezone}
                onResolve={(optionId, input) => resolveReview(review.id, optionId, input)}
                onDismiss={() => dismissReview(review.id)}
                onOpenOpportunity={review.opportunityId ? () => onOpenOpportunity(review.opportunityId!) : undefined}
                onOpenDetail={() => setDetailId(review.id)}
              />
            ))}
          </div>
        ) : (
          <ResolvedList reviews={filtered} timezone={timezone} onOpenOpportunity={onOpenOpportunity} />
        )}
      </div>

      {detail && <ReviewDetailPanel review={detail} timezone={timezone} onClose={() => setDetailId(null)} />}
    </div>
  );
}

/** Read-only side panel showing the source text (メモ) a review was generated from. */
function ReviewDetailPanel({
  review,
  timezone,
  onClose,
}: {
  review: ReviewDto;
  timezone: string;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-30 flex justify-end" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="閉じる"
        onClick={onClose}
        className="absolute inset-0 bg-black/20"
      />
      <div className="relative flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-kumo-line bg-kumo-base px-5 py-6 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Badge label={REVIEW_TYPE_LABEL[review.type]} tone="warning" />
            <p className="mt-1.5 text-sm font-medium text-kumo-default">{review.question}</p>
            {review.relatedTitle && <p className="mt-0.5 text-xs text-kumo-subtle">{review.relatedTitle}</p>}
          </div>
          <button type="button" onClick={onClose} className="shrink-0 text-sm text-kumo-link hover:underline">
            閉じる
          </button>
        </div>

        <div className="mt-5 space-y-3">
          {review.sources.length === 0 ? (
            <p className="text-sm text-kumo-subtle">元の入力が見つかりませんでした。</p>
          ) : (
            review.sources.map((source) => (
              <div key={source.id} className="rounded-lg border border-kumo-line bg-kumo-elevated p-3">
                <div className="flex items-center justify-between gap-2 text-xs text-kumo-subtle">
                  <span>{SOURCE_TYPE_LABEL[source.sourceType]}</span>
                  {source.occurredAt && <span>{formatDateTime(source.occurredAt, timezone)}</span>}
                </div>
                <p className="mt-1.5 whitespace-pre-wrap text-sm text-kumo-default">
                  {source.rawText ?? "（本文なし）"}
                </p>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function ResolvedList({
  reviews,
  timezone,
  onOpenOpportunity,
}: {
  reviews: ReviewDto[];
  timezone: string;
  onOpenOpportunity: (id: string) => void;
}) {
  const sorted = [...reviews].sort((a, b) => (a.resolvedAt ?? a.createdAt) < (b.resolvedAt ?? b.createdAt) ? 1 : -1);
  return (
    <div className="divide-y divide-kumo-line rounded-lg border border-kumo-line">
      {sorted.map((review) => (
        <div key={review.id} className="px-3.5 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <ReviewStatusBadge status={review.status} />
                <span className="text-xs text-kumo-inactive">{REVIEW_TYPE_LABEL[review.type]}</span>
              </div>
              <p className="mt-1.5 text-sm text-kumo-default">{review.question}</p>
              {review.relatedTitle && (
                <button
                  type="button"
                  onClick={() => review.opportunityId && onOpenOpportunity(review.opportunityId)}
                  disabled={!review.opportunityId}
                  className="mt-0.5 text-xs text-kumo-link hover:underline disabled:no-underline disabled:text-kumo-subtle"
                >
                  {review.relatedTitle}
                </button>
              )}
            </div>
            <span className="shrink-0 text-xs text-kumo-inactive">
              {formatDateTime(review.resolvedAt ?? review.createdAt, timezone)}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
