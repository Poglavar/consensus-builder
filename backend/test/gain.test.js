// Unit tests for frontend/js/proposals/gain.js — the € value-gain math for the 3D view. This is
// the money number the panel shows, and it had no coverage while welded into three-mode.js.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const { dedupeCoincidentBuildings, computeParcelMetrics, computeGain } = require('../../frontend/js/proposals/gain.js');

// A small square building footprint at (lng,lat) with side ~ degrees, as a faces[] mesh entry.
function meshBuilding(lng, lat, zmin, zmax, side = 0.0005) {
    return {
        z_min: zmin, z_max: zmax,
        faces: [{ coordinates: [[[lng, lat], [lng + side, lat], [lng + side, lat + side], [lng, lat + side], [lng, lat]]] }]
    };
}

describe('dedupeCoincidentBuildings', () => {
    it('drops a coincident twin mesh (same footprint + z-extent)', () => {
        const a = meshBuilding(15.9, 45.8, 0, 12);
        const twin = meshBuilding(15.9, 45.8, 0, 12); // same place, same height
        expect(dedupeCoincidentBuildings([a, twin])).toHaveLength(1);
    });

    it('keeps buildings that differ in height or location', () => {
        const a = meshBuilding(15.9, 45.8, 0, 12);
        const taller = meshBuilding(15.9, 45.8, 0, 30);   // >1 m z-diff
        const elsewhere = meshBuilding(15.91, 45.81, 0, 12); // far away
        expect(dedupeCoincidentBuildings([a, taller, elsewhere])).toHaveLength(3);
    });

    it('passes through 0/1-element inputs untouched', () => {
        expect(dedupeCoincidentBuildings([])).toEqual([]);
        const one = [meshBuilding(15.9, 45.8, 0, 12)];
        expect(dedupeCoincidentBuildings(one)).toBe(one);
    });
});

describe('computeParcelMetrics', () => {
    const parcel = turf.polygon([[[15.9, 45.8], [15.902, 45.8], [15.902, 45.802], [15.9, 45.802], [15.9, 45.8]]]);
    const opts = {
        floorHeightM: 3.5,
        turf,
        footprintOf: (bld) => turf.polygon(bld.faces[0].coordinates),
        heightOf: (feat) => Number(feat.properties?.height) || 0
    };

    it('accumulates built volume from footprint ∩ parcel × z-extent', () => {
        const built = [meshBuilding(15.9005, 45.8005, 0, 10)];
        const m = computeParcelMetrics(parcel, built, [], opts);
        expect(m.builtVolume).toBeGreaterThan(0);
        expect(m.proposedVolume).toBe(0);
        expect(m.builtFloorArea).toBeCloseTo(m.builtVolume / 3.5, 6);
    });

    it('accumulates proposed volume from proposed features × their height', () => {
        const proposed = [turf.polygon(
            [[[15.9005, 45.8005], [15.9009, 45.8005], [15.9009, 45.8009], [15.9005, 45.8009], [15.9005, 45.8005]]],
            { height: 20 }
        )];
        const m = computeParcelMetrics(parcel, [], proposed, opts);
        expect(m.proposedVolume).toBeGreaterThan(0);
        expect(m.proposedFloorArea).toBeCloseTo(m.proposedVolume / 3.5, 6);
    });

    it('returns null without a parcel or turf', () => {
        expect(computeParcelMetrics(null, [], [], opts)).toBeNull();
        expect(computeParcelMetrics(parcel, [], [], { ...opts, turf: null })).toBeNull();
    });
});

describe('computeGain', () => {
    it('is (proposed − built) × price when there is proposed massing', () => {
        const g = computeGain({ builtFloorArea: 100, proposedFloorArea: 300, priceEurPerM2: 4000 });
        expect(g.gain).toBe((300 - 100) * 4000);
        expect(g.hasProposed).toBe(true);
    });

    it('reports current value (not a negative delta) when there is no proposed massing', () => {
        const g = computeGain({ builtFloorArea: 100, proposedFloorArea: 0, priceEurPerM2: 4000 });
        expect(g.hasProposed).toBe(false);
        expect(g.currentValue).toBe(100 * 4000);
        expect(g.avg).toBeNull();
    });

    it('is negative when a proposal reduces floor area (a real loss)', () => {
        const g = computeGain({ builtFloorArea: 300, proposedFloorArea: 100, priceEurPerM2: 4000 });
        expect(g.gain).toBeLessThan(0);
        expect(g.hasProposed).toBe(true);
    });

    it('computes per-parcel average only with proposed massing and a positive count', () => {
        expect(computeGain({ builtFloorArea: 0, proposedFloorArea: 400, priceEurPerM2: 1000, parcelCount: 4 }).avg)
            .toBe((400 * 1000) / 4);
        expect(computeGain({ builtFloorArea: 0, proposedFloorArea: 0, priceEurPerM2: 1000, parcelCount: 4 }).avg)
            .toBeNull();
    });
});
