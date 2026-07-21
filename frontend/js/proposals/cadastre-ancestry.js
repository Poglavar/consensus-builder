// The BASE cadastral parcels a proposal's geometry covers. This is the only map-facing part of the
// base-ancestry work — the logic lives in the pure plan-order.js; this file just reads the live
// parcel index and hands it over.
//
// Why a second list next to parentParcelIds (see rethink-proposals.md): parentParcelIds may name
// DERIVED parcels (HR-339270-823/1#p-road-2) that are re-minted on every apply and therefore exist in
// exactly one browser. Cadastral ids are the same on every machine, so they survive sharing, replay
// and re-cutting. Written alongside, never instead of — nothing reads it yet.
//
// WHEN this is computed matters more than it looks. A road can be dragged around all afternoon, so
// there is no useful "the parcels of this proposal" while it is still local and mutable. The moment
// that counts is PUBLICATION — upload or mint — because that snapshot is what other people replay and
// what owners consent to. So the only caller is buildUploadReadyProposal(), and the value describes
// the published version, not whatever the local copy has drifted to since.

(function (global) {
    'use strict';

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
                if (!key || key.indexOf('#') !== -1) return; // derived — not a cadastral parcel
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

    // Never throws and never blocks a save: this is additive bookkeeping, so a failure here must cost
    // the field, not the proposal.
    function computeCadastreParcelIds(proposal) {
        const api = planOrder();
        if (!api || !proposal) return [];
        let ids;
        try {
            ids = api.computeCadastreParcelIds(proposal, loadedCadastreParcels());
        } catch (error) {
            console.warn('[cadastre-ancestry] falling back to declared roots', error);
            try { ids = api.cadastreIdsFromDeclared(proposal.parentParcelIds); } catch (_) { ids = []; }
        }
        const declared = Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds.length : 0;
        console.debug(`[cadastre-ancestry] ${ids.length} cadastral parcel(s) for `
            + `${proposal.proposalId || proposal.title || 'proposal'} (declared ${declared} parent(s))`, ids);
        return ids;
    }

    const api = { loadedCadastreParcels, computeCadastreParcelIds };

    if (typeof window !== 'undefined') window.__cadastreAncestry = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
