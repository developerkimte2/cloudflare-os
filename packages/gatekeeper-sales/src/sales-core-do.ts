/**
 * The Sales Context Core for one tenant: a SQLite-backed Durable Object that owns the database and
 * runs `@gadgets/sales-core`'s `SalesService`. This is the *only* place sales data lives; the
 * gatekeeper facets and the management UI are thin adapters over its RPC surface (計画書 §3).
 *
 * Identity: callers are Cloudflare OS auto-provisioned accounts (`accountId`), bound to Sales OS
 * users through `external_identities(provider = "cfos")`.
 */
import { DurableObject } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { createLogger } from "@gadgets/backend-utils/logger";
import {
  DurableObjectSqlExecutor, Repository, SalesService, loadConfig, migrate, systemClock,
  type AIContextSnapshot, type Actor, type AnswerResult, type AuditLog, type CaptureOptions,
  type CaptureResult, type Commitment, type ConfigDto, type CoreContext, type ManagerSummary,
  type NextAction, type NextActionFilter, type NextActionInput, type NextActionPatch,
  type OpportunityDetail, type OpportunityFilter, type OpportunityPatch, type OpportunitySummary,
  type RegisterIdentityInput, type ReviewDto, type ReviewResolution, type SalesConfig,
  type SourceDocument, type TodayView, type UserDto, toUserDto,
} from "@gadgets/sales-core";
import { buildLlm, describeAi } from "./llm.js";
import type { WhoAmI } from "./management-types.js";
import { describeSlack, postToSlack } from "./slack.js";

export const IDENTITY_PROVIDER = "cfos";
export const VENDOR_ID = "sales";

type SalesLogFields = {
  event: string;
  vendorId?: string;
  tenant?: string;
  sourceId?: string;
  status?: string;
  reviews?: number;
  repairs?: number;
  kind?: string;
  error?: unknown;
  sourceType?: string;
};

const logger = createLogger<SalesLogFields>({ component: "gatekeeper.sales.core", vendorId: VENDOR_ID });

/** The calling account, as the DO sees it. */
export type Caller = { accountId: string; isAdmin?: boolean };

/**
 * The DO's RPC surface as plain async methods, derived from the class itself. Adapters call the
 * stub through this view: the DTOs carry recursive JSON columns, and letting TypeScript expand them
 * through `DurableObjectStub`'s serializability mapping hits its instantiation-depth limit.
 */
export type SalesCoreApi = {
  [K in keyof SalesCoreDurableObject as SalesCoreDurableObject[K] extends (...args: never[]) => Promise<unknown>
    ? K : never]: SalesCoreDurableObject[K];
};

