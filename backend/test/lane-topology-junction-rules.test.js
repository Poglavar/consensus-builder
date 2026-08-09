// The deterministic junction rules decide movements at junctions whose lane counts leave no
// choice. What matters is as much what they DECLINE as what they solve: a rule that resolves a
// multi-lane approach would silently ship a guess as a fact.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LaneTopologyGraph = require('../../frontend/js/lane-topology-graph.js');
const JunctionRules = require('../../frontend/js/lane-topology-junction-rules.js');
const CorridorProfile = require('../../frontend/js/corridor-profile.js');
const OsmProfile = require('../../frontend/js/osm-profile.js');

const BUILD_OPTIONS = {
    generatedAt: '2026-08-09T00:00:00.000Z',
    profileFromTags: CorridorProfile.corridorProfileFromOsmTags,
    orientProfile: OsmProfile.orientForRightHandTraffic
};

// About 100 m per 0.001° of latitude here, so these arms are long enough for the bearing baseline.
const CENTRE = [15.98, 45.8];
const WEST = [15.9787, 45.8];
const EAST = [15.9813, 45.8];
const SOUTH = [15.98, 45.799];
const NORTH = [15.98, 45.801];

function way(id, coordinates, tags, nodes) {
    return {
        type: 'Feature',
        properties: { osm_id: id, tags, osm_node_ids: nodes },
        geometry: { type: 'LineString', coordinates }
    };
}

const TWO_WAY = { highway: 'residential', lanes: '2', 'lanes:forward': '1', 'lanes:backward': '1' };

// A plain T: one lane each way on all three arms, meeting at node 100.
function tJunction(overrides = {}) {
    return [
        way(1, [[15.9787, 45.8], CENTRE], { ...TWO_WAY, name: 'Ilica', ...(overrides.west || {}) }, [10, 100]),
        way(2, [CENTRE, [15.9813, 45.8]], { ...TWO_WAY, name: 'Ilica', ...(overrides.east || {}) }, [100, 20]),
        way(3, [CENTRE, [15.98, 45.799]], { ...TWO_WAY, name: 'Frankopanska', ...(overrides.south || {}) }, [100, 30])
    ];
}

function junctionConnections(graph) {
    return graph.connections.filter(connection => connection.nodeId === 'osm-node:100');
}

function restriction(osmId, kind, fromWayId, toWayId, viaNodeId = 100) {
    return {
        osm_id: osmId,
        restriction: kind,
        members: [
            { role: 'from', type: 'way', ref: fromWayId },
            { role: 'via', type: 'node', ref: viaNodeId },
            { role: 'to', type: 'way', ref: toWayId }
        ]
    };
}

