/**
 * Cloudflare OS adapter for Sales OS: an auto-provisioned (ambient) gatekeeper in the style of
 * gatekeeper-scheduler / gatekeeper-context.
 *
 *   GatekeeperVendor  → createAccount()            one SalesAccount per Workshop user (no OAuth)
 *   SalesAccount      → getSingletonGatekeeperClass  the SALES chat binding (SalesGatekeeper facet)
 *                     → startAppUi                   the management SPA (Today / 案件 / 確認 …)
 *   SalesGatekeeper   → startSession                 SalesSessionImpl: reads are observations,
 *                                                    writes are submitted actions (applied later)
 *
 * All data lives in SalesCoreDurableObject (one per tenant); nothing here stores sales data.
 */
import {
  DurableObject, RpcStub as NativeRpcStub, RpcTarget, WorkerEntrypoint,
} from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription, ActionKind, AgentCatalog, AppUiContext, ApprovalQueue, Gatekeeper,
  GatekeeperConnectCallback, GatekeeperConnectOptions, GatekeeperUiFrame, GatekeeperUser,
  GatekeeperUserVerifier, ObservationAuthorizer, ResourceConfiguratorFrame, ResourceDescription,
  SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type {
  AccountPatch, AIContextSnapshot, AnswerResult, AuditLog, CaptureOptions, CaptureResult, Commitment,
  ConfigDto, CustomerAccount, CustomerDetail, CustomerPerson, LineItemInput, ManagerSummary,
  ManagerSummaryQuery, NextAction,
  NextActionFilter,
  NextActionInput, NextActionPatch, OpportunityDetail, OpportunityFilter, OpportunityPatch,
  OpportunitySummary, PersonInput, PersonPatch, Product, ProductInput, ProductPatch,
  RegisterIdentityInput, ReviewDto, ReviewResolution,
  SalesConfig, SourceDocument, TodayView, UserDto,
} from "@gadgets/sales-core";
import type { SalesManagementApi, WhoAmI } from "./management-types.js";
import type { SalesSession } from "./types.js";
import { IDENTITY_PROVIDER, VENDOR_ID, type Caller, type SalesCoreApi } from "./sales-core-do.js";
import TYPES_CODE from "./types.txt";
import APP_HTML from "./generated/app.txt";

const SALES_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
        "<path d='M224 200h-8V40a8 8 0 0 0-8-8h-48a8 8 0 0 0-8 8v40h-40a8 8 0 0 0-8 8v40H64a8 8 0 0 0-8 8v64h-8a8 8 0 0 0 0 16h176a8 8 0 0 0 0-16ZM168 48h32v152h-32Zm-56 48h40v104h-40Zm-40 48h24v56H72Z'/></svg>",
    ),
};

const DEFAULT_TENANT = "default";

type AccountProps = { accountId: string; tenant: string };

function tenantOf(env: Cloudflare.Env): string {
  return env.SALES_TENANT?.trim() || DEFAULT_TENANT;
}

function core(exports: Cloudflare.Exports, tenant: string): SalesCoreApi {
  // See SalesCoreApi: the stub's methods are exactly the DO's async methods.
  return exports.SalesCoreDurableObject.getByName(tenant) as unknown as SalesCoreApi;
}

// ---------------------------------------------------------------------------------------------
// Pending actions (writes the agent submits; applied only after the Workshop approves them)

type PendingAction =
  | { kind: "capture"; sourceId: string }
  | { kind: "updateNextAction"; id: string; patch: NextActionPatch }
  | { kind: "createNextAction"; input: NextActionInput }
  | { kind: "updateCommitment"; id: string; patch: { status?: Commitment["status"]; dueAt?: string | null } }
  | { kind: "updateOpportunity"; id: string; patch: OpportunityPatch }
  | { kind: "resolveReview"; id: string; resolution: ReviewResolution }
  | { kind: "dismissReview"; id: string }
  | { kind: "recompute"; opportunityId: string }
  | { kind: "revert"; sourceId: string };

