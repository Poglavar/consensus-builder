// Planning funnel: steps flow through AppDiagnostics, upload once per session to the private
// store, reach Clarity as closed-vocabulary events, wait for the visitor's opt-in, and stay off
// local or automated browsers.
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

// Just enough DOM for the banner section and the Status log checkbox.
function element(tag) {
    const node = {
        tag, attrs: {}, children: [], listeners: {}, className: '', textContent: '', checked: false, parent: null,
        setAttribute(name, value) { node.attrs[name] = value; },
        append(...kids) { for (const kid of kids) { kid.parent = node; node.children.push(kid); } },
        appendChild(kid) { node.append(kid); return kid; },
        insertBefore(kid, ref) { kid.parent = node; const at = node.children.indexOf(ref); node.children.splice(at < 0 ? node.children.length : at, 0, kid); },
        addEventListener(name, fn) { (node.listeners[name] ||= []).push(fn); },
        fire(name) { (node.listeners[name] || []).forEach(fn => fn()); },
        remove() { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null; },
        all() { return node.children.flatMap(kid => [kid, ...kid.all()]); },
        querySelector(selector) { const attr = selector.match(/^\[(.+)\]$/)?.[1]; return node.all().find(kid => attr in kid.attrs) || null; }
    };
    return node;
}

function browser({ hostname = 'urbangametheory.xyz', webdriver = false, pathname = '/plans/abc', consent = null } = {}) {
    const listeners = {}, clarity = [], timers = [], stored = new Map(consent ? [[F.CONSENT_KEY, consent]] : []);
    const footer = element('div'), stack = element('div'), body = element('body');
    footer.append(Object.assign(element('button'), { attrs: { 'data-diagnostics-export': '' } }));
    const document = {
        visibilityState: 'visible', readyState: 'complete', body,
        addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); },
        createElement: element,
        querySelector: selector => (selector === '#status-log-modal .cb-dialog__footer' ? footer : null)
    };
    const win = {
        document, location: { hostname, pathname }, navigator: { webdriver },
        clarity: (...args) => clarity.push(args), getBackendBase: () => 'https://api.example.test/',
        resolveCurrentCityCode: () => 'zagreb',
        localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, String(value)) },
        __BannerStack: { mount: node => { stack.append(node); return stack; } },
        setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {}
    };
    const fire = name => (listeners[name] || []).forEach(fn => fn());
    const banner = () => stack.children.find(node => 'data-diagnostics-ask' in node.attrs) || null;
    const checkbox = () => footer.querySelector('[data-diagnostics-share]');
    return { win, clarity, timers, fire, stored, banner, checkbox };
}

const hide = async b => {
    b.win.document.visibilityState = 'hidden'; b.fire('visibilitychange');
    await new Promise(resolve => setImmediate(resolve));
};

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

test('an opted-in funnel records app open, map inspection and design start, batching the upload', async () => {
    const b = browser({ consent: 'yes' }); const s = server(); b.win.fetch = s.fetch;
    const d = D.create({ uuid: randomUUID });
    const funnel = F.install(b.win, d);
    funnel.ready();
    funnel.inspect('parcels'); funnel.inspect('formed'); funnel.inspect('built'); funnel.inspect('not-a-kind');
    b.fire('parcelBasedModalOpened');
    assert.deepEqual(b.clarity, [['set', 'city', 'zagreb'], ['event', 'open-workspace-success'], ['set', 'entry', 'plans'],
        ['event', 'inspect-parcel-success'], ['event', 'inspect-building-success'], ['event', 'start-design-success']]);
    assert.equal(b.timers.length, 1);
    assert.equal(s.batches.length, 0);
    assert.equal(b.banner(), null);
    assert.equal(b.checkbox().checked, true);
    await hide(b);
    assert.equal(s.batches.length, 1);
    assert.equal(s.batches[0].keepalive, true);
    assert.deepEqual(s.batches[0].entries.map(row => `${row.operation}-${row.entity}`),
        ['open-workspace', 'inspect-parcel', 'inspect-building', 'start-design']);
});

