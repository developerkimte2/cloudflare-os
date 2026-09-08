import { describe, expect, it } from "vitest";
import { splitCaptureText } from "../src/pipeline/split.js";

describe("splitCaptureText", () => {
  it("splits on 【...】 heading lines (FB_20260908 sample format), keeping the heading in each chunk", () => {
    const text = [
      "【営業日報 01】",
      "ABC株式会社の山田様と打合せ。",
      "",
      "【営業日報 02】",
      "合同会社ブルームワークスの佐藤様とオンライン面談。",
      "",
      "【営業日報 03】",
      "株式会社東都メディカルの鈴木様へデモ。",
    ].join("\n");

    const result = splitCaptureText(text);
    expect(result.rule).toBe("heading");
    expect(result.chunks).toHaveLength(3);
    expect(result.chunks[0]).toBe("【営業日報 01】\nABC株式会社の山田様と打合せ。");
    expect(result.chunks[1]).toContain("【営業日報 02】");
    expect(result.chunks[1]).toContain("佐藤様とオンライン面談");
    expect(result.chunks[2]).toContain("【営業日報 03】");
  });

  it("keeps content before the first heading as its own leading chunk", () => {
    const text = [
      "先方から届いたメールの転送です。",
      "【営業日報 01】",
      "本文その1。",
      "【営業日報 02】",
      "本文その2。",
    ].join("\n");

    const result = splitCaptureText(text);
    expect(result.rule).toBe("heading");
    expect(result.chunks).toHaveLength(3);
    expect(result.chunks[0]).toBe("先方から届いたメールの転送です。");
  });

  it("does not treat a single heading as multiple records", () => {
    const text = "【営業日報 01】\nABC株式会社の山田様と打合せ。来月見積を送る。";
    const result = splitCaptureText(text);
    expect(result.rule).toBe("none");
    expect(result.chunks).toEqual([text]);
  });

  it("recognizes blank-line-separated paragraphs only as a candidate (rule=blank-lines), never auto-applied", () => {
    // A single email thread with paragraph breaks - the caller must not silently split this.
    const text = [
      "件名: Re: 見積のご相談について、追加要件のご連絡です。",
      "",
      "佐藤様より返信あり。追加要件として管理者向けダッシュボードの実装希望とのこと。",
      "",
      "来週火曜に打合せを設定したいとのことです。よろしくお願いします。",
    ].join("\n");

    const result = splitCaptureText(text);
    expect(result.rule).toBe("blank-lines");
    expect(result.chunks.length).toBeGreaterThanOrEqual(2);
    // The function only classifies; whether to split is entirely the caller's (opt-in) decision.
  });

  it("falls back to a single chunk (rule=none) for one plain paragraph with no separators", () => {
    const text = "ABC株式会社の山田様と定例のオンライン商談を実施。新機能の要望をヒアリングした。";
    const result = splitCaptureText(text);
    expect(result).toEqual({ chunks: [text], rule: "none" });
  });

  it("does not classify short blank-line-separated fragments as records", () => {
    const text = "メモ1\n\nメモ2\n\nメモ3";
    const result = splitCaptureText(text);
    expect(result.rule).toBe("none");
  });

  it("caps heading-delimited chunks at 100", () => {
    const text = Array.from({ length: 105 }, (_, i) => `【営業日報 ${i + 1}】\n本文 ${i + 1}`).join("\n");
    const result = splitCaptureText(text);
    expect(result.rule).toBe("heading");
    expect(result.chunks).toHaveLength(100);
    expect(result.chunks[0]).toContain("営業日報 1】");
    expect(result.chunks[99]).toContain("営業日報 100】");
  });

  it("caps blank-line-delimited chunks at 100", () => {
    const paragraph = (i: number) => `これは十分に長いテスト用の段落です番号${i}`;
    const text = Array.from({ length: 105 }, (_, i) => paragraph(i)).join("\n\n");
    const result = splitCaptureText(text);
    expect(result.rule).toBe("blank-lines");
    expect(result.chunks).toHaveLength(100);
  });

  it("handles empty text without throwing", () => {
    expect(splitCaptureText("")).toEqual({ chunks: [""], rule: "none" });
  });
});
