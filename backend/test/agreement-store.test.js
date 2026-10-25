// agreement-store.js and the pure helpers of agreement-dialog.js (plan-design-agreement.md, M1 (b)):
// the local agreement rows on a fake storage (save, list, get, remove, clear, subscribers) and the editor's record, allocation, money, rule and section helpers, without
// a DOM; and what the editor decides before it docks (M3): "Add to agreement" choosing a new agreement
// or one not proposed yet, and the refusal to edit a proposed one. AgreementRecord and AgreementGround
// are stubbed: this file tests the store and the editor only.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Store = require('../../frontend/js/agreement-store.js');
const Dialog = require('../../frontend/js/agreement-dialog.js');
const Panel = require('../../frontend/js/agreement-panel.js');
// The real money schedule the agreement ledger hands back (AgreementRecord.ledger(...).money).
const Deal = require('../../frontend/js/reparcellization-deal.js');
const Cid = require('../../frontend/js/cid.js');
const PlanRecord = require('../../frontend/js/plan-record.js');

// A PersistentStorage-shaped map; like the real one, forEach swallows what its iterator throws.
function fakeStorage(seed = {}) {
    const rows = new Map(Object.entries(seed));
    return {
        rows,
        getItem: key => (rows.has(String(key)) ? rows.get(String(key)) : null),
        setItem: (key, value) => { rows.set(String(key), String(value)); },
        removeItem: key => { rows.delete(String(key)); },
        forEach: iterator => rows.forEach((value, key) => { try { iterator(value, key); } catch (_) { } }),
        key: index => Array.from(rows.keys())[index] ?? null,
        get length() { return rows.size; }
    };
}

// Stands in for AgreementRecord.normalize: refuses what is not an agreement, trims the title.
const normalize = vi.fn(raw => {
    if (!raw || raw.schema !== 'agreement/v1' || !raw.id) throw Object.assign(new Error('Expected agreement/v1.'), { code: 'invalid-agreement' });
    return { ...raw, title: raw.title ? String(raw.title).trim() : null };
});

function setup({ seed } = {}) {
    const storage = fakeStorage(seed);
    let clock = new Date('2026-10-21T10:00:00.000Z');
    const store = Store.create({ storage, normalize, now: () => clock });
    return { storage, store, tick: iso => { clock = new Date(iso); } };
}

const agreement = (id, extra = {}) => ({ schema: 'agreement/v1', id, title: ` ${id} title `, designs: [], ...extra });

afterEach(() => {
    vi.unstubAllGlobals();
    normalize.mockClear();
});

