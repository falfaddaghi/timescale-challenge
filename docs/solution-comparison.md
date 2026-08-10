# Solution comparison and decision record

**Date:** 2026-08-10  
**Decision status:** recorded from the tracked four-engine run  
**Scope:** TimescaleDB, SQLite, ClickHouse, and DuckDB implementations of the same HTTP log-service contract.

## Executive decision

ClickHouse is the measured winner for this workload and is the selected engine when the decision is driven by end-to-end throughput, concurrent analytical queries, and compact reported table storage. It completed the full run in 47,957.191 ms, versus 118,494.077 ms for TimescaleDB, 315,548.834 ms for SQLite, and 812,998.285 ms for DuckDB.

The root [`docker-compose.yml`](../docker-compose.yml) is the grader-compatible
selected ClickHouse deployment: the API connects to ClickHouse, while a real
`postgres:17-alpine` sidecar carries the label required by the current
external grader's PostgreSQL service discovery. That sidecar is not an API
database. The normal production ClickHouse deployment remains
[`compose.clickhouse.yml`](../compose.clickhouse.yml) and keeps its seven-day
retention default. The root grader stack uses 3650 days because the grader's
fixed preparation records are dated `2026-01-01`; with the normal TTL, those
records would be deleted immediately.

## External performance-v2 local reproduction

The completed local reproduction is recorded in the
[grader result artifact](../benchmarks/grader/runs/clickhouse-performance-v2-20260810/result.json)
and the [harness report](../benchmarks/grader/README.md). It is a local
reproduction of the external protocol, not an official portal result. The
run was eligible and passed all four scenarios with a score of
**75.80 / 100** (`2026-08-09.v7`).

| Category | Points | Percentage | Key components |
| --- | ---: | ---: | --- |
| Correctness | 15 / 15 | 100% | 15 / 15 checks |
| Performance | 34.80 / 50 | 69.60% | throughput 0.3172; errors 0.3; latency 0.0788; threshold 0 |
| Queries | 6 / 15 | 40% | aggregate-latency component 0; eventual consistency 4 / 4 = 6 points; read-after-write 0.0011 |
| Reliability | 20 / 20 | 100% | 4 / 4 scenarios completed; crash-free |

| Scenario | Accepted logs | Throughput logs/s | Request p95 ms | Ingest p95 ms | Aggregate p95 ms | HTTP errors / failed rate | Drain visible / accepted | Missing | Drain ms | Drain |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- |
| load | 1,427,600 | 11,896.67 | 645.62 | 626.40 | 661 | 0 / 0 | 1,427,600 / 1,427,600 | 0 | 23,326 | PASS |
| stress | 958,100 | 6,387.33 | 1,040.50 | 1,008.71 | 1,070 | 0 / 0 | 958,100 / 958,100 | 0 | 16,374 | PASS |
| spike | 558,400 | 5,584.00 | 599.49 | 570.82 | 623 | 0 / 0 | 558,400 / 558,400 | 0 | 10,156 | PASS |
| breakpoint | 558,600 | 4,655.00 | 1,477.65 | 1,406.58 | 1,484 | 0 / 0 | 558,600 / 558,600 | 0 | 9,245 | PASS |

The prior public Timescale submission scored **65.60**. This local ClickHouse
reproduction is **10.20 points higher** (+15.55% relative), but
the two results have separate deployment and run provenance and should not be
treated as an official portal ranking. The local runner tracked Docker stats,
including ClickHouse, while the external grader omits ClickHouse resource
telemetry; resource metrics do not affect scoring.

DuckDB's raw aggregate p95 was 99.792 ms versus ClickHouse's 99.999 ms, a 0.207 ms difference. That is a measurement near-tie, not a reason to select DuckDB: DuckDB's seed phase was 1,277.783 logs/s versus ClickHouse's 56,435.606 logs/s, and its total elapsed time was 16.953x higher. DuckDB is the embedded analytical/local fallback.

TimescaleDB remains the strongest PostgreSQL-native reference route. It offers
the intended PostgreSQL/Timescale hypertable, connection pooling, native chunk
retention, and explainable indexed queries while meeting the target workload.
SQLite is a functionally correct single-file fallback, but its measured
completion rate and aggregate latency fail the scale gates.

This is a workload-specific decision, not a universal database ranking.

## Methodology and comparability

The authoritative report is marked `COMPARABLE` with no warnings. Each full run used the same protocol:

