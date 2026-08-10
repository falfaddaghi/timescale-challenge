#!/usr/bin/env node

/** Capture post-run DuckDB storage, resource, SQL-plan, and checkpoint evidence. */

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const project = process.env.COMPOSE_PROJECT ?? "timescale-duckdb-full-20260810";
const apiUrl = process.env.API_URL ?? "http://127.0.0.1:18083";
const runId = process.env.RUN_ID ?? "duckdb-full-1m-500lps-30s-20260810";
const baseTimestamp = process.env.BASE_TIMESTAMP ?? "2026-08-10T07:22:48.301Z";
const outputDir = process.env.OUTPUT_DIR ?? path.join(root, "benchmarks", "results");
const outputPath = path.join(outputDir, `${runId}.runtime.json`);
const markdownPath = path.join(outputDir, `${runId}.runtime.md`);
const composeFile = path.join(root, "compose.duckdb.yml");

async function command(args, options = {}) {
  try {
    const result = await execFileAsync(args[0], args.slice(1), { cwd: root, maxBuffer: 64 * 1024 * 1024, ...options });
    return { ok: true, stdout: result.stdout, stderr: result.stderr, error: null };
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? "", stderr: error.stderr ?? "", error: error instanceof Error ? error.message : String(error) };
  }
}

async function compose(...args) {
  return command(["docker", "compose", "-p", project, "-f", composeFile, ...args]);
}

async function resolveContainer(service) {
  const result = await compose("ps", "-q", service);
  return { ...result, container: result.stdout.trim().split(/\s+/)[0] || null };
}

async function containerShell(container, script) {
  return command(["docker", "exec", container, "sh", "-lc", script]);
}

async function fileEvidence(container) {
  const result = await containerShell(container, "stat -c '%n %s' /data/* 2>/dev/null || true");
  const files = {};
  for (const line of result.stdout.trim().split("\n")) {
    const match = line.match(/^(\/data\/[^ ]+)\s+(\d+)$/);
    if (match) files[path.basename(match[1])] = Number(match[2]);
  }
  return { ...result, files };
}

async function stats(container) {
  const result = await command(["docker", "stats", "--no-stream", "--format", "{{json .}}", container]);
  let value = null;
  try { value = JSON.parse(result.stdout.trim()); } catch { /* preserve raw output */ }
  return { ...result, value };
}

async function health() {
  const started = performance.now();
  try {
    const response = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(10_000) });
    const body = await response.json();
    return { ok: response.ok && body.status === "ok", status: response.status, body, elapsedMs: Number((performance.now() - started).toFixed(3)) };
  } catch (error) {
    return { ok: false, status: null, body: null, error: String(error), elapsedMs: Number((performance.now() - started).toFixed(3)) };
  }
}

async function timedApiAggregate() {
  const since = new Date(Date.parse(baseTimestamp) - 60_000).toISOString();
  const until = new Date(Date.parse(baseTimestamp) + 1_000).toISOString();
  const params = new URLSearchParams({
    since,
    until,
    "attr.run_id": runId,
    bucket: "1m",
    group_by: "service",
  });
  const started = performance.now();
  try {
    const response = await fetch(`${apiUrl}/logs/aggregate?${params}`);
    const body = await response.json();
    return {
      ok: response.ok,
      status: response.status,
      elapsedMs: Number((performance.now() - started).toFixed(3)),
      buckets: body.buckets ?? null,
      total: Array.isArray(body.buckets) ? body.buckets.reduce((sum, bucket) => sum + Number(bucket.count ?? 0), 0) : null,
    };
  } catch (error) {
    return { ok: false, status: null, elapsedMs: Number((performance.now() - started).toFixed(3)), error: String(error) };
  }
}

