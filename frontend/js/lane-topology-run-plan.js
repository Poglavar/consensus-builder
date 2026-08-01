// Describes a recognition run BEFORE it is launched: the exact request body that will be posted,
// what the model will be given, which junctions it will actually solve, and anything that would
// make the run fail or be pointless. A CLI run costs minutes and money, so the answer to "what is
// this solving?" has to be available before pressing Run, not after it finishes.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.LaneTopologyRunPlan = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function featureBbox(feature) {
        const coordinates = feature?.geometry?.coordinates;
        if (!Array.isArray(coordinates) || !coordinates.length) return null;
        const flat = typeof coordinates[0][0] === 'number' ? coordinates : coordinates.flat();
        let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
        flat.forEach(point => {
            const lng = Number(point?.[0]);
            const lat = Number(point?.[1]);
            if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
            west = Math.min(west, lng); east = Math.max(east, lng);
            south = Math.min(south, lat); north = Math.max(north, lat);
        });
        return Number.isFinite(west) ? [west, south, east, north] : null;
    }

    // Mirrors the backend's `geom && ST_MakeEnvelope(...)`: a way is in scope when it INTERSECTS the
    // bbox. The client holds evidence for a padded area, so previewing without this overstates the run.
    function evidenceForBbox(evidence, bbox) {
        const features = Array.isArray(evidence?.features) ? evidence.features : [];
        if (!Array.isArray(bbox) || bbox.length !== 4) return { ...evidence, features };
        const [west, south, east, north] = bbox.map(Number);
        return {
            ...evidence,
            features: features.filter(feature => {
                const box = featureBbox(feature);
                if (!box) return false;
                return box[0] <= east && box[2] >= west && box[1] <= north && box[3] >= south;
            })
        };
    }

    function imagerySummary(input) {
        if (!input?.imagery) return null;
        const crop = input.crop || null;
        return {
            key: input.imagery.key || null,
            label: input.imagery.label || input.imagery.key || 'orthophoto',
            width: crop?.width ?? null,
            height: crop?.height ?? null,
            effectiveGsdM: Number.isFinite(Number(crop?.effectiveGsdM))
                ? Number(crop.effectiveGsdM)
                : null,
            maxGsdM: Number(input.maxRecognitionGsdM) || null
        };
    }

    function buildRunPlan(input) {
        const provider = String(input?.provider || '');
        const bbox = Array.isArray(input?.bbox) ? input.bbox.map(Number) : null;
        const evidence = input?.evidence || null;
        const graph = input?.graph || null;
        const junctions = Array.isArray(input?.junctions) ? input.junctions : [];
        const imagery = imagerySummary(input);
        const stats = graph?.stats || {};

        const blockers = [];
        const warnings = [];

        if (!provider) blockers.push('No provider selected.');
        else if (input?.providerAvailable === false) blockers.push(`The ${provider} CLI is not available.`);
        if (!bbox) blockers.push('No area selected.');
        if (!evidence?.features?.length) blockers.push('No OSM evidence in this area — nothing to solve.');

        if (imagery) {
            const { effectiveGsdM, maxGsdM } = imagery;
            // An unsized crop must not quietly become "no imagery" — that is a different run.
            if (!Number.isFinite(effectiveGsdM)) {
                blockers.push('Could not size the orthophoto crop for this area.');
            } else if (Number.isFinite(maxGsdM) && effectiveGsdM > maxGsdM) {
                blockers.push(
                    `The orthophoto crop would be ${effectiveGsdM.toFixed(2)} m/px `
                    + `(maximum ${maxGsdM.toFixed(2)}). Zoom in, or run without imagery.`
                );
            }
        } else {
            warnings.push('No orthophoto attached — the model works from OSM tags alone.');
        }

        if (evidence?.truncated) {
            warnings.push(`Evidence hit the ${evidence.limit} way cap; part of this area is missing.`);
        }
        if (!junctions.length && evidence?.features?.length) {
            warnings.push('No unsolved junctions here — the run would have nothing to decide.');
        }

        return {
            provider,
            bbox,
            // Exactly what gets posted, so the review and the request cannot drift apart.
            request: {
                city: input?.city || 'zagreb',
                bbox,
                provider,
                imagerySource: imagery?.key || null,
                baseSolutionId: input?.parentSolution?.id || null
            },
            summary: {
                osmWays: evidence?.features?.length || 0,
                snapshotAt: evidence?.snapshotAt || null,
                sections: Number(stats.sections) || 0,
                nodes: Number(stats.nodes) || 0,
                lanes: Number(stats.lanes) || 0,
                connections: Number(stats.connections) || 0,
                unresolvedIntersections: Number(stats.unresolvedIntersections) || 0,
                junctionCount: junctions.length,
                junctions: junctions.map(junction => ({
                    name: junction.name,
                    armCount: junction.armCount,
                    nodeCount: junction.nodeIds?.length || 0
                })),
                imagery,
                // The server always builds a fresh deterministic graph for this bbox and parents it
                // to the current solution, so "base" is a new graph, not the one on screen.
                parentSolution: input?.parentSolution
                    ? { id: input.parentSolution.id, sourceKind: input.parentSolution.sourceKind || null }
                    : null,
                promptVersion: input?.promptVersion || null,
                providerVersion: input?.providerVersion || null
            },
            blockers,
            warnings,
            canRun: blockers.length === 0
        };
    }

    return { buildRunPlan, evidenceForBbox, featureBbox };
});
