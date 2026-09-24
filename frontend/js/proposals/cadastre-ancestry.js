// The BASE cadastral parcels a proposal's geometry covers. The pure plan-order logic receives
// immutable GeoJSON from CadastralParcelRepository. Leaflet is never a geometry source, so
// rendering precision, visibility, and layer lifetime cannot change an answer.
//
// A formation stores only flat cadastral anchors. Geometry resolves the current live pieces at
// replay time; derived ids are local tessellation output and never become prerequisites.
//
// WHEN this is computed matters more than it looks. A road can be dragged around all afternoon, so
// there is no useful "the parcels of this proposal" while it is still being drawn. The published
// immutable snapshot carries the cadastral anchors used for consent and transport.

(function (global) {
    'use strict';

    // Same floor as the API (backend/proposals/footprint.js MIN_PARCEL_OVERLAP_M2): below 1 m² an
    // overlap is boundary noise, not ground the proposal lies on.
    const MIN_PARCEL_OVERLAP_M2 = 1;

    const planOrder = () => (global && global.__planOrder)
        ? global.__planOrder
        : (typeof require === 'function' ? require('./plan-order.js') : null);

    function geometryBox(feature) {
        const coordinates = feature?.geometry?.coordinates;
        if (!Array.isArray(coordinates)) return null;
        let west = Infinity;
        let south = Infinity;
        let east = -Infinity;
        let north = -Infinity;
        const visit = value => {
            if (!Array.isArray(value)) return;
            if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
                const x = Number(value[0]);
                const y = Number(value[1]);
                west = Math.min(west, x); east = Math.max(east, x);
                south = Math.min(south, y); north = Math.max(north, y);
                return;
            }
            value.forEach(visit);
        };
        visit(coordinates);
        return Number.isFinite(west) ? [west, south, east, north] : null;
    }

    function intersectsBox(feature, box) {
        if (!box) return true;
        const candidate = geometryBox(feature);
        return !!candidate && candidate[0] <= box[2] && candidate[2] >= box[0]
            && candidate[1] <= box[3] && candidate[3] >= box[1];
    }

    // Every immutable source parcel retained by the repository, including source ground currently
    // replaced in the live partition.
    function loadedCadastreParcels(box) {
        const repository = global.CadastralParcelRepository;
        if (!repository || typeof repository.list !== 'function') return [];
        return repository.list()
            .filter(feature => intersectsBox(feature, box))
            .map(feature => ({ id: String(feature.properties.parcelId), feature }));
    }

    // How much of a proposal footprint is backed by ORIGINAL cadastre. The repository owns both
    // retrieval and retained coverage; this module only supplies the proposal footprint and applies
    // the publish rule. There is no second cache scan and no renderer-aware fallback.
    function loadedCadastreCoverage(proposal) {
        const api = planOrder();
        const repository = global.CadastralParcelRepository;
        if (!api || !proposal || !repository || typeof repository.coverageOf !== 'function') {
            return { ids: [], coverage: 0 };
        }
        try {
            const footprint = api.footprintOf(proposal);
            if (!footprint) return { ids: [], coverage: 0 };
            return repository.coverageOf(footprint);
        } catch (error) {
            console.warn('[cadastre-ancestry] cadastral repository coverage failed', error);
            return { ids: [], coverage: 0 };
        }
    }

    function translate(key, fallback, params) {
        const i18n = global && global.i18n;
        if (i18n && typeof i18n.t === 'function') {
            const translated = i18n.t(key, params);
            if (translated && translated !== key) return translated;
        }
        return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (
            Object.prototype.hasOwnProperty.call(params || {}, name) ? String(params[name]) : match
        ));
    }

    // Loaded ORIGINAL cadastral parcels the footprint covers by >= MIN_PARCEL_OVERLAP_M2 that are not
    // declared, largest overlap first. Publish loads the ground under the footprint first
    // (server-sync ensurePublishGroundLoaded), and the API re-checks against the full cadastre.
    function undeclaredParcelsUnder(footprint, declaredIds) {
        const api = planOrder();
        if (!api || !footprint) return [];
        const declared = new Set((declaredIds || []).map(String));
        const t = global.turf;
        const box = t && typeof t.bbox === 'function' ? t.bbox(footprint) : null;
        return api.computeBaseAncestry(footprint, loadedCadastreParcels(box), { minAreaM2: MIN_PARCEL_OVERLAP_M2 })
            .filter(hit => !declared.has(String(hit.id)));
    }

    // For tools whose geometry legitimately takes land beyond what was clicked (a road corridor
    // drawn across neighbours): the declaration extended by every loaded parcel the footprint
    // covers by >= 1 m². Declared ids keep their order; covered ones follow, largest first.
    function declarationCoveringFootprint(proposal) {
        const api = planOrder();
        const declared = Array.isArray(proposal?.cadastreParcelIds) ? proposal.cadastreParcelIds.map(String) : [];
        const footprint = api && proposal ? api.footprintOf(proposal) : null;
        if (!footprint) return declared;
        return declared.concat(undeclaredParcelsUnder(footprint, declared).map(hit => String(hit.id)));
    }

    // The declaration a record is published with. A corridor (road or track, drawn or from a
    // government plan) takes every parcel its polygon covers, and its polygon can legitimately grow
    // after the parcels were picked (node drags, width/profile edits, a plan polygon wider than the
    // viewport selection, cadastral streets already under an applied road). Every other typology
    // publishes exactly what its author selected.
    function publishDeclaration(proposal) {
        const declared = Array.isArray(proposal?.cadastreParcelIds) ? proposal.cadastreParcelIds.map(String) : [];
        return proposal && proposal.roadProposal ? declarationCoveringFootprint(proposal) : declared;
    }

    // Validate the proposal's already-authored cadastral declaration. Selection projects live
    // parcel ids to this flat set once, when the proposal is created. Publishing must preserve that
    // exact scope (including selected block parcels without a generated building), never silently
    // replace it with whichever parcels happen to intersect the output geometry today. The rule is
    // strict in one direction only: geometry may not lie on an undeclared parcel (>= 1 m²), while a
    // declared parcel with no geometry on it is allowed. The API applies the same rule
    // (backend/proposals/footprint.js), so this gate is the early, explainable copy of it.
    function validateCadastreParcelIds(proposal) {
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
        const declared = Array.from(new Set((Array.isArray(proposal.cadastreParcelIds)
            ? proposal.cadastreParcelIds
            : [])
            .map(value => String(value || '').trim())
            .filter(Boolean)));
        if (!declared.length) {
            const error = new Error('Cannot publish: the proposal has no explicit cadastral parcel declaration.');
            error.code = 'cadastre-declaration-missing';
            throw error;
        }
        const repository = global.CadastralParcelRepository;
        const loaded = typeof repository?.getMany === 'function'
            ? repository.getMany(declared)
            : [];
        const loadedIds = new Set(loaded.map(feature => String(feature?.properties?.parcelId || '')));
        const missing = declared.filter(id => !loadedIds.has(id));
        if (missing.length) {
            const error = new Error(`Cannot publish: ${missing.length} declared cadastral parcel(s) are not loaded.`);
            error.code = 'cadastre-declaration-not-loaded';
            error.missingIds = missing;
            throw error;
        }
        const undeclared = undeclaredParcelsUnder(footprint, declared);
        if (undeclared.length) {
            const list = undeclared.map(hit => hit.id).join(', ');
            const error = new Error(translate(
                'modal.createProposal.errors.undeclaredParcels',
                'This proposal\'s geometry lies on {{count}} parcel(s) you did not select: {{list}}. Select them too, or keep the geometry inside the selected parcels.',
                { count: undeclared.length, list }
            ));
            error.code = 'undeclared-parcels';
            error.undeclaredParcelIds = undeclared.map(hit => hit.id);
            error.parcels = undeclared;
            throw error;
        }
        console.debug(`[cadastre-ancestry] validated ${declared.length} declared cadastral parcel(s) for `
            + `${proposal.proposalId || proposal.title || 'proposal'}`, declared);
        return declared;
    }

    // The ownership flow of a proposal's formation against the live cadastre (see ownership-flow.js).
    // Same contract as validateCadastreParcelIds: additive bookkeeping, so a failure costs the field,
    // never the proposal.
    function computeOwnershipFlow(proposal) {
        const flowApi = (global && global.__ownershipFlow)
            ? global.__ownershipFlow
            : (typeof require === 'function' ? require('./ownership-flow.js') : null);
        if (!flowApi || !proposal) return [];
        try {
            // The flat stamp is the proposal's land: the flow is measured over those parcels only.
            // Reading the whole repository here cloned every cadastral polygon per proposal and was
            // 16% of a shared-plan apply.
            const repository = global.CadastralParcelRepository;
            const declared = Array.isArray(proposal.cadastreParcelIds) ? proposal.cadastreParcelIds : [];
            const parcels = declared.length && repository && typeof repository.peekMany === 'function'
                ? repository.peekMany(declared).map(feature => ({ id: String(feature.properties.parcelId), feature }))
                : loadedCadastreParcels();
            return flowApi.computeOwnershipFlow(proposal, parcels);
        } catch (error) {
            console.warn('[cadastre-ancestry] ownership flow unavailable', error);
            return [];
        }
    }

    const api = {
        MIN_PARCEL_OVERLAP_M2,
        loadedCadastreParcels,
        loadedCadastreCoverage,
        undeclaredParcelsUnder,
        declarationCoveringFootprint,
        publishDeclaration,
        validateCadastreParcelIds,
        computeOwnershipFlow
    };

    if (typeof window !== 'undefined') window.__cadastreAncestry = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
