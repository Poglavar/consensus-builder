// Durable proposal storage is one row per record plus a manifest. A mutation writes only the rows
// it touched; a whole-store save writes only rows whose projection changed; a legacy envelope is
// migrated into rows once, at load, on the primary tab only; a corrupt row costs itself, not the log.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ParcelMutation } = require('../../frontend/js/proposals/apply/transaction.js');
const formationDepth = require('../../frontend/js/proposals/formation-depth.js');
const planOrder = require('../../frontend/js/proposals/plan-order.js');
const dataSource = readFileSync(new URL('../../frontend/js/proposals/data.js', import.meta.url), 'utf8');

const saved = new Map();
function install(name, value) {
    if (!saved.has(name)) saved.set(name, { existed: Object.prototype.hasOwnProperty.call(globalThis, name), value: globalThis[name] });
    globalThis[name] = value;
}
afterEach(() => {
    for (const [name, prior] of saved) {
        if (prior.existed) globalThis[name] = prior.value; else delete globalThis[name];
    }
    saved.clear();
});

function fakeStorage(seed = {}) {
    const values = new Map(Object.entries(seed));
    const writes = [];
    return {
        values, writes,
        getItem: key => (values.has(key) ? values.get(key) : null),
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: key => values.delete(key),
        forEach: callback => values.forEach((value, key) => callback(value, key)),
        async atomicWrite(change) {
            writes.push({ puts: new Map(change.puts), deletes: [...(change.deletes || [])] });
            (change.deletes || []).forEach(key => values.delete(key));
            (change.puts || new Map()).forEach((value, key) => values.set(key, String(value)));
        }
    };
}

function bootStore(storage, options = {}) {
    install('window', globalThis);
    install('__cbSecondaryTab', options.secondaryTab === true);
    install('__formationDepth', formationDepth);
    install('__planOrder', planOrder);
    install('normalizeParcelIdList', values => Array.from(new Set((values || []).map(String))));
    install('normalizeOwnerAcceptances', value => value || {});
    install('normalizeLensEntries', value => value || []);
    install('normalizeProposalStatusAxes', proposal => proposal);
    install('normalizeProposalGoalKey', value => String(value || '').trim().toLowerCase());
    install('isLocalProposalId', value => /^local-/.test(String(value || '')));
    install('PersistentStorage', storage);
    return (0, eval)(dataSource + '\n;proposalStorage');
}

const record = (id, extra = {}) => ({ proposalId: id, goal: 'buildings', typologyType: 'block', cadastreParcelIds: ['HR-1'], applied: false, title: id, ...extra });
const rowKeys = storage => Array.from(storage.values.keys()).filter(key => key.startsWith('proposal:')).sort();

function run(store, storage, body) {
    return ParcelMutation.run({ kind: 'test' }, body, { proposalStore: store, agentStore: null, storage, fabric: null, runtime: {} });
}

describe('proposal rows: mutations', () => {
    it('writes one row and the manifest for one touched record out of three hundred', async () => {
        const storage = fakeStorage();
        const store = bootStore(storage);
        for (let i = 0; i < 300; i += 1) store.proposals.set(`p${i}`, record(`p${i}`));
        await run(store, storage, async context => {
            context.proposals.getProposal('p7').title = 'edited';
            return true;
        });
        expect(storage.writes).toHaveLength(1);
        expect([...storage.writes[0].puts.keys()].sort()).toEqual(['cadastre_proposals_manifest', 'proposal:p7']);
        expect(storage.writes[0].deletes).toEqual([]);
        expect(JSON.parse(storage.values.get('proposal:p7')).title).toBe('edited');
        expect(storage.writes[0].puts.get('proposal:p7').length).toBeLessThan(500);
    });

    it('writes a delete for a removed record and a row for an added one', async () => {
        const storage = fakeStorage();
        const store = bootStore(storage);
        store.proposals.set('keep', record('keep'));
        store.proposals.set('gone', record('gone'));
        await run(store, storage, async context => {
            context.proposals.proposals.delete('gone');
            context.proposals.proposals.set('new', record('new'));
            context.proposals.nextProposalId = 9;
            return true;
        });
        expect(storage.writes).toHaveLength(1);
        expect(storage.writes[0].deletes).toEqual(['proposal:gone']);
        expect([...storage.writes[0].puts.keys()].sort()).toEqual(['cadastre_proposals_manifest', 'proposal:new']);
        expect(JSON.parse(storage.values.get('cadastre_proposals_manifest'))).toEqual({ manifestVersion: 1, nextProposalId: 9 });
    });

    it('in a read-only tab, writes no shared row: the change stays in memory and is parked', async () => {
        // multi-tab-guard.js marked this tab secondary: its city is open in another tab
        const storage = fakeStorage();
        const store = bootStore(storage);
        store.proposals.set('p1', record('p1'));
        const blocked = vi.fn();
        const runtime = { __cbSecondaryTab: true, __cbReportSecondaryWriteBlocked: blocked };
        await ParcelMutation.run({ kind: 'test' }, async context => {
            context.proposals.getProposal('p1').title = 'edited here';
            return true;
        }, { proposalStore: store, agentStore: null, storage, fabric: null, runtime });
        expect(storage.writes).toEqual([]);
        expect(rowKeys(storage)).toEqual([]);
        expect(store.getProposal('p1').title).toBe('edited here');
        // parked under the recovery key (a store of this tab's own), and the user is told
        expect(JSON.parse(storage.values.get('cadastre_proposals_recovery')).records.map(r => r.title)).toEqual(['edited here']);
        expect(blocked).toHaveBeenCalledOnce();
    });

    it('deletes a legacy envelope still visible during a boot migration', async () => {
        const storage = fakeStorage({ cadastre_proposals: '{"version":2,"nextProposalId":0,"records":[]}' });
        const store = bootStore(storage);
        store.proposals.set('a', record('a'));
        await run(store, storage, async context => { context.proposals.getProposal('a').title = 'x'; return true; });
        expect(storage.writes[0].deletes).toEqual(['cadastre_proposals']);
    });
});

