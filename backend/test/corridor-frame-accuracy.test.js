// The construction path that produced the bug, measured against the ellipsoid: a 19 m road
// rectangle built through New York's UTM frame at Zagreb is 13.65 m wide (what the app did when no
// city was stored), while one built through a local frame is 19.000 m wide — here, and in Svalbard,
// Quito and Fiji. The first case documents the failure; the second is the contract.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { inverse, destination, PLACES } from './helpers/ellipsoid.js';

const require = createRequire(import.meta.url);
const proj4 = require('proj4');
const { createRectangularRoadSegment } = require('../../frontend/js/corridor-geometry.js');
const { frameFor } = require('../../frontend/js/metric-frame.js');

const WIDTH_M = 19;
const latLng = (lat, lng) => ({ lat, lng });

// The corridor builder takes its projection as deps in the legacy (lat, lng) → [x, y] shape.
function depsFromProj(projection) {
    const converter = proj4('EPSG:4326', projection);
    return {
        wgs84ToHTRS96: (lat, lng) => converter.forward([lng, lat]),
        htrs96ToWGS84: (x, y) => { const [lon, lat] = converter.inverse([x, y]); return [lat, lon]; },
        latLng
    };
}
function depsFromFrame(frame) {
    return { wgs84ToHTRS96: frame.latLngToMetric, htrs96ToWGS84: frame.metricToLatLng, latLng };
}

// Width of the built rectangle: the shorter of the two sides meeting at the first corner.
function measuredWidth(ring) {
    const p = index => [ring[index].lng, ring[index].lat];
    const a = inverse(p(0), p(1));
    const b = inverse(p(0), p(3));
    return Math.min(a, b);
}

function segmentAt(place) {
    const end = destination(place, 90, 100);
    return [latLng(place[1], place[0]), latLng(end[1], end[0])];
}

describe('a 19 m road rectangle', () => {
    it('was 13.65 m wide at Zagreb when built through New York\'s frame (the bug)', () => {
        const [p1, p2] = segmentAt(PLACES.zagreb);
        const ring = createRectangularRoadSegment(p1, p2, WIDTH_M, depsFromProj('+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs'));
        expect(ring).not.toBeNull();
        const width = measuredWidth(ring);
        expect(width).toBeGreaterThan(13.5);
        expect(width).toBeLessThan(13.8);
    });

    for (const name of ['zagreb', 'svalbard', 'quito', 'fiji', 'sydney']) {
        it(`is 19.000 m wide at ${name} when built through a local frame`, () => {
            const [p1, p2] = segmentAt(PLACES[name]);
            const frame = frameFor([p1, p2]);
            const ring = createRectangularRoadSegment(p1, p2, WIDTH_M, depsFromFrame(frame));
            expect(ring).not.toBeNull();
            expect(Math.abs(measuredWidth(ring) - WIDTH_M)).toBeLessThan(0.001);
            // and the long side is the 100 m the centre line was drawn at
            const length = Math.max(inverse([ring[0].lng, ring[0].lat], [ring[1].lng, ring[1].lat]), inverse([ring[0].lng, ring[0].lat], [ring[3].lng, ring[3].lat]));
            expect(Math.abs(length - 100)).toBeLessThan(0.001);
        });
    }
});
