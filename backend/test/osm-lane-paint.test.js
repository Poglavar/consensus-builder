// The layer that paints the streets that already exist. `lanesForParcel` is the whole of it — the
// code above it only schedules and the code below it only draws — so it is run here against the real
// Gundulićeva geometry with stubbed collaborators, and what comes out is checked to be actual lane
// polygons rather than an empty list nobody would notice.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
    growBbox, ringsNear, boxOf, ringsOf, runIsUnderProposal, lanesForParcel
} = require(path.join(here, '../../frontend/js/osm-lane-paint.js'));
const segmentation = require(path.join(here, '../../frontend/js/road-segmentation.js'));
const translator = require(path.join(here, '../../frontend/js/osm-profile.js'));
const profiles = require(path.join(here, '../../frontend/js/corridor-profile.js'));

const DONJI_GRAD = JSON.parse(readFileSync(path.join(here, 'fixtures/osm-donji-grad.json'), 'utf8'));
const block = DONJI_GRAD.gundulic;
const street = block.ways.find(way => way.osm_id === block.streetId);

// An exact inverse pair, so a strip built in lat/lng comes back as the metres it was measured in and
// the polygons can be checked against real widths.
const project = (lat, lng) => [lng * 1000, lat * 1000];
const unproject = (x, y) => [y / 1000, x / 1000];

// A road parcel around the street: the centreline pushed out `half` metres each side. A real cadastral
// road parcel is not this tidy, but it gives the run two kerb lines to be measured against, which is
// all the paint needs.
function parcelAround(pointsXY, half) {
    // Extend past both ends first: a parcel that stops exactly where the centreline does leaves the
    // run's endpoints ON its boundary, and the clip then keeps nothing at all. A real road parcel
    // always runs on past the piece of street inside it.
    const first = pointsXY[0];
    const second = pointsXY[1];
    const last = pointsXY[pointsXY.length - 1];
    const secondLast = pointsXY[pointsXY.length - 2];
    const step = (from, towards, by) => {
        const len = Math.hypot(towards[0] - from[0], towards[1] - from[1]) || 1;
        return [from[0] + (from[0] - towards[0]) / len * by, from[1] + (from[1] - towards[1]) / len * by];
    };
    const spine = [step(first, second, 10), ...pointsXY, step(last, secondLast, 10)];

    const left = [];
    const right = [];
    for (let i = 0; i < spine.length; i += 1) {
        const a = spine[Math.max(0, i - 1)];
        const b = spine[Math.min(spine.length - 1, i + 1)];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const nx = -(b[1] - a[1]) / len;
        const ny = (b[0] - a[0]) / len;
        left.push([spine[i][0] + nx * half, spine[i][1] + ny * half]);
        right.push([spine[i][0] - nx * half, spine[i][1] - ny * half]);
    }
    const ring = left.concat(right.reverse());
    ring.push(ring[0].slice());
    return ring;
}

const context = (corridors = []) => ({
    ways: block.ways,
    segments: segmentation.segmentRoadNetwork(
        block.ways.filter(way => way.properties.highway_type === 'tertiary').map(way => way.pointsXY)
    ),
    buildings: [],
    buildingBoxes: [],
    corridors
});

describe('the bbox the lane paint fetches', () => {
    it('reaches past the viewport, so a run is segmented against the junctions just off screen', () => {
        expect(growBbox('1000,2000,3000,4000', 80)).toBe('920,1920,3080,4080');
    });

    it('refuses a bbox that is not one, rather than fetching nonsense', () => {
        expect(growBbox('', 80)).toBe(null);
        expect(growBbox('1,2,3', 80)).toBe(null);
        expect(growBbox('1,2,3,four', 80)).toBe(null);
    });
});

describe('the bounding-box rejects that keep a viewport paint linear', () => {
    it('keeps only the rings whose box could touch the parcel', () => {
        const rings = [
            [[0, 0], [1, 0], [1, 1]],       // right on it
            [[500, 500], [501, 500], [501, 501]]   // far away
        ];
        const near = ringsNear(rings, rings.map(r => boxOf([r])), [0, 0, 10, 10]);
        expect(near.length).toBe(1);
        expect(near[0]).toBe(rings[0]);
    });

    it('measures a box over every ring it is given', () => {
        expect(boxOf([[[0, 0], [10, 5]], [[-3, 2], [4, 9]]])).toEqual([-3, 0, 10, 9]);
    });

    it('reads the outer ring of a polygon and of every part of a multipolygon', () => {
        expect(ringsOf({ type: 'Polygon', coordinates: [[[0, 0]], [[9, 9]]] }).length).toBe(1);
        expect(ringsOf({ type: 'MultiPolygon', coordinates: [[[[0, 0]]], [[[5, 5]]]] }).length).toBe(2);
        expect(ringsOf({ type: 'LineString', coordinates: [[0, 0]] })).toEqual([]);
        expect(ringsOf(null)).toEqual([]);
    });
});

// Where the paint has to stop. An adopted street is drawn from its OWN cross-section — the one the
// editor may just have changed — so painting the OSM reconstruction over it would show the street as
// it was, and the edit would look like it had not applied.
describe('ground a proposal already covers', () => {
    const straight = [[0, 0], [0, 30], [0, 60], [0, 90], [0, 120]];

    it('recognises a run lying along a proposed corridor', () => {
        expect(runIsUnderProposal(straight, [{ points: [[0, -10], [0, 130]], half: 8 }])).toBe(true);
    });

    it('leaves the street beside it alone', () => {
        expect(runIsUnderProposal(straight, [{ points: [[40, -10], [40, 130]], half: 8 }])).toBe(false);
    });

    // Proximity, not endpoint matching: a re-segmented run's ends move with the fetched bbox while
    // the ground it covers does not, so a key comparison would miss the case this exists for.
    it('still recognises it when the proposal covers only part of the run', () => {
        expect(runIsUnderProposal(straight, [{ points: [[0, 20], [0, 130]], half: 8 }])).toBe(true);
        expect(runIsUnderProposal(straight, [{ points: [[0, 90], [0, 130]], half: 8 }])).toBe(false);
    });

    it('takes a narrow proposal as covering only what it is wide enough to cover', () => {
        const offset = [[6, 0], [6, 30], [6, 60], [6, 90], [6, 120]];
        expect(runIsUnderProposal(offset, [{ points: [[0, -10], [0, 130]], half: 8 }])).toBe(true);
        expect(runIsUnderProposal(offset, [{ points: [[0, -10], [0, 130]], half: 2 }])).toBe(false);
    });

    it('says no when there are no proposals at all', () => {
        expect(runIsUnderProposal(straight, [])).toBe(false);
        expect(runIsUnderProposal(straight, null)).toBe(false);
    });
});

