import type { AppConfig } from "../config";
import { ClickHouseLogStore } from "./clickhouse";
import { PostgresLogStore } from "./postgres";
import type { LogStore } from "./store";
import { SQLiteLogStore } from "./sqlite";

export type MigratableLogStore = LogStore & {
  migrate(): Promise<void>;
};

/** Construct one of the interchangeable persistence adapters from config. */
export function createLogStore(config: AppConfig): MigratableLogStore {
  switch (config.dbEngine) {
    case "timescale":
      return new PostgresLogStore(config.databaseUrl, {
        poolConfig: { max: config.dbPoolMax },
      });
    case "sqlite":
      return new SQLiteLogStore(config.sqlitePath);
    case "clickhouse":
      return new ClickHouseLogStore(config.clickhouseUrl, {
        database: config.clickhouseDatabase,
        username: config.clickhouseUsername,
        password: config.clickhousePassword,
        requestTimeout: config.clickhouseRequestTimeoutMs,
      });
  }
}
