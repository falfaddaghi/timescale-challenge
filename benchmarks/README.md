# HTTP benchmark harness

`bench.mjs` is a deterministic, engine-neutral load generator for the HTTP
contract in the project specification. It uses only Node.js built-ins and
does not start, stop, restart, or configure the service under test. Engine
labels are explicit and may be `timescaledb`/`timescale`, `sqlite`,
`clickhouse`, or `duckdb` (the comparator remains engine-neutral).

Every run requires an explicit `--engine` label. This prevents a result from
being silently misidentified when comparing TimescaleDB, SQLite, and
ClickHouse runs.

Node.js 20 or newer is required (`fetch()` and `AbortSignal.timeout()` are
used, matching the repository engine requirement). The local checks run
without a reachable service:

```sh
node --check benchmarks/bench.mjs
node benchmarks/bench.mjs --self-check
node --check benchmarks/compare.mjs
node benchmarks/compare.mjs --self-check
```

## Run a benchmark

The default run is intentionally the grading-shaped workload:

```sh
node benchmarks/bench.mjs \
  --url http://localhost:8080 \
  --engine timescaledb
```

It performs these phases in order:

1. Poll `GET /health` until it returns `200`.
2. POST exactly `1,000,000` valid seed rows to `/logs`, in batches of 500 by
   default.
3. Verify persistence through `GET /logs/aggregate` and `GET /logs`.
4. Send exactly `floor(rate * duration)` additional rows while sampling a
   predeclared aggregate query. Defaults are 500 logs/s for 30 seconds.
5. Wait for all requests, then verify the final aggregate and `/logs` read.
6. Write a timestamped JSON artifact under `benchmarks/results/`.

The stream rows are additional to the seed rows. Therefore, the default
attempted workload is 1,015,000 rows (`1,000,000 + 500 * 30`). `--rows`
changes only the seed count; `--rate` and `--duration` control the concurrent
stream. A request is never retried: retrying a successful POST could create
duplicates because the required API has no idempotency key. Failures are
recorded and the run is marked failed.

The dispatch horizon is held open for the requested duration when all POSTs
complete early, so the default accepted-row rate is measured over 30 seconds
rather than only the interval between the first and last batch. If the service
falls behind, the phase extends past the horizon and the artifact exposes that
lower completion rate and pacing lag.

The smaller smoke mode is useful for checking a running service before a full
run:

```sh
node benchmarks/bench.mjs --smoke --url http://localhost:8080 --engine sqlite
```

The repository's Compose variants expose these host ports; the benchmark only
connects to the URL supplied and never changes an occupied port:

```sh
# default TimescaleDB stack (host API port 8080)
node benchmarks/bench.mjs --smoke --url http://127.0.0.1:8080 --engine timescaledb

# SQLite stack (compose.sqlite.yml defaults to host API port 8081)
node benchmarks/bench.mjs --smoke --url http://127.0.0.1:8081 --engine sqlite

# ClickHouse stack (compose.clickhouse.yml defaults to host API port 8082)
node benchmarks/bench.mjs --smoke --url http://127.0.0.1:8082 --engine clickhouse

# DuckDB stack (compose.duckdb.yml defaults to host API port 8083)
node benchmarks/bench.mjs --smoke --url http://127.0.0.1:8083 --engine duckdb
```

For an alternate/high API port, use either the complete URL or `--api-port`
(`--port` is an alias); no listener on 8080 is touched:

```sh
node benchmarks/bench.mjs --smoke --url http://127.0.0.1:8080 --api-port 18081 --engine sqlite
```

The equivalent host-port override when starting any Compose variant is
`API_HOST_PORT=18081` (or another free port); start/stop those services
separately according to the normal project workflow. The alternate Compose
files use 8081 for SQLite and 8082 for ClickHouse by default, while the API
container continues to listen on 8080.

The DuckDB implementation uses the same smoke/full contract on host API port
8083. The benchmark does not start or stop the service itself:

```sh
API_HOST_PORT=8083 docker compose -p timescale-duckdb-bench \
  -f compose.duckdb.yml up -d --build
node benchmarks/bench.mjs --smoke \
  --url http://127.0.0.1:8083 --engine duckdb \
  --run-id duckdb-smoke-20260810
node benchmarks/bench.mjs \
  --url http://127.0.0.1:8083 --engine duckdb \
  --rows 1000000 --batch-size 500 --duration 30 --rate 500 \
  --seed 20260720 --sample-interval-ms 1000 --bucket 1m \
  --run-id duckdb-full-1m-500lps-30s-20260810 \
  --output-dir benchmarks/results
API_HOST_PORT=8083 docker compose -p timescale-duckdb-bench \
  -f compose.duckdb.yml down -v --remove-orphans
```

