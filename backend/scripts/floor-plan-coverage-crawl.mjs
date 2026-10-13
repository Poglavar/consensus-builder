#!/usr/bin/env node
// Durable, bounded, multi-host one-off floor-plan coverage crawl.
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs as parseNodeArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import dotenv from 'dotenv';
import pg from 'pg';
import { normalizeSiteHost } from '../floor-plans/crawl-queue.js';
import { drainSourceRetention } from '../floor-plans/compact-sources.js';
import { runSiteCrawl } from './floor-plan-site-crawl.mjs';

const DEFAULTS = Object.freeze({ maxTotalPages: 10000, maxTotalMinutes: 360, maxSitePages: 150, maxSiteMinutes: 3 });
const RETENTION_LIMIT = 100;
const RETENTION_MAX_MS = 15000;
const HELP = [
  'Usage: node scripts/floor-plan-coverage-crawl.mjs --run --hosts FILE --run-dir DIR [options]',
  '',
  'Run a bounded, resumable one-off crawl across a JSON array of hostnames.',
  'No arguments or --help prints this help without reading files or connecting to PostgreSQL.',
  '',
  'Required for mutation:',
  '  --run                         Explicitly enable crawling',
  '  --hosts FILE                  JSON array of host strings',
  '  --run-dir DIR                 Durable collector summary and per-host run directories',
  '',
  'Budgets:',
  '  --max-total-pages N           Across all hosts and resumes (default 10000)',
  '  --max-total-minutes N         Across all hosts and resumes (default 360)',
  '  --max-site-pages N            Per host across resumes (default 150)',
  '  --max-site-minutes N          Per host active time across resumes (default 3)',
  '',
  'The collector uses asset-mode all, interleaved pages/assets, and known-target revisits.',
  'It loads backend/.env; FLOOR_PLAN_ENV_FILE may select another dotenv file.',
].join('\n');

