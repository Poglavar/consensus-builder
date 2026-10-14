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

function centreDirectionMismatchFixture({ extraPublicLane = false, centreMovement = true } = {}) {
    const currentLanes = [
        roadLane('in-a', 'a', J, { sourceWayId: 'way-in-a' }),
        roadLane('in-b', 'b', J, { sourceWayId: 'way-in-b' }),
        roadLane('out-a', J, 'c', { sourceWayId: 'way-out-a' }),
        roadLane('out-b', J, 'd', { sourceWayId: 'way-out-b' }),
        roadLane('centre-forward', 'e', J, {
            sourceWayId: 'way-centre', direction: 'forward', ordinal: 0,
            turn: 'left', centreLane: true
        }),
        roadLane('centre-backward', J, 'f', {
            sourceWayId: 'way-centre', direction: 'backward', ordinal: 0,
            turn: 'left', centreLane: true
        })
    ];
    if (extraPublicLane) currentLanes.push(roadLane('new-public-in', 'g', J, {
        sourceWayId: 'new-public-way'
    }));

    const oldLanes = [
        roadLane('old-in-a', 'old-a', J, { sourceWayId: 'way-in-a' }),
        roadLane('old-in-b', 'old-b', J, { sourceWayId: 'way-in-b' }),
        roadLane('old-out-a', J, 'old-c', { sourceWayId: 'way-out-a' }),
        roadLane('old-out-b', J, 'old-d', { sourceWayId: 'way-out-b' }),
        roadLane('old-centre-both', 'old-e', J, {
            sourceWayId: 'way-centre', direction: 'both', ordinal: 0,
            turn: null, centreLane: false
        })
    ];
    const base = {
        nodes: [{ id: J, degree: 5 }],
        lanes: currentLanes,
        connections: [movement('existing-a', 'in-a', 'out-a')],
        problems: [{ type: 'unresolved_intersection', nodeIds: [J] }],
        decisions: { answered: [] }
    };
    const graph = {
        nodes: [{ id: J, degree: 5 }],
        lanes: oldLanes,
        connections: [
            movement('saved-a', 'old-in-a', 'old-out-a'),
            movement('saved-b', 'old-in-b', 'old-out-b'),
            ...(centreMovement ? [movement('saved-centre', 'old-centre-both', 'old-out-a')] : [])
        ],
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
        const partialGraph = { ...graph, connections: [movement('saved-b', 'in-b', 'out-b')] };
        const rejected = solution('rejected', partialGraph, { status: 'rejected' });
        const deterministic = solution('derived', partialGraph, { sourceKind: 'deterministic' });

        const merged = mergeSavedJunctions(base, [rejected, deterministic], {
            ...mergeOptions, missingNodes: () => new Set([J])
        });
        expect(merged.connections).toEqual(base.connections);
        expect(merged.savedPartialJunctions).toEqual([]);
    });

    it('does not merge a solution whose parent comparison finds a regression', () => {
        const { base, graph } = fixture();
        const parent = solution('parent', graph, { status: 'rejected' });
        const child = solution('child', {
            ...graph, connections: [movement('saved-b', 'in-b', 'out-b')]
        }, { parentId: 'parent' });
        const isUnsafe = vi.fn(() => true);

        const merged = mergeSavedJunctions(base, [parent, child], {
            ...mergeOptions, isUnsafe, missingNodes: () => new Set([J])
        });

        expect(isUnsafe).toHaveBeenCalledWith(child, parent);
        expect(merged.connections).toEqual(base.connections);
        expect(merged.savedJunctions).toEqual([]);
        expect(merged.savedPartialJunctions).toEqual([]);
    });

    it('does not merge an answer that still has an incomplete node', () => {
        const { base, graph } = fixture();
        // The candidate only repeats the already assigned in-a movement; it has no saved move
        // for the currently unassigned in-b lane, so partial import must add nothing.
        const candidate = solution('partial', {
            ...graph, connections: [movement('saved-a', 'in-a', 'out-a')]
        });

        const merged = mergeSavedJunctions(base, [candidate], {
            ...mergeOptions, missingNodes: () => new Set([J])
        });

        expect(merged.connections).toEqual(base.connections);
        expect(merged.savedJunctions).toEqual([]);
        expect(merged.savedPartialJunctions).toEqual([]);
    });

    it('fills only zero-exit incoming lanes from a compatible partial answer and keeps the node unresolved', () => {
        const { base, graph } = fixture();
        const candidate = solution('partial-in-b', {
            ...graph, connections: [movement('saved-b', 'in-b', 'out-b')]
        });

        const merged = mergeSavedJunctions(base, [candidate], {
            ...mergeOptions, missingNodes: () => new Set([J])
        });

        expect(merged.connections.filter(item => item.nodeId === J)).toEqual([
            base.connections.find(item => item.id === 'old-a'),
            expect.objectContaining({
                id: 'saved-b', fromLaneId: 'in-b', toLaneId: 'out-b',
                savedSolutionId: 'partial-in-b', savedSource: 'claude'
            })
        ]);
        expect(merged.connections.find(item => item.id === 'keep-other')).toBeDefined();
        expect(merged.problems).toEqual(base.problems);
        expect(merged.savedJunctions).toEqual([]);
        expect(merged.savedPartialJunctions).toEqual([{
            nodeId: J, solutionId: 'partial-in-b', source: 'claude', status: 'candidate',
            createdAt: '2026-10-01T00:00:00Z', laneIds: ['in-b']
        }]);
    });

    it.each([
        ['node', { nodeIds: [J] }],
        ['incident lane', { laneIds: ['in-b'] }],
        ['incident section', { sectionIds: ['section-in-b'] }]
    ])('blocks a partial import when a non-unresolved error names the %s', (_label, location) => {
        const { base, graph } = fixture();
        const candidate = solution('error-at-node', {
            ...graph,
            connections: [movement('saved-b', 'in-b', 'out-b')],
            problems: [{ type: 'invalid_geometry', severity: 'error', ...location }]
        });

        const merged = mergeSavedJunctions(base, [candidate], {
            ...mergeOptions, missingNodes: () => new Set([J])
        });

        expect(merged.connections).toEqual(base.connections);
        expect(merged.savedPartialJunctions).toEqual([]);
    });

    it('does not partially import a human-decided node', () => {
        const { base, graph } = fixture();
        base.decisions.answered.push({ nodeId: J, assignment: {} });
        const candidate = solution('human-decided', {
            ...graph, connections: [movement('saved-b', 'in-b', 'out-b')]
        });

        const merged = mergeSavedJunctions(base, [candidate], {
            ...mergeOptions, missingNodes: () => new Set([J])
        });

        expect(merged.connections).toEqual(base.connections);
        expect(merged.savedPartialJunctions).toEqual([]);
    });

    it('does not import a partial movement when its stored incoming lane has no unique match', () => {
        const { base, graph } = fixture();
        const candidate = solution('unmatched-in-b', {
            ...graph,
            lanes: graph.lanes.map(item => item.id === 'in-b'
                ? { ...item, sourceWayId: 'different-way' }
                : item),
            connections: [movement('saved-b', 'in-b', 'out-b')]
        });

        const merged = mergeSavedJunctions(base, [candidate], {
            ...mergeOptions, missingNodes: () => new Set([J])
        });

        expect(merged.connections).toEqual(base.connections);
        expect(merged.savedPartialJunctions).toEqual([]);
    });

    it('keeps the newest compatible partial answer per incoming lane', () => {
        const { base, graph } = fixture();
        const older = solution('older', {
            ...graph, connections: [movement('older-b', 'in-b', 'out-b')]
        }, { createdAt: '2026-10-01T00:00:00Z' });
        const newer = solution('newer', {
            ...graph, connections: [movement('newer-b', 'in-b', 'out-a')]
        }, { createdAt: '2026-10-02T00:00:00Z' });

        const merged = mergeSavedJunctions(base, [older, newer], {
            ...mergeOptions, missingNodes: candidateGraph => candidateGraph.connections.length === 1
                ? new Set([J]) : new Set()
        });

        expect(merged.connections.filter(item => item.nodeId === J)).toEqual([
            base.connections.find(item => item.id === 'old-a'),
            expect.objectContaining({
                id: 'newer-b', fromLaneId: 'in-b', toLaneId: 'out-a', savedSolutionId: 'newer'
            })
        ]);
        expect(merged.savedPartialJunctions).toEqual([expect.objectContaining({
            nodeId: J, solutionId: 'newer', laneIds: ['in-b']
        })]);
    });

    it('lets a complete accepted node replace any partial answer collected earlier', () => {
        const { base, graph } = fixture();
        const partial = solution('newer-partial', {
            ...graph, connections: [movement('partial-b', 'in-b', 'out-b')]
        }, { createdAt: '2026-10-02T00:00:00Z' });
        const complete = solution('older-complete', graph, { createdAt: '2026-10-01T00:00:00Z' });

        const merged = mergeSavedJunctions(base, [complete, partial], {
            ...mergeOptions, missingNodes: candidateGraph => candidateGraph.connections.length === 1
                ? new Set([J]) : new Set()
        });

        expect(merged.connections.filter(item => item.nodeId === J)).toEqual([
            expect.objectContaining({ id: 'saved-a', savedSolutionId: 'older-complete' }),
            expect.objectContaining({ id: 'saved-b', savedSolutionId: 'older-complete' })
        ]);
        expect(merged.savedPartialJunctions).toEqual([]);
        expect(merged.savedJunctions).toEqual([expect.objectContaining({ nodeId: J, solutionId: 'older-complete' })]);
        expect(merged.problems).toEqual([{ type: 'warning', nodeIds: [J] }]);
    });

    it('rejects a saved graph when the current junction has an extra arm', () => {
        const { base, graph } = fixture({ extraBaseLane: true });
        const candidate = solution('old-topology', {
            ...graph, connections: [movement('saved-b', 'in-b', 'out-b')]
        });

        const merged = mergeSavedJunctions(base, [candidate], {
            ...mergeOptions, missingNodes: () => new Set([J])
        });

        expect(merged.connections).toEqual(base.connections);
        expect(merged.savedJunctions).toEqual([]);
        expect(merged.savedPartialJunctions).toEqual([]);
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

    it('fills stable public lanes when a saved both-direction centre incidence became two current centre incidences', () => {
        const { base, graph } = centreDirectionMismatchFixture();
        const candidate = solution('centre-direction-change', graph);
        const graphBefore = structuredClone(candidate.graph);
        const baseBefore = structuredClone(base);

        const merged = mergeSavedJunctions(base, [candidate], mergeOptions);

        expect(merged.connections.filter(item => item.nodeId === J)).toEqual([
            base.connections[0],
            expect.objectContaining({
                id: 'saved-b', fromLaneId: 'in-b', toLaneId: 'out-b',
                savedSolutionId: 'centre-direction-change', savedSource: 'claude'
            })
        ]);
        expect(merged.connections.some(item => item.fromLaneId.startsWith('centre-')
            || item.toLaneId.startsWith('centre-'))).toBe(false);
        expect(merged.savedJunctions).toEqual([]);
        expect(merged.savedPartialJunctions).toEqual([expect.objectContaining({
            nodeId: J, solutionId: 'centre-direction-change', laneIds: ['in-b']
        })]);
        expect(merged.problems).toEqual(base.problems);
        expect(candidate.graph).toEqual(graphBefore);
        expect(base).toEqual(baseBefore);
    });

    it('rejects a centre-direction partial match when the current public lane set has a new arm', () => {
        const { base, graph } = centreDirectionMismatchFixture({ extraPublicLane: true });
        const candidate = solution('centre-plus-new-arm', graph);
        const graphBefore = structuredClone(candidate.graph);

        const merged = mergeSavedJunctions(base, [candidate], mergeOptions);

        expect(merged.connections).toEqual(base.connections);
        expect(merged.savedJunctions).toEqual([]);
        expect(merged.savedPartialJunctions).toEqual([]);
        expect(candidate.graph).toEqual(graphBefore);
    });

    it('ignores saved movements that touch a centre lane with no public-lane match', () => {
        const { base, graph } = centreDirectionMismatchFixture({ centreMovement: false });
        graph.connections.push(movement('saved-to-centre', 'old-in-a', 'old-centre-both'));
        const candidate = solution('unmatched-centre-target', graph);

        const merged = mergeSavedJunctions(base, [candidate], mergeOptions);

        expect(merged.connections.filter(item => item.nodeId === J)).toEqual([
            base.connections[0],
            expect.objectContaining({ id: 'saved-b', fromLaneId: 'in-b', toLaneId: 'out-b' })
        ]);
        expect(merged.connections.some(item => item.toLaneId === 'centre-forward'
            || item.toLaneId === 'centre-backward')).toBe(false);
        expect(merged.savedPartialJunctions).toEqual([expect.objectContaining({
            nodeId: J, solutionId: 'unmatched-centre-target', laneIds: ['in-b']
        })]);
    });

    it('accepts only public, directed driving lanes for cars', () => {
        expect(publicCarLane({ type: 'driving', direction: 'forward', access: 'yes' })).toBe(true);
        expect(publicCarLane({ type: 'bus', direction: 'forward', access: 'yes' })).toBe(false);
        expect(publicCarLane({ type: 'driving', direction: 'both' })).toBe(false);
        expect(publicCarLane({ type: 'driving', direction: 'forward', access: 'private' })).toBe(false);
        expect(publicCarLane({ type: 'driving', direction: 'forward', centreLane: true })).toBe(false);
    });
});
