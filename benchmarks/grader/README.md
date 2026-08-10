# External performance-v2 reproduction

`run-performance-v2.mjs` is a standalone reproduction of the cloned
FoothillSolutions/logs-load-generator external grader at commit
`4cf3748f9503332ee506e8cd4bea6e965a3b11bc`. The external grader calls this
protocol `performance-v2`; the generated fixture metadata identifies the
cloned tester implementation as `performance-v4`. This runner does not start
or stop Compose and does not use the grader control plane.

## Target deployment

Use the root `docker-compose.yml` for the grader-compatible selected
ClickHouse deployment. The `api` service uses `DB_ENGINE=clickhouse` and
connects to the `clickhouse` service. The real `postgres:17-alpine` service is
present only because the current external grader discovers a PostgreSQL
service by the `load-generator.role: postgres` label; it is not an API backend
and does not need a host port.

The root stack defaults `RETENTION_DAYS` to `3650`. The external grader's fixed
preparation records are dated `2026-01-01`; the normal seven-day ClickHouse TTL
would delete those records immediately. The normal production ClickHouse
deployment remains [`compose.clickhouse.yml`](../../compose.clickhouse.yml),
which keeps its seven-day default and does not need the grader-only PostgreSQL
sidecar.

Start the root submission separately on an unused host port:

```sh
API_HOST_PORT=18084 \
  docker compose -p clickhouse-grader-v2-20260810 \
  -f docker-compose.yml up -d --build

node benchmarks/grader/run-performance-v2.mjs \
  --url http://127.0.0.1:18084 \
  --project clickhouse-grader-v2-20260810 \
  --run-id clickhouse-performance-v2-20260810
```

`--project` must identify the Compose project that owns the already-running
root stack so the runner can resolve `api`, `clickhouse`, and `postgres` for
diagnostic container stats. The runner refuses to begin unless
`GET /health` succeeds. It never invokes `docker compose up` or `docker compose
down`; after the run and artifact copy are complete, the caller owns teardown:

```sh
docker compose -p clickhouse-grader-v2-20260810 \
  -f docker-compose.yml down -v --remove-orphans
```

## Protocol and artifacts

By default the runner executes the exact correctness catalog, the exact
one-million-row preparation script (batch size 100), then `load`, `stress`,
`spike`, and `breakpoint` sequentially. Each scenario includes its configured
30-second setup warmup, POST plus aggregate GET plus `/logs` GET on every
iteration, and a 30-second eventual-consistency drain. It runs pinned
`grafana/k6:0.54.0` in Docker, so a host `k6` installation is not required.

The runner captures generated scripts, raw k6 stdout/stderr and summaries,
drain results, Docker stats snapshots/intervals when containers are
discoverable, the v7 score input, and the computed score under
`benchmarks/grader/runs/<run-id>/`.

The local runner tracked Docker stats for `api`, `clickhouse`, and `postgres`,
including ClickHouse telemetry. The external grader omits ClickHouse resource
telemetry from its scoring input; resource metrics are diagnostic only and do
not affect scoring.

## Measured local reproduction

The exact local run completed with `status: passed` and `eligible: true`. Its
artifact is [`result.json`](runs/clickhouse-performance-v2-20260810/result.json).
This is a local reproduction of the external protocol, not an official portal
result.

The score was **75.80 / 100** (`2026-08-09.v7`):

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
the comparison is not an official portal ranking: the public submission and
this local reproduction have separate deployment and run provenance.

A bounded subset can be selected with `--scenarios load` for a smoke of the
external protocol. An authoritative score requires all four scenarios and the
correctness/preparation phases:

```sh
node benchmarks/grader/run-performance-v2.mjs \
  --url http://127.0.0.1:18084 \
  --project clickhouse-grader-v2-20260810 \
  --run-id clickhouse-performance-v2-20260810
```

Use `node benchmarks/grader/run-performance-v2.mjs --self-check` to validate
script and score-calculation invariants without network, Compose, or k6
execution.
