import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LaneTopologyGraph = require('../../frontend/js/lane-topology-graph.js');
const CorridorProfile = require('../../frontend/js/corridor-profile.js');
const OsmProfile = require('../../frontend/js/osm-profile.js');

const BUILD_OPTIONS = {
    generatedAt: '2026-07-28T00:00:00.000Z',
    profileFromTags: CorridorProfile.corridorProfileFromOsmTags,
    orientProfile: OsmProfile.orientForRightHandTraffic
};

function way(id, coordinates, tags, nodes = null) {
    return {
        type: 'Feature',
        properties: {
            osm_id: id,
            tags,
            ...(nodes ? { osm_node_ids: nodes } : {})
        },
        geometry: { type: 'LineString', coordinates }
    };
}

describe('deterministic OSM lane graph', () => {
    it('connects both directions across an exact, harmless OSM way split', () => {
        const graph = LaneTopologyGraph.build([
            way(1, [[15.96, 45.80], [15.961, 45.80]], {
                highway: 'secondary', name: 'Savska cesta', lanes: '2',
                'lanes:forward': '1', 'lanes:backward': '1'
            }, [10, 20]),
            way(2, [[15.961, 45.80], [15.962, 45.80]], {
                highway: 'secondary', name: 'Savska cesta', lanes: '2',
                'lanes:forward': '1', 'lanes:backward': '1'
            }, [20, 30])
        ], BUILD_OPTIONS);

        expect(graph.sections).toHaveLength(2);
        expect(graph.lanes).toHaveLength(4);
        expect(graph.connections).toHaveLength(2);
        expect(graph.connections.every(connection => connection.type === 'continue')).toBe(true);
        expect(graph.source.nodeIdentity).toBe('osm-node-id');
        expect(graph.problems).toHaveLength(0);
    });

    it('represents one added lane as a binary split', () => {
        const graph = LaneTopologyGraph.build([
            way(1, [[15.96, 45.80], [15.961, 45.80]], {
                highway: 'secondary', lanes: '2', 'lanes:forward': '1', 'lanes:backward': '1'
            }, [10, 20]),
            way(2, [[15.961, 45.80], [15.963, 45.80]], {
                highway: 'secondary', lanes: '3', 'lanes:forward': '2', 'lanes:backward': '1'
            }, [20, 30])
        ], BUILD_OPTIONS);

        expect(graph.connections.filter(connection => connection.type === 'split')).toHaveLength(2);
        const splitFrom = graph.connections
            .filter(connection => connection.type === 'split')
            .map(connection => connection.fromLaneId);
        expect(new Set(splitFrom).size).toBe(1);
        expect(graph.problems.some(problem => problem.type === 'nonbinary_transition')).toBe(false);
    });

    it('does not invent a connection across a coordinate gap', () => {
        const graph = LaneTopologyGraph.build([
            way(1, [[15.96, 45.80], [15.961, 45.80]], { highway: 'secondary', lanes: '2' }),
            way(2, [[15.9611, 45.80], [15.962, 45.80]], { highway: 'secondary', lanes: '2' })
        ], BUILD_OPTIONS);

        expect(graph.connections).toHaveLength(0);
        expect(graph.source.nodeIdentity).toBe('coordinate-fallback');
        expect(graph.problems.some(problem => problem.type === 'missing_osm_node_ids')).toBe(true);
    });

    it('flags opposing restricted access on a one-way way without asserting physical contraflow', () => {
        const graph = LaneTopologyGraph.build([
            way(849041697, [[15.96289, 45.80036], [15.96277, 45.80020]], {
                highway: 'secondary',
                oneway: 'yes',
                'oneway:psv': 'no',
                lanes: '4',
                'lanes:forward': '3',
                'lanes:backward': '1',
                'access:lanes:backward': 'no',
                'psv:lanes:backward': 'designated',
                'embedded_rails:lanes:backward': 'tram'
            }, [100, 101])
        ], BUILD_OPTIONS);

        const backward = graph.lanes.find(lane => lane.direction === 'backward');
        expect(backward).toMatchObject({ type: 'bus', access: 'psv', embeddedRail: true });
        const problem = graph.problems.find(candidate => candidate.type === 'directional_transit_exception');
        expect(problem).toBeTruthy();
        expect(problem.message.toLowerCase()).not.toContain('contraflow');
        expect(problem.message.toLowerCase()).not.toContain('reverse');
    });

    it('prefers detailed directional counts but exposes a contradictory total', () => {
        const graph = LaneTopologyGraph.build([
            way(779283872, [[15.95291, 45.78573], [15.95280, 45.78557]], {
                highway: 'unclassified',
                lanes: '3',
                'lanes:forward': '2',
                'lanes:backward': '2'
            }, [200, 201])
        ], BUILD_OPTIONS);

        expect(graph.lanes).toHaveLength(4);
        expect(graph.problems).toContainEqual(expect.objectContaining({
            type: 'contradictory_lane_counts',
            severity: 'error'
        }));
    });

    it('is independent of input way order', () => {
        const first = way(1, [[15.96, 45.80], [15.961, 45.80]], { highway: 'secondary', lanes: '2' }, [10, 20]);
        const second = way(2, [[15.961, 45.80], [15.962, 45.80]], { highway: 'secondary', lanes: '2' }, [20, 30]);
        expect(LaneTopologyGraph.build([first, second], BUILD_OPTIONS))
            .toEqual(LaneTopologyGraph.build([second, first], BUILD_OPTIONS));
    });
});
