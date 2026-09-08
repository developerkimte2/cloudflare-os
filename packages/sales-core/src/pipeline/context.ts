/** Shared dependencies every pipeline step receives. */
import type { LlmProvider } from "../ai/provider.js";
import type { Repository } from "../db/repository.js";
import type { Clock } from "../domain/util.js";
import type { SalesConfig } from "../rules/config.js";

export interface CoreContext {
  repo: Repository;
  llm: LlmProvider;
  config: SalesConfig;
  clock: Clock;
  /** Optional structured logger; never receives prompts or raw text. */
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

export function logEvent(ctx: CoreContext, event: string, fields?: Record<string, unknown>): void {
  ctx.log?.(event, fields);
}
