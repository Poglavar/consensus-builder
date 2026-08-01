// Turn arrows are the marking that says a lane is straight-only or turn-only. OSM states it in
// turn:lanes; the graph carries it as lane.turn. These lock the two rules that make an arrow mean
// something: it points the way the movement goes, and it only appears where a driver is about to
// need it — approaching a junction.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LaneTurnArrows = require('../../frontend/js/lane-turn-arrows.js');
const LaneTopologyGraph = require('../../frontend/js/lane-topology-graph.js');
const CorridorProfile = require('../../frontend/js/corridor-profile.js');
const OsmProfile = require('../../frontend/js/osm-profile.js');
const View = require('../../frontend/js/lane-topology-view.js');

const { buildTurnArrows, movementsOf } = LaneTurnArrows;

const NODE = [15.96, 45.8];
// ~155 m of approach running west→east into the junction, comfortably over the length floor.
const APPROACH = [[NODE[0] - 0.002, NODE[1]], [NODE[0], NODE[1]]];

function graphWith(turn, overrides = {}) {
    return {
        nodes: [{ id: 'n:junction', degree: 4 }, { id: 'n:back', degree: 1 }],
        lanes: [{
            id: 'l:approach',
            sectionId: 's:west',
            offset: 1.5,
            width: 3,
            turn,
            fromNode: 'n:back',
            toNode: 'n:junction',
            geometry: { type: 'LineString', coordinates: APPROACH }
        }],
        connections: [],
        ...overrides
    };
}

// Every arrow vertex in the lane's own frame: +y along travel (east here), +x to the driver's right
// (south here, because right of an eastbound driver is south).
function localPoints(arrow) {
    return arrow.shapes.flat().map(([lng, lat]) => ({
        along: (lng - NODE[0]) * 111320 * Math.cos(NODE[1] * Math.PI / 180),
        across: -(lat - NODE[1]) * 110540
    }));
}

describe('movementsOf', () => {
    it('splits a lane that permits more than one movement', () => {
        expect(movementsOf('left;through')).toEqual(['left', 'through']);
    });

    it('treats an explicit "none" and a missing value alike', () => {
        expect(movementsOf('none')).toEqual([]);
        expect(movementsOf(null)).toEqual([]);
        expect(movementsOf(undefined)).toEqual([]);
        expect(movementsOf('')).toEqual([]);
    });
});

