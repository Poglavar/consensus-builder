// The live-fabric overlap check refuses to cut against a corrupted partition: two live parents may
// touch at their borders but may never overlap in area. It did that by testing every pair, which is
// 218,130 boolean operations for a 661-parcel corridor and measured 3.39 s of a 5.1 s apply.
//
// It now skips pairs whose bounding boxes are disjoint. That is safe by construction — two polygons
// with disjoint boxes cannot intersect — but "safe by construction" is exactly the kind of claim
// that should be able to fail a test, because the whole guard is worthless if the prefilter ever
// skips a real overlap. So the pin here is the REFUSAL, not the speed: a genuine double-cover must
// still be caught, and neighbours that merely share an edge must still be allowed.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');

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

beforeEach(() => {
    install('turf', turf);
    install('window', {
        __cadastreAncestry: {
            resolveParentsByGeometry: () => ({ ids: features.map((_, i) => 'p' + i), coverage: 1 })
        },
        // The last gate after the overlap check: resolved ground must carry cadastral anchors.
        __formationEdit: { baseIdsOfFeatures: fs => fs.map((_, i) => 'HR-330337-' + i) }
    });
    install('updateStatus', () => {});
});

afterEach(() => {
    Object.keys(originals).forEach(name => {
        if (originals[name] === undefined) delete globalThis[name];
        else globalThis[name] = originals[name];
    });
});

function resolve() {
    const harness = Object.create(ProposalManager);
    harness._resolveParcelFeaturesByIds = () => features;
    harness._setLastApplyFailure = () => {};
    return ProposalManager._resolveLiveFormationParents.call(harness, { proposalId: 'x' }, 'x', 'road');
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
});
