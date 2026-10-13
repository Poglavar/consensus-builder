// Guards junction answer stitching against stale, partial, ambiguous and regressing candidates.
import { describe, expect, it, vi } from 'vitest';
import { mergeSavedJunctions, publicCarLane } from '../scripts/lib/traffic-snapshot.mjs';

const J = 'junction';

function roadLane(id, fromNode, toNode, extra = {}) {
    return {
        id, sectionId: `section-${id}`, sourceWayId: `way-${id}`,
        fromNode, toNode, direction: 'forward', type: 'driving', access: 'yes',
        ordinal: 0, turn: null, change: 'yes', centreLane: false, ...extra
    };
}

function movement(id, fromLaneId, toLaneId, nodeId = J) {
    return { id, nodeId, fromLaneId, toLaneId };
}

function fixture({ extraBaseLane = false } = {}) {
    const lanes = [
        roadLane('in-a', 'a', J), roadLane('in-b', 'b', J),
        roadLane('out-a', J, 'c'), roadLane('out-b', J, 'd')
    ];
    if (extraBaseLane) lanes.push(roadLane('new-arm', 'e', J));
    const other = roadLane('other-in', 'x', 'other-node');
    const otherOut = roadLane('other-out', 'other-node', 'y');
    lanes.push(other, otherOut);
    const base = {
        nodes: [{ id: J }, { id: 'other-node' }],
        lanes,
        connections: [movement('old-a', 'in-a', 'out-a'), movement('keep-other', 'other-in', 'other-out', 'other-node')],
        problems: [{ type: 'unresolved_intersection', nodeIds: [J] }, { type: 'warning', nodeIds: [J] }],
        decisions: { answered: [] }
    };
    const graphLanes = lanes.filter(item => !item.id.startsWith('other-') && item.id !== 'new-arm');
    const graph = {
        nodes: base.nodes,
        lanes: graphLanes,
        connections: [movement('saved-a', 'in-a', 'out-a'), movement('saved-b', 'in-b', 'out-b')],
        problems: []
    };
    return { base, graph };
}

function solution(id, graph, overrides = {}) {
    return {
        id, parentId: null, status: 'candidate', sourceKind: 'claude',
        createdAt: '2026-10-01T00:00:00Z', stats: {}, graph, ...overrides
    };
}

const mergeOptions = { isUnsafe: () => false, missingNodes: () => new Set() };

