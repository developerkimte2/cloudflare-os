import type { CaptureResult, WhoAmI } from "../../src/management-types";
import { ACTIVITY_TYPE_LABEL } from "../labels";
import { AiAttribution } from "./AiAttribution";
import { Badge } from "./Badges";
import { ReviewCard } from "./ReviewCard";

export function CaptureResultView({
  result,
  timezone,
  ai,
  onOpenOpportunity,
  onResolveReview,
  onDismissReview,
  onRetry,
}: {
  result: CaptureResult;
  timezone: string;
  ai: WhoAmI["ai"];
  onOpenOpportunity: (opportunityId: string) => void;
  onResolveReview: (id: string, optionId: string, input?: Record<string, unknown>) => void | Promise<void>;
  onDismissReview: (id: string) => void | Promise<void>;
  onRetry: () => void | Promise<void>;
}) {
  if (result.error) {
    return (
      <div className="mt-3 rounded-lg border border-kumo-danger-tint bg-kumo-danger-tint px-3.5 py-3">
        <p className="text-sm font-medium text-kumo-danger">取り込みの処理に失敗しました。</p>
        <p className="mt-1 text-xs text-kumo-danger">{result.error}</p>
        <button
          type="button"
          onClick={onRetry}
          className="press mt-2 rounded-lg border border-kumo-danger px-3 py-1.5 text-xs font-medium text-kumo-danger hover:bg-kumo-base"
        >
          再試行
        </button>
      </div>
    );
  }

  if (result.notSalesRelated) {
    return (
      <div className="mt-3 rounded-lg border border-kumo-line bg-kumo-elevated px-3.5 py-3 text-sm text-kumo-subtle">
        営業に関連する内容ではないと判断し、取り込みませんでした。
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-kumo-line bg-kumo-elevated px-3.5 py-3">
      <AiAttribution ai={ai} />
      {result.duplicate && (
        <p className="text-xs text-kumo-subtle">同じ内容が既に取り込まれています。新規の変更はありません。</p>
      )}
      {result.opportunity && (
        <button
          type="button"
          onClick={() => onOpenOpportunity(result.opportunity!.id)}
          className="block text-sm font-medium text-kumo-link hover:underline"
        >
          {result.opportunity.accountName} / {result.opportunity.title}
        </button>
      )}
      {result.activity && (
        <div className="flex items-start gap-2">
          <Badge label={ACTIVITY_TYPE_LABEL[result.activity.type]} tone="info" />
          <p className="text-sm text-kumo-default">{result.activity.summary}</p>
        </div>
      )}
      {result.nextActions.length > 0 && (
        <div>
          <p className="text-xs font-medium text-kumo-subtle">次アクション</p>
          <ul className="mt-1 list-inside list-disc text-sm text-kumo-default">
            {result.nextActions.map((action) => (
              <li key={action.id}>{action.title}</li>
            ))}
          </ul>
        </div>
      )}
      {result.commitments.length > 0 && (
        <div>
          <p className="text-xs font-medium text-kumo-subtle">約束</p>
          <ul className="mt-1 list-inside list-disc text-sm text-kumo-default">
            {result.commitments.map((commitment) => (
              <li key={commitment.id}>{commitment.description}</li>
            ))}
          </ul>
        </div>
      )}
      {result.reviews.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-kumo-subtle">確認してください</p>
          {result.reviews.map((review) => (
            <ReviewCard
              key={review.id}
              review={review}
              timezone={timezone}
              onResolve={(optionId, input) => onResolveReview(review.id, optionId, input)}
              onDismiss={() => onDismissReview(review.id)}
              onOpenOpportunity={
                review.opportunityId ? () => onOpenOpportunity(review.opportunityId!) : undefined
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
