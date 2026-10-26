import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createBudget, createDiagnosticStore, createApiObservation, createMcpObserver, validateDiagnosticReport, MAX_BATCH, MAX_ROWS } from '../operations/planning-diagnostics.js';
import { readPlanningUsage } from '../operations/planning-usage.js';
const require = createRequire(import.meta.url);
const D = require('../../frontend/js/app-diagnostics.js');
const client = options => D.create({ uuid: randomUUID, ...options });
const envelope = d => ({ version: 1, entries: d.snapshot().entries.map(D.wire) });
const privateText = 'Private plan by alice@example.com https://private.example/?token=SECRET wallet=ADDRESS 192.0.2.1';

test('closed error vocabulary, safe context, readable severity/recovery/correlation and redacted export', () => {
    const d = client();
    const failure = Object.assign(new Error(privateText), { stack: privateText, url: privateText, code: privateText });
    const entry = d.report(failure, { code: 'plan-import-failed', context: { surface: 'plan-file', format: 'json', httpStatus: 400,
        title: privateText, geometry: privateText, url: privateText, ip: privateText, wallet: privateText } });
    assert.equal(entry.code, 'plan-import-failed'); assert.equal(entry.severity, 'warning'); assert.equal(entry.recoverable, true);
    assert.match(entry.correlationId, D.UUID); assert.equal(entry.message, D.CATALOG['plan-import-failed'][0]);
    assert.deepEqual(entry.context, { surface: 'plan-file', format: 'json', httpStatus: 400 });
    assert.ok(!d.exportText().includes('SECRET')); assert.ok(!d.exportText().includes('alice')); assert.ok(!d.exportText().includes('192.0.2.1'));
    const trap = { get code() { throw Error(privateText); }, get message() { throw Error(privateText); } };
    assert.equal(d.report(trap).code, 'unexpected');
    assert.equal(d.report(Object.assign(new Error(privateText), { code: 'network-failed' })).code, 'network-unavailable');
});

test('operation outcomes are completion evidence; failures remain recoverable and cancellation is separate', async () => {
    const d = client(); const original = new Error(privateText);
    const options = { entity: 'plan', planKey: 'private raw cid', code: 'plan-save-failed', context: { surface: 'named-plan' } };
    assert.equal(await d.run('save', options, async () => 42), 42);
    await assert.rejects(d.run('save', options, async () => { throw original; }), e => e === original);
    await assert.rejects(d.run('publish', options, async () => { throw { cancelled: true }; }));
    const rows = d.snapshot().entries;
    assert.deepEqual(rows.filter(e => e.kind === 'operation').map(e => e.outcome), ['success', 'failure', 'cancelled']);
    const failure = rows.find(e => e.kind === 'operation' && e.outcome === 'failure');
    assert.equal(failure.correlationId, rows.find(e => e.kind === 'error').correlationId);
    assert.equal(rows[0].planId, failure.planId); assert.ok(!d.exportText().includes('private raw cid'));
    assert.equal(rows.filter(e => e.kind === 'error').length, 1);
});

test('local buffer, dedupe, clearing, idle sessions and expiry are bounded without browser persistence', () => {
    let at = 1000; const d = client({ now: () => at }); const original = Error(privateText);
    const first = d.report(original); for (let i = 0; i < 1000; i++) d.report(Error(privateText));
    assert.equal(d.snapshot().entries.length, 1); assert.equal(d.report(original).correlationId, first.correlationId);
    for (let i = 0; i < 500; i++) d.event('edit', 'success', { entity: 'plan', planKey: 'plan-' + i });
    assert.equal(d.snapshot().entries.length, D.MAX_ENTRIES);
    const session = d.snapshot().entries.at(-1).sessionId;
    at += 31 * 60 * 1000; d.event('edit', 'success', { entity: 'plan', planKey: 'plan-499' });
    assert.notEqual(d.snapshot().entries.at(-1).sessionId, session);
    at += D.MAX_AGE_MS; assert.equal(d.snapshot().entries.length, 0);
    d.clear(); d.report(original); assert.equal(d.snapshot().entries.length, 1);
    assert.equal(d.event('pageview', 'success'), null);
});

