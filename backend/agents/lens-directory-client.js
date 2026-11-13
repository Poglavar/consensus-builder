// The attester directory as agents read it (lens-model.md §Agents and MCP): GET /agent/lenses/members, and
// lens keys as they are typed or listed (canonical base58). The proposer runner names the lens member it
// operates (personas.json) rather than choosing from the directory. Pure except fetchLensMembers().
// A member is one identity with an address per chain family (`addresses.solana`, `addresses.evm`); an
// agreement's lens holds only addresses of its sponsor's chain (lensChainProblem).

import { PublicKey } from '@solana/web3.js';
import { keyFamily, sameKey } from '../chain/keys.js';
import { createRetryingFetch } from '../utils/retrying-fetch.js';

function cleanBase(apiBase) {
    if (!apiBase) throw new Error('apiBase is required to read the lens directory');
    return String(apiBase).replace(/\/+$/, '');
}

/** A canonical base58 public key, or a thrown error naming the label. */
export function normalizeLensKey(value, label = 'lens key') {
    const text = typeof value === 'string' ? value.trim() : '';
    let key;
    try {
        key = new PublicKey(text).toBase58();
    } catch {
        throw new Error(`${label} "${value}" is not a base58 public key`);
    }
    if (key !== text) throw new Error(`${label} "${value}" is not a canonical base58 public key`);
    return key;
}

/** "key,key" (CLI) or an array → unique canonical keys, in the given order. */
export function parseLensList(value) {
    const items = Array.isArray(value) ? value : String(value ?? '').split(',');
    return [...new Set(items.map(item => String(item).trim()).filter(Boolean).map(item => normalizeLensKey(item)))];
}

/** The member's address on a chain family ('solana' | 'evm'), or null when it publishes none there. */
export function memberAddress(member, family) {
    const address = member?.addresses?.[family] ?? null;
    return address && keyFamily(address) === family ? address : null;
}

/** The directory member that published `address` on any chain, or null. */
export function memberOf(members, address) {
    return (members || []).find(member => Object.values(member?.addresses || {}).some(value => value && sameKey(value, address))) ?? null;
}

/**
 * The members available on a chain family, each with its address there: [{ member, address }], in
 * directory order. A member that published no address on that family is not available on it.
 */
export function membersOnChain(members, family) {
    return (members || []).map(member => ({ member, address: memberAddress(member, family) })).filter(entry => entry.address);
}

/**
 * Why `lens` cannot be the lens of an agreement `sponsor` mints, or null when it can: its entries must
 * all be addresses of the sponsor's chain. Without a sponsor nothing is minted and any lens stands.
 * With `members` (the directory), the message names the member's address on the sponsor's chain.
 */
export function lensChainProblem({ sponsor, lens, members = null }) {
    const family = sponsor ? keyFamily(sponsor) : null;
    if (!family) return null;
    const chain = family === 'evm' ? 'EVM' : 'Solana';
    for (const entry of Array.isArray(lens) ? lens : []) {
        if (keyFamily(entry) === family) continue;
        const member = members ? memberOf(members, entry) : null;
        const instead = member ? memberAddress(member, family) : null;
        return `rule.lens names ${entry}, which is not ${family === 'evm' ? 'an' : 'a'} ${chain} address, but the sponsor ${sponsor} mints on ${chain}: an agreement's lens holds only addresses of its sponsor's chain`
            + (instead ? `; that member's ${chain} address is ${instead}` : member ? `; that member publishes no ${chain} address` : '');
    }
    return null;
}

/**
 * GET `${apiBase}/agent/lenses/members` → the directory's members array.
 * @returns {Promise<Array<{ key: string, addresses: { solana: string, evm: string|null }, kind: string|null,
 *   name: string|null, description: string|null, coverage: { ownership: number, parcels: number, executed: number } }>>}
 */
export async function fetchLensMembers({ apiBase, fetchImpl = globalThis.fetch, retryOptions = {} } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('a fetch implementation is required');
    const url = `${cleanBase(apiBase)}/agent/lenses/members`;
    const retryFetch = createRetryingFetch({ ...retryOptions, fetchImpl, timeoutMs: retryOptions.timeoutMs ?? 12_000,
        requestLabel: () => 'lens-directory' });
    let response;
    try {
        response = await retryFetch(url, { method: 'GET', headers: { accept: 'application/json' } });
    } catch {
        throw new Error('lens directory unreachable');
    }
    const text = await response.text();
    if (!response.ok) throw new Error(`lens directory returned HTTP ${response.status}`);
    let body;
    try { body = JSON.parse(text); } catch { throw new Error('lens directory did not return JSON'); }
    if (!body || !Array.isArray(body.members)) throw new Error('lens directory returned no members array');
    return body.members;
}
