// Unit tests for the 3D-life graph (frontend/js/life/life-graph.js): lane offsets, OSM drive-lane tags,
// splitting at shared vertices, corridor lanes and loose-end joins, plaza/park areas and track sampling.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    createGraphBuilder, offsetPolyline, nodeKey, sampleTrack, junctionCurve, curveHeading, pointInArea, parseOneway, LANE_WIDTH_M, KERB_M, DRIVE_CLASSES, ZCODE
} = require('../../frontend/js/life/life-graph.js');

// Test coordinates are already local metres, so the projection is the identity.
const project = (lng, lat) => [lng, lat];

function road(tags, coordinates, properties = {}) {
    const type = Array.isArray(coordinates[0][0]) ? 'MultiLineString' : 'LineString';
    return { type: 'Feature', properties: { highway_type: tags.highway, tags, ...properties }, geometry: { type, coordinates } };
}

function osmGraph(features, options) {
    const builder = createGraphBuilder(options);
    builder.addOsmRoads(features, project);
    return builder.build();
}

function polygon(rings, decorations) {
    return { type: 'Feature', properties: { decorations }, geometry: { type: 'Polygon', coordinates: rings } };
}

const SQUARE_40 = [[0, 0], [40, 0], [40, 40], [0, 40], [0, 0]];
const driveTracks = graph => graph.tracks.filter(track => track.kind === 'drive');
const first = track => track.pts[0];
const last = track => track.pts[track.pts.length - 1];
const byNumber = (a, b) => a - b;

function expectPoint(actual, expected) {
    expected.forEach((value, i) => expect(actual[i]).toBeCloseTo(value, 9));
}

describe('offsetPolyline', () => {
    it('offsets an eastward line north for a positive (left) offset and south for a negative one', () => {
        const north = offsetPolyline([[0, 0], [10, 0]], 2);
        expectPoint(north[0], [0, 2, 0]);
        expectPoint(north[1], [10, 2, 0]);
        const south = offsetPolyline([[0, 0], [10, 0]], -2);
        expectPoint(south[0], [0, -2, 0]);
        expectPoint(south[1], [10, -2, 0]);
    });

    it('mitres a 90° bend onto the true parallel corner', () => {
        const out = offsetPolyline([[0, 0], [10, 0], [10, 10]], 2);
        out.flat().forEach(value => expect(Number.isFinite(value)).toBe(true));
        expectPoint(out[0], [0, 2, 0]);
        expectPoint(out[1], [8, 2, 0]); // 2 m from both legs
        expectPoint(out[2], [8, 10, 0]);
    });

    it('keeps the mitre of a hairpin finite and capped, and bevels an exact reversal', () => {
        const hairpin = offsetPolyline([[0, 0], [10, 0], [0, 1]], 1);
        expect(Number.isFinite(hairpin[1][0]) && Number.isFinite(hairpin[1][1])).toBe(true);
        // MITRE_LIMIT is 4: the corner never moves more than 4 × |offset| from its vertex.
        expect(Math.hypot(hairpin[1][0] - 10, hairpin[1][1])).toBeLessThanOrEqual(4 + 1e-9);
        const reversal = offsetPolyline([[0, 0], [10, 0], [0, 0]], 1);
        expectPoint(reversal[1], [10, 1, 0]);
    });

    it('returns an independent copy for a zero offset and null for a single point', () => {
        const input = [[1, 2, 3], [4, 5, 6]];
        const out = offsetPolyline(input, 0);
        expect(out).toEqual(input);
        out[0][0] = 99;
        expect(input[0][0]).toBe(1);
        expect(offsetPolyline([[0, 0]], 2)).toBeNull();
    });
});

