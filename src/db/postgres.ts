import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Pool, type PoolConfig, type QueryResultRow } from "pg";
import type {
  AggregateBucket,
  AggregateQuery,
  LogCursor,
  LogFilters,
  LogQueryResult,
  LogRecord,
} from "../domain/log";
import { buildAggregateQuery, buildLogsQuery } from "./query-builder";
import type { LogStore } from "./store";

export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<{
    rows: T[];
    rowCount: number | null;
  }>;
}

export interface PoolLike extends Queryable {
  connect(): Promise<PoolClientLike>;
  end(): Promise<void>;
}

export interface PoolClientLike extends Queryable {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<{
    rows: T[];
    rowCount: number | null;
  }>;
  release(): void;
}

const asIsoString = (value: unknown): string => {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error("database returned an invalid timestamp");
  }
  return date.toISOString();
};

const asAttributes = (value: unknown): Record<string, string | number | boolean> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, string | number | boolean>;
};

const mapLogRow = (row: Record<string, unknown>): LogRecord => ({
  id: String(row.id),
  timestamp: asIsoString(row.timestamp),
  level: row.level as LogRecord["level"],
  service: String(row.service),
  message: String(row.message),
  attributes: asAttributes(row.attributes),
});

const mapAggregateRow = (row: Record<string, unknown>): AggregateBucket => ({
  start: asIsoString(row.start),
  group: row.group === null || row.group === undefined ? null : String(row.group),
  count: Number(row.count),
});

const defaultMigrationDirectory = (): string => {
  return resolve(dirname(__filename), "migrations");
};

export interface PostgresLogStoreOptions {
  pool?: PoolLike;
  migrationDirectory?: string;
  poolConfig?: PoolConfig;
}

/** Timescale/PostgreSQL implementation of the LogStore contract. */
export class PostgresLogStore implements LogStore {
  private readonly pool: PoolLike;
  private readonly migrationDirectory: string;
  private readonly ownsPool: boolean;

  public constructor(databaseUrlOrOptions: string | PostgresLogStoreOptions, options: PostgresLogStoreOptions = {}) {
    if (typeof databaseUrlOrOptions === "string") {
      const poolConfig: PoolConfig = { connectionString: databaseUrlOrOptions, ...options.poolConfig };
      this.pool = options.pool ?? (new Pool(poolConfig) as unknown as PoolLike);
      this.migrationDirectory = options.migrationDirectory ?? defaultMigrationDirectory();
      this.ownsPool = options.pool === undefined;
    } else {
      this.pool = databaseUrlOrOptions.pool ?? (new Pool(databaseUrlOrOptions.poolConfig) as unknown as PoolLike);
      this.migrationDirectory = databaseUrlOrOptions.migrationDirectory ?? defaultMigrationDirectory();
      this.ownsPool = databaseUrlOrOptions.pool === undefined;
    }
  }

  public async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  public async migrate(): Promise<void> {
    const files = (await readdir(this.migrationDirectory))
      .filter((file) => file.endsWith(".sql"))
      .sort((left, right) => left.localeCompare(right));
    if (files.length === 0) {
      throw new Error(`no migration files found in ${this.migrationDirectory}`);
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["timescale-log-service-migrations"]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS "schema_migrations" (
          "version" text PRIMARY KEY,
          "applied_at" timestamptz NOT NULL DEFAULT now()
        )
      `);
      const appliedResult = await client.query<{ version: string }>(
        `SELECT "version" FROM "schema_migrations" ORDER BY "version"`,
      );
      const applied = new Set(appliedResult.rows.map((row) => row.version));
      for (const file of files) {
        const version = file.replace(/\.sql$/, "");
        if (applied.has(version)) {
          continue;
        }
        const sql = await readFile(join(this.migrationDirectory, file), "utf8");
        await client.query(sql);
        await client.query(`INSERT INTO "schema_migrations" ("version") VALUES ($1)`, [version]);
      }
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original migration failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  public async insertLogs(logs: readonly LogRecord[]): Promise<void> {
    if (logs.length === 0) {
      return;
    }

    const values: unknown[] = [];
    const rows: string[] = [];
    for (const log of logs) {
      const offset = values.length + 1;
      rows.push(`($${offset}::uuid, $${offset + 1}::timestamptz, $${offset + 2}::text, $${offset + 3}::text, $${offset + 4}::text, $${offset + 5}::jsonb)`);
      values.push(log.id, log.timestamp, log.level, log.service, log.message, JSON.stringify(log.attributes));
    }
    await this.pool.query(
      `INSERT INTO "logs" ("id", "timestamp", "level", "service", "message", "attributes") VALUES ${rows.join(", ")}`,
      values,
    );
  }

  public async queryLogs(filters: LogFilters, limit: number, cursor: LogCursor | null): Promise<LogQueryResult> {
    const query = buildLogsQuery(filters, limit, cursor);
    const result = await this.pool.query<Record<string, unknown>>(query.text, query.values);
    const logs = result.rows.map(mapLogRow);
    const hasMore = logs.length > limit;
    if (hasMore) {
      logs.pop();
    }
    const last = logs.at(-1);
    return {
      logs,
      nextCursor: hasMore && last !== undefined ? { version: 1, timestamp: last.timestamp, id: last.id } : null,
    };
  }

  public async aggregateLogs(queryInput: AggregateQuery): Promise<AggregateBucket[]> {
    const query = buildAggregateQuery(queryInput);
    const result = await this.pool.query<Record<string, unknown>>(query.text, query.values);
    return result.rows.map(mapAggregateRow);
  }

  public async deleteBefore(cutoff: Date): Promise<number> {
    const cutoffValue = cutoff.toISOString();
    // Dropping complete chunks is substantially cheaper than deleting a
    // million rows one at a time. The DELETE handles the current partial
    // chunk and keeps the method correct for adapters without chunking.
    try {
      await this.pool.query(`SELECT drop_chunks('logs', older_than => $1::timestamptz)`, [cutoffValue]);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "42883" && code !== "0A000") {
        throw error;
      }
    }
    const result = await this.pool.query(`DELETE FROM "logs" WHERE "timestamp" < $1::timestamptz`, [cutoffValue]);
    return result.rowCount ?? 0;
  }

  public async configureRetention(retentionDays: number): Promise<void> {
    const interval = `${retentionDays} days`;
    try {
      await this.pool.query(`SELECT remove_retention_policy('logs', if_exists => TRUE)`);
      await this.pool.query(`SELECT add_retention_policy('logs', $1::interval, if_not_exists => TRUE)`, [interval]);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "42883" && code !== "0A000") {
        throw error;
      }
      // The SQL fallback in deleteBefore still enforces retention on a
      // PostgreSQL instance where Timescale policy functions are unavailable.
    }
  }

  public async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }
}