Smoke defaults are 10,000 seed rows, batches of 100, and a five-second stream
at 100 logs/s. Any explicitly supplied option wins, for example
`--smoke --rate 500`.

Useful options include:

```text
--url URL                 API base URL (or LOG_SERVICE_URL)
--rows N                  exact seed-row count (alias: --seed-rows)
--batch-size N            rows per POST /logs request
--duration SECONDS        stream duration
--rate LOGS_PER_SECOND    stream target rate
--seed N                  deterministic generator seed
--bucket 1m|5m|1h|1d      aggregate bucket (default 1m)
--sample-interval-ms N    aggregate sample cadence (default 1000)
--max-in-flight N         stream POST concurrency (0 means unlimited)
--engine NAME             required artifact label, e.g. timescaledb/sqlite/clickhouse/duckdb
--api-port N              override the port in --url (`--port` alias)
--run-id ID               explicit isolation key; otherwise unique per run
--output-dir PATH         artifact directory
```

The harness does not assume a project-specific retention endpoint. An
implementation may expose one and opt into the explicit probe:

```sh
node benchmarks/bench.mjs \
  --url http://localhost:8080 \
  --retention-probe \
  --retention-endpoint http://localhost:8080/admin/retention/run
```

This calls the supplied endpoint once after ingestion, checks `/health`, and
checks that the aggregate route still responds, reporting the retained count.
The exact persistence comparison runs before the probe because a retention
operation is allowed to delete historical rows. It is skipped by default
because the required contract defines no admin route and an unknown
destructive route must never be called implicitly.

## Determinism and isolation

The row generator is deterministic for a fixed `--seed`, `--run-id`, row
count, and timestamp configuration. Each row uses a valid, repeating set of
levels and eight services. Attributes include:

```json
{
  "run_id": "bench-...",
  "phase": "seed|stream",
  "generator_seed": "20260720"
}
```

The unique `run_id` prevents previous runs or other clients from contaminating
the verification queries. Seed timestamps occupy a fixed historical window;
stream timestamps use the same historical base timestamp, safely behind the
five-minute future guard in the API contract. The generated range is included
in every aggregate query.

During the concurrent phase, the predeclared query filters
`attr.run_id=<run-id>&attr.phase=seed`, groups by service, and uses the selected
bucket. Its expected bucket counts are built independently from the generated
rows before comparing them with the API response. Because stream rows use a
different phase, a sample is not made flaky by a request completing halfway
through the aggregate query. The final query removes the phase filter and
compares the complete accepted set.

The harness treats the API response as authoritative for accepted rows: a
valid batch must return `accepted == batch size` and an empty `rejected` list.
For partial responses it records only indexes not listed in `rejected`, then
the persisted aggregate check catches any inconsistency. Verification covers:

- accepted/rejected counts and HTTP status for every ingestion request;
- at least one persisted row with the run attribute through `GET /logs`;
- exact bucket/group counts and total through `GET /logs/aggregate` after the
  seed phase, during stream samples, and at the end;
- stream target row count and scheduling drift.

## Artifact contents

Each run writes `log-benchmark-<timestamp>-<run-id>.json`. Artifacts include:

- `machine`: Node version, OS, architecture, CPU model/count, memory, and
  load average at start;
- `config`: URL (credentials redacted), row/rate/batch/duration settings,
  timestamp range, bucket, run ID, and expected accepted totals;
- `phases.seed` and `phases.stream`: request counts, accepted/rejected rows,
  failures, durations, observed rates, and request p50/p95/p99 latency;
- `phases.streamRateControl`: target rows, scheduled rate, dispatch window,
  and maximum schedule lag;
- `throughput`: seed, stream, planned-dispatch, and total accepted logs/s;
- `phases.aggregateSamples`: each sample's latency, expected/actual count,
  correctness, and errors, plus aggregate p50/p95/p99;
- `verification`: health, seed/final aggregate comparisons, and `/logs`
  persistence checks;
- `metrics.failures`, capped failure details, `durationsMs`, `correctness`,
  and optional `retention` probe result.