describe('nodeKey', () => {
    it('snaps to a 0.5 m grid: points 0.2 m apart in one cell share a key, points 1 m apart do not', () => {
        expect(nodeKey(10.2, 20)).toBe(nodeKey(10, 20));
        expect(nodeKey(10, 20.2)).toBe(nodeKey(10, 20));
        expect(nodeKey(10.1, 19.9)).toBe(nodeKey(10, 20));
        expect(nodeKey(11, 20)).not.toBe(nodeKey(10, 20));
        expect(nodeKey(10, 21)).not.toBe(nodeKey(10, 20));
    });
});

describe('addOsmRoads: drive lanes', () => {
    it('projects every coordinate with project(lng, lat)', () => {
        const calls = [];
        const builder = createGraphBuilder();
        builder.addOsmRoads([road({ highway: 'residential', oneway: 'yes' }, [[1, 2], [51, 2]])], (lng, lat) => {
            calls.push([lng, lat]);
            return [lng * 2, lat * 3];
        });
        const [lane] = driveTracks(builder.build());
        expect(calls).toEqual([[1, 2], [51, 2]]);
        expectPoint(first(lane), [2, 6, -KERB_M]); // lanes drive on the sunk asphalt
        expect(lane.len).toBeCloseTo(100, 9);
    });

    it('gives a two-way residential street one lane each way, driving on the right', () => {
        const graph = osmGraph([road({ highway: 'residential', lanes: '2' }, [[0, 0], [100, 0]])]);
        const lanes = driveTracks(graph);
        expect(lanes).toHaveLength(2);
        const start = nodeKey(0, 0), end = nodeKey(100, 0);
        const forward = lanes.find(track => track.from === start);
        const backward = lanes.find(track => track.from === end);
        expect(forward.to).toBe(end);
        expect(backward.to).toBe(start);
        // Drawn eastwards: the forward lane is south (right of travel), the backward lane north.
        forward.pts.forEach(p => expect(p[1]).toBeCloseTo(-LANE_WIDTH_M / 2, 9));
        backward.pts.forEach(p => expect(p[1]).toBeCloseTo(LANE_WIDTH_M / 2, 9));
        expect(first(forward)[0]).toBe(0);
        expect(last(forward)[0]).toBe(100);
        expect(first(backward)[0]).toBe(100); // the backward lane runs westwards
        expect(last(backward)[0]).toBe(0);
        expect(forward.speed).toBe(DRIVE_CLASSES.residential);
        expect(forward.len).toBeCloseTo(100, 9);
        expect(graph.nodes.get(start).out).toEqual([forward.id]);
        expect(graph.nodes.get(end).out).toEqual([backward.id]);
    });

    it('sinks an OSM carriageway a kerb below the pavement and drives its lanes down there', () => {
        const graph = osmGraph([road({ highway: 'residential', lanes: '2' }, [[0, 0], [100, 0]])]);
        expect(KERB_M).toBe(0.15);
        expect(graph.surface.carriageways).toEqual([{
            pts: [[0, 0, 0], [100, 0, 0]], halfWidth: LANE_WIDTH_M, drop: KERB_M, zcode: ZCODE.ROAD,
            lanes: [{ offset: -LANE_WIDTH_M / 2, dir: 1 }, { offset: LANE_WIDTH_M / 2, dir: -1 }]
        }]);
        driveTracks(graph).forEach(track => track.pts.forEach(p => expect(p[2]).toBeCloseTo(-KERB_M, 9)));
    });

    it('reads oneway the way OSM writes it', () => {
        ['yes', '1', 'true', 'YES'].forEach(value => expect(parseOneway({ oneway: value })).toBe(1));
        ['-1', 'reverse'].forEach(value => expect(parseOneway({ oneway: value })).toBe(-1));
        expect(parseOneway({ junction: 'roundabout' })).toBe(1);
        expect(parseOneway({ oneway: 'no' })).toBe(0);
        expect(parseOneway({})).toBe(0);
    });

    it('keeps every lane of a oneway=yes street in the drawing direction', () => {
        const graph = osmGraph([road({ highway: 'residential', oneway: 'yes', lanes: '2' }, [[0, 0], [100, 0]])]);
        const lanes = driveTracks(graph);
        expect(lanes).toHaveLength(2);
        lanes.forEach(track => {
            expect(track.from).toBe(nodeKey(0, 0));
            expect(track.to).toBe(nodeKey(100, 0));
            expect(last(track)[0]).toBeGreaterThan(first(track)[0]);
        });
        expect(lanes.map(track => first(track)[1]).sort(byNumber)).toEqual([-1.75, 1.75]);
    });

    it('reverses every lane of a oneway=-1 street', () => {
        const graph = osmGraph([road({ highway: 'residential', oneway: '-1' }, [[0, 0], [100, 0]])]);
        const lanes = driveTracks(graph);
        expect(lanes).toHaveLength(1);
        expect(lanes[0].from).toBe(nodeKey(100, 0));
        expect(lanes[0].to).toBe(nodeKey(0, 0));
        expect(first(lanes[0])[0]).toBe(100);
        expect(last(lanes[0])[0]).toBe(0);
    });

    it('keeps traffic on the left where the city drives on the left (a UK street)', () => {
        const lanesOf = (tags, drivingSide) => {
            const graph = osmGraph([road({ highway: 'residential', ...tags }, [[0, 0], [100, 0]])], { drivingSide });
            const offsets = x => driveTracks(graph).filter(track => track.from === nodeKey(x, 0)).map(track => first(track)[1]).sort(byNumber);
            return { forward: offsets(0), backward: offsets(100) };
        };
        // Drawn eastwards: the forward (eastbound) lane is north of the centre line, left of travel.
        expect(lanesOf({ lanes: '2' }, 'left')).toEqual({ forward: [1.75], backward: [-1.75] });
        expect(lanesOf({ lanes: '3', 'lanes:forward': '2', 'lanes:backward': '1' }, 'left')).toEqual({ forward: [1.75, 5.25], backward: [-1.75] });
        expect(lanesOf({ lanes: '2' }, 'right')).toEqual({ forward: [-1.75], backward: [1.75] });
        // A one-way street fills its carriageway either way.
        expect(lanesOf({ lanes: '2', oneway: 'yes' }, 'left')).toEqual(lanesOf({ lanes: '2', oneway: 'yes' }, 'right'));
        expect(() => createGraphBuilder({ drivingSide: 'middle' })).toThrow(/unknown driving side/);
    });

    it('takes the lanes of each direction from lanes:forward / lanes:backward', () => {
        const lanesOf = tags => {
            const graph = osmGraph([road({ highway: 'residential', ...tags }, [[0, 0], [100, 0]])]);
            const offsets = x => driveTracks(graph).filter(track => track.from === nodeKey(x, 0)).map(track => first(track)[1]).sort(byNumber);
            return { forward: offsets(0), backward: offsets(100) };
        };
        expect(lanesOf({ lanes: '3', 'lanes:forward': '2', 'lanes:backward': '1' })).toEqual({ forward: [-5.25, -1.75], backward: [1.75] });
        expect(lanesOf({ lanes: '3', 'lanes:forward': '1', 'lanes:backward': '2' })).toEqual({ forward: [-1.75], backward: [1.75, 5.25] });
        // A centre turn lane (lanes:both_ways=1) leaves 2 + 1 through lanes on a 4-lane street.
        expect(lanesOf({ lanes: '4', 'lanes:forward': '2', 'lanes:backward': '1' })).toEqual({ forward: [-5.25, -1.75], backward: [1.75] });
    });

    it('narrows lanes to width_meters / lanes when the street is narrower than 3.5 m lanes', () => {
        const graph = osmGraph([road({ highway: 'residential', lanes: '2' }, [[0, 0], [100, 0]], { width_meters: 6 })]);
        expect(driveTracks(graph).map(track => first(track)[1]).sort(byNumber)).toEqual([-1.5, 1.5]);
    });

    it('drives motorways but not service roads or footways', () => {
        const motorway = driveTracks(osmGraph([road({ highway: 'motorway', oneway: 'yes' }, [[0, 0], [100, 0]])]));
        expect(motorway).toHaveLength(2);
        motorway.forEach(track => expect(track.speed).toBe(DRIVE_CLASSES.motorway));
        expect(driveTracks(osmGraph([road({ highway: 'service' }, [[0, 0], [100, 0]])]))).toHaveLength(0);
        expect(driveTracks(osmGraph([road({ highway: 'footway' }, [[0, 0], [100, 0]])]))).toHaveLength(0);
    });

    it('emits lanes for every part of a MultiLineString', () => {
        const graph = osmGraph([road({ highway: 'residential' }, [[[0, 0], [100, 0]], [[0, 50], [100, 50]]])]);
        const lanes = driveTracks(graph);
        expect(lanes).toHaveLength(4);
        expect(lanes.filter(track => Math.abs(first(track)[1]) < 5)).toHaveLength(2);
        expect(lanes.filter(track => Math.abs(first(track)[1] - 50) < 5)).toHaveLength(2);
        expect(graph.nodes.size).toBe(4);
    });
});

