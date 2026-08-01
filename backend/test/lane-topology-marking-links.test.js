// A solved graph states which lane continues into which, so lane markings must taper along the
// topology rather than along a nearest-endpoint guess. These lock the derivation: continuations
// only, pass-through nodes only, and no lane silently landing on the centreline because its offset
// was missing. The last test feeds the real graph builder so the shape stays the one build() emits.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MarkingLinks = require('../../frontend/js/lane-topology-marking-links.js');
const LaneTopologyGraph = require('../../frontend/js/lane-topology-graph.js');
const CorridorProfile = require('../../frontend/js/corridor-profile.js');
const OsmProfile = require('../../frontend/js/osm-profile.js');

const { buildMarkingLinks, offsetPairs } = MarkingLinks;

function graphOf({ nodes, sections, lanes, connections }) {
    return { nodes, sections, lanes, connections };
}

// A bend: two sections meeting at one degree-2 node, two lanes each, all continuing.
function bendGraph(overrides = {}) {
    return graphOf({
        nodes: [{ id: 'n:mid', degree: 2 }],
        sections: [
            { id: 's:a', startNode: 'n:start', endNode: 'n:mid' },
            { id: 's:b', startNode: 'n:mid', endNode: 'n:end' }
        ],
        lanes: [
            { id: 'l:a1', sectionId: 's:a', offset: -1.6 },
            { id: 'l:a2', sectionId: 's:a', offset: 1.6 },
            { id: 'l:b1', sectionId: 's:b', offset: -1.6 },
            { id: 'l:b2', sectionId: 's:b', offset: 1.6 }
        ],
        connections: [
            { id: 'c:1', nodeId: 'n:mid', fromLaneId: 'l:a1', toLaneId: 'l:b1', type: 'continue' },
            { id: 'c:2', nodeId: 'n:mid', fromLaneId: 'l:a2', toLaneId: 'l:b2', type: 'continue' }
        ],
        ...overrides
    });
}

describe('buildMarkingLinks', () => {
    it('links the two sections meeting at a pass-through node, with a match per continuing lane', () => {
        const links = buildMarkingLinks(bendGraph());
        expect(links).toHaveLength(1);
        expect(links[0].nodeId).toBe('n:mid');
        expect(links[0].a).toEqual({ sectionId: 's:a', side: 'end' });
        expect(links[0].b).toEqual({ sectionId: 's:b', side: 'start' });
        expect(links[0].matches.map(match => [match.aOffset, match.bOffset]))
            .toEqual([[-1.6, -1.6], [1.6, 1.6]]);
    });

    it('records the side each section actually meets the node on, not a fixed end', () => {
        const graph = bendGraph();
        // Section B digitized the other way round: it now ENDS at the shared node.
        graph.sections[1] = { id: 's:b', startNode: 'n:end', endNode: 'n:mid' };
        const links = buildMarkingLinks(graph);
        expect(links[0].b).toEqual({ sectionId: 's:b', side: 'end' });
    });

    it('ignores merges, splits and turns — only a continuing lane carries its dividers across', () => {
        const graph = bendGraph();
        graph.connections[1].type = 'merge';
        const links = buildMarkingLinks(graph);
        expect(links[0].matches.map(match => match.aLaneId)).toEqual(['l:a1']);
    });

    it('refuses to link across a junction, where the paint stops at the portal instead', () => {
        const graph = bendGraph();
        graph.nodes[0].degree = 3;
        expect(buildMarkingLinks(graph)).toEqual([]);
    });

    it('drops a lane with no offset rather than letting Number(null) park it on the centreline', () => {
        const graph = bendGraph();
        graph.lanes[0].offset = null;
        const links = buildMarkingLinks(graph);
        expect(links[0].matches.map(match => match.aOffset)).toEqual([1.6]);
        expect(links[0].matches.every(match => match.aOffset !== 0)).toBe(true);
    });

    it('never lets one divider continue into two', () => {
        const graph = bendGraph();
        graph.connections.push({
            id: 'c:3', nodeId: 'n:mid', fromLaneId: 'l:a1', toLaneId: 'l:b2', type: 'continue'
        });
        const links = buildMarkingLinks(graph);
        expect(links[0].matches).toHaveLength(2);
        expect(new Set(links[0].matches.map(match => match.bLaneId)).size).toBe(2);
    });

    it('orients a and b by section id, so connection direction cannot flip the output', () => {
        const forward = buildMarkingLinks(bendGraph());
        const graph = bendGraph();
        graph.connections = graph.connections.map(connection => ({
            ...connection,
            fromLaneId: connection.toLaneId,
            toLaneId: connection.fromLaneId
        }));
        const reversed = buildMarkingLinks(graph);
        expect(reversed[0].a).toEqual(forward[0].a);
        expect(reversed[0].b).toEqual(forward[0].b);
        expect(reversed[0].matches.map(match => [match.aOffset, match.bOffset]))
            .toEqual(forward[0].matches.map(match => [match.aOffset, match.bOffset]));
    });

    it('skips a self-loop, which has no neighbouring cross-section to map into', () => {
        const graph = bendGraph();
        graph.lanes[2].sectionId = 's:a';
        graph.lanes[3].sectionId = 's:a';
        expect(buildMarkingLinks(graph)).toEqual([]);
    });

    it('skips a node the graph never described, rather than assuming it passes through', () => {
        const graph = bendGraph();
        graph.nodes = [];
        expect(buildMarkingLinks(graph)).toEqual([]);
    });

    it('returns nothing for an absent graph', () => {
        expect(buildMarkingLinks(null)).toEqual([]);
        expect(buildMarkingLinks({})).toEqual([]);
    });

    it('sorts matches across the cross-section so downstream interpolation can assume order', () => {
        const graph = bendGraph();
        graph.connections.reverse();
        const links = buildMarkingLinks(graph);
        expect(links[0].matches.map(match => match.aOffset)).toEqual([-1.6, 1.6]);
    });
});