const ACTION_KINDS = {
  capture: { tag: "sales.capture", label: "営業メモの取込" },
  edit: { tag: "sales.edit", label: "案件・次アクション・約束の更新" },
  review: { tag: "sales.review", label: "確認項目への回答" },
  recompute: { tag: "sales.recompute", label: "AI コンテキストの再計算" },
  revert: { tag: "sales.revert", label: "取込の取り消し" },
} as const satisfies Record<string, ActionKind>;

function excerpt(text: string, max = 160): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

// ---------------------------------------------------------------------------------------------
// Session — what the agent (and gadget code) sees as env.SALES

@validateRpc()
export class SalesSessionImpl extends RpcTarget implements SalesSession {
  readonly #queue: NativeRpcStub<ApprovalQueue>;
  readonly #core: SalesCoreApi;
  readonly #caller: Caller;
  readonly #stage: (action: PendingAction) => Promise<number>;
  readonly #discard: (actionId: number) => Promise<void>;

  constructor(deps: {
    queue: NativeRpcStub<ApprovalQueue>;
    core: SalesCoreApi;
    caller: Caller;
    stage: (action: PendingAction) => Promise<number>;
    discard: (actionId: number) => Promise<void>;
  }) {
    super();
    this.#queue = deps.queue;
    this.#core = deps.core;
    this.#caller = deps.caller;
    this.#stage = deps.stage;
    this.#discard = deps.discard;
  }

  [Symbol.dispose](): void {
    this.#queue[Symbol.dispose]?.();
  }

  // ---- reads (observations) ----

  async whoAmI() {
    const who = await this.#core.whoAmI(this.#caller);
    await this.#observe("Sales OS のユーザー情報を確認", "現在のユーザーの登録状況を読み取りました。");
    return who.user ?? null;
  }

  async getCapture(sourceId: string): Promise<CaptureResult> {
    const result = await this.#core.getCapture(this.#caller, sourceId);
    await this.#observe("取込結果を読み取り", `取込 ${sourceId} の処理結果 (${result.source.processingStatus}) を読み取りました。`);
    return result;
  }

