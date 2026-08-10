import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { ClickHouseLogStore, type ClickHouseClientLike, type ClickHouseQueryResultLike } from "../src/db/clickhouse";
import type { AggregateQuery, LogRecord } from "../src/domain/log";

type QueryOptions = Parameters<ClickHouseClientLike["query"]>[0];
type CommandOptions = Parameters<ClickHouseClientLike["command"]>[0];
type InsertOptions = Parameters<ClickHouseClientLike["insert"]>[0];

class FakeClickHouseClient implements ClickHouseClientLike {
  public readonly queries: QueryOptions[] = [];
  public readonly commands: CommandOptions[] = [];
  public readonly inserts: InsertOptions[] = [];
  public queuedRows: Array<Array<Record<string, unknown>>> = [];

  public async query(options: QueryOptions): Promise<ClickHouseQueryResultLike> {
    this.queries.push(options);
    const rows = this.queuedRows.shift() ?? [];
    return {
      json: async <T extends Record<string, unknown>>(): Promise<T[]> => rows as T[],
    };
  }

  public async command(options: CommandOptions): Promise<void> {
    this.commands.push(options);
  }

  public async insert(options: InsertOptions): Promise<void> {
    this.inserts.push(options);
  }

  public async close(): Promise<void> {
    // An injected client is deliberately not owned by the store.
  }
}

const makeLog = (id: string): LogRecord => ({
  id,
  timestamp: "2026-07-20T13:00:00.123Z",
  level: "error",
  service: "checkout",
  message: "100%_safe\\path",
  attributes: { retries: 3, sampled: true, region: "eu-west" },
});

