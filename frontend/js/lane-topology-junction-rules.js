// Deterministic movements for the junctions whose answer the lane counts already force.
//
// Every degree-3+ node used to go to a recognition run, because a junction with two lanes on an
// approach genuinely needs evidence to say which lane turns where. A junction with ONE lane per
// direction on every arm has no such question: each approach can reach every other arm, and the
// only things that remove a movement are an OSM turn restriction and a turn:lanes tag — both
// readable. Solving those here is the difference between a city-sized recognition backlog and a
// small one.
//
// The movement SET never depends on a bearing: it is all-to-all minus the U-turn, minus what the
// evidence forbids. Bearings only label a movement (through/left/right) and match turn:lanes
// tokens, so a noisy bearing at a stubby arm mislabels a connection but cannot invent or lose one.
(function (root, factory) {
    const api = factory(root || {});
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.LaneTopologyJunctionRules = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    // Above this, a node is not something anyone drives through — it is OSM's rendering of a plaza,
    // a parking-aisle fan or a cluster that should have been several nodes, and all-to-all would
    // invent dozens of movements through it.
    const MAX_RESOLVABLE_ARMS = 6;
    // Bearings are measured across this much of each arm, never across the last vertex pair: OSM
    // geometry is dense at junctions, and a 0.6 m final segment measures quantisation, not heading.
    const BEARING_BASELINE_M = 15;
    const THROUGH_MAX_DEG = 30;
    const REVERSE_MIN_DEG = 150;
    // How much straighter an arm must be than its rivals to be called the way straight on. Below
    // this the two are a fork with no favourite, and saying which continues is a guess.
    const FORK_MARGIN_DEG = 5;

    // A lane token says which movements the lane permits. Anything that is not a turn — a merge
    // hint, an explicit "none" — leaves the lane going straight on.
    const TURN_TOKEN_CATEGORY = {
        left: 'left', slight_left: 'left', sharp_left: 'left', merge_to_left: 'through',
        right: 'right', slight_right: 'right', sharp_right: 'right', merge_to_right: 'through',
        through: 'through', none: 'through', '': 'through',
        reverse: 'reverse'
    };

    let restrictionsApi = null;
    function restrictionsModule() {
        if (restrictionsApi) return restrictionsApi;
        restrictionsApi = (root && root.LaneTopologyRestrictions)
            || (typeof require === 'function' ? require('./lane-topology-restrictions.js') : null);
        if (!restrictionsApi) {
            throw new Error('LaneTopologyJunctionRules needs lane-topology-restrictions.js to read turn restrictions.');
        }
        return restrictionsApi;
    }

    function bearingDegrees(from, to) {
        const meanLat = (from[1] + to[1]) * Math.PI / 360;
        const dx = (to[0] - from[0]) * Math.cos(meanLat);
        const dy = to[1] - from[1];
        return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
    }

    function metersBetween(a, b) {
        const meanLat = (a[1] + b[1]) * Math.PI / 360;
        return Math.hypot((b[0] - a[0]) * 111320 * Math.cos(meanLat), (b[1] - a[1]) * 110540);
    }

    // Heading of travel where the lane meets the node: arriving when `atEnd`, departing otherwise.
    // Walks away from the node until the baseline is spanned, so the chord describes the arm.
    function headingAtNode(coordinates, atEnd) {
        const points = atEnd ? [...coordinates].reverse() : coordinates;
        const node = points[0];
        let far = points[points.length - 1];
        let span = 0;
        for (let index = 1; index < points.length; index += 1) {
            span += metersBetween(points[index - 1], points[index]);
            if (span >= BEARING_BASELINE_M) {
                far = points[index];
                break;
            }
        }
        if (metersBetween(node, far) < 1e-6) return null;
        return atEnd ? bearingDegrees(far, node) : bearingDegrees(node, far);
    }

    // Signed angle from the arriving heading to the departing one: positive turns right.
    function relativeTurnDegrees(arriving, departing) {
        return ((departing - arriving + 540) % 360) - 180;
    }

    function classifyTurn(relative) {
        if (Math.abs(relative) <= THROUGH_MAX_DEG) return 'through';
        if (Math.abs(relative) >= REVERSE_MIN_DEG) return 'reverse';
        return relative > 0 ? 'right' : 'left';
    }

    // The angle each token is aiming at. The category a token collapses to is enough to decide
    // whether a movement EXISTS, but not which arm it means when two arms are on the same side.
    const TOKEN_ANGLE = {
        sharp_left: -135, left: -90, slight_left: -45,
        merge_to_left: 0, through: 0, none: 0, '': 0, merge_to_right: 0,
        slight_right: 45, right: 90, sharp_right: 135
    };

    function tokensOf(lane) {
        return String(lane?.turn ?? '').split(';')
            .map(token => token.trim().toLowerCase())
            .filter(Boolean);
    }

    // null means the lane says nothing, which is different from a lane that permits nothing.
    function turnCategoriesOf(lane) {
        const raw = lane?.turn;
        if (raw === undefined || raw === null || raw === '') return null;
        const categories = new Set(
            String(raw).split(';')
                .map(token => TURN_TOKEN_CATEGORY[token.trim().toLowerCase()])
                .filter(Boolean)
        );
        return categories.size ? categories : null;
    }

    // node key -> the movement rules OSM states there, already reduced to way ids.
    function indexRestrictions(restrictions) {
        const index = new Map();
        if (!Array.isArray(restrictions) || !restrictions.length) return index;
        const { describe } = restrictionsModule();
        restrictions.forEach(raw => {
            const rule = describe(raw);
            if (!rule.kind || !rule.fromWayId || !rule.toWayId || !rule.viaNodeKey) return;
            if (!index.has(rule.viaNodeKey)) index.set(rule.viaNodeKey, []);
            index.get(rule.viaNodeKey).push(rule);
        });
        return index;
    }

    function laneEndpoint(lane, atEnd) {
        const coordinates = lane?.geometry?.coordinates || [];
        return coordinates[atEnd ? coordinates.length - 1 : 0] || null;
    }

    function movementWord(category) {
        return category === 'through' ? 'Straight on' : (category === 'left' ? 'Left' : 'Right');
    }

    // Says what settled the movement, because "deterministic" alone does not distinguish a movement
    // OSM states outright from one that follows only from there being nowhere else for a lane to go.
    function movementReason(category, toName, arms, tagged, mandatoryKind, hugged, forked, merged) {
        const head = `${movementWord(category)}${toName ? ` into ${toName}` : ''}`;
        if (merged) {
            return `${head}; every lane arriving here has its own lane to enter and nowhere else `
                + 'to go, so the order settles which.';
        }
        const receiving = hugged
            ? `it enters the ${category === 'left' ? 'leftmost' : 'rightmost'} lane, which is the only one it can reach without crossing`
            : 'the receiving lane follows in order without crossing';
        if (mandatoryKind) return `${head}; OSM ${mandatoryKind} permits only this movement.`;
        if (forked) {
            const confirmation = tagged
                ? 'turn:lanes names it on this lane'
                : 'no lane tag names it, so this rests on the angle alone';
            return `${head}; a shallower fork off the straight-on arm, and ${confirmation}.`;
        }
        if (tagged) return `${head}; turn:lanes names it on this lane, and ${receiving}.`;
        if (hugged) return `${head}; ${receiving}.`;
        return `${head}; one lane per direction on all ${arms} arms, so no lane assignment is in question.`;
    }

    function confidenceFor(category, tagged, forced, hugged, forked, merged) {
        if (forced) return 0.95;
        // The counts leave no alternative, which is the strongest basis short of OSM saying so.
        if (merged) return 0.92;
        // Hugging is a road-code rule rather than something the counts force, so it stays under the
        // in-order pairing even when turn:lanes named the movement itself.
        if (tagged) return hugged ? 0.8 : 0.9;
        if (hugged) return 0.7;
        // A fork demoted out of `through` is read off geometry; with no lane tag agreeing, it is the
        // weakest basis here.
        if (forked) return 0.65;
        if (category === 'through') return 0.85;
        // A left turn is the movement most often killed by a sign OSM never recorded, so it is the
        // one worth a human glance; a right turn across nothing rarely is.
        return category === 'right' ? 0.8 : 0.7;
    }

    // Only ONE arm can be the way straight on. Several can fall inside the through window, though —
    // a motorway slip road leaving at 28° is the common case — and treating them alike is not a near
    // miss but a wrong answer: every through-tagged lane is then read as turning into the slip road,
    // the count test fails against its single lane, and the approach is abandoned whole, taking the
    // perfectly good continuation with it.
    //
    // So the straightest arm keeps `through` and the rest become the turn their angle already says
    // they are. Nothing is invented: a wrong demotion still has to satisfy the lane counts, and when
    // it cannot the approach opens exactly as before.
    //
    // Measured A/B over 683 junctions (76 sampled tiles, same evidence both runs): 2 junctions went
    // from open to settled, 22 movements at 22 further junctions changed from a straight-on
    // continuation to a yielding turn, and NO already-settled junction lost or gained a movement.
    // A small share of the backlog, then, but the relabelling is the part that matters downstream —
    // a slip road that claims priority as a continuation is wrong in a way nothing else catches.
    function assignCategories(candidates) {
        const graded = candidates.map(candidate => ({
            ...candidate,
            category: classifyTurn(candidate.relative),
            forked: false
        }));
        const through = graded.filter(candidate => candidate.category === 'through');
        if (through.length < 2) return graded;
        const straightest = through.reduce(
            (best, candidate) => Math.abs(candidate.relative) < Math.abs(best.relative) ? candidate : best
        );
        through.forEach(candidate => {
            if (candidate === straightest) return;
            // Two arms leaving at near enough the same angle either side of the axis are a symmetric
            // fork, and no angle says which is the continuation. Left as a collision, so the tokens
            // or the counts have to decide instead.
            //
            // A MARGIN, not equality: these angles are measured off offset lane geometry, so a
            // perfectly symmetric Y produces -20.130° and +20.130° that are not bit-identical.
            // Comparing them with === meant the guard never once fired, and one arm of every
            // symmetric fork was quietly demoted to a turn on the strength of a rounding error.
            if (Math.abs(candidate.relative) - Math.abs(straightest.relative) < FORK_MARGIN_DEG) return;
            candidate.category = candidate.relative > 0 ? 'right' : 'left';
            candidate.forked = true;
        });
        return graded;
    }

    // Lanes ordered left to right in their own direction of travel — which is the order OSM writes
    // turn:lanes in, and the order movements must preserve because lanes cannot cross inside a
    // junction. `ordinal` already carries it for both directions; this only makes the reliance plain.
    function leftToRight(lanes) {
        return lanes.slice().sort((a, b) => (a.ordinal || 0) - (b.ordinal || 0));
    }

    // A bus lane is not interchangeable with a general one, so pairing an arm by order would put
    // through traffic into it. One restricted lane in a multi-lane arm forfeits the whole node.
    function ordinaryLanes(lanes) {
        return lanes.every(lane => lane.type === 'driving' && lane.access === 'yes');
    }

    // Which lane of the exit arm a set of turning lanes enters.
    //
    // A bus lane is not a candidate for general traffic, so it is removed from the exit before
    // anything is counted — otherwise an arm with one would be unanswerable rather than simply
    // narrower. Then three shapes are settled and the rest is left alone:
    //
    //   - a single receiving lane takes everything;
    //   - equal counts pair in order, because lanes cannot cross inside a junction;
    //   - a turn hugs its own side — a left turn enters the leftmost lanes, a right turn the
    //     rightmost — which is the rule the road code states and the only one that does not cross
    //     the traffic already entering that arm. Marked as a weaker basis than the two above.
    //
    // What is left is a genuine choice: which lane a lone through movement leaves empty, or which
    // pair merges when more lanes turn than can receive them. Those belong to recognition.
    function receivingLanes(turning, exit, category) {
        const candidates = exit.filter(lane => lane.type === 'driving' && lane.access === 'yes');
        if (!candidates.length) return null;
        // More lanes turning than can receive them is a merge inside the junction, and which pair
        // merges is exactly the thing a count cannot say.
        if (turning.length > candidates.length) return null;
        if (turning.length === candidates.length) return { lanes: candidates.slice(), hugged: false };
        if (category === 'left') return { lanes: candidates.slice(0, turning.length), hugged: true };
        if (category === 'right') return { lanes: candidates.slice(-turning.length), hugged: true };
        return null;
    }

    // A node where every arriving lane has its own lane to enter, and nowhere else to go.
    //
    // One exit arm, and its lanes number exactly the lanes arriving across all approaches: that is
    // a merge — two carriageways becoming one, or a slip road adding a lane. Nobody chooses
    // anything, because lanes cannot cross, so the order alone settles it. This was being put to a
    // person as "which of these three lanes does the one-lane on-ramp enter", with no control to
    // answer it and a fallback that would have said "the leftmost" — sending the ramp across both
    // through lanes. About a tenth of the open approaches citywide, and most of them at
    // interchanges, where they were the bulk of the queue.
    //
    // Approaches are ordered by the turn each must make to line up with the exit. A right-side
    // on-ramp points leftward and turns RIGHT to straighten, so its angle is positive; a left-side
    // one is the mirror. Ascending angle is therefore left-to-right across the exit.
    function mergeAssignment(approaches, exits, headingOf) {
        if (exits.size !== 1) return null;
        const [exitSectionId, exitLanes] = [...exits.entries()][0];
        const candidates = exitLanes.filter(lane => lane.type === 'driving' && lane.access === 'yes');
        if (!candidates.length) return null;
        const departing = headingOf(exitLanes[0], false);
        if (departing === null) return null;

        const ordered = [];
        let arrivingTotal = 0;
        for (const [sectionId, approach] of approaches) {
            // The exit doubling as an approach is a two-way arm, not a merge.
            if (sectionId === exitSectionId) return null;
            // A bus lane is not interchangeable with a general one, so order cannot allocate it.
            if (!ordinaryLanes(approach)) return null;
            const arriving = headingOf(approach[0], true);
            if (arriving === null) return null;
            ordered.push({ sectionId, count: approach.length, turn: relativeTurnDegrees(arriving, departing) });
            arrivingTotal += approach.length;
        }
        if (arrivingTotal !== candidates.length) return null;

        ordered.sort((a, b) => a.turn - b.turn);
        const assignment = new Map();
        let cursor = 0;
        ordered.forEach(entry => {
            assignment.set(entry.sectionId, candidates.slice(cursor, cursor + entry.count));
            cursor += entry.count;
        });
        return { exitSectionId, assignment };
    }

    // Which arm each TOKEN means, when several arms share a category — or null when the tokens
    // cannot tell those arms apart.
    //
    // A lane tagged `left` where two arms are both left turns names ONE movement: one arrow is
    // painted on the road. The category alone cannot say which arm it means, so every such lane was
    // sent to BOTH — four movements at a junction that has two, emitted at full confidence with
    // nothing flagged, because the counts happened to work out on each arm separately.
    //
    // Distinct tokens can often say: `left` and `slight_left`, at arms 92° and 39° off the approach,
    // match one each. That is accepted only as a strict one-to-one pairing — as many distinct tokens
    // as arms, each claiming a different one. Anything less is genuinely ambiguous and belongs to a
    // person, which is what `left|left` across two left arms always was.
    function pairTokensToArms(approach, category, arms) {
        const tokens = new Set();
        approach.forEach(lane => {
            tokensOf(lane).forEach(token => {
                const categories = turnCategoriesOf({ turn: token });
                if (categories && categories.has(category)) tokens.add(token);
            });
        });
        if (!tokens.size) return new Map();          // no tag names this side; nothing to divide
        if (tokens.size !== arms.length) return null;

        const pairs = new Map();
        const taken = new Set();
        for (const token of tokens) {
            const target = TOKEN_ANGLE[token];
            if (!Number.isFinite(target)) return null;
            const nearest = arms.reduce((best, arm) =>
                Math.abs(arm.relative - target) < Math.abs(best.relative - target) ? arm : best);
            if (taken.has(nearest.toSectionId)) return null;   // two tokens want the same arm
            taken.add(nearest.toSectionId);
            pairs.set(token, nearest.toSectionId);
        }
        return pairs;
    }

    // Which approach lanes may use each arm: a set of lane indices per exit.
    //
    // An UNTAGGED lane is unmarked road and may use every arm, exactly as before — the ambiguity
    // this resolves is a property of the marking, not of the junction.
    function armAssignment(approach, graded) {
        const allowed = new Map(graded.map(candidate => [candidate.toSectionId, new Set()]));
        const byCategory = new Map();
        graded.forEach(candidate => {
            if (!byCategory.has(candidate.category)) byCategory.set(candidate.category, []);
            byCategory.get(candidate.category).push(candidate);
        });

        for (const [category, arms] of byCategory) {
            const pairs = arms.length > 1 ? pairTokensToArms(approach, category, arms) : new Map();
            if (pairs === null) return { allowed: null, ambiguous: category };
            approach.forEach((lane, index) => {
                const categories = turnCategoriesOf(lane);
                if (!categories) {
                    arms.forEach(arm => allowed.get(arm.toSectionId).add(index));
                    return;
                }
                if (!categories.has(category)) return;
                if (arms.length === 1) {
                    allowed.get(arms[0].toSectionId).add(index);
                    return;
                }
                tokensOf(lane).forEach(token => {
                    const sectionId = pairs.get(token);
                    if (sectionId) allowed.get(sectionId).add(index);
                });
            });
        }
        return { allowed, ambiguous: null };
    }

    // { connections, arms, evidence, open } — the movements the rules can settle at this node, and
    // the approaches still open, each with why. An empty `open` means the node is fully settled.
    //
    // How many lane-to-lane movements are actually in question at a node — the size of the decision,
    // and the one honest test of whether there is one at all.
    //
    // Some nodes the rules decline have nothing to decide: three OSM ways meet, but only one of them
    // produced a drivable lane, so the sole movement available is a U-turn. Those became junctions
    // that could never be closed by anyone — five of the six left open in two fully swept tiles.
    // The tempting fix is to blame the decline REASON, but that over-reaches badly: measured over
    // the same tiles, nine nodes declined for too-few-arms still had real movements in question, and
    // suppressing them would have hidden genuine work. So this counts, rather than infers.
    //
    // Only the open approaches count. The rest were settled by the rules and a consumer must not
    // reopen them.
    function decisionSurface(node, lanes, openApproaches) {
        const touching = (lanes || []).filter(lane => lane.fromNode === node.id
            || lane.toNode === node.id);
        const openSections = openApproaches?.length
            ? new Set(openApproaches.map(entry => entry.sectionId))
            : null;
        const incoming = touching.filter(lane => lane.toNode === node.id
            && (!openSections || openSections.has(lane.sectionId)));
        const exitArms = new Set(touching.filter(lane => lane.fromNode === node.id)
            .map(lane => lane.sectionId));
        // Arriving on an arm, you may leave by any OTHER arm; going back the way you came is a
        // U-turn, not a movement this model decides.
        return incoming.reduce((total, lane) => total
            + Math.max(0, exitArms.size - (exitArms.has(lane.sectionId) ? 1 : 0)), 0);
    }

    // `{ declined }` instead means nothing at the node could be looked at: the whole node is open.
    // Those two are different states and a caller must not confuse them, because a missing
    // connection in this model reads as a movement that is forbidden, not one nobody decided —
    // which is why `open` has to be carried alongside the connections and honoured downstream.
    //
    // Resolution is per APPROACH, never per movement. A doubt anywhere in an approach opens all of
    // it; the other approaches at the same node keep their answers.
    function resolveNode(node, context) {
        const sectionsById = context?.sectionsById;
        const lanesBySection = context?.lanesBySection;
        if (!sectionsById || !lanesBySection) return { declined: 'no_graph_context' };
        if ((node?.degree || 0) < 3) return { declined: 'not_a_junction' };

        const sectionIds = [...new Set(node.sectionIds || [])];
        if (sectionIds.length > MAX_RESOLVABLE_ARMS) return { declined: 'arms_over_cap' };
        if (sectionIds.length < 3) return { declined: 'fewer_than_three_arms' };

        const lanes = sectionIds.flatMap(sectionId => lanesBySection.get(sectionId) || []);
        const touching = lanes.filter(lane => lane.fromNode === node.id || lane.toNode === node.id);
        // A `lanes:both_ways` centre lane belongs to neither approach; who may use it to turn is a
        // judgement, not a count.
        if (touching.some(lane => lane.direction === 'both')) return { declined: 'two_way_centre_lane' };
        if (!touching.some(lane => lane.toNode === node.id)
            || !touching.some(lane => lane.fromNode === node.id)) {
            return { declined: 'no_incoming_or_no_outgoing' };
        }

        // One approach and one exit per arm; every lane within them ordered left to right.
        const approaches = new Map();
        const exits = new Map();
        sectionIds.forEach(sectionId => {
            const own = (lanesBySection.get(sectionId) || []);
            const arriving = leftToRight(own.filter(lane => lane.toNode === node.id));
            const leaving = leftToRight(own.filter(lane => lane.fromNode === node.id));
            if (arriving.length) approaches.set(sectionId, arriving);
            if (leaving.length) exits.set(sectionId, leaving);
        });
        const multiLaneApproaches = [...approaches.values()].filter(group => group.length > 1);
        // Node-level, so it is computed once rather than per approach: a merge is a fact about how
        // the whole node's lanes line up, not about any one arm.
        const merge = mergeAssignment(approaches, exits,
            (lane, atEnd) => headingAtNode(lane.geometry.coordinates, atEnd));
        const rules = (context.restrictionsByNode || new Map()).get(node.id) || [];
        const matchers = rules.length ? restrictionsModule() : null;
        const isMandatory = rule => !!matchers && matchers.MANDATORY.test(rule.kind);
        const isProhibitive = rule => !!matchers && matchers.PROHIBITIVE.test(rule.kind);
        const wayOf = sectionId => String(sectionsById.get(sectionId)?.sourceWayId ?? '');

        const connections = [];
        const evidence = {
            restrictions: 0,
            taggedTurns: 0,
            huggedTurns: 0,
            forkedTurns: 0,
            mergedApproaches: 0,
            multiLaneApproaches: multiLaneApproaches.length
        };
        const open = [];
        for (const [fromSectionId, approach] of approaches) {
            // An approach is decided as a whole, and a doubt anywhere in it leaves the WHOLE
            // approach open: emitting some of its movements and not others would say the missing
            // ones are forbidden. Its neighbours at the same node are unaffected — they have their
            // own lanes and their own evidence.
            const leaveOpen = reason => {
                open.push({
                    sectionId: fromSectionId,
                    name: sectionsById.get(fromSectionId)?.name || null,
                    reason
                });
            };
            const decided = [];
            const arriving = headingAtNode(approach[0].geometry.coordinates, true);
            if (arriving === null) { leaveOpen('degenerate_arm_heading'); continue; }
            // A bus lane arriving has movements of its own that nothing here can settle. On the way
            // OUT it is merely a lane general traffic may not enter, and `receivingLanes` drops it.
            if (approach.length > 1 && !ordinaryLanes(approach)) {
                leaveOpen('restricted_lane_in_multi_lane_approach');
                continue;
            }
            // With one lane the token is optional — there is nothing to assign it to. With more,
            // an untagged lane is precisely the question a picture has to answer.
            //
            // Unless this approach is part of a merge: one arm out, and its lanes numbering exactly
            // the lanes coming in. Then there is no assignment for a tag to disambiguate — every
            // lane has one place to go — and demanding turn:lanes would hold open a junction whose
            // answer the counts already force. That was every multi-lane carriageway feeding a
            // motorway merge.
            const mergedHere = !!merge?.assignment.get(fromSectionId);
            const permitted = approach.map(turnCategoriesOf);
            if (!mergedHere && approach.length > 1 && permitted.some(categories => !categories)) {
                leaveOpen('multi_lane_approach_without_turn_lanes');
                continue;
            }
            const fromWayId = wayOf(fromSectionId);
            const only = rules.find(rule => isMandatory(rule) && rule.fromWayId === fromWayId);
            let undecidable = null;

            // Which exits this approach may reach, before any of them is called a turn. Restrictions
            // are applied here so a forbidden arm cannot win the straight-on slot from the arm that
            // traffic actually continues into.
            const reachable = [];
            for (const [toSectionId, exit] of exits) {
                if (toSectionId === fromSectionId) continue; // the U-turn back down the arm
                const departing = headingAtNode(exit[0].geometry.coordinates, false);
                if (departing === null) { undecidable = 'degenerate_arm_heading'; break; }
                const relative = relativeTurnDegrees(arriving, departing);
                // Two arms that leave in opposite directions are a hairpin, not a junction movement.
                if (classifyTurn(relative) === 'reverse') continue;

                const toWayId = wayOf(toSectionId);
                if (rules.some(rule => isProhibitive(rule)
                    && rule.fromWayId === fromWayId && rule.toWayId === toWayId)) {
                    evidence.restrictions += 1;
                    continue;
                }
                if (only && only.toWayId !== toWayId) {
                    evidence.restrictions += 1;
                    continue;
                }
                reachable.push({ toSectionId, exit, relative, toWayId });
            }
            if (undecidable) { leaveOpen(undecidable); continue; }

            const graded = assignCategories(reachable);
            const { allowed, ambiguous } = armAssignment(approach, graded);
            if (ambiguous) { leaveOpen('ambiguous_arm_for_turn'); continue; }

            for (const { toSectionId, exit, toWayId, category, forked } of graded) {
                if (forked) evidence.forkedTurns += 1;
                const takers = allowed.get(toSectionId);
                const turning = approach.filter((lane, index) => takers.has(index));
                if (!turning.length) continue;
                // A merge allocates the whole approach by order. If turn:lanes narrowed the set,
                // the allocation no longer describes what is turning, so the ordinary rule decides.
                const merged = merge && toSectionId === merge.exitSectionId
                    ? merge.assignment.get(fromSectionId)
                    : null;
                const receiving = merged && merged.length === turning.length
                    ? { lanes: merged, hugged: false, merged: true }
                    : receivingLanes(turning, exit, category);
                if (!receiving) { undecidable = 'receiving_lane_undetermined'; break; }
                if (receiving.hugged) evidence.huggedTurns += 1;
                if (receiving.merged) evidence.mergedApproaches += 1;

                const forced = !!(only && only.toWayId === toWayId);
                const toName = sectionsById.get(toSectionId)?.name;
                turning.forEach((from, index) => {
                    const to = receiving.lanes[index];
                    const tagged = !!permitted[approach.indexOf(from)];
                    if (tagged) evidence.taggedTurns += 1;
                    const fromPoint = laneEndpoint(from, true);
                    const toPoint = laneEndpoint(to, false);
                    if (!fromPoint || !toPoint) return;
                    decided.push({
                        id: `connection:${node.id}:${from.id}->${to.id}`,
                        nodeId: node.id,
                        fromLaneId: from.id,
                        toLaneId: to.id,
                        type: category === 'through' ? 'continue' : 'turn',
                        priority: category === 'through' ? 'continuing' : 'yielding',
                        confidence: confidenceFor(category, tagged, forced, receiving.hugged, forked,
                            receiving.merged),
                        source: 'deterministic',
                        reason: movementReason(category, toName, sectionIds.length, tagged,
                            forced && only.kind, receiving.hugged, forked, receiving.merged),
                        geometry: { type: 'LineString', coordinates: [fromPoint, toPoint] }
                    });
                });
            }

            if (undecidable) { leaveOpen(undecidable); continue; }
            // An approach that can reach nothing means the tags and the restrictions contradict each
            // other or the geometry. That is a finding, not a settled approach.
            if (!decided.length) { leaveOpen('approach_reaches_nothing'); continue; }
            connections.push(...decided);
        }

        return { connections, arms: sectionIds.length, evidence, open };
    }

    return {
        decisionSurface,
        MAX_RESOLVABLE_ARMS,
        BEARING_BASELINE_M,
        THROUGH_MAX_DEG,
        REVERSE_MIN_DEG,
        bearingDegrees,
        headingAtNode,
        relativeTurnDegrees,
        classifyTurn,
        turnCategoriesOf,
        indexRestrictions,
        // Exported so anything that ASKS about a junction labels its arms exactly as the rules
        // would answer. A question that calls an arm a right turn where the rules call it the
        // straight-on continuation is not a wording difference; it is a different junction.
        assignCategories,
        movementWord,
        receivingLanes,
        resolveNode
    };
});
