import { describe, expect, it } from "vitest";
import { buildAggregateQuery, buildLogsQuery } from "../src/db/query-builder";
import { decodeCursor, encodeCursor, parseAggregateQuery, parseLogsQuery } from "../src/domain/query";
import { InputValidationError, validateBatch, validateLogEntry } from "../src/domain/validation";

const now = new Date("2026-07-20T14:00:00.000Z");

describe("log validation", () => {
  it("accepts valid entries and canonicalises timestamps", () => {
    const result = validateBatch(
      {
        logs: [
          {
            timestamp: "2026-07-20T13:59:59.123+00:00",
            level: "error",
            service: "checkout",
            message: "payment declined",
            attributes: { user_id: "42", retries: 3, sampled: false },
          },
        ],
      },
      { now },
    );
    expect(result).toEqual({
      accepted: [
        expect.objectContaining({
          timestamp: "2026-07-20T13:59:59.123Z",
          level: "error",
          attributes: { user_id: "42", retries: 3, sampled: false },
        }),
      ],
      rejected: [],
    });
  });

  it("partially accepts a batch and reports source indexes", () => {
    const result = validateBatch(
      {
        logs: [
          { timestamp: "2026-07-20T13:59:00Z", level: "info", service: "api", message: "ok" },
          { timestamp: "2026-07-20T13:59:00Z", level: "critical", service: "api", message: "bad" },
          { timestamp: "2026-07-20T13:59:00Z", level: "warn", service: "api", message: "nested", attributes: { details: {} } },
        ],
      },
      { now },
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toEqual([
      { index: 1, reason: "invalid level: 'critical'" },
      { index: 2, reason: "attribute 'details' must be a string, number, or boolean" },
    ]);
  });

  it("rejects timestamps more than five minutes ahead", () => {
    expect(() =>
      validateLogEntry(
        { timestamp: "2026-07-20T14:05:00.001Z", level: "info", service: "api", message: "future" },
        { now },
      ),
    ).toThrow("timestamp cannot be more than 5 minutes in the future");
  });

  it("rejects calendar dates that Date would otherwise normalize", () => {
    expect(() =>
      validateLogEntry(
        { timestamp: "2026-02-31T13:59:00Z", level: "info", service: "api", message: "invalid date" },
        { now },
      ),
    ).toThrow("timestamp must be a valid ISO 8601 timestamp");
  });

  it("preserves offset and fractional-second forms", () => {
    const result = validateLogEntry(
      {
        timestamp: "2026-07-20T13:59:59.123456789+0530",
        level: "info",
        service: "api",
        message: "valid precision",
      },
      { now },
    );
    expect(result.timestamp).toBe("2026-07-20T08:29:59.123Z");
  });

  it("rejects malformed batches", () => {
    expect(validateBatch({ logs: "not-an-array" })).toEqual({ error: "body.logs must be an array" });
  });
});

describe("query parsing and cursors", () => {
  it("parses combinable filters and caps the limit", () => {
    const parsed = parseLogsQuery({
      service: "checkout",
      level: "error",
      since: "2026-07-20T13:00:00Z",
      until: "2026-07-20T14:00:00Z",
      "attr.user_id": "42",
      q: "declined",
      limit: "10000",
    });
    expect(parsed.limit).toBe(1000);
    expect(parsed.filters.attributes).toEqual({ user_id: "42" });
  });

  it("round-trips an opaque cursor and rejects malformed values", () => {
    const cursor = { version: 1 as const, timestamp: "2026-07-20T13:00:00.000Z", id: "00000000-0000-0000-0000-000000000001" };
    const encoded = encodeCursor(cursor);
    expect(encoded).not.toContain("timestamp");
    expect(decodeCursor(encoded)).toEqual(cursor);
    expect(() => decodeCursor("not.valid")) .toThrow(InputValidationError);
  });

  it("requires a complete aggregate range and a supported bucket", () => {
    expect(() => parseAggregateQuery({ bucket: "1m", since: "2026-07-20T00:00:00Z" })).toThrow(
      "since and until are required",
    );
    expect(() =>
      parseAggregateQuery({ bucket: "2m", since: "2026-07-20T00:00:00Z", until: "2026-07-20T01:00:00Z" }),
    ).toThrow("bucket must be one of");
  });
});

describe("parameterized query builder", () => {
  const filters = {
    service: "checkout",
    level: "error" as const,
    since: "2026-07-20T13:00:00.000Z",
    until: "2026-07-20T14:00:00.000Z",
    attributes: { user_id: "42", region: "eu-west" },
    query: "100%_safe",
  };

  it("uses placeholders for every client-controlled value", () => {
    const query = buildLogsQuery(filters, 100, null);
    expect(query.text).not.toContain("checkout");
    expect(query.text).not.toContain("user_id");
    expect(query.values).toEqual([
      "checkout",
      "error",
      "2026-07-20T13:00:00.000Z",
      "2026-07-20T14:00:00.000Z",
      "user_id",
      "42",
      "region",
      "eu-west",
      "100\\%\\_safe",
      101,
    ]);
    expect(query.text).toMatch(/ILIKE/);
  });

  it("keeps aggregate interval parameterized and group names allowlisted", () => {
    const query = buildAggregateQuery({ filters, bucket: "5m", groupBy: "service" });
    expect(query.text).toContain("time_bucket($1::interval");
    expect(query.text).toContain('"service"');
    expect(query.values[0]).toBe("5 minutes");
  });

  it("adds deterministic timestamp/id cursor predicates", () => {
    const query = buildLogsQuery(filters, 10, {
      version: 1,
      timestamp: "2026-07-20T13:30:00.000Z",
      id: "00000000-0000-0000-0000-000000000001",
    });
    expect(query.text).toContain('("timestamp", "id") <');
    expect(query.values.at(-1)).toBe(11);
  });
});
