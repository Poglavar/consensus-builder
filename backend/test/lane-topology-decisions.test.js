// The decision queue turns an unresolved junction into a question and an answer back into
// movements. What matters is that a question is ANSWERABLE — the old manager could say a junction
// was unresolved and offer nowhere to say what the answer was — and that an answer cannot quietly
// assert something nobody chose.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LaneTopologyGraph = require('../../frontend/js/lane-topology-graph.js');
const Decisions = require('../../frontend/js/lane-topology-decisions.js');
const CorridorProfile = require('../../frontend/js/corridor-profile.js');
const OsmProfile = require('../../frontend/js/osm-profile.js');

const BUILD_OPTIONS = {
    generatedAt: '2026-08-12T00:00:00.000Z',
    profileFromTags: CorridorProfile.corridorProfileFromOsmTags,
    orientProfile: OsmProfile.orientForRightHandTraffic
};

const CENTRE = [15.98, 45.8];

function armAt(bearing, lengthM = 90) {
    const radians = bearing * Math.PI / 180;
    return [
        CENTRE[0] + Math.sin(radians) * lengthM / (111320 * Math.cos(CENTRE[1] * Math.PI / 180)),
        CENTRE[1] + Math.cos(radians) * lengthM / 110540
    ];
}

function way(id, coordinates, tags, nodes) {
    return {
        type: 'Feature',
        properties: { osm_id: id, tags, osm_node_ids: nodes },
        geometry: { type: 'LineString', coordinates }
    };
}

// Three lanes arriving from the west with no turn:lanes at all — the commonest open approach.
// Ilica continues east with two lanes, Frankopanska heads south with one.
function untaggedApproach(approachTags = {}) {
    return LaneTopologyGraph.build([
        way(1, [armAt(270), CENTRE], {
            highway: 'secondary', name: 'Ilica', oneway: 'yes', lanes: '3', ...approachTags
        }, [10, 100]),
        way(2, [CENTRE, armAt(90)], {
            highway: 'secondary', name: 'Ilica', oneway: 'yes', lanes: '2'
        }, [100, 20]),
        way(3, [CENTRE, armAt(180)], {
            highway: 'residential', name: 'Frankopanska', oneway: 'yes', lanes: '1'
        }, [100, 30])
    ], BUILD_OPTIONS);
}