test('explicit sending is off by default, bounded, redacted, deduplicated and network failure does not affect editing', async () => {
    let at = 1000, calls = 0; const d = client({ now: () => at });
    d.report(Error(privateText));
    const fetch = async (_url, options) => {
        calls++; assert.equal(options.credentials, 'omit'); assert.equal(options.referrerPolicy, 'no-referrer');
        assert.ok(!options.body.includes('SECRET')); assert.ok(!options.body.includes('message'));
        const body = JSON.parse(options.body); assert.ok(body.entries.length <= MAX_BATCH);
        return { ok: true, json: async () => ({ accepted: body.entries.length }) };
    };
    const send = extra => d.send({ endpoint: 'https://api.example/diagnostics/reports', fetch, ...extra });
    assert.equal((await send({ confirm: true })).code, 'submission-disabled');
    assert.equal((await send({ enabled: true })).code, 'submission-disabled'); assert.equal(calls, 0);
    const results = await Promise.all([send({ enabled: true, confirm: true }), send({ enabled: true, confirm: true })]);
    assert.ok(results.every(r => r.ok)); assert.equal(calls, 1);
    assert.equal((await send({ enabled: true, confirm: true })).code, 'submission-rate-limited');
    at += 60000;
    assert.equal((await send({ enabled: true, confirm: true, fetch: async () => { throw Error(privateText); } })).ok, false);
    assert.equal(await d.run('edit', { entity: 'design' }, async () => 'still editable'), 'still editable');
    at += 60000;
    assert.equal((await send({ enabled: true, confirm: true, timeoutMs: 2, fetch: () => new Promise(() => {}) })).ok, false);
    at += 60000;
    assert.equal((await send({ enabled: true, confirm: true, timeoutMs: 2, fetch: async () => ({ ok: true, json: () => new Promise(() => {}) }) })).ok, false);
    for (const endpoint of ['https://api.example/diagnostics/reports?token=SECRET', 'https://alice:pw@api.example/diagnostics/reports', 'data:text/plain,SECRET']) {
        at += 60000;
        assert.equal((await send({ enabled: true, confirm: true, endpoint })).code, 'submission-unavailable');
    }
    assert.ok(d.snapshot().entries.length > 0); assert.ok(!d.exportText().includes('SECRET'));
});

test('malformed, excessive, unknown, private, contradictory and spoofed fields are rejected', () => {
    const d = client(); d.event('create', 'success', { entity: 'plan', planKey: 'private', context: { surface: 'plan-file' } });
    const body = envelope(d), checked = validateDiagnosticReport(body);
    assert.equal(checked.value[0].source, 'ui'); assert.equal(checked.value[0].evidence, 'client-report'); assert.equal(checked.value[0].test, 'unknown');
    for (const input of [null, [], {}, { ...body, version: 2 }, { ...body, source: 'mcp' }, { ...body, entries: [] }, { ...body, entries: Array(21).fill(body.entries[0]) }]) {
        assert.equal(validateDiagnosticReport(input).error, 'invalid-diagnostic-report');
    }
    for (const patch of [{ message: privateText }, { stack: privateText }, { source: 'mcp' }, { test: 'known-test' }, { sessionId: 'alice' },
        { id: null }, { correlationId: privateText }, { planId: privateText }, { entity: 'design', planId: randomUUID() },
        { kind: 'error', operation: null, code: 'unexpected', outcome: 'success' }, { operation: 'pageview' },
        { kind: 'error', operation: null, outcome: 'failure', planId: null, code: { toString: 'SECRET', valueOf: 'SECRET' } },
        { context: { surface: 'plan-file', title: privateText } }, { context: { surface: privateText } }, { context: { httpStatus: 999 } }]) {
        assert.equal(validateDiagnosticReport({ version: 1, entries: [{ ...body.entries[0], ...patch }] }).error, 'invalid-diagnostic-report');
    }
    assert.equal(validateDiagnosticReport({ version: 1, entries: [body.entries[0], body.entries[0]] }).error, 'invalid-diagnostic-report');
});

test('fixed rate budget has no identity map and resets', () => {
    let at = 0; const budget = createBudget({ limit: 2, now: () => at });
    assert.equal(budget(), true); assert.equal(budget(), true); assert.equal(budget(), false);
    at = 60000; assert.equal(budget(), true);
});

test('API attribution uses matched routes, never URL text/headers or client declarations', () => {
    const row = createApiObservation({ method: 'POST', route: { path: '/plans' }, originalUrl: privateText, headers: { 'x-source': 'mcp' } }, { statusCode: 201 });
    assert.equal(row.source, 'api'); assert.equal(row.entity, 'plan'); assert.equal(row.sessionId, null); assert.equal(row.planId, null);
    assert.ok(!JSON.stringify(row).includes('SECRET'));
    assert.equal(createApiObservation({ method: 'GET', route: { path: '/plans' } }, { statusCode: 200 }), null);
    assert.equal(createApiObservation({ method: 'POST', route: { path: '/unknown' } }, { statusCode: 200 }), null);
    assert.equal(createApiObservation({ method: 'POST', route: { path: '/designs' } }, { statusCode: 503 }, { knownTest: true }).test, 'known-test');
});

