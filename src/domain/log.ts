import { randomUUID } from "node:crypto";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogAttribute = string | number | boolean;
export type LogAttributes = Record<string, LogAttribute>;

export interface LogRecord {
  id: string;
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
  attributes: LogAttributes;
}

export interface LogInput {
  timestamp: string;
  level: string;
  service: string;
  message: string;
  attributes?: unknown;
}

export interface RejectedLog {
  index: number;
  reason: string;
}

export interface BatchValidationResult {
  accepted: LogRecord[];
  rejected: RejectedLog[];
}

export interface MalformedBatch {
  error: string;
}

export interface LogFilters {
  service?: string;
  level?: LogLevel;
  since?: string;
  until?: string;
  attributes: Readonly<Record<string, string>>;
  query?: string;
}

export interface LogCursor {
  version: 1;
  timestamp: string;
  id: string;
}

export interface LogQueryResult {
  logs: LogRecord[];
  nextCursor: LogCursor | null;
}

export type BucketSize = "1m" | "5m" | "1h" | "1d";
export type AggregateGroup = "service" | "level";

export interface AggregateQuery {
  filters: LogFilters;
  bucket: BucketSize;
  groupBy?: AggregateGroup;
}

export interface AggregateBucket {
  start: string;
  group: string | null;
  count: number;
}

export const createLogRecord = (input: Omit<LogRecord, "id">): LogRecord => ({
  id: randomUUID(),
  ...input,
});
