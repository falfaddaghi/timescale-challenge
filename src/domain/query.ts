import {
  LOG_LEVELS,
  type AggregateGroup,
  type AggregateQuery,
  type BucketSize,
  type LogCursor,
  type LogFilters,
  type LogLevel,
} from "./log";
import { InputValidationError, parseIsoTimestamp } from "./validation";

const BUCKETS = new Set<BucketSize>(["1m", "5m", "1h", "1d"]);
const GROUPS = new Set<AggregateGroup>(["service", "level"]);
const MAX_CURSOR_LENGTH = 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ParsedLogQuery {
  filters: LogFilters;
  limit: number;
  cursor: LogCursor | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getSingle = (query: Record<string, unknown>, key: string): string | undefined => {
  const value = query[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new InputValidationError(`${key} must be provided once as a string`);
  }
  return value;
};

const parseFilterTimestamp = (value: string | undefined, name: string): string | undefined =>
  value === undefined ? undefined : parseIsoTimestamp(value, name);

const parseFilters = (query: Record<string, unknown>, requireRange: boolean): LogFilters => {
  const service = getSingle(query, "service");
  const levelValue = getSingle(query, "level");
  const sinceInput = getSingle(query, "since");
  const untilInput = getSingle(query, "until");
  const search = getSingle(query, "q");
  const since = parseFilterTimestamp(sinceInput, "since");
  const until = parseFilterTimestamp(untilInput, "until");

  if (levelValue !== undefined && !(LOG_LEVELS as readonly string[]).includes(levelValue)) {
    throw new InputValidationError(`invalid level: '${levelValue}'`);
  }
  if (service !== undefined && service.length === 0) {
    throw new InputValidationError("service must not be empty");
  }
  if (since !== undefined && until !== undefined && new Date(until).getTime() < new Date(since).getTime()) {
    throw new InputValidationError("until must not be before since");
  }
  if (requireRange && (since === undefined || until === undefined)) {
    throw new InputValidationError("since and until are required");
  }

  const attributes: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(query)) {
    if (!key.startsWith("attr.")) {
      continue;
    }
    const attributeName = key.slice("attr.".length);
    if (attributeName.length === 0) {
      throw new InputValidationError("attribute filter name must not be empty");
    }
    if (typeof rawValue !== "string") {
      throw new InputValidationError(`attr.${attributeName} must be provided once as a string`);
    }
    attributes[attributeName] = rawValue;
  }

  return {
    service,
    level: levelValue as LogLevel | undefined,
    since,
    until,
    attributes,
    query: search,
  };
};

const parseLimit = (value: string | undefined): number => {
  if (value === undefined) {
    return 100;
  }
  if (!/^\d+$/.test(value)) {
    throw new InputValidationError("limit must be a positive integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new InputValidationError("limit must be a positive integer");
  }
  return Math.min(parsed, 1000);
};

const base64UrlEncode = (value: string): string =>
  Buffer.from(value, "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const base64UrlDecode = (value: string): string => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new InputValidationError("cursor is malformed");
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    throw new InputValidationError("cursor is malformed");
  }
};

export function encodeCursor(cursor: LogCursor): string {
  return base64UrlEncode(JSON.stringify(cursor));
}

export function decodeCursor(value: string): LogCursor {
  if (value.length === 0 || value.length > MAX_CURSOR_LENGTH) {
    throw new InputValidationError("cursor is malformed");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(value));
  } catch {
    throw new InputValidationError("cursor is malformed");
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.id !== "string" ||
    !UUID.test(parsed.id)
  ) {
    throw new InputValidationError("cursor is malformed");
  }

  const timestamp = parseIsoTimestamp(parsed.timestamp, "cursor timestamp");
  return { version: 1, timestamp, id: parsed.id };
}

export function parseLogsQuery(input: unknown): ParsedLogQuery {
  if (!isRecord(input)) {
    throw new InputValidationError("query parameters are malformed");
  }
  const filters = parseFilters(input, false);
  const limit = parseLimit(getSingle(input, "limit"));
  const cursorValue = getSingle(input, "cursor");
  return { filters, limit, cursor: cursorValue === undefined ? null : decodeCursor(cursorValue) };
}

export function parseAggregateQuery(input: unknown): AggregateQuery {
  if (!isRecord(input)) {
    throw new InputValidationError("query parameters are malformed");
  }
  const filters = parseFilters(input, true);
  const bucket = getSingle(input, "bucket");
  if (bucket === undefined || !BUCKETS.has(bucket as BucketSize)) {
    throw new InputValidationError("bucket must be one of 1m, 5m, 1h, or 1d");
  }
  const groupBy = getSingle(input, "group_by");
  if (groupBy !== undefined && !GROUPS.has(groupBy as AggregateGroup)) {
    throw new InputValidationError("group_by must be service or level");
  }
  return { filters, bucket: bucket as BucketSize, groupBy: groupBy as AggregateGroup | undefined };
}

export const bucketInterval = (bucket: BucketSize): string => {
  switch (bucket) {
    case "1m":
      return "1 minute";
    case "5m":
      return "5 minutes";
    case "1h":
      return "1 hour";
    case "1d":
      return "1 day";
  }
};
