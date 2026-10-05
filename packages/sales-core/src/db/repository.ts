/**
 * Repository layer (設計書 §49-4). Thin, explicit queries over `SqlExecutor`; no business rules
 * here — those live in `rules/` and `pipeline/`.
 */
import type {
  AIContextSnapshot, AIDecision, Activity, AuditLog, CalendarEventMirror, Commitment,
  CustomerAccount, CustomerPerson, ExternalIdentity, LifecycleState, NextAction, NextActionStatus,
  NotificationLog, Opportunity, OpportunityLineItem, Product, ReviewItem, ReviewStatus,
  SourceApplication, SourceDocument, User,
} from "../domain/types.js";
import { normalizeEmail, normalizeName } from "../domain/util.js";
import type { SqlExecutor, SqlValue } from "./sql.js";
import * as T from "./tables.js";

/**
 * The tables holding a tenant's business data, in foreign-key-safe deletion order (children first).
 * Everything not listed (users, external_identities, settings, products, audit_logs,
 * schema_migrations) is the tenant's setup and survives a reset.
 */
export const BUSINESS_DATA_TABLES = [
  "source_applications",
  "opportunity_line_items",
  "ai_context_snapshots",
  "ai_decisions",
  "review_items",
  "commitments",
  "next_actions",
  "activities",
  "calendar_event_mirrors",
  "notification_logs",
  "opportunities",
  "customer_persons",
  "customer_accounts",
  "source_documents",
] as const;

/** One table cleared by a tenant reset. */
export type BusinessDataTable = typeof BUSINESS_DATA_TABLES[number];

export class Repository {
  constructor(readonly db: SqlExecutor) {}

  transaction<R>(fn: () => R): R {
    return this.db.transaction(fn);
  }

  // ---- users / identities -------------------------------------------------------------------

  getUser(id: string): User | undefined {
    return T.users.get(this.db, id);
  }

  getUserByEmail(email: string): User | undefined {
    return T.users.select(this.db, "WHERE email = ?", normalizeEmail(email))[0];
  }

  listUsers(): User[] {
    return T.users.select(this.db, "ORDER BY display_name");
  }

  insertUser(user: User): void {
    T.users.insert(this.db, { ...user, email: normalizeEmail(user.email) });
  }

  updateUser(user: User): void {
    T.users.update(this.db, { ...user, email: normalizeEmail(user.email) });
  }

  getIdentity(provider: string, externalId: string): ExternalIdentity | undefined {
    return T.externalIdentities.select(
      this.db, "WHERE provider = ? AND external_id = ?", provider, externalId)[0];
  }

  insertIdentity(identity: ExternalIdentity): void {
    T.externalIdentities.insert(this.db, identity);
  }

  deleteIdentity(provider: string, externalId: string): void {
    this.db.run("DELETE FROM external_identities WHERE provider = ? AND external_id = ?",
      provider, externalId);
  }

  // ---- customers -------------------------------------------------------------------------------

  getAccount(id: string): CustomerAccount | undefined {
    return T.customerAccounts.get(this.db, id);
  }

  listAccounts(limit = 500): CustomerAccount[] {
    return T.customerAccounts.select(this.db, "ORDER BY display_name LIMIT ?", limit);
  }

  findAccountsByNormalizedName(name: string): CustomerAccount[] {
    return T.customerAccounts.select(this.db, "WHERE normalized_name = ?", normalizeName(name));
  }

  /**
   * Like findAccountsByNormalizedName, but falls back to recomputing normalizeName(displayName) in
   * JS for every account when the indexed lookup misses. Guards the 企業DB sync against accounts
   * whose stored normalized_name has drifted from their displayName (e.g. rows written before
   * normalization was applied consistently) -- without this, a sync would silently create a
   * duplicate account instead of matching the existing one.
   */
  findAccountsByComputedName(name: string): CustomerAccount[] {
    const exact = this.findAccountsByNormalizedName(name);
    if (exact.length > 0) return exact;
    const n = normalizeName(name);
    if (!n) return [];
    return this.listAccounts(5000).filter(a => normalizeName(a.displayName) === n);
  }

