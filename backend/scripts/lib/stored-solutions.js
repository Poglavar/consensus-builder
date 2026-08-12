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
const SOLUTION_LIMIT = 500;
// The solutions endpoint rejects a bbox wider than the builder's own ceiling, so a city-wide report
// must ask without one and narrow the list here instead. Asking with the city bbox returned HTTP 400
// and the whole survey quietly fell back to derivation only.
const MAX_BBOX_SPAN_DEG = 0.08;

function overlaps(a, b) {
    return Array.isArray(a) && Array.isArray(b)
        && a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

export async function settledNodeIndex({ api, city = 'zagreb', bbox, fetchImpl = fetch, log }) {
    const settled = new Set();
    const base = String(api).replace(/\/+$/, '');
    const wide = !Array.isArray(bbox)
        || (bbox[2] - bbox[0]) > MAX_BBOX_SPAN_DEG
        || (bbox[3] - bbox[1]) > MAX_BBOX_SPAN_DEG;
    const listUrl = `${base}/lane-topology/solutions?city=${encodeURIComponent(city)}`
        + (wide ? '' : `&bbox=${bbox.join(',')}`)
        + `&limit=${SOLUTION_LIMIT}`;
    let solutions = [];
    try {
        const response = await fetchImpl(listUrl, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        solutions = (await response.json()).solutions || [];
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
            const graph = (await response.json()).solution?.graph;
            if (!graph) continue;
            consulted += 1;
            const stillOpen = new Set((graph.problems || [])
                .filter(problem => problem.type === 'unresolved_intersection')
                .flatMap(problem => problem.nodeIds || []));
            (graph.connections || []).forEach(connection => {
                if (!stillOpen.has(connection.nodeId)) settled.add(connection.nodeId);
            });
        } catch (_) {
            // One unreadable solution must not lose the rest.
        }
    }
    return { settled, solutions: decided.length, consulted };
}
