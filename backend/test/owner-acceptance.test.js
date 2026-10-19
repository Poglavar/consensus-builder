// Unit tests for frontend/js/proposals/owner-acceptance.js — the per-parcel owner/acceptance
// bookkeeping shared by proposals/core.js, data.js and execution.js. It was trapped in execution.js
// (a classic script) with no export, so this behaviour had no headless coverage at all.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeOwnerAcceptances, ensureOwnerAcceptanceEntry } = require('../../frontend/js/proposals/owner-acceptance.js');

describe('normalizeOwnerAcceptances', () => {
    it('canonicalizes a sparse entry and folds accepted keys into ownerOrder', () => {
        const out = normalizeOwnerAcceptances({
            '123': { owners: { a: {}, b: {} }, acceptedOwnerKeys: ['b', 'c'] }
        });
        expect(out['123'].ownerOrder).toEqual(expect.arrayContaining(['a', 'b', 'c']));
        expect(out['123'].acceptedOwnerKeys).toEqual(['b', 'c']);
        expect(out['123'].acceptedBy).toEqual({});
    });

    it('dedups accepted keys and ignores non-object input', () => {
        expect(normalizeOwnerAcceptances(null)).toEqual({});
        const out = normalizeOwnerAcceptances({ '1': { acceptedOwnerKeys: ['x', 'x', 'y'] } });
        expect(out['1'].acceptedOwnerKeys).toEqual(['x', 'y']);
    });
});

describe('ensureOwnerAcceptanceEntry', () => {
    it('adds owner slots in order and returns the entry', () => {
        const proposal = {};
        const entry = ensureOwnerAcceptanceEntry(proposal, '42', [
            { key: 'a', displayName: 'Ana', shareText: '1/2', type: 'private individual' },
            { key: 'b', displayName: 'Bob', shareText: '1/2', type: 'private individual' }
        ]);
        expect(entry.ownerOrder).toEqual(['a', 'b']);
        expect(entry.owners.a.displayName).toBe('Ana');
        expect(proposal.ownerAcceptances['42']).toBe(entry);
    });

    it('purges a legacy placeholder owner once a real slot arrives', () => {
        const proposal = {
            ownerAcceptances: {
                '42': {
                    owners: { legacy: { displayName: 'Parcel owner', shareText: '100%', type: 'unknown' } },
                    ownerOrder: ['legacy'],
                    acceptedOwnerKeys: ['legacy'],
                    acceptedBy: { legacy: { username: 'x' } }
                }
            }
        };
        const entry = ensureOwnerAcceptanceEntry(proposal, '42', [
            { key: 'real', displayName: 'Ana Anić', shareText: '1/1', type: 'private individual' }
        ]);
        expect(entry.owners.legacy).toBeUndefined();
        expect(entry.ownerOrder).toEqual(['real']);
        expect(entry.acceptedBy.legacy).toBeUndefined();
    });

    it('does NOT purge a real named 100% owner (the display-name guard)', () => {
        const proposal = {
            ownerAcceptances: {
                '42': {
                    owners: { real: { displayName: 'Ivan Horvat', shareText: '100%', type: 'unknown' } },
                    ownerOrder: ['real'],
                    acceptedOwnerKeys: [],
                    acceptedBy: {}
                }
            }
        };
        const entry = ensureOwnerAcceptanceEntry(proposal, '42', [
            { key: 'other', displayName: 'Marko Marić', shareText: '1/2', type: 'private individual' }
        ]);
        // The named owner survives because the placeholder heuristic requires an empty or
        // placeholder-looking display name.
        expect(entry.owners.real).toBeDefined();
        expect(entry.owners.real.displayName).toBe('Ivan Horvat');
    });

    it('back-fills owner acceptances from acceptedParcelIds when syncing', () => {
        const proposal = { acceptedParcelIds: ['42'], executedAt: '2026-01-01T00:00:00.000Z' };
        const entry = ensureOwnerAcceptanceEntry(proposal, '42', [
            { key: 'a', displayName: 'Ana', type: 'private individual' }
        ]);
        expect(entry.acceptedOwnerKeys).toContain('a');
        expect(entry.acceptedBy.a.acceptedAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('does not back-fill when syncWithParcelAcceptance is false', () => {
        const proposal = { acceptedParcelIds: ['42'] };
        const entry = ensureOwnerAcceptanceEntry(proposal, '42',
            [{ key: 'a', displayName: 'Ana' }],
            { syncWithParcelAcceptance: false });
        expect(entry.acceptedOwnerKeys).toEqual([]);
    });

    it('returns null for a missing proposal or parcel id', () => {
        expect(ensureOwnerAcceptanceEntry(null, '42', [])).toBeNull();
        expect(ensureOwnerAcceptanceEntry({}, null, [])).toBeNull();
    });
});
