# DuckDB full-run runtime evidence

Run: `duckdb-full-1m-500lps-30s-20260810`; project: `timescale-duckdb-full-20260810`; API: `http://127.0.0.1:18083`.

- Benchmark artifact: passed, 1,000,000 seed + 15,000 stream rows, zero harness failures, exact aggregates.
- API timed aggregate: PASS; 236.5 ms; total 1015000.
- Database files before checkpoint: {"logs.duckdb":309866496,"logs.duckdb.wal":3330456}.
- Direct DuckDB count/EXPLAIN/CHECKPOINT probe: PASS. API was stopped only within this isolated project while the file lock was released, then restarted and health-checked.
- Database files after checkpoint/restart: {"logs.duckdb":317730816}.
- API resources at first post-run capture: {"BlockIO":"386MB / 1.03GB","CPUPerc":"0.00%","Container":"eed75ef21a28c7affe48b87f81fc1b50714181eb166a2caa40b446a02fd39644","ID":"eed75ef21a28","MemPerc":"0.22%","MemUsage":"281.9MiB / 125GiB","Name":"timescale-duckdb-full-20260810-api-1","NetIO":"234MB / 1.61MB","PIDs":"34"}.
- API resources at bounded second probe: {"BlockIO":"17.6MB / 0B","CPUPerc":"0.00%","Container":"eed75ef21a28c7affe48b87f81fc1b50714181eb166a2caa40b446a02fd39644","ID":"eed75ef21a28","MemPerc":"0.02%","MemUsage":"31.36MiB / 125GiB","Name":"timescale-duckdb-full-20260810-api-1","NetIO":"3.38kB / 680B","PIDs":"34"}; after restart: {"BlockIO":"8.21MB / 0B","CPUPerc":"0.11%","Container":"eed75ef21a28c7affe48b87f81fc1b50714181eb166a2caa40b446a02fd39644","ID":"eed75ef21a28","MemPerc":"0.03%","MemUsage":"43.91MiB / 125GiB","Name":"timescale-duckdb-full-20260810-api-1","NetIO":"564B / 614B","PIDs":"34"}.
- Post-restart health: PASS.

Full SQL and EXPLAIN ANALYZE rows are preserved under `checkpoint.directResult` in the JSON artifact.
