#!/usr/bin/env node
// Durable, resumable, site-scoped floor-plan discovery and asset crawl.
import { appendFile, mkdir, readFile, rename, truncate, writeFile } from 'node:fs/promises';
import { renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs as parseNodeArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import dotenv from 'dotenv';
import pg from 'pg';
import { crawl } from '../floor-plans/crawler.js';
import { countPendingTargets, createTargetSelector, normalizeSiteHost, revisitKnownTargets } from '../floor-plans/crawl-queue.js';
import { fetchPublic } from '../floor-plans/fetch-public.js';
import { zagrebStreetIndex } from '../floor-plans/site-candidates.js';
import { acquireCrawlLock } from '../floor-plans/crawl-locks.js';

const CHUNK_REQUESTS = 500;
const HELP = [
  'Usage: node scripts/floor-plan-site-crawl.mjs --site HOST --run-dir DIR [options]',
  '',
  'Fetch one site\'s due pages and listing-owned assets in two resumable stages.',
  '',
  'Required:',
  '  --site HOST                 Exact site hostname, e.g. opereta.hr',
  '  --run-dir DIR               Durable run directory for snapshots and trace.ndjson',
  '',
  'Options:',
  '  --asset-mode all|plans      Crawl all listing-owned images (default) or only labelled plans/documents',
  '  --interleave-assets         Alternate due pages and assets in one resumable mixed stage',
  '  --revisit-known             Recheck known pages once, using validators and stored results',
  '  --max-pages N               Overall request cap across chunks/resumes (default 50000)',
  '  --max-minutes N             Overall active-time cap across chunks/resumes (default 360)',
  '  -h, --help                  Print help without loading env or connecting to PostgreSQL',
  '',
  'The runner loads backend/.env explicitly. FLOOR_PLAN_ENV_FILE can select another dotenv file.',
  'Chunks contain at most 500 requests. Each response/error is appended to trace.ndjson.',
  '',
].join('\n');

const isoNow = () => new Date().toISOString();
const safeError = value => String(value?.message || value || 'Unknown fetch error')
  .replace(/https?:\/\/[^\s"'<>]+/g, value => safeUrl(value));

function safeUrl(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return String(value).split(/[?#]/, 1)[0];
  }
}

export function parseArgs(argv = []) {
  const { values } = parseNodeArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h' },
      site: { type: 'string' },
      'run-dir': { type: 'string' },
      'asset-mode': { type: 'string' },
      'interleave-assets': { type: 'boolean' },
      'revisit-known': { type: 'boolean' },
      'max-pages': { type: 'string' },
      'max-minutes': { type: 'string' },
    },
    allowPositionals: false,
    strict: true,
  });
  if (!argv.length || values.help) return { help: true };
  if (!values.site || !values['run-dir']) throw new Error('--site and --run-dir are required.');
  const site = normalizeSiteHost(values.site);
  const assetMode = values['asset-mode'] || 'all';
  if (!['plans', 'all'].includes(assetMode)) throw new Error('--asset-mode must be plans or all.');
  const maxPages = values['max-pages'] === undefined ? 50000 : Number(values['max-pages']);
  const maxMinutes = values['max-minutes'] === undefined ? 360 : Number(values['max-minutes']);
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new Error('--max-pages must be a positive integer.');
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) throw new Error('--max-minutes must be positive.');
  return { help: false, site, runDir: resolve(values['run-dir']), assetMode,
    interleaveAssets: Boolean(values['interleave-assets']), revisitKnown: Boolean(values['revisit-known']), maxPages, maxMinutes };
}

async function writeJsonAtomic(path, value) {
  const temporary = path + '.tmp-' + process.pid;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}

