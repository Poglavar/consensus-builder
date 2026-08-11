// The BASE cadastral parcels a proposal's geometry covers. This is the only map-facing part of the
// base-ancestry work — the logic lives in the pure plan-order.js; this file just reads the live
// parcel index and hands it over.
//
// Every read here is `toGeoJSON(false)`, and the `false` is load-bearing: Leaflet rounds coordinates
// to 6 decimals by default, which is ~8 cm of longitude and ~11 cm of latitude at Zagreb's latitude.
// Cutting itself is exact — turf reuses the shared vertices, so difference() then intersect() against
// the cutter measures 0 — but difference() also INTERPOLATES new vertices where the cutter crosses a
// parcel edge, and those points have no twin on the other polygon to round with. Rounding drifts them
// off the shared line, which is what left 0.3-1.8 m2 slivers between a corridor and the remainders it
// cut (measured: 0 m2 unrounded vs 2.478 m2 rounded, on the same cut). Round for transport or display
// if you must; never in the geometry pipeline.
//
// A formation stores only flat cadastral anchors. Geometry resolves the current live pieces at
// replay time; derived ids are local tessellation output and never become prerequisites.
//
// WHEN this is computed matters more than it looks. A road can be dragged around all afternoon, so
// there is no useful "the parcels of this proposal" while it is still being drawn. The published
// immutable snapshot carries the cadastral anchors used for consent and transport.

