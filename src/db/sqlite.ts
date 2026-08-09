import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  AggregateBucket,
  AggregateQuery,
  LogCursor,
  LogFilters,
  LogQueryResult,
  LogRecord,
} from "../domain/log";
import type { LogStore } from "./store";

/** The small portion of better-sqlite3 used by this adapter. */
export interface SqliteStatementLike {
  all<T extends Record<string, unknown> = Record<string, unknown>>(...parameters: unknown[]): T[];
  get<T extends Record<string, unknown> = Record<string, unknown>>(...parameters: unknown[]): T | undefined;
  run(...parameters: unknown[]): { changes: number };
}

export interface SqliteDatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementLike;
  transaction<T>(callback: () => T): () => T;
  function(
    name: string,
    options: { deterministic?: boolean },
    implementation: (value: string) => string,
  ): void;
  pragma(sql: string, options?: { simple?: boolean }): unknown;
  close(): void;
}

export interface SqliteLogStoreOptions {
  database?: SqliteDatabaseLike;
  migrationDirectory?: string;
  /** better-sqlite3 constructor options, for example `{ readonly: true }`. */
  databaseOptions?: Record<string, unknown>;
}

interface BetterSqlite3Constructor {
  new (filename: string, options?: Record<string, unknown>): SqliteDatabaseLike;
}

interface BetterSqlite3Module {
  default?: BetterSqlite3Constructor;
}

const loadBetterSqlite3 = (): BetterSqlite3Constructor => {
  const moduleValue = createRequire(__filename)("better-sqlite3") as BetterSqlite3Constructor | BetterSqlite3Module;
  if (typeof moduleValue === "function") {
    return moduleValue;
  }
  if (moduleValue.default !== undefined) {
    return moduleValue.default;
  }
  throw new Error("better-sqlite3 did not expose a database constructor");
};

const defaultMigrationDirectory = (): string => {
  const candidates = [
    resolve(process.cwd(), "migrations/sqlite"),
    resolve(process.cwd(), "src/db/migrations/sqlite"),
    resolve(dirname(__filename), "migrations/sqlite"),
    resolve(dirname(__filename), "../../migrations/sqlite"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
};

const asIsoString = (value: unknown): string => {
  const text = value instanceof Date ? value.toISOString() : String(value);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("database returned an invalid timestamp");
  }
  return parsed.toISOString();
};

const parseAttributes = (value: unknown): Record<string, string | number | boolean> => {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("database returned invalid attributes JSON");
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("database returned non-object attributes");
  }

  const attributes: Record<string, string | number | boolean> = {};
  for (const [key, attribute] of Object.entries(parsed)) {
    if (typeof attribute === "string" || typeof attribute === "boolean") {
      attributes[key] = attribute;
    } else if (typeof attribute === "number" && Number.isFinite(attribute)) {
      attributes[key] = attribute;
    } else {
      throw new Error("database returned a non-scalar attribute");
    }
  }
  return attributes;
};

const mapLogRow = (row: Record<string, unknown>): LogRecord => ({
  id: String(row.id),
  timestamp: asIsoString(row.timestamp),
  level: row.level as LogRecord["level"],
  service: String(row.service),
  message: String(row.message),
  attributes: parseAttributes(row.attributes),
});

const mapAggregateRow = (row: Record<string, unknown>): AggregateBucket => ({
  start: asIsoString(row.start),
  group: row.group === null || row.group === undefined ? null : String(row.group),
  count: Number(row.count),
});

const escapeLikePattern = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");

// SQLite's built-in LOWER/NOCASE collations are ASCII-only. Registering the
// fold as a deterministic function keeps literal substring search Unicode
// aware without making the query depend on the host locale.
const foldMessage = (value: string): string => value.toLocaleLowerCase("und");

const normalisedAttributeValues = (attributes: LogRecord["attributes"]): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    result[key] = typeof value === "boolean" ? (value ? "true" : "false") : String(value);
  }
  return result;
};

interface SqliteWhere {
  text: string;
  values: unknown[];
}

