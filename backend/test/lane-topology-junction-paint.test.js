// The junction interior has two halves with different licences. The SURFACE is geometry — every
// junction has an inside, so every junction gets paving. The GUIDE LINES are topology, and a
// junction with no solved connections must get none: a fabricated turn marking would make an
// unsolved junction look solved, which is the one failure this tool cannot afford.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const JunctionPaint = require('../../frontend/js/lane-topology-junction-paint.js');
const View = require('../../frontend/js/lane-topology-view.js');
const LaneTopologyGraph = require('../../frontend/js/lane-topology-graph.js');
const CorridorProfile = require('../../frontend/js/corridor-profile.js');
const OsmProfile = require('../../frontend/js/osm-profile.js');

const {
    convexHull,
    junctionSurfaces,
    junctionGuideLines,
    buildJunctionPaint
} = JunctionPaint;

const NODE = [15.96, 45.8];
// Roughly 7.7 m east at this latitude, and 11.1 m north — enough to sit a portal on.
const DX = 0.0001;
const DY = 0.0001;

// A lane already trimmed to its portal: `toNode` lanes END at the junction, `fromNode` lanes leave it.
function lane(id, sectionId, offset, arriving, [dx, dy]) {
    const outer = [NODE[0] + dx * 3, NODE[1] + dy * 3];
    const portal = [NODE[0] + dx, NODE[1] + dy];
    return {
        id,
        sectionId,
        offset,
        width: 3,
        direction: 'forward',
        fromNode: arriving ? 'n:outer' : 'n:junction',
        toNode: arriving ? 'n:junction' : 'n:outer',
        geometry: { type: 'LineString', coordinates: arriving ? [outer, portal] : [portal, outer] }
    };
}

const WEST = [-DX, 0];
const EAST = [DX, 0];
const NORTH = [0, DY];
const SOUTH = [0, -DY];

function crossroads(overrides = {}) {
    return {
        nodes: [{ id: 'n:junction', degree: 4, point: NODE }, { id: 'n:outer', degree: 1 }],
        lanes: [
            lane('l:w-in', 's:west', 1.5, true, WEST),
            lane('l:w-in2', 's:west', 4.5, true, WEST),
            lane('l:e-out', 's:east', 1.5, false, EAST),
            lane('l:e-out2', 's:east', 4.5, false, EAST),
            lane('l:n-in', 's:north', 1.5, true, NORTH),
            lane('l:s-out', 's:south', 1.5, false, SOUTH)
        ],
        connections: [],
        ...overrides
    };
}

function through(id, fromLaneId, toLaneId) {
    return { id, nodeId: 'n:junction', fromLaneId, toLaneId, type: 'continue' };
}

describe('convexHull', () => {
    it('wraps scattered points in the square that contains them', () => {
        const hull = convexHull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5], [2, 8]]);
        expect(hull).toHaveLength(4);
        expect(new Set(hull.map(point => point.join(',')))).toEqual(
            new Set(['0,0', '10,0', '10,10', '0,10'])
        );
    });

    it('drops a duplicated corner rather than emitting a zero-length edge', () => {
        const hull = convexHull([[0, 0], [0, 0], [4, 0], [4, 4], [0, 4]]);
        expect(hull).toHaveLength(4);
    });

    it('hands back what it was given when there is no area to wrap', () => {
        expect(convexHull([[1, 1], [2, 2]])).toEqual([[1, 1], [2, 2]]);
        expect(convexHull([])).toEqual([]);
    });
});

