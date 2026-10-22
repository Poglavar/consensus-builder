// The attester directory as agents read it (agents/lens-directory-client.js): GET /agent/lenses/members
// through the retrying fetch, and lens keys as they are typed or listed (canonical base58, unique, in
// order). The proposer runner names the lens member it operates instead of choosing from the directory.
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { fetchLensMembers, normalizeLensKey, parseLensList } from '../agents/lens-directory-client.js';

const key = () => Keypair.generate().publicKey.toBase58();
const [A, B] = [key(), key()];
const member = (k, kind, ownership = 0, name = null) => ({ key: k, kind, name, description: null, coverage: { ownership, parcels: ownership, executed: 0 } });
const retryOptions = { wait: async () => {}, log: () => {} };

function directoryFetch(body, status = 200) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, method: init?.method });
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    };
    return { fetchImpl, calls };
}

describe('fetchLensMembers', () => {
    it('reads the members array from GET /agent/lenses/members under the API base', async () => {
        const members = [member(A, 'owner-consent', 2, 'notary-01'), member(B, 'lifecycle')];
        const { fetchImpl, calls } = directoryFetch({ members });
        expect(await fetchLensMembers({ apiBase: 'https://api.example.test/', fetchImpl, retryOptions })).toEqual(members);
        expect(calls).toEqual([{ url: 'https://api.example.test/agent/lenses/members', method: 'GET' }]);
    });

    it('refuses an unavailable directory and an answer that is not a members list', async () => {
        await expect(fetchLensMembers({ apiBase: 'http://x', fetchImpl: directoryFetch({ members: [] }, 500).fetchImpl, retryOptions })).rejects.toThrow(/HTTP 500/);
        await expect(fetchLensMembers({ apiBase: 'http://x', fetchImpl: async () => { throw new TypeError('fetch failed'); }, retryOptions })).rejects.toThrow(/unreachable/);
        await expect(fetchLensMembers({ apiBase: 'http://x', fetchImpl: directoryFetch('<html>').fetchImpl, retryOptions })).rejects.toThrow(/did not return JSON/);
        await expect(fetchLensMembers({ apiBase: 'http://x', fetchImpl: directoryFetch({ lenses: [] }).fetchImpl, retryOptions })).rejects.toThrow(/no members array/);
        await expect(fetchLensMembers({ fetchImpl: directoryFetch({ members: [] }).fetchImpl, retryOptions })).rejects.toThrow(/apiBase is required/);
    });
});

describe('lens keys', () => {
    it('parses CLI lists and arrays into unique canonical keys, in the given order', () => {
        expect(parseLensList(`${B},${A}, ${B}`)).toEqual([B, A]);
        expect(parseLensList([A, ` ${B} `, A])).toEqual([A, B]);
        expect(parseLensList('')).toEqual([]);
        expect(parseLensList(undefined)).toEqual([]);
        expect(() => parseLensList(`${A},not-a-key`)).toThrow(/lens key "not-a-key" is not a base58 public key/);
    });

    it('normalizes one key or refuses it by its label', () => {
        expect(normalizeLensKey(` ${A} `)).toBe(A);
        expect(() => normalizeLensKey('nope', 'operated lens')).toThrow(/operated lens "nope" is not a base58 public key/);
        expect(() => normalizeLensKey(7)).toThrow(/not a base58 public key/);
    });
});
