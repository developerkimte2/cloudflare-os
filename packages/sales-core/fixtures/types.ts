/**
 * Evaluation fixtures (設計書 §35). Each fixture is a self-contained scenario: a raw input a
 * salesperson would plausibly write, a scripted ("golden") LLM extraction for it, and declarative
 * expectations about what the deterministic pipeline (rules + review gates) must do with that
 * extraction. `__tests__/fixtures.test.ts` runs every fixture through `SalesService.capture()` with
 * a `FakeLlmProvider` scripted to the fixture's `extraction`, so this doubles as a regression suite
 * that does not depend on any real model's quality.
 *
 * `axes` names which of §35's evaluation axes the fixture exercises:
 *   Entity Precision, Activity extraction, Commitment extraction, Date accuracy, State agreement,
 *   Next Action usefulness, False WON/LOST, False notification
 * A few fixtures also tag a specific rule (計画書 §4 "Rules") when no §35 axis fits precisely.
 */
import type {
  ActivityType, LifecycleState, OperationalState, ReviewItemType, SourceType,
} from "../src/domain/types.js";

/** Existing account/person records to insert before the fixture's text is captured. */
export interface FixtureSeed {
  account: { displayName: string; primaryDomain?: string };
  persons?: { displayName: string; email?: string }[];
}

/**
 * Declarative pass/fail criteria checked by the generic runner in `__tests__/fixtures.test.ts`.
 * Every field is optional; only what the fixture actually cares about is asserted.
 */
export interface FixtureExpectations {
  /** Whether the source ends up needing a human decision. */
  processingStatus?: "PROCESSED" | "REVIEW_REQUIRED";
  /** Review types that MUST be present among the reviews this capture created. */
  reviewTypesInclude?: ReviewItemType[];
  /** Exact number of reviews created (use when "no extra review fired" matters). */
  reviewCount?: number;
  /** Whether the customer account resolved to a real record (not the UNRESOLVED placeholder). */
  accountResolved?: boolean;
  accountDisplayName?: string;
  lifecycleState?: LifecycleState;
  operationalState?: OperationalState;
  activityType?: ActivityType;
  /** `null` asserts the amount was NOT auto-applied (still pending review or unset). */
  expectedAmount?: number | null;
  nextActionCount?: number;
  commitmentCount?: number;
  notSalesRelated?: boolean;
}

export interface EvalFixture {
  /** e.g. "fixture_001_simple_meeting", matching 設計書 §35's naming. */
  id: string;
  axes: string[];
  /** One-line Japanese description of the scenario and what it guards against. */
  description: string;
  sourceType: SourceType;
  /** Anonymized, realistic Japanese input text — what a salesperson would actually paste in. */
  rawText: string;
  occurredAt?: string;
  seed?: FixtureSeed;
  /**
   * The "golden" (or, for a safety-net fixture, deliberately adversarial) extraction a scripted
   * FakeLlmProvider returns. Snake_case, matches `ai/schema.ts`'s `extractionSchema` — validated
   * against it by the test runner so a typo here fails loudly instead of silently.
   */
  extraction: Record<string, unknown>;
  expect: FixtureExpectations;
}
