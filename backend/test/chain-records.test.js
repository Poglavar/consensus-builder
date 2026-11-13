// The chain watcher's pass (oracle/chain-records.js) with fake chains, IPFS and index: designs are
// imported before plans, indexed CIDs are skipped, unretrievable and refused records are counted,
// a plan with missing members waits, and a dry run imports nothing.
import { describe, expect, it, vi } from 'vitest';
import { cidOfObject } from '../cid.js';
import { buildChainRecordsRunStats, syncChainRecords } from '../oracle/chain-records.js';
import { designParcelSourceId } from '../chain/design-parcel-source.js';

const design = title => { const content = { schema: 'design/v1', title }; return { cid: cidOfObject(content), content }; };
const plan = (title, members) => { const content = { schema: 'plan/v1', title, designCids: members.map(m => m.cid) }; return { cid: cidOfObject(content), content }; };

const A = design('A'), B = design('B'), C = design('C'), GONE = design('never pinned');
const P = plan('Plan of A and B', [A, B]);
const Q = plan('Plan waiting for an unminted design', [A, design('not on chain')]);

function chain(chainId, records) {
    return { chainId, name: `chain ${chainId}`, listRecords: vi.fn(async kind => records.filter(row => row.kind === kind).map(row => ({ cid: row.cid, kind, chainId }))) };
}
const rec = (kind, object) => ({ kind, cid: object.cid });

// consensus.design / consensus.plan as sets; indexing adds to them.
function fakeIndex({ designs = [], plans = [] } = {}) {
    const tables = { 'consensus.design': new Set(designs), 'consensus.plan': new Set(plans) };
    const order = [];
    const pool = { query: vi.fn(async (sql, [cids]) => {
        const table = /FROM (consensus\.\w+)/.exec(sql)[1];
        return { rows: cids.filter(cid => tables[table].has(cid)).map(cid => ({ cid })) };
    }) };
    const indexDesign = vi.fn(async ({ cid }) => {
        order.push(cid);
        if (cid === C.cid) return { refusal: { status: 400, body: { code: 'invalid-footprint', error: 'no ground' } } };
        tables['consensus.design'].add(cid); return { status: 201, row: { cid } };
    });
    const indexPlan = vi.fn(async ({ cid, content }) => {
        order.push(cid);
        if (content.designCids.some(member => !tables['consensus.design'].has(member))) return { refusal: { status: 409, body: { error: 'missing' } } };
        tables['consensus.plan'].add(cid); return { status: 201, row: { cid } };
    });
    return { pool, indexDesign, indexPlan, order, tables };
}

const contents = new Map([A, B, C, P, Q].map(object => [object.cid, object.content]));
const fetchContent = vi.fn(async (cid, schema) => {
    const content = contents.get(cid);
    if (!content) throw Object.assign(new Error(`${cid} could not be read from IPFS`), { code: 'ipfs-unavailable' });
    expect(content.schema).toBe(schema);
    return { cid, content };
});

describe('the parcel source of a watched design', () => {
    it("is its city's configured source, as the browser publishes it, and null for an unconfigured city", () => {
        expect(designParcelSourceId({ city: 'zagreb' })).toBe('oss-wfs');
        expect(designParcelSourceId({ city: 'zg' })).toBe('oss-wfs');
        expect(designParcelSourceId({ city: 'birmingham' })).toBe('gb-hmlr-browser-v1');
        expect(designParcelSourceId({ city: 'nowhere-at-all' })).toBeNull();
        expect(designParcelSourceId({ city: null })).toBeNull();
    });
});

describe('chain records watcher', () => {
    it('imports designs before plans, skips indexed CIDs and counts what it cannot import', async () => {
        // The plan is listed first on the chain; its designs still go in first. A is already indexed;
        // B is on both chains.
        const chains = [
            chain('84532', [rec('plan', P), rec('plan', Q), rec('design', B), rec('design', A), rec('design', C), rec('design', GONE)]),
            chain('11155111', [rec('design', B)])
        ];
        const index = fakeIndex({ designs: [A.cid] });
        const result = await syncChainRecords({ ...index, chains, fetchContent, apply: true });
        expect(index.order).toEqual([B.cid, C.cid, P.cid]);
        expect(result.designs).toMatchObject({ listed: 4, indexed: 1, imported: 1, refused: 1, unretrievable: 1 });
        expect(result.plans).toMatchObject({ listed: 2, indexed: 0, imported: 1, blocked: 1 });
        expect(result.skipped.map(item => [item.kind, item.cid, item.reason])).toEqual([
            ['design', C.cid, 'invalid-footprint'], ['design', GONE.cid, 'ipfs-unavailable'], ['plan', Q.cid, 'members-missing']
        ]);
        expect(result.skipped.find(item => item.cid === Q.cid).missing).toHaveLength(1);
        expect(result.errors).toEqual([]);
        expect(index.tables['consensus.plan'].has(P.cid)).toBe(true);

        // A second pass is a no-op for everything imported.
        index.order.length = 0;
        const again = await syncChainRecords({ ...index, chains, fetchContent, apply: true });
        expect(index.order).toEqual([C.cid]);
        expect(again.designs).toMatchObject({ indexed: 2, imported: 0 });
        expect(again.plans).toMatchObject({ indexed: 1, imported: 0, blocked: 1 });
    });

    it('imports nothing on a dry run, but reports what it would import', async () => {
        const index = fakeIndex();
        const chains = [chain('84532', [rec('design', A), rec('design', B), rec('plan', P)])];
        const result = await syncChainRecords({ ...index, chains, fetchContent, apply: false });
        expect(index.indexDesign).not.toHaveBeenCalled();
        expect(index.indexPlan).not.toHaveBeenCalled();
        // The plan's members would be imported in the same pass, so the plan would be too.
        expect(result.designs).toMatchObject({ wouldImport: 2, imported: 0 });
        expect(result.plans).toMatchObject({ wouldImport: 1, imported: 0, blocked: 0 });
    });

    it('fails the pass when a chain cannot be read, and keeps going with the others', async () => {
        const broken = { chainId: '11155111', name: 'broken', listRecords: vi.fn(async () => { throw new Error('RPC down'); }) };
        const index = fakeIndex();
        const result = await syncChainRecords({ ...index, chains: [broken, chain('84532', [rec('design', B)])], fetchContent, apply: true });
        expect(result.errors).toEqual([{ chainId: '11155111', kind: 'design', error: 'RPC down' }, { chainId: '11155111', kind: 'plan', error: 'RPC down' }]);
        expect(result.designs.imported).toBe(1);
        const stats = buildChainRecordsRunStats({ startedAt: 'a', endedAt: 'b', result, chains: ['84532', '11155111'] });
        expect(stats).toMatchObject({ job: 'consensus-builder-chain-records', verdict: 'failure', counters: { designsImported: 1, errors: 2 } });
        const clean = await syncChainRecords({ ...fakeIndex(), chains: [chain('84532', [rec('design', A)])], fetchContent, apply: true });
        expect(buildChainRecordsRunStats({ result: clean })).toMatchObject({ verdict: 'success', error: null, counters: { designsImported: 1 } });
    });
});
