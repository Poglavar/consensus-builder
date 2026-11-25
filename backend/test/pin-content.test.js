// Content before the mint (agreements/pin-content.js, POST /agreements/:cid/pin): an agreement's
// record, plan and designs are pinned from the index's own copies, a CID already pinned is never pinned
// again (a design two agreements share is pinned once), a copy that does not hash to its CID is
// refused, and one failure does not stop the rest.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createMockPool } from './helpers/mock-pool.js';
import { createContentApp } from './helpers/create-app.js';
import { cidOfObject } from '../cid.js';
import { mintedTree, pinAgreementTrees } from '../agreements/pin-content.js';

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

describe('pinning an agreement\'s content', () => {
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
        const result = await pinAgreementTrees({ store, agreements: [agreement1, agreement2], pinBytes: p.pinBytes });
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
        await pinAgreementTrees({ store, agreements: [agreement1], pinBytes: p.pinBytes });
        p.calls.length = 0;
        const result = await pinAgreementTrees({ store, agreements: [agreement2], pinBytes: p.pinBytes });
        expect(p.calls.map(call => call.cid).sort()).toEqual([agreement2.cid, plan2.cid, designC.cid].sort());
        expect(result.alreadyPinned).toBe(1);
    });

    it('refuses an index copy that does not hash to its CID, and carries on with the rest', async () => {
        const tampered = { cid: designA.cid, content: { ...designA.content, title: 'Changed' } };
        const store = memoryStore({ designs: [tampered, designB, designC] });
        const p = provider({ failOn: [plan1.cid] });
        const result = await pinAgreementTrees({ store, agreements: [agreement1], pinBytes: p.pinBytes });
        expect(p.calls.map(call => call.cid)).not.toContain(designA.cid);
        expect(result.failed.map(item => [item.kind, item.cid])).toEqual([['plan', plan1.cid], ['design', designA.cid]]);
        expect(result.failed[1].error).toMatch(/hashes to/);
        expect(result.pinned.map(item => item.cid).sort()).toEqual([agreement1.cid, designB.cid].sort());
        expect(store.pins.has(plan1.cid)).toBe(false);
    });

    it('reports referenced objects the index does not hold', async () => {
        const result = await pinAgreementTrees({ store: memoryStore({ designs: [designA] }), agreements: [agreement1], pinBytes: provider().pinBytes });
        expect(result.missing).toEqual([{ kind: 'design', cid: designB.cid }]);
    });
});

describe('POST /agreements/:cid/pin', () => {
    const binding = record({ schema: 'agreement/v1', title: 'Binding', planCid: plan1.cid, rule: { binding: true } });
    const poll = record({ schema: 'agreement/v1', title: 'Poll', planCid: plan1.cid, rule: { binding: false } });

    function appWith({ designs = [designA, designB], pinned = [], failOn = [] } = {}) {
        const pool = createMockPool();
        const tables = { agreement: [binding, poll], plan: [plan1], design: designs };
        const pins = new Set(pinned);
        pool.answer(/FROM consensus\.(agreement|plan|design) WHERE cid = ANY/, (sql, params) => {
            const table = /consensus\.(agreement|plan|design)/.exec(sql)[1];
            return { rows: tables[table].filter(row => params[0].includes(row.cid)) };
        });
        pool.answer(/FROM consensus\.ipfs_pin/, (sql, params) => ({ rows: params[0].filter(cid => pins.has(cid)).map(cid => ({ cid })) }));
        pool.answer(/INSERT INTO consensus\.ipfs_pin/, (sql, params) => { pins.add(params[0]); return { rows: [], rowCount: 1 }; });
        const p = provider({ failOn });
        const app = createContentApp(pool, { thumbnailQueue: { enqueue: vi.fn() }, baseUrl: 'https://api.example', pinBytes: p.pinBytes });
        return { app, pins, calls: p.calls };
    }
    const post = (app, cid) => request(app).post(`/agreements/${cid}/pin`).send({});

    beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); });

    it('pins the agreement, its plan and designs, and answers the objects a mint must find on a gateway', async () => {
        const { app, pins } = appWith({ pinned: [designA.cid] });
        const res = await post(app, binding.cid);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ objects: [
            { kind: 'agreement', cid: binding.cid }, { kind: 'plan', cid: plan1.cid }, { kind: 'design', cid: designA.cid }, { kind: 'design', cid: designB.cid }
        ], pinned: 3, alreadyPinned: 1 });
        expect([...pins].sort()).toEqual([binding.cid, plan1.cid, designA.cid, designB.cid].sort());
    });

    it('refuses a poll, an unknown agreement, missing content and a failed pin', async () => {
        expect((await post(appWith().app, poll.cid)).body.code).toBe('not-binding');
        expect((await post(appWith().app, designC.cid)).status).toBe(404);
        const missing = await post(appWith({ designs: [designA] }).app, binding.cid);
        expect(missing.status).toBe(409);
        expect(missing.body).toMatchObject({ code: 'content-missing', missing: [{ kind: 'design', cid: designB.cid }] });
        const failed = await post(appWith({ failOn: [plan1.cid] }).app, binding.cid);
        expect(failed.status).toBe(502);
        expect(failed.body).toMatchObject({ code: 'pin-failed', failed: [{ kind: 'plan', cid: plan1.cid }] });
    });
});
