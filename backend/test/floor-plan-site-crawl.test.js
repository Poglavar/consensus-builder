import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs, runCli, runSiteCrawl } from '../scripts/floor-plan-site-crawl.mjs';

const tempDirs = [];
async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'floor-plan-site-crawl-test-'));
  tempDirs.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

it('revisits known pages once per durable run rather than resetting them on resume',async()=>{
  const runDir=await tempDir(),db=fakeDb(),revisitKnownFn=vi.fn(async()=>({targets:3}));
  const options={site:'agency.test',runDir,assetMode:'all',revisitKnown:true,interleaveAssets:false,maxPages:1,maxMinutes:5};
  const dependencies={clientFactory:()=>db,revisitKnownFn,countPendingFn:async()=>({pending:0}),log:()=>{}};
  expect((await runSiteCrawl(options,dependencies)).status).toBe('complete');
  expect((await runSiteCrawl(options,dependencies)).status).toBe('complete');
  expect(revisitKnownFn).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await readFile(join(runDir,'progress.json'),'utf8')).revisit.targets).toBe(3);
});

function fakeDb({ recoveryCounters = null } = {}) {
  return {
    connect: vi.fn(async () => {}),
    end: vi.fn(async () => {}),
    query: vi.fn(async sql => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (sql.includes('SELECT counters FROM floor_plan.run')) return { rows: recoveryCounters ? [{ counters: recoveryCounters }] : [] };
      return { rows: [] };
    }),
  };
}

function harness(queues, { statuses = [], recoveryCounters = null } = {}) {
  const db = fakeDb({ recoveryCounters });
  const countCalls = [];
  const crawlCalls = [];
  const countPendingFn = vi.fn(async (_db, options) => {
    const stage = options.discoveryOnly ? 'discovery' : options.assetOnly ? 'assets' : 'mixed';
    countCalls.push({ ...options, stage });
    return { pending: stage === 'mixed' ? queues.discovery.length + queues.assets.length : queues[stage].length,
      deferredGeneratedSearchTargets: 0, deferredUnownedAssets: 0, deferredUnmatchedAssets: 0 };
  });
  const selectorFactory = options => {
    const stage = options.discoveryOnly ? 'discovery' : options.assetOnly ? 'assets' : 'mixed';
    let next = 'assets';
    return async () => {
      if (stage !== 'mixed') return queues[stage][0] || null;
      const chosen = queues[next].length ? next : next === 'assets' ? 'discovery' : 'assets';
      next = chosen === 'assets' ? 'discovery' : 'assets';
      return queues[chosen][0] || null;
    };
  };
  const crawlFn = vi.fn(async (_db, options) => {
    crawlCalls.push(options);
    const stage = options.discoveryOnly ? 'discovery' : options.assetOnly ? 'assets' : 'mixed';
    const counters = { requestsAttempted: 0, failed: 0, blocked: 0, changed: 0, unchanged: 0, discovered: 0, filteredGeneratedSearchTargets: 0 };
    while (counters.requestsAttempted < options.maxPages) {
      const target = await options.selectTarget(_db);
      if (!target) break;
      const response = await options.fetcher(target.url, {});
      queues[target.kind === 'asset' ? 'assets' : 'discovery'].shift();
      counters.requestsAttempted += 1;
      if (response.status === 403) counters.blocked += 1;
      else if (response.status >= 400) counters.failed += 1;
      options.log(JSON.stringify({ run: 'fake-' + stage, current: target.url, requestsAttempted: counters.requestsAttempted, failed: counters.failed, blocked: counters.blocked, discovered: 0 }));
    }
    return { id: 'fake-' + stage, status: counters.failed || counters.blocked ? 'partial' : 'complete', counters };
  });
  const fetcher = vi.fn(async url => {
    const status = statuses.length ? statuses.shift() : 200;
    return { status, blockedReason: status === 403 ? 'http-403' : null, headers: {}, body: Buffer.from('x'), finalUrl: url };
  });
  return { db, clientFactory: () => db, countCalls, crawlCalls, countPendingFn, selectorFactory, crawlFn, fetcher };
}

const options = runDir => ({ site: 'opereta.hr', runDir, assetMode: 'plans', maxPages: 20, maxMinutes: 30 });

