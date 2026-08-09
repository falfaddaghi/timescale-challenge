import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

describe("environment configuration", () => {
  it("defaults to the documented Timescale engine and API port", () => {
    const config = loadConfig({});
    expect(config.dbEngine).toBe("timescale");
    expect(config.port).toBe(8080);
    expect(config.databaseUrl).toContain("@timescaledb:5432/logs");
  });

  it("accepts the three engine names and the legacy Timescale alias", () => {
    expect(loadConfig({ DB_ENGINE: "timescale" }).dbEngine).toBe("timescale");
    expect(loadConfig({ DB_ENGINE: "timescaledb" }).dbEngine).toBe("timescale");
    expect(loadConfig({ DB_ENGINE: "sqlite", SQLITE_PATH: "./local.sqlite" }).sqlitePath).toBe("./local.sqlite");
    expect(loadConfig({ DB_ENGINE: "clickhouse", CLICKHOUSE_URL: "http://localhost:8123" }).clickhouseUrl).toBe(
      "http://localhost:8123",
    );
  });

  it("rejects unknown engines and invalid numeric settings", () => {
    expect(() => loadConfig({ DB_ENGINE: "redis" })).toThrow("DB_ENGINE must be one of");
    expect(() => loadConfig({ API_PORT: "not-a-port" })).toThrow("API_PORT must be a positive integer");
  });
});
