export interface AppConfig {
  dbEngine: DbEngine;
  host: string;
  port: number;
  databaseUrl: string;
  sqlitePath: string;
  duckdbPath: string;
  clickhouseUrl: string;
  clickhouseDatabase?: string;
  clickhouseUsername?: string;
  clickhousePassword?: string;
  clickhouseRequestTimeoutMs: number;
  dbPoolMax: number;
  retentionDays: number;
  retentionIntervalMs: number;
  bodyLimitBytes: number;
}

export const DB_ENGINES = ["timescale", "sqlite", "clickhouse", "duckdb"] as const;
export type DbEngine = (typeof DB_ENGINES)[number];

const parsePositiveInteger = (value: string | undefined, fallback: number, name: string): number => {
  if (value === undefined || value === "") {
    return fallback;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
};

const parseDbEngine = (value: string | undefined): DbEngine => {
  // `timescale` is the documented short name; keep `timescaledb` as a
  // backwards-compatible alias for existing compose files and deployments.
  const engine = value === "timescaledb" ? "timescale" : (value ?? "timescale");
  if ((DB_ENGINES as readonly string[]).includes(engine)) {
    return engine as DbEngine;
  }
  throw new Error(`DB_ENGINE must be one of ${DB_ENGINES.join(", ")}`);
};

const defaultDatabaseUrl = (engine: DbEngine): string => {
  switch (engine) {
    case "timescale":
      return "postgres://postgres:postgres@timescaledb:5432/logs";
    case "sqlite":
      return "sqlite:///data/logs.sqlite";
    case "clickhouse":
      return "clickhouse://default:@clickhouse:8123/logs";
    case "duckdb":
      return "duckdb:///data/logs.duckdb";
  }
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const dbEngine = parseDbEngine(environment.DB_ENGINE);
  const databaseUrl = environment.DATABASE_URL ?? defaultDatabaseUrl(dbEngine);
  return {
    dbEngine,
    host: environment.API_HOST ?? "0.0.0.0",
    port: parsePositiveInteger(environment.API_PORT, 8080, "API_PORT"),
    databaseUrl,
    sqlitePath: environment.SQLITE_PATH ?? (
      dbEngine === "sqlite" && databaseUrl.startsWith("sqlite:") ? databaseUrl : "/data/logs.sqlite"
    ),
    duckdbPath: environment.DUCKDB_PATH ?? (
      dbEngine === "duckdb" && databaseUrl.startsWith("duckdb:") ? databaseUrl : "/data/logs.duckdb"
    ),
    clickhouseUrl: environment.CLICKHOUSE_URL ?? (
      dbEngine === "clickhouse" && /^(clickhouse|https?):\/\//.test(databaseUrl)
        ? databaseUrl
        : "http://clickhouse:8123"
    ),
    clickhouseDatabase: environment.CLICKHOUSE_DATABASE || undefined,
    clickhouseUsername: environment.CLICKHOUSE_USER || undefined,
    clickhousePassword: environment.CLICKHOUSE_PASSWORD || undefined,
    clickhouseRequestTimeoutMs: parsePositiveInteger(
      environment.CLICKHOUSE_REQUEST_TIMEOUT_MS,
      30_000,
      "CLICKHOUSE_REQUEST_TIMEOUT_MS",
    ),
    dbPoolMax: parsePositiveInteger(environment.DB_POOL_MAX, 20, "DB_POOL_MAX"),
    retentionDays: parsePositiveInteger(environment.RETENTION_DAYS, 7, "RETENTION_DAYS"),
    retentionIntervalMs: parsePositiveInteger(environment.RETENTION_INTERVAL_MS, 60 * 60 * 1000, "RETENTION_INTERVAL_MS"),
    bodyLimitBytes: parsePositiveInteger(environment.BODY_LIMIT_BYTES, 10 * 1024 * 1024, "BODY_LIMIT_BYTES"),
  };
}