describe('the decision queue', () => {
    it('states an open approach as a question with named arms, not a decline reason', () => {
        const [decision, ...rest] = Decisions.openDecisions(untaggedApproach());

        expect(rest).toHaveLength(0);
        expect(decision.kind).toBe('lane_exits');
        expect(decision.reason).toBe('multi_lane_approach_without_turn_lanes');
        expect(decision.prompt).toBe('Which way can each lane go?');
        expect(decision.approach.name).toBe('Ilica');
        expect(decision.approach.lanes.map(lane => lane.side))
            .toEqual(['leftmost', '2 from the left', 'rightmost']);
        // Every arm the approach could use, named the way a person would say it.
        expect(decision.exits.map(exit => exit.label))
            .toEqual(['Straight on into Ilica', 'Right into Frankopanska']);
    });

    it('keys a decision by node and arriving way, so an answer survives a rebuild', () => {
        const first = Decisions.openDecisions(untaggedApproach())[0];
        // A neighbouring edit changes section ids (they carry the node pair) but not this identity.
        const second = Decisions.openDecisions(untaggedApproach())[0];

        expect(first.id).toBe('decision:osm-node:100:way:1');
        expect(second.id).toBe(first.id);
        expect(first.sectionId).not.toBe(first.id);
    });

    it('drops a decision that has already been answered', () => {
        const answered = ['decision:osm-node:100:way:1'];

        expect(Decisions.openDecisions(untaggedApproach(), { answered })).toHaveLength(0);
    });

    describe('the suggested answer', () => {
        it('offers what turn:lanes already says rather than an empty form', () => {
            const graph = untaggedApproach({ 'turn:lanes': 'left|through|right' });
            // Tagged but still open: nothing arrives at the left, so the approach reaches an arm
            // it cannot use and the rules decline it.
            const decision = Decisions.openDecisions(graph)[0];
            const suggestion = Decisions.suggestAssignment(decision);
            const labelsFor = lane => (suggestion[lane.id] || [])
                .map(sectionId => decision.exits.find(exit => exit.sectionId === sectionId).label);

            expect(labelsFor(decision.approach.lanes[1])).toEqual(['Straight on into Ilica']);
            expect(labelsFor(decision.approach.lanes[2])).toEqual(['Right into Frankopanska']);
        });

        it('sends slight_left to the shallower of two left arms, not the sharper one', () => {
            // Lefts at -90° and -39°: the category alone cannot tell them apart, the token can.
            // Two lanes are tagged slight_left against Kneza Mislava's single lane, which is what
            // leaves the approach open — the rules settle this shape once the counts allow it.
            const graph = LaneTopologyGraph.build([
                way(1, [armAt(270), CENTRE], {
                    highway: 'secondary', name: 'Hatzova', oneway: 'yes', lanes: '3',
                    'turn:lanes': 'left|slight_left|slight_left'
                }, [10, 100]),
                way(2, [CENTRE, armAt(0)], {
                    highway: 'secondary', name: 'Draškovićeva', oneway: 'yes', lanes: '1'
                }, [100, 20]),
                way(3, [CENTRE, armAt(51)], {
                    highway: 'secondary', name: 'Kneza Mislava', oneway: 'yes', lanes: '1'
                }, [100, 30])
            ], BUILD_OPTIONS);
            const decision = Decisions.openDecisions(graph)[0];
            const suggestion = Decisions.suggestAssignment(decision);
            const labelFor = lane => decision.exits
                .find(exit => exit.sectionId === suggestion[lane.id][0]).label;

            expect(labelFor(decision.approach.lanes[0])).toBe('Left into Draškovićeva');
            expect(labelFor(decision.approach.lanes[1])).toBe('Left into Kneza Mislava');
            expect(labelFor(decision.approach.lanes[2])).toBe('Left into Kneza Mislava');
        });

        it('gives an untagged approach the ordinary shape of a marked one', () => {
            const decision = Decisions.openDecisions(untaggedApproach())[0];
            const suggestion = Decisions.suggestAssignment(decision);
            const labelsFor = lane => (suggestion[lane.id] || [])
                .map(sectionId => decision.exits.find(exit => exit.sectionId === sectionId).label);

            // Everyone straight on; only the rightmost lane also takes the right turn.
            expect(labelsFor(decision.approach.lanes[0])).toEqual(['Straight on into Ilica']);
            expect(labelsFor(decision.approach.lanes[2]))
                .toEqual(['Straight on into Ilica', 'Right into Frankopanska']);
        });
    });

    describe('validation', () => {
        it('refuses a lane with nowhere to go, because that would read as a dead end', () => {
            const decision = Decisions.openDecisions(untaggedApproach())[0];
            const assignment = Decisions.suggestAssignment(decision);
            assignment[decision.approach.lanes[1].id] = [];

            expect(Decisions.validate(decision, assignment))
                .toContain('Lane 2 (2 from the left) has nowhere to go.');
            expect(() => Decisions.movementsFor(decision, assignment, untaggedApproach())).toThrow(/nowhere to go/);
        });

        it('says out loud when an arm goes unused, without blocking the answer', () => {
            const graph = untaggedApproach();
            const decision = Decisions.openDecisions(graph)[0];
            const straightOn = decision.exits.find(exit => exit.category === 'through').sectionId;
            const assignment = Object.fromEntries(
                decision.approach.lanes.map(lane => [lane.id, [straightOn]])
            );

            expect(Decisions.validate(decision, assignment))
                .toEqual(['NOTE: nothing enters right into frankopanska.']);
            // A note is not a refusal: banning a turn is a legitimate answer.
            expect(Decisions.movementsFor(decision, assignment, graph).length).toBeGreaterThan(0);
        });

        it('refuses an obstacle no movement decision can fix', () => {
            const plaza = {
                sections: [], lanes: [], nodes: [{ id: 'osm-node:7', point: CENTRE, degree: 8, sectionIds: [] }],
                problems: [{
                    type: 'unresolved_intersection', nodeIds: ['osm-node:7'],
                    declineReason: 'arms_over_cap', openApproaches: []
                }]
            };
            const [decision] = Decisions.openDecisions(plaza);

            expect(decision.kind).toBe('unsupported');
            expect(decision.id).toBe('decision:osm-node:7:node');
            expect(Decisions.validate(decision, {}))
                .toEqual(['This obstacle is not something a movement decision can fix.']);
        });
    });

    describe('turning an answer into movements', () => {
        it('emits one movement per lane and arm chosen, in the deterministic shape', () => {
            const graph = untaggedApproach();
            const decision = Decisions.openDecisions(graph)[0];
            const movements = Decisions.movementsFor(decision, Decisions.suggestAssignment(decision), graph);

            expect(movements).toHaveLength(4); // three straight on, one right
            expect(movements.every(movement => movement.nodeId === 'osm-node:100')).toBe(true);
            expect(movements.every(movement => movement.source === 'manual')).toBe(true);
            const right = movements.find(movement => movement.type === 'turn');
            expect(right.priority).toBe('yielding');
            expect(right.reason).toContain('Right into Frankopanska');
            expect(right.reason).toContain('decided by hand');
        });

        it('marks a receiving lane it had to assume, so a review can find every one', () => {
            const graph = untaggedApproach();
            const decision = Decisions.openDecisions(graph)[0];
            // Three lanes into a two-lane continuation: the pairing is a choice, not a deduction.
            const straightOn = decision.exits.find(exit => exit.category === 'through').sectionId;
            const assignment = Object.fromEntries(
                decision.approach.lanes.map(lane => [lane.id, [straightOn]])
            );
            const movements = Decisions.movementsFor(decision, assignment, graph);

            expect(movements).toHaveLength(3);
            expect(movements.some(movement => movement.receivingLaneAssumed)).toBe(true);
            expect(movements.find(movement => movement.receivingLaneAssumed).reason)
                .toContain('paired in order rather than deduced');
        });

        it('deduces the receiving lane where the counts allow, and says nothing was assumed', () => {
            const graph = untaggedApproach();
            const decision = Decisions.openDecisions(graph)[0];
            const straightOn = decision.exits.find(exit => exit.category === 'through').sectionId;
            const right = decision.exits.find(exit => exit.category === 'right').sectionId;
            const [first, second, third] = decision.approach.lanes;
            // Two lanes into the two-lane continuation, one into the single-lane right arm.
            const movements = Decisions.movementsFor(decision, {
                [first.id]: [straightOn], [second.id]: [straightOn], [third.id]: [right]
            }, graph);

            expect(movements).toHaveLength(3);
            expect(movements.every(movement => !movement.receivingLaneAssumed)).toBe(true);
            const laneById = new Map(graph.lanes.map(lane => [lane.id, lane]));
            const pairs = movements
                .filter(movement => movement.type === 'continue')
                .map(movement => [laneById.get(movement.fromLaneId).ordinal,
                    laneById.get(movement.toLaneId).ordinal])
                .sort((a, b) => a[0] - b[0]);
            // In order, so no movement crosses another inside the junction.
            expect(pairs).toEqual([[0, 0], [1, 1]]);
        });

        it('produces movements the graph can carry beside the deterministic ones', () => {
            const graph = untaggedApproach();
            const decision = Decisions.openDecisions(graph)[0];
            const movements = Decisions.movementsFor(decision, Decisions.suggestAssignment(decision), graph);
            const laneIds = new Set(graph.lanes.map(lane => lane.id));

            movements.forEach(movement => {
                expect(laneIds.has(movement.fromLaneId)).toBe(true);
                expect(laneIds.has(movement.toLaneId)).toBe(true);
                expect(movement.geometry.coordinates).toHaveLength(2);
                expect(movement.id).toBe(`connection:osm-node:100:${movement.fromLaneId}->${movement.toLaneId}`);
            });
            // No movement duplicates another, and none is a lane connecting to itself.
            expect(new Set(movements.map(movement => movement.id)).size).toBe(movements.length);
            expect(movements.every(movement => movement.fromLaneId !== movement.toLaneId)).toBe(true);
        });
    });

    // Lane and section ids embed the pair of nodes the piece was cut between, so an edit to a
    // neighbouring way renames them. An answer stored against those ids would silently stop
    // matching, and the approach would reappear in the queue as though never answered.
    describe('storing an answer so it survives the graph being rebuilt', () => {
        // The same junction, with a side street newly joining the eastern arm partway along. That
        // splits the arm at the shared node, so its section and every lane on it is renamed —
        // exactly what an ordinary OSM edit next door does to a stored answer.
        function withSplitExit() {
            const midpoint = armAt(90, 45);
            return LaneTopologyGraph.build([
                way(1, [armAt(270), CENTRE], {
                    highway: 'secondary', name: 'Ilica', oneway: 'yes', lanes: '3'
                }, [10, 100]),
                way(2, [CENTRE, midpoint, armAt(90)], {
                    highway: 'secondary', name: 'Ilica', oneway: 'yes', lanes: '2'
                }, [100, 21, 20]),
                way(3, [CENTRE, armAt(180)], {
                    highway: 'residential', name: 'Frankopanska', oneway: 'yes', lanes: '1'
                }, [100, 30]),
                way(4, [midpoint, [midpoint[0], midpoint[1] - 0.0008]], {
                    highway: 'residential', name: 'Nova', lanes: '2',
                    'lanes:forward': '1', 'lanes:backward': '1'
                }, [21, 40])
            ], BUILD_OPTIONS);
        }

        it('reads back onto the renamed lanes and arms', () => {
            const before = untaggedApproach();
            const decisionBefore = Decisions.openDecisions(before)[0];
            const stored = Decisions.toStoredAssignment(
                decisionBefore, Decisions.suggestAssignment(decisionBefore)
            );
            // Nothing in the stored form may name a section or lane id.
            expect(JSON.stringify(stored)).not.toContain('section:');
            expect(JSON.stringify(stored)).not.toContain('lane:');

            const after = withSplitExit();
            // By id, not by position: the new side street opens a question of its own.
            const decisionAfter = Decisions.openDecisions(after)
                .find(decision => decision.id === decisionBefore.id);
            expect(decisionAfter).toBeTruthy();
            // The eastern arm was cut at a new node, so its section and its lanes are renamed.
            const easternBefore = decisionBefore.exits.find(exit => exit.wayId === '2');
            const easternAfter = decisionAfter.exits.find(exit => exit.wayId === '2');
            expect(easternAfter.sectionId).not.toBe(easternBefore.sectionId);
            expect(easternAfter.lanes.map(lane => lane.id))
                .not.toEqual(easternBefore.lanes.map(lane => lane.id));

            const { assignment, missing } = Decisions.fromStoredAssignment(decisionAfter, stored);
            expect(missing).toEqual([]);
            expect(Decisions.movementsFor(decisionAfter, assignment, after)).toHaveLength(4);
        });

        it('reports an arm that is no longer there rather than applying half an answer', () => {
            const graph = untaggedApproach();
            const decision = Decisions.openDecisions(graph)[0];
            const stored = Decisions.toStoredAssignment(decision, Decisions.suggestAssignment(decision));
            stored.lanes[2].exits.push({ wayId: '999', bearingDeg: 45 });

            const { missing } = Decisions.fromStoredAssignment(decision, stored);
            expect(missing).toEqual(['Lane 3 pointed at an arm that is no longer here.']);
        });

        it('tells two arms of the same way apart by bearing, not by way id alone', () => {
            // Ilica runs through the junction, so both the east and west arms carry way 2.
            const graph = LaneTopologyGraph.build([
                way(1, [armAt(180), CENTRE], {
                    highway: 'residential', name: 'Frankopanska', oneway: 'yes', lanes: '2'
                }, [30, 100]),
                way(2, [armAt(270), CENTRE, armAt(90)], {
                    highway: 'secondary', name: 'Ilica', lanes: '2',
                    'lanes:forward': '1', 'lanes:backward': '1'
                }, [10, 100, 20])
            ], BUILD_OPTIONS);
            const decision = Decisions.openDecisions(graph)[0];
            const eastAndWest = decision.exits.filter(exit => exit.wayId === '2');

            expect(eastAndWest).toHaveLength(2);
            // Same way, opposite sides: only the bearing separates them.
            expect(eastAndWest[0].category).not.toBe(eastAndWest[1].category);
            const chosen = eastAndWest[0];
            const stored = Decisions.toStoredAssignment(decision, {
                [decision.approach.lanes[0].id]: [chosen.sectionId],
                [decision.approach.lanes[1].id]: [chosen.sectionId]
            });
            const { assignment, missing } = Decisions.fromStoredAssignment(decision, stored);

            expect(missing).toEqual([]);
            expect(assignment[decision.approach.lanes[0].id]).toEqual([chosen.sectionId]);
        });
    });

    // Recording an answer is only half of it: until the derivation reads it back, the junction
    // keeps its warning, the movements do not exist for anything downstream, and the person who
    // answered has no way to tell their answer landed.
    describe('feeding answers back into the derived graph', () => {
        function storedAnswerFor(graph) {
            const decision = Decisions.openDecisions(graph)[0];
            return {
                decisionKey: decision.id,
                nodeKey: decision.nodeId,
                author: 'manual',
                assignment: Decisions.toStoredAssignment(decision, Decisions.suggestAssignment(decision))
            };
        }

        function build(decisions) {
            return LaneTopologyGraph.build([
                way(1, [armAt(270), CENTRE], {
                    highway: 'secondary', name: 'Ilica', oneway: 'yes', lanes: '3'
                }, [10, 100]),
                way(2, [CENTRE, armAt(90)], {
                    highway: 'secondary', name: 'Ilica', oneway: 'yes', lanes: '2'
                }, [100, 20]),
                way(3, [CENTRE, armAt(180)], {
                    highway: 'residential', name: 'Frankopanska', oneway: 'yes', lanes: '1'
                }, [100, 30])
            ], { ...BUILD_OPTIONS, decisions });
        }

        it('closes the junction and carries the movements', () => {
            const before = build();
            expect(before.problems.filter(problem => problem.type === 'unresolved_intersection'))
                .toHaveLength(1);
            expect(before.connections.filter(connection => connection.nodeId === 'osm-node:100'))
                .toHaveLength(0);

            const after = build([storedAnswerFor(before)]);

            expect(after.problems.filter(problem => problem.type === 'unresolved_intersection'))
                .toHaveLength(0);
            const movements = after.connections.filter(connection => connection.nodeId === 'osm-node:100');
            expect(movements).toHaveLength(4);
            expect(movements.every(connection => connection.source === 'manual')).toBe(true);
            expect(after.decisions.applied).toBe(1);
            expect(after.decisions.movements).toBe(4);
        });

        it('restates the counts, so the readout does not still say the junction is open', () => {
            const after = build([storedAnswerFor(build())]);

            expect(after.stats.resolvedIntersections).toBe(1);
            expect(after.stats.unresolvedIntersections).toBe(0);
            expect(after.stats.partialIntersections).toBe(0);
            expect(after.stats.connections).toBe(after.connections.length);
            expect(after.stats.decidedByHand).toBe(1);
        });

        it('counts a decided movement in the lane tallies', () => {
            const after = build([storedAnswerFor(build())]);
            const arriving = after.lanes.filter(lane => lane.toNode === 'osm-node:100'
                && String(lane.sourceWayId) === '1');

            // Every arriving lane now goes somewhere; before the answer, none of them did.
            expect(arriving).toHaveLength(3);
            expect(arriving.every(lane => lane.outgoingConnections > 0)).toBe(true);
        });

        it('hands back the answered approach so it can still be reviewed and corrected', () => {
            const after = build([storedAnswerFor(build())]);

            // It is no longer open, so nothing could re-derive the question from the problems.
            expect(after.decisions.answered).toHaveLength(1);
            expect(after.decisions.answered[0].approach.name).toBe('Ilica');
            expect(Object.keys(after.decisions.answered[0].assignment)).toHaveLength(3);
        });

        it('reports an answer it could not apply instead of dropping it in silence', () => {
            const stored = storedAnswerFor(build());
            stored.assignment.lanes[0].exits = [{ wayId: '404', bearingDeg: 0 }];
            const after = build([stored]);

            expect(after.decisions.applied).toBe(0);
            expect(after.decisions.stale).toHaveLength(1);
            expect(after.decisions.stale[0].reasons[0]).toContain('no longer here');
            // And the junction stays open, rather than being closed on an answer that did not fit.
            expect(after.problems.filter(problem => problem.type === 'unresolved_intersection'))
                .toHaveLength(1);
        });

        it('leaves the other approaches of a part-answered node open', () => {
            // Two multi-lane approaches into the same node: answering one must not close the other.
            const twoOpen = () => LaneTopologyGraph.build([
                way(1, [armAt(270), CENTRE], {
                    highway: 'secondary', name: 'Ilica west', oneway: 'yes', lanes: '3'
                }, [10, 100]),
                way(2, [armAt(90), CENTRE], {
                    highway: 'secondary', name: 'Ilica east', oneway: 'yes', lanes: '3'
                }, [20, 100]),
                way(3, [CENTRE, armAt(180)], {
                    highway: 'residential', name: 'Frankopanska', oneway: 'yes', lanes: '2'
                }, [100, 30]),
                way(4, [CENTRE, armAt(0)], {
                    highway: 'residential', name: 'Nova', oneway: 'yes', lanes: '2'
                }, [100, 40])
            ], BUILD_OPTIONS);

            const base = twoOpen();
            const open = Decisions.openDecisions(base);
            expect(open.length).toBeGreaterThan(1);
            const first = open[0];
            const answer = {
                decisionKey: first.id,
                nodeKey: first.nodeId,
                assignment: Decisions.toStoredAssignment(first, Decisions.suggestAssignment(first))
            };

            const after = LaneTopologyGraph.build([
                way(1, [armAt(270), CENTRE], {
                    highway: 'secondary', name: 'Ilica west', oneway: 'yes', lanes: '3'
                }, [10, 100]),
                way(2, [armAt(90), CENTRE], {
                    highway: 'secondary', name: 'Ilica east', oneway: 'yes', lanes: '3'
                }, [20, 100]),
                way(3, [CENTRE, armAt(180)], {
                    highway: 'residential', name: 'Frankopanska', oneway: 'yes', lanes: '2'
                }, [100, 30]),
                way(4, [CENTRE, armAt(0)], {
                    highway: 'residential', name: 'Nova', oneway: 'yes', lanes: '2'
                }, [100, 40])
            ], { ...BUILD_OPTIONS, decisions: [answer] });

            const problem = after.problems.find(entry => entry.type === 'unresolved_intersection');
            expect(problem).toBeTruthy();
            expect(problem.openApproaches.some(entry => entry.sectionId === first.sectionId)).toBe(false);
            expect(problem.openApproaches.length).toBe(open.length - 1);
            expect(problem.message).toContain('1 answered by hand');
            // Part-settled, not settled: there is still work at this node.
            expect(after.stats.partialIntersections).toBe(1);
            expect(after.stats.resolvedIntersections).toBe(0);
        });
    });

    // The question the card could not ask. One lane arriving, one arm leaving, three lanes on that
    // arm: the lane-to-arm question is already answered and the card looked empty, while the real
    // ambiguity had no control and Save wrote a guess — the LEFTMOST lane, for a right-side merge.
    describe('which lane of the arm a movement enters', () => {
        // Three lanes arriving, four leaving: the counts cannot balance, so a lane is left over and
        // the rules cannot say which. Exactly the residue the merge rule leaves behind.
        function unbalanced() {
            return LaneTopologyGraph.build([
                way(1, [armAt(270), CENTRE], {
                    highway: 'trunk', oneway: 'yes', lanes: '3'
                }, [10, 100]),
                way(2, [armAt(254), CENTRE], {
                    highway: 'motorway_link', oneway: 'yes', lanes: '1'
                }, [20, 100]),
                way(3, [CENTRE, armAt(90)], {
                    highway: 'trunk', oneway: 'yes', lanes: '5'
                }, [100, 30])
            ], BUILD_OPTIONS);
        }

        it('is offered only when nothing can deduce it', () => {
            const graph = unbalanced();
            const decision = Decisions.openDecisions(graph)
                .find(entry => entry.approach.highway === 'motorway_link');
            const assignment = Decisions.suggestAssignment(decision);
            const questions = Decisions.openReceivingChoices(decision, assignment, graph);

            expect(questions).toHaveLength(1);
            expect(questions[0].candidates.map(candidate => candidate.ordinal)).toEqual([0, 1, 2, 3, 4]);
            expect(questions[0].key).toBe('0->3');
        });

        it('is not offered where the counts already force it', () => {
            // A plain T: one lane in, one lane out on each arm. Nothing to choose.
            const graph = LaneTopologyGraph.build([
                way(1, [armAt(270), CENTRE], { highway: 'secondary', oneway: 'yes', lanes: '3' }, [10, 100]),
                way(2, [CENTRE, armAt(90)], { highway: 'secondary', oneway: 'yes', lanes: '3' }, [100, 20]),
                way(3, [CENTRE, armAt(180)], { highway: 'residential', oneway: 'yes', lanes: '1' }, [100, 30])
            ], BUILD_OPTIONS);
            const decision = Decisions.openDecisions(graph)[0];
            const straightOn = decision.exits.find(exit => exit.category === 'through').sectionId;
            const assignment = Object.fromEntries(
                decision.approach.lanes.map(lane => [lane.id, [straightOn]])
            );

            expect(Decisions.openReceivingChoices(decision, assignment, graph)).toHaveLength(0);
        });

        it('an explicit choice outranks the rule, and is not marked assumed', () => {
            const graph = unbalanced();
            const decision = Decisions.openDecisions(graph)
                .find(entry => entry.approach.highway === 'motorway_link');
            const assignment = Decisions.suggestAssignment(decision);
            const laneById = new Map(graph.lanes.map(lane => [lane.id, lane]));

            const [movement] = Decisions.movementsFor(decision, assignment, graph, {
                received: { '0->3': 1 }
            });
            expect(laneById.get(movement.toLaneId).ordinal).toBe(1);
            expect(movement.receivingLaneAssumed).toBe(false);
        });

        it('hugs the side the approach joins from when nobody chose', () => {
            const graph = unbalanced();
            const decision = Decisions.openDecisions(graph)
                .find(entry => entry.approach.highway === 'motorway_link');
            const laneById = new Map(graph.lanes.map(lane => [lane.id, lane]));

            const [movement] = Decisions.movementsFor(
                decision, Decisions.suggestAssignment(decision), graph
            );
            // The ramp turns right to line up, so it came from the right: the RIGHTMOST of five,
            // not lane 0 on the far side of the carriageway.
            expect(laneById.get(movement.toLaneId).ordinal).toBe(4);
            expect(movement.receivingLaneAssumed).toBe(true);
        });

        it('survives storage as ordinals, like the rest of the answer', () => {
            const graph = unbalanced();
            const decision = Decisions.openDecisions(graph)
                .find(entry => entry.approach.highway === 'motorway_link');
            const assignment = Decisions.suggestAssignment(decision);
            const stored = Decisions.toStoredAssignment(decision, assignment, { '0->3': 2 });

            expect(JSON.stringify(stored)).not.toContain('lane:');
            expect(stored.received).toEqual({ '0->3': 2 });
            const readBack = Decisions.fromStoredAssignment(decision, stored);
            expect(readBack.received).toEqual({ '0->3': 2 });

            const laneById = new Map(graph.lanes.map(lane => [lane.id, lane]));
            const [movement] = Decisions.movementsFor(decision, readBack.assignment, graph,
                { received: readBack.received });
            expect(laneById.get(movement.toLaneId).ordinal).toBe(2);
        });
    });

    describe('walking a distance along an arm', () => {
        // The label bug: an arm drawn as ONE long straight segment. Walking whole vertices puts the
        // point at the far end of it — arm B ended up several hundred metres off screen, so the
        // card offered a choice whose arm you could not see.
        it('interpolates inside a long segment instead of jumping to its end', () => {
            const line = [[15.98, 45.8], [15.98, 45.809]];   // ~1 km in one segment

            const point = Decisions.pointAlong(line, 35);

            const metres = (point[1] - 45.8) * 110540;
            expect(Math.abs(metres - 35)).toBeLessThan(1);
            expect(point[1]).toBeLessThan(45.809);
        });

        it('crosses vertices when the distance needs more than one segment', () => {
            const line = [[15.98, 45.8], [15.98, 45.80009], [15.98, 45.80045]];

            const point = Decisions.pointAlong(line, 30);

            expect(Math.abs((point[1] - 45.8) * 110540 - 30)).toBeLessThan(1);
        });

        it('stops at the end of a line shorter than the distance asked for', () => {
            const line = [[15.98, 45.8], [15.98, 45.8001]];

            expect(Decisions.pointAlong(line, 500)).toEqual([15.98, 45.8001]);
        });
    });

    describe('the Street View link', () => {
        function junction() {
            return LaneTopologyGraph.build([
                way(1, [armAt(180), CENTRE], {
                    highway: 'secondary', name: 'Ilica', oneway: 'yes', lanes: '3'
                }, [10, 100]),
                way(2, [CENTRE, armAt(0)], {
                    highway: 'secondary', name: 'Ilica', oneway: 'yes', lanes: '2'
                }, [100, 20]),
                way(3, [CENTRE, armAt(90)], {
                    highway: 'residential', name: 'Frankopanska', oneway: 'yes', lanes: '1'
                }, [100, 30])
            ], BUILD_OPTIONS);
        }

        it('stands back along the approach, not on the junction', () => {
            const graph = junction();
            const decision = Decisions.openDecisions(graph)[0];
            const straightOn = decision.exits.find(exit => exit.category === 'through');
            const viewpoint = Decisions.streetViewViewpoint(decision, straightOn, graph);

            // The approach runs north into the node at 45.8, so standing back is south of it.
            expect(viewpoint.lat).toBeLessThan(CENTRE[1]);
            const setback = (CENTRE[1] - viewpoint.lat) * 110540;
            expect(setback).toBeGreaterThan(5);
            expect(setback).toBeLessThan(12);
        });

        it('looks the way the movement goes, not the way the road runs', () => {
            const graph = junction();
            const decision = Decisions.openDecisions(graph)[0];
            const straightOn = decision.exits.find(exit => exit.category === 'through');
            const right = decision.exits.find(exit => exit.category === 'right');

            // Driving north: straight on is a heading near 0°, the right turn swings towards 90°.
            const ahead = Decisions.streetViewViewpoint(decision, straightOn, graph).heading;
            const across = Decisions.streetViewViewpoint(decision, right, graph).heading;
            expect(Math.min(ahead, 360 - ahead)).toBeLessThan(15);
            expect(across).toBeGreaterThan(30);
            expect(across).toBeLessThan(90);
        });

        it('builds a pano link Google understands', () => {
            const url = Decisions.streetViewUrl({ lat: 45.8, lng: 15.98, heading: 275 });

            expect(url).toContain('map_action=pano');
            expect(url).toContain('viewpoint=45.8,15.98');
            expect(url).toContain('heading=275');
        });

        it('says nothing rather than guessing when the geometry is missing', () => {
            const decision = { approach: { lanes: [{ id: 'nope' }] }, nodeId: 'osm-node:1' };

            expect(Decisions.streetViewViewpoint(decision, { lanes: [] }, { lanes: [] })).toBeNull();
            expect(Decisions.streetViewUrl(null)).toBeNull();
        });
    });

    it('puts answerable questions above ones nobody can answer', () => {
        const graph = untaggedApproach();
        const mixed = {
            ...graph,
            nodes: [...graph.nodes, { id: 'osm-node:900', point: CENTRE, degree: 9, sectionIds: [] }],
            problems: [
                ...graph.problems,
                {
                    type: 'unresolved_intersection', nodeIds: ['osm-node:900'],
                    declineReason: 'arms_over_cap', openApproaches: []
                }
            ]
        };
        const decisions = Decisions.openDecisions(mixed);

        // The plaza has nine arms and would outrank everything on size alone.
        expect(decisions[0].kind).toBe('lane_exits');
        expect(decisions.at(-1).kind).toBe('unsupported');
    });
});