describe('junctionSurfaces', () => {
    it('closes the hole the portal setbacks leave at a crossroads', () => {
        const surfaces = junctionSurfaces(crossroads());
        expect(surfaces).toHaveLength(1);
        expect(surfaces[0].nodeId).toBe('n:junction');
        expect(surfaces[0].degree).toBe(4);
        expect(surfaces[0].ring.length).toBeGreaterThanOrEqual(3);
        expect(surfaces[0].ring.every(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat)))
            .toBe(true);
    });

    it('reaches from portal to portal along the road', () => {
        const surfaces = junctionSurfaces(crossroads());
        const lngs = surfaces[0].ring.map(([lng]) => lng);
        // The east and west portals sit one DX either side of the node; paving must cover both.
        expect(Math.min(...lngs)).toBeLessThanOrEqual(NODE[0] - DX + 1e-9);
        expect(Math.max(...lngs)).toBeGreaterThanOrEqual(NODE[0] + DX - 1e-9);
    });

    // West and east arms only, so the ring's north-south extent is decided purely by lane WIDTH.
    // On a full crossroads the north and south arms would mask it entirely.
    function straightThroughSpanM(width) {
        const graph = crossroads({
            lanes: [
                { ...lane('l:w-in', 's:west', 1.5, true, WEST), width },
                { ...lane('l:e-out', 's:east', 1.5, false, EAST), width }
            ]
        });
        graph.nodes[0].degree = 3;
        const lats = junctionSurfaces(graph)[0].ring.map(([, lat]) => lat);
        return (Math.max(...lats) - Math.min(...lats)) * 110540;
    }

    it('reaches the kerb across the road, not just the lane centre', () => {
        expect(straightThroughSpanM(3)).toBeGreaterThan(2.9);
    });

    it('gives a narrow lane a kerb clearance floor, so its patch is still drivable', () => {
        expect(straightThroughSpanM(1)).toBeGreaterThan(2.7);
    });

    it('treats an unknown width as a normal lane, never as a zero-width one', () => {
        // Number(null) is 0, which would halve to a paving patch with no width at all.
        expect(straightThroughSpanM(null)).toBeGreaterThan(2.9);
        expect(straightThroughSpanM(undefined)).toBeGreaterThan(2.9);
    });

    it('leaves mid-road nodes alone — a bend has no interior to pave', () => {
        const graph = crossroads();
        graph.nodes[0].degree = 2;
        expect(junctionSurfaces(graph)).toEqual([]);
    });

    it('needs more than one approach before there is an inside at all', () => {
        const graph = crossroads({ lanes: [lane('l:w-in', 's:west', 1.5, true, WEST)] });
        expect(junctionSurfaces(graph)).toEqual([]);
    });

    it('skips a junction whose approaches collapse onto one another — no area, nothing to pave', () => {
        const stacked = crossroads({
            lanes: [
                lane('l:a', 's:west', 1.5, true, WEST),
                lane('l:b', 's:west-again', 1.5, true, WEST),
                lane('l:c', 's:west-third', 1.5, true, WEST)
            ]
        });
        expect(junctionSurfaces(stacked)).toEqual([]);
    });

    it('returns nothing for an absent graph', () => {
        expect(junctionSurfaces(null)).toEqual([]);
        expect(junctionSurfaces({})).toEqual([]);
    });
});

