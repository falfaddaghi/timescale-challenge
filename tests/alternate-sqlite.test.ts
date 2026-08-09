import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { SQLiteLogStore } from "../src/db/sqlite";
import type { LogFilters, LogRecord } from "../src/domain/log";
import { validateBatch } from "../src/domain/validation";

const migrationDirectory = resolve(process.cwd(), "migrations/sqlite");

const makeLog = (
  id: string,
  timestamp: string,
  overrides: Partial<Pick<LogRecord, "level" | "service" | "message" | "attributes">> = {},
): LogRecord => ({
  id,
  timestamp,
  level: overrides.level ?? "info",
  service: overrides.service ?? "api",
  message: overrides.message ?? `message-${id}`,
  attributes: overrides.attributes ?? {},
});

const noAttributes = (): LogFilters => ({ attributes: {} });

describe("SQLite LogStore", () => {
  let store: SQLiteLogStore;

  beforeEach(async () => {
    store = new SQLiteLogStore(":memory:", { migrationDirectory });
    await store.migrate();
  });

  afterEach(async () => {
    await store.close();
  });

  it("persists only accepted entries from a partially valid batch", async () => {
    const result = validateBatch({
      logs: [
        {
          timestamp: "2026-07-20T13:59:00Z",
          level: "info",
          service: "api",
          message: "accepted",
          attributes: { retries: 3, sampled: true },
        },
        {
          timestamp: "2026-07-20T13:59:00Z",
          level: "trace",
          service: "api",
          message: "rejected",
        },
      ],
    });
    if ("error" in result) {
      throw new Error(result.error);
    }

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toEqual([{ index: 1, reason: "invalid level: 'trace'" }]);
    await store.insertLogs(result.accepted);
    const queried = await store.queryLogs(noAttributes(), 10, null);
    expect(queried.logs).toHaveLength(1);
    expect(queried.logs[0]).toMatchObject({ message: "accepted", attributes: { retries: 3, sampled: true } });
  });

  it("combines exact filters, normalized attributes, ranges, and escaped message search", async () => {
    await store.insertLogs([
      makeLog("match", "2026-07-20T13:00:00.000Z", {
        level: "error",
        service: "checkout",
        message: "100%_safe\\path",
        attributes: { retries: 3, sampled: true, "odd.key'": "yes" },
      }),
      makeLog("wrong-service", "2026-07-20T13:00:00.000Z", {
        level: "error",
        service: "payments",
        message: "100%_safe\\path",
        attributes: { retries: 3, sampled: true, "odd.key'": "yes" },
      }),
      makeLog("wrong-level", "2026-07-20T13:00:00.000Z", {
        level: "warn",
        service: "checkout",
        message: "100%_safe\\path",
        attributes: { retries: 3, sampled: true, "odd.key'": "yes" },
      }),
      makeLog("wrong-attrs", "2026-07-20T13:00:00.000Z", {
        level: "error",
        service: "checkout",
        message: "100X_safe\\path",
        attributes: { retries: 4, sampled: false, "odd.key'": "yes" },
      }),
      makeLog("outside-range", "2026-07-20T14:00:00.000Z", {
        level: "error",
        service: "checkout",
        message: "100%_safe\\path",
        attributes: { retries: 3, sampled: true, "odd.key'": "yes" },
      }),
    ]);

    const result = await store.queryLogs(
      {
        service: "checkout",
        level: "error",
        since: "2026-07-20T13:00:00.000Z",
        until: "2026-07-20T14:00:00.000Z",
        attributes: { retries: "3", sampled: "true", "odd.key'": "yes" },
        query: "100%_SAFE\\path",
      },
      10,
      null,
    );
    expect(result.logs.map((log) => log.id)).toEqual(["match"]);
  });

  it("matches Unicode case-insensitively without treating LIKE metacharacters specially", async () => {
    await store.insertLogs([
      makeLog("unicode", "2026-07-20T13:00:00.000Z", { message: "Über 100% ready" }),
      makeLog("different", "2026-07-20T13:00:00.000Z", { message: "Uber 100X ready" }),
    ]);

    const result = await store.queryLogs({ attributes: {}, query: "ÜBER 100%" }, 10, null);
    expect(result.logs.map((log) => log.id)).toEqual(["unicode"]);
  });

  it("uses timestamp plus id as a stable cursor when timestamps tie", async () => {
    await store.insertLogs([
      makeLog("a", "2026-07-20T13:00:00.000Z"),
      makeLog("c", "2026-07-20T12:59:00.000Z"),
      makeLog("b", "2026-07-20T13:00:00.000Z"),
    ]);

    const first = await store.queryLogs(noAttributes(), 1, null);
    expect(first.logs.map((log) => log.id)).toEqual(["b"]);
    expect(first.nextCursor).toEqual({ version: 1, timestamp: "2026-07-20T13:00:00.000Z", id: "b" });

    const second = await store.queryLogs(noAttributes(), 1, first.nextCursor);
    expect(second.logs.map((log) => log.id)).toEqual(["a"]);
    expect(second.nextCursor).toEqual({ version: 1, timestamp: "2026-07-20T13:00:00.000Z", id: "a" });

    const third = await store.queryLogs(noAttributes(), 1, second.nextCursor);
    expect(third.logs.map((log) => log.id)).toEqual(["c"]);
    expect(third.nextCursor).toBeNull();
  });

  it("aggregates every supported bucket and deterministic grouping", async () => {
    await store.insertLogs([
      makeLog("m1", "2026-07-20T00:00:59.999Z", { service: "checkout", level: "info" }),
      makeLog("m2", "2026-07-20T00:01:00.000Z", { service: "checkout", level: "error" }),
      makeLog("m3", "2026-07-20T00:05:00.000Z", { service: "auth", level: "info" }),
      makeLog("h1", "2026-07-20T01:00:00.000Z", { service: "auth", level: "error" }),
      makeLog("d1", "2026-07-21T00:00:00.000Z", { service: "checkout", level: "warn" }),
    ]);
    const filters = {
      ...noAttributes(),
      since: "2026-07-20T00:00:00.000Z",
      until: "2026-07-22T00:00:00.000Z",
    };

    const oneMinute = await store.aggregateLogs({ filters, bucket: "1m" });
    expect(oneMinute).toEqual([
      { start: "2026-07-20T00:00:00.000Z", group: null, count: 1 },
      { start: "2026-07-20T00:01:00.000Z", group: null, count: 1 },
      { start: "2026-07-20T00:05:00.000Z", group: null, count: 1 },
      { start: "2026-07-20T01:00:00.000Z", group: null, count: 1 },
      { start: "2026-07-21T00:00:00.000Z", group: null, count: 1 },
    ]);

    const fiveMinutes = await store.aggregateLogs({ filters, bucket: "5m", groupBy: "service" });
    expect(fiveMinutes).toEqual([
      { start: "2026-07-20T00:00:00.000Z", group: "checkout", count: 2 },
      { start: "2026-07-20T00:05:00.000Z", group: "auth", count: 1 },
      { start: "2026-07-20T01:00:00.000Z", group: "auth", count: 1 },
      { start: "2026-07-21T00:00:00.000Z", group: "checkout", count: 1 },
    ]);

    const oneHour = await store.aggregateLogs({ filters, bucket: "1h", groupBy: "level" });
    expect(oneHour).toEqual([
      { start: "2026-07-20T00:00:00.000Z", group: "error", count: 1 },
      { start: "2026-07-20T00:00:00.000Z", group: "info", count: 2 },
      { start: "2026-07-20T01:00:00.000Z", group: "error", count: 1 },
      { start: "2026-07-21T00:00:00.000Z", group: "warn", count: 1 },
    ]);

    const oneDay = await store.aggregateLogs({ filters, bucket: "1d" });
    expect(oneDay).toEqual([
      { start: "2026-07-20T00:00:00.000Z", group: null, count: 4 },
      { start: "2026-07-21T00:00:00.000Z", group: null, count: 1 },
    ]);
  });

  it("floors aggregate buckets before the Unix epoch", async () => {
    await store.insertLogs([makeLog("pre-epoch", "1969-12-31T23:59:00.000Z")]);
    await expect(store.aggregateLogs({
      filters: {
        attributes: {},
        since: "1969-12-31T23:00:00.000Z",
        until: "1970-01-01T00:00:00.000Z",
      },
      bucket: "1h",
    })).resolves.toEqual([
      { start: "1969-12-31T23:00:00.000Z", group: null, count: 1 },
    ]);
  });

  it("deletes rows strictly older than the retention cutoff", async () => {
    await store.insertLogs([
      makeLog("old", "2026-07-19T23:59:59.999Z"),
      makeLog("at-cutoff", "2026-07-20T00:00:00.000Z"),
      makeLog("new", "2026-07-20T00:00:00.001Z"),
    ]);
    await expect(store.deleteBefore(new Date("2026-07-20T00:00:00.000Z"))).resolves.toBe(1);
    const remaining = await store.queryLogs(noAttributes(), 10, null);
    expect(remaining.logs.map((log) => log.id)).toEqual(["new", "at-cutoff"]);
  });

  it("serializes concurrent migration startup on a shared SQLite file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "timescale-sqlite-migrate-"));
    const databasePath = join(directory, "logs.sqlite");
    const first = new SQLiteLogStore(databasePath, { migrationDirectory });
    const second = new SQLiteLogStore(databasePath, { migrationDirectory });
    try {
      await expect(Promise.all([first.migrate(), second.migrate()])).resolves.toEqual([undefined, undefined]);
      await first.insertLogs([makeLog("migrated", "2026-07-20T13:00:00.000Z")]);
      await expect(second.queryLogs(noAttributes(), 10, null)).resolves.toMatchObject({
        logs: [expect.objectContaining({ id: "migrated" })],
      });
    } finally {
      await first.close();
      await second.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