  /** Substring candidates in either direction, for the review options list. */
  findAccountCandidates(name: string, limit = 5): CustomerAccount[] {
    const n = normalizeName(name);
    if (!n) return [];
    return T.customerAccounts.select(
      this.db,
      "WHERE normalized_name LIKE ? OR ? LIKE '%' || normalized_name || '%' " +
      "ORDER BY length(normalized_name) LIMIT ?",
      `%${n}%`, n, limit);
  }

  findAccountByDomain(domain: string): CustomerAccount | undefined {
    return T.customerAccounts.select(this.db, "WHERE primary_domain = ?", domain.toLowerCase())[0];
  }

  findAccountByCorporateNumber(corporateNumber: string): CustomerAccount | undefined {
    return T.customerAccounts.select(this.db, "WHERE corporate_number = ?", corporateNumber)[0];
  }

  insertAccount(account: CustomerAccount): void {
    T.customerAccounts.insert(this.db, { ...account, normalizedName: normalizeName(account.displayName) });
  }

  // Always recomputed (never trusts a caller-supplied normalizedName) so a stored value can't drift
  // out of sync with displayName -- every write self-heals to the canonical form.
  updateAccount(account: CustomerAccount): void {
    T.customerAccounts.update(this.db, { ...account, normalizedName: normalizeName(account.displayName) });
  }

  deleteAccount(id: string): void {
    T.customerAccounts.delete(this.db, id);
  }

  getPerson(id: string): CustomerPerson | undefined {
    return T.customerPersons.get(this.db, id);
  }

  findPersonByEmail(email: string): CustomerPerson | undefined {
    return T.customerPersons.select(this.db, "WHERE email = ?", normalizeEmail(email))[0];
  }

  findPersonsByName(name: string, accountId?: string): CustomerPerson[] {
    const n = normalizeName(name);
    return accountId
      ? T.customerPersons.select(this.db, "WHERE normalized_name = ? AND account_id = ?", n, accountId)
      : T.customerPersons.select(this.db, "WHERE normalized_name = ?", n);
  }

  listPersonsForAccount(accountId: string): CustomerPerson[] {
    return T.customerPersons.select(this.db, "WHERE account_id = ? ORDER BY display_name", accountId);
  }

  insertPerson(person: CustomerPerson): void {
    T.customerPersons.insert(this.db, {
      ...person,
      normalizedName: normalizeName(person.displayName),
      email: person.email ? normalizeEmail(person.email) : undefined,
    });
  }

  updatePerson(person: CustomerPerson): void {
    T.customerPersons.update(this.db, {
      ...person,
      normalizedName: normalizeName(person.displayName),
      email: person.email ? normalizeEmail(person.email) : undefined,
    });
  }

  deletePerson(id: string): void {
    T.customerPersons.delete(this.db, id);
  }

  // ---- products -------------------------------------------------------------------------------

  getProduct(id: string): Product | undefined {
    return T.products.get(this.db, id);
  }

  listProducts(includeInactive: boolean): Product[] {
    return T.products.select(this.db,
      includeInactive ? "ORDER BY sort_order, name" : "WHERE active = 1 ORDER BY sort_order, name");
  }

  findProductByCode(code: string): Product | undefined {
    return T.products.select(this.db, "WHERE code = ? LIMIT 1", code)[0];
  }

  insertProduct(product: Product): void {
    T.products.insert(this.db, product);
  }

  updateProduct(product: Product): void {
    T.products.update(this.db, product);
  }

  // ---- line items -----------------------------------------------------------------------------

  listLineItems(opportunityId: string): OpportunityLineItem[] {
    return T.opportunityLineItems.select(this.db, "WHERE opportunity_id = ? ORDER BY sort_order, created_at", opportunityId);
  }

  /** Replace-all: the UI always sends the whole table, so no per-row diffing. */
  replaceLineItems(opportunityId: string, items: OpportunityLineItem[]): void {
    this.db.run("DELETE FROM opportunity_line_items WHERE opportunity_id = ?", opportunityId);
    for (const item of items) T.opportunityLineItems.insert(this.db, item);
  }

  countLineItems(opportunityId: string): number {
    return this.db.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM opportunity_line_items WHERE opportunity_id = ?", opportunityId)!.n;
  }

