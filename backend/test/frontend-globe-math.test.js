// Pure globe maths (frontend/js/world/globe-math.js): sphere mapping, picking, fly interpolation
// and the altitude -> Leaflet zoom handoff.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const GM = require('../../frontend/js/world/globe-math.js');

describe('lat/lon <-> vector', () => {
    it('round-trips across the globe', () => {
        for (const [lat, lon] of [[0, 0], [45.8, 15.98], [-33.9, 151.2], [89, -179], [-60, 179.5], [10, -90]]) {
            const back = GM.vectorToLatLon(GM.latLonToVector(lat, lon));
            expect(back.lat).toBeCloseTo(lat, 9);
            expect(back.lon).toBeCloseTo(lon, 9);
        }
    });

    it('matches the three.js SphereGeometry UV convention', () => {
        expect(GM.latLonToVector(0, 0).map(v => Math.round(v * 1e9) / 1e9)).toEqual([1, 0, -0]);
        expect(GM.latLonToVector(0, 90)[2]).toBeCloseTo(-1, 12);
        expect(GM.latLonToVector(90, 0)[1]).toBeCloseTo(1, 12);
    });
});

describe('raySphere', () => {
    it('hits the near side of the globe', () => {
        const hit = GM.raySphere([3, 0, 0], [-1, 0, 0]);
        expect(hit[0]).toBeCloseTo(1, 12);
        expect(GM.vectorToLatLon(hit)).toMatchObject({ lat: 0, lon: 0 });
    });

    it('picks the point under an off-centre ray', () => {
        const target = GM.latLonToVector(20, 30);
        const origin = [0, 0, 0].map((_, i) => target[i] * 2.5 + (i === 1 ? 0.3 : 0));
        const dir = target.map((v, i) => v - origin[i]);
        const ll = GM.vectorToLatLon(GM.raySphere(origin, dir));
        expect(ll.lat).toBeCloseTo(20, 6);
        expect(ll.lon).toBeCloseTo(30, 6);
    });

    it('misses when the ray passes beside or points away', () => {
        expect(GM.raySphere([3, 2, 0], [-1, 0, 0])).toBeNull();
        expect(GM.raySphere([3, 0, 0], [1, 0, 0])).toBeNull();
    });
});

describe('flyInterpolate', () => {
    const from = { lat: 20, lon: -30, altitudeKm: 19000 };
    const to = { lat: 45.8, lon: 15.98, altitudeKm: 120 };

    it('starts and ends exactly at the endpoints', () => {
        expect(GM.flyInterpolate(from, to, 0)).toEqual({ lat: 20, lon: -30, altitudeKm: 19000 });
        expect(GM.flyInterpolate(from, to, 1)).toEqual({ lat: 45.8, lon: 15.98, altitudeKm: 120 });
    });

    it('follows the great circle and descends monotonically on a dive', () => {
        let prevDist = Infinity; let prevAlt = Infinity;
        for (let t = 0.1; t <= 1.0001; t += 0.1) {
            const s = GM.flyInterpolate(from, to, t, { hop: 0 });
            const d = GM.angularDistance(s, to);
            expect(d).toBeLessThanOrEqual(prevDist + 1e-9);
            expect(s.altitudeKm).toBeLessThanOrEqual(prevAlt + 1e-6);
            prevDist = d; prevAlt = s.altitudeKm;
        }
    });

    it('lifts a long flight between equal altitudes', () => {
        const a = { lat: 0, lon: 0, altitudeKm: 8000 }; const b = { lat: 0, lon: 150, altitudeKm: 8000 };
        expect(GM.flyInterpolate(a, b, 0.5).altitudeKm).toBeGreaterThan(8000);
        expect(GM.flyInterpolate(a, b, 0.5, { hop: 0 }).altitudeKm).toBeCloseTo(8000, 6);
    });

    it('slerps across the antimeridian the short way', () => {
        const mid = GM.slerpLatLon({ lat: 0, lon: 170 }, { lat: 0, lon: -170 }, 0.5);
        expect(Math.abs(mid.lon)).toBeCloseTo(180, 6);
    });
});

describe('altitudeToLeafletZoom', () => {
    it('maps ~20 km altitude to a city-scale zoom', () => {
        const z = GM.altitudeToLeafletZoom(20, 45.8, 800);
        expect(z).toBeGreaterThanOrEqual(11);
        expect(z).toBeLessThanOrEqual(13);
    });

    it('decreases monotonically with altitude and inverts', () => {
        let prev = Infinity;
        for (const alt of [1, 5, 20, 100, 500, 2000]) {
            const z = GM.altitudeToLeafletZoom(alt, 40, 900);
            expect(z).toBeLessThan(prev);
            prev = z;
            expect(GM.leafletZoomToAltitude(z, 40, 900)).toBeCloseTo(alt, 6);
        }
    });

    it('zooms in further for a taller viewport and at higher latitude', () => {
        expect(GM.altitudeToLeafletZoom(20, 45, 1200)).toBeGreaterThan(GM.altitudeToLeafletZoom(20, 45, 600));
        expect(GM.altitudeToLeafletZoom(20, 0, 800)).toBeGreaterThan(GM.altitudeToLeafletZoom(20, 60, 800));
    });
});

describe('wheel zoom math', () => {
    it('normalizes wheel pixel, line, and page deltas', () => {
        expect(GM.wheelDeltaPixels(-12, 0, 800)).toBe(-12);
        expect(GM.wheelDeltaPixels(2, 1, 800)).toBe(60);
        expect(GM.wheelDeltaPixels(-2, 2, 800)).toBe(-1600);
    });

    it('damps geometrically at the same rate at 60 and 120 Hz', () => {
        const step = (frames, totalSeconds) => {
            let altitude = 10000;
            for (let i = 0; i < frames; i += 1) {
                altitude = GM.dampAltitude(altitude, 1500, totalSeconds / frames);
            }
            return altitude;
        };
        expect(step(12, 0.2)).toBeCloseTo(step(24, 0.2), 8);
        expect(GM.dampAltitude(10000, 1500, 0.2)).toBeCloseTo(step(12, 0.2), 8);
    });

    it('moves monotonically without overshooting, then settles exactly at the target', () => {
        let altitude = 10000;
        for (let i = 0; i < 200; i += 1) {
            const next = GM.dampAltitude(altitude, 1500, 1 / 120);
            expect(next).toBeLessThanOrEqual(altitude);
            expect(next).toBeGreaterThanOrEqual(1500);
            altitude = next;
        }
        expect(altitude).toBe(1500);
    });

    it('snaps when the remaining logarithmic distance is below the settling threshold', () => {
        const target = 1500 * Math.exp(0.00009);
        expect(GM.dampAltitude(1500, target, 0)).toBe(target);
    });
});