describe('Opereta durable site crawler runner', () => {
  it('prints help without loading a client and validates the explicit scope and caps', async () => {
    const output = vi.fn(), clientFactory = vi.fn();
    expect(await runCli([], { output, clientFactory })).toBe(0);
    expect(output.mock.calls[0][0]).toMatch(/--site HOST --run-dir DIR/);
    expect(clientFactory).not.toHaveBeenCalled();
    expect(parseArgs(['--site', 'WWW.Opereta.hr', '--run-dir', './run'])).toMatchObject({ site: 'opereta.hr', assetMode: 'all', maxPages: 50000, maxMinutes: 360 });
    expect(parseArgs(['--site', 'opereta.hr', '--run-dir', './run', '--interleave-assets'])).toMatchObject({ interleaveAssets: true });
    expect(() => parseArgs(['--site', 'opereta.hr'])).toThrow(/--site and --run-dir/);
    expect(() => parseArgs(['--site', 'opereta.hr.evil.test/path', '--run-dir', './run'])).toThrow(/hostname/);
    expect(() => parseArgs(['--site', 'opereta.hr', '--run-dir', './run', '--asset-mode', 'photos'])).toThrow(/plans or all/);
  });

  it('runs discovery then owned plan assets and writes durable snapshots and a redacted trace', async () => {
    const runDir = await tempDir();
    const queues = {
      discovery: [{ url: 'https://www.opereta.hr/listing/1?token=private', kind: 'page' }, { url: 'https://opereta.hr/listing/2', kind: 'page' }],
      assets: [{ url: 'https://cdn.example/plan.pdf', kind: 'asset' }],
    };
    const h = harness(queues);
    const logs = [];
    const result = await runSiteCrawl(options(runDir), { ...h, log: line => logs.push(line) });

    expect(result.status).toBe('complete');
    expect(result.completedStages).toEqual(['discovery', 'assets']);
    expect(result.counters).toMatchObject({ requestsAttempted: 3, decodedResponseBodyBytes: 3, failed: 0 });
    expect(h.crawlCalls.map(call => [call.discoveryOnly, call.assetOnly, call.planAssetsOnly])).toEqual([[true, false, false], [false, true, true]]);
    expect(h.countCalls.some(call => call.stage === 'assets' && call.planAssetsOnly)).toBe(true);
    expect((await readFile(join(runDir, 'before.json'), 'utf8'))).toContain('"site": "opereta.hr"');
    expect(JSON.parse(await readFile(join(runDir, 'progress.json'), 'utf8')).stage).toBe('done');
    expect(JSON.parse(await readFile(join(runDir, 'after.json'), 'utf8')).assets.pending).toBe(0);
    const trace = (await readFile(join(runDir, 'trace.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(trace).toHaveLength(3);
    expect(trace[0]).toMatchObject({ stage: 'discovery', host: 'opereta.hr', kind: 'page', status: 200, decodedBytes: 1 });
    expect(trace[0].url).toBe('https://www.opereta.hr/listing/1');
    expect(trace[0].url).not.toContain('private');
    expect(logs.some(line => JSON.parse(line).etaSeconds !== undefined)).toBe(true);
  });

  it('starts an explicitly mixed run with both page and asset selectors and completes only when both queues drain', async () => {
    const runDir = await tempDir();
    const queues = {
      discovery: [{ url: 'https://opereta.hr/listing/1', kind: 'page' }],
      assets: [{ url: 'https://cdn.example/plan.jpg', kind: 'asset' }],
    };
    const h = harness(queues);
    const result = await runSiteCrawl({ ...options(runDir), interleaveAssets: true }, h);
    expect(result).toMatchObject({ status: 'complete', interleaveAssets: true, completedStages: ['mixed'] });
    expect(h.crawlCalls).toHaveLength(1);
    expect(h.crawlCalls[0]).toMatchObject({ discoveryOnly: false, assetOnly: false, planAssetsOnly: true });
    expect(h.countCalls.some(call => call.stage === 'mixed' && !call.discoveryOnly && !call.assetOnly && call.planAssetsOnly)).toBe(true);
    expect(result.counters.requestsAttempted).toBe(2);
    expect(JSON.parse(await readFile(join(runDir, 'progress.json'), 'utf8'))).toMatchObject({ stage: 'done', interleaveAssets: true });
    const trace = (await readFile(join(runDir, 'trace.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
    expect(trace.map(row => row.kind)).toEqual(['asset', 'page']);
    expect(trace.every(row => row.stage === 'mixed')).toBe(true);
  });

  it('recovers an in-flight discovery checkpoint before migrating to mixed without resetting counters', async () => {
    const runDir = await tempDir();
    const queues = {
      discovery: [{ url: 'https://opereta.hr/listing/1', kind: 'page' }, { url: 'https://opereta.hr/listing/2', kind: 'page' }],
      assets: [{ url: 'https://cdn.example/plan.jpg', kind: 'asset' }],
    };
    const first = harness(queues);
    const partial = await runSiteCrawl({ ...options(runDir), maxPages: 1 }, first);
    expect(partial).toMatchObject({ status: 'partial', stage: 'discovery' });
    const prior = JSON.parse(await readFile(join(runDir, 'progress.json'), 'utf8'));
    prior.inFlight = { stage: 'discovery', runId: 'interrupted-run', counters: { failed: 1 } };
    await writeFile(join(runDir, 'progress.json'), JSON.stringify(prior));
    const second = harness(queues, { recoveryCounters: { failed: 1 } });
    const resumed = await runSiteCrawl({ ...options(runDir), maxPages: 3, interleaveAssets: true }, second);
    expect(resumed).toMatchObject({ status: 'partial', stopReason: 'completed-with-errors', interleaveAssets: true,
      counters: { requestsAttempted: 3, failed: 1 } });
    expect(resumed.completedStages).toEqual(['mixed']);
    expect(resumed.chunks.map(chunk => chunk.requests)).toEqual([1, 2]);
    expect(second.crawlCalls).toHaveLength(1);
    expect(second.crawlCalls[0]).toMatchObject({ discoveryOnly: false, assetOnly: false, planAssetsOnly: true });
    const saved = JSON.parse(await readFile(join(runDir, 'progress.json'), 'utf8'));
    expect(saved).toMatchObject({ stage: 'done', interleaveAssets: true, inFlight: null,
      foldedRunIds: expect.arrayContaining(['interrupted-run']),
      modeChanges: [{ fromStage: 'discovery', toStage: 'mixed', reason: '--interleave-assets' }] });
    const trace = (await readFile(join(runDir, 'trace.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
    expect(trace.map(row => row.stage)).toEqual(['discovery', 'mixed', 'mixed']);
  });

  it('resumes at the saved asset stage and rejects a run directory with a different mode', async () => {
    const runDir = await tempDir();
    await writeFile(join(runDir, 'progress.json'), JSON.stringify({
      version: 1, site: 'opereta.hr', assetMode: 'plans', stage: 'assets', completedStages: ['discovery'],
      activeElapsedMs: 0, counters: {}, chunks: [], foldedRunIds: [],
    }));
    await writeFile(join(runDir, 'before.json'), JSON.stringify({ site: 'opereta.hr', assetMode: 'plans' }));
    const queues = { discovery: [], assets: [{ url: 'https://cdn.example/next.pdf', kind: 'asset' }] };
    const h = harness(queues);
    const result = await runSiteCrawl(options(runDir), h);
    expect(result.status).toBe('complete');
    expect(h.crawlCalls).toHaveLength(1);
    expect(h.crawlCalls[0].assetOnly).toBe(true);
    await expect(runSiteCrawl({ ...options(runDir), assetMode: 'all' }, { clientFactory: vi.fn() })).rejects.toThrow(/different site or asset mode/);
  });

  it('applies the request cap across resumed chunks and stages', async () => {
    const runDir = await tempDir();
    const queues = {
      discovery: [{ url: 'https://opereta.hr/listing/1', kind: 'page' }, { url: 'https://opereta.hr/listing/2', kind: 'page' }],
      assets: [{ url: 'https://cdn.example/plan.pdf', kind: 'asset' }],
    };
    const first = harness(queues);
    const partial = await runSiteCrawl({ ...options(runDir), maxPages: 1 }, first);
    expect(partial.status).toBe('partial');
    expect(partial.stopReason).toBe('max-pages');
    expect(partial.counters.requestsAttempted).toBe(1);

    const second = harness(queues);
    const resumed = await runSiteCrawl({ ...options(runDir), maxPages: 2 }, second);
    expect(resumed.status).toBe('partial');
    expect(resumed.stopReason).toBe('max-pages');
    expect(resumed.counters.requestsAttempted).toBe(2);
    expect(second.crawlCalls).toHaveLength(1);
    expect(second.crawlCalls[0].discoveryOnly).toBe(true);
    expect(resumed.stage).toBe('assets');
  });

  it('stops after three consecutive 403/429 responses and reports a partial run', async () => {
    const runDir = await tempDir();
    const queues = {
      discovery: [1, 2, 3, 4].map(id => ({ url: 'https://opereta.hr/listing/' + id, kind: 'page' })),
      assets: [{ url: 'https://cdn.example/plan.pdf', kind: 'asset' }],
    };
    const h = harness(queues, { statuses: [403, 429, 403, 200, 200] });
    const result = await runSiteCrawl(options(runDir), h);
    expect(result.status).toBe('partial');
    expect(result.stopReason).toBe('sustained-http-denials');
    expect(result.counters.requestsAttempted).toBe(3);
    expect(h.crawlCalls).toHaveLength(1);
    expect(h.crawlCalls[0].discoveryOnly).toBe(true);
  });

  it('folds an interrupted run checkpoint once and preserves failed status on resume', async () => {
    const runDir = await tempDir();
    await writeFile(join(runDir, 'progress.json'), JSON.stringify({
      version: 1, site: 'opereta.hr', assetMode: 'plans', stage: 'assets', completedStages: ['discovery'],
      activeElapsedMs: 0, counters: { failed: 0, blocked: 0 }, chunks: [], foldedRunIds: [],
      inFlight: { stage: 'assets', startedAt: new Date().toISOString(), runId: 'interrupted-run', counters: { failed: 1 } },
    }));
    await writeFile(join(runDir, 'before.json'), JSON.stringify({ site: 'opereta.hr', assetMode: 'plans' }));
    const db = fakeDb({ recoveryCounters: { failed: 1, blocked: 0, changed: 0, unchanged: 0, discovered: 0 } });
    const countPendingFn = vi.fn(async () => ({ pending: 0, deferredGeneratedSearchTargets: 0 }));
    const result = await runSiteCrawl(options(runDir), { clientFactory: () => db, countPendingFn });
    expect(result.status).toBe('partial');
    expect(result.stopReason).toBe('completed-with-errors');
    expect(result.counters.failed).toBe(1);
    const saved = JSON.parse(await readFile(join(runDir, 'progress.json'), 'utf8'));
    expect(saved.foldedRunIds).toContain('interrupted-run');
    expect(saved.inFlight).toBeNull();
  });
});
