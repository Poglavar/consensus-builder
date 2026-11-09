// Unit tests for the From chain reads (docs/blockchain-flows.md, Flow 1): frontend/js/chain/ipfs-read.js
// fetching an object by CID from gateways in order and accepting only bytes that hash to it, and
// frontend/js/chain/chain-reader.js's fallback from the server to those reads.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Cid = require('../../frontend/js/cid.js');
const IpfsRead = require('../../frontend/js/chain/ipfs-read.js');
const { withFallback } = require('../../frontend/js/chain/chain-reader.js');

const PLAN = { schema: 'plan/v1', title: 'Riverside', designCids: [], view: { city: 'zagreb' } };
const BYTES = Cid.canonicalBytes(PLAN);
const CID = Cid.cidOf(BYTES);
const OTHER = Cid.canonicalBytes({ ...PLAN, title: 'Forged' });
const A = 'https://a.example/ipfs/', B = 'https://b.example/ipfs/', C = 'https://c.example/ipfs/';

// A fetch whose answer per gateway is bytes, an HTTP status, or a thrown error.
function gatewaysAnswering(answers) {
    const asked = [];
    const fetchImpl = async url => {
        asked.push(url);
        const answer = answers[url.slice(0, url.lastIndexOf('/') + 1)];
        if (answer instanceof Error) throw answer;
        if (typeof answer === 'number') return { ok: false, status: answer };
        return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(answer).buffer };
    };
    return { asked, fetchImpl };
}
const thrown = async fn => { try { await fn(); } catch (error) { return error; } return null; };

describe('IpfsRead', () => {
    it('takes the first gateway whose bytes hash to the CID, after refusals, timeouts and forgeries', async () => {
        const { asked, fetchImpl } = gatewaysAnswering({ [A]: 429, [B]: OTHER, [C]: BYTES });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const read = await IpfsRead.fetchObject(CID, { gateways: [A, B, C], fetchImpl, schema: 'plan/v1' });
        warn.mockRestore();
        expect(read).toEqual({ cid: CID, content: PLAN, gateway: C });
        expect(asked).toEqual([A + CID, B + CID, C + CID]);
    });

    it('fails with every attempt named when no gateway has the bytes, and asks none for a non-CID', async () => {
        const { fetchImpl } = gatewaysAnswering({ [A]: new Error('timeout'), [B]: OTHER });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const error = await thrown(() => IpfsRead.fetchBytes(CID, { gateways: [A, B], fetchImpl }));
        warn.mockRestore();
        expect(error.code).toBe('ipfs-unavailable');
        expect(error.attempts).toEqual([{ gateway: A, error: 'timeout' }, { gateway: B, error: 'cid-mismatch', computed: Cid.cidOf(OTHER) }]);
        const { asked, fetchImpl: never } = gatewaysAnswering({});
        expect((await thrown(() => IpfsRead.fetchBytes('not-a-cid', { gateways: [A], fetchImpl: never }))).code).toBe('invalid-cid');
        expect(asked).toEqual([]);
    });

    it('refuses verified bytes of another schema, and reads several objects without one failure failing the rest', async () => {
        const { fetchImpl } = gatewaysAnswering({ [A]: BYTES });
        expect((await thrown(() => IpfsRead.fetchObject(CID, { gateways: [A], fetchImpl, schema: 'design/v1' }))).code).toBe('invalid-object');
        const missingCid = Cid.cidOf(OTHER);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const both = await IpfsRead.fetchObjects([CID, missingCid, CID], { gateways: [A], fetchImpl: async url => (url.endsWith(CID)
            ? { ok: true, arrayBuffer: async () => Uint8Array.from(BYTES).buffer } : { ok: false, status: 404 }) });
        warn.mockRestore();
        expect([...both.rows.keys()]).toEqual([CID]);
        expect(both.missing.map(entry => entry.cid)).toEqual([missingCid]);
    });

    it('uses the configured gateways, each ending in one slash', () => {
        expect(IpfsRead.gateways(['https://x.example/ipfs', 'https://y.example/ipfs//'])).toEqual(['https://x.example/ipfs/', 'https://y.example/ipfs/']);
        expect(IpfsRead.gateways(null)).toEqual([...IpfsRead.DEFAULT_GATEWAYS]);
    });
});

describe('ChainReader.withFallback', () => {
    it('answers from the server when it can, and from IPFS only when it cannot', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const fallback = vi.fn(async () => 'ipfs');
        expect(await withFallback('plan', async () => 'server', fallback)).toBe('server');
        expect(fallback).not.toHaveBeenCalled();
        expect(await withFallback('plan', async () => { throw new Error('HTTP 503'); }, fallback)).toBe('ipfs');
        info.mockRestore();
    });

    it('throws the server\'s error, carrying the fallback\'s, when both fail', async () => {
        const quiet = [vi.spyOn(console, 'info').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})];
        const serverError = Object.assign(new Error('This agreement is not on the server.'), { code: 'agreement-not-found' });
        const ipfsError = Object.assign(new Error('not retrievable'), { code: 'ipfs-unavailable' });
        const error = await thrown(() => withFallback('agreement', async () => { throw serverError; }, async () => { throw ipfsError; }));
        quiet.forEach(spy => spy.mockRestore());
        expect(error).toBe(serverError);
        expect(error.fallbackError).toBe(ipfsError);
    });
});