describe('traffic snapshot saved junction merge', () => {
    it('replaces every connection at an accepted node atomically and preserves saved source metadata', () => {
        const { base, graph } = fixture();
        const candidate = solution(12, graph, { sourceKind: 'claude' });

        const merged = mergeSavedJunctions(base, [candidate], mergeOptions);

        expect(merged.connections.filter(item => item.nodeId === J)).toEqual([
            expect.objectContaining({ id: 'saved-a', savedSolutionId: '12', savedSource: 'claude' }),
            expect.objectContaining({ id: 'saved-b', savedSolutionId: '12', savedSource: 'claude' })
        ]);
        expect(merged.connections.find(item => item.id === 'keep-other')).toBeDefined();
        expect(merged.problems).toEqual([{ type: 'warning', nodeIds: [J] }]);
        expect(merged.savedJunctions).toEqual([expect.objectContaining({ nodeId: J, solutionId: '12', source: 'claude' })]);
    });

    it('does not merge rejected or deterministic solutions', () => {
        const { base, graph } = fixture();
        const rejected = solution('rejected', graph, { status: 'rejected' });
        const deterministic = solution('derived', graph, { sourceKind: 'deterministic' });

        expect(mergeSavedJunctions(base, [rejected, deterministic], mergeOptions).connections)
            .toEqual(base.connections);
    });

    it('does not merge a solution whose parent comparison finds a regression', () => {
        const { base, graph } = fixture();
        const parent = solution('parent', graph, { status: 'rejected' });
        const child = solution('child', graph, { parentId: 'parent' });
        const isUnsafe = vi.fn(() => true);

        const merged = mergeSavedJunctions(base, [parent, child], { ...mergeOptions, isUnsafe });

        expect(isUnsafe).toHaveBeenCalledWith(child, parent);
        expect(merged.connections).toEqual(base.connections);
        expect(merged.savedJunctions).toEqual([]);
    });

    it('does not merge an answer that still has an incomplete node', () => {
        const { base, graph } = fixture();
        const candidate = solution('partial', graph);

        const merged = mergeSavedJunctions(base, [candidate], {
            ...mergeOptions, missingNodes: () => new Set([J])
        });

        expect(merged.connections).toEqual(base.connections);
        expect(merged.savedJunctions).toEqual([]);
    });

    it('rejects a saved graph when the current junction has an extra arm', () => {
        const { base, graph } = fixture({ extraBaseLane: true });
        const candidate = solution('old-topology', graph);

        const merged = mergeSavedJunctions(base, [candidate], mergeOptions);

        expect(merged.connections).toEqual(base.connections);
        expect(merged.savedJunctions).toEqual([]);
    });

    it('maps stored lanes by their unique incidence when split IDs and far endpoints changed', () => {
        const { base, graph } = fixture();
        const remappedGraph = {
            ...graph,
            lanes: graph.lanes.map(item => {
                const atJunction = item.fromNode === J || item.toNode === J;
                if (!atJunction) return item;
                return {
                    ...item,
                    id: `old-${item.id}`,
                    sectionId: `old-split-${item.id}`,
                    ...(item.toNode === J ? { fromNode: `old-far-${item.fromNode}` } : { toNode: `old-far-${item.toNode}` })
                };
            }),
            connections: graph.connections.map(item => ({
                ...item,
                fromLaneId: `old-${item.fromLaneId}`,
                toLaneId: `old-${item.toLaneId}`
            }))
        };
        const candidate = solution('different-build-extent', remappedGraph);

        const merged = mergeSavedJunctions(base, [candidate], mergeOptions);

        expect(merged.connections.filter(item => item.nodeId === J)).toEqual([
            expect.objectContaining({ fromLaneId: 'in-a', toLaneId: 'out-a' }),
            expect.objectContaining({ fromLaneId: 'in-b', toLaneId: 'out-b' })
        ]);
        expect(merged.savedJunctions).toHaveLength(1);
    });

    it('treats legacy missing centreLane as false for ordinary lanes', () => {
        const { base, graph } = fixture();
        const legacyGraph = {
            ...graph,
            lanes: graph.lanes.map(item => {
                const lane = { ...item };
                delete lane.centreLane;
                return lane;
            })
        };
        const candidate = solution('legacy-centre-default', legacyGraph);

        const merged = mergeSavedJunctions(base, [candidate], mergeOptions);

        expect(merged.savedJunctions).toEqual([
            expect.objectContaining({ nodeId: J, solutionId: 'legacy-centre-default' })
        ]);
        expect(merged.connections.filter(item => item.nodeId === J)).toHaveLength(2);
    });

    it('declines lane remapping when two current lanes have ambiguous junction incidence', () => {
        const { base, graph } = fixture();
        const duplicate = roadLane('duplicate-in-a', 'elsewhere', J, { sourceWayId: 'way-in-a' });
        base.lanes.push(duplicate);
        const candidate = solution('ambiguous-incidence', graph);

        const merged = mergeSavedJunctions(base, [candidate], mergeOptions);

        expect(merged.connections).toEqual(base.connections);
        expect(merged.savedJunctions).toEqual([]);
    });

    it('accepts only public, directed driving lanes for cars', () => {
        expect(publicCarLane({ type: 'driving', direction: 'forward', access: 'yes' })).toBe(true);
        expect(publicCarLane({ type: 'bus', direction: 'forward', access: 'yes' })).toBe(false);
        expect(publicCarLane({ type: 'driving', direction: 'both' })).toBe(false);
        expect(publicCarLane({ type: 'driving', direction: 'forward', access: 'private' })).toBe(false);
        expect(publicCarLane({ type: 'driving', direction: 'forward', centreLane: true })).toBe(false);
    });
});