describe('junctionGuideLines', () => {
    it('paints nothing inside a junction nobody has solved', () => {
        expect(junctionGuideLines(crossroads())).toEqual([]);
    });

    it('carries a divider across between two adjacent through movements', () => {
        const lines = junctionGuideLines(crossroads({
            connections: [
                through('c:1', 'l:w-in', 'l:e-out'),
                through('c:2', 'l:w-in2', 'l:e-out2')
            ]
        }));

        expect(lines).toHaveLength(1);
        expect(lines[0].kind).toBe('through');
        expect(lines[0].nodeId).toBe('n:junction');
        expect(lines[0].connectionIds).toEqual(['c:1', 'c:2']);
        expect(lines[0].coordinates.length).toBeGreaterThan(2);
        // It has to actually cross the junction, west portal to east portal.
        const lngs = lines[0].coordinates.map(([lng]) => lng);
        expect(Math.min(...lngs)).toBeCloseTo(NODE[0] - DX, 6);
        expect(Math.max(...lngs)).toBeCloseTo(NODE[0] + DX, 6);
    });

    it('draws one divider per gap, so three lanes through give two lines', () => {
        const graph = crossroads();
        graph.lanes.push(lane('l:w-in3', 's:west', 7.5, true, WEST));
        graph.lanes.push(lane('l:e-out3', 's:east', 7.5, false, EAST));
        graph.connections = [
            through('c:1', 'l:w-in', 'l:e-out'),
            through('c:2', 'l:w-in2', 'l:e-out2'),
            through('c:3', 'l:w-in3', 'l:e-out3')
        ];

        const lines = junctionGuideLines(graph);
        expect(lines.filter(line => line.kind === 'through')).toHaveLength(2);
    });

    it('refuses to bridge across a lane that is not part of the movement', () => {
        const graph = crossroads();
        // A third westbound lane sits BETWEEN the two that continue, so they are not neighbours and
        // the line between them would cut straight across it.
        graph.lanes.push(lane('l:w-mid', 's:west', 3, true, WEST));
        graph.connections = [
            through('c:1', 'l:w-in', 'l:e-out'),
            through('c:2', 'l:w-in2', 'l:e-out2')
        ];

        expect(junctionGuideLines(graph)).toEqual([]);
    });

    it('keeps movements to different exits apart, rather than pairing across them', () => {
        const graph = crossroads();
        // Offsets chosen so that WITHOUT the per-movement grouping these two would look like an
        // adjacent pair and get a divider drawn between a westbound and a southbound stream.
        graph.lanes.push(lane('l:n-in2', 's:north', 4.5, true, NORTH));
        graph.lanes.push(lane('l:s-out2', 's:south', 4.5, false, SOUTH));
        graph.connections = [
            through('c:1', 'l:w-in', 'l:e-out'),
            through('c:2', 'l:n-in2', 'l:s-out2')
        ];

        expect(junctionGuideLines(graph)).toEqual([]);
    });

    it('follows the turning path for a turn, one line per movement', () => {
        const lines = junctionGuideLines(crossroads({
            connections: [{
                id: 'c:turn',
                nodeId: 'n:junction',
                fromLaneId: 'l:w-in',
                toLaneId: 'l:s-out',
                type: 'turn'
            }]
        }));

        expect(lines).toHaveLength(1);
        expect(lines[0].kind).toBe('turn');
        expect(lines[0].connectionIds).toEqual(['c:turn']);
        // A turn is a curve, not the two-point stub the solver stores as placeholder geometry.
        expect(lines[0].coordinates.length).toBeGreaterThan(2);
        const first = lines[0].coordinates[0];
        const last = lines[0].coordinates[lines[0].coordinates.length - 1];
        expect(first[0]).toBeCloseTo(NODE[0] - DX, 9);
        expect(last[1]).toBeCloseTo(NODE[1] - DY, 9);
    });

    it('ignores connections at a mid-road node, where the section markings already join up', () => {
        const graph = crossroads({
            connections: [
                through('c:1', 'l:w-in', 'l:e-out'),
                through('c:2', 'l:w-in2', 'l:e-out2')
            ]
        });
        graph.nodes[0].degree = 2;
        expect(junctionGuideLines(graph)).toEqual([]);
    });

    it('skips a connection naming a lane the graph does not have', () => {
        const lines = junctionGuideLines(crossroads({
            connections: [through('c:1', 'l:missing', 'l:e-out')]
        }));
        expect(lines).toEqual([]);
    });
});

describe('buildJunctionPaint on a graph from the real builder', () => {
    // Guards against fixture drift: this consumes whatever LaneTopologyGraph.build() actually emits.
    function way(id, name, coordinates, nodeIds) {
        return {
            type: 'Feature',
            geometry: { type: 'LineString', coordinates },
            properties: {
                osm_id: id,
                highway_type: 'secondary',
                name,
                osm_node_ids: nodeIds,
                tags: { highway: 'secondary', name, lanes: '4' }
            }
        };
    }

    const evidence = {
        type: 'FeatureCollection',
        features: [
            way(101, 'Savska cesta', [[15.9590, 45.8000], [15.9600, 45.8000], [15.9610, 45.8000]], [1, 2, 3]),
            way(102, 'Vukovarska ulica', [[15.9600, 45.7990], [15.9600, 45.8000], [15.9600, 45.8010]], [4, 2, 5])
        ]
    };

    it('paves the crossroads but invents no markings, because the builder solves no junctions', () => {
        const graph = LaneTopologyGraph.build(evidence, {
            corridorProfile: CorridorProfile,
            osmProfile: OsmProfile
        });
        const display = View.buildDisplayGraph(graph);
        const paint = buildJunctionPaint(display);

        const junctions = display.nodes.filter(node => node.degree >= 3);
        expect(junctions.length).toBeGreaterThan(0);
        expect(paint.surfaces.length).toBe(junctions.length);
        // The deterministic pass connects degree-2 nodes only; a junction stays visibly unsolved.
        expect(graph.connections.every(connection => connection.type !== 'turn')).toBe(true);
        expect(paint.guideLines).toEqual([]);

        paint.surfaces.forEach(surface => {
            expect(surface.spanM).toBeGreaterThan(0);
            expect(surface.ring.every(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat)))
                .toBe(true);
        });
    });
});