describe('proposal rows: load', () => {
    it('loads from rows, seeds the fragment cache, and writes nothing', () => {
        const storage = fakeStorage({
            cadastre_proposals_manifest: JSON.stringify({ manifestVersion: 1, nextProposalId: 5 }),
            'proposal:a': JSON.stringify(record('a')),
            'proposal:b': JSON.stringify(record('b', { applied: true }))
        });
        const store = bootStore(storage);
        store.load();
        expect(store.getAllProposals().map(p => p.proposalId).sort()).toEqual(['a', 'b']);
        expect(store.getProposal('b').applied).toBe(true);
        expect(store.nextProposalId).toBe(5);
        expect(storage.writes).toHaveLength(0);
        expect(store._persistFragments.get('a')).toBe(storage.values.get('proposal:a'));
    });

    it('skips a corrupt row and keeps the rest', () => {
        const storage = fakeStorage({
            cadastre_proposals_manifest: JSON.stringify({ manifestVersion: 1, nextProposalId: 1 }),
            'proposal:ok': JSON.stringify(record('ok')),
            'proposal:bad': '{not json'
        });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const store = bootStore(storage);
        store.load();
        expect(store.getAllProposals().map(p => p.proposalId)).toEqual(['ok']);
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Rejected invalid stored proposal bad'), expect.any(Error));
        consoleError.mockRestore();
    });

    it('migrates a legacy envelope into rows in exactly one write and deletes the envelope', () => {
        const storage = fakeStorage({
            cadastre_proposals: JSON.stringify({ version: 2, nextProposalId: 3, records: [record('a'), record('b')] })
        });
        const store = bootStore(storage);
        store.load();
        expect(store.getAllProposals().map(p => p.proposalId).sort()).toEqual(['a', 'b']);
        expect(storage.writes).toHaveLength(1);
        expect(storage.writes[0].deletes).toEqual(['cadastre_proposals']);
        expect([...storage.writes[0].puts.keys()].sort()).toEqual(['cadastre_proposals_manifest', 'proposal:a', 'proposal:b']);
        expect(storage.values.has('cadastre_proposals')).toBe(false);
        expect(JSON.parse(storage.values.get('cadastre_proposals_manifest')).nextProposalId).toBe(3);
        // A reload now takes the row path and finds the same log.
        const again = bootStore(storage);
        again.load();
        expect(again.getAllProposals().map(p => p.proposalId).sort()).toEqual(['a', 'b']);
        expect(again.nextProposalId).toBe(3);
    });

    it('does not migrate from a read-only tab', () => {
        const storage = fakeStorage({
            cadastre_proposals: JSON.stringify({ version: 2, nextProposalId: 3, records: [record('a')] })
        });
        const store = bootStore(storage, { secondaryTab: true });
        store.load();
        expect(store.getAllProposals().map(p => p.proposalId)).toEqual(['a']);
        expect(storage.writes).toHaveLength(0);
        expect(storage.values.has('cadastre_proposals')).toBe(true);
    });
});

