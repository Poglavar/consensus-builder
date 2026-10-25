// Before/after on the main map for an applied proposal (dividers.md, M2). "After" is the live map;
// "before" is the ground as it stands without this proposal: the cadastre parcels it claims in
// their original shape, every other presented parcel as it is now, and the existing buildings when
// the Layers sheet shows them. The divider itself is ui/map-before-after.js.
//
// Two refinements of "before": a proposal that replaces an earlier version (its typed proposalOrigin,
// not a land fork) gets that version's footprint drawn as a dashed outline, so the two versions can
// be told apart (M5); and a comparison can be opened for one parcel, which is then outlined on the
// before side while the live pieces now standing on it are outlined on the after side (M6: dashed
// amber in, solid blue out). It can also be opened for one owner in a proposal's rights snapshot:
// every parcel that owner holds a share in is outlined before, the live pieces on them after
// (ownerFocusParts). A parcel layout names no owners, so it has no owner focus: who holds its plots
// is carried over from the ground and shown on the parcels themselves.
//
// An agreement (plan-design-agreement.md, M1 b) is compared the same way over its input parcels:
// "before" is that land as the cadastre has it, "after" the live map with every one of its designs
// applied. Its session key is agreementKey(id), so it never collides with a proposal's.
//
// beforeLayers(), canCompare() and canCompareAgreement() are pure and tested headlessly; create()
// takes its collaborators as a function so the browser instance can resolve the app's globals at
// call time (they load after this file). window.ProposalBeforeAfter is that instance;
// toggleProposalBeforeAfter(key) is the details panel button's handler and
// toggleAgreementBeforeAfter(id) the agreement panel's (agreement-panel.js).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root.document !== 'undefined') {
        const instance = api.create(() => api.browserDependencies(root));
        root.ProposalBeforeAfter = Object.assign(instance, { beforeLayers: api.beforeLayers, create: api.create, agreementKey: api.agreementKey });
        // A comparison started from the click stack folds the stack to its rows: the map is what
        // the reader now looks at (the card stays hosted, hidden, so the comparison keeps running).
        root.toggleProposalBeforeAfter = async (key, options) => {
            const shown = await instance.toggle(key, options);
            if (shown === true && root.ClickStack?.isOpen()) root.ClickStack.fold();
            return shown;
        };
        root.toggleAgreementBeforeAfter = id => instance.toggleAgreement(id);
    }
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const idOf = value => (value === undefined || value === null ? '' : String(value));
    const AGREEMENT_KEY_PREFIX = 'agreement:';
    const agreementKey = id => (idOf(id) ? AGREEMENT_KEY_PREFIX + idOf(id) : '');

    // The land an agreement settles: its input cadastral parcels, each once.
    function agreementInputIds(agreement) {
        const parcels = agreement && agreement.inputs && Array.isArray(agreement.inputs.parcels) ? agreement.inputs.parcels : [];
        return Array.from(new Set(parcels.map(parcel => idOf(parcel && parcel.parcelId)).filter(Boolean)));
    }

    // An agreement has an "after" only while every one of its designs is held here and applied,
    // and a "before" only when it takes cadastral land.
    function canCompareAgreement(agreement, { isApplied, recordOf } = {}) {
        if (!agreement || typeof isApplied !== 'function' || typeof recordOf !== 'function') return false;
        const designs = Array.isArray(agreement.designs) ? agreement.designs : [];
        if (!designs.length || !agreementInputIds(agreement).length) return false;
        return designs.every(design => {
            const record = recordOf(idOf(design && design.proposalId));
            return !!record && !!isApplied(record);
        });
    }

    // A comparison needs something on the map to compare: an applied record with a footprint
    // (buildings, a corridor, a structure, a parcel layout). Content-only records have no "after".
    function canCompare(proposal, { isApplied, footprintParts } = {}) {
        if (!proposal || typeof isApplied !== 'function' || typeof footprintParts !== 'function') return false;
        if (!isApplied(proposal)) return false;
        const parts = footprintParts(proposal) || {};
        return (Array.isArray(parts.polygons) && parts.polygons.length > 0) || !!parts.centerline;
    }

    const withGeometry = list => (Array.isArray(list) ? list : []).filter(feature => feature && feature.geometry);

    // What the before map draws. `presented` are the parcels on the main map right now
    // ({ id, feature, cadastreIds }); any that derive from a parcel this proposal claims (the parcel
    // itself, a plot of its parcel layout, a piece a corridor cut) is replaced by the claimed
    // parcel's original cadastre feature. Buildings come along only when the main map shows them.
    // `previous` is the replaced version's footprint; `focusParcelId` picks the one claimed parcel
    // to outline (M6), found among the originals.
    function beforeLayers({ affectedIds, originals, presented, buildings, buildingsShown, previous, focusParcelId, focusParcelIds, idOfFeature } = {}) {
        const affected = new Set(Array.from(affectedIds || [], idOf).filter(Boolean));
        const kept = (Array.isArray(presented) ? presented : []).filter(entry => {
            if (!entry || !entry.feature) return false;
            const ids = Array.isArray(entry.cadastreIds) && entry.cadastreIds.length ? entry.cadastreIds : [entry.id];
            return !ids.some(id => affected.has(idOf(id)));
        }).map(entry => entry.feature);
        const original = withGeometry(originals);
        const wanted = new Set([focusParcelId, ...(Array.isArray(focusParcelIds) ? focusParcelIds : [])].map(idOf).filter(Boolean));
        const identify = typeof idOfFeature === 'function' ? idOfFeature : feature => featureIdOf(feature, null);
        return {
            parcels: kept.concat(original),
            buildings: buildingsShown ? withGeometry(buildings) : [],
            previous: withGeometry(previous),
            focus: wanted.size ? original.filter(feature => wanted.has(idOf(identify(feature)))) : []
        };
    }

    // The footprint of a record as drawable features (its polygons; a legacy centre-line road has
    // none and contributes nothing).
    function footprintFeatures(record, footprintParts) {
        if (!record || typeof footprintParts !== 'function') return [];
        let parts = null;
        try { parts = footprintParts(record); } catch (_) { return []; }
        return (parts && Array.isArray(parts.polygons) ? parts.polygons : [])
            .filter(geometry => geometry && geometry.type)
            .map(geometry => ({ type: 'Feature', properties: {}, geometry }));
    }

    // Dashed amber for the land put in, solid blue for what stands on it now, and a dashed proposal
    // orange for the version being replaced.
    const PREVIOUS_STYLE = { color: '#ff6600', weight: 2, opacity: 0.9, dashArray: '6 4', fillColor: '#ff6600', fillOpacity: 0.08 };
    const FOCUS_BEFORE_STYLE = { color: '#b45309', weight: 4, fillOpacity: 0.08, dashArray: '7 5' };
    const FOCUS_AFTER_STYLE = { color: '#0369a1', weight: 4, fillOpacity: 0.18 };

    function featureIdOf(feature, fabric) {
        if (fabric && typeof fabric.featureId === 'function') {
            try { const id = fabric.featureId(feature); if (id) return idOf(id); } catch (_) { /* not a fabric feature */ }
        }
        const props = (feature && feature.properties) || {};
        return idOf(props.parcelId || props.parcel_id || props.id || feature?.id);
    }

    // One owner's side of a proposal: the cadastral parcels they hold a share in, from the
    // proposal's rights snapshot. What stands on that land now is read from the live fabric.
    function ownerFocusParts(proposal, ownerId) {
        const id = idOf(ownerId).trim();
        if (!proposal || !id) return { parcelIds: [] };
        const rights = proposal.approvalConfig && proposal.approvalConfig.rights;
        const parcelIds = (rights && Array.isArray(rights.parcels) ? rights.parcels : [])
            .filter(parcel => Array.isArray(parcel && parcel.owners) && parcel.owners.some(owner => idOf(owner && owner.ownerId).trim() === id))
            .map(parcel => idOf(parcel.parcelId))
            .filter(Boolean);
        return { parcelIds };
    }

    // [[south, west], [north, east]] around a set of GeoJSON features, or null. Pure, so the framing
    // of a focused comparison is testable without Leaflet.
    function focusBounds(features) {
        let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
        const visit = coords => {
            if (!Array.isArray(coords)) return;
            if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
                if (!Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) return;
                minLng = Math.min(minLng, coords[0]); maxLng = Math.max(maxLng, coords[0]);
                minLat = Math.min(minLat, coords[1]); maxLat = Math.max(maxLat, coords[1]);
                return;
            }
            coords.forEach(visit);
        };
        withGeometry(features).forEach(feature => visit(feature.geometry.coordinates));
        return Number.isFinite(minLng) ? [[minLat, minLng], [maxLat, maxLng]] : null;
    }

    function create(resolveDependencies) {
        let session = null;
        let activeKey = null;
        let activeFocus = null;
        let hostLayer = null;
        let starting = null;

        const isActive = key => !!session && (key === undefined || idOf(key) === activeKey);

        function dispose() {
            if (!session) return false;
            const closing = session;
            const closingHostLayer = hostLayer;
            session = null;
            activeKey = null;
            activeFocus = null;
            hostLayer = null;
            if (closingHostLayer) { try { closingHostLayer.remove(); } catch (_) { /* the host map is gone */ } }
            try { closing.dispose(); } catch (_) { /* the map may already be gone */ }
            try { const deps = resolveDependencies(); if (typeof deps.onChange === 'function') deps.onChange(false, { key: null, focusParcelId: null }); } catch (_) { /* no dependencies left */ }
            return true;
        }

        async function presentedParcels(deps) {
            const { map, presenter, fabric } = deps;
            if (!presenter || typeof presenter.getLayersWithinBounds !== 'function' || !fabric) return [];
            const layers = presenter.getLayersWithinBounds(map.getBounds()) || [];
            const read = typeof fabric.peek === 'function' ? fabric.peek : fabric.get;
            const entries = [];
            for (const layer of layers) {
                const id = typeof presenter.getIdForLayer === 'function' ? presenter.getIdForLayer(layer) : null;
                const feature = id && typeof read === 'function' ? read.call(fabric, id) : null;
                if (!feature || !feature.geometry) continue;
                let cadastreIds = null;
                try { cadastreIds = typeof fabric.explicitCadastreIds === 'function' ? fabric.explicitCadastreIds(feature) : null; } catch (_) { cadastreIds = null; }
                entries.push({ id: idOf(id), feature, cadastreIds: Array.isArray(cadastreIds) ? cadastreIds.map(idOf) : [idOf(id)] });
            }
            return entries;
        }

        async function originalParcels(deps, affectedIds) {
            const ids = Array.from(affectedIds);
            if (!ids.length || !deps.repository || typeof deps.repository.ensureIds !== 'function') return [];
            try {
                const result = await deps.repository.ensureIds(ids, { retainOnly: true });
                return Array.isArray(result && result.features) ? result.features : [];
            } catch (error) {
                // The comparison still stands: the claimed parcels just keep their current shape.
                if (typeof deps.warn === 'function') deps.warn('[before-after] original parcels unavailable', error);
                return [];
            }
        }

        async function start(proposal, key, options = {}) {
            const deps = resolveDependencies();
            if (!canCompare(proposal, deps)) return false;
            const focusOwnerId = idOf(options.focusOwnerId) || null;
            const ownerParts = focusOwnerId ? ownerFocusParts(proposal, focusOwnerId) : null;
            return startWith({
                key,
                affectedIds: deps.claims && typeof deps.claims.cadastreParcelIdsOf === 'function'
                    ? deps.claims.cadastreParcelIdsOf(proposal)
                    : (Array.isArray(proposal.cadastreParcelIds) ? proposal.cadastreParcelIds : []),
                previous: typeof deps.previousVersionOf === 'function' ? deps.previousVersionOf(proposal) : null,
                focusParcelId: options.focusParcelId,
                focusOwnerId,
                focusParcelIds: ownerParts ? ownerParts.parcelIds : null
            });
        }

        // An agreement's comparison: its input parcels in their original shape before, the live
        // map after. Refused unless every one of its designs is applied here.
        async function startAgreement(agreement, key) {
            if (!canCompareAgreement(agreement, resolveDependencies())) return false;
            const ids = agreementInputIds(agreement);
            return startWith({ key, affectedIds: ids, focusParcelIds: ids });
        }

        // The comparison itself, over the cadastral parcels `affectedIds` names. `previous` is the
        // version a proposal replaces; `focusParcelIds` (one owner's parcels) or `focusParcelId`
        // (one parcel) outline the focused land on both sides.
        async function startWith({ key, affectedIds, previous = null, focusParcelId = null, focusOwnerId = null, focusParcelIds = null } = {}) {
            const deps = resolveDependencies();
            if (!deps.map || !deps.L || typeof deps.attach !== 'function') return false;
            const affected = new Set(Array.from(affectedIds || [], idOf).filter(Boolean));
            const focusParcel = idOf(focusParcelId) || null;
            const focusOwner = idOf(focusOwnerId) || null;
            const focusMany = Array.isArray(focusParcelIds) ? focusParcelIds : null;
            const [originals, presented] = await Promise.all([originalParcels(deps, affected), presentedParcels(deps)]);
            if (session) dispose();
            const layers = beforeLayers({
                affectedIds: affected, originals, presented,
                buildings: typeof deps.buildingPool === 'function' ? deps.buildingPool() : [],
                buildingsShown: typeof deps.buildingsShown === 'function' ? deps.buildingsShown() : false,
                previous: footprintFeatures(previous, deps.footprintParts),
                focusParcelId: focusParcel,
                focusParcelIds: focusMany || [],
                idOfFeature: feature => featureIdOf(feature, deps.fabric)
            });
            const t = typeof deps.t === 'function' ? deps.t : (_key, fallback) => fallback;
            const L = deps.L;
            let afterFocus = [];
            // The live pieces on the focused land (the one parcel, or every parcel of the focused
            // owner), outlined on the live ("after") map.
            const focusIds = focusMany || (focusParcel ? [focusParcel] : []);
            if (focusIds.length && deps.fabric && typeof deps.fabric.entriesForCadastre === 'function') {
                let plots = [];
                try { plots = withGeometry(deps.fabric.entriesForCadastre(focusIds, { includeCorridors: true })); } catch (_) { plots = []; }
                if (plots.length) {
                    afterFocus = plots;
                    hostLayer = L.geoJSON({ type: 'FeatureCollection', features: plots }, { interactive: false, style: () => FOCUS_AFTER_STYLE }).addTo(deps.map);
                }
            }
            // A focused comparison (an agreement, one owner, or one parcel) is about that land: frame it in the part
            // of the map the panel leaves free, and start the divider through its middle so "before"
            // shows the old parcel and "after" the new plots.
            let percent;
            const framed = (focusMany || focusParcel)
                ? focusBounds(layers.focus.concat(afterFocus))
                : null;
            if (framed && typeof deps.map.fitBounds === 'function') {
                const padding = (typeof deps.fitPadding === 'function' && deps.fitPadding()) || { paddingTopLeft: [40, 40], paddingBottomRight: [40, 40] };
                try {
                    deps.map.fitBounds(framed, { ...padding, maxZoom: 20, animate: false });
                    const size = deps.map.getSize();
                    const middle = deps.map.latLngToContainerPoint([(framed[0][0] + framed[1][0]) / 2, (framed[0][1] + framed[1][1]) / 2]);
                    if (size && size.x > 0 && middle && Number.isFinite(middle.x)) {
                        percent = Math.min(95, Math.max(5, (middle.x / size.x) * 100));
                    }
                } catch (error) {
                    if (typeof deps.warn === 'function') deps.warn('[before-after] could not frame the focused land', error);
                }
            }
            session = deps.attach(deps.map, {
                L,
                ...(percent === undefined ? {} : { percent }),
                labels: { before: t('mapCompare.before', 'Before'), after: t('mapCompare.after', 'After') },
                sliderLabel: t('mapCompare.sliderLabel', 'Before and after comparison'),
                // The main map's bottom corners sit under the tab bar; the labels ride the divider.
                labelPlacement: 'divider',
                drawBefore(beforeMap) {
                    // One canvas for everything: a dense view can hold thousands of parcels. The before
                    // map is its own Leaflet map; its standard overlay pane is named so the pane review
                    // (test/interactive-pane-renderer.test.js) sees the choice.
                    const renderer = typeof L.canvas === 'function' ? L.canvas({ padding: 0.5, pane: 'overlayPane' }) : undefined;
                    L.geoJSON({ type: 'FeatureCollection', features: layers.parcels }, {
                        renderer, interactive: false,
                        style: feature => deps.parcelStyle(featureIdOf(feature, deps.fabric), feature)
                    }).addTo(beforeMap);
                    if (layers.buildings.length) {
                        L.geoJSON({ type: 'FeatureCollection', features: layers.buildings }, {
                            renderer, interactive: false, style: () => deps.buildingStyle()
                        }).addTo(beforeMap);
                    }
                    if (layers.previous.length) {
                        L.geoJSON({ type: 'FeatureCollection', features: layers.previous }, {
                            renderer, interactive: false, style: () => PREVIOUS_STYLE
                        }).addTo(beforeMap);
                    }
                    if (layers.focus.length) {
                        L.geoJSON({ type: 'FeatureCollection', features: layers.focus }, {
                            renderer, interactive: false, style: () => FOCUS_BEFORE_STYLE
                        }).addTo(beforeMap);
                    }
                }
            });
            activeKey = idOf(key);
            activeFocus = focusOwner ? `owner:${focusOwner}` : focusParcel;
            // What the before map holds, for a test or a reader of the DOM: the canvas cannot be read.
            try {
                session.beforeEl.dataset.layers = JSON.stringify({
                    parcels: layers.parcels.length, buildings: layers.buildings.length,
                    previous: layers.previous.length, focus: layers.focus.length,
                    afterFocus: afterFocus.length
                });
            } catch (_) { /* no dataset on this host */ }
            if (typeof deps.onChange === 'function') deps.onChange(true, { key: activeKey, focusParcelId: focusParcel, focusOwnerId: focusOwner });
            // The divider is what the reader now operates.
            try { session.handleEl && session.handleEl.focus({ preventScroll: true }); } catch (_) { /* no focus in this host */ }
            return true;
        }

        return {
            isActive,
            activeKey: () => activeKey,
            activeFocus: () => activeFocus,
            canCompare: proposal => canCompare(proposal, resolveDependencies()),
            canCompareAgreement: agreement => canCompareAgreement(agreement, resolveDependencies()),
            dispose,
            // Called by the details panel on every render: a different proposal, or one no longer
            // applied, ends the comparison; a re-render of the same applied proposal keeps it.
            reconcile(proposal, key) {
                if (!session) return false;
                const deps = resolveDependencies();
                const sameKey = key === undefined || idOf(key) === activeKey;
                if (sameKey && canCompare(proposal, deps)) return false;
                return dispose();
            },
            // toggle(key) starts or ends the comparison; toggle(key, { focusParcelId }) opens it for
            // one parcel, and asked again for another parcel moves the focus instead of closing.
            // toggle(key, { focusOwnerId }) does the same for one owner in the rights snapshot.
            async toggle(key, options = {}) {
                const owner = idOf(options.focusOwnerId) || null;
                const focus = owner ? `owner:${owner}` : (idOf(options.focusParcelId) || null);
                if (session && idOf(key) === activeKey && focus === activeFocus) { dispose(); return false; }
                if (session && !focus) { dispose(); return false; }
                if (starting) return starting;
                const deps = resolveDependencies();
                const proposal = typeof deps.findProposal === 'function' ? deps.findProposal(key) : null;
                if (!proposal) return false;
                starting = start(proposal, key, owner ? { focusOwnerId: owner } : { focusParcelId: focus })
                    .finally(() => { starting = null; });
                return starting;
            },
            // toggleAgreement(id) starts the comparison of the stored agreement `id`, replacing any
            // other comparison, or ends it when it is the one showing.
            async toggleAgreement(id) {
                const key = agreementKey(id);
                if (!key) return false;
                if (session && key === activeKey) { dispose(); return false; }
                if (starting) return starting;
                const deps = resolveDependencies();
                starting = Promise.resolve(typeof deps.findAgreement === 'function' ? deps.findAgreement(idOf(id)) : null)
                    .then(agreement => (agreement ? startAgreement(agreement, key) : false))
                    .finally(() => { starting = null; });
                return starting;
            }
        };
    }

    // The app's globals, read at call time: all of them load after this file.
    function browserDependencies(w) {
        const i18n = w.i18n;
        return {
            map: w.map, L: w.L,
            presenter: w.ParcelPresenter, fabric: w.LiveParcelFabric, repository: w.CadastralParcelRepository,
            claims: w.__claims,
            isApplied: w.isApplied,
            // An agreement's designs as this browser holds them, and the stored agreement itself.
            recordOf: id => (w.proposalStorage && typeof w.proposalStorage.getProposal === 'function' ? w.proposalStorage.getProposal(id) : null),
            findAgreement: id => (w.AgreementStore && typeof w.AgreementStore.get === 'function' ? w.AgreementStore.get(id) : null),
            footprintParts: w.__footprintParts && w.__footprintParts.footprintParts,
            attach: w.__MapBeforeAfter && w.__MapBeforeAfter.attach,
            findProposal: key => (typeof w.getProposalByIdOrHash === 'function' ? w.getProposalByIdOrHash(key) : null),
            // The version this record replaces: its source, unless the record is a land fork (a
            // counterproposal on different ground, not a version of the same thing).
            previousVersionOf: proposal => {
                if (!proposal || proposal.landFork) return null;
                const record = w.ProposalOrigin.resolveLocal(proposal.proposalOrigin, w.proposalStorage.getAllProposals());
                return record && record !== proposal ? record : null;
            },
            // Keep framed land clear of the details panel (proposals/list-ui.js).
            fitPadding: () => (typeof w.getProposalPanelFitPadding === 'function' ? w.getProposalPanelFitPadding(40) : null),
            buildingPool: () => (Array.isArray(w.buildingFeaturePool) ? w.buildingFeaturePool : []),
            buildingsShown: () => {
                const box = w.document.getElementById('showBuildings');
                if (box) return !!box.checked;
                return !!(w.buildingLayer && w.map && typeof w.map.hasLayer === 'function' && w.map.hasLayer(w.buildingLayer));
            },
            buildingStyle: () => (w.BuildingLayersDialog && w.BuildingLayersDialog.style)
                || (typeof w.buildingStyleForFeature === 'function' ? w.buildingStyleForFeature({}) : {}),
            parcelStyle: (id, feature) => (typeof w.getParcelBaseStyle === 'function' ? w.getParcelBaseStyle(id, null, { feature }) : null)
                || w.normalStyle || {},
            t: (key, fallback) => {
                try {
                    const text = i18n && typeof i18n.t === 'function' ? i18n.t(key) : null;
                    return text && text !== key ? text : fallback;
                } catch (_) { return fallback; }
            },
            warn: (...args) => console.warn(...args),
            onChange: (active, { key, focusParcelId } = {}) => {
                const agreement = typeof key === 'string' && key.startsWith(AGREEMENT_KEY_PREFIX);
                w.document.querySelectorAll('.btn-compare-proposal').forEach(button => button.setAttribute('aria-pressed', String(active && !agreement)));
                w.document.querySelectorAll('.btn-compare-parcel').forEach(button => {
                    button.setAttribute('aria-pressed', String(active && !!focusParcelId && button.dataset.focusParcel === String(focusParcelId)));
                });
                w.document.querySelectorAll('[data-agreement-action="compare"]').forEach(button => button.setAttribute('aria-pressed', String(active && agreement)));
            }
        };
    }

    return {
        canCompare, canCompareAgreement, agreementKey, agreementInputIds, beforeLayers, footprintFeatures, ownerFocusParts, focusBounds,
        create, browserDependencies, PREVIOUS_STYLE, FOCUS_BEFORE_STYLE, FOCUS_AFTER_STYLE
    };
});
