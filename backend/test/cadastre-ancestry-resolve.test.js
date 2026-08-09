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
    require('../../frontend/js/proposal-parcel-identity.js');
    ancestry = require('../../frontend/js/proposals/cadastre-ancestry.js');
});

beforeEach(() => {
    const base = fakeLayer(A);
    const derived = fakeLayer(B);
    const consumed = fakeLayer(CONSUMED);
    const broken = { toGeoJSON: () => { throw new Error('cannot serialise'); } };
    globalThis.getParcelLayerIdMap = () => new Map([
        ['HR-1-1', base],
        ['HR-1-2#p-road-1', derived],
        ['HR-1-3', consumed],
        ['broken', broken]
    ]);
    const visible = new Set([base, derived, broken]);
    globalThis.parcelLayer = { hasLayer: layer => visible.has(layer) };
});

describe('loadedLiveParcels', () => {
    it('keeps derived slices, drops consumed parents and unserialisable layers', () => {
        const live = ancestry.loadedLiveParcels();
        expect(live.map(p => p.id).sort()).toEqual(['HR-1-1', 'HR-1-2#p-road-1']);
    });
});

describe('loadedCadastreParcels', () => {
    it('rejects both current and legacy synthetic parcel ids', () => {
        const base = fakeLayer(A);
        const currentDerived = fakeLayer(B);
        const legacyDerived = fakeLayer(B);
        globalThis.getParcelLayerIdMap = () => new Map([
            ['HR-1-1', base],
            ['HR-1-2#p-road-1', currentDerived],
            ['HR-339270-824_proposal_9', legacyDerived]
        ]);
        expect(ancestry.loadedCadastreParcels().map(item => item.id)).toEqual(['HR-1-1']);
    });
});

describe('computeCadastreParcelIds', () => {
    it('publishes geometry-derived cadastral ids and ignores stale declarations', () => {
        const base = fakeLayer(A);
        globalThis.getParcelLayerIdMap = () => new Map([['HR-1-1', base]]);
        const proposal = {
            parentParcelIds: ['HR-stale'],
            structureProposal: { geometry: A.geometry }
        };
        expect(ancestry.computeCadastreParcelIds(proposal)).toEqual(['HR-1-1']);
    });

    it('refuses when loaded cadastre covers less than 95% of the footprint', () => {
        const base = fakeLayer(A);
        globalThis.getParcelLayerIdMap = () => new Map([['HR-1-1', base]]);
        const proposal = {
            parentParcelIds: ['HR-1-1'],
            structureProposal: { geometry: square(16.000, 46.000, 16.002, 46.001).geometry }
        };
        expect(() => ancestry.computeCadastreParcelIds(proposal)).toThrow(/cover only 50%/);
    });

    it('refuses records without authored geometry instead of using declared ids', () => {
        expect(() => ancestry.computeCadastreParcelIds({ parentParcelIds: ['HR-1-1'] }))
            .toThrow(/no usable authored footprint/);
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

describe('loadedLiveParcels — visible fabric only', () => {
    it('excludes hidden registry entries without inferring state from id prefixes', () => {
        const parent = fakeLayer(A);
        const childA = fakeLayer(A);
        const childB = fakeLayer(B);
        const unrelated = fakeLayer(B);
        globalThis.getParcelLayerIdMap = () => new Map([
            ['HR-1-824', parent],
            ['HR-1-824#c-sub-1', childA],
            ['HR-1-824#c-sub-2', childB],
            ['HR-1-9', unrelated]
        ]);
        const visible = new Set([childA, childB, unrelated]);
        globalThis.parcelLayer = { hasLayer: layer => visible.has(layer) };
        const ids = ancestry.loadedLiveParcels().map(p => p.id).sort();
        expect(ids).toEqual(['HR-1-824#c-sub-1', 'HR-1-824#c-sub-2', 'HR-1-9']);
    });

    it('does not heal a non-conforming visible partition from identifier ancestry', () => {
        const base = fakeLayer(A);
        const first = fakeLayer(A);
        const second = fakeLayer(B);
        globalThis.getParcelLayerIdMap = () => new Map([
            ['HR-1-5', base],
            ['HR-1-5#p-a-1', first],
            ['HR-1-5#p-a-1#p-b-1', second]
        ]);
        globalThis.parcelLayer = { hasLayer: () => true };
        const ids = ancestry.loadedLiveParcels().map(p => p.id);
        expect(ids).toEqual(['HR-1-5', 'HR-1-5#p-a-1', 'HR-1-5#p-a-1#p-b-1']);
    });
});