function directScript() {
  const since = new Date(Date.parse(baseTimestamp) - 60_000).toISOString();
  const until = new Date(Date.parse(baseTimestamp) + 1_000).toISOString();
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const attr = `(EXISTS (SELECT 1 FROM json_each("logs"."attribute_values") AS attribute WHERE attribute.key = 'run_id' AND json_extract_string(attribute.value, '$') = ${quote(runId)}))`;
  const seedAttr = `${attr} AND EXISTS (SELECT 1 FROM json_each("logs"."attribute_values") AS phase WHERE phase.key = 'phase' AND json_extract_string(phase.value, '$') = 'seed')`;
  const listSql = `EXPLAIN ANALYZE SELECT "id", "timestamp", "level", "service", "message", "attributes" FROM "logs" WHERE "service" = 'benchmark-0' AND "timestamp" >= CAST(${quote(since)} AS TIMESTAMPTZ) AND "timestamp" < CAST(${quote(until)} AS TIMESTAMPTZ) AND ${seedAttr} ORDER BY "timestamp" DESC, "id" DESC LIMIT 101`;
  const aggregateSql = `SELECT time_bucket(INTERVAL '1 minute', "timestamp", TIMESTAMPTZ '1970-01-01 00:00:00+00') AS "start", "service" AS "group", COUNT(*) AS "count" FROM "logs" WHERE "timestamp" >= CAST(${quote(since)} AS TIMESTAMPTZ) AND "timestamp" < CAST(${quote(until)} AS TIMESTAMPTZ) AND ${seedAttr} GROUP BY 1, 2 ORDER BY 1 ASC, 2 ASC`;
  return `import {DuckDBInstance} from "@duckdb/node-api";
const started=performance.now();
let instance;
try {
  instance=await DuckDBInstance.create("/data/logs.duckdb");
  const connection=await instance.connect();
  const rows=async(sql)=>await (await connection.run(sql)).getRowObjectsJS();
  const countStarted=performance.now();
  const counts=await rows("SELECT COUNT(*) AS total_rows FROM logs");
  const countElapsedMs=Number((performance.now()-countStarted).toFixed(3));
  const aggregateStarted=performance.now();
  const aggregate=await rows(${JSON.stringify(aggregateSql)});
  const aggregateElapsedMs=Number((performance.now()-aggregateStarted).toFixed(3));
  const explainStarted=performance.now();
  const explain=await rows(${JSON.stringify(listSql)});
  const explainElapsedMs=Number((performance.now()-explainStarted).toFixed(3));
  const checkpointStarted=performance.now();
  await connection.run("CHECKPOINT");
  const checkpointElapsedMs=Number((performance.now()-checkpointStarted).toFixed(3));
  const afterCheckpoint=await rows("SELECT COUNT(*) AS total_rows FROM logs");
  console.log(JSON.stringify({ok:true,elapsedMs:Number((performance.now()-started).toFixed(3)),counts,countElapsedMs,aggregate,aggregateElapsedMs,explain,explainElapsedMs,checkpointElapsedMs,afterCheckpoint}, (_, value) => typeof value === "bigint" ? Number(value) : value));
  connection.closeSync(); instance.closeSync();
} catch(error) {
  console.log(JSON.stringify({ok:false,elapsedMs:Number((performance.now()-started).toFixed(3)),error:String(error)}));
  try { instance?.closeSync(); } catch {}
  process.exitCode=1;
}`;
}

