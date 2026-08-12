// Turns what the deterministic rules could NOT settle into questions a person can answer, and turns
// their answers back into movements.
//
// The manager could already say a junction was unresolved; it could not say what it was unresolved
// ABOUT. A marker reading `receiving_lane_undetermined` over a JSON dump is a diagnosis, not a
// question, and there was nowhere to put an answer even once you knew one. This module is the
// missing middle: `openDecisions` states each open approach as "these lanes arrive, those arms
// leave, which lane may use which arm", and `movementsFor` turns a filled-in answer into exactly
// the connection records the rules would have emitted had they been able to decide.
//
// The unit is an APPROACH — one arm arriving at one node — because that is the unit the rules
// already open and close. A node with four arms can be three-quarters answered, and asking about
// the whole node would either re-ask the settled parts or lose them.
//
// Everything here is pure: graph in, plain objects out. No DOM, no map, no fetch.
(function (root, factory) {
    const api = factory(root || {});
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.LaneTopologyDecisions = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    let rulesApi = null;
    function rules() {
        if (rulesApi) return rulesApi;
        rulesApi = (root && root.LaneTopologyJunctionRules)
            || (typeof require === 'function' ? require('./lane-topology-junction-rules.js') : null);
        if (!rulesApi) {
            throw new Error('LaneTopologyDecisions needs lane-topology-junction-rules.js to label arms.');
        }
        return rulesApi;
    }

    // What each decline reason actually asks of a person. A reason with no question here is one a
    // human cannot fix by choosing — bad geometry, a node that is not a junction — and it must not
    // reach the queue pretending to be answerable.
    const QUESTIONS = {
        multi_lane_approach_without_turn_lanes: {
            kind: 'lane_exits',
            prompt: 'Which way can each lane go?',
            why: 'This approach has more than one lane and OSM does not say what any of them are for.'
        },
        receiving_lane_undetermined: {
            kind: 'lane_exits',
            prompt: 'Which way can each lane go?',
            why: 'More lanes want an arm than it has lanes to receive them, so which lane feeds which is a choice.'
        },
        ambiguous_arm_for_turn: {
            kind: 'lane_exits',
            prompt: 'Which way can each lane go?',
            why: 'Two arms leave on the same side and the lane markings name a turn without saying which of them it means.'
        },
        restricted_lane_in_multi_lane_approach: {
            kind: 'lane_exits',
            prompt: 'Which way can each lane go?',
            why: 'One of these lanes is a bus or restricted lane, whose movements the counts cannot settle.'
        },
        approach_reaches_nothing: {
            kind: 'lane_exits',
            prompt: 'Which way can each lane go?',
            why: 'The lane tags and the turn restrictions here contradict each other, so nothing was emitted.'
        },
        two_way_centre_lane: {
            kind: 'unsupported',
            prompt: 'Centre-lane junction',
            why: 'A two-way centre lane belongs to neither approach; who may turn from it needs the lane model, not a movement.'
        },
        arms_over_cap: {
            kind: 'unsupported',
            prompt: 'Too many arms to treat as one junction',
            why: 'This is a plaza or a cluster OSM drew as one node; it needs splitting upstream, not a movement decision.'
        },
        degenerate_arm_heading: {
            kind: 'unsupported',
            prompt: 'An arm too short to have a direction',
            why: 'One arm is shorter than the bearing baseline, so no angle here can be trusted.'
        },
        no_incoming_or_no_outgoing: {
            kind: 'unsupported',
            prompt: 'Nothing arrives, or nothing leaves',
            why: 'Every arm runs the same way; this is a one-way tagging fault upstream.'
        }
    };

    const UNKNOWN_QUESTION = {
        kind: 'unsupported',
        prompt: 'Unrecognised obstacle',
        why: 'The rules declined for a reason this queue has no question for.'
    };

    function questionFor(reason) {
        return QUESTIONS[reason] || UNKNOWN_QUESTION;
    }

    function laneSide(ordinal, count) {
        if (count === 1) return 'the only lane';
        if (ordinal === 0) return 'leftmost';
        if (ordinal === count - 1) return 'rightmost';
        return `${ordinal + 1} from the left`;
    }

    // "Left into Ilica" / "Straight on into Jadranska avenija" / "Right into an unnamed service road".
    function exitLabel(exit) {
        const word = rules().movementWord(exit.category);
        if (exit.name) return `${word} into ${exit.name}`;
        const kind = String(exit.highway || 'road').replaceAll('_', ' ');
        return `${word} into an unnamed ${kind}`;
    }

    function indexGraph(graph) {
        const sectionsById = new Map((graph.sections || []).map(section => [section.id, section]));
        const lanesBySection = new Map();
        (graph.lanes || []).forEach(lane => {
            if (!lanesBySection.has(lane.sectionId)) lanesBySection.set(lane.sectionId, []);
            lanesBySection.get(lane.sectionId).push(lane);
        });
        const nodesById = new Map((graph.nodes || []).map(node => [node.id, node]));
        return { sectionsById, lanesBySection, nodesById };
    }

    function orderedLanes(lanes) {
        return lanes.slice().sort((a, b) => (a.ordinal || 0) - (b.ordinal || 0));
    }

    // The arms this approach could reach, labelled exactly as the rules label them — including the
    // fork demotion, so a slip road reads as the turn it is rather than a second straight on.
    function exitsFor(node, fromSectionId, index) {
        const { sectionsById, lanesBySection } = index;
        const approachLanes = orderedLanes(
            (lanesBySection.get(fromSectionId) || []).filter(lane => lane.toNode === node.id)
        );
        if (!approachLanes.length) return null;
        const arriving = rules().headingAtNode(approachLanes[0].geometry.coordinates, true);
        if (arriving === null) return null;

        const reachable = [];
        [...new Set(node.sectionIds || [])].forEach(sectionId => {
            if (sectionId === fromSectionId) return;
            const leaving = orderedLanes(
                (lanesBySection.get(sectionId) || []).filter(lane => lane.fromNode === node.id)
            );
            if (!leaving.length) return;
            const departing = rules().headingAtNode(leaving[0].geometry.coordinates, false);
            if (departing === null) return;
            const relative = rules().relativeTurnDegrees(arriving, departing);
            if (rules().classifyTurn(relative) === 'reverse') return;
            reachable.push({ toSectionId: sectionId, exit: leaving, relative });
        });

        return rules().assignCategories(reachable).map(candidate => {
            const section = sectionsById.get(candidate.toSectionId) || {};
            const exit = {
                sectionId: candidate.toSectionId,
                wayId: section.sourceWayId == null ? null : String(section.sourceWayId),
                name: section.name || null,
                highway: section.highway || null,
                category: candidate.category,
                forked: !!candidate.forked,
                relativeDeg: Math.round(candidate.relative * 10) / 10,
                lanes: candidate.exit.map(lane => ({
                    id: lane.id,
                    ordinal: lane.ordinal,
                    type: lane.type,
                    access: lane.access,
                    side: laneSide(lane.ordinal, candidate.exit.length)
                }))
            };
            exit.label = exitLabel(exit);
            return exit;
        }).sort((a, b) => a.relativeDeg - b.relativeDeg);
    }

    // A stable identity for the question, so an answer keeps pointing at the same approach across
    // rebuilds. Node plus arriving way: the section id carries the node ids of the piece it was cut
    // into, which change whenever a neighbouring way is edited.
    function decisionId(nodeId, wayId) {
        return `decision:${nodeId}:way:${wayId}`;
    }

    // How much is riding on the answer: an approach with five lanes and three arms is a bigger
    // decision than a two-lane one, and it is also the one worth a person's attention first.
    function weightOf(laneCount, exitCount) {
        return laneCount * Math.max(1, exitCount);
    }

    function approachDecision(node, entry, index, answered) {
        const section = index.sectionsById.get(entry.sectionId);
        if (!section) return null;
        const wayId = String(section.sourceWayId);
        const id = decisionId(node.id, wayId);
        if (answered.has(id)) return null;
        const approachLanes = orderedLanes(
            (index.lanesBySection.get(entry.sectionId) || []).filter(lane => lane.toNode === node.id)
        );
        if (!approachLanes.length) return null;
        const exits = exitsFor(node, entry.sectionId, index) || [];
        const question = questionFor(entry.reason);
        return {
            id,
            nodeId: node.id,
            sectionId: entry.sectionId,
            fromWayId: wayId,
            point: node.point,
            arms: node.degree,
            reason: entry.reason,
            kind: question.kind,
            prompt: question.prompt,
            why: question.why,
            approach: {
                name: section.name || null,
                highway: section.highway || null,
                lanes: approachLanes.map(lane => ({
                    id: lane.id,
                    ordinal: lane.ordinal,
                    direction: lane.direction,
                    type: lane.type,
                    access: lane.access,
                    turn: lane.turn || null,
                    side: laneSide(lane.ordinal, approachLanes.length)
                }))
            },
            exits,
            laneCount: approachLanes.length,
            exitCount: exits.length,
            weight: weightOf(approachLanes.length, exits.length)
        };
    }

    // A node nothing can be asked about, stated once. The alternative — one dead entry per arm —
    // put a five-arm plaza at the top of the queue as five questions with no answer between them.
    function blockedNode(node, reason, index, answered) {
        // Not decisionId(): this is the node itself, not one of its arriving ways.
        const id = `decision:${node.id}:node`;
        if (answered.has(id)) return null;
        const question = questionFor(reason);
        const names = [...new Set([...new Set(node.sectionIds || [])]
            .map(sectionId => index.sectionsById.get(sectionId)?.name)
            .filter(Boolean))];
        return {
            id,
            nodeId: node.id,
            sectionId: null,
            fromWayId: null,
            point: node.point,
            arms: node.degree,
            reason,
            kind: question.kind,
            prompt: question.prompt,
            why: question.why,
            approach: { name: names.join(' / ') || null, highway: null, lanes: [] },
            exits: [],
            laneCount: 0,
            exitCount: 0,
            weight: 0
        };
    }

    // Every open approach in the graph as an answerable question, the ones a person can actually
    // settle first and the heaviest of those at the top.
    //
    // `problem.openApproaches` names the approaches a partially-settled node still has open. A node
    // the rules declined OUTRIGHT has no such list: if the obstacle is per-approach the whole node
    // is asked arm by arm, and if it is a property of the node itself it is asked once.
    function openDecisions(graph, options = {}) {
        if (!graph) return [];
        const index = indexGraph(graph);
        const answered = new Set(options.answered || []);
        const decisions = [];

        (graph.problems || [])
            .filter(problem => problem.type === 'unresolved_intersection')
            .forEach(problem => {
                const nodeId = (problem.nodeIds || [])[0];
                const node = index.nodesById.get(nodeId);
                if (!node) return;
                const open = problem.openApproaches || [];
                if (!open.length && questionFor(problem.declineReason).kind === 'unsupported') {
                    const blocked = blockedNode(node, problem.declineReason, index, answered);
                    if (blocked) decisions.push(blocked);
                    return;
                }
                const entries = open.length
                    ? open.map(entry => ({ ...entry, reason: entry.reason || problem.declineReason }))
                    : [...new Set(node.sectionIds || [])]
                        .filter(sectionId => (index.lanesBySection.get(sectionId) || [])
                            .some(lane => lane.toNode === nodeId))
                        .map(sectionId => ({ sectionId, reason: problem.declineReason }));
                entries.forEach(entry => {
                    const decision = approachDecision(node, entry, index, answered);
                    if (decision) decisions.push(decision);
                });
            });

        // Answerable first: a queue whose top item is a plaza nobody can resolve is the dead end
        // this whole module exists to remove.
        const rank = decision => (decision.kind === 'lane_exits' ? 0 : 1);
        return decisions.sort((a, b) => rank(a) - rank(b)
            || b.weight - a.weight
            || a.id.localeCompare(b.id, undefined, { numeric: true }));
    }

    const CANONICAL_ANGLE = { left: -90, through: 0, right: 90 };

    // The angle each turn:lanes token is aiming at. The rules collapse all of these to left /
    // through / right, which is right for deciding whether a movement EXISTS but throws away what
    // distinguishes two arms on the same side: at a five-arm junction with lefts at -92° and -39°,
    // a lane tagged `slight_left` means the second one, and a category alone picks the first.
    const TOKEN_ANGLE = {
        sharp_left: -135, left: -90, slight_left: -45,
        merge_to_left: 0, through: 0, none: 0, '': 0, merge_to_right: 0,
        slight_right: 45, right: 90, sharp_right: 135
    };

    function tokensOf(lane) {
        return String(lane.turn || '').split(';').map(token => token.trim().toLowerCase()).filter(Boolean);
    }

    // Where two arms share a category and no token distinguishes them, the nearer to the category's
    // canonical angle is offered and the person can retarget it.
    function nearestInCategory(exits, category, target) {
        const inCategory = exits.filter(exit => exit.category === category);
        if (!inCategory.length) return null;
        const aim = Number.isFinite(target) ? target : CANONICAL_ANGLE[category];
        return inCategory.reduce((best, exit) =>
            Math.abs(exit.relativeDeg - aim) < Math.abs(best.relativeDeg - aim) ? exit : best);
    }

    // The arm a single turn:lanes token points at, using the rules' own token vocabulary so a token
    // this module does not understand is skipped rather than guessed at.
    function exitForToken(exits, token) {
        const categories = rules().turnCategoriesOf({ turn: token });
        if (!categories) return null;
        const category = [...categories][0];
        if (category === 'reverse') return null;
        return nearestInCategory(exits, category, TOKEN_ANGLE[token]);
    }

    // A starting point to edit rather than a blank form.
    //
    // A lane that already carries a turn tag is offered what its tag says: most open approaches are
    // open because of the RECEIVING side, not because nobody knows where the lane goes, and asking
    // someone to re-enter what OSM already states is how a queue of 345 stops being worth starting.
    // Untagged lanes fall back to the ordinary shape of a marked approach — everyone straight on,
    // the outer lanes also taking the turn on their own side.
    //
    // A suggestion is never saved on its own: `movementsFor` is only ever called with what the
    // person actually confirmed.
    function suggestAssignment(decision) {
        const assignment = {};
        const lanes = decision.approach.lanes;
        const straight = nearestInCategory(decision.exits, 'through');
        const left = nearestInCategory(decision.exits, 'left');
        const right = nearestInCategory(decision.exits, 'right');
        lanes.forEach((lane, index) => {
            const tagged = rules().turnCategoriesOf(lane);
            const picks = [];
            if (tagged) {
                tokensOf(lane).forEach(token => {
                    const exit = exitForToken(decision.exits, token);
                    if (exit && !picks.includes(exit.sectionId)) picks.push(exit.sectionId);
                });
            }
            if (!picks.length && !tagged) {
                if (index === 0 && left) picks.push(left.sectionId);
                if (straight) picks.push(straight.sectionId);
                if (index === lanes.length - 1 && right) picks.push(right.sectionId);
            }
            // A lane whose tag names a movement no arm here offers still has to go somewhere.
            if (!picks.length && decision.exits.length) {
                picks.push((straight || decision.exits[0]).sectionId);
            }
            assignment[lane.id] = picks;
        });
        return assignment;
    }

    // How far an arm may have swung and still be recognised as the arm that was answered about.
    // Wide enough to absorb a re-survey nudging the geometry, narrow enough that two arms on the
    // same side of a junction can never be confused for one another.
    const EXIT_MATCH_TOLERANCE_DEG = 15;

    // The durable form of an answer.
    //
    // Lane ids and section ids both embed the pair of nodes the piece was cut between, so editing
    // ANY neighbouring way renames them, and an answer stored against them silently stops matching
    // the junction it was given for. Nothing then reports a problem: the approach simply reappears
    // in the queue as though it had never been answered. Ordinals, OSM way ids and bearings survive
    // that, so those are what goes to the database.
    //
    // A way id alone is not enough either: a two-way street through the junction leaves it in both
    // directions on the same way, so the bearing is what tells the two apart.
    function toStoredAssignment(decision, assignment, received) {
        const exitById = new Map(decision.exits.map(exit => [exit.sectionId, exit]));
        const stored = {
            lanes: decision.approach.lanes.map(lane => ({
                ordinal: lane.ordinal,
                direction: lane.direction || null,
                exits: (assignment?.[lane.id] || [])
                    .map(sectionId => exitById.get(sectionId))
                    .filter(Boolean)
                    .map(exit => ({ wayId: exit.wayId, bearingDeg: Math.round(exit.relativeDeg) }))
            }))
        };
        // Which lane of the arm each movement enters, when somebody said. Ordinals both sides, for
        // the same reason the arms are way ids: a lane id does not survive an edit next door.
        const entries = Object.entries(received || {}).filter(([, ordinal]) => Number.isInteger(ordinal));
        if (entries.length) stored.received = Object.fromEntries(entries);
        return stored;
    }

    function matchExit(exits, stored) {
        const sameWay = exits.filter(exit => exit.wayId === stored.wayId);
        if (!sameWay.length) return null;
        if (sameWay.length === 1) return sameWay[0];
        const nearest = sameWay.reduce((best, exit) =>
            Math.abs(exit.relativeDeg - stored.bearingDeg) < Math.abs(best.relativeDeg - stored.bearingDeg)
                ? exit : best);
        return Math.abs(nearest.relativeDeg - stored.bearingDeg) <= EXIT_MATCH_TOLERANCE_DEG ? nearest : null;
    }

    // A stored answer read back against today's graph. `missing` names what no longer matches, so a
    // junction whose arms have changed under a stored answer is re-asked rather than half-applied.
    function fromStoredAssignment(decision, stored) {
        const assignment = {};
        const missing = [];
        const received = { ...(stored?.received || {}) };
        const byOrdinal = new Map((stored?.lanes || []).map(lane => [lane.ordinal, lane.exits || []]));
        decision.approach.lanes.forEach(lane => {
            const wanted = byOrdinal.get(lane.ordinal);
            if (!wanted) {
                missing.push(`Lane ${lane.ordinal + 1} was not part of the stored answer.`);
                assignment[lane.id] = [];
                return;
            }
            assignment[lane.id] = wanted.map(entry => {
                const exit = matchExit(decision.exits, entry);
                if (!exit) missing.push(`Lane ${lane.ordinal + 1} pointed at an arm that is no longer here.`);
                return exit?.sectionId;
            }).filter(Boolean);
        });
        return { assignment, missing, received };
    }

    // Reasons an answer cannot be saved. Empty means it can.
    //
    // A lane with no arm is the one that must be caught: in this model a missing movement reads as
    // "forbidden", so saving a half-filled form would silently assert that a lane is a dead end.
    function validate(decision, assignment) {
        const problems = [];
        if (!decision || decision.kind !== 'lane_exits') {
            return ['This obstacle is not something a movement decision can fix.'];
        }
        const exitIds = new Set(decision.exits.map(exit => exit.sectionId));
        decision.approach.lanes.forEach(lane => {
            const picks = assignment?.[lane.id];
            if (!Array.isArray(picks) || !picks.length) {
                problems.push(`Lane ${lane.ordinal + 1} (${lane.side}) has nowhere to go.`);
                return;
            }
            picks.forEach(pick => {
                if (!exitIds.has(pick)) problems.push(`Lane ${lane.ordinal + 1} points at an arm that is not here.`);
            });
        });
        const used = new Set(Object.values(assignment || {}).flat());
        decision.exits.forEach(exit => {
            if (!used.has(exit.sectionId)) {
                // Not fatal: an arm no lane may enter is a legitimate answer at a junction with a
                // banned turn. Said out loud so it is a choice rather than an oversight.
                problems.push(`NOTE: nothing enters ${exit.label.toLowerCase()}.`);
            }
        });
        return problems;
    }

    function fatal(problems) {
        return problems.filter(problem => !problem.startsWith('NOTE:'));
    }

    function laneEndpoint(lane, atEnd) {
        const coordinates = lane?.geometry?.coordinates || [];
        return coordinates[atEnd ? coordinates.length - 1 : 0] || null;
    }

    // Where to stand, and which way to look, to see a movement in Street View.
    //
    // A few metres BACK along the approach, facing the arm being decided — the driver's view of the
    // decision, which is the only view in which the painted arrows are legible. Standing on the
    // junction itself looks across it rather than at the markings that answer the question.
    const STREET_VIEW_SETBACK_M = 8;
    const STREET_VIEW_AIM_M = 25;

    function metresBetween(a, b) {
        const meanLat = (a[1] + b[1]) * Math.PI / 360;
        return Math.hypot((b[0] - a[0]) * 111320 * Math.cos(meanLat), (b[1] - a[1]) * 110540);
    }

    // A point `metres` along a polyline from its first vertex, interpolated inside the segment it
    // lands in. Walking whole vertices instead puts the point at the far end of a long straight —
    // which is exactly how an arm label ended up several hundred metres off screen.
    function pointAlong(coordinates, metres) {
        const points = coordinates || [];
        if (points.length < 2) return points[0] || null;
        let travelled = 0;
        for (let index = 1; index < points.length; index += 1) {
            const from = points[index - 1];
            const to = points[index];
            const span = metresBetween(from, to);
            if (span <= 0) continue;
            if (travelled + span >= metres) {
                const ratio = (metres - travelled) / span;
                return [from[0] + (to[0] - from[0]) * ratio, from[1] + (to[1] - from[1]) * ratio];
            }
            travelled += span;
        }
        return points[points.length - 1];
    }

    // { lat, lng, heading } for a Street View pano showing this movement, or null when the graph
    // does not carry enough geometry to place one.
    function streetViewViewpoint(decision, exit, graph) {
        const lanesById = new Map((graph?.lanes || []).map(lane => [lane.id, lane]));
        const approachLane = lanesById.get(decision?.approach?.lanes?.[0]?.id);
        const exitLane = lanesById.get(exit?.lanes?.[0]?.id);
        if (!approachLane || !exitLane) return null;
        // Reversed: the approach runs INTO the node, so walking back from the node means walking
        // forward along the reversed line.
        const back = [...approachLane.geometry.coordinates].reverse();
        const stand = pointAlong(back, STREET_VIEW_SETBACK_M);
        const aim = pointAlong(exitLane.geometry.coordinates, STREET_VIEW_AIM_M);
        if (!stand || !aim) return null;
        return {
            lat: Number(stand[1].toFixed(7)),
            lng: Number(stand[0].toFixed(7)),
            heading: Math.round(rules().bearingDegrees(stand, aim))
        };
    }

    // Google's documented Street View deep link. `viewpoint` snaps to the nearest pano, so a point
    // a few metres off the carriageway still lands on the road.
    function streetViewUrl(viewpoint) {
        if (!viewpoint) return null;
        return 'https://www.google.com/maps/@?api=1&map_action=pano'
            + `&viewpoint=${viewpoint.lat},${viewpoint.lng}`
            + `&heading=${viewpoint.heading}&pitch=0&fov=80`;
    }

    // The movements whose receiving lane nothing can deduce — the arm has spare lanes and no rule
    // says which. These are the ones worth putting to a person: everything else is already forced.
    //
    // Returned as questions rather than left to the fallback, because the fallback is a guess. It
    // is a better guess than it was (it hugs the side the approach joins from) but a one-lane ramp
    // meeting a three-lane trunk still has three possible answers and only one right one.
    function openReceivingChoices(decision, assignment, graph) {
        const index = indexGraph(graph);
        const lanesById = new Map((graph.lanes || []).map(lane => [lane.id, lane]));
        const questions = [];
        decision.exits.forEach(exit => {
            const turning = decision.approach.lanes
                .filter(lane => (assignment?.[lane.id] || []).includes(exit.sectionId))
                .map(lane => lanesById.get(lane.id))
                .filter(Boolean)
                .sort((a, b) => (a.ordinal || 0) - (b.ordinal || 0));
            if (!turning.length) return;
            const exitLanes = orderedLanes(
                (index.lanesBySection.get(exit.sectionId) || [])
                    .filter(lane => lane.fromNode === decision.nodeId)
            );
            if (rules().receivingLanes(turning, exitLanes, exit.category)) return;   // already forced
            const candidates = exitLanes.filter(lane => lane.type === 'driving' && lane.access === 'yes');
            if (candidates.length < 2) return;
            turning.forEach(lane => {
                questions.push({
                    key: `${lane.ordinal}->${exit.wayId}`,
                    laneOrdinal: lane.ordinal,
                    laneSide: laneSide(lane.ordinal, decision.approach.lanes.length),
                    exit,
                    candidates: candidates.map(candidate => ({
                        ordinal: candidate.ordinal,
                        side: laneSide(candidate.ordinal, candidates.length)
                    }))
                });
            });
        });
        return questions;
    }

    // The movements an answer means, in the same shape the deterministic rules emit.
    //
    // Which lane of the receiving arm each movement enters is settled by the SAME rule the
    // deterministic path uses — a single candidate takes everything, equal counts pair in order, a
    // turn hugs its own side. Where even that cannot say, the movements are paired in order from
    // the side the turn comes from, and the connection records `receivingLaneAssumed` so a review
    // can find every place this module chose rather than deduced.
    function movementsFor(decision, assignment, graph, options = {}) {
        const problems = fatal(validate(decision, assignment));
        if (problems.length) throw new Error(problems[0]);
        const index = indexGraph(graph);
        const lanesById = new Map((graph.lanes || []).map(lane => [lane.id, lane]));
        const connections = [];
        const author = options.author || 'manual';
        const received = options.received || {};

        const emit = (turning, receiving, exit, assumed) => {
            turning.forEach((from, position) => {
                const to = receiving[position];
                if (!to) return;
                const fromPoint = laneEndpoint(from, true);
                const toPoint = laneEndpoint(to, false);
                if (!fromPoint || !toPoint) return;
                connections.push({
                    id: `connection:${decision.nodeId}:${from.id}->${to.id}`,
                    nodeId: decision.nodeId,
                    fromLaneId: from.id,
                    toLaneId: to.id,
                    type: exit.category === 'through' ? 'continue' : 'turn',
                    priority: exit.category === 'through' ? 'continuing' : 'yielding',
                    // A person looking at the picture is better evidence than any rule here, but a
                    // person can also misread a picture; this is not the 0.95 of a stated restriction.
                    confidence: assumed ? 0.85 : 0.9,
                    source: author,
                    receivingLaneAssumed: assumed,
                    reason: `${exit.label}; decided by hand`
                        + (assumed ? ', and the receiving lane was paired in order rather than deduced.' : '.'),
                    geometry: { type: 'LineString', coordinates: [fromPoint, toPoint] }
                });
            });
        };

        decision.exits.forEach(exit => {
            const turning = decision.approach.lanes
                .filter(lane => (assignment[lane.id] || []).includes(exit.sectionId))
                .map(lane => lanesById.get(lane.id))
                .filter(Boolean)
                .sort((a, b) => (a.ordinal || 0) - (b.ordinal || 0));
            if (!turning.length) return;
            const exitLanes = orderedLanes(
                (index.lanesBySection.get(exit.sectionId) || [])
                    .filter(lane => lane.fromNode === decision.nodeId)
            );
            // An explicit choice outranks every rule here: it is the one case where somebody looked
            // at the picture. Keyed by lane and arm, and given as an ordinal so the choice survives
            // the lane ids being renamed by an edit next door.
            const chosen = turning
                .map(lane => received?.[`${lane.ordinal}->${exit.wayId}`])
                .map(ordinal => exitLanes.find(lane => lane.ordinal === ordinal));
            if (chosen.length && chosen.every(Boolean)) {
                emit(turning, chosen, exit, false);
                return;
            }

            const settled = rules().receivingLanes(turning, exitLanes, exit.category);
            let receiving = settled?.lanes;
            let assumed = false;
            if (!receiving) {
                const candidates = exitLanes.filter(lane => lane.type === 'driving' && lane.access === 'yes');
                if (!candidates.length) return;
                assumed = true;
                // Hug the side the approach joins from. An approach that has to turn RIGHT to line
                // up with the arm came at it from the right, so it takes the rightmost lanes — a
                // right-side on-ramp joins the nearside lane, it does not cross the carriageway.
                // Pairing every through movement from the left, as this did, put a one-lane ramp
                // into lane 0 of a three-lane trunk, across both through lanes.
                const hugRight = exit.category === 'right'
                    || (exit.category === 'through' && exit.relativeDeg > 0);
                const offset = hugRight ? Math.max(0, candidates.length - turning.length) : 0;
                receiving = turning.map((_, position) =>
                    candidates[Math.min(offset + position, candidates.length - 1)]);
            }

            emit(turning, receiving, exit, assumed);
        });

        return connections;
    }

    // Folds stored answers into a finished graph: their movements become connections, and the
    // approaches they answer stop counting as open.
    //
    // A post-pass, not a rule. A decision is not something the evidence forces — it is evidence
    // that arrived later, from a person — and keeping the two apart is what lets `source` on a
    // connection still mean something and lets a stale answer be reported rather than absorbed.
    //
    // Mutates the graph in place and returns what it did, so a caller can say how much of what it
    // is showing came from a person and what could not be applied.
    function applyDecisions(graph, stored) {
        // `answered` carries the descriptors, not just a count: once an answer is folded in the
        // approach is no longer open, so nothing could re-derive the question and a mistake would
        // be uncorrectable. This is how the queue can still offer it for review.
        const summary = { applied: 0, movements: 0, stale: [], answered: [] };
        const byKey = new Map((stored || []).map(record => [record.decisionKey, record]));
        if (!graph || !byKey.size) return summary;

        const open = openDecisions(graph);
        // What was ASKED at each node, taken from the queue itself rather than from the problem's
        // openApproaches: a node the rules declined outright has an empty list there, and every
        // arriving arm was synthesised into a question. Reading the empty list would make one
        // answered arm look like the whole node answered.
        const askedByNode = new Map();
        const blockedNodes = new Set();
        open.forEach(decision => {
            if (decision.kind !== 'lane_exits') { blockedNodes.add(decision.nodeId); return; }
            if (!askedByNode.has(decision.nodeId)) askedByNode.set(decision.nodeId, new Map());
            askedByNode.get(decision.nodeId).set(decision.sectionId, decision);
        });

        const answeredByNode = new Map();
        open.forEach(decision => {
            const record = byKey.get(decision.id);
            if (!record || decision.kind !== 'lane_exits') return;
            const { assignment, missing, received } = fromStoredAssignment(decision, record.assignment);
            if (missing.length) { summary.stale.push({ id: decision.id, reasons: missing }); return; }
            let movements;
            try {
                movements = movementsFor(decision, assignment, graph,
                    { author: record.author || 'manual', received });
            } catch (error) {
                summary.stale.push({ id: decision.id, reasons: [error.message] });
                return;
            }
            graph.connections.push(...movements);
            summary.applied += 1;
            summary.movements += movements.length;
            summary.answered.push({ ...decision, answered: true, assignment, received });
            if (!answeredByNode.has(decision.nodeId)) answeredByNode.set(decision.nodeId, new Set());
            answeredByNode.get(decision.nodeId).add(decision.sectionId);
        });

        if (!summary.applied) return summary;

        graph.problems = (graph.problems || []).filter(problem => {
            if (problem.type !== 'unresolved_intersection') return true;
            const nodeId = (problem.nodeIds || [])[0];
            const answered = answeredByNode.get(nodeId);
            if (!answered) return true;
            const asked = askedByNode.get(nodeId) || new Map();
            const remaining = [...asked.entries()].filter(([sectionId]) => !answered.has(sectionId));
            // A node with something nobody can answer keeps its problem however many arms were done.
            if (!remaining.length && !blockedNodes.has(nodeId)) return false;
            problem.openApproaches = remaining.map(([sectionId, decision]) => ({
                sectionId,
                name: decision.approach.name,
                reason: decision.reason
            }));
            problem.message = `${remaining.length} approach${remaining.length === 1 ? '' : 'es'} `
                + `still open here; ${answered.size} answered by hand.`;
            return true;
        });

        const junctions = (graph.nodes || []).filter(node => node.degree > 2);
        const stillOpen = new Set((graph.problems || [])
            .filter(problem => problem.type === 'unresolved_intersection')
            .map(problem => (problem.nodeIds || [])[0]));
        const withMovements = new Set((graph.connections || []).map(connection => connection.nodeId));
        graph.stats = {
            ...graph.stats,
            connections: graph.connections.length,
            problems: graph.problems.length,
            unresolvedIntersections: stillOpen.size,
            partialIntersections: [...stillOpen].filter(nodeId => withMovements.has(nodeId)).length,
            resolvedIntersections: junctions.filter(node => !stillOpen.has(node.id)).length,
            warnings: graph.problems.filter(problem => problem.severity === 'warning').length,
            errors: graph.problems.filter(problem => problem.severity === 'error').length,
            decidedByHand: summary.applied,
            decidedMovements: summary.movements
        };
        return summary;
    }

    return {
        QUESTIONS,
        EXIT_MATCH_TOLERANCE_DEG,
        questionFor,
        openDecisions,
        exitsFor,
        decisionId,
        suggestAssignment,
        toStoredAssignment,
        fromStoredAssignment,
        validate,
        pointAlong,
        streetViewViewpoint,
        streetViewUrl,
        openReceivingChoices,
        movementsFor,
        applyDecisions
    };
});
