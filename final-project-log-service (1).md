# Final Project: Log Ingestion & Query Service

## Overview

Build a service that ingests high volumes of structured logs, stores them efficiently, and lets users query and aggregate them. Think of it as a simplified Datadog or Grafana Loki — applications fire logs at your API, and your service makes them searchable and analyzable.

**Timeline:** 1–2 weeks
**Stack:** TypeScript, SQL (PostgreSQL recommended), Docker, GitHub Actions CI/CD

---

## What You're Building

Your service handles three concerns:

1. **Ingestion** — an API that accepts structured log entries (single and batched), validates them, and stores them fast
2. **Querying** — an API to filter logs (by service, level, time range, attributes, message text) and aggregate them (counts over time buckets, grouped by dimensions)
3. **Retention** — old logs don't live forever; a background job enforces a configurable retention policy

A log entry has at minimum: a timestamp, a level (`debug` / `info` / `warn` / `error`), a service name, a message, and a bag of arbitrary key/value attributes (e.g., `user_id`, `request_id`, `region`). How you store that attribute bag is one of the most important decisions you'll make.

This service will be tested **under load**. We will run a load generator against it and measure whether queries stay fast while ingestion is active, at a million-plus rows. Correct-but-slow is not done.

---

## Core Requirements

- Implement the **Required API Contract** below exactly — ingestion with per-entry validation, combinable query filters, time-bucketed aggregation, and cursor pagination
- A retention/rollup job that deletes or compacts logs older than a configurable window — and doesn't block ingestion while running
- Deliberate indexing — you should be able to say which index serves which query, and prove it with `EXPLAIN`
- The full service runs via `docker compose up`
- A GitHub Actions CI/CD pipeline
- A README documenting setup, usage, your schema design, and your measured performance numbers

---

## Required API Contract

We will run a single automated load generator against every submission. It expects the exact endpoints below — same paths, same shapes, no per-project configuration. **You may add any endpoints you like, but these must exist exactly as specified.** If the load generator can't talk to your service, we can't grade it.

Your service must listen on **port 8080** inside the container and expose it as **localhost:8080** in your `docker-compose.yml`.

### `GET /health`

Returns `200` with any body once the service is ready to accept logs (database connected, migrations applied). The load generator polls this before starting.

### `POST /logs` — ingest

Always accepts a batch (a batch of one is fine):

```json
{
  "logs": [
    {
      "timestamp": "2026-07-20T14:32:01.123Z",
      "level": "error",
      "service": "checkout",
      "message": "payment declined",
      "attributes": { "user_id": "42", "region": "eu-west", "retries": 3 }
    }
  ]
}
```

**Entry rules:**
- `timestamp`: ISO 8601 string, required. Reject if unparseable or more than 5 minutes in the future.
- `level`: one of `debug`, `info`, `warn`, `error`. Reject anything else.
- `service`: non-empty string, required.
- `message`: non-empty string, required.
- `attributes`: optional flat object; values are strings, numbers, or booleans. No nested objects.

**Response** — `200` if at least one entry was accepted, `400` if all were rejected or the JSON itself is malformed:

```json
{
  "accepted": 9,
  "rejected": [
    { "index": 3, "reason": "invalid level: 'critical'" }
  ]
}
```

A bad entry never fails the batch — accept the good ones, report the bad ones by their array index.

### `GET /logs` — query

Query parameters, all optional and freely combinable:

| Param | Meaning | Example |
|---|---|---|
| `service` | exact match | `service=checkout` |
| `level` | exact match | `level=error` |
| `since` / `until` | ISO 8601 time range (inclusive since, exclusive until) | `since=2026-07-20T14:00:00Z` |
| `attr.<key>` | attribute equality (compared as strings) | `attr.user_id=42` |
| `q` | case-insensitive substring match on message | `q=declined` |
| `limit` | max results, default 100, cap at 1000 | `limit=500` |
| `cursor` | opaque cursor from a previous response | `cursor=eyJpZCI6...` |

