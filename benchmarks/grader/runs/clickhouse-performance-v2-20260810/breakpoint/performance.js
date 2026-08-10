import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';
import { sleep } from 'k6';
const BASE_URL = "http://127.0.0.1:18084";
const SEED = 6122026;
const SCENARIO_MARKER = "clickhouse-performance-v2-20260810-breakpoint";
const BATCH_SIZE = 100;
const acceptedLogs = new Counter('accepted_logs');
const rejectedLogs = new Counter('rejected_logs');
const postStatusSuccess = new Rate('post_status_success');
const postStatusCode = new Trend('post_status_code');
const ingestionLatency = new Trend('ingestion_latency');
const aggregateQueryLatency = new Trend('aggregate_query_latency');
const readAfterWrite = new Rate('read_after_write');
export const options = {"scenarios":{"breakpoint":{"executor":"ramping-arrival-rate","startRate":150,"timeUnit":"1s","preAllocatedVUs":150,"stages":[{"target":150,"duration":"30s"},{"target":225,"duration":"30s"},{"target":300,"duration":"30s"},{"target":450,"duration":"30s"}]}},"thresholds":{"http_req_failed":["rate<0.2"],"http_req_duration":["p(95)<3000"]}};
export function handleSummary(data) { return { "/repo/benchmarks/grader/runs/clickhouse-performance-v2-20260810/breakpoint/summary.json": JSON.stringify({ tester: "performance-v4", metrics: data.metrics }) }; }
export function setup() { const end = Date.now() + 30000; while (Date.now() < end) { sleep(1); } return { warmup: true }; }
function log(index) { return { service: 'benchmark-' + SCENARIO_MARKER, level: index % 3 ? 'info' : 'warn', message: 'benchmark log ' + index + ' ' + SCENARIO_MARKER, timestamp: new Date().toISOString(), attributes: { seed: String(SEED), scenario_marker: SCENARIO_MARKER } }; }
export default function () {
  const marker = 'benchmark-raw-' + SEED + '-' + __VU + '-' + __ITER;
  const logs = Array.from({ length: BATCH_SIZE }, (_, index) => { const entry = log(index); return { ...entry, message: entry.message + ' ' + marker, attributes: { ...entry.attributes, read_after_write_id: marker } }; });
  const response = http.post(BASE_URL + '/logs', JSON.stringify({ logs }), { headers: { 'Content-Type': 'application/json' } });
  postStatusSuccess.add(response.status >= 200 && response.status < 300); postStatusCode.add(response.status); ingestionLatency.add(response.timings.duration);
  let accepted = 0;
  try { const body = JSON.parse(response.body || '{}'); accepted = Math.max(0, Math.min(BATCH_SIZE, Number(body.accepted) || 0)); acceptedLogs.add(accepted); rejectedLogs.add(Math.max(0, Math.min(BATCH_SIZE, Array.isArray(body.rejected) ? body.rejected.length : 0))); } catch (_) { rejectedLogs.add(BATCH_SIZE); }
  if (__ITER % 1 === 0) {
    const queryStart = Date.now(); http.get(BASE_URL + '/logs/aggregate?since=' + encodeURIComponent(new Date(Date.now() - 3600000).toISOString()) + '&until=' + encodeURIComponent(new Date().toISOString()) + '&bucket=1m'); aggregateQueryLatency.add(Date.now() - queryStart);
    const query = http.get(BASE_URL + '/logs?limit=20'); let matched = false; try { const body = JSON.parse(query.body || '{}'); matched = query.status >= 200 && query.status < 300 && Array.isArray(body.logs) && body.logs.some((item) => item && item.attributes && item.attributes.read_after_write_id === marker); } catch (_) { matched = false; }
    if (response.status >= 200 && response.status < 300 && accepted > 0) readAfterWrite.add(matched);
  }
  sleep(0.01);
}