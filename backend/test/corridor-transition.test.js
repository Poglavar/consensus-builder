// Transition zones (frontend/js/corridor-transition.js): where they are planned, how one profile's
// strips map onto another's, and the diagonal taper geometry — pure planar, tested in metres.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('../../frontend/js/corridor-transition.js');
const { CORRIDOR_PROFILE_PRESETS, corridorStripSpans, corridorProfileWidth, normalizeCorridorProfile } = require('../../frontend/js/corridor-profile.js');

const wide = normalizeCorridorProfile({ strips: CORRIDOR_PROFILE_PRESETS[26] });
const narrow = normalizeCorridorProfile({ strips: CORRIDOR_PROFILE_PRESETS[7.5] });
const local = normalizeCorridorProfile({ strips: CORRIDOR_PROFILE_PRESETS[10] });

describe('transition length', () => {
    it('is eight metres per metre of width change, clamped to 10..60', () => {
        expect(T.transitionLength(26, 7.5)).toBe(60);
        expect(T.transitionLength(10, 7.5)).toBe(20);
        expect(T.transitionLength(10.5, 10)).toBe(10);
        expect(T.transitionLength(10, 10)).toBe(T.SAME_WIDTH_LENGTH_M);
    });
});

describe('planning', () => {
    it('puts the zone on the narrower stretch at a two-arm boundary, widening back from the node', () => {
        const plans = T.planTransitions([
            { points: [[-200, 0], [0, 0]], profile: wide, width: 26, corridorId: 'r', segmentId: 'a' },
            { points: [[0, 0], [150, 0]], profile: narrow, width: 7.5, corridorId: 'r', segmentId: 'b' }
        ]);
        expect(plans).toHaveLength(1);
        expect(plans[0]).toMatchObject({ entryIndex: 1, end: 'start', length: 60, kind: 'bend' });
        expect(plans[0].from).toBe(wide);
        expect(plans[0].to).toBe(narrow);
    });

    it('lets a record widen back to a wider record it continues, from the junction written into it', () => {
        const plans = T.planTransitions([
            { points: [[0, 0], [150, 0]], profile: narrow, width: 7.5, corridorId: 'b', segmentId: 'b1' }
        ], { junctions: [{ point: [0, 0], arms: [{ dir: [-1, 0], profile: wide, width: 26 }] }] });
        expect(plans).toHaveLength(1);
        expect(plans[0]).toMatchObject({ entryIndex: 0, end: 'start', length: 60, kind: 'bend' });
        expect(plans[0].from).toBe(wide);
        // and a wider record never changes for a narrower one: nothing to plan the other way round
        expect(T.planTransitions([
            { points: [[-200, 0], [0, 0]], profile: wide, width: 26, corridorId: 'a', segmentId: 'a1' }
        ], { junctions: [{ point: [0, 0], arms: [{ dir: [1, 0], profile: narrow, width: 7.5 }] }] })).toEqual([]);
    });

    it('widens the narrower continuation back to its opposite arm at a junction, not the branch', () => {
        const plans = T.planTransitions([
            { points: [[-200, 0], [0, 0]], profile: wide, width: 26, corridorId: 'r', segmentId: 'w' },
            { points: [[0, 0], [200, 0]], profile: local, width: 10, corridorId: 'r', segmentId: 'e' },
            { points: [[0, 0], [0, 120]], profile: narrow, width: 7.5, corridorId: 'r', segmentId: 'n' }
        ]);
        expect(plans).toHaveLength(1);
        expect(plans[0]).toMatchObject({ entryIndex: 1, end: 'start', length: 60, kind: 'junction' });
        expect(plans[0].from).toBe(wide);
        expect(plans[0].to).toBe(local);
    });

    it('never tapers between identical profiles, at a right-angle branch, or on a stub', () => {
        expect(T.planTransitions([
            { points: [[-50, 0], [0, 0]], profile: wide, width: 26, corridorId: 'r' },
            { points: [[0, 0], [50, 0]], profile: wide, width: 26, corridorId: 'r' }
        ])).toEqual([]);
        // a branch leaving at 90° continues nothing
        expect(T.planTransitions([
            { points: [[-50, 0], [0, 0]], profile: wide, width: 26, corridorId: 'r' },
            { points: [[0, 0], [0, 50]], profile: narrow, width: 7.5, corridorId: 'r' }
        ])).toEqual([]);
        // a 5 m narrow stretch can host at most 2.25 m of zone: below the minimum, so none
        expect(T.planTransitions([
            { points: [[-50, 0], [0, 0]], profile: wide, width: 26, corridorId: 'r' },
            { points: [[0, 0], [5, 0]], profile: narrow, width: 7.5, corridorId: 'r' }
        ])).toEqual([]);
    });
});

describe('pieces', () => {
    it('cuts the zone off the end of the stretch and orients its profiles along the piece', () => {
        const pieces = T.piecesOf([[-200, 0], [-100, 0], [0, 0]], [{ end: 'end', length: 60, from: wide, to: narrow, kind: 'bend' }]);
        expect(pieces).toHaveLength(2);
        expect(pieces[0].taper).toBeNull();
        expect(pieces[0].points).toEqual([[-200, 0], [-100, 0], [-60, 0]]);
        expect(pieces[1].points).toEqual([[-60, 0], [0, 0]]);
        // the zone runs towards the node, where the wide profile is handed over
        expect(pieces[1].taper.profileStart).toBe(narrow);
        expect(pieces[1].taper.profileEnd).toBe(wide);
    });

    it('cuts a zone at the start, starting from the opposite arm profile', () => {
        const pieces = T.piecesOf([[0, 0], [200, 0]], [{ end: 'start', length: 60, from: wide, to: local, kind: 'junction' }]);
        expect(pieces).toHaveLength(2);
        expect(pieces[0].points).toEqual([[0, 0], [60, 0]]);
        expect(pieces[0].taper.profileStart).toBe(wide);
        expect(pieces[0].taper.profileEnd).toBe(local);
        expect(pieces[1].taper).toBeNull();
    });
});

describe('strip mapping', () => {
    it('matches by type and direction in order, collapsing the rest onto the seam where they vanish', () => {
        const wideSpans = corridorStripSpans(wide);
        const narrowSpans = corridorStripSpans(narrow);
        const mapped = T.mapSpans(wideSpans, narrowSpans);
        expect(mapped).toHaveLength(wideSpans.length);
        const byType = wideSpans.map((span, index) => [span.type + (span.direction ? ':' + span.direction : ''), mapped[index]]);
        const sidewalkLeft = byType[0][1];
        expect(sidewalkLeft.matched).toBe(true);
        expect(sidewalkLeft.left).toBeCloseTo(3.75, 6);
        expect(sidewalkLeft.right).toBeCloseTo(2.75, 6);
        // verge, cycleway and parking on the left collapse onto the footway kerb at +2.75
        ['verge', 'cycleway:backward', 'parking'].forEach(key => {
            const span = byType.find(([k]) => k === key)[1];
            expect(span.matched).toBe(false);
            expect(span.left).toBeCloseTo(2.75, 6);
            expect(span.right).toBeCloseTo(2.75, 6);
        });
        // the median vanishes into the centre line
        const median = byType.find(([k]) => k === 'median')[1];
        expect(median.left).toBeCloseTo(0, 6);
        expect(median.right).toBeCloseTo(0, 6);
        const drivingBack = byType.find(([k]) => k === 'driving:backward')[1];
        expect(drivingBack).toMatchObject({ matched: true });
        expect(drivingBack.left).toBeCloseTo(2.75, 6);
        expect(drivingBack.right).toBeCloseTo(0, 6);
    });
});

describe('taper geometry', () => {
    it('builds a diagonal ring from the start span to the end span and drops a vanished strip', () => {
        const samples = T.sampleWithNormals([[0, 0], [60, 0]]);
        expect(samples[0].s).toBe(0);
        expect(samples[samples.length - 1].s).toBe(1);
        const ring = T.taperStripRing(samples, { left: 13, right: 10 }, { left: 3.75, right: 2.75 });
        // the left edge runs from y=13 at x=0 to y=3.75 at x=60
        expect(ring[0]).toEqual([0, 13]);
        const atEnd = ring.find(point => Math.abs(point[0] - 60) < 1e-9 && point[1] > 3);
        expect(atEnd[1]).toBeCloseTo(3.75, 6);
        expect(T.taperStripRing(samples, { left: 0, right: 0 }, { left: 0, right: 0 })).toBeNull();
        expect(T.taperWidthAt(26, 7.5, 0.5)).toBeCloseTo(16.75, 6);
        expect(corridorProfileWidth(wide)).toBe(26);
    });
});