function parsePositiveInteger(value, name, fallback) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`--${name} must be a strict positive integer.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`--${name} must be a strict positive integer.`);
  return number;
}

function parsePositiveNumber(value, name, fallback) {
  if (value === undefined) return fallback;
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) throw new Error(`--${name} must be a strict positive number.`);
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`--${name} must be a strict positive number.`);
  return number;
}

export function parseArgs(argv = []) {
  const { values } = parseNodeArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h' },
      run: { type: 'boolean' },
      hosts: { type: 'string' },
      'run-dir': { type: 'string' },
      'max-total-pages': { type: 'string' },
      'max-total-minutes': { type: 'string' },
      'max-site-pages': { type: 'string' },
      'max-site-minutes': { type: 'string' },
    },
    allowPositionals: false,
    strict: true,
  });
  if (!argv.length || values.help) return { help: true };
  if (!values.run) throw new Error('Crawling requires explicit --run.');
  if (!values.hosts || !values['run-dir']) throw new Error('--run requires --hosts FILE and --run-dir DIR.');
  return {
    help: false,
    hostsFile: resolve(values.hosts),
    runDir: resolve(values['run-dir']),
    maxTotalPages: parsePositiveInteger(values['max-total-pages'], 'max-total-pages', DEFAULTS.maxTotalPages),
    maxTotalMinutes: parsePositiveNumber(values['max-total-minutes'], 'max-total-minutes', DEFAULTS.maxTotalMinutes),
    maxSitePages: parsePositiveInteger(values['max-site-pages'], 'max-site-pages', DEFAULTS.maxSitePages),
    maxSiteMinutes: parsePositiveNumber(values['max-site-minutes'], 'max-site-minutes', DEFAULTS.maxSiteMinutes),
  };
}

export function normalizeHosts(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('The hosts file must contain a non-empty JSON array of host strings.');
  const hosts = value.map(host => normalizeSiteHost(host));
  if (hosts.some(host => !host)) throw new Error('The hosts file must contain hostname strings.');
  if (new Set(hosts).size !== hosts.length) throw new Error('The hosts file contains duplicate normalized hostnames.');
  return hosts;
}

export function calculateHostLimits({
  hostRequests = 0,
  hostElapsedMs = 0,
  totalRequests = 0,
  totalElapsedMs = 0,
  hostRetentionElapsedMs = 0,
  maxTotalPages,
  maxTotalMinutes,
  maxSitePages,
  maxSiteMinutes,
}) {
  const remainingTotalPages = Math.max(0, maxTotalPages - totalRequests);
  const remainingTotalMs = Math.max(0, maxTotalMinutes * 60000 - totalElapsedMs);
  return {
    maxPages: Math.min(maxSitePages, hostRequests + remainingTotalPages),
    maxMinutes: Math.min(Math.max(0, (maxSiteMinutes * 60000 - hostRetentionElapsedMs) / 60000),
      Math.max(0, (hostElapsedMs + remainingTotalMs - hostRetentionElapsedMs) / 60000)),
    remainingTotalPages,
    remainingTotalMs,
  };
}

async function boundedRetention({ deadline, limit, log }) {
  const timeoutMs = Math.max(0, Math.floor(deadline - Date.now()));
  if (!timeoutMs) return { status: 'partial', partial: true, remaining: true, deferred: 0, stopReason: 'deadline' };
  const connectionString = process.env.DATABASE_URL;
  const connection = {
    ...(connectionString ? { connectionString } : {}),
    ...(process.env.PGHOST ? { host: process.env.PGHOST } : {}),
    connectionTimeoutMillis: timeoutMs,
    statement_timeout: timeoutMs,
    query_timeout: timeoutMs,
  };
  const client = new pg.Client(connection);
  let connected = false;
  try {
    await client.connect();
    connected = true;
    return await drainSourceRetention(client, { limit, deadline, log });
  } finally {
    if (connected) await client.end();
  }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  const handle = await open(temporary, 'w', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function readHostUsage(runDir) {
  const [progress, result, traceText] = await Promise.all([
    readJson(join(runDir, 'progress.json')),
    readJson(join(runDir, 'result.json')),
    readFile(join(runDir, 'trace.ndjson'), 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error)),
  ]);
  const lines = traceText ? traceText.split('\n') : [];
  const hasIncompleteTail = traceText.length > 0 && !traceText.endsWith('\n');
  if (traceText.endsWith('\n')) lines.pop();
  const traceRows = [];
  for (const [index, line] of lines.entries()) {
    try {
      const row = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)
          || !Number.isFinite(Number(row.durationMs)) || Number(row.durationMs) < 0) {
        throw new Error('invalid trace record');
      }
      traceRows.push(row);
    } catch (error) {
      if (hasIncompleteTail && index === lines.length - 1) continue;
      throw new Error(`Malformed crawler trace at ${join(runDir, 'trace.ndjson')} line ${index + 1}: ${error.message}`);
    }
  }
  const traceElapsedMs = traceRows.reduce((sum, row) => sum + Number(row.durationMs || 0), 0);
  const chunkRequests = (progress?.chunks || []).reduce((sum, chunk) => sum + Number(chunk.requests || 0), 0);
  const requestsAttempted = Math.max(traceRows.length, chunkRequests + Number(progress?.inFlight?.requestsAttempted || 0),
    Number(result?.counters?.requestsAttempted || 0));
  const activeElapsedMs = Math.max(Number(progress?.activeElapsedMs || 0), traceElapsedMs,
    Number(result?.counters?.fetchElapsedMs || 0));
  return { progress, result, requestsAttempted, activeElapsedMs };
}

function statusFromArtifacts({ progress, result, fallback }) {
  if (result?.stopReason === 'archive-capacity') return 'capacity';
  if (result?.status === 'interrupted' || result?.stopReason === 'interrupted') return 'interrupted';
  if (result?.status === 'complete') return 'completed';
  if (result?.status === 'failed') return 'failed';
  if (result?.status === 'partial') return 'partial';
  if (progress?.stage === 'done') {
    return Number(progress?.counters?.failed || 0) || Number(progress?.counters?.blocked || 0) ? 'partial' : 'completed';
  }
  return fallback;
}

const resumableStatus = status => status === 'pending' || status === 'running' || status === 'capacity' || status === 'interrupted';
const refreshTotals = summary => {
  summary.totals = {
    requestsAttempted: summary.hostResults.reduce((sum, item) => sum + Number(item.requestsAttempted || 0), 0),
    activeElapsedMs: summary.hostResults.reduce((sum, item) => sum + Number(item.activeElapsedMs || 0), 0),
  };
};

function formatMinutes(milliseconds) {
  return (Number(milliseconds || 0) / 60000).toFixed(1);
}

export async function runCoverageCrawl(options, dependencies = {}) {
  const hosts = dependencies.hosts || normalizeHosts(JSON.parse(await readFile(options.hostsFile, 'utf8')));
  const crawlSite = dependencies.runSiteCrawlFn || runSiteCrawl;
  const output = dependencies.log || (line => console.log(line));
  const summaryPath = join(options.runDir, 'summary.json');
  await mkdir(options.runDir, { recursive: true });

  let summary = await readJson(summaryPath);
  const limits = {
    maxTotalPages: options.maxTotalPages,
    maxTotalMinutes: options.maxTotalMinutes,
    maxSitePages: options.maxSitePages,
    maxSiteMinutes: options.maxSiteMinutes,
  };
  if (summary && (JSON.stringify(summary.hosts) !== JSON.stringify(hosts)
      || JSON.stringify(summary.limits) !== JSON.stringify(limits))) {
    throw new Error('The run directory belongs to a different host list or budget.');
  }
  summary ||= {
    version: 1,
    createdAt: new Date().toISOString(),
    hosts,
    limits,
    hostResults: hosts.map(host => ({ host, status: 'pending', requestsAttempted: 0, activeElapsedMs: 0,
      runnerElapsedMs: 0, retentionElapsedMs: 0, attempts: 0 })),
  };
  const byHost = new Map(summary.hostResults.map(row => [row.host, row]));
  for (const host of hosts) if (!byHost.has(host)) byHost.set(host, { host, status: 'pending', requestsAttempted: 0,
    activeElapsedMs: 0, runnerElapsedMs: 0, retentionElapsedMs: 0, attempts: 0 });
  for (const row of byHost.values()) {
    row.runnerElapsedMs = Number(row.runnerElapsedMs ?? row.activeElapsedMs ?? 0);
    row.retentionElapsedMs = Number(row.retentionElapsedMs || 0);
    row.activeElapsedMs = row.runnerElapsedMs + row.retentionElapsedMs;
  }
  summary.hostResults = hosts.map(host => byHost.get(host));

  let stopRequested = false;
  const stop = () => { stopRequested = true; };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const externalSignal = dependencies.signal;
  if (externalSignal?.aborted) stop();
  else externalSignal?.addEventListener('abort', stop, { once: true });

  try {
    summary.status = 'running';
    refreshTotals(summary);
    summary.updatedAt = new Date().toISOString();
    await atomicJson(summaryPath, summary);
    let stopReason = null;

    // Reconcile every host before using a global budget or concluding there is no resumable work.
    for (const row of summary.hostResults) {
      const hostRunDir = join(options.runDir, 'hosts', row.host);
      const usage = await readHostUsage(hostRunDir);
      row.requestsAttempted = Math.max(Number(row.requestsAttempted || 0), usage.requestsAttempted);
      row.runnerElapsedMs = Math.max(Number(row.runnerElapsedMs || 0), usage.activeElapsedMs);
      row.activeElapsedMs = row.runnerElapsedMs + Number(row.retentionElapsedMs || 0);
      const artifactStatus = statusFromArtifacts({ progress: usage.progress, result: usage.result, fallback: row.status });
      if (row.retention?.status === 'running' || row.retention?.status === 'interrupted') {
        row.retentionElapsedMs = Math.max(Number(row.retentionElapsedMs || 0), Number(row.retention.elapsedMs || 0));
        row.activeElapsedMs = row.runnerElapsedMs + row.retentionElapsedMs;
        row.retention.status = 'interrupted';
        row.status = ['capacity', 'interrupted'].includes(artifactStatus) ? artifactStatus : 'interrupted';
        row.stopReason ||= 'retention-interrupted';
      } else if (['partial', 'failed'].includes(row.retention?.status)) {
        row.status = ['capacity', 'interrupted'].includes(artifactStatus) ? artifactStatus : 'partial';
      } else row.status = artifactStatus;
    }
    refreshTotals(summary);
    summary.updatedAt = new Date().toISOString();
    await atomicJson(summaryPath, summary);

    for (const [hostIndex, row] of summary.hostResults.entries()) {
      if (stopRequested || externalSignal?.aborted) { stopReason = 'interrupted'; break; }
      const hostRunDir = join(options.runDir, 'hosts', row.host);
      if (!resumableStatus(row.status)) {
        refreshTotals(summary);
        output(`[${new Date().toISOString()}] [${hostIndex + 1}/${summary.hostResults.length}] skip ${row.host} status=${row.status} requests=${row.requestsAttempted} total=${summary.totals.requestsAttempted}/${limits.maxTotalPages} active=${formatMinutes(summary.totals.activeElapsedMs)}/${limits.maxTotalMinutes}m`);
        continue;
      }
      if (stopRequested || externalSignal?.aborted) { stopReason = 'interrupted'; break; }

      const totalRequests = summary.hostResults.reduce((sum, item) => sum + Number(item.requestsAttempted || 0), 0);
      const totalElapsedMs = summary.hostResults.reduce((sum, item) => sum + Number(item.activeElapsedMs || 0), 0);
      const allowance = calculateHostLimits({
        hostRequests: row.requestsAttempted,
        hostElapsedMs: row.activeElapsedMs,
        totalRequests,
        totalElapsedMs,
        hostRetentionElapsedMs: row.retentionElapsedMs,
        ...limits,
      });
      if (allowance.remainingTotalPages <= 0 || allowance.remainingTotalMs <= 0) {
        stopReason = allowance.remainingTotalPages <= 0 ? 'max-total-pages' : 'max-total-minutes';
        refreshTotals(summary);
        output(`[${new Date().toISOString()}] [${hostIndex + 1}/${summary.hostResults.length}] stop ${row.host} reason=${stopReason} total=${summary.totals.requestsAttempted}/${limits.maxTotalPages} pages active=${formatMinutes(summary.totals.activeElapsedMs)}/${limits.maxTotalMinutes}m`);
        break;
      }

      row.status = 'running';
      row.attempts = Number(row.attempts || 0) + 1;
      row.startedAt ||= new Date().toISOString();
      row.updatedAt = new Date().toISOString();
      row.runDir = hostRunDir;
      refreshTotals(summary);
      summary.updatedAt = row.updatedAt;
      await atomicJson(summaryPath, summary);
      output(`[${new Date().toISOString()}] [${hostIndex + 1}/${summary.hostResults.length}] ${row.attempts > 1 ? 'resume' : 'start'} ${row.host} host=${row.requestsAttempted}/${limits.maxSitePages} pages total=${summary.totals.requestsAttempted}/${limits.maxTotalPages} pages active=${formatMinutes(summary.totals.activeElapsedMs)}/${limits.maxTotalMinutes}m`);
      if (stopRequested || externalSignal?.aborted) {
        row.status = 'pending';
        row.updatedAt = new Date().toISOString();
        summary.updatedAt = row.updatedAt;
        await atomicJson(summaryPath, summary);
        stopReason = 'interrupted';
        break;
      }

      let result = null;
      let runError = null;
      let runErrorCode = null;
      try {
        result = await crawlSite({
          site: row.host,
          runDir: hostRunDir,
          assetMode: 'all',
          interleaveAssets: true,
          revisitKnown: true,
          maxPages: allowance.maxPages,
          maxMinutes: allowance.maxMinutes,
        }, { ...(dependencies.siteDependencies || {}), log: dependencies.siteDependencies?.log || (() => {}) });
      } catch (error) {
        runError = String(error?.message || error);
        runErrorCode = error?.code || null;
      }

      const latest = await readHostUsage(hostRunDir);
      row.requestsAttempted = Math.max(row.requestsAttempted, latest.requestsAttempted,
        Number(result?.counters?.requestsAttempted || 0));
      row.runnerElapsedMs = Math.max(Number(row.runnerElapsedMs || 0), latest.activeElapsedMs,
        Number(result?.counters?.fetchElapsedMs || 0));
      row.activeElapsedMs = row.runnerElapsedMs + Number(row.retentionElapsedMs || 0);
      const resultLike = result || latest.result;
      if (runErrorCode === 'ARCHIVE_CAPACITY' || resultLike?.stopReason === 'archive-capacity') {
        row.status = 'capacity';
        row.error = runError || null;
      } else if (runError) {
        row.status = 'failed';
        row.error = runError;
      } else {
        row.status = statusFromArtifacts({ progress: latest.progress, result: resultLike, fallback: 'partial' });
      }
      row.stopReason = resultLike?.stopReason || (runErrorCode === 'ARCHIVE_CAPACITY' ? 'archive-capacity' : runError ? 'error' : null);
      row.updatedAt = new Date().toISOString();
      summary.updatedAt = row.updatedAt;
      refreshTotals(summary);
      await atomicJson(summaryPath, summary);

      // The site runner has returned and released its crawl lock. Drain a small retention batch
      // before moving to another host, while accounting this work against both time budgets.
      const retentionBaseMs = Number(row.retentionElapsedMs || 0);
      const remainingGlobalMs = Math.max(0, limits.maxTotalMinutes * 60000 - summary.totals.activeElapsedMs);
      const retentionWindowMs = Math.min(RETENTION_MAX_MS, remainingGlobalMs);
      const retentionDeadline = Date.now() + retentionWindowMs;
      const retentionStartedAt = new Date().toISOString();
      const retentionClock = dependencies.monotonic || (() => performance.now());
      // Reserve the bounded window before starting. If the process is killed mid-cleanup,
      // reconciliation keeps the full reservation in the global and per-host budgets.
      row.retentionElapsedMs = retentionBaseMs + retentionWindowMs;
      row.activeElapsedMs = Number(row.runnerElapsedMs || 0) + row.retentionElapsedMs;
      row.retention = { status: 'running', limit: RETENTION_LIMIT, startedAt: retentionStartedAt,
        deadlineAt: new Date(retentionDeadline).toISOString(), elapsedMs: retentionWindowMs };
      row.updatedAt = retentionStartedAt;
      summary.updatedAt = retentionStartedAt;
      refreshTotals(summary);
      await atomicJson(summaryPath, summary);
      const retentionStarted = retentionClock();
      const activeRetentionMs = () => Math.max(0, retentionClock() - retentionStarted);

      let checkpointWrites = Promise.resolve();
      const persistRetentionCheckpoint = checkpoint => {
        row.retention.lastCheckpoint = checkpoint && typeof checkpoint === 'object' ? checkpoint : null;
        row.retention.updatedAt = new Date().toISOString();
        summary.updatedAt = row.retention.updatedAt;
        refreshTotals(summary);
        const snapshot = JSON.parse(JSON.stringify(summary));
        checkpointWrites = checkpointWrites.then(() => atomicJson(summaryPath, snapshot));
      };
      let retentionResult = null;
      let retentionError = null;
      try {
        retentionResult = await (dependencies.retentionFn || boundedRetention)({
          host: row.host,
          limit: RETENTION_LIMIT,
          deadline: retentionDeadline,
          log: persistRetentionCheckpoint,
        });
      } catch (error) {
        retentionError = String(error?.message || error);
      }
      const retentionElapsedMs = Math.max(0, Math.round(activeRetentionMs()));
      row.retentionElapsedMs = retentionBaseMs + retentionElapsedMs;
      row.activeElapsedMs = Number(row.runnerElapsedMs || 0) + row.retentionElapsedMs;
      const retentionIncomplete = Boolean(retentionError || retentionResult?.status !== 'complete'
        || retentionResult?.partial || retentionResult?.remaining || Number(retentionResult?.deferred || 0) > 0
        || Number(retentionResult?.sourceReadErrors || 0) > 0);
      row.retention = {
        status: retentionIncomplete ? 'partial' : 'complete',
        limit: RETENTION_LIMIT,
        startedAt: retentionStartedAt,
        finishedAt: new Date().toISOString(),
        deadlineAt: new Date(retentionDeadline).toISOString(),
        elapsedMs: retentionElapsedMs,
        ...(retentionResult ? { result: retentionResult } : {}),
        ...(retentionError ? { error: retentionError } : {}),
      };
      if (retentionIncomplete && !['capacity', 'interrupted'].includes(row.status)) {
        row.crawlStatus = row.status;
        row.crawlStopReason = row.stopReason;
        row.status = 'partial';
        row.stopReason = 'retention-incomplete';
      }
      row.updatedAt = new Date().toISOString();
      summary.updatedAt = row.updatedAt;
      refreshTotals(summary);
      await checkpointWrites;
      await atomicJson(summaryPath, summary);
      output(`[${new Date().toISOString()}] [${hostIndex + 1}/${summary.hostResults.length}] done ${row.host} status=${row.status} host=${row.requestsAttempted}/${limits.maxSitePages} pages total=${summary.totals.requestsAttempted}/${limits.maxTotalPages} pages active=${formatMinutes(summary.totals.activeElapsedMs)}/${limits.maxTotalMinutes}m retention=${row.retention.status}/${formatMinutes(retentionElapsedMs)}m reason=${row.stopReason || 'none'}`);

      if (row.status === 'capacity') { stopReason = 'archive-capacity'; break; }
      if (row.status === 'interrupted' || stopRequested || externalSignal?.aborted) { stopReason = 'interrupted'; break; }
    }

    refreshTotals(summary);
    const unfinished = summary.hostResults.some(row => row.status === 'pending' || row.status === 'running');
    const anyNotComplete = summary.hostResults.some(row => row.status !== 'completed');
    summary.status = stopReason || unfinished || anyNotComplete ? 'partial' : 'complete';
    summary.stopReason = stopReason || (unfinished ? 'budget-exhausted' : anyNotComplete ? 'host-incomplete' : 'queue-exhausted');
    summary.updatedAt = new Date().toISOString();
    await atomicJson(summaryPath, summary);
    return summary;
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    externalSignal?.removeEventListener('abort', stop);
  }
}

export async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  const output = dependencies.output || (value => console.log(value));
  if (options.help) { output(HELP); return 0; }
  const envFile = process.env.FLOOR_PLAN_ENV_FILE
    ? resolve(process.env.FLOOR_PLAN_ENV_FILE)
    : fileURLToPath(new URL('../.env', import.meta.url));
  dotenv.config({ path: envFile, quiet: true });
  const result = await runCoverageCrawl(options, dependencies);
  output(JSON.stringify(result, null, 2));
  return result.status === 'complete' ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().then(code => { process.exitCode = code; }).catch(error => {
    console.error(JSON.stringify({ status: 'failed', error: String(error?.message || error) }));
    process.exitCode = 1;
  });
}
