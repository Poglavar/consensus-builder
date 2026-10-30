import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const D = require('../../frontend/js/app-diagnostics.js');
const Cid = require('../../frontend/js/cid.js');
const FileUI = require('../../frontend/js/plan-file-ui.js');
const NamedPlans = require('../../frontend/js/named-plans.js');
const PlanRecord = require('../../frontend/js/plan-record.js');
const DesignSync = require('../../frontend/js/proposals/design-sync.js');
const BusyControl = require('../../frontend/js/ui/busy-control.js');
const FileDownload = require('../../frontend/js/ui/file-download.js');
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');
const { cancelledError } = require('../../frontend/js/work-slicer.js');
const { createProposalDraftStore } = require('../../frontend/js/proposal-drafts.js');
const secret = 'Private title alice@example.com ?token=SECRET 192.0.2.1';
class Element {
    children = []; listeners = {}; attributes = {}; dataset = {}; classList = { toggle() {} };
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { this.children.push(...children); }
    prepend(...children) { this.children.unshift(...children); }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    querySelector(selector) { return this.children.find(child => child.attributes?.[selector.slice(1, -1)] !== undefined) || null; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    remove() { this.removed = true; }
    click() { this.clicked = true; return this.listeners.click?.(); }
}
function browser() {
    const blobs = [], alerts = [], footer = new Element(), callbacks = {}, stored = new Map();
    const win = { document: { readyState: 'complete', body: new Element(), title: '', createElement: () => new Element(),
        querySelector: () => footer }, addEventListener: (name, callback) => { callbacks[name] = callback; },
        removeEventListener(name) { delete callbacks[name]; },
        URL: { createObjectURL(blob) { blobs.push(blob); return 'blob:download'; }, revokeObjectURL() {} }, Blob,
        setTimeout: callback => callback(), requestAnimationFrame: callback => queueMicrotask(callback),
        getProposalI18nHelper: () => (_key, fallback) => fallback, showStyledAlert: message => alerts.push(message), BusyControl, FileDownload,
        AppDiagnostics: D.create({ uuid: randomUUID }), location: { href: 'https://ugt.example/', pathname: '/', search: '' },
        resolveBackendBaseUrl: () => 'https://api.example', resolveFrontendBaseUrl: () => 'https://ugt.example',
        Cid: { cidOfObject: () => 'private raw cid', isCid: () => true },
        PlanRecord: { validate: () => null }, PersistentStorage: {
            getItem: key => stored.get(key) ?? null,
            setItem(key, value) { stored.set(key, String(value)); },
            removeItem: key => stored.delete(key),
            forEach(callback) { stored.forEach((value, key) => callback(value, key)); }
        } };
    return { win, alerts, blobs, footer, callbacks, stored };
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
        if (commitFails) throw Error(secret); commits++; return action({ _parcelMutation: { proposals: {}, storage: {
                setItem(key, value) { win.PersistentStorage.setItem(key, value); }
            } } });
    } };
    win.showSimpleShareModal = options => {
        if (options.title === 'Review plan file') {
            const choice = options.actions.find(a => a.id === (cancel ? 'cancel' : 'import'));
            queueMicrotask(() => choice.onClick({ close() {} }));
        }
        return { close() {} };
    };
    const ui = FileUI.browser(win);
    const select = (text, size = 10) => ui.importFile('plans', { size, text: async () => text });
    await select('bad'); await select('valid', 1001); cancel = true; await select('valid'); assert.equal(commits, 0);
    cancel = false; commitFails = true; await select('valid'); assert.equal(commits, 0);
    commitFails = false; await select('valid'); assert.equal(commits, 1);
    assert.equal(JSON.parse(win.PersistentStorage.getItem('ugt-imported-plan:private raw cid')).content.title, secret);
    const outcomes = win.AppDiagnostics.snapshot().entries.filter(row => row.operation === 'import').map(row => row.outcome);
    assert.deepEqual(outcomes, ['failure', 'failure', 'cancelled', 'failure', 'success']);
    assert.ok(alerts.every(message => !message.includes('SECRET'))); assert.ok(!win.AppDiagnostics.exportText().includes('SECRET'));
});

test('a design file read on the Designs tab adds its designs and keeps no imported plan', async () => {
    const { win, stored } = browser(); let reviewed = null, notice = null;
    win.PlanFile = { MAX_BYTES: 1000, parse: () => ({ plan: { title: 'One park', view: { at: '45,15,17' } }, designs: [{ content: { title: 'Park' } }] }),
        validate() {}, importInto: () => ({ cid: 'cid', memberIds: ['file-1'], content: { title: 'One park' } }) };
    win.ProposalManager = { runParcelMutation: async (_kind, _id, action) => action({ _parcelMutation: { proposals: {}, storage: {
        setItem(key, value) { win.PersistentStorage.setItem(key, value); } } } }) };
    win.showSimpleShareModal = options => {
        reviewed = options.title; queueMicrotask(() => options.actions.find(a => a.id === 'import').onClick({ close() {} }));
        return { close() {} };
    };
    win.showEphemeralMessage = message => { notice = message; };
    await FileUI.browser(win).importFile('designs', { size: 10, text: async () => '{}' });
    assert.equal(reviewed, 'Review design file');
    assert.equal(notice, 'Designs imported as local drafts: {{count}}');
    assert.equal([...stored.keys()].filter(key => key.startsWith('ugt-imported-plan:')).length, 0);
});

