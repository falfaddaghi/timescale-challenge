# Structured Log Ingestion and Query Service

This service accepts structured application logs, stores them behind a small
adapter contract, and exposes filtering, cursor pagination, and time-bucketed
aggregation. The production/default backend is TimescaleDB. SQLite,
ClickHouse, and DuckDB implementations use the same HTTP API and are useful
for local development and engine comparisons.

## Quick start

The default stack is TimescaleDB plus the API. It listens on
`http://localhost:8080`:

```sh
cp .env.example .env
docker compose up --build
curl http://localhost:8080/health
```

The API container listens on port `8080` by default. Change the host-side
port without changing the container with `API_HOST_PORT=18080 docker compose
up --build`. `API_PORT` is also configurable when a deployment needs the
service to listen on a different container port; the compose mapping follows
that value.

Alternative backends launch the same API and contract:

```sh
# SQLite, with data in the sqlite-data volume (host port 8081)
docker compose -f compose.sqlite.yml up --build

# ClickHouse, with the HTTP API on its own internal network (host port 8082)
docker compose -f compose.clickhouse.yml up --build

# DuckDB, with an embedded database file in the duckdb-data volume (host port 8083)
docker compose -f compose.duckdb.yml up --build
```

The TimescaleDB compose file defaults to host port 8080; the SQLite and
ClickHouse variants default to 8081 and 8082, and DuckDB defaults to 8083.
Every API container still listens on port 8080 by default. Set
`API_HOST_PORT` when running more than one variant at once. The backend is
selected with `DB_ENGINE=timescale|sqlite|clickhouse|duckdb`; `timescaledb`
remains accepted as a compatibility alias.

As an environment audit note, ClickHouse was identified as the likely
forgotten local time-series database (not certain): multiple cached
ClickHouse server images were present, while no other local time-series
database installation or artifact was found.

For local development without Docker:

```sh
npm ci
npm test
npm run lint
npm run build

# The migration command uses DB_ENGINE and the same URLs as the server.
DB_ENGINE=sqlite SQLITE_PATH=./data/logs.sqlite npm run db:migrate
DB_ENGINE=sqlite SQLITE_PATH=./data/logs.sqlite API_PORT=8080 npm start

# DuckDB uses the same migration and server entry points.
DB_ENGINE=duckdb DUCKDB_PATH=./data/logs.duckdb npm run db:migrate
DB_ENGINE=duckdb DUCKDB_PATH=./data/logs.duckdb API_PORT=8080 npm start
```

## API contract

### `GET /health`

Returns `200` with `{ "status": "ok" }` after the selected database is
reachable and its migrations have been applied. It returns `503` while the
server is starting or the database is unavailable.

### `POST /logs`

The endpoint always accepts a batch. A valid entry has an ISO-8601
`timestamp`, a `level` of `debug`, `info`, `warn`, or `error`, non-empty
`service` and `message` strings, and an optional flat `attributes` object
whose values are strings, numbers, or booleans.

```sh
curl -X POST http://localhost:8080/logs \
  -H 'content-type: application/json' \
  -d '{"logs":[{"timestamp":"2026-07-20T14:32:01.123Z","level":"error","service":"checkout","message":"payment declined","attributes":{"user_id":"42","region":"eu-west","retries":3}}]}'
```

The timestamp cannot be more than five minutes in the future. Invalid entries
do not poison a batch:

```json
{
  "accepted": 1,
  "rejected": [{ "index": 3, "reason": "invalid level: 'critical'" }]
}
```

The response is `200` when at least one entry was accepted and `400` when all
entries were rejected or the JSON/body shape is invalid.

### `GET /logs`

All filters are optional and can be combined:

| Parameter | Semantics |
| --- | --- |
| `service` | exact service match |
| `level` | exact `debug`, `info`, `warn`, or `error` match |
| `since` / `until` | inclusive lower bound / exclusive upper bound ISO timestamps |
| `attr.<key>` | attribute equality compared using its textual value |
| `q` | case-insensitive literal substring of `message` |
| `limit` | default 100, capped at 1000 |
| `cursor` | opaque cursor returned by the previous response |