describe('deterministic junction rules', () => {
    it('solves a single-lane T instead of queueing it for recognition', () => {
        const graph = LaneTopologyGraph.build(tJunction(), BUILD_OPTIONS);

        expect(graph.problems.filter(problem => problem.type === 'unresolved_intersection')).toHaveLength(0);
        expect(graph.stats.resolvedIntersections).toBe(1);

        // Three arms, one lane in and one out each: every approach reaches the other two arms.
        const connections = junctionConnections(graph);
        expect(connections).toHaveLength(6);
        expect(connections.every(connection => connection.source === 'deterministic')).toBe(true);
        // No approach may turn back down the arm it arrived on.
        connections.forEach(connection => {
            const from = graph.lanes.find(lane => lane.id === connection.fromLaneId);
            const to = graph.lanes.find(lane => lane.id === connection.toLaneId);
            expect(from.sectionId).not.toBe(to.sectionId);
        });
    });

    it('labels the movements by their geometry, not by arm order', () => {
        const graph = LaneTopologyGraph.build(tJunction(), BUILD_OPTIONS);
        const byType = junctionConnections(graph).reduce((memo, connection) => {
            memo[connection.type] = (memo[connection.type] || 0) + 1;
            return memo;
        }, {});

        // Ilica runs through in both directions; the other four movements involve Frankopanska.
        expect(byType).toEqual({ continue: 2, turn: 4 });
        const left = junctionConnections(graph).filter(connection => connection.reason.startsWith('Left'));
        const right = junctionConnections(graph).filter(connection => connection.reason.startsWith('Right'));
        expect(left).toHaveLength(2);
        expect(right).toHaveLength(2);
        // A left turn is the movement an unmapped sign most often kills, so it must not claim the
        // confidence of a movement nothing can contradict.
        expect(Math.max(...left.map(connection => connection.confidence)))
            .toBeLessThan(Math.min(...right.map(connection => connection.confidence)));
    });

    it('declines a junction where an approach has two lanes', () => {
        const graph = LaneTopologyGraph.build(tJunction({
            west: { lanes: '3', 'lanes:forward': '2', 'lanes:backward': '1' }
        }), BUILD_OPTIONS);

        expect(junctionConnections(graph)).toHaveLength(0);
        expect(graph.stats.resolvedIntersections).toBe(0);
        expect(graph.problems.some(problem => problem.type === 'unresolved_intersection'
            && problem.nodeIds.includes('osm-node:100'))).toBe(true);
    });

    it('declines a junction with a two-way centre lane', () => {
        const graph = LaneTopologyGraph.build(tJunction({
            east: { lanes: '3', 'lanes:forward': '1', 'lanes:backward': '1', 'lanes:both_ways': '1' }
        }), BUILD_OPTIONS);

        expect(junctionConnections(graph)).toHaveLength(0);
        expect(graph.stats.resolvedIntersections).toBe(0);
    });

    it('never emits a movement an OSM restriction forbids', () => {
        const forbidden = LaneTopologyGraph.build(tJunction(), {
            ...BUILD_OPTIONS,
            restrictions: [restriction(900, 'no_left_turn', 1, 3)]
        });

        expect(junctionConnections(forbidden)).toHaveLength(5);
        // The graph must not merely avoid the movement — it must avoid it for THIS reason, so a
        // later refactor that drops restriction handling cannot pass by losing a different one.
        const surviving = junctionConnections(forbidden).map(connection => ({
            from: forbidden.lanes.find(lane => lane.id === connection.fromLaneId).sourceWayId,
            to: forbidden.lanes.find(lane => lane.id === connection.toLaneId).sourceWayId
        }));
        expect(surviving).not.toContainEqual({ from: '1', to: '3' });
        expect(surviving).toContainEqual({ from: '2', to: '3' });
    });

    it('keeps only the mandatory movement, and says the restriction decided it', () => {
        const graph = LaneTopologyGraph.build(tJunction(), {
            ...BUILD_OPTIONS,
            restrictions: [restriction(901, 'only_straight_on', 1, 2)]
        });

        const fromWest = junctionConnections(graph).filter(connection => (
            graph.lanes.find(lane => lane.id === connection.fromLaneId).sourceWayId === '1'
        ));
        expect(fromWest).toHaveLength(1);
        expect(fromWest[0].confidence).toBe(0.95);
        expect(fromWest[0].reason).toContain('only_straight_on');
        // The other two approaches keep both their movements: the restriction names only this one.
        expect(junctionConnections(graph)).toHaveLength(5);
    });

    it('narrows a single-lane approach to what turn:lanes permits', () => {
        const graph = LaneTopologyGraph.build(tJunction({
            west: { highway: 'residential', oneway: 'yes', lanes: '1', 'turn:lanes': 'right' }
        }), BUILD_OPTIONS);

        const fromWest = junctionConnections(graph).filter(connection => (
            graph.lanes.find(lane => lane.id === connection.fromLaneId).sourceWayId === '1'
        ));
        expect(fromWest).toHaveLength(1);
        expect(fromWest[0].type).toBe('turn');
        expect(fromWest[0].reason).toContain('turn:lanes names it');
    });

    it('declines rather than stranding an approach with nowhere to go', () => {
        // The tag says this approach may only go left, and there is no left arm at this T.
        const graph = LaneTopologyGraph.build(tJunction({
            west: { highway: 'residential', oneway: 'yes', lanes: '1', 'turn:lanes': 'left' }
        }), BUILD_OPTIONS);

        expect(junctionConnections(graph)).toHaveLength(0);
        expect(graph.stats.resolvedIntersections).toBe(0);
    });

    it('declines a node with more arms than a junction plausibly has', () => {
        const spokes = [];
        for (let index = 0; index < 7; index += 1) {
            const angle = (index / 7) * Math.PI * 2;
            spokes.push(way(index + 1, [
                CENTRE,
                [CENTRE[0] + Math.sin(angle) * 0.0013, CENTRE[1] + Math.cos(angle) * 0.0009]
            ], TWO_WAY, [100, 200 + index]));
        }
        const graph = LaneTopologyGraph.build(spokes, BUILD_OPTIONS);

        expect(junctionConnections(graph)).toHaveLength(0);
        expect(graph.stats.resolvedIntersections).toBe(0);
    });

    // Tier A2: a multi-lane approach is answerable when turn:lanes names every lane, because the
    // token says which movement each lane makes and lanes cannot cross inside the junction.
    describe('multi-lane approaches named by turn:lanes', () => {
        // West approach is one-way east with three lanes: left, through, through-or-right.
        // Ilica continues east with two lanes; Frankopanska heads south with one.
        function taggedApproach(turn, eastTags = {}) {
            return [
                way(1, [[15.9787, 45.8], CENTRE], {
                    highway: 'secondary', name: 'Ilica', oneway: 'yes', lanes: '3', 'turn:lanes': turn
                }, [10, 100]),
                way(2, [CENTRE, [15.9813, 45.8]], {
                    highway: 'secondary', name: 'Ilica', oneway: 'yes', lanes: '2', ...eastTags
                }, [100, 20]),
                way(3, [CENTRE, [15.98, 45.799]], {
                    highway: 'residential', name: 'Frankopanska', oneway: 'yes', lanes: '1'
                }, [100, 30])
            ];
        }

        it('assigns each tagged lane its own movement', () => {
            const graph = LaneTopologyGraph.build(taggedApproach('left|through|through;right'), BUILD_OPTIONS);
            const connections = junctionConnections(graph);

            expect(graph.stats.resolvedIntersections).toBe(1);
            // Two through lanes into the two-lane continuation, one right into Frankopanska.
            // The left token names a movement with no arm to make it, so it contributes nothing.
            expect(connections.filter(connection => connection.type === 'continue')).toHaveLength(2);
            expect(connections.filter(connection => connection.type === 'turn')).toHaveLength(1);
            expect(connections.every(connection => connection.reason.includes('turn:lanes names it'))).toBe(true);
        });

        it('pairs the through lanes in order, so no movement crosses another', () => {
            const graph = LaneTopologyGraph.build(taggedApproach('left|through|through;right'), BUILD_OPTIONS);
            const laneById = new Map(graph.lanes.map(lane => [lane.id, lane]));
            const through = junctionConnections(graph)
                .filter(connection => connection.type === 'continue')
                .map(connection => [
                    laneById.get(connection.fromLaneId).ordinal,
                    laneById.get(connection.toLaneId).ordinal
                ])
                .sort((a, b) => a[0] - b[0]);

            // Approach lanes 1 and 2 (0 is the left-turn lane) feed exit lanes 0 and 1 in order.
            expect(through).toEqual([[1, 0], [2, 1]]);
        });

        it('refuses when the number of turning lanes and receiving lanes disagree', () => {
            // Both remaining lanes go through, but the continuation has three lanes: which one is
            // left empty is a decision, not a deduction.
            const graph = LaneTopologyGraph.build(
                taggedApproach('left|through|through', { lanes: '3' }), BUILD_OPTIONS
            );

            expect(graph.stats.resolvedIntersections).toBe(0);
            expect(graph.problems.find(problem => problem.type === 'unresolved_intersection').declineReason)
                .toBe('receiving_lane_undetermined');
        });

        it('refuses a multi-lane approach with no turn:lanes at all', () => {
            const graph = LaneTopologyGraph.build([
                way(1, [[15.9787, 45.8], CENTRE], { highway: 'secondary', oneway: 'yes', lanes: '3' }, [10, 100]),
                way(2, [CENTRE, [15.9813, 45.8]], { highway: 'secondary', oneway: 'yes', lanes: '2' }, [100, 20]),
                way(3, [CENTRE, [15.98, 45.799]], { highway: 'residential', oneway: 'yes', lanes: '1' }, [100, 30])
            ], BUILD_OPTIONS);

            expect(graph.stats.resolvedIntersections).toBe(0);
            expect(graph.problems.find(problem => problem.type === 'unresolved_intersection').declineReason)
                .toBe('multi_lane_approach_without_turn_lanes');
        });

        it('never routes general traffic into a bus lane on the way out', () => {
            // The continuation is bus, driving, driving. Two through lanes have two lanes to enter,
            // and the bus lane is not one of them.
            const graph = LaneTopologyGraph.build(taggedApproach('left|through|through;right', {
                lanes: '3', 'access:lanes': 'no|yes|yes', 'psv:lanes': 'designated|no|no'
            }), BUILD_OPTIONS);
            const laneById = new Map(graph.lanes.map(lane => [lane.id, lane]));
            const entered = junctionConnections(graph).map(connection => laneById.get(connection.toLaneId));

            expect(graph.stats.resolvedIntersections).toBe(1);
            expect(entered.length).toBeGreaterThan(0);
            expect(entered.some(lane => lane.type === 'bus')).toBe(false);
        });

        it('refuses when a bus lane is on the approach, whose own movements nothing here can settle', () => {
            const graph = LaneTopologyGraph.build([
                way(1, [[15.9787, 45.8], CENTRE], {
                    highway: 'secondary', name: 'Ilica', oneway: 'yes', lanes: '2',
                    'turn:lanes': 'through|through', 'access:lanes': 'no|yes', 'psv:lanes': 'designated|no'
                }, [10, 100]),
                way(2, [CENTRE, [15.9813, 45.8]], {
                    highway: 'secondary', name: 'Ilica', oneway: 'yes', lanes: '2'
                }, [100, 20]),
                way(3, [CENTRE, [15.98, 45.799]], {
                    highway: 'residential', name: 'Frankopanska', oneway: 'yes', lanes: '1'
                }, [100, 30])
            ], BUILD_OPTIONS);

            expect(graph.stats.resolvedIntersections).toBe(0);
            expect(graph.problems.find(problem => problem.type === 'unresolved_intersection').declineReason)
                .toBe('restricted_lane_in_multi_lane_approach');
        });

        it('sends a lone turn into the lane on its own side and says so', () => {
            // One right-turn lane, and Frankopanska widened to two: it enters the rightmost, which
            // is the only one reachable without crossing the traffic already entering that arm.
            const graph = LaneTopologyGraph.build([
                way(1, [[15.9787, 45.8], CENTRE], {
                    highway: 'secondary', name: 'Ilica', oneway: 'yes', lanes: '2', 'turn:lanes': 'through|right'
                }, [10, 100]),
                way(2, [CENTRE, [15.9813, 45.8]], {
                    highway: 'secondary', name: 'Ilica', oneway: 'yes', lanes: '1'
                }, [100, 20]),
                way(3, [CENTRE, [15.98, 45.799]], {
                    highway: 'residential', name: 'Frankopanska', oneway: 'yes', lanes: '2'
                }, [100, 30])
            ], BUILD_OPTIONS);
            const laneById = new Map(graph.lanes.map(lane => [lane.id, lane]));
            const right = junctionConnections(graph).find(connection => connection.type === 'turn');

            expect(graph.stats.resolvedIntersections).toBe(1);
            // Frankopanska's lanes are ordinal 0 (left) and 1 (right); the turn takes the right one.
            expect(laneById.get(right.toLaneId).ordinal).toBe(1);
            expect(right.reason).toContain('rightmost lane');
            // A road-code rule is a weaker basis than a count, and the confidence has to show it.
            expect(right.confidence).toBeLessThan(0.9);
        });
    });

    it('classifies a turn from the heading of the arms', () => {
        const arriving = JunctionRules.bearingDegrees(WEST, CENTRE);
        const north = JunctionRules.bearingDegrees(CENTRE, NORTH);
        const south = JunctionRules.bearingDegrees(CENTRE, SOUTH);
        const east = JunctionRules.bearingDegrees(CENTRE, EAST);

        expect(JunctionRules.classifyTurn(JunctionRules.relativeTurnDegrees(arriving, east))).toBe('through');
        expect(JunctionRules.classifyTurn(JunctionRules.relativeTurnDegrees(arriving, north))).toBe('left');
        expect(JunctionRules.classifyTurn(JunctionRules.relativeTurnDegrees(arriving, south))).toBe('right');
        expect(JunctionRules.classifyTurn(JunctionRules.relativeTurnDegrees(arriving, arriving + 180))).toBe('reverse');
    });

    it('measures a heading across the baseline, not across the last vertex pair', () => {
        // A dense final segment pointing the wrong way must not decide the arm's direction.
        const coordinates = [[15.98, 45.8], [15.9815, 45.8], [15.98151, 45.800005]];
        const heading = JunctionRules.headingAtNode(coordinates, false);

        expect(Math.abs(heading - 90)).toBeLessThan(1);
    });

    it('reports a junction as resolved so a run never queues it', () => {
        const LaneTopologyJunctions = require('../../frontend/js/lane-topology-junctions.js');
        const solved = LaneTopologyJunctions.deriveJunctions(LaneTopologyGraph.build(tJunction(), BUILD_OPTIONS));
        const hard = LaneTopologyJunctions.deriveJunctions(LaneTopologyGraph.build(tJunction({
            west: { lanes: '3', 'lanes:forward': '2', 'lanes:backward': '1' }
        }), BUILD_OPTIONS));

        expect(solved.junctions).toHaveLength(1);
        expect(solved.junctions[0].resolved).toBe(true);
        expect(solved.stats.unresolved).toBe(0);
        expect(hard.junctions[0].resolved).toBe(false);
        expect(hard.junctions[0].unresolvedNodeIds).toEqual(['osm-node:100']);
        expect(hard.stats.unresolved).toBe(1);
    });
});
