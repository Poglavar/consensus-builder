// Pure guards for model selection, topology regression and prepaid batch budgets.
import { isUnsafeComparedWithParent, nodesWithMissingIncomingAssignments } from './stored-solutions.js';

export const TIERS = ['standard', 'advanced', 'hardest'];

export function bboxAroundPoints(points, radius = 70) {
    if (!points.length || !Number.isFinite(radius) || radius <= 0
        || points.some(p => !Array.isArray(p) || p.length !== 2 || p.some(n => !Number.isFinite(n)) || Math.abs(p[0]) > 180 || Math.abs(p[1]) >= 85)) {
        throw new Error('Invalid junction coordinates');
    }
    const latitude = Math.max(...points.map(p => Math.abs(p[1])));
    const dy = radius / 111_320, dx = dy / Math.cos(latitude * Math.PI / 180);
    return [Math.min(...points.map(p => p[0])) - dx, Math.min(...points.map(p => p[1])) - dy,
        Math.max(...points.map(p => p[0])) + dx, Math.max(...points.map(p => p[1])) + dy]
        .map(n => Number(n.toFixed(7)));
}

export function initialTier(junction) {
    const reasons = (junction.problems || []).map(p => p.reason);
    if (junction.arms >= 8 || junction.lanes >= 60 || junction.nodeIds?.length >= 4
        || reasons.some(r => /centre|approach_reaches_nothing|ambiguous_arm/.test(r || ''))) return 'hardest';
    if (junction.arms > 4 || junction.lanes > 30 || junction.nodeIds?.length > 1) return 'advanced';
    return 'standard';
}

export function openTargets(graph, targetNodeIds) {
    const missing = nodesWithMissingIncomingAssignments(graph);
    const open = new Set((graph.problems || [])
        .filter(p => p.type === 'unresolved_intersection' || p.severity === 'error')
        .flatMap(p => p.nodeIds || []));
    const connected = new Set((graph.connections || []).map(c => c.nodeId));
    return targetNodeIds.filter(id => open.has(id) || missing.has(id) || !connected.has(id));
}

export function safeTransition(parent, child) {
    const describe = graph => ({ graph, stats: graph.stats,
        errorProblemKeys: (graph.problems || []).filter(p => p.severity === 'error').map(p => p.id) });
    return !isUnsafeComparedWithParent(describe(child), describe(parent));
}

export function budgetedPrefix(items, remaining) {
    if (!Number.isFinite(remaining) || remaining < 0) throw new Error('Invalid remaining budget');
    const selected = [];
    let reserved = 0;
    for (const item of items) {
        if (!Number.isFinite(item.ceilingUsd) || item.ceilingUsd < 0) throw new Error('Unknown batch ceiling');
        if (reserved + item.ceilingUsd > remaining + 1e-9) break;
        selected.push(item); reserved += item.ceilingUsd;
    }
    return { selected, reserved };
}

export function pilotMadeProgress(attempts) {
    return attempts.some(a => a.safe && !a.error
        && Number.isInteger(a.remainingBefore) && Number.isInteger(a.remainingAfter)
        && a.remainingAfter < a.remainingBefore);
}
