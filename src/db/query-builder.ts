import type { AggregateQuery, LogCursor, LogFilters } from "../domain/log";
import { bucketInterval } from "../domain/query";

export interface SqlQuery {
  text: string;
  values: unknown[];
}

export interface WhereClause {
  text: string;
  values: unknown[];
  nextParameter: number;
}

const escapeLikePattern = (value: string): string => value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");

/** Build only SQL generated from a typed filter object. */
export function buildWhereClause(filters: LogFilters, startParameter = 1): WhereClause {
  const clauses: string[] = [];
  const values: unknown[] = [];
  let nextParameter = startParameter;
  const add = (clause: string, value: unknown): void => {
    clauses.push(clause.replace("?", `$${nextParameter}`));
    values.push(value);
    nextParameter += 1;
  };

  if (filters.service !== undefined) {
    add('"service" = ?', filters.service);
  }
  if (filters.level !== undefined) {
    add('"level" = ?', filters.level);
  }
  if (filters.since !== undefined) {
    add('"timestamp" >= ?::timestamptz', filters.since);
  }
  if (filters.until !== undefined) {
    add('"timestamp" < ?::timestamptz', filters.until);
  }
  for (const [key, value] of Object.entries(filters.attributes ?? {})) {
    // The containment arm is indexable by logs_attributes_gin_idx for the
    // overwhelmingly common case where an attribute was ingested as a JSON
    // string. The ->> arm preserves the API's string comparison semantics
    // for numeric and boolean JSON values.
    clauses.push(
      `(attributes @> jsonb_build_object($${nextParameter}::text, to_jsonb($${nextParameter + 1}::text)) OR (attributes ->> $${nextParameter}::text) = $${nextParameter + 1}::text)`,
    );
    values.push(key, value);
    nextParameter += 2;
  }
  if (filters.query !== undefined && filters.query.length > 0) {
    add('"message" ILIKE (\'%\' || ? || \'%\') ESCAPE \'\\\'', escapeLikePattern(filters.query));
  }

  return {
    text: clauses.length === 0 ? "TRUE" : clauses.join(" AND "),
    values,
    nextParameter,
  };
}

/**
 * Add the cursor predicate after ordinary filters. The pair comparison is
 * what makes equal timestamps deterministic and prevents skipped/duplicated
 * rows while new events are being ingested.
 */
export function addCursorPredicate(where: WhereClause, cursor: LogCursor | null): WhereClause {
  if (cursor === null) {
    return where;
  }
  const timestampParameter = where.nextParameter;
  const idParameter = where.nextParameter + 1;
  return {
    text: `${where.text} AND ("timestamp", "id") < ($${timestampParameter}::timestamptz, $${idParameter}::uuid)`,
    values: [...where.values, cursor.timestamp, cursor.id],
    nextParameter: where.nextParameter + 2,
  };
}

export function buildLogsQuery(filters: LogFilters, limit: number, cursor: LogCursor | null): SqlQuery {
  const where = addCursorPredicate(buildWhereClause(filters), cursor);
  const limitParameter = where.nextParameter;
  return {
    text: `SELECT "id"::text AS "id", "timestamp", "level", "service", "message", "attributes"
FROM "logs"
WHERE ${where.text}
ORDER BY "timestamp" DESC, "id" DESC
LIMIT $${limitParameter}`,
    values: [...where.values, limit + 1],
  };
}

export function buildAggregateQuery(query: AggregateQuery): SqlQuery {
  const where = buildWhereClause(query.filters, 2);
  const intervalParameter = 1;
  const groupSelect = query.groupBy === "service"
    ? '"service"'
    : query.groupBy === "level"
      ? '"level"'
      : "NULL::text";
  const hasGroup = query.groupBy === "service" || query.groupBy === "level";
  const groupBy = hasGroup ? "1, 2" : "1";
  const groupOrder = hasGroup ? ", 2 ASC" : "";
  return {
    text: `SELECT time_bucket($${intervalParameter}::interval, "timestamp") AS "start",
       ${groupSelect} AS "group",
       COUNT(*)::bigint AS "count"
FROM "logs"
WHERE ${where.text}
GROUP BY ${groupBy}
ORDER BY 1 ASC${groupOrder}`,
    values: [bucketInterval(query.bucket), ...where.values],
  };
}
