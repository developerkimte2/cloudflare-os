import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AIDecision } from "@gadgets/sales-core";
import type { AnswerResult, CaptureResult } from "../src/management-types";
import { AiAttribution } from "./components/AiAttribution";
import { AnswerView } from "./components/AnswerView";
import { CaptureResultView } from "./components/CaptureResultView";

const CONFIGURED_AI = { provider: "ollama", model: "qwen3-coder:30b", configured: true };
const UNCONFIGURED_AI = { provider: "", model: "", configured: false };

function decision(modelName: string): AIDecision {
  return {
    id: "d1", entityType: "OPPORTUNITY", entityId: "o1", decisionType: "ENTITY_RESOLUTION",
    inputSourceIds: [], proposedJson: {}, confidence: 1, status: "AUTO_APPLIED",
    reasoningSummary: "", evidenceJson: {}, modelName, promptVersion: "extract.v1",
    createdAt: "2026-09-10T00:00:00.000Z",
  };
}

function captureResult(overrides: Partial<CaptureResult>): CaptureResult {
  return {
    source: { id: "s1" } as CaptureResult["source"],
    duplicate: false, nextActions: [], commitments: [], reviews: [], decisions: [], suggestions: [],
    ...overrides,
  };
}

describe("AiAttribution", () => {
  it("(a) shows the configured provider/model when nothing actual is given", () => {
    const html = renderToStaticMarkup(<AiAttribution ai={CONFIGURED_AI} />);
    expect(html).toContain("判定AI: ollama/qwen3-coder:30b");
  });

  it("(b) shows 未設定 when unconfigured and nothing actual is given", () => {
    const html = renderToStaticMarkup(<AiAttribution ai={UNCONFIGURED_AI} />);
    expect(html).toContain("未設定");
  });

  it("(c) prefers actual over the configured model, even when unconfigured", () => {
    const html = renderToStaticMarkup(<AiAttribution ai={UNCONFIGURED_AI} actual="fake/fake-model" />);
    expect(html).toContain("fake/fake-model");
    expect(html).not.toContain("未設定");
  });
});

describe("CaptureResultView", () => {
  const noop = () => {};

  it("(d) shows the model that actually decided, not the configured one", () => {
    const result = captureResult({ decisions: [decision("fake/fake-model")] });
    const html = renderToStaticMarkup(
      <CaptureResultView
        result={result}
        timezone="Asia/Tokyo"
        ai={{ provider: "ollama", model: "other-model", configured: true }}
        onOpenOpportunity={noop}
        onResolveReview={noop}
        onDismissReview={noop}
        onAdoptSuggestion={noop}
        onDismissSuggestion={noop}
        onRetry={noop}
      />,
    );
    expect(html).toContain("fake/fake-model");
    expect(html).not.toContain("other-model");
  });

  it("(e) falls back to the configured model when there are no decisions", () => {
    const result = captureResult({});
    const html = renderToStaticMarkup(
      <CaptureResultView
        result={result}
        timezone="Asia/Tokyo"
        ai={{ provider: "ollama", model: "other-model", configured: true }}
        onOpenOpportunity={noop}
        onResolveReview={noop}
        onDismissReview={noop}
        onAdoptSuggestion={noop}
        onDismissSuggestion={noop}
        onRetry={noop}
      />,
    );
    expect(html).toContain("ollama/other-model");
  });

  it("(f) shows the judging model even on the notSalesRelated branch", () => {
    const result = captureResult({ notSalesRelated: true, decisions: [decision("fake/fake-model")] });
    const html = renderToStaticMarkup(
      <CaptureResultView
        result={result}
        timezone="Asia/Tokyo"
        ai={CONFIGURED_AI}
        onOpenOpportunity={noop}
        onResolveReview={noop}
        onDismissReview={noop}
        onAdoptSuggestion={noop}
        onDismissSuggestion={noop}
        onRetry={noop}
      />,
    );
    expect(html).toContain("判定AI:");
    expect(html).toContain("fake/fake-model");
  });
});

describe("AnswerView", () => {
  it("(g) shows the model that actually answered", () => {
    const result: AnswerResult = {
      answer: "テスト回答", references: [], matchedByName: true, contactsMissing: [],
      modelProvider: "fake", modelName: "fake-model",
    };
    const html = renderToStaticMarkup(
      <AnswerView result={result} ai={CONFIGURED_AI} onOpenOpportunity={() => {}} onRetry={() => {}} />,
    );
    expect(html).toContain("fake/fake-model");
    expect(html).not.toContain("窓口を登録");
  });

  // 2026-09-15: "窓口: (未設定)" in the answer told the rep nothing about what to do next.
  it("nudges the rep to register a 窓口 for each asked-about case that has none", () => {
    const result: AnswerResult = {
      answer: "窓口: (未設定)", matchedByName: true,
      references: [{ id: "opp-1", accountName: "ABC株式会社", title: "新機能提案" }],
      contactsMissing: [{ id: "opp-1", accountName: "ABC株式会社", title: "新機能提案" }],
      modelProvider: "fake", modelName: "fake-model",
    };
    const html = renderToStaticMarkup(
      <AnswerView result={result} ai={CONFIGURED_AI} onOpenOpportunity={() => {}} onRetry={() => {}} />,
    );
    expect(html).toContain("窓口（先方の担当者）が未登録の案件があります");
    expect(html).toContain("ABC株式会社 / 新機能提案 → 窓口を登録");
  });
});