(function (global) {
    'use strict';

    const MIN_CADASTRE_COVERAGE = 0.95;

    const planOrder = () => (global && global.__planOrder)
        ? global.__planOrder
        : (typeof require === 'function' ? require('./plan-order.js') : null);

    // Skip a layer without serialising it.
    //
    // These collectors call toGeoJSON on EVERY parcel on the map, and the callers then intersect a
    // proposal's footprint against all of them. Both costs scale with how much ground is loaded
    // rather than with the proposal — 13,000 parcels loaded meant 13,000 serialisations and 13,000
    // polygon intersections to resolve the parents of one building, once per proposal. Leaflet
    // already knows each layer's bounds and hands them over without building any GeoJSON, so a
    // caller that knows where it is looking pays only for the parcels that could possibly answer.
    //
    // `box` is a turf bbox, [west, south, east, north]. Omitted, nothing is skipped.
    function layerOutsideBox(layer, box) {
        if (!box || !layer || typeof layer.getBounds !== 'function') return false;
        let bounds = null;
        try { bounds = layer.getBounds(); } catch (_) { return false; }
        if (!bounds || typeof bounds.isValid !== 'function' || !bounds.isValid()) return false;
        return bounds.getWest() > box[2] || bounds.getEast() < box[0]
            || bounds.getSouth() > box[3] || bounds.getNorth() < box[1];
    }

    // Every ORIGINAL parcel currently known to the map, derived ones excluded. A cadastral parcel
    // that a road or reparcellization has consumed is hidden rather than removed (hideParcelLayerById
    // keeps it in parcelLayerById precisely so descendants can still resolve it), so the originals are
    // still here to intersect against even once the fabric above them has been re-cut.
    function loadedCadastreParcels(box) {
        const out = [];
        try {
            const byId = (typeof global.getParcelLayerIdMap === 'function') ? global.getParcelLayerIdMap() : null;
            if (!byId || typeof byId.forEach !== 'function') return out;
            byId.forEach((layer, id) => {
                const key = id === undefined || id === null ? '' : String(id);
                if (!key || (typeof global.isSyntheticParcelId === 'function' && global.isSyntheticParcelId(key))) return;
                if (!layer || typeof layer.toGeoJSON !== 'function') return;
                if (layerOutsideBox(layer, box)) return;
                try {
                    const gj = layer.toGeoJSON(false);
                    const feature = gj && gj.type === 'FeatureCollection' ? gj.features[0] : gj;
                    if (feature && feature.geometry && /Polygon/.test(feature.geometry.type || '')) {
                        out.push({ id: key, feature });
                    }
                } catch (_) { /* a layer that cannot serialise is simply not a candidate */ }
            });
        } catch (error) {
            console.warn('[cadastre-ancestry] could not read the parcel index', error);
        }
        return out;
    }

    // Every parcel currently LIVE in the sole visible parcel layer. Hidden registry entries are
    // ancestry/cache only and never participate in a cut.
    function loadedLiveParcels(box) {
        const out = [];
        try {
            const byId = (typeof global.getParcelLayerIdMap === 'function') ? global.getParcelLayerIdMap() : null;
            if (!byId || typeof byId.forEach !== 'function') return out;
            const parcelLayerGroup = (global.parcelLayer && typeof global.parcelLayer.hasLayer === 'function')
                ? global.parcelLayer
                : null;

            byId.forEach((layer, id) => {
                const key = id === undefined || id === null ? '' : String(id);
                if (!key) return;
                if (parcelLayerGroup) {
                    try { if (!parcelLayerGroup.hasLayer(layer)) return; } catch (_) { return; }
                }
                if (!layer || typeof layer.toGeoJSON !== 'function') return;
                if (layerOutsideBox(layer, box)) return;
                try {
                    const gj = layer.toGeoJSON(false);
                    const feature = gj && gj.type === 'FeatureCollection' ? gj.features[0] : gj;
                    if (feature && feature.geometry && /Polygon/.test(feature.geometry.type || '')) {
                        out.push({ id: key, feature });
                    }
                } catch (_) { /* a layer that cannot serialise is simply not a candidate */ }
            });
        } catch (error) {
            console.warn('[cadastre-ancestry] could not read the parcel index', error);
        }
        return out;
    }

    // Resolve a proposal's parents from its GEOMETRY against the live fabric, for payloads whose
    // declared parents are ghosts (§3.1 of rethink-proposals.md). Returns { ids, coverage } where
    // coverage is the share of the footprint the resolved parcels actually cover — callers must
    // treat low coverage as "the land is genuinely absent", not as a rename to paper over.
    //
    // Only formations that stand ON the ground ask this. Corridors do not: they are takes, and the
    // parcels under them are re-derived from the cadastre (proposals/parcel-arrangement.js). The
    // junction exception this used to carry — discounting ground a standing formation had already
    // consumed — existed solely because corridors cut each other's leftovers, and went with it.
    function resolveParentsByGeometry(proposal) {
        const api = planOrder();
        const t = (typeof global.turf !== 'undefined' && global.turf) ? global.turf : null;
        if (!api || !t || !proposal) return { ids: [], coverage: 0 };
        try {
            const footprint = api.footprintOf(proposal);
            if (!footprint) return { ids: [], coverage: 0 };
            const footprintM2 = t.area(footprint);
            if (!(footprintM2 > 0)) return { ids: [], coverage: 0 };
            // Only the parcels the footprint could possibly touch are serialised, let alone clipped.
            let box = null;
            try { box = t.bbox(footprint); } catch (_) { box = null; }
            const hits = api.computeBaseAncestry(footprint, loadedLiveParcels(box));
            const coveredM2 = hits.reduce((sum, hit) => sum + (hit.area || 0), 0);

            // Live parcels tessellate (consumed parents are excluded), so the hits partition the
            // footprint and the ratio cannot meaningfully exceed 1; clamp for rounding noise.
            return {
                ids: hits.map(hit => hit.id),
                coverage: Math.min(1, coveredM2 / footprintM2)
            };
        } catch (error) {
            console.warn('[cadastre-ancestry] live geometry resolution failed', error);
            return { ids: [], coverage: 0 };
        }
    }

    // Resolve the publish-time cadastral declaration from geometry alone. A partial viewport must
    // refuse publication; falling back to stale declared ids is exactly how unrelated parcels became
    // occupied after reload. The caller may load more ground and try again.
    function computeCadastreParcelIds(proposal, options) {
        const api = planOrder();
        const t = (typeof global.turf !== 'undefined' && global.turf) ? global.turf : null;
        if (!api || !t || !proposal) {
            const error = new Error('Cannot publish: cadastral geometry resolution is unavailable.');
            error.code = 'cadastre-resolver-unavailable';
            throw error;
        }
        const footprint = api.footprintOf(proposal);
        if (!footprint || !(t.area(footprint) > 0)) {
            const error = new Error('Cannot publish: the proposal has no usable authored footprint.');
            error.code = 'proposal-footprint-missing';
            throw error;
        }
        let footprintBox = null;
        try { footprintBox = t.bbox(footprint); } catch (_) { footprintBox = null; }
        const candidates = loadedCadastreParcels(footprintBox);
        const hits = api.computeBaseAncestry(footprint, candidates);
        const hitIds = new Set(hits.map(hit => String(hit.id)));
        const coveredM2 = candidates.reduce((total, entry) => {
            if (!hitIds.has(String(entry.id))) return total;
            return total + api.intersectionArea(footprint, entry.feature);
        }, 0);
        const coverage = Math.min(1, coveredM2 / t.area(footprint));
        const minimum = Number.isFinite(Number(options?.minCoverage))
            ? Number(options.minCoverage)
            : MIN_CADASTRE_COVERAGE;
        if (!hits.length || coverage < minimum) {
            const error = new Error(`Cannot publish: loaded cadastral parcels cover only ${Math.round(coverage * 100)}% of the proposal footprint (95% required).`);
            error.code = 'cadastre-coverage-insufficient';
            error.coverage = coverage;
            throw error;
        }
        const ids = hits.map(hit => String(hit.id));
        const declared = Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds.length : 0;
        console.debug(`[cadastre-ancestry] ${ids.length} cadastral parcel(s) for `
            + `${proposal.proposalId || proposal.title || 'proposal'} (declared ${declared} parent(s))`, ids);
        return ids;
    }

    // The ownership flow of a proposal's formation against the live cadastre (see ownership-flow.js).
    // Same contract as computeCadastreParcelIds: additive bookkeeping, so a failure costs the field,
    // never the proposal.
    function computeOwnershipFlow(proposal) {
        const flowApi = (global && global.__ownershipFlow)
            ? global.__ownershipFlow
            : (typeof require === 'function' ? require('./ownership-flow.js') : null);
        if (!flowApi || !proposal) return [];
        try {
            return flowApi.computeOwnershipFlow(proposal, loadedCadastreParcels());
        } catch (error) {
            console.warn('[cadastre-ancestry] ownership flow unavailable', error);
            return [];
        }
    }

    const api = {
        MIN_CADASTRE_COVERAGE,
        loadedCadastreParcels,
        loadedLiveParcels,
        computeCadastreParcelIds,
        computeOwnershipFlow,
        resolveParentsByGeometry
    };

    if (typeof window !== 'undefined') window.__cadastreAncestry = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