describe('proposal rows: whole-store save and clear', () => {
    it('_persist writes only rows whose projection changed, deletes orphan rows, and the manifest', () => {
        // Rows written by the store itself, so a reload followed by a save sees them as unchanged.
        const storage = fakeStorage();
        const writer = bootStore(storage);
        ['a', 'b', 'orphan'].forEach(id => writer._indexProposal(record(id)));
        writer.nextProposalId = 2;
        writer._persist();
        expect(rowKeys(storage)).toEqual(['proposal:a', 'proposal:b', 'proposal:orphan']);
        storage.writes.length = 0;

        const store = bootStore(storage);
        store.load();
        store.proposals.delete('orphan');
        store.getProposal('b').title = 'changed';
        store._persist();
        expect(storage.writes).toHaveLength(1);
        expect([...storage.writes[0].puts.keys()].sort()).toEqual(['cadastre_proposals_manifest', 'proposal:b']);
        expect(storage.writes[0].deletes).toEqual(['proposal:orphan']);
        expect(rowKeys(storage)).toEqual(['proposal:a', 'proposal:b']);
    });

    it('clear removes every row, the manifest and the recovery blob in one write', () => {
        const storage = fakeStorage({
            cadastre_proposals_manifest: '{"manifestVersion":1,"nextProposalId":1}',
            'proposal:a': JSON.stringify(record('a')),
            cadastre_proposals_recovery: '{}',
            'parcel_HR-1_owner': 'agent-1'
        });
        const store = bootStore(storage);
        store.load();
        store.clear();
        expect(storage.writes).toHaveLength(1);
        expect(storage.writes[0].deletes.sort()).toEqual(['cadastre_proposals', 'cadastre_proposals_manifest', 'cadastre_proposals_recovery', 'proposal:a']);
        expect(Array.from(storage.values.keys())).toEqual(['parcel_HR-1_owner']);
        expect(store.getAllProposals()).toEqual([]);
    });
});

describe('proposal rows: a record is stored only in its own city', () => {
    // projections.md §10 M8: storage refuses another city's record (CityConfigManager.foreignCityFor);
    // every link and list route catches the refusal and opens the record in its city instead.
    function bootInCity(foreign, current = 'zagreb') {
        const storage = fakeStorage();
        const store = bootStore(storage);
        install('getLifecycleStatus', proposal => proposal.lifecycleStatus || 'Active');
        install('parkProposalForImport', () => {});
        install('CityConfigManager', {
            resolveCityId: city => (['zagreb', 'split', 'paris', 'new_york'].includes(city) ? city : null),
            getCitiesByParcelSource: source => (source === 'oss-wfs' ? [{ id: 'zagreb' }, { id: 'split' }] : []),
            foreignCityFor: city => (foreign.includes(city) ? city : null),
            getCityLabel: id => ({ paris: 'Paris', zagreb: 'Zagreb' })[id] || id,
            getCurrentCityId: () => current
        });
        return { storage, store };
    }

    it('refuses a record of a city with other parcel data, writing nothing', () => {
        const { storage, store } = bootInCity(['paris']);
        let refusal = null;
        try { store.importProposal(record('p1', { city: 'paris' })); } catch (error) { refusal = error; }
        expect(refusal).toMatchObject({ code: 'proposal-in-other-city', cityId: 'paris' });
        expect(refusal.message).toMatch(/Paris/);
        expect(store.getProposal('p1')).toBeFalsy();
        expect(rowKeys(storage)).toEqual([]);
    });

    it('imports its own city\'s records, those of a city on the same cadastre and those naming no city', () => {
        const { store } = bootInCity(['paris']);
        expect(store.importProposal(record('z1', { city: 'zagreb' }))).toBeTruthy();
        expect(store.importProposal(record('s1', { city: 'split' }))).toBeTruthy();
        expect(store.importProposal(record('n1'))).toBeTruthy();
    });

    it('places a record naming no city by its parcels: a Croatian one is not New York\'s', () => {
        const { storage, store } = bootInCity(['zagreb'], 'new_york');
        let refusal = null;
        try { store.importProposal(record('legacy', { city: 'city', cadastreParcelIds: ['HR-335649-100'] })); } catch (error) { refusal = error; }
        expect(refusal).toMatchObject({ code: 'proposal-in-other-city', cityId: 'zagreb' });
        expect(rowKeys(storage)).toEqual([]);
    });
});