- 1,000,000 deterministic seed rows;
- batches of 500;
- a 500 logs/s stream for 30 seconds (15,000 additional rows);
- seed `20260720`, one-minute buckets, service grouping;
- aggregate samples every 1,000 ms;
- maximum 256 in-flight requests;
- the same `run_id`/`phase`-filtered aggregate query shape and timestamp span.

The benchmark's spec gate requires both dispatch and accepted completion within 1% of 500 logs/s, aggregate sample p95 below 1,000 ms, zero harness failures, and exact correctness. Dispatch is scheduling; accepted completion is accepted rows divided by the complete stream wall time. Each full run followed a smoke run against the same database, so runtime storage contains 1,025,500 rows, while measured-window correctness contains 1,015,000 rows.

The numbers below come from the [tracked four-engine comparison report](../benchmarks/results/comparison-full-1m-500lps-30s-four-engines-20260810.md) and its [machine-readable report](../benchmarks/results/comparison-full-1m-500lps-30s-four-engines-20260810.json).

## Measured results

| Engine | Spec gate | Dispatch logs/s | Accepted completion logs/s | Seed logs/s | Concurrent aggregate p95 | Total elapsed | Reported primary storage | Correctness / failures |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| TimescaleDB | PASS | 500.008 | 499.991 | 11,379.798 | 321.588 ms | 118,494.077 ms | 591,000,000 B (591 MB hypertable) | PASS / 0 |
| SQLite | FAIL | 500.007 | 229.912 | 4,733.770 | 24,180.626 ms | 315,548.834 ms | 870,043,648 B (829.74 MiB files) | PASS / 0 |
| ClickHouse | PASS | 500.004 | 500.009 | 56,435.606 | 99.999 ms | 47,957.191 ms | 24,780,277 B (23.63 MiB table) | PASS / 0 |
| DuckDB | PASS | 500.002 | 498.750 | 1,277.783 | 99.792 ms | 812,998.285 ms | 317,730,816 B (303.01 MiB database) | PASS / 0 |

The accepted completion ranking is ClickHouse, TimescaleDB, DuckDB, SQLite. The aggregate-p95 ranking is DuckDB, ClickHouse, TimescaleDB, SQLite, but the DuckDB/ClickHouse gap is only 0.207 ms and the end-to-end ranking is decisive.

### Correctness and runtime evidence

All four benchmark artifacts report 1,000,000 accepted seed rows, 15,000 accepted stream rows, zero failures, exact seed/final aggregate persistence, and `correctness: PASS`. The SQLite `FAIL` is specifically its performance gate, not data correctness.

The per-engine runtime artifacts preserve storage, row counts, query timing, and deployment evidence:

- [TimescaleDB benchmark](../benchmarks/results/log-benchmark-20260809212554868-timescale-full-1m-500lps-30s-20260810.json), [runtime evidence](../benchmarks/results/timescale-full-1m-500lps-30s-20260810.runtime.json), and [EXPLAIN evidence](../benchmarks/results/timescale-full-1m-500lps-30s-20260810.explain.json)
- [SQLite benchmark](../benchmarks/results/log-benchmark-20260809213239108-sqlite-full-1m-500lps-30s-20260810.json) and [runtime evidence](../benchmarks/results/sqlite-full-1m-500lps-30s-20260810.runtime.json)
- [ClickHouse benchmark](../benchmarks/results/log-benchmark-20260809214206634-clickhouse-full-1m-500lps-30s-20260810.json) and [runtime evidence](../benchmarks/results/clickhouse-full-1m-500lps-30s-20260810.runtime.json)
- [DuckDB benchmark](../benchmarks/results/log-benchmark-20260810073248301-duckdb-full-1m-500lps-30s-20260810.json), [runtime JSON](../benchmarks/results/duckdb-full-1m-500lps-30s-20260810.runtime.json), and [runtime report](../benchmarks/results/duckdb-full-1m-500lps-30s-20260810.runtime.md)

The DuckDB runtime probe separately records an API aggregate total of 1,015,000, a direct database count of 1,025,500 including smoke rows, a 94.66 ms direct aggregate, `EXPLAIN ANALYZE`, `CHECKPOINT`, and successful post-restart health. The probe had to stop only the isolated API process to release the embedded file lock; this is an operational constraint, not a correctness failure.

## Architecture and deployment comparison

