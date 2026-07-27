// Ground treatment for freeform building proposals: the parcel area left over AROUND the placed
// buildings, rendered either as paving (like a square) or as grass (like a park). One setting per
// proposal covers the whole merged parcel area, whatever the building count. Pure turf read from
// the runtime global — plain GeoJSON in and out, no DOM and no map, so it is unit-testable
// headlessly. Rendering lives in structures.js (2D), three-mode.js (model) and photoreal-mode.js.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.BuildingGround = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // 'none' is the default: the surroundings are left exactly as they are today.
    const TREATMENTS = ['none', 'paved', 'green'];

    // Below this the leftover ring is a slither of rounding error, not a surface worth drawing.
    const MIN_SURFACE_AREA_M2 = 2;

    // The 2D fill of each treatment, matching the square paving and park grass in structures.js —
    // one definition for the map layer and for the freeform editor's live preview.
    const SURFACE_STYLE_2D = {
        paved: { color: '#666666', fillColor: '#bdbdbd', fillOpacity: 0.7 },
        green: { color: '#0d3b1f', fillColor: '#1b5e20', fillOpacity: 0.65 }
    };

    function normalizeTreatment(value) {
        const key = String(value == null ? '' : value).trim().toLowerCase();
        return TREATMENTS.indexOf(key) > 0 ? key : 'none';
    }

    function asFeature(input) {
        if (!input || typeof input !== 'object') return null;
        const geometry = input.type === 'Feature' ? input.geometry : input;
        if (!geometry || !geometry.type || !Array.isArray(geometry.coordinates)) return null;
        if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') return null;
        return { type: 'Feature', properties: {}, geometry: geometry };
    }

    function geometryArea(geometry) {
        const feature = asFeature(geometry);
        if (!feature || typeof turf === 'undefined' || typeof turf.area !== 'function') return 0;
        try { return Number(turf.area(feature)) || 0; } catch (_) { return 0; }
    }

    // The surround polygon: the proposal's merged parcel area minus every building footprint on it.
    // `blockFeature` is the same union the freeform editor validates footprints against, so the
    // surface and the "must stay inside the block" rule always agree.
    function computeSurfacePolygon(blockFeature, buildingFeatures) {
        if (typeof turf === 'undefined' || typeof turf.difference !== 'function') return null;
        let surface = asFeature(blockFeature);
        if (!surface) return null;
        const buildings = Array.isArray(buildingFeatures) ? buildingFeatures : [];
        for (let i = 0; i < buildings.length && surface; i++) {
            const cutter = asFeature(buildings[i]);
            if (!cutter) continue;
            try { surface = turf.difference(surface, cutter); } catch (_) { /* keep what we have */ }
        }
        if (!surface || !surface.geometry) return null;
        if (geometryArea(surface.geometry) < MIN_SURFACE_AREA_M2) return null;
        try { return JSON.parse(JSON.stringify(surface.geometry)); } catch (_) { return surface.geometry; }
    }

    // { treatment, polygon } as it is persisted on the proposal, or null when the proposal leaves
    // its surroundings unchanged (the default, and every proposal made before this feature).
    function buildSurface(treatment, blockFeature, buildingFeatures) {
        const normalized = normalizeTreatment(treatment);
        if (normalized === 'none') return null;
        const polygon = computeSurfacePolygon(blockFeature, buildingFeatures);
        if (!polygon) return null;
        return { treatment: normalized, polygon: polygon };
    }

    function surfaceOf(proposal) {
        const raw = proposal && proposal.geometry ? proposal.geometry.groundSurface : null;
        if (!raw || typeof raw !== 'object') return null;
        const treatment = normalizeTreatment(raw.treatment);
        if (treatment === 'none') return null;
        const feature = asFeature(raw.polygon);
        if (!feature) return null;
        return { treatment: treatment, polygon: feature.geometry };
    }

    function treatmentOf(proposal) {
        const surface = surfaceOf(proposal);
        return surface ? surface.treatment : 'none';
    }

    // Every applied proposal that paves or greens its surroundings, as
    // { proposalId, treatment, geometry }. `isAppliedFn(proposal, sub)` is the caller's applied
    // predicate (each renderer already has one) so this module stays free of lifecycle knowledge.
    function appliedSurfaces(proposals, isAppliedFn) {
        const out = [];
        if (!Array.isArray(proposals) || typeof isAppliedFn !== 'function') return out;
        proposals.forEach(function (proposal) {
            if (!proposal || !proposal.buildingProposal) return;
            const surface = surfaceOf(proposal);
            if (!surface) return;
            let applied = false;
            try { applied = !!isAppliedFn(proposal, proposal.buildingProposal); } catch (_) { applied = false; }
            if (!applied) return;
            out.push({
                proposalId: proposal.proposalId != null ? String(proposal.proposalId) : null,
                treatment: surface.treatment,
                geometry: surface.polygon
            });
        });
        return out;
    }

    return {
        TREATMENTS: TREATMENTS,
        MIN_SURFACE_AREA_M2: MIN_SURFACE_AREA_M2,
        SURFACE_STYLE_2D: SURFACE_STYLE_2D,
        normalizeTreatment: normalizeTreatment,
        computeSurfacePolygon: computeSurfacePolygon,
        buildSurface: buildSurface,
        surfaceOf: surfaceOf,
        treatmentOf: treatmentOf,
        appliedSurfaces: appliedSurfaces
    };
});
