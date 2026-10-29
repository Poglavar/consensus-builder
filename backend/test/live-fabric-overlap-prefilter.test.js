// The live-fabric overlap check refuses to cut against a corrupted partition: two live parents may
// touch at their borders but may never overlap in area. It did that by testing every pair, which is
// 218,130 boolean operations for a 661-parcel corridor and measured 3.39 s of a 5.1 s apply.
//
// It now skips pairs whose bounding boxes are disjoint. That is safe by construction — two polygons
// with disjoint boxes cannot intersect — but "safe by construction" is exactly the kind of claim
// that should be able to fail a test, because the whole guard is worthless if the prefilter ever
// skips a real overlap. So the pin here is the REFUSAL, not the speed: a genuine double-cover must
// still be caught, and neighbours that merely share an edge must still be allowed.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');
const arrangement = require('../../frontend/js/proposals/parcel-arrangement.js');

const box = (west, south, width, height) => ({
    type: 'Feature',
    properties: {},
    geometry: {
        type: 'Polygon',
        coordinates: [[
            [west, south], [west + width, south],
            [west + width, south + height], [west, south + height], [west, south]
        ]]
    }
});

const originals = {};
const install = (name, value) => {
    if (!(name in originals)) originals[name] = globalThis[name];
    globalThis[name] = value;
};

let features;
let sourceFacts;

beforeEach(() => {
    install('turf', turf);
    install('window', { turf });
    install('updateStatus', () => {});
    sourceFacts = new Map();
    install('CadastralParcelRepository', {
        getMany: ids => ids.map(id => sourceFacts.get(id)).filter(Boolean)
    });
});

afterEach(() => {
    Object.keys(originals).forEach(name => {
        if (originals[name] === undefined) delete globalThis[name];
        else globalThis[name] = originals[name];
    });
});

function resolve(footprintOverride = null) {
    features.forEach((feature, index) => {
        feature.properties.parcelId ||= `live-${index}`;
        feature.properties.cadastreParcelIds ||= [`HR-${index}`];
    });
    const footprint = footprintOverride || turf.multiPolygon(features.flatMap(feature => (
        feature.geometry.type === 'MultiPolygon'
            ? feature.geometry.coordinates
            : [feature.geometry.coordinates]
    )));
    const fabricDraft = {
        entriesForCadastre: () => features,
        getMany: ids => ({
            features: features.filter(feature => ids.includes(feature.properties.parcelId)),
            missingIds: []
        })
    };
    const wholeParcels = (shape, entries) => entries.map(entry => {
        const hit = turf.intersect(shape, entry.feature);
        return { id: entry.id, area: hit ? turf.area(hit) : 0 };
    }).filter(hit => hit.area >= 0.25);
    window.__planOrder = {
        footprintOf: () => footprint,
        computeBaseAncestry: wholeParcels,
        measureCoverage: (shape, entries) => {
            const hits = wholeParcels(shape, entries);
            return { hits, coveredArea: hits.reduce((sum, hit) => sum + hit.area, 0) };
        }
    };
    const harness = Object.create(ProposalManager);
    harness._setLastApplyFailure = () => {};
    return ProposalManager._resolveLiveFormationParents.call(harness, {
        proposalId: 'x',
        cadastreParcelIds: features.map((_, index) => `HR-${index}`)
    }, 'x', 'road', { _parcelMutation: { fabric: fabricDraft } });
}

describe('a corrupted partition is still refused', () => {
    it('catches two parcels that genuinely overlap', () => {
        features = [box(15.90, 43.73, 0.001, 0.001), box(15.9005, 43.7305, 0.001, 0.001)];
        const result = resolve();
        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/overlap/);
    });

    it('catches an overlap buried among many disjoint neighbours', () => {
        // 60 parcels in a row that only touch, plus one pair that truly overlaps at the far end.
        features = Array.from({ length: 60 }, (_, i) => box(15.90 + i * 0.001, 43.73, 0.001, 0.001));
        features.push(box(15.90 + 59 * 0.001 + 0.0003, 43.73, 0.001, 0.001));
        const result = resolve();
        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/overlap/);
    });
});

