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

  describe("numbered lists (「1. …」形式, 誤解を避けるための境界)", () => {
    it("recognizes 5+ blank-line-separated paragraphs sequentially numbered from 1 (a numbered daily-report batch)", () => {
      const report = (i: number) =>
        `${i}. 株式会社サンプル${i}の担当者${i}さんと話しました。連絡先はsample${i}@example.comです。案件について説明しました。`;
      const text = Array.from({ length: 6 }, (_, i) => report(i + 1)).join("\n\n");

      const result = splitCaptureText(text);
      expect(result.rule).toBe("numbered");
      expect(result.chunks).toHaveLength(6);
      expect(result.chunks[0]).toContain("1. 株式会社サンプル1");
      expect(result.chunks[5]).toContain("6. 株式会社サンプル6");
    });

    it("accepts common numbering styles: '1)' 、'1、' 、'1．' as well as '1. '", () => {
      const paragraphs = [
        "1) 株式会社サンプルAの田中さんと話しました。案件について説明しました。連絡先は聞けていません。",
        "2、株式会社サンプルBの佐藤さんと話しました。案件について説明しました。連絡先は聞けていません。",
        "3．株式会社サンプルCの鈴木さんと話しました。案件について説明しました。連絡先は聞けていません。",
        "4. 株式会社サンプルDの高橋さんと話しました。案件について説明しました。連絡先は聞けていません。",
        "5. 株式会社サンプルEの伊藤さんと話しました。案件について説明しました。連絡先は聞けていません。",
      ];
      const result = splitCaptureText(paragraphs.join("\n\n"));
      expect(result.rule).toBe("numbered");
      expect(result.chunks).toHaveLength(5);
    });

    it("does NOT treat a short numbered to-do list for ONE case as multiple records (誤解防止, below MIN_NUMBERED_CHUNKS)", () => {
      // A single customer's next actions, laid out as a numbered list - very ordinary, must stay
      // one record. Falls back to rule=blank-lines (an opt-in candidate), never auto-applied.
      const text = [
        "ABC株式会社の山田様と打合せ。今後の対応は以下の通り。",
        "",
        "1. 見積書を送付する",
        "",
        "2. 来週電話でフォローする",
        "",
        "3. 次回訪問の日程を調整する",
      ].join("\n");

      const result = splitCaptureText(text);
      expect(result.rule).not.toBe("numbered");
    });

    it("does not treat non-sequential numbering (gaps, out of order, or not starting at 1) as a numbered batch", () => {
      const paragraphs = (nums: number[]) =>
        nums.map(n => `${n}. 株式会社サンプル${n}の担当者と話しました。案件について説明しました。詳細略。`).join("\n\n");

      // Starts at 2, not 1.
      expect(splitCaptureText(paragraphs([2, 3, 4, 5, 6])).rule).toBe("blank-lines");
      // Skips 3.
      expect(splitCaptureText(paragraphs([1, 2, 4, 5, 6])).rule).toBe("blank-lines");
      // Out of order.
      expect(splitCaptureText(paragraphs([1, 3, 2, 4, 5])).rule).toBe("blank-lines");
    });

    it("does not treat 4 sequentially-numbered paragraphs as a numbered batch (below MIN_NUMBERED_CHUNKS=5)", () => {
      const report = (i: number) =>
        `${i}. 株式会社サンプル${i}の担当者と話しました。案件について詳しく説明しました。詳細は省略します。`;
      const text = Array.from({ length: 4 }, (_, i) => report(i + 1)).join("\n\n");
      expect(splitCaptureText(text).rule).toBe("blank-lines");
    });

    it("caps numbered chunks at 100, same as the other rules", () => {
      const report = (i: number) => `${i}. これは十分に長いテスト用の営業記録です番号${i}`;
      const text = Array.from({ length: 105 }, (_, i) => report(i + 1)).join("\n\n");
      const result = splitCaptureText(text);
      expect(result.rule).toBe("numbered");
      expect(result.chunks).toHaveLength(100);
    });
  });
});
