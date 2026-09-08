/**
 * Minimal SQL executor abstraction so the Sales Context Core can run on Durable Object SQLite today
 * and on D1 (or any SQLite dialect) later without touching the repository layer (設計書 §7.3, 計画書 §2).
 *
 * Only positional `?` bindings are used. Every adapter must map SQL NULL to `null`.
 */
export type SqlValue = string | number | null | Uint8Array;

export type Row = Record<string, SqlValue>;

export interface SqlExecutor {
  /** Runs a statement and returns all result rows. */
  all<T extends Row = Row>(sql: string, ...params: SqlValue[]): T[];
  /** Runs a statement, returning the first row or undefined. */
  one<T extends Row = Row>(sql: string, ...params: SqlValue[]): T | undefined;
  /** Runs a statement for its side effects. */
  run(sql: string, ...params: SqlValue[]): void;
  /** Runs `fn` atomically; nested calls are flattened into the outermost transaction. */
  transaction<T>(fn: () => T): T;
}

/** Adapter over a Durable Object's `ctx.storage.sql` + `ctx.storage.transactionSync`. */
export interface DurableStorageLike {
  sql: {
    exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
  };
  transactionSync<T>(closure: () => T): T;
}

export class DurableObjectSqlExecutor implements SqlExecutor {
  #depth = 0;
  constructor(private readonly storage: DurableStorageLike) {}

  all<T extends Row = Row>(sql: string, ...params: SqlValue[]): T[] {
    return this.storage.sql.exec(sql, ...params).toArray() as T[];
  }

  one<T extends Row = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.all<T>(sql, ...params)[0];
  }

  run(sql: string, ...params: SqlValue[]): void {
    this.storage.sql.exec(sql, ...params);
  }

  transaction<T>(fn: () => T): T {
    if (this.#depth > 0) return fn();
    this.#depth++;
    try {
      return this.storage.transactionSync(fn);
    } finally {
      this.#depth--;
    }
  }
}

/** Splits a multi-statement DDL script into individual statements (no string literals with `;`). */
export function splitStatements(script: string): string[] {
  return script
    .split(/;\s*(?:\n|$)/)
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith("--"));
}