  async getToday(): Promise<TodayView> {
    const today = await this.#core.getToday(this.#caller);
    await this.#observe("今日の営業状況を読み取り",
      `次アクション ${today.counts.openActions} 件、確認待ち ${today.counts.openReviews} 件、案件 ${today.counts.openOpportunities} 件を読み取りました。`);
    return today;
  }

  async listOpportunities(filter?: OpportunityFilter): Promise<OpportunitySummary[]> {
    const list = await this.#core.listOpportunities(this.#caller, filter);
    await this.#observe("案件一覧を読み取り", `${list.length} 件の案件を読み取りました。`);
    return list;
  }

  async getOpportunity(opportunityId: string): Promise<OpportunityDetail> {
    const detail = await this.#core.getOpportunity(this.#caller, opportunityId);
    await this.#observe("案件の詳細を読み取り", `案件「${detail.title}」(${detail.accountName}) の詳細を読み取りました。`);
    return detail;
  }

  async listNextActions(filter?: NextActionFilter): Promise<NextAction[]> {
    const list = await this.#core.listNextActions(this.#caller, filter);
    await this.#observe("次アクション一覧を読み取り", `${list.length} 件の次アクションを読み取りました。`);
    return list;
  }

  async listReviews(): Promise<ReviewDto[]> {
    const list = await this.#core.listReviews(this.#caller);
    await this.#observe("確認項目を読み取り", `${list.length} 件の確認項目を読み取りました。`);
    return list;
  }

  async getManagerSummary(): Promise<ManagerSummary> {
    const summary = await this.#core.getManagerSummary(this.#caller);
    await this.#observe("チーム状況を読み取り",
      `停滞 ${summary.stalled.length} 件、高リスク ${summary.highRisk.length} 件、契約手続き中 ${summary.contracting.length} 件を読み取りました。`);
    return summary;
  }

  async listUsers(): Promise<UserDto[]> {
    const users = await this.#core.listUsers(this.#caller);
    await this.#observe("チームメンバーを読み取り", `${users.length} 名のユーザーを読み取りました。`);
    return users;
  }

  // ---- writes (actions) ----

  async capture(text: string, options?: CaptureOptions): Promise<CaptureResult> {
    if (typeof text !== "string" || !text.trim()) throw new TypeError("capture: text is required");
    const { sourceId, duplicate } = await this.#core.receive(this.#caller, text, options);
    const current = await this.#core.getCapture(this.#caller, sourceId);
    if (duplicate || current.source.processingStatus !== "RECEIVED") {
      return { ...current, duplicate: true };
    }
    await this.#submit({ kind: "capture", sourceId }, {
      title: `営業メモを取り込む: ${excerpt(text, 60)}`,
      description: `以下のテキストを Sales OS に取り込み、AI が活動記録・約束・次アクション・案件状況を生成します。\n\n> ${excerpt(text, 800)}`,
      kind: ACTION_KINDS.capture, implementsRevert: true, autoApprovable: true,
    });
    return { ...current, duplicate: false };
  }

  async revertCapture(sourceId: string): Promise<void> {
    const current = await this.#core.getCapture(this.#caller, sourceId);
    await this.#submit({ kind: "revert", sourceId }, {
      title: "取込を取り消す",
      description: `取込 ${sourceId} (${excerpt(current.source.rawText ?? "", 120)}) が生成した活動記録・約束・次アクション・案件の変更を元に戻します。`,
      kind: ACTION_KINDS.revert, implementsRevert: false, autoApprovable: false,
    });
  }

  async updateOpportunity(opportunityId: string, patch: OpportunityPatch): Promise<OpportunitySummary> {
    const detail = await this.#core.getOpportunity(this.#caller, opportunityId);
    await this.#submit({ kind: "updateOpportunity", id: opportunityId, patch }, {
      title: `案件「${detail.title}」を更新`,
      description: `変更内容: \`${JSON.stringify(patch)}\``,
      kind: ACTION_KINDS.edit, implementsRevert: false,
      autoApprovable: patch.lifecycleState !== "WON" && patch.lifecycleState !== "LOST",
    });
    return { ...detail, ...projectOpportunityPatch(patch) };
  }

  async recomputeContext(opportunityId: string): Promise<AIContextSnapshot> {
    const detail = await this.#core.getOpportunity(this.#caller, opportunityId);
    await this.#submit({ kind: "recompute", opportunityId }, {
      title: `案件「${detail.title}」のコンテキストを再計算`,
      description: "活動記録から AI が現在状況・未決事項・推奨アクションを再生成します。",
      kind: ACTION_KINDS.recompute, implementsRevert: false, autoApprovable: true,
    });
    if (!detail.context) throw new Error("この案件にはまだコンテキストがありません。承認後に getOpportunity() で確認してください。");
    return detail.context;
  }

  async createNextAction(input: NextActionInput): Promise<NextAction> {
    const id = crypto.randomUUID();
    const detail = await this.#core.getOpportunity(this.#caller, input.opportunityId);
    const me = await this.#core.whoAmI(this.#caller);
    await this.#submit({ kind: "createNextAction", input: { ...input, id } }, {
      title: `次アクションを追加: ${input.title}`,
      description: `案件「${detail.title}」に次アクション「${input.title}」を追加します。${input.dueAt ? ` 期限: ${input.dueAt}` : ""}`,
      kind: ACTION_KINDS.edit, implementsRevert: false, autoApprovable: true,
    });
    const now = new Date().toISOString();
    return {
      id, opportunityId: input.opportunityId, assignedUserId: input.assignedUserId ?? me.user?.id ?? "",
      actionType: input.actionType ?? "OTHER", title: input.title, purpose: input.purpose ?? "",
      dueAt: input.dueAt ?? undefined, priority: input.priority ?? "NORMAL", status: "OPEN", generatedBy: "USER",
      createdAt: now, updatedAt: now,
    };
  }

  async updateNextAction(nextActionId: string, patch: NextActionPatch): Promise<NextAction> {
    const current = (await this.#core.listNextActions(this.#caller, { statuses: ["OPEN", "SNOOZED", "DONE", "CANCELLED"], limit: 500 }))
      .find(a => a.id === nextActionId);
    if (!current) throw new Error("次アクションが見つかりません");
    await this.#submit({ kind: "updateNextAction", id: nextActionId, patch }, {
      title: `次アクション「${current.title}」を更新`,
      description: `変更内容: \`${JSON.stringify(patch)}\``,
      kind: ACTION_KINDS.edit, implementsRevert: false, autoApprovable: true,
    });
    return { ...current, ...stripNulls(patch) };
  }

  async updateCommitment(commitmentId: string, patch: { status?: Commitment["status"]; dueAt?: string | null }): Promise<Commitment> {
    await this.#submit({ kind: "updateCommitment", id: commitmentId, patch }, {
      title: "約束を更新",
      description: `約束 ${commitmentId} を更新します: \`${JSON.stringify(patch)}\``,
      kind: ACTION_KINDS.edit, implementsRevert: false, autoApprovable: true,
    });
    return { id: commitmentId, ...stripNulls(patch) } as Commitment;
  }

  async resolveReview(reviewId: string, resolution: ReviewResolution): Promise<ReviewDto> {
    const review = (await this.#core.listReviews(this.#caller)).find(r => r.id === reviewId);
    if (!review) throw new Error("確認項目が見つかりません");
    const option = review.optionsJson?.find(o => o.id === resolution.optionId);
    if (!option) throw new TypeError(`不明な選択肢: ${resolution.optionId}`);
    await this.#submit({ kind: "resolveReview", id: reviewId, resolution }, {
      title: `確認項目に回答: ${option.label}`,
      description: `${review.question}\n\n→ **${option.label}**${resolution.input ? ` (${JSON.stringify(resolution.input)})` : ""}`,
      kind: ACTION_KINDS.review, implementsRevert: false,
      autoApprovable: review.type !== "STATE_AMBIGUOUS",
    });
    return { ...review, status: "RESOLVED" };
  }

  async dismissReview(reviewId: string): Promise<ReviewDto> {
    const review = (await this.#core.listReviews(this.#caller)).find(r => r.id === reviewId);
    if (!review) throw new Error("確認項目が見つかりません");
    await this.#submit({ kind: "dismissReview", id: reviewId }, {
      title: "確認項目を却下", description: review.question,
      kind: ACTION_KINDS.review, implementsRevert: false, autoApprovable: true,
    });
    return { ...review, status: "DISMISSED" };
  }

  // ---- helpers ----

  async #observe(title: string, description: string): Promise<void> {
    await this.#queue.authorizeObservation({ title, description });
  }

  async #submit(action: PendingAction, desc: {
    title: string; description: string; kind: ActionKind; implementsRevert: boolean; autoApprovable: boolean;
  }): Promise<void> {
    const actionId = await this.#stage(action);
    try {
      await this.#queue.submitAction(actionId, {
        title: desc.title,
        description: desc.description,
        implementsRevert: desc.implementsRevert,
        // Writes are not simulated: the agent must wait for the decision before reading again.
        awaitDecision: true,
        autoApprovable: desc.autoApprovable,
        actionKind: desc.kind,
      });
    } catch (err) {
      await this.#discard(actionId);
      if (action.kind === "capture") await this.#core.discard(this.#caller, action.sourceId).catch(() => {});
      throw err;
    }
  }
}

