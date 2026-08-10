# Log-service benchmark comparison

Generated from timestamped `bench.mjs` artifacts. Rates and latency are not normalized across different machine/configuration metadata; compare like-for-like runs.

Comparison set: **COMPARABLE**

## Gate and interpretation

The spec gate requires target configuration 500 logs/s for 30s, both dispatch and accepted completion within +/-1% of 500 logs/s, aggregate-sample p95 under 1,000ms, zero harness failures, and correctness PASS. Dispatch is request scheduling; completion is accepted rows divided by stream wall time.

| Engine | Spec gate | Dispatch logs/s | Accepted completion logs/s | Aggregate p95 ms | Failures | Correctness | Stored rows | Measured rows |
| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| timescale | PASS | 500.008 | 499.991 | 321.588 | 0 | PASS | 1025500 | 1015000 |
| sqlite | FAIL | 500.007 | 229.912 | 24180.626 | 0 | PASS | 1025500 | 1015000 |
| clickhouse | PASS | 500.004 | 500.009 | 99.999 | 0 | PASS | 1025500 | 1015000 |
| duckdb | PASS | 500.002 | 498.75 | 99.792 | 0 | PASS | - | - |

## Rankings

- Accepted completion rate (descending): 1. clickhouse: 500.009 logs/s (spec PASS); 2. timescale: 499.991 logs/s (spec PASS); 3. duckdb: 498.75 logs/s (spec PASS); 4. sqlite: 229.912 logs/s (spec FAIL).
- Seed throughput (descending): 1. clickhouse: 56435.606 logs/s (spec PASS); 2. timescale: 11379.798 logs/s (spec PASS); 3. sqlite: 4733.77 logs/s (spec FAIL); 4. duckdb: 1277.783 logs/s (spec PASS).
- Aggregate sample p95 (ascending): 1. duckdb: 99.792 ms (spec PASS); 2. clickhouse: 99.999 ms (spec PASS); 3. timescale: 321.588 ms (spec PASS); 4. sqlite: 24180.626 ms (spec FAIL).
- Total elapsed time (ascending): 1. clickhouse: 47957.191 ms (spec PASS); 2. timescale: 118494.077 ms (spec PASS); 3. sqlite: 315548.834 ms (spec FAIL); 4. duckdb: 812998.285 ms (spec PASS).
- Reported primary storage (ascending): 1. clickhouse: 23.63 MiB (24780277 bytes) (spec PASS); 2. duckdb: 303.01 MiB (317730816 bytes) (spec PASS); 3. timescale: 563.62 MiB (591000000 bytes) (spec PASS); 4. sqlite: 829.74 MiB (870043648 bytes) (spec FAIL).
- duckdbVsClickhouse ratios (DuckDB / competitor; throughput >1 is faster, lower-is-better metrics <1 are better): seed throughput 0.023x, stream completion 0.997x, aggregate p95 0.998x, total elapsed 16.953x, storage 12.822x.
- duckdbVsTimescale ratios (DuckDB / competitor; throughput >1 is faster, lower-is-better metrics <1 are better): seed throughput 0.112x, stream completion 0.998x, aggregate p95 0.31x, total elapsed 6.861x, storage 0.538x.

## Notes

- Protocol comparability: all rows use seedRows=1,000,000, batchSize=500, target=500 logs/s, duration=30s, bucket=1m, service grouping, and the same run_id/phase-filtered aggregate query shape.
- Dispatch rate is request scheduling; completion rate is accepted rows divided by stream wall time. The 500 logs/s gate requires both within +/-1% of 500; dispatch alone is not sufficient.
- The aggregate gate is harness aggregate-sample p95 < 1,000ms. Harness correctness additionally requires zero failures and exact seed/final persisted counts.
- Aggregate p95 raw ordering is duckdb 99.792 ms vs clickhouse 99.999 ms; the 0.207 ms difference is treated as effectively tied/noise without repeated evidence.
- DuckDB operational nuance: this run uses an embedded single-process database file. Direct SQL/checkpoint evidence required stopping only the isolated API to release the file lock; this is an operational distinction, not a correctness failure.
- Whole-workload winner among spec-passing runs by total elapsed time is clickhouse (47957.191 ms); aggregate-p95 near-ties do not override the end-to-end result.
- Storage ranking uses each runtime artifact's reported primary storage measure: Timescale hypertable size, SQLite main database file, ClickHouse table bytes, or DuckDB post-checkpoint database file. WAL/volume overhead and compression semantics differ, so this is directional evidence rather than a normalized physical-footprint comparison.
- Storage nuance: each full run followed same-database smoke; runtime stored-row counts include smoke rows (typically 1,025,500), while measured-window counts isolate the full run at 1,015,000.
- sqlite spec gate: FAIL (accepted completion rate is outside +/-1% of 500 logs/s; aggregate sample p95 is not under 1s). The run can still be correctness-comparable when its status, configuration, and exact aggregates pass.

