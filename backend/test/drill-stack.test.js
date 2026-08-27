// drill-stack.js — the vertical stack at one map point, ordered top → ground: content
// proposals above the slices they stand on, the formation that minted the slices between
// them and the base cadastral parcels, everything else by derivation depth.

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let drill;

beforeAll(() => {
    drill = require('../../frontend/js/proposals/drill-stack.js');
});

// Axis-aligned test fixtures: pointInPolygon is a bbox test, which is exact for rectangles.
function rect(minX, minY, maxX, maxY, properties = {}) {
    return {
        type: 'Feature',
        properties,
        geometry: {
            type: 'Polygon',
            coordinates: [[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]]]
        }
    };
}

function pipRect(pt, poly) {
    const [x, y] = pt.geometry.coordinates;
    const rings = poly.geometry.type === 'Polygon'
        ? [poly.geometry.coordinates[0]]
        : poly.geometry.coordinates.map(p => p[0]);
    return rings.some(ring => {
        const xs = ring.map(p => p[0]);
        const ys = ring.map(p => p[1]);
        return x >= Math.min(...xs) && x <= Math.max(...xs)
            && y >= Math.min(...ys) && y <= Math.max(...ys);
    });
}

const BASE_ID = 'HR-335550-1804/1';
const SLICE_ID = `${BASE_ID}#c-rep-1`;

function ctxWith(overrides = {}) {
    return { parcels: [], proposals: [], pointInPolygon: pipRect, ...overrides };
}

describe('parcelDepth / mintingProposalIdOf', () => {
    it('counts derivation generations', () => {
        expect(drill.parcelDepth(BASE_ID)).toBe(0);
        expect(drill.parcelDepth(SLICE_ID)).toBe(1);
        expect(drill.parcelDepth(`${SLICE_ID}#c-road-2`)).toBe(2);
    });

    it('parses the minting proposal id from both id generations', () => {
        expect(drill.mintingProposalIdOf(`${BASE_ID}#c-abc123-4`)).toBe('c-abc123');
        expect(drill.mintingProposalIdOf(`${BASE_ID}#c2-abc123-4`)).toBe('c2-abc123');
        expect(drill.mintingProposalIdOf(`${BASE_ID}#p-1mkonr8j4t2-1`)).toBe('p-1mkonr8j4t2');
        expect(drill.mintingProposalIdOf(BASE_ID)).toBe(null);
    });
});

