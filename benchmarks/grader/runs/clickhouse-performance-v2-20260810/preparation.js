import http from 'k6/http';
import { check, fail } from 'k6';
const BASE_URL = "http://127.0.0.1:18084";
const COUNT = 1000000;
const BATCH_SIZE = 100;
export const options = { vus: 1, iterations: Math.ceil(COUNT / BATCH_SIZE) };
function log(index) { return { service: 'benchmark-service-' + ((6122026 + index) % 7), level: index % 3 ? 'info' : 'warn', message: 'benchmark fixture ' + index, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index % 60)).toISOString(), attributes: { seed: String(6122026), fixture_index: String(index) } }; }
export default function () { const start = __ITER * BATCH_SIZE; const size = Math.min(BATCH_SIZE, COUNT - start); const response = http.post(BASE_URL + '/logs', JSON.stringify({ logs: Array.from({ length: size }, (_, offset) => log(start + offset)) }), { headers: { 'Content-Type': 'application/json' } }); if (response.status !== 200) fail('fixture batch was rejected'); }
export function teardown() { const response = http.get(BASE_URL + '/logs?service=benchmark-service-1&q=benchmark%20fixture%200&limit=1'); if (response.status !== 200 || !response.body.includes('benchmark fixture 0')) fail('prepared fixture is not queryable'); }
export function handleSummary(data) { return { "/repo/benchmarks/grader/runs/clickhouse-performance-v2-20260810/preparation-summary.json": JSON.stringify({ tester: "performance-v4", metrics: data.metrics }) }; }