import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    canonicalizeCorridorNetworkJunctions,
    corridorDistanceMeters,
    normalizeCorridorNetwork,
    projectCorridorPointToEdge
} = require('../../../frontend/js/corridor-geometry.js');

const pointLevel = point => (point && Number.isFinite(Number(point.level))) ? Number(point.level) : 0;
const flatEdgeLevel = (from, to) => pointLevel(from) === pointLevel(to) ? pointLevel(from) : null;
const pointKey = point => `${Number(point?.lat)},${Number(point?.lng)},${pointLevel(point)}`;
const baseStretchId = id => {
    const text = id === null || id === undefined ? '' : String(id);
    const split = text.indexOf('~');
    return split === -1 ? text : text.slice(0, split);
};

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function edgeRecords(entries) {
    const edges = [];
    entries.forEach((entry, entryIndex) => {
        (entry.segments || []).forEach((segment, segmentIndex) => {
            if (!Array.isArray(segment)) return;
            for (let edgeIndex = 0; edgeIndex < segment.length - 1; edgeIndex += 1) {
                const from = segment[edgeIndex];
                const to = segment[edgeIndex + 1];
                const lengthMeters = corridorDistanceMeters(from, to);
                if (!Number.isFinite(lengthMeters)) continue;
                edges.push({
                    entry,
                    entryIndex,
                    segment,
                    segmentIndex,
                    segmentId: Array.isArray(entry.segmentIds) ? (entry.segmentIds[segmentIndex] ?? null) : null,
                    edgeIndex,
                    from,
                    to,
                    fromKey: pointKey(from),
                    toKey: pointKey(to),
                    level: flatEdgeLevel(from, to),
                    lengthMeters
                });
            }
        });
    });
    return edges;
}

function degreeMap(edges) {
    const degree = new Map();
    edges.forEach(edge => {
        if (!(edge.lengthMeters > 0.001) || edge.fromKey === edge.toKey) return;
        degree.set(edge.fromKey, (degree.get(edge.fromKey) || 0) + 1);
        degree.set(edge.toKey, (degree.get(edge.toKey) || 0) + 1);
    });
    return degree;
}

function occurrencesByNode(entries) {
    const byNode = new Map();
    entries.forEach((entry, entryIndex) => {
        (entry.segments || []).forEach((segment, segmentIndex) => {
            (Array.isArray(segment) ? segment : []).forEach((point, pointIndex) => {
                const key = pointKey(point);
                if (!byNode.has(key)) byNode.set(key, []);
                byNode.get(key).push({ entry, entryIndex, segment, segmentIndex, pointIndex, point });
            });
        });
    });
    return byNode;
}

function pruneProfiles(entry) {
    if (!entry.segmentProfiles || typeof entry.segmentProfiles !== 'object') return;
    const live = new Set((entry.segmentIds || []).filter(id => id !== null && id !== undefined).map(String));
    Object.keys(entry.segmentProfiles).forEach(id => {
        if (!live.has(String(id))) delete entry.segmentProfiles[id];
    });
}

function removeDegenerateSegments(entries) {
    let droppedPoints = 0;
    let droppedSegments = 0;
    entries.forEach(entry => {
        const segments = [];
        const ids = [];
        (entry.segments || []).forEach((segment, index) => {
            const kept = [];
            (Array.isArray(segment) ? segment : []).forEach(point => {
                if (!kept.length || corridorDistanceMeters(kept[kept.length - 1], point) > 0.001) {
                    kept.push(point);
                } else {
                    droppedPoints += 1;
                }
            });
            if (kept.length < 2) {
                droppedSegments += 1;
                return;
            }
            segments.push(kept);
            ids.push(Array.isArray(entry.segmentIds) ? (entry.segmentIds[index] ?? null) : null);
        });
        entry.segments.splice(0, entry.segments.length, ...segments);
        if (!Array.isArray(entry.segmentIds)) entry.segmentIds = ids;
        else entry.segmentIds.splice(0, entry.segmentIds.length, ...ids);
        pruneProfiles(entry);
    });
    return { droppedPoints, droppedSegments };
}

export function auditRoadNetwork(entries, options = {}) {
    const microEdgeMeters = Number.isFinite(Number(options.microEdgeMeters))
        ? Number(options.microEdgeMeters)
        : 1;
    const edges = edgeRecords(entries).filter(edge => edge.lengthMeters > 0.001 && edge.fromKey !== edge.toKey);
    const degree = degreeMap(edges);
    const byNode = occurrencesByNode(entries);
    const adjacency = new Map();
    const nodeEntries = new Map();
    edges.forEach(edge => {
        if (!adjacency.has(edge.fromKey)) adjacency.set(edge.fromKey, new Set());
        if (!adjacency.has(edge.toKey)) adjacency.set(edge.toKey, new Set());
        adjacency.get(edge.fromKey).add(edge.toKey);
        adjacency.get(edge.toKey).add(edge.fromKey);
        [edge.fromKey, edge.toKey].forEach(key => {
            if (!nodeEntries.has(key)) nodeEntries.set(key, new Set());
            nodeEntries.get(key).add(edge.entry.proposalId || edge.entry.id || String(edge.entryIndex));
        });
    });

    const components = [];
    const visited = new Set();
    adjacency.forEach((_, start) => {
        if (visited.has(start)) return;
        const stack = [start];
        const nodes = [];
        const proposalIds = new Set();
        visited.add(start);
        while (stack.length) {
            const key = stack.pop();
            nodes.push(key);
            (nodeEntries.get(key) || []).forEach(id => proposalIds.add(id));
            (adjacency.get(key) || []).forEach(next => {
                if (visited.has(next)) return;
                visited.add(next);
                stack.push(next);
            });
        }
        components.push({ nodeCount: nodes.length, proposalIds: [...proposalIds].sort() });
    });
    components.sort((a, b) => b.nodeCount - a.nodeCount);

    const dangling = [...degree.entries()]
        .filter(([, value]) => value === 1)
        .map(([key]) => {
            const occurrence = (byNode.get(key) || [])[0];
            return {
                key,
                point: occurrence ? clone(occurrence.point) : null,
                proposalId: occurrence?.entry?.proposalId || null,
                title: occurrence?.entry?.title || null
            };
        });
    const microEdges = edges
        .filter(edge => edge.lengthMeters < microEdgeMeters)
        .map(edge => ({
            proposalId: edge.entry.proposalId || null,
            title: edge.entry.title || null,
            segmentId: edge.segmentId,
            lengthMeters: edge.lengthMeters,
            from: clone(edge.from),
            to: clone(edge.to)
        }));
    const duplicateCounts = new Map();
    edges.forEach(edge => {
        const ends = [edge.fromKey, edge.toKey].sort();
        const key = `${ends[0]}|${ends[1]}`;
        duplicateCounts.set(key, (duplicateCounts.get(key) || 0) + 1);
    });

    return {
        entryCount: entries.filter(entry => (entry.segments || []).length).length,
        segmentCount: entries.reduce((sum, entry) => sum + (entry.segments || []).length, 0),
        edgeCount: edges.length,
        nodeCount: degree.size,
        dangling,
        components,
        microEdges,
        duplicateEdgeCount: [...duplicateCounts.values()].filter(count => count > 1).length
    };
}

export function collapseMicroJunctions(entries, thresholdMeters = 1) {
    const edges = edgeRecords(entries);
    const microEdges = edges.filter(edge =>
        edge.level !== null
        && edge.lengthMeters > 0.001
        && edge.lengthMeters < thresholdMeters
        && edge.fromKey !== edge.toKey
    );
    if (!microEdges.length) return [];

    const parent = new Map();
    const find = key => {
        if (!parent.has(key)) parent.set(key, key);
        let root = key;
        while (parent.get(root) !== root) root = parent.get(root);
        while (parent.get(key) !== key) {
            const next = parent.get(key);
            parent.set(key, root);
            key = next;
        }
        return root;
    };
    const join = (a, b) => {
        const rootA = find(a);
        const rootB = find(b);
        if (rootA !== rootB) parent.set(rootB, rootA);
    };
    microEdges.forEach(edge => join(edge.fromKey, edge.toKey));

    const clusters = new Map();
    [...parent.keys()].forEach(key => {
        const root = find(key);
        if (!clusters.has(root)) clusters.set(root, new Set());
        clusters.get(root).add(key);
    });
    const degrees = degreeMap(edges);
    const occurrences = occurrencesByNode(entries);
    const longIncident = new Map();
    edges.filter(edge => edge.lengthMeters >= thresholdMeters).forEach(edge => {
        longIncident.set(edge.fromKey, (longIncident.get(edge.fromKey) || 0) + 1);
        longIncident.set(edge.toKey, (longIncident.get(edge.toKey) || 0) + 1);
    });

    const collapsed = [];
    clusters.forEach(keys => {
        const candidates = [...keys].map(key => ({
            key,
            point: (occurrences.get(key) || [])[0]?.point,
            longDegree: longIncident.get(key) || 0,
            degree: degrees.get(key) || 0,
            occurrences: (occurrences.get(key) || []).length
        })).filter(candidate => candidate.point);
        if (candidates.length < 2) return;
        candidates.sort((a, b) =>
            (b.longDegree - a.longDegree)
            || (b.degree - a.degree)
            || (b.occurrences - a.occurrences)
            || a.key.localeCompare(b.key)
        );
        const representative = candidates[0].point;
        candidates.slice(1).forEach(candidate => {
            (occurrences.get(candidate.key) || []).forEach(item => {
                item.point.lat = Number(representative.lat);
                item.point.lng = Number(representative.lng);
            });
        });
        collapsed.push({
            representative: clone(representative),
            nodeCount: candidates.length,
            // Every record carrying one of the collapsed coordinates moved, including a long arm
            // that merely met the micro-edge cluster. Those records need their footprints rebuilt.
            proposalIds: [...new Set(candidates.flatMap(candidate =>
                (occurrences.get(candidate.key) || []).map(item => item.entry.proposalId || null)
            ).filter(Boolean))].sort(),
            edgeLengthsMeters: microEdges
                .filter(edge => keys.has(edge.fromKey) && keys.has(edge.toKey))
                .map(edge => edge.lengthMeters)
                .sort((a, b) => a - b)
        });
    });
    removeDegenerateSegments(entries);
    return collapsed;
}

export function snapDanglingEndpoints(entries, toleranceMeters = 1) {
    const snaps = [];
    for (let pass = 0; pass < 1000; pass += 1) {
        normalizeCorridorNetwork(entries);
        const edges = edgeRecords(entries).filter(edge => edge.lengthMeters > 0.001 && edge.fromKey !== edge.toKey);
        const degree = degreeMap(edges);
        const nodes = occurrencesByNode(entries);
        const danglingKeys = [...degree.entries()].filter(([, value]) => value === 1).map(([key]) => key);
        let best = null;

        danglingKeys.forEach(sourceKey => {
            const sourceOccurrences = nodes.get(sourceKey) || [];
            const sourceOccurrence = sourceOccurrences[0];
            const source = sourceOccurrence?.point;
            if (!source) return;

            // Prefer an authored node when it is the closest target; otherwise project to an edge
            // and insert that exact projected coordinate into both owners.
            nodes.forEach((targetOccurrences, targetKey) => {
                if (targetKey === sourceKey || !targetOccurrences.length) return;
                const target = targetOccurrences[0].point;
                if (pointLevel(target) !== pointLevel(source)) return;
                const distance = corridorDistanceMeters(source, target);
                if (distance > toleranceMeters || (best && distance >= best.distance)) return;
                best = { kind: 'node', sourceKey, sourceOccurrences, source, target, distance };
            });

            edges.forEach(edge => {
                if (edge.fromKey === sourceKey || edge.toKey === sourceKey || edge.level !== pointLevel(source)) return;
                const projected = projectCorridorPointToEdge(source, edge.from, edge.to);
                if (!projected || projected.t <= 1e-9 || projected.t >= 1 - 1e-9) return;
                if (projected.distance > toleranceMeters || (best && projected.distance >= best.distance)) return;
                best = {
                    kind: 'edge',
                    sourceKey,
                    sourceOccurrences,
                    source,
                    edge,
                    target: projected.point,
                    distance: projected.distance
                };
            });
        });

        if (!best) break;
        const originalSource = clone(best.source);
        best.sourceOccurrences.forEach(item => {
            item.point.lat = Number(best.target.lat);
            item.point.lng = Number(best.target.lng);
        });
        if (best.kind === 'edge') {
            const inserted = best.edge.level
                ? { ...best.target, level: best.edge.level }
                : { ...best.target };
            best.edge.segment.splice(best.edge.edgeIndex + 1, 0, inserted);
        }
        snaps.push({
            kind: best.kind,
            distanceMeters: best.distance,
            proposalId: best.sourceOccurrences[0]?.entry?.proposalId || null,
            title: best.sourceOccurrences[0]?.entry?.title || null,
            from: originalSource,
            to: clone(best.target)
        });
        canonicalizeCorridorNetworkJunctions(entries);
        removeDegenerateSegments(entries);
    }
    return snaps;
}

export function pruneDanglingSegments(entries) {
    const removed = [];
    for (let pass = 0; pass < 1000; pass += 1) {
        normalizeCorridorNetwork(entries);
        const edges = edgeRecords(entries).filter(edge => edge.lengthMeters > 0.001 && edge.fromKey !== edge.toKey);
        const degree = degreeMap(edges);
        let changed = false;
        entries.forEach(entry => {
            let entryChanged = false;
            const keptSegments = [];
            const keptIds = [];
            (entry.segments || []).forEach((segment, index) => {
                const firstKey = pointKey(segment[0]);
                const lastKey = pointKey(segment[segment.length - 1]);
                if ((degree.get(firstKey) || 0) === 1 || (degree.get(lastKey) || 0) === 1) {
                    removed.push({
                        pass: pass + 1,
                        proposalId: entry.proposalId || null,
                        title: entry.title || null,
                        segmentId: Array.isArray(entry.segmentIds) ? (entry.segmentIds[index] ?? null) : null,
                        baseStretchId: baseStretchId(Array.isArray(entry.segmentIds) ? entry.segmentIds[index] : null),
                        lengthMeters: segment.slice(1).reduce(
                            (sum, point, pointIndex) => sum + corridorDistanceMeters(segment[pointIndex], point),
                            0
                        ),
                        points: clone(segment)
                    });
                    changed = true;
                    entryChanged = true;
                    return;
                }
                keptSegments.push(segment);
                keptIds.push(Array.isArray(entry.segmentIds) ? (entry.segmentIds[index] ?? null) : null);
            });
            if (!entryChanged) return;
            entry.segments.splice(0, entry.segments.length, ...keptSegments);
            if (!Array.isArray(entry.segmentIds)) entry.segmentIds = keptIds;
            else entry.segmentIds.splice(0, entry.segmentIds.length, ...keptIds);
            pruneProfiles(entry);
        });
        if (!changed) break;
        removeDegenerateSegments(entries);
    }
    return removed;
}

export function repairRoadNetwork(entries, options = {}) {
    const microEdgeMeters = Number.isFinite(Number(options.microEdgeMeters))
        ? Number(options.microEdgeMeters)
        : 1;
    const snapToleranceMeters = Number.isFinite(Number(options.snapToleranceMeters))
        ? Number(options.snapToleranceMeters)
        : 1;
    normalizeCorridorNetwork(entries);
    const collapsedJunctions = collapseMicroJunctions(entries, microEdgeMeters);
    normalizeCorridorNetwork(entries);
    const snaps = snapDanglingEndpoints(entries, snapToleranceMeters);
    normalizeCorridorNetwork(entries);
    const removedSegments = options.pruneDangling === false ? [] : pruneDanglingSegments(entries);
    normalizeCorridorNetwork(entries);
    removeDegenerateSegments(entries);
    return {
        collapsedJunctions,
        snaps,
        removedSegments,
        audit: auditRoadNetwork(entries, { microEdgeMeters })
    };
}
