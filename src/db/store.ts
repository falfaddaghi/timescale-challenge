import type {
  AggregateBucket,
  AggregateQuery,
  LogCursor,
  LogRecord,
  LogQueryResult,
} from "../domain/log";
import type { LogFilters } from "../domain/log";

/**
 * Persistence seam used by HTTP and background jobs. Implementations must
 * preserve descending `(timestamp, id)` ordering for cursor pagination and
 * treat all filter values as data, never SQL fragments.
 */
export interface LogStore {
  ping(): Promise<void>;
  insertLogs(logs: readonly LogRecord[]): Promise<void>;
  queryLogs(filters: LogFilters, limit: number, cursor: LogCursor | null): Promise<LogQueryResult>;
  aggregateLogs(query: AggregateQuery): Promise<AggregateBucket[]>;
  deleteBefore(cutoff: Date): Promise<number>;
  configureRetention?(retentionDays: number): Promise<void>;
  close?(): Promise<void>;
}
