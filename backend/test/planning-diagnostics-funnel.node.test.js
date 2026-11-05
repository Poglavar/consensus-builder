// Planning funnel: steps flow through AppDiagnostics, upload once per session to the private
// store, reach Clarity as closed-vocabulary events, and stay off local or automated browsers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { validateDiagnosticReport } from '../operations/planning-diagnostics.js';
const require = createRequire(import.meta.url);
const D = require('../../frontend/js/app-diagnostics.js');
const F = require('../../frontend/js/app-funnel.js');
const ENDPOINT = 'https://api.example.test/diagnostics/reports';

function server({ status = 202 } = {}) {
    const batches = [];
    const fetch = async (_url, request) => {
        const body = JSON.parse(request.body);
        batches.push({ entries: body.entries, keepalive: request.keepalive });
        return { status, ok: status < 400, json: async () => (status < 400 ? { accepted: body.entries.length } : { code: 'x' }) };
    };
    return { batches, fetch };
}

function browser({ hostname = 'urbangametheory.xyz', webdriver = false, pathname = '/plans/abc' } = {}) {
    const listeners = {}, clarity = [], timers = [];
    const document = { visibilityState: 'visible', addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); } };
    const win = {
        document, location: { hostname, pathname }, navigator: { webdriver },
        clarity: (...args) => clarity.push(args), getBackendBase: () => 'https://api.example.test/',
        resolveCurrentCityCode: () => 'zagreb',
        setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {}
    };
    const fire = name => (listeners[name] || []).forEach(fn => fn());
    return { win, clarity, timers, fire };
}

test('upload sends each distinct observation once per session and the server accepts it', async () => {
    const d = D.create({ uuid: randomUUID });
    d.event('open', 'success', { entity: 'workspace', context: { surface: 'runtime', route: 'plans' } });
    for (let i = 0; i < 5; i++) d.event('inspect', 'success', { entity: 'parcel', context: { surface: 'click-stack' } });
    d.event('edit', 'success', { entity: 'design', context: { surface: 'draft-editor' } });
    d.event('edit', 'success', { entity: 'design', context: { surface: 'draft-editor' } });
    d.report(new Error('private text'), { code: 'plan-save-failed', context: { surface: 'named-plan' } });
    const s = server();
    assert.deepEqual(await d.upload({ fetch: s.fetch, endpoint: ENDPOINT }), { ok: true, accepted: 4 });
    const sent = s.batches.flatMap(batch => batch.entries);
    assert.deepEqual(sent.map(row => row.operation || row.code), ['open', 'inspect', 'edit', 'plan-save-failed']);
    assert.equal(sent[0].context.route, 'plans');
    assert.ok(!JSON.stringify(sent).includes('private text'));
    assert.equal(validateDiagnosticReport({ version: 1, entries: sent }).error, undefined);
    // Nothing new: no request. A new kind of step: only that one.
    assert.deepEqual(await d.upload({ fetch: s.fetch, endpoint: ENDPOINT }), { ok: true, accepted: 0 });
    d.event('publish', 'success', { entity: 'design', context: { surface: 'design-index' } });
    await d.upload({ fetch: s.fetch, endpoint: ENDPOINT });
    assert.deepEqual(s.batches.at(-1).entries.map(row => row.operation), ['publish']);
});

test('a failed upload is retried with the same entries; a disabled server stops uploading', async () => {
    const d = D.create({ uuid: randomUUID });
    d.event('start', 'success', { entity: 'design', context: { surface: 'draft-editor' } });
    const down = server({ status: 503 });
    assert.equal((await d.upload({ fetch: down.fetch, endpoint: ENDPOINT })).ok, false);
    const up = server();
    await d.upload({ fetch: up.fetch, endpoint: ENDPOINT });
    assert.equal(up.batches[0].entries[0].id, down.batches[0].entries[0].id);
    const disabled = server({ status: 404 });
    d.event('create', 'success', { entity: 'design', context: { surface: 'draft-editor' } });
    assert.equal((await d.upload({ fetch: disabled.fetch, endpoint: ENDPOINT })).code, 'submission-disabled');
    d.event('publish', 'success', { entity: 'design' });
    assert.equal((await d.upload({ fetch: up.fetch, endpoint: ENDPOINT })).code, 'submission-disabled');
    assert.equal(up.batches.length, 1);
});