function projectOpportunityPatch(patch: OpportunityPatch): Partial<OpportunitySummary> {
  const out: Partial<OpportunitySummary> = {};
  if (patch.title !== undefined) out.title = patch.title;
  if (patch.phaseLabel !== undefined) out.phaseLabel = patch.phaseLabel ?? undefined;
  if (patch.expectedAmount !== undefined) out.expectedAmount = patch.expectedAmount ?? undefined;
  if (patch.currency !== undefined) out.currency = patch.currency;
  if (patch.expectedCloseDate !== undefined) out.expectedCloseDate = patch.expectedCloseDate ?? undefined;
  if (patch.lifecycleState !== undefined) out.lifecycleState = patch.lifecycleState;
  if (patch.ownerUserId !== undefined) out.ownerUserId = patch.ownerUserId;
  if (patch.collaboratorUserIds !== undefined) out.collaboratorUserIds = patch.collaboratorUserIds;
  return out;
}

function stripNulls<T extends object>(obj: T): { [K in keyof T]?: Exclude<T[K], null> } {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined).map(([k, v]) => [k, v === null ? undefined : v]),
  ) as { [K in keyof T]?: Exclude<T[K], null> };
}

// ---------------------------------------------------------------------------------------------
// Gatekeeper facet — the singleton installed into the account owner's workspaces

