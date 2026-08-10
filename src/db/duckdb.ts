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

export interface DuckDBResultLike {
  getRowObjectsJS(): Promise<Record<string, unknown>[]>;
}

export interface DuckDBPreparedStatementLike {
  bind(values: readonly unknown[]): void;
  run(): Promise<DuckDBResultLike>;
  destroySync(): void;
}

export interface DuckDBConnectionLike {
  run(sql: string, values?: readonly unknown[]): Promise<DuckDBResultLike>;
  prepare(sql: string): Promise<DuckDBPreparedStatementLike>;
  closeSync(): void;
}

export interface DuckDBInstanceLike {
  connect(): Promise<DuckDBConnectionLike>;
  closeSync(): void;
}

export interface DuckDBLogStoreOptions {
  path?: string;
  connection?: DuckDBConnectionLike;
  instance?: DuckDBInstanceLike;
  migrationDirectory?: string;
}

interface DuckDBFactory {
  DuckDBInstance: {
    create(path: string, options?: Record<string, string>): Promise<DuckDBInstanceLike>;
  };
}

const loadDuckDBFactory = (): DuckDBFactory => {
  const moduleValue = createRequire(__filename)("@duckdb/node-api") as DuckDBFactory;
  if (typeof moduleValue.DuckDBInstance?.create !== "function") {
    throw new Error("@duckdb/node-api did not expose DuckDBInstance.create");
  }
  return moduleValue;
};