  // ---- opportunities ---------------------------------------------------------------------------

  getOpportunity(id: string): Opportunity | undefined {
    return T.opportunities.get(this.db, id);
  }

  insertOpportunity(opp: Opportunity): void {
    T.opportunities.insert(this.db, opp);
  }

  /**
   * Optimistic concurrency (NFR-05): the update only lands if the stored version equals the
   * caller's `expectedVersion`; the stored version is then bumped.
   */
  updateOpportunity(opp: Opportunity, expectedVersion: number): boolean {
    return this.db.transaction(() => {
      // Check-then-write inside a transaction: a bare post-write version comparison would
      // false-positive when the row's *current* version already equals expectedVersion + 1
      // (e.g. a second call with a now-stale expectedVersion right after a successful update),
      // because the WHERE clause matches zero rows yet the stored version happens to match
      // `next.version` anyway.
      const current = this.db.one<{ version: number }>(
        "SELECT version FROM opportunities WHERE id = ?", opp.id);
      if (!current || current.version !== expectedVersion) return false;
      const next = { ...opp, version: expectedVersion + 1 };
      const sets = T.opportunities.columns.filter(c => c.column !== "id").map(c => `${c.column} = ?`);
      const values = T.opportunities.toRow(next).slice(1);
      this.db.run(
        `UPDATE opportunities SET ${sets.join(", ")} WHERE id = ? AND version = ?`,
        ...values, next.id, expectedVersion);
      return true;
    });
  }

  deleteOpportunity(id: string): void {
    T.opportunities.delete(this.db, id);
  }

  listOpenOpportunitiesForAccount(accountId: string): Opportunity[] {
    return T.opportunities.select(this.db,
      "WHERE account_id = ? AND lifecycle_state IN ('OPEN','ON_HOLD') ORDER BY updated_at DESC",
      accountId);
  }

