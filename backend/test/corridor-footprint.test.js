// The shared corridor construction (frontend/js/corridor-footprint.js) measured against the
// ellipsoid: widths hold to 1 mm along straights at any latitude, bends are bevelled, per-segment
// widths and tunnels are honoured, the result is deterministic, failures throw, and the module
// reproduces the footprint the browser built for the Borovje v3 collector.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { inverse, initialBearing, destination, PLACES } from './helpers/ellipsoid.js';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const footprint = require('../../frontend/js/corridor-footprint.js');
const { frameFromProvenance } = require('../../frontend/js/metric-frame.js');

const WIDTH = 19;
const latLng = ([lon, lat], extra = {}) => ({ lat, lng: lon, ...extra });

// A centre line as a list of [lon, lat] built on the ellipsoid from `place` along bearings/lengths.
function lineFrom(place, legs) {
    const positions = [place];
    let at = place;
    for (const [bearing, length] of legs) { at = destination(at, bearing, length); positions.push(at); }
    return positions;
}
const definitionOf = (segments, extra = {}) => ({ width: WIDTH, points: segments, segments, ...extra });

// Is `position` ([lon, lat]) inside the footprint? (planar test in the footprint's own frame)
function insideIn(frame, polygon, position) {
    const metric = p => frame.toMetric(p);
    const geometry = polygon.type === 'Polygon'
        ? turf.polygon(polygon.coordinates.map(ring => ring.map(metric)))
        : turf.multiPolygon(polygon.coordinates.map(rings => rings.map(ring => ring.map(metric))));
    return turf.booleanPointInPolygon(turf.point(metric(position)), geometry);
}

// Along a straight stretch the boundary must lie 9.5 m from the centre line, to ±1 mm, both sides.
function expectWidthAlong(result, from, to, width = WIDTH) {
    const frame = frameFromProvenance(result.constructionFrame);
    const bearing = initialBearing(from, to);
    const length = inverse(from, to);
    for (const fraction of [0.2, 0.5, 0.8]) {
        const station = destination(from, bearing, length * fraction);
        for (const side of [90, -90]) {
            const justInside = destination(station, bearing + side, width / 2 - 0.001);
            const justOutside = destination(station, bearing + side, width / 2 + 0.001);
            expect(insideIn(frame, result.polygon, justInside), `inside at ${fraction}, side ${side}`).toBe(true);
            expect(insideIn(frame, result.polygon, justOutside), `outside at ${fraction}, side ${side}`).toBe(false);
        }
    }
}