@validateRpc()
export class SalesCoreDurableObject extends DurableObject<Cloudflare.Env> {
  readonly #service: SalesService;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    const db = new DurableObjectSqlExecutor(ctx.storage);
    // DO SQLite is synchronous, so the schema is guaranteed before the first request runs.
    const applied = migrate(db);
    if (applied.length) logger.info("schema migrated", { event: "core.migrated", tenant: ctx.id.name ?? undefined });
    const repo = new Repository(db);
    const core: CoreContext = {
      repo, llm: buildLlm(env), config: loadConfig(repo), clock: systemClock,
      log: (event, fields) => logger.info(event, { event, ...(fields as Partial<SalesLogFields>) }),
    };
    this.#service = new SalesService(core);
  }

  // ---- identity ---------------------------------------------------------------------------------

  async whoAmI(caller: Caller): Promise<WhoAmI> {
    const user = this.#service.resolveIdentity(IDENTITY_PROVIDER, caller.accountId);
    return {
      user: user ? toUserDto(user) : undefined,
      isAdmin: caller.isAdmin === true,
      firstUser: this.#service.repo.listUsers().length === 0,
      ai: describeAi(this.env),
      slack: describeSlack(this.env),
    };
  }

  /** ADMIN only. See `SalesManagementApi.sendSlackTest`. */
  async sendSlackTest(caller: Caller): Promise<void> {
    if (!caller.isAdmin) throw new Error("Slack のテスト送信は管理者のみ実行できます");
    await postToSlack(this.env, "Sales OS からのテスト通知です。この文言が届けば連携は正常です。");
  }

  async register(caller: Caller, input: RegisterIdentityInput): Promise<UserDto> {
    const user = this.#service.registerIdentity(
      IDENTITY_PROVIDER, caller.accountId, input, { isAdmin: caller.isAdmin === true });
    return toUserDto(user);
  }

  /** Drops the account ↔ user binding (called when the Workshop revokes the account). */
  async unbind(caller: Caller): Promise<void> {
    this.#service.repo.deleteIdentity(IDENTITY_PROVIDER, caller.accountId);
  }

  // ---- delegated API ------------------------------------------------------------------------------

  async getToday(caller: Caller): Promise<TodayView> {
    return this.#service.getToday(this.#actor(caller));
  }

  async capture(caller: Caller, text: string, options?: CaptureOptions): Promise<CaptureResult> {
    return this.#service.capture(this.#actor(caller), text, options ?? {});
  }

  async askQuestion(caller: Caller, question: string): Promise<AnswerResult> {
    return this.#service.askQuestion(this.#actor(caller), question);
  }

  /** Stores the raw text without processing (used by the approval flow). */
  async receive(caller: Caller, text: string, options?: CaptureOptions): Promise<{ sourceId: string; duplicate: boolean }> {
    return this.#service.receive(this.#actor(caller), text, options ?? {});
  }

  /** Processes a RECEIVED/FAILED source (used by the approval flow and retries). */
  async process(caller: Caller, sourceId: string): Promise<CaptureResult> {
    return this.#service.retryCapture(this.#actor(caller), sourceId);
  }

  /** Discards a RECEIVED source that was never processed (approval rejected). */
  async discard(caller: Caller, sourceId: string): Promise<void> {
    this.#service.discardReceived(this.#actor(caller), sourceId);
  }

  async getCapture(caller: Caller, sourceId: string): Promise<CaptureResult> {
    return this.#service.getCapture(this.#actor(caller), sourceId);
  }

  async listCaptures(caller: Caller, limit?: number): Promise<SourceDocument[]> {
    return this.#service.listCaptures(this.#actor(caller), limit);
  }

  async retryCapture(caller: Caller, sourceId: string): Promise<CaptureResult> {
    return this.#service.retryCapture(this.#actor(caller), sourceId);
  }

  async revertCapture(caller: Caller, sourceId: string): Promise<void> {
    this.#service.revertCapture(this.#actor(caller), sourceId);
  }

  async listOpportunities(caller: Caller, filter?: OpportunityFilter): Promise<OpportunitySummary[]> {
    return this.#service.listOpportunities(this.#actor(caller), filter ?? {});
  }

  async getOpportunity(caller: Caller, id: string): Promise<OpportunityDetail> {
    return this.#service.getOpportunity(this.#actor(caller), id);
  }

  async updateOpportunity(caller: Caller, id: string, patch: OpportunityPatch): Promise<OpportunitySummary> {
    return this.#service.updateOpportunity(this.#actor(caller), id, patch);
  }

  async recomputeContext(caller: Caller, id: string): Promise<AIContextSnapshot> {
    return this.#service.recompute(this.#actor(caller), id);
  }

  async listNextActions(caller: Caller, filter?: NextActionFilter): Promise<NextAction[]> {
    return this.#service.listNextActions(this.#actor(caller), filter ?? {});
  }

  async createNextAction(caller: Caller, input: NextActionInput): Promise<NextAction> {
    return this.#service.createNextAction(this.#actor(caller), input);
  }

  async updateNextAction(caller: Caller, id: string, patch: NextActionPatch): Promise<NextAction> {
    return this.#service.updateNextAction(this.#actor(caller), id, patch);
  }

  async updateCommitment(
    caller: Caller, id: string, patch: { status?: Commitment["status"]; dueAt?: string | null },
  ): Promise<Commitment> {
    return this.#service.updateCommitment(this.#actor(caller), id, patch);
  }

  async listReviews(caller: Caller): Promise<ReviewDto[]> {
    return this.#service.listReviews(this.#actor(caller));
  }

  async resolveReview(caller: Caller, id: string, resolution: ReviewResolution): Promise<ReviewDto> {
    return this.#service.resolveReview(this.#actor(caller), id, resolution);
  }

  async dismissReview(caller: Caller, id: string): Promise<ReviewDto> {
    return this.#service.dismissReview(this.#actor(caller), id);
  }

  async getManagerSummary(caller: Caller): Promise<ManagerSummary> {
    return this.#service.getManagerSummary(this.#actor(caller));
  }

  async listUsers(caller: Caller): Promise<UserDto[]> {
    return this.#service.listUsers(this.#actor(caller));
  }

  async updateUser(
    caller: Caller, userId: string,
    patch: Partial<Pick<UserDto, "displayName" | "role" | "managerUserId" | "timezone" | "active">>,
  ): Promise<UserDto> {
    return this.#service.updateUser(this.#actor(caller), userId, patch);
  }

  async getConfig(caller: Caller): Promise<ConfigDto> {
    return this.#service.getConfig(this.#actor(caller));
  }

  async updateConfig(caller: Caller, patch: Partial<SalesConfig>): Promise<ConfigDto> {
    return this.#service.updateConfig(this.#actor(caller), patch);
  }

  async listAudit(caller: Caller, entityType?: string, entityId?: string, limit?: number): Promise<AuditLog[]> {
    return this.#service.listAudit(this.#actor(caller), entityType, entityId, limit);
  }

  #actor(caller: Caller): Actor {
    const user = this.#service.resolveIdentity(IDENTITY_PROVIDER, caller.accountId);
    if (!user) {
      throw new Error(
        "Sales OS にまだ登録されていません。サイドバーの「Sales OS」を開いて登録してください。");
    }
    return { userId: user.id };
  }
}
