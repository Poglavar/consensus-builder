// resolveParentsByGeometry / loadedLiveParcels: the map-facing half of ghost re-parenting
// (rethink-proposals.md §3.1). A shared payload can name derived parents this browser never
// minted; the resolver must find the LIVE parcels its footprint covers — derived slices included,
// consumed parents excluded — and report coverage honestly so callers can refuse low-coverage
// renames.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');

let ancestry;

// Two adjacent ~77m × 111m squares; a third square duplicates A's footprint but is consumed.
const square = (w, s, e, n) => turf.polygon([[[w, s], [e, s], [e, n], [w, n], [w, s]]]);
const A = square(16.000, 46.000, 16.001, 46.001);           // base parcel
const B = square(16.001, 46.000, 16.002, 46.001);           // live DERIVED slice
const CONSUMED = square(16.000, 46.000, 16.001, 46.001);    // replaced by children — must be skipped

const fakeLayer = (feature) => ({ toGeoJSON: () => feature });

beforeAll(() => {
    globalThis.turf = turf;
    ancestry = require('../../frontend/js/proposals/cadastre-ancestry.js');
});

beforeEach(() => {
    globalThis.getParcelLayerIdMap = () => new Map([
        ['HR-1-1', fakeLayer(A)],
        ['HR-1-2#p-road-1', fakeLayer(B)],
        ['HR-1-3', fakeLayer(CONSUMED)],
        ['broken', { toGeoJSON: () => { throw new Error('cannot serialise'); } }]
    ]);
    globalThis.isParcelReplacedByChildren = (id) => id === 'HR-1-3';
});

describe('loadedLiveParcels', () => {
    it('keeps derived slices, drops consumed parents and unserialisable layers', () => {
        const live = ancestry.loadedLiveParcels();
        expect(live.map(p => p.id).sort()).toEqual(['HR-1-1', 'HR-1-2#p-road-1']);
    });
});

describe('resolveParentsByGeometry', () => {
    it('resolves a footprint spanning base and derived fabric, with full coverage', () => {
        const proposal = { structureProposal: { geometry: square(16.000, 46.000, 16.002, 46.001).geometry } };
        const result = ancestry.resolveParentsByGeometry(proposal);
        expect(result.ids.sort()).toEqual(['HR-1-1', 'HR-1-2#p-road-1']);
        expect(result.coverage).toBeGreaterThan(0.99);
    });

    it('reports low coverage when half the footprint has no live fabric under it', () => {
        const proposal = { structureProposal: { geometry: square(16.001, 46.000, 16.003, 46.001).geometry } };
        const result = ancestry.resolveParentsByGeometry(proposal);
        expect(result.ids).toEqual(['HR-1-2#p-road-1']);
        expect(result.coverage).toBeGreaterThan(0.45);
        expect(result.coverage).toBeLessThan(0.55);
    });

    it('never resolves onto a consumed parent, even when the geometry matches it exactly', () => {
        const proposal = { structureProposal: { geometry: square(16.000, 46.000, 16.001, 46.001).geometry } };
        const result = ancestry.resolveParentsByGeometry(proposal);
        expect(result.ids).toEqual(['HR-1-1']);
        expect(result.ids).not.toContain('HR-1-3');
    });

    it('returns empty and zero coverage for a proposal with no usable geometry', () => {
        expect(ancestry.resolveParentsByGeometry({})).toEqual({ ids: [], coverage: 0 });
        expect(ancestry.resolveParentsByGeometry(null)).toEqual({ ids: [], coverage: 0 });
    });
});

describe('loadedLiveParcels — structural consumption', () => {
    it('excludes a parent whose derived children are live, even when the replaced flag lies', () => {
        // The 97-104 replay measured exactly this: base 824 stayed layer-ready and unreplaced
        // next to its own subdivision slices. The id structure is the ground truth.
        globalThis.getParcelLayerIdMap = () => new Map([
            ['HR-1-824', fakeLayer(A)],
            ['HR-1-824#c-sub-1', fakeLayer(A)],
            ['HR-1-824#c-sub-2', fakeLayer(B)],
            ['HR-1-9', fakeLayer(B)]
        ]);
        globalThis.isParcelReplacedByChildren = () => false; // the lying flag
        const ids = ancestry.loadedLiveParcels().map(p => p.id).sort();
        expect(ids).toEqual(['HR-1-824#c-sub-1', 'HR-1-824#c-sub-2', 'HR-1-9']);
    });

    it('consumes every #-prefix of a nested derived id', () => {
        globalThis.getParcelLayerIdMap = () => new Map([
            ['HR-1-5', fakeLayer(A)],
            ['HR-1-5#p-a-1', fakeLayer(A)],
            ['HR-1-5#p-a-1#p-b-1', fakeLayer(B)]
        ]);
        globalThis.isParcelReplacedByChildren = () => false;
        const ids = ancestry.loadedLiveParcels().map(p => p.id);
        expect(ids).toEqual(['HR-1-5#p-a-1#p-b-1']);
    });
});