describe('AgreementStore', () => {
    it('saves a normalized, stamped row at agreement:<id> and reads it back', () => {
        const { storage, store } = setup();
        const saved = store.save(agreement('ag-1'));
        expect(normalize).toHaveBeenCalledTimes(1);
        expect(saved).toMatchObject({ id: 'ag-1', title: 'ag-1 title', createdAt: '2026-10-21T10:00:00.000Z', updatedAt: '2026-10-21T10:00:00.000Z' });
        expect(JSON.parse(storage.getItem('agreement:ag-1'))).toEqual(saved);
        expect(store.get('ag-1')).toEqual(saved);
        expect(store.get('ag-missing')).toBeNull();
        expect(Store.KEY_PREFIX).toBe('agreement:');
    });

    it('keeps createdAt across edits and moves updatedAt', () => {
        const { store, tick } = setup();
        const first = store.save(agreement('ag-1'));
        tick('2026-10-22T08:30:00.000Z');
        const second = store.save({ ...first, title: 'Courtyard' });
        expect(second.createdAt).toBe('2026-10-21T10:00:00.000Z');
        expect(second.updatedAt).toBe('2026-10-22T08:30:00.000Z');
        expect(store.get('ag-1').title).toBe('Courtyard');
    });

    it('lists only agreement rows, newest createdAt first, ties by id', () => {
        const { store, tick } = setup({ seed: { 'proposal:p1': '{"proposalId":"p1"}', parcel_7_owner: 'agent-1' } });
        tick('2026-10-01T00:00:00.000Z');
        store.save(agreement('ag-old'));
        tick('2026-10-05T00:00:00.000Z');
        store.save(agreement('ag-b'));
        store.save(agreement('ag-a'));
        expect(store.list().map(row => row.id)).toEqual(['ag-a', 'ag-b', 'ag-old']);
    });

    it('names a row that is not JSON instead of skipping it', () => {
        const { store } = setup({ seed: { 'agreement:ag-bad': '{not json' } });
        expect(() => store.list()).toThrow(/agreement:ag-bad/);
        expect(() => store.get('ag-bad')).toThrow(expect.objectContaining({ code: 'invalid-agreement-row' }));
    });

    it('removes one row and clears every agreement row, leaving the rest of the storage', () => {
        const { storage, store } = setup({ seed: { 'proposal:p1': '{}' } });
        store.save(agreement('ag-1'));
        store.save(agreement('ag-2'));
        store.save(agreement('ag-3'));
        expect(store.remove('ag-2')).toBe(true);
        expect(store.remove('ag-2')).toBe(false);
        expect(store.list().map(row => row.id).sort()).toEqual(['ag-1', 'ag-3']);
        expect(store.clear()).toBe(2);
        expect(store.list()).toEqual([]);
        expect(Array.from(storage.rows.keys())).toEqual(['proposal:p1']);
    });

    it('writes nothing and tells nobody when the record does not normalize', () => {
        const { storage, store } = setup();
        const listener = vi.fn();
        store.subscribe(listener);
        expect(() => store.save({ schema: 'agreement/v0', id: 'ag-1' })).toThrow(expect.objectContaining({ code: 'invalid-agreement' }));
        expect(storage.rows.size).toBe(0);
        expect(listener).not.toHaveBeenCalled();
    });

    it('tells subscribers about saves, removals and clears until they unsubscribe', () => {
        const { store } = setup();
        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);
        const saved = store.save(agreement('ag-1'));
        store.remove('ag-1');
        store.save(agreement('ag-2'));
        store.clear();
        expect(listener.mock.calls.map(([change]) => change)).toEqual([
            { type: 'save', id: 'ag-1', agreement: saved },
            { type: 'remove', id: 'ag-1' },
            { type: 'save', id: 'ag-2', agreement: expect.objectContaining({ id: 'ag-2' }) },
            { type: 'clear', ids: ['ag-2'] }
        ]);
        unsubscribe();
        store.save(agreement('ag-3'));
        expect(listener).toHaveBeenCalledTimes(4);
        expect(() => store.subscribe('not a function')).toThrow(TypeError);
    });

    it('a subscriber that throws neither undoes the write nor silences the others; its error is raised on its own', () => {
        const raised = [];
        vi.stubGlobal('queueMicrotask', task => { try { task(); } catch (error) { raised.push(error); } });
        const { storage, store } = setup();
        const after = vi.fn();
        store.subscribe(() => { throw new Error('panel broke'); });
        store.subscribe(after);
        expect(() => store.save(agreement('ag-1'))).not.toThrow();
        expect(storage.getItem('agreement:ag-1')).not.toBeNull();
        expect(after).toHaveBeenCalledTimes(1);
        expect(raised.map(error => error.message)).toEqual(['panel broke']);
    });
});

// ---- the dialog's pure helpers -----------------------------------------------------------------

const square = (x, y) => ({ type: 'Polygon', coordinates: [[[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]]] });
const land = {
    inputs: {
        parcels: [
            { parcelId: '335/2', areaM2: 400, holders: [{ ownerKey: 'agent-ana', displayName: 'Ana', share: 0.5 }, { ownerKey: 'agent-ben', displayName: 'Ben', share: 0.5 }] },
            { parcelId: '335/10', areaM2: 600, holders: [{ ownerKey: 'agent-ana', displayName: 'Ana', share: 1 }] },
            { parcelId: '336', areaM2: null, holders: [] }
        ],
        openGroundM2: 0
    },
    outputs: [
        { hash: 'piece1-sha256:aa', pieceId: 'p1#1', areaM2: 520, fromParcelIds: ['335/10', '335/2'], producedBy: 'p1', role: 'plot',
            holders: [{ ownerKey: 'agent-ana', displayName: 'Ana', share: 0.8 }, { ownerKey: 'agent-ben', displayName: 'Ben', share: 0.2 }], geometry: square(0, 0) },
        { hash: 'piece1-sha256:bb', pieceId: 'p1#2', areaM2: 480, fromParcelIds: ['335/2'], producedBy: 'p1', role: 'plot', holders: [], geometry: square(1, 0) }
    ]
};