describe('painting one road parcel', () => {
    beforeEach(() => {
        globalThis.RoadSegmentation = segmentation;
        globalThis.OsmProfile = translator;
        globalThis.wgs84ToHTRS96 = project;
        globalThis.htrs96ToWGS84 = unproject;
        globalThis.corridorProfileFromOsmTags = profiles.corridorProfileFromOsmTags;
        globalThis.buildCorridorStrips = profiles.buildCorridorStrips;
        globalThis.corridorStripSurface = profiles.corridorStripSurface;
    });
    afterEach(() => {
        ['RoadSegmentation', 'OsmProfile', 'wgs84ToHTRS96', 'htrs96ToWGS84',
            'corridorProfileFromOsmTags', 'buildCorridorStrips', 'corridorStripSurface']
            .forEach(key => { delete globalThis[key]; });
    });

    const paint = (half = 8) => lanesForParcel({ id: 'test', rings: [parcelAround(street.pointsXY, half)] }, context());

    it('paints Gundulićeva as the lanes it has, not as one grey bar', () => {
        const lanes = paint();
        expect(lanes.length).toBeGreaterThan(0);
        const types = lanes.map(lane => lane.type);
        expect(types).toContain('driving');
        expect(types).toContain('sidewalk');
        expect(types).toContain('cycleway');
        expect(lanes.every(lane => lane.name === 'Gundulićeva ulica')).toBe(true);
    });

    it('gives every lane a closed ring of real coordinates and its own surface colour', () => {
        paint().forEach(lane => {
            expect(lane.polygon.length).toBeGreaterThan(2);
            expect(lane.polygon.every(p => Number.isFinite(p.lat) && Number.isFinite(p.lng))).toBe(true);
            expect(lane.surface).toMatch(/^#[0-9a-f]{6}$/i);
        });
        // The three kinds of lane are drawn in three different colours, or the paint says nothing.
        const bySurface = new Map(paint().map(lane => [lane.type, lane.surface]));
        expect(new Set(bySurface.values()).size).toBeGreaterThan(2);
    });

    // The lanes must fill the corridor they were measured in — that is the whole contract the
    // translator's fit exists to keep, and this is where it reaches the screen.
    it('spans the width of the parcel it was measured against', () => {
        [6, 8, 11].forEach(half => {
            const lanes = paint(half);
            expect(lanes.length, `half ${half}`).toBeGreaterThan(0);
            const spanned = Math.max(...lanes.map(lane => Math.max(...lane.polygon.map(p => p.lng * 1000))))
                - Math.min(...lanes.map(lane => Math.min(...lane.polygon.map(p => p.lng * 1000))));
            // The street runs nearly north, so its cross-section spans in x (lng). Allow for the
            // slight bearing and for the corridor being measured at its narrowest station.
            expect(spanned, `half ${half}`).toBeGreaterThan(half);
            expect(spanned, `half ${half}`).toBeLessThan(2 * half + 4);
        });
    });

    // The dashes, bay outlines and arrows are drawn by corridor-render.js's own renderers, which need
    // a centreline and a profile per run — so the paint has to hand those back rather than only
    // polygons, or the street comes out as flat colour with no markings on it at all.
    it('hands back the centreline and section of every run, for the markings to be drawn from', () => {
        const marks = [];
        const lanes = lanesForParcel({ id: 'test', rings: [parcelAround(street.pointsXY, 8)] }, context(), marks);
        expect(lanes.length).toBeGreaterThan(0);
        expect(marks.length).toBe(1);
        expect(marks[0].centerline.every(p => Number.isFinite(p.lat) && Number.isFinite(p.lng))).toBe(true);
        expect(marks[0].profile.strips.length).toBe(6);

        // And those two are all the marking builders need: real dashes come out of them.
        const markings = profiles.buildCorridorLaneMarkings([marks[0].centerline], marks[0].profile);
        expect(markings.length).toBeGreaterThan(0);
        expect(markings.some(marking => marking.kind === 'lane' || marking.kind === 'centerline')).toBe(true);
        markings.forEach(marking => marking.lines.forEach(line => {
            expect(line.length).toBeGreaterThan(1);
            expect(line.every(p => Number.isFinite(p.lat) && Number.isFinite(p.lng))).toBe(true);
        }));
    });

    it('leaves the markings list alone for a parcel it paints nothing in', () => {
        const marks = [];
        lanesForParcel({ id: 'empty', rings: [[[5000, 5000], [5020, 5000], [5020, 5020], [5000, 5000]]] }, context(), marks);
        expect(marks).toEqual([]);
    });

    // The reason the whole proposal check exists: an adopted street whose cross-section was edited
    // must show THAT section, not the one OSM describes.
    it('paints nothing where an applied road proposal already covers the street', () => {
        const corridor = { points: street.pointsXY.map(([x, y]) => [x, y]), half: 10 };
        const lanes = lanesForParcel(
            { id: 'test', rings: [parcelAround(street.pointsXY, 8)] },
            context([corridor])
        );
        expect(lanes).toEqual([]);
        // …and still paints it when the proposal is somewhere else entirely.
        expect(lanesForParcel(
            { id: 'test', rings: [parcelAround(street.pointsXY, 8)] },
            context([{ points: [[400, 0], [400, 200]], half: 10 }])
        ).length).toBeGreaterThan(0);
    });

    // Painting is not adopting. An adopted road's section MUST total its corridor — the footprint is
    // that width — but a painted street is as wide as the street is, and the corridor is only a
    // ceiling. A street does not grow to fill its parcel: the ground beside it is a verge, a layby or
    // somebody's forecourt. Spending the difference on pavement is how a 9 m carriageway with 26 m of
    // open ground beside it came out as a 35 m road.
    const spanOf = lanes => Math.max(...lanes.flatMap(lane => lane.polygon.map(p => p.lng * 1000)))
        - Math.min(...lanes.flatMap(lane => lane.polygon.map(p => p.lng * 1000)));

    it('draws the street at the width OSM gives it, not at the width of its parcel', () => {
        const inPlace = lanesForParcel({ id: 'street', rings: [parcelAround(street.pointsXY, 8)] }, context());
        const inPlaza = lanesForParcel({ id: 'plaza', rings: [parcelAround(street.pointsXY, 40)] }, context());
        expect(inPlace.length).toBeGreaterThan(0);
        expect(inPlaza.length).toBeGreaterThan(0);
        // 80 m of parcel, and still a street: the same lanes, no wider than in the 16 m one.
        expect(spanOf(inPlaza)).toBeLessThan(32);
        expect(inPlaza.map(lane => lane.type)).toEqual(inPlace.map(lane => lane.type));
    });

    // The neighbours that bound a street are mostly in OTHER parcels — always so at a junction, where
    // one road parcel sprawls across the ground of everything meeting there. This is that shape: an
    // 80 m parcel with a parallel street running 25 m off, well inside it. Bounded by that street the
    // section is a street; bounded only by the parcel it is 80 m of pavement over the neighbour.
    //
    // Only the WHOLE network can supply it: the neighbour is a segment of another parcel's street, so
    // anything reading this parcel's own runs finds nothing at all to stop at.
    it('is bounded by a street that this parcel keeps too little of to call a run', () => {
        // The junction shape, in miniature: a road parcel sprawling 80 m across the ground where
        // several streets meet, and a neighbouring street of which only a 15 m stub falls inside it.
        // That stub is under MIN_RUN_LENGTH, so the parcel's own run list drops it — and a rule that
        // looked only at this parcel's runs would then find NOTHING to stop the section, which is how
        // a pavement came to be painted across the streets on the other side of the junction.
        const stub = [[street.pointsXY[0][0] + 12, 50], [street.pointsXY[1][0] + 12, 65]];
        const parcel = () => ({ id: 'junction', rings: [parcelAround(street.pointsXY, 40)] });
        expect(segmentation.polylineLength(stub)).toBeLessThan(20);

        const withNeighbour = context();
        withNeighbour.segments = withNeighbour.segments.concat([stub]);
        const squeezed = lanesForParcel(parcel(), withNeighbour);
        const unbounded = lanesForParcel(parcel(), context());
        expect(squeezed.length).toBeGreaterThan(0);
        expect(unbounded.length).toBeGreaterThan(0);

        // Neither is a slab: sizing the street from OSM is what guarantees that, and it holds even
        // where nothing bounds the rays. Knowing about the neighbour can only ever narrow it further.
        expect(spanOf(squeezed)).toBeLessThan(32);
        expect(spanOf(unbounded)).toBeLessThan(32);
        expect(spanOf(squeezed)).toBeLessThanOrEqual(spanOf(unbounded) + 0.001);
    });

    it('paints nothing, rather than throwing, when the collaborators are missing', () => {
        delete globalThis.OsmProfile;
        expect(paint()).toEqual([]);
    });

    it('paints nothing for a parcel with no street in it', () => {
        const empty = lanesForParcel({ id: 'empty', rings: [[[5000, 5000], [5020, 5000], [5020, 5020], [5000, 5020], [5000, 5000]]] }, context());
        expect(empty).toEqual([]);
    });
});
