// The proposing bots' parcel-source fetch: bounded retries on a source's server error, none on a client
// error, and the run fails with the status when the retry fails too. fetch is stubbed.
import { describe, expect, it } from 'vitest';
import { fetchSourceParcels } from '../agents/source-fetch.js';

const reply = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const stub = (...statuses) => {
    const calls = [];
    const fetchImpl = async (url) => { calls.push(url); return reply(statuses[calls.length - 1], { type: 'FeatureCollection', features: [], complete: true }); };
    return { fetchImpl, calls };
};
const args = ['https://api.urbangametheory.xyz', 'es-dgc-inspire-cp-wfs', [-3.7, 40.41, -3.69, 40.42]];

describe('fetchSourceParcels', () => {
    it('retries a 5xx and returns the second answer', async () => {
        const { fetchImpl, calls } = stub(502, 200);
        const logged = [];
        const out = await fetchSourceParcels(...args, { fetchImpl, retryDelaysMs: [0, 0], log: m => logged.push(m) });
        expect(out.type).toBe('FeatureCollection');
        expect(calls).toHaveLength(2);
        expect(calls[0]).toBe('https://api.urbangametheory.xyz/parcel-sources/es-dgc-inspire-cp-wfs?bbox=-3.7,40.41,-3.69,40.42');
        expect(logged[0]).toMatch(/attempt 1\/3: HTTP 502; retrying/);
    });

    it('fails with the status when all three attempts fail', async () => {
        const { fetchImpl, calls } = stub(503, 502, 504);
        await expect(fetchSourceParcels(...args, { fetchImpl, retryDelaysMs: [0, 0] })).rejects.toThrow(/attempt 3\/3: HTTP 504/);
        expect(calls).toHaveLength(3);
    });

    it('does not retry a client error', async () => {
        const { fetchImpl, calls } = stub(404);
        await expect(fetchSourceParcels(...args, { fetchImpl, retryDelaysMs: [0, 0] })).rejects.toThrow(/HTTP 404$/);
        expect(calls).toHaveLength(1);
    });
});
