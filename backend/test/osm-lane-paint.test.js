// The layer that paints the streets that already exist. `lanesForParcel` is the whole of it — the
// code above it only schedules and the code below it only draws — so it is run here against the real
// Gundulićeva geometry with stubbed collaborators, and what comes out is checked to be actual lane
// polygons rather than an empty list nobody would notice.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const paint = require(path.join(here, '../../frontend/js/osm-lane-paint.js'));
const {
    growBbox, ringsNear, boxOf, ringsOf, runIsUnderProposal, lanesForParcel,
    describeSegment, keysToForget, explainAt, paintSegment, segmentEdgeKeys,
    unownedSegmentRuns, EXPLAINED_LIMIT
} = paint;
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

// A real failure from Strojarska cesta. A northern viewport did not fetch the side street at the
// western end, so these ten source edges belonged to one 287 m segment. After panning south, the
// newly visible junction split the same edges into the 111 m segment shown by the hover readout.
// Endpoint-keyed caching retained both profiles and drew the road twice with slightly different
// centreline shifts. The source edges are the stable identity underneath both segmentations.
describe('one paint owner when viewports segment the same road differently', () => {
    const strojarskaParent = [
        [460493.025100566, 5073964.416922977],
        [460491.178067824, 5073962.43925142],
        [460488.608022282, 5073960.44395135],
        [460486.03967187, 5073958.715379377],
        [460483.420374894, 5073957.531722308],
        [460479.506200718, 5073956.85643834],
        [460472.46742929, 5073956.212154017],
        [460456.62587944, 5073955.001523501],
        [460420.735404158, 5073952.251540888],
        [460396.868323796, 5073950.469817897],
        [460384.984663421, 5073949.478645901],
        [460375.353980718, 5073948.295298539],
        [460365.283761577, 5073946.447925962],
        [460350.575371926, 5073942.540727739],
        [460338.172938249, 5073938.218732744],
        [460330.098144192, 5073934.802704827],
        [460323.029408434, 5073930.691187934],
        [460312.627064854, 5073923.100042606],
        [460306.658529831, 5073917.214376019],
        [460301.350960846, 5073911.36894705],
        [460298.311720562, 5073907.731839779],
        [460293.498544753, 5073901.405352046],
        [460290.239054321, 5073896.147000974],
        [460286.470681795, 5073887.891103636],
        [460281.61644838, 5073876.36349831],
        [460280.196272521, 5073870.648828546],
        [460279.323778474, 5073864.274926234],
        [460278.596649656, 5073856.321895292],
        [460278.724382523, 5073845.907186482],
        [460279.391745917, 5073834.788840203]
    ];
    const strojarskaChild = strojarskaParent.slice(0, 11);
    const segment = points => ({
        points,
        key: paint.segmentKey(points),
        box: boxOf([points]),
        parcels: [{ id: 'road' }],
        street: { id: 'name:Strojarska cesta', name: 'Strojarska cesta' }
    });
    const ownersOf = (points, owner = 'first') => new Map(segmentEdgeKeys(points).map(key => [key, owner]));

    it('does not paint the 111 m child over the already-painted 287 m parent', () => {
        expect(segmentation.polylineLength(strojarskaChild)).toBeCloseTo(110.7, 1);
        expect(segmentation.polylineLength(strojarskaParent)).toBeCloseTo(287.4, 1);
        expect(unownedSegmentRuns(segment(strojarskaChild), ownersOf(strojarskaParent))).toEqual([]);
    });

    it('keeps only the genuinely new tail when the shorter segmentation was painted first', () => {
        const runs = unownedSegmentRuns(segment(strojarskaParent), ownersOf(strojarskaChild));
        expect(runs).toHaveLength(1);
        expect(runs[0].points[0]).toEqual(strojarskaParent[10]);
        expect(runs[0].points.at(-1)).toEqual(strojarskaParent.at(-1));
        expect(segmentation.polylineLength(runs[0].points)).toBeCloseTo(176.7, 1);
        expect(segmentEdgeKeys(runs[0].points).some(key => ownersOf(strojarskaChild).has(key))).toBe(false);
    });

    it('does not confuse a nearby parallel centreline with the same source edges', () => {
        const parallel = strojarskaChild.map(([x, y]) => [x, y + 0.5]);
        expect(unownedSegmentRuns(segment(parallel), ownersOf(strojarskaChild))).toHaveLength(1);
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
        // Without this the drawn line never moves off the OSM one, and the asymmetric-corridor
        // behaviour below cannot be exercised at all.
        globalThis.offsetPolylinePlanar = profiles.offsetPolylinePlanar;
        globalThis.corridorStripRingPlanar = profiles.corridorStripRingPlanar;
        // The road parcels are dissolved with turf; without it the layer keeps every cadastral seam.
        globalThis.turf = require('@turf/turf');
    });
    afterEach(() => {
        ['RoadSegmentation', 'OsmProfile', 'wgs84ToHTRS96', 'htrs96ToWGS84',
            'corridorProfileFromOsmTags', 'buildCorridorStrips', 'corridorStripSurface',
            'offsetPolylinePlanar', 'corridorStripRingPlanar', 'turf']
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

    // The tags belong to the line OSM DREW; the drawing goes where the corridor is. Reading the
    // shifted line loses the very way the section comes from — ways are matched within 4 m of the run
    // and the shift can be twice that — which is how a well-mapped 285 m stretch of boulevard came
    // back as "no OSM way describes this segment".
    it('reads the tags off the OSM line even when the drawing moves off it', () => {
        // A parcel whose middle is 8 m to one side of the street: enough asymmetry to shift the
        // drawn line clear of the way it was read from.
        const offset = street.pointsXY.map(([x, y]) => [x + 8, y]);
        const lanes = lanesForParcel({ id: 'lopsided', rings: [parcelAround(offset, 12)] }, context());
        expect(lanes.length).toBeGreaterThan(0);
        expect(lanes.every(lane => lane.name === 'Gundulićeva ulica')).toBe(true);
    });

    // A segment crosses as many parcels as the land register happens to have drawn. Measuring it
    // against them separately makes every internal seam a kerb — a 290 m stretch of Ulica grada
    // Vukovara came out 5 m wide — so the road parcels are dissolved into one surface first.
    it('measures across a cadastral seam rather than stopping at it', () => {
        const { dissolveRoadLand } = require(path.join(here, '../../frontend/js/osm-lane-paint.js'));
        // Two abutting halves of one road parcel, split down the middle of the street.
        const whole = parcelAround(street.pointsXY, 9);
        const west = parcelAround(street.pointsXY.map(([x, y]) => [x - 4.5, y]), 4.5);
        const east = parcelAround(street.pointsXY.map(([x, y]) => [x + 4.5, y]), 4.5);

        const undissolved = lanesForParcel({ id: 'split', rings: [west, east] }, context());
        const dissolved = lanesForParcel(
            { id: 'split', rings: dissolveRoadLand([{ rings: [west, east] }]) }, context()
        );
        const span = lanes => (lanes.length
            ? Math.max(...lanes.flatMap(l => l.polygon.map(p => p.lng * 1000)))
                - Math.min(...lanes.flatMap(l => l.polygon.map(p => p.lng * 1000)))
            : 0);
        const undivided = lanesForParcel({ id: 'whole', rings: [whole] }, context());
        // The seam down the middle must not make the street half as wide as the same land undivided.
        expect(span(dissolved)).toBeGreaterThan(span(undissolved));
        expect(Math.abs(span(dissolved) - span(undivided))).toBeLessThan(3);
    });

    // The far side of the kerb. A street's corridor ends where somebody's plot begins, and that
    // boundary is in the cadastre whether or not a building was ever surveyed on it — which makes it a
    // steadier edge than a footprint that may be set back from the line, missing, or not yet loaded.
    it('is bounded by the parcels that are not road land', () => {
        // No road-land ring and no buildings: the plots either side are the only thing to measure to.
        const plot = (from, to) => [[from, -20], [from, 200], [to, 200], [to, -20], [from, -20]];
        const other = [plot(6, 40), plot(-40, -6)];
        const withPlots = { ...context(), otherRings: other, otherBoxes: other.map(r => boxOf([r])) };

        const lanes = lanesForParcel({ id: 'kerbless', rings: [parcelAround(street.pointsXY, 40)] }, withPlots);
        expect(lanes.length).toBeGreaterThan(0);
        const span = Math.max(...lanes.flatMap(l => l.polygon.map(p => p.lng * 1000)))
            - Math.min(...lanes.flatMap(l => l.polygon.map(p => p.lng * 1000)));
        expect(span).toBeLessThan(20);   // the 12 m between the plots, not the 80 m parcel
    });

    // The bounding-box rejects that keep a viewport paint linear must not throw away anything a ray
    // could reach. A straight street's box is a sliver, so a pad of a few metres discards every kerb
    // line beside it — and 212 m of Ulica grada Vukovara came back "measured at only 1 stations",
    // there being nothing left on one side at all but one of its ~53 stations.
    it('looks for kerb lines as far as a ray can travel, not just beside the centreline', () => {
        const plot = (from, to) => [[from, -20], [from, 200], [to, 200], [to, -20], [from, -20]];
        // 25 m out on each side: well inside the 60 m a ray goes, well outside a few metres of pad.
        const other = [plot(28, 60), plot(-60, -22)];
        const far = { ...context(), otherRings: other, otherBoxes: other.map(r => boxOf([r])) };

        // The parcel's own edges are 200 m away, so the plots are the only thing a ray can hit.
        const lanes = lanesForParcel({ id: 'wide-open', rings: [parcelAround(street.pointsXY, 200)] }, far);
        expect(lanes.length).toBeGreaterThan(0);
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

// ---------------------------------------------------------------------------
// What the layer SAYS about itself, and what it holds on to while saying it.
//
// A layer that quietly declines to draw a street is impossible to argue with, so every segment it
// looks at leaves a verdict and pointing at one reads it out. Below: that the verdict is honest (a
// truncated fetch is not the same as OSM having nothing), translated, bounded, and that it does not
// shout into the console every time somebody clicks a parcel.
// ---------------------------------------------------------------------------

describe('what a segment\'s verdict says', () => {
    const segment = { name: 'Gundulićeva ulica', length: 205.4, points: [[0, 0], [0, 205]] };

    it('reads out a painted street with its width', () => {
        const text = describeSegment({ ...segment, state: 'painted', width: 12.25 });
        expect(text).toBe('Gundulićeva ulica · 205 m segment · 12.3 m wide');
    });

    it('says outright when a street was not painted, and why', () => {
        const text = describeSegment({ ...segment, state: 'skipped', reason: 'measured at only 3 stations' });
        expect(text).toContain('NOT painted');
        expect(text).toContain('measured at only 3 stations');
    });

    it('names a street that OSM does not name', () => {
        expect(describeSegment({ ...segment, name: null, state: 'painted', width: 9 }))
            .toContain('unnamed street');
    });

    // The frame is the app's; the reason is the diagnostic and stays in the one language this layer
    // is written in, so a bug report reads the same whoever files it.
    it('goes through the app\'s translator, keeping the reason verbatim', () => {
        const seen = [];
        const translate = (key, fallback, params) => {
            seen.push(key);
            if (key === 'sidebar.roads.lanePaint.skipped') return `NEMA: ${params.reason}`;
            return fallback;
        };
        const text = describeSegment(
            { ...segment, state: 'skipped', reason: 'no kerb line found on both sides' },
            translate
        );
        expect(text).toBe('NEMA: no kerb line found on both sides');
        expect(seen).toContain('sidebar.roads.lanePaint.skipped');
    });

    it('is translated everywhere the app is', () => {
        const keys = ['unnamed', 'segment', 'segmentOf', 'adopted', 'painted', 'wide', 'paintedPlain',
            'skipped', 'zoomIn'];
        ['en', 'hr', 'sr', 'es'].forEach(lang => {
            const strings = JSON.parse(readFileSync(path.join(here, `../../frontend/i18n/${lang}.json`), 'utf8'));
            const lanePaint = strings.sidebar.roads.lanePaint;
            keys.forEach(key => expect(typeof lanePaint[key], `${lang}.${key}`).toBe('string'));
        });
    });
});

// A way that fell off the end of a truncated answer is indistinguishable from a way OSM does not
// have — so the layer must not report the first as the second and send somebody to fix tagging that
// was fine all along.
describe('a truncated fetch is not the same as OSM having nothing', () => {
    const run = [[0, 0], [0, 120]];
    const ring = [[-10, -10], [10, -10], [10, 130], [-10, 130], [-10, -10]];
    const parcel = { id: 'road-1', rings: [ring] };
    const context = (truncated) => ({
        ways: [],                       // nothing came back that covers the run
        segments: [run],
        buildings: [], buildingBoxes: [],
        otherRings: [], otherBoxes: [],
        corridors: [],
        adopted: new Set(),
        truncated,
        unproject: (x, y) => [y / 1000, x / 1000]
    });

    beforeEach(() => {
        globalThis.RoadSegmentation = segmentation;
        globalThis.OsmProfile = translator;
        globalThis.htrs96ToWGS84 = (x, y) => [y / 1000, x / 1000];
        globalThis.corridorProfileFromOsmTags = profiles.corridorProfileFromOsmTags;
        globalThis.corridorStripRingPlanar = profiles.corridorStripRingPlanar;
    });
    afterEach(() => {
        ['RoadSegmentation', 'OsmProfile', 'htrs96ToWGS84', 'corridorProfileFromOsmTags',
            'corridorStripRingPlanar'].forEach(key => { delete globalThis[key]; });
    });

    const verdict = (truncated) => paintSegment(
        { key: 'k', points: run, box: paint.boxOf([run]), parcels: [parcel], parcel, street: { id: null, name: null } },
        context(truncated)
    );

    it('blames OSM when the answer was complete', () => {
        const record = verdict(false);
        expect(record.state).toBe('skipped');
        expect(record.reason).toBe('no OSM way describes this segment');
    });

    it('blames the limit when the answer was not', () => {
        const record = verdict(true);
        expect(record.state).toBe('skipped');
        expect(record.reason).toContain('truncated');
    });
});

// The layer refuses to draw anything wider than a street, because past that the rays found a plaza or
// a junction mouth rather than two kerbs. A tram reservation is neither: it was read off OSM's own
// geometry, and it is genuinely part of the street — so it must not be what pushes a boulevard over.
describe('a boulevard is not disqualified by the tram down it', () => {
    const run = [[0, 0], [0, 240]];
    // 40 m of road parcel, wide enough that the section is capped by what OSM says and not by the kerbs.
    const ring = [[-20, -20], [20, -20], [20, 260], [-20, 260], [-20, -20]];
    const parcel = { id: 'road-1', rings: [ring] };
    const way = (properties, offset = 0) => ({
        pointsXY: [[offset, 0], [offset, 240]],
        properties
    });
    const boulevard = way({
        osm_id: '1', highway_type: 'primary', name: 'Savska cesta',
        // 29.5 m of road — under the cap on its own, over it once the two tracks are added.
        tags: { highway: 'primary', lanes: '5', 'sidewalk:both': 'yes', 'sidewalk:both:width': '6' }
    });
    const trams = [
        way({ osm_id: '2', highway_type: null, railway_type: 'tram', tags: { railway: 'tram', gauge: '1000' } }, 2.5),
        way({ osm_id: '3', highway_type: null, railway_type: 'tram', tags: { railway: 'tram', gauge: '1000' } }, -2.5)
    ];
    const context = (ways) => ({
        ways, segments: [run],
        buildings: [], buildingBoxes: [],
        otherRings: [], otherBoxes: [],
        roadLandRings: [ring], roadLandBoxes: [paint.boxOf([ring])],
        corridors: [], adopted: new Set(), truncated: false,
        unproject: (x, y) => [y / 1000, x / 1000]
    });

    beforeEach(() => {
        globalThis.RoadSegmentation = segmentation;
        globalThis.OsmProfile = translator;
        globalThis.wgs84ToHTRS96 = (lat, lng) => [lng * 1000, lat * 1000];
        globalThis.htrs96ToWGS84 = (x, y) => [y / 1000, x / 1000];
        globalThis.corridorProfileFromOsmTags = profiles.corridorProfileFromOsmTags;
        globalThis.corridorStripRingPlanar = profiles.corridorStripRingPlanar;
        globalThis.corridorStandardWidth = profiles.corridorStandardWidth;
        globalThis.buildCorridorStrips = profiles.buildCorridorStrips;
        globalThis.corridorStripSurface = profiles.corridorStripSurface;
        globalThis.offsetPolylinePlanar = profiles.offsetPolylinePlanar;
    });
    afterEach(() => {
        ['RoadSegmentation', 'OsmProfile', 'wgs84ToHTRS96', 'htrs96ToWGS84', 'corridorProfileFromOsmTags',
            'corridorStripRingPlanar', 'corridorStandardWidth', 'buildCorridorStrips',
            'corridorStripSurface', 'offsetPolylinePlanar'].forEach(key => { delete globalThis[key]; });
    });

    const verdict = (ways) => paintSegment(
        { key: 'k', points: run, box: paint.boxOf([run]), parcels: [parcel], parcel, street: { id: null, name: 'Savska cesta' } },
        context(ways)
    );

    it('paints one wider than the cap, because the extra width is rails', () => {
        const record = verdict([boulevard, ...trams]);
        expect(record.state, record.reason).toBe('painted');
        expect(record.width, 'the test is pointless unless it really is over the cap')
            .toBeGreaterThan(paint.PAINT_MAX_WIDTH);
        expect(record.lanes.some(lane => lane.type === 'rail')).toBe(true);
    });

    it('still refuses one that is simply too wide to be a street', () => {
        const plaza = way({
            osm_id: '9', highway_type: 'primary', name: 'Not a street',
            tags: { highway: 'primary', lanes: '10', 'sidewalk:both': 'yes', 'sidewalk:both:width': '6' }
        });
        const record = verdict([plaza]);
        expect(record.state).toBe('skipped');
        expect(record.reason).toContain("is not a street's width");
    });
});

describe('the register of verdicts is bounded', () => {
    it('has a ceiling of its own, because a skipped segment has no layers to be evicted with', () => {
        expect(EXPLAINED_LIMIT).toBeGreaterThan(0);
    });

    it('drops the oldest first, and only as many as it must', () => {
        const keys = ['a', 'b', 'c', 'd', 'e'];
        expect(keysToForget(keys, new Set(), 3)).toEqual(['a', 'b']);
        expect(keysToForget(keys, new Set(), 5)).toEqual([]);
        expect(keysToForget(keys, new Set(), 9)).toEqual([]);
    });

    it('never drops a street that is still drawn', () => {
        const keys = ['a', 'b', 'c', 'd', 'e'];
        expect(keysToForget(keys, new Set(['a', 'b']), 3)).toEqual(['c', 'd']);
        // Every verdict still has a street on the map: nothing may be dropped, over the limit or not.
        expect(keysToForget(keys, new Set(keys), 2)).toEqual([]);
    });
});

describe('finding the segment under the pointer', () => {
    const records = [
        { key: 'near', points: [[0, 0], [0, 100]], box: [0, 0, 0, 100], name: 'Near', state: 'painted', width: 10 },
        { key: 'far', points: [[500, 0], [500, 100]], box: [500, 0, 500, 100], name: 'Far', state: 'painted', width: 10 }
    ];

    it('picks the nearest street that was looked at', () => {
        expect(explainAt([3, 50], records).key).toBe('near');
        expect(explainAt([497, 50], records).key).toBe('far');
    });

    it('finds nothing where nothing was looked at', () => {
        expect(explainAt([250, 50], records)).toBe(null);
        expect(explainAt([3, 50], records, 1)).toBe(null);
    });
});

// Below its minimum zoom a lane is thinner than a pixel, so the layer draws nothing — which from the
// outside is a toggle that does not work. It has to say which of the two it is.
describe('being switched on at a zoom it cannot draw at', () => {
    let readouts;

    const settle = async (rounds = 12) => {
        for (let i = 0; i < rounds; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
    };

    beforeEach(() => {
        readouts = [];
        globalThis.document = {
            createElement() {
                const node = { className: '', hidden: true, textContent: '', remove() { node.removed = true; } };
                readouts.push(node);
                return node;
            },
            body: { appendChild() { } },
            getElementById: () => null      // no sidebar checkbox: the toggle just flips
        };
        const listeners = new Map();
        globalThis.map = {
            zoom: 12,
            getZoom() { return this.zoom; },
            getBounds: () => ({ intersects: () => true }),
            getPane: () => ({ style: {} }),
            createPane: () => ({ style: {} }),
            hasLayer: () => false,
            addLayer() { return this; },
            removeLayer() { return this; },
            on(events, fn) { String(events).split(' ').forEach(e => listeners.set(e, fn)); return this; },
            off(events) { String(events).split(' ').forEach(e => listeners.delete(e)); return this; },
            fire(event) { const fn = listeners.get(event); if (fn) fn(); }
        };
        globalThis.L = {
            layerGroup: () => ({
                addLayer() { return this; }, removeLayer() { return this; },
                hasLayer() { return false; }, clearLayers() { return this; },
                addTo(t) { t.addLayer(this); return this; }
            })
        };
        globalThis.wgs84ToHTRS96 = (lat, lng) => [lng * 1000, lat * 1000];
        globalThis.htrs96ToWGS84 = (x, y) => [y / 1000, x / 1000];
        globalThis.RoadSegmentation = segmentation;
        globalThis.getBboxFromBounds = () => '0,0,1000,1000';
        globalThis.getBackendBase = () => '';
        globalThis.parcelLayer = { eachLayer() { } };
        globalThis.fetch = async () => ({ ok: true, json: async () => ({ features: [] }) });

        delete require.cache[require.resolve('../../frontend/js/osm-lane-paint.js')];
        require('../../frontend/js/osm-lane-paint.js');
    });

    afterEach(() => {
        ['document', 'map', 'L', 'wgs84ToHTRS96', 'htrs96ToWGS84', 'RoadSegmentation',
            'getBboxFromBounds', 'getBackendBase', 'parcelLayer', 'fetch', 'toggleOsmLanePaint',
            'refreshOsmLanePaint', 'refreshOsmLanePaintForProposals', 'OsmLanePaint']
            .forEach(key => { delete globalThis[key]; });
    });

    it('says to zoom in rather than doing nothing visible', async () => {
        globalThis.toggleOsmLanePaint();
        await settle();
        expect(readouts.length, 'no readout was put on the page at all').toBe(1);
        expect(readouts[0].hidden).toBe(false);
        expect(readouts[0].textContent.toLowerCase()).toContain('zoom in');
    });

    it('takes the message down once it can draw', async () => {
        globalThis.toggleOsmLanePaint();
        await settle();
        expect(readouts[0].hidden).toBe(false);

        globalThis.map.zoom = 18;
        globalThis.map.fire('zoomend');
        await new Promise(resolve => setTimeout(resolve, 520));
        await settle();

        expect(readouts[0].hidden, 'the hint outlived the zoom that caused it').toBe(true);
    });

    it('goes away with the layer', async () => {
        globalThis.toggleOsmLanePaint();
        await settle();
        globalThis.toggleOsmLanePaint();
        expect(readouts[0].removed).toBe(true);
    });
});

// An ordinary click on the map is how a parcel is selected. A layer that logs a paragraph every time
// somebody does that makes the console useless for everything else, so the dump is behind SHIFT.
//
// Driven against a really painted street, so "nothing was logged" means the gate held rather than
// that there was nothing to log — which is what the same test over an empty map would have proved.
describe('the console dump is behind a modifier', () => {
    let log;
    let clickHandler;
    let fetched;

    // A 200 m residential street with a 16 m road parcel around it: enough for one painted segment.
    const WAY = [[0, 0], [0, 200]];
    const toLngLat = ([x, y]) => [x / 1000, y / 1000];
    const parcelRing = [[-8, -20], [8, -20], [8, 220], [-8, 220], [-8, -20]].map(toLngLat);

    const settle = async (rounds = 12) => {
        for (let i = 0; i < rounds; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
    };

    beforeEach(async () => {
        fetched = [];
        log = vi.spyOn(console, 'log').mockImplementation(() => { });
        globalThis.wgs84ToHTRS96 = (lat, lng) => [lng * 1000, lat * 1000];
        globalThis.htrs96ToWGS84 = (x, y) => [y / 1000, x / 1000];
        globalThis.RoadSegmentation = segmentation;
        globalThis.OsmProfile = translator;
        globalThis.corridorProfileFromOsmTags = profiles.corridorProfileFromOsmTags;
        globalThis.corridorStripRingPlanar = profiles.corridorStripRingPlanar;
        globalThis.buildCorridorStrips = profiles.buildCorridorStrips;
        globalThis.corridorStripSurface = profiles.corridorStripSurface;

        const group = () => {
            const members = new Set();
            return {
                addLayer(l) { members.add(l); return this; },
                removeLayer(l) { members.delete(l); return this; },
                hasLayer(l) { return members.has(l); },
                clearLayers() { members.clear(); return this; },
                addTo(t) { t.addLayer(this); return this; }
            };
        };
        globalThis.L = {
            layerGroup: group,
            polygon: (...args) => ({ args, addTo(g) { g.addLayer(this); return this; } }),
            polyline: (...args) => ({ args, addTo(g) { g.addLayer(this); return this; } })
        };
        globalThis.map = {
            getZoom: () => 18,
            getBounds: () => ({ intersects: () => true }),
            getPane: () => ({ style: {} }),
            createPane: () => ({ style: {} }),
            hasLayer: () => true,
            addLayer() { return this; },
            removeLayer() { return this; },
            on(events, fn) { if (String(events).includes('click')) clickHandler = fn; return this; },
            off() { return this; }
        };
        globalThis.getBboxFromBounds = () => '-100,-100,1100,1100';
        globalThis.getBackendBase = () => '';
        globalThis.parcelLayer = {
            eachLayer(fn) {
                fn({
                    feature: {
                        properties: { parcelId: 'road-1', isRoad: true },
                        geometry: { type: 'Polygon', coordinates: [parcelRing] }
                    },
                    getBounds: () => ({})
                });
            }
        };
        globalThis.fetch = async (url) => {
            fetched.push(String(url));
            return {
                ok: true,
                json: async () => ({
                    features: [{
                        properties: {
                            osm_id: '1', highway_type: 'residential', name: 'Testna ulica',
                            tags: { highway: 'residential', lanes: '2' }
                        },
                        geometry: { type: 'LineString', coordinates: WAY.map(toLngLat) }
                    }]
                })
            };
        };

        delete require.cache[require.resolve('../../frontend/js/osm-lane-paint.js')];
        require('../../frontend/js/osm-lane-paint.js');
        globalThis.toggleOsmLanePaint();
        await settle();
    });

    afterEach(() => {
        log.mockRestore();
        ['wgs84ToHTRS96', 'htrs96ToWGS84', 'RoadSegmentation', 'OsmProfile', 'corridorProfileFromOsmTags',
            'corridorStripRingPlanar', 'buildCorridorStrips', 'corridorStripSurface', 'L', 'map',
            'getBboxFromBounds', 'getBackendBase', 'parcelLayer', 'fetch', 'toggleOsmLanePaint',
            'refreshOsmLanePaint', 'refreshOsmLanePaintForProposals', 'OsmLanePaint']
            .forEach(key => { delete globalThis[key]; });
    });

    // If this is empty the two tests below prove nothing, so it is asserted first.
    it('has actually looked at the street', () => {
        expect(globalThis.OsmLanePaint.segments().length).toBeGreaterThan(0);
        expect(typeof clickHandler).toBe('function');
    });

    it('says nothing on a plain click over a street it knows all about', () => {
        clickHandler({ latlng: { lat: 0.1, lng: 0 }, originalEvent: { shiftKey: false } });
        expect(log).not.toHaveBeenCalled();
    });

    it('dumps the record on a shift-click', () => {
        clickHandler({ latlng: { lat: 0.1, lng: 0 }, originalEvent: { shiftKey: true } });
        expect(log).toHaveBeenCalled();
        expect(String(log.mock.calls[0][0])).toContain('[osmLanePaint]');
    });

    // The tramways carry no highway class, so they come only when they are asked for by name.
    it('asks the endpoint for the tramways too', () => {
        expect(fetched.length).toBeGreaterThan(0);
        expect(fetched.every(url => url.includes('rail=1'))).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Telling one band from the next
//
// Two lane types are only ever confused with the band beside them. A parking lane is the same asphalt
// as the carriageway; a tram track used to be the same light grey as the pavement. In both cases what
// resolves it is drawn ON the band — yellow bays, steel rails — so what matters is not that those
// renderers exist but that the street layer actually reaches them, and at the zoom the street is drawn
// at rather than one closer. Both were broken: the rails were never called at all, and the bays were
// held back to z18 while the layer starts painting at z17.
// ---------------------------------------------------------------------------
describe('a parking lane and a tram track are marked out, not just coloured in', () => {
    // corridor-render.js is a classic script with no CommonJS tail, so its free variables come in as
    // parameters and the two renderers under test are handed back explicitly.
    const renderSource = readFileSync(path.join(here, '../../frontend/js/corridor-render.js'), 'utf8');
    const loadRenderers = (L) => new Function(
        'L', 'corridorStripSpans', 'corridorRailGauge', 'wgs84ToHTRS96', 'htrs96ToWGS84',
        `${renderSource}\n; return { renderCorridorParkingBays, renderCorridorRails };`
    )(L, profiles.corridorStripSpans, profiles.corridorRailGauge, project, unproject);

    // Enough Leaflet to record what was drawn and where it landed. `canvases` matters as much as the
    // paths: a path given a renderer ignores its own pane, so the renderer's pane is the real answer
    // to "where did this end up".
    const drawingLeaflet = () => ({
        canvases: [],
        canvas(opts) { const c = { kind: 'canvas', opts }; this.canvases.push(c); return c; },
        latLng: (lat, lng) => ({ lat, lng }),
        layerGroup: () => ({ drawn: [], addLayer(layer) { this.drawn.push(layer); return this; } }),
        polyline: (lines, opts) => ({ kind: 'polyline', lines, opts, addTo(g) { g.addLayer(this); return this; } }),
        polygon: (ring, opts) => ({ kind: 'polygon', ring, opts, addTo(g) { g.addLayer(this); return this; } })
    });

    const classNames = group => group.drawn.map(layer => layer.opts?.className || '');
    const straight = (metres, step = 10) => Array.from({ length: Math.round(metres / step) + 1 },
        (_, i) => ({ lat: (i * step) / 1000, lng: 0 }));

    // The geometry builders read the projection off the globals, so every test here needs at least
    // those two; the wiring test needs the renderers there as well.
    let restore = null;
    function install(extra = {}) {
        const previous = {};
        Object.entries({ wgs84ToHTRS96: project, htrs96ToWGS84: unproject, ...extra })
            .forEach(([key, value]) => { previous[key] = globalThis[key]; globalThis[key] = value; });
        restore = () => Object.entries(previous).forEach(([key, value]) => {
            if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
        });
    }
    afterEach(() => { if (restore) restore(); restore = null; });

    it('draws a street\'s bay markings as two paths, not one per bay', () => {
        install();
        const L = drawingLeaflet();
        const { renderCorridorParkingBays } = loadRenderers(L);
        const profile = { strips: [{ type: 'parking', width: 2.5 }, { type: 'driving', width: 3.2 }] };

        const bays = profiles.buildCorridorParkingBays([straight(220)], profile);
        expect(bays.length, 'the street really does have many bays').toBeGreaterThan(20);

        const group = L.layerGroup();
        renderCorridorParkingBays(bays, group, 'somePane');

        // One path per KIND. Per bay it was 76 Leaflet layers on a 221 m street, which is the whole
        // reason they were once held back to a zoom nobody needed them at.
        expect(group.drawn.length, 'paths drawn').toBe(2);
        const kinds = new Set(bays.map(bay => bay.kind));
        expect(new Set(classNames(group).map(n => n.split('--')[1]))).toEqual(kinds);
        // ...and no bay was dropped on the way into the batch.
        expect(group.drawn.reduce((total, layer) => total + layer.lines.length, 0)).toBe(bays.length);
    });

    // The bug that made every fix above invisible: one shared paneless canvas, so bays and rails were
    // drawn into overlayPane (z-index 400) while the lanes they mark sit at 610. They were rendered
    // and then buried. Leaflet gives a path's own `pane` option no say once a `renderer` is passed
    // (Map.getRenderer), so the ONLY thing that can be asserted here is the canvas's own pane.
    it('draws its marks into the pane the lanes are in, not the default one underneath', () => {
        install();
        const L = drawingLeaflet();
        const { renderCorridorParkingBays, renderCorridorRails } = loadRenderers(L);
        const profile = { strips: [{ type: 'parking', width: 2.5 }, { type: 'rail', width: 2.75, gauge: 1000 }] };
        const centerline = straight(100);

        const group = L.layerGroup();
        renderCorridorParkingBays(profiles.buildCorridorParkingBays([centerline], profile), group, 'lanePane');
        renderCorridorRails([centerline], profile, group, { pane: 'lanePane' });

        expect(group.drawn.length).toBeGreaterThan(0);
        group.drawn.forEach(layer => {
            expect(layer.opts.renderer, `${layer.opts.className} has a renderer`).toBeTruthy();
            expect(layer.opts.renderer.opts?.pane, `${layer.opts.className} lands in the lane pane`).toBe('lanePane');
        });

        // And a second pane gets its own canvas rather than everything sharing the first one's.
        renderCorridorRails([centerline], profile, L.layerGroup(), { pane: 'otherPane' });
        expect(new Set(L.canvases.map(c => c.opts?.pane))).toEqual(new Set(['lanePane', 'otherPane']));
    });

    it('lays the rails apart from their sleepers when asked to', () => {
        install();
        const L = drawingLeaflet();
        const { renderCorridorRails } = loadRenderers(L);
        const profile = { strips: [{ type: 'rail', width: 2.75, gauge: 1000 }] };

        const rails = L.layerGroup();
        const sleepers = L.layerGroup();
        renderCorridorRails([straight(100)], profile, rails, { sleeperGroup: sleepers });

        expect(classNames(rails), 'two rails, no sleepers').toEqual(['corridor-rail', 'corridor-rail']);
        expect(classNames(sleepers)).toEqual(['corridor-sleepers']);

        // Given one group it still draws the whole track into it, which is what every other caller does.
        const together = L.layerGroup();
        renderCorridorRails([straight(100)], profile, together);
        expect(classNames(together)).toEqual(['corridor-rail', 'corridor-rail', 'corridor-sleepers']);
    });

    it('puts the bays and rails with the lanes, and only the repeated symbols behind the closer zoom', () => {
        const L = drawingLeaflet();
        const renderers = loadRenderers(L);
        install({
            L,
            corridorStripSpans: profiles.corridorStripSpans,
            corridorRailGauge: profiles.corridorRailGauge,
            buildCorridorParkingBays: profiles.buildCorridorParkingBays,
            buildCorridorLaneMarkings: profiles.buildCorridorLaneMarkings,
            buildCorridorDirectionArrows: profiles.buildCorridorDirectionArrows,
            renderCorridorParkingBays: renderers.renderCorridorParkingBays,
            renderCorridorRails: renderers.renderCorridorRails,
            renderCorridorLaneMarkings: () => {},
            renderCorridorDirectionArrows: (arrows, group) => arrows
                .forEach(ring => L.polygon(ring, { className: 'corridor-direction-arrow' }).addTo(group))
        });

        // A boulevard: traffic, kerbside parking and a tram track down the middle.
        const profile = {
            strips: [
                { type: 'sidewalk', width: 3 }, { type: 'parking', width: 2.5 },
                { type: 'driving', width: 3.2, direction: 'forward' },
                { type: 'rail', width: 2.75, gauge: 1000 },
                { type: 'driving', width: 3.2, direction: 'backward' },
                { type: 'parking', width: 2.5 }, { type: 'sidewalk', width: 3 }
            ]
        };
        const groups = paint.buildSegmentGroups({
            lanes: [{ polygon: [[0, 0], [0.1, 0], [0.1, 0.001]], type: 'driving', surface: '#2b2b2b' }],
            markings: { centerline: straight(220), profile },
            box: null, name: 'Boulevard', width: 20.15, length: 220
        });

        const withLanes = classNames(groups.base);
        const closerIn = classNames(groups.detail);

        // The two marks that say what a band IS are drawn with the lanes.
        expect(withLanes.filter(n => n.includes('corridor-parking-marking')).length).toBeGreaterThan(0);
        expect(withLanes.filter(n => n === 'corridor-rail').length).toBe(2);
        // The repeated symbols are not.
        expect(withLanes.some(n => n === 'corridor-sleepers')).toBe(false);
        expect(withLanes.some(n => n === 'corridor-direction-arrow')).toBe(false);
        expect(closerIn).toContain('corridor-sleepers');
        expect(closerIn.filter(n => n === 'corridor-direction-arrow').length).toBeGreaterThan(0);
    });
});