| Engine | Status | Comparison | Seed rows | Accepted | Target logs/s | Observed logs/s | Total logs/s | Planned logs/s | Dispatch logs/s | Seed logs/s | Ingest p50 ms | Ingest p95 ms | Ingest p99 ms | Agg p50 ms | Agg p95 ms | Agg p99 ms | Agg samples | Agg correct | Correctness | Failures | Spec gate | 500/s gate | Agg p95<1s | Zero failures | Correctness gate | Total ms | Completion x TS | Agg p95 x TS | Elapsed x TS | Stored rows | Measured rows | Storage bytes | Storage | Runtime agg ms | Seed x TS | Retention | Comparison issues |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| timescale | passed | COMPARABLE | 1000000 | 1015000 | 500 | 499.991 | 8565.831 | 500 | 500.008 | 11379.798 | 25.82 | 121.303 | 253.384 | 301.205 | 321.588 | 324.656 | 30 | 30 | PASS | 0 | PASS | PASS | PASS | PASS | PASS | 118494.077 | 1 | 1 | 1 | 1025500 | 1015000 | 591000000 | 591 MB | 354.976 | 1 | skipped |  |
| sqlite | passed | COMPARABLE | 1000000 | 1015000 | 500 | 229.912 | 3216.618 | 500 | 500.007 | 4733.77 | 76.826 | 220.773 | 251.026 | 20977.941 | 24180.626 | 24465.309 | 3 | 3 | PASS | 0 | FAIL | FAIL | FAIL | PASS | PASS | 315548.834 | 0.46 | 75.191 | 2.663 | 1025500 | 1015000 | 870043648 | 829.74 MiB | 19990.671 | 0.416 | skipped |  |
| clickhouse | passed | COMPARABLE | 1000000 | 1015000 | 500 | 500.009 | 21164.721 | 500 | 500.004 | 56435.606 | 7.919 | 10.949 | 14.487 | 87.03 | 99.999 | 102.371 | 30 | 30 | PASS | 0 | PASS | PASS | PASS | PASS | PASS | 47957.191 | 1 | 0.311 | 0.405 | 1025500 | 1015000 | 24780277 | 23.63 MiB | 49 | 4.959 | skipped |  |
| duckdb | passed | COMPARABLE | 1000000 | 1015000 | 500 | 498.75 | 1248.465 | 500 | 500.002 | 1277.783 | 383.236 | 428.844 | 501.404 | 69.24 | 99.792 | 241.853 | 31 | 31 | PASS | 0 | PASS | PASS | PASS | PASS | PASS | 812998.285 | 0.998 | 0.31 | 6.861 | - | - | 317730816 | 303.01 MiB | - | 0.112 | skipped |  |

Artifacts:

- timescale (passed): benchmarks/results/log-benchmark-20260809212554868-timescale-full-1m-500lps-30s-20260810.json
- sqlite (passed): benchmarks/results/log-benchmark-20260809213239108-sqlite-full-1m-500lps-30s-20260810.json
- clickhouse (passed): benchmarks/results/log-benchmark-20260809214206634-clickhouse-full-1m-500lps-30s-20260810.json
- duckdb (passed): benchmarks/results/log-benchmark-20260810073248301-duckdb-full-1m-500lps-30s-20260810.json

Configuration and correctness comparability checks: PASS (spec gates are reported per engine above).
