// The attester directory as agents read it (agents/lens-directory-client.js): GET /agent/lenses/members
// through the retrying fetch, and lens keys as they are typed or listed (canonical base58, unique, in
// order). The proposer runner names the lens member it operates instead of choosing from the directory.
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { fetchLensMembers, lensChainProblem, memberAddress, memberOf, membersOnChain, normalizeLensKey, parseLensList } from '../agents/lens-directory-client.js';

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

describe('one member, an address per chain', () => {
    const EVM = '0x2F4cE2B5ed2a1C1aF7D0eb0B33e3Fc5EC5a1FbD0';
    const both = { ...member(A, 'owner-consent'), addresses: { solana: A, evm: EVM } };
    const solanaOnly = { ...member(B, 'lifecycle'), addresses: { solana: B, evm: null } };

    it('makes a member available only on the chains it published an address for', () => {
        expect(memberAddress(both, 'evm')).toBe(EVM);
        expect(memberAddress(solanaOnly, 'evm')).toBeNull();
        // An address of the wrong family under a family's name is not an address there.
        expect(memberAddress({ addresses: { evm: A } }, 'evm')).toBeNull();
        expect(membersOnChain([both, solanaOnly], 'evm')).toEqual([{ member: both, address: EVM }]);
        expect(membersOnChain([both, solanaOnly], 'solana').map(entry => entry.address)).toEqual([A, B]);
        expect(memberOf([both, solanaOnly], EVM.toLowerCase())).toBe(both);
        expect(memberOf([both, solanaOnly], B)).toBe(solanaOnly);
        expect(memberOf([both], key())).toBeNull();
    });

    it('accepts a lens of the sponsor\'s chain only, naming the member\'s address there', () => {
        expect(lensChainProblem({ sponsor: A, lens: [A, B] })).toBeNull();
        expect(lensChainProblem({ sponsor: EVM, lens: [EVM.toLowerCase()] })).toBeNull();
        // Without a sponsor nothing is minted.
        expect(lensChainProblem({ sponsor: null, lens: [A, EVM] })).toBeNull();
        expect(lensChainProblem({ sponsor: EVM, lens: [A] })).toMatch(new RegExp(`rule.lens names ${A}, which is not an EVM address`));
        expect(lensChainProblem({ sponsor: EVM, lens: [A], members: [both] })).toMatch(new RegExp(`that member's EVM address is ${EVM}`));
        expect(lensChainProblem({ sponsor: EVM, lens: [B], members: [both, solanaOnly] })).toMatch(/that member publishes no EVM address/);
        expect(lensChainProblem({ sponsor: A, lens: [A, EVM] })).toMatch(/not a Solana address/);
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
