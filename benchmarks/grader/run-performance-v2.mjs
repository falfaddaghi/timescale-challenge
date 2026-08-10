#!/usr/bin/env node

/**
 * Standalone reproduction of FoothillSolutions/logs-load-generator
 * performance-v2, commit 4cf3748f9503332ee506e8cd4bea6e965a3b11bc.
 *
 * It intentionally does not start Compose or use the grader control plane.
 * The caller must provide a ready root HTTP API URL. k6 0.54.0 is run in the
 * pinned official container so this remains runnable on hosts without a k6
 * binary installed.
 */

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const sourceCommit = "4cf3748f9503332ee506e8cd4bea6e965a3b11bc";
const sourceRoot = "/tmp/logs-load-generator.3U9Xli";
const testerVersion = "performance-v4";
const k6Version = "0.54.0";
const seed = 6122026;
const batchSize = 100;
const datasetSize = 1_000_000;
const warmupDuration = "30s";
const drainWindowMs = 30_000;
const drainPollIntervalMs = 250;
const scenarios = {
  load: {
    stages: [{ targetLogsPerSecond: 15_000, duration: "2m" }],
    thresholds: { errorRate: 0.01, p95Ms: 500 },
  },
  stress: {
    stages: [
      { targetLogsPerSecond: 15_000, duration: "30s" },
      { targetLogsPerSecond: 22_500, duration: "60s" },
      { targetLogsPerSecond: 30_000, duration: "60s" },
    ],
    thresholds: { errorRate: 0.05, p95Ms: 1000 },
  },
  spike: {
    stages: [
      { targetLogsPerSecond: 7500, duration: "30s" },
      { targetLogsPerSecond: 30_000, duration: "10s" },
      { targetLogsPerSecond: 7500, duration: "60s" },
    ],
    thresholds: { errorRate: 0.1, p95Ms: 2000 },
  },
  breakpoint: {
    stages: [
      { targetLogsPerSecond: 15_000, duration: "30s" },
      { targetLogsPerSecond: 22_500, duration: "30s" },
      { targetLogsPerSecond: 30_000, duration: "30s" },
      { targetLogsPerSecond: 45_000, duration: "30s" },
    ],
    thresholds: { errorRate: 0.2, p95Ms: 3000 },
  },
};

