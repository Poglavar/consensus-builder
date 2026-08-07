// The BASE cadastral parcels a proposal's geometry covers. This is the only map-facing part of the
// base-ancestry work — the logic lives in the pure plan-order.js; this file just reads the live
// parcel index and hands it over.
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

    // Every ORIGINAL parcel currently known to the map, derived ones excluded. A cadastral parcel
    // that a road or reparcellization has consumed is hidden rather than removed (hideParcelLayerById
    // keeps it in parcelLayerById precisely so descendants can still resolve it), so the originals are
    // still here to intersect against even once the fabric above them has been re-cut.
    function loadedCadastreParcels() {
        const out = [];
        try {
            const byId = (typeof global.getParcelLayerIdMap === 'function') ? global.getParcelLayerIdMap() : null;
            if (!byId || typeof byId.forEach !== 'function') return out;
            byId.forEach((layer, id) => {
                const key = id === undefined || id === null ? '' : String(id);
                if (!key || (typeof global.isSyntheticParcelId === 'function' && global.isSyntheticParcelId(key))) return;
                if (!layer || typeof layer.toGeoJSON !== 'function') return;
                try {
                    const gj = layer.toGeoJSON();
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
    function loadedLiveParcels() {
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
                try {
                    const gj = layer.toGeoJSON();
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
    function resolveParentsByGeometry(proposal) {
        const api = planOrder();
        const t = (typeof global.turf !== 'undefined' && global.turf) ? global.turf : null;
        if (!api || !t || !proposal) return { ids: [], coverage: 0 };
        try {
            const footprint = api.footprintOf(proposal);
            if (!footprint) return { ids: [], coverage: 0 };
            const footprintM2 = t.area(footprint);
            if (!(footprintM2 > 0)) return { ids: [], coverage: 0 };
            const hits = api.computeBaseAncestry(footprint, loadedLiveParcels());
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
        const candidates = loadedCadastreParcels();
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
