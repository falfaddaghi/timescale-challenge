import http from 'k6/http';
import { check, sleep } from 'k6';
const BASE_URL = "http://127.0.0.1:18084";
const CHECK_NAMES = ["health.status","ingestion.single","ingestion.batch","ingestion.partial-invalid","ingestion.empty","ingestion.malformed-json","query.unfiltered","query.filters","query.invalid-parameters","pagination.stable-order","pagination.cursor","pagination.invalid-cursor","aggregate.buckets","aggregate.grouping","aggregate.invalid-options"];
const FIXTURE = {"seed":6122026,"version":"performance-v4"};
const MAX_BODY = 8192;
export const options = { scenarios: { correctness: { executor: 'shared-iterations', vus: 1, iterations: 1, maxDuration: '30s' } } };
export function handleSummary(data) { return { "/repo/benchmarks/grader/runs/clickhouse-performance-v2-20260810/correctness-summary.json": JSON.stringify({ tester: FIXTURE.version, metrics: data.metrics }) }; }
function boundedBody(response) { return String(response.body || '').slice(0, MAX_BODY); }
function emit(name, response, passed, expected, started) { console.log(JSON.stringify({ tester: FIXTURE.version, seed: FIXTURE.seed, name, status: response.status, passed: Boolean(passed), durationMs: Date.now() - started, body: boundedBody(response), expected })); }
function execute(name, request, predicate, expected) { const started = Date.now(); let response; try { response = request(); emit(name, response, predicate(response), expected, started); } catch (error) { emit(name, { status: 0, body: String(error) }, false, expected, started); } }
export default function () {
  const headers = { headers: { 'Content-Type': 'application/json' } };
  const log = (index) => ({ service: 'phase6-' + FIXTURE.seed, level: index % 2 ? 'warn' : 'info', message: 'phase-6 fixture ' + index, timestamp: new Date(Date.now() - index * 1000).toISOString(), attributes: { request_id: 'phase6-' + index, retries: index } });
  const logs = Array.from({ length: 8 }, (_, index) => log(index));
  execute('health.status', () => http.get(BASE_URL + '/health'), (r) => r.status === 200, 'GET /health returns HTTP 200');
  execute('ingestion.single', () => http.post(BASE_URL + '/logs', JSON.stringify({ logs: [log(0)] }), headers), (r) => { try { const b = JSON.parse(r.body); return r.status === 200 && b.accepted === 1 && Array.isArray(b.rejected); } catch (_) { return false; } }, 'a valid single-entry batch is accepted with HTTP 200');
  execute('ingestion.batch', () => http.post(BASE_URL + '/logs', JSON.stringify({ logs }), headers), (r) => { try { const b = JSON.parse(r.body); return r.status === 200 && b.accepted === logs.length && Array.isArray(b.rejected); } catch (_) { return false; } }, 'a valid batch is accepted');
  execute('ingestion.partial-invalid', () => http.post(BASE_URL + '/logs', JSON.stringify({ logs: [logs[0], { level: 12 }] }), headers), (r) => { try { const b = JSON.parse(r.body); return r.status === 200 && b.accepted === 1 && b.rejected?.[0]?.index === 1 && typeof b.rejected[0].reason === 'string'; } catch (_) { return false; } }, 'valid entries are accepted and invalid entries include indexes and reasons');
  execute('ingestion.empty', () => http.post(BASE_URL + '/logs', JSON.stringify({ logs: [] }), headers), (r) => r.status === 400, 'an empty batch is rejected with HTTP 400');
  execute('ingestion.malformed-json', () => http.post(BASE_URL + '/logs', '{', headers), (r) => r.status >= 400 && r.status < 500, 'malformed JSON is rejected with a client error');
  execute('query.unfiltered', () => http.get(BASE_URL + '/logs?limit=20'), (r) => r.status === 200 && /logs/i.test(r.body), 'stored logs can be listed');
  execute('query.filters', () => http.get(BASE_URL + '/logs?service=phase6-' + FIXTURE.seed + '&level=info&since=' + encodeURIComponent(new Date(Date.now() - 3600000).toISOString()) + '&until=' + encodeURIComponent(new Date(Date.now() + 300000).toISOString()) + '&q=BENCHMARK&limit=1000'), (r) => r.status === 200, 'range, attribute-compatible, level, service, message, and maximum-limit filters are accepted');
  execute('query.invalid-parameters', () => http.get(BASE_URL + '/logs?limit=0'), (r) => r.status >= 400 && r.status < 500, 'invalid query parameters return a client error');
  execute('pagination.stable-order', () => http.get(BASE_URL + '/logs?service=phase6-' + FIXTURE.seed + '&limit=3'), (r) => r.status === 200, 'results have deterministic ordering');
  let cursor = '';
  execute('pagination.cursor', () => { const first = http.get(BASE_URL + '/logs?service=phase6-' + FIXTURE.seed + '&limit=3'); try { cursor = JSON.parse(first.body).next_cursor || ''; } catch (_) {} return cursor ? http.get(BASE_URL + '/logs?service=phase6-' + FIXTURE.seed + '&limit=3&cursor=' + encodeURIComponent(cursor)) : first; }, (r) => r.status === 200, 'cursor pages have no gaps or duplicates');
  execute('pagination.invalid-cursor', () => http.get(BASE_URL + '/logs?cursor=invalid-cursor'), (r) => r.status >= 400 && r.status < 500, 'invalid cursors return a client error');
  const since = new Date(Date.now() - 3600000).toISOString();
  const until = new Date(Date.now() + 60000).toISOString();
  execute('aggregate.buckets', () => http.get(BASE_URL + '/logs/aggregate?since=' + encodeURIComponent(since) + '&until=' + encodeURIComponent(until) + '&bucket=1m'), (r) => { try { const b = JSON.parse(r.body); return r.status === 200 && Array.isArray(b.buckets) && b.buckets.every((x) => typeof x.start === 'string' && x.group === null && typeof x.count === 'number'); } catch (_) { return false; } }, 'time buckets use the required start, group, and count response shape');
  execute('aggregate.grouping', () => http.get(BASE_URL + '/logs/aggregate?since=' + encodeURIComponent(since) + '&until=' + encodeURIComponent(until) + '&bucket=5m&group_by=service'), (r) => r.status === 200, 'service grouping is supported');
  execute('aggregate.invalid-options', () => http.get(BASE_URL + '/logs/aggregate?bucket=invalid&group_by=unknown'), (r) => r.status >= 400 && r.status < 500, 'invalid aggregation options return a client error');
  sleep(0.01);
}