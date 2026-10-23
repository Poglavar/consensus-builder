// Ground treatment for building proposals: the site area left over AROUND the placed
// buildings, rendered either as sidewalk paving or as grass (like a park). One setting per
// proposal covers its authored ground boundary, whatever the building count. Pure turf read from
// the runtime global — plain GeoJSON in and out, no DOM and no map, so it is unit-testable
// headlessly. Rendering lives in structures.js (2D), three-mode.js (model) and photoreal-mode.js.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.BuildingGround = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // New and edited building designs always specify their surrounding surface.
    const TREATMENTS = ['paved', 'green'];

    // Below this the leftover ring is a slither of rounding error, not a surface worth drawing.
    const MIN_SURFACE_AREA_M2 = 2;

    // The 2D fill of each treatment, matching the sidewalk paving and park grass in structures.js —
    // one definition for the map layer and for the building editors' live previews.
    const SURFACE_STYLE_2D = {
        paved: { color: '#8e8c87', fillColor: '#cdccc8', fillOpacity: 1 },
        green: { color: '#0d3b1f', fillColor: '#1b5e20', fillOpacity: 0.65 }
    };

    // A polygon clip that cannot be done, typed and counted (parcel-arrangement.js ClipFailure).
    function clipFailureOf(operation, error, site, operands) {
        const root = typeof window !== 'undefined' ? window : globalThis;
        const api = root.__parcelArrangement
            || (typeof require === 'function' ? require('./proposals/parcel-arrangement.js') : null);
        return api ? api.clipFailure(operation, error, { site }, operands) : error;
    }

    function normalizeTreatment(value) {
        const key = String(value == null ? '' : value).trim().toLowerCase();
        return TREATMENTS.includes(key) ? key : 'paved';
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

    // The surround polygon: the authored ground boundary minus every building footprint on it.
    // The freeform editor moves this boundary with the design; the starting parcels are optional guides.
    function computeSurfacePolygon(blockFeature, buildingFeatures) {
        if (typeof turf === 'undefined' || typeof turf.difference !== 'function') return null;
        let surface = asFeature(blockFeature);
        if (!surface) return null;
        const buildings = Array.isArray(buildingFeatures) ? buildingFeatures : [];
        for (let i = 0; i < buildings.length && surface; i++) {
            const cutter = asFeature(buildings[i]);
            if (!cutter) continue;
            // Keeping the surface uncut by a building that threw would pave or green under that
            // building, and the surface is persisted with the proposal: refuse instead.
            try { surface = turf.difference(surface, cutter); } catch (error) {
                throw clipFailureOf('difference', error, 'building-ground.computeSurfacePolygon', [surface, cutter]);
            }
        }
        if (!surface || !surface.geometry) return null;
        if (geometryArea(surface.geometry) < MIN_SURFACE_AREA_M2) return null;
        try { return JSON.parse(JSON.stringify(surface.geometry)); } catch (_) { return surface.geometry; }
    }

    // Persist the surface polygon with the design; a footprint-only take may have no area left.
    function buildSurface(treatment, blockFeature, buildingFeatures, decorationDesign = null) {
        const normalized = normalizeTreatment(treatment);
        const polygon = computeSurfacePolygon(blockFeature, buildingFeatures);
        if (!polygon) return null;
        return { treatment: normalized, polygon, ...(decorationDesign ? { decorationDesign: JSON.parse(JSON.stringify(decorationDesign)) } : {}) };
    }

    function surfaceOf(proposal) {
        const raw = proposal && proposal.geometry ? proposal.geometry.groundSurface : null;
        if (!raw || typeof raw !== 'object') return null;
        if (!TREATMENTS.includes(raw.treatment)) return null;
        const treatment = raw.treatment;
        const feature = asFeature(raw.polygon);
        if (!feature) return null;
        return { treatment, polygon: feature.geometry, ...(raw.decorationDesign ? { decorationDesign: JSON.parse(JSON.stringify(raw.decorationDesign)) } : {}) };
    }

    function treatmentOf(proposal) {
        const surface = surfaceOf(proposal);
        return surface ? surface.treatment : 'paved';
    }

    // Whole-design movement keeps authored furniture tied to the moving ground in WGS84.
    function moveDecorationDesign(design, from, to, moveCoordinates) {
        if (!design) return null;
        const moved = JSON.parse(JSON.stringify(design));
        Object.keys(moved).forEach(key => {
            if (!Array.isArray(moved[key])) return;
            moved[key] = moved[key].map(item => item?.coordinate
                ? { ...item, coordinate: moveCoordinates(item.coordinate, from, to) }
                : moveCoordinates(item, from, to));
        });
        return moved;
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
                ...(surface.decorationDesign ? { decorationDesign: surface.decorationDesign } : {}),
                geometry: surface.polygon
            });
        });
        return out;
    }

    // A vacant plot is a current output of an applied layout with no standing building or
    // applied physical design on it. This is presentation, never authored land or ownership.
    function vacantPlots(features, proposals, isAppliedFn, turfApi, existingBuildings = []) {
        const applied = proposals.filter(proposal => isAppliedFn(proposal));
        const layouts = new Set(applied.filter(proposal => proposal.parcelLayout).map(proposal => String(proposal.proposalId)));
        const plots = features.filter(feature => feature.properties?.readjustmentPiece?.role === 'plot'
            && layouts.has(String(feature.properties?.producedByProposalId)));
        if (!plots.length) return [];
        const occupied = existingBuildings.map(asFeature).filter(Boolean);
        const add = value => { const feature = asFeature(value); if (feature) occupied.push(feature); };
        applied.filter(proposal => !proposal.parcelLayout).forEach(proposal => {
            (proposal.geometry?.buildings || []).forEach(add);
            add(proposal.geometry?.landTake);
            add(proposal.geometry?.groundSurface?.polygon);
            add(proposal.structureProposal?.geometry);
            add(proposal.roadProposal?.definition?.polygon);
        });
        const boxes = occupied.map(feature => ({ feature, box: turfApi.bbox(feature) }));
        return plots.filter(feature => {
            const box = turfApi.bbox(feature);
            return !boxes.some(entry => {
                if (box[0] >= entry.box[2] || box[2] <= entry.box[0] || box[1] >= entry.box[3] || box[3] <= entry.box[1]) return false;
                try {
                    const intersection = turfApi.intersect(feature, entry.feature);
                    return intersection && turfApi.area(intersection) > 0.1;
                } catch (error) {
                    throw clipFailureOf('intersect', error, 'building-ground.vacantPlots', [feature, entry.feature]);
                }
            });
        });
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
        moveDecorationDesign,
        vacantPlots,
        appliedSurfaces: appliedSurfaces
    };
});
