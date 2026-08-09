#!/usr/bin/env node

/**
 * Targeted TimescaleDB completion-evidence probe.
 *
 * This is intentionally separate from bench.mjs: it exercises the HTTP
 * protocol and keyset contract directly, captures the generated PostgreSQL
 * plan/index/chunk evidence, and observes configured retention while a small
 * 500-log/s stream is active.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const DEFAULT_API_URL = process.env.API_URL ?? "http://127.0.0.1:18110";
const DEFAULT_PROJECT = process.env.COMPOSE_PROJECT ?? "timescale-completion-evidence-20260810";
const DEFAULT_OUTPUT_DIR = process.env.OUTPUT_DIR ?? path.join(ROOT, "benchmarks", "results");
const DEFAULT_RUN_ID = process.env.RUN_ID ?? "timescale-completion-evidence-20260810";
const COMPOSE_FILE = process.env.COMPOSE_FILE ?? path.join(ROOT, "docker-compose.yml");
const COMPOSE_OVERRIDE = process.env.COMPOSE_OVERRIDE
  ?? path.join(ROOT, "benchmarks", "results", "timescale-completion-evidence-20260810.compose.override.yml");
const DB_SERVICE = process.env.DB_SERVICE ?? "timescaledb";
const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS ?? 30_000);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isoAt(base, offsetMs) {
  return new Date(base.getTime() + offsetMs).toISOString();
}

function medianPercentile(values, percentile) {
  const sorted = [...values].filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return Number(sorted[lower].toFixed(3));
  return Number((sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)).toFixed(3));
}

function latencySummary(latencies) {
  return {
    count: latencies.length,
    p50Ms: medianPercentile(latencies, 0.5),
    p95Ms: medianPercentile(latencies, 0.95),
    p99Ms: medianPercentile(latencies, 0.99),
    maxMs: latencies.length ? Number(Math.max(...latencies).toFixed(3)) : null,
  };
}

function row(timestamp, service, level, message, attributes) {
  return { timestamp, service, level, message, attributes };
}

async function requestJson(apiUrl, method, route, body = undefined) {
  const started = performance.now();
  try {
    const response = await fetch(new URL(route, `${apiUrl}/`).toString(), {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    return {
      ok: response.ok,
      status: response.status,
      body: parsed,
      error: response.ok ? null : `HTTP ${response.status}`,
      latencyMs: Number((performance.now() - started).toFixed(3)),
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      body: null,
      error: error instanceof Error ? error.message : String(error),
      latencyMs: Number((performance.now() - started).toFixed(3)),
    };
  }
}

async function waitForHealth(apiUrl, deadlineMs = 60_000) {
  const started = Date.now();
  const attempts = [];
  while (Date.now() - started < deadlineMs) {
    const response = await requestJson(apiUrl, "GET", "/health");
    attempts.push({ status: response.status, ok: response.ok, latencyMs: response.latencyMs, error: response.error });
    if (response.ok && response.status === 200 && response.body?.status === "ok") {
      return { ok: true, attempts, elapsedMs: Date.now() - started };
    }
    await sleep(500);
  }
  return { ok: false, attempts, elapsedMs: Date.now() - started };
}

function queryRoute(route, params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) query.set(key, String(value));
  }
  return `${route}?${query.toString()}`;
}

function requestQuery(apiUrl, route, params) {
  return requestJson(apiUrl, "GET", queryRoute(route, params));
}

async function insertBatches(apiUrl, logs, batchSize = 250) {
  const latencies = [];
  const failures = [];
  let accepted = 0;
  let rejected = 0;
  let requests = 0;
  for (let offset = 0; offset < logs.length; offset += batchSize) {
    const batch = logs.slice(offset, offset + batchSize);
    const response = await requestJson(apiUrl, "POST", "/logs", { logs: batch });
    requests += 1;
    latencies.push(response.latencyMs);
    if (!response.ok) {
      failures.push({ request: requests, offset, status: response.status, error: response.error });
      continue;
    }
    accepted += number(response.body?.accepted) ?? 0;
    rejected += Array.isArray(response.body?.rejected) ? response.body.rejected.length : 0;
  }
  return { requests, attempted: logs.length, accepted, rejected, failures, latency: latencySummary(latencies) };
}

function strictDescending(previous, current) {
  const previousTimestamp = Date.parse(previous.timestamp);
  const currentTimestamp = Date.parse(current.timestamp);
  if (previousTimestamp !== currentTimestamp) return previousTimestamp > currentTimestamp;
  return previous.id > current.id;
}

function checkOrdering(logs) {
  const violations = [];
  for (let index = 1; index < logs.length; index += 1) {
    if (!strictDescending(logs[index - 1], logs[index])) {
      violations.push({ index, previous: logs[index - 1], current: logs[index] });
    }
  }
  return { checked: Math.max(0, logs.length - 1), violations };
}

function aggregateTotal(body) {
  if (!Array.isArray(body?.buckets)) return null;
  return body.buckets.reduce((total, bucket) => total + (number(bucket.count) ?? 0), 0);
}

async function aggregate(apiUrl, params) {
  const response = await requestQuery(apiUrl, "/logs/aggregate", params);
  return {
    ok: response.ok,
    status: response.status,
    latencyMs: response.latencyMs,
    error: response.error,
    buckets: response.body?.buckets ?? null,
    total: aggregateTotal(response.body),
  };
}

async function traverseCursor(apiUrl, params, pageSize, expectedRows, aggregateResult, expectedMessages = []) {
  const pages = [];
  const allLogs = [];
  const seenIds = new Set();
  const seenCursors = new Set();
  let cursor = null;
  let pageNumber = 0;
  let fatalError = null;
  while (pageNumber < expectedRows + 5) {
    const pageParams = { ...params, limit: pageSize };
    if (cursor !== null) pageParams.cursor = cursor;
    const response = await requestQuery(apiUrl, "/logs", pageParams);
    pageNumber += 1;
    const logs = Array.isArray(response.body?.logs) ? response.body.logs : [];
    const nextCursor = response.body?.next_cursor ?? null;
    pages.push({ page: pageNumber, status: response.status, ok: response.ok, count: logs.length, nextCursorPresent: nextCursor !== null, latencyMs: response.latencyMs, error: response.error });
    if (!response.ok) {
      fatalError = response.error ?? `HTTP ${response.status}`;
      break;
    }
    for (const log of logs) {
      allLogs.push(log);
      if (seenIds.has(log.id)) continue;
      seenIds.add(log.id);
    }
    if (nextCursor === null) break;
    if (seenCursors.has(nextCursor)) {
      fatalError = "cursor repeated";
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  if (pageNumber >= expectedRows + 5 && cursor !== null) fatalError = "cursor traversal exceeded safety page bound";
  const ordering = checkOrdering(allLogs);
  const duplicateCount = allLogs.length - seenIds.size;
  const uniqueCount = seenIds.size;
  const aggregateCount = aggregateResult.total;
  const expectedMessageSet = new Set(expectedMessages);
  const returnedMessageSet = new Set(allLogs.map((log) => log.message));
  const missingMessages = [...expectedMessageSet].filter((message) => !returnedMessageSet.has(message));
  const unexpectedMessages = [...returnedMessageSet].filter((message) => !expectedMessageSet.has(message));
  return {
    pageSize,
    expectedRows,
    pages,
    returnedRows: allLogs.length,
    uniqueRows: uniqueCount,
    duplicateRows: duplicateCount,
    missingMessages,
    unexpectedMessages,
    omissionsAgainstAggregate: aggregateCount === null ? null : aggregateCount - uniqueCount,
    aggregateCount,
    ordering,
    fatalError,
    complete: fatalError === null && nextCursorIsNull(pages) && uniqueCount === expectedRows && duplicateCount === 0 && missingMessages.length === 0 && unexpectedMessages.length === 0 && ordering.violations.length === 0 && aggregateCount === expectedRows,
  };
}

function nextCursorIsNull(pages) {
  return pages.length > 0 && pages.at(-1).nextCursorPresent === false;
}

function sqlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function command(args, options = {}) {
  try {
    const result = await execFileAsync(args[0], args.slice(1), { cwd: ROOT, maxBuffer: 32 * 1024 * 1024, ...options });
    return { ok: true, stdout: result.stdout, stderr: result.stderr, error: null };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function databaseContainer(project) {
  const result = await command(["docker", "compose", "-p", project, "-f", COMPOSE_FILE, "-f", COMPOSE_OVERRIDE, "ps", "-q", DB_SERVICE]);
  const container = result.stdout.trim().split(/\s+/)[0] ?? "";
  return { ...result, container: container || null };
}

async function psql(container, sql) {
  if (!container) return { ok: false, stdout: "", stderr: "", error: "database container was not found" };
  return command(["docker", "exec", container, "psql", "-U", "postgres", "-d", "logs", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql]);
}

async function psqlJson(container, sql) {
  const result = await psql(container, sql);
  if (!result.ok) return { ...result, value: null };
  try {
    return { ...result, value: JSON.parse(result.stdout.trim() || "null") };
  } catch (error) {
    return { ...result, value: null, error: `invalid JSON from psql: ${error.message}` };
  }
}

async function psqlScalar(container, sql) {
  const result = await psql(container, sql);
  if (!result.ok) return { ...result, value: null };
  const raw = result.stdout.trim();
  const value = Number(raw);
  return { ...result, value: Number.isFinite(value) ? value : raw };
}

function planNodes(plan) {
  const nodes = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node["Node Type"]) {
      nodes.push({
        nodeType: node["Node Type"],
        indexName: node["Index Name"] ?? null,
        relationName: node["Relation Name"] ?? null,
        actualRows: node["Actual Rows"] ?? null,
        actualTotalTimeMs: node["Actual Total Time"] ?? null,
        loops: node["Actual Loops"] ?? null,
      });
    }
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(plan);
  return nodes;
}

async function main() {
  const runId = DEFAULT_RUN_ID;
  const generatedAt = new Date();
  const anchor = new Date(Math.floor(generatedAt.getTime() / 1000) * 1000);
  const outputDir = DEFAULT_OUTPUT_DIR;
  const jsonPath = path.join(outputDir, `${runId}.json`);
  const markdownPath = path.join(outputDir, `${runId}.md`);
  const failures = [];
  const check = (condition, message) => {
    if (!condition) failures.push(message);
  };

  const commands = {
    composeUp: `API_HOST_PORT=18110 TIMESCALE_HOST_PORT=15490 docker compose -p ${DEFAULT_PROJECT} -f docker-compose.yml -f benchmarks/results/timescale-completion-evidence-20260810.compose.override.yml up -d --build`,
    readiness: `curl --fail http://${new URL(DEFAULT_API_URL).host}/health`,
    probe: `API_URL=${DEFAULT_API_URL} COMPOSE_PROJECT=${DEFAULT_PROJECT} node benchmarks/timescale-completion-evidence.mjs`,
    composeDown: `API_HOST_PORT=18110 TIMESCALE_HOST_PORT=15490 docker compose -p ${DEFAULT_PROJECT} -f docker-compose.yml -f benchmarks/results/timescale-completion-evidence-20260810.compose.override.yml down -v --remove-orphans`,
  };

  const health = await waitForHealth(DEFAULT_API_URL);
  check(health.ok, "GET /health did not become ready");
  if (!health.ok) {
    const failedArtifact = { schemaVersion: 1, status: "failed", runId, generatedAt: generatedAt.toISOString(), config: { apiUrl: DEFAULT_API_URL, project: DEFAULT_PROJECT }, commands, readiness: health, failures };
    await mkdir(outputDir, { recursive: true });
    await writeFile(jsonPath, `${JSON.stringify(failedArtifact, null, 2)}\n`);
    await writeFile(markdownPath, `# Timescale completion evidence\n\nStatus: **FAILED**\n\n- ${failures.join("\n- ")}\n`);
    process.exitCode = 1;
    return;
  }

  const containerResult = await databaseContainer(DEFAULT_PROJECT);
  const container = containerResult.container;
  check(Boolean(container), `could not resolve ${DB_SERVICE} container: ${containerResult.error ?? containerResult.stderr}`);

  const filterAt = isoAt(anchor, -15 * 60_000);
  const cursorAt = isoAt(anchor, -12 * 60_000);
  const newAt = isoAt(anchor, -5_000);
  const range = (timestamp, paddingMs = 1_000) => ({ since: isoAt(new Date(timestamp), -paddingMs), until: isoAt(new Date(timestamp), paddingMs) });
  const filterRange = range(filterAt);
  const cursorRange = range(cursorAt);
  const filterAttributes = { run_id: runId, phase: "combined" };
  const cursorAttributes = { run_id: runId, dataset: "tied-cursor" };

  const combinedMatching = Array.from({ length: 50 }, (_, index) => row(
    filterAt,
    "filter-evidence",
    "warn",
    `needle-evidence-${String(index).padStart(3, "0")}`,
    filterAttributes,
  ));
  const combinedDistractors = [
    row(filterAt, "wrong-service", "warn", "needle-evidence-distractor", filterAttributes),
    row(filterAt, "filter-evidence", "info", "needle-evidence-distractor", filterAttributes),
    row(filterAt, "filter-evidence", "warn", "needle-evidence-distractor", { run_id: runId, phase: "wrong" }),
    row(filterAt, "filter-evidence", "warn", "other-message", filterAttributes),
  ];
  const cursorRows = Array.from({ length: 73 }, (_, index) => row(
    cursorAt,
    "cursor-evidence",
    "info",
    `tied-cursor-${String(index).padStart(3, "0")}`,
    cursorAttributes,
  ));
  const noiseRows = Array.from({ length: 5_000 }, (_, index) => row(
    isoAt(anchor, -(4 * 60_000) - (index % 120) * 1_000),
    "explain-noise",
    index % 2 === 0 ? "info" : "debug",
    `explain-noise-${index}`,
    { run_id: runId, dataset: "noise" },
  ));
  const oldRetentionRows = [-30, -20, -10].flatMap((days, chunkIndex) => Array.from({ length: 100 }, (_, index) => row(
    isoAt(anchor, days * 24 * 60 * 60_000 + (index % 10) * 1_000),
    "retention-old",
    "warn",
    `retention-old-${chunkIndex}-${String(index).padStart(3, "0")}`,
    { run_id: runId, dataset: "retention-old" },
  )));

  const insertions = {
    combined: await insertBatches(DEFAULT_API_URL, [...combinedMatching, ...combinedDistractors], 250),
    cursor: await insertBatches(DEFAULT_API_URL, cursorRows, 250),
    noise: await insertBatches(DEFAULT_API_URL, noiseRows, 250),
    retentionOld: await insertBatches(DEFAULT_API_URL, oldRetentionRows, 250),
  };
  for (const [name, result] of Object.entries(insertions)) {
    check(result.accepted === result.attempted && result.rejected === 0 && result.failures.length === 0, `${name} dataset did not fully insert`);
  }

  const combinedQuery = {
    service: "filter-evidence",
    level: "warn",
    ...filterRange,
    "attr.run_id": runId,
    "attr.phase": "combined",
    q: "needle-evidence",
    limit: 100,
  };
  const combinedResponse = await requestQuery(DEFAULT_API_URL, "/logs", combinedQuery);
  const combinedLogs = Array.isArray(combinedResponse.body?.logs) ? combinedResponse.body.logs : [];
  const combinedOrdering = checkOrdering(combinedLogs);
  const combinedFilters = {
    request: combinedQuery,
    status: combinedResponse.status,
    ok: combinedResponse.ok,
    returned: combinedLogs.length,
    expected: combinedMatching.length,
    nextCursor: combinedResponse.body?.next_cursor ?? null,
    ordering: combinedOrdering,
    allRowsMatch: combinedLogs.every((log) => log.service === "filter-evidence" && log.level === "warn" && log.attributes?.run_id === runId && log.attributes?.phase === "combined" && log.message.includes("needle-evidence")),
  };
  check(combinedFilters.ok && combinedFilters.returned === combinedFilters.expected && combinedFilters.ordering.violations.length === 0 && combinedFilters.allRowsMatch, "combined-filter list/order evidence failed");

  const cursorQuery = { service: "cursor-evidence", ...cursorRange, "attr.run_id": runId, "attr.dataset": "tied-cursor" };
  const cursorAggregate = await aggregate(DEFAULT_API_URL, { ...cursorQuery, bucket: "1m", group_by: "service" });
  const cursorTraversal = await traverseCursor(DEFAULT_API_URL, cursorQuery, 7, cursorRows.length, cursorAggregate, cursorRows.map((cursorRow) => cursorRow.message));
  check(cursorTraversal.complete, "full tied-timestamp keyset traversal failed");

  const indexQuery = `SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.indexname), '[]'::json) FROM (SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'logs') t`;
  const chunkQuery = `SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.range_start), '[]'::json) FROM (SELECT chunk_schema, chunk_name, range_start::text, range_end::text FROM timescaledb_information.chunks WHERE hypertable_name = 'logs') t`;
  const hypertableQuery = `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (SELECT hypertable_schema, hypertable_name, num_dimensions, num_chunks, compression_enabled, primary_dimension, primary_dimension_type::text FROM timescaledb_information.hypertables WHERE hypertable_name = 'logs') t`;
  const indexEvidence = await psqlJson(container, indexQuery);
  const chunksBeforeRetention = await psqlJson(container, chunkQuery);
  const hypertableEvidence = await psqlJson(container, hypertableQuery);
  check(indexEvidence.ok && Array.isArray(indexEvidence.value) && indexEvidence.value.length > 0, "index evidence query failed");
  check(chunksBeforeRetention.ok && Array.isArray(chunksBeforeRetention.value) && chunksBeforeRetention.value.length >= 2, "chunk evidence did not show multiple chunks");
  check(hypertableEvidence.ok && Array.isArray(hypertableEvidence.value) && hypertableEvidence.value.length === 1, "hypertable evidence query failed");

  const explainWhere = [
    `"service" = ${sqlQuote("filter-evidence")}`,
    `"level" = ${sqlQuote("warn")}`,
    `"timestamp" >= ${sqlQuote(filterRange.since)}::timestamptz`,
    `"timestamp" < ${sqlQuote(filterRange.until)}::timestamptz`,
    `(attributes @> jsonb_build_object(${sqlQuote("run_id")}::text, to_jsonb(${sqlQuote(runId)}::text)) OR (attributes ->> ${sqlQuote("run_id")}::text) = ${sqlQuote(runId)}::text)`,
    `(attributes @> jsonb_build_object(${sqlQuote("phase")}::text, to_jsonb(${sqlQuote("combined")}::text)) OR (attributes ->> ${sqlQuote("phase")}::text) = ${sqlQuote("combined")}::text)`,
    `"message" ILIKE ('%' || ${sqlQuote("needle-evidence")} || '%') ESCAPE '\\'`,
  ].join(" AND ");
  const explainSql = `EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) SELECT "id"::text AS "id", "timestamp", "level", "service", "message", "attributes" FROM "logs" WHERE ${explainWhere} ORDER BY "timestamp" DESC, "id" DESC LIMIT 101`;
  const explainResult = await psql(container, explainSql);
  let explainPlan = null;
  if (explainResult.ok) {
    try {
      explainPlan = JSON.parse(explainResult.stdout.trim());
    } catch (error) {
      failures.push(`EXPLAIN JSON could not be parsed: ${error.message}`);
    }
  } else {
    failures.push(`EXPLAIN query failed: ${explainResult.error ?? explainResult.stderr}`);
  }
  const explainRoot = explainPlan?.[0]?.Plan ?? null;
  const explainEvidence = {
    sql: explainSql,
    format: "JSON",
    options: ["ANALYZE", "BUFFERS", "SETTINGS"],
    ok: explainResult.ok && explainRoot !== null,
    rootNode: explainRoot?.["Node Type"] ?? null,
    nodes: planNodes(explainRoot),
    plan: explainPlan,
    stderr: explainResult.stderr || null,
  };
  check(explainEvidence.ok, "filtered /logs EXPLAIN evidence failed");

  const retentionOldCountBefore = await psqlScalar(container, `SELECT count(*) FROM "logs" WHERE "attributes" @> ${sqlQuote(JSON.stringify({ run_id: runId, dataset: "retention-old" }))}::jsonb`);
  check(retentionOldCountBefore.ok && retentionOldCountBefore.value === oldRetentionRows.length, "retention old-row baseline count mismatch");

  const streamRows = 6_000;
  const streamBatchSize = 50;
  const streamIntervalMs = 100;
  const streamBatches = Array.from({ length: streamRows / streamBatchSize }, (_, batchIndex) => Array.from({ length: streamBatchSize }, (_, index) => row(
    newAt,
    "retention-new",
    "info",
    `retention-new-${String(batchIndex * streamBatchSize + index).padStart(5, "0")}`,
    { run_id: runId, dataset: "retention-new" },
  )));
  const streamState = { startedAtMs: null, endedAtMs: null };
  const retentionPoll = [];
  let polling = true;
  const pollPromise = (async () => {
    while (polling) {
      const sampleStarted = performance.now();
      const count = await psqlScalar(container, `SELECT count(*) FROM "logs" WHERE "attributes" @> ${sqlQuote(JSON.stringify({ run_id: runId, dataset: "retention-old" }))}::jsonb`);
      retentionPoll.push({ elapsedMs: Number((sampleStarted).toFixed(3)), count: count.value, ok: count.ok, error: count.error });
      await sleep(250);
    }
  })();

  const streamStartedAt = new Date().toISOString();
  const streamStarted = performance.now();
  streamState.startedAtMs = streamStarted;
  const streamPromises = [];
  const dispatchTimes = [];
  for (let batchIndex = 0; batchIndex < streamBatches.length; batchIndex += 1) {
    const dueAt = streamStarted + batchIndex * streamIntervalMs;
    const waitMs = dueAt - performance.now();
    if (waitMs > 0) await sleep(waitMs);
    dispatchTimes.push(performance.now());
    streamPromises.push(requestJson(DEFAULT_API_URL, "POST", "/logs", { logs: streamBatches[batchIndex] }));
  }
  const streamResponses = await Promise.all(streamPromises);
  const streamEnded = performance.now();
  const streamEndedAt = new Date().toISOString();
  streamState.endedAtMs = streamEnded;
  await sleep(1_500);
  polling = false;
  await pollPromise;

  const streamLatencies = streamResponses.map((response) => response.latencyMs);
  const streamAccepted = streamResponses.reduce((total, response) => total + (number(response.body?.accepted) ?? 0), 0);
  const streamRejected = streamResponses.reduce((total, response) => total + (Array.isArray(response.body?.rejected) ? response.body.rejected.length : 0), 0);
  const streamErrors = streamResponses.filter((response) => !response.ok).length;
  const dispatchWindowMs = dispatchTimes.length > 1 ? (dispatchTimes.at(-1) - dispatchTimes[0]) + streamIntervalMs : streamIntervalMs;
  const streamEvidence = {
    targetLogsPerSecond: 500,
    durationSec: (streamBatches.length * streamIntervalMs) / 1000,
    batchSize: streamBatchSize,
    sentRows: streamRows,
    acceptedRows: streamAccepted,
    rejectedRows: streamRejected,
    errorRequests: streamErrors,
    startedAt: streamStartedAt,
    endedAt: streamEndedAt,
    dispatchWindowMs: Number(dispatchWindowMs.toFixed(3)),
    completionWindowMs: Number((streamEnded - streamStarted).toFixed(3)),
    dispatchLogsPerSecond: Number((streamRows / dispatchWindowMs * 1000).toFixed(3)),
    completionLogsPerSecond: Number((streamAccepted / (streamEnded - streamStarted) * 1000).toFixed(3)),
    latency: latencySummary(streamLatencies),
    responseStatusCounts: streamResponses.reduce((counts, response) => {
      const key = String(response.status);
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {}),
    failures: streamResponses.filter((response) => !response.ok).map((response, index) => ({ batch: index, status: response.status, error: response.error })),
  };
  check(streamEvidence.sentRows === streamEvidence.acceptedRows && streamEvidence.rejectedRows === 0 && streamEvidence.errorRequests === 0, "retention-concurrent stream did not fully succeed");
  check(Math.abs(streamEvidence.dispatchLogsPerSecond - 500) <= 5, "retention-concurrent dispatch did not target 500 logs/s");

  const oldAfter = await psqlScalar(container, `SELECT count(*) FROM "logs" WHERE "attributes" @> ${sqlQuote(JSON.stringify({ run_id: runId, dataset: "retention-old" }))}::jsonb`);
  const newRange = range(newAt, 120_000);
  const newAggregate = await aggregate(DEFAULT_API_URL, { service: "retention-new", ...newRange, "attr.run_id": runId, "attr.dataset": "retention-new", bucket: "1m", group_by: "service" });
  const newList = await requestQuery(DEFAULT_API_URL, "/logs", { service: "retention-new", "attr.run_id": runId, "attr.dataset": "retention-new", limit: 1 });
  const removedDuringStream = retentionPoll.some((sample) => sample.ok && sample.count === 0 && streamState.startedAtMs !== null && sample.elapsedMs >= streamState.startedAtMs && sample.elapsedMs <= streamState.endedAtMs);
  const retentionEvidence = {
    configured: { retentionDays: 1, intervalMs: 1000, source: COMPOSE_OVERRIDE },
    oldRows: { before: retentionOldCountBefore.value, after: oldAfter.value, removed: oldAfter.value === 0, pollSamples: retentionPoll, removedDuringConcurrentStream: removedDuringStream },
    stream: streamEvidence,
    newRows: { expected: streamRows, aggregate: newAggregate, listStatus: newList.status, listOk: newList.ok, retained: newAggregate.total === streamRows && newList.ok },
  };
  check(retentionEvidence.oldRows.removed, "configured retention did not remove old rows");
  check(retentionEvidence.oldRows.removedDuringConcurrentStream, "old rows were not observed removed during concurrent ingestion");
  check(retentionEvidence.newRows.retained, "new rows were not retained after concurrent ingestion");

  const chunksAfterRetention = await psqlJson(container, chunkQuery);
  const policyQuery = `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (SELECT * FROM timescaledb_information.jobs WHERE proc_name = 'policy_retention') t`;
  const retentionPolicy = await psqlJson(container, policyQuery);
  const artifact = {
    schemaVersion: 1,
    status: failures.length === 0 ? "passed" : "failed",
    generatedAt: generatedAt.toISOString(),
    runId,
    engine: "timescale",
    config: {
      apiUrl: DEFAULT_API_URL,
      composeProject: DEFAULT_PROJECT,
      composeFile: COMPOSE_FILE,
      composeOverride: COMPOSE_OVERRIDE,
      databaseService: DB_SERVICE,
      databaseContainer: container,
      retentionDays: 1,
      retentionIntervalMs: 1000,
      anchor: anchor.toISOString(),
      datasets: { combinedRows: combinedMatching.length + combinedDistractors.length, tiedCursorRows: cursorRows.length, noiseRows: noiseRows.length, oldRetentionRows: oldRetentionRows.length, concurrentNewRows: streamRows },
    },
    commands,
    readiness: health,
    insertions,
    httpEvidence: { combinedFilters, cursorAggregate, cursorTraversal },
    sqlEvidence: {
      indexes: indexEvidence.value,
      hypertables: hypertableEvidence.value,
      chunksBeforeRetention: chunksBeforeRetention.value,
      chunksAfterRetention: chunksAfterRetention.value,
      filteredLogsExplain: explainEvidence,
      retentionPolicy: retentionPolicy.value,
    },
    retention: retentionEvidence,
    failures,
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`);
  const indexNames = (indexEvidence.value ?? []).map((index) => index.indexname).join(", ") || "none";
  const beforeChunks = (chunksBeforeRetention.value ?? []).length;
  const afterChunks = (chunksAfterRetention.value ?? []).length;
  const hypertable = (hypertableEvidence.value ?? [])[0] ?? null;
  const planSummary = explainEvidence.nodes.map((node) => node.indexName ? `${node.nodeType}[${node.indexName}]` : node.nodeType).join(" -> ") || "unavailable";
  const markdown = [
    "# Timescale completion evidence",
    "",
    `Status: **${artifact.status.toUpperCase()}**`,
    "",
    `Run ID: \`${runId}\`; API: \`${DEFAULT_API_URL}\`; Compose project: \`${DEFAULT_PROJECT}\`.`,
    "",
    "## Readiness and protocol",
    "",
    `- GET /health: ${health.ok ? "PASS" : "FAIL"} after ${health.elapsedMs} ms (${health.attempts.length} attempts).`,
    `- Combined-filter list: ${combinedFilters.ok && combinedFilters.returned === combinedFilters.expected ? "PASS" : "FAIL"}; ${combinedFilters.returned}/${combinedFilters.expected} rows; strict-order violations ${combinedFilters.ordering.violations.length}.`,
    `- Tied-timestamp keyset traversal: ${cursorTraversal.complete ? "PASS" : "FAIL"}; ${cursorTraversal.pages.length} pages, ${cursorTraversal.uniqueRows}/${cursorTraversal.expectedRows} unique rows, duplicates ${cursorTraversal.duplicateRows}, omissions ${cursorTraversal.omissionsAgainstAggregate ?? "unknown"}, missing messages ${cursorTraversal.missingMessages.length}, unexpected messages ${cursorTraversal.unexpectedMessages.length}, order violations ${cursorTraversal.ordering.violations.length}.`,
    "",
    "## Filtered SQL plan and storage evidence",
    "",
    `- EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON): ${explainEvidence.ok ? "PASS" : "FAIL"}; plan ${planSummary}.`,
    `- Indexes: ${indexNames}.`,
    `- Hypertable: ${hypertable?.hypertable_name ?? "unavailable"}; dimensions ${hypertable?.num_dimensions ?? "unknown"}; chunks reported ${hypertable?.num_chunks ?? "unknown"}; primary dimension ${hypertable?.primary_dimension ?? "unknown"}.`,
    `- Hypertable chunks before retention: ${beforeChunks}; after retention: ${afterChunks}.`,
    `- Full SQL and JSON plan are embedded in the JSON artifact under \`sqlEvidence.filteredLogsExplain\`.`,
    "",
    "## Retention during concurrent ingestion",
    "",
    `- Configured retention: ${retentionEvidence.configured.retentionDays} day; worker interval ${retentionEvidence.configured.intervalMs} ms.`,
    `- Old rows: ${retentionEvidence.oldRows.before} before, ${retentionEvidence.oldRows.after} after; removed during stream: ${retentionEvidence.oldRows.removedDuringConcurrentStream ? "YES" : "NO"}.`,
    `- Concurrent stream (${streamEvidence.startedAt} to ${streamEvidence.endedAt}): sent ${streamEvidence.sentRows}, accepted ${streamEvidence.acceptedRows}, rejected ${streamEvidence.rejectedRows}, error requests ${streamEvidence.errorRequests}; dispatch ${streamEvidence.dispatchLogsPerSecond} logs/s; completion ${streamEvidence.completionLogsPerSecond} logs/s; latency p50/p95/p99 ${streamEvidence.latency.p50Ms}/${streamEvidence.latency.p95Ms}/${streamEvidence.latency.p99Ms} ms.`,
    `- New rows retained: ${retentionEvidence.newRows.retained ? "YES" : "NO"}; aggregate total ${retentionEvidence.newRows.aggregate.total ?? "unknown"}/${streamRows}.`,
    "",
    "## Commands",
    "",
    "```sh",
    commands.composeUp,
    commands.readiness,
    commands.probe,
    commands.composeDown,
    "```",
    "",
    "## Failures",
    "",
    ...(failures.length ? failures.map((failure) => `- ${failure}`) : ["- None."]),
    "",
  ].join("\n");
  await writeFile(markdownPath, markdown);
  console.log(`wrote ${jsonPath}`);
  console.log(`wrote ${markdownPath}`);
  console.log(`status=${artifact.status} failures=${failures.length}`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});
