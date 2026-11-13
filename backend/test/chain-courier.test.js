// The server's IPFS courier (chain/courier.js): an object already on a public gateway is not pinned;
// otherwise it is pinned and the gate waits, a bounded number of logged attempts, until a gateway
// serves bytes hashing to the CID. No network: fetch, pin and wait are injected.
import { describe, expect, it, vi } from 'vitest';
import { canonicalBytes, cidOf } from '../cid.js';
import { ensureRetrievable } from '../chain/courier.js';

const content = { schema: 'design/v1', title: 'A courier test' };
const bytes = canonicalBytes(content);
const cid = cidOf(bytes);
const GATEWAYS = ['https://gw.example.test/ipfs/'];

// A gateway that serves the bytes from the `servedFrom`-th request on (Infinity: never), and 404 before.
function gateway(servedFrom, served = bytes) {
    let requests = 0;
    const fetchImpl = vi.fn(async () => {
        requests += 1;
        return requests >= servedFrom ? new Response(served, { status: 200 }) : new Response('not found', { status: 404 });
    });
    return fetchImpl;
}

describe('IPFS courier', () => {
    it('pins nothing when a public gateway already serves the bytes', async () => {
        const pin = vi.fn(), wait = vi.fn(async () => {}), lines = [];
        const result = await ensureRetrievable({ kind: 'design', cid, bytes, fetchImpl: gateway(1), gateways: GATEWAYS, pin, wait, log: line => lines.push(line) });
        expect(result).toEqual({ cid, via: 'already', gateway: GATEWAYS[0], attempts: 1, pinnedAt: null });
        expect(pin).not.toHaveBeenCalled();
        expect(wait).not.toHaveBeenCalled();
        expect(lines.some(line => /already served/.test(line))).toBe(true);
    });

    it('pins, then waits with visible attempts until a gateway serves the CID', async () => {
        const pin = vi.fn(async () => ({ cid, pinnedAt: '2026-11-13T10:00:00.000Z' }));
        const wait = vi.fn(async () => {}), lines = [];
        const result = await ensureRetrievable({ kind: 'plan', cid, bytes, fetchImpl: gateway(4), gateways: GATEWAYS, pin, wait, delays: [1, 2, 3, 4], log: line => lines.push(line) });
        expect(pin).toHaveBeenCalledWith({ bytes, name: `plan-${cid}`, cid });
        // Request 1 is the check before pinning; requests 2 and 3 miss, 4 is served.
        expect(result).toEqual({ cid, via: 'pinned', gateway: GATEWAYS[0], attempts: 3, pinnedAt: '2026-11-13T10:00:00.000Z' });
        expect(wait.mock.calls.map(call => call[0])).toEqual([1, 2]);
        expect(lines.filter(line => /attempt \d\/5/.test(line))).toHaveLength(3);
    });

    it('gives up after the bounded attempts with not-retrievable', async () => {
        const wait = vi.fn(async () => {});
        await expect(ensureRetrievable({ kind: 'design', cid, bytes, fetchImpl: gateway(Infinity), gateways: GATEWAYS,
            pin: async () => ({ cid }), wait, delays: [1, 1], log: () => {} })).rejects.toMatchObject({ code: 'not-retrievable', cid });
        expect(wait).toHaveBeenCalledTimes(2);
    });

    it('never counts a gateway answering other bytes as retrievable', async () => {
        await expect(ensureRetrievable({ kind: 'design', cid, bytes, fetchImpl: gateway(1, canonicalBytes({ schema: 'design/v1', title: 'Other' })),
            gateways: GATEWAYS, pin: async () => ({ cid }), wait: async () => {}, delays: [], log: () => {} })).rejects.toMatchObject({ code: 'not-retrievable' });
    });

    it('refuses bytes of another CID and carries the pinning error code', async () => {
        const pin = vi.fn();
        await expect(ensureRetrievable({ kind: 'design', cid, bytes: canonicalBytes({ schema: 'design/v1' }), fetchImpl: gateway(1), gateways: GATEWAYS, pin, log: () => {} }))
            .rejects.toMatchObject({ code: 'cid-mismatch' });
        await expect(ensureRetrievable({ kind: 'parcel', cid, bytes, fetchImpl: gateway(1), gateways: GATEWAYS, pin, log: () => {} }))
            .rejects.toMatchObject({ code: 'invalid-kind' });
        expect(pin).not.toHaveBeenCalled();
        const unconfigured = async () => { throw Object.assign(new Error('Unknown IPFS_PINNING_PROVIDER'), { code: 'pinning-unconfigured' }); };
        await expect(ensureRetrievable({ kind: 'design', cid, bytes, fetchImpl: gateway(Infinity), gateways: GATEWAYS, pin: unconfigured, wait: async () => {}, log: () => {} }))
            .rejects.toMatchObject({ code: 'pinning-unconfigured' });
    });
});
