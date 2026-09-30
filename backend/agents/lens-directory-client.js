// Lens choice for agent proposers (lens-model.md §Agents and MCP): read the attester directory
// (GET /agent/lenses/members) and pick lens members deterministically, so a proposer never names
// its own key as the authority that decides its proposal. Pure except fetchLensMembers().

import { PublicKey } from '@solana/web3.js';

export const DEFAULT_LENS_KINDS = Object.freeze(['owner-consent']);

function cleanBase(apiBase) {
    if (!apiBase) throw new Error('apiBase is required to read the lens directory');
    return String(apiBase).replace(/\/+$/, '');
}

function coverageOf(member, key) {
    const value = Number(member?.coverage?.[key]);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
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
export async function fetchLensMembers({ apiBase, fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('a fetch implementation is required');
    const url = `${cleanBase(apiBase)}/agent/lenses/members`;
    let response;
    try {
        response = await fetchImpl(url, { headers: { accept: 'application/json' } });
    } catch (error) {
        throw new Error(`lens directory ${url} unreachable: ${error.cause?.code || error.cause?.message || error.message}`);
    }
    const text = await response.text();
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
    let body;
    try { body = JSON.parse(text); } catch { throw new Error(`${url} did not return JSON`); }
    if (!body || !Array.isArray(body.members)) throw new Error(`${url} returned no members array`);
    return body.members;
}

/**
 * Pick lens members. Rule: keep members whose `kind` is in `kinds` (any kind when `kinds` is empty)
 * and whose key is not in `exclude`; order by coverage.ownership descending, then key ascending
 * (byte-wise string compare); return the first `max` (default `min`). Fewer than `min` qualifying
 * members is an error, never a silent fallback.
 *
 * @param {Array} members directory members
 * @param {{ kinds?: string[], min?: number, max?: number, exclude?: string[] }} options
 * @returns {Array} the chosen members, in rank order
 */
export function chooseLens(members, { kinds = DEFAULT_LENS_KINDS, min = 1, max, exclude = [] } = {}) {
    if (!Number.isInteger(min) || min < 1) throw new Error('chooseLens: min must be a positive integer');
    const take = max === undefined ? min : max;
    if (!Number.isInteger(take) || take < min) throw new Error('chooseLens: max must be an integer ≥ min');
    const excluded = new Set((exclude || []).filter(Boolean).map(String));
    const kindSet = new Set((kinds || []).map(String));
    const seen = new Set();
    const qualifying = [];
    for (const member of Array.isArray(members) ? members : []) {
        const key = typeof member?.key === 'string' ? member.key : '';
        if (!key || seen.has(key) || excluded.has(key)) continue;
        if (kindSet.size && !kindSet.has(member.kind)) continue;
        seen.add(key);
        qualifying.push(member);
    }
    qualifying.sort((a, b) => (coverageOf(b, 'ownership') - coverageOf(a, 'ownership')) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    if (qualifying.length < min) {
        const total = Array.isArray(members) ? members.length : 0;
        throw new Error(
            `no lens: ${qualifying.length} of ${total} directory member(s) qualify (need ${min}; kinds ${kindSet.size ? [...kindSet].join('|') : 'any'}; ` +
            `excluding ${excluded.size ? [...excluded].join(', ') : 'nobody'}). Refusing to mint with the proposer as its own lens; ` +
            'pass --lens KEY[,KEY] or wait for a lens member to appear in /agent/lenses/members.'
        );
    }
    return qualifying.slice(0, take);
}

/**
 * The lens for one mint: explicit keys when given, otherwise the directory choice. Either way the
 * proposer's own key alone is refused. Returns what the dry-run plan prints and the run checkpoints.
 *
 * @returns {Promise<{ lens: string[], source: 'explicit'|'directory', reason: string, members: Array }>}
 */
export async function resolveLens({ explicit, proposer, apiBase, fetchImpl, kinds = DEFAULT_LENS_KINDS, min = 1, max } = {}) {
    const self = proposer ? normalizeLensKey(proposer, 'proposer key') : null;
    if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') {
        const lens = parseLensList(explicit);
        if (!lens.length) throw new Error('--lens was given but names no key');
        if (self && lens.length === 1 && lens[0] === self) {
            throw new Error(`--lens names only the proposer's own key ${self}; a self-lens lets the proposer decide its own proposal. Name at least one other lens member.`);
        }
        return { lens, source: 'explicit', reason: `explicit --lens (${lens.length} key${lens.length === 1 ? '' : 's'})`, members: lens.map(key => ({ key })) };
    }
    const members = await fetchLensMembers({ apiBase, fetchImpl });
    const chosen = chooseLens(members, { kinds, min, max, exclude: self ? [self] : [] });
    const reason = `directory ${cleanBase(apiBase)}/agent/lenses/members: ${chosen.length} of ${members.length} member(s), ` +
        `kind ${kinds?.length ? kinds.join('|') : 'any'}, proposer excluded, ranked by ownership coverage then key → ` +
        chosen.map(m => `${m.name || m.key} (${m.kind ?? '?'}, ${coverageOf(m, 'ownership')} ownership)`).join(', ');
    return { lens: chosen.map(m => m.key), source: 'directory', reason, members: chosen };
}

/** One line for logs and the dry-run plan. */
export function describeLensChoice(choice) {
    if (!choice?.lens?.length) return 'lens: none';
    return `lens [${choice.lens.join(', ')}] · ${choice.reason}`;
}