describe('offsetPairs', () => {
    it('reads the cross-section correspondence in either direction', () => {
        const link = buildMarkingLinks(bendGraph())[0];
        link.matches[1].bOffset = 4.9;
        expect(offsetPairs(link, 'a->b')).toEqual([{ from: -1.6, to: -1.6 }, { from: 1.6, to: 4.9 }]);
        expect(offsetPairs(link, 'b->a')).toEqual([{ from: -1.6, to: -1.6 }, { from: 4.9, to: 1.6 }]);
    });

    it('has nothing to say about a link with no matches', () => {
        expect(offsetPairs(null, 'a->b')).toEqual([]);
    });
});

describe('against a graph from the real builder', () => {
    // Guards against fixture drift: this consumes whatever LaneTopologyGraph.build() actually emits.
    // Two ways meeting end to end at node 2 — a bend, so the shared node stays degree 2.
    function way(id, name, coordinates, nodeIds) {
        return {
            type: 'Feature',
            geometry: { type: 'LineString', coordinates },
            properties: {
                osm_id: id,
                highway_type: 'secondary',
                name,
                osm_node_ids: nodeIds,
                tags: { highway: 'secondary', name, lanes: '2' }
            }
        };
    }

    const evidence = {
        type: 'FeatureCollection',
        features: [
            way(101, 'Testna ulica', [[15.9590, 45.8000], [15.9610, 45.8000]], [1, 2]),
            way(102, 'Testna ulica', [[15.9610, 45.8000], [15.9630, 45.8010]], [2, 3])
        ]
    };

    it('produces a link whose offsets are lane offsets the graph actually emitted', () => {
        const graph = LaneTopologyGraph.build(evidence, {
            corridorProfile: CorridorProfile,
            osmProfile: OsmProfile
        });
        const links = buildMarkingLinks(graph);
        expect(links.length).toBeGreaterThan(0);

        const offsets = new Set(graph.lanes.map(lane => lane.offset));
        links.forEach(link => {
            expect(link.matches.length).toBeGreaterThan(0);
            link.matches.forEach(match => {
                expect(offsets.has(match.aOffset)).toBe(true);
                expect(offsets.has(match.bOffset)).toBe(true);
            });
            // A link only ever names a section end the graph agrees the node sits on.
            [link.a, link.b].forEach(endpoint => {
                const section = graph.sections.find(candidate => candidate.id === endpoint.sectionId);
                expect(section).toBeTruthy();
                expect(endpoint.side === 'start' ? section.startNode : section.endNode)
                    .toBe(link.nodeId);
            });
        });
    });
});