const buildWhere = (filters: LogFilters): SqliteWhere => {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const add = (text: string, ...parameters: unknown[]): void => {
    clauses.push(text);
    values.push(...parameters);
  };

  if (filters.service !== undefined) {
    add('"service" = ?', filters.service);
  }
  if (filters.level !== undefined) {
    add('"level" = ?', filters.level);
  }
  if (filters.since !== undefined) {
    add('"timestamp" >= ?', filters.since);
  }
  if (filters.until !== undefined) {
    add('"timestamp" < ?', filters.until);
  }
  for (const [key, value] of Object.entries(filters.attributes ?? {})) {
    add(
      '(EXISTS (SELECT 1 FROM json_each("logs"."attribute_values") AS attribute WHERE attribute.key = ? AND attribute.value = ?))',
      key,
      value,
    );
  }
  if (filters.query !== undefined && filters.query.length > 0) {
    add('casefold("message") LIKE casefold(?) ESCAPE \'\\\'', `%${escapeLikePattern(filters.query)}%`);
  }

  return { text: clauses.length === 0 ? "1 = 1" : clauses.join(" AND "), values };
};

const bucketSeconds = (bucket: AggregateQuery["bucket"]): number => {
  switch (bucket) {
    case "1m":
      return 60;
    case "5m":
      return 5 * 60;
    case "1h":
      return 60 * 60;
    case "1d":
      return 24 * 60 * 60;
    default:
      throw new Error("invalid aggregate bucket");
  }
};

const groupExpression = (groupBy: AggregateQuery["groupBy"]): string => {
  switch (groupBy) {
    case undefined:
      return "CAST(NULL AS TEXT)";
    case "service":
      return '"service"';
    case "level":
      return '"level"';
    default:
      throw new Error("invalid aggregate group");
  }
};

const sqlitePath = (value: string): string => {
  if (value === ":memory:") {
    return value;
  }
  if (value.startsWith("sqlite://") || value.startsWith("sqlite:")) {
    const url = new URL(value.replace(/^sqlite:/, "http:"));
    return decodeURIComponent(url.pathname);
  }
  if (value.startsWith("file:")) {
    return decodeURIComponent(new URL(value).pathname);
  }
  return value;
};

const openSqliteDatabase = (path: string, options: Record<string, unknown> | undefined): SqliteDatabaseLike => {
  if (path !== ":memory:" && !path.startsWith("file::memory:")) {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }
  return new (loadBetterSqlite3())(path, options);
};

/** SQLite implementation, intended for local development and lightweight deployments. */
export class SqliteLogStore implements LogStore {
  private readonly database: SqliteDatabaseLike;
  private readonly migrationDirectory: string;
  private readonly ownsDatabase: boolean;

  public constructor(databasePathOrOptions: string | SqliteLogStoreOptions = "data/logs.sqlite", options: SqliteLogStoreOptions = {}) {
    if (typeof databasePathOrOptions === "string") {
      this.database = options.database ?? openSqliteDatabase(sqlitePath(databasePathOrOptions), options.databaseOptions);
      this.migrationDirectory = options.migrationDirectory ?? defaultMigrationDirectory();
      this.ownsDatabase = options.database === undefined;
    } else {
      this.database = databasePathOrOptions.database ?? openSqliteDatabase("data/logs.sqlite", databasePathOrOptions.databaseOptions);
      this.migrationDirectory = databasePathOrOptions.migrationDirectory ?? defaultMigrationDirectory();
      this.ownsDatabase = databasePathOrOptions.database === undefined;
    }

    this.database.function("casefold", { deterministic: true }, foldMessage);

    if (this.ownsDatabase) {
      this.database.pragma("journal_mode = WAL");
      this.database.pragma("synchronous = NORMAL");
      this.database.pragma("foreign_keys = ON");
      this.database.pragma("busy_timeout = 5000");
    }
  }

  public async ping(): Promise<void> {
    this.database.prepare("SELECT 1 AS ok").get();
  }

