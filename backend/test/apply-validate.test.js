// The gate that replaces rollback. If this decides wrongly, the choice is between applying
// something that cannot stand and refusing something that could — so every rule it encodes is
// pinned here, including the two distinctions that are easy to lose: a proposal never conflicts
// with itself, and "the ground is taken" is a final answer while "not loaded yet" is not.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateApply, validatePlan, CODE_CONFLICT, CODE_MISSING } =
    require('../../frontend/js/proposals/apply/validate.js');

const holders = (map) => (parcelId) => map[parcelId] || [];
const titles = (map) => (proposalId) => map[proposalId] || proposalId;

describe('validateApply', () => {
    it('passes a proposal whose ground is free and resolved', () => {
        const verdict = validateApply({
            declaredParentIds: ['p1', 'p2'],
            unresolvableIds: [],
            selfProposalId: 'me',
            occupiedBy: holders({})
        });
        expect(verdict.ok).toBe(true);
        expect(verdict.code).toBe(null);
        expect(verdict.conflicts).toEqual([]);
    });

    it('refuses ground another applied proposal is standing on, and names it', () => {
        const verdict = validateApply({
            declaredParentIds: ['p1', 'p2'],
            unresolvableIds: [],
            selfProposalId: 'me',
            occupiedBy: holders({ p2: ['other'] }),
            titleOf: titles({ other: 'Block 1108-0100' })
        });
        expect(verdict.ok).toBe(false);
        expect(verdict.code).toBe(CODE_CONFLICT);
        expect(verdict.message).toContain('Block 1108-0100');
        expect(verdict.conflicts).toEqual([
            { proposalId: 'other', title: 'Block 1108-0100', parcelIds: ['p2'] }
        ]);
    });

    // Re-applying a proposal over its own ground is a no-op, not a conflict. Getting this wrong
    // makes every already-applied member of a plan look blocked on reload.
    it('does not let a proposal conflict with itself', () => {
        const verdict = validateApply({
            declaredParentIds: ['p1'],
            unresolvableIds: [],
            selfProposalId: 'me',
            occupiedBy: holders({ p1: ['me'] })
        });
        expect(verdict.ok).toBe(true);
    });

    it('reports an unresolved parent as a missing dependency', () => {
        const verdict = validateApply({
            declaredParentIds: ['p1', 'p2'],
            unresolvableIds: ['p2'],
            selfProposalId: 'me',
            occupiedBy: holders({})
        });
        expect(verdict.ok).toBe(false);
        expect(verdict.code).toBe(CODE_MISSING);
        expect(verdict.notLoaded).toEqual(['p2']);
    });

    // The distinction that decides whether a caller may retry. Occupied ground will still be
    // occupied after a refetch; a parcel that merely was not loaded may not be.
    it('calls an occupied parcel taken, not missing, even when it is also unresolved', () => {
        const verdict = validateApply({
            declaredParentIds: ['p1'],
            unresolvableIds: ['p1'],
            selfProposalId: 'me',
            occupiedBy: holders({ p1: ['other'] }),
            titleOf: titles({ other: 'Road Ilica' })
        });
        expect(verdict.code).toBe(CODE_CONFLICT);
        expect(verdict.notLoaded).toEqual([]);
        expect(verdict.retryable, 'a taken parcel is not worth retrying').toBe(false);
    });

    it('marks a missing dependency retryable, so a fetch is worth attempting', () => {
        const verdict = validateApply({
            declaredParentIds: ['p1', 'p2'],
            unresolvableIds: ['p1'],
            selfProposalId: 'me',
            occupiedBy: holders({ p2: ['other'] })
        });
        expect(verdict.code).toBe(CODE_MISSING);
        expect(verdict.retryable).toBe(true);
        expect(verdict.conflicts.length, 'the occupier is still reported alongside').toBe(1);
    });

    it('groups several taken parcels under the one proposal holding them', () => {
        const verdict = validateApply({
            declaredParentIds: ['p1', 'p2', 'p3'],
            unresolvableIds: [],
            selfProposalId: 'me',
            occupiedBy: holders({ p1: ['other'], p3: ['other'] })
        });
        expect(verdict.conflicts).toHaveLength(1);
        expect(verdict.conflicts[0].parcelIds).toEqual(['p1', 'p3']);
    });

    it('survives being handed nothing at all', () => {
        expect(validateApply().ok).toBe(true);
        expect(validateApply({}).ok).toBe(true);
        expect(validateApply({ declaredParentIds: null, occupiedBy: 'not a function' }).ok).toBe(true);
    });
});

describe('validatePlan', () => {
    const members = [
        { proposalId: 'a', title: 'Block A', declaredParentIds: ['p1'], unresolvableIds: [] },
        { proposalId: 'b', title: 'Block B', declaredParentIds: ['p2'], unresolvableIds: [] },
        { proposalId: 'c', title: 'Block C', declaredParentIds: ['p3'], unresolvableIds: ['p3'] }
    ];

    it('splits a plan into what can be applied and what cannot, before anything is applied', () => {
        const report = validatePlan(members, {
            occupiedBy: holders({ p2: ['x'] }),
            titleOf: titles({ x: 'Road X' })
        });

        expect(report.total).toBe(3);
        expect(report.applicable.map(e => e.proposalId)).toEqual(['a']);
        expect(report.blocked.map(e => e.proposalId)).toEqual(['b', 'c']);
        expect(report.blocked[0].verdict.code).toBe(CODE_CONFLICT);
        expect(report.blocked[0].verdict.message).toContain('Road X');
        expect(report.blocked[1].verdict.code).toBe(CODE_MISSING);
    });

    it('passes a whole plan whose ground is clear', () => {
        const report = validatePlan(members.slice(0, 2), { occupiedBy: holders({}) });
        expect(report.blocked).toEqual([]);
        expect(report.applicable).toHaveLength(2);
    });

    it('handles an empty plan without inventing work', () => {
        expect(validatePlan([], {})).toEqual({ applicable: [], blocked: [], total: 0 });
        expect(validatePlan(null, null).total).toBe(0);
    });
});

// §15b: within one plan the taker amends the taken, so members overlapping each other is the design,
// not a conflict. Re-opening a plan whose members are already applied would otherwise report almost
// every member as blocked by its own plan-mates — a gate that refuses everything is worse than none.
describe('validatePlan and a plan\'s own members', () => {
    const members = [
        { proposalId: 'a', title: 'Block A', declaredParentIds: ['shared'], unresolvableIds: [] },
        { proposalId: 'b', title: 'Block B', declaredParentIds: ['shared'], unresolvableIds: [] }
    ];

    it('does not block a member on ground held by another member of the same plan', () => {
        const report = validatePlan(members, {
            occupiedBy: () => ['a'],                       // 'a' is applied and holds the ground
            titleOf: (id) => `Block ${String(id).toUpperCase()}`
        });
        expect(report.blocked, 'blocked members on their own plan-mates').toEqual([]);
        expect(report.applicable).toHaveLength(2);
    });

    it('still blocks on ground held by something outside the plan', () => {
        const report = validatePlan(members, {
            occupiedBy: () => ['a', 'outsider'],
            titleOf: (id) => (id === 'outsider' ? 'Road Ilica' : `Block ${id}`)
        });
        expect(report.applicable).toEqual([]);
        expect(report.blocked).toHaveLength(2);
        expect(report.blocked[0].verdict.message).toContain('Road Ilica');
        expect(report.blocked[0].verdict.message, 'named a plan-mate as a blocker').not.toContain('Block a');
    });
});
