// Checks a solved lane graph against OSM turn restrictions.
//
// Junction connections are the one part of the graph nothing deterministic produces — they come
// from an LLM run, and until now nothing could contradict one. OSM states a subset of the same
// facts as relations (from-way / via-node / to-way), so where the two disagree the graph is
// provably wrong, not merely unverified.
//
// Coverage is sparse (a few restrictions per viewport), so this can only ever REFUTE, never
// confirm. A junction with no restriction is not thereby correct.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.LaneTopologyRestrictions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // A movement OSM forbids outright. Anything else the graph does at that node is untouched.
    const PROHIBITIVE = /^no_/;
    // A movement OSM declares the ONLY one permitted from that approach — so every other movement
    // out of the same from-way at the same node is forbidden by implication.
    const MANDATORY = /^only_/;

    function nodeKey(ref) {
        return `osm-node:${ref}`;
    }

    function memberRef(restriction, role, type) {
        const member = (restriction?.members || []).find(
            candidate => candidate?.role === role && candidate?.type === type
        );
        return member ? String(member.ref) : null;
    }

    // A restriction we cannot place has to be reported as unusable, not silently skipped: a
    // via-way restriction is real, and pretending it does not exist is how coverage gets overstated.
    function describe(restriction) {
        const via = memberRef(restriction, 'via', 'node');
        return {
            osmId: restriction?.osm_id ?? null,
            kind: restriction?.restriction || null,
            fromWayId: memberRef(restriction, 'from', 'way'),
            toWayId: memberRef(restriction, 'to', 'way'),
            viaNodeId: via,
            viaNodeKey: via === null ? null : nodeKey(via)
        };
    }

    function indexGraph(graph) {
        const lanes = new Map();
        (graph?.lanes || []).forEach(lane => {
            if (lane?.id) lanes.set(lane.id, lane);
        });
        const sections = new Map();
        (graph?.sections || []).forEach(section => {
            if (section?.id) sections.set(section.id, section);
        });
        const wayOf = lane => {
            if (!lane) return null;
            const direct = lane.sourceWayId ?? sections.get(lane.sectionId)?.sourceWayId;
            return direct === undefined || direct === null ? null : String(direct);
        };
        return { lanes, wayOf };
    }

    function problem(restriction, connection, severity, message) {
        return {
            id: `problem:restriction:${restriction.osmId}:${connection.id}`,
            type: 'turn_restriction_violation',
            severity,
            nodeIds: [connection.nodeId],
            connectionIds: [connection.id],
            sourceWayIds: [restriction.fromWayId, restriction.toWayId].filter(Boolean),
            restriction: restriction.kind,
            restrictionOsmId: restriction.osmId,
            message
        };
    }

    function checkConnections(graph, restrictions) {
        const { lanes, wayOf } = indexGraph(graph);
        const connections = (graph?.connections || []).map(connection => ({
            ...connection,
            fromWayId: wayOf(lanes.get(connection.fromLaneId)),
            toWayId: wayOf(lanes.get(connection.toLaneId))
        }));

        const problems = [];
        const unusable = [];
        let checked = 0;

        (restrictions || []).forEach(raw => {
            const restriction = describe(raw);
            if (!restriction.kind || !restriction.fromWayId || !restriction.toWayId
                || !restriction.viaNodeKey) {
                unusable.push({
                    osmId: restriction.osmId,
                    kind: restriction.kind,
                    // via-way restrictions and malformed relations both land here.
                    reason: restriction.viaNodeKey ? 'incomplete_members' : 'no_via_node'
                });
                return;
            }

            const atNode = connections.filter(connection => connection.nodeId === restriction.viaNodeKey
                && connection.fromWayId === restriction.fromWayId);
            if (!atNode.length) return;
            checked += 1;

            if (PROHIBITIVE.test(restriction.kind)) {
                atNode
                    .filter(connection => connection.toWayId === restriction.toWayId)
                    .forEach(connection => problems.push(problem(
                        restriction, connection, 'error',
                        `OSM restriction ${restriction.kind} forbids way ${restriction.fromWayId} → `
                        + `${restriction.toWayId} here, but the graph connects them.`
                    )));
                return;
            }

            if (MANDATORY.test(restriction.kind)) {
                atNode
                    .filter(connection => connection.toWayId !== restriction.toWayId)
                    .forEach(connection => problems.push(problem(
                        restriction, connection, 'error',
                        `OSM restriction ${restriction.kind} permits only way ${restriction.fromWayId} → `
                        + `${restriction.toWayId} here, but the graph also connects to `
                        + `${connection.toWayId}.`
                    )));
            }
            // Anything else (restriction:conditional, no_entry style) is not a movement rule we
            // can decide on, so it neither passes nor fails the graph.
        });

        return {
            problems,
            stats: {
                restrictions: (restrictions || []).length,
                usable: (restrictions || []).length - unusable.length,
                applicable: checked,
                violations: problems.length,
                unusable
            }
        };
    }

    return { PROHIBITIVE, MANDATORY, describe, checkConnections };
});