describe('overlap inherited from immutable cadastral source outlines', () => {
    it('allows distinct roots whose live overlap stays inside the source overlap', () => {
        const left = box(15.90, 43.73, 0.002, 0.001);
        const right = box(15.901, 43.73, 0.002, 0.001);
        sourceFacts.set('HR-0', left);
        sourceFacts.set('HR-1', right);
        features = [left, right].map(feature => structuredClone(feature));
        expect(resolve(box(15.90, 43.73, 0.003, 0.001)).ok).toBe(true);
    });

    it('refuses a derived overlap outside the two source outlines', () => {
        sourceFacts.set('HR-0', box(15.90, 43.73, 0.002, 0.001));
        sourceFacts.set('HR-1', box(15.901, 43.73, 0.002, 0.001));
        features = [box(15.90, 43.73, 0.002, 0.001), box(15.9005, 43.73, 0.0025, 0.001)];
        expect(resolve(box(15.90, 43.73, 0.003, 0.001)).ok).toBe(false);
    });

    it('fails closed when either immutable source fact is unavailable', () => {
        sourceFacts.set('HR-0', box(15.90, 43.73, 0.002, 0.001));
        features = [box(15.90, 43.73, 0.002, 0.001), box(15.901, 43.73, 0.002, 0.001)];
        expect(resolve(box(15.90, 43.73, 0.003, 0.001)).ok).toBe(false);
    });

    it('still refuses two derived pieces sharing the same cadastral anchor', () => {
        const source = box(15.90, 43.73, 0.003, 0.001);
        sourceFacts.set('HR-0', source);
        features = [box(15.90, 43.73, 0.002, 0.001), box(15.901, 43.73, 0.002, 0.001)];
        features[1].properties.cadastreParcelIds = ['HR-0'];
        expect(resolve(source).ok).toBe(false);
    });

    it('does not let double-counted source overlap hide uncovered ground', () => {
        const left = box(15.90, 43.73, 0.002, 0.001);
        const right = box(15.901, 43.73, 0.002, 0.001);
        sourceFacts.set('HR-0', left);
        sourceFacts.set('HR-1', right);
        features = [left, right].map(feature => structuredClone(feature));
        const result = resolve(box(15.90, 43.73, 0.004, 0.001));
        expect(result.ok).toBe(false);
        expect(result.coverage).toBeCloseTo(0.75, 2);
    });

    it('handles a source outline with disconnected ground and a hole', () => {
        const left = box(15.90, 43.73, 0.002, 0.002);
        left.geometry = { type: 'MultiPolygon', coordinates: [
            [left.geometry.coordinates[0], [[15.9006, 43.7306], [15.901, 43.7306], [15.901, 43.731], [15.9006, 43.731], [15.9006, 43.7306]]],
            box(15.905, 43.73, 0.001, 0.001).geometry.coordinates
        ] };
        const right = box(15.901, 43.73, 0.002, 0.002);
        sourceFacts.set('HR-0', left);
        sourceFacts.set('HR-1', right);
        features = [structuredClone(left), structuredClone(right)];
        const footprint = box(15.9012, 43.7302, 0.0004, 0.0004);
        expect(resolve(footprint).ok).toBe(true);
    });

    it('allows successive cuts of the same overlapping source outlines', () => {
        const left = box(15.90, 43.73, 0.002, 0.001);
        const right = box(15.901, 43.73, 0.002, 0.001);
        sourceFacts.set('HR-0', left);
        sourceFacts.set('HR-1', right);
        features = [left, right].map(feature => structuredClone(feature));
        const first = box(15.9002, 43.7301, 0.0004, 0.0008);
        expect(resolve(first).ok).toBe(true);
        features = features.map((feature, index) => {
            const remainder = turf.difference(feature, first);
            remainder.properties.cadastreParcelIds = [`HR-${index}`];
            return remainder;
        });
        const second = box(15.9012, 43.7301, 0.0004, 0.0008);
        expect(resolve(second).ok).toBe(true);
    });

    it('checks a merged feature against the union of its distinct source anchors', () => {
        const first = box(15.90, 43.73, 0.001, 0.001);
        const second = box(15.901, 43.73, 0.001, 0.001);
        const third = box(15.9015, 43.73, 0.001, 0.001);
        sourceFacts.set('HR-0', first);
        sourceFacts.set('HR-1', second);
        sourceFacts.set('HR-2', third);
        const merged = turf.union(first, second);
        merged.properties.cadastreParcelIds = ['HR-0', 'HR-1'];
        third.properties.cadastreParcelIds = ['HR-2'];
        features = [merged, third];
        expect(resolve(box(15.90, 43.73, 0.0025, 0.001)).ok).toBe(true);
    });
});

describe('an honest partition still passes', () => {
    it('allows neighbours that share an edge but enclose no common area', () => {
        features = [box(15.90, 43.73, 0.001, 0.001), box(15.901, 43.73, 0.001, 0.001)];
        expect(resolve().ok).toBe(true);
    });

    it('allows a long run of tiling parcels — the corridor case', () => {
        features = Array.from({ length: 120 }, (_, i) => box(15.90 + i * 0.001, 43.73, 0.001, 0.001));
        expect(resolve().ok).toBe(true);
    });

    it('allows parcels that are far apart', () => {
        features = [box(15.90, 43.73, 0.001, 0.001), box(16.50, 44.10, 0.001, 0.001)];
        expect(resolve().ok).toBe(true);
    });

    it('uses the hardened parcel clipper when raw Turf rejects last-bit Sibenik geometry', () => {
        const west = 15.873701234414993;
        features = [
            box(west, 43.754, 0.001, 0.001),
            box(west + 0.001, 43.754, 0.001, 0.001)
        ];
        const fragileTurf = {
            ...turf,
            intersect(left) {
                const x = left.geometry.coordinates[0][0][0];
                if (x !== Number(x.toFixed(9))) {
                    throw new Error('Unable to complete output ring');
                }
                return null;
            }
        };
        globalThis.turf = fragileTurf;
        window.turf = fragileTurf;
        window.__parcelArrangement = {
            clip: vi.fn((operation, left, right) => arrangement.clip(operation, left, right)),
            // The uncovered-footprint test (geometry-tolerances.js uncoveredBy) runs the shared clip too.
            clipWith: (...args) => arrangement.clipWith(...args)
        };

        const result = resolve();

        expect(result.ok).toBe(true);
        expect(window.__parcelArrangement.clip).toHaveBeenCalledWith('intersect', features[0], features[1]);
    });
});
