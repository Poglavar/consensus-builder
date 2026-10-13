// Combines compatible saved junction answers with the current directed OSM lane graph.
// Complete junctions replace the base atomically; partial answers only fill unassigned lanes.

export function publicCarLane(lane) {
    return lane?.type === 'driving' && !lane.centreLane && lane.direction !== 'both'
        && [null, undefined, '', 'yes', 'permissive', 'designated'].includes(lane.access);
}

// Signal locations come from OSM nodes, never junction degree or a nearby-road guess.
// Lane stop positions are projections onto the matching source way, clipped to its display portal.
export function mapTrafficSignals(signalNodes, sections, lanes) {
    const bySection = new Map(sections.map(section => [section.id, section]));
    const wayIds = new Set(lanes.map(lane => String(lane.sourceWayId)));
    return signalNodes.filter(signal => (signal.tags.highway === 'traffic_signals'
        || signal.tags.highway === 'crossing' && (signal.tags.crossing === 'traffic_signals'
            || signal.tags['crossing:signals'] === 'yes'))
        && signal.wayIds.some(id => wayIds.has(String(id)))).map(signal => {
        const direction = signal.tags['traffic_signals:direction'] || signal.tags.direction || 'both';
        const sourceWays = new Set(signal.wayIds.map(String));
        const controls = [];
        const scale = 111320 * Math.cos(signal.point[1] * Math.PI / 180);
        const project = p => [(p[0] - signal.point[0]) * scale, (p[1] - signal.point[1]) * 111320];
        for (const lane of lanes) {
            if (!sourceWays.has(String(lane.sourceWayId)) || !['both', lane.direction].includes(direction)
                || lane.fromNode === signal.id) continue;
            const section = bySection.get(lane.sectionId);
            // Way membership alone is insufficient: the node must occur in this section.
            if (!section?.coordinates.some(p => Math.hypot(...project(p)) < .02)) continue;
            const points = lane.geometry.coordinates.map(project);
            let total = 0, nearest = Infinity, along = 0;
            for (let i = 1; i < points.length; i++) {
                const a = points[i - 1], b = points[i], dx = b[0] - a[0], dy = b[1] - a[1];
                const length = Math.hypot(dx, dy);
                const t = length ? Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / (length * length))) : 0;
                const distance = Math.hypot(a[0] + dx * t, a[1] + dy * t);
                if (distance < nearest) { nearest = distance; along = total + t * length; }
                total += length;
            }
            if (total > 0) controls.push({ laneId: lane.id, fraction: lane.toNode === signal.id ? 1 : along / total });
        }
        return {
            id: signal.id, point: signal.point, direction,
            kind: signal.tags.highway === 'traffic_signals' ? 'traffic_signals' : 'signalised_crossing',
            sourceWayIds: [...sourceWays], controls
        };
    });
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
    const partial = new Map();
    const baseAssigned = new Set(base.connections.map(connection => connection.fromLaneId));
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
        const errors = (graph.problems || []).filter(problem => problem.severity === 'error'
            && problem.type !== 'unresolved_intersection');
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
            if (!baseNodes.has(nodeId) || chosen.has(nodeId) || humanNodes.has(nodeId)) continue;
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
            if (!open.has(nodeId)) {
                chosen.set(nodeId, { solution, connections: remapped });
            } else {
                // An unanswered lane must not erase a checked answer for another lane. Preserve
                // existing base movements and keep the node unresolved; never synthesize a turn.
                const unsafe = errors.some(problem => (problem.nodeIds || []).includes(nodeId)
                    || stored.some(lane => (problem.laneIds || []).includes(lane.id)
                        || (problem.sectionIds || []).includes(lane.sectionId)));
                if (unsafe) continue;
                const fromLanes = new Set(remapped.map(connection => connection.fromLaneId));
                for (const laneId of fromLanes) {
                    if (baseAssigned.has(laneId) || partial.has(laneId)) continue;
                    partial.set(laneId, { nodeId, laneId, solution,
                        connections: remapped.filter(connection => connection.fromLaneId === laneId) });
                }
            }
        }
    }
    const usedPartial = [...partial.values()].filter(item => !chosen.has(item.nodeId));
    const savedConnections = ({ solution, connections }) => connections.map(connection => ({
        ...connection, savedSolutionId: String(solution.id), savedSource: solution.sourceKind
    }));
    const connections = base.connections.filter(connection => !chosen.has(connection.nodeId))
        .concat([...chosen.values(), ...usedPartial].flatMap(savedConnections));
    const partialJunctions = new Map();
    for (const { nodeId, laneId, solution } of usedPartial) {
        const key = `${nodeId}:${solution.id}`;
        if (!partialJunctions.has(key)) partialJunctions.set(key, {
            nodeId, solutionId: String(solution.id), source: solution.sourceKind,
            status: solution.status, createdAt: solution.createdAt, laneIds: []
        });
        partialJunctions.get(key).laneIds.push(laneId);
    }
    return {
        ...base, connections,
        problems: base.problems.filter(problem => problem.type !== 'unresolved_intersection'
            || !(problem.nodeIds || []).every(id => chosen.has(id))),
        savedPartialJunctions: [...partialJunctions.values()],
        savedJunctions: [...chosen].map(([nodeId, { solution }]) => ({
            nodeId, solutionId: String(solution.id), source: solution.sourceKind,
            status: solution.status, createdAt: solution.createdAt
        }))
    };
}