function writeJsonAtomicSync(path, value) {
  const temporary = path + '.tmp-' + process.pid;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readTrace(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const completeEnd = raw.lastIndexOf('\n') + 1;
  if (completeEnd !== raw.length) await truncate(path, completeEnd);
  return raw.slice(0, completeEnd).split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function summarizeTrace(rows) {
  let denials = 0;
  for (const row of rows) {
    if (row.status === 403 || row.status === 429) denials += 1;
    else denials = 0;
  }
  return {
    requests: rows.length,
    decodedBytes: rows.reduce((sum, row) => sum + Number(row.decodedBytes || 0), 0),
    fetchElapsedMs: rows.reduce((sum, row) => sum + Number(row.durationMs || 0), 0),
    denialStreak: denials,
    failedFetches: rows.filter(row => row.error || (row.status !== null && row.status >= 400)).length,
  };
}

function addCounters(total, counters = {}) {
  for (const key of ['failed', 'blocked', 'unchanged', 'notModified', 'identicalBodies', 'changed', 'discovered', 'filteredGeneratedSearchTargets']) {
    total[key] = (total[key] || 0) + Number(counters[key] || 0);
  }
}

async function pendingForStage(db, options, countFn) {
  return countFn(db, {
    site: options.site,
    discoveryOnly: options.stage === 'discovery',
    assetOnly: options.stage === 'assets',
    planAssetsOnly: options.stage !== 'discovery' && options.assetMode === 'plans',
  });
}

function makeSnapshot(options, progress, trace, pending, extra = {}) {
  const spentMs = Math.max(Number(progress.activeElapsedMs || 0), trace.fetchElapsedMs);
  const usedRequests = trace.requests;
  const averageMs = usedRequests ? spentMs / usedRequests : 0;
  return {
    at: isoNow(),
    site: options.site,
    assetMode: options.assetMode,
    interleaveAssets: Boolean(progress.interleaveAssets),
    stage: progress.stage,
    requestsAttempted: usedRequests,
    decodedResponseBodyBytes: trace.decodedBytes,
    elapsedMs: Math.round(spentMs),
    pending: pending?.pending ?? null,
    deferredGeneratedSearchTargets: pending?.deferredGeneratedSearchTargets ?? null,
    etaSeconds: pending && averageMs ? Math.ceil(pending.pending * averageMs / 1000) : null,
    etaApproximate: Boolean(pending && averageMs),
    ...extra,
  };
}

export async function runSiteCrawl(options, dependencies = {}) {
  const clientFactory = dependencies.clientFactory || (connection => new pg.Client(connection));
  const crawlFn = dependencies.crawlFn || crawl;
  const countFn = dependencies.countPendingFn || countPendingTargets;
  const selectorFactory = dependencies.selectorFactory || createTargetSelector;
  const fetchFn = dependencies.fetcher || fetchPublic;
  const log = dependencies.log || (value => console.log(value));
  const monotonic = dependencies.monotonic || (() => performance.now());
  const runDir = resolve(options.runDir);
  await mkdir(runDir, { recursive: true });
  const paths = {
    before: resolve(runDir, 'before.json'),
    after: resolve(runDir, 'after.json'),
    progress: resolve(runDir, 'progress.json'),
    result: resolve(runDir, 'result.json'),
    trace: resolve(runDir, 'trace.ndjson'),
  };
  let progress = await readJson(paths.progress);
  if (progress && (progress.site !== options.site || progress.assetMode !== options.assetMode)) {
    throw new Error('The run directory belongs to a different site or asset mode.');
  }
  if (progress?.stage === 'done') return (await readJson(paths.result)) || progress;

  const traceRows = await readTrace(paths.trace);
  const trace = summarizeTrace(traceRows);
  const elapsedBase = Math.max(Number(progress?.activeElapsedMs || 0), trace.fetchElapsedMs);
  const processStart = monotonic();
  const activeElapsedMs = () => elapsedBase + Math.max(0, monotonic() - processStart);
  progress ||= {
    version: 1,
    site: options.site,
    assetMode: options.assetMode,
    createdAt: isoNow(),
    stage: options.interleaveAssets ? 'mixed' : 'discovery',
    interleaveAssets: Boolean(options.interleaveAssets),
    completedStages: [],
    activeElapsedMs: 0,
    counters: { failed: 0, blocked: 0, unchanged: 0, changed: 0, discovered: 0, filteredGeneratedSearchTargets: 0 },
    cleanupIssues: false,
    chunks: [],
  };
  progress.counters ||= { failed: 0, blocked: 0, unchanged: 0, changed: 0, discovered: 0, filteredGeneratedSearchTargets: 0 };
  progress.completedStages ||= [];
  progress.chunks ||= [];
  progress.cleanupIssues ||= false;
  progress.foldedRunIds ||= [];

  const connection = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, ...(process.env.PGHOST ? { host: process.env.PGHOST } : {}) }
    : undefined;
  const db = clientFactory(connection);
  await db.connect();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  let releaseLock;
  try {
    releaseLock = await acquireCrawlLock(db, options.site);
    // Page qualification reads street-name mentions from this index; load it once per run.
    await zagrebStreetIndex(db);

    if (options.revisitKnown && !progress.revisit) {
      progress.revisit = { at: isoNow(), ...(await (dependencies.revisitKnownFn || revisitKnownTargets)(db, { site: options.site })) };
      await writeJsonAtomic(paths.progress, progress);
    }

    if (progress.inFlight?.runId && !progress.foldedRunIds.includes(progress.inFlight.runId)) {
      const saved = await db.query('SELECT counters FROM floor_plan.run WHERE id=$1', [progress.inFlight.runId]);
      addCounters(progress.counters, saved.rows[0]?.counters || progress.inFlight.counters || {});
      progress.foldedRunIds.push(progress.inFlight.runId);
      progress.inFlight = null;
      progress.recoveredAt = isoNow();
    }
    if (options.interleaveAssets && progress.stage !== 'mixed') {
      const fromStage = progress.stage;
      progress.stage = 'mixed';
      progress.interleaveAssets = true;
      progress.modeChanges ||= [];
      progress.modeChanges.push({ at: isoNow(), fromStage, toStage: 'mixed', reason: '--interleave-assets' });
    }
    if (!(await readJson(paths.before))) {
      const initial = {
        discovery: await pendingForStage(db, { ...options, stage: 'discovery' }, countFn),
        assets: await pendingForStage(db, { ...options, stage: 'assets' }, countFn),
      };
      await writeJsonAtomic(paths.before, { at: isoNow(), site: options.site, assetMode: options.assetMode, initial });
    }
    await writeJsonAtomic(paths.progress, { ...progress, updatedAt: isoNow(), activeElapsedMs: Math.round(elapsedBase) });
    let stopReason = null;
    while (progress.stage !== 'done') {
      if (controller.signal.aborted) { stopReason = 'interrupted'; break; }
      if (trace.denialStreak >= 3) { stopReason = 'sustained-http-denials'; break; }
      const stage = progress.stage;
      const pendingBefore = await pendingForStage(db, { ...options, stage }, countFn);
      if (pendingBefore.pending === 0) {
        if (!progress.completedStages.includes(stage)) progress.completedStages.push(stage);
        progress.stage = stage === 'discovery' ? 'assets' : 'done';
        await writeJsonAtomic(paths.progress, { ...progress, updatedAt: isoNow(), activeElapsedMs: Math.round(activeElapsedMs()), lastPending: pendingBefore });
        continue;
      }

      const remainingRequests = options.maxPages - trace.requests;
      const remainingMs = options.maxMinutes * 60000 - activeElapsedMs();
      if (remainingRequests <= 0) { stopReason = 'max-pages'; break; }
      if (remainingMs <= 0) { stopReason = 'max-minutes'; break; }

      let currentTarget = null;
      let denialStreak = trace.denialStreak;
      let denialStop = false;
      const select = selectorFactory({
        site: options.site,
        discoveryOnly: stage === 'discovery',
        assetOnly: stage === 'assets',
        planAssetsOnly: stage !== 'discovery' && options.assetMode === 'plans',
        knownFirst: Boolean(progress.revisit),
      });
      const selectTarget = async client => {
        if (denialStop) return null;
        currentTarget = await select(client);
        return currentTarget;
      };
      const fetcher = async (url, fetchOptions) => {
        const started = monotonic();
        let response = null;
        let error = null;
        try {
          response = await fetchFn(url, fetchOptions);
          if (response.status === 403 || response.status === 429) denialStreak += 1;
          else denialStreak = 0;
          if (denialStreak >= 3) denialStop = true;
          return response;
        } catch (caught) {
          error = safeError(caught);
          denialStreak = 0;
          throw caught;
        } finally {
          const durationMs = Math.max(0, monotonic() - started);
          const row = {
            at: isoNow(),
            stage,
            url: safeUrl(url),
            host: (() => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; } })(),
            kind: currentTarget?.kind || null,
            status: response?.status ?? caughtStatus(error),
            error: error || response?.blockedReason || null,
            durationMs: Math.round(durationMs),
            decodedBytes: response?.body?.byteLength ?? 0,
          };
          await appendFile(paths.trace, JSON.stringify(row) + '\n', { flag: 'a', mode: 0o600 });
          traceRows.push(row);
          Object.assign(trace, summarizeTrace(traceRows));
        }
      };

      const chunkStartedAt = isoNow();
      const chunkLimit = Math.min(CHUNK_REQUESTS, remainingRequests);
      progress.inFlight = { stage, startedAt: chunkStartedAt, runId: null, counters: {} };
      writeJsonAtomicSync(paths.progress, { ...progress, updatedAt: isoNow(), activeElapsedMs: Math.round(activeElapsedMs()) });
      const result = await crawlFn(db, {
        signal: controller.signal,
        maxPages: chunkLimit,
        maxMinutes: remainingMs / 60000,
        site: options.site,
        discoveryOnly: stage === 'discovery',
        assetOnly: stage === 'assets',
        planAssetsOnly: stage !== 'discovery' && options.assetMode === 'plans',
        selectTarget,
        fetcher,
        log: line => {
          let event = {};
          try { event = JSON.parse(line); } catch {}
          if (event.run) {
            progress.inFlight = {
              stage,
              startedAt: chunkStartedAt,
              runId: event.run,
              counters: {
                failed: event.failed,
                blocked: event.blocked,
                unchanged: event.unchanged,
                notModified: event.notModified,
                identicalBodies: event.identicalBodies,
                changed: event.changed,
                discovered: event.discovered,
                filteredGeneratedSearchTargets: event.filteredGeneratedSearchTargets,
              },
              requestsAttempted: event.requestsAttempted,
              updatedAt: isoNow(),
            };
            writeJsonAtomicSync(paths.progress, { ...progress, updatedAt: isoNow(), activeElapsedMs: Math.round(activeElapsedMs()) });
          }
          const approximatePending = Math.max(0, pendingBefore.pending - Number(event.requestsAttempted || 0) + Number(event.discovered || 0));
          log(JSON.stringify(makeSnapshot(options, { ...progress, activeElapsedMs: Math.round(activeElapsedMs()) }, trace,
            { ...pendingBefore, pending: approximatePending }, {
            current: event.current ? safeUrl(event.current) : null,
            lastStatus: traceRows.at(-1)?.status ?? null,
            newlyDiscovered: Number(event.discovered || 0),
            blocked: Number(event.blocked || 0),
            failed: Number(event.failed || 0),
          })));
        },
      });
      if (result.cleanup?.errors?.length || Number(result.cleanup?.deferred || 0) > 0) progress.cleanupIssues = true;

      if (!result.id || !progress.foldedRunIds.includes(result.id)) {
        addCounters(progress.counters, result.counters);
        if (result.id) progress.foldedRunIds.push(result.id);
      }
      progress.inFlight = null;
      const pendingAfter = await pendingForStage(db, { ...options, stage }, countFn);
      progress.activeElapsedMs = Math.round(activeElapsedMs());
      progress.chunks.push({
        stage,
        startedAt: chunkStartedAt,
        finishedAt: isoNow(),
        requests: Number(result.counters?.requestsAttempted || 0),
        discovered: Number(result.counters?.discovered || 0),
        failed: Number(result.counters?.failed || 0),
        unchanged: Number(result.counters?.unchanged || 0),
        notModified: Number(result.counters?.notModified || 0),
        identicalBodies: Number(result.counters?.identicalBodies || 0),
        blocked: Number(result.counters?.blocked || 0),
        status: result.status || null,
        stopReason: result.stopReason || null,
        cleanup: result.cleanup || null,
        pendingBefore: pendingBefore.pending,
        pendingAfter: pendingAfter.pending,
        runId: result.id || null,
      });
      progress.lastPending = pendingAfter;
      progress.updatedAt = isoNow();
      await writeJsonAtomic(paths.progress, progress);
      log(JSON.stringify(makeSnapshot(options, progress, trace, pendingAfter, {
        chunkRequests: Number(result.counters?.requestsAttempted || 0),
        discovered: Number(result.counters?.discovered || 0),
        status: result.status || null,
      })));

      if (controller.signal.aborted) { stopReason = 'interrupted'; break; }
      if (result.stopReason === 'archive-capacity') { stopReason = 'archive-capacity'; break; }
      if (denialStop) { stopReason = 'sustained-http-denials'; break; }
      if (!Number(result.counters?.requestsAttempted || 0) && pendingAfter.pending > 0) {
        stopReason = 'no-progress';
        break;
      }
    }

    const after = {
      at: isoNow(),
      site: options.site,
      assetMode: options.assetMode,
      interleaveAssets: Boolean(progress.interleaveAssets),
      discovery: await pendingForStage(db, { ...options, stage: 'discovery' }, countFn),
      assets: await pendingForStage(db, { ...options, stage: 'assets' }, countFn),
    };
    const complete = progress.stage === 'done';
    const hadFailures = progress.counters.failed > 0 || progress.counters.blocked > 0 || trace.failedFetches > 0 || progress.cleanupIssues;
    const status = controller.signal.aborted ? 'interrupted' : complete && !hadFailures ? 'complete' : 'partial';
    const result = {
      at: isoNow(),
      site: options.site,
      assetMode: options.assetMode,
      interleaveAssets: Boolean(progress.interleaveAssets),
      status,
      stopReason: stopReason || (complete ? (hadFailures ? 'completed-with-errors' : 'queue-exhausted') : 'stage-incomplete'),
      completedStages: [...progress.completedStages],
      stage: progress.stage,
      limits: { maxPages: options.maxPages, maxMinutes: options.maxMinutes, chunkRequests: CHUNK_REQUESTS },
      counters: {
        ...progress.counters,
        requestsAttempted: trace.requests,
        decodedResponseBodyBytes: trace.decodedBytes,
        fetchElapsedMs: trace.fetchElapsedMs,
        fetchErrors: trace.failedFetches,
        cleanupIssues: Boolean(progress.cleanupIssues),
      },
      before: await readJson(paths.before),
      after,
      traceFile: paths.trace,
      chunks: progress.chunks,
    };
    await writeJsonAtomic(paths.after, after);
    progress.activeElapsedMs = Math.round(activeElapsedMs());
    progress.updatedAt = isoNow();
    progress.stopReason = stopReason || (complete ? 'queue-exhausted' : 'stage-incomplete');
    if (complete) progress.stage = 'done';
    await writeJsonAtomic(paths.progress, progress);
    await writeJsonAtomic(paths.result, result);
    return result;
  } catch (error) {
    const failure = safeError(error);
    progress.updatedAt = isoNow();
    progress.lastError = failure;
    progress.activeElapsedMs = Math.round(activeElapsedMs());
    await writeJsonAtomic(paths.progress, progress);
    await writeJsonAtomic(paths.result, { at: isoNow(), site: options.site, assetMode: options.assetMode, status: 'failed', error: failure, stage: progress.stage });
    throw error;
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    try { if (releaseLock) await releaseLock(); }
    finally { await db.end(); }
  }
}

export async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  const output = dependencies.output || (value => console.log(value));
  if (options.help) {
    output(HELP);
    return 0;
  }
  const envFile = process.env.FLOOR_PLAN_ENV_FILE
    ? resolve(process.env.FLOOR_PLAN_ENV_FILE)
    : fileURLToPath(new URL('../.env', import.meta.url));
  dotenv.config({ path: envFile, quiet: true });
  const result = await runSiteCrawl(options, dependencies);
  output(JSON.stringify(result, null, 2));
  return result.status === 'complete' ? 0 : 2;
}

function caughtStatus(error) {
  const match = String(error || '').match(/\bHTTP\s+(403|429)\b/);
  return match ? Number(match[1]) : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().then(code => { process.exitCode = code; }).catch(error => {
    console.error(JSON.stringify({ at: isoNow(), status: 'failed', error: safeError(error) }));
    process.exitCode = 1;
  });
}