const defaultMigrationDirectory = (): string => {
  const candidates = [
    resolve(process.cwd(), "migrations/duckdb"),
    resolve(process.cwd(), "src/db/migrations/duckdb"),
    resolve(dirname(__filename), "migrations/duckdb"),
    resolve(dirname(__filename), "../../migrations/duckdb"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
};

const databasePath = (value: string): string => {
  if (value === ":memory:") {
    return value;
  }
  if (value.startsWith("duckdb://") || value.startsWith("duckdb:")) {
    const url = new URL(value.replace(/^duckdb:/, "http:"));
    return decodeURIComponent(url.pathname);
  }
  return value;
};

const openPath = (value: string): string => {
  const path = databasePath(value);
  if (path !== ":memory:") {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }
  return path;
};

const asIsoString = (value: unknown): string => {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error("database returned an invalid timestamp");
  }
  return date.toISOString();
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

interface DuckDBWhere {
  text: string;
  values: unknown[];
  nextParameter: number;
}

const buildWhere = (filters: LogFilters, startParameter = 1): DuckDBWhere => {
  const clauses: string[] = [];
  const values: unknown[] = [];
  let nextParameter = startParameter;
  const add = (text: string, value: unknown): void => {
    clauses.push(text.replace("?", `$${nextParameter}`));
    values.push(value);
    nextParameter += 1;
  };

  if (filters.service !== undefined) {
    add('"service" = ?', filters.service);
  }
  if (filters.level !== undefined) {
    add('"level" = ?', filters.level);
  }
  if (filters.since !== undefined) {
    add('"timestamp" >= CAST(? AS TIMESTAMPTZ)', filters.since);
  }
  if (filters.until !== undefined) {
    add('"timestamp" < CAST(? AS TIMESTAMPTZ)', filters.until);
  }
  for (const [key, value] of Object.entries(filters.attributes ?? {})) {
    const keyParameter = nextParameter;
    const valueParameter = nextParameter + 1;
    clauses.push(`(EXISTS (SELECT 1 FROM json_each("logs"."attribute_values") AS attribute WHERE attribute.key = $${keyParameter} AND json_extract_string(attribute.value, '$') = $${valueParameter}))`);
    values.push(key, value);
    nextParameter += 2;
  }
  if (filters.query !== undefined && filters.query.length > 0) {
    add('contains(lower("message"), lower(?))', filters.query);
  }

  return {
    text: clauses.length === 0 ? "TRUE" : clauses.join(" AND "),
    values,
    nextParameter,
  };
};

const bucketSeconds = (bucket: AggregateQuery["bucket"]): number => {
  switch (bucket) {
    case "1m": return 60;
    case "5m": return 5 * 60;
    case "1h": return 60 * 60;
    case "1d": return 24 * 60 * 60;
    default: throw new Error("invalid aggregate bucket");
  }
};

const groupExpression = (groupBy: AggregateQuery["groupBy"]): string => {
  switch (groupBy) {
    case undefined: return "CAST(NULL AS VARCHAR)";
    case "service": return '"service"';
    case "level": return '"level"';
    default: throw new Error("invalid aggregate group");
  }
};

/** DuckDB in-process implementation for persistent local/embedded deployments. */
export class DuckDBLogStore implements LogStore {
  private readonly migrationDirectory: string;
  private readonly instance: DuckDBInstanceLike | undefined;
  private readonly connectionPromise: Promise<DuckDBConnectionLike>;
  private readonly ownsResources: boolean;
  private closed = false;

  public constructor(pathOrOptions: string | DuckDBLogStoreOptions = "data/logs.duckdb") {
    const options = typeof pathOrOptions === "string" ? { path: pathOrOptions } : pathOrOptions;
    this.migrationDirectory = options.migrationDirectory ?? defaultMigrationDirectory();
    this.instance = options.instance;
    this.ownsResources = options.connection === undefined;
    if (options.connection !== undefined) {
      this.connectionPromise = Promise.resolve(options.connection);
    } else if (options.instance !== undefined) {
      this.connectionPromise = options.instance.connect();
    } else {
      const path = openPath(options.path ?? "data/logs.duckdb");
      this.connectionPromise = (async () => {
        const created = await loadDuckDBFactory().DuckDBInstance.create(path);
        this.instance ??= created;
        return created.connect();
      })();
    }
  }

  private async connection(): Promise<DuckDBConnectionLike> {
    if (this.closed) {
      throw new Error("DuckDB store is closed");
    }
    return this.connectionPromise;
  }

  public async ping(): Promise<void> {
    await (await this.connection()).run("SELECT 1 AS ok");
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
    const connection = await this.connection();
    await connection.run("BEGIN TRANSACTION");
    try {
      await connection.run(`
        CREATE TABLE IF NOT EXISTS "schema_migrations" (
          "version" VARCHAR PRIMARY KEY,
          "applied_at" TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      const appliedRows = await (await connection.run('SELECT "version" FROM "schema_migrations"')).getRowObjectsJS();
      const applied = new Set(appliedRows.map((row) => String(row.version)));
      const marker = await connection.prepare('INSERT INTO "schema_migrations" ("version") VALUES ($1)');
      try {
        for (const migration of migrations) {
          if (applied.has(migration.version)) continue;
          await connection.run(migration.sql);
          marker.bind([migration.version]);
          await marker.run();
          applied.add(migration.version);
        }
      } finally {
        marker.destroySync();
      }
      await connection.run("COMMIT");
    } catch (error) {
      try {
        await connection.run("ROLLBACK");
      } catch {
        // Preserve the original migration failure.
      }
      throw error;
    }
  }

  public async insertLogs(logs: readonly LogRecord[]): Promise<void> {
    if (logs.length === 0) return;
    const connection = await this.connection();
    await connection.run("BEGIN TRANSACTION");
    const statement = await connection.prepare(`
      INSERT INTO "logs" ("id", "timestamp", "level", "service", "message", "attributes", "attribute_values")
      VALUES (CAST($1 AS UUID), CAST($2 AS TIMESTAMPTZ), $3, $4, $5, CAST($6 AS JSON), CAST($7 AS JSON))
    `);
    try {
      for (const log of logs) {
        statement.bind([
          log.id,
          log.timestamp,
          log.level,
          log.service,
          log.message,
          JSON.stringify(log.attributes),
          JSON.stringify(Object.fromEntries(Object.entries(log.attributes).map(([key, value]) => [
            key,
            typeof value === "boolean" ? (value ? "true" : "false") : String(value),
          ]))),
        ]);
        await statement.run();
      }
      statement.destroySync();
      await connection.run("COMMIT");
    } catch (error) {
      statement.destroySync();
      try { await connection.run("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    }
  }

  public async queryLogs(filters: LogFilters, limit: number, cursor: LogCursor | null): Promise<LogQueryResult> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
    const where = buildWhere(filters);
    const values = [...where.values];
    let cursorClause = "";
    if (cursor !== null) {
      const timestampParameter = where.nextParameter;
      const idParameter = where.nextParameter + 1;
      cursorClause = ` AND ("timestamp", "id") < (CAST($${timestampParameter} AS TIMESTAMPTZ), CAST($${idParameter} AS UUID))`;
      values.push(cursor.timestamp, cursor.id);
    }
    const limitParameter = where.nextParameter + (cursor === null ? 0 : 2);
    values.push(limit + 1);
    const result = await (await this.connection()).run(`
      SELECT "id", "timestamp", "level", "service", "message", "attributes"
      FROM "logs"
      WHERE ${where.text}${cursorClause}
      ORDER BY "timestamp" DESC, "id" DESC
      LIMIT $${limitParameter}
    `, values);
    const logs = (await result.getRowObjectsJS()).map(mapLogRow);
    const hasMore = logs.length > limit;
    if (hasMore) logs.pop();
    const last = logs.at(-1);
    return {
      logs,
      nextCursor: hasMore && last !== undefined ? { version: 1, timestamp: last.timestamp, id: last.id } : null,
    };
  }

  public async aggregateLogs(query: AggregateQuery): Promise<AggregateBucket[]> {
    const where = buildWhere(query.filters);
    const interval = bucketSeconds(query.bucket);
    const group = groupExpression(query.groupBy);
    const groupBy = query.groupBy === undefined ? "1" : "1, 2";
    const result = await (await this.connection()).run(`
      SELECT time_bucket(INTERVAL '${interval} seconds', "timestamp", TIMESTAMPTZ '1970-01-01 00:00:00+00') AS "start",
             ${group} AS "group", COUNT(*) AS "count"
      FROM "logs"
      WHERE ${where.text}
      GROUP BY ${groupBy}
      ORDER BY 1 ASC${query.groupBy === undefined ? "" : ", 2 ASC"}
    `, where.values);
    return (await result.getRowObjectsJS()).map(mapAggregateRow);
  }

  public async deleteBefore(cutoff: Date): Promise<number> {
    const connection = await this.connection();
    const result = await (await connection.run('DELETE FROM "logs" WHERE "timestamp" < CAST($1 AS TIMESTAMPTZ) RETURNING 1', [cutoff.toISOString()])).getRowObjectsJS();
    return result.length;
  }

  public async configureRetention(_retentionDays: number): Promise<void> {
    // DuckDB has no background TTL scheduler; RetentionWorker performs deletes.
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const connection = await this.connectionPromise;
    if (this.ownsResources) connection.closeSync();
    this.instance?.closeSync();
  }
}