describe('choosing the designs', () => {
    it('offers the applied designs in authored order', () => {
        const records = [{ proposalId: 'b', applied: true }, { proposalId: 'a', applied: true }, { proposalId: 'c', applied: false }, { applied: true }];
        const order = vi.fn(list => list.slice().sort((x, y) => x.proposalId.localeCompare(y.proposalId)));
        expect(Dialog.appliedDesigns(records, { isApplied: record => record.applied === true, orderFormations: order }).map(r => r.proposalId)).toEqual(['a', 'b']);
        expect(order).toHaveBeenCalledTimes(1);
        expect(() => Dialog.appliedDesigns(records, {})).toThrow(TypeError);
    });

    it('asks for the declared parcels and the cadastral anchors of every produced piece, once, in order', () => {
        const fabric = {
            producedBy: id => (id === 'layout' ? [
                { properties: { cadastreParcelIds: ['335/10', ' 335/2 '] } },
                { properties: { cadastreParcelIds: ['335/2'] } },
                { properties: {} }
            ] : [])
        };
        const designs = [{ proposalId: 'road', cadastreParcelIds: ['336', '', null, '335/2'] }, { proposalId: 'layout' }];
        expect(Dialog.inputParcelIds(designs, fabric)).toEqual(['335/2', '335/10', '336']);
    });

    it('indexes the original cadastral features by id, with the fabric\'s id rule when given', () => {
        const features = [{ properties: { parcelId: '335/2' } }, { properties: { id: 7 } }, { properties: {} }];
        expect(Array.from(Dialog.originalsById(features).keys())).toEqual(['335/2', '7']);
        const byOwnRule = Dialog.originalsById(features, feature => feature.properties.parcelId);
        expect(Array.from(byOwnRule.keys())).toEqual(['335/2']);
    });
});

describe('allocation and money', () => {
    it('offers the current holders, each input party once, and the public', () => {
        expect(Dialog.partiesOf(land.inputs)).toEqual([{ ownerKey: 'agent-ana', displayName: 'Ana' }, { ownerKey: 'agent-ben', displayName: 'Ben' }]);
        expect(Dialog.allocationOptions(land.inputs)).toEqual([
            { value: 'holders', label: 'Current holders' },
            { value: 'party:agent-ana', label: 'Ana' },
            { value: 'party:agent-ben', label: 'Ben' },
            { value: 'public', label: 'Public' }
        ]);
    });

    it('turns a select value into an allocation line and back; current holders is no line', () => {
        expect(Dialog.allocationTo('party:agent:with:colons')).toEqual({ kind: 'party', ownerKey: 'agent:with:colons' });
        expect(Dialog.allocationTo('public')).toEqual({ kind: 'public' });
        expect(Dialog.allocationTo('holders')).toBeNull();
        expect(Dialog.allocationTo('party:')).toBeNull();
        expect(Dialog.allocationValue({ kind: 'party', ownerKey: 'agent-ana' })).toBe('party:agent-ana');
        expect(Dialog.allocationValue({ kind: 'public' })).toBe('public');
        expect(Dialog.allocationValue(null)).toBe('holders');
    });

    it('reads typed euros as cents, empty as no line, and anything else as unreadable', () => {
        expect(Dialog.cashCents('')).toBeNull();
        expect(Dialog.cashCents('  ')).toBeNull();
        expect(Dialog.cashCents('12.5')).toBe(1250);
        expect(Dialog.cashCents('-3')).toBe(-300);
        expect(Dialog.cashCents('0.29')).toBe(29);
        expect(Dialog.cashCents('.5')).toBe(50);
        expect(Dialog.cashCents('1e3')).toBeNaN();
        expect(Dialog.cashCents('invalid')).toBeNaN();
        expect(Dialog.cashInputText({ value: '', validity: { badInput: true } })).toBe('invalid');
        expect(Dialog.cashInputText({ value: '4.20', validity: { badInput: false } })).toBe('4.20');
    });

    it('keeps the terms whose piece and party survive a new derivation, and drops the rest', () => {
        const stored = {
            allocations: [
                { output: 'piece1-sha256:aa', to: { kind: 'party', ownerKey: 'agent-ben' } },
                { output: 'piece1-sha256:gone', to: { kind: 'public' } },
                { output: 'piece1-sha256:bb', to: { kind: 'party', ownerKey: 'agent-left' } }
            ],
            money: { currency: 'EUR', lines: [{ ownerKey: 'agent-ana', amountCents: -1250 }, { ownerKey: 'agent-left', amountCents: 500 }] }
        };
        const terms = Dialog.termsOf(stored);
        expect(terms).toEqual({
            allocations: { 'piece1-sha256:aa': 'party:agent-ben', 'piece1-sha256:gone': 'public', 'piece1-sha256:bb': 'party:agent-left' },
            cash: { 'agent-ana': '-12.5', 'agent-left': '5' }
        });
        expect(Dialog.keptTerms({ ...terms, cash: { ...terms.cash, 'agent-ben': 'invalid' } }, land)).toEqual({
            allocations: { 'piece1-sha256:aa': 'party:agent-ben' },
            cash: { 'agent-ana': '-12.5' }
        });
    });

    it('words the sponsor line of the real money schedule', () => {
        const schedule = lines => Deal.schedule({
            ledger: lines.map(([ownerKey, amountCents]) => ({ ownerKey, cashCents: Math.max(0, amountCents), payCents: Math.max(0, -amountCents) })),
            terms: { currency: 'EUR' }
        });
        expect(Dialog.sponsorLine(schedule([['a', 125050], ['b', -50]]), 'EUR')).toMatchObject({ kind: 'funds', cents: 125000, text: 'Sponsor funds 1250 EUR' });
        expect(Dialog.sponsorLine(schedule([['a', -1050]]), 'EUR')).toMatchObject({ kind: 'receives', cents: 1050, text: 'Sponsor receives 10.50 EUR' });
        expect(Dialog.sponsorLine(schedule([]))).toMatchObject({ kind: 'balanced', text: 'No money moves.' });
        expect(Dialog.sponsorLine(schedule([['a', 700], ['b', -700]]))).toMatchObject({ kind: 'covered', cents: 0 });
        expect(Dialog.sponsorLine(null)).toBeNull();
    });
});

