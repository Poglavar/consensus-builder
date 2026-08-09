// Junctions are the unit an LLM run solves, so these lock the grouping rule: fuse by network
// adjacency and link length, never by map distance, and bias toward fusing because splitting one
// real intersection loses movements that cross the boundary.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LaneTopologyJunctions = require('../../frontend/js/lane-topology-junctions.js');
const LaneTopologyGraph = require('../../frontend/js/lane-topology-graph.js');
const CorridorProfile = require('../../frontend/js/corridor-profile.js');
const OsmProfile = require('../../frontend/js/osm-profile.js');

const { deriveJunctions, DEFAULT_MAX_LINK_LENGTH_M } = LaneTopologyJunctions;

// Hand-built graphs keep link lengths and degrees exact; the last test feeds the real builder to
// prove the module still reads the shape build() actually produces.
function node(id, lng, lat, degree) {
    return { id: `osm-node:${id}`, point: [lng, lat], degree };
}

function section(id, from, to, lengthM, name, sourceWayId) {
    return {
        id: `section:${id}`,
        startNode: `osm-node:${from}`,
        endNode: `osm-node:${to}`,
        lengthM,
        name: name || null,
        sourceWayId: sourceWayId ?? 1
    };
}

describe('deriveJunctions', () => {
    it('makes one junction from a plain crossroads and counts its arms', () => {
        const graph = {
            nodes: [node(1, 15.96, 45.8, 4), node(2, 15.961, 45.8, 1), node(3, 15.959, 45.8, 1),
                node(4, 15.96, 45.801, 1), node(5, 15.96, 45.799, 1)],
            sections: [
                section('a', 1, 2, 80, 'Savska cesta'),
                section('b', 1, 3, 80, 'Savska cesta'),
                section('c', 1, 4, 80, 'Vukovarska ulica'),
                section('d', 1, 5, 80, 'Vukovarska ulica')
            ]
        };
        const { junctions, stats } = deriveJunctions(graph);
        expect(junctions).toHaveLength(1);
        expect(junctions[0].nodeIds).toEqual(['osm-node:1']);
        expect(junctions[0].armCount).toBe(4);
        expect(junctions[0].internalSectionIds).toEqual([]);
        expect(junctions[0].name).toBe('Savska cesta × Vukovarska ulica');
        expect(stats.fused).toBe(0);
    });

    it('fuses a dual carriageway crossing joined by a short median link', () => {
        const graph = {
            nodes: [node(1, 15.96, 45.8, 3), node(2, 15.9604, 45.8, 3),
                node(3, 15.959, 45.8, 1), node(4, 15.9614, 45.8, 1),
                node(5, 15.96, 45.801, 1), node(6, 15.9604, 45.799, 1)],
            sections: [
                section('median', 1, 2, 30, null, 9),
                section('w', 1, 3, 90, 'Vukovarska ulica'),
                section('n', 1, 5, 90, 'Savska cesta'),
                section('e', 2, 4, 90, 'Vukovarska ulica'),
                section('s', 2, 6, 90, 'Savska cesta')
            ]
        };
        const { junctions, stats } = deriveJunctions(graph);
        expect(junctions).toHaveLength(1);
        expect(junctions[0].nodeIds).toEqual(['osm-node:1', 'osm-node:2']);
        // The median belongs to the junction, not to a street.
        expect(junctions[0].internalSectionIds).toEqual(['section:median']);
        expect(junctions[0].armCount).toBe(4);
        expect(stats.fused).toBe(1);
    });

    // The case that rules distance clustering out: closer together than the median above, but no
    // road runs between them, so they are two intersections and must stay two.
    it('keeps two unconnected intersections apart however close they are on the map', () => {
        const graph = {
            nodes: [node(1, 15.96, 45.8, 3), node(2, 15.96002, 45.8, 3),
                node(3, 15.959, 45.8, 1), node(4, 15.9591, 45.8005, 1),
                node(5, 15.961, 45.8, 1), node(6, 15.9611, 45.8005, 1)],
            sections: [
                section('a1', 1, 3, 90, 'Ilica'), section('a2', 1, 4, 90, 'Ilica'),
                section('b1', 2, 5, 90, 'Frankopanska'), section('b2', 2, 6, 90, 'Frankopanska')
            ]
        };
        const { junctions } = deriveJunctions(graph);
        expect(junctions).toHaveLength(2);
        expect(junctions.map(junction => junction.nodeIds)).toEqual([['osm-node:1'], ['osm-node:2']]);
    });

    it('leaves a full block between two intersections as two junctions', () => {
        const graph = {
            nodes: [node(1, 15.96, 45.8, 3), node(2, 15.962, 45.8, 3),
                node(3, 15.959, 45.8, 1), node(4, 15.963, 45.8, 1),
                node(5, 15.96, 45.801, 1), node(6, 15.962, 45.801, 1)],
            sections: [
                section('block', 1, 2, 140, 'Ilica'),
                section('a', 1, 3, 90, 'Ilica'), section('b', 1, 5, 90, 'Runjaninova'),
                section('c', 2, 4, 90, 'Ilica'), section('d', 2, 6, 90, 'Klaićeva')
            ]
        };
        const { junctions } = deriveJunctions(graph);
        expect(junctions).toHaveLength(2);
        // The block between them is an arm of both, never internal to either.
        junctions.forEach(junction => expect(junction.armSectionIds).toContain('section:block'));
    });

    it('walks through a pass-through node so a link split by a tag change still fuses', () => {
        const graph = {
            nodes: [node(1, 15.96, 45.8, 3), node(9, 15.9602, 45.8, 2), node(2, 15.9604, 45.8, 3),
                node(3, 15.959, 45.8, 1), node(4, 15.9614, 45.8, 1),
                node(5, 15.96, 45.801, 1), node(6, 15.9604, 45.799, 1)],
            sections: [
                section('link-a', 1, 9, 15, null, 9), section('link-b', 9, 2, 15, null, 9),
                section('w', 1, 3, 90, 'Vukovarska'), section('n', 1, 5, 90, 'Savska'),
                section('e', 2, 4, 90, 'Vukovarska'), section('s', 2, 6, 90, 'Savska')
            ]
        };
        const { junctions } = deriveJunctions(graph);
        expect(junctions).toHaveLength(1);
        expect(junctions[0].nodeIds).toEqual(['osm-node:1', 'osm-node:2']);
    });

    it('stops walking when the chain through pass-through nodes exceeds the limit', () => {
        const graph = {
            nodes: [node(1, 15.96, 45.8, 3), node(9, 15.9602, 45.8, 2), node(2, 15.9604, 45.8, 3),
                node(3, 15.959, 45.8, 1), node(4, 15.9614, 45.8, 1),
                node(5, 15.96, 45.801, 1), node(6, 15.9604, 45.799, 1)],
            sections: [
                section('link-a', 1, 9, 30, null, 9), section('link-b', 9, 2, 30, null, 9),
                section('w', 1, 3, 90, 'Vukovarska'), section('n', 1, 5, 90, 'Savska'),
                section('e', 2, 4, 90, 'Vukovarska'), section('s', 2, 6, 90, 'Savska')
            ]
        };
        expect(deriveJunctions(graph).junctions).toHaveLength(2);
    });

    it('never fuses two junctions through a third one between them', () => {
        const graph = {
            nodes: [node(1, 15.96, 45.8, 3), node(2, 15.9603, 45.8, 4), node(3, 15.9606, 45.8, 3),
                node(4, 15.959, 45.8, 1), node(5, 15.96, 45.801, 1),
                node(6, 15.9603, 45.801, 1), node(7, 15.9606, 45.801, 1), node(8, 15.962, 45.8, 1)],
            sections: [
                section('l1', 1, 2, 25, 'Ilica'), section('l2', 2, 3, 25, 'Ilica'),
                section('a', 1, 4, 90, 'Ilica'), section('b', 1, 5, 90, 'A'),
                section('c', 2, 6, 90, 'B'), section('d', 2, 8, 90, 'B'),
                section('e', 3, 7, 90, 'C'), section('f', 3, 8, 90, 'C')
            ]
        };
        const { junctions } = deriveJunctions(graph);
        // 1 fuses with 2 and 2 with 3 — but 1 and 3 are 50 m apart THROUGH a junction, so the walk
        // stops at 2 and all three land in one component only via legitimate pairwise links.
        expect(junctions).toHaveLength(1);
        expect(junctions[0].nodeIds).toEqual(['osm-node:1', 'osm-node:2', 'osm-node:3']);
    });

    it('respects a caller-supplied link length', () => {
        const graph = {
            nodes: [node(1, 15.96, 45.8, 3), node(2, 15.9604, 45.8, 3),
                node(3, 15.959, 45.8, 1), node(4, 15.9614, 45.8, 1),
                node(5, 15.96, 45.801, 1), node(6, 15.9604, 45.799, 1)],
            sections: [
                section('median', 1, 2, 30, null, 9),
                section('w', 1, 3, 90, 'A'), section('n', 1, 5, 90, 'B'),
                section('e', 2, 4, 90, 'A'), section('s', 2, 6, 90, 'B')
            ]
        };
        expect(deriveJunctions(graph, { maxLinkLengthM: 10 }).junctions).toHaveLength(2);
        expect(deriveJunctions(graph, { maxLinkLengthM: 60 }).junctions).toHaveLength(1);
        expect(DEFAULT_MAX_LINK_LENGTH_M).toBe(40);
    });

    it('reports a span so a caller can refuse a crop that would blow the imagery budget', () => {
        const graph = {
            nodes: [node(1, 15.96, 45.8, 3), node(2, 15.9604, 45.8, 3),
                node(3, 15.959, 45.8, 1), node(4, 15.9614, 45.8, 1),
                node(5, 15.96, 45.801, 1), node(6, 15.9604, 45.799, 1)],
            sections: [
                section('median', 1, 2, 30, null, 9),
                section('w', 1, 3, 90, 'A'), section('n', 1, 5, 90, 'B'),
                section('e', 2, 4, 90, 'A'), section('s', 2, 6, 90, 'B')
            ]
        };
        const junction = deriveJunctions(graph).junctions[0];
        expect(junction.spanM).toBeGreaterThan(25);
        expect(junction.spanM).toBeLessThan(45);
        expect(junction.point[0]).toBeCloseTo(15.9602, 4);
    });

    it('flags a junction whose nodes cannot be matched across OSM snapshots', () => {
        const graph = {
            nodes: [
                { id: 'coord:15.96,45.8', point: [15.96, 45.8], degree: 3 },
                node(2, 15.959, 45.8, 1), node(3, 15.961, 45.8, 1), node(4, 15.96, 45.801, 1)
            ],
            sections: [
                { id: 'section:a', startNode: 'coord:15.96,45.8', endNode: 'osm-node:2', lengthM: 90, name: 'A', sourceWayId: 1 },
                { id: 'section:b', startNode: 'coord:15.96,45.8', endNode: 'osm-node:3', lengthM: 90, name: 'A', sourceWayId: 1 },
                { id: 'section:c', startNode: 'coord:15.96,45.8', endNode: 'osm-node:4', lengthM: 90, name: 'B', sourceWayId: 2 }
            ]
        };
        const junction = deriveJunctions(graph).junctions[0];
        expect(junction.stableIdentity).toBe(false);
        expect(junction.osmNodeIds).toEqual([]);
        expect(junction.name).toBe('A × B');
    });

    it('finds nothing when every node is solvable deterministically', () => {
        const graph = {
            nodes: [node(1, 15.96, 45.8, 2), node(2, 15.961, 45.8, 2), node(3, 15.962, 45.8, 1)],
            sections: [section('a', 1, 2, 90, 'Ilica'), section('b', 2, 3, 90, 'Ilica')]
        };
        const { junctions, stats } = deriveJunctions(graph);
        expect(junctions).toEqual([]);
        expect(stats.seedNodes).toBe(0);
    });

    it('survives an empty or malformed graph', () => {
        expect(deriveJunctions(null).junctions).toEqual([]);
        expect(deriveJunctions({}).junctions).toEqual([]);
        expect(deriveJunctions({ nodes: [], sections: [] }).junctions).toEqual([]);
    });
});