describe('build: splitting at shared vertices', () => {
    it('splits two ways crossing at a shared vertex into four edges per lane direction', () => {
        const graph = osmGraph([
            road({ highway: 'residential' }, [[-50, 0], [0, 0], [50, 0]], { osm_id: 1 }),
            road({ highway: 'residential' }, [[0, -50], [0, 0], [0, 50]], { osm_id: 2 })
        ]);
        const lanes = driveTracks(graph);
        expect(lanes).toHaveLength(8);
        // Along the drawing direction: east for way 1, north for way 2.
        const along = track => (track.wayId === 'osm:1' ? last(track)[0] - first(track)[0] : last(track)[1] - first(track)[1]);
        expect(lanes.filter(track => along(track) > 0)).toHaveLength(4);
        expect(lanes.filter(track => along(track) < 0)).toHaveLength(4);
        lanes.forEach(track => expect(track.len).toBeCloseTo(50, 9));
        expect(graph.nodes.size).toBe(5);
        const centre = graph.nodes.get(nodeKey(0, 0));
        expect(centre.out).toHaveLength(4);
        expect(centre.out.slice().sort(byNumber))
            .toEqual(lanes.filter(track => track.from === centre.id).map(track => track.id).sort(byNumber));
        for (const [x, y] of [[-50, 0], [50, 0], [0, -50], [0, 50]]) {
            const end = graph.nodes.get(nodeKey(x, y));
            expect(end.out).toHaveLength(1);
            expect(graph.tracks[end.out[0]].to).toBe(centre.id);
        }
    });

    it('does not split a way at a vertex that merely lies on another way', () => {
        const graph = osmGraph([
            road({ highway: 'residential' }, [[-50, 0], [50, 0]]),
            road({ highway: 'residential' }, [[0, -50], [0, 0], [0, 50]])
        ]);
        expect(driveTracks(graph)).toHaveLength(4);
        expect(graph.nodes.size).toBe(4);
        expect(graph.nodes.has(nodeKey(0, 0))).toBe(false);
        driveTracks(graph).forEach(track => expect(track.len).toBeCloseTo(100, 9));
    });

    it('splits a way where another way ends on its interior vertex (T junction)', () => {
        const graph = osmGraph([
            road({ highway: 'residential' }, [[-50, 0], [0, 0], [50, 0]]),
            road({ highway: 'residential' }, [[0, 0], [0, 50]])
        ]);
        expect(driveTracks(graph)).toHaveLength(6);
        expect(graph.nodes.size).toBe(4);
        expect(graph.nodes.get(nodeKey(0, 0)).out).toHaveLength(3);
    });

    it('does not split a street where only a footway shares its vertex', () => {
        const graph = osmGraph([
            road({ highway: 'residential' }, [[-50, 0], [0, 0], [50, 0]]),
            road({ highway: 'footway' }, [[0, -50], [0, 0], [0, 50]])
        ]);
        expect(driveTracks(graph)).toHaveLength(2);
        driveTracks(graph).forEach(track => expect(track.len).toBeCloseTo(100, 9));
        expect(graph.nodes.size).toBe(2);
    });
});

