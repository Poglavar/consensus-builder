// Spreading proposals across the epoch buckets, randomly and evenly.
//
// Six hundred proposals is too many to assign by hand, and the two properties that make an automatic
// spread useful pull against each other: it must be RANDOM (so the buckets are not the created-at
// order sliced into four) and it must be EVEN (so no bucket ends up with twice the work of another).
// Sorting by a random key gives the first and not the second; this shuffles and then deals
// round-robin, which gives both.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const epoch = require('../../frontend/js/proposals/epoch.js');

const proposals = n => Array.from({ length: n }, (_, i) => ({ proposalId: `p${i}` }));
const countByYear = plan => plan.reduce((acc, entry) => {
    acc[entry.year] = (acc[entry.year] || 0) + 1;
    return acc;
}, {});

describe('the buckets come out even', () => {
    it('splits a multiple of four exactly', () => {
        const plan = epoch.planEpochSpread(proposals(621 - 1), epoch.DEFAULT_CHOICES, epoch.makeRandom(1));
        expect(Object.values(countByYear(plan))).toEqual([155, 155, 155, 155]);
    });

    it('never differs by more than one when it does not divide', () => {
        [1, 2, 3, 5, 7, 10, 621, 1000].forEach(n => {
            const counts = Object.values(countByYear(
                epoch.planEpochSpread(proposals(n), epoch.DEFAULT_CHOICES, epoch.makeRandom(n))));
            const total = counts.reduce((a, b) => a + b, 0);
            expect(total, `${n} proposals must all be placed`).toBe(n);
            if (counts.length > 1) {
                expect(Math.max(...counts) - Math.min(...counts), `${n} proposals`).toBeLessThanOrEqual(1);
            }
        });
    });

    it('places every proposal exactly once', () => {
        const list = proposals(200);
        const plan = epoch.planEpochSpread(list, epoch.DEFAULT_CHOICES, epoch.makeRandom(3));
        expect(new Set(plan.map(entry => entry.proposal.proposalId)).size).toBe(200);
    });

    it('uses only the years it was given', () => {
        const plan = epoch.planEpochSpread(proposals(50), [2035, 2100], epoch.makeRandom(9));
        expect(new Set(plan.map(entry => entry.year))).toEqual(new Set([2035, 2100]));
    });
});

describe('the order is genuinely shuffled', () => {
    it('does not deal the input order straight into the buckets', () => {
        const list = proposals(100);
        const plan = epoch.planEpochSpread(list, epoch.DEFAULT_CHOICES, epoch.makeRandom(42));
        const inOrder = plan.every((entry, index) => entry.proposal.proposalId === `p${index}`);
        expect(inOrder, 'the plan is the input order — the shuffle did nothing').toBe(false);
    });

    it('is reproducible from a seed, and different without one', () => {
        const list = proposals(60);
        const first = epoch.planEpochSpread(list, epoch.DEFAULT_CHOICES, epoch.makeRandom(11));
        const again = epoch.planEpochSpread(list, epoch.DEFAULT_CHOICES, epoch.makeRandom(11));
        expect(again.map(e => e.proposal.proposalId)).toEqual(first.map(e => e.proposal.proposalId));

        const other = epoch.planEpochSpread(list, epoch.DEFAULT_CHOICES, epoch.makeRandom(12));
        expect(other.map(e => e.proposal.proposalId)).not.toEqual(first.map(e => e.proposal.proposalId));
    });

    it('leaves the caller\'s array alone', () => {
        const list = proposals(30);
        const before = list.map(p => p.proposalId);
        epoch.planEpochSpread(list, epoch.DEFAULT_CHOICES, epoch.makeRandom(5));
        expect(list.map(p => p.proposalId)).toEqual(before);
    });
});

describe('nothing to spread', () => {
    it('is an empty plan, not a crash', () => {
        expect(epoch.planEpochSpread([], epoch.DEFAULT_CHOICES, epoch.makeRandom(1))).toEqual([]);
        expect(epoch.planEpochSpread(null, epoch.DEFAULT_CHOICES, epoch.makeRandom(1))).toEqual([]);
    });
});
