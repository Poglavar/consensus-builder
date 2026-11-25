// Pin on mint (agreements/pin-minted.js): a minted agreement's record, plan and designs are pinned
// from the index's own copies, a CID already pinned is never pinned again (a design two agreements
// share is pinned once), a copy that does not hash to its CID is refused, one failure does not stop
// the rest, and a dry run pins nothing.
import { describe, expect, it } from 'vitest';
import { cidOfObject } from '../cid.js';
import { mintedTree, pinAgreementTrees, pinMintedContent, pinProblem } from '../agreements/pin-minted.js';

const record = content => ({ cid: cidOfObject(content), content });
const designA = record({ schema: 'design/v1', title: 'Courtyard A' });
const designB = record({ schema: 'design/v1', title: 'Courtyard B' });
const designC = record({ schema: 'design/v1', title: 'Tower C' });
const plan1 = record({ schema: 'plan/v1', title: 'Plan one', designCids: [designA.cid, designB.cid] });
const plan2 = record({ schema: 'plan/v1', title: 'Plan two', designCids: [designB.cid, designC.cid] });
const agreement1 = record({ schema: 'agreement/v1', title: 'First', planCid: plan1.cid });
const agreement2 = record({ schema: 'agreement/v1', title: 'Second', planCid: plan2.cid });

function memoryStore({ plans = [plan1, plan2], designs = [designA, designB, designC], pinned = [], minted = [agreement1, agreement2] } = {}) {
    const pins = new Map(pinned.map(cid => [cid, { cid, kind: 'design', pinnedAt: '2026-11-01T00:00:00.000Z' }]));
    const pick = (rows, cids) => rows.filter(row => cids.includes(row.cid));
    return {
        pins,
        mintedAgreements: async () => minted,
        agreement: async cid => minted.find(row => row.cid === cid) || null,
        plans: async cids => pick(plans, cids),
        designs: async cids => pick(designs, cids),
        pinnedCids: async cids => new Set(cids.filter(cid => pins.has(cid))),
        recordPin: async row => { if (!pins.has(row.cid)) pins.set(row.cid, row); }
    };
}

function provider({ failOn = [] } = {}) {
    const calls = [];
    return {
        calls,
        pinBytes: async ({ bytes, cid, name }) => {
            calls.push({ cid, name, bytes: bytes.length });
            if (failOn.includes(cid)) throw new Error('provider refused');
            return { cid, pinnedAt: '2026-11-25T10:00:00.000Z' };
        }
    };
}

describe('pin on mint', () => {
    it('collects an agreement, its plan and the plan\'s designs, each CID once across agreements', async () => {
        const { objects, missing } = await mintedTree(memoryStore(), [agreement1, agreement2]);
        expect(objects.map(object => [object.kind, object.cid])).toEqual([
            ['agreement', agreement1.cid], ['agreement', agreement2.cid],
            ['plan', plan1.cid], ['plan', plan2.cid],
            ['design', designA.cid], ['design', designB.cid], ['design', designC.cid]
        ]);
        expect(missing).toEqual([]);
    });

    it('pins the whole tree once, the shared design once, and records each pin', async () => {
        const store = memoryStore();
        const p = provider();
        const result = await pinAgreementTrees({ store, agreements: [agreement1, agreement2], apply: true, pinBytes: p.pinBytes });
        expect(p.calls.map(call => call.cid).sort()).toEqual([agreement1, agreement2, plan1, plan2, designA, designB, designC].map(r => r.cid).sort());
        expect(p.calls.filter(call => call.cid === designB.cid)).toHaveLength(1);
        expect(p.calls.find(call => call.cid === designA.cid).name).toBe(`design-${designA.cid}`);
        expect(result).toMatchObject({ referenced: 7, alreadyPinned: 0, failed: [], missing: [] });
        expect(result.pinned).toHaveLength(7);
        expect(store.pins.get(plan2.cid)).toEqual({ cid: plan2.cid, kind: 'plan', pinnedAt: '2026-11-25T10:00:00.000Z' });
    });

    it('a second agreement on already pinned content pins only what is new', async () => {
        const store = memoryStore();
        const p = provider();
        await pinAgreementTrees({ store, agreements: [agreement1], apply: true, pinBytes: p.pinBytes });
        p.calls.length = 0;
        const result = await pinAgreementTrees({ store, agreements: [agreement2], apply: true, pinBytes: p.pinBytes });
        expect(p.calls.map(call => call.cid).sort()).toEqual([agreement2.cid, plan2.cid, designC.cid].sort());
        expect(result.alreadyPinned).toBe(1);
    });

    it('refuses an index copy that does not hash to its CID, and carries on with the rest', async () => {
        const tampered = { cid: designA.cid, content: { ...designA.content, title: 'Changed' } };
        const store = memoryStore({ designs: [tampered, designB, designC] });
        const p = provider({ failOn: [plan1.cid] });
        const result = await pinAgreementTrees({ store, agreements: [agreement1], apply: true, pinBytes: p.pinBytes });
        expect(p.calls.map(call => call.cid)).not.toContain(designA.cid);
        expect(result.failed.map(item => [item.kind, item.cid])).toEqual([['plan', plan1.cid], ['design', designA.cid]]);
        expect(result.failed[1].error).toMatch(/hashes to/);
        expect(result.pinned.map(item => item.cid).sort()).toEqual([agreement1.cid, designB.cid].sort());
        expect(store.pins.has(plan1.cid)).toBe(false);
        expect(pinProblem(result)).toMatch(/^2 object\(s\) could not be pinned/);
    });

    it('reports referenced objects the index does not hold', async () => {
        const result = await pinAgreementTrees({ store: memoryStore({ designs: [designA] }), agreements: [agreement1], apply: true, pinBytes: provider().pinBytes });
        expect(result.missing).toEqual([{ kind: 'design', cid: designB.cid }]);
        expect(pinProblem(result)).toBe('1 referenced object(s) are not in the index');
    });

    it('a dry run pins and records nothing', async () => {
        const store = memoryStore({ pinned: [designA.cid] });
        const p = provider();
        const lines = [];
        const result = await pinMintedContent({ store, cluster: 'devnet', pinBytes: p.pinBytes, log: line => lines.push(line) });
        expect(p.calls).toEqual([]);
        expect(store.pins.size).toBe(1);
        expect(result).toMatchObject({ agreements: 2, referenced: 7, alreadyPinned: 1, pinned: [] });
        expect(result.wouldPin).toHaveLength(6);
        expect(lines.at(-1)).toBe('pin pass: 2 minted agreement(s) reference 7 object(s) · already pinned 1 · would pin 6 (dry run) · failed 0 · missing from index 0');
        expect(pinProblem(result)).toBeNull();
    });
});