// A corridor's lane spans as corridorStripSpans reports them: signed offsets, positive left of the
// drawing direction, forward traffic on the right.
const SPANS = [
    { type: 'sidewalk', width: 2, left: 5, right: 3 },
    { type: 'driving', width: 3, direction: 'backward', left: 3, right: 0 },
    { type: 'driving', width: 3, direction: 'forward', left: 0, right: -3 },
    { type: 'sidewalk', width: 2, left: -3, right: -5 }
];

describe('addCorridor: drive lanes', () => {
    it('turns driving spans into directed lanes at their centres, lifted by zLift over zAt', () => {
        const calls = [];
        const builder = createGraphBuilder();
        builder.addCorridor({
            id: 'c1', zLift: 0.05,
            zAt: (x, y) => { calls.push([x, y]); return 0.01 * x; },
            segments: [{ id: 's0', points: [[0, 0], [100, 0]], spans: SPANS }]
        });
        const lanes = driveTracks(builder.build());
        expect(lanes).toHaveLength(2);
        const forward = lanes.find(track => track.from === nodeKey(0, 0));
        const backward = lanes.find(track => track.from === nodeKey(100, 0));
        expectPoint(first(forward), [0, -1.5, 0.05]);
        expectPoint(last(forward), [100, -1.5, 1.05]);
        expectPoint(first(backward), [100, 1.5, 1.05]); // runs westwards
        expectPoint(last(backward), [0, 1.5, 0.05]);
        expect(calls).toEqual([[0, 0], [100, 0]]); // heights come from the centreline
        expect(forward).toMatchObject({ laneKind: 'driving', speed: 11, source: 'corridor', wayId: 'c1:s0' });
    });

    it('lays a flat corridor at zLift and drives bus lanes slower', () => {
        const builder = createGraphBuilder();
        builder.addCorridor({
            id: 'c2', zLift: 0.05,
            segments: [{ points: [[0, 0], [100, 0]], spans: [{ type: 'bus', direction: 'forward', left: 0, right: -3 }] }]
        });
        const [lane] = driveTracks(builder.build());
        lane.pts.forEach(p => expect(p[2]).toBeCloseTo(0.05, 9));
        expect(lane).toMatchObject({ laneKind: 'bus', speed: 10, wayId: 'c2:0' });
    });
});

