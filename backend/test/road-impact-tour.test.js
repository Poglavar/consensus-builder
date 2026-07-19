// Unit tests for the per-building road-impact tour: its pure state model (road-impact-tour.js), the
// obstacle-hit partitioner and the persistent footprint-outcome classifier/style (corridor-tunnel.js).
// These lock the decision logic that decides what each affected building becomes — cut, demolished or
// tunnelled — independent of the DOM/map layer that drives it.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tour = require('../../frontend/js/road-impact-tour.js');
const {
    partitionObstacleHits,
    classifyBuildingOutcome,
    buildingOutcomeStyle,
    corridorTunnelHitProposalId
} = require('../../frontend/js/corridor-tunnel.js');

const realHit = id => ({ id, feature: { properties: {}, geometry: null } });
const proposalHit = (id, proposalId) => ({ id, feature: { properties: { proposalId }, geometry: null } });

describe('road impact tour — pure state model', () => {
    it('starts at index 0 with the given global default and no overrides', () => {
        const s = tour.createTourState([{}, {}, {}], 'cut');
        expect(s.count).toBe(3);
        expect(s.index).toBe(0);
        expect(s.defaultAction).toBe('cut');
        expect(s.overrides).toEqual({});
    });

    it('clamps the index to the building range', () => {
        expect(tour.tourClampIndex(5, 3)).toBe(2);
        expect(tour.tourClampIndex(-1, 3)).toBe(0);
        expect(tour.tourClampIndex(0, 0)).toBe(0);
        expect(tour.tourGoTo(tour.createTourState([{}, {}], 'cut'), 9).index).toBe(1);
    });

    it('returns the default action until a building is overridden, then the override', () => {
        let s = tour.createTourState([{}, {}], 'cut');
        expect(tour.tourEffectiveAction(s, 'b1')).toBe('cut');
        s = tour.tourSetOverride(s, 'b1', 'tunnel');
        expect(tour.tourEffectiveAction(s, 'b1')).toBe('tunnel');
        expect(tour.tourEffectiveAction(s, 'b2')).toBe('cut'); // untouched keeps the default
    });

    it('"apply to all" resets the default AND clears every override', () => {
        let s = tour.createTourState([{}], 'cut');
        s = tour.tourSetOverride(s, 'b1', 'tunnel');
        s = tour.tourSetDefault(s, 'destroy');
        expect(s.defaultAction).toBe('destroy');
        expect(s.overrides).toEqual({});
        expect(tour.tourEffectiveAction(s, 'b1')).toBe('destroy');
    });

    it('collapses a proposal-owned building menu to unapply(=destroy)/tunnel', () => {
        expect(tour.tourAllowedActions(false)).toEqual(['cut', 'destroy', 'tunnel']);
        expect(tour.tourAllowedActions(true)).toEqual(['destroy', 'tunnel']);
        expect(tour.tourNormalizeAction('cut', true)).toBe('destroy'); // cut is meaningless for a proposal
        expect(tour.tourNormalizeAction('tunnel', true)).toBe('tunnel');
        expect(tour.tourNormalizeAction('cut', false)).toBe('cut');
    });
});

describe('partitionObstacleHits — per-building outcome split', () => {
    const owner = corridorTunnelHitProposalId;

    it('global cut: real buildings are cut, proposal-owned are unapplied', () => {
        const hits = [realHit('a'), proposalHit('p', 'P1'), realHit('b')];
        const p = partitionObstacleHits(hits, 'cut', new Map(), owner);
        expect(p.realCut.map(h => h.id)).toEqual(['a', 'b']);
        expect(p.realDestroy).toEqual([]);
        expect(p.tunnelHits).toEqual([]);
        expect([...p.proposalUnapply]).toEqual(['P1']);
    });

    it('global destroy: real buildings are demolished, proposal-owned are unapplied', () => {
        const hits = [realHit('a'), proposalHit('p', 'P1')];
        const p = partitionObstacleHits(hits, 'destroy', {}, owner);
        expect(p.realDestroy.map(h => h.id)).toEqual(['a']);
        expect(p.realCut).toEqual([]);
        expect([...p.proposalUnapply]).toEqual(['P1']);
    });

    it('global tunnel: everything tunnels, nothing is unapplied', () => {
        const hits = [realHit('a'), proposalHit('p', 'P1')];
        const p = partitionObstacleHits(hits, 'tunnel', {}, owner);
        expect(p.tunnelHits.map(h => h.id)).toEqual(['a', 'p']);
        expect([...p.proposalUnapply]).toEqual([]);
        expect(p.realCut).toEqual([]);
        expect(p.realDestroy).toEqual([]);
    });

    it('a per-building override moves just that building; a proposal overridden to tunnel is NOT unapplied', () => {
        const hits = [realHit('a'), realHit('b'), proposalHit('p', 'P1')];
        const overrides = new Map([['b', 'tunnel'], ['p', 'tunnel']]);
        const p = partitionObstacleHits(hits, 'cut', overrides, owner);
        expect(p.realCut.map(h => h.id)).toEqual(['a']);   // a keeps the default
        expect(p.tunnelHits.map(h => h.id)).toEqual(['b', 'p']); // b and the proposal building tunnel
        expect([...p.proposalUnapply]).toEqual([]);         // the proposal survives (tunnelled, not unapplied)
        expect([...p.effectiveActionById]).toEqual([['a', 'cut'], ['b', 'tunnel'], ['p', 'tunnel']]);
    });

    it('accepts overrides as a plain object as well as a Map', () => {
        const hits = [realHit('a'), realHit('b')];
        const p = partitionObstacleHits(hits, 'cut', { b: 'destroy' }, owner);
        expect(p.realCut.map(h => h.id)).toEqual(['a']);
        expect(p.realDestroy.map(h => h.id)).toEqual(['b']);
    });
});

describe('building outcome classification and style', () => {
    it('classifies by the applied demolition/tunnel state (raze > cut > tunnel)', () => {
        const demolishedById = new Map([
            ['razed', { id: 'razed', geometry: {} }],           // no remainder → full demolition
            ['sliced', { id: 'sliced', geometry: {}, remainder: {} }] // remainder → cut
        ]);
        const tunnelledIds = new Set(['under']);
        expect(classifyBuildingOutcome('razed', { demolishedById, tunnelledIds })).toBe('destroyed');
        expect(classifyBuildingOutcome('sliced', { demolishedById, tunnelledIds })).toBe('cut');
        expect(classifyBuildingOutcome('under', { demolishedById, tunnelledIds })).toBe('tunnelled');
        expect(classifyBuildingOutcome('clear', { demolishedById, tunnelledIds })).toBe(null);
    });

    it('a razed building outranks a stray tunnel record for the same id', () => {
        const demolishedById = new Map([['x', { id: 'x', geometry: {} }]]);
        expect(classifyBuildingOutcome('x', { demolishedById, tunnelledIds: new Set(['x']) })).toBe('destroyed');
    });

    it('destroyed reads as a dashed red outline with no fill (road shows through)', () => {
        const s = buildingOutcomeStyle('destroyed');
        expect(s.color).toBe('#dc2626');
        expect(s.fill).toBe(false);
        expect(s.dashArray).toBeTruthy();
    });

    it('cut is orange, tunnelled is yellow, untouched is blue', () => {
        expect(buildingOutcomeStyle('cut').fillColor).toBe('#f97316');
        expect(buildingOutcomeStyle('tunnelled').fillColor).toBe('#eab308');
        expect(buildingOutcomeStyle(null).fillColor).toBe('blue');
        expect(buildingOutcomeStyle(undefined).color).toBe('blue');
    });
});