test('without an answer nothing is sent; the first error asks, and Share sends the steps already taken', async () => {
    const b = browser(); const s = server(); b.win.fetch = s.fetch;
    const d = D.create({ uuid: randomUUID });
    const funnel = F.install(b.win, d);
    funnel.ready(); funnel.inspect('parcels');
    await hide(b);
    assert.deepEqual(b.clarity, []); assert.equal(b.timers.length, 0); assert.equal(s.batches.length, 0);
    assert.equal(b.banner(), null, 'no ask before a problem');
    d.report(new Error('x'), { code: 'plan-save-failed', context: { surface: 'named-plan' } });
    assert.ok(b.banner(), 'the first error asks');
    assert.deepEqual(b.clarity, []);
    b.banner().querySelector('[data-diagnostics-yes]').fire('click');
    assert.equal(b.banner(), null);
    assert.equal(b.stored.get(F.CONSENT_KEY), 'yes');
    assert.equal(b.checkbox().checked, true);
    assert.deepEqual(b.clarity.map(command => command.slice(0, 2).join(':')),
        ['set:city', 'event:open-workspace-success', 'set:entry', 'event:inspect-parcel-success', 'event:error-plan-save-failed', 'set:error', 'upgrade:plan-save-failed']);
    await hide(b);
    assert.deepEqual(s.batches.flatMap(batch => batch.entries).map(row => row.operation || row.code), ['open', 'inspect', 'plan-save-failed']);
});

test('No thanks is remembered: nothing is sent and the next tab does not ask again', async () => {
    const b = browser(); const s = server(); b.win.fetch = s.fetch;
    const d = D.create({ uuid: randomUUID });
    F.install(b.win, d).ready();
    d.event('publish', 'failure', { entity: 'design', context: { surface: 'design-index' } });
    b.banner().querySelector('[data-diagnostics-no]').fire('click');
    d.report(new Error('x'), { code: 'share-failed' });
    await hide(b);
    assert.equal(b.stored.get(F.CONSENT_KEY), 'no');
    assert.deepEqual(b.clarity, []); assert.equal(s.batches.length, 0); assert.equal(b.banner(), null);
    const next = browser({ consent: 'no' }); next.win.fetch = s.fetch;
    const again = D.create({ uuid: randomUUID });
    F.install(next.win, again).ready();
    again.report(new Error('x'), { code: 'plan-save-failed' });
    await hide(next);
    assert.equal(next.banner(), null); assert.deepEqual(next.clarity, []); assert.equal(s.batches.length, 0);
    assert.equal(next.checkbox().checked, false);
});

test('the Status log checkbox changes the choice either way', async () => {
    const b = browser(); const s = server(); b.win.fetch = s.fetch;
    const d = D.create({ uuid: randomUUID });
    F.install(b.win, d).ready();
    const box = b.checkbox();
    assert.equal(b.win.document.querySelector('#status-log-modal .cb-dialog__footer').children.indexOf(box.parent), 0, 'before the download button');
    box.checked = true; box.fire('change');
    assert.equal(b.stored.get(F.CONSENT_KEY), 'yes');
    await hide(b);
    assert.deepEqual(s.batches.flatMap(batch => batch.entries).map(row => row.operation), ['open']);
    box.checked = false; box.fire('change');
    d.event('publish', 'success', { entity: 'design' });
    await hide(b);
    assert.equal(b.stored.get(F.CONSENT_KEY), 'no');
    assert.equal(s.batches.length, 1);
});

test('local and automated browsers send nothing to Clarity or the store, even after opting in', async () => {
    for (const options of [{ hostname: 'localhost' }, { webdriver: true }]) {
        const b = browser({ ...options, consent: 'yes' }); const s = server(); b.win.fetch = s.fetch;
        const d = D.create({ uuid: randomUUID });
        const funnel = F.install(b.win, d);
        funnel.ready(); funnel.inspect('parcels');
        d.report(new Error('x'), { code: 'plan-save-failed' });
        await hide(b);
        assert.deepEqual(b.clarity, []); assert.equal(b.timers.length, 0); assert.equal(s.batches.length, 0);
        assert.equal(b.banner(), null);
    }
});
