// The attester directory as agents read it (lens-model.md §Agents and MCP): GET /agent/lenses/members, and
// lens keys as they are typed or listed (canonical base58). The proposer runner names the lens member it
// operates (personas.json) rather than choosing from the directory. Pure except fetchLensMembers().

import { PublicKey } from '@solana/web3.js';
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

/**
 * GET `${apiBase}/agent/lenses/members` → the directory's members array.
 * @returns {Promise<Array<{ key: string, kind: string|null, name: string|null, description: string|null,
 *   coverage: { ownership: number, parcels: number, executed: number } }>>}
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
