// _growRoadFabricForCorridor + _adoptCorridorFabric, mixed into ProposalManager via Object.assign.
// `this` is ProposalManager at call time (keeps using this._x() and proposal-manager.js bare-name globals).
//
// The additive half of a road merge. An applied road that grows keeps every parcel it already
// formed and takes ONLY the ground the drawing added; an absorbed road's parcels change hands
// instead of being re-cut. Neither path unapplies anything, so no slice is re-minted, no
// dependent proposal is dragged off the map, and untouched parcels are never even looked at.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProposalApplyRoadGrow = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    function growthApi() {
        if (typeof window !== 'undefined' && window.__corridorGrow) return window.__corridorGrow;
        return require('../corridor-grow.js');
    }

    function turfApi() {
        if (typeof turf !== 'undefined' && turf) return turf;
        return (typeof window !== 'undefined' && window.turf) ? window.turf : null;
    }

    function asIdList(list) {
        return (Array.isArray(list) ? list : [])
            .map(id => (id === undefined || id === null) ? '' : String(id))
            .filter(Boolean);
    }

    return {
    /**
     * Take the ground a grown corridor newly covers. The proposal stays applied throughout.
     *
     * @param {string} proposalId
     * @param {object} proposalData        the host record (already carrying the merged definition)
     * @param {object} options
     * @param {object} options.newGround   GeoJSON geometry — ground the corridor did NOT cover before
     * @param {string[]} [options.absorbedProposalIds]  roads folding into this one; their corridor
     *        parcels are this road's ground already and must not be cut by it
     * @returns {{corridorParcels:number, cutParcels:number, consumedParcels:number}|null}
     */
    _growRoadFabricForCorridor(proposalId, proposalData, options = {}) {
        const grow = growthApi();
        const turfLib = turfApi();
        const newGround = options.newGround;
        if (!turfLib || !newGround || !newGround.type || !proposalData) return null;

        const hostKey = String(_normalizeProposalId(proposalId) || proposalId || '');
        if (!hostKey) return null;
        const ownGround = new Set([hostKey, ...asIdList(options.absorbedProposalIds)]);

        const layerGroup = (typeof window !== 'undefined') ? window.parcelLayer : null;
        if (!layerGroup || typeof layerGroup.eachLayer !== 'function') {
            console.warn('[_growRoadFabricForCorridor] parcel layer unavailable; cannot form the new ground');
            return null;
        }

        let groundBounds = null;
        try { groundBounds = L.geoJSON({ type: 'Feature', properties: {}, geometry: newGround }).getBounds(); } catch (_) { groundBounds = null; }

        // Only the VISIBLE fabric is a candidate: a hidden parcel is already consumed by some
        // applied proposal, and the corridor's own ground (its parcels and those of the roads
        // merging into it) is road already.
        const candidates = new Map();
        layerGroup.eachLayer(layer => {
            const feature = layer && layer.feature;
            if (!feature || !feature.geometry || !feature.properties) return;
            const parcelId = _getParcelIdFromFeature(feature);
            if (parcelId === undefined || parcelId === null) return;
            const props = feature.properties;
            const isCorridor = props.isCorridor === true || props.isCorridor === 'true';
            if (isCorridor && ownGround.has(String(props.proposalId))) return;
            if (groundBounds) {
                try { if (!groundBounds.intersects(layer.getBounds())) return; } catch (_) { /* test the geometry instead */ }
            }
            candidates.set(String(parcelId), feature);
        });

        const plan = grow.planCorridorGrowth({
            newGround,
            parcels: Array.from(candidates.entries()).map(([id, feature]) => ({ id, geometry: feature.geometry })),
            turf: turfLib
        });
        if (!plan.corridorPieces.length && !plan.cuts.length) return null;

        // The corridor's new parcels are numbered against the root of the parcel it takes most
        // ground from — the same "first affected parcel" convention the full apply uses, made
        // deterministic here because a grown piece has no natural first. Over ground where nothing
        // is loaded there is no such parcel, so the road's own existing ancestry names it instead.
        const largestCut = plan.cuts.reduce((best, cut) => (!best || cut.takenArea > best.takenArea) ? cut : best, null);
        let rootSource = largestCut ? candidates.get(largestCut.parcelId) : null;
        if (!rootSource) {
            const fallbackParent = asIdList(proposalData.parentParcelIds)
                .map(id => this._getParcelLayerById(id))
                .find(layer => layer && layer.feature && layer.feature.properties);
            rootSource = fallbackParent ? fallbackParent.feature : null;
        }

        const newFeatures = [];
        const cutParentIds = [];
        const consumedIds = [];
        plan.cuts.forEach(cut => {
            const original = candidates.get(cut.parcelId);
            if (!original) return;
            cutParentIds.push(cut.parcelId);
            if (cut.consumed) consumedIds.push(cut.parcelId);
            cut.remainders.forEach(piece => {
                const remainder = this._buildCorridorRemainderFeature(original, piece, hostKey, proposalData);
                if (remainder) newFeatures.push(remainder);
            });
        });
        plan.corridorPieces.forEach(piece => {
            const corridor = this._buildGrownCorridorFeature(piece, rootSource, hostKey, proposalData);
            if (corridor) newFeatures.push(corridor);
        });
        if (!newFeatures.length && !cutParentIds.length) return null;

        // Continue the road's own numbering — its existing children keep their ids.
        const token = _buildSyntheticToken(hostKey, 'proposal');
        const existingChildIds = Array.from(new Set([
            ...asIdList(proposalData.childParcelIds),
            ...asIdList(proposalData.roadProposal && proposalData.roadProposal.childParcelIds)
        ]));
        this._assignSyntheticChildIdentities(hostKey, newFeatures, {
            startIndexByRootId: grow.nextSyntheticIndexByRoot(existingChildIds, token)
        });

        this._addFeaturesToMap(newFeatures, true, proposalData);

        const newIds = [];
        newFeatures.forEach(feature => {
            const parcelId = _getParcelIdFromFeature(feature);
            _ensureParcelIdOnProperties(feature.properties, parcelId);
            feature.properties.ancestorProposal = hostKey;
            delete feature.properties.descendantProposal;
            this._persistParcelFeature(feature);
            this._addProposalAsAncestor(parcelId, hostKey);
            if (feature.properties.isRoad && typeof window.addRoadParcel === 'function') {
                window.addRoadParcel(parcelId);
            }
            if (parcelId !== undefined && parcelId !== null) newIds.push(String(parcelId));
        });

        // Register the new ground BEFORE the parents leave the map: parent visibility is derived
        // from the applied proposals that claim them, so hiding first would flicker them back.
        this._recordCorridorFabric(proposalData, { parentIds: cutParentIds, childIds: newIds });
        this._setDescendantProposalOnParcels(cutParentIds, hostKey);
        this._markParcelsModifiedBatch(cutParentIds);
        this._markParcelsModifiedBatch(newIds);
        cutParentIds.forEach(id => {
            if (typeof window.hideParcelLayerById === 'function') window.hideParcelLayerById(id);
            else if (typeof window.removeParcelLayerById === 'function') window.removeParcelLayerById(id);
        });

        if (typeof proposalStorage !== 'undefined' && typeof proposalStorage.save === 'function') proposalStorage.save();

        const summary = {
            corridorParcels: plan.corridorPieces.length,
            cutParcels: cutParentIds.length,
            consumedParcels: consumedIds.length
        };
        console.info('[ProposalManager] Grew road proposal onto new ground', { proposalId: hostKey, ...summary });
        return summary;
    },

    /**
     * Hand an absorbed road's applied fabric to the road it merges into. Same parcels, same ids,
     * same geometry — only the owner changes, because the absorbed body's ground is unchanged by
     * the merge. Re-cutting it would re-mint every slice for nothing.
     */
    _adoptCorridorFabric(fromProposalId, fromData, hostProposalId, hostData) {
        if (!fromData || !hostData) return null;
        const hostKey = String(_normalizeProposalId(hostProposalId) || hostProposalId || '');
        if (!hostKey) return null;

        const childIds = Array.from(new Set([
            ...asIdList(fromData.childParcelIds),
            ...asIdList(fromData.roadProposal && fromData.roadProposal.childParcelIds)
        ]));
        const parentIds = Array.from(new Set([
            ...asIdList(fromData.parentParcelIds),
            ...asIdList(fromData.roadProposal && fromData.roadProposal.parentParcelIds)
        ]));
        const hostName = hostData.title || hostData.name || hostData.proposalName || null;

        childIds.forEach(parcelId => {
            this._upsertParcelProperties(parcelId, props => {
                props.proposalId = hostKey;
                props.ancestorProposal = hostKey;
                const isCorridor = props.isCorridor === true || props.isCorridor === 'true';
                if (isCorridor && hostName) props.roadName = hostName;
            }, { persistIfMissing: true });
        });

        this._recordCorridorFabric(hostData, { parentIds, childIds });
        this._setDescendantProposalOnParcels(parentIds, hostKey);
        if (typeof proposalStorage !== 'undefined' && typeof proposalStorage.save === 'function') proposalStorage.save();

        console.info('[ProposalManager] Adopted corridor fabric', {
            fromProposalId: String(fromProposalId || ''),
            proposalId: hostKey,
            parcels: childIds.length
        });
        return { adoptedParcels: childIds.length, adoptedParents: parentIds.length };
    },

    // Append to both places a road records its fabric (the record and its roadProposal mirror),
    // keeping them the identical set the apply path expects.
    _recordCorridorFabric(proposalData, { parentIds = [], childIds = [] } = {}) {
        if (!proposalData) return;
        const road = proposalData.roadProposal || (proposalData.roadProposal = {});
        const mergedParents = Array.from(new Set([
            ...asIdList(proposalData.parentParcelIds),
            ...asIdList(road.parentParcelIds),
            ...asIdList(parentIds)
        ]));
        const mergedChildren = Array.from(new Set([
            ...asIdList(proposalData.childParcelIds),
            ...asIdList(road.childParcelIds),
            ...asIdList(childIds)
        ]));
        proposalData.parentParcelIds = mergedParents.slice();
        road.parentParcelIds = mergedParents.slice();
        proposalData.childParcelIds = mergedChildren.slice();
        road.childParcelIds = mergedChildren.slice();
        if (typeof proposalStorage !== 'undefined' && typeof proposalStorage._indexProposal === 'function') {
            proposalStorage._indexProposal(proposalData);
        }
    },

    // A remainder its owner keeps. Same shape the full apply mints (proposal-manager.js
    // _buildChildFeaturesFromDefinition), including the DIRECT-parent-only road-ness rule.
    _buildCorridorRemainderFeature(original, piece, hostKey, proposalData) {
        if (!original || !piece || !Array.isArray(piece.coords)) return null;
        const parcelId = _getParcelIdFromFeature(original);
        const originalProps = original.properties || {};
        const clone = JSON.parse(JSON.stringify(original));
        clone.geometry = { type: 'Polygon', coordinates: piece.coords };
        const props = clone.properties;
        props.calculatedArea = piece.area;
        props.parentParcelId = parcelId;
        props.parentParcelNumber = originalProps.BROJ_CESTICE;
        props.rootParcelNumber = _resolveRootParcelNumberFromProperties(originalProps, parcelId)
            || _extractRootParcelNumber(originalProps.BROJ_CESTICE);
        props.rootParcelId = _resolveRootParcelIdFromProperties(originalProps, parcelId)
            || _extractRootParcelId(parcelId === undefined || parcelId === null ? '' : String(parcelId));
        props.proposalId = hostKey;
        delete props.descendantProposal;
        const parentIsRoad = originalProps.isRoad === true || originalProps.isRoad === 'true'
            || (parcelId && typeof window.isRoadParcel === 'function' && window.isRoadParcel(String(parcelId)));
        props.isRoad = !!parentIsRoad;
        props.isCorridor = originalProps.isCorridor === true || originalProps.isCorridor === 'true';
        _assignOwnershipDetails(clone, {
            parentFeature: original,
            defaultOwnerName: (proposalData && proposalData.author) || 'User'
        });
        return clone;
    },

    // A new stretch of the corridor itself.
    _buildGrownCorridorFeature(piece, rootSource, hostKey, proposalData) {
        if (!piece || !Array.isArray(piece.coords)) return null;
        const definition = (proposalData && proposalData.roadProposal && proposalData.roadProposal.definition) || {};
        const isTrack = corridorIsTrack(definition)
            || definition?.metadata?.type === 'track'
            || definition?.type === 'track';
        const sourceProps = (rootSource && rootSource.properties) || {};
        const sourceId = rootSource ? _getParcelIdFromFeature(rootSource) : null;
        const rootNumber = _resolveRootParcelNumberFromProperties(sourceProps, sourceId)
            || _extractRootParcelNumber(sourceProps.BROJ_CESTICE) || 'parcel';
        const rootParcelId = _resolveRootParcelIdFromProperties(sourceProps, sourceId)
            || _extractRootParcelId(sourceId === undefined || sourceId === null ? '' : String(sourceId)) || 'parcel';

        const feature = {
            type: 'Feature',
            properties: {
                isRoad: !isTrack, // tracks are NOT roads
                isCorridor: true,
                isTrack,
                calculatedArea: piece.area,
                roadName: (proposalData && (proposalData.title || proposalData.name)) || 'Road',
                isProposed: true,
                proposalId: hostKey,
                parentParcelId: sourceId || null,
                parentParcelNumber: sourceProps.BROJ_CESTICE || null,
                rootParcelNumber: rootNumber,
                rootParcelId
            },
            geometry: { type: 'Polygon', coordinates: piece.coords }
        };
        if (isTrack && Array.isArray(definition.points)) {
            feature.properties.trackPoints = definition.points;
        }
        _assignOwnershipDetails(feature, {
            defaultOwnerName: (proposalData && proposalData.author) || 'User',
            overwriteExisting: true
        });
        return feature;
    },
    };
});
