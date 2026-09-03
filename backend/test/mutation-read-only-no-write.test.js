// A mutation that only reads the proposal log must not persist it. Inside a mutation the draft store
// is copy-on-read: getAllProposals() clones and marks every record touched, so a body that merely
// listed proposals re-serialized all of them and wrote the whole envelope. peekAllProposals() hands
// out the shared records for read-only listing, and an untouched draft serializes to nothing.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ParcelMutation } = require('../../frontend/js/proposals/apply/transaction.js');
const formationDepth = require('../../frontend/js/proposals/formation-depth.js');
const planOrder = require('../../frontend/js/proposals/plan-order.js');
const dataSource = readFileSync(new URL('../../frontend/js/proposals/data.js', import.meta.url), 'utf8');

const saved = new Map();
function install(name, value) {
    if (!saved.has(name)) {
        saved.set(name, { existed: Object.prototype.hasOwnProperty.call(globalThis, name), value: globalThis[name] });
    }
    globalThis[name] = value;
}

afterEach(() => {
    for (const [name, prior] of saved) {
        if (prior.existed) globalThis[name] = prior.value;
        else delete globalThis[name];
    }
    saved.clear();
});

function bootStore() {
    install('window', globalThis);
    install('__cbSecondaryTab', false);
    install('__formationDepth', formationDepth);
    install('__planOrder', planOrder);
    install('normalizeParcelIdList', values => Array.from(new Set((values || []).map(String))));
    install('normalizeOwnerAcceptances', value => value || {});
    install('normalizeLensEntries', value => value || []);
    install('normalizeProposalStatusAxes', proposal => proposal);
    install('normalizeProposalGoalKey', value => String(value || '').trim().toLowerCase());
    install('isLocalProposalId', value => /^local-/.test(String(value || '')));
    install('PersistentStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    const api = (0, eval)(dataSource + '\n;({ proposalStorage })');
    const store = api.proposalStorage;
    store.proposals.set('p1', { proposalId: 'p1', goal: 'buildings', typologyType: 'block', cadastreParcelIds: ['HR-1'], applied: false, title: 'one' });
    store.proposals.set('p2', { proposalId: 'p2', goal: 'buildings', typologyType: 'block', cadastreParcelIds: ['HR-2'], applied: false, title: 'two' });
    return store;
}

function memoryStorage() {
    const values = new Map();
    const writes = [];
    return {
        writes,
        getItem: key => values.get(String(key)) ?? null,
        forEach: callback => values.forEach((value, key) => callback(value, key)),
        async atomicWrite(change) {
            writes.push({ puts: new Map(change.puts), deletes: [...change.deletes] });
            change.deletes.forEach(key => values.delete(key));
            change.puts.forEach((value, key) => values.set(key, value));
        }
    };
}

function run(store, storage, body) {
    return ParcelMutation.run({ kind: 'test' }, body, {
        proposalStore: store, agentStore: null, storage, fabric: null, runtime: {}
    });
}

describe('read-only mutations do not persist the proposal log', () => {
    it('a body that only peeks at the log opens no durable write and sees the committed records', async () => {
        const store = bootStore();
        const storage = memoryStorage();
        const committed = store.proposals.get('p1');
        let seen = null;
        await run(store, storage, async context => {
            seen = context.proposals.peekAllProposals();
            return true;
        });
        expect(seen.map(record => record.proposalId)).toEqual(['p1', 'p2']);
        expect(seen[0]).toBe(committed);
        expect(storage.writes).toHaveLength(0);
        expect(store.proposals.get('p1').title).toBe('one');
    });

    it('an edit through getAllProposals is still persisted and published', async () => {
        const store = bootStore();
        const storage = memoryStorage();
        await run(store, storage, async context => {
            const [record] = context.proposals.getAllProposals();
            record.title = 'edited';
            return true;
        });
        expect(storage.writes).toHaveLength(1);
        // getAllProposals clones and marks every record it lists, so the untouched p2 is written
        // too: that over-approximation is exactly why read-only callers must peek instead.
        expect([...storage.writes[0].puts.keys()].sort()).toEqual(['cadastre_proposals_manifest', 'proposal:p1', 'proposal:p2']);
        expect(JSON.parse(storage.writes[0].puts.get('proposal:p1')).title).toBe('edited');
        expect(store.proposals.get('p1').title).toBe('edited');
    });

    it('an edit that then throws leaves the committed record and storage untouched', async () => {
        const store = bootStore();
        const storage = memoryStorage();
        await expect(run(store, storage, async context => {
            const [record] = context.proposals.getAllProposals();
            record.title = 'edited';
            throw new Error('abort');
        })).rejects.toThrow('abort');
        expect(storage.writes).toHaveLength(0);
        expect(store.proposals.get('p1').title).toBe('one');
    });

    it('a changed next id alone is a durable change', async () => {
        const store = bootStore();
        const storage = memoryStorage();
        await run(store, storage, async context => {
            context.proposals.nextProposalId += 1;
            return true;
        });
        expect(storage.writes).toHaveLength(1);
        expect([...storage.writes[0].puts.keys()]).toEqual(['cadastre_proposals_manifest']);
        expect(JSON.parse(storage.writes[0].puts.get('cadastre_proposals_manifest')).nextProposalId).toBe(1);
    });
});
