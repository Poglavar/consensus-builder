// Simulation ghosts without a browser (frontend/js/simulation-ghosts.js): which agent designs are
// still drawn after each turn, and how strongly, before they fade out.
import { beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Ghosts = require('../../frontend/js/simulation-ghosts.js');

describe('simulation ghosts', () => {
    beforeEach(() => Ghosts.clear());

    it('is full strength in its own turn and fades out over three turns', () => {
        expect([0, 1, 2, 3].map(age => Ghosts.ghostStrength(age))).toEqual([1, 2 / 3, 1 / 3, 0]);
        expect(Ghosts.ghostStrength(-1)).toBe(0);
        expect(Ghosts.ghostStrength(NaN)).toBe(0);
    });

    it('lists the live ghosts newest first', () => {
        const live = Ghosts.liveGhosts([{ proposalId: 'a', turn: 4 }, { proposalId: 'b', turn: 6 }, { proposalId: 'c', turn: 2 }], 6);
        expect(live.map(g => [g.proposalId, g.strength])).toEqual([['b', 1], ['a', 1 / 3]]);
    });

    it('records each turn: new designs join, older ones fade, faded ones drop out', () => {
        Ghosts.recordTurn(1, ['p1', 7]);
        expect(Ghosts.strengthOf('p1')).toBe(1);
        expect(Ghosts.strengthOf('7')).toBe(1);
        Ghosts.recordTurn(2, ['p2']);
        expect(Ghosts.strengthOf('p1')).toBeCloseTo(2 / 3);
        Ghosts.recordTurn(3, []);
        Ghosts.recordTurn(4, []);
        expect(Ghosts.strengthOf('p1')).toBe(0);
        expect(Ghosts.list().map(g => g.proposalId)).toEqual(['p2']);
    });

    it('redraws a design picked up again at full strength', () => {
        Ghosts.recordTurn(1, ['p1']);
        Ghosts.recordTurn(2, ['p1']);
        expect(Ghosts.strengthOf('p1')).toBe(1);
        expect(Ghosts.list()).toHaveLength(1);
    });

    it('clears on Stop and New game', () => {
        Ghosts.recordTurn(1, ['p1']);
        Ghosts.clear();
        expect(Ghosts.list()).toEqual([]);
        expect(Ghosts.strengthOf('p1')).toBe(0);
    });
});