`p50`, `p95`, and `p99` use linear interpolation over sorted per-request
latencies. Ingest request latency and aggregate-query latency are reported
separately; do not treat one as the other. `observedAcceptedRate` divides
accepted rows by the complete phase wall time (including response wait), while
`scheduledRate` is the requested/planned dispatch rate and
`actualDispatchRate` measures the full dispatch horizon (including the final
batch interval). `dispatchStartToLastMs` is also retained to expose the
first-to-last request spacing, and `maxDispatchLagMs` exposes pacing drift. A
service that cannot keep up will show schedule lag and a lower completion rate
rather than having the harness silently change the requested workload.

## Timescale completion evidence

The targeted `timescale-completion-evidence.mjs` probe uses a fresh Timescale
Compose project. It verifies combined HTTP filters and strict descending
ordering, traverses a tied-timestamp dataset through every keyset cursor,
captures filtered `/logs` `EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON)`
plus index/chunk metadata, and runs configured one-day retention while
dispatching 500 logs/s to the API. It writes sibling JSON and Markdown
artifacts; the Compose override uses a one-second worker interval so this
bounded probe can observe removal.

```sh
API_HOST_PORT=18110 TIMESCALE_HOST_PORT=15490 \
  docker compose -p timescale-completion-evidence-20260810 \
  -f docker-compose.yml \
  -f benchmarks/results/timescale-completion-evidence-20260810.compose.override.yml \
  up -d --build
curl --fail http://127.0.0.1:18110/health
API_URL=http://127.0.0.1:18110 \
  COMPOSE_PROJECT=timescale-completion-evidence-20260810 \
  node benchmarks/timescale-completion-evidence.mjs
API_HOST_PORT=18110 TIMESCALE_HOST_PORT=15490 \
  docker compose -p timescale-completion-evidence-20260810 \
  -f docker-compose.yml \
  -f benchmarks/results/timescale-completion-evidence-20260810.compose.override.yml \
  down -v --remove-orphans
```

The probe artifact records the exact project/container, deterministic HTTP
datasets, SQL text/plan, index/chunk evidence, retention policy, concurrent
stream accepted/error counts and latency percentiles, and new-row retention.

## Comparing engines

`compare.mjs` reads one or more timestamped artifacts and produces a compact
Markdown, CSV, or JSON report. It does not connect to any service.

```sh
# all artifacts below a directory
node benchmarks/compare.mjs --dir benchmarks/results \
  --output benchmarks/results/comparison.md

# explicit artifacts, machine-readable output
node benchmarks/compare.mjs \
  benchmarks/results/timescale.json \
  benchmarks/results/sqlite.json \
  benchmarks/results/clickhouse.json \
  --format csv --output benchmarks/results/comparison.csv

node benchmarks/compare.mjs --dir benchmarks/results --format json
```

Label each run with `--engine timescaledb`, `--engine sqlite`, or
`--engine clickhouse`. Comparisons are meaningful only when row counts, batch
size, rate, duration, bucket/filter shape, and machine configuration are
matched. By default, the comparison refuses to render if any artifact has a
missing/unknown engine, failed correctness, nonzero failures, or a mismatched
seed/rate/duration/query signature. For diagnostic output only, explicitly
request a flagged report:

```sh
node benchmarks/compare.mjs --dir benchmarks/results \
  --allow-incomparable --output benchmarks/results/diagnostic.md
```

Flagged Markdown/CSV/JSON output marks each affected row `INCOMPARABLE` and
includes the reasons. Generated comparison JSON plus supplemental
`.explain.json`/`.runtime.json` evidence in the same results directory is
ignored on subsequent `--dir` scans. The report intentionally leaves missing
measurements as `-` rather than treating them as zero.

The authoritative four-engine full-run comparison (TimescaleDB, SQLite,
ClickHouse, and DuckDB; seed=1,000,000, batch=500, 500 logs/s for 30s) is
preserved at:

- `benchmarks/results/comparison-full-1m-500lps-30s-four-engines-20260810.md`
- `benchmarks/results/comparison-full-1m-500lps-30s-four-engines-20260810.json`

It was generated with explicit artifact paths and without
`--allow-incomparable`; the report records `COMPARABLE` with no warnings.

Comparison reports also include a separate workload-spec gate: for the
standard full run, dispatch and accepted completion must each stay within 1%
of 500 logs/s for 30 seconds, aggregate sample p95 must be below 1,000 ms, and
the run must have zero failures with exact aggregate correctness. A row can be
`COMPARABLE` while its spec gate is `FAIL` (for example, a slow engine that
accepted every row and matched every expected aggregate); comparability and
performance compliance are intentionally reported separately. When a sibling
`<run-id>.runtime.json` exists, reports include its stored/measured row counts,
storage evidence, runtime aggregate timing, and captured machine/container
metadata without treating that evidence as another benchmark run.