test('Imported lists what files brought to this device: designs by their file id, agreements by their mark', () => {
    const { win } = browser();
    win.proposalStorage = { getAllProposals: () => [{ proposalId: 'file-1', title: 'From a file' }, { proposalId: 'p-2', title: 'Drawn here' }] };
    win.AgreementStore = { get: id => (id === 'ag-1' ? { id, title: 'Imported terms' } : null) };
    win.PersistentStorage.setItem('ugt-imported-agreement:ag-1', '1');
    win.PersistentStorage.setItem('ugt-imported-agreement:ag-gone', '1');
    const ui = FileUI.browser(win);
    assert.deepEqual(ui.importedRows('designs').map(row => row.title), ['From a file']);
    assert.deepEqual(ui.importedRows('agreements').map(row => row.title), ['Imported terms']);
    assert.deepEqual(ui.importedRows('plans'), []);
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

test('invalid plans and CID hashing failures stay inside observed save and never request the server', async () => {
    const { win } = browser(); let requests = 0, hashes = 0;
    win.fetch = async () => { requests++; throw Error(secret); };
    win.PlanRecord.validate = () => secret;
    const originalCidOfObject = win.Cid.cidOfObject;
    win.Cid.cidOfObject = () => { hashes++; throw Error(secret); };
    const api = NamedPlans.browser(win);
    await assert.rejects(api.save({ title: secret }));
    assert.equal(hashes, 0, 'invalid content must fail before hashing');
    win.PlanRecord.validate = () => null;
    await assert.rejects(api.save({ title: secret }));
    assert.equal(hashes, 1);
    assert.equal(requests, 0);
    const operations = win.AppDiagnostics.snapshot().entries.filter(entry => entry.operation === 'save');
    assert.deepEqual(operations.map(entry => entry.outcome), ['failure', 'failure']);
    assert.ok(operations.every(entry => entry.planId === null));
    assert.ok(!win.AppDiagnostics.exportText().includes('SECRET'));
    win.Cid.cidOfObject = originalCidOfObject;
});

test('plan import and repeated saves share one private handle for a CID, while distinct CIDs stay separate', async () => {
    const { win, alerts } = browser();
    win.Cid = Cid;
    win.PlanRecord = PlanRecord;
    const designCid = Cid.cidOfObject({ test: 'member' });
    const imported = PlanRecord.create('same plan', [designCid], { at: '45,15,16', mode: '2d', city: 'zagreb', language: 'en' });
    const cidOfObject = Cid.cidOfObject;
    win.PlanFile = { MAX_BYTES: 1000, parse: () => ({ plan: imported, designs: [] }), validate() {},
        importInto: file => ({ cid: cidOfObject(file.plan), content: file.plan, memberIds: [] }) };
    win.ProposalManager = { runParcelMutation: async (_kind, _id, action) => action({ _parcelMutation: { proposals: {}, storage: {
        setItem(key, value) { win.PersistentStorage.setItem(key, value); }
    } } }) };
    win.showSimpleShareModal = options => {
        if (options.title === 'Review plan file') queueMicrotask(() => options.actions.find(action => action.id === 'import').onClick({ close() {} }));
        return { close() {} };
    };
    const fileUi = FileUI.browser(win);
    await fileUi.importFile('plans', { size: 10, text: async () => '{"valid":true}' });
    const cid = cidOfObject(imported);
    assert.ok(win.PersistentStorage.getItem(`ugt-imported-plan:${cid}`));
    assert.deepEqual(win.AppDiagnostics.snapshot().entries.filter(entry => entry.operation === 'import').map(entry => entry.outcome), ['success']);
    let row = null;
    win.fetch = async (_url, options) => {
        if (options.method === 'POST') row = { cid: cidOfObject(JSON.parse(options.body).content), content: JSON.parse(options.body).content };
        return { ok: true, json: async () => row };
    };
    const api = NamedPlans.browser(win);
    await api.save(imported);
    const reorderedClone = { view: { ...imported.view }, designCids: [...imported.designCids], title: imported.title, schema: imported.schema };
    await api.save(reorderedClone);
    await api.save({ ...imported, view: { ...imported.view, at: '46,16,16' } });
    const operations = win.AppDiagnostics.snapshot().entries.filter(entry => entry.kind === 'operation');
    assert.deepEqual(operations.map(entry => entry.operation), ['import', 'save', 'save', 'save']);
    assert.equal(operations[0].planId, operations[1].planId);
    assert.equal(operations[1].planId, operations[2].planId);
    assert.notEqual(operations[2].planId, operations[3].planId);
    const exported = win.AppDiagnostics.exportText();
    assert.ok(!exported.includes('same plan'));
    assert.ok(!exported.includes(cid));
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

test('import failures keep their operation-specific error after the real mutation boundary', async t => {
    const d = D.create({ uuid: randomUUID });
    globalThis.AppDiagnostics = d;
    t.after(() => { delete globalThis.AppDiagnostics; });
    const error = new Error('synthetic storage failure');
    await assert.rejects(d.run('import', { entity: 'plan', code: 'plan-import-failed', context: { surface: 'plan-file' } }, () =>
        ProposalManager.runParcelMutation('import-plan-file', null, async () => { throw error; }, { _mapMutation: false })), caught => caught === error);
    const diagnostic = d.snapshot().entries.find(entry => entry.kind === 'error');
    assert.equal(diagnostic.code, 'plan-import-failed');
    assert.equal(diagnostic.context.surface, 'plan-file');
});

test('normal replay supersession is not recorded as a planning error', async t => {
    const d = D.create({ uuid: randomUUID });
    globalThis.AppDiagnostics = d;
    t.after(() => { delete globalThis.AppDiagnostics; });
    const cancelled = cancelledError('city-changed');
    await assert.rejects(ProposalManager.runParcelMutation('rebuild-applied-fabric', null, async () => { throw cancelled; }, { _mapMutation: false }), caught => caught === cancelled);
    assert.deepEqual(d.snapshot().entries.filter(entry => entry.kind === 'error'), []);
});