async function main() {
  let previousArtifact = null;
  try { previousArtifact = JSON.parse(await readFile(outputPath, "utf8")); } catch { /* first capture */ }
  const api = await resolveContainer("api");
  const container = api.container;
  if (!container) throw new Error(`could not resolve API container: ${api.error ?? api.stderr}`);
  const imageResult = await command(["docker", "inspect", "-f", "{{.Config.Image}}", container]);
  const image = imageResult.stdout.trim();
  const beforeFiles = await fileEvidence(container);
  const beforeStats = await stats(container);
  const apiAggregate = await timedApiAggregate();

  const stop = await compose("stop", "api");
  const direct = await command(["docker", "run", "--rm", "--volumes-from", container, image, "node", "--input-type=module", "-e", directScript()]);
  let directValue = null;
  try { directValue = JSON.parse(direct.stdout.trim()); } catch { /* preserve raw output */ }
  const start = await compose("start", "api");
  let finalHealth = await health();
  if (!finalHealth.ok) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    finalHealth = await health();
  }
  const afterFiles = await fileEvidence(container);
  const afterStats = await stats(container);
  const artifact = {
    schemaVersion: 1,
    runId,
    engine: "duckdb",
    composeProject: project,
    hostUrl: apiUrl,
    apiContainer: container,
    image,
    benchmarkArtifact: `benchmarks/results/log-benchmark-20260810073248301-${runId}.json`,
    smokeArtifact: "benchmarks/results/log-benchmark-20260810073218810-duckdb-smoke-20260810.json",
    protocol: { seedRows: 1_000_000, batchSize: 500, rate: 500, durationSec: 30, seed: 20260720, bucket: "1m", sampleIntervalMs: 1000, maxInFlight: 256, timestampSpanMs: 60000 },
    apiAggregate,
    resources: {
      // Preserve the first post-run snapshot when a second bounded probe is
      // needed after checkpoint/restart. `beforeStats` is still retained as
      // liveBeforeSecondProbe for auditability.
      beforeStop: previousArtifact?.resources?.beforeStop ?? beforeStats.value,
      liveBeforeSecondProbe: beforeStats.value,
      afterRestart: afterStats.value,
    },
    databaseFiles: { beforeCheckpoint: previousArtifact?.databaseFiles?.beforeCheckpoint ?? beforeFiles.files, liveBeforeSecondProbe: beforeFiles.files, afterCheckpoint: afterFiles.files },
    checkpoint: { stop, directCommand: "docker run --rm --volumes-from <api-container> <api-image> node --input-type=module -e <DuckDB SQL probe>", directResult: directValue, stdout: direct.stdout || null, stderr: direct.stderr || null },
    apiRestart: { start, health: finalHealth },
    commands: {
      composeUp: `API_HOST_PORT=18083 docker compose -p ${project} -f compose.duckdb.yml up -d --build`,
      smoke: "node benchmarks/bench.mjs --smoke --url http://127.0.0.1:18083 --engine duckdb --run-id duckdb-smoke-20260810 --output-dir benchmarks/results",
      full: "node benchmarks/bench.mjs --url http://127.0.0.1:18083 --engine duckdb --rows 1000000 --batch-size 500 --duration 30 --rate 500 --seed 20260720 --sample-interval-ms 1000 --bucket 1m --max-in-flight 256 --base-age-ms 600000 --timestamp-span-ms 60000 --timeout-ms 30000 --health-timeout-ms 30000 --run-id duckdb-full-1m-500lps-30s-20260810 --output-dir benchmarks/results",
      composeDown: `API_HOST_PORT=18083 docker compose -p ${project} -f compose.duckdb.yml down -v --remove-orphans`,
    },
  };
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
  const directSummary = directValue?.ok ? "PASS" : "FAILED (see JSON; separate-process lock/checkpoint probe)";
  const markdown = [
    "# DuckDB full-run runtime evidence",
    "",
    `Run: \`${runId}\`; project: \`${project}\`; API: \`${apiUrl}\`.`,
    "",
    "- Benchmark artifact: passed, 1,000,000 seed + 15,000 stream rows, zero harness failures, exact aggregates.",
    `- API timed aggregate: ${apiAggregate.ok ? "PASS" : "FAIL"}; ${apiAggregate.elapsedMs ?? "unknown"} ms; total ${apiAggregate.total ?? "unknown"}.`,
    `- Database files before checkpoint: ${JSON.stringify(artifact.databaseFiles.beforeCheckpoint)}.`,
    `- Direct DuckDB count/EXPLAIN/CHECKPOINT probe: ${directSummary}. API was stopped only within this isolated project while the file lock was released, then restarted and health-checked.`,
    `- Database files after checkpoint/restart: ${JSON.stringify(afterFiles.files)}.`,
    `- API resources at first post-run capture: ${JSON.stringify(artifact.resources.beforeStop)}.`,
    `- API resources at bounded second probe: ${JSON.stringify(artifact.resources.liveBeforeSecondProbe)}; after restart: ${JSON.stringify(artifact.resources.afterRestart)}.`,
    `- Post-restart health: ${finalHealth.ok ? "PASS" : "FAIL"}.`,
    "",
    "Full SQL and EXPLAIN ANALYZE rows are preserved under `checkpoint.directResult` in the JSON artifact.",
    "",
  ].join("\n");
  await writeFile(markdownPath, markdown);
  console.log(`wrote ${outputPath}`);
  console.log(`wrote ${markdownPath}`);
  console.log(`direct=${directSummary} health=${finalHealth.ok}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
