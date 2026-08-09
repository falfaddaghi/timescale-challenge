# Timescale completion evidence

Status: **PASSED**

Run ID: `timescale-completion-evidence-20260810`; API: `http://127.0.0.1:18110`; Compose project: `timescale-completion-evidence-20260810`.

## Readiness and protocol

- GET /health: PASS after 32 ms (1 attempts).
- Combined-filter list: PASS; 50/50 rows; strict-order violations 0.
- Tied-timestamp keyset traversal: PASS; 11 pages, 73/73 unique rows, duplicates 0, omissions 0, missing messages 0, unexpected messages 0, order violations 0.

## Filtered SQL plan and storage evidence

- EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON): PASS; plan Limit -> Incremental Sort -> Result -> Custom Scan -> Index Scan[_hyper_1_1_chunk_logs_level_timestamp_id_idx].
- Indexes: logs_attributes_gin_idx, logs_id_timestamp_uidx, logs_level_timestamp_id_idx, logs_message_trgm_idx, logs_service_timestamp_id_idx, logs_timestamp_id_idx, logs_timestamp_idx.
- Hypertable: logs; dimensions 1; chunks reported 4; primary dimension timestamp.
- Hypertable chunks before retention: 4; after retention: 1.
- Full SQL and JSON plan are embedded in the JSON artifact under `sqlEvidence.filteredLogsExplain`.

## Retention during concurrent ingestion

- Configured retention: 1 day; worker interval 1000 ms.
- Old rows: 300 before, 0 after; removed during stream: YES.
- Concurrent stream (2026-08-09T22:13:55.461Z to 2026-08-09T22:14:07.407Z): sent 6000, accepted 6000, rejected 0, error requests 0; dispatch 500.036 logs/s; completion 502.274 logs/s; latency p50/p95/p99 10.108/18.62/61.928 ms.
- New rows retained: YES; aggregate total 6000/6000.

## Commands

```sh
API_HOST_PORT=18110 TIMESCALE_HOST_PORT=15490 docker compose -p timescale-completion-evidence-20260810 -f docker-compose.yml -f benchmarks/results/timescale-completion-evidence-20260810.compose.override.yml up -d --build
curl --fail http://127.0.0.1:18110/health
API_URL=http://127.0.0.1:18110 COMPOSE_PROJECT=timescale-completion-evidence-20260810 node benchmarks/timescale-completion-evidence.mjs
API_HOST_PORT=18110 TIMESCALE_HOST_PORT=15490 docker compose -p timescale-completion-evidence-20260810 -f docker-compose.yml -f benchmarks/results/timescale-completion-evidence-20260810.compose.override.yml down -v --remove-orphans
```

## Failures

- None.
