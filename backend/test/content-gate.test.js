// The pre-mint retrievability gate (frontend/js/content-gate.js): every CID must be served by some
// public gateway with bytes that hash to it; gateways are tried in order, wrong bytes do not count,
// rounds wait between them, and after the last round it throws with what is missing.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { cidOfObject, canonicalBytes, cidOf } from '../cid.js';

const require = createRequire(import.meta.url);
const ContentGate = require('../../frontend/js/content-gate.js');

const plan = { schema: 'plan/v1', title: 'Courtyard' };
const design = { schema: 'design/v1', title: 'Block A' };
const objects = [{ kind: 'plan', cid: cidOfObject(plan) }, { kind: 'design', cid: cidOfObject(design) }];
const bytesOf = new Map([[objects[0].cid, canonicalBytes(plan)], [objects[1].cid, canonicalBytes(design)]]);
const [FIRST, SECOND, THIRD] = ContentGate.IPFS_GATEWAYS;

// serves(url) → which bytes a gateway answers; null is a failure.
function harness(serves) {
    const fetched = [];
    const waits = [];
    return {
        fetched, waits,
        options: { objects, cidOf, fetchBytes: async url => { fetched.push(url); return serves(url, fetched.length); }, wait: async ms => { waits.push(ms); } }
    };
}

describe('waitRetrievable', () => {
    it('passes when a gateway serves every object, trying gateways in order', async () => {
        const h = harness(url => (url.startsWith(SECOND) ? bytesOf.get(url.slice(SECOND.length)) : null));
        const progress = [];
        const result = await ContentGate.waitRetrievable({ ...h.options, onProgress: step => progress.push(step) });
        expect(result.confirmed).toEqual(objects.map(object => ({ ...object, gateway: SECOND })));
        expect(h.fetched).toEqual([FIRST + objects[0].cid, SECOND + objects[0].cid, FIRST + objects[1].cid, SECOND + objects[1].cid]);
        expect(progress).toEqual([{ confirmed: 2, total: 2, round: 1, rounds: ContentGate.DEFAULT_ROUNDS }]);
        expect(h.waits).toEqual([]);
    });

    it('does not count bytes that hash to another CID', async () => {
        const h = harness(() => canonicalBytes({ forged: true }));
        await expect(ContentGate.waitRetrievable({ ...h.options, rounds: 1 })).rejects.toMatchObject({ code: 'content-not-retrievable', missing: objects });
    });

    it('waits between rounds and asks again only for what is still missing', async () => {
        const h = harness((url, n) => {
            const cid = url.slice(url.lastIndexOf('/') + 1);
            return cid === objects[0].cid || n > 6 ? bytesOf.get(cid) : null;
        });
        const result = await ContentGate.waitRetrievable({ ...h.options, rounds: 3, intervalMs: 10 });
        expect(result.rounds).toBe(2);
        expect(h.waits).toEqual([10]);
        expect(h.fetched.filter(url => url.endsWith(objects[0].cid))).toHaveLength(1);
    });

    it('throws after the last round, naming what no gateway serves, with no wait after it', async () => {
        const h = harness(url => (url.endsWith(objects[0].cid) ? bytesOf.get(objects[0].cid) : null));
        await expect(ContentGate.waitRetrievable({ ...h.options, rounds: 2, intervalMs: 5 })).rejects.toMatchObject({
            code: 'content-not-retrievable', missing: [objects[1]], message: expect.stringMatching(/^1 of 2 object\(s\) are not yet served/)
        });
        expect(h.waits).toEqual([5]);
    });

    it('reads a gateway answer as bytes, and any failure as null', async () => {
        const ok = await ContentGate.fetchBytes('https://g/ipfs/x', async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2]).buffer }));
        expect([...ok]).toEqual([1, 2]);
        expect(await ContentGate.fetchBytes('https://g/ipfs/x', async () => ({ ok: false }))).toBeNull();
        expect(await ContentGate.fetchBytes('https://g/ipfs/x', async () => { throw new Error('offline'); })).toBeNull();
    });
});
