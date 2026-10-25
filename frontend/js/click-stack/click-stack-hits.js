// Everything under one map point, by geometry rather than by which layer is drawn on top
// (click-stack.md): designs and parcels from the drill stack, buildings from the drawn building
// layers, permitted massing from the planning views. With no design under the point, the parcel
// there adds its buildings and designs.
// Returns the hits object the pure click-stack model orders.
(function (global) {
    'use strict';

    function parcelLabel(id, feature) {
        const props = (feature && feature.properties) || {};
        if (props.rootParcelNumber) {
            const ordinal = props.syntheticIndex !== undefined && props.syntheticIndex !== null ? ` #${props.syntheticIndex}` : '';
            return `${props.rootParcelNumber}${ordinal}`;
        }
        try {
            const number = feature && global.getParcelDisplayNumberFromFeature?.(feature, '');
            if (number) return String(number);
        } catch (_) { }
        return String(id).replace(/^HR-\d+-/, '');
    }

    // A building's name or address when the survey has one, else its footprint area.
    function buildingLabel(feature) {
        const props = feature.properties || {};
        const named = props.name || props.address || props.addr_street;
        if (named) return String(named);
        try { return global.CbFormat.formatArea(global.turf.area(feature), { maxFractionDigits: 0 }); } catch (_) { return ''; }
    }

    function designLabel(proposal, key) {
        return String(proposal.title || proposal.name || key);
    }

    function baseFeature(id) {
        try { return global.CadastralParcelRepository?.get?.(String(id)) || global.LiveParcelFabric?.get?.(String(id)) || null; }
        catch (_) { return null; }
    }

    // The cadastral parcels a formation or a design stands on, when there are several (a merged
    // park, a corridor): explicit provenance ids, the clicked one first.
    function parcelSetOf(entry) {
        const ids = entry.kind === 'proposal'
            ? entry.proposal?.cadastreParcelIds
            : entry.feature?.properties?.cadastreParcelIds;
        return Array.isArray(ids) ? Array.from(new Set(ids.map(String).filter(Boolean))) : [];
    }

    // A live piece cut from a cadastral parcel (what a road leaves either side of it) is formed
    // ground even when no design names it as its product: its own id is not one of the cadastral
    // parcels it lies on.
    function isFragment(entry) {
        const ids = entry.feature?.properties?.cadastreParcelIds;
        return Array.isArray(ids) && ids.length > 0 && !ids.map(String).includes(String(entry.id));
    }

    // What stands on the parcel under the point when no design is there (click-stack.md): its
    // buildings and its proposals, this browser's and the published ones it holds no copy of
    // (ParcelSetProposals). They are marked onParcel, so the point's own hits keep the first place.
    // onPublished runs once the published proposals arrive, when they were not known yet.
    function onParcel(parcel, onPublished) {
        const designs = [], built = [];
        try {
            const { entries } = global.ParcelSetProposals.lookup([parcel.id], { onPublished });
            entries.forEach(entry => {
                const key = entry.serverId || global.getProposalKey?.(entry.proposal) || entry.proposal.proposalId;
                designs.push({ id: String(key), label: designLabel(entry.proposal, key), createdAt: entry.proposal.createdAt,
                    proposal: entry.proposal, goal: entry.proposal.goal || '', serverId: entry.serverId || null, onParcel: true });
            });
        } catch (error) { console.error('[ClickStack] the parcel\'s proposals could not be listed', error); }
        try {
            (global.buildingsOn?.(parcel.feature) || []).forEach(hit => built.push({ id: hit.id, feature: hit.feature,
                demolition: hit.demolition, tunnelled: hit.tunnelled, label: buildingLabel(hit.feature), onParcel: true }));
        } catch (error) { console.error('[ClickStack] the parcel\'s buildings could not be listed', error); }
        return { designs, built };
    }

    function hitsAt(latlng, { onPublished } = {}) {
        const stack = global.__drillUi?.stackAt(latlng) || [];
        const designs = [], formed = [], parcels = [];
        for (const entry of stack) {
            if (entry.kind === 'proposal') {
                designs.push({ id: entry.key, label: designLabel(entry.proposal, entry.key), createdAt: entry.proposal.createdAt,
                    proposal: entry.proposal, goal: entry.proposal.goal || '', entry });
            } else if (entry.depth > 0 || isFragment(entry)) {
                const producer = entry.producerId;
                const proposal = producer ? global.proposalStorage?.getProposal?.(producer) : null;
                formed.push({ id: entry.id, label: parcelLabel(entry.id, entry.feature), feature: entry.feature, entry,
                    designId: producer, designLabel: proposal ? designLabel(proposal, producer) : producer });
            } else {
                parcels.push({ id: entry.id, label: parcelLabel(entry.id, entry.feature), feature: entry.feature, live: true, entry });
            }
        }
        // Several cadastral parcels under one formation or design: list them all, the one under the
        // point (if any) first; consumed ones are read from the registry.
        const owner = formed[0]?.entry || designs[0]?.entry;
        const set = owner ? parcelSetOf(owner) : [];
        if (set.length > 1 || (!parcels.length && set.length)) {
            const first = parcels[0]?.id;
            const ordered = Array.from(new Set([first, ...set].filter(Boolean)));
            const live = new Map(parcels.map(parcel => [parcel.id, parcel]));
            parcels.length = 0;
            ordered.forEach(id => {
                const feature = live.get(id)?.feature || baseFeature(id);
                parcels.push(live.get(id) || { id, label: parcelLabel(id, feature), feature, live: false });
            });
        }
        let built = [];
        try { built = (global.buildingsAt?.(latlng) || []).map(hit => ({ id: hit.id, feature: hit.feature, demolition: hit.demolition,
            tunnelled: hit.tunnelled, label: buildingLabel(hit.feature) })); }
        catch (error) { console.error('[ClickStack] buildings could not be hit-tested', error); }
        let permitted = [];
        try {
            permitted = (global.PlanningViews?.isReady?.() ? global.PlanningViews.itemsAt(latlng) : [])
                .filter(item => item.role === 'permitted')
                .map(item => ({ id: item.id, label: item.source?.parcel || item.title || item.id, item }));
        } catch (error) { console.error('[ClickStack] massing could not be hit-tested', error); }
        const ground = designs.length ? null : [...formed, ...parcels].find(parcel => parcel.live !== false && parcel.feature);
        if (ground) {
            const extra = onParcel(ground, onPublished);
            const has = (list, id) => list.some(item => String(item.id) === String(id));
            designs.push(...extra.designs.filter(item => !has(designs, item.id)));
            built.push(...extra.built.filter(item => !has(built, item.id)));
        }
        const hits = { designs, built, permitted, formed, parcels, ground: [] };
        // Nothing at all here: bare ground offers what can be drawn on it, when the place has no
        // register to wait for (ui/ground-menu-model.js decides).
        if (!designs.length && !built.length && !permitted.length && !formed.length && !parcels.length
            && global.GroundMenu?.isBareGround?.(latlng)) hits.ground = [{ id: 'here', label: '' }];
        return hits;
    }

    // The selected object's own geometry, shared by the 2D and model-view focus outlines.
    // A design's source parcels are provenance; its authored/result geometry is the selection.
    function featuresFor(kind, instance) {
        if (!instance) return [];
        const designFeatures = key => {
            const proposal = global.proposalStorage?.getProposal?.(String(key));
            if (!proposal) return [];
            if (global.collectProposalFeatureSets) return global.collectProposalFeatureSets(proposal, { includeBuildingGeometry: true }).primaryFeatures;
            const footprint = global.__planOrder?.footprintOf?.(proposal);
            return footprint ? [footprint] : [];
        };
        let features = [];
        if (kind === 'plans') features = instance.features || [];
        else if (kind === 'designs') features = designFeatures(instance.id);
        else if (kind === 'permitted') {
            const item = instance.item || global.PlanningViews?.getItems?.().find(item => item.id === instance.id);
            const shapes = item && global.PlanningViews?.permittedFeatures?.(item);
            features = shapes ? [...shapes.body, ...shapes.bound] : [];
            if (!features.length && item?.site) features = [item.site];
        } else if (kind === 'selection') features = [...(global.multiParcelSelection?.selectedParcels || [])].map(id => global.LiveParcelFabric?.get?.(String(id)));
        else if (kind === 'parcels' && instance.live === false) features = [global.CadastralParcelRepository?.get?.(String(instance.id)) || instance.feature];
        else features = [instance.feature || global.LiveParcelFabric?.get?.(String(instance.id)) || baseFeature(instance.id)];
        return features.filter(feature => feature?.geometry && ['Polygon', 'MultiPolygon', 'LineString', 'MultiLineString'].includes(feature.geometry.type));
    }

    global.ClickStackHits = Object.freeze({ hitsAt, parcelLabel, featuresFor });
})(window);