describe('connectLooseEnds', () => {
    // An OSM street ending at (0, 0) and a corridor from `corridorStart` eastwards.
    function corridorMeetingOsm(corridorStart, extraSegments = []) {
        const builder = createGraphBuilder();
        builder.addOsmRoads([road({ highway: 'residential' }, [[-100, 0], [0, 0]])], project);
        builder.addCorridor({ id: 'c1', segments: [{ id: 's0', points: [corridorStart, [100, 0]], spans: SPANS }, ...extraSegments] });
        return builder.build();
    }
    const corridorLanes = graph => driveTracks(graph).filter(track => track.source === 'corridor' && track.wayId === 'c1:s0');

    it('re-points a corridor end 3 m from an OSM node onto that node', () => {
        const graph = corridorMeetingOsm([3, 0]);
        const osmEnd = graph.nodes.get(nodeKey(0, 0));
        const leaving = corridorLanes(graph).find(track => last(track)[0] > first(track)[0]);
        const arriving = corridorLanes(graph).find(track => last(track)[0] < first(track)[0]);
        expect(leaving.from).toBe(osmEnd.id);
        expect(arriving.to).toBe(osmEnd.id);
        // Traffic arriving on the OSM street can now continue onto the corridor.
        expect(osmEnd.out).toContain(leaving.id);
        expect(osmEnd.out).toHaveLength(2);
        const loose = graph.nodes.get(nodeKey(3, 0));
        expect(loose.mergedInto).toBe(osmEnd.id);
        expect(loose.out).toEqual([]);
        expect(leaving.to).toBe(nodeKey(100, 0)); // the far end has no OSM node within reach
    });

    it('leaves a corridor end 20 m from any OSM node unconnected', () => {
        const graph = corridorMeetingOsm([20, 0]);
        const osmEnd = graph.nodes.get(nodeKey(0, 0));
        const leaving = corridorLanes(graph).find(track => last(track)[0] > first(track)[0]);
        expect(leaving.from).toBe(nodeKey(20, 0));
        expect(graph.nodes.get(nodeKey(20, 0)).mergedInto).toBeUndefined();
        expect(osmEnd.out.every(id => graph.tracks[id].source === 'osm')).toBe(true);
    });

    it('never merges a corridor junction shared by two corridor ways', () => {
        const graph = corridorMeetingOsm([3, 0], [{ id: 's1', points: [[3, 0], [3, 100]], spans: SPANS }]);
        const junction = graph.nodes.get(nodeKey(3, 0));
        expect(junction.ways.size).toBe(2);
        expect(junction.mergedInto).toBeUndefined();
        const osmEnd = graph.nodes.get(nodeKey(0, 0));
        expect(osmEnd.out.every(id => graph.tracks[id].source === 'osm')).toBe(true);
        driveTracks(graph).filter(track => track.source === 'corridor').forEach(track => {
            expect(track.from).not.toBe(osmEnd.id);
            expect(track.to).not.toBe(osmEnd.id);
        });
    });
});

