#!/usr/bin/env node

/**
 * Engine-neutral benchmark client for the log-service HTTP contract.
 *
 * This file deliberately uses only Node.js built-ins.  It never starts,
 * stops, or otherwise manages the service under test.
 */

import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import process from "node:process";
import { performance } from "node:perf_hooks";

const LEVELS = ["debug", "info", "warn", "error"];
const BUCKET_MS = Object.freeze({
  "1m": 60_000,
  "5m": 300_000,
  "1h": 3_600_000,
  "1d": 86_400_000,
});

const DEFAULTS = Object.freeze({
  targetUrl: process.env.LOG_SERVICE_URL ?? "http://localhost:8080",
  seedRows: 1_000_000,
  batchSize: 500,
  durationSec: 30,
  rate: 500,
  seed: 20260720,
  sampleIntervalMs: 1_000,
  bucket: "1m",
  timeoutMs: 30_000,
  healthTimeoutMs: 30_000,
  outputDir: "benchmarks/results",
  engine: process.env.BENCH_ENGINE ?? "",
  maxInFlight: 256,
  baseAgeMs: 10 * 60_000,
  timestampSpanMs: 60_000,
});

const SMOKE_DEFAULTS = Object.freeze({
  seedRows: 10_000,
  batchSize: 100,
  durationSec: 5,
  rate: 100,
  maxInFlight: 64,
});

const SELF_CHECK = process.argv.includes("--self-check");

function fail(message, code = 2) {
  throw new Error(`${message} (exit ${code})`);
}