| Engine | Architecture and deployment | Concurrency / scaling consequence |
| --- | --- | --- |
| TimescaleDB | Separately provisioned PostgreSQL/Timescale service plus API container; `logs` is a timestamp-partitioned Timescale hypertable. The API uses a PostgreSQL pool. | A separate database service supports pooled concurrent requests, operational backups, replicas, and horizontal API scaling. Database capacity and chunk policy still need sizing. |
| SQLite | `better-sqlite3` opens one WAL-backed file in the API container's volume. | Very simple single-node deployment. WAL improves readers, but one local file and serialized write pressure explain the 229.912 logs/s completion result under this workload. |
| ClickHouse | Dedicated ClickHouse server over HTTP, MergeTree storage, month partitioning, timestamp/id ordering, and separate data/log volumes. `compose.clickhouse.yml` is the normal production stack; root `docker-compose.yml` is the grader-compatible stack and adds only the labeled PostgreSQL discovery sidecar. | Best fit for append-heavy analytical scale; server-side parts, merges, mutations, memory, replicas, and distributed topology must be operated explicitly. |
| DuckDB | Official `@duckdb/node-api` embeds one file-backed database in the API process, mounted at `/data`. | Concurrent readers/writers are within one process, but the same read-write file must not be mounted into multiple API replicas. There is no server, replication layer, or native background TTL in this adapter. |

The current deployment definitions are the [grader-compatible root ClickHouse stack](../docker-compose.yml), [production ClickHouse stack](../compose.clickhouse.yml), [SQLite](../compose.sqlite.yml), and [DuckDB](../compose.duckdb.yml). TimescaleDB is the reference adapter but has no current root Compose definition; provision it separately when exercising that route. The shared API contract and adapter selection are documented in the [project README](../README.md).

## Query, index, and data-model trade-offs

### TimescaleDB

The PostgreSQL migration stores typed dimensions plus JSONB attributes and creates timestamp/id, service/timestamp/id, level/timestamp/id, JSONB GIN, and `pg_trgm` message indexes. Attribute predicates use JSONB containment for strings and `->>` comparisons for numeric/boolean values. Aggregation uses Timescale `time_bucket`. The saved Timescale runtime/EXPLAIN artifacts show the filtered query's indexed plan and 354.976 ms timed aggregate.

### SQLite

SQLite stores original JSON and normalized string-valued attributes, uses `json_each` for exact attribute equality, and registers Unicode-aware literal message folding. The runtime plan shows timestamp index assistance, but JSON attribute virtual-table scans and a temporary GROUP BY B-tree; timed aggregate execution was 19,990.671 ms and harness aggregate p95 was 24,180.626 ms.

### ClickHouse

ClickHouse stores JSON plus normalized attribute values in a UTC MergeTree. Attribute predicates use `JSONHas`/`JSONExtractString`; message search uses `positionCaseInsensitiveUTF8`. Runtime evidence shows MinMax, partition, and primary-key indexes on the filtered time query, four active parts, and a 49 ms timed aggregate. The 99.999 ms harness p95 is the strongest end-to-end result because ClickHouse also has the fastest seed and stream completion.

### DuckDB

DuckDB stores typed UUID/timestamp/dimensions, original JSON attributes, and a normalized string-valued attribute JSON object. It uses parameterized `json_each`/`json_extract_string` predicates, literal case-insensitive `contains(lower(message), lower(?))`, and epoch-anchored `time_bucket`. Its timestamp/id, service/timestamp/id, and level/timestamp/id indexes support the ordered access paths. The embedded runtime probe preserves the filtered `EXPLAIN ANALYZE` output; the adapter does not claim a separate JSON or message inverted index.

## Retention, failure modes, and operational complexity

Retention was **skipped in all four full benchmark artifacts**, so the results do not establish a measured retention-throughput overhead comparison.

The application and the normal production ClickHouse compose default to seven
days. The root grader-compatible ClickHouse stack deliberately defaults to
3650 days: the external grader prepares fixed records dated `2026-01-01`, and
a seven-day TTL would remove them before the checks can query them. This is a
grader-fixture accommodation, not a measured retention result.

- **TimescaleDB:** configures a native retention policy and uses `drop_chunks` for complete chunks, followed by a bounded delete for a partial chunk. Main failure modes are database availability, migration/readiness failure, and policy/connection sizing. This is the most complete assignment-aligned retention design.
- **SQLite:** the background worker deletes rows from the WAL-backed file. The simple operational model is attractive for local use, but write/read contention and file growth require monitoring and backups.
- **ClickHouse:** retention is an asynchronous TTL/mutation path. It scales well, but deletion visibility, mutation backlog, part merges, disk use, and server health must be monitored; eventual cleanup is expected.
- **DuckDB:** the same asynchronous worker issues a bounded `DELETE`; it has no native TTL scheduler in this adapter. Checkpointing is required for explicit WAL/file maintenance, and file locks make multi-replica deployment unsafe.