describe('addSquare / addPark: areas', () => {
    function areasOf(add, feature) {
        const builder = createGraphBuilder();
        builder[add](feature, project);
        return builder.build().areas;
    }

    it('turns a 40 × 40 m square into one area with its outline, size and bbox', () => {
        const [area, ...rest] = areasOf('addSquare', polygon([SQUARE_40]));
        expect(rest).toEqual([]);
        expect(area.kind).toBe('square');
        expect(area.outer).toEqual(SQUARE_40);
        expect(area.area).toBeCloseTo(1600, 9);
        expect(area.bbox).toEqual([0, 0, 40, 40]);
        expect(pointInArea(area, 20, 20)).toBe(true);
        expect(pointInArea(area, 0.5, 39.5)).toBe(true);
        expect(pointInArea(area, 50, 20)).toBe(false);
        expect(pointInArea(area, 20, -1)).toBe(false);
    });

    it('treats a hole as outside the area', () => {
        const hole = [[2, 2], [6, 2], [6, 6], [2, 6], [2, 2]];
        const [area] = areasOf('addSquare', polygon([SQUARE_40, hole]));
        expect(area.holes).toEqual([hole]);
        expect(pointInArea(area, 4, 4)).toBe(false);
        expect(pointInArea(area, 8, 4)).toBe(true);
    });

    it('follows a concave outline rather than its bbox', () => {
        const lShape = [[0, 0], [60, 0], [60, 20], [20, 20], [20, 60], [0, 60], [0, 0]];
        const [area] = areasOf('addSquare', polygon([lShape]));
        expect(area.bbox).toEqual([0, 0, 60, 60]);
        expect(area.area).toBeCloseTo(60 * 20 + 20 * 40, 9);
        expect(pointInArea(area, 10, 50)).toBe(true);
        expect(pointInArea(area, 50, 10)).toBe(true);
        expect(pointInArea(area, 40, 40)).toBe(false); // inside the bbox, outside the L
    });

    it('makes a park lawn an area, one per polygon of a MultiPolygon', () => {
        const park = { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: [[SQUARE_40], [[[100, 0], [110, 0], [110, 10], [100, 10], [100, 0]]]] } };
        const areas = areasOf('addPark', park);
        expect(areas.map(area => area.kind)).toEqual(['park', 'park']);
        expect(areas.map(area => area.bbox)).toEqual([[0, 0, 40, 40], [100, 0, 110, 10]]);
        expect(areas.map(area => area.id)).toEqual(['area:0', 'area:1']);
    });
});

