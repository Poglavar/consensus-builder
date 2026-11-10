// Unit tests for frontend/js/chain/ipfs-courier.js (docs/blockchain-flows.md, Flow 2): the courier
// order (server, own Pinata key, nothing) and the retrievability gate that waits, visibly, until a
// public gateway serves bytes hashing to the CID.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Cid = require('../../frontend/js/cid.js');
const IpfsCourier = require('../../frontend/js/chain/ipfs-courier.js');

const PLAN = { schema: 'plan/v1', title: 'Riverside', designCids: [], view: { city: 'zagreb' } };
const BYTES = Cid.canonicalBytes(PLAN);
const CID = Cid.cidOf(BYTES);
const GATEWAY = 'https://gw.example/ipfs/';
const API = 'https://api.example';

// One fetch for everything the courier talks to: the gateway (serving after `servesAfter` probes),
// the server's /pins and Pinata, each answering as `answers` says.
function world({ servesAfter = Infinity, server = null, pinata = null } = {}) {
    const asked = [];
    let probes = 0;
    const fetchImpl = async (url, init = {}) => {
        asked.push(url);
        if (url.startsWith(GATEWAY)) {
            probes += 1;
            return probes > servesAfter ? { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(BYTES).buffer } : { ok: false, status: 404 };
        }
        if (url === `${API}/pins`) {
            if (!server) throw new Error('connection refused');
            expect(JSON.parse(init.body)).toEqual({ kind: 'plan', cid: CID, bytes: Buffer.from(BYTES).toString('base64') });
            return { ok: server.ok, status: server.status, json: async () => server.body };
        }
        if (url.startsWith('https://api.pinata.cloud/')) {
            expect(init.headers.Authorization).toBe('Bearer jwt-1');
            return { ok: pinata.ok, status: pinata.status, json: async () => pinata.body };
        }
        throw new Error(`unexpected ${url}`);
    };
    return { asked, fetchImpl };
}
const gate = (fetchImpl, delays = [1, 1]) => ({ fetchImpl, gateways: [GATEWAY], delays, wait: async () => {} });
const quiet = () => [vi.spyOn(console, 'warn').mockImplementation(() => {}), vi.spyOn(console, 'info').mockImplementation(() => {})];

describe('IpfsCourier', () => {
    it('counts every probe of the gate and stops when a gateway serves the bytes', async () => {
        const { fetchImpl } = world({ servesAfter: 2 });
        const spies = quiet();
        const attempts = [];
        const opened = await IpfsCourier.retrievable(CID, { ...gate(fetchImpl, [1, 1, 1]), onAttempt: attempts.push.bind(attempts) });
        spies.forEach(spy => spy.mockRestore());
        expect(opened).toEqual({ retrievable: true, gateway: GATEWAY, attempts: 3 });
        expect(attempts).toEqual([{ attempt: 1, total: 4 }, { attempt: 2, total: 4 }, { attempt: 3, total: 4 }]);
        const closed = await IpfsCourier.retrievable(CID, gate(world().fetchImpl, [1]));
        expect(closed).toEqual({ retrievable: false, gateway: null, attempts: 2 });
    });

    it('delivers nothing when the bytes are already served', async () => {
        const { asked, fetchImpl } = world({ servesAfter: 0 });
        expect(await IpfsCourier.deliver({ kind: 'plan', cid: CID, bytes: BYTES, apiBase: API, gate: gate(fetchImpl) })).toEqual({ via: 'already', gateway: GATEWAY });
        expect(asked).toEqual([GATEWAY + CID]);
    });

    it('pins through the server first and then waits for the gate', async () => {
        const { asked, fetchImpl } = world({ servesAfter: 2, server: { ok: true, status: 200, body: { cid: CID, pinnedAt: 'now' } } });
        const spies = quiet();
        const phases = [];
        const delivered = await IpfsCourier.deliver({ kind: 'plan', cid: CID, bytes: BYTES, apiBase: API, pinataJwt: 'jwt-1', gate: gate(fetchImpl), onStatus: phases.push.bind(phases) });
        spies.forEach(spy => spy.mockRestore());
        expect(delivered).toEqual({ via: 'server', gateway: GATEWAY });
        expect(asked.filter(url => url.includes('pinata'))).toEqual([]);
        expect(phases).toEqual([{ phase: 'checking' }, { phase: 'pinning', courier: 'server' },
            { phase: 'waiting', courier: 'server', attempt: 1, total: 3 }, { phase: 'waiting', courier: 'server', attempt: 2, total: 3 }]);
    });

    it('falls back to the own Pinata key when the server refuses, and refuses a Pinata CID that is not ours', async () => {
        const refused = { ok: false, status: 503, body: { code: 'pinning-unconfigured', error: 'Pinning is not configured on this server.' } };
        const good = world({ servesAfter: 1, server: refused, pinata: { ok: true, status: 200, body: { IpfsHash: CID, Timestamp: 'now' } } });
        const spies = quiet();
        expect(await IpfsCourier.deliver({ kind: 'plan', cid: CID, bytes: BYTES, apiBase: API, pinataJwt: 'jwt-1', gate: gate(good.fetchImpl) })).toEqual({ via: 'pinata', gateway: GATEWAY });
        const forged = world({ servesAfter: 1, server: refused, pinata: { ok: true, status: 200, body: { IpfsHash: 'bafyother' } } });
        const error = await IpfsCourier.deliver({ kind: 'plan', cid: CID, bytes: BYTES, apiBase: API, pinataJwt: 'jwt-1', gate: gate(forged.fetchImpl) }).catch(e => e);
        spies.forEach(spy => spy.mockRestore());
        expect(error.code).toBe('no-courier');
        expect(error.serverError.code).toBe('pinning-unconfigured');
        expect(error.pinataError.code).toBe('cid-mismatch');
    });

    it('reports a pin nobody serves, and asks no courier for a non-CID', async () => {
        const { fetchImpl } = world({ server: { ok: true, status: 200, body: { cid: CID } } });
        const spies = quiet();
        const error = await IpfsCourier.deliver({ kind: 'plan', cid: CID, bytes: BYTES, apiBase: API, gate: gate(fetchImpl, [1]) }).catch(e => e);
        spies.forEach(spy => spy.mockRestore());
        expect(error).toMatchObject({ code: 'not-retrievable', via: 'server' });
        await expect(IpfsCourier.deliver({ kind: 'plan', cid: 'nope', bytes: BYTES, apiBase: API, gate: gate(fetchImpl) })).rejects.toMatchObject({ code: 'invalid-cid' });
    });
});
