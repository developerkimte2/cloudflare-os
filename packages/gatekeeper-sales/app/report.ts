/**
 * Plain-text "report to your manager" template for one opportunity. Mirrors sales-core's
 * `buildMorningBrief` in spirit (deterministic string building, no side effects) but is UI-owned
 * because it leans on the same Japanese enum labels the detail page already renders.
 */
import type { OpportunityDetail } from "../src/management-types";
import { formatDate } from "./format";
import { RISK_LABEL } from "./labels";

type OperationalState = OpportunityDetail["operationalState"];

const OPEN_STATUS_LINE: Record<OperationalState, string> = {
  UNKNOWN: "状況不明",
  ACTIVE: "順調に進行中",
  WAITING_CUSTOMER: "客先回答待ち",
  WAITING_INTERNAL: "社内対応待ち",
  FOLLOWUP_REQUIRED: "要フォロー",
  SCHEDULED: "予定あり",
  BLOCKED: "停滞中",
  CONTRACTING: "契約手続き中",
};

function statusLine(o: OpportunityDetail): string {
  switch (o.lifecycleState) {
    case "WON":
      return "受注";
    case "LOST":
      return "失注";
    case "ON_HOLD":
      return "保留";
    case "CLOSED":
      return "終了";
    default:
      return OPEN_STATUS_LINE[o.operationalState];
  }
}

/** Builds the copy-pasteable status report for `o`, in `timezone`. */
export function buildOpportunityReport(o: OpportunityDetail, timezone: string): string {
  const amount =
    o.expectedAmount != null ? `${o.currency ?? "JPY"} ${o.expectedAmount.toLocaleString("ja-JP")}` : "未設定";
  const risk = RISK_LABEL[o.riskLevel] + (o.riskReason ? `（${o.riskReason}）` : "");

  const lines = [
    `【案件状況報告】${o.accountName}様 ${o.title}`,
    "",
    `■ 企業:        ${o.accountName}`,
    `■ 担当:        ${o.ownerName}`,
    `■ 顧客窓口:    ${o.primaryContactName ?? "未登録"}`,
    `■ 現在の状況:  ${statusLine(o)}`,
    `■ リスク:      ${risk}`,
    "",
    `■ 次のアクション: ${o.nextAction?.title ?? "なし"}`,
    `   期限: ${o.nextAction?.dueAt ? formatDate(o.nextAction.dueAt, timezone) : "なし"}`,
    "",
    `■ 最終アクション日: ${o.lastMeaningfulActivityAt ? formatDate(o.lastMeaningfulActivityAt, timezone) : "なし"}`,
    `■ 見込金額:     ${amount}`,
    `■ 受注予定日:   ${o.expectedCloseDate ? formatDate(o.expectedCloseDate, timezone) : "未設定"}`,
    "",
    `■ 提案資料:     ${o.proposalDocumentUrl ?? "なし"}`,
  ];

  if (o.currentSituation) {
    lines.push("", "■ 補足:", `   ${o.currentSituation}`);
  }

  return lines.join("\n");
}