test('MCP observation records actual tool completion, preserves results/errors and has no invented session/person', async () => {
    const rows = []; const observe = createMcpObserver({ record: row => rows.push(row), knownTest: true });
    const result = { content: privateText }; assert.equal(await observe('ugt_draft_plan', async () => result), result);
    await observe('ugt_edit_plan', async () => ({ isError: true, content: privateText }));
    const error = Error(privateText); await assert.rejects(observe('ugt_publish_plan', async () => { throw error; }), e => e === error);
    await observe('ugt_help', async () => ({})); assert.equal(rows.length, 3);
    assert.deepEqual(rows.map(r => r.outcome), ['success', 'failure', 'failure']);
    assert.ok(rows.every(r => r.source === 'mcp' && r.evidence === 'server' && r.test === 'known-test' && r.sessionId === null));
    assert.ok(!JSON.stringify(rows).includes('SECRET'));
    assert.equal(await createMcpObserver({ record: () => { throw Error(privateText); } })('ugt_edit_plan', async () => 42), 42);
    assert.equal(await createMcpObserver()('ugt_edit_plan', async () => 42), 42);
    await observe('ugt_draft_plan', async () => ({ content: privateText }), () => false);
    assert.equal(rows.at(-1).outcome, 'failure');
});

function poolModel({ locked = true, fail = false, mismatch = false } = {}) {
    const queries = []; let released = 0;
    return { queries, get released() { return released; }, async connect() {
        return { async query(sql, params) {
            queries.push({ sql, params });
            if (fail && sql === 'BEGIN') throw Error(privateText);
            if (sql.includes('pg_try_advisory')) return { rows: [{ locked }] };
            if (sql.includes('INSERT')) return { rows: mismatch ? [] : JSON.parse(params[0]).map(row => ({ id: row.id })) };
            return { rows: [] };
        }, release() { released++; } };
    } };
}
test('storage transaction deduplicates, rejects conflicting IDs, prunes retention and row cap, releases on failures', async () => {
    const d = client(); d.report(Error(privateText)); const row = validateDiagnosticReport(envelope(d)).value;
    const pool = poolModel(); assert.deepEqual(await createDiagnosticStore(pool).insert(row), { accepted: 1 });
    assert.equal(pool.released, 1); assert.ok(pool.queries.some(q => q.sql.includes("interval '7 days'")));
    assert.ok(pool.queries.some(q => q.params?.[0] === MAX_ROWS));
    assert.ok(pool.queries.some(q => q.sql.includes('existing.payload = EXCLUDED.payload')));
    assert.equal(pool.queries.at(-1).sql, 'COMMIT'); assert.ok(!JSON.stringify(pool.queries).includes('SECRET'));
    for (const [options, expected] of [[{ locked: false }, 'busy'], [{ fail: true }, 'unavailable'], [{ mismatch: true }, 'conflict']]) {
        const fake = poolModel(options); assert.equal((await createDiagnosticStore(fake).insert(row))[expected], true);
        assert.equal(fake.released, 1); assert.equal(fake.queries.at(-1).sql, 'ROLLBACK');
    }
});

test('storage limits concurrent DB work instead of building an unbounded queue', async () => {
    const releases = [];
    const pool = { connect: () => new Promise(resolve => releases.push(() => resolve({ query: async sql => ({ rows: sql.includes('advisory') ? [{ locked: false }] : [] }), release() {} }))) };
    const store = createDiagnosticStore(pool); const a = store.insert([]), b = store.insert([]);
    assert.equal((await store.insert([])).busy, true); assert.equal(releases.length, 2);
    releases.forEach(fn => fn()); await Promise.all([a, b]);
});

test('private report queries publication records first, never content, IDs, IPs or author fields', async () => {
    const queries = []; const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } };
    const report = await readPlanningUsage(pool); assert.equal(queries.length, 1); assert.equal(report.diagnostics.included, false);
    assert.match(queries[0].sql, /consensus\.plan/); assert.match(queries[0].sql, /consensus\.design/); assert.match(queries[0].sql, /consensus\.agreement/);
    await readPlanningUsage(pool, { days: 7, diagnostics: true });
    assert.match(queries.at(-1).sql, /LEAST\(\$1, 7\)/); assert.match(queries.at(-1).sql, /count\(DISTINCT/);
    assert.ok(!queries[0].sql.includes('content')); await assert.rejects(readPlanningUsage(pool, { days: 0 }));
});

test('integration gates precede large body parsing; no deployment or hosted MCP activation is included', () => {
    const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    assert.ok(index.indexOf('setupPlanningDiagnostics(app, activePool') < index.indexOf("app.use(express.json({ limit: '15mb' }))"));
    assert.ok(index.indexOf("const origin = req.get('origin')") < index.indexOf('setupPlanningDiagnostics(app, activePool'));
    const mcp = readFileSync(new URL('../agents/mcp-server.mjs', import.meta.url), 'utf8');
    assert.match(mcp, /this\.observeTool\(name/); assert.match(mcp, /diagnosticRecorder = null/);
});