describe('the decision rule across derivations', () => {
    const rightsFromInputs = vi.fn(inputs => ({ schema: 'parcel-rights/v1', source: { provider: 'local-owners' }, parcels: inputs.parcels.map(p => ({ parcelId: p.parcelId })) }));

    it('starts as "every owner must agree" over the local owners of the inputs', () => {
        expect(Dialog.ruleConfigAfterDerive(null, land.inputs, rightsFromInputs)).toEqual({
            schema: 'proposal-approval/v1',
            rights: { schema: 'parcel-rights/v1', source: { provider: 'local-owners' }, parcels: [{ parcelId: '335/2' }, { parcelId: '335/10' }, { parcelId: '336' }] },
            policy: { type: 'unanimous' }
        });
    });

    it('rebuilds local-owner rights from the new land but keeps the chosen rules; imported rights stay', () => {
        const local = { schema: 'proposal-approval/v1', rights: { source: { provider: 'local-owners' }, parcels: [] }, policy: { type: 'rules', tests: [] }, regime: { id: 'x', version: '2026-01-01' } };
        const rebuilt = Dialog.ruleConfigAfterDerive(local, land.inputs, rightsFromInputs);
        expect(rebuilt.policy).toBe(local.policy);
        expect(rebuilt.regime).toBe(local.regime);
        expect(rebuilt.rights.parcels).toHaveLength(3);
        const imported = { ...local, rights: { source: { provider: 'upload', reference: 'notary-2026' }, parcels: [] } };
        expect(Dialog.ruleConfigAfterDerive(imported, land.inputs, rightsFromInputs)).toBe(imported);
        expect(Dialog.ruleConfigAfterDerive({ ...local, rights: null }, land.inputs, rightsFromInputs).rights.source.provider).toBe('local-owners');
        expect(() => Dialog.ruleConfigAfterDerive(null, land.inputs)).toThrow(TypeError);
    });
});

describe('the deadline field', () => {
    it('takes the end of the chosen day in local time and gives the day back', () => {
        const iso = Dialog.deadlineFromDate('2026-12-31');
        const date = new Date(iso);
        expect([date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes()]).toEqual([2026, 11, 31, 23, 59]);
        expect(Dialog.dateFromDeadline(iso)).toBe('2026-12-31');
        expect(Dialog.deadlineFromDate('')).toBeNull();
        expect(Dialog.deadlineFromDate('2026-02-31')).toBe('2026-02-31');
        expect(Dialog.dateFromDeadline(null)).toBe('');
        expect(Dialog.dateFromDeadline('not a date')).toBe('');
    });
});

