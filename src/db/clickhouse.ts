import { createRequire } from "node:module";
import { existsSync } from "node:fs";
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

export interface ClickHouseQueryResultLike {
  json<T extends Record<string, unknown>>(): Promise<T[]>;
}

export interface ClickHouseClientLike {
  query(options: {
    query: string;
    format: "JSONEachRow";
    query_params?: Readonly<Record<string, string | number>>;
  }): Promise<ClickHouseQueryResultLike>;
  command(options: {
    query: string;
    query_params?: Readonly<Record<string, string | number>>;
  }): Promise<unknown>;
  insert(options: {
    table: string;
    values: readonly Record<string, unknown>[];
    format: "JSONEachRow";
  }): Promise<unknown>;
  close(): Promise<void>;
}

export interface ClickHouseLogStoreOptions {
  client?: ClickHouseClientLike;
  migrationDirectory?: string;
  username?: string;
  password?: string;
  database?: string;
  requestTimeout?: number;
}

interface ClickHouseClientFactory {
  createClient(options: {
    url: string;
    username?: string;
    password?: string;
    database?: string;
    request_timeout?: number;
  }): ClickHouseClientLike;
}

const loadClickHouseFactory = (): ClickHouseClientFactory => {
  const moduleValue = createRequire(__filename)("@clickhouse/client") as ClickHouseClientFactory;
  if (typeof moduleValue.createClient !== "function") {
    throw new Error("@clickhouse/client did not expose createClient");
  }
  return moduleValue;
};

const defaultMigrationDirectory = (): string => {
  const candidates = [
    resolve(process.cwd(), "migrations/clickhouse"),
    resolve(process.cwd(), "src/db/migrations/clickhouse"),
    resolve(dirname(__filename), "migrations/clickhouse"),
    resolve(dirname(__filename), "../../migrations/clickhouse"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
};

const asIsoString = (value: unknown): string => {
  const text = value instanceof Date ? value.toISOString() : String(value);
  // ClickHouse commonly emits DateTime64 values as `YYYY-MM-DD HH:mm:ss.SSS`
  // in JSONEachRow. The schema timezone is UTC, so make that explicit before
  // handing the value to JavaScript's date parser.
  const normalised = text.includes("T") ? text : `${text.replace(" ", "T")}Z`;
  const parsed = new Date(normalised);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("database returned an invalid timestamp");
  }
  return parsed.toISOString();
};

const asClickHouseTimestamp = (value: unknown): string => asIsoString(value).replace("T", " ").replace("Z", "");

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

const normalisedAttributeValues = (attributes: LogRecord["attributes"]): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    result[key] = typeof value === "boolean" ? (value ? "true" : "false") : String(value);
  }
  return result;
};

interface ClickHouseWhere {
  text: string;
  parameters: Record<string, string | number>;
}

const buildWhere = (filters: LogFilters): ClickHouseWhere => {
  const clauses: string[] = [];
  const parameters: Record<string, string | number> = {};
  let index = 0;
  const add = (text: string, name: string, value: string | number): void => {
    clauses.push(text);
    parameters[name] = value;
  };

  if (filters.service !== undefined) {
    const name = `service_${index++}`;
    add(`"service" = {${name}:String}`, name, filters.service);
  }
  if (filters.level !== undefined) {
    const name = `level_${index++}`;
    add(`"level" = {${name}:String}`, name, filters.level);
  }
  if (filters.since !== undefined) {
    const name = `since_${index++}`;
    add(`"timestamp" >= {${name}:DateTime64(3)}`, name, asClickHouseTimestamp(filters.since));
  }
  if (filters.until !== undefined) {
    const name = `until_${index++}`;
    add(`"timestamp" < {${name}:DateTime64(3)}`, name, asClickHouseTimestamp(filters.until));
  }
  for (const [key, value] of Object.entries(filters.attributes ?? {})) {
    const keyName = `attribute_key_${index}`;
    const valueName = `attribute_value_${index}`;
    index += 1;
    add(
      `JSONHas("attribute_values", {${keyName}:String}) = 1 AND JSONExtractString("attribute_values", {${keyName}:String}) = {${valueName}:String}`,
      keyName,
      key,
    );
    parameters[valueName] = value;
  }
  if (filters.query !== undefined && filters.query.length > 0) {
    const name = `query_${index++}`;
    add(`positionCaseInsensitiveUTF8("message", {${name}:String}) > 0`, name, filters.query);
  }

  return { text: clauses.length === 0 ? "1 = 1" : clauses.join(" AND "), parameters };
};