  public async migrate(): Promise<void> {
    const files = (await readdir(this.migrationDirectory))
      .filter((file) => file.endsWith(".sql"))
      .sort((left, right) => left.localeCompare(right));
    if (files.length === 0) {
      throw new Error(`no migration files found in ${this.migrationDirectory}`);
    }

    const migrations = await Promise.all(files.map(async (file) => ({
      version: file.replace(/\.sql$/, ""),
      sql: await readFile(join(this.migrationDirectory, file), "utf8"),
    })));

    // BEGIN IMMEDIATE takes the write lock before reading schema_migrations,
    // so two API processes cannot both observe a migration as unapplied.
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS "schema_migrations" (
          "version" TEXT PRIMARY KEY,
          "applied_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        )
      `);
      const applied = new Set(
        this.database
          .prepare('SELECT "version" FROM "schema_migrations"')
          .all<{ version: string }>()
          .map((row) => row.version),
      );

      for (const migration of migrations) {
        if (applied.has(migration.version)) {
          continue;
        }
        this.database.exec(migration.sql);
        this.database.prepare('INSERT INTO "schema_migrations" ("version") VALUES (?)').run(migration.version);
        applied.add(migration.version);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original migration failure.
      }
      throw error;
    }
  }

  public async insertLogs(logs: readonly LogRecord[]): Promise<void> {
    if (logs.length === 0) {
      return;
    }
    const insert = this.database.prepare(`
      INSERT INTO "logs" ("id", "timestamp", "level", "service", "message", "attributes", "attribute_values")
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const write = this.database.transaction(() => {
      for (const log of logs) {
        insert.run(
          log.id,
          asIsoString(log.timestamp),
          log.level,
          log.service,
          log.message,
          JSON.stringify(log.attributes),
          JSON.stringify(normalisedAttributeValues(log.attributes)),
        );
      }
    });
    write();
  }

  public async queryLogs(filters: LogFilters, limit: number, cursor: LogCursor | null): Promise<LogQueryResult> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("limit must be a positive integer");
    }
    const where = buildWhere(filters);
    const cursorClause = cursor === null
      ? ""
      : " AND (\"timestamp\" < ? OR (\"timestamp\" = ? AND \"id\" < ?))";
    const values = cursor === null
      ? [...where.values, limit + 1]
      : [...where.values, cursor.timestamp, cursor.timestamp, cursor.id, limit + 1];
    const rows = this.database
      .prepare(`
        SELECT "id", "timestamp", "level", "service", "message", "attributes"
        FROM "logs"
        WHERE ${where.text}${cursorClause}
        ORDER BY "timestamp" DESC, "id" DESC
        LIMIT ?
      `)
      .all(...values)
      .map(mapLogRow);
    const hasMore = rows.length > limit;
    if (hasMore) {
      rows.pop();
    }
    const last = rows.at(-1);
    return {
      logs: rows,
      nextCursor: hasMore && last !== undefined ? { version: 1, timestamp: last.timestamp, id: last.id } : null,
    };
  }

  public async aggregateLogs(query: AggregateQuery): Promise<AggregateBucket[]> {
    const seconds = bucketSeconds(query.bucket);
    const where = buildWhere(query.filters);
    const group = groupExpression(query.groupBy);
    const rows = this.database
      .prepare(`
        WITH bucketed AS (
          SELECT
            strftime('%Y-%m-%dT%H:%M:%fZ',
              (CAST(unixepoch("timestamp") / ? AS INTEGER)
                - CASE WHEN unixepoch("timestamp") < 0 AND unixepoch("timestamp") % ? <> 0 THEN 1 ELSE 0 END) * ?,
              'unixepoch') AS "start",
            ${group} AS "group"
          FROM "logs"
          WHERE ${where.text}
        )
        SELECT "start", "group", COUNT(*) AS "count"
        FROM bucketed
        GROUP BY "start", "group"
        ORDER BY "start" ASC, "group" ASC
      `)
      .all(seconds, seconds, seconds, ...where.values)
      .map(mapAggregateRow);
    return rows;
  }

  public async deleteBefore(cutoff: Date): Promise<number> {
    const result = this.database.prepare('DELETE FROM "logs" WHERE "timestamp" < ?').run(cutoff.toISOString());
    return result.changes;
  }

  public async configureRetention(_retentionDays: number): Promise<void> {
    // SQLite has no background TTL scheduler. RetentionWorker calls deleteBefore
    // out of band, which keeps this adapter's behavior deterministic.
  }

  public async close(): Promise<void> {
    if (this.ownsDatabase) {
      this.database.close();
    }
  }
}

// Keep the conventional acronym spelling available to callers while using a
// TypeScript-friendly class name internally.
export { SqliteLogStore as SQLiteLogStore };
