import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app";
import type {
  AggregateBucket,
  AggregateQuery,
  LogCursor,
  LogFilters,
  LogQueryResult,
  LogRecord,
} from "../src/domain/log";
import type { LogStore } from "../src/db/store";

class FakeStore implements LogStore {
  public inserted: LogRecord[] = [];
  public healthChecks = 0;
  public queryResult: LogQueryResult = { logs: [], nextCursor: null };
  public aggregateResult: AggregateBucket[] = [];

  public async ping(): Promise<void> {
    this.healthChecks += 1;
  }

  public async insertLogs(logs: readonly LogRecord[]): Promise<void> {
    this.inserted.push(...logs);
  }

  public async queryLogs(filters: LogFilters, limit: number, cursor: LogCursor | null): Promise<LogQueryResult> {
    void filters;
    void limit;
    void cursor;
    return this.queryResult;
  }

  public async aggregateLogs(query: AggregateQuery): Promise<AggregateBucket[]> {
    void query;
    return this.aggregateResult;
  }

  public async deleteBefore(cutoff: Date): Promise<number> {
    void cutoff;
    return 0;
  }
}

describe("HTTP contract", () => {
  let app: ReturnType<typeof createApp> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("returns readiness only after the store is marked ready", async () => {
    const store = new FakeStore();
    app = createApp({ store, ready: false });
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(503);
    app.markReady();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(store.healthChecks).toBe(1);
  });

  it("partially accepts POST /logs and returns source indexes", async () => {
    const store = new FakeStore();
    app = createApp({ store, now: () => new Date("2026-07-20T14:00:00.000Z") });
    const response = await app.inject({
      method: "POST",
      url: "/logs",
      payload: {
        logs: [
          {
            timestamp: "2026-07-20T13:59:00Z",
            level: "info",
            service: "api",
            message: "request complete",
            attributes: { request_id: "abc" },
          },
          {
            timestamp: "2026-07-20T13:59:00Z",
            level: "trace",
            service: "api",
            message: "bad",
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accepted: 1, rejected: [{ index: 1 }] });
    expect(store.inserted).toHaveLength(1);
  });

  it("returns 400 for an all-invalid batch and malformed JSON", async () => {
    const store = new FakeStore();
    app = createApp({ store });
    const invalid = await app.inject({
      method: "POST",
      url: "/logs",
      payload: { logs: [{ timestamp: "bad", level: "info", service: "api", message: "x" }] },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().accepted).toBe(0);

    const malformed = await app.inject({
      method: "POST",
      url: "/logs",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ error: "malformed JSON" });
  });

  it("exposes query and aggregate response shapes", async () => {
    const store = new FakeStore();
    store.queryResult = {
      logs: [
        {
          id: "00000000-0000-0000-0000-000000000001",
          timestamp: "2026-07-20T13:59:00.000Z",
          level: "error",
          service: "checkout",
          message: "payment declined",
          attributes: { user_id: "42" },
        },
      ],
      nextCursor: {
        version: 1,
        timestamp: "2026-07-20T13:59:00.000Z",
        id: "00000000-0000-0000-0000-000000000001",
      },
    };
    store.aggregateResult = [{ start: "2026-07-20T13:00:00.000Z", group: null, count: 1 }];
    app = createApp({ store });
    const query = await app.inject({ method: "GET", url: "/logs?service=checkout&limit=10" });
    expect(query.statusCode).toBe(200);
    expect(query.json().logs).toHaveLength(1);
    expect(query.json().next_cursor).toEqual(expect.any(String));

    const aggregate = await app.inject({
      method: "GET",
      url: "/logs/aggregate?since=2026-07-20T13:00:00Z&until=2026-07-20T14:00:00Z&bucket=1h",
    });
    expect(aggregate.statusCode).toBe(200);
    expect(aggregate.json()).toEqual({ buckets: store.aggregateResult });
  });

  it("rejects invalid query parameters", async () => {
    const store = new FakeStore();
    app = createApp({ store });
    const response = await app.inject({ method: "GET", url: "/logs?level=critical&limit=abc" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("invalid level");
  });
});