const bucketIntervalMilliseconds = (bucket: AggregateQuery["bucket"]): number => {
  switch (bucket) {
    case "1m":
      return 60_000;
    case "5m":
      return 5 * 60_000;
    case "1h":
      return 60 * 60_000;
    case "1d":
      return 24 * 60 * 60_000;
    default:
      throw new Error("invalid aggregate bucket");
  }
};

const groupExpression = (groupBy: AggregateQuery["groupBy"]): string => {
  switch (groupBy) {
    case undefined:
      return "CAST(NULL AS Nullable(String))";
    case "service":
      return '"service"';
    case "level":
      return '"level"';
    default:
      throw new Error("invalid aggregate group");
  }
};

interface ClickHouseConnection {
  url: string;
  username?: string;
  password?: string;
  database?: string;
}

const clickHouseConnection = (value: string): ClickHouseConnection => {
  const withProtocol = value.startsWith("clickhouse://")
    ? `http://${value.slice("clickhouse://".length)}`
    : value.startsWith("http://") || value.startsWith("https://")
      ? value
      : `http://${value}`;
  const parsed = new URL(withProtocol);
  const pathDatabase = parsed.pathname.length > 1 ? decodeURIComponent(parsed.pathname.slice(1)) : undefined;
  return {
    url: `${parsed.protocol}//${parsed.host}`,
    username: parsed.username.length === 0 ? undefined : decodeURIComponent(parsed.username),
    password: parsed.password.length === 0 ? undefined : decodeURIComponent(parsed.password),
    database: pathDatabase,
  };
};

/** ClickHouse implementation using MergeTree and JSONEachRow over HTTP. */
export class ClickHouseLogStore implements LogStore {
  private readonly client: ClickHouseClientLike;
  private readonly migrationDirectory: string;
  private readonly ownsClient: boolean;

  public constructor(urlOrOptions: string | ClickHouseLogStoreOptions = "http://localhost:8123", options: ClickHouseLogStoreOptions = {}) {
    if (typeof urlOrOptions === "string") {
      const connection = clickHouseConnection(urlOrOptions);
      this.client = options.client ?? loadClickHouseFactory().createClient({
        url: connection.url,
        username: options.username ?? connection.username,
        password: options.password ?? connection.password,
        database: options.database ?? connection.database,
        request_timeout: options.requestTimeout,
      });
      this.migrationDirectory = options.migrationDirectory ?? defaultMigrationDirectory();
      this.ownsClient = options.client === undefined;
    } else {
      this.client = urlOrOptions.client ?? loadClickHouseFactory().createClient({
        url: "http://localhost:8123",
        username: urlOrOptions.username,
        password: urlOrOptions.password,
        database: urlOrOptions.database,
        request_timeout: urlOrOptions.requestTimeout,
      });
      this.migrationDirectory = urlOrOptions.migrationDirectory ?? defaultMigrationDirectory();
      this.ownsClient = urlOrOptions.client === undefined;
    }
  }

  public async ping(): Promise<void> {
    const result = await this.client.query({ query: "SELECT 1 AS ok", format: "JSONEachRow" });
    await result.json();
  }

