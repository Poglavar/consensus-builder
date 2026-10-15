// Headless checks for spend limits and the pilot's required observable improvement.
import { describe, expect, it } from 'vitest';
import { initialTier, openTargets, safeTransition, budgetedPrefix, pilotMadeProgress, bboxAroundPoints } from '../scripts/lib/junction-batch.js';

const graph = (connections = []) => ({
    nodes: [{ id: 'n', degree: 3 }],
    lanes: [{ id: 'incoming', type: 'driving', direction: 'forward', access: 'yes', toNode: 'n' }],
    connections, problems: [], stats: { turnRestrictions: { violations: 0 } }
});
describe('junction batch guards', () => {
    it('crops around every verified target instead of the surrounding road-group centroid', () => {
        const points = [[16,46],[16.001,45.998]];
        const bbox = bboxAroundPoints(points);
        for (const [lng,lat] of points) {
            expect(lng).toBeGreaterThan(bbox[0]); expect(lng).toBeLessThan(bbox[2]);
            expect(lat).toBeGreaterThan(bbox[1]); expect(lat).toBeLessThan(bbox[3]);
        }
        expect(() => bboxAroundPoints([[16,null]])).toThrow(/coordinates/);
        expect(() => bboxAroundPoints([[16,NaN]])).toThrow(/coordinates/);
    });
    it('uses cheaper reasoning for small junctions and reserves the hardest tier for complex ones', () => {
        expect(initialTier({ arms: 3, lanes: 12, nodeIds: ['n'] })).toBe('standard');
        expect(initialTier({ arms: 6, lanes: 25, nodeIds: ['n'] })).toBe('advanced');
        expect(initialTier({ arms: 10, lanes: 55, nodeIds: ['n'] })).toBe('hardest');
        expect(initialTier({ arms: 3, lanes: 10, problems: [{ reason: 'approach_reaches_nothing' }] })).toBe('hardest');
    });
    it('does not mistake a connected node for one with every incoming lane assigned', () => {
        expect(openTargets(graph([{ nodeId: 'n', fromLaneId: 'other' }]), ['n'])).toEqual(['n']);
        expect(openTargets(graph([{ nodeId: 'n', fromLaneId: 'incoming' }]), ['n'])).toEqual([]);
    });
    it('rejects new error identities, forbidden turns, and newly missing incoming assignments', () => {
        const parent = graph([{ nodeId: 'n', fromLaneId: 'incoming' }]);
        expect(safeTransition(parent, parent)).toBe(true);
        expect(safeTransition(parent, graph())).toBe(false);
        expect(safeTransition(parent, { ...parent, problems: [{ id: 'new-error', severity: 'error' }] })).toBe(false);
        expect(safeTransition(parent, { ...parent, stats: { turnRestrictions: { violations: 1 } } })).toBe(false);
    });
    it('reserves the entire maximum charge before submission', () => {
        expect(budgetedPrefix([{ ceilingUsd: 3 }, { ceilingUsd: 4 }, { ceilingUsd: 2 }], 6))
            .toEqual({ selected: [{ ceilingUsd: 3 }], reserved: 3 });
        expect(() => budgetedPrefix([{ ceilingUsd: null }], 10)).toThrow(/Unknown/);
        expect(() => budgetedPrefix([{ ceilingUsd: 1 }], NaN)).toThrow(/budget/);
    });
    it('requires a safe reduction in unresolved targets before expanding a pilot', () => {
        expect(pilotMadeProgress([{ safe: true, remainingBefore: 2, remainingAfter: 2 }])).toBe(false);
        expect(pilotMadeProgress([{ safe: false, remainingBefore: 2, remainingAfter: 0 }])).toBe(false);
        expect(pilotMadeProgress([{ safe: true, remainingBefore: 2, remainingAfter: 1 }])).toBe(true);
        expect(pilotMadeProgress([{ safe: true, remainingBefore: 2, remainingAfter: 1, error: 'readback failed' }])).toBe(false);
    });
});
