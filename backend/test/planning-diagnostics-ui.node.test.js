import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const D = require('../../frontend/js/app-diagnostics.js');
const FileUI = require('../../frontend/js/plan-file-ui.js');
const NamedPlans = require('../../frontend/js/named-plans.js');
const DesignSync = require('../../frontend/js/proposals/design-sync.js');
const BusyControl = require('../../frontend/js/ui/busy-control.js');
const { createProposalDraftStore } = require('../../frontend/js/proposal-drafts.js');
const secret = 'Private title alice@example.com ?token=SECRET 192.0.2.1';
class Element {
    children = []; listeners = {}; attributes = {}; dataset = {}; classList = { toggle() {} };
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { this.children.push(...children); }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    querySelector(selector) { return this.children.find(child => child.attributes?.[selector.slice(1, -1)] !== undefined) || null; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    remove() { this.removed = true; }
    click() { this.clicked = true; return this.listeners.click?.(); }
}
function browser() {
    const blobs = [], alerts = [], footer = new Element(), callbacks = {};
    const win = { document: { readyState: 'complete', body: new Element(), title: '', createElement: () => new Element(),
        querySelector: () => footer }, addEventListener: (name, callback) => { callbacks[name] = callback; },
        removeEventListener(name) { delete callbacks[name]; },
        URL: { createObjectURL(blob) { blobs.push(blob); return 'blob:download'; }, revokeObjectURL() {} }, Blob,
        setTimeout: callback => callback(), requestAnimationFrame: callback => queueMicrotask(callback),
        getProposalI18nHelper: () => (_key, fallback) => fallback, showStyledAlert: message => alerts.push(message), BusyControl,
        AppDiagnostics: D.create({ uuid: randomUUID }), location: { href: 'https://ugt.example/', pathname: '/', search: '' },
        resolveBackendBaseUrl: () => 'https://api.example', resolveFrontendBaseUrl: () => 'https://ugt.example',
        Cid: { cidOfObject: () => 'private raw cid', isCid: () => true },
        PlanRecord: { validate: () => null }, PersistentStorage: { forEach() {} } };
    return { win, alerts, blobs, footer, callbacks };
}
test('unexpected errors/rejections cannot recurse or leak error text; local download works without network', async () => {
    const { win, blobs, footer, callbacks } = browser(); let requests = 0;
    win.fetch = async () => { requests++; throw Error(secret); };
    const remove = D.install(win, win.AppDiagnostics);
    for (let i = 0; i < 500; i++) { callbacks.error({ error: Error(secret), filename: secret }); callbacks.unhandledrejection({ reason: secret }); }
    assert.equal(win.AppDiagnostics.snapshot().entries.length, 1);
    await footer.querySelector('[data-diagnostics-export]').click();
    const text = await blobs[0].text(); assert.ok(!text.includes('SECRET')); assert.equal(JSON.parse(text).version, 1);
    assert.equal(footer.querySelector('[data-diagnostics-send]'), null); assert.equal(requests, 0);
    await footer.querySelector('[data-diagnostics-clear]').click(); assert.equal(win.AppDiagnostics.snapshot().entries.length, 0);
    remove(); assert.equal(Object.keys(callbacks).length, 0);
});

test('file export success/failure restores controls, uses safe errors and never transmits diagnostics', async () => {
    const { win, alerts, blobs } = browser(); let fail = false, requests = 0;
    win.fetch = async () => { requests++; throw Error(secret); };
    win.PlanFile = { create: async () => { if (fail) throw Error(secret); return { plan: secret }; }, stringify: JSON.stringify,
        geojsonRecords: () => ({ type: 'FeatureCollection', features: [] }) };
    const ui = FileUI.browser(win), group = ui.controls({ getRecords: () => [{ title: secret }], getView: () => ({}) });
    const button = group.children.find(c => c.dataset.planFileAction === 'json');
    await button.click(); assert.equal(blobs.length, 1); assert.equal(button.disabled, false); assert.equal(BusyControl.isBusy(button), false);
    fail = true; await button.click(); assert.equal(button.disabled, false); assert.equal(BusyControl.isBusy(button), false);
    const outcomes = win.AppDiagnostics.snapshot().entries.filter(row => row.operation === 'export');
    assert.deepEqual(outcomes.map(row => row.outcome), ['success', 'failure']);
    assert.equal(alerts[0], D.CATALOG['plan-export-failed'][0]); assert.ok(!win.AppDiagnostics.exportText().includes('SECRET')); assert.equal(requests, 0);
});

test('file import only succeeds after atomic commit; invalid input, cancellation and storage rollback are separate', async () => {
    const { win, alerts } = browser(); let commits = 0, commitFails = false, cancel = false;
    win.PlanFile = { MAX_BYTES: 1000, parse(text) { if (text === 'bad') throw Error(secret); return { plan: { title: secret, view: { at: '45,15,17' } }, designs: [] }; },
        validate() {}, importInto: () => ({ cid: 'private raw cid', memberIds: [], content: { title: secret } }) };
    win.ProposalManager = { runParcelMutation: async (_kind, _id, action) => {
        if (commitFails) throw Error(secret); commits++; return action({ _parcelMutation: { proposals: {}, storage: { setItem() {} } } });
    } };
    win.showSimpleShareModal = options => {
        if (options.title === 'Review plan file') {
            const choice = options.actions.find(a => a.id === (cancel ? 'cancel' : 'import'));
            queueMicrotask(() => choice.onClick({ close() {} }));
        }
        return { close() {} };
    };
    const ui = FileUI.browser(win), group = ui.controls(), input = group.children.find(c => c.type === 'file');
    const choose = group.children.find(c => c.dataset.planFileAction === 'import');
    const select = async (text, size = 10) => { input.files = [{ size, text: async () => text }]; await input.listeners.change();
        assert.equal(choose.disabled, false); assert.equal(BusyControl.isBusy(choose), false); };
    await select('bad'); await select('valid', 1001); cancel = true; await select('valid'); assert.equal(commits, 0);
    cancel = false; commitFails = true; await select('valid'); assert.equal(commits, 0);
    commitFails = false; await select('valid'); assert.equal(commits, 1);
    const outcomes = win.AppDiagnostics.snapshot().entries.filter(row => row.operation === 'import').map(row => row.outcome);
    assert.deepEqual(outcomes, ['failure', 'failure', 'cancelled', 'failure', 'success']);
    assert.ok(alerts.every(message => !message.includes('SECRET'))); assert.ok(!win.AppDiagnostics.exportText().includes('SECRET'));
});

test('named plan save verifies readback before success and preserves recovery on network failure', async () => {
    const { win } = browser(); let fail = false;
    const row = { cid: 'private raw cid', content: { title: secret } };
    win.fetch = async () => { if (fail) throw Error(secret); return { ok: true, json: async () => row }; };
    const api = NamedPlans.browser(win); assert.equal((await api.save(row.content)).cid, row.cid);
    fail = true; await assert.rejects(api.save(row.content)); assert.equal(api.current.cid, row.cid);
    fail = false; assert.equal((await api.save(row.content)).cid, row.cid);
    assert.deepEqual(win.AppDiagnostics.snapshot().entries.filter(e => e.operation === 'save').map(e => e.outcome), ['success', 'failure', 'success']);
    assert.ok(!win.AppDiagnostics.exportText().includes('SECRET'));
});

test('clipboard recovery reports a failure without claiming a successful share', async () => {
    const { win } = browser(); win.navigator = { clipboard: { writeText: async () => { throw Error(secret); } } };
    const api = DesignSync.browser(win).api;
    assert.equal(await api.copyLink(secret), false);
    win.navigator.clipboard.writeText = async () => {};
    assert.equal(await api.copyLink(secret), true);
    assert.deepEqual(win.AppDiagnostics.snapshot().entries.filter(e => e.operation === 'share').map(e => e.outcome), ['failure', 'success']);
    assert.ok(!win.AppDiagnostics.exportText().includes('SECRET'));
});

test('actual draft store records meaningful edits only and distinguishes memory editing from failed device saves', () => {
    const d = D.create({ uuid: randomUUID }); let fails = false;
    const values = new Map(); const storage = { getItem: key => values.get(key) ?? null,
        setItem(key, value) { if (fails) throw Error(secret); values.set(key, value); }, removeItem: key => values.delete(key) };
    const store = createProposalDraftStore({ storage, diagnostics: d, idFactory: () => 'private-draft-id' });
    const draft = store.createDraft({ goal: 'park', cityId: 'zagreb', fields: { name: secret } });
    store.updateDraft(draft.id, {}); assert.equal(d.snapshot().entries.filter(e => e.operation === 'edit').length, 0);
    store.updateDraft(draft.id, { fields: { name: 'Changed private title' } });
    fails = true; store.updateDraft(draft.id, { fields: { name: 'Still editable in memory' } });
    assert.equal(store.getDraft(draft.id).fields.name, 'Still editable in memory');
    assert.equal(d.snapshot().entries.filter(e => e.operation === 'edit').length, 2);
    assert.equal(d.snapshot().entries.at(-1).operation, 'save'); assert.equal(d.snapshot().entries.at(-1).outcome, 'failure');
    assert.ok(d.snapshot().entries.some(e => e.code === 'draft-storage-unavailable')); assert.ok(!d.exportText().includes('SECRET'));
});