  public async migrate(): Promise<void> {
    const files = (await readdir(this.migrationDirectory))
      .filter((file) => file.endsWith(".sql"))
      .sort((left, right) => left.localeCompare(right));
    if (files.length === 0) {
      throw new Error(`no migration files found in ${this.migrationDirectory}`);
    }

    await this.client.command({
      query: `
        CREATE TABLE IF NOT EXISTS "schema_migrations" (
          "version" String,
          "applied_at" DateTime64(3, 'UTC') DEFAULT now64(3)
        ) ENGINE = ReplacingMergeTree("applied_at")
        ORDER BY "version"
      `,
    });
    const appliedResult = await this.client.query({
      // ReplacingMergeTree plus FINAL hides duplicate version rows when two
      // API processes race during startup. Migration DDL is deliberately
      // idempotent (CREATE/ALTER ... IF NOT EXISTS).
      query: 'SELECT DISTINCT "version" FROM "schema_migrations" FINAL',
      format: "JSONEachRow",
    });
    const applied = new Set((await appliedResult.json<{ version: string }>()).map((row) => row.version));

    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      if (applied.has(version)) {
        continue;
      }
      const sql = await readFile(join(this.migrationDirectory, file), "utf8");
      await this.client.command({ query: sql });
      await this.client.insert({
        table: "schema_migrations",
        // Let ClickHouse fill its DateTime64 default; JSONEachRow on older
        // 24.x servers does not accept an RFC3339 trailing `Z` for this type.
        values: [{ version }],
        format: "JSONEachRow",
      });
    }
  }

  public async insertLogs(logs: readonly LogRecord[]): Promise<void> {
    if (logs.length === 0) {
      return;
    }
    await this.client.insert({
      table: "logs",
      values: logs.map((log) => ({
        id: log.id,
        timestamp: asClickHouseTimestamp(log.timestamp),
        level: log.level,
        service: log.service,
        message: log.message,
        attributes: JSON.stringify(log.attributes),
        attribute_values: JSON.stringify(normalisedAttributeValues(log.attributes)),
      })),
      format: "JSONEachRow",
    });
  }

  public async queryLogs(filters: LogFilters, limit: number, cursor: LogCursor | null): Promise<LogQueryResult> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("limit must be a positive integer");
    }
    const where = buildWhere(filters);
    const parameters: Record<string, string | number> = { ...where.parameters, limit: limit + 1 };
    const cursorClause = cursor === null
      ? ""
      : " AND (\"timestamp\" < {cursor_timestamp:DateTime64(3)} OR (\"timestamp\" = {cursor_timestamp:DateTime64(3)} AND \"id\" < {cursor_id:UUID}))";
    if (cursor !== null) {
      parameters.cursor_timestamp = asClickHouseTimestamp(cursor.timestamp);
      parameters.cursor_id = cursor.id;
    }
    const result = await this.client.query({
      query: `
        SELECT "id", "timestamp", "level", "service", "message", "attributes"
        FROM "logs"
        WHERE ${where.text}${cursorClause}
        ORDER BY "timestamp" DESC, "id" DESC
        LIMIT {limit:UInt32}
      `,
      format: "JSONEachRow",
      query_params: parameters,
    });
    const logs = (await result.json()).map(mapLogRow);
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

  public async aggregateLogs(query: AggregateQuery): Promise<AggregateBucket[]> {
    const where = buildWhere(query.filters);
    const interval = bucketIntervalMilliseconds(query.bucket);
    const group = groupExpression(query.groupBy);
    const result = await this.client.query({
      query: `
        SELECT bucket AS "start", group_value AS "group", count() AS "count"
        FROM (
          SELECT
            fromUnixTimestamp64Milli(
              (
                intDiv(toUnixTimestamp64Milli("timestamp"), ${interval})
                - if(
                    toUnixTimestamp64Milli("timestamp") < 0
                    AND modulo(toUnixTimestamp64Milli("timestamp"), ${interval}) != 0,
                    1,
                    0
                  )
              ) * ${interval},
              'UTC'
            ) AS bucket,
            ${group} AS group_value
          FROM "logs"
          WHERE ${where.text}
        )
        GROUP BY bucket, group_value
        ORDER BY bucket ASC, group_value ASC
      `,
      format: "JSONEachRow",
      query_params: where.parameters,
    });
    return (await result.json()).map(mapAggregateRow);
  }

  public async deleteBefore(cutoff: Date): Promise<number> {
    const cutoffValue = cutoff.toISOString();
    const countResult = await this.client.query({
      query: 'SELECT count() AS "count" FROM "logs" WHERE "timestamp" < {cutoff:DateTime64(3)}',
      format: "JSONEachRow",
      query_params: { cutoff: asClickHouseTimestamp(cutoffValue) },
    });
    const countRows = await countResult.json<{ count: string | number }>();
    const count = Number(countRows[0]?.count ?? 0);
    await this.client.command({
      query: 'ALTER TABLE "logs" DELETE WHERE "timestamp" < {cutoff:DateTime64(3)}',
      query_params: { cutoff: asClickHouseTimestamp(cutoffValue) },
    });
    return count;
  }

  public async configureRetention(retentionDays: number): Promise<void> {
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) {
      throw new Error("retentionDays must be a positive integer");
    }
    await this.client.command({
      // ClickHouse 24.x requires the TTL expression to produce DateTime (or
      // Date), while the event column intentionally retains millisecond
      // precision as DateTime64.
      query: `ALTER TABLE "logs" MODIFY TTL toDateTime("timestamp", 'UTC') + INTERVAL ${retentionDays} DAY`,
    });
  }

  public async close(): Promise<void> {
    if (this.ownsClient) {
      await this.client.close();
    }
  }
}
