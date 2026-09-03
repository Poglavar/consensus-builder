// The drill stack orders current Fabric parcels and current proposal claims. It must never parse a
// generated ID to manufacture historical levels.

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let drill;

beforeAll(() => {
    drill = require('../../frontend/js/proposals/drill-stack.js');
});

function rect(minX, minY, maxX, maxY, properties = {}) {
    return {
        type: 'Feature', properties,
        geometry: {
            type: 'Polygon',
            coordinates: [[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]]]
        }
    };
}

function pipRect(pt, poly) {
    const [x, y] = pt.geometry.coordinates;
    const ring = poly.geometry.coordinates[0];
    const xs = ring.map(value => value[0]);
    const ys = ring.map(value => value[1]);
    return x >= Math.min(...xs) && x <= Math.max(...xs)
        && y >= Math.min(...ys) && y <= Math.max(...ys);
}

const context = overrides => ({ parcels: [], proposals: [], pointInPolygon: pipRect, ...overrides });

describe('flat drill stack', () => {
    it('orders content above live output and its ground-authoring proposal', () => {
        const liveId = 'opaque-live-parcel';
        const stack = drill.buildDrillStack([5, 5], context({
            parcels: [{
                id: liveId,
                feature: rect(0, 0, 10, 10, { producedByProposalId: 'readjustment' }),
                live: true
            }],
            proposals: [
                { key: 'readjustment', proposal: { goal: 'reparcellization' }, footprint: rect(0, 0, 10, 10) },
                { key: 'building', proposal: { goal: 'buildings' }, footprint: rect(2, 2, 8, 8) }
            ]
        }));
        expect(stack.map(entry => entry.kind === 'proposal' ? entry.key : entry.id))
            .toEqual(['building', liveId, 'readjustment']);
        expect(stack.map(entry => entry.depth)).toEqual([1.5, 1, 0.5]);
    });

    it('places a road above both raw ground and its own corridor parcel', () => {
        for (const feature of [
            rect(0, 0, 10, 10),
            rect(0, 0, 10, 10, { producedByProposalId: 'road' })
        ]) {
            const stack = drill.buildDrillStack([5, 5], context({
                parcels: [{ id: 'id-with#arbitrary-spelling', feature, live: true }],
                proposals: [{ key: 'road', proposal: { goal: 'road-track' }, footprint: rect(0, 0, 10, 10) }]
            }));
            expect(stack[0].key).toBe('road');
            expect(stack[0].depth).toBe(1.5);
        }
    });

    it('does not infer a producer or level from ID punctuation', () => {
        const feature = rect(0, 0, 10, 10);
        const stack = drill.buildDrillStack([5, 5], context({
            parcels: [{ id: 'official#cadastre-id', feature, live: true }]
        }));
        expect(stack[0]).toEqual(expect.objectContaining({
            id: 'official#cadastre-id', producerId: null, depth: 0
        }));
        expect(drill.parcelDepth).toBeUndefined();
        expect(drill.mintingProposalIdOf).toBeUndefined();
    });

    it('drops parcels outside the committed live partition', () => {
        const stack = drill.buildDrillStack([5, 5], context({
            parcels: [{ id: 'old', feature: rect(0, 0, 10, 10), live: false }]
        }));
        expect(stack).toEqual([]);
    });

    it('breaks same-level proposal ties by creation time', () => {
        const stack = drill.buildDrillStack([5, 5], context({
            parcels: [{ id: 'ground', feature: rect(0, 0, 10, 10), live: true }],
            proposals: [
                { key: 'old', proposal: { goal: 'park', createdAt: '2026-01-01T00:00:00Z' }, footprint: rect(0, 0, 10, 10) },
                { key: 'new', proposal: { goal: 'square', createdAt: '2026-02-01T00:00:00Z' }, footprint: rect(0, 0, 10, 10) }
            ]
        }));
        expect(stack.map(entry => entry.kind === 'proposal' ? entry.key : entry.id))
            .toEqual(['new', 'old', 'ground']);
    });

    it('keeps any ground-authoring proposal below foreign live Fabric output', () => {
        const stack = drill.buildDrillStack([5, 5], context({
            parcels: [{
                id: 'corridor-body',
                feature: rect(0, 0, 10, 10, { producedByProposalId: 'road', isCorridor: true }),
                live: true
            }],
            proposals: [
                { key: 'road', proposal: { goal: 'road-track' }, footprint: rect(0, 0, 10, 10) },
                { key: 'readjustment', proposal: { goal: 'reparcellization' }, footprint: rect(0, 0, 10, 10) }
            ]
        }));
        expect(stack.map(entry => entry.kind === 'proposal' ? entry.key : entry.id))
            .toEqual(['road', 'corridor-body', 'readjustment']);
    });

    it('misses cleanly and honours a precomputed footprint', () => {
        let computed = 0;
        const stack = drill.buildDrillStack([50, 50], context({
            proposals: [{ key: 'park', proposal: { goal: 'park' }, footprint: rect(0, 0, 10, 10) }],
            footprintOf: () => { computed += 1; return rect(40, 40, 60, 60); }
        }));
        expect(stack).toEqual([]);
        expect(computed).toBe(0);
    });
});