describe('corridor footprint construction', () => {
    for (const name of ['zagreb', 'svalbard', 'quito', 'fiji']) {
        it(`${name}: a straight 19 m corridor is 19 m wide and as long as its centre line`, () => {
            const [a, b] = lineFrom(PLACES[name], [[75, 120]]);
            const result = footprint.materialize(definitionOf([[latLng(a), latLng(b)]]));
            expect(result.polygon.type).toBe('Polygon');
            const ring = result.polygon.coordinates[0];
            expectWidthAlong(result, a, b);
            // perimeter on the ellipsoid: 2 × (19 + 120) m to 2 mm; no stored edge longer than 50 m
            const edges = ring.slice(0, -1).map((position, i) => inverse(position, ring[i + 1]));
            expect(Math.abs(edges.reduce((sum, edge) => sum + edge, 0) - 2 * (WIDTH + 120))).toBeLessThan(0.002);
            expect(Math.max(...edges)).toBeLessThan(footprint.DENSIFY_M + 0.01);
            expect(result.constructionFrame.kind).toBe('local-tmerc');
            expect(result.constructionFrame.algorithm).toBe(footprint.ALGORITHM);
        });
    }

    it('stays 19 m wide when its stored edges are read as straight lon/lat lines (2 km street at 60°N)', () => {
        // PostGIS, Leaflet and turf all draw an edge as a straight line in lon/lat. Undivided, this
        // street's 2 km sides would bow ~13 cm away from the true offset line; divided into ≤ 50 m
        // pieces they stay within a fraction of a millimetre.
        const start = [10.75, 60.0];
        const [a, b] = lineFrom(start, [[90, 2000]]);
        const result = footprint.materialize(definitionOf([[latLng(a), latLng(b)]]));
        const ring = result.polygon.coordinates[0];
        const bearing = initialBearing(a, b);
        let worst = 0;
        for (let i = 0; i < ring.length - 1; i += 1) {
            // midpoint of the stored edge, interpolated linearly in lon/lat
            const mid = [(ring[i][0] + ring[i + 1][0]) / 2, (ring[i][1] + ring[i + 1][1]) / 2];
            // its distance from the centre line, on the ellipsoid: along-track station, then cross-track
            const along = inverse(a, mid);
            if (along < 30 || along > 1970) continue; // the end caps are not offset lines
            const station = destination(a, bearing, along * Math.cos((initialBearing(a, mid) - bearing) * Math.PI / 180));
            const crossTrack = inverse(station, mid);
            worst = Math.max(worst, Math.abs(crossTrack - WIDTH / 2));
        }
        expect(worst).toBeLessThan(0.001);
    });

    it('bevels a bend: full width on both straights, the miter apex cut off', () => {
        const [a, b, c] = lineFrom(PLACES.sydney, [[90, 80], [30, 80]]);
        const result = footprint.materialize(definitionOf([[latLng(a), latLng(b), latLng(c)]]));
        expectWidthAlong(result, a, b);
        expectWidthAlong(result, b, c);
        const frame = frameFromProvenance(result.constructionFrame);
        // On the outside of a 60° left turn (bearing 90° → 30°) the outer bisector points to 150°.
        // The bevel chord pA–pB crosses it at half-width · cos(30°) from the joint; the miter apex
        // would sit at half-width / cos(30°). Inside up to the chord, outside beyond it.
        const outerBisector = 150;
        const chord = (WIDTH / 2) * Math.cos(Math.PI / 6);
        expect(insideIn(frame, result.polygon, destination(b, outerBisector, chord - 0.002))).toBe(true);
        expect(insideIn(frame, result.polygon, destination(b, outerBisector, chord + 0.002))).toBe(false);
        expect(insideIn(frame, result.polygon, destination(b, outerBisector, (WIDTH / 2) / Math.cos(Math.PI / 6) - 0.002))).toBe(false);
    });

    it('gives each segment its own width from segmentProfiles', () => {
        const [a, b, c] = lineFrom(PLACES.newYork, [[0, 100], [0, 100]]);
        const definition = definitionOf([[latLng(a), latLng(b)], [latLng(b), latLng(c)]], {
            segmentIds: ['narrow', 'wide'],
            segmentProfiles: { narrow: { strips: [{ type: 'driving', width: 5 }, { type: 'driving', width: 5 }] }, wide: { strips: [{ type: 'driving', width: 10 }, { type: 'driving', width: 10 }] } }
        });
        const result = footprint.materialize(definition);
        expectWidthAlong(result, a, b, 10);
        expectWidthAlong(result, b, c, 20);
    });

    it('leaves a gap where a stretch is fully underground', () => {
        const [a, b, c, d] = lineFrom(PLACES.reykjavik, [[45, 100], [45, 100], [45, 100]]);
        const segment = [latLng(a), latLng(b, { level: -1 }), latLng(c, { level: -1 }), latLng(d)];
        const result = footprint.materialize(definitionOf([segment]));
        expect(result.polygon.type).toBe('MultiPolygon');
        expect(result.polygon.coordinates).toHaveLength(2);
        const frame = frameFromProvenance(result.constructionFrame);
        expect(insideIn(frame, result.polygon, destination(b, 45, 50))).toBe(false);
    });

    it('restores the bend wedge when a junction split a stretch into two pieces', () => {
        const [a, b, c] = lineFrom(PLACES.zagreb, [[90, 80], [30, 80]]);
        const split = definitionOf([[latLng(a), latLng(b)], [latLng(b), latLng(c)]], { segmentIds: ['s', 's~2'] });
        const whole = definitionOf([[latLng(a), latLng(b), latLng(c)]], { segmentIds: ['s'] });
        const splitResult = footprint.materialize(split);
        const wholeResult = footprint.materialize(whole);
        const symmetric = turf.area(turf.difference(turf.polygon(splitResult.polygon.coordinates), turf.polygon(wholeResult.polygon.coordinates)) || turf.polygon([[[0, 0], [0, 0], [0, 0], [0, 0]]]))
            + turf.area(turf.difference(turf.polygon(wholeResult.polygon.coordinates), turf.polygon(splitResult.polygon.coordinates)) || turf.polygon([[[0, 0], [0, 0], [0, 0], [0, 0]]]));
        expect(symmetric).toBeLessThan(0.01);
        // and two DIFFERENT stretches meeting at a node get no wedge (a T junction's corners are not paved)
        const twoRoads = definitionOf([[latLng(a), latLng(b)], [latLng(b), latLng(c)]], { segmentIds: ['s', 't'] });
        const twoResult = footprint.materialize(twoRoads);
        expect(turf.area(turf.polygon(twoResult.polygon.coordinates))).toBeLessThan(turf.area(turf.polygon(wholeResult.polygon.coordinates)));
    });

    it('is deterministic and anchors on the authored centre line regardless of segment order', () => {
        const [a, b, c] = lineFrom(PLACES.quito, [[90, 80], [30, 80]]);
        const definition = definitionOf([[latLng(a), latLng(b)], [latLng(b), latLng(c)]], { segmentIds: ['s', 's~2'] });
        const first = footprint.materialize(definition);
        const second = footprint.materialize(JSON.parse(JSON.stringify(definition)));
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
        const reversed = definitionOf([[latLng(c), latLng(b)], [latLng(b), latLng(a)]], { segmentIds: ['s~2', 's'] });
        const third = footprint.materialize(reversed);
        expect(third.constructionFrame.anchor).toEqual(first.constructionFrame.anchor);
        expect(Math.abs(turf.area(turf.polygon(third.polygon.coordinates)) - turf.area(turf.polygon(first.polygon.coordinates)))).toBeLessThan(1e-3);
    });

    it('reuses a given frame and records it as provenance', () => {
        const [a, b] = lineFrom(PLACES.zagreb, [[90, 50]]);
        const first = footprint.materialize(definitionOf([[latLng(a), latLng(b)]]));
        const frame = frameFromProvenance(first.constructionFrame);
        const again = footprint.materialize(definitionOf([[latLng(a), latLng(b)]]), { frame });
        expect(again.constructionFrame.anchor).toEqual(first.constructionFrame.anchor);
        expect(again.polygon).toEqual(first.polygon);
    });

    it('throws instead of building a partial footprint', () => {
        const [a, b] = lineFrom(PLACES.zagreb, [[90, 50]]);
        const far = destination(PLACES.zagreb, 90, 70000);
        expect(() => footprint.materialize(definitionOf([[latLng(a), latLng(far)]]))).toThrow(/beyond the 60000 m domain|more than the 60000 m/);
        expect(() => footprint.materialize(definitionOf([[latLng(a), { lat: Number.NaN, lng: b[0] }]]))).toThrow(/not finite/);
        expect(() => footprint.materialize(definitionOf([]))).toThrow(/no centre line/);
        expect(() => footprint.materialize(definitionOf([[latLng(a), latLng(b)]], { width: 0 }))).toThrow(/no width/);
        const underground = [latLng(a, { level: -1 }), latLng(b, { level: -1 })];
        expect(() => footprint.materialize(definitionOf([underground]))).toThrow(/underground/);
    });
});

