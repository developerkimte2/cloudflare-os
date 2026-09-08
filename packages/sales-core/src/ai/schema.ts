/**
 * Structured-output schema for the extraction skill (設計書 §14.2). The LLM never writes to the DB;
 * its output must parse against this schema before any rule runs (AC-002).
 *
 * Keys are snake_case to match the design document's JSON examples verbatim.
 */
import { z } from "zod";

export const SCHEMA_VERSION = "extract.schema.v1";

const confidence = z.number().min(0).max(1);

/** An ISO-8601 date-time with offset, or null when the text does not pin one down (RULE-03). */
const isoDateTimeOrNull = z.string().min(16).nullable();
const isoDateOrNull = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();

export const evidenceSchema = z.string().min(1).max(500);

export const accountCandidateSchema = z.object({
  name: z.string().min(1).max(200),
  domain: z.string().max(200).nullable().optional(),
  confidence,
});

export const personCandidateSchema = z.object({
  name: z.string().min(1).max(200),
  company: z.string().max(200).nullable().optional(),
  email: z.string().max(320).nullable().optional(),
  title: z.string().max(200).nullable().optional(),
  confidence,
});

export const activityTypeSchema = z.enum([
  "MEETING", "CALL", "EMAIL", "CHAT", "NOTE", "FILE", "CALENDAR", "SYSTEM",
]);

export const operationalStateSchema = z.enum([
  "UNKNOWN", "ACTIVE", "WAITING_CUSTOMER", "WAITING_INTERNAL", "FOLLOWUP_REQUIRED", "SCHEDULED",
  "BLOCKED", "CONTRACTING",
]);

export const lifecycleStateSchema = z.enum(["OPEN", "WON", "LOST", "ON_HOLD", "CLOSED"]);

export const nextActionTypeSchema = z.enum([
  "CALL", "MEETING", "EMAIL", "FOLLOW_UP", "PROPOSAL", "NEGOTIATION", "CONTRACT",
  "INTERNAL_COORDINATION", "REVIEW", "OTHER",
]);

export const prioritySchema = z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]);
export const riskLevelSchema = z.enum(["NONE", "LOW", "MEDIUM", "HIGH"]);

export const factSchema = z.object({
  fact: z.string().min(1).max(500),
  evidence: evidenceSchema,
  confidence,
});

export const commitmentSchema = z.object({
  side: z.enum(["CUSTOMER", "OUR_COMPANY"]),
  description: z.string().min(1).max(500),
  due_at: isoDateTimeOrNull,
  due_confidence: confidence,
  evidence: evidenceSchema,
  confidence,
});

export const amountSchema = z.object({
  kind: z.enum(["QUOTE", "CONTRACT", "BUDGET", "OTHER"]),
  amount: z.number().nonnegative(),
  currency: z.string().min(3).max(3).default("JPY"),
  evidence: evidenceSchema,
  confidence,
});

export const nextActionSchema = z.object({
  action_type: nextActionTypeSchema,
  title: z.string().min(1).max(200),
  purpose: z.string().min(1).max(500),
  due_at: isoDateTimeOrNull,
  due_confidence: confidence,
  priority: prioritySchema.default("NORMAL"),
  confidence,
});

export const extractionSchema = z.object({
  entities: z.object({
    account_candidates: z.array(accountCandidateSchema).max(10).default([]),
    person_candidates: z.array(personCandidateSchema).max(20).default([]),
  }),
  opportunity: z.object({
    /** EXISTING: one of the listed open opportunities; NEW: none of them; UNKNOWN: can't tell. */
    match: z.enum(["EXISTING", "NEW", "UNKNOWN"]),
    existing_opportunity_id: z.string().nullable().optional(),
    title: z.string().max(200).nullable().optional(),
    confidence,
  }),
  activity: z.object({
    type: activityTypeSchema,
    occurred_at: isoDateTimeOrNull,
    summary: z.string().min(1).max(1000),
    confidence,
  }),
  facts: z.array(factSchema).max(50).default([]),
  decisions: z.array(factSchema).max(30).default([]),
  unresolved: z.array(z.string().max(300)).max(30).default([]),
  questions: z.array(z.string().max(300)).max(30).default([]),
  objections: z.array(z.string().max(300)).max(30).default([]),
  commitments: z.array(commitmentSchema).max(30).default([]),
  amounts: z.array(amountSchema).max(10).default([]),
  expected_close_date: isoDateOrNull.optional(),
  state: z.object({
    operational_state: operationalStateSchema,
    lifecycle_state: lifecycleStateSchema,
    reason: z.string().max(500).nullable().optional(),
    confidence,
  }),
  next_actions: z.array(nextActionSchema).max(20).default([]),
  risk: z.object({
    level: riskLevelSchema,
    reason: z.string().max(500).nullable().optional(),
    confidence,
  }),
  context: z.object({
    current_situation: z.string().min(1).max(1000),
    latest_development: z.string().min(1).max(1000),
    customer_intent: z.string().max(500).nullable().optional(),
  }),
  /** Non-sales or unusable input (e.g. "hello"); the pipeline records a NOTE and stops. */
  not_sales_related: z.boolean().default(false),
});

export type Extraction = z.infer<typeof extractionSchema>;

/** Output of the context-recompute skill (WF-03 / 設計書 §11.10). */
export const contextSnapshotSchema = z.object({
  current_situation: z.string().min(1).max(1000),
  latest_development: z.string().min(1).max(1000),
  customer_intent: z.string().max(500).nullable().optional(),
  decided: z.array(z.string().max(300)).max(30).default([]),
  unresolved: z.array(z.string().max(300)).max(30).default([]),
  risks: z.array(z.object({
    level: riskLevelSchema, reason: z.string().max(300),
  })).max(10).default([]),
  recommended_actions: z.array(nextActionSchema).max(10).default([]),
  operational_state: operationalStateSchema,
  state_confidence: confidence,
  confidence: confidence,
});

export type ContextSnapshotOutput = z.infer<typeof contextSnapshotSchema>;

/** Compact JSON Schema description used inside prompts (kept in sync with the Zod schema by test). */
export function jsonSchemaOf(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema, { unrepresentable: "any" });
}
