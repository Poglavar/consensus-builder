// The proposing bots' parcel-source fetch: one retry on a source's server error, none on a client
// error, and the run fails with the status when the retry fails too. fetch is stubbed.
import { describe, expect, it } from 'vitest';
import { fetchSourceParcels } from '../agents/source-fetch.js';

const reply = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const stub = (...statuses) => {
    const calls = [];
    const fetchImpl = async (url) => { calls.push(url); return reply(statuses[calls.length - 1], { type: 'FeatureCollection', features: [] }); };
    return { fetchImpl, calls };
};
const args = ['https://api.urbangametheory.xyz', 'es-dgc-inspire-cp-wfs', [-3.7, 40.41, -3.69, 40.42]];

describe('fetchSourceParcels', () => {
    it('retries a 5xx once and returns the second answer', async () => {
        const { fetchImpl, calls } = stub(502, 200);
        const logged = [];
        const out = await fetchSourceParcels(...args, { fetchImpl, retryDelayMs: 0, log: m => logged.push(m) });
        expect(out.type).toBe('FeatureCollection');
        expect(calls).toHaveLength(2);
        expect(calls[0]).toBe('https://api.urbangametheory.xyz/parcel-sources/es-dgc-inspire-cp-wfs?bbox=-3.7,40.41,-3.69,40.42');
        expect(logged[0]).toMatch(/HTTP 502; retrying once/);
    });

    it('fails with the status when the retry fails too', async () => {
        const { fetchImpl, calls } = stub(503, 502);
        await expect(fetchSourceParcels(...args, { fetchImpl, retryDelayMs: 0 })).rejects.toThrow(/returned HTTP 502 \(also on retry\)/);
        expect(calls).toHaveLength(2);
    });

    it('does not retry a client error', async () => {
        const { fetchImpl, calls } = stub(404);
        await expect(fetchSourceParcels(...args, { fetchImpl, retryDelayMs: 0 })).rejects.toThrow(/returned HTTP 404$/);
        expect(calls).toHaveLength(1);
    });
});