describe('reproduces what the browser built', () => {
    // The Borovje v3 collector: the browser's own footprint of this definition was captured on
    // 2026-10-10 (rekonstrukcije/upu-borovje/data/street-footprints.json, built in HTRS96).
    const snap = JSON.parse(readFileSync(new URL('../../rekonstrukcije/upu-borovje/data/cadastral-snap.json', import.meta.url), 'utf8'));
    const captured = JSON.parse(readFileSync(new URL('../../rekonstrukcije/upu-borovje/data/street-footprints.json', import.meta.url), 'utf8')).footprints;

    it('rebuilds the Borovje collector within millimetres of the browser\'s footprint', () => {
        const street = snap.members['upu-borovje-ulice'];
        const definition = { width: 19, kind: 'road', points: street.segments, segments: street.segments, segmentIds: street.segmentIds, segmentProfiles: street.segmentProfiles, tunnels: [] };
        const result = footprint.materialize(definition);
        const ours = turf.feature(result.polygon);
        const theirs = turf.feature(captured['upu-borovje-ulice-v2']);
        const area = turf.area(ours);
        expect(Math.abs(area - turf.area(theirs)) / area).toBeLessThan(1e-4);
        const left = turf.difference(ours, theirs);
        const right = turf.difference(theirs, ours);
        const symmetric = (left ? turf.area(left) : 0) + (right ? turf.area(right) : 0);
        // ~2.6 km of boundary; HTRS96 differs from the local frame by ≈ 1.6 mm per 19 m, so the
        // symmetric difference is a few square metres at most.
        expect(symmetric).toBeLessThan(5);
    });
});
