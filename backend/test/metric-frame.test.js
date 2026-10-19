// The accuracy contract of projections.md §1–2, checked against an independent ellipsoidal oracle:
// a frame built anywhere on the globe reproduces a 19 m offset to within 1 mm in every direction,
// round-trips, refuses what is outside its domain, and derives the same canonical anchor however
// the same geometry is written.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { inverse, destination, PLACES } from './helpers/ellipsoid.js';

const require = createRequire(import.meta.url);
const frames = require('../../frontend/js/metric-frame.js');
const { CONTRACT, canonicalAnchor, frameFor, frameAt, frameFromProvenance, projString, geodesicDistance, wrapLongitude } = frames;

const BEARINGS = [0, 45, 90, 135, 180, 225, 270, 315];
const OFFSET_M = 19;
const TOLERANCE_M = 0.001;

// Move `distance` metres along `bearing` in the frame, come back to the ellipsoid, and measure.
function offsetError(frame, position, bearing, distance = OFFSET_M) {
    const [x, y] = frame.toMetric(position);
    const rad = bearing * Math.PI / 180;
    const moved = frame.toLngLat([x + distance * Math.sin(rad), y + distance * Math.cos(rad)]);
    return inverse(position, moved) - distance;
}

describe('a local frame is accurate everywhere on the globe', () => {
    for (const [name, place] of Object.entries(PLACES)) {
        it(`${name}: a 19 m offset measures 19 m ± 1 mm in every direction`, () => {
            const frame = frameFor([place]);
            for (const bearing of BEARINGS) {
                expect(Math.abs(offsetError(frame, place, bearing)), `bearing ${bearing}`).toBeLessThan(TOLERANCE_M);
            }
        });
    }

    it('stays within 1 mm per 19 m out to the edge of its domain, east-west included', () => {
        const frame = frameFor([PLACES.zagreb]);
        for (const km of [1, 10, 30, 59]) {
            const far = destination(PLACES.zagreb, 90, km * 1000);
            for (const bearing of BEARINGS) {
                expect(Math.abs(offsetError(frame, far, bearing)), `${km} km east, bearing ${bearing}`).toBeLessThan(TOLERANCE_M);
            }
        }
    });

    it('agrees with the oracle on long distances too (a 40 km transit line)', () => {
        const frame = frameFor([PLACES.sydney]);
        const far = destination(PLACES.sydney, 30, 40000);
        const [x1, y1] = frame.toMetric(PLACES.sydney);
        const [x2, y2] = frame.toMetric(far);
        const error = Math.abs(Math.hypot(x2 - x1, y2 - y1) - 40000);
        expect(error / 40000).toBeLessThan(CONTRACT.SCALE_TOLERANCE);
        expect(error).toBeLessThan(0.1); // measured: 66 mm, from the scale growing with distance from the meridian
    });

    it('round-trips a position to better than 1e-9°', () => {
        for (const place of Object.values(PLACES)) {
            const frame = frameFor([place]);
            const back = frame.toLngLat(frame.toMetric(place));
            expect(Math.abs(back[0] - place[0])).toBeLessThan(1e-9);
            expect(Math.abs(back[1] - place[1])).toBeLessThan(1e-9);
        }
    });

    it('measures geodesic distance like the oracle', () => {
        const far = destination(PLACES.reykjavik, 200, 12345.678);
        expect(Math.abs(geodesicDistance(PLACES.reykjavik, far) - inverse(PLACES.reykjavik, far))).toBeLessThan(1e-6);
        expect(Math.abs(geodesicDistance(PLACES.reykjavik, far) - 12345.678)).toBeLessThan(1e-3);
    });
});

describe('a frame refuses what is outside its domain', () => {
    it('refuses a point beyond 60 km from the anchor, in either direction', () => {
        const frame = frameFor([PLACES.quito]);
        expect(() => frame.toMetric(destination(PLACES.quito, 90, 59000))).not.toThrow();
        expect(() => frame.toMetric(destination(PLACES.quito, 90, 61000))).toThrow(/beyond the 60000 m domain/);
        expect(() => frame.toLngLat([0, 61000])).toThrow(/beyond the 60000 m domain/);
    });

    it('refuses latitudes beyond the supported band and non-finite input', () => {
        expect(() => frameFor([[15, 85.01]])).toThrow(/outside the supported band/);
        expect(() => frameFor([[15, 84.99]])).not.toThrow();
        expect(() => frameFor([[Number.NaN, 45]])).toThrow();
        expect(() => frameFor([])).toThrow(/no positions/);
        const frame = frameFor([PLACES.zagreb]);
        expect(() => frame.toMetric([16, Number.POSITIVE_INFINITY])).toThrow();
        expect(() => frame.toLngLat(['1', 2])).toThrow();
    });

    it('refuses a geometry spanning more than 180° of longitude', () => {
        // Two points are always within 180° by shortest arc; three can spread beyond it.
        expect(() => canonicalAnchor([[-100, 10], [100, 10]])).not.toThrow();
        expect(() => canonicalAnchor([[-100, 10], [100, 10], [0, 10]])).toThrow(/more than 180/);
    });
});