**Response** — `200`, entries sorted by timestamp descending:

```json
{
  "logs": [
    {
      "id": "any-unique-id",
      "timestamp": "2026-07-20T14:32:01.123Z",
      "level": "error",
      "service": "checkout",
      "message": "payment declined",
      "attributes": { "user_id": "42" }
    }
  ],
  "next_cursor": "eyJpZCI6..."
}
```

`next_cursor` is `null` when there are no more results. The cursor format is yours — the generator just passes it back.

Invalid parameters (bad timestamps, `until` before `since`, unknown `level`, non-numeric `limit`) return `400` with `{ "error": "<description>" }`.

### `GET /logs/aggregate` — time-bucketed counts

Query parameters: same filters as `GET /logs` (`service`, `level`, `attr.<key>`, `q`), plus:

| Param | Meaning | Example |
|---|---|---|
| `since` / `until` | **required** time range | |
| `bucket` | bucket size: `1m`, `5m`, `1h`, or `1d` — required | `bucket=1m` |
| `group_by` | optional: `service` or `level` | `group_by=service` |

**Response** — `200`, one row per (bucket, group), ordered by bucket ascending. Empty buckets may be omitted. Without `group_by`, the `group` field is `null`:

```json
{
  "buckets": [
    { "start": "2026-07-20T14:00:00Z", "group": "checkout", "count": 118 },
    { "start": "2026-07-20T14:00:00Z", "group": "auth", "count": 42 },
    { "start": "2026-07-20T14:01:00Z", "group": "checkout", "count": 97 }
  ]
}
```

Everything beyond this contract — retention configuration, extra endpoints, admin APIs, dashboards — is entirely your design.

---

## Performance Targets

We will verify these with our own load generator on grading day:

- Sustain **500 logs/sec** of ingestion without dropped requests or crashes
- The main aggregation query returns in **under 1 second (p95)** with ~1M rows stored, while ingestion is running

Run your own load tests before submitting. Report your numbers in the README — we want to see that you measured, not just hoped.

---

## What We're Looking For

This project is intentionally underspecified. How you fill in the gaps is part of the evaluation.

| Area | What we're looking at |
|---|---|
| **Architecture** | Schema design, attribute storage strategy, sensible project structure |
| **Performance** | Indexes that match your query patterns, behavior under load, retention that doesn't lock things up |
| **Reliability** | Validation, error handling, edge cases — malformed batches, empty ranges, invalid queries |
| **Code Quality** | Readable TypeScript, proper typing, parameterized queries (SQL injection is disqualifying), query-building logic separate from HTTP handlers |
| **Infrastructure** | Docker setup works on first try, migrations run automatically, CI pipeline is meaningful |
| **Documentation** | README is clear, design decisions are explained with reasoning, limitations acknowledged |
| **Creativity & Polish** | What did you add beyond the minimum? How did you make it your own? |

---

## Stretch Goals

- Optional, but a chance to stand out. Prioritize a solid, fast core over half-finished extras.
- Optional, build a dashboard for viewing the logs and other metrics around the logs.
- Extra ideas: alerting rules (fire a webhook when error count crosses a threshold), a live tail endpoint, pre-aggregated rollup tables, a query language, a dashboard UI, multi-tenancy with API keys, compression. Or come up with your own.

---

## Deliverables

1. **GitHub repository** with clean commit history showing incremental progress
2. **Working Docker Compose setup**
3. **Passing CI pipeline**
4. **README** covering setup, API docs, schema/index design decisions, and your load test results
5. **Demo** — be prepared to walk through your project, explain decisions, run `EXPLAIN` on your queries, and answer questions

---

## A Note on AI Usage

You are welcome and expected to use AI tools. We do the same in our daily work. What matters is that you **understand what you've built**. During the demo, we'll ask you to explain your schema, justify your indexes, walk through code paths, and debug or extend a feature live. If you can't explain it, it doesn't count.
