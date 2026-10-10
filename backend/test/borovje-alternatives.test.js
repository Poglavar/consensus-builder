// Geometry of the Borovje "urban blocks" alternative: an open block must stay on its plot, keep its
// wings at full depth, open toward the green, and the plot frame must follow the plot, not north.

import { describe, it, expect } from 'vitest';
import * as turf from '@turf/turf';
import { openBlock, orientedBox, streetSideOf, localFrame, summarize, buildingFeature, STOREY_M }
    from '../scripts/lib/borovje-alternatives.mjs';

// A 120 m × 36 m plot rotated 30° from east, near Borovje, built in a local metre frame.
const frame = localFrame([16.012, 45.787]);
function rotatedRect(lengthM, widthM, degrees, offset = [0, 0]) {
    const a = degrees * Math.PI / 180;
    const corner = (u, v) => frame.toLngLat([offset[0] + u * Math.cos(a) - v * Math.sin(a), offset[1] + u * Math.sin(a) + v * Math.cos(a)]);
    const ring = [corner(0, 0), corner(lengthM, 0), corner(lengthM, widthM), corner(0, widthM)];
    return { type: 'Polygon', coordinates: [[...ring, ring[0]]] };
}
const PLOT = rotatedRect(120, 36, 30);
// The park lies on the plot's high-v side (beyond v = 36).
const PARK = rotatedRect(120, 40, 30, [-50 * Math.sin(Math.PI / 6), 50 * Math.cos(Math.PI / 6)]);

describe('orientedBox', () => {
    it('finds the plot axis, not north', () => {
        const box = orientedBox(PLOT);
        const degrees = ((box.angle * 180 / Math.PI) % 180 + 180) % 180;
        expect(Math.abs(degrees - 30)).toBeLessThan(0.5);
        expect(box.u[1] - box.u[0]).toBeCloseTo(120, 0);
        expect(box.v[1] - box.v[0]).toBeCloseTo(36, 0);
    });
});

describe('streetSideOf', () => {
    it('puts the street on the side away from the park', () => {
        const side = streetSideOf(PLOT, PARK);
        const block = openBlock(PLOT, { streetSide: side });
        // The block's mass must sit nearer the far (street) edge than the park edge.
        const parkEdge = turf.polygonToLine(turf.feature(PARK));
        const centre = turf.centerOfMass(turf.feature(block.geometry));
        const plotCentre = turf.centerOfMass(turf.feature(PLOT));
        expect(turf.pointToLineDistance(centre, parkEdge, { units: 'meters' }))
            .toBeGreaterThan(turf.pointToLineDistance(plotCentre, parkEdge, { units: 'meters' }));
    });
});

describe('openBlock', () => {
    const block = openBlock(PLOT, { streetSide: 'low', setbackM: 2, depthM: 12 });

    it('stays inside its plot', () => {
        expect(turf.booleanWithin(turf.feature(block.geometry), turf.feature(PLOT))).toBe(true);
    });

    it('is a U: street wing plus two end wings at full depth, open on the park side', () => {
        expect(block.kind).toBe('open-block');
        // Set-back box 116 × 32: street wing 116 × 12 + two end wings 12 × 20.
        expect(turf.area(turf.feature(block.geometry))).toBeGreaterThan(0.95 * (116 * 12 + 2 * 12 * 20));
        // The middle of the park side is open yard, the middle of the street side is building.
        const at = (u, v) => turf.point(frame.toLngLat([u * Math.cos(Math.PI / 6) - v * Math.sin(Math.PI / 6),
            u * Math.sin(Math.PI / 6) + v * Math.cos(Math.PI / 6)]));
        expect(turf.booleanPointInPolygon(at(60, 6), turf.feature(block.geometry))).toBe(true);
        expect(turf.booleanPointInPolygon(at(60, 30), turf.feature(block.geometry))).toBe(false);
        expect(turf.booleanPointInPolygon(at(6, 30), turf.feature(block.geometry))).toBe(true);
    });

    it('keeps only the street wing on a plot too short for end wings', () => {
        const short = openBlock(rotatedRect(40, 36, 30), { streetSide: 'low' });
        expect(short.kind).toBe('street-wing');
    });
});

describe('summarize', () => {
    it('counts floor area as footprint × floors at the reconstruction storey height', () => {
        const feature = buildingFeature('x', rotatedRect(20, 10, 0), 5);
        expect(feature.properties.height).toBeCloseTo(5 * STOREY_M, 5);
        const total = summarize([feature]);
        // 20 × 10 m × 5 floors; the planar frame and turf's geodesic area agree to within 1 %.
        expect(Math.abs(total.floorAreaM2 - 1000) / 1000).toBeLessThan(0.01);
    });
});
