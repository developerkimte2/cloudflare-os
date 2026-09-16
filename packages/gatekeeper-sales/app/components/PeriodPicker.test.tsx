import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PeriodPicker, PERIOD_PRESET_LABEL, type PeriodChoice } from "./PeriodPicker";

const noop = () => {};

describe("PeriodPicker", () => {
  it("shows every preset label", () => {
    const html = renderToStaticMarkup(<PeriodPicker value={{ preset: "THIS_MONTH" }} onChange={noop} />);
    for (const label of Object.values(PERIOD_PRESET_LABEL)) {
      expect(html).toContain(label);
    }
  });

  it("highlights only the currently selected preset", () => {
    const html = renderToStaticMarkup(<PeriodPicker value={{ preset: "THIS_QUARTER" }} onChange={noop} />);
    // The selected button carries the brand border/text classes; the others carry the neutral ones.
    const buttons = [...html.matchAll(/<button[^>]*>([^<]+)<\/button>/g)];
    const selected = buttons.find((m) => m[1] === PERIOD_PRESET_LABEL.THIS_QUARTER)!;
    const other = buttons.find((m) => m[1] === PERIOD_PRESET_LABEL.THIS_MONTH)!;
    expect(selected[0]).toContain("border-kumo-brand");
    expect(other[0]).not.toContain("border-kumo-brand");
  });

  it("shows no preset highlighted when a custom range is selected", () => {
    const value: PeriodChoice = { custom: { from: "2026-04-01", to: "2026-04-15" } };
    const html = renderToStaticMarkup(<PeriodPicker value={value} onChange={noop} />);
    expect(html).not.toContain("border-kumo-brand");
    // The date inputs are pre-filled from the custom range.
    expect(html).toContain('value="2026-04-01"');
    expect(html).toContain('value="2026-04-15"');
  });

  it("disables 任意期間 until both dates are filled in order", () => {
    const html = renderToStaticMarkup(<PeriodPicker value={{ preset: "THIS_MONTH" }} onChange={noop} />);
    expect(html).toMatch(/任意期間<\/button>/);
    const customButton = html.match(/<button[^>]*>任意期間<\/button>/)![0];
    expect(customButton).toContain("disabled=\"\"");
  });
});