@validateRpc()
export class SalesGatekeeper
  extends DurableObject<Cloudflare.Env, AccountProps>
  implements Gatekeeper<SalesSession>
{
  async describe(): Promise<ResourceDescription> {
    return {
      url: "sales://os",
      title: "Sales OS",
      snippet: "営業案件・活動・約束・次アクションの記録と、自由文からの自動整理。",
      suggestedBindingName: "SALES",
      tsType: "SalesSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [ACTION_KINDS.capture, ACTION_KINDS.edit, ACTION_KINDS.review, ACTION_KINDS.recompute];
  }

  async startSession(approvalQueue: NativeRpcStub<ApprovalQueue>): Promise<SalesSession> {
    return new SalesSessionImpl({
      queue: approvalQueue.dup(),
      core: this.#core(),
      caller: this.#caller(),
      stage: async action => this.#stage(action),
      discard: async id => { this.ctx.storage.kv.delete(`action:${id}`); },
    });
  }

  async getAgentCatalog(_authorizer: NativeRpcStub<ObservationAuthorizer>): Promise<AgentCatalog | null> {
    return null;
  }

  /** Observers must be registered Sales OS users themselves; roles are enforced in the core. */
  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    const verifier = user as unknown as Fetcher<SalesVerifierApi>;
    const accountId = await verifier.accountId();
    const who = await this.#core().whoAmI({ accountId });
    if (!who.user) {
      throw new Error("このユーザーは Sales OS に登録されていないため、Sales OS のデータを含む共有を閲覧できません。");
    }
  }

  async removeObserver(_id: string): Promise<void> {}

  async applyAction(action: number): Promise<void> {
    const pending = this.ctx.storage.kv.get<PendingAction>(`action:${action}`);
    if (!pending) throw new Error(`Unknown pending Sales OS action ${action}`);
    const core = this.#core();
    const caller = this.#caller();
    switch (pending.kind) {
      case "capture":
        await core.process(caller, pending.sourceId);
        break;
      case "revert":
        await core.revertCapture(caller, pending.sourceId);
        break;
      case "updateOpportunity":
        await core.updateOpportunity(caller, pending.id, pending.patch);
        break;
      case "recompute":
        await core.recomputeContext(caller, pending.opportunityId);
        break;
      case "createNextAction":
        await core.createNextAction(caller, pending.input);
        break;
      case "updateNextAction":
        await core.updateNextAction(caller, pending.id, pending.patch);
        break;
      case "updateCommitment":
        await core.updateCommitment(caller, pending.id, pending.patch);
        break;
      case "resolveReview":
        await core.resolveReview(caller, pending.id, pending.resolution);
        break;
      case "dismissReview":
        await core.dismissReview(caller, pending.id);
        break;
    }
    this.ctx.storage.kv.put(`applied:${action}`, pending);
    this.ctx.storage.kv.delete(`action:${action}`);
  }

  async rejectAction(action: number): Promise<void> {
    const pending = this.ctx.storage.kv.get<PendingAction>(`action:${action}`);
    this.ctx.storage.kv.delete(`action:${action}`);
    if (pending?.kind === "capture") {
      await this.#core().discard(this.#caller(), pending.sourceId).catch(() => {});
    }
  }

  async revertAction(action: number): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    const applied = this.ctx.storage.kv.get<PendingAction>(`applied:${action}`);
    if (!applied || applied.kind !== "capture") {
      return { message: "この操作は自動では元に戻せません。Sales OS の画面から手動で修正してください。", canRetry: false };
    }
    await this.#core().revertCapture(this.#caller(), applied.sourceId);
    this.ctx.storage.kv.delete(`applied:${action}`);
  }

  #stage(action: PendingAction): number {
    const id = (this.ctx.storage.kv.get<number>("nextActionId") ?? 1);
    this.ctx.storage.kv.put("nextActionId", id + 1);
    this.ctx.storage.kv.put(`action:${id}`, action);
    return id;
  }

  #core() {
    return core(this.ctx.exports, this.ctx.props.tenant);
  }

  #caller(): Caller {
    return { accountId: this.ctx.props.accountId };
  }
}

