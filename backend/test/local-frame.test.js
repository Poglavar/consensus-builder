// Unit tests for frontend/js/local-frame.js — the affine WGS84 ⇄ ground-metres frame. Pins the
// round-trip, a known 100 m offset, the ellipsoid's true scales, the affine property the slicer needs,
// and documents WHY it exists: Leaflet's Web-Mercator CRS
// (used by single-building.js / three-mode.js) inflates ground distance by 1/cos(lat), so building
// dimensions built in Mercator metres come out ~1.43× too large at Zagreb's latitude.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

import { inverse } from './helpers/ellipsoid.js';

const require = createRequire(import.meta.url);
const { makeLocalFrame, projectToLocalMeters } = require('../../frontend/js/local-frame.js');

const ZAGREB = { lng: 15.98, lat: 45.81 };

describe('makeLocalFrame', () => {
    it('round-trips degrees → metres → degrees', () => {
        const f = makeLocalFrame(ZAGREB.lng, ZAGREB.lat);
        const [x, y] = f.toMeters(ZAGREB.lng + 0.001, ZAGREB.lat + 0.001);
        const [lng, lat] = f.toDegrees(x, y);
        expect(lng).toBeCloseTo(ZAGREB.lng + 0.001, 9);
        expect(lat).toBeCloseTo(ZAGREB.lat + 0.001, 9);
    });

    it('places the anchor at the origin', () => {
        const f = makeLocalFrame(ZAGREB.lng, ZAGREB.lat);
        expect(f.toMeters(ZAGREB.lng, ZAGREB.lat)).toEqual([0, 0]);
    });

    it('a 100 m north offset is ~100 m in the frame', () => {
        const f = makeLocalFrame(ZAGREB.lng, ZAGREB.lat);
        const north = 100 / f.metersPerDegLat; // degrees for 100 m north
        const [, y] = f.toMeters(ZAGREB.lng, ZAGREB.lat + north);
        expect(y).toBeCloseTo(100, 6);
    });

    it('uses the ellipsoid\'s true metres per degree at the anchor (the old 110 540 m was 0.55% short)', () => {
        for (const place of [ZAGREB, { lng: -73.99, lat: 40.73 }, { lng: -78.5, lat: -0.2 }, { lng: 15.6, lat: 78.2 }]) {
            const f = makeLocalFrame(place.lng, place.lat);
            const d = 0.0005;
            const north = inverse([place.lng, place.lat - d], [place.lng, place.lat + d]) / (2 * d);
            const east = inverse([place.lng - d, place.lat], [place.lng + d, place.lat]) / (2 * d);
            expect(Math.abs(f.metersPerDegLat / north - 1)).toBeLessThan(1e-7);
            expect(Math.abs(f.metersPerDegLng / east - 1)).toBeLessThan(1e-7);
        }
        // The Mercator inflation this module avoids: 1/cos(45.81°) ≈ 1.43.
        expect(1 / Math.cos(ZAGREB.lat * Math.PI / 180)).toBeCloseTo(1.435, 2);
    });

    it('stays affine in lng/lat: a straight edge stays straight (what the slicer relies on)', () => {
        const f = makeLocalFrame(ZAGREB.lng, ZAGREB.lat);
        const a = [ZAGREB.lng - 0.002, ZAGREB.lat - 0.001];
        const b = [ZAGREB.lng + 0.003, ZAGREB.lat + 0.002];
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const [ax, ay] = f.toMeters(...a);
        const [bx, by] = f.toMeters(...b);
        const [mx, my] = f.toMeters(...mid);
        expect(mx).toBeCloseTo((ax + bx) / 2, 9);
        expect(my).toBeCloseTo((ay + by) / 2, 9);
    });
});

describe('projectToLocalMeters', () => {
    it('matches makeLocalFrame(anchor).toMeters', () => {
        const anchor = { lng: ZAGREB.lng, lat: ZAGREB.lat };
        const got = projectToLocalMeters(ZAGREB.lng + 0.002, ZAGREB.lat - 0.001, anchor);
        const want = makeLocalFrame(anchor.lng, anchor.lat).toMeters(ZAGREB.lng + 0.002, ZAGREB.lat - 0.001);
        expect(got).toEqual(want);
    });

    it('returns null for non-finite input', () => {
        expect(projectToLocalMeters(NaN, 45, { lng: 0, lat: 0 })).toBeNull();
        expect(projectToLocalMeters(15, 'x', { lng: 0, lat: 0 })).toBeNull();
    });
});
