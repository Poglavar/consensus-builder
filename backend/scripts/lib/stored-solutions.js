// Which junction nodes a stored solution has already settled.
//
// The rules derive most of the topology on demand, so a report built only from a fresh derivation
// describes work that a model or a person may have finished days ago: twenty-three junctions solved
// by Opus still counted as open in both the worklist and the coverage map. The runner never redid
// them — its resume is by artifact — but the reports overstated what was left.
//
// A node counts as settled by a solution when that solution has movements at it and no longer calls
// it unresolved. Partial resolution means the second half matters: a solution can answer one
// approach of a node and leave another open, and the node is then still work.
// The endpoint caps a page at 100 whatever is asked for. Asking for 500 and taking what came back
// silently dropped the 24 oldest solutions — 6 of them adjudicated — so both reports called settled
// junctions open. Page until `total` is covered instead of trusting one response to be complete.
const PAGE_SIZE = 100;
const MAX_PAGES = 200;
// The solutions endpoint rejects a bbox wider than the builder's own ceiling, so a city-wide report
// must ask without one and narrow the list here instead. Asking with the city bbox returned HTTP 400
// and the whole survey quietly fell back to derivation only.
const MAX_BBOX_SPAN_DEG = 0.08;

function overlaps(a, b) {
    return Array.isArray(a) && Array.isArray(b)
        && a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

function errorKeys(solution) {
    if (!Array.isArray(solution?.errorProblemKeys)) return null;
    return new Set(solution.errorProblemKeys);
}

function countRestrictionViolations(graph) {
    const reported = graph?.stats?.turnRestrictions?.violations
        ?? graph?.graph?.stats?.turnRestrictions?.violations;
    const value = Number(reported);
    return reported != null && Number.isFinite(value) ? value : 0;
}

function isUnsafeComparedWithParent(solution, parent) {
    const childErrors = errorKeys(solution);
    const parentErrors = errorKeys(parent);
    const parentMissing = missingIncomingAssignmentKeys(parent.graph);
    // Graph JSON in older solutions can disagree with persisted problem rows. Compare the rows'
    // distinct identities, while failing closed if either persisted list is unavailable.
    return !childErrors || !parentErrors
        || [...childErrors].some(key => !parentErrors.has(key))
        || countRestrictionViolations(solution) > countRestrictionViolations(parent)
        || [...missingIncomingAssignmentKeys(solution.graph)]
            .some(key => !parentMissing.has(key));
}

function isDrivableIncomingLane(lane) {
    return lane?.type === 'driving'
        && lane?.direction !== 'both'
        && !['no', 'private'].includes(lane?.access)
        && typeof lane?.toNode === 'string';
}

function missingIncomingAssignmentKeys(graph) {
    const nodes = new Map((graph?.nodes || []).map(node => [node.id, node]));
    const assigned = new Set((graph?.connections || []).map(connection => connection?.fromLaneId));
    const missing = new Set();
    (graph?.lanes || []).forEach(lane => {
        if (lane?.type === 'driving' && lane?.direction === 'both'
            && !['no', 'private'].includes(lane?.access)) {
            // A two-way centre lane has no directed counterpart to leave the junction. A model
            // connecting the ordinary lanes cannot by itself resolve this lane's usage.
            [lane.fromNode, lane.toNode].forEach(nodeId => {
                if (Number(nodes.get(nodeId)?.degree) >= 3) {
                    missing.add(`${nodeId}|centre:${lane.id}`);
                }
            });
            return;
        }
        const node = nodes.get(lane?.toNode);
        if (Number(node?.degree) < 3 || !isDrivableIncomingLane(lane)) return;
        if (!assigned.has(lane.id)) missing.add(`${node.id}|${lane.id}`);
    });
    return missing;
}

function nodesWithMissingIncomingAssignments(graph) {
    return new Set([...missingIncomingAssignmentKeys(graph)].map(key => key.split('|')[0]));
}

// Every page of the solution list, in order. Throws rather than returning a short list: a caller
// that cannot tell "all of them" from "the first hundred" is the bug this replaces.
export async function listAllSolutions({ api, city = 'zagreb', bbox, fetchImpl = fetch, log }) {
    const base = String(api).replace(/\/+$/, '');
    const query = `city=${encodeURIComponent(city)}`
        + (Array.isArray(bbox) ? `&bbox=${bbox.join(',')}` : '');
    const all = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
        const url = `${base}/lane-topology/solutions?${query}&limit=${PAGE_SIZE}&offset=${all.length}`;
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        const batch = body.solutions || [];
        all.push(...batch);
        // `hasMore` is the server's own judgement; the length check covers an older server that
        // does not send it, and stops a zero-length page from looping forever.
        if (!batch.length || body.hasMore === false || all.length >= (body.total ?? all.length)) {
            return all;
        }
    }
    log?.(`stopped paging solutions at ${all.length}; more remain`);
    return all;
}

export async function settledNodeIndex({ api, city = 'zagreb', bbox, fetchImpl = fetch, log }) {
    const settled = new Set();
    const base = String(api).replace(/\/+$/, '');
    const wide = !Array.isArray(bbox)
        || (bbox[2] - bbox[0]) > MAX_BBOX_SPAN_DEG
        || (bbox[3] - bbox[1]) > MAX_BBOX_SPAN_DEG;
    let solutions = [];
    try {
        solutions = await listAllSolutions({
            api: base, city, bbox: wide ? null : bbox, fetchImpl, log
        });
    } catch (error) {
        // A report that silently forgets stored work is worse than one that says it could not look.
        log?.(`stored solutions unavailable (${error.message}); reporting derivation only`);
        return { settled, solutions: 0, consulted: 0 };
    }

    // Only the kinds that carry a decision. A deterministic solution is a snapshot of what the rules
    // already say, so counting it would credit the same derivation twice.
    const decided = solutions
        .filter(solution => solution.sourceKind !== 'deterministic')
        .filter(solution => !wide || !Array.isArray(bbox) || overlaps(solution.bbox, bbox));
    let consulted = 0;
    for (const solution of decided) {
        try {
            const response = await fetchImpl(`${base}/lane-topology/solutions/${solution.id}`,
                { signal: AbortSignal.timeout(60_000) });
            if (!response.ok) continue;
            const stored = (await response.json()).solution;
            const graph = stored?.graph;
            if (!graph) continue;
            if (stored.parentId != null) {
                const parentResponse = await fetchImpl(`${base}/lane-topology/solutions/${stored.parentId}`,
                    { signal: AbortSignal.timeout(60_000) });
                // A missing parent means the safety comparison cannot be made. Do not credit an
                // answer whose regression status is unknowable.
                if (!parentResponse.ok) continue;
                const parent = (await parentResponse.json()).solution;
                if (!parent?.graph || isUnsafeComparedWithParent(stored, parent)) continue;
            }
            consulted += 1;
            // A model may connect lanes yet explicitly report a node-level topology error.
            // Such a junction still needs work, even if its unresolved note was removed.
            const stillOpen = new Set((graph.problems || [])
                .filter(problem => problem.type === 'unresolved_intersection'
                    || problem.severity === 'error')
                .flatMap(problem => problem.nodeIds || []));
            nodesWithMissingIncomingAssignments(graph).forEach(nodeId => stillOpen.add(nodeId));
            (graph.connections || []).forEach(connection => {
                if (!stillOpen.has(connection.nodeId)) settled.add(connection.nodeId);
            });
        } catch (_) {
            // One unreadable solution must not lose the rest.
        }
    }
    return { settled, solutions: decided.length, consulted };
}