describe('sampleTrack', () => {
    // An L-shaped track: 10 m east on the flat, then 10 m north climbing 2 m.
    function lTrack() {
        const builder = createGraphBuilder();
        builder.addWay({
            points: [[0, 0, 0], [10, 0, 0], [10, 10, 2]], lanes: [{ offset: 0, dir: 1, speed: 5, kind: 'driving' }],
            source: 'test', id: 'test:L'
        });
        return builder.build().tracks[0];
    }
    function expectSample(out, expected) {
        Object.entries(expected).forEach(([key, value]) => expect(out[key]).toBeCloseTo(value, 9));
    }

    it('interpolates position, height and heading, and clamps beyond either end', () => {
        const track = lTrack();
        expect(track.len).toBeCloseTo(20, 9);
        const at = s => sampleTrack(track, s, {}, 0);
        expectSample(at(0), { x: 0, y: 0, z: 0, heading: 0, seg: 0 });
        expectSample(at(5), { x: 5, y: 0, z: 0, heading: 0, seg: 0 });
        expectSample(at(15), { x: 10, y: 5, z: 1, heading: Math.PI / 2, seg: 1 });
        expectSample(at(99), { x: 10, y: 10, z: 2, heading: Math.PI / 2, seg: 1 });
        expectSample(at(-3), { x: 0, y: 0, z: 0, heading: 0, seg: 0 });
    });

    it('walks the seg hint forward and recovers from a stale or out-of-range hint', () => {
        const track = lTrack();
        const out = {};
        sampleTrack(track, 5, out, 0);
        expect(out.seg).toBe(0);
        sampleTrack(track, 12, out, out.seg);
        expect(out.seg).toBe(1);
        expect(out.y).toBeCloseTo(2, 9);
        sampleTrack(track, 5, out, 1); // stale hint ahead of s
        expect(out.seg).toBe(0);
        expect(out.x).toBeCloseTo(5, 9);
        sampleTrack(track, 15, out, 99); // hint past the last segment
        expect(out.seg).toBe(1);
        expect(out.y).toBeCloseTo(5, 9);
    });
});

describe('build: stats', () => {
    it('reports a drive length and counts that match what it returned, with ids indexing tracks', () => {
        const builder = createGraphBuilder();
        builder.addOsmRoads([
            road({ highway: 'residential' }, [[-50, 0], [0, 0], [50, 0]]),
            road({ highway: 'residential' }, [[0, -50], [0, 0], [0, 50]]),
            road({ highway: 'residential', oneway: 'yes' }, [[200, 0], [230, 0]])
        ], project);
        builder.addSquare(polygon([SQUARE_40]), project);
        const graph = builder.build();
        const driveSum = driveTracks(graph).reduce((sum, track) => sum + track.len, 0);
        expect(graph.stats.driveLength).toBeCloseTo(driveSum, 9);
        expect(graph.stats.driveLength).toBeCloseTo(8 * 50 + 30, 9);
        expect(graph.stats.nodes).toBe(graph.nodes.size);
        expect(graph.stats.areas).toBe(1);
        expect(graph.stats.tracks).toBe(graph.tracks.length);
        graph.tracks.forEach((track, index) => {
            expect(track.id).toBe(index); // agents look tracks up by id
            expect(track.cum[track.cum.length - 1]).toBe(track.len);
        });
    });
});

