/**
 * Node `node:sqlite` adapter for tests, fixtures and the offline eval runner. Not imported by
 * Worker code (excluded from the package's main tsconfig; typed by tsconfig.test.json).
 */
import { DatabaseSync } from "node:sqlite";
import type { Row, SqlExecutor, SqlValue } from "./sql.js";

export class NodeSqliteExecutor implements SqlExecutor {
  readonly db: DatabaseSync;
  #depth = 0;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  all<T extends Row = Row>(sql: string, ...params: SqlValue[]): T[] {
    return this.db.prepare(sql).all(...params) as unknown as T[];
  }

  one<T extends Row = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as unknown as T | undefined;
  }

  run(sql: string, ...params: SqlValue[]): void {
    if (params.length === 0) {
      this.db.exec(sql);
    } else {
      this.db.prepare(sql).run(...params);
    }
  }

  transaction<T>(fn: () => T): T {
    if (this.#depth > 0) return fn();
    this.#depth++;
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.#depth--;
    }
  }

  close(): void {
    this.db.close();
  }
}
