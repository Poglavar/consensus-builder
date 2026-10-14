// Lane paint should describe the roadway cross-section, not the vehicle route fan.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const Geometry = require('../../frontend/traffic/geometry.js');
const TrafficSurface = require('../../frontend/traffic/surface.js');
const TrafficMarkings = require('../../frontend/traffic/markings.js');
const { offsetPolylinePlanar } = require('../../frontend/js/corridor-profile.js');

const JUNCTION = 'width-change';

function rotate([x, y], angle) {
    return [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)];
}

function makeLane(id, sectionId, fromNode, toNode, ordinal, centerY, x0, x1, angle = 0) {
    return {
        id, sectionId, fromNode, toNode, direction: 'forward', ordinal, stripIndex: ordinal,
        width: 3, points: [[x0, centerY], [x1, centerY]].map(point => rotate(point, angle)),
    };
}

function widthTransition(beforeYs, afterYs, pairs, angle = 0) {
    const sourceLanes = [
        ...beforeYs.map((y, ordinal) => makeLane(`before-${ordinal}`, 'before', 'west', JUNCTION,
            ordinal, y, 0, 100, angle)),
        ...afterYs.map((y, ordinal) => makeLane(`after-${ordinal}`, 'after', JUNCTION, 'east',
            ordinal, y, 100, 200, angle)),
    ];
    const lanes = new Map(sourceLanes.map(lane => [lane.id, {
        ...lane,
        path: Geometry.path(lane.points),
    }]));
    const connections = new Map(pairs.map(([fromOrdinal, toOrdinal], index) => {
        const from = sourceLanes.find(lane => lane.id === `before-${fromOrdinal}`);
        const to = sourceLanes.find(lane => lane.id === `after-${toOrdinal}`);
        const start = from.points.at(-1), end = to.points[0];
        return [`move-${index}`, {
            id: `move-${index}`, nodeId: JUNCTION,
            fromLaneId: from.id, toLaneId: to.id, type: 'continue',
            path: Geometry.path([start, [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2], end]),
        }];
    }));
    const network = {
        lanes,
        connections,
        nodes: new Map([[JUNCTION, { id: JUNCTION, degree: 2 }]]),
        project: point => point,
    };
    Object.assign(network, Geometry.build(network.lanes, network.connections, network.nodes));
    const vehiclePaths = {
        lanes: [...network.lanes.values()].map(lane => [lane.id, lane.path.points.map(point => [...point])]),
        connections: [...network.connections.values()].map(move => [move.id, move.path.points.map(point => [...point])]),
    };
    const surface = TrafficSurface.build(network, sourceLanes);
    return { network, surface, sourceLanes, vehiclePaths,
        markings: TrafficMarkings.build(network, surface, offsetPolylinePlanar), angle };
}

function allMarks(markings) {
    return [...markings.lanes.values()].flat().map(mark => mark.route)
        .concat(markings.connections.map(mark => mark.route));
}

function longitudinal(point, angle) {
    return point[0] * Math.cos(angle) + point[1] * Math.sin(angle);
}

function crossTrack(point, angle) {
    return -point[0] * Math.sin(angle) + point[1] * Math.cos(angle);
}

function lineAt(markings, lateral, angle) {
    return allMarks(markings).filter(route => route.points.length > 1
        && route.points.every(point => Math.abs(crossTrack(point, angle) - lateral) < 0.03));
}

function markExistsAt(markings, along, lateral, angle) {
    const target = [along * Math.cos(angle) - lateral * Math.sin(angle),
        along * Math.sin(angle) + lateral * Math.cos(angle)];
    return allMarks(markings).some(route => Geometry.nearest(route, target).distance < 0.06);
}

function pavedAt(surface, point) {
    const roads = [...surface.lanes, ...surface.connections];
    return roads.some(road => {
        const halfWidth = (road.width || 3) / 2;
        const hit = Geometry.nearest(road.path, point);
        if (hit.distance > halfWidth + 0.06) return false;
        const along = (point[0] - hit.x) * Math.cos(hit.angle) + (point[1] - hit.y) * Math.sin(hit.angle);
        return !(hit.s < 0.01 && along < -0.04 || hit.s > road.path.length - 0.01 && along > 0.04);
    });
}

function expectMarksParallel(markings, angle) {
    for (const route of allMarks(markings)) {
        const positions = route.points.map(point => crossTrack(point, angle));
        expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(0.03);
    }
}

