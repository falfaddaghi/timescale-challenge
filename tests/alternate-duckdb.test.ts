import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { DuckDBLogStore } from "../src/db/duckdb";
import type { LogFilters, LogRecord } from "../src/domain/log";
import { loadConfig } from "../src/config";

const migrationDirectory = resolve(process.cwd(), "migrations/duckdb");
const id = (n: number): string => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const noAttributes = (): LogFilters => ({ attributes: {} });
const makeLog = (
  number: number,
  timestamp: string,
  overrides: Partial<Pick<LogRecord, "level" | "service" | "message" | "attributes">> = {},
): LogRecord => ({
  id: id(number),
  timestamp,
  level: overrides.level ?? "info",
  service: overrides.service ?? "api",
  message: overrides.message ?? `message-${number}`,
  attributes: overrides.attributes ?? {},
});

describe("DuckDB LogStore", () => {
  let store: DuckDBLogStore;

  beforeEach(async () => {
    store = new DuckDBLogStore({ path: ":memory:", migrationDirectory });
    await store.migrate();
  });

  afterEach(async () => {
    await store.close();
  });

  it("selects DuckDB through shared configuration", () => {
    const config = loadConfig({ DB_ENGINE: "duckdb", DUCKDB_PATH: "./local.duckdb" });
    expect(config.dbEngine).toBe("duckdb");
    expect(config.duckdbPath).toBe("./local.duckdb");
  });

  it("runs migration and ping readiness, then preserves exact scalar filters", async () => {
    await expect(store.ping()).resolves.toBeUndefined();
    await store.insertLogs([
      makeLog(1, "2026-07-20T13:00:00.000Z", {
        service: "checkout",
        level: "error",
        message: "Über 100% ready",
        attributes: { retries: 3, sampled: true, "odd.key'": "yes" },
      }),
      makeLog(2, "2026-07-20T13:00:00.000Z", { message: "Uber 100X ready" }),
    ]);
    const result = await store.queryLogs({
      service: "checkout",
      level: "error",
      attributes: { retries: "3", sampled: "true", "odd.key'": "yes" },
      query: "ÜBER 100%",
    }, 10, null);
    expect(result.logs.map((log) => log.id)).toEqual([id(1)]);
    expect(result.logs[0]!.attributes).toEqual({ retries: 3, sampled: true, "odd.key'": "yes" });
  });

  it("paginates tied timestamps by timestamp and UUID", async () => {
    await store.insertLogs([
      makeLog(1, "2026-07-20T13:00:00.000Z"),
      makeLog(3, "2026-07-20T12:59:00.000Z"),
      makeLog(2, "2026-07-20T13:00:00.000Z"),
    ]);
    const first = await store.queryLogs(noAttributes(), 1, null);
    const second = await store.queryLogs(noAttributes(), 1, first.nextCursor);
    const third = await store.queryLogs(noAttributes(), 1, second.nextCursor);
    expect(first.logs.map((log) => log.id)).toEqual([id(2)]);
    expect(second.logs.map((log) => log.id)).toEqual([id(1)]);
    expect(third.logs.map((log) => log.id)).toEqual([id(3)]);
    expect(third.nextCursor).toBeNull();
  });

  it("aggregates supported buckets with epoch-anchored pre-epoch floors and grouping", async () => {
    await store.insertLogs([
      makeLog(1, "1969-12-31T23:59:00.000Z", { service: "auth", level: "info" }),
      makeLog(2, "1970-01-01T00:00:00.000Z", { service: "auth", level: "error" }),
      makeLog(3, "2026-07-20T00:05:00.000Z", { service: "checkout", level: "warn" }),
    ]);
    const filters = {
      ...noAttributes(),
      since: "1969-12-31T23:00:00.000Z",
      until: "2026-07-21T00:00:00.000Z",
    };
    await expect(store.aggregateLogs({ filters, bucket: "1m" })).resolves.toEqual([
      { start: "1969-12-31T23:59:00.000Z", group: null, count: 1 },
      { start: "1970-01-01T00:00:00.000Z", group: null, count: 1 },
      { start: "2026-07-20T00:05:00.000Z", group: null, count: 1 },
    ]);
    await expect(store.aggregateLogs({ filters, bucket: "5m", groupBy: "service" })).resolves.toEqual([
      { start: "1969-12-31T23:55:00.000Z", group: "auth", count: 1 },
      { start: "1970-01-01T00:00:00.000Z", group: "auth", count: 1 },
      { start: "2026-07-20T00:05:00.000Z", group: "checkout", count: 1 },
    ]);
    for (const bucket of ["1h", "1d"] as const) {
      await expect(store.aggregateLogs({ filters, bucket })).resolves.toBeInstanceOf(Array);
    }
  });

  it("deletes only rows strictly older than the retention cutoff", async () => {
    await store.insertLogs([
      makeLog(1, "2026-07-19T23:59:59.999Z"),
      makeLog(2, "2026-07-20T00:00:00.000Z"),
      makeLog(3, "2026-07-20T00:00:00.001Z"),
    ]);
    await expect(store.deleteBefore(new Date("2026-07-20T00:00:00.000Z"))).resolves.toBe(1);
    await expect(store.queryLogs(noAttributes(), 10, null)).resolves.toMatchObject({
      logs: [expect.objectContaining({ id: id(3) }), expect.objectContaining({ id: id(2) })],
    });
  });
});