function parseArgs(argv) {
  const options = {
    url: process.env.GRADER_URL ?? "http://127.0.0.1:18084",
    project: process.env.COMPOSE_PROJECT ?? "timescale-grader-v2-20260810",
    composeFile: process.env.COMPOSE_FILE ?? "docker-compose.yml",
    outputDir: process.env.OUTPUT_DIR ?? path.join(repoRoot, "benchmarks", "grader", "runs"),
    runId: process.env.RUN_ID ?? `root-timescale-performance-v2-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`,
    k6Image: process.env.K6_IMAGE ?? `grafana/k6:${k6Version}`,
    scenarios: Object.keys(scenarios),
    skipCorrectness: false,
    skipPreparation: false,
    selfCheck: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => argv[++i];
    if (token === "--url") options.url = next();
    else if (token.startsWith("--url=")) options.url = token.slice(6);
    else if (token === "--project") options.project = next();
    else if (token === "--compose-file") options.composeFile = next();
    else if (token === "--output-dir") options.outputDir = next();
    else if (token === "--run-id") options.runId = next();
    else if (token === "--k6-image") options.k6Image = next();
    else if (token === "--scenarios") options.scenarios = next().split(",").map((x) => x.trim()).filter(Boolean);
    else if (token === "--skip-correctness") options.skipCorrectness = true;
    else if (token === "--skip-preparation") options.skipPreparation = true;
    else if (token === "--self-check") options.selfCheck = true;
    else if (token === "--help" || token === "-h") options.help = true;
    else throw new Error(`unknown option ${token}`);
  }
  if (!options.help && !options.selfCheck) {
    if (!/^https?:\/\//.test(options.url)) throw new Error("--url must use HTTP or HTTPS");
    for (const scenario of options.scenarios) if (!scenarios[scenario]) throw new Error(`unknown scenario ${scenario}`);
  }
  return options;
}

function printHelp() {
  console.log(`Standalone performance-v2 runner (no Compose/control plane management)

Usage:
  node benchmarks/grader/run-performance-v2.mjs --url http://127.0.0.1:18084 \
    --project timescale-grader-v2-20260810

Defaults reproduce performance-v2 exactly: correctness checks, 1,000,000-row
preparation, then load/stress/spike/breakpoint sequentially, batch size 100,
30s warmup per scenario, and k6 ${k6Version}. Raw scripts, k6 output, summaries,
drain evidence, Docker stats, and score are written under --output-dir.

Options: --scenarios load,stress,spike,breakpoint; --skip-correctness;
--skip-preparation; --run-id ID; --k6-image IMAGE; --project NAME.

self-check validates generated script/config invariants without network or k6.
`);
}

async function command(args, options = {}) {
  try {
    const result = await execFileAsync(args[0], args.slice(1), {
      cwd: repoRoot,
      maxBuffer: 64 * 1024 * 1024,
      timeout: options.timeoutMs,
      killSignal: "SIGKILL",
    });
    return { ok: true, exitCode: 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "", timedOut: false };
  } catch (error) {
    return {
      ok: false,
      exitCode: typeof error.code === "number" ? error.code : null,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      timedOut: error.killed === true || error.signal === "SIGKILL",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchJson(url, timeoutMs = 10_000) {
  const started = performance.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { ok: response.ok, status: response.status, body, elapsedMs: Number((performance.now() - started).toFixed(3)) };
  } catch (error) {
    return { ok: false, status: null, body: null, elapsedMs: Number((performance.now() - started).toFixed(3)), error: String(error) };
  }
}

function durationSeconds(value) {
  const match = String(value).match(/^(\d+)(ms|s|m|h)$/);
  if (!match) throw new Error(`unsupported duration ${value}`);
  return Number(match[1]) * ({ ms: 1 / 1000, s: 1, m: 60, h: 3600 }[match[2]]);
}

function durationMs(value) {
  return durationSeconds(value) * 1000;
}

function endpoint(value) {
  return new URL(value).toString().replace(/\/$/, "");
}

function generateCorrectnessScript(baseUrl, summaryPath) {
  return `import http from 'k6/http';
import { check, sleep } from 'k6';
const BASE_URL = ${JSON.stringify(endpoint(baseUrl))};
const CHECK_NAMES = ${JSON.stringify([
    "health.status", "ingestion.single", "ingestion.batch", "ingestion.partial-invalid", "ingestion.empty", "ingestion.malformed-json",
    "query.unfiltered", "query.filters", "query.invalid-parameters", "pagination.stable-order", "pagination.cursor", "pagination.invalid-cursor",
    "aggregate.buckets", "aggregate.grouping", "aggregate.invalid-options",
  ])};
const FIXTURE = ${JSON.stringify({ seed, version: testerVersion })};
const MAX_BODY = 8192;
export const options = { scenarios: { correctness: { executor: 'shared-iterations', vus: 1, iterations: 1, maxDuration: '30s' } } };
export function handleSummary(data) { return { ${JSON.stringify(summaryPath)}: JSON.stringify({ tester: FIXTURE.version, metrics: data.metrics }) }; }
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
}`;
}

function generatePreparationScript(baseUrl, summaryPath) {
  return `import http from 'k6/http';
import { check, fail } from 'k6';
const BASE_URL = ${JSON.stringify(endpoint(baseUrl))};
const COUNT = ${datasetSize};
const BATCH_SIZE = ${batchSize};
export const options = { vus: 1, iterations: Math.ceil(COUNT / BATCH_SIZE) };
function log(index) { return { service: 'benchmark-service-' + ((${seed} + index) % 7), level: index % 3 ? 'info' : 'warn', message: 'benchmark fixture ' + index, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index % 60)).toISOString(), attributes: { seed: String(${seed}), fixture_index: String(index) } }; }
export default function () { const start = __ITER * BATCH_SIZE; const size = Math.min(BATCH_SIZE, COUNT - start); const response = http.post(BASE_URL + '/logs', JSON.stringify({ logs: Array.from({ length: size }, (_, offset) => log(start + offset)) }), { headers: { 'Content-Type': 'application/json' } }); if (response.status !== 200) fail('fixture batch was rejected'); }
export function teardown() { const response = http.get(BASE_URL + '/logs?service=benchmark-service-${seed % 7}&q=benchmark%20fixture%200&limit=1'); if (response.status !== 200 || !response.body.includes('benchmark fixture 0')) fail('prepared fixture is not queryable'); }
export function handleSummary(data) { return { ${JSON.stringify(summaryPath)}: JSON.stringify({ tester: ${JSON.stringify(testerVersion)}, metrics: data.metrics }) }; }`;
}

function generatePerformanceScript(baseUrl, scenarioName, scenarioMarker, summaryPath) {
  const scenario = scenarios[scenarioName];
  const targetScale = 1;
  const targetStages = scenario.stages.map((stage) => ({ target: stage.targetLogsPerSecond * targetScale, duration: stage.duration }));
  const iterationRate = (logsPerSecond) => Math.max(1, Math.round(logsPerSecond / batchSize));
  const options = {
    scenarios: {
      [scenarioName]: {
        executor: "ramping-arrival-rate",
        startRate: iterationRate(targetStages[0].target),
        timeUnit: "1s",
        preAllocatedVUs: Math.max(10, iterationRate(targetStages[0].target)),
        stages: targetStages.map((stage) => ({ target: iterationRate(stage.target), duration: `${Math.max(1, Math.ceil(durationSeconds(stage.duration)))}s` })),
      },
    },
    thresholds: {
      http_req_failed: [`rate<${scenario.thresholds.errorRate}`],
      http_req_duration: [`p(95)<${scenario.thresholds.p95Ms}`],
    },
  };
  return `import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';
import { sleep } from 'k6';
const BASE_URL = ${JSON.stringify(endpoint(baseUrl))};
const SEED = ${seed};
const SCENARIO_MARKER = ${JSON.stringify(scenarioMarker)};
const BATCH_SIZE = ${batchSize};
const acceptedLogs = new Counter('accepted_logs');
const rejectedLogs = new Counter('rejected_logs');
const postStatusSuccess = new Rate('post_status_success');
const postStatusCode = new Trend('post_status_code');
const ingestionLatency = new Trend('ingestion_latency');
const aggregateQueryLatency = new Trend('aggregate_query_latency');
const readAfterWrite = new Rate('read_after_write');
export const options = ${JSON.stringify(options)};
export function handleSummary(data) { return { ${JSON.stringify(summaryPath)}: JSON.stringify({ tester: ${JSON.stringify(testerVersion)}, metrics: data.metrics }) }; }
export function setup() { const end = Date.now() + ${durationMs(warmupDuration)}; while (Date.now() < end) { sleep(1); } return { warmup: true }; }
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
}`;
}

async function writeRaw(file, value) {
  await writeFile(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

async function runK6({ scriptPath, summaryPath, rawPath, image, timeoutMs }) {
  await unlink(summaryPath).catch(() => undefined);
  const started = performance.now();
  const result = await command([
    "docker", "run", "--rm", "--network", "host",
    "--user", `${process.getuid()}:${process.getgid()}`,
    "-v", `${repoRoot}:/repo:rw`, image, "run", "--no-usage-report", `/repo/${path.relative(repoRoot, scriptPath)}`,
  ], { timeoutMs });
  const completed = { ...result, elapsedMs: Number((performance.now() - started).toFixed(3)), scriptPath, summaryPath, rawPath };
  await writeRaw(rawPath, { command: `docker run --rm --network host --user ${process.getuid()}:${process.getgid()} -v ${repoRoot}:/repo:rw ${image} run --no-usage-report /repo/${path.relative(repoRoot, scriptPath)}`, ...completed });
  let summary = null;
  try {
    const candidate = JSON.parse(await readFile(summaryPath, "utf8"));
    if (candidate?.tester === testerVersion && candidate.metrics && typeof candidate.metrics === "object") summary = candidate;
  } catch { /* k6 output diagnostics remain authoritative */ }
  return { ...completed, status: result.timedOut ? "timeout" : summary !== null || result.ok ? "completed" : "failed", summary };
}

async function composeContainers(project, composeFile) {
  const services = ["api", "clickhouse", "postgres"];
  const entries = await Promise.all(services.map(async (service) => {
    const result = await command(["docker", "compose", "-p", project, "-f", composeFile, "ps", "-q", service]);
    return [service, { result, container: result.stdout.trim() || null }];
  }));
  return Object.fromEntries(entries);
}

async function dockerStats(containers) {
  const names = Object.values(containers).filter(Boolean);
  if (!names.length) return { ok: false, rows: [], error: "no containers resolved" };
  const result = await command(["docker", "stats", "--no-stream", "--format", "{{json .}}", ...names]);
  const rows = result.stdout.trim().split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  return { ...result, rows };
}

async function drainScenario(baseUrl, service, acceptedRecords) {
  const started = Date.now();
  const deadlineAt = started + drainWindowMs;
  let visibleRecords = 0;
  let getStatus = 0;
  let responseShapeValid = false;
  let timeoutCount = 0;
  do {
    let cursor = "";
    visibleRecords = 0;
    getStatus = 0;
    responseShapeValid = false;
    let timedOut = false;
    for (;;) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) { timedOut = true; break; }
      const url = new URL(`${endpoint(baseUrl)}/logs`);
      url.searchParams.set("service", service);
      url.searchParams.set("limit", "1000");
      if (cursor) url.searchParams.set("cursor", cursor);
      let response;
      try { response = await fetch(url, { signal: AbortSignal.timeout(Math.min(2000, remaining)) }); }
      catch { timedOut = true; break; }
      getStatus = response.status;
      if (!response.ok) break;
      let body;
      try { body = await response.json(); } catch { break; }
      if (!Array.isArray(body.logs)) break;
      visibleRecords += body.logs.length;
      if (!body.next_cursor) { responseShapeValid = true; break; }
      cursor = body.next_cursor;
    }
    if (timedOut) timeoutCount += 1;
    if (visibleRecords >= acceptedRecords || Date.now() >= deadlineAt) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(drainPollIntervalMs, deadlineAt - Date.now())));
  } while (Date.now() < deadlineAt);
  return { acceptedRecords, visibleRecords, missingRecords: Math.max(0, acceptedRecords - visibleRecords), durationMs: Math.min(Date.now() - started, drainWindowMs), deadlineMs: drainWindowMs, getStatus, responseShapeValid, timeoutCount, passed: visibleRecords >= acceptedRecords };
}

function metric(summary, name) {
  return summary?.metrics?.[name] ?? null;
}

function normalizeK6Summary(summary) {
  const failed = metric(summary, "http_req_failed");
  const duration = metric(summary, "http_req_duration");
  const sent = metric(summary, "http_reqs");
  const accepted = metric(summary, "accepted_logs");
  const rejected = metric(summary, "rejected_logs");
  const ingestion = metric(summary, "ingestion_latency");
  const aggregate = metric(summary, "aggregate_query_latency");
  const readAfterWrite = metric(summary, "read_after_write");
  const thresholds = Object.entries({ ...(failed?.thresholds ?? {}), ...(duration?.thresholds ?? {}) }).map(([name, value]) => ({ name, passed: value.ok === true, actual: null, target: null }));
  return {
    httpRequests: sent?.values?.count ?? null,
    acceptedLogs: accepted?.values?.count ?? 0,
    rejectedLogs: rejected?.values?.count ?? 0,
    failedRate: failed?.values?.rate ?? 0,
    p50: duration?.values?.["p(50)"] ?? null,
    p95: duration?.values?.["p(95)"] ?? null,
    p99: duration?.values?.["p(99)"] ?? null,
    ingestionP95: ingestion?.values?.["p(95)"] ?? null,
    aggregateP95: aggregate?.values?.["p(95)"] ?? null,
    readAfterWriteRate: readAfterWrite?.values?.rate ?? null,
    thresholds,
  };
}

function performanceMetrics(measured, duration) {
  return {
    acceptedLogs: Math.floor(measured.acceptedLogs),
    rejectedLogs: Math.floor(measured.rejectedLogs),
    httpErrors: measured.failedRate,
    logsPerSecond: duration > 0 ? measured.acceptedLogs / (duration / 1000) : 0,
    latencyP95Ms: measured.p95,
    ingestionP95Ms: measured.ingestionP95,
    aggregateP95Ms: measured.aggregateP95,
    readAfterWriteSuccessRate: measured.readAfterWriteRate,
    thresholdPassed: measured.thresholds.every((threshold) => threshold.passed),
  };
}

function clamp(value, maximum = 1) { return Number.isFinite(value) ? Math.max(0, Math.min(maximum, value)) : 0; }
function scoreCategory(points, maximum, components) { const safe = clamp(points, maximum); return { points: safe, maximum, percentage: safe / maximum * 100, components }; }
function calculateScore(input) {
  const correctnessRatio = input.correctness.total > 0 ? clamp(input.correctness.passed / input.correctness.total) : 0;
  const correctness = scoreCategory(correctnessRatio * 15, 15, { passed: input.correctness.passed, total: input.correctness.total });
  const throughputBonus = input.performance.logsPerSecond >= 25000 ? 0.1 : input.performance.logsPerSecond >= 20000 ? 0.05 : 0;
  const throughput = clamp(input.performance.logsPerSecond / 15000) * 0.4 + throughputBonus;
  const errors = clamp(1 - input.performance.errorRate / 0.01) * 0.3;
  const latency = input.performance.latencyP95Ms === null ? 0 : clamp(1 - (Math.max(input.performance.latencyP95Ms, 100) - 100) / (1000 - 100)) * 0.2;
  const threshold = input.performance.thresholdPassed && input.performance.throughputTargetMet ? 0.1 : 0;
  const performanceCategory = scoreCategory((throughput + errors + latency + threshold) * 50, 50, { throughput, throughputBonus, errors, latency, threshold });
  const aggregateLatency = input.queries.aggregateP95Ms === null ? 0 : clamp(1 - input.queries.aggregateP95Ms / 500);
  const readAfterWrite = input.queries.readAfterWriteSuccessRate === null ? 0 : clamp(input.queries.readAfterWriteSuccessRate);
  const eventual = Math.floor(clamp(input.queries.eventualConsistencyPassedScenarios, input.queries.eventualConsistencyTotalScenarios));
  const eventualPoints = eventual * 1.5;
  const queries = scoreCategory(aggregateLatency * 9 + eventualPoints, 15, { aggregateLatency, eventualConsistencyPassedScenarios: eventual, eventualConsistencyTotalScenarios: input.queries.eventualConsistencyTotalScenarios, eventualConsistencyPoints: eventualPoints, readAfterWrite });
  const completion = input.reliability.totalScenarios > 0 ? clamp(input.reliability.completedScenarios / input.reliability.totalScenarios) : 0;
  const reliability = scoreCategory(completion * 20, 20, { scenarioCompletion: completion, crashFree: input.reliability.crashed ? 0 : 1 });
  const uncappedScore = correctness.points + performanceCategory.points + queries.points + reliability.points;
  const appliedCap = correctnessRatio < 1 ? (correctnessRatio >= 0.9 ? 85 : correctnessRatio >= 0.75 ? 65 : 40) : null;
  return { version: "2026-08-09.v7", eligibility: input.eligibility, score: input.eligibility.eligible ? appliedCap === null ? uncappedScore : Math.min(uncappedScore, appliedCap) : null, maximumScore: 100, correctness, performance: performanceCategory, queries, reliability, calculation: input.eligibility.eligible ? { correctnessRatio, uncappedScore, appliedCap } : null };
}

function selfCheck() {
  const correctness = generateCorrectnessScript("http://127.0.0.1:18084", "/repo/checks.json");
  const preparation = generatePreparationScript("http://127.0.0.1:18084", "/repo/preparation.json");
  const load = generatePerformanceScript("http://127.0.0.1:18084", "load", "self-check-load", "/repo/load.json");
  if (!correctness.includes("health.status") || !correctness.includes("aggregate.invalid-options")) throw new Error("correctness catalog generation failed");
  if (!preparation.includes("const COUNT = 1000000") || !preparation.includes("const BATCH_SIZE = 100") || !preparation.includes("benchmark fixture 0")) throw new Error("preparation generation failed");
  if (!load.includes('"startRate":150') || !load.includes('"duration":"120s"') || !load.includes("Date.now() + 30000")) throw new Error("load stage/warmup generation failed");
  const score = calculateScore({
    eligibility: { eligible: true },
    correctness: { passed: 15, total: 15 },
    performance: { logsPerSecond: 15_000, errorRate: 0, latencyP95Ms: 100, thresholdPassed: true, throughputTargetMet: true },
    queries: { aggregateP95Ms: 0, readAfterWriteSuccessRate: 1, eventualConsistencyPassedScenarios: 4, eventualConsistencyTotalScenarios: 4 },
    reliability: { crashed: false, completedScenarios: 4, totalScenarios: 4 },
  });
  if (score.score !== 100) throw new Error(`score reproduction failed: ${score.score}`);
  console.log("grader performance-v2 self-check passed (no network, Compose, or k6 execution)");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();
  if (options.selfCheck) return selfCheck();
  const runDir = path.resolve(options.outputDir, options.runId);
  await mkdir(runDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const containers = await composeContainers(options.project, options.composeFile);
  const health = await fetchJson(`${endpoint(options.url)}/health`, 15_000);
  if (!health.ok) throw new Error(`refusing to run: API is not ready at ${options.url} (${JSON.stringify(health)})`);
  const artifact = {
    schemaVersion: 1,
    runner: "standalone-log-load-generator-performance-v2",
    source: { repository: "FoothillSolutions/logs-load-generator", root: sourceRoot, commit: sourceCommit, testerVersion, k6Version },
    target: { url: endpoint(options.url), composeProject: options.project, composeFile: options.composeFile, containers, health },
    protocol: { batchSize, datasetSize, seed, warmupDuration, drainWindowMs, scenarios: options.scenarios, config: scenarios },
    phases: {},
    systemStats: [],
    commands: [],
    status: "running",
    startedAt,
  };
  const stats = async (phase, point) => {
    const sample = await dockerStats(Object.fromEntries(Object.entries(containers).map(([service, value]) => [service, value.container])));
    artifact.systemStats.push({ at: new Date().toISOString(), phase, point, ...sample });
  };
  await stats("startup", "before");

  if (!options.skipCorrectness) {
    const scriptPath = path.join(runDir, "correctness.js");
    const summaryPath = path.join(runDir, "correctness-summary.json");
    const rawPath = path.join(runDir, "correctness-k6.json");
    await writeFile(scriptPath, generateCorrectnessScript(options.url, `/repo/${path.relative(repoRoot, summaryPath)}`));
    const run = await runK6({ scriptPath, summaryPath, rawPath, image: options.k6Image, timeoutMs: 120_000 });
    const checks = `${run.stdout}\n${run.stderr}`.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/msg="(\{.*\})" source=console$/);
      try {
        const candidate = match ? JSON.parse(`"${match[1]}"`) : line;
        const value = JSON.parse(candidate);
        return value?.name ? [value] : [];
      } catch { return []; }
    });
    const expected = ["health.status", "ingestion.single", "ingestion.batch", "ingestion.partial-invalid", "ingestion.empty", "ingestion.malformed-json", "query.unfiltered", "query.filters", "query.invalid-parameters", "pagination.stable-order", "pagination.cursor", "pagination.invalid-cursor", "aggregate.buckets", "aggregate.grouping", "aggregate.invalid-options"];
    const validChecks = checks.every((check) => check.tester === testerVersion && typeof check.status === "number" && typeof check.passed === "boolean");
    artifact.phases.correctness = { run: { ...run, stdout: undefined, stderr: undefined }, checks, expectedChecks: expected, passed: checks.filter((check) => check.passed).length, total: checks.length, exactCatalog: validChecks && checks.length === expected.length && new Set(checks.map((check) => check.name)).size === expected.length && expected.every((name) => checks.some((check) => check.name === name)) };
    if (run.status !== "completed" || !artifact.phases.correctness.exactCatalog || artifact.phases.correctness.passed !== expected.length) throw new Error("correctness phase failed; see artifact");
  } else artifact.phases.correctness = { skipped: true };

  if (!options.skipPreparation) {
    const scriptPath = path.join(runDir, "preparation.js");
    const summaryPath = path.join(runDir, "preparation-summary.json");
    const rawPath = path.join(runDir, "preparation-k6.json");
    await writeFile(scriptPath, generatePreparationScript(options.url, `/repo/${path.relative(repoRoot, summaryPath)}`));
    const run = await runK6({ scriptPath, summaryPath, rawPath, image: options.k6Image, timeoutMs: 15 * 60_000 });
    artifact.phases.preparation = { run: { ...run, stdout: undefined, stderr: undefined }, summary: run.summary };
    if (run.status !== "completed") throw new Error("preparation phase failed; see artifact");
  } else artifact.phases.preparation = { skipped: true };

  for (const scenarioName of options.scenarios) {
    const scenario = scenarios[scenarioName];
    const scenarioDir = path.join(runDir, scenarioName);
    await mkdir(scenarioDir, { recursive: true });
    const marker = `${options.runId}-${scenarioName}`;
    const scriptPath = path.join(scenarioDir, "performance.js");
    const summaryPath = path.join(scenarioDir, "summary.json");
    const rawPath = path.join(scenarioDir, "k6.json");
    await writeFile(scriptPath, generatePerformanceScript(options.url, scenarioName, marker, `/repo/${path.relative(repoRoot, summaryPath)}`));
    await stats(scenarioName, "before");
    const telemetryTimer = setInterval(() => { void stats(scenarioName, "interval"); }, 5_000);
    let run;
    try { run = await runK6({ scriptPath, summaryPath, rawPath, image: options.k6Image, timeoutMs: 15 * 60_000 }); }
    finally { clearInterval(telemetryTimer); }
    await stats(scenarioName, "after");
    const measured = normalizeK6Summary(run.summary);
    const configuredDurationMs = scenario.stages.reduce((total, stage) => total + durationMs(stage.duration), 0);
    const metrics = performanceMetrics(measured, configuredDurationMs);
    const drain = await drainScenario(options.url, `benchmark-${marker}`, Math.floor(measured.acceptedLogs));
    artifact.phases[scenarioName] = { run: { ...run, stdout: undefined, stderr: undefined }, stages: scenario.stages, configuredDurationMs, measured, metrics, drain, status: run.status === "completed" ? "completed" : run.status };
    if (run.status !== "completed") throw new Error(`${scenarioName} phase failed; see artifact`);
  }

  const load = artifact.phases.load ?? artifact.phases[options.scenarios[0]];
  const phaseRows = options.scenarios.map((name) => artifact.phases[name]);
  artifact.scoreInput = {
    eligibility: { eligible: true },
    correctness: { passed: artifact.phases.correctness.passed ?? 0, total: artifact.phases.correctness.total ?? 0 },
    performance: { logsPerSecond: load?.metrics?.logsPerSecond ?? 0, errorRate: load?.measured?.failedRate ?? 0, latencyP95Ms: load?.measured?.p95 ?? null, thresholdPassed: load?.metrics?.thresholdPassed === true, throughputTargetMet: (load?.metrics?.logsPerSecond ?? 0) >= 15_000 },
    queries: { aggregateP95Ms: load?.measured?.aggregateP95 ?? null, readAfterWriteSuccessRate: load?.measured?.readAfterWriteRate ?? null, eventualConsistencyPassedScenarios: phaseRows.filter((row) => row.drain?.passed).length, eventualConsistencyTotalScenarios: 4 },
    reliability: { crashed: phaseRows.some((row) => row.status === "crashed"), completedScenarios: phaseRows.filter((row) => row.status === "completed").length, totalScenarios: phaseRows.length },
  };
  artifact.score = calculateScore(artifact.scoreInput);
  artifact.status = "passed";
  artifact.endedAt = new Date().toISOString();
  await writeFile(path.join(runDir, "result.json"), `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(JSON.stringify({ status: artifact.status, runDir, score: artifact.score, scenarios: options.scenarios }, null, 2));
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});