describe('traffic lane markings', () => {
    it.each([0, 0.47])('keeps a 3-to-5 expansion on the straight lane grid at rotation %s', angle => {
        const fixture = widthTransition([3, 0, -3], [6, 3, 0, -3, -6],
            [[0, 1], [1, 2], [2, 3], [0, 0], [2, 4]], angle);
        const { network, surface, markings } = fixture;

        expect([...network.connections.values()].filter(move => move.geometryKind === 'taper')).toHaveLength(5);
        expect(markings.connections).toEqual([]);
        expectMarksParallel(markings, angle);
        for (const lateral of [4.5, -4.5]) {
            expect(lineAt(markings, lateral, angle).length).toBeGreaterThan(0);
            for (const along of [85, 95, 100, 105, 115, 150, 199]) {
                expect(markExistsAt(markings, along, lateral, angle)).toBe(true);
            }
        }

        for (const lateral of [7.5, -7.5]) {
            const outer = lineAt(markings, lateral, angle);
            expect(outer.length).toBeGreaterThan(0);
            const points = outer.flatMap(route => route.points);
            expect(Math.min(...points.map(point => longitudinal(point, angle)))).toBeGreaterThan(100);
            for (const route of outer) {
                for (let index = 0; index < route.points.length; index++) {
                    expect(pavedAt(surface, route.points[index])).toBe(true);
                    if (index + 1 < route.points.length) {
                        const a = route.points[index], b = route.points[index + 1];
                        expect(pavedAt(surface, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])).toBe(true);
                    }
                }
            }
        }
    });

    it('does not draw fanning lane paint through a 5-to-3 merge', () => {
        const fixture = widthTransition([6, 3, 0, -3, -6], [3, 0, -3],
            [[0, 0], [1, 0], [2, 1], [3, 2], [4, 2]]);

        expect([...fixture.network.connections.values()].filter(move => move.geometryKind === 'taper')).toHaveLength(5);
        expect(fixture.markings.connections).toEqual([]);
        expectMarksParallel(fixture.markings, 0);
    });

    it('retains curved markings for a real right-angle junction movement', () => {
        const sourceLanes = [
            makeLane('incoming', 'main', 'west', JUNCTION, 0, 0, -20, -5),
            makeLane('outgoing', 'side', JUNCTION, 'north', 0, -10, 5, 20),
            makeLane('crossing', 'cross', 'south', 'north2', 0, 15, 0, 20),
        ];
        sourceLanes[1].points = [[0, 5], [0, 20]];
        sourceLanes[2].points = [[-20, 0], [20, 0]];
        sourceLanes[2].fromNode = 'south';
        sourceLanes[2].toNode = 'north2';
        const lanes = new Map(sourceLanes.map(lane => [lane.id, { ...lane, path: Geometry.path(lane.points) }]));
        const turnPath = Geometry.path([[-5, 0], [-4, 0], [-2, 1], [-1, 3], [0, 5]]);
        const connections = new Map([['right-turn', {
            id: 'right-turn', nodeId: JUNCTION, fromLaneId: 'incoming', toLaneId: 'outgoing',
            type: 'turn', path: turnPath,
        }]]);
        const network = { lanes, connections, nodes: new Map([[JUNCTION, { id: JUNCTION, degree: 3 }]]), project: point => point };
        Object.assign(network, Geometry.build(network.lanes, network.connections, network.nodes));
        const surface = TrafficSurface.build(network, sourceLanes);
        const markings = TrafficMarkings.build(network, surface, offsetPolylinePlanar);

        expect(markings.connections.length).toBeGreaterThan(0);
        expect(markings.connections.some(mark => {
            const first = Geometry.sample(mark.route, 0), last = Geometry.sample(mark.route, mark.route.length);
            return Math.cos(last.angle - first.angle) < .5;
        })).toBe(true);
    });

    it('does not alter vehicle lane or connection paths while deriving paint', () => {
        const fixture = widthTransition([3, 0, -3], [6, 3, 0, -3, -6],
            [[0, 1], [1, 2], [2, 3], [0, 0], [2, 4]]);
        expect([...fixture.network.lanes.values()].map(lane => [lane.id, lane.path.points]))
            .toEqual(fixture.vehiclePaths.lanes);
        expect([...fixture.network.connections.values()].map(move => [move.id, move.path.points]))
            .toEqual(fixture.vehiclePaths.connections);
    });
});