describe('junctionCurve', () => {
    const track = pts => {
        const cum = [0];
        for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
        return { pts, cum, len: cum[cum.length - 1] };
    };
    const headingAt = (curve, i) => Math.atan2(curve.pts[i + 1][1] - curve.pts[i][1], curve.pts[i + 1][0] - curve.pts[i][0]);

    it('joins a right-angle turn tangent to both lanes, trimmed back by the turn radius', () => {
        const a = track([[0, 0, 0], [50, 0, 0]]);
        const b = track([[50, 0, 0], [50, 50, 0]]);
        const curve = junctionCurve(a, b);
        expect(curve.exitS).toBeCloseTo(43, 6); // 7 m × tan 45°
        expect(curve.entryS).toBeCloseTo(7, 6);
        expect(curve.pts[0]).toEqual([43, 0, 0]);
        const end = curve.pts[curve.pts.length - 1];
        expect(end[0]).toBeCloseTo(50, 9);
        expect(end[1]).toBeCloseTo(7, 9);
        // The first and last chords of a 12-sample curve sit within half a sample's turn of the lanes.
        expect(Math.abs(headingAt(curve, 0))).toBeLessThan(0.1);
        expect(Math.abs(headingAt(curve, curve.pts.length - 2) - Math.PI / 2)).toBeLessThan(0.1);
        // Close to the quarter circle it approximates, and no faster than 2.5 m/s² sideways.
        expect(curve.len).toBeGreaterThan(Math.PI / 2 * 7 - 0.2);
        expect(curve.len).toBeLessThan(Math.PI / 2 * 7 + 0.2);
        expect(curve.vmax).toBeCloseTo(Math.sqrt(2.5 * 7), 0);
    });

    it('keeps a straight continuation straight and unlimited in speed', () => {
        const curve = junctionCurve(track([[0, 0, 1], [30, 0, 1]]), track([[30, 0, 1], [60, 0, 3]]));
        curve.pts.forEach(p => expect(p[1]).toBeCloseTo(0, 9));
        expect(curve.vmax).toBe(Infinity);
        expect(curve.pts[curve.pts.length - 1][2]).toBeGreaterThan(1); // follows the climb of the next lane
    });

    it('never trims more than 40 % of a short lane and U-turns at the node itself', () => {
        const short = junctionCurve(track([[0, 0, 0], [10, 0, 0]]), track([[10, 0, 0], [10, 10, 0]]));
        expect(short.exitS).toBeCloseTo(6, 9);
        expect(short.entryS).toBeCloseTo(4, 9);
        const uTurn = junctionCurve(track([[0, 0, 0], [60, 0, 0]]), track([[60, 3.5, 0], [0, 3.5, 0]]));
        expect(uTurn.exitS).toBeCloseTo(58.5, 9);
        expect(uTurn.entryS).toBeCloseTo(1.5, 9);
        expect(Math.max(...uTurn.pts.map(p => p[0]))).toBeGreaterThan(59); // bulges round the end
    });

    it('turns the heading continuously round a U-turn, not in chord-sized steps', () => {
        const uTurn = junctionCurve(track([[0, 0, 0], [60, 0, 0]]), track([[60, 3.5, 0], [0, 3.5, 0]]));
        expect(curveHeading(uTurn, 0)).toBeCloseTo(0, 9);
        expect(Math.abs(curveHeading(uTurn, uTurn.len))).toBeCloseTo(Math.PI, 9);
        let worst = 0, previous = curveHeading(uTurn, 0);
        for (let s = 0.05; s <= uTurn.len; s += 0.05) {
            const h = curveHeading(uTurn, s);
            let d = Math.abs(h - previous); if (d > Math.PI) d = 2 * Math.PI - d;
            worst = Math.max(worst, d);
            previous = h;
        }
        expect(worst).toBeLessThan(0.1); // 12 chords would step π / 12 ≈ 0.26
    });
});
