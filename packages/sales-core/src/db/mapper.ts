/**
 * Declarative table ↔ entity mapping. Each column declares its entity key and an optional codec
 * (JSON / boolean). Keeps the repository free of per-table boilerplate while staying explicit
 * about every column, which is what a reviewer wants to see for an audited data store.
 */
import type { Row, SqlExecutor, SqlValue } from "./sql.js";

export type Codec = "json" | "bool";

export interface ColumnSpec<T> {
  column: string;
  key: keyof T & string;
  codec?: Codec;
}

export class Table<T extends object> {
  readonly columns: ColumnSpec<T>[];
  readonly columnList: string;

  constructor(readonly name: string, readonly primaryKey: string, columns: ColumnSpec<T>[]) {
    this.columns = columns;
    this.columnList = columns.map(c => c.column).join(", ");
  }

  fromRow(row: Row): T {
    const entity: Record<string, unknown> = {};
    for (const spec of this.columns) {
      const raw = row[spec.column];
      if (raw === null || raw === undefined) {
        // Absent optional fields stay absent (not `null`) so JSON payloads stay tidy.
        if (spec.codec === "json") entity[spec.key] = undefined;
        continue;
      }
      switch (spec.codec) {
        case "json":
          entity[spec.key] = JSON.parse(String(raw));
          break;
        case "bool":
          entity[spec.key] = Number(raw) !== 0;
          break;
        default:
          entity[spec.key] = raw;
      }
    }
    return entity as T;
  }

  toRow(entity: T): SqlValue[] {
    return this.columns.map(spec => {
      const value = (entity as Record<string, unknown>)[spec.key];
      if (value === undefined || value === null) return null;
      switch (spec.codec) {
        case "json":
          return JSON.stringify(value);
        case "bool":
          return value ? 1 : 0;
        default:
          if (typeof value === "number" || typeof value === "string") return value;
          if (value instanceof Uint8Array) return value;
          throw new TypeError(`${this.name}.${spec.column}: unsupported value type ${typeof value}`);
      }
    });
  }

  insert(db: SqlExecutor, entity: T): void {
    const placeholders = this.columns.map(() => "?").join(", ");
    db.run(`INSERT INTO ${this.name} (${this.columnList}) VALUES (${placeholders})`,
      ...this.toRow(entity));
  }

  /** Full-row replace keyed on the primary key. */
  update(db: SqlExecutor, entity: T): void {
    const row = this.toRow(entity);
    const pkIndex = this.columns.findIndex(c => c.column === this.primaryKey);
    const sets: string[] = [];
    const values: SqlValue[] = [];
    this.columns.forEach((spec, i) => {
      if (i === pkIndex) return;
      sets.push(`${spec.column} = ?`);
      values.push(row[i]!);
    });
    db.run(`UPDATE ${this.name} SET ${sets.join(", ")} WHERE ${this.primaryKey} = ?`,
      ...values, row[pkIndex]!);
  }

  get(db: SqlExecutor, id: SqlValue): T | undefined {
    const row = db.one(`SELECT ${this.columnList} FROM ${this.name} WHERE ${this.primaryKey} = ?`, id);
    return row ? this.fromRow(row) : undefined;
  }

  select(db: SqlExecutor, where: string, ...params: SqlValue[]): T[] {
    return db.all(`SELECT ${this.columnList} FROM ${this.name} ${where}`, ...params)
      .map(r => this.fromRow(r));
  }

  delete(db: SqlExecutor, id: SqlValue): void {
    db.run(`DELETE FROM ${this.name} WHERE ${this.primaryKey} = ?`, id);
  }
}

/** Convenience for building specs: `col("display_name", "displayName")`. */
export function col<T>(column: string, key: keyof T & string, codec?: Codec): ColumnSpec<T> {
  return codec ? { column, key, codec } : { column, key };
}