describe('buildDrillStack', () => {
    it('orders the visible chain without resurrecting its consumed cadastral base', () => {
        const stack = drill.buildDrillStack([5, 5], ctxWith({
            parcels: [
                { id: BASE_ID, feature: rect(0, 0, 10, 10), live: false },
                { id: SLICE_ID, feature: rect(0, 0, 10, 10, { producedByProposalId: 'c-rep' }), live: true }
            ],
            proposals: [
                {
                    key: 'c-rep',
                    proposal: { goal: 'reparcellization', createdAt: '2026-07-18T20:00:00Z', parentParcelIds: [BASE_ID] },
                    footprint: rect(0, 0, 10, 10)
                },
                {
                    key: 'c-bldg',
                    proposal: { goal: 'buildings', createdAt: '2026-07-18T21:00:00Z', parentParcelIds: [SLICE_ID] },
                    footprint: rect(2, 2, 8, 8)
                }
            ]
        }));
        expect(stack.map(e => e.kind === 'proposal' ? e.key : e.id)).toEqual([
            'c-bldg', SLICE_ID, 'c-rep'
        ]);
        expect(stack[0].depth).toBe(1.5);
        expect(stack[1].depth).toBe(1);
        expect(stack[2].depth).toBe(0.5);
    });

    it('includes roads: a road over base ground sits above the base parcel', () => {
        const stack = drill.buildDrillStack([5, 5], ctxWith({
            parcels: [{ id: BASE_ID, feature: rect(0, 0, 10, 10), live: true }],
            proposals: [{
                key: 'c-road',
                proposal: { goal: 'road-track', parentParcelIds: [BASE_ID] },
                footprint: rect(0, 4, 10, 6)
            }]
        }));
        expect(stack.map(e => e.kind === 'proposal' ? e.key : e.id)).toEqual(['c-road', BASE_ID]);
    });

    it('places a road ABOVE its own corridor parcel — that parcel is the road\'s body', () => {
        const stack = drill.buildDrillStack([5, 5], ctxWith({
            parcels: [{ id: `${BASE_ID}#c-road-1`, feature: rect(0, 0, 10, 10, { producedByProposalId: 'c-road' }), live: true }],
            proposals: [{
                key: 'c-road',
                proposal: { goal: 'road-track' },
                footprint: rect(0, 0, 10, 10)
            }]
        }));
        expect(stack.map(e => e.kind === 'proposal' ? e.key : e.id)).toEqual(['c-road', `${BASE_ID}#c-road-1`]);
        expect(stack[0].depth).toBe(1.5);
    });

    it('places a ground-authoring formation below the slices it produced', () => {
        const stack = drill.buildDrillStack([5, 5], ctxWith({
            parcels: [
                { id: SLICE_ID, feature: rect(0, 0, 10, 10, { producedByProposalId: 'c-rep' }), live: true }
            ],
            proposals: [{
                key: 'c-rep',
                proposal: { goal: 'reparcellization' },
                footprint: rect(0, 0, 10, 10)
            }]
        }));
        expect(stack.map(e => e.kind === 'proposal' ? e.key : e.id)).toEqual([SLICE_ID, 'c-rep']);
    });

    it('falls back to id parsing when producer provenance is missing', () => {
        const stack = drill.buildDrillStack([5, 5], ctxWith({
            parcels: [{ id: SLICE_ID, feature: rect(0, 0, 10, 10), live: true }],
            proposals: [{
                key: 'c-rep',
                proposal: { goal: 'reparcellization' },
                footprint: rect(0, 0, 10, 10)
            }]
        }));
        expect(stack[0].id).toBe(SLICE_ID);
        expect(stack[1].key).toBe('c-rep');
        expect(stack[1].depth).toBe(0.5);
    });

    it('drops every parcel outside the live partition, including consumed cadastre', () => {
        const stack = drill.buildDrillStack([5, 5], ctxWith({
            parcels: [
                { id: BASE_ID, feature: rect(0, 0, 10, 10), live: false },
                { id: `${BASE_ID}#c-old-1`, feature: rect(0, 0, 10, 10), live: false }
            ]
        }));
        expect(stack).toEqual([]);
    });

    it('breaks same-depth proposal ties by creation time, later on top', () => {
        const older = {
            key: 'c-old',
            proposal: { goal: 'park', createdAt: '2026-07-01T00:00:00Z', parentParcelIds: [BASE_ID] },
            footprint: rect(0, 0, 10, 10)
        };
        const newer = {
            key: 'c-new',
            proposal: { goal: 'square', createdAt: '2026-07-02T00:00:00Z', parentParcelIds: [BASE_ID] },
            footprint: rect(0, 0, 10, 10)
        };
        const stack = drill.buildDrillStack([5, 5], ctxWith({
            parcels: [{ id: BASE_ID, feature: rect(0, 0, 10, 10), live: true }],
            proposals: [older, newer]
        }));
        expect(stack.map(e => e.kind === 'proposal' ? e.key : e.id)).toEqual(['c-new', 'c-old', BASE_ID]);
    });

    it('puts a re-based proposal with no declared parent here on top of the deepest ground', () => {
        const stack = drill.buildDrillStack([5, 5], ctxWith({
            parcels: [
                { id: SLICE_ID, feature: rect(0, 0, 10, 10, { producedByProposalId: 'c-rep' }), live: true }
            ],
            proposals: [{
                key: 'c-park',
                proposal: { goal: 'park', parentParcelIds: ['HR-000000-1/1'] },
                footprint: rect(0, 0, 10, 10)
            }]
        }));
        expect(stack[0].key).toBe('c-park');
        expect(stack[0].depth).toBe(1.5);
    });

    it('collects typology-level parents too', () => {
        const stack = drill.buildDrillStack([5, 5], ctxWith({
            parcels: [{ id: SLICE_ID, feature: rect(0, 0, 10, 10, { producedByProposalId: 'c-rep' }), live: true }],
            proposals: [{
                key: 'c-road',
                proposal: { goal: 'road-track', roadProposal: { parentParcelIds: [SLICE_ID] } },
                footprint: rect(0, 0, 10, 10)
            }]
        }));
        expect(stack[0].key).toBe('c-road');
        expect(stack[0].depth).toBe(1.5);
    });

    it('misses cleanly: a point outside everything returns an empty stack', () => {
        const stack = drill.buildDrillStack([50, 50], ctxWith({
            parcels: [{ id: BASE_ID, feature: rect(0, 0, 10, 10), live: true }],
            proposals: [{
                key: 'c-rep',
                proposal: { goal: 'reparcellization' },
                footprint: rect(0, 0, 10, 10)
            }]
        }));
        expect(stack).toEqual([]);
    });

    it('uses a provided footprint without calling footprintOf', () => {
        let called = 0;
        drill.buildDrillStack([5, 5], ctxWith({
            proposals: [{ key: 'c-x', proposal: { goal: 'park' }, footprint: rect(0, 0, 10, 10) }],
            footprintOf: () => { called += 1; return null; }
        }));
        expect(called).toBe(0);
    });

    // A degraded record can declare ANOTHER proposal's live slice as its parent (measured on
    // Cibona: a subdivision that once re-applied over a standing road kept the corridor slice
    // in parentParcelIds). Without the cap that parent lifted the reparcellization above the
    // road, so clicking the corridor selected the subdivision.
    it('a ground-authoring formation never outranks live fabric minted by another proposal', () => {
        const corridorId = `${BASE_ID}#c-road-1`;
        const stack = drill.buildDrillStack([5, 5], ctxWith({
            parcels: [
                { id: corridorId, feature: rect(0, 0, 10, 10, { producedByProposalId: 'c-road', isCorridor: true }), live: true },
                { id: BASE_ID, feature: rect(0, 0, 10, 10), live: false }
            ],
            proposals: [
                {
                    key: 'c-road',
                    proposal: { goal: 'road-track', createdAt: '2026-01-01T00:00:00Z', roadProposal: { parentParcelIds: [BASE_ID] } },
                    footprint: rect(0, 0, 10, 10)
                },
                {
                    // Newer, and (degraded) declaring the road's corridor slice as its parent —
                    // both of which used to win it the top of the stack.
                    key: 'c-rep',
                    proposal: { goal: 'reparcellization', createdAt: '2026-02-01T00:00:00Z', reparcellization: { parentParcelIds: [corridorId] } },
                    footprint: rect(0, 0, 10, 10)
                }
            ]
        }));
        const order = stack.map(e => e.kind === 'proposal' ? e.key : e.id);
        expect(order[0]).toBe('c-road');
        expect(order.indexOf('c-rep')).toBeGreaterThan(order.indexOf(corridorId));
    });

    it('the cap leaves a readjustment above the base pool parcels it stands on', () => {
        const stack = drill.buildDrillStack([5, 5], ctxWith({
            parcels: [{ id: BASE_ID, feature: rect(0, 0, 10, 10), live: true }],
            proposals: [{
                key: 'c-rep',
                proposal: { goal: 'reparcellization', reparcellization: { parentParcelIds: [BASE_ID] } },
                footprint: rect(0, 0, 10, 10)
            }]
        }));
        expect(stack[0].key).toBe('c-rep');
        expect(stack[0].depth).toBe(0.5);
    });
});
