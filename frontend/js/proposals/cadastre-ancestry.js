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

    // Whether a footprint lies on a parcel is the shared rule (geometry-tolerances.js reachesInto,
    // through plan-order.js computeBaseAncestry), the rule binding uses: debris along a shared edge
    // is not ground the proposal lies on.
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

    // Loaded ORIGINAL cadastral parcels the footprint reaches into that are not declared, largest
    // overlap first. Publish loads the ground under the footprint first (server-sync
    // ensurePublishGroundLoaded), and the API re-checks against the full cadastre. `toleranceM` is
    // the record's own allowance (designToleranceOf), when the caller has the record.
    function undeclaredParcelsUnder(footprint, declaredIds, toleranceM = 0) {
        const api = planOrder();
        if (!api || !footprint) return [];
        const declared = new Set((declaredIds || []).map(String));
        const t = global.turf;
        const box = t && typeof t.bbox === 'function' ? t.bbox(footprint) : null;
        return api.computeBaseAncestry(footprint, loadedCadastreParcels(box), { toleranceM })
            .filter(hit => !declared.has(String(hit.id)));
    }

    // A record's own toleranceM, normalized as binding normalizes it (geometry-tolerances.js).
    function designToleranceOf(proposal) {
        const grid = (global && global.GeometryTolerances)
            || (typeof require === 'function' ? require('../geometry-tolerances.js') : null);
        return grid.designToleranceM(proposal);
    }

    // For tools whose geometry legitimately takes land beyond what was clicked (a road corridor
    // drawn across neighbours): the declaration extended by every loaded parcel the footprint
    // reaches into. Declared ids keep their order; covered ones follow, largest first.
    function declarationCoveringFootprint(proposal) {
        const api = planOrder();
        const declared = Array.isArray(proposal?.cadastreParcelIds) ? proposal.cadastreParcelIds.map(String) : [];
        const footprint = api && proposal ? api.footprintOf(proposal) : null;
        if (!footprint) return declared;
        return declared.concat(undeclaredParcelsUnder(footprint, declared, designToleranceOf(proposal)).map(hit => String(hit.id)));
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

    // The cadastral parcels a record's geometry reaches into on the ground in view today:
    // loads the ground under its footprint, then reads it. For re-basing a record whose stored
    // parcels no longer fit the cadastre (proposals/ground-rebase.js).
    async function currentCadastreParcelIds(proposal) {
        const api = planOrder();
        const repository = global.CadastralParcelRepository;
        const footprint = api && proposal ? api.footprintOf(proposal) : null;
        if (!footprint) throw new Error('The proposal has no footprint to find its parcels from.');
        if (!repository || typeof repository.ensureFootprint !== 'function') throw new Error('The cadastral repository is unavailable.');
        await repository.ensureFootprint(footprint, proposal.city ? { city: proposal.city } : {});
        return undeclaredParcelsUnder(footprint, [], designToleranceOf(proposal)).map(hit => String(hit.id));
    }

    // The ownership flow of a proposal's formation against the live cadastre (see ownership-flow.js).
    // Additive bookkeeping: a failure costs the field, never the proposal.
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
            // No bound parcels (a site on bare ground): nobody's land changes hands.
            if (!declared.length) return [];
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
        loadedCadastreParcels,
        loadedCadastreCoverage,
        undeclaredParcelsUnder,
        declarationCoveringFootprint,
        publishDeclaration,
        currentCadastreParcelIds,
        computeOwnershipFlow
    };

    if (typeof window !== 'undefined') window.__cadastreAncestry = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