Results are ordered by `timestamp DESC, id DESC`, so equal timestamps remain
stable while ingestion continues:

```json
{
  "logs": [],
  "next_cursor": null
}
```

The cursor is a URL-safe, base64-encoded versioned pair of the final row's
timestamp and UUID. Clients must treat it as opaque.

### `GET /logs/aggregate`

This route accepts the same `service`, `level`, `attr.<key>`, and `q` filters;
`since`, `until`, and `bucket` are required. `bucket` is one of `1m`, `5m`,
`1h`, or `1d`. Optional `group_by` is `service` or `level`.

```sh
curl 'http://localhost:8080/logs/aggregate?since=2026-07-20T14:00:00Z&until=2026-07-20T15:00:00Z&bucket=5m&group_by=service'
```

The response is ordered by bucket start ascending and omits empty buckets:

```json
{
  "buckets": [
    { "start": "2026-07-20T14:00:00.000Z", "group": "checkout", "count": 118 }
  ]
}
```

Malformed timestamps, ranges where `until` is before `since`, unsupported
levels/buckets/groups, malformed cursors, and non-numeric limits return
`400 { "error": "..." }`.

## Storage and query design

The shared `LogStore` interface (`src/db/store.ts`) keeps HTTP and retention
logic independent of a database vendor. Every adapter implements `ping`,
`migrate`, batch `insertLogs`, filtered `queryLogs`, `aggregateLogs`,
`deleteBefore`, and `close`.

### TimescaleDB (default)

`logs` is a Timescale hypertable partitioned by the event `timestamp`. The
event UUID plus timestamp makes a legal hypertable uniqueness index and gives
the cursor a deterministic tie-breaker. The migration creates:

- `(timestamp DESC, id DESC)` for the unfiltered time-ordered query;
- `(service, timestamp DESC, id DESC)` and `(level, timestamp DESC, id DESC)`
  for the common exact-dimension queries;
- a JSONB GIN index for string attribute containment;
- a `pg_trgm` message GIN index for substring search.

Attribute predicates use a GIN-indexable JSONB containment arm for string
values and a `jsonb ->>` arm for numeric/boolean values. All values, keys,
limits, timestamps, and cursor values are bound parameters; group names are
allowlisted before entering SQL. Aggregation uses Timescale `time_bucket`.

To inspect the chosen plan against a running default stack:

```sh
docker compose exec timescaledb psql -U postgres -d logs -c \
  "EXPLAIN (ANALYZE, BUFFERS) SELECT id, timestamp, service FROM logs WHERE service = 'checkout' AND timestamp >= now() - interval '1 hour' ORDER BY timestamp DESC, id DESC LIMIT 100;"
```

The service query builder emits the equivalent parameterized predicates; the
literal command above is only an operator inspection query.

### SQLite, ClickHouse, and DuckDB

SQLite stores both the original JSON attributes and a normalized string-valued
`attribute_values` JSON object. It uses WAL mode, covering time/service/level
indexes, and `json_each` for exact attribute comparisons. Its migration lives
at `migrations/sqlite/001_logs.sql`.

ClickHouse stores JSON plus normalized attribute values in a UTC MergeTree
partitioned by month and ordered by `(timestamp, id)`. Its migration is
`migrations/clickhouse/001_logs.sql`; parameterized ClickHouse query settings
are used for filters and cursor values.

DuckDB is an embedded, file-backed adapter using the official
`@duckdb/node-api` package pinned to `1.5.5-r.3`. Its migration creates a typed
`logs` table with UUID, `TIMESTAMPTZ`, scalar dimensions, original JSON
`attributes`, normalized string-valued `attribute_values`, and `created_at`.
Timestamp/id, service/timestamp/id, and level/timestamp/id indexes support the
ordered query paths. Attribute filters use parameterized `json_each`/
`json_extract_string` predicates; message search uses a parameterized literal
`contains(lower(message), lower(?))`; aggregates use an epoch-anchored
`time_bucket` with allowlisted bucket and group expressions. User-controlled
values remain bound parameters.

