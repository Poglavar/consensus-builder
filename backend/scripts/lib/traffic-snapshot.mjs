// Combines compatible saved junction answers with the current directed OSM lane graph.
// A whole junction is replaced atomically; incomplete answers never invent missing movements.

export function publicCarLane(lane) {
    return lane?.type === 'driving' && !lane.centreLane && lane.direction !== 'both'
        && [null, undefined, '', 'yes', 'permissive', 'designated'].includes(lane.access);
}

function incidentLanes(graph, nodeId) {
    return graph.lanes.filter(lane => lane.fromNode === nodeId || lane.toNode === nodeId);
}

function sameLane(a, b, nodeId) {
    // Section IDs contain a split ordinal that changes with viewport extent. Match the directed
    // incidence at THIS node; a remote endpoint is not part of a junction's lane assignment.
    return a && b && (a.fromNode === nodeId) === (b.fromNode === nodeId)
        && (a.toNode === nodeId) === (b.toNode === nodeId)
        && !!a.centreLane === !!b.centreLane
        && ['sourceWayId', 'direction', 'ordinal', 'type', 'access', 'turn', 'change']
            .every(key => (a[key] ?? null) === (b[key] ?? null));
}

export function mergeSavedJunctions(base, solutions, { isUnsafe, missingNodes }) {
    const byId = new Map(solutions.map(solution => [String(solution.id), solution]));
    const baseLanes = new Map(base.lanes.map(lane => [lane.id, lane]));
    const baseNodes = new Set(base.nodes.map(node => node.id));
    const chosen = new Map();
    const humanNodes = new Set((base.decisions?.answered || []).map(answer => answer.nodeId));
    const ordered = [...solutions].filter(solution => solution.sourceKind !== 'deterministic')
        .sort((a, b) => Number(b.status === 'canonical') - Number(a.status === 'canonical')
            || Date.parse(b.createdAt) - Date.parse(a.createdAt) || Number(b.id) - Number(a.id));
    for (const solution of ordered) {
        if (!['candidate', 'canonical'].includes(solution.status) || !solution.graph
            || solution.stats?.forensicRecovery?.originalProblemRowsVerified === false) continue;
        if (solution.parentId != null) {
            const parent = byId.get(String(solution.parentId));
            if (!parent?.graph || isUnsafe(solution, parent)) continue;
        }
        const graph = solution.graph;
        const open = missingNodes(graph);
        for (const problem of graph.problems || []) {
            if (problem.type === 'unresolved_intersection' || problem.severity === 'error') {
                for (const id of problem.nodeIds || []) open.add(id);
            }
        }
        const grouped = new Map();
        for (const connection of graph.connections || []) {
            if (!grouped.has(connection.nodeId)) grouped.set(connection.nodeId, []);
            grouped.get(connection.nodeId).push(connection);
        }
        for (const [nodeId, connections] of grouped) {
            if (!baseNodes.has(nodeId) || chosen.has(nodeId) || open.has(nodeId) || humanNodes.has(nodeId)) continue;
            const current = incidentLanes(base, nodeId);
            const stored = incidentLanes(graph, nodeId);
            // A clipped viewport or changed source must not erase an approach that exists today.
            if (current.length !== stored.length) continue;
            const matches = stored.map(lane => [lane.id, current.filter(candidate => sameLane(candidate, lane, nodeId))]);
            if (matches.some(([, candidates]) => candidates.length !== 1)) continue;
            const mapping = new Map(matches.map(([id, candidates]) => [id, candidates[0].id]));
            if (new Set(mapping.values()).size !== current.length) continue;
            const remapped = connections.map(connection => ({ ...connection,
                fromLaneId: mapping.get(connection.fromLaneId), toLaneId: mapping.get(connection.toLaneId) }));
            if (!remapped.every(connection => baseLanes.get(connection.fromLaneId)?.toNode === nodeId
                && baseLanes.get(connection.toLaneId)?.fromNode === nodeId)) continue;
            chosen.set(nodeId, { solution, connections: remapped });
        }
    }
    const connections = base.connections.filter(connection => !chosen.has(connection.nodeId))
        .concat([...chosen.values()].flatMap(({ solution, connections: saved }) => saved.map(connection => ({
            ...connection, savedSolutionId: String(solution.id), savedSource: solution.sourceKind
        }))));
    return {
        ...base, connections,
        problems: base.problems.filter(problem => problem.type !== 'unresolved_intersection'
            || !(problem.nodeIds || []).every(id => chosen.has(id))),
        savedJunctions: [...chosen].map(([nodeId, { solution }]) => ({
            nodeId, solutionId: String(solution.id), source: solution.sourceKind,
            status: solution.status, createdAt: solution.createdAt
        }))
    };
}