// ---------------------------------------------------------------------------------------------
// Management UI API — direct, account-scoped; no approval queue (the user acts on their own data)

@validateRpc()
export class SalesManagementApiImpl extends RpcTarget implements SalesManagementApi {
  constructor(
    private readonly core: SalesCoreApi,
    private readonly caller: Caller,
  ) {
    super();
  }

  whoAmI(): Promise<WhoAmI> { return this.core.whoAmI(this.caller); }
  register(input: RegisterIdentityInput): Promise<UserDto> { return this.core.register(this.caller, input); }
  getToday(): Promise<TodayView> { return this.core.getToday(this.caller); }
  capture(text: string, options?: CaptureOptions): Promise<CaptureResult> { return this.core.capture(this.caller, text, options); }
  captureAsync(text: string, options?: CaptureOptions): Promise<{ sourceId: string; duplicate: boolean }> { return this.core.captureAsync(this.caller, text, options); }
  askQuestion(question: string): Promise<AnswerResult> { return this.core.askQuestion(this.caller, question); }
  transcribeAudio(audio: ArrayBuffer, mimeType: string): Promise<{ text: string; modelName: string }> {
    return this.core.transcribeAudio(this.caller, audio, mimeType);
  }
  getCapture(sourceId: string): Promise<CaptureResult> { return this.core.getCapture(this.caller, sourceId); }
  listCaptures(limit?: number): Promise<SourceDocument[]> { return this.core.listCaptures(this.caller, limit); }
  retryCapture(sourceId: string): Promise<CaptureResult> { return this.core.retryCapture(this.caller, sourceId); }
  revertCapture(sourceId: string): Promise<void> { return this.core.revertCapture(this.caller, sourceId); }
  listOpportunities(filter?: OpportunityFilter): Promise<OpportunitySummary[]> { return this.core.listOpportunities(this.caller, filter); }
  getOpportunity(id: string): Promise<OpportunityDetail> { return this.core.getOpportunity(this.caller, id); }
  updateOpportunity(id: string, patch: OpportunityPatch): Promise<OpportunitySummary> { return this.core.updateOpportunity(this.caller, id, patch); }
  recomputeContext(id: string): Promise<AIContextSnapshot> { return this.core.recomputeContext(this.caller, id); }
  updateAccount(accountId: string, patch: AccountPatch): Promise<CustomerAccount> { return this.core.updateAccount(this.caller, accountId, patch); }
  createPerson(accountId: string, input: PersonInput): Promise<CustomerPerson> { return this.core.createPerson(this.caller, accountId, input); }
  updatePerson(personId: string, patch: PersonPatch): Promise<CustomerPerson> { return this.core.updatePerson(this.caller, personId, patch); }
  listProducts(options?: { includeInactive?: boolean }): Promise<Product[]> { return this.core.listProducts(this.caller, options); }
  createProduct(input: ProductInput): Promise<Product> { return this.core.createProduct(this.caller, input); }
  updateProduct(id: string, patch: ProductPatch): Promise<Product> { return this.core.updateProduct(this.caller, id, patch); }
  setLineItems(opportunityId: string, items: LineItemInput[], version: number): Promise<OpportunityDetail> {
    return this.core.setLineItems(this.caller, opportunityId, items, version);
  }
  getCustomer(accountId: string): Promise<CustomerDetail> { return this.core.getCustomer(this.caller, accountId); }
  listNextActions(filter?: NextActionFilter): Promise<NextAction[]> { return this.core.listNextActions(this.caller, filter); }
  createNextAction(input: NextActionInput): Promise<NextAction> { return this.core.createNextAction(this.caller, input); }
  updateNextAction(id: string, patch: NextActionPatch): Promise<NextAction> { return this.core.updateNextAction(this.caller, id, patch); }
  adoptSuggestion(decisionId: string, index: number): Promise<NextAction> { return this.core.adoptSuggestion(this.caller, decisionId, index); }
  dismissSuggestion(decisionId: string, index: number): Promise<void> { return this.core.dismissSuggestion(this.caller, decisionId, index); }
  updateCommitment(id: string, patch: { status?: Commitment["status"]; dueAt?: string | null }): Promise<Commitment> { return this.core.updateCommitment(this.caller, id, patch); }
  listReviews(): Promise<ReviewDto[]> { return this.core.listReviews(this.caller); }
  resolveReview(id: string, resolution: ReviewResolution): Promise<ReviewDto> { return this.core.resolveReview(this.caller, id, resolution); }
  dismissReview(id: string): Promise<ReviewDto> { return this.core.dismissReview(this.caller, id); }
  getManagerSummary(query?: ManagerSummaryQuery): Promise<ManagerSummary> { return this.core.getManagerSummary(this.caller, query); }
  listUsers(): Promise<UserDto[]> { return this.core.listUsers(this.caller); }
  updateUser(userId: string, patch: Partial<Pick<UserDto, "displayName" | "role" | "managerUserId" | "timezone" | "active">>): Promise<UserDto> { return this.core.updateUser(this.caller, userId, patch); }
  getConfig(): Promise<ConfigDto> { return this.core.getConfig(this.caller); }
  updateConfig(patch: Partial<SalesConfig>): Promise<ConfigDto> { return this.core.updateConfig(this.caller, patch); }
  listAudit(entityType?: string, entityId?: string, limit?: number): Promise<AuditLog[]> { return this.core.listAudit(this.caller, entityType, entityId, limit); }
  sendSlackTest(): Promise<void> { return this.core.sendSlackTest(this.caller); }
  sendMorningBrief(): Promise<{ sent: boolean; recipientCount: number }> { return this.core.sendMorningBrief(this.caller); }
}

