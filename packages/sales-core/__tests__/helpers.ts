/** Shared test factories (not itself a `*.test.ts`, so vitest never collects it directly). */
import { NodeSqliteExecutor } from "../src/db/node-sqlite.js";
import { migrate } from "../src/db/migrations.js";
import { Repository } from "../src/db/repository.js";
import { FakeLlmProvider } from "../src/ai/provider.js";
import { loadConfig } from "../src/rules/config.js";
import { fixedClock, newId } from "../src/domain/util.js";
import { SalesService, type CoreContext } from "../src/index.js";
import type { CustomerAccount, Opportunity, User, UserRole } from "../src/domain/types.js";

export function makeService(
  llm: FakeLlmProvider, now = "2026-09-08T01:00:00Z", log?: CoreContext["log"],
): SalesService {
  const db = new NodeSqliteExecutor();
  migrate(db);
  const repo = new Repository(db);
  const ctx: CoreContext = { repo, llm, config: loadConfig(repo), clock: fixedClock(now), log };
  return new SalesService(ctx);
}

export function makeUser(repo: Repository, role: UserRole, overrides: Partial<User> = {}): User {
  const now = "2026-01-01T00:00:00.000Z";
  const user: User = {
    id: newId(), email: overrides.email ?? `${newId()}@example.com`,
    displayName: overrides.displayName ?? role, role,
    timezone: "Asia/Tokyo", active: true, createdAt: now, updatedAt: now, ...overrides,
  };
  repo.insertUser(user);
  return user;
}

export function makeAccount(repo: Repository, overrides: Partial<CustomerAccount> = {}): CustomerAccount {
  const now = "2026-01-01T00:00:00.000Z";
  const account: CustomerAccount = {
    id: newId(), displayName: "ABC株式会社", resolutionStatus: "MANUAL",
    createdAt: now, updatedAt: now, ...overrides,
  };
  repo.insertAccount(account);
  return account;
}

export function makeOpportunity(
  repo: Repository, accountId: string, ownerUserId: string, overrides: Partial<Opportunity> = {},
): Opportunity {
  const now = "2026-01-01T00:00:00.000Z";
  const opp: Opportunity = {
    id: newId(), accountId, title: "案件", ownerUserId, collaboratorUserIds: [],
    lifecycleState: "OPEN", operationalState: "UNKNOWN", riskLevel: "NONE", version: 1,
    createdAt: now, updatedAt: now, ...overrides,
  };
  repo.insertOpportunity(opp);
  return opp;
}

export interface ExtractionOverrides {
  accounts?: unknown[];
  persons?: unknown[];
  opportunity?: Record<string, unknown>;
  activity?: Record<string, unknown>;
  facts?: unknown[];
  decisions?: unknown[];
  unresolved?: string[];
  questions?: string[];
  objections?: string[];
  commitments?: unknown[];
  amounts?: unknown[];
  expected_close_date?: string | null;
  state?: Record<string, unknown>;
  next_actions?: unknown[];
  risk?: Record<string, unknown>;
  context?: Record<string, unknown>;
  not_sales_related?: boolean;
}

/** Builds a scripted extraction JSON object (snake_case, matches `ai/schema.ts`). */
export function extractionJson(o: ExtractionOverrides = {}): Record<string, unknown> {
  return {
    entities: {
      account_candidates: o.accounts ?? [],
      person_candidates: o.persons ?? [],
    },
    opportunity: { match: "NEW", title: null, existing_opportunity_id: null, confidence: 0.9, ...o.opportunity },
    activity: { type: "NOTE", occurred_at: null, summary: "テスト活動の要約", confidence: 0.9, ...o.activity },
    facts: o.facts ?? [],
    decisions: o.decisions ?? [],
    unresolved: o.unresolved ?? [],
    questions: o.questions ?? [],
    objections: o.objections ?? [],
    commitments: o.commitments ?? [],
    amounts: o.amounts ?? [],
    expected_close_date: o.expected_close_date ?? null,
    state: { operational_state: "UNKNOWN", lifecycle_state: "OPEN", reason: null, confidence: 0.9, ...o.state },
    next_actions: o.next_actions ?? [],
    risk: { level: "NONE", reason: null, confidence: 0.9, ...o.risk },
    context: { current_situation: "状況", latest_development: "進展", customer_intent: null, ...o.context },
    not_sales_related: o.not_sales_related ?? false,
  };
}