function numberOption(value, name, { integer = false, min = 0 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || (integer && !Number.isInteger(parsed))) {
    fail(`invalid --${name}: ${value}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  const supplied = new Set();
  let smoke = false;
  let selfCheck = false;

  const takesValue = new Set([
    "url", "target-url", "rows", "seed-rows", "batch-size", "duration",
    "duration-sec", "rate", "seed", "sample-interval-ms", "bucket",
    "timeout-ms", "health-timeout-ms", "output-dir", "out", "engine",
    "max-in-flight", "base-age-ms", "timestamp-span-ms", "run-id", "api-port", "port",
    "retention-endpoint",
  ]);

  const aliases = {
    url: "targetUrl",
    "target-url": "targetUrl",
    rows: "seedRows",
    "seed-rows": "seedRows",
    "batch-size": "batchSize",
    duration: "durationSec",
    "duration-sec": "durationSec",
    rate: "rate",
    seed: "seed",
    "sample-interval-ms": "sampleIntervalMs",
    bucket: "bucket",
    "timeout-ms": "timeoutMs",
    "health-timeout-ms": "healthTimeoutMs",
    "output-dir": "outputDir",
    out: "outputDir",
    engine: "engine",
    "max-in-flight": "maxInFlight",
    "base-age-ms": "baseAgeMs",
    "timestamp-span-ms": "timestampSpanMs",
    "run-id": "runId",
    "retention-endpoint": "retentionEndpoint",
    "api-port": "apiPort",
    port: "apiPort",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--smoke") {
      smoke = true;
      continue;
    }
    if (token === "--retention-probe") {
      options.retentionProbe = true;
      continue;
    }
    if (token === "--self-check") {
      selfCheck = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (!token.startsWith("--")) {
      fail(`unexpected argument: ${token}`);
    }

    const withoutPrefix = token.slice(2);
    const equalsAt = withoutPrefix.indexOf("=");
    const name = equalsAt === -1 ? withoutPrefix : withoutPrefix.slice(0, equalsAt);
    let value = equalsAt === -1 ? undefined : withoutPrefix.slice(equalsAt + 1);
    if (!takesValue.has(name)) {
      fail(`unknown option --${name}`);
    }
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        fail(`missing value for --${name}`);
      }
    }
    const key = aliases[name];
    supplied.add(key);
    if (key === "targetUrl" || key === "outputDir" || key === "engine" || key === "runId" || key === "retentionEndpoint") {
      options[key] = value;
    } else if (key === "bucket") {
      options[key] = value;
    } else if (["durationSec", "rate", "baseAgeMs", "timestampSpanMs"].includes(key)) {
      options[key] = numberOption(value, name, { min: 0 });
    } else if (key === "apiPort") {
      options[key] = numberOption(value, name, { integer: true, min: 1 });
      if (options[key] > 65_535) fail(`invalid --${name}: port must be <= 65535`);
    } else {
      options[key] = numberOption(value, name, { integer: true, min: 1 });
    }
  }

  if (smoke) {
    for (const [key, value] of Object.entries(SMOKE_DEFAULTS)) {
      if (!supplied.has(key)) options[key] = value;
    }
    options.smoke = true;
  }
  options.selfCheck = selfCheck || SELF_CHECK;
  if (options.selfCheck && !options.engine) options.engine = "self-check";

  if (options.help) return options;
  if (!BUCKET_MS[options.bucket]) fail(`--bucket must be one of ${Object.keys(BUCKET_MS).join(", ")}`);
  if (!options.targetUrl || !/^https?:\/\//i.test(options.targetUrl)) fail("--url must be an http(s) URL");
  if (!options.engine || !String(options.engine).trim()) fail("--engine is required (timescaledb, sqlite, clickhouse, ...)");
  if (options.seedRows < 1) fail("--rows must be at least 1");
  if (options.batchSize < 1) fail("--batch-size must be at least 1");
  if (options.durationSec <= 0) fail("--duration must be greater than zero");
  if (options.rate <= 0) fail("--rate must be greater than zero");
  if (options.sampleIntervalMs <= 0) fail("--sample-interval-ms must be greater than zero");
  if (options.timeoutMs <= 0 || options.healthTimeoutMs <= 0) fail("timeouts must be greater than zero");
  if (options.baseAgeMs < 5_000) fail("--base-age-ms must be at least 5000ms to avoid future timestamps");
  if (options.timestampSpanMs < 0) fail("--timestamp-span-ms cannot be negative");
  if (options.maxInFlight < 0) fail("--max-in-flight cannot be negative (0 means unlimited)");
  options.runId ??= defaultRunId(options.seed);
  if (!options.runId || !String(options.runId).trim()) fail("--run-id cannot be empty");
  if (options.retentionProbe && !options.retentionEndpoint) {
    fail("--retention-probe requires --retention-endpoint; no endpoint is assumed by the API contract");
  }
  if (options.apiPort !== undefined) {
    const target = new URL(options.targetUrl);
    target.port = String(options.apiPort);
    target.search = "";
    target.hash = "";
    options.targetUrl = target.toString();
  }
  return options;
}

function printHelp() {
  console.log(`Usage:
  node benchmarks/bench.mjs [options]

Runs a deterministic seed/load/query benchmark against the log-service HTTP API.
No service process is started or stopped. Node.js 20+ is required.

Defaults: --rows 1000000 --batch-size 500 --duration 30 --rate 500

Options:
  --url URL                 API base URL (default $LOG_SERVICE_URL or localhost:8080)
  --rows N                  Seed exactly N rows (alias: --seed-rows)
  --batch-size N            Rows per POST /logs request
  --duration SECONDS        Concurrent ingest phase duration
  --rate LOGS_PER_SECOND    Concurrent ingest target rate
  --seed N                  Deterministic generator seed
  --bucket 1m|5m|1h|1d      Aggregate bucket (default 1m)
  --sample-interval-ms N    Aggregate sample cadence during ingest
  --timeout-ms N            Per-request timeout
  --health-timeout-ms N     Health-check deadline
  --max-in-flight N         Concurrent POST limit (0 means unlimited)
  --engine NAME             Required artifact label (timescaledb/sqlite/clickhouse/...)
  --api-port N              Override the port in --url (alias: --port)
  --run-id ID               Isolating attribute value (otherwise generated)
  --output-dir PATH         Timestamped JSON artifact directory
  --smoke                   Smaller self-contained run (10k seed, 5s at 100/s)
  --retention-probe --retention-endpoint URL
                            Explicitly trigger an optional retention endpoint
  --self-check              Run local deterministic/unit checks; no network
  --help

The seed phase sends exactly --rows valid entries. The concurrent phase sends
floor(--rate * --duration) additional valid entries at the requested schedule.
Seed rows carry phase=seed and stream rows phase=stream, so sampled aggregates
are stable while the stream is active. Every run is isolated with attr.run_id.
`);
}

function defaultRunId(seed) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  return `bench-${stamp}-${process.pid}-${seed}`;
}

function nowIso() {
  return new Date().toISOString();
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sleepUntil(startMs, dueMs) {
  let remaining = dueMs - performance.now();
  while (remaining > 1) {
    await sleep(Math.min(remaining, 1_000));
    remaining = dueMs - performance.now();
  }
}

function floorBucket(ms, bucketMs) {
  return Math.floor(ms / bucketMs) * bucketMs;
}

function makeTimestampMs(phase, index, total, config) {
  if (phase === "stream") {
    // The base is deliberately old enough to pass the API's five-minute
    // future guard even when a request is queued for a while.
    return config.baseMs;
  }
  if (total <= 1 || config.timestampSpanMs === 0) return config.baseMs;
  const ratio = index / (total - 1);
  return config.baseMs - config.timestampSpanMs + Math.round(config.timestampSpanMs * ratio);
}

function makeEntry(phase, index, total, config) {
  const timestampMs = makeTimestampMs(phase, index, total, config);
  const serviceNumber = index % 8;
  const entry = {
    timestamp: iso(timestampMs),
    level: LEVELS[index % LEVELS.length],
    service: `benchmark-${serviceNumber}`,
    message: `${phase} deterministic log ${index}`,
    attributes: {
      run_id: config.runId,
      phase,
      generator_seed: String(config.seed),
    },
  };
  // Keep the independently computed epoch out of the wire payload. Some
  // contract validators reject unknown entry properties; this value is only
  // for the client's expected-aggregate calculation.
  Object.defineProperty(entry, "timestampMs", { value: timestampMs, enumerable: false });
  return entry;
}

function makeBatch(phase, start, count, total, config) {
  const rows = [];
  for (let offset = 0; offset < count; offset += 1) {
    rows.push(makeEntry(phase, start + offset, total, config));
  }
  return rows;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return Number(sorted[0].toFixed(3));
  const rank = (sorted.length - 1) * p;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const value = sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
  return Number(value.toFixed(3));
}

function latencySummary(samples) {
  const values = samples.filter((value) => Number.isFinite(value));
  return {
    count: values.length,
    minMs: values.length ? Number(Math.min(...values).toFixed(3)) : null,
    maxMs: values.length ? Number(Math.max(...values).toFixed(3)) : null,
    meanMs: values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(3)) : null,
    p50Ms: percentile(values, 0.50),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
  };
}

function canonicalKey(bucketStartMs, group) {
  return `${bucketStartMs}|${group === null || group === undefined ? "<null>" : String(group)}`;
}

function expectedAggregate() {
  const counts = new Map();
  let total = 0;
  return {
    add(entry, bucketMs, groupBy = "service") {
      const group = groupBy === "service" ? entry.service : groupBy === "level" ? entry.level : null;
      const key = canonicalKey(floorBucket(entry.timestampMs, bucketMs), group);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total += 1;
    },
    get total() {
      return total;
    },
    get counts() {
      return counts;
    },
  };
}

function responseAggregateRows(body) {
  if (!body || !Array.isArray(body.buckets)) {
    throw new Error("aggregate response must contain a buckets array");
  }
  return body.buckets;
}

function normalizeAggregate(rows, bucketMs, groupBy = "service") {
  const counts = new Map();
  const errors = [];
  let total = 0;
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== "object") {
      errors.push(`bucket ${index} is not an object`);
      continue;
    }
    const startMs = Date.parse(row.start);
    const count = Number(row.count);
    if (!Number.isFinite(startMs) || !Number.isInteger(count) || count < 0) {
      errors.push(`bucket ${index} has invalid start/count`);
      continue;
    }
    const group = groupBy ? (row.group === null || row.group === undefined ? null : String(row.group)) : null;
    const key = canonicalKey(floorBucket(startMs, bucketMs), group);
    if (counts.has(key)) errors.push(`duplicate bucket/group ${key}`);
    counts.set(key, (counts.get(key) ?? 0) + count);
    total += count;
  }
  return { counts, total, errors };
}

function compareAggregate(expected, actual) {
  const missing = [];
  const unexpected = [];
  const mismatched = [];
  for (const [key, count] of expected.counts.entries()) {
    if (!actual.counts.has(key)) missing.push({ key, expected: count });
    else if (actual.counts.get(key) !== count) mismatched.push({ key, expected: count, actual: actual.counts.get(key) });
  }
  for (const [key, count] of actual.counts.entries()) {
    if (!expected.counts.has(key)) unexpected.push({ key, actual: count });
  }
  return {
    ok: !missing.length && !unexpected.length && !mismatched.length && !actual.errors.length,
    expectedTotal: expected.total,
    actualTotal: actual.total,
    missing: missing.slice(0, 20),
    unexpected: unexpected.slice(0, 20),
    mismatched: mismatched.slice(0, 20),
    responseErrors: actual.errors.slice(0, 20),
    differenceCount: missing.length + unexpected.length + mismatched.length + actual.errors.length,
  };
}

function queryBounds(config) {
  const first = config.baseMs - config.timestampSpanMs;
  const pad = BUCKET_MS[config.bucket];
  return {
    since: iso(first - pad),
    // Keep the range in the past even when a caller deliberately chooses a
    // very small --base-age-ms; the ingestion contract's future guard is not
    // required for query parameters, but implementations commonly reject a
    // future query bound as a convenience.
    until: iso(Math.min(config.baseMs + pad, Date.now() - 1_000)),
  };
}

function filterQuery(config, phase) {
  const params = new URLSearchParams();
  params.set("since", queryBounds(config).since);
  params.set("until", queryBounds(config).until);
  params.set("bucket", config.bucket);
  params.set("group_by", "service");
  params.set("attr.run_id", config.runId);
  if (phase) params.set("attr.phase", phase);
  return params;
}

function baseUrl(url) {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    // The CLI accepts a base URL, not a pre-populated query. Dropping query
    // and fragment also prevents credentials or tokens from entering the
    // artifact and keeps endpoint concatenation correct.
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "<invalid-url>";
  }
}

async function requestJson(method, url, body, timeoutMs) {
  const started = performance.now();
  let response;
  let text = "";
  let error = null;
  try {
    const init = {
      method,
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    response = await fetch(url, init);
    text = await response.text();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const ended = performance.now();
  let parsed;
  if (!error && text) {
    try {
      parsed = JSON.parse(text);
    } catch (caught) {
      error = `invalid JSON response: ${caught instanceof Error ? caught.message : String(caught)}`;
    }
  }
  return {
    status: response?.status ?? null,
    ok: Boolean(response?.ok) && !error,
    body: parsed,
    rawBody: text.slice(0, 1_000),
    error,
    latencyMs: Number((ended - started).toFixed(3)),
  };
}

async function healthCheck(config) {
  const deadline = performance.now() + config.healthTimeoutMs;
  let last = null;
  while (performance.now() < deadline) {
    last = await requestJson("GET", `${baseUrl(config.targetUrl)}/health`, undefined, Math.min(config.timeoutMs, 5_000));
    if (last.status === 200) return last;
    await sleep(250);
  }
  throw new Error(`health check failed before deadline: ${JSON.stringify(last)}`);
}

function ingestionResult(response, batch, expectedSeed, expectedAll, config) {
  const hasRejectedArray = Array.isArray(response.body?.rejected);
  const rejected = hasRejectedArray ? response.body.rejected : [];
  const accepted = Number(response.body?.accepted);
  const rejectedIndexes = new Set();
  for (const item of rejected) {
    if (Number.isInteger(item?.index) && item.index >= 0 && item.index < batch.length) rejectedIndexes.add(item.index);
  }
  const inferredAcceptedIndexes = [];
  for (let index = 0; index < batch.length; index += 1) {
    if (!rejectedIndexes.has(index)) inferredAcceptedIndexes.push(index);
  }

  const validShape = Number.isInteger(accepted) && accepted >= 0 && accepted <= batch.length
    && hasRejectedArray
    && rejectedIndexes.size === rejected.length
    && accepted + rejected.length === batch.length;
  const statusValid = response.status === 200 && validShape;
  if (statusValid) {
    // The generated entries are all valid. If a server reports a partial
    // acceptance, only count entries whose indexes were not rejected; the
    // final aggregate check will expose any server-side inconsistency.
    for (const index of inferredAcceptedIndexes) {
      const entry = batch[index];
      expectedAll.add(entry, BUCKET_MS[config.bucket], "service");
      if (entry.attributes.phase === "seed") expectedSeed.add(entry, BUCKET_MS[config.bucket], "service");
    }
  }
  return {
    ok: statusValid && rejected.length === 0 && accepted === batch.length,
    accepted: Number.isInteger(accepted) ? accepted : 0,
    rejectedCount: rejected.length,
    rejected: rejected.slice(0, 20),
    protocolError: validShape ? null : "response must report accepted + rejected indexes equal to batch size",
  };
}

async function postBatch(phase, batch, expectedSeed, expectedAll, config, metrics) {
  metrics.attemptedRows += batch.length;
  const request = await requestJson("POST", `${baseUrl(config.targetUrl)}/logs`, { logs: batch }, config.timeoutMs);
  metrics.latencies.push(request.latencyMs);
  metrics.requests += 1;
  const parsed = ingestionResult(request, batch, expectedSeed, expectedAll, config);
  metrics.accepted += parsed.accepted;
  metrics.rejected += parsed.rejectedCount;
  if (!request.ok || !parsed.ok) {
    metrics.failures += 1;
    metrics.failureDetails.push({
      phase,
      status: request.status,
      error: request.error,
      protocolError: parsed.protocolError,
      accepted: parsed.accepted,
      rejected: parsed.rejected.slice(0, 5),
      body: request.rawBody,
    });
  }
  return { ...request, ...parsed };
}

async function verifyAggregate(config, expected, phase, label, metrics) {
  const url = `${baseUrl(config.targetUrl)}/logs/aggregate?${filterQuery(config, phase).toString()}`;
  const response = await requestJson("GET", url, undefined, config.timeoutMs);
  metrics.latencies.push(response.latencyMs);
  metrics.requests += 1;
  if (!response.ok) {
    metrics.failures += 1;
    metrics.failureDetails.push({ phase: label, status: response.status, error: response.error, body: response.rawBody });
    return {
      label,
      ok: false,
      latencyMs: response.latencyMs,
      error: response.error ?? `HTTP ${response.status}`,
      expectedTotal: expected.total,
      actualTotal: null,
    };
  }
  let actual;
  try {
    actual = normalizeAggregate(responseAggregateRows(response.body), BUCKET_MS[config.bucket], "service");
  } catch (error) {
    metrics.failures += 1;
    metrics.failureDetails.push({ phase: label, status: response.status, error: error.message });
    return { label, ok: false, latencyMs: response.latencyMs, error: error.message, expectedTotal: expected.total, actualTotal: null };
  }
  const comparison = compareAggregate(expected, actual);
  if (!comparison.ok) metrics.failures += 1;
  return { label, latencyMs: response.latencyMs, ...comparison };
}

async function verifyLogRead(config) {
  const params = new URLSearchParams();
  params.set("attr.run_id", config.runId);
  params.set("limit", "1");
  const response = await requestJson("GET", `${baseUrl(config.targetUrl)}/logs?${params.toString()}`, undefined, config.timeoutMs);
  const first = response.body?.logs?.[0];
  const ok = response.ok && Array.isArray(response.body?.logs) && response.body.logs.length > 0
    && first?.attributes?.run_id === config.runId;
  return {
    ok,
    status: response.status,
    latencyMs: response.latencyMs,
    countReturned: Array.isArray(response.body?.logs) ? response.body.logs.length : null,
    nextCursorType: response.body && Object.hasOwn(response.body, "next_cursor") ? (response.body.next_cursor === null ? "null" : typeof response.body.next_cursor) : "missing",
    error: ok ? null : response.error ?? "persisted log not found or invalid /logs response",
  };
}

function phaseMetrics() {
  return {
    requests: 0,
    attemptedRows: 0,
    accepted: 0,
    rejected: 0,
    failures: 0,
    latencies: [],
    failureDetails: [],
  };
}

function summarizePhase(metrics, durationMs) {
  return {
    requests: metrics.requests,
    attemptedRows: metrics.attemptedRows,
    acceptedRows: metrics.accepted,
    rejectedRows: metrics.rejected,
    failures: metrics.failures,
    durationMs: Number(durationMs.toFixed(3)),
    observedAcceptedRate: durationMs > 0 ? Number((metrics.accepted / (durationMs / 1_000)).toFixed(3)) : null,
    latencyMs: latencySummary(metrics.latencies),
    failureDetails: metrics.failureDetails.slice(0, 100),
  };
}

async function runSeed(config, expectedSeed, expectedAll) {
  const metrics = phaseMetrics();
  const started = performance.now();
  let next = 0;
  while (next < config.seedRows) {
    const count = Math.min(config.batchSize, config.seedRows - next);
    const batch = makeBatch("seed", next, count, config.seedRows, config);
    await postBatch("seed", batch, expectedSeed, expectedAll, config, metrics);
    next += count;
  }
  return { metrics, summary: summarizePhase(metrics, performance.now() - started) };
}

async function runStream(config, expectedSeed, expectedAll) {
  const metrics = phaseMetrics();
  const sampleMetrics = { requests: 0, failures: 0, latencies: [], failureDetails: [] };
  const targetRows = Math.floor(config.rate * config.durationSec);
  const started = performance.now();
  const dispatchStarted = started;
  const pending = new Set();
  const samples = [];
  let stopSampling = false;
  // Take one sample immediately so even a short smoke/custom run proves that
  // the predeclared aggregate is queried while stream requests are active.
  let nextSampleAt = started - config.sampleIntervalMs;

  const sampler = (async () => {
    while (!stopSampling) {
      nextSampleAt += config.sampleIntervalMs;
      await sleepUntil(started, nextSampleAt);
      if (stopSampling) break;
      const sampleStart = performance.now();
      const result = await verifyAggregate(config, expectedSeed, "seed", "sample", sampleMetrics);
      const sample = {
        at: nowIso(),
        latencyMs: result.latencyMs,
        ok: result.ok,
        expectedTotal: result.expectedTotal,
        actualTotal: result.actualTotal,
        differenceCount: result.differenceCount ?? null,
        error: result.error ?? null,
        elapsedSincePhaseStartMs: Number((sampleStart - started).toFixed(3)),
      };
      samples.push(sample);
    }
  })();

  let sent = 0;
  let dispatchLast = dispatchStarted;
  let lastBatchDurationMs = 0;
  let maxDispatchLagMs = 0;
  while (sent < targetRows) {
    const count = Math.min(config.batchSize, targetRows - sent);
    const batch = makeBatch("stream", sent, count, targetRows, config);
    const idealAt = dispatchStarted + (sent / config.rate) * 1_000;
    await sleepUntil(dispatchStarted, idealAt);
    const dispatchAt = performance.now();
    dispatchLast = dispatchAt;
    lastBatchDurationMs = (count / config.rate) * 1_000;
    maxDispatchLagMs = Math.max(maxDispatchLagMs, dispatchAt - idealAt);
    const promise = postBatch("stream", batch, expectedSeed, expectedAll, config, metrics)
      .finally(() => pending.delete(promise));
    pending.add(promise);
    sent += count;
    if (config.maxInFlight > 0 && pending.size >= config.maxInFlight) await Promise.race(pending);
  }
  await Promise.all(pending);
  // Keep the phase wall clock at the requested duration when the service is
  // faster than the schedule. This makes acceptedRows / duration directly
  // comparable to the requested rate; a slow service naturally extends the
  // phase past this horizon and exposes a lower completion rate.
  const scheduledHorizon = dispatchStarted + (targetRows / config.rate) * 1_000;
  await sleepUntil(dispatchStarted, scheduledHorizon);
  stopSampling = true;
  await sampler;
  const ended = performance.now();

  return {
    targetRows,
    targetRate: config.rate,
    dispatch: {
      attemptedRows: targetRows,
      scheduledDurationMs: targetRows > 0 ? Number(((targetRows / config.rate) * 1_000).toFixed(3)) : 0,
      dispatchStartToLastMs: Number(Math.max(0, dispatchLast - dispatchStarted).toFixed(3)),
      scheduledRate: config.rate,
      actualDispatchWindowMs: dispatchLast > dispatchStarted ? Number(((dispatchLast - dispatchStarted + lastBatchDurationMs)).toFixed(3)) : 0,
      actualDispatchRate: dispatchLast >= dispatchStarted && lastBatchDurationMs > 0
        ? Number((targetRows / ((dispatchLast - dispatchStarted + lastBatchDurationMs) / 1_000)).toFixed(3))
        : null,
      maxDispatchLagMs: Number(maxDispatchLagMs.toFixed(3)),
    },
    summary: summarizePhase(metrics, ended - started),
    ingestLatencySamples: metrics.latencies,
    samples: {
      count: samples.length,
      correct: samples.filter((sample) => sample.ok).length,
      correctnessRate: samples.length ? Number((samples.filter((sample) => sample.ok).length / samples.length).toFixed(4)) : null,
      latencyMs: latencySummary(sampleMetrics.latencies),
      failures: sampleMetrics.failures,
      failureDetails: sampleMetrics.failureDetails.slice(0, 100),
      results: samples,
    },
  };
}

async function runRetentionProbe(config, expectedAll) {
  if (!config.retentionProbe) return { status: "skipped", reason: "not requested" };
  const started = performance.now();
  const response = await requestJson("POST", config.retentionEndpoint, {}, config.timeoutMs);
  const health = await requestJson("GET", `${baseUrl(config.targetUrl)}/health`, undefined, config.timeoutMs);
  // Retention is allowed to delete some of this run's historical rows, so a
  // post-trigger exact comparison against expectedAll would report a false
  // failure. Instead, validate that the aggregate route remains callable and
  // report the observed retained count for interpretation alongside the
  // exact pre-trigger verification.
  const aggregateUrl = `${baseUrl(config.targetUrl)}/logs/aggregate?${filterQuery(config, null).toString()}`;
  const aggregateResponse = await requestJson("GET", aggregateUrl, undefined, config.timeoutMs);
  let aggregateAfter = null;
  let aggregateError = null;
  if (aggregateResponse.ok) {
    try {
      const normalized = normalizeAggregate(responseAggregateRows(aggregateResponse.body), BUCKET_MS[config.bucket], "service");
      aggregateAfter = { bucketRows: aggregateResponse.body.buckets.length, retainedCount: normalized.total };
    } catch (error) {
      aggregateError = error.message;
    }
  } else {
    aggregateError = aggregateResponse.error ?? `HTTP ${aggregateResponse.status}`;
  }
  return {
    status: response.ok && health.status === 200 && aggregateError === null ? "passed" : "failed",
    endpoint: redactUrl(config.retentionEndpoint),
    triggerStatus: response.status,
    triggerError: response.error,
    healthStatus: health.status,
    aggregateStatus: aggregateResponse.status,
    aggregateAfter,
    aggregateError,
    expectedBeforeCount: expectedAll.total,
    durationMs: Number((performance.now() - started).toFixed(3)),
    note: "Retention may delete historical rows; exact persistence was checked before this probe.",
  };
}

function machineMetadata() {
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    node: process.version,
    cpuCount: cpus.length,
    cpuModel: cpus[0]?.model ?? null,
    cpuSpeedMHz: cpus[0]?.speed ?? null,
    memoryTotalBytes: os.totalmem(),
    memoryFreeBytesAtStart: os.freemem(),
    loadAverageAtStart: os.loadavg(),
  };
}

function resultPath(config, startedAt) {
  const stamp = startedAt.replace(/[-:.TZ]/g, "");
  const safeRunId = config.runId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${config.outputDir}/log-benchmark-${stamp}-${safeRunId}.json`;
}

async function writeArtifact(config, artifact, startedAt) {
  const path = resultPath(config, startedAt);
  await mkdir(config.outputDir, { recursive: true });
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return path;
}

function configForRun(options) {
  const baseMs = Date.now() - options.baseAgeMs;
  return {
    ...options,
    baseMs,
    targetUrl: redactUrl(options.targetUrl),
  };
}

async function runBenchmark(options) {
  const startedAt = nowIso();
  const started = performance.now();
  const config = configForRun(options);
  const expectedSeed = expectedAggregate();
  const expectedAll = expectedAggregate();
  const artifact = {
    schemaVersion: 1,
    benchmark: "log-service-http",
    status: "running",
    startedAt,
    endedAt: null,
    engine: config.engine,
    config: {
      targetUrl: config.targetUrl,
      apiPort: config.apiPort ?? null,
      engine: config.engine,
      seedRows: config.seedRows,
      batchSize: config.batchSize,
      durationSec: config.durationSec,
      rate: config.rate,
      seed: config.seed,
      runId: config.runId,
      bucket: config.bucket,
      aggregateQuery: {
        endpoint: "/logs/aggregate",
        bucket: config.bucket,
        groupBy: "service",
        sampledFilters: ["attr.run_id", "attr.phase=seed"],
        finalFilters: ["attr.run_id"],
      },
      sampleIntervalMs: config.sampleIntervalMs,
      timeoutMs: config.timeoutMs,
      maxInFlight: config.maxInFlight,
      baseTimestamp: iso(config.baseMs),
      timestampSpanMs: config.timestampSpanMs,
      smoke: Boolean(config.smoke),
      retentionProbeRequested: Boolean(config.retentionProbe),
    },
    machine: machineMetadata(),
    phases: {},
    verification: {},
    metrics: {
      failures: 0,
      failureDetails: [],
      ingestLatencyMs: null,
      aggregateLatencyMs: null,
    },
    durationsMs: {},
    retention: { status: "not-run" },
  };

  try {
    const healthStart = performance.now();
    const health = await healthCheck(config);
    artifact.verification.health = { ok: true, status: health.status, latencyMs: health.latencyMs };
    artifact.durationsMs.health = Number((performance.now() - healthStart).toFixed(3));

    const seedStart = performance.now();
    const seed = await runSeed(config, expectedSeed, expectedAll);
    artifact.phases.seed = seed.summary;
    artifact.durationsMs.seed = Number((performance.now() - seedStart).toFixed(3));

    const seedVerifyStart = performance.now();
    artifact.verification.seedAggregate = await verifyAggregate(
      config,
      expectedSeed,
      "seed",
      "seed",
      { latencies: [], requests: 0, failures: 0, failureDetails: [] },
    );
    artifact.verification.seedLogs = await verifyLogRead(config);
    artifact.durationsMs.seedVerification = Number((performance.now() - seedVerifyStart).toFixed(3));

    const streamStart = performance.now();
    const stream = await runStream(config, expectedSeed, expectedAll);
    artifact.phases.stream = stream.summary;
    artifact.phases.streamRateControl = stream.dispatch;
    artifact.phases.aggregateSamples = stream.samples;
    artifact.durationsMs.stream = Number((performance.now() - streamStart).toFixed(3));

    const finalVerifyStart = performance.now();
    artifact.verification.finalAggregate = await verifyAggregate(
      config,
      expectedAll,
      null,
      "final",
      { latencies: [], requests: 0, failures: 0, failureDetails: [] },
    );
    artifact.verification.finalLogs = await verifyLogRead(config);
    artifact.durationsMs.finalVerification = Number((performance.now() - finalVerifyStart).toFixed(3));

    const retentionStart = performance.now();
    artifact.retention = await runRetentionProbe(config, expectedAll);
    artifact.durationsMs.retention = Number((performance.now() - retentionStart).toFixed(3));

    const phaseFailureDetails = [
      ...(seed.metrics.failureDetails ?? []),
      ...(stream.summary.failureDetails ?? []),
      ...(stream.samples.failureDetails ?? []),
      ...["seedAggregate", "seedLogs", "finalAggregate", "finalLogs"]
        .filter((key) => artifact.verification[key] && !artifact.verification[key].ok)
        .map((key) => ({ verification: key, ...artifact.verification[key] })),
      ...(artifact.retention.status === "failed" ? [{ verification: "retention", ...artifact.retention }] : []),
    ];
    const failures = (seed.summary.failures ?? 0)
      + (stream.summary.failures ?? 0)
      + (stream.samples.failures ?? 0)
      + (artifact.verification.seedAggregate.ok ? 0 : 1)
      + (artifact.verification.seedLogs.ok ? 0 : 1)
      + (artifact.verification.finalAggregate.ok ? 0 : 1)
      + (artifact.verification.finalLogs.ok ? 0 : 1)
      + (artifact.retention.status === "failed" ? 1 : 0);
    artifact.metrics.failures = failures;
    artifact.metrics.failureDetails = phaseFailureDetails.slice(0, 200);
    artifact.metrics.ingestLatencyMs = latencySummary([
      ...(seed.metrics.latencies ?? []),
      ...(stream.ingestLatencySamples ?? []),
    ]);
    // Keep the per-phase summaries authoritative while also exposing a
    // top-level aggregate latency summary for comparison tools.
    artifact.metrics.aggregateLatencyMs = latencySummary([
      ...(stream.samples.results ?? []).map((sample) => sample.latencyMs),
      artifact.verification.seedAggregate.latencyMs,
      artifact.verification.finalAggregate.latencyMs,
    ].filter(Number.isFinite));
    artifact.metrics.ingest = {
      seedAcceptedRows: seed.summary.acceptedRows,
      streamAcceptedRows: stream.summary.acceptedRows,
      totalAcceptedRows: seed.summary.acceptedRows + stream.summary.acceptedRows,
      targetStreamRate: config.rate,
      observedStreamCompletionRate: stream.summary.observedAcceptedRate,
      scheduledStreamRate: stream.dispatch.scheduledRate,
    };
    const throughputElapsedMs = performance.now() - started;
    artifact.throughput = {
      targetStreamLogsPerSecond: config.rate,
      seedAcceptedLogsPerSecond: seed.summary.observedAcceptedRate,
      streamAcceptedLogsPerSecond: stream.summary.observedAcceptedRate,
      streamPlannedLogsPerSecond: stream.dispatch.scheduledRate,
      streamDispatchLogsPerSecond: stream.dispatch.actualDispatchRate,
      totalAcceptedLogsPerSecond: throughputElapsedMs > 0
        ? Number(((seed.summary.acceptedRows + stream.summary.acceptedRows) / (throughputElapsedMs / 1_000)).toFixed(3))
        : null,
    };
    artifact.correctness = {
      seedPersisted: artifact.verification.seedAggregate.ok && artifact.verification.seedLogs.ok,
      samplesCorrect: stream.samples.count > 0 && stream.samples.correct === stream.samples.count,
      finalPersisted: artifact.verification.finalAggregate.ok && artifact.verification.finalLogs.ok,
      overall: artifact.verification.seedAggregate.ok
        && artifact.verification.seedLogs.ok
        && artifact.verification.finalAggregate.ok
        && artifact.verification.finalLogs.ok
        && stream.samples.count > 0
        && stream.samples.correct === stream.samples.count,
    };
    artifact.status = artifact.metrics.failures === 0 && artifact.correctness.overall ? "passed" : "failed";
  } catch (error) {
    artifact.status = "error";
    artifact.metrics.failures += 1;
    artifact.metrics.failureDetails.push({ fatal: error instanceof Error ? error.message : String(error) });
  } finally {
    artifact.endedAt = nowIso();
    artifact.durationsMs.total = Number((performance.now() - started).toFixed(3));
    artifact.config.expectedRows = {
      seedAccepted: expectedSeed.total,
      allAccepted: expectedAll.total,
    };
  }

  const path = await writeArtifact(config, artifact, startedAt);
  console.log(JSON.stringify({ status: artifact.status, artifact: path, runId: config.runId, failures: artifact.metrics.failures }, null, 2));
  return artifact.status === "passed" ? 0 : 1;
}

function selfCheck() {
  const config = {
    seed: 7,
    runId: "self-check",
    baseMs: Date.parse("2026-07-20T14:32:00.000Z"),
    timestampSpanMs: 60_000,
    bucket: "1m",
  };
  const a = makeBatch("seed", 0, 10, 10, config);
  const b = makeBatch("seed", 0, 10, 10, config);
  if (JSON.stringify(a) !== JSON.stringify(b)) fail("deterministic batch generation failed");
  if (JSON.stringify(a).includes("timestampMs") || a[0].timestampMs !== Date.parse(a[0].timestamp)) fail("internal timestamp leaked into wire payload");
  if (a[0].timestamp !== "2026-07-20T14:31:00.000Z" || a[9].timestamp !== "2026-07-20T14:32:00.000Z") fail("timestamp range check failed");
  const expected = expectedAggregate();
  for (const row of a) expected.add(row, BUCKET_MS[config.bucket], "service");
  const actual = normalizeAggregate([
    { start: "2026-07-20T14:31:00.000Z", group: "benchmark-0", count: 1 },
    { start: "2026-07-20T14:31:00.000Z", group: "benchmark-1", count: 1 },
    { start: "2026-07-20T14:31:00.000Z", group: "benchmark-2", count: 1 },
    { start: "2026-07-20T14:31:00.000Z", group: "benchmark-3", count: 1 },
    { start: "2026-07-20T14:31:00.000Z", group: "benchmark-4", count: 1 },
    { start: "2026-07-32T14:31:00.000Z", group: "benchmark-5", count: 1 },
  ], BUCKET_MS[config.bucket], "service");
  if (!actual.errors.length) fail("invalid aggregate date should be rejected");
  const known = normalizeAggregate(
    [...expected.counts.entries()].map(([key, count]) => {
      const [bucketStart, group] = key.split("|");
      return { start: iso(Number(bucketStart)), group, count };
    }),
    BUCKET_MS[config.bucket],
    "service",
  );
  if (!compareAggregate(expected, known).ok) fail("aggregate normalization check failed");
  if (percentile([1, 2, 3, 4], 0.5) !== 2.5 || percentile([], 0.5) !== null) fail("percentile check failed");
  const parsed = parseArgs(["--smoke", "--rate", "500", "--engine", "sqlite", "--api-port", "18081"]);
  if (parsed.seedRows !== SMOKE_DEFAULTS.seedRows || parsed.rate !== 500 || parsed.batchSize !== SMOKE_DEFAULTS.batchSize) fail("argument parser check failed");
  if (new URL(parsed.targetUrl).port !== "18081" || parsed.engine !== "sqlite") fail("port/engine argument check failed");
  console.log("benchmark self-check passed (no network requests made)");
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
  } else if (options.selfCheck) {
    selfCheck();
  } else {
    const exitCode = await runBenchmark(options);
    process.exitCode = exitCode;
  }
} catch (error) {
  if (error?.message?.startsWith("Usage:")) console.error(error.message);
  else console.error(`benchmark error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
