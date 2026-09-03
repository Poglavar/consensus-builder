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

    const MIN_CADASTRE_COVERAGE = 0.95;

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

    // Validate the proposal's already-authored cadastral declaration. Selection projects live
    // parcel ids to this flat set once, when the proposal is created. Publishing must preserve that
    // exact scope (including selected block parcels without a generated building), never silently
    // replace it with whichever parcels happen to intersect the output geometry today.
    function validateCadastreParcelIds(proposal, options) {
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
        const resolved = repository.coverageOf(footprint, { ids: declared });
        const coverage = resolved.coverage;
        const minimum = Number.isFinite(Number(options?.minCoverage))
            ? Number(options.minCoverage)
            : MIN_CADASTRE_COVERAGE;
        if (!resolved.ids.length || coverage < minimum) {
            const error = new Error(`Cannot publish: loaded cadastral parcels cover only ${Math.round(coverage * 100)}% of the proposal footprint (95% required).`);
            error.code = 'cadastre-coverage-insufficient';
            error.coverage = coverage;
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
        MIN_CADASTRE_COVERAGE,
        loadedCadastreParcels,
        loadedCadastreCoverage,
        validateCadastreParcelIds,
        computeOwnershipFlow
    };

    if (typeof window !== 'undefined') window.__cadastreAncestry = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