// ---------------------------------------------------------------------------------------------
// Account — one per Workshop user, minted by createAccount() with no identity attached

export function describeSalesAccount(): AccountDescription {
  return {
    displayName: "Sales OS",
    avatar: SALES_ICON,
    singleton: { tsType: "SalesSession" },
    providesUi: { title: "Sales OS", icon: SALES_ICON },
  };
}

@validateRpc()
export class SalesAccount extends WorkerEntrypoint<Cloudflare.Env, AccountProps> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return describeSalesAccount();
  }

  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<SalesSession>>> {
    return this.ctx.exports.SalesGatekeeper({ props: this.ctx.props });
  }

  async startAppUi(context: AppUiContext): Promise<GatekeeperUiFrame> {
    const api = new SalesManagementApiImpl(
      core(this.ctx.exports, this.ctx.props.tenant),
      { accountId: this.ctx.props.accountId, isAdmin: context.isAdmin },
    );
    return { iframeHtml: APP_HTML, ui: new NativeRpcStub(api) };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  getGatekeeperClassFor(_url: string): never {
    throw new Error("Sales OS has no URL-addressed resources.");
  }

  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("Sales OS has no URL-addressed resources.");
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  /** Disconnecting only drops the identity binding; the team's sales data is not the user's to delete. */
  async revoke(): Promise<void> {
    await core(this.ctx.exports, this.ctx.props.tenant).unbind({ accountId: this.ctx.props.accountId });
  }

  reconnect(): Promise<{ url: string }> {
    throw new Error("Sales OS has no connect flow.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.SalesVerifier({ props: this.ctx.props });
  }
}

export interface SalesVerifierApi extends GatekeeperUserVerifier {
  accountId(): Promise<string>;
}

@validateRpc()
export class SalesVerifier extends WorkerEntrypoint<Cloudflare.Env, AccountProps> implements SalesVerifierApi {
  async accountId(): Promise<string> {
    return this.ctx.props.accountId;
  }
}

// ---------------------------------------------------------------------------------------------
// Vendor

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Sales OS",
      url: "https://workers.cloudflare.com/",
      logo: SALES_ICON,
      tagline: "営業の記録・整理・報告を AI に任せる",
      description:
        "自由文・メール・議事録を投げ込むだけで、AI が案件状況・約束・次アクションを整理します。" +
        "エージェントからは SALES バインディングとして、画面からは「Sales OS」として使えます。",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.SalesAccount({
      props: { accountId: crypto.randomUUID(), tenant: tenantOf(this.env) },
    }) as unknown as Fetcher<GatekeeperUser>;
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("Sales OS is auto-provisioned and has no connect flow.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

export { IDENTITY_PROVIDER, VENDOR_ID };
