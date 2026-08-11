// "Cannot publish: loaded cadastral parcels cover only 90% of the proposal footprint" is a number,
// and a number cannot be argued with — it does not say whether the missing ground is a real hole in
// the cadastre, a strip the fetch never delivered, or a rounding sliver along one edge.
//
// computeCoverageGap subtracts the parcels from the footprint and hands back what survives, so the
// answer can be painted on the map instead of asserted.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { computeCoverageGap } = require('../../frontend/js/publish-gap-debug.js');
const turf = require('@turf/turf');

const ops = {
    area: shape => { try { return turf.area(shape) || 0; } catch (_) { return 0; } },
    difference: (a, b) => { try { return turf.difference(a, b); } catch (_) { return a; } },
    intersectionArea: (a, b) => {
        try { const hit = turf.intersect(a, b); return hit ? (turf.area(hit) || 0) : 0; } catch (_) { return 0; }
    },
    explode: shape => {
        const geom = shape && shape.type === 'Feature' ? shape.geometry : shape;
        if (!geom) return [];
        if (geom.type !== 'MultiPolygon') return [shape];
        return geom.coordinates.map(rings => turf.polygon(rings));
    }
};

const D = 0.0001;
const x = n => 15.9 + n * D;
const y = n => 43.73 + n * D;
const rect = (x0, y0, x1, y1) => turf.polygon([[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]);

// A corridor-ish strip crossing four parcel widths.
const footprint = rect(x(0), y(0), x(12), y(1));

describe('computeCoverageGap', () => {
    it('fully covered ground leaves nothing behind', () => {
        const parcels = [rect(x(0), y(-1), x(6), y(2)), rect(x(6), y(-1), x(12), y(2))];
        const report = computeCoverageGap(footprint, parcels, ops);
        expect(report.gaps).toHaveLength(0);
        expect(report.coverage).toBeGreaterThan(0.999);
    });

    it('names the hole, with its area, when a parcel is missing in the middle', () => {
        // Nothing between x(5) and x(7): a genuine hole in the cadastre under the corridor.
        const parcels = [rect(x(0), y(-1), x(5), y(2)), rect(x(7), y(-1), x(12), y(2))];
        const report = computeCoverageGap(footprint, parcels, ops);
        expect(report.gaps).toHaveLength(1);
        expect(report.coverage).toBeLessThan(0.9);
        // The hole is 2 of 12 widths, so about a sixth of the footprint.
        expect(report.gaps[0].areaM2 / report.footprintM2).toBeGreaterThan(0.13);
        expect(report.gaps[0].areaM2 / report.footprintM2).toBeLessThan(0.2);
    });

    it('reports several holes, largest first', () => {
        const parcels = [
            rect(x(0), y(-1), x(2), y(2)),
            rect(x(3), y(-1), x(8), y(2)),
            rect(x(11), y(-1), x(12), y(2))
        ];
        const report = computeCoverageGap(footprint, parcels, ops);
        expect(report.gaps.length).toBeGreaterThanOrEqual(2);
        expect(report.gaps[0].areaM2).toBeGreaterThanOrEqual(report.gaps[1].areaM2);
    });

    it('ignores a sliver under a square metre — that is a shared edge, not a hole', () => {
        // Parcels meeting almost exactly, leaving a hairline.
        const parcels = [rect(x(0), y(-1), x(5.999), y(2)), rect(x(6), y(-1), x(12), y(2))];
        const report = computeCoverageGap(footprint, parcels, ops);
        expect(report.gaps).toHaveLength(0);
    });

    it('parcels nowhere near the footprint do not count as coverage', () => {
        const away = [rect(x(40), y(40), x(45), y(45))];
        const report = computeCoverageGap(footprint, away, ops);
        expect(report.coveredM2).toBe(0);
        expect(report.gaps).toHaveLength(1);
        expect(report.gaps[0].areaM2).toBeCloseTo(report.footprintM2, 0);
    });

    it('says nothing rather than guessing when it has nothing to work with', () => {
        expect(computeCoverageGap(null, [], ops).gaps).toEqual([]);
        expect(computeCoverageGap(footprint, [], null).gaps).toEqual([]);
        expect(computeCoverageGap(footprint, null, ops).coverage).toBe(0);
    });
});

describe('the command that paints it', () => {
    const src = readFileSync(new URL('../../frontend/js/publish-gap-debug.js', import.meta.url), 'utf8');

    it('asks for the ground first, exactly as publish does', () => {
        // Otherwise it reports the viewport and blames the cadastre for what was never fetched.
        expect(src).toContain('await fetchParcelsUnderGeometry(footprint)');
        expect(src.indexOf('await fetchParcelsUnderGeometry(footprint)'))
            .toBeLessThan(src.indexOf('const parcels = ancestry.loadedCadastreParcels();'));
    });

    it('draws the holes and can take them off again', () => {
        expect(src).toContain('global.whereIsThePublishGap');
        expect(src).toContain('global.clearPublishGap = clearGapLayer;');
        expect(src).toContain('fitBounds');
        expect(src).toContain('m²');
    });

    it('is loaded by the page, and the refusal names it', () => {
        expect(readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8'))
            .toContain("'js/publish-gap-debug.js'");
        expect(readFileSync(new URL('../../frontend/js/proposals/server-sync.js', import.meta.url), 'utf8'))
            .toContain("whereIsThePublishGap('${id}')");
    });
});