test('the server rejects an unknown route or step', () => {
    const d = D.create({ uuid: randomUUID });
    const [row] = d.event('open', 'success', { entity: 'workspace', context: { route: 'plans' } }) ? d.snapshot().entries.map(D.wire) : [];
    assert.equal(validateDiagnosticReport({ version: 1, entries: [{ ...row, context: { route: '/plans/private-cid' } }] }).error, 'invalid-diagnostic-report');
    assert.equal(validateDiagnosticReport({ version: 1, entries: [{ ...row, operation: 'hover' }] }).error, 'invalid-diagnostic-report');
    assert.equal(D.contextOf({ route: '/plans/private-cid' }).route, undefined);
});

test('Clarity receives closed-vocabulary events, failure tags and recording upgrades', () => {
    assert.deepEqual(F.clarityCommands({ kind: 'operation', operation: 'inspect', entity: 'parcel', outcome: 'success', context: {} }),
        [['event', 'inspect-parcel-success']]);
    assert.deepEqual(F.clarityCommands({ kind: 'error', code: 'plan-save-failed', context: {} }),
        [['event', 'error-plan-save-failed'], ['set', 'error', 'plan-save-failed'], ['upgrade', 'plan-save-failed']]);
    assert.deepEqual(F.clarityCommands({ kind: 'operation', operation: 'publish', entity: 'design', outcome: 'failure', context: {} }),
        [['event', 'publish-design-failure'], ['set', 'failed', 'publish-design'], ['upgrade', 'publish-failure']]);
    assert.deepEqual(F.clarityCommands({ kind: 'operation', operation: 'open', entity: 'workspace', outcome: 'success', context: { route: 'map' } }),
        [['event', 'open-workspace-success'], ['set', 'entry', 'map']]);
    assert.equal(F.routeOf('/plans/bafy/monitors/3'), 'plans');
    assert.equal(F.routeOf('/'), 'map');
    assert.equal(F.routeOf('/unknown'), null);
});

test('installed funnel records app open, map inspection and design start, batching the upload', async () => {
    const b = browser(); const s = server(); b.win.fetch = s.fetch;
    const d = D.create({ uuid: randomUUID });
    const funnel = F.install(b.win, d);
    funnel.ready();
    funnel.inspect('parcels'); funnel.inspect('formed'); funnel.inspect('built'); funnel.inspect('not-a-kind');
    b.fire('parcelBasedModalOpened');
    assert.deepEqual(b.clarity, [['set', 'city', 'zagreb'], ['event', 'open-workspace-success'], ['set', 'entry', 'plans'],
        ['event', 'inspect-parcel-success'], ['event', 'inspect-building-success'], ['event', 'start-design-success']]);
    assert.equal(b.timers.length, 1);
    assert.equal(s.batches.length, 0);
    b.win.document.visibilityState = 'hidden'; b.fire('visibilitychange');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.batches.length, 1);
    assert.equal(s.batches[0].keepalive, true);
    assert.deepEqual(s.batches[0].entries.map(row => `${row.operation}-${row.entity}`),
        ['open-workspace', 'inspect-parcel', 'inspect-building', 'start-design']);
});

test('local and automated browsers send nothing to Clarity or the store', async () => {
    for (const options of [{ hostname: 'localhost' }, { webdriver: true }]) {
        const b = browser(options); const s = server(); b.win.fetch = s.fetch;
        const funnel = F.install(b.win, D.create({ uuid: randomUUID }));
        funnel.ready(); funnel.inspect('parcels');
        b.win.document.visibilityState = 'hidden'; b.fire('visibilitychange');
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(b.clarity, []); assert.equal(b.timers.length, 0); assert.equal(s.batches.length, 0);
    }
});