describe("ClickHouse LogStore", () => {
  it("keeps filter values out of SQL and normalizes inserted scalar attributes", async () => {
    const client = new FakeClickHouseClient();
    client.queuedRows.push([
      {
        id: "00000000-0000-0000-0000-000000000002",
        timestamp: "2026-07-20 13:00:00.123",
        level: "error",
        service: "checkout",
        message: "100%_safe\\path",
        attributes: '{"retries":3,"sampled":true,"region":"eu-west"}',
      },
    ]);
    const store = new ClickHouseLogStore({ client });
    const queried = await store.queryLogs(
      {
        service: "checkout",
        level: "error",
        since: "2026-07-20T12:00:00.000Z",
        until: "2026-07-20T14:00:00.000Z",
        attributes: { retries: "3", sampled: "true" },
        query: "100%_safe\\path",
      },
      1,
      {
        version: 1,
        timestamp: "2026-07-20T13:05:00.000Z",
        id: "00000000-0000-0000-0000-000000000010",
      },
    );

    expect(queried.logs).toEqual([
      expect.objectContaining({ id: "00000000-0000-0000-0000-000000000002", timestamp: "2026-07-20T13:00:00.123Z" }),
    ]);
    const query = client.queries[0]!;
    expect(query.query).not.toContain("checkout");
    expect(query.query).not.toContain("100%_safe");
    expect(query.query_params).toMatchObject({
      service_0: "checkout",
      level_1: "error",
      since_2: "2026-07-20 12:00:00.000",
      until_3: "2026-07-20 14:00:00.000",
      attribute_key_4: "retries",
      attribute_value_4: "3",
      attribute_key_5: "sampled",
      attribute_value_5: "true",
      query_6: "100%_safe\\path",
      cursor_timestamp: "2026-07-20 13:05:00.000",
      cursor_id: "00000000-0000-0000-0000-000000000010",
      limit: 2,
    });

    await store.insertLogs([makeLog("00000000-0000-0000-0000-000000000001")]);
    expect(client.inserts).toHaveLength(1);
    expect(client.inserts[0]!.values).toEqual([
      {
        id: "00000000-0000-0000-0000-000000000001",
        timestamp: "2026-07-20 13:00:00.123",
        level: "error",
        service: "checkout",
        message: "100%_safe\\path",
        attributes: '{"retries":3,"sampled":true,"region":"eu-west"}',
        attribute_values: '{"retries":"3","sampled":"true","region":"eu-west"}',
      },
    ]);
  });

  it("generates UTC bucket SQL with allowlisted grouping and maps rows", async () => {
    const client = new FakeClickHouseClient();
    client.queuedRows.push([
      { start: "2026-07-20 13:00:00.000", group: "auth", count: "4" },
      { start: "2026-07-20 13:05:00.000", group: "checkout", count: 2 },
    ]);
    const store = new ClickHouseLogStore({ client });
    const filters = {
      attributes: { region: "eu-west" },
      since: "2026-07-20T13:00:00.000Z",
      until: "2026-07-20T14:00:00.000Z",
    };

    const buckets = await store.aggregateLogs({ filters, bucket: "5m", groupBy: "service" });
    expect(buckets).toEqual([
      { start: "2026-07-20T13:00:00.000Z", group: "auth", count: 4 },
      { start: "2026-07-20T13:05:00.000Z", group: "checkout", count: 2 },
    ]);
    expect(client.queries[0]!.query).toContain("toUnixTimestamp64Milli(\"timestamp\")");
    expect(client.queries[0]!.query).toContain("300000");
    expect(client.queries[0]!.query).toContain('"service" AS group_value');
    expect(client.queries[0]!.query_params).toEqual({
      since_0: "2026-07-20 13:00:00.000",
      until_1: "2026-07-20 14:00:00.000",
      attribute_key_2: "region",
      attribute_value_2: "eu-west",
    });

    const unsafeGroup = "service, message" as AggregateQuery["groupBy"];
    await expect(store.aggregateLogs({ filters, bucket: "1m", groupBy: unsafeGroup })).rejects.toThrow(
      "invalid aggregate group",
    );
  });

  it("uses parameterized retention mutations and ClickHouse-compatible TTL syntax", async () => {
    const client = new FakeClickHouseClient();
    client.queuedRows.push([{ count: "7" }]);
    const store = new ClickHouseLogStore({ client });
    const cutoff = new Date("2026-07-20T00:00:00.000Z");

    await expect(store.deleteBefore(cutoff)).resolves.toBe(7);
    expect(client.queries[0]!.query).not.toContain(cutoff.toISOString());
    expect(client.queries[0]!.query_params).toEqual({ cutoff: "2026-07-20 00:00:00.000" });
    expect(client.commands[0]).toEqual({
      query: 'ALTER TABLE "logs" DELETE WHERE "timestamp" < {cutoff:DateTime64(3)}',
      query_params: { cutoff: "2026-07-20 00:00:00.000" },
    });

    await store.configureRetention(7);
    expect(client.commands[1]!.query).toContain("toDateTime(\"timestamp\", 'UTC') + INTERVAL 7 DAY");
  });

  it("uses epoch-floor arithmetic for pre-epoch UTC buckets", async () => {
    const client = new FakeClickHouseClient();
    client.queuedRows.push([
      { start: "1969-12-31 23:00:00.000", group: null, count: 1 },
    ]);
    const store = new ClickHouseLogStore({ client });

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
    expect(client.queries[0]!.query).toContain("intDiv(toUnixTimestamp64Milli(\"timestamp\"), 3600000)");
    expect(client.queries[0]!.query).toContain("modulo(toUnixTimestamp64Milli(\"timestamp\"), 3600000)");
  });

  it("runs migration and readiness through the injected client seam", async () => {
    const client = new FakeClickHouseClient();
    const store = new ClickHouseLogStore({
      client,
      migrationDirectory: resolve(process.cwd(), "migrations/clickhouse"),
    });

    await store.migrate();
    await store.ping();
    expect(client.commands[0]!.query).toContain('CREATE TABLE IF NOT EXISTS "schema_migrations"');
    expect(client.commands[1]!.query).toContain('CREATE TABLE IF NOT EXISTS "logs"');
    expect(client.inserts).toEqual([
      {
        table: "schema_migrations",
        values: [{ version: "001_logs" }],
        format: "JSONEachRow",
      },
    ]);
    expect(client.queries.at(-1)!.query).toBe("SELECT 1 AS ok");
  });

  it("treats duplicate migration markers as already applied", async () => {
    const client = new FakeClickHouseClient();
    client.queuedRows.push([
      { version: "001_logs" },
      { version: "001_logs" },
    ]);
    const store = new ClickHouseLogStore({
      client,
      migrationDirectory: resolve(process.cwd(), "migrations/clickhouse"),
    });

    await store.migrate();
    expect(client.queries[0]!.query).toContain('SELECT DISTINCT "version" FROM "schema_migrations" FINAL');
    expect(client.commands).toHaveLength(1);
    expect(client.inserts).toHaveLength(0);
  });
});
