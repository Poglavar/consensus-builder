// The construction that produced the bug, measured against the ellipsoid: a 19 m road built through
// New York's UTM frame at Zagreb is 13.65 m wide (what the app did when no city was stored), while
// the same road built through a local frame is 19.000 m wide — here, and in Svalbard, Quito, Fiji
// and Sydney. Both go through the shared construction (corridor-footprint.js footprintOfArms); only
// the frame differs. The first case documents the failure; the second is the contract.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { inverse, initialBearing, destination, PLACES } from './helpers/ellipsoid.js';

const require = createRequire(import.meta.url);
const proj4 = require('proj4');
const turf = require('@turf/turf');
const { footprintOfArms } = require('../../frontend/js/corridor-footprint.js');
const { frameFor } = require('../../frontend/js/metric-frame.js');

const WIDTH_M = 19;
const latLng = ([lng, lat]) => ({ lat, lng });

// A "frame" through an arbitrary projection, as the old code had one: the city's.
function projectionFrame(projection) {
    const converter = proj4('EPSG:4326', projection);
    return { toMetric: p => converter.forward([p[0], p[1]]), toLngLat: xy => converter.inverse([xy[0], xy[1]]) };
}

// Distance from the centre line's midpoint to the footprint boundary along `turn` degrees from the
// line's bearing, on the ellipsoid, bisected to well under a millimetre.
function boundaryDistance(polygon, from, to, turn) {
    const bearing = initialBearing(from, to);
    const mid = destination(from, bearing, inverse(from, to) / 2);
    const inside = d => turf.booleanPointInPolygon(turf.point(destination(mid, bearing + turn, d)), polygon);
    let lo = 0;
    let hi = 200;
    for (let k = 0; k < 40; k += 1) {
        const m = (lo + hi) / 2;
        if (inside(m)) lo = m; else hi = m;
    }
    return lo;
}

function build(place, frameOf) {
    const end = destination(place, 90, 100);
    const points = [latLng(place), latLng(end)];
    const polygon = footprintOfArms([{ points, width: WIDTH_M }], frameOf(points));
    return { polygon, from: place, to: end };
}

describe('a 19 m road', () => {
    it('was 13.65 m wide at Zagreb when built through New York\'s frame (the bug)', () => {
        const { polygon, from, to } = build(PLACES.zagreb, () => projectionFrame('+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs'));
        const width = boundaryDistance(polygon, from, to, 90) + boundaryDistance(polygon, from, to, -90);
        expect(width).toBeGreaterThan(13.5);
        expect(width).toBeLessThan(13.8);
    });

    for (const name of ['zagreb', 'svalbard', 'quito', 'fiji', 'sydney']) {
        it(`is 19.000 m wide at ${name} when built through a local frame`, () => {
            const { polygon, from, to } = build(PLACES[name], points => frameFor(points));
            expect(Math.abs(boundaryDistance(polygon, from, to, 90) - WIDTH_M / 2)).toBeLessThan(0.001);
            expect(Math.abs(boundaryDistance(polygon, from, to, -90) - WIDTH_M / 2)).toBeLessThan(0.001);
            // and as long as the 100 m the centre line was drawn at (square ends, 50 m each way)
            expect(Math.abs(boundaryDistance(polygon, from, to, 0) - 50)).toBeLessThan(0.001);
            expect(Math.abs(boundaryDistance(polygon, from, to, 180) - 50)).toBeLessThan(0.001);
        });
    }
});