describe('the record the form describes', () => {
    // Each design is named by its CID (DesignRecord.cidOf), which the dialog looks up per design.
    const LAYOUT_CID = Cid.cidOfObject({ design: 'layout' });
    const ROAD_CID = Cid.cidOfObject({ design: 'road' });
    const designs = [
        { proposalId: 'layout', title: 'Courtyard plots', goal: 'parcel-layout', city: 'ny' },
        { proposalId: 'road', name: 'New lane', goal: 'road-track' },
        { proposalId: 'untitled' }
    ];
    const formState = {
        id: 'ag-1', city: 'ny', currency: 'USD', designs, land,
        fingerprints: new Map([['layout', LAYOUT_CID], ['road', ROAD_CID]]),
        approvalConfig: { schema: 'proposal-approval/v1', rights: null, policy: { type: 'unanimous' } },
        lens: ['lens-key-1']
    };
    const values = {
        allocations: { 'piece1-sha256:aa': 'party:agent-ben', 'piece1-sha256:bb': 'holders', 'piece1-sha256:gone': 'public' },
        cash: { 'agent-ana': '-12.5', 'agent-ben': '12.50', 'agent-nobody': '99' },
        electorate: 'owners', binding: true, title: '  Courtyard  ', deadline: '2026-12-31'
    };

    it('is the contract shape: designs in authored order, allocation lines only off the holders, non-zero cash of input parties', () => {
        const record = Dialog.recordFromForm(formState, values);
        expect(record).toEqual({
            schema: 'agreement/v1',
            id: 'ag-1',
            title: 'Courtyard',
            city: 'ny',
            createdAt: null,
            updatedAt: null,
            plan: null,
            designs: [
                { proposalId: 'layout', title: 'Courtyard plots', goal: 'parcel-layout', cid: LAYOUT_CID },
                { proposalId: 'road', title: 'New lane', goal: 'road-track', cid: ROAD_CID },
                { proposalId: 'untitled', title: 'Untitled design', goal: null, cid: null }
            ],
            inputs: land.inputs,
            outputs: land.outputs,
            allocations: [{ output: 'piece1-sha256:aa', to: { kind: 'party', ownerKey: 'agent-ben' } }],
            money: { currency: 'USD', lines: [{ ownerKey: 'agent-ana', amountCents: -1250 }, { ownerKey: 'agent-ben', amountCents: 1250 }] },
            rule: { electorate: 'owners', binding: true, approvalConfig: formState.approvalConfig, lens: ['lens-key-1'] },
            consultation: null,
            deadline: Dialog.deadlineFromDate('2026-12-31')
        });
    });

    it('a community vote never binds and carries no owner rule', () => {
        const record = Dialog.recordFromForm(formState, { ...values, electorate: 'community', binding: true });
        expect(record.rule).toEqual({ electorate: 'community', binding: false, approvalConfig: null, lens: [] });
        expect(record.allocations).toEqual([]);
        expect(record.money.lines).toEqual([]);
        expect(record.consultation).toEqual({ organiser: null, participationUrl: null });
    });

    it('keeps an unreadable amount for the validation to name, and drops zero and empty lines', () => {
        const record = Dialog.recordFromForm(formState, { ...values, cash: { 'agent-ana': 'invalid', 'agent-ben': '0' }, title: '', deadline: '' });
        expect(record.money.lines).toHaveLength(1);
        expect(record.money.lines[0].ownerKey).toBe('agent-ana');
        expect(record.money.lines[0].amountCents).toBeNaN();
        expect(record.title).toBeNull();
        expect(record.deadline).toBeNull();
    });

    it('an empty form is still a record: no designs, no land, no lines', () => {
        const record = Dialog.recordFromForm({ id: 'ag-2' }, {});
        expect(record).toMatchObject({ id: 'ag-2', designs: [], inputs: { parcels: [], openGroundM2: 0 }, outputs: [], allocations: [], money: { currency: null, lines: [] } });
        expect(record.rule.electorate).toBe('owners');
        expect(record.rule.binding).toBe(false);
    });

    it('keeps the saved view in a plan and creates a new revision when membership changes', () => {
        const view = { at: '45.8,15.96,16', mode: '2d', city: 'zagreb', language: 'hr' };
        const originalContent = PlanRecord.create('Original plan', [LAYOUT_CID], view);
        const originalPlan = { cid: Cid.cidOfObject(originalContent), content: originalContent };
        const state = { ...formState, designs: designs.slice(0, 1), plan: originalPlan, view,
            fingerprints: new Map([['layout', LAYOUT_CID]]) };
        const titled = Dialog.recordFromForm(state, { ...values, planTitle: 'Courtyard plan' });
        expect(titled.plan).toMatchObject({ content: { title: 'Courtyard plan', designCids: [LAYOUT_CID], view } });
        expect(titled.plan.cid).not.toBe(originalPlan.cid);

        const expanded = Dialog.recordFromForm({ ...state, designs: designs.slice(0, 2), plan: titled.plan,
            fingerprints: new Map([['layout', LAYOUT_CID], ['road', ROAD_CID]]) }, { ...values, planTitle: 'Courtyard plan' });
        expect(expanded.plan).toMatchObject({ content: { title: 'Courtyard plan', designCids: [LAYOUT_CID, ROAD_CID].sort(), view } });
        expect(expanded.plan.cid).not.toBe(titled.plan.cid);
        expect(originalPlan.content.designCids).toEqual([LAYOUT_CID]);
    });

    it('keeps the exact plan when only agreement terms or the current map view change', () => {
        const content = PlanRecord.create('Courtyard plan', [LAYOUT_CID], { at: '45.8,15.96,16', mode: '2d' });
        const plan = { cid: Cid.cidOfObject(content), content };
        const state = { ...formState, designs: designs.slice(0, 1), plan,
            view: { at: '52.4,-1.9,18', mode: '3d' }, fingerprints: new Map([['layout', LAYOUT_CID]]) };
        const agreement = Dialog.recordFromForm(state, { ...values, title: 'Different terms', electorate: 'community' });
        expect(agreement.plan).toEqual(plan);
        expect(agreement.title).toBe('Different terms');
    });
});