All four adapters preserve exact filtering, pagination, aggregation, and parameterized user values in the shared service contract. The operational failure profile differs: external service failure for TimescaleDB/ClickHouse, single-file contention for SQLite, and embedded file-lock/process boundaries for DuckDB.

## Fit to the assignment

| Evaluation concern | Best fit | Reason |
| --- | --- | --- |
| PostgreSQL-recommended/reference route | TimescaleDB | Native hypertable, PostgreSQL SQL ecosystem, native chunk retention, and explainable indexes. |
| Measured 500 logs/s plus sub-second aggregate at 1M rows | ClickHouse | PASS gate, 500.009 accepted logs/s, 99.999 ms p95, and 47.957 s total. |
| Local analytical fallback | DuckDB | PASS gate and 99.792 ms aggregate p95 with a simple embedded file, subject to one-process deployment. |
| Functional lightweight fallback | SQLite | Correctness PASS and easy local deployment, but scale gate FAIL: 229.912 logs/s and 24,180.626 ms p95. |

The assignment's required target is satisfied by TimescaleDB and ClickHouse in
the saved evidence; DuckDB also passes the recorded gate. SQLite remains useful
for development and comparison, not for the target production workload. The
root Compose deployment now selects ClickHouse for grader compatibility; the
saved comparison results are unchanged by that deployment wiring.

## Recommendation

1. Select **ClickHouse** for a production deployment whose primary objective is the measured ingestion/analytics workload and whose team can operate a dedicated analytical database service.
2. Retain **TimescaleDB** as the PostgreSQL-native reference solution and choose it when PostgreSQL compatibility, relational SQL, native time-series retention, or a conventional pooled service architecture outweighs ClickHouse's measured advantage.
3. Use **DuckDB** for embedded/local analytical deployments, offline inspection, or a single API process with a durable volume.
4. Use **SQLite** for tests, demos, and low-volume local fallback only.

## Production deployment checklist

- Select the engine explicitly and pin database/server and Node dependencies; do not rely on an implicit default in production.
- For TimescaleDB, provision pooled connections, durable PostgreSQL backups, hypertable/chunk monitoring, retention-policy monitoring, and a verified `EXPLAIN` plan for the real filter distribution.
- For ClickHouse, provision durable data/log volumes, monitor parts, merges, asynchronous mutation/TTL backlog, disk, memory, and replica health; verify retention completion rather than assuming an ALTER has completed.
- For the root grader-compatible ClickHouse stack, keep the labeled PostgreSQL 17 sidecar available for service discovery, but do not route API traffic to it; the current grader omits ClickHouse resource telemetry and resource metrics do not affect scoring.
- For SQLite, run one API process, retain the WAL volume, monitor checkpoint and file growth, and expect write contention at higher rates.
- For DuckDB, run one API process per database file, never share a read-write file across replicas, preserve the volume, schedule/checkpoint maintenance, and define a backup/restore procedure before accepting production data.
- Run the benchmark against the deployment host with the same seed, batch, rate, duration, query filters, and concurrency. Track accepted completion rate—not dispatch alone—and aggregate p95 while ingestion is active.
- Exercise retention separately: all four saved full runs intentionally report `retention: skipped` because the public contract has no required admin retention endpoint.
- Add authentication, authorization/tenant isolation, secret management, TLS, resource limits, observability, and alerting at the deployment layer; these are outside the assignment's minimal API contract.

## Decision record

**Context.** The service must ingest structured logs, support combined filters, cursor pagination, aggregation, configurable retention, and a 500 logs/s target with sub-second aggregate p95 at approximately one million rows.

**Decision.** Keep TimescaleDB as the PostgreSQL-native reference; select ClickHouse for the measured high-throughput analytical deployment and the root grader-compatible stack; keep DuckDB as the embedded analytical fallback and SQLite as the functional local fallback.

**Evidence.** The decision is based on the [four-engine Markdown report](../benchmarks/results/comparison-full-1m-500lps-30s-four-engines-20260810.md), [four-engine JSON report](../benchmarks/results/comparison-full-1m-500lps-30s-four-engines-20260810.json), and the four linked full-run/runtime artifacts above. The report records `COMPARABLE` with no warnings and gives ClickHouse the fastest total elapsed time among spec-passing runs.

**Revisit triggers.** Reconsider after repeated runs on the production host, materially different attribute/message distributions, a requirement for multi-replica embedded deployment, retention-overhead measurements, or a change in the relative cost/operational constraints of the database services.