describe('the canonical anchor is the same however the geometry is written', () => {
    const ring = [[16.0100, 45.7800], [16.0120, 45.7800], [16.0120, 45.7815], [16.0100, 45.7815], [16.0100, 45.7800]];

    it('is the bbox midpoint rounded to 1e-6°, for any ring start, winding or +360° longitude', () => {
        const expected = [16.011, 45.78075];
        expect(canonicalAnchor(ring)).toEqual(expected);
        expect(canonicalAnchor([...ring].reverse())).toEqual(expected);
        expect(canonicalAnchor([ring[2], ring[3], ring[4], ring[1], ring[2]])).toEqual(expected);
        expect(canonicalAnchor(ring.map(([lon, lat]) => [lon + 360, lat]))).toEqual(expected);
        expect(canonicalAnchor({ type: 'Polygon', coordinates: [ring] })).toEqual(expected);
        expect(canonicalAnchor({ type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [[ring]] } })).toEqual(expected);
        expect(canonicalAnchor(ring.map(([lng, lat]) => ({ lat, lng })))).toEqual(expected);
    });

    it('keeps an antimeridian-crossing geometry contiguous', () => {
        const positions = [[179.99, -16.5], [-179.99, -16.5], [-179.99, -16.49], [179.99, -16.49]];
        const anchor = canonicalAnchor(positions);
        expect(anchor[1]).toBeCloseTo(-16.495, 6);
        expect(Math.abs(wrapLongitude(anchor[0]))).toBeCloseTo(180, 6);
        expect(canonicalAnchor([...positions].reverse())).toEqual(anchor);
        const frame = frameAt(anchor);
        const [x1] = frame.toMetric(positions[0]);
        const [x2] = frame.toMetric(positions[1]);
        expect(Math.abs(x2 - x1)).toBeGreaterThan(2000);
        expect(Math.abs(x2 - x1)).toBeLessThan(2300);
        expect(Math.abs(inverse(positions[0], positions[1]) - Math.abs(x2 - x1))).toBeLessThan(0.01);
    });

    it('never writes -0 into the projection string', () => {
        expect(projString(canonicalAnchor([[-0.0000001, 0.0000001]]))).toContain('+lat_0=0.000000 +lon_0=0.000000');
        expect(projString([0, 0])).not.toContain('-0');
    });
});

describe('provenance', () => {
    it('round-trips and pins the proj4 version', () => {
        const frame = frameFor([PLACES.svalbard]);
        const provenance = frame.provenance();
        expect(provenance.kind).toBe(CONTRACT.KIND);
        expect(provenance.proj).toBe(projString(provenance.anchor));
        expect(provenance.proj4).toBe(require('proj4/package.json').version);
        const rebuilt = frameFromProvenance(provenance);
        expect(rebuilt.toMetric(PLACES.svalbard)).toEqual(frame.toMetric(PLACES.svalbard));
    });

    it('refuses a non-canonical projection string, an unrounded anchor and an unknown kind', () => {
        const good = frameFor([PLACES.zagreb]).provenance();
        expect(() => frameFromProvenance({ ...good, proj: good.proj.replace('+k=1', '+k=0.9999') })).toThrow(/canonical/);
        expect(() => frameFromProvenance({ ...good, proj: '+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs' })).toThrow(/canonical/);
        expect(() => frameFromProvenance({ ...good, anchor: [16.0100001, 45.78] })).toThrow(/rounded/);
        expect(() => frameFromProvenance({ ...good, kind: 'utm' })).toThrow(/unsupported frame kind/);
        expect(() => frameFromProvenance(null)).toThrow(/missing/);
    });
});

describe('pinned dependencies', () => {
    it('serves the same proj4 version in the browser as the backend uses', () => {
        const html = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');
        const backendVersion = require('proj4/package.json').version;
        expect(html).toContain(`vendor/proj4-${backendVersion}/proj4.js`);
        expect(html).toContain("'js/metric-frame.js'");
    });
});
