/**
 * Line-item money math (D2). Pure functions -- no LLM/DB access -- so the browser bundle can import
 * them too for a live total while a rep edits 明細, before saving.
 */
import type { OpportunityLineItem, TaxCategory } from "../domain/types.js";
import type { SalesConfig } from "./config.js";

export interface LineTotals { subtotal: number; tax: number; total: number }

export function lineSubtotal(item: Pick<OpportunityLineItem, "quantity" | "unitPrice" | "discountAmount">): number {
  return item.quantity * item.unitPrice - item.discountAmount;
}

/** Tax per row (rounded per config), summed. Amounts are tax-exclusive; `total` adds the tax. */
export function lineTotals(items: OpportunityLineItem[], config: Pick<SalesConfig, "taxRates" | "taxRounding">): LineTotals {
  let subtotal = 0, tax = 0;
  for (const item of items) {
    const s = lineSubtotal(item);
    subtotal += s;
    tax += roundTax(s * (config.taxRates[item.taxCategory] ?? 0), config.taxRounding);
  }
  return { subtotal, tax, total: subtotal + tax };
}

function roundTax(value: number, mode: SalesConfig["taxRounding"]): number {
  return mode === "CEIL" ? Math.ceil(value) : mode === "ROUND" ? Math.round(value) : Math.floor(value);
}

export const DEFAULT_TAX_RATES: Record<TaxCategory, number> = { STANDARD: 0.1, REDUCED: 0.08, EXEMPT: 0 };