describe('buildTurnArrows', () => {
    it('draws one arrow per permitted movement on a shared lane', () => {
        const arrows = buildTurnArrows(graphWith('left;through'));
        expect(arrows.map(arrow => arrow.movement).sort()).toEqual(['left', 'through']);
        expect(arrows.every(arrow => arrow.laneId === 'l:approach')).toBe(true);
        expect(arrows.every(arrow => arrow.turn === 'left;through')).toBe(true);
    });

    it('points a left arrow to the driver\'s left and a right arrow to their right', () => {
        const [left] = buildTurnArrows(graphWith('left'));
        const [right] = buildTurnArrows(graphWith('right'));

        // +across is the driver's right, so a left turn must reach negative and a right positive.
        expect(Math.min(...localPoints(left).map(p => p.across))).toBeLessThan(-1);
        expect(Math.max(...localPoints(left).map(p => p.across))).toBeLessThan(0.5);
        expect(Math.max(...localPoints(right).map(p => p.across))).toBeGreaterThan(1);
        expect(Math.min(...localPoints(right).map(p => p.across))).toBeGreaterThan(-0.5);
    });

    it('keeps a through arrow straight along the lane', () => {
        const [through] = buildTurnArrows(graphWith('through'));
        const across = localPoints(through).map(point => Math.abs(point.across));
        // Only the head barbs leave the centreline, and not by much.
        expect(Math.max(...across)).toBeLessThan(1);
    });

    it('sits back from the junction by default, not on top of it', () => {
        // No options: this is the shipped default, and an arrow painted across the stop line is
        // the failure it prevents.
        const [arrow] = buildTurnArrows(graphWith('through'));
        const along = localPoints(arrow).map(point => point.along);
        // Every vertex upstream of the portal at along = 0, and the tail a real distance back.
        expect(Math.max(...along)).toBeLessThan(0);
        expect(Math.min(...along)).toBeLessThan(-8);
    });

    it('honours a caller-supplied setback', () => {
        const near = buildTurnArrows(graphWith('through'), { setbackM: 9 })[0];
        const far = buildTurnArrows(graphWith('through'), { setbackM: 30 })[0];
        const start = arrow => localPoints(arrow)[0].along;
        expect(start(far)).toBeLessThan(start(near) - 15);
    });

    it('says nothing on a lane with no turn assignment', () => {
        expect(buildTurnArrows(graphWith(null))).toEqual([]);
        expect(buildTurnArrows(graphWith('none'))).toEqual([]);
    });

    it('draws nothing mid-block — an arrow there tells a driver nothing', () => {
        const graph = graphWith('left');
        graph.nodes[0].degree = 2;
        // A junction exists elsewhere in the graph, so this isolates the PER-LANE gate rather than
        // the cheap "no junctions at all" exit — which is what let a broken gate pass before.
        graph.nodes.push({ id: 'n:elsewhere', degree: 4 });
        expect(buildTurnArrows(graph)).toEqual([]);
    });

    it('skips a lane too short to carry the arrow clear of the junction behind it', () => {
        const graph = graphWith('through');
        graph.lanes[0].geometry.coordinates = [[NODE[0] - 0.00005, NODE[1]], NODE];
        expect(buildTurnArrows(graph)).toEqual([]);
    });

    it('ignores a movement it has no glyph for rather than drawing a wrong one', () => {
        expect(buildTurnArrows(graphWith('merge_to_left'))).toEqual([]);
        expect(buildTurnArrows(graphWith('merge_to_left;through')).map(a => a.movement))
            .toEqual(['through']);
    });

    it('returns nothing for an absent or junction-free graph', () => {
        expect(buildTurnArrows(null)).toEqual([]);
        expect(buildTurnArrows({})).toEqual([]);
        expect(buildTurnArrows({ nodes: [{ id: 'n', degree: 2 }], lanes: [] })).toEqual([]);
    });
});

describe('against a graph from the real builder', () => {
    // Guards against fixture drift: consumes whatever LaneTopologyGraph.build() actually emits,
    // including the one-way bare turn:lanes key that carries nearly every real assignment.
    function way(id, name, coordinates, nodeIds, tags) {
        return {
            type: 'Feature',
            geometry: { type: 'LineString', coordinates },
            properties: { osm_id: id, highway_type: 'secondary', name, osm_node_ids: nodeIds, tags },
        };
    }

    it('draws the assignment a one-way avenue states in turn:lanes', () => {
        const graph = LaneTopologyGraph.build({
            type: 'FeatureCollection',
            features: [
                way(101, 'Avenija', [[15.9560, 45.8000], [15.9600, 45.8000]], [1, 2], {
                    highway: 'secondary', name: 'Avenija', lanes: '3', oneway: 'yes',
                    'turn:lanes': 'left|through|through;right'
                }),
                // Three coordinates for three node ids: the middle one IS the crossing, which is
                // what makes node 2 shared and therefore a junction.
                way(102, 'Poprečna', [[15.9600, 45.7980], [15.9600, 45.8000], [15.9600, 45.8020]], [3, 2, 4], {
                    highway: 'secondary', name: 'Poprečna', lanes: '2'
                })
            ]
        }, { corridorProfile: CorridorProfile, osmProfile: OsmProfile });

        const arrows = buildTurnArrows(View.buildDisplayGraph(graph));
        const movements = arrows.map(arrow => arrow.movement).sort();
        expect(movements).toEqual(['left', 'right', 'through', 'through']);
        arrows.forEach(arrow => {
            expect(arrow.shapes.length).toBeGreaterThanOrEqual(3);
            arrow.shapes.flat().forEach(([lng, lat]) => {
                expect(Number.isFinite(lng) && Number.isFinite(lat)).toBe(true);
            });
        });
    });
});
