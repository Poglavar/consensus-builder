// Unit tests for frontend/js/local-frame.js — the one WGS84 ⇄ ground-metres frame. Pins the
// round-trip and a known 100 m offset, and documents WHY it exists: Leaflet's Web-Mercator CRS
// (used by single-building.js / three-mode.js) inflates ground distance by 1/cos(lat), so building
// dimensions built in Mercator metres come out ~1.43× too large at Zagreb's latitude.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

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

    it('metres-per-degree of longitude shrinks with latitude (the cos factor)', () => {
        const equator = makeLocalFrame(0, 0).metersPerDegLng;
        const zagreb = makeLocalFrame(ZAGREB.lng, ZAGREB.lat).metersPerDegLng;
        expect(zagreb).toBeCloseTo(equator * Math.cos(ZAGREB.lat * Math.PI / 180), 3);
        // The Mercator inflation this module avoids: 1/cos(45.81°) ≈ 1.43.
        expect(1 / Math.cos(ZAGREB.lat * Math.PI / 180)).toBeCloseTo(1.435, 2);
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