describe('errors and warnings in words', () => {
    it('words every code by its key, with the engine\'s readiness reason or the validator\'s own words', () => {
        expect(Dialog.issueText({ code: 'no-designs', message: 'x' })).toBe('Choose at least one design.');
        expect(Dialog.issueText({ code: 'rule-not-ready', reason: 'missing-owners' })).toBe('The rule cannot be evaluated yet: No owners are declared for the selected parcels.');
        expect(Dialog.issueText({ code: 'rule-invalid', message: 'Invalid owner/area threshold.' })).toBe('The decision rule is incomplete: Invalid owner/area threshold.');
        expect(Dialog.issueText({ code: 'rule-invalid' })).toBe('The decision rule is incomplete');
        expect(Dialog.issueText({ code: 'open-ground' })).toBe('Part of the land is open ground with no recorded owner.');
        expect(Dialog.issueText({ code: 'something-new', message: 'As the validator says.' })).toBe('As the validator says.');
    });
});

describe('the sections as HTML (the hooks the browser spec targets)', () => {
    it('lists the applied designs as checkboxes, the chosen ones checked, titles escaped', () => {
        const html = Dialog.designsHtml({ designs: [{ proposalId: 'p1', title: '<b>Plots</b>' }, { proposalId: 'p2', title: 'Road' }], selected: new Set(['p2']) });
        expect(html).toContain('<input type="checkbox" data-agreement-design="p1">');
        expect(html).toContain('<input type="checkbox" data-agreement-design="p2" checked>');
        expect(html).toContain('&lt;b&gt;Plots&lt;/b&gt;');
        expect(html).not.toContain('data-agreement-empty');
        expect(Dialog.designsHtml({ designs: [] })).toContain('data-agreement-empty');
        expect(Dialog.designsHtml({ designs: [], missing: ['p9'] })).toContain('data-agreement-designs-missing');
        // The map is the main picker: the hint says so, and the status line under it says what a click did.
        expect(html).toContain('<p class="agreement-hint" data-agreement-map-hint>Click a design on the map to add or remove it</p>');
        expect(html).toMatch(/<p class="agreement-hint agreement-pick-status" data-agreement-pick-status role="status" aria-live="polite"><\/p>$/);
    });

    it('shows the land loading, then the inputs and outputs tables, open ground and the empty case', () => {
        expect(Dialog.landHtml({ loading: true, selectedCount: 1 })).toContain('data-agreement-land-loading');
        expect(Dialog.landHtml({ selectedCount: 0, land })).toContain('Choose at least one design.');
        expect(Dialog.landHtml({ selectedCount: 1, error: 'ground unavailable' })).toContain('data-agreement-land-error');
        const html = Dialog.landHtml({ land, selectedCount: 1 });
        expect(html).toContain('data-agreement-inputs');
        expect(html).toContain('data-agreement-outputs');
        expect(html).toContain('<tr data-agreement-input="335/10">');
        expect(html).toContain('<tr data-agreement-output="piece1-sha256:aa"><th scope="row">Piece 1</th><td class="agreement-table__from" data-label="From">');
        expect(html).toContain('Ana 50%, Ben 50%');
        expect(html).toContain('No recorded owner');
        expect(html).toContain('335/10, 335/2');
        expect(html).not.toContain('data-agreement-open-ground');
        const open = Dialog.landHtml({ land: { inputs: { parcels: [], openGroundM2: 120 }, outputs: [] }, selectedCount: 1 });
        expect(open).toContain('data-agreement-land-empty');
        expect(open).toContain('Open ground: 120 m²');
    });

    it('gives every resulting piece one select, the stored choice selected, an unknown one back to the holders', () => {
        const html = Dialog.allocationHtml(land, { 'piece1-sha256:aa': 'party:agent-ben', 'piece1-sha256:bb': 'party:agent-gone' });
        expect(html.match(/<select data-agreement-allocation=/g)).toHaveLength(2);
        expect(html).toContain('<select data-agreement-allocation="piece1-sha256:aa"><option value="holders">Current holders</option><option value="party:agent-ana">Ana</option><option value="party:agent-ben" selected>Ben</option><option value="public">Public</option></select>');
        expect(html).toContain('<select data-agreement-allocation="piece1-sha256:bb"><option value="holders" selected>');
        expect(Dialog.allocationHtml({ inputs: land.inputs, outputs: [] })).toBe('');
    });

    it('gives every party one cash field, showing what was typed unless it cannot be read', () => {
        const html = Dialog.moneyHtml(land, { 'agent-ana': '-12.5', 'agent-ben': 'invalid' });
        expect(html).toContain('<input type="number" step="0.01" data-agreement-cash="agent-ana" value="-12.5">');
        expect(html).toContain('<input type="number" step="0.01" data-agreement-cash="agent-ben" value="">');
        expect(Dialog.moneyHtml({ inputs: { parcels: [] }, outputs: [] })).toBe('');
    });

    it('offers the two electorates; a community vote has no binding and no owner form', () => {
        const owners = Dialog.ruleHtml({ electorate: 'owners', binding: true });
        expect(owners).toContain('value="owners" data-agreement-electorate checked');
        expect(owners).toContain('<input type="checkbox" data-agreement-binding checked>');
        expect(owners).toContain('<div class="agreement-rule-form" data-agreement-rule-form></div>');
        const community = Dialog.ruleHtml({ electorate: 'community', binding: true });
        expect(community).toContain('value="community" data-agreement-electorate checked');
        expect(community).toContain('<input type="checkbox" data-agreement-binding disabled>');
        expect(community).toContain('data-agreement-rule-form hidden');
    });

    it('shows community consultation fields while hiding settlement terms', () => {
        const html = Dialog.bodyHtml({ designs: [], selected: new Set(), values: { electorate: 'community', organiser: 'did:web:ngo.example', participationUrl: 'https://ngo.example/join' } });
        expect(html).toContain('Ask the community');
        expect(html).toContain('Seek owners’ decisions');
        expect(html).toContain('data-agreement-section="consultation"><h3');
        expect(html).toContain('data-agreement-section="allocation" hidden');
        expect(html).toContain('data-agreement-section="money" hidden');
        expect(html).toContain('data-agreement-organiser value="did:web:ngo.example"');
        expect(html).toContain('data-agreement-participation-url value="https://ngo.example/join"');
        expect(html.indexOf('data-agreement-section="rule"')).toBeLessThan(html.indexOf('data-agreement-section="land"'));
    });

    it('puts the decision and consultation sections before the design and settlement sections, errors and warnings above them', () => {
        const html = Dialog.bodyHtml({ designs: [], selected: new Set(), missing: [], land: null, values: { electorate: 'owners', binding: true, title: 'T', deadline: '' }, today: '2026-10-21' });
        expect([...html.matchAll(/data-agreement-section="([a-z]+)"/g)].map(m => m[1])).toEqual(['rule', 'consultation', 'designs', 'land', 'allocation', 'money', 'details']);
        expect(html.indexOf('data-agreement-errors')).toBeLessThan(html.indexOf('data-agreement-section="designs"'));
        expect(html).toContain('<input type="text" data-agreement-title value="T" autocomplete="off">');
        expect(html).toContain('<input type="date" data-agreement-deadline value="" min="2026-10-21">');
    });
});

