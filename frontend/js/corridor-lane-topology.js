// Connects painted lane-divider paths across corridor segments. Curbs participate as virtual
// ancestors, so widening keeps the established middle lanes continuous and adds lanes at the sides.

(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.CorridorLaneTopology = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const DEFAULT_TRANSITION_LENGTH_M = 28;
    const ENDPOINT_KEY_PRECISION = 2;
    const MIN_CONTINUATION_DOT = Math.cos(Math.PI / 4);

    function cleanPoints(points) {
        return (points || [])
            .filter(point => Array.isArray(point)
                && Number.isFinite(Number(point[0]))
                && Number.isFinite(Number(point[1])))
            .map(point => [Number(point[0]), Number(point[1])])
            .filter((point, index, all) => (
                index === 0
                || Math.hypot(point[0] - all[index - 1][0], point[1] - all[index - 1][1]) >= 0.05
            ));
    }

    function pointsWithArcs(points) {
        let arc = 0;
        return cleanPoints(points).map((point, index, all) => {
            if (index > 0) {
                arc += Math.hypot(point[0] - all[index - 1][0], point[1] - all[index - 1][1]);
            }
            return { x: point[0], y: point[1], arc };
        });
    }

    function endpointKey(point) {
        return `${Number(point[0]).toFixed(ENDPOINT_KEY_PRECISION)},${Number(point[1]).toFixed(ENDPOINT_KEY_PRECISION)}`;
    }

    function endpointDescriptor(entry, side) {
        const atStart = side === 'start';
        const endpoint = entry.centerline[atStart ? 0 : entry.centerline.length - 1];
        const neighbor = entry.centerline[atStart ? 1 : entry.centerline.length - 2];
        const dx = neighbor[0] - endpoint[0];
        const dy = neighbor[1] - endpoint[1];
        const length = Math.hypot(dx, dy);
        if (length < 0.05) return null;
        return {
            entry,
            side,
            key: endpointKey(endpoint),
            outwardX: dx / length,
            outwardY: dy / length,
        };
    }

    function continuationScore(a, b) {
        if (a.entry === b.entry) return -Infinity;
        const oppositeDot = -(a.outwardX * b.outwardX + a.outwardY * b.outwardY);
        if (oppositeDot < MIN_CONTINUATION_DOT) return -Infinity;
        const sameCorridor = a.entry.corridorId != null
            && b.entry.corridorId != null
            && a.entry.corridorId === b.entry.corridorId;
        const sameFlow = a.entry.flowDirection
            && b.entry.flowDirection
            && a.entry.flowDirection === b.entry.flowDirection;
        const differentFlow = a.entry.flowDirection
            && b.entry.flowDirection
            && a.entry.flowDirection !== b.entry.flowDirection;
        return oppositeDot + (sameCorridor ? 2 : 0) + (sameFlow ? 0.5 : 0) - (differentFlow ? 0.5 : 0);
    }

    function pairContinuationEndpoints(entries) {
        const byNode = new Map();
        entries.forEach(entry => {
            ['start', 'end'].forEach(side => {
                const endpoint = endpointDescriptor(entry, side);
                if (!endpoint) return;
                if (!byNode.has(endpoint.key)) byNode.set(endpoint.key, []);
                byNode.get(endpoint.key).push(endpoint);
            });
        });
        const pairs = [];
        byNode.forEach(endpoints => {
            const candidates = [];
            for (let left = 0; left < endpoints.length; left += 1) {
                for (let right = left + 1; right < endpoints.length; right += 1) {
                    const score = continuationScore(endpoints[left], endpoints[right]);
                    if (Number.isFinite(score)) {
                        candidates.push({ a: endpoints[left], b: endpoints[right], score });
                    }
                }
            }
            candidates.sort((a, b) => b.score - a.score);
            const used = new Set();
            candidates.forEach(candidate => {
                if (used.has(candidate.a) || used.has(candidate.b)) return;
                used.add(candidate.a);
                used.add(candidate.b);
                pairs.push([candidate.a, candidate.b]);
            });
        });
        return pairs;
    }

    function pathEndpoint(path, side) {
        return path[side === 'start' ? 0 : path.length - 1];
    }

    function endpointDistance(a, b) {
        return Math.hypot(b.x - a.x, b.y - a.y);
    }

    function endpointMatchCost(sourcePoints, sourceIndexes, targetPoints, targetIndexes) {
        return sourceIndexes.reduce((total, sourceIndex, orderIndex) => (
            total + endpointDistance(
                sourcePoints[sourceIndex],
                targetPoints[targetIndexes[orderIndex]],
            )
        ), 0);
    }

    function edgeAwareTargetIndexCandidates(sourceIndexes, targetPoints) {
        if (targetPoints.length <= sourceIndexes.length) {
            return [targetPoints.map((_, index) => index)];
        }
        const withoutRightEdge = targetPoints
            .slice(0, sourceIndexes.length)
            .map((_, index) => index);
        const withoutLeftEdge = targetPoints
            .slice(targetPoints.length - sourceIndexes.length)
            .map((_, index) => targetPoints.length - sourceIndexes.length + index);
        return [withoutRightEdge, withoutLeftEdge];
    }

    function chooseOrderedEndpointMatches(
        sourcePaths,
        sourceSide,
        targetPaths,
        targetSide,
        preferredExpansionEdgeSourceIndex,
    ) {
        const sourcePoints = sourcePaths.map(path => pathEndpoint(path.points, sourceSide));
        const targetPoints = targetPaths.map(path => pathEndpoint(path.points, targetSide));
        if (!sourcePoints.length || !targetPoints.length) {
            return { sourcePoints, targetPoints, matches: [], expansionEdgeSourceIndex: null };
        }
        const matchCount = Math.min(sourcePoints.length, targetPoints.length);
        const sourceIndexes = sourcePaths
            .map((path, index) => ({ index, centrality: Math.abs(path.offset) }))
            .sort((a, b) => a.centrality - b.centrality || a.index - b.index)
            .slice(0, matchCount)
            .map(item => item.index)
            .sort((a, b) => a - b);
        const isOneLaneExpansion = targetPaths.length === sourcePaths.length + 1;
        const configurations = [];
        edgeAwareTargetIndexCandidates(sourceIndexes, targetPoints).forEach(targetIndexes => {
            [targetIndexes, [...targetIndexes].reverse()].forEach(orderedTargetIndexes => {
                const matches = sourceIndexes.map((sourceIndex, orderIndex) => ({
                    sourceIndex,
                    targetIndex: orderedTargetIndexes[orderIndex],
                }));
                const edgeMatch = isOneLaneExpansion
                    ? matches.find(match => targetPaths[match.targetIndex].kind === 'edge')
                    : null;
                configurations.push({
                    matches,
                    cost: endpointMatchCost(
                        sourcePoints,
                        sourceIndexes,
                        targetPoints,
                        orderedTargetIndexes,
                    ),
                    expansionEdgeSourceIndex: edgeMatch ? edgeMatch.sourceIndex : null,
                });
            });
        });
        configurations.sort((a, b) => {
            const aPreferred = Number.isInteger(preferredExpansionEdgeSourceIndex)
                && a.expansionEdgeSourceIndex === preferredExpansionEdgeSourceIndex;
            const bPreferred = Number.isInteger(preferredExpansionEdgeSourceIndex)
                && b.expansionEdgeSourceIndex === preferredExpansionEdgeSourceIndex;
            if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;
            if (Math.abs(a.cost - b.cost) > 0.05) return a.cost - b.cost;
            return (
                (a.expansionEdgeSourceIndex ?? Number.MAX_SAFE_INTEGER)
                - (b.expansionEdgeSourceIndex ?? Number.MAX_SAFE_INTEGER)
            );
        });
        return {
            sourcePoints,
            targetPoints,
            matches: configurations[0].matches,
            expansionEdgeSourceIndex: configurations[0].expansionEdgeSourceIndex,
        };
    }

    function setEndpointTargets(source, target, targetBoundaries) {
        const targetPaths = targetBoundaries ? target.entry.boundaryPaths : target.entry.paths;
        const selected = chooseOrderedEndpointMatches(
            source.entry.paths,
            source.side,
            targetPaths,
            target.side,
            source.entry.preferredExpansionEdgeSourceIndex,
        );
        if (!selected.sourcePoints.length || !selected.targetPoints.length) return;
        if (
            targetBoundaries
            && Number.isInteger(selected.expansionEdgeSourceIndex)
            && !Number.isInteger(source.entry.preferredExpansionEdgeSourceIndex)
        ) {
            source.entry.preferredExpansionEdgeSourceIndex = selected.expansionEdgeSourceIndex;
        }
        const targets = selected.sourcePoints.map(() => null);
        const usedSources = new Set();
        selected.matches.forEach(match => {
            const point = selected.targetPoints[match.targetIndex];
            targets[match.sourceIndex] = { x: point.x, y: point.y };
            usedSources.add(match.sourceIndex);
        });
        const branches = selected.sourcePoints.map(() => null);
        selected.sourcePoints.forEach((sourcePoint, sourceIndex) => {
            if (targets[sourceIndex]) return;
            let nearest = null;
            usedSources.forEach(parentIndex => {
                const distance = endpointDistance(sourcePoint, selected.sourcePoints[parentIndex]);
                if (!nearest || distance < nearest.distance) nearest = { parentIndex, distance };
            });
            branches[sourceIndex] = nearest ? nearest.parentIndex : null;
        });
        source.entry.endpointTargets[source.side] = targets;
        source.entry.endpointBranches[source.side] = branches;
    }

    function assignTransitionTargets(a, b) {
        const aLaneCount = Math.max(0, a.entry.boundaryPaths.length - 1);
        const bLaneCount = Math.max(0, b.entry.boundaryPaths.length - 1);
        if (aLaneCount && bLaneCount && aLaneCount !== bLaneCount) {
            if (aLaneCount > bLaneCount) setEndpointTargets(a, b, true);
            else setEndpointTargets(b, a, true);
            return;
        }
        if (a.entry.paths.length >= b.entry.paths.length) setEndpointTargets(a, b, false);
        else setEndpointTargets(b, a, false);
    }

    function interpolatePathPoint(from, to, arc) {
        const span = to.arc - from.arc;
        if (span <= 1e-9) return { ...from, arc };
        const progress = (arc - from.arc) / span;
        return {
            x: from.x + (to.x - from.x) * progress,
            y: from.y + (to.y - from.y) * progress,
            arc,
        };
    }

    function pointAtArc(path, arc) {
        if (arc <= path[0].arc) return { ...path[0], arc };
        if (arc >= path[path.length - 1].arc) return { ...path[path.length - 1], arc };
        for (let index = 0; index + 1 < path.length; index += 1) {
            if (path[index + 1].arc + 1e-9 < arc) continue;
            return interpolatePathPoint(path[index], path[index + 1], arc);
        }
        return { ...path[path.length - 1], arc };
    }

    function applyEndpointTarget(path, side, target, transitionLengthM) {
        if (!target || path.length < 2) return;
        const endpointIndex = side === 'start' ? 0 : path.length - 1;
        const endpointArc = path[endpointIndex].arc;
        const dx = target.x - path[endpointIndex].x;
        const dy = target.y - path[endpointIndex].y;
        path.forEach(point => {
            const distance = Math.abs(point.arc - endpointArc);
            if (distance >= transitionLengthM) return;
            const progress = distance / transitionLengthM;
            const weight = 1 - progress * progress * (3 - 2 * progress);
            point.x += dx * weight;
            point.y += dy * weight;
        });
    }

    function applyEndpointBranch(path, parentPath, side, transitionLengthM) {
        if (!parentPath || path.length < 2 || parentPath.length < 2) return;
        const endpointIndex = side === 'start' ? 0 : path.length - 1;
        const endpointArc = path[endpointIndex].arc;
        path.forEach(point => {
            const distance = Math.abs(point.arc - endpointArc);
            if (distance >= transitionLengthM) return;
            const progress = distance / transitionLengthM;
            const weight = 1 - progress * progress * (3 - 2 * progress);
            const parentPoint = pointAtArc(parentPath, point.arc);
            point.x += (parentPoint.x - point.x) * weight;
            point.y += (parentPoint.y - point.y) * weight;
        });
    }

    function prepareEntry(rawEntry, topologyIndex) {
        const centerline = cleanPoints(rawEntry && rawEntry.centerline);
        if (centerline.length < 2) return null;
        const preparePaths = paths => (paths || []).map(path => ({
            ...path,
            offset: Number(path.offset),
            points: pointsWithArcs(path.points),
        })).filter(path => Number.isFinite(path.offset) && path.points.length >= 2);
        return {
            rawEntry,
            topologyIndex,
            corridorId: rawEntry.corridorId == null ? null : String(rawEntry.corridorId),
            flowDirection: rawEntry.flowDirection || null,
            centerline,
            paths: preparePaths(rawEntry.paths),
            boundaryPaths: preparePaths(rawEntry.boundaryPaths),
            endpointTargets: { start: null, end: null },
            endpointBranches: { start: null, end: null },
            preferredExpansionEdgeSourceIndex: null,
        };
    }

    function build(entries, options) {
        const transitionLengthM = Math.max(
            5,
            Number(options && options.transitionLengthM) || DEFAULT_TRANSITION_LENGTH_M,
        );
        const prepared = (entries || [])
            .map((entry, index) => prepareEntry(entry, index))
            .filter(Boolean);
        pairContinuationEndpoints(prepared).forEach(pair => assignTransitionTargets(pair[0], pair[1]));
        prepared.forEach(entry => {
            ['start', 'end'].forEach(side => {
                const targets = entry.endpointTargets[side];
                if (!targets) return;
                entry.paths.forEach((path, index) => {
                    applyEndpointTarget(path.points, side, targets[index], transitionLengthM);
                });
            });
        });
        prepared.forEach(entry => {
            ['start', 'end'].forEach(side => {
                const branches = entry.endpointBranches[side];
                if (!branches) return;
                entry.paths.forEach((path, index) => {
                    const parentIndex = branches[index];
                    if (!Number.isInteger(parentIndex)) return;
                    applyEndpointBranch(
                        path.points,
                        entry.paths[parentIndex] && entry.paths[parentIndex].points,
                        side,
                        transitionLengthM,
                    );
                });
            });
        });
        return prepared.map(entry => ({
            sourceIndex: entry.topologyIndex,
            paths: entry.paths.map(path => ({
                offset: path.offset,
                kind: path.kind || 'lane',
                points: path.points.map(point => [point.x, point.y]),
            })),
        }));
    }

    function splitDashedPolyline(points, dash) {
        const clean = cleanPoints(points);
        const on = Number(dash && dash.on);
        const off = Number(dash && dash.off);
        if (clean.length < 2 || !Number.isFinite(on) || on <= 0 || !Number.isFinite(off) || off < 0) {
            return [];
        }
        const period = on + off;
        const segments = [];
        let cumulative = 0;
        for (let index = 0; index < clean.length - 1; index += 1) {
            const a = clean[index];
            const b = clean[index + 1];
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const length = Math.hypot(dx, dy);
            if (length < 1e-9) continue;
            const ux = dx / length;
            const uy = dy / length;
            let distance = 0;
            while (distance < length - 1e-9) {
                const phase = (cumulative + distance) % period;
                const painting = phase < on;
                const remaining = painting ? on - phase : period - phase;
                const end = Math.min(length, distance + remaining);
                if (painting && end > distance + 1e-9) {
                    segments.push([
                        [a[0] + ux * distance, a[1] + uy * distance],
                        [a[0] + ux * end, a[1] + uy * end],
                    ]);
                }
                distance = end;
            }
            cumulative += length;
        }
        return segments;
    }

    return {
        DEFAULT_TRANSITION_LENGTH_M,
        build,
        splitDashedPolyline,
    };
});