  /** Opportunities a user may see: owned, collaborating, or all for managers/admins. */
  listOpportunitiesVisibleTo(user: User, filter: OpportunityQuery = {}): Opportunity[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (user.role === "SALES") {
      where.push("(owner_user_id = ? OR collaborator_user_ids LIKE ?)");
      params.push(user.id, `%"${user.id}"%`);
    }
    if (filter.lifecycleStates?.length) {
      where.push(`lifecycle_state IN (${filter.lifecycleStates.map(() => "?").join(",")})`);
      params.push(...filter.lifecycleStates);
    }
    if (filter.ownerUserId) {
      where.push("owner_user_id = ?");
      params.push(filter.ownerUserId);
    }
    if (filter.accountId) {
      where.push("account_id = ?");
      params.push(filter.accountId);
    }
    if (filter.expectedAmountGte !== undefined) {
      where.push("expected_amount >= ?");
      params.push(filter.expectedAmountGte);
    }
    if (filter.notUpdatedSince) {
      where.push("COALESCE(last_meaningful_activity_at, updated_at) < ?");
      params.push(filter.notUpdatedSince);
    }
    const text = filter.text?.trim();
    if (text) {
      const pattern = `%${text.replace(/[\\%_]/g, c => `\\${c}`)}%`;
      where.push(
        "(title LIKE ? ESCAPE '\\' OR phase_label LIKE ? ESCAPE '\\'" +
        " OR account_id IN (SELECT id FROM customer_accounts WHERE display_name LIKE ? ESCAPE '\\')" +
        " OR EXISTS (SELECT 1 FROM json_each(COALESCE(contact_person_ids, '[]')) j" +
        "            JOIN customer_persons p ON p.id = j.value WHERE p.display_name LIKE ? ESCAPE '\\')" +
        " OR owner_user_id IN (SELECT id FROM users WHERE display_name LIKE ? ESCAPE '\\'))",
      );
      params.push(pattern, pattern, pattern, pattern, pattern);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return T.opportunities.select(this.db,
      `${clause} ORDER BY updated_at DESC LIMIT ?`, ...params, filter.limit ?? 200);
  }

  countOpportunitiesByState(): { lifecycleState: LifecycleState; count: number }[] {
    return this.db.all<{ lifecycle_state: LifecycleState; count: number }>(
      "SELECT lifecycle_state, COUNT(*) AS count FROM opportunities GROUP BY lifecycle_state")
      .map(r => ({ lifecycleState: r.lifecycle_state, count: r.count }));
  }

  /** Manager KPI tiles that are single-row aggregates -- plain SQL beats looping every row in JS. */
  managerKpiAggregates(closedFrom: string, closedTo: string, now: string): {
    expectedAmountTotal: number; wonThisMonth: number; wonAmountThisMonth: number; lostThisMonth: number;
    overdueActions: number; unresolvedCustomers: number;
  } {
    const amount = this.db.one<{ total: number }>(
      "SELECT COALESCE(SUM(expected_amount), 0) AS total FROM opportunities WHERE lifecycle_state = 'OPEN'")!;
    const won = this.db.one<{ count: number; amount: number }>(
      "SELECT COUNT(*) AS count, COALESCE(SUM(won_amount), 0) AS amount FROM opportunities " +
      "WHERE lifecycle_state = 'WON' AND closed_at >= ? AND closed_at < ?", closedFrom, closedTo)!;
    const lost = this.db.one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM opportunities WHERE lifecycle_state = 'LOST' AND closed_at >= ? AND closed_at < ?",
      closedFrom, closedTo)!;
    // Mirrors getToday's "sleeping" rule: a SNOOZED action with a future wake-up doesn't count.
    const overdue = this.db.one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM next_actions WHERE status IN ('OPEN','SNOOZED') " +
      "AND due_at IS NOT NULL AND due_at < ? " +
      "AND NOT (status = 'SNOOZED' AND snoozed_until IS NOT NULL AND snoozed_until > ?)", now, now)!;
    const unresolved = this.db.one<{ count: number }>(
      "SELECT COUNT(DISTINCT a.id) AS count FROM customer_accounts a " +
      "JOIN opportunities o ON o.account_id = a.id " +
      "WHERE a.resolution_status = 'UNRESOLVED' AND o.lifecycle_state = 'OPEN'")!;
    return {
      expectedAmountTotal: amount.total, wonThisMonth: won.count, wonAmountThisMonth: won.amount,
      lostThisMonth: lost.count, overdueActions: overdue.count, unresolvedCustomers: unresolved.count,
    };
  }

  /**
   * Per-rep table on the Team page: one GROUP BY per metric (never a JOIN across them, which would
   * multiply rows) merged by user id in JS. `now`/`stalledBefore`/`weekAgo` are ISO instants;
   * `closedFrom`/`closedTo` are the F1 reporting period (YYYY-MM-DD, [from, to)).
   */
  managerPerUserStats(now: string, stalledBefore: string, weekAgo: string, closedFrom: string, closedTo: string): Map<string, {
    openOpportunities: number; expectedAmountTotal: number; overdueActions: number;
    stalledOpportunities: number; openReviews: number; lastCaptureAt?: string; capturesLast7Days: number;
    wonCount: number; wonAmount: number;
  }> {
    type Stats = {
      openOpportunities: number; expectedAmountTotal: number; overdueActions: number;
      stalledOpportunities: number; openReviews: number; lastCaptureAt?: string; capturesLast7Days: number;
      wonCount: number; wonAmount: number;
    };
    const stats = new Map<string, Stats>();
    const ensure = (userId: string): Stats => {
      let s = stats.get(userId);
      if (!s) {
        s = { openOpportunities: 0, expectedAmountTotal: 0, overdueActions: 0, stalledOpportunities: 0,
          openReviews: 0, capturesLast7Days: 0, wonCount: 0, wonAmount: 0 };
        stats.set(userId, s);
      }
      return s;
    };

    for (const row of this.db.all<{ owner_user_id: string; count: number; total: number }>(
      "SELECT owner_user_id, COUNT(*) AS count, COALESCE(SUM(expected_amount), 0) AS total " +
      "FROM opportunities WHERE lifecycle_state = 'OPEN' GROUP BY owner_user_id")) {
      const s = ensure(row.owner_user_id);
      s.openOpportunities = row.count;
      s.expectedAmountTotal = row.total;
    }
    for (const row of this.db.all<{ owner_user_id: string; count: number }>(
      "SELECT owner_user_id, COUNT(*) AS count FROM opportunities WHERE lifecycle_state = 'OPEN' " +
      "AND COALESCE(last_meaningful_activity_at, updated_at) < ? GROUP BY owner_user_id", stalledBefore)) {
      ensure(row.owner_user_id).stalledOpportunities = row.count;
    }
    for (const row of this.db.all<{ assigned_user_id: string; count: number }>(
      "SELECT assigned_user_id, COUNT(*) AS count FROM next_actions " +
      "WHERE status IN ('OPEN','SNOOZED') AND due_at IS NOT NULL AND due_at < ? " +
      "AND NOT (status = 'SNOOZED' AND snoozed_until IS NOT NULL AND snoozed_until > ?) " +
      "GROUP BY assigned_user_id", now, now)) {
      ensure(row.assigned_user_id).overdueActions = row.count;
    }
    for (const row of this.db.all<{ assigned_user_id: string; count: number }>(
      "SELECT assigned_user_id, COUNT(*) AS count FROM review_items " +
      "WHERE status = 'OPEN' AND assigned_user_id IS NOT NULL GROUP BY assigned_user_id")) {
      ensure(row.assigned_user_id).openReviews = row.count;
    }
    for (const row of this.db.all<{ submitted_by_user_id: string; last_at: string; recent: number }>(
      "SELECT submitted_by_user_id, MAX(received_at) AS last_at, " +
      "SUM(CASE WHEN received_at >= ? THEN 1 ELSE 0 END) AS recent FROM source_documents " +
      "WHERE submitted_by_user_id IS NOT NULL GROUP BY submitted_by_user_id", weekAgo)) {
      const s = ensure(row.submitted_by_user_id);
      s.lastCaptureAt = row.last_at ?? undefined;
      s.capturesLast7Days = row.recent;
    }
    for (const row of this.db.all<{ owner_user_id: string; n: number; amount: number }>(
      "SELECT owner_user_id, COUNT(*) AS n, COALESCE(SUM(won_amount), 0) AS amount FROM opportunities " +
      "WHERE lifecycle_state = 'WON' AND closed_at >= ? AND closed_at < ? GROUP BY owner_user_id", closedFrom, closedTo)) {
      const s = ensure(row.owner_user_id);
      s.wonCount = row.n;
      s.wonAmount = row.amount;
    }
    return stats;
  }

  // ---- sources ---------------------------------------------------------------------------------

  getSource(id: string): SourceDocument | undefined {
    return T.sourceDocuments.get(this.db, id);
  }

  findSourceByHash(hash: string): SourceDocument | undefined {
    return T.sourceDocuments.select(this.db, "WHERE content_hash = ?", hash)[0];
  }

  insertSource(source: SourceDocument): void {
    T.sourceDocuments.insert(this.db, source);
  }

  updateSource(source: SourceDocument): void {
    T.sourceDocuments.update(this.db, source);
  }

  listRecentSources(userId: string | undefined, limit = 50): SourceDocument[] {
    return userId
      ? T.sourceDocuments.select(this.db,
          "WHERE submitted_by_user_id = ? ORDER BY received_at DESC LIMIT ?", userId, limit)
      : T.sourceDocuments.select(this.db, "ORDER BY received_at DESC LIMIT ?", limit);
  }

  /** Oldest first, so a backlog drains in submission order. Used by the alarm-driven queue. */
  listSourcesByStatus(status: SourceDocument["processingStatus"], limit = 20): SourceDocument[] {
    return T.sourceDocuments.select(this.db,
      "WHERE processing_status = ? ORDER BY received_at ASC LIMIT ?", status, limit);
  }

  // ---- activities / commitments / next actions -------------------------------------------------

  insertActivity(activity: Activity): void {
    T.activities.insert(this.db, activity);
  }

  getActivity(id: string): Activity | undefined {
    return T.activities.get(this.db, id);
  }

  deleteActivity(id: string): void {
    T.activities.delete(this.db, id);
  }

  listActivitiesForOpportunity(opportunityId: string, limit = 100): Activity[] {
    return T.activities.select(this.db,
      "WHERE opportunity_id = ? ORDER BY occurred_at DESC LIMIT ?", opportunityId, limit);
  }

  insertCommitment(c: Commitment): void {
    T.commitments.insert(this.db, c);
  }

  getCommitment(id: string): Commitment | undefined {
    return T.commitments.get(this.db, id);
  }

  updateCommitment(c: Commitment): void {
    T.commitments.update(this.db, c);
  }

  deleteCommitment(id: string): void {
    T.commitments.delete(this.db, id);
  }

  listCommitmentsForOpportunity(opportunityId: string, openOnly = false): Commitment[] {
    return T.commitments.select(this.db,
      `WHERE opportunity_id = ?${openOnly ? " AND status IN ('OPEN','OVERDUE')" : ""} ORDER BY due_at`,
      opportunityId);
  }

  getNextAction(id: string): NextAction | undefined {
    return T.nextActions.get(this.db, id);
  }

  insertNextAction(a: NextAction): void {
    T.nextActions.insert(this.db, a);
  }

  updateNextAction(a: NextAction): void {
    T.nextActions.update(this.db, a);
  }

  deleteNextAction(id: string): void {
    T.nextActions.delete(this.db, id);
  }

  listNextActionsForOpportunity(opportunityId: string, statuses?: NextActionStatus[]): NextAction[] {
    if (statuses?.length) {
      return T.nextActions.select(this.db,
        `WHERE opportunity_id = ? AND status IN (${statuses.map(() => "?").join(",")}) ` +
        "ORDER BY COALESCE(due_at, '9999') , created_at", opportunityId, ...statuses);
    }
    return T.nextActions.select(this.db,
      "WHERE opportunity_id = ? ORDER BY COALESCE(due_at, '9999'), created_at", opportunityId);
  }

  listOpenNextActionsForUser(userId: string, limit = 200): NextAction[] {
    return T.nextActions.select(this.db,
      "WHERE assigned_user_id = ? AND status IN ('OPEN','SNOOZED') " +
      "ORDER BY COALESCE(due_at, '9999'), priority, created_at LIMIT ?", userId, limit);
  }

  listOpenNextActions(limit = 500): NextAction[] {
    return T.nextActions.select(this.db,
      "WHERE status IN ('OPEN','SNOOZED') ORDER BY COALESCE(due_at, '9999'), created_at LIMIT ?",
      limit);
  }

  // ---- AI artefacts ----------------------------------------------------------------------------

  insertSnapshot(s: AIContextSnapshot): void {
    T.aiContextSnapshots.insert(this.db, s);
  }

  deleteSnapshot(id: string): void {
    T.aiContextSnapshots.delete(this.db, id);
  }

  latestSnapshot(opportunityId: string): AIContextSnapshot | undefined {
    return T.aiContextSnapshots.select(this.db,
      "WHERE opportunity_id = ? ORDER BY created_at DESC LIMIT 1", opportunityId)[0];
  }

  insertDecision(d: AIDecision): void {
    T.aiDecisions.insert(this.db, d);
  }

  updateDecision(d: AIDecision): void {
    T.aiDecisions.update(this.db, d);
  }

  getDecision(id: string): AIDecision | undefined {
    return T.aiDecisions.get(this.db, id);
  }

  listDecisionsForSource(sourceId: string): AIDecision[] {
    return T.aiDecisions.select(this.db,
      "WHERE input_source_ids_json LIKE ? ORDER BY created_at", `%"${sourceId}"%`);
  }

  listDecisionsForEntity(entityType: string, entityId: string, limit = 50): AIDecision[] {
    return T.aiDecisions.select(this.db,
      "WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC LIMIT ?",
      entityType, entityId, limit);
  }

  // ---- reviews ---------------------------------------------------------------------------------

  insertReview(r: ReviewItem): void {
    T.reviewItems.insert(this.db, r);
  }

  updateReview(r: ReviewItem): void {
    T.reviewItems.update(this.db, r);
  }

  deleteReview(id: string): void {
    T.reviewItems.delete(this.db, id);
  }

  getReview(id: string): ReviewItem | undefined {
    return T.reviewItems.get(this.db, id);
  }

  listReviews(status: ReviewStatus, assignedUserId?: string, limit = 200): ReviewItem[] {
    return assignedUserId
      ? T.reviewItems.select(this.db,
          "WHERE status = ? AND assigned_user_id = ? ORDER BY created_at LIMIT ?",
          status, assignedUserId, limit)
      : T.reviewItems.select(this.db, "WHERE status = ? ORDER BY created_at LIMIT ?", status, limit);
  }

  listReviewsForSource(sourceId: string): ReviewItem[] {
    return T.reviewItems.select(this.db,
      "WHERE source_evidence_ids_json LIKE ? ORDER BY created_at", `%"${sourceId}"%`);
  }

  // ---- audit -----------------------------------------------------------------------------------

  insertAudit(a: AuditLog): void {
    T.auditLogs.insert(this.db, a);
  }

  listAuditForEntity(entityType: string, entityId: string, limit = 100): AuditLog[] {
    return T.auditLogs.select(this.db,
      "WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC LIMIT ?",
      entityType, entityId, limit);
  }

  listAudit(limit = 200): AuditLog[] {
    return T.auditLogs.select(this.db, "ORDER BY created_at DESC LIMIT ?", limit);
  }

  // ---- notifications (plans/sales-os-notify.md §2.4, 設計書 §20.2) -----------------------------

  insertNotificationLog(n: NotificationLog): void {
    T.notificationLogs.insert(this.db, n);
  }

  /**
   * The most recent SENT log matching this exact `messageHash`, if any. `messageHash` already
   * encodes the send-date and `notificationType` (see `buildMorningBrief`'s caller), so an exact
   * match is what "already sent today" means — this is what backs the dedup check before sending
   * and the idempotency guard against a scheduler retry reusing the same `runId`.
   */
  findSentNotification(userId: string, messageHash: string): NotificationLog | undefined {
    return T.notificationLogs.select(
      this.db,
      "WHERE user_id = ? AND message_hash = ? AND status = 'SENT' ORDER BY sent_at DESC LIMIT 1",
      userId, messageHash,
    )[0];
  }

  // ---- calendar (plans/sales-os-calendar.md §2.5, 設計書 §17) ------------------------------------

  findCalendarEvent(googleCalendarId: string, googleEventId: string): CalendarEventMirror | undefined {
    return T.calendarEventMirrors.select(
      this.db, "WHERE google_calendar_id = ? AND google_event_id = ?", googleCalendarId, googleEventId,
    )[0];
  }

  /**
   * Insert-or-replace keyed on (googleCalendarId, googleEventId), not `id` — Google's Calendar sync
   * (initial or incremental, §17.2-17.3) reports the same event id on every update, so this is what
   * "upsert the mirror row" means here; `e.id` is only used for a brand-new row.
   */
  upsertCalendarEvent(e: CalendarEventMirror): void {
    const existing = this.findCalendarEvent(e.googleCalendarId, e.googleEventId);
    if (existing) {
      T.calendarEventMirrors.update(this.db, { ...e, id: existing.id });
    } else {
      T.calendarEventMirrors.insert(this.db, e);
    }
  }

  /** Events for one owner whose start falls in `[fromIso, toIso)`, earliest first. */
  listCalendarEventsForOwner(ownerUserId: string, fromIso: string, toIso: string): CalendarEventMirror[] {
    return T.calendarEventMirrors.select(
      this.db, "WHERE owner_user_id = ? AND start_at >= ? AND start_at < ? ORDER BY start_at",
      ownerUserId, fromIso, toIso,
    );
  }

  // ---- source applications (undo) --------------------------------------------------------------

  getApplication(sourceId: string): SourceApplication | undefined {
    return T.sourceApplications.get(this.db, sourceId);
  }

  insertApplication(a: SourceApplication): void {
    T.sourceApplications.insert(this.db, a);
  }

  updateApplication(a: SourceApplication): void {
    T.sourceApplications.update(this.db, a);
  }

  // ---- bulk re-linking (review resolution) -----------------------------------------------------

  /** Moves every person / opportunity / activity from one account to another. */
  reassignAccount(fromAccountId: string, toAccountId: string): void {
    this.db.run("UPDATE customer_persons SET account_id = ? WHERE account_id = ?", toAccountId, fromAccountId);
    this.db.run("UPDATE opportunities SET account_id = ? WHERE account_id = ?", toAccountId, fromAccountId);
    this.db.run("UPDATE activities SET account_id = ? WHERE account_id = ?", toAccountId, fromAccountId);
  }

  /** Moves activities, commitments, next actions and snapshots between opportunities. */
  moveOpportunityContents(fromOpportunityId: string, toOpportunityId: string): void {
    for (const table of ["activities", "commitments", "next_actions", "ai_context_snapshots"]) {
      this.db.run(`UPDATE ${table} SET opportunity_id = ? WHERE opportunity_id = ?`,
        toOpportunityId, fromOpportunityId);
    }
    this.db.run("UPDATE source_applications SET opportunity_id = ? WHERE opportunity_id = ?",
      toOpportunityId, fromOpportunityId);
    this.db.run("UPDATE review_items SET related_entity_id = ? WHERE related_entity_type = 'opportunity' AND related_entity_id = ?",
      toOpportunityId, fromOpportunityId);
  }

  listSourcesForOpportunity(opportunityId: string): SourceDocument[] {
    return T.sourceDocuments.select(this.db,
      "WHERE id IN (SELECT source_id FROM activities WHERE opportunity_id = ?) ORDER BY received_at DESC",
      opportunityId);
  }

  listOverdueCommitments(before: string, limit = 200): Commitment[] {
    return T.commitments.select(this.db,
      "WHERE status IN ('OPEN','OVERDUE') AND due_at IS NOT NULL AND due_at < ? ORDER BY due_at LIMIT ?",
      before, limit);
  }

  // ---- whole-tenant export / reset (admin migration tools) -------------------------------------
  // Unbounded on purpose: an export that silently truncated at a list limit would be a lossy backup.

  listAllAccounts(): CustomerAccount[] {
    return T.customerAccounts.select(this.db, "ORDER BY created_at, id");
  }

  listAllPersons(): CustomerPerson[] {
    return T.customerPersons.select(this.db, "ORDER BY created_at, id");
  }

  listAllSources(): SourceDocument[] {
    return T.sourceDocuments.select(this.db, "ORDER BY received_at, id");
  }

  listAllOpportunities(): Opportunity[] {
    return T.opportunities.select(this.db, "ORDER BY created_at, id");
  }

  listAllActivities(): Activity[] {
    return T.activities.select(this.db, "ORDER BY created_at, id");
  }

  listAllNextActions(): NextAction[] {
    return T.nextActions.select(this.db, "ORDER BY created_at, id");
  }

  listAllCommitments(): Commitment[] {
    return T.commitments.select(this.db, "ORDER BY created_at, id");
  }

  /**
   * Deletes every row of every `BUSINESS_DATA_TABLES` table (children before parents, so foreign
   * keys hold at each step) and returns how many rows each held. Callers wrap this in a transaction.
   */
  clearBusinessData(): { table: BusinessDataTable; count: number }[] {
    return BUSINESS_DATA_TABLES.map(table => {
      const count = Number(this.db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0);
      this.db.run(`DELETE FROM ${table}`);
      return { table, count };
    });
  }

  // ---- settings --------------------------------------------------------------------------------

  getSetting<V>(key: string): V | undefined {
    const row = this.db.one<{ value_json: string }>(
      "SELECT value_json FROM settings WHERE key = ?", key);
    return row ? JSON.parse(row.value_json) as V : undefined;
  }

  listSettings(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const row of this.db.all<{ key: string; value_json: string }>(
      "SELECT key, value_json FROM settings")) {
      out[row.key] = JSON.parse(row.value_json);
    }
    return out;
  }

  putSetting(key: string, value: unknown, updatedAt: string): void {
    this.db.run(
      "INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
      key, JSON.stringify(value), updatedAt);
  }
}

export interface OpportunityQuery {
  lifecycleStates?: LifecycleState[];
  ownerUserId?: string;
  accountId?: string;
  expectedAmountGte?: number;
  /** ISO instant; returns opportunities whose last meaningful activity is older. */
  notUpdatedSince?: string;
  /** Substring of the title, phase, customer name, the deal's contacts (窓口) or the owner's name. */
  text?: string;
  limit?: number;
}