// The editor docks over the map through MapPick; in node there is none, so open() stops right there
// (after it has read the agreement it opens): the error says how far it got.
const EDITOR_REACHED = /MapPick \(js\/map-pick\.js\) is not loaded/;
const thrownAsync = async fn => { try { await fn(); } catch (error) { return error; } return null; };

describe('Add to agreement (addDesign)', () => {
    const DESIGN = { proposalId: 'road-1', title: 'New lane', goal: 'road' };
    const PUBLISHED = { cid: 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq', publishedAt: '2026-10-21T12:00:00.000Z', apiBase: 'https://api.example.test', sponsor: null };
    // The agreements this device holds, newest first as AgreementStore.list() gives them.
    const held = () => [
        agreement('ag-new', { title: 'Block eight', createdAt: '2026-10-22T09:00:00.000Z', designs: [{ proposalId: 'layout-2' }], published: null }),
        agreement('ag-proposed', { title: 'Block seven', createdAt: '2026-10-21T09:00:00.000Z', designs: [{ proposalId: 'layout-1' }], published: PUBLISHED }),
        agreement('ag-old', { title: '', createdAt: '2026-10-20T09:00:00.000Z', designs: [{ proposalId: 'road-1' }, { proposalId: 'park-1' }], published: null })
    ];
    function environment(rows, answer) {
        const store = { list: vi.fn(() => rows), get: vi.fn(id => rows.find(row => row.id === id) || null) };
        const dialog = { choice: vi.fn(async () => answer) };
        const message = vi.fn();
        vi.stubGlobal('AgreementStore', store);
        vi.stubGlobal('CbDialog', dialog);
        vi.stubGlobal('AgreementPanel', { titleOf: Panel.titleOf });
        vi.stubGlobal('proposalStorage', { getProposal: id => (id === DESIGN.proposalId ? DESIGN : null) });
        vi.stubGlobal('showEphemeralMessage', message);
        return { store, dialog, message };
    }

    it('opens a new agreement straight away when none is waiting to be proposed', async () => {
        for (const rows of [[], [held()[1]]]) {
            const { store, dialog } = environment(rows, null);
            expect((await thrownAsync(() => Dialog.addDesign('road-1'))).message).toMatch(EDITOR_REACHED);
            expect(dialog.choice).not.toHaveBeenCalled();
            expect(store.get).not.toHaveBeenCalled();
        }
    });

    it('offers a new agreement first, then each one not proposed yet, never a proposed one', async () => {
        const { dialog } = environment(held(), null);
        expect(await Dialog.addDesign(' road-1 ')).toBeNull();
        expect(dialog.choice).toHaveBeenCalledTimes(1);
        const [message, options, settings] = dialog.choice.mock.calls[0];
        expect(message).toBe('Add “New lane” to a new agreement, or to one not proposed yet.');
        expect(options).toEqual([
            { value: '__new__', label: 'New agreement', primary: true },
            { value: 'ag-new', label: 'Block eight · 1 design' },
            { value: 'ag-old', label: `${Panel.titleOf(held()[2])} · 2 designs` }
        ]);
        expect(settings).toEqual({ title: 'Add to agreement', className: 'agreement-add-to' });
    });

    it('opens nothing when the choice is dismissed', async () => {
        const { store } = environment(held(), null);
        expect(await Dialog.addDesign('road-1')).toBeNull();
        expect(store.get).not.toHaveBeenCalled();
    });

    it('opens a new agreement for "New agreement", and the chosen one otherwise', async () => {
        const fresh = environment(held(), '__new__');
        expect((await thrownAsync(() => Dialog.addDesign('road-1'))).message).toMatch(EDITOR_REACHED);
        expect(fresh.store.get).not.toHaveBeenCalled();
        const chosen = environment(held(), 'ag-new');
        expect((await thrownAsync(() => Dialog.addDesign('road-1'))).message).toMatch(EDITOR_REACHED);
        expect(chosen.store.get).toHaveBeenCalledWith('ag-new');
        expect(chosen.message).not.toHaveBeenCalled();
    });

    it('says so when the chosen agreement already holds the design, and opens it as it is', async () => {
        const { store, message } = environment(held(), 'ag-old');
        expect((await thrownAsync(() => Dialog.addDesign('road-1'))).message).toMatch(EDITOR_REACHED);
        expect(message).toHaveBeenCalledWith('“New lane” is already in this agreement.', 4000, 'info');
        expect(store.get).toHaveBeenCalledWith('ag-old');
    });

    it('refuses a choice that is no longer on this device, and a call without a design', async () => {
        environment(held(), 'ag-gone');
        expect((await thrownAsync(() => Dialog.addDesign('road-1'))).message).toBe('Agreement ag-gone is not on this device.');
        await expect(Dialog.addDesign('  ')).rejects.toThrow(TypeError);
    });
});

describe('editing a proposed agreement', () => {
    it('is refused: a proposed agreement is immutable, a change is a new agreement', async () => {
        const proposed = agreement('ag-proposed', { published: { cid: 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq' } });
        const store = { get: vi.fn(id => (id === 'ag-proposed' ? proposed : id === 'ag-draft' ? agreement('ag-draft') : null)) };
        vi.stubGlobal('AgreementStore', store);
        const error = await thrownAsync(() => Dialog.open({ agreementId: 'ag-proposed', designIds: ['road-1'] }));
        expect(error).toMatchObject({ code: 'agreement-published', message: 'A proposed agreement cannot be edited; propose a new one.' });
        expect((await thrownAsync(() => Dialog.open({ agreementId: 'ag-gone' }))).message).toBe('Agreement ag-gone is not on this device.');
        // A draft passes the refusal and goes on to the editor.
        expect((await thrownAsync(() => Dialog.open({ agreementId: 'ag-draft' }))).message).toMatch(EDITOR_REACHED);
    });
});