// The pieces API in corridor-profile.js: strips, lines and the land of a zone, from the same plan.
describe('pieces through corridor-profile', () => {
    const P = require('../../frontend/js/corridor-profile.js');
    const F = { latLngToMetric: (lat, lng) => [lng, lat], metricToLatLng: (x, y) => [y, x] };
    const avenue = { strips: CORRIDOR_PROFILE_PRESETS[40] };   // two lanes each way around a median
    const street = { strips: CORRIDOR_PROFILE_PRESETS[26] };   // one lane each way around a median

    it('splits a stretch into body and zone, and the zone strips run diagonally', () => {
        const pieces = P.corridorRenderPieces([
            { segmentId: 'a', points: [{ lat: 0, lng: -200 }, { lat: 0, lng: 0 }], profile: avenue, corridorId: 'r' },
            { segmentId: 'b', points: [{ lat: 0, lng: 0 }, { lat: 0, lng: 150 }], profile: street, corridorId: 'r' }
        ], F);
        expect(pieces.map(piece => [piece.segmentId, piece.taper ? 'zone' : 'body'])).toEqual([['a', 'body'], ['b', 'zone'], ['b', 'body']]);
        const zone = pieces[1];
        expect(zone.taper.widthStart).toBe(40);
        expect(zone.taper.widthEnd).toBe(26);
        expect(zone.points[zone.points.length - 1].lng).toBeCloseTo(60, 6); // 8 × 14 m = 112, clamped to 60
        expect(P.corridorProfileWidth(zone.profile)).toBe(40); // the zone carries the wide profile at the node
        const strips = P.buildCorridorPieceStrips(zone, F);
        const outer = strips[0].polygons[0];
        expect(outer[0]).toEqual({ lat: 20, lng: 0 });
        expect(outer.find(point => Math.abs(point.lng - 60) < 1e-9 && point.lat > 5).lat).toBeCloseTo(13, 6);
        // the dropped second driving lane collapses to a point at the narrow end and still draws
        const driving = strips.filter(strip => strip.type === 'driving');
        expect(driving).toHaveLength(4);
    });

    it('ends the line beside a vanishing lane two thirds in and carries the others through', () => {
        const pieces = P.corridorRenderPieces([
            { segmentId: 'a', points: [{ lat: 0, lng: -200 }, { lat: 0, lng: 0 }], profile: avenue, corridorId: 'r' },
            { segmentId: 'b', points: [{ lat: 0, lng: 0 }, { lat: 0, lng: 150 }], profile: street, corridorId: 'r' }
        ], F);
        const markings = P.buildCorridorLaneMarkingsForEntries(pieces, F);
        const zoneLines = markings[1].flatMap(marking => marking.lines);
        // The avenue has one divider per carriageway (between its two same-way lanes); one lane
        // beside each divider vanishes, so both lines end 2/3 of the way along the 60 m zone,
        // which starts wide at the node (lng 0) and narrows towards lng 60.
        expect(zoneLines).toHaveLength(2);
        zoneLines.forEach(line => {
            expect(Math.max(...line.map(point => point.lng))).toBeCloseTo(40, 0);
        });
    });

    it('tapers the land of the zone between the two widths', () => {
        const footprint = require('../../frontend/js/corridor-footprint.js');
        const metric = require('../../frontend/js/metric-frame.js');
        const turf = require('@turf/turf');
        const a = { lat: 45.8, lng: 15.97 };
        const b = { lat: 45.8, lng: 15.97 + 200 / (111320 * Math.cos(45.8 * Math.PI / 180)) };
        const c = { lat: 45.8, lng: b.lng + 150 / (111320 * Math.cos(45.8 * Math.PI / 180)) };
        const definition = { points: [[a, b], [b, c]], segmentIds: ['a', 'b'], profile: avenue, width: 40, segmentProfiles: { b: street }, kind: 'road' };
        const result = footprint.materialize(definition);
        const frame = metric.frameFromProvenance(result.constructionFrame);
        const polygon = turf.feature(result.polygon);
        const inside = (east, north) => {
            const [x, y] = frame.toMetric([b.lng, b.lat]);
            const [lng, lat] = frame.toLngLat([x + east, y + north]);
            return turf.booleanPointInPolygon(turf.point([lng, lat]), polygon);
        };
        // 30 m past the node the zone is halfway: 33 m wide, so 15 m north is in and 19 m is out.
        expect(inside(30, 15)).toBe(true);
        expect(inside(30, 19)).toBe(false);
        // before the node the avenue is 40 m: 19 m north is in.
        expect(inside(-30, 19)).toBe(true);
        // past the zone the street is 26 m: 14 m north is out.
        expect(inside(100, 14)).toBe(false);
    });
});
