// conflict-tour.js — decision bookkeeping for the shared-plan conflict tour. The modal and the
// unapply/apply live in sharing-routes.js; this state must make blanket decisions stick and keep
// a re-conflict (same proposal, different occupiers) a NEW question.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tour = require('../../frontend/js/proposals/conflict-tour.js');

describe('stopKey', () => {
    it('is stable under occupier order', () => {
        expect(tour.stopKey('c-a', ['x', 'y'])).toBe(tour.stopKey('c-a', ['y', 'x']));
    });

    it('changes when the occupier set changes — a new occupier is a new question', () => {
        expect(tour.stopKey('c-a', ['x'])).not.toBe(tour.stopKey('c-a', ['x', 'y']));
    });
});

describe('decisions', () => {
    it('asks until something is decided', () => {
        const state = tour.createTourState();
        expect(tour.resolveAction(state, 'k1')).toBe('ask');
    });

    it('remembers a direct decision for exactly that stop', () => {
        const state = tour.createTourState();
        tour.recordDecision(state, 'k1', 'replace', false);
        expect(tour.resolveAction(state, 'k1')).toBe('replace');
        expect(tour.resolveAction(state, 'k2')).toBe('ask');
    });

    it('a blanket decision answers every later stop', () => {
        const state = tour.createTourState();
        tour.recordDecision(state, 'k1', 'keep', true);
        expect(tour.resolveAction(state, 'k2')).toBe('keep');
        expect(tour.resolveAction(state, 'anything')).toBe('keep');
    });

    it('a direct decision wins over the blanket for its own stop', () => {
        const state = tour.createTourState();
        tour.recordDecision(state, 'k1', 'replace', false);
        tour.recordDecision(state, 'k2', 'keep', true);
        expect(tour.resolveAction(state, 'k1')).toBe('replace');
        expect(tour.resolveAction(state, 'k3')).toBe('keep');
    });

    it('normalises junk actions to the non-destructive choice', () => {
        const state = tour.createTourState();
        tour.recordDecision(state, 'k1', 'detonate', false);
        expect(tour.resolveAction(state, 'k1')).toBe('keep');
    });
});