This adapter deliberately runs one API process against one DuckDB file. The
[official DuckDB concurrency model](https://duckdb.org/docs/current/connect/concurrency)
supports concurrent readers/writers within a single process, but read/write
access to a native database file from multiple API processes is not the stable
deployment model; file locks are part of the contract. Do not mount the same
read-write `.duckdb` file into multiple API replicas. The runtime probe had to
stop only the isolated API to release that file lock before direct SQL,
`EXPLAIN`, and `CHECKPOINT` inspection; this was an operational constraint,
not a correctness failure.

Primary references for the implementation are the
[DuckDB Node.js (Neo) client guide](https://duckdb.org/docs/lts/clients/node_neo/overview),
the [`@duckdb/node-api` package](https://www.npmjs.com/package/@duckdb/node-api),
the [DuckDB Node client source](https://github.com/duckdb/duckdb-node), and the
[`CHECKPOINT` statement](https://duckdb.org/docs/current/sql/statements/checkpoint).

## Retention and readiness

Startup applies migrations before marking `/health` ready. A
`RetentionWorker` runs out of band every `RETENTION_INTERVAL_MS` (one hour by
default) and removes rows older than `RETENTION_DAYS` (seven by default).

The Timescale adapter configures a native retention policy and uses
`drop_chunks` for complete chunks, followed by a bounded delete for a partial
chunk. SQLite performs its delete in the background worker. ClickHouse uses
an asynchronous `ALTER TABLE ... DELETE` mutation after counting the affected
rows. Cleanup is never awaited by ingestion requests; ClickHouse mutations
and chunk drops are therefore eventually consistent with respect to the
retention cutoff. DuckDB has no native background TTL in this adapter: the
same `RetentionWorker` issues a bounded `DELETE` in the API process, and
`CHECKPOINT` is the explicit mechanism used to synchronize the WAL during
maintenance/probing.

Relevant configuration:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DB_ENGINE` | `timescale` | `timescale`, `sqlite`, `clickhouse`, or `duckdb` |
| `DATABASE_URL` | Timescale service URL | backend URL when one URL is sufficient |
| `API_HOST` | `0.0.0.0` | bind address |
| `API_PORT` | `8080` | port inside the API container |
| `API_HOST_PORT` | `8080` (Timescale; 8081/8082/8083 in alternate files) | host port used by compose files |
| `TIMESCALE_HOST_PORT` | `5432` | optional host port for the Timescale service |
| `SQLITE_PATH` | `/data/logs.sqlite` | SQLite database path |
| `DUCKDB_PATH` | `/data/logs.duckdb` | DuckDB database path |
| `CLICKHOUSE_URL` | `http://clickhouse:8123` | ClickHouse HTTP endpoint |
| `CLICKHOUSE_DATABASE` | URL path or unset | ClickHouse database |
| `RETENTION_DAYS` | `7` | retention window |
| `RETENTION_INTERVAL_MS` | `3600000` | cleanup cadence |
| `DB_POOL_MAX` | `20` | Timescale connection pool size |

## Benchmarking

The benchmark harness never starts or stops the service. The authoritative
comparison was run with the same protocol for all four adapters:

| Setting | Value |
| --- | --- |
| Seed rows | 1,000,000 |
| Batch size | 500 |
| Concurrent stream | 500 logs/s for 30 seconds (15,000 rows) |
| Seed | `20260720` |
| Aggregate | `1m`, grouped by `service`, sampled every 1 second |
| Aggregate filters | `attr.run_id` and `attr.phase=seed` during the stream; `attr.run_id` for final verification |
| Concurrency | 256 maximum in-flight requests |
| Timestamp window | 60 seconds, base age 10 minutes |

The generated comparison is `COMPARABLE` with no warnings. The spec gate is
defined as both dispatch and accepted completion within +/-1% of 500 logs/s,
aggregate sample p95 below 1,000 ms, zero harness failures, and correctness
PASS. Dispatch rate alone is not sufficient.

### Full-run results

| Engine | Spec gate | Dispatch logs/s | Accepted completion logs/s | Aggregate p95 | Ingest p95 | Total elapsed | Table/storage size |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| TimescaleDB | PASS | 500.008 | 499.991 | 321.588 ms | 121.303 ms | 118.494 s | 591 MB hypertable |
| ClickHouse | PASS | 500.004 | 500.009 | **99.999 ms** | **10.949 ms** | **47.957 s** | **23.63 MiB table** |
| DuckDB | PASS | 500.002 | 498.750 | **99.792 ms** | 428.844 ms | 812.998 s | 303.01 MiB database |
| SQLite | **FAIL** | 500.007 | **229.912** | **24,180.626 ms** | 220.773 ms | 315.549 s | 829.74 MiB files |

All four runs accepted exactly 1,000,000 seed rows plus 15,000 stream rows,
reported zero request failures/rejections, and passed exact seed/final
aggregate persistence checks. DuckDB therefore passes the workload spec gate.
SQLite is functionally correct but does not meet the 500 logs/s or sub-second
aggregate scale gates.

ClickHouse is the measured winner: its aggregate p95 is 0.311x TimescaleDB
(69% lower), seed throughput is 4.959x, and total elapsed time is 0.405x
(2.47x faster). TimescaleDB remains the default assignment solution because it
provides the intended PostgreSQL/Timescale hypertable, SQL ecosystem, native
chunk retention, and a comfortable 321.588 ms aggregate p95 while sustaining
the target. SQLite is a useful single-file/local fallback, not a production
choice for this workload: its completion rate is 0.46x TimescaleDB and its
aggregate p95 is 75.191x slower.

DuckDB's raw aggregate p95 is 99.792 ms versus ClickHouse's 99.999 ms, a
0.207 ms difference treated as effectively tied/noise without repeated runs.
That near-tie does not change the whole-workload result: ClickHouse completed
the run in 47.957 s versus DuckDB's 812.998 s, with seed throughput of
56,435.606 versus 1,277.783 logs/s and primary storage of 23.63 MiB versus
303.01 MiB. The comparison ratios are DuckDB/ClickHouse: 0.998x aggregate
p95, 16.953x total elapsed, 0.023x seed throughput, and 12.822x storage.

The measured rows and stored rows intentionally differ. Each full run followed
a smoke run against the same database. The smoke run contributes 10,500 rows,
so runtime storage reports **1,025,500 stored rows**, while the run-specific
`run_id` fields and the comparison table measure exactly **1,015,000 rows**
(1,000,000 seed + 15,000 stream). This is isolation metadata, not an
ingestion discrepancy.

Runtime tradeoffs are also different. The TimescaleDB container used a 1.238
GiB memory snapshot and the hypertable occupied 591 MB; its EXPLAIN ran with
three planned/launched workers, 26,993 shared-hit blocks, zero shared reads,
and 354.976 ms PostgreSQL execution time. ClickHouse used a 397.8 MiB
container snapshot, four MergeTree parts, and a 49 ms timed aggregate; its
MinMax, partition, and primary-key indexes were visible in the runtime plan.
SQLite used a WAL-backed file and an index-assisted timestamp range, but its
JSON attribute scans and temporary GROUP BY B-tree drove a 19,990.671 ms
timed aggregate. ClickHouse's TTL and mutations are asynchronous; Timescale
chunk policies are operationally richer; SQLite is simplest to run but has
single-file write/read contention. DuckDB's embedded file keeps deployment
simple and has strong analytical execution, but its one-process write/file-lock
boundary and much slower 1M-row seed phase make it a local analytical fallback,
not the production default for this ingestion workload.

These are directional measurements, not isolated hardware guarantees. All
runs were on the current `pop-os` host (Linux 6.17.9, AMD Ryzen 9 7900X3D,
24 logical CPUs, Node v24.13.1, approximately 125 GiB RAM), with starting
load averages from 3.17 to 5.37, starting free memory from roughly 8.3 to
10.0 GiB, and no CPU/memory limits on the containers. CPU frequency and other
host workloads varied between runs; repeat the protocol on the deployment
host before treating the numbers as capacity commitments.

The comparison report and runtime evidence are checked in:

- [generated comparison](benchmarks/results/comparison-full-1m-500lps-30s-20260810.md)
- [Timescale benchmark](benchmarks/results/log-benchmark-20260809212554868-timescale-full-1m-500lps-30s-20260810.json)
- [Timescale runtime and EXPLAIN](benchmarks/results/timescale-full-1m-500lps-30s-20260810.runtime.json), [EXPLAIN JSON](benchmarks/results/timescale-full-1m-500lps-30s-20260810.explain.json)
- [SQLite benchmark and runtime](benchmarks/results/log-benchmark-20260809213239108-sqlite-full-1m-500lps-30s-20260810.json), [runtime evidence](benchmarks/results/sqlite-full-1m-500lps-30s-20260810.runtime.json)
- [ClickHouse benchmark and runtime](benchmarks/results/log-benchmark-20260809214206634-clickhouse-full-1m-500lps-30s-20260810.json), [runtime evidence](benchmarks/results/clickhouse-full-1m-500lps-30s-20260810.runtime.json)
- [DuckDB benchmark](benchmarks/results/log-benchmark-20260810073248301-duckdb-full-1m-500lps-30s-20260810.json), [runtime JSON](benchmarks/results/duckdb-full-1m-500lps-30s-20260810.runtime.json), [runtime report](benchmarks/results/duckdb-full-1m-500lps-30s-20260810.runtime.md)
- [Four-engine comparison](benchmarks/results/comparison-full-1m-500lps-30s-four-engines-20260810.md), [comparison JSON](benchmarks/results/comparison-full-1m-500lps-30s-four-engines-20260810.json)

### Reproduce the comparison

Run the smoke phase before the full phase, preserve the same database for both,
and use a unique project/run ID per engine. The commands below reproduce the
recorded protocol; change host ports if another service is using them.

```sh
# TimescaleDB (the default assignment stack)
API_HOST_PORT=18080 TIMESCALE_HOST_PORT=15432 \
  docker compose -p timescale-bench-20260810 up -d --build
node benchmarks/bench.mjs --smoke --url http://127.0.0.1:18080 \
  --engine timescale --run-id timescale-smoke-20260810
node benchmarks/bench.mjs --url http://127.0.0.1:18080 \
  --engine timescale --rows 1000000 --batch-size 500 --duration 30 --rate 500 \
  --seed 20260720 --sample-interval-ms 1000 --bucket 1m --max-in-flight 256 \
  --base-age-ms 600000 --timestamp-span-ms 60000 --timeout-ms 30000 \
  --health-timeout-ms 30000 --run-id timescale-full-1m-500lps-30s-20260810 \
  --output-dir benchmarks/results
docker compose -p timescale-bench-20260810 down -v

# SQLite fallback
API_HOST_PORT=18081 docker compose -p timescale-challenge-sqlite-full \
  -f compose.sqlite.yml up -d --build
node benchmarks/bench.mjs --smoke --url http://127.0.0.1:18081 \
  --engine sqlite --run-id sqlite-smoke-20260810
node benchmarks/bench.mjs --url http://127.0.0.1:18081 \
  --engine sqlite --rows 1000000 --batch-size 500 --duration 30 --rate 500 \
  --seed 20260720 --sample-interval-ms 1000 --bucket 1m --max-in-flight 256 \
  --base-age-ms 600000 --timestamp-span-ms 60000 --timeout-ms 30000 \
  --health-timeout-ms 30000 --run-id sqlite-full-1m-500lps-30s-20260810 \
  --output-dir benchmarks/results
docker compose -p timescale-challenge-sqlite-full -f compose.sqlite.yml down -v

# ClickHouse comparison
API_HOST_PORT=18082 CLICKHOUSE_HTTP_PORT=18182 CLICKHOUSE_NATIVE_PORT=19182 \
  docker compose -p timescale-challenge-clickhouse-full \
  -f compose.clickhouse.yml up -d --build
node benchmarks/bench.mjs --smoke --url http://127.0.0.1:18082 \
  --engine clickhouse --run-id clickhouse-smoke-20260810
node benchmarks/bench.mjs --url http://127.0.0.1:18082 \
  --engine clickhouse --rows 1000000 --batch-size 500 --duration 30 --rate 500 \
  --seed 20260720 --sample-interval-ms 1000 --bucket 1m --max-in-flight 256 \
  --base-age-ms 600000 --timestamp-span-ms 60000 --timeout-ms 30000 \
  --health-timeout-ms 30000 --run-id clickhouse-full-1m-500lps-30s-20260810 \
  --output-dir benchmarks/results
docker compose -p timescale-challenge-clickhouse-full \
  -f compose.clickhouse.yml down -v

# DuckDB embedded comparison
API_HOST_PORT=18083 docker compose -p timescale-duckdb-full-20260810 \
  -f compose.duckdb.yml up -d --build
node benchmarks/bench.mjs --smoke --url http://127.0.0.1:18083 \
  --engine duckdb --run-id duckdb-smoke-20260810
node benchmarks/bench.mjs --url http://127.0.0.1:18083 \
  --engine duckdb --rows 1000000 --batch-size 500 --duration 30 --rate 500 \
  --seed 20260720 --sample-interval-ms 1000 --bucket 1m --max-in-flight 256 \
  --base-age-ms 600000 --timestamp-span-ms 60000 --timeout-ms 30000 \
  --health-timeout-ms 30000 --run-id duckdb-full-1m-500lps-30s-20260810 \
  --output-dir benchmarks/results
docker compose -p timescale-duckdb-full-20260810 \
  -f compose.duckdb.yml down -v --remove-orphans

# Compare the four full artifacts, not smoke artifacts.
node benchmarks/compare.mjs \
  benchmarks/results/log-benchmark-20260809212554868-timescale-full-1m-500lps-30s-20260810.json \
  benchmarks/results/log-benchmark-20260809213239108-sqlite-full-1m-500lps-30s-20260810.json \
  benchmarks/results/log-benchmark-20260809214206634-clickhouse-full-1m-500lps-30s-20260810.json \
  benchmarks/results/log-benchmark-20260810073248301-duckdb-full-1m-500lps-30s-20260810.json \
  --format markdown --output benchmarks/results/comparison-full-1m-500lps-30s-four-engines-20260810.md
```

Each run writes a timestamped JSON artifact under `benchmarks/results/` with
ingestion p50/p95/p99, aggregate p50/p95/p99, correctness checks, accepted
rows, and stream-rate drift. Keep the generated artifacts with the submission
so measured rows can be distinguished from smoke rows and the exact host
conditions can be audited.

## Limitations and operational notes

- There is no authentication, tenant isolation, alerting, or dashboard.
- The required API exposes literal substring search, not ranked full-text
  search or a query language.
- ClickHouse retention is an asynchronous mutation and can lag the configured
  cutoff; Timescale chunk retention removes complete chunks first.
- DuckDB is an embedded single-process/file-lock deployment; do not share one
  read-write database file across API replicas. Its retention worker issues
  deletes in-process and requires checkpoint/maintenance policy for file-size
  reclamation.
- Attribute keys are intentionally unbounded JSON keys. High-cardinality
  workloads should benchmark their own key distribution and may need a
  dedicated indexed attribute table.
- The service uses one process and one local database endpoint per compose
  stack; replication, backups, and horizontal ingestion fan-out belong in the
  deployment layer.