describe('deriveJunctions on a real built graph', () => {
    // Guards against fixture drift: this consumes whatever LaneTopologyGraph.build() actually emits.
    function way(id, name, coordinates, nodeIds, tags = {}) {
        return {
            type: 'Feature',
            geometry: { type: 'LineString', coordinates },
            properties: {
                osm_id: id,
                highway_type: 'secondary',
                name,
                osm_node_ids: nodeIds,
                tags: { highway: 'secondary', name, ...tags }
            }
        };
    }

    it('extracts the crossroads that the builder itself reports as unresolved', () => {
        // Savska carries two forward lanes, which is what keeps this crossroads unresolved: with
        // one lane per direction on every arm the deterministic rules would settle it and there
        // would be no recognition work to extract.
        const evidence = {
            type: 'FeatureCollection',
            features: [
                way(101, 'Savska cesta', [[15.9590, 45.8000], [15.9600, 45.8000], [15.9610, 45.8000]], [1, 2, 3],
                    { lanes: '3', 'lanes:forward': '2', 'lanes:backward': '1' }),
                way(102, 'Vukovarska ulica', [[15.9600, 45.7990], [15.9600, 45.8000], [15.9600, 45.8010]], [4, 2, 5])
            ]
        };
        const graph = LaneTopologyGraph.build(evidence, {
            snapshotAt: '2026-07-28T00:00:00.000Z',
            profileFromTags: CorridorProfile.corridorProfileFromOsmTags,
            orientProfile: OsmProfile.orientForRightHandTraffic
        });

        const unresolved = graph.problems.filter(problem => problem.type === 'unresolved_intersection');
        expect(unresolved).toHaveLength(1);

        const { junctions } = deriveJunctions(graph);
        expect(junctions).toHaveLength(1);
        expect(junctions[0].nodeIds).toEqual(['osm-node:2']);
        expect(junctions[0].armCount).toBe(4);
        expect(junctions[0].name).toBe('Savska cesta × Vukovarska ulica');
        // The builder normalises osm_id to a string; junctions pass it through untouched.
        expect(junctions[0].sourceWayIds).toEqual(['101', '102']);
        // Exactly the node the builder gave up on.
        expect(unresolved[0].id).toContain(junctions[0].nodeIds[0]);
        expect(junctions[0].resolved).toBe(false);
    });
});
