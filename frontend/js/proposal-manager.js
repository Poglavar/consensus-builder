function _buildSyntheticToken(value, fallback = 'proposal') {
    const base = (value !== undefined && value !== null) ? String(value) : String(fallback || 'proposal');
    const sanitize = (raw) => String(raw || '')
        .trim()
        .replace(/#/g, '') // avoid colliding with the delimiter
        .replace(/\s+/g, '')
        .replace(/[^a-zA-Z0-9_-]+/g, '');

    const sanitized = sanitize(base);
    const fallbackSanitized = sanitize(fallback || 'proposal') || 'proposal';
    return sanitized || fallbackSanitized;
}

function _composeSyntheticParcelNumber(rootNumber, token, index) {
    const rawRoot = (rootNumber !== undefined && rootNumber !== null && String(rootNumber).trim().length)
        ? String(rootNumber).trim()
        : null;
    const safeRoot = rawRoot
        ? (_extractRootParcelNumber(rawRoot) || rawRoot.replace(/\s+/g, ''))
        : null;
    const safeIndex = Number(index) || 1;
    return safeRoot ? `${safeRoot}#${token}-${safeIndex}` : `${token}-${safeIndex}`;
}

function _composeSyntheticParcelId(rootParcelId, token, index) {
    const rawRoot = (rootParcelId !== undefined && rootParcelId !== null && String(rootParcelId).trim().length)
        ? String(rootParcelId).trim()
        : null;
    const safeRoot = rawRoot
        ? (_extractRootParcelId(rawRoot) || rawRoot.replace(/\s+/g, ''))
        : null;
    const safeIndex = Number(index) || 1;
    return safeRoot ? `${safeRoot}#${token}-${safeIndex}` : `${token}-${safeIndex}`;
}

// NOTE: child parcel ids are assigned solely by the id subsystem (_assignSyntheticChildIdentities /
// getNextIdentity) from the current rules — deterministically derived from (proposalId → token,
// root parcel, running index). A proposal never carries a canonical id list to reproduce: if the
// geometry or the id rules change, children simply get different ids, and that is fine. The
// consensus layer (acceptance / sale / ownership transfer) is entirely parent-keyed, so child-id
// identity is a local concern of whichever apply produced them, not something to recreate.

function _escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _parseSyntheticIndexFromIdentifiers(parcelNumber, parcelId, token) {
    const normalizedToken = token ? _buildSyntheticToken(token) : null;

    const tryMatch = (value) => {
        if (!value) return null;
        const str = String(value);

        if (normalizedToken) {
            const escaped = _escapeRegExp(normalizedToken);
            const directMatch = str.match(new RegExp(`#${escaped}-(\\d+)$`));
            if (directMatch) {
                const parsed = Number(directMatch[1]);
                if (Number.isFinite(parsed)) return parsed;
            }
            // Legacy "/token/idx" form for back-compat
            const legacyMatch = str.match(new RegExp(`${escaped}/(\\d+)$`));
            if (legacyMatch) {
                const parsed = Number(legacyMatch[1]);
                if (Number.isFinite(parsed)) return parsed;
            }
            const legacyUnderscore = str.match(new RegExp(`${escaped}_(\\d+)$`));
            if (legacyUnderscore) {
                const parsed = Number(legacyUnderscore[1]);
                if (Number.isFinite(parsed)) return parsed;
            }
        }

        const hashGeneric = str.match(/#([^#]+)-(\d+)$/);
        if (hashGeneric) {
            const parsed = Number(hashGeneric[2]);
            if (Number.isFinite(parsed)) return parsed;
        }

        const tailNumeric = str.match(/(\d+)$/);
        if (tailNumeric) {
            const parsed = Number(tailNumeric[1]);
            if (Number.isFinite(parsed)) return parsed;
        }

        return null;
    };

    return tryMatch(parcelId) ?? tryMatch(parcelNumber);
}

/**
 * Client-generated parcel ids (subdivision, proposal chaining, government-roads splits)
 * must not be requested from the cadastre API. Kept aligned with focusProposalDetails /
 * findMissingParentParcels filtering.
 */
function isSyntheticParcelId(rawId) {
    if (rawId === undefined || rawId === null) return false;
    const id = String(rawId);
    if (!id) return false;
    if (id.includes('#')) return true;
    // Road subdivision token segment (hex), e.g. …_a1b2c3d4_…
    if (/_[0-9a-f]{4,}_/.test(id)) return true;
    // government-roads.js composeSyntheticParcelId: `${safeRoot}_${token}_${index}` — token is often
    // alphabetic (e.g. "proposal"), so the hex pattern above does not match.
    if (/^HR-\d+-\d+_[a-z0-9]+_\d+$/i.test(id)) return true;
    return false;
}

function _normalizeParcelId(value) {
    if (value === undefined || value === null) return null;
    try {
        return value.toString();
    } catch (_) {
        return String(value);
    }
}

function _getParcelIdFromProperties(props) {
    if (!props) return null;
    const candidateOrder = [
        () => (typeof ensureParcelId === 'function' ? ensureParcelId({ properties: props }) : null),
        () => props.parcelId,
        () => props.parcel_id,
        () => props.id
    ];
    for (const getter of candidateOrder) {
        try {
            const value = getter();
            const normalized = _normalizeParcelId(value);
            if (normalized) return normalized;
        } catch (_) { /* ignore */ }
    }
    return null;
}

function _getParcelIdFromFeature(feature) {
    if (!feature) return null;
    if (typeof ensureParcelId === 'function') {
        try {
            const ensured = ensureParcelId(feature);
            const normalized = _normalizeParcelId(ensured);
            if (normalized) return normalized;
        } catch (_) { /* ignore */ }
    }
    return _getParcelIdFromProperties(feature.properties);
}

function _ensureParcelIdOnProperties(props, parcelId) {
    if (!props) return null;
    const resolved = _normalizeParcelId(parcelId) || _getParcelIdFromProperties(props);
    if (!resolved) return null;
    props.parcelId = resolved;
    return resolved;
}

function _normalizeOwnerRecord(owner, index, fallbackName) {
    const baseName = owner?.ownerLabel || owner?.name || owner?.possessorName || fallbackName || `Owner ${index + 1}`;
    const pct = Number.isFinite(owner?.percentageShare)
        ? owner.percentageShare
        : (Number.isFinite(owner?.percentage) ? owner.percentage : null);
    const shareText = owner?.actualShareText
        || owner?.ownership
        || owner?.shareText
        || (pct !== null ? `${pct}%` : '100%');

    return {
        name: baseName,
        ownerLabel: baseName,
        percentageShare: pct !== null ? pct : undefined,
        actualShareText: shareText,
        shareDetail: owner?.shareDetail || owner?.detail || ''
    };
}

function _extractOwnersFromProperties(props) {
    if (!props) return null;
    if (Array.isArray(props?.ownershipDetails?.owners) && props.ownershipDetails.owners.length) {
        return props.ownershipDetails.owners;
    }
    if (Array.isArray(props?.ownershipList) && props.ownershipList.length) {
        return props.ownershipList;
    }
    return null;
}

function _readOwnersFromCache(parcelId) {
    if (!parcelId) return null;
    try {
        const cache = (typeof window !== 'undefined' && window.ParcelsOwnershipUi && window.ParcelsOwnershipUi.parcelOwnerDataCache)
            ? window.ParcelsOwnershipUi.parcelOwnerDataCache
            : null;
        if (cache && typeof cache.get === 'function') {
            const owners = cache.get(parcelId);
            return Array.isArray(owners) && owners.length ? owners : null;
        }
    } catch (_) { /* ignore */ }
    return null;
}

function _getOwnershipTypeForOwners(owners) {
    if (!Array.isArray(owners) || owners.length === 0) return undefined;
    const classify = (typeof getOwnershipType === 'function')
        ? getOwnershipType
        : (typeof window !== 'undefined' && typeof window.getOwnershipType === 'function'
            ? window.getOwnershipType
            : null);
    if (!classify) return undefined;
    const types = owners.map(owner => classify(owner)).filter(Boolean);
    if (!types.length) return undefined;
    const unique = Array.from(new Set(types));
    return unique.length === 1 ? unique[0] : 'mixed';
}

function _assignOwnershipDetails(targetFeature, options = {}) {
    if (!targetFeature || typeof targetFeature !== 'object') return;
    const props = targetFeature.properties || (targetFeature.properties = {});
    const {
        parentFeature = null,
        defaultOwnerName = null,
        forceDefaultOwner = false,
        overwriteExisting = false
    } = options;

    const existingOwners = Array.isArray(props?.ownershipDetails?.owners) ? props.ownershipDetails.owners : null;
    const hasExisting = existingOwners && existingOwners.length > 0;
    if (hasExisting && !overwriteExisting && !forceDefaultOwner) {
        const normalizedOwners = existingOwners.map((owner, index) => _normalizeOwnerRecord(owner, index, defaultOwnerName));
        props.ownershipDetails = Object.assign({}, props.ownershipDetails, { owners: normalizedOwners });
        const existingType = _getOwnershipTypeForOwners(normalizedOwners);
        if (existingType && !props.ownershipType) {
            props.ownershipType = existingType;
        }
        return;
    }

    let ownersSource = null;

    if (!forceDefaultOwner) {
        ownersSource = _extractOwnersFromProperties(props);
        if ((!ownersSource || ownersSource.length === 0) && parentFeature) {
            const parentProps = parentFeature.properties || parentFeature;
            ownersSource = _extractOwnersFromProperties(parentProps);
            if (!ownersSource || ownersSource.length === 0) {
                const parentParcelId = _getParcelIdFromFeature(parentFeature) || _getParcelIdFromProperties(parentProps);
                ownersSource = _readOwnersFromCache(parentParcelId);
            }
        }
    }

    let owners = ownersSource;

    if ((!owners || owners.length === 0) && defaultOwnerName) {
        owners = [{
            name: defaultOwnerName,
            ownerLabel: defaultOwnerName,
            percentageShare: 100,
            actualShareText: '100%'
        }];
    }

    if (!owners || owners.length === 0) return;

    const normalizedOwners = owners.map((owner, index) => _normalizeOwnerRecord(owner, index, defaultOwnerName));
    props.ownershipDetails = Object.assign({}, props.ownershipDetails, { owners: normalizedOwners });

    const ownershipType = _getOwnershipTypeForOwners(normalizedOwners);
    if (ownershipType && !props.ownershipType) {
        props.ownershipType = ownershipType;
    }
}

function _normalizeProposalId(value) {
    if (value === undefined || value === null) return null;
    try {
        return String(value);
    } catch (_) {
        return null;
    }
}

function _getProposalApplyLabel(proposalId, proposalData) {
    const title = proposalData && typeof proposalData.title === 'string'
        ? proposalData.title.trim()
        : '';
    return title || _normalizeProposalId(proposalId) || 'unknown-proposal';
}

async function _runProposalApplyWithSummary(proposalId, proposalData, runApply) {
    const label = _getProposalApplyLabel(proposalId, proposalData);
    try {
        const result = await runApply();
        if (result === false) {
            console.warn(`Applying proposal ${label} ... failed`);
            return false;
        }
        console.log(`Applying proposal ${label} ... done`);
        return result;
    } catch (error) {
        console.warn(`Applying proposal ${label} ... failed`);
        throw error;
    }
}

function _normalizeIdList(list) {
    return Array.from(new Set(
        (Array.isArray(list) ? list : [])
            .map(v => (v !== undefined && v !== null ? v.toString() : null))
            .filter(Boolean)
    ));
}

function _getParentIdsForProposal(proposal) {
    if (!proposal) return [];
    if (proposal.roadProposal && Array.isArray(proposal.roadProposal.parentParcelIds)) {
        return _normalizeIdList(proposal.roadProposal.parentParcelIds);
    }
    if (proposal.reparcellization && Array.isArray(proposal.reparcellization.parentParcelIds)) {
        return _normalizeIdList(proposal.reparcellization.parentParcelIds);
    }
    if (proposal.decideLaterProposal && Array.isArray(proposal.decideLaterProposal.parentParcelIds)) {
        return _normalizeIdList(proposal.decideLaterProposal.parentParcelIds);
    }
    if (proposal.buildingProposal && Array.isArray(proposal.buildingProposal.parentParcelIds)) {
        return _normalizeIdList(proposal.buildingProposal.parentParcelIds);
    }
    if (proposal.structureProposal && Array.isArray(proposal.structureProposal.parentParcelIds)) {
        return _normalizeIdList(proposal.structureProposal.parentParcelIds);
    }
    if (Array.isArray(proposal.parentParcelIds)) {
        return _normalizeIdList(proposal.parentParcelIds);
    }
    return [];
}

function _getChildIdsForProposal(proposal) {
    if (!proposal) return [];
    const buckets = [];
    if (proposal.roadProposal && Array.isArray(proposal.roadProposal.childParcelIds)) buckets.push(proposal.roadProposal.childParcelIds);
    if (proposal.decideLaterProposal && Array.isArray(proposal.decideLaterProposal.childParcelIds)) buckets.push(proposal.decideLaterProposal.childParcelIds);
    if (proposal.reparcellization && Array.isArray(proposal.reparcellization.childParcelIds)) buckets.push(proposal.reparcellization.childParcelIds);
    if (proposal.buildingProposal && Array.isArray(proposal.buildingProposal.childParcelIds)) buckets.push(proposal.buildingProposal.childParcelIds);
    if (Array.isArray(proposal.childParcelIds)) buckets.push(proposal.childParcelIds);
    return _normalizeIdList(buckets.flat());
}

async function _ensureParentsAvailable(parentIds) {
    // Wait for PersistentStorage to be ready before reading parcel data
    if (typeof PersistentStorage !== 'undefined' && PersistentStorage && typeof PersistentStorage.ensureReady === 'function') {
        await new Promise(resolve => PersistentStorage.ensureReady(resolve));
    }

    const ids = _normalizeIdList(parentIds);

    // Separate synthetic IDs (child parcels from other proposals) from real cadastre
    // IDs. Synthetic IDs cannot be fetched from the parcel server.
    const syntheticIds = ids.filter(isSyntheticParcelId);
    const realIds = ids.filter(id => !isSyntheticParcelId(id));

    const missing = realIds.filter(id => {
        try {
            return !(typeof resolveParcelLayerById === 'function' && resolveParcelLayerById(id));
        } catch (_) {
            return true;
        }
    });

    if (syntheticIds.length) {
        console.debug(`[_ensureParentsAvailable] Skipping ${syntheticIds.length} synthetic parent IDs (from other proposals)`);
    }
    if (!missing.length) return;

    console.debug(`[_ensureParentsAvailable] ${missing.length} real parents missing from index`);

    // Step 1: Try to rehydrate parents from PersistentStorage first (faster than network)
    const rehydratedFeatures = [];
    const stillMissing = [];
    missing.forEach(id => {
        const fromDisk = _buildFeatureFromPersisted(id);
        if (fromDisk && fromDisk.geometry) {
            rehydratedFeatures.push(fromDisk);
        } else {
            stillMissing.push(id);
        }
    });

    console.debug(`[_ensureParentsAvailable] Storage check: ${rehydratedFeatures.length} found, ${stillMissing.length} still missing`);

    if (rehydratedFeatures.length && typeof ingestParcelFeatures === 'function') {
        try {
            await ingestParcelFeatures(rehydratedFeatures, { replaceExisting: false });
            console.debug(`[_ensureParentsAvailable] Rehydrated ${rehydratedFeatures.length} parent(s) from storage`);
        } catch (e) { console.warn(`[_ensureParentsAvailable] Ingest from storage failed:`, e); }
    }

    // Step 2: Fetch remaining from backend (cap at 200 to avoid flooding)
    if (stillMissing.length && stillMissing.length <= 200) {
        console.debug(`[_ensureParentsAvailable] Fetching ${stillMissing.length} parents from network`);
        if (typeof fetchParcelsByIds === 'function') {
            try {
                const fetched = await fetchParcelsByIds(stillMissing, { forceRefresh: false });
                console.debug(`[_ensureParentsAvailable] Network fetch returned ${fetched ? fetched.length : 0} layers`);
            } catch (e) { console.warn(`[_ensureParentsAvailable] Network fetch failed:`, e); }
        } else if (typeof fetchParcelFeaturesByIds === 'function') {
            try {
                const features = await fetchParcelFeaturesByIds(stillMissing);
                if (features && features.length && typeof ingestParcelFeatures === 'function') {
                    await ingestParcelFeatures(features, { replaceExisting: false });
                }
            } catch (e) { console.warn(`[_ensureParentsAvailable] Network fetch (alt) failed:`, e); }
        }
    } else if (stillMissing.length > 200) {
        console.warn(`[_ensureParentsAvailable] ${stillMissing.length} parents still missing, too many to fetch on reapply — will load when viewport moves there`);
    }
}

function _shouldSkipChildFeature(feature) {
    if (!feature || !feature.properties) return false;
    const props = feature.properties;
    const marker = props.descendantProposal || props.descendantProposals;
    if (Array.isArray(marker)) return marker.length > 0;
    return !!marker;
}

function _buildFeatureFromPersisted(parcelId) {
    if (typeof readPersistedParcelRecord !== 'function') return null;
    const record = readPersistedParcelRecord(parcelId);
    if (!record || !record.geometry || !record.properties) return null;
    return {
        type: 'Feature',
        geometry: record.geometry,
        properties: Object.assign({}, record.properties, { parcelId: parcelId })
    };
}

async function _rehydrateChildFeatures(proposal, childIds) {
    // Wait for PersistentStorage to be ready before reading parcel data
    if (typeof PersistentStorage !== 'undefined' && PersistentStorage && typeof PersistentStorage.ensureReady === 'function') {
        await new Promise(resolve => PersistentStorage.ensureReady(resolve));
    }

    const ids = _normalizeIdList(childIds);
    const features = [];

    // Prefer cached childFeatures bundled with the proposal (roads/decide-later store them)
    if (proposal && Array.isArray(proposal.childParcelIds) && Array.isArray(proposal.childFeatures)) {
        proposal.childFeatures.forEach(f => {
            const pid = _getParcelIdFromFeature(f);
            if (pid && ids.includes(pid.toString())) {
                features.push(f);
            }
        });
    }

    // Road helper: load persisted assets
    if (proposal && proposal.roadProposal && typeof ProposalManager._loadRoadProposalAssets === 'function') {
        try {
            const assets = ProposalManager._loadRoadProposalAssets(proposal, {
                includeParents: false,
                includeChildren: true,
                includeKeepDetails: true,
                allowMissing: true
            });
            if (Array.isArray(assets.childFeatures)) {
                assets.childFeatures.forEach(f => {
                    const pid = _getParcelIdFromFeature(f);
                    if (pid && ids.includes(pid.toString())) {
                        features.push(f);
                    }
                });
            }
        } catch (_) { /* ignore */ }
    }

    // Fill gaps from persisted storage
    ids.forEach(id => {
        const already = features.find(f => _getParcelIdFromFeature(f)?.toString() === id);
        if (!already) {
            const fromDisk = _buildFeatureFromPersisted(id);
            if (fromDisk) features.push(fromDisk);
        }
    });

    // Fallback: fetch missing children from source (should be rare)
    const missing = ids.filter(id => !features.find(f => _getParcelIdFromFeature(f)?.toString() === id));
    if (missing.length && typeof fetchParcelFeaturesByIds === 'function') {
        try {
            const fetched = await fetchParcelFeaturesByIds(missing);
            if (Array.isArray(fetched)) {
                features.push(...fetched);
            }
        } catch (_) { /* best-effort */ }
    }

    // Re-apply track tagging if this is a track proposal
    const isTrackProposal = (proposal?.roadProposal?.definition?.metadata?.isTrack === true)
        || (proposal?.roadProposal?.definition?.metadata?.type === 'track')
        || (proposal?.roadProposal?.definition?.type === 'track');
    if (isTrackProposal && features.length > 0) {
        const trackPointsRaw = proposal?.roadProposal?.definition?.points;
        // Flatten nested arrays
        const flattenTrackPoints = (points) => {
            if (!Array.isArray(points)) return null;
            const result = [];
            const walk = (arr) => {
                if (!Array.isArray(arr)) return;
                arr.forEach(p => {
                    if (Array.isArray(p) && p.length > 0 && Array.isArray(p[0])) {
                        walk(p);
                    } else if (p !== undefined && p !== null) {
                        result.push(p);
                    }
                });
            };
            walk(points);
            return result;
        };
        const trackPoints = flattenTrackPoints(trackPointsRaw);
        console.debug('[_rehydrateChildFeatures] re-tagging track features', {
            proposalId: proposal?.proposalId,
            featureCount: features.length,
            trackPointCount: Array.isArray(trackPoints) ? trackPoints.length : 0
        });
        features.forEach(f => {
            if (!f || !f.properties) return;
            // Only tag corridor children (isCorridor=true or already isTrack=true)
            if (f.properties.isCorridor === true || f.properties.isTrack === true) {
                f.properties.isTrack = true;
                f.properties.isCorridor = true;
                f.properties.isRoad = false; // tracks are NOT roads
                if (!f.properties.trackPoints && Array.isArray(trackPoints)) {
                    f.properties.trackPoints = trackPoints;
                }
            }
        });
    }

    return features;
}

async function _reapplyAppliedProposal(proposal) {
    if (!proposal) return;
    const goal = ProposalManager._normalizeGoalKey(proposal.goal);
    const parentIds = _getParentIdsForProposal(proposal);
    const childIds = _getChildIdsForProposal(proposal);
    const proposalId = proposal.proposalId ? String(proposal.proposalId) : 'unknown';

    console.debug(`[_reapplyAppliedProposal] Starting for ${proposalId}`, { parentIds, childIds, goal });

    // Recovery: if parcelLayer has layers but parcelLayerById is empty/uninitialized,
    // rebuild the id map (and index) from the visible parcelLayer contents.
    try {
        const parcelLayer = (typeof window !== 'undefined') ? window.parcelLayer : null;
        const layerCount = parcelLayer && typeof parcelLayer.getLayers === 'function' ? parcelLayer.getLayers().length : 0;
        const mapSize = (typeof window !== 'undefined' && window.parcelLayerById instanceof Map) ? window.parcelLayerById.size : 0;
        if (layerCount > 0 && mapSize === 0 && typeof window !== 'undefined' && typeof window.rebuildParcelLayerByIdFromParcelLayer === 'function') {
            const stats = window.rebuildParcelLayerByIdFromParcelLayer({ includeIndexRebuild: true, reason: 'reapply' });
            console.debug(`[_reapplyAppliedProposal] ${proposalId}: Rebuilt parcelLayerById from parcelLayer`, stats);
        }
    } catch (_) { }

    // Ensure parents are present in cache/map before proceeding
    await _ensureParentsAvailable(parentIds);

    // Verify parents are now available
    let parentsAvailable = parentIds.filter(id => typeof resolveParcelLayerById === 'function' && resolveParcelLayerById(id));

    // If we still can't resolve any parents but parcels are visible, rebuild the map/index once.
    try {
        if (parentsAvailable.length === 0 && parentIds.length > 0 && typeof window !== 'undefined') {
            const parcelLayer = window.parcelLayer;
            const layerCount = parcelLayer && typeof parcelLayer.getLayers === 'function' ? parcelLayer.getLayers().length : 0;
            if (layerCount > 0 && typeof window.rebuildParcelLayerByIdFromParcelLayer === 'function') {
                const stats = window.rebuildParcelLayerByIdFromParcelLayer({ includeIndexRebuild: true, reason: 'parents-missing' });
                console.debug(`[_reapplyAppliedProposal] ${proposalId}: Parents missing; rebuilt parcelLayerById from parcelLayer`, stats);
                parentsAvailable = parentIds.filter(id => typeof resolveParcelLayerById === 'function' && resolveParcelLayerById(id));
            }
        }
    } catch (_) { }
    console.debug(`[_reapplyAppliedProposal] ${proposalId}: Parents available in index: ${parentsAvailable.length}/${parentIds.length}`);

    const parcelLayer = (typeof window !== 'undefined') ? window.parcelLayer : null;

    // No children: re-add parents if they exist but are not on the parcelLayer
    if (childIds.length === 0) {
        parentIds.forEach(id => {
            if (typeof window !== 'undefined' && typeof window.showParcelLayerById === 'function') {
                try { window.showParcelLayerById(id); } catch (_) { }
                return;
            }

            // Fallback: only add if the layer is already indexed by id.
            const layer = (typeof resolveParcelLayerById === 'function') ? resolveParcelLayerById(id) : null;
            if (layer && parcelLayer && !parcelLayer.hasLayer(layer)) {
                try {
                    if (typeof window !== 'undefined' && typeof window.setParcelLayerById === 'function') {
                        window.setParcelLayerById(id, layer);
                    }
                    parcelLayer.addLayer(layer);
                    if (typeof window !== 'undefined' && typeof window.indexParcelLayer === 'function') {
                        window.indexParcelLayer(layer);
                    }
                } catch (_) { }
            }
        });
        return;
    }

    // Add children only if not present in parcelLayerById
    const childLayersInIndex = new Set();
    childIds.forEach(id => {
        const layer = (typeof resolveParcelLayerById === 'function') ? resolveParcelLayerById(id) : null;
        if (layer) {
            childLayersInIndex.add(id);
        }
    });

    const features = await _rehydrateChildFeatures(proposal, childIds);
    console.debug(`[_reapplyAppliedProposal] ${proposalId}: Rehydrated ${features.length} features for ${childIds.length} childIds`);

    // If all rehydrated children are themselves replaced by deeper descendants,
    // we must still hide this proposal's parents; otherwise parent layers can remain
    // on top and block clicks for the leaf parcels.
    const skippedByDescendantsCount = features.reduce((acc, f) => {
        try { return acc + (_shouldSkipChildFeature(f) ? 1 : 0); } catch (_) { return acc; }
    }, 0);

    // Detailed logging for debugging
    if (features.length > 0 && features.length <= 5) {
        features.forEach((f, idx) => {
            const pid = _getParcelIdFromFeature(f)?.toString() || '(no-id)';
            const inIndex = childLayersInIndex.has(pid);
            const hasDescendant = _shouldSkipChildFeature(f);
            const marker = f?.properties?.descendantProposal || f?.properties?.descendantProposals || null;
            console.debug(`[_reapplyAppliedProposal] ${proposalId}: child[${idx}] id=${pid}, inIndex=${inIndex}, hasDescendant=${hasDescendant}, marker=${JSON.stringify(marker)}`);
        });
    }

    const featuresToAdd = features.filter(f => {
        const pid = _getParcelIdFromFeature(f)?.toString();
        if (!pid) return false;
        if (childLayersInIndex.has(pid)) return false;
        if (_shouldSkipChildFeature(f)) return false;
        return true;
    });

    let addedChildIds = [];
    if (featuresToAdd.length) {
        console.debug(`[_reapplyAppliedProposal] ${proposalId}: Adding ${featuresToAdd.length} child features`);
        // Prefer the internal add helper to preserve styling/indexing
        if (typeof ProposalManager._addFeaturesToMap === 'function') {
            try { ProposalManager._addFeaturesToMap(featuresToAdd, true, proposal); } catch (e) { console.error(`[_reapplyAppliedProposal] _addFeaturesToMap failed:`, e); }
        } else if (typeof ingestParcelFeatures === 'function') {
            try { await ingestParcelFeatures(featuresToAdd, { replaceExisting: false }); } catch (e) { console.error(`[_reapplyAppliedProposal] ingestParcelFeatures failed:`, e); }
        }
        // Verify what actually landed in the index (not necessarily visible on parcelLayer)
        addedChildIds = featuresToAdd
            .map(f => _getParcelIdFromFeature(f)?.toString())
            .filter(id => id && typeof resolveParcelLayerById === 'function' && resolveParcelLayerById(id));
        console.debug(`[_reapplyAppliedProposal] ${proposalId}: Actually added to index: ${addedChildIds.length}/${featuresToAdd.length}`);
    }

    // After attempted add, decide visibility
    const childPresenceCount = childLayersInIndex.size + addedChildIds.length;
    console.debug(`[_reapplyAppliedProposal] ${proposalId}: Child presence count = ${childPresenceCount} (inIndex: ${childLayersInIndex.size}, added: ${addedChildIds.length})`);

    // Hide parents if:
    // - we have any visible child in the layer/index, OR
    // - we rehydrated children but skipped them because they have their own descendants.
    // This prevents ancestor parcels from blocking clicks for deeper descendants.
    const shouldHideParents = childPresenceCount > 0 || (features.length > 0 && skippedByDescendantsCount > 0);
    if (shouldHideParents) {
        parentIds.forEach(id => {
            if (typeof window !== 'undefined' && typeof window.hideParcelLayerById === 'function') {
                try { window.hideParcelLayerById(id); } catch (_) { }
                return;
            }

            // Fallback: only remove if the layer is already indexed by id.
            const layer = (typeof resolveParcelLayerById === 'function') ? resolveParcelLayerById(id) : null;
            if (layer && parcelLayer && parcelLayer.hasLayer(layer)) {
                try {
                    if (typeof window !== 'undefined' && typeof window.setParcelLayerById === 'function') {
                        window.setParcelLayerById(id, layer);
                    }
                    if (typeof window !== 'undefined' && typeof window.unindexParcelLayer === 'function') {
                        window.unindexParcelLayer(layer);
                    }
                    // Clean up attached overlay layers before removing
                    if (layer._roadCenterlineLayer && window.map && window.map.hasLayer(layer._roadCenterlineLayer)) {
                        window.map.removeLayer(layer._roadCenterlineLayer);
                        layer._roadCenterlineLayer = null;
                    }
                    parcelLayer.removeLayer(layer);
                } catch (_) { }
            }
        });
    } else {
        // No children to show—ensure parents stay visible
        parentIds.forEach(id => {
            if (typeof window !== 'undefined' && typeof window.showParcelLayerById === 'function') {
                try { window.showParcelLayerById(id); } catch (_) { }
                return;
            }

            // Fallback: only add if the layer is already indexed by id.
            const layer = (typeof resolveParcelLayerById === 'function') ? resolveParcelLayerById(id) : null;
            if (layer && parcelLayer && !parcelLayer.hasLayer(layer)) {
                try {
                    if (typeof window !== 'undefined' && typeof window.setParcelLayerById === 'function') {
                        window.setParcelLayerById(id, layer);
                    }
                    parcelLayer.addLayer(layer);
                    if (typeof window !== 'undefined' && typeof window.indexParcelLayer === 'function') {
                        window.indexParcelLayer(layer);
                    }
                } catch (_) { }
            }
        });
    }

    // Structures: reapply overlays if needed (they keep parents visible)
    if (goal === 'park' || goal === 'square' || goal === 'lake') {
        if (typeof ProposalManager._applyStructureProposal === 'function') {
            try {
                await _runProposalApplyWithSummary(
                    proposal.proposalId,
                    proposal,
                    () => ProposalManager._applyStructureProposal(proposal.proposalId, proposal)
                );
            } catch (_) { }
        }
    }
}

function _resolveProposalId(source) {
    if (!source || typeof source !== 'object') return null;
    const candidate = source.proposalId
        || source.id
        || source.tokenId;
    const normalized = _normalizeProposalId(candidate);
    if (normalized) {
        source.proposalId = normalized;
        return normalized;
    }
    return null;
}

function _getProposalRecord(proposalId) {
    if (!proposalId || typeof proposalStorage === 'undefined') return null;
    const normalized = _normalizeProposalId(proposalId) || null;
    if (!normalized) return null;
    const direct = typeof proposalStorage.getProposal === 'function'
        ? proposalStorage.getProposal(normalized)
        : null;
    if (direct) return direct;
    if (typeof proposalStorage.findProposalByIdOrHash === 'function') {
        return proposalStorage.findProposalByIdOrHash(normalized);
    }
    return null;
}

function _isAppliedStatusLike(status) {
    const normalized = (status || '').toString().toLowerCase();
    return normalized === 'applied' || normalized === 'executed';
}

function _buildAppliedDescendantIndex(excludeProposalId = null) {
    const index = new Map();
    try {
        if (typeof proposalStorage === 'undefined' || typeof proposalStorage.getAllProposals !== 'function') {
            return index;
        }
        const appliedProposals = proposalStorage.getAllProposals().filter(p => {
            if (!p) return false;
            if (excludeProposalId && p.proposalId && String(p.proposalId) === String(excludeProposalId)) return false;
            const roadStatus = p.roadProposal && _isAppliedStatusLike(p.roadProposal.status);
            const decideLaterStatus = p.decideLaterProposal && _isAppliedStatusLike(p.decideLaterProposal.status);
            const structureStatus = p.structureProposal && _isAppliedStatusLike(p.structureProposal.status);
            const reparcelStatus = p.reparcellization && _isAppliedStatusLike(p.reparcellization.status);
            const buildingStatus = p.buildingProposal && _isAppliedStatusLike(p.buildingProposal.status);
            const globalStatus = _isAppliedStatusLike(p.status);
            return roadStatus || decideLaterStatus || structureStatus || reparcelStatus || buildingStatus || globalStatus;
        });

        const appliedProposalIds = new Set(appliedProposals.map(p => (p && p.proposalId) ? String(p.proposalId) : '').filter(Boolean));

        const harvestParents = (proposal) => {
            const buckets = [];
            if (Array.isArray(proposal.parentParcelIds)) buckets.push(proposal.parentParcelIds);
            if (proposal.roadProposal && Array.isArray(proposal.roadProposal.parentParcelIds)) buckets.push(proposal.roadProposal.parentParcelIds);
            if (proposal.decideLaterProposal && Array.isArray(proposal.decideLaterProposal.parentParcelIds)) buckets.push(proposal.decideLaterProposal.parentParcelIds);
            if (proposal.reparcellization && Array.isArray(proposal.reparcellization.parentParcelIds)) buckets.push(proposal.reparcellization.parentParcelIds);
            if (proposal.buildingProposal && Array.isArray(proposal.buildingProposal.parentParcelIds)) buckets.push(proposal.buildingProposal.parentParcelIds);
            if (proposal.structureProposal && Array.isArray(proposal.structureProposal.parentParcelIds)) buckets.push(proposal.structureProposal.parentParcelIds);
            return buckets.flat().filter(id => id !== undefined && id !== null).map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean);
        };

        appliedProposals.forEach(p => {
            const parents = harvestParents(p);
            if (!parents.length) return;
            const uniqueParents = Array.from(new Set(parents));
            uniqueParents.forEach(id => {
                const list = index.get(id) || [];
                list.push(p.proposalId || id);
                index.set(id, list);
            });
        });

        // Also include parcels that have descendantProposal markers pointing to applied proposals (persisted/local cache)
        const parcelStore = (typeof ParcelsState !== 'undefined' && ParcelsState.getParcelCache)
            ? ParcelsState.getParcelCache()
            : (typeof parcelCache !== 'undefined' ? parcelCache : null);
        const parcelMap = parcelStore && parcelStore.byId instanceof Map ? parcelStore.byId : null;
        if (parcelMap && parcelMap.size > 0 && appliedProposalIds.size > 0) {
            parcelMap.forEach((feature, key) => {
                const props = feature && feature.properties ? feature.properties : {};
                const marker = props.descendantProposal || props.descendantProposals;
                const markers = Array.isArray(marker) ? marker : (marker ? [marker] : []);
                const hit = markers.map(m => m && m.toString ? m.toString() : String(m)).find(m => appliedProposalIds.has(m));
                if (hit && key) {
                    const id = key && key.toString ? key.toString() : String(key);
                    const list = index.get(id) || [];
                    list.push(hit);
                    index.set(id, list);
                }
            });
        }
    } catch (_) { /* ignore */ }
    return index;
}

function _filterChildFeaturesBlockedByDescendants(features, proposalId) {
    if (!Array.isArray(features) || features.length === 0) return [];
    const descendantIndex = _buildAppliedDescendantIndex(proposalId);
    if (!descendantIndex.size) return features;

    const filtered = [];
    features.forEach(feature => {
        const parcelId = _getParcelIdFromFeature(feature);
        const key = parcelId && parcelId.toString ? parcelId.toString() : null;
        if (!key) {
            filtered.push(feature);
            return;
        }
        const blockers = descendantIndex.get(key);
        if (!blockers || blockers.length === 0) {
            filtered.push(feature);
        }
    });
    return filtered;
}

// Assign each child parcel a synthetic id, deterministically, from the CURRENT id rules only.
// The token is derived from the proposalId; the index is a running per-root-parcel counter in
// feature order. We deliberately do NOT read the proposal's stored childParcelIds to reproduce
// prior tokens/indices — children are derived data, so if the geometry or rules change they simply
// get different ids. Because token (from proposalId) and per-root ordering are stable, a stable
// parent set still reproduces identical ids naturally; a drifted split yields different ids, as it
// should. No canonical list is honored anywhere.
function _assignSyntheticChildIdentitiesImpl(proposalId, childFeatures) {
    if (!proposalId || !Array.isArray(childFeatures)) {
        return;
    }

    const token = _buildSyntheticToken(proposalId, 'proposal');
    const counters = new Map();

    childFeatures.forEach(feature => {
        if (!feature || !feature.properties) {
            return;
        }

        const props = feature.properties;
        const rootNumber = _resolveRootParcelNumberFromProperties(props) || 'parcel';
        const rootId = _resolveRootParcelIdFromProperties(props) || 'parcel';

        const key = `${rootNumber || ''}__${rootId || ''}`;
        let state = counters.get(key);
        if (!state) {
            state = { nextIndex: 1 };
            counters.set(key, state);
        }
        const index = state.nextIndex++;

        props.syntheticIndex = index;
        props.syntheticToken = token;
        props.BROJ_CESTICE = _composeSyntheticParcelNumber(rootNumber, token, index);
        const parcelId = _composeSyntheticParcelId(rootId, token, index);
        _ensureParcelIdOnProperties(props, parcelId);
        // Ensure rootParcelId is persisted to avoid re-extraction
        props.rootParcelId = rootId;
        props.rootParcelNumber = rootNumber;
    });
}

class Proposal {
    constructor({ id, proposalId, name, type, definition, parentFeatures, author, description, offer, budget }) {
        // Prefer a provided proposalId/id; otherwise fall back to a simple local placeholder
        this.id = proposalId || id || `local-temp-${Date.now()}`;
        this.name = name;
        this.type = type; // 'road', 'building', etc.
        this.status = 'unapplied'; // 'applied' or 'unapplied'

        // Data to recreate the proposal's geometry, e.g., points and width for a road
        this.definition = definition || {};

        // Deep copy of original GeoJSON features (parcels, etc.) before they were changed
        this.parentFeatures = parentFeatures;
        // GeoJSON features of the new/modified objects created by this proposal
        this.childFeatures = [];

        // Dependency tracking
        this.parentProposals = new Set(); // Set of parent proposal IDs
        this.childProposals = new Set();  // Set of child proposal IDs

        const numericOffer = typeof offer === 'number' ? offer : parseFloat(offer);
        const offerValue = Number.isFinite(numericOffer) ? numericOffer : null;
        const numericBudget = typeof budget === 'number' ? budget : parseFloat(budget);
        const budgetValue = Number.isFinite(numericBudget) ? numericBudget : offerValue;

        this.author = (author && String(author).trim()) || 'User';
        this.description = (description && String(description).trim()) || '';
        this.offer = offerValue;
        this.budget = budgetValue;
    }

    calculateChildFeatures() {
        if (this.type !== 'road') {
            return;
        }

        // Prevent duplicate calculation if child features already exist and have valid IDs
        if (Array.isArray(this.childFeatures) && this.childFeatures.length > 0) {
            const hasValidFeatures = this.childFeatures.some(f =>
                f && f.properties && _getParcelIdFromProperties(f.properties)
            );
            if (hasValidFeatures) {
                return;
            }
        }

        const proposalToken = _buildSyntheticToken(this.id || 'proposal');
        // Tunnel spans are covered structures that acquire nothing: the corridor parcel and the
        // parcel cuts are built from the surface-only centerline (tunnelled edges skipped), so
        // parcels under a tunnel stay whole. The full centerline keeps driving the rendering.
        let acquisitionCenterline = this.definition.points;
        const tunnelRecords = Array.isArray(this.definition.tunnels) ? this.definition.tunnels.filter(Boolean) : [];
        if (tunnelRecords.length && typeof corridorSurfaceRuns === 'function') {
            const surfaceRuns = corridorSurfaceRuns(this.definition.points, tunnelRecords);
            if (surfaceRuns.length) acquisitionCenterline = surfaceRuns;
        }
        const roadPolygon = _calculateRoadPolygon(acquisitionCenterline, this.definition.width);
        if (!roadPolygon || this.parentFeatures.length === 0) {
            console.error('Invalid inputs to calculateChildFeatures');
            return;
        }

        // Clear any existing child features before calculating new ones
        this.childFeatures = [];

        const numberAllocators = {};

        const getRootInfo = (feature) => {
            const props = feature?.properties || {};
            const parcelNumber = props.BROJ_CESTICE ? String(props.BROJ_CESTICE) : '';
            const parcelId = _getParcelIdFromFeature(feature) || '';
            const rootNumber = _resolveRootParcelNumberFromProperties(props, parcelId)
                || _extractRootParcelNumber(parcelNumber);
            const rootParcelId = _resolveRootParcelIdFromProperties(props, parcelId)
                || _extractRootParcelId(parcelId);
            return {
                rootNumber,
                rootParcelId
            };
        };

        const getAllocatorKey = (rootNumber, rootParcelId) => syntheticParcelAllocatorKey(rootParcelId, rootNumber);

        const getNextIdentity = (rootNumber, rootParcelId) => {
            if (!rootNumber || !rootParcelId) {
                console.warn('Missing root info for parcel identity generation:', { rootNumber, rootParcelId });
                return null;
            }
            const key = getAllocatorKey(rootNumber, rootParcelId);
            let state = numberAllocators[key];
            if (!state) {
                state = numberAllocators[key] = {
                    baseId: rootParcelId,
                    nextIndex: 1
                };
            }
            const sub = state.nextIndex;
            state.nextIndex += 1;
            return {
                parcelNumber: _composeSyntheticParcelNumber(rootNumber, proposalToken, sub),
                parcelId: _composeSyntheticParcelId(state.baseId, proposalToken, sub),
                subNumber: sub
            };
        };

        const affectedParcels = this.parentFeatures.map(f => {
            const layer = L.geoJSON(f);
            const rootInfo = getRootInfo(f);
            const parcelId = _getParcelIdFromFeature(f);
            return {
                id: parcelId,
                number: f.properties.BROJ_CESTICE,
                rootNumber: rootInfo.rootNumber,
                rootParcelId: rootInfo.rootParcelId,
                layer: layer,
                feature: f
            };
        });

        const primaryAffectedParcelNumber = affectedParcels[0]?.number;
        if (!primaryAffectedParcelNumber) {
            console.error("Could not determine primary affected parcel number.");
            return;
        }

        const primaryRootNumber = affectedParcels[0]?.rootNumber;
        const primaryRootParcelId = affectedParcels[0]?.rootParcelId;
        const roadIdentity = getNextIdentity(primaryRootNumber, primaryRootParcelId);

        // Check if this is a track proposal
        const isTrack = this.definition?.metadata?.isTrack === true;
        console.debug('[Proposal.calculateChildFeatures] Creating corridor feature', {
            proposalId: this.id,
            isTrack,
            metadataType: this.definition?.metadata?.type,
            metadataIsTrack: this.definition?.metadata?.isTrack
        });

        const roadFeatureProperties = {
            parcelId: roadIdentity ? roadIdentity.parcelId : `road_${Date.now()}`,
            parcelNumber: roadIdentity ? roadIdentity.parcelNumber : `${primaryAffectedParcelNumber}/road`,
            isRoad: !isTrack, // tracks are NOT roads
            isCorridor: true,
            isTrack: isTrack,
            calculatedArea: _calculateAreaFromLatLngPolygon(roadPolygon),
            roadName: this.name,
            isProposed: true,
            proposalId: this.id,
            parentParcelId: affectedParcels[0]?.id || null,
            parentParcelNumber: primaryAffectedParcelNumber,
            parentParcelIds: affectedParcels.map(p => p.id),
            parentParcelNumbers: affectedParcels.map(p => p.number),
            rootParcelNumber: primaryRootNumber,
            rootParcelId: primaryRootParcelId,
            // Set proposal author as parcel owner with 100% share
            ownershipDetails: {
                owners: [{
                    name: this.author || 'User',
                    ownerLabel: this.author || 'User',
                    percentageShare: 100,
                    actualShareText: '100%'
                }]
            }
        };

        // Store track points if this is a track
        if (isTrack && Array.isArray(this.definition.points)) {
            roadFeatureProperties.trackPoints = this.definition.points;
        }

        const isLatLng = (p) => p && typeof p.lat === 'number' && typeof p.lng === 'number';
        const buildClosedRing = (ring) => {
            const coords = (Array.isArray(ring) ? ring : [])
                .filter(isLatLng)
                .map(p => [p.lng, p.lat]);
            const closed = _ensurePolygonIsClosed(coords);
            return (Array.isArray(closed) && closed.length >= 4) ? closed : null;
        };

        let roadGeometry = null;
        if (Array.isArray(roadPolygon) && roadPolygon.length) {
            // LatLng[]
            if (isLatLng(roadPolygon[0])) {
                const outer = buildClosedRing(roadPolygon);
                if (outer) {
                    roadGeometry = { type: 'Polygon', coordinates: [outer] };
                }
            }
            // LatLng[][] (polygon with holes)
            else if (Array.isArray(roadPolygon[0]) && roadPolygon[0].length && isLatLng(roadPolygon[0][0])) {
                const rings = roadPolygon.map(buildClosedRing).filter(Boolean);
                if (rings.length) {
                    roadGeometry = { type: 'Polygon', coordinates: rings };
                }
            }
            // LatLng[][][] (multipolygon)
            else if (Array.isArray(roadPolygon[0]) && Array.isArray(roadPolygon[0][0]) && roadPolygon[0][0].length && isLatLng(roadPolygon[0][0][0])) {
                const polys = roadPolygon
                    .map(polyRings => (Array.isArray(polyRings) ? polyRings : []).map(buildClosedRing).filter(Boolean))
                    .filter(rings => rings.length > 0);
                if (polys.length) {
                    roadGeometry = { type: 'MultiPolygon', coordinates: polys };
                }
            }
        }

        if (!roadGeometry) {
            console.error('Unable to derive road geometry from roadPolygon');
            return;
        }

        const roadFeature = {
            type: 'Feature',
            properties: roadFeatureProperties,
            geometry: roadGeometry
        };

        _assignOwnershipDetails(roadFeature, {
            defaultOwnerName: this.author || 'User',
            overwriteExisting: true
        });
        this.childFeatures.push(roadFeature);

        const createdGeometryHashes = new Set();

        const normalizeParcelGeometry = (geometry) => {
            const polygons = _extractPolygonsWithHolesFromGeometry(geometry);
            if (!polygons.length) {
                return null;
            }
            if (geometry.type === 'MultiPolygon') {
                const coords = polygons.map(({ outer, holes }) => [outer, ...(holes || [])]);
                return { type: 'MultiPolygon', coordinates: coords };
            }
            const primary = polygons[0];
            return { type: 'Polygon', coordinates: [primary.outer, ...(primary.holes || [])] };
        };

        const extractDiffPolygons = (geometry) => {
            if (!geometry) return [];
            const polygons = _extractPolygonsWithHolesFromGeometry(geometry);
            return polygons.map(({ outer, holes }) => {
                const closedOuter = _ensurePolygonIsClosed(outer || []);
                const closedHoles = Array.isArray(holes) ? holes.map(ring => _ensurePolygonIsClosed(ring || [])) : [];
                const coords = [closedOuter, ...closedHoles];
                const area = turf.area(turf.polygon(coords));
                return { coords, area };
            }).filter(item => Array.isArray(item.coords[0]) && item.coords[0].length >= 4 && item.area >= MIN_MEANINGFUL_CHILD_AREA);
        };

        let roadTurf;
        try {
            roadTurf = roadGeometry.type === 'MultiPolygon'
                ? turf.multiPolygon(roadGeometry.coordinates)
                : turf.polygon(roadGeometry.coordinates);
        } catch (err) {
            console.error('Failed to create road turf geometry', err);
            return;
        }

        for (const parcel of affectedParcels) {
            const originalFeature = parcel.feature;
            const originalNumber = originalFeature.properties.BROJ_CESTICE;
            const parcelId = _getParcelIdFromFeature(originalFeature);
            const rootNumber = parcel.rootNumber;
            const rootParcelId = parcel.rootParcelId;

            try {
                const parcelGeometry = normalizeParcelGeometry(originalFeature.geometry);
                if (!parcelGeometry) throw new Error('Invalid parcel geometry');

                const parcelTurf = parcelGeometry.type === 'MultiPolygon'
                    ? turf.multiPolygon(parcelGeometry.coordinates)
                    : turf.polygon(parcelGeometry.coordinates);
                let parentParcelArea = 0;
                try {
                    parentParcelArea = typeof turf.area === 'function' ? turf.area(parcelTurf) : 0;
                } catch (_) { parentParcelArea = 0; }
                const difference = turf.difference(parcelTurf, roadTurf);
                const parentIsRoad = originalFeature?.properties?.isRoad === true
                    || originalFeature?.properties?.isRoad === 'true';

                if (!difference) {
                    // Parcel is completely covered, so it produces no child features.
                    console.debug(`Parcel ${parcelId} (${originalNumber}) completely covered by road - removed.`);
                    continue;
                }

                const pieces = extractDiffPolygons(difference.geometry).sort((a, b) => b.area - a.area);
                pieces.forEach(piece => {
                    // If the road did not actually intersect this parcel, turf.difference returns the
                    // full parent polygon. Only skip when the area delta is within a tiny tolerance;
                    // otherwise real but small cuts on large parcels get discarded.
                    if (_shouldSkipUncutRemainder(parentParcelArea, piece.area)) {
                        console.debug(`[Proposal.calculateChildFeatures] Skipping uncut remainder for ${parcelId} — road did not intersect this parcel meaningfully`);
                        return;
                    }
                    const hash = _geometryHash(piece.coords);
                    if (createdGeometryHashes.has(hash)) return;
                    createdGeometryHashes.add(hash);

                    const newFeature = JSON.parse(JSON.stringify(originalFeature));
                    newFeature.geometry.type = 'Polygon';
                    newFeature.geometry.coordinates = piece.coords;
                    newFeature.properties.calculatedArea = piece.area;
                    const identity = getNextIdentity(rootNumber, rootParcelId);
                    if (identity) {
                        newFeature.properties.parcelId = identity.parcelId;
                        newFeature.properties.parcelNumber = identity.parcelNumber;
                    } else {
                        const fallbackId = `${parcelId}_derived_${Date.now()}`;
                        newFeature.properties.parcelId = fallbackId;
                        newFeature.properties.parcelNumber = rootNumber ? `${rootNumber}/${Date.now()}` : `${originalNumber}/${Date.now()}`;
                    }
                    _ensureParcelIdOnProperties(newFeature.properties, newFeature.properties.parcelId);
                    newFeature.properties.parentParcelId = parcelId;
                    newFeature.properties.parentParcelNumber = originalNumber;
                    newFeature.properties.rootParcelNumber = rootNumber;
                    newFeature.properties.rootParcelId = rootParcelId;
                    newFeature.properties.proposalId = this.id;
                    newFeature.properties.isRoad = parentIsRoad;
                    newFeature.properties.isCorridor = parentIsRoad === true;

                    _assignOwnershipDetails(newFeature, {
                        parentFeature: originalFeature,
                        defaultOwnerName: this.author || 'User'
                    });
                    this.childFeatures.push(newFeature);
                });
            } catch (error) {
                console.error(`Error processing parcel ${parcelId} (Number: ${originalNumber}):`, error);
            }
        }
    }
}

const ProposalManager = {
    _modifiedParcelIndexHydrated: false,
    _cachedModifiedParcelSet: null,
    _reparcellizationLayers: new Map(),
    _reparcellizationRootLayer: null,
    _lastApplyFailureByProposalId: new Map(),
    _initialReapplyDone: false,
    _reapplyInFlight: false,

    _setLastApplyFailure(proposalId, failure) {
        try {
            const key = _normalizeProposalId(proposalId) || (proposalId && proposalId.toString ? proposalId.toString() : String(proposalId || ''));
            if (!key) return;
            const message = (failure && failure.message) ? String(failure.message)
                : (failure && failure.reason) ? String(failure.reason)
                    : (typeof failure === 'string' ? failure : (failure !== undefined && failure !== null ? String(failure) : ''));
            const code = (failure && failure.code) ? String(failure.code) : null;
            const missingIds = (failure && Array.isArray(failure.missingIds))
                ? Array.from(new Set(failure.missingIds
                    .map(id => id && id.toString ? id.toString() : String(id || ''))
                    .filter(Boolean)))
                : [];
            if (!message) return;
            this._lastApplyFailureByProposalId.set(key, {
                message,
                code,
                missingIds,
                at: Date.now()
            });
        } catch (_) { /* best-effort */ }
    },

    _clearLastApplyFailure(proposalId) {
        try {
            const key = _normalizeProposalId(proposalId) || (proposalId && proposalId.toString ? proposalId.toString() : String(proposalId || ''));
            if (!key) return;
            this._lastApplyFailureByProposalId.delete(key);
        } catch (_) { /* best-effort */ }
    },

    getLastApplyFailure(proposalId) {
        try {
            const key = _normalizeProposalId(proposalId) || (proposalId && proposalId.toString ? proposalId.toString() : String(proposalId || ''));
            if (!key) return null;
            const entry = this._lastApplyFailureByProposalId.get(key);
            return entry && entry.message ? entry.message : null;
        } catch (_) {
            return null;
        }
    },

    getLastApplyFailureInfo(proposalId) {
        try {
            const key = _normalizeProposalId(proposalId) || (proposalId && proposalId.toString ? proposalId.toString() : String(proposalId || ''));
            if (!key) return null;
            const entry = this._lastApplyFailureByProposalId.get(key);
            if (!entry || !entry.message) return null;
            return {
                message: String(entry.message),
                code: entry.code ? String(entry.code) : null,
                missingIds: Array.isArray(entry.missingIds) ? entry.missingIds.slice() : [],
                at: entry.at || null
            };
        } catch (_) {
            return null;
        }
    },
    createProposal(options) {
        const nextLocalId = (typeof proposalStorage !== 'undefined' && Number.isFinite(proposalStorage.nextProposalId))
            ? proposalStorage.nextProposalId
            : Date.now();
        const initialProposalId = options?.onchainProposal?.proposalId != null
            ? String(options.onchainProposal.proposalId)
            : `local-${nextLocalId}`;

        const proposal = new Proposal({ ...options, proposalId: initialProposalId });
        proposal.proposalId = initialProposalId;

        if (options.onchainProposal) {
            proposal.onchain = { ...options.onchainProposal };
        }

        // Store in proposalStorage with the existing proposals system
        const normalizedAuthor = (options.author && String(options.author).trim()) || proposal.author || 'User';
        const normalizedDescription = (options.description && String(options.description).trim())
            || proposal.description
            || `Road: ${proposal.name}`;
        const offerFromOptions = typeof options.offer === 'number' ? options.offer : parseFloat(options.offer);
        const offerValue = Number.isFinite(proposal.offer) ? proposal.offer : (Number.isFinite(offerFromOptions) ? offerFromOptions : null);
        const budgetFromOptions = typeof options.budget === 'number' ? options.budget : parseFloat(options.budget);
        const budgetValue = Number.isFinite(proposal.budget) ? proposal.budget : (Number.isFinite(budgetFromOptions) ? budgetFromOptions : offerValue);

        // Extract parent parcel IDs from parent features using canonical parcelId
        const deriveParcelIdFromFeature = (feature) => _getParcelIdFromFeature(feature);

        const parentParcelIds = Array.isArray(proposal.parentFeatures)
            ? proposal.parentFeatures.map(f => deriveParcelIdFromFeature(f)).filter(Boolean)
            : [];

        const proposalData = {
            type: 'road',
            title: proposal.name,
            author: normalizedAuthor,
            description: normalizedDescription,
            proposalId: proposal.proposalId,
            parentParcelIds,
            childParcelIds: [],
            geometry: {
                roadPlan: proposal.definition || null,
                roadGeometry: proposal.geometry?.roadGeometry || proposal.roadGeometry || null
            },
            roadProposal: {
                id: proposal.proposalId,
                proposalId: proposal.proposalId,
                definition: proposal.definition,
                parentParcelIds: parentParcelIds,
                // Child parcels are derived from the proposal definition and persisted storage; avoid storing geometry blobs
                childParcelIds: [],
                status: proposal.status
            },
            createdAt: new Date().toISOString()
        };

        // Ensure no geometries are persisted on the proposal object
        delete proposalData.roadProposal.parentFeatures;
        delete proposalData.roadProposal.childFeatures;

        if (proposal.onchain) {
            proposalData.onchain = { ...proposal.onchain };
        }

        if (Number.isFinite(offerValue)) {
            proposalData.offer = offerValue;
            proposalData.budget = Number.isFinite(budgetValue) ? budgetValue : offerValue;
        }

        // Include lens from options or proposal object
        const lensFromOptions = options?.lens;
        const lensFromProposal = proposal?.lens;
        const lensToUse = lensFromOptions || lensFromProposal;

        // Process lens if it exists and is not empty
        if (lensToUse !== undefined && lensToUse !== null) {
            let normalizedLens = null;
            if (typeof normalizeLensEntries === 'function') {
                normalizedLens = normalizeLensEntries(lensToUse);
            } else if (Array.isArray(lensToUse)) {
                normalizedLens = lensToUse;
            }

            // Only set lens if we have valid entries after normalization
            if (normalizedLens && Array.isArray(normalizedLens) && normalizedLens.length > 0) {
                proposalData.lens = normalizedLens;
                console.log('[createProposal] Lens included in proposalData:', normalizedLens.length, 'entries');
            }
        }

        if (typeof proposalStorage !== 'undefined') {
            const proposalId = proposalStorage.addProposal(proposalData);
            if (!proposalId) {
                // Duplicate proposal or invalid data - return null to indicate failure
                console.warn('[createProposal] Failed to add proposal to storage - duplicate or invalid data', { proposalData });
                return null;
            }
            proposal.proposalId = proposalId;
            if (proposal.roadProposal) {
                proposal.roadProposal.id = proposalId;
                proposal.roadProposal.proposalId = proposalId;
            }
            // Keep id-only; legacy hashes are deprecated

            // DEBUG: Verify the stored proposal has correct parcelIds

            if (proposalId) {
                this._linkProposalToAncestors(proposalId, proposalData.parentParcelIds);
            }

            // Update show proposals button
            if (typeof updateShowProposalsButton === 'function') {
                updateShowProposalsButton();
            }
        }

        return proposal;
    },

    async reapplyAppliedProposals() {
        if (this._initialReapplyDone || this._reapplyInFlight) return;
        this._reapplyInFlight = true; // Set immediately to prevent race conditions

        try {
            // Wait for PersistentStorage to be ready before reading proposals and parcel data
            if (typeof PersistentStorage !== 'undefined' && PersistentStorage && typeof PersistentStorage.ensureReady === 'function') {
                await new Promise(resolve => PersistentStorage.ensureReady(resolve));
            }

            if (typeof proposalStorage === 'undefined' || typeof proposalStorage.getAllProposals !== 'function') return;

            const proposals = proposalStorage.getAllProposals() || [];
            const applied = proposals.filter(p => {
                const roadStatus = p.roadProposal && _isAppliedStatusLike(p.roadProposal.status);
                const decideLaterStatus = p.decideLaterProposal && _isAppliedStatusLike(p.decideLaterProposal.status);
                const structureStatus = p.structureProposal && _isAppliedStatusLike(p.structureProposal.status);
                const reparcelStatus = p.reparcellization && _isAppliedStatusLike(p.reparcellization.status);
                const buildingStatus = p.buildingProposal && _isAppliedStatusLike(p.buildingProposal.status);
                const globalStatus = _isAppliedStatusLike(p.status);
                return roadStatus || decideLaterStatus || structureStatus || reparcelStatus || buildingStatus || globalStatus;
            });

            if (!applied.length) return;

            // Only reapply proposals belonging to the active city. Applied proposals are
            // stored globally (not per-city), so without this an NYC session would try to
            // reapply Zagreb proposals — fetching HR-* ids from the NYC parcel endpoint (400)
            // and poisoning the nearby-3D-buildings query with cross-city geometry (→ "loaded
            // 0 nearby 3d buildings"). Mirrors the city filter in game.js.
            const currentCityId = (typeof window !== 'undefined' && window.CityConfigManager
                    && typeof window.CityConfigManager.getCurrentCityId === 'function')
                ? window.CityConfigManager.getCurrentCityId()
                : null;
            const appliedInCity = (currentCityId && typeof isInCity === 'function')
                ? applied.filter(p => {
                    const ids = Array.isArray(p.parentParcelIds) && p.parentParcelIds.length
                        ? p.parentParcelIds
                        : (Array.isArray(p.childParcelIds) ? p.childParcelIds : []);
                    if (!ids.length) return true;
                    return ids.some(id => isInCity(id, currentCityId));
                })
                : applied;

            if (!appliedInCity.length) return;

            // Process in stored order; dependencies intentionally ignored per request
            for (const proposal of appliedInCity) {
                await _reapplyAppliedProposal(proposal);
            }
        } finally {
            this._reapplyInFlight = false;
            this._initialReapplyDone = true;
        }
    },

    registerBuildingProposal(proposalId, parentParcelIds = []) {
        if (!proposalId || !Array.isArray(parentParcelIds)) return;
        const normalized = parentParcelIds
            .map(id => id && id.toString ? id.toString() : String(id))
            .filter(Boolean);
        if (normalized.length === 0) return;
        this._linkProposalToAncestors(proposalId, normalized);
    },

    _cloneFeatures(features) {
        if (!Array.isArray(features)) return [];
        const clones = [];
        features.forEach(feature => {
            try {
                if (feature === undefined || feature === null) return;

                // If it's a Leaflet layer, extract the GeoJSON feature from it
                let geoJsonFeature = feature;
                if (feature.feature && typeof feature.feature === 'object') {
                    // It's a Leaflet layer, extract the underlying feature
                    geoJsonFeature = feature.feature;
                } else if (feature.toGeoJSON && typeof feature.toGeoJSON === 'function') {
                    // It's a Leaflet layer with toGeoJSON method
                    geoJsonFeature = feature.toGeoJSON();
                }

                // Extract only GeoJSON properties (type, properties, geometry)
                // This ensures we don't include any Leaflet-specific circular references
                const cleanFeature = {
                    type: geoJsonFeature.type || 'Feature',
                    properties: geoJsonFeature.properties ? { ...geoJsonFeature.properties } : {},
                    geometry: geoJsonFeature.geometry ? {
                        type: geoJsonFeature.geometry.type,
                        coordinates: geoJsonFeature.geometry.coordinates
                    } : null
                };

                // Validate it's a proper GeoJSON feature
                if (cleanFeature.type === 'Feature' && cleanFeature.geometry) {
                    clones.push(cleanFeature);
                } else {
                    console.warn('ProposalManager._cloneFeatures: invalid feature structure', cleanFeature);
                }
            } catch (error) {
                console.warn('ProposalManager._cloneFeatures: failed to clone feature', error);
            }
        });
        return clones;
    },

    _collectParentParcelIds(_roadProposal = {}, proposalData = {}) {
        const sources = [];
        if (Array.isArray(proposalData.parentParcelIds)) sources.push(...proposalData.parentParcelIds);
        return Array.from(new Set(sources.map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));
    },

    _getParcelFeatureFromMap(parcelId) {
        if (!parcelId || typeof window === 'undefined') return null;
        const idStr = parcelId && parcelId.toString ? parcelId.toString() : String(parcelId);
        if (!idStr) return null;

        let layer = null;
        try {
            if (typeof window.resolveParcelLayerById === 'function') {
                layer = window.resolveParcelLayerById(idStr);
            }
        } catch (error) {
            console.warn('Failed to read parcel from map', { parcelId: idStr, error });
        }

        if (!layer || !layer.feature) {
            console.error(`[ProposalManager] Parcel ${idStr} not present in parcelLayerById; aborting lookup.`);
            return null;
        }
        const feature = layer.feature;
        return {
            type: 'Feature',
            properties: feature.properties ? { ...feature.properties } : {},
            geometry: feature.geometry ? JSON.parse(JSON.stringify(feature.geometry)) : null
        };
    },

    _getParcelFeatureFromStorage(parcelId) {
        if (!parcelId) return null;
        const idStr = parcelId && parcelId.toString ? parcelId.toString() : String(parcelId);
        if (!idStr) return null;

        try {
            if (typeof readPersistedParcelRecord !== 'function') return null;
            const record = readPersistedParcelRecord(idStr);
            if (!record || !record.properties || !record.geometry) return null;
            return {
                type: 'Feature',
                properties: { ...record.properties },
                geometry: JSON.parse(JSON.stringify(record.geometry))
            };
        } catch (error) {
            console.warn('Failed to hydrate parcel from storage', { parcelId: idStr, error });
            return null;
        }
    },

    _getParcelLayerById(parcelId) {
        if (!parcelId || typeof window === 'undefined') return null;
        const idStr = parcelId && parcelId.toString ? parcelId.toString() : String(parcelId);
        if (!idStr) return null;

        try {
            if (typeof window.resolveParcelLayerById === 'function') {
                const direct = window.resolveParcelLayerById(idStr);
                if (direct) return direct;
            }
            if (window.parcelLayer && typeof window.parcelLayer.eachLayer === 'function') {
                let found = null;
                window.parcelLayer.eachLayer(layer => {
                    if (found) return;
                    const candidateId = _getParcelIdFromFeature(layer?.feature);
                    if (candidateId && String(candidateId) === idStr) {
                        found = layer;
                    }
                });
                if (found) return found;
            }
        } catch (error) {
            console.warn('Failed to resolve parcel layer', { parcelId: idStr, error });
        }
        return null;
    },

    _upsertParcelProperties(parcelId, mutator, options = {}) {
        if (!parcelId) return;
        const idStr = parcelId && parcelId.toString ? parcelId.toString() : String(parcelId);
        if (!idStr) return;

        const persistIfMissing = options.persistIfMissing === true;
        const record = (typeof readPersistedParcelRecord === 'function') ? readPersistedParcelRecord(idStr) : null;
        const hadStorage = !!record;
        const propsFromStorage = record?.properties || null;

        const layer = this._getParcelLayerById(idStr);
        const propsFromLayer = layer && layer.feature && layer.feature.properties ? layer.feature.properties : null;

        const working = propsFromStorage || (propsFromLayer ? { ...propsFromLayer } : {});
        try { mutator(working); } catch (_) { /* ignore mutator errors */ }

        if (propsFromLayer) {
            layer.feature.properties = { ...propsFromLayer, ...working };
        }

        if (hadStorage || persistIfMissing) {
            if (typeof writePersistedParcelRecord === 'function') {
                writePersistedParcelRecord(idStr, rec => {
                    rec.properties = { ...(rec.properties || {}), ...working };
                });
            }
        }
    },

    _persistParcelFeature(feature) {
        if (!feature || !feature.properties || !feature.geometry) return;
        const parcelId = _getParcelIdFromFeature(feature);
        if (parcelId === undefined || parcelId === null) return;
        const idStr = parcelId && parcelId.toString ? parcelId.toString() : String(parcelId);
        if (!idStr) return;

        if (typeof writePersistedParcelRecord === 'function') {
            writePersistedParcelRecord(idStr, rec => {
                rec.geometry = JSON.parse(JSON.stringify(feature.geometry));
                rec.properties = { ...feature.properties };
                // No longer need to clear removedByProposal - visibility is calculated from parent/child relationships
            });
        }
    },

    _resolveParcelFeaturesByIds(parcelIds, options = {}) {
        const preferMap = options.preferMap !== false;
        const allowStorage = options.allowStorage === true;
        const allowCache = options.allowCache !== false;
        const allowMissing = options.allowMissing === true;
        const ids = Array.isArray(parcelIds) ? parcelIds : [];
        const seen = new Set();
        const features = [];

        // Build a one-shot lookup to avoid N x parcelLayer scans when many ids are requested
        let mapLookup = null;
        if (preferMap && typeof window !== 'undefined') {
            const byId = window.parcelLayerById instanceof Map ? window.parcelLayerById : null;
            if (byId && byId.size > 0) {
                mapLookup = byId;
            } else if (window.parcelLayer && typeof window.parcelLayer.eachLayer === 'function') {
                mapLookup = new Map();
                window.parcelLayer.eachLayer(layer => {
                    const candidateId = _getParcelIdFromFeature(layer?.feature);
                    if (candidateId === undefined || candidateId === null) return;
                    mapLookup.set(candidateId.toString(), layer);
                });
            }
        }

        // Also consult the in-memory parcel cache for parcels that were fetched but intentionally not rendered
        // (e.g., ancestors replaced by applied descendants).
        let cacheLookup = null;
        if (allowCache) {
            try {
                const store = (typeof ParcelsState !== 'undefined' && ParcelsState && typeof ParcelsState.getParcelCache === 'function')
                    ? ParcelsState.getParcelCache()
                    : (typeof window !== 'undefined' ? window.parcelCache : null);
                const byId = store && store.byId instanceof Map ? store.byId : null;
                if (byId && byId.size > 0) {
                    cacheLookup = byId;
                }
            } catch (_) { /* best-effort */ }
        }

        ids.forEach(rawId => {
            const idStr = rawId && rawId.toString ? rawId.toString() : String(rawId || '');
            if (!idStr || seen.has(idStr)) return;
            seen.add(idStr);

            let feature = null;
            if (preferMap) {
                const layer = mapLookup && mapLookup.get(idStr);
                if (layer && layer.feature) {
                    feature = {
                        type: 'Feature',
                        properties: layer.feature.properties ? { ...layer.feature.properties } : {},
                        geometry: layer.feature.geometry ? JSON.parse(JSON.stringify(layer.feature.geometry)) : null
                    };
                }
            }

            // Fallback to parcel cache (loaded but not necessarily rendered)
            if (!feature && cacheLookup) {
                const cached = cacheLookup.get(idStr);
                if (cached && cached.geometry && cached.properties) {
                    feature = {
                        type: 'Feature',
                        properties: { ...cached.properties },
                        geometry: JSON.parse(JSON.stringify(cached.geometry))
                    };
                }
            }

            // Fallback to persisted storage if allowed
            if (!feature && allowStorage && typeof readPersistedParcelRecord === 'function') {
                try {
                    const rec = readPersistedParcelRecord(idStr);
                    if (rec && rec.geometry && rec.properties) {
                        feature = {
                            type: 'Feature',
                            properties: { ...rec.properties },
                            geometry: JSON.parse(JSON.stringify(rec.geometry))
                        };
                    }
                } catch (err) {
                    console.warn(`[ProposalManager] Failed to read persisted parcel ${idStr}`, err);
                }
            }

            if (!feature) {
                if (!allowMissing) {
                    console.error(`[ProposalManager] Parcel ${idStr} missing in parcelLayerById; stopping resolution.`);
                    throw new Error(`Missing parcel ${idStr} in parcelLayerById`);
                }
                return;
            }

            // Normalize id onto properties (some sources only set it on the layer mapping)
            try {
                if (feature.properties) {
                    _ensureParcelIdOnProperties(feature.properties, idStr);
                }
            } catch (_) { }

            features.push(feature);
        });

        return features;
    },

    _rebuildRoadFromDefinition(proposalData, parentParcelIds) {
        if (!proposalData || !proposalData.roadProposal || !proposalData.roadProposal.definition) {
            return { parentFeatures: [], childFeatures: [] };
        }
        const proposalId = _resolveProposalId(proposalData) || proposalData.id || 'unknown-proposal';

        // Fetch parent features by ID (geometries are in the parcel system, not stored on proposal)
        const parcelIds = Array.isArray(parentParcelIds) && parentParcelIds.length > 0
            ? parentParcelIds.map(id => String(id)).filter(Boolean)
            : (proposalData.parentParcelIds || proposalData.roadProposal.parentParcelIds || []);

        if (parcelIds.length === 0) {
            console.warn('_rebuildRoadFromDefinition: No parent parcel IDs provided', proposalId);
            return { parentFeatures: [], childFeatures: [] };
        }

        const parentFeatures = this._resolveParcelFeaturesByIds(parcelIds, { preferMap: true, allowStorage: true });
        if (parentFeatures.length === 0) {
            console.warn('_rebuildRoadFromDefinition: Could not resolve parent parcels by ID', parcelIds, proposalId);
            return { parentFeatures: [], childFeatures: [] };
        }

        const childFeatures = this._buildChildFeaturesFromDefinition(proposalId, proposalData, parentFeatures);
        // Don't return parentFeatures - they're not stored, just used temporarily for calculation
        return { parentFeatures: [], childFeatures };
    },

    _buildChildFeaturesFromDefinition(proposalId, proposalData, parentFeatures = []) {
        if (!proposalData || !proposalData.roadProposal || !proposalData.roadProposal.definition) {
            return [];
        }
        const safeId = proposalId || _resolveProposalId(proposalData) || proposalData.id || 'unknown-proposal';
        const definition = proposalData.roadProposal.definition || {};
        const geometryFromDefinition = definition.polygon || null;
        const geometryFromProposal = proposalData?.geometry?.roadGeometry?.polygon || proposalData?.geometry?.roadGeometry || null;
        const polygonGeometry = geometryFromDefinition || geometryFromProposal || null;

        // If a polygon was provided (e.g., full-parcel corridor), build road features directly from it
        if (polygonGeometry && polygonGeometry.type && Array.isArray(polygonGeometry.coordinates)) {
            // Pick the largest polygon (with its holes) from the geometry
            const pickPrimaryPolygonRings = (geom) => {
                if (!geom || !geom.type || !Array.isArray(geom.coordinates)) return null;
                if (geom.type === 'Polygon') {
                    // Return all rings: [outer, ...holes]
                    const rings = geom.coordinates
                        .map(ring => Array.isArray(ring) ? _ensurePolygonIsClosed(ring) : null)
                        .filter(ring => Array.isArray(ring) && ring.length >= 4);
                    return rings.length > 0 ? rings : null;
                }
                if (geom.type === 'MultiPolygon') {
                    let largestRings = null;
                    let largestArea = -Infinity;
                    geom.coordinates.forEach(poly => {
                        if (!Array.isArray(poly) || !poly.length) return;
                        const rings = poly
                            .map(ring => Array.isArray(ring) ? _ensurePolygonIsClosed(ring) : null)
                            .filter(ring => Array.isArray(ring) && ring.length >= 4);
                        if (!rings.length) return;
                        if (typeof turf === 'undefined') {
                            if (!largestRings) largestRings = rings;
                            return;
                        }
                        try {
                            const area = turf.area(turf.polygon(rings));
                            if (area > largestArea) {
                                largestArea = area;
                                largestRings = rings;
                            }
                        } catch (_) { /* ignore */ }
                    });
                    return largestRings;
                }
                return null;
            };

            const primaryPolygonRings = pickPrimaryPolygonRings(polygonGeometry);
            if (!primaryPolygonRings || !primaryPolygonRings.length) return [];
            const primaryRing = primaryPolygonRings[0];

            const latLngPolygon = primaryRing.map(coord => {
                if (!Array.isArray(coord) || coord.length < 2) return null;
                return L.latLng(coord[1], coord[0]);
            }).filter(Boolean);
            if (latLngPolygon.length < 3) return [];

            const proposalToken = _buildSyntheticToken(safeId || 'proposal');
            const numberAllocators = {};
            const corridorMode = (definition?.metadata?.mode || definition?.mode || '').toLowerCase();
            const treatAsFullCorridor = corridorMode === 'full';

            const getRootInfo = (feature) => {
                const props = feature?.properties || {};
                const parcelNumber = props.BROJ_CESTICE ? String(props.BROJ_CESTICE) : '';
                const parcelId = _getParcelIdFromFeature(feature) || '';
                const rootNumber = _resolveRootParcelNumberFromProperties(props, parcelId)
                    || _extractRootParcelNumber(parcelNumber);
                const rootParcelId = _resolveRootParcelIdFromProperties(props, parcelId)
                    || _extractRootParcelId(parcelId);
                return {
                    rootNumber,
                    rootParcelId
                };
            };

            const getAllocatorKey = (rootNumber, rootParcelId) => syntheticParcelAllocatorKey(rootParcelId, rootNumber);

            const getNextIdentity = (rootNumber, rootParcelId) => {
                if (!rootNumber || !rootParcelId) {
                    console.warn('Missing root info for parcel identity generation:', { rootNumber, rootParcelId });
                    return null;
                }
                const key = getAllocatorKey(rootNumber, rootParcelId);
                let state = numberAllocators[key];
                if (!state) {
                    state = numberAllocators[key] = {
                        baseId: rootParcelId,
                        nextIndex: 1
                    };
                }
                const sub = state.nextIndex;
                state.nextIndex += 1;
                return {
                    parcelNumber: _composeSyntheticParcelNumber(rootNumber, proposalToken, sub),
                    parcelId: _composeSyntheticParcelId(state.baseId, proposalToken, sub),
                    subNumber: sub
                };
            };

            const affectedParcels = parentFeatures.map(f => {
                const layer = L.geoJSON(f);
                const rootInfo = getRootInfo(f);
                const parcelId = _getParcelIdFromFeature(f);
                return {
                    id: parcelId,
                    number: f?.properties?.BROJ_CESTICE,
                    rootNumber: rootInfo.rootNumber,
                    rootParcelId: rootInfo.rootParcelId,
                    layer: layer,
                    feature: f
                };
            }).filter(entry => entry && entry.id);

            if (!affectedParcels.length) return [];

            const primaryAffectedParcelNumber = affectedParcels[0]?.number;
            const primaryRootNumber = affectedParcels[0]?.rootNumber;
            const primaryRootParcelId = affectedParcels[0]?.rootParcelId;
            const roadIdentity = getNextIdentity(primaryRootNumber, primaryRootParcelId);
            const isTrack = definition?.metadata?.isTrack === true || definition?.metadata?.type === 'track' || definition?.type === 'track';
            console.debug('[_buildChildFeaturesFromDefinition] Creating corridor feature', {
                proposalId: safeId,
                isTrack,
                metadataType: definition?.metadata?.type,
                metadataIsTrack: definition?.metadata?.isTrack,
                definitionType: definition?.type
            });

            const normalizeParcelGeometry = (geometry) => {
                const polygons = _extractPolygonsWithHolesFromGeometry(geometry);
                if (!polygons.length) {
                    return null;
                }
                if (geometry.type === 'MultiPolygon') {
                    const coords = polygons.map(({ outer, holes }) => [outer, ...(holes || [])]);
                    return { type: 'MultiPolygon', coordinates: coords };
                }
                const primary = polygons[0];
                return { type: 'Polygon', coordinates: [primary.outer, ...(primary.holes || [])] };
            };

            const extractDiffPolygons = (geometry) => {
                if (!geometry) return [];
                const polygons = _extractPolygonsWithHolesFromGeometry(geometry);
                return polygons.map(({ outer, holes }) => {
                    const closedOuter = _ensurePolygonIsClosed(outer || []);
                    const closedHoles = Array.isArray(holes) ? holes.map(ring => _ensurePolygonIsClosed(ring || [])) : [];
                    const coords = [closedOuter, ...closedHoles];
                    const area = (typeof turf !== 'undefined' && turf.area) ? turf.area(turf.polygon(coords)) : 0;
                    return { coords, area };
                }).filter(item => Array.isArray(item.coords[0]) && item.coords[0].length >= 4 && item.area >= MIN_MEANINGFUL_CHILD_AREA);
            };

            const roadFeatureProperties = {
                parcelId: roadIdentity ? roadIdentity.parcelId : `road_${Date.now()}`,
                parcelNumber: roadIdentity ? roadIdentity.parcelNumber : `${primaryAffectedParcelNumber || 'road'}/${Date.now()}`,
                isRoad: !isTrack, // tracks are NOT roads
                isCorridor: true,
                isTrack: isTrack,
                calculatedArea: _calculateAreaFromLatLngPolygon(latLngPolygon),
                roadName: proposalData.title || proposalData.name || 'Road',
                isProposed: true,
                proposalId: safeId,
                parentParcelId: affectedParcels[0]?.id || null,
                parentParcelNumber: primaryAffectedParcelNumber || null,
                parentParcelIds: affectedParcels.map(p => p.id),
                parentParcelNumbers: affectedParcels.map(p => p.number),
                rootParcelNumber: primaryRootNumber,
                rootParcelId: primaryRootParcelId,
                ownershipDetails: {
                    owners: [{
                        name: proposalData.author || 'User',
                        ownerLabel: proposalData.author || 'User',
                        percentageShare: 100,
                        actualShareText: '100%'
                    }]
                }
            };

            if (isTrack && Array.isArray(definition.points)) {
                roadFeatureProperties.trackPoints = definition.points;
            }

            const roadFeature = {
                type: 'Feature',
                properties: roadFeatureProperties,
                geometry: {
                    type: 'Polygon',
                    coordinates: primaryPolygonRings.map(ring => ring.map(coord => [coord[0], coord[1]]))
                }
            };

            _assignOwnershipDetails(roadFeature, {
                defaultOwnerName: proposalData?.author || 'User',
                overwriteExisting: true
            });

            const childFeatures = [roadFeature];

            // For drawn corridors, carve the road polygon out of parents to keep residual descendants on the map.
            if (!treatAsFullCorridor && typeof turf !== 'undefined' && turf.difference) {
                // Include holes in the road polygon so turf.difference preserves parcels inside holes
                const roadRings = primaryPolygonRings.map(ring => _ensurePolygonIsClosed(ring.map(coord => [coord[0], coord[1]])));
                const roadTurf = turf.polygon(roadRings);
                console.debug('[_buildChildFeaturesFromDefinition] Road polygon has', roadRings.length - 1, 'holes');
                const createdGeometryHashes = new Set();

                affectedParcels.forEach(parcel => {
                    const originalFeature = parcel.feature;
                    const originalNumber = originalFeature.properties.BROJ_CESTICE;
                    const parcelId = _getParcelIdFromFeature(originalFeature);
                    const rootNumber = parcel.rootNumber;
                    const rootParcelId = parcel.rootParcelId;

                    try {
                        const parcelGeometry = normalizeParcelGeometry(originalFeature.geometry);
                        if (!parcelGeometry) throw new Error('Invalid parcel geometry');

                        const parcelTurf = parcelGeometry.type === 'MultiPolygon'
                            ? turf.multiPolygon(parcelGeometry.coordinates)
                            : turf.polygon(parcelGeometry.coordinates);
                        let parentParcelArea = 0;
                        try {
                            parentParcelArea = typeof turf.area === 'function' ? turf.area(parcelTurf) : 0;
                        } catch (_) { parentParcelArea = 0; }
                        const difference = turf.difference(parcelTurf, roadTurf);
                        const parentIsRoad = originalFeature?.properties?.isRoad === true
                            || originalFeature?.properties?.isRoad === 'true';

                        if (!difference) {
                            // Parcel fully consumed by corridor
                            return;
                        }

                        const pieces = extractDiffPolygons(difference.geometry).sort((a, b) => b.area - a.area);
                        pieces.forEach(piece => {
                            // Same uncut-remainder guard as Proposal.calculateChildFeatures: only skip
                            // when the remainder area is effectively unchanged within a tiny tolerance.
                            if (_shouldSkipUncutRemainder(parentParcelArea, piece.area)) {
                                console.debug(`[_buildChildFeaturesFromDefinition] Skipping uncut remainder for ${parcelId} — road polygon did not intersect this parcel`);
                                return;
                            }
                            const hash = _geometryHash(piece.coords);
                            if (createdGeometryHashes.has(hash)) return;
                            createdGeometryHashes.add(hash);

                            const newFeature = JSON.parse(JSON.stringify(originalFeature));
                            newFeature.geometry.type = 'Polygon';
                            newFeature.geometry.coordinates = piece.coords;
                            newFeature.properties.calculatedArea = piece.area;
                            const identity = getNextIdentity(rootNumber, rootParcelId);
                            if (identity) {
                                newFeature.properties.parcelId = identity.parcelId;
                                newFeature.properties.parcelNumber = identity.parcelNumber;
                            } else {
                                const fallbackId = `${parcelId}_derived_${Date.now()}`;
                                newFeature.properties.parcelId = fallbackId;
                                newFeature.properties.parcelNumber = rootNumber ? `${rootNumber}/${Date.now()}` : `${originalNumber}/${Date.now()}`;
                            }
                            _ensureParcelIdOnProperties(newFeature.properties, newFeature.properties.parcelId);
                            newFeature.properties.parentParcelId = parcelId;
                            newFeature.properties.parentParcelNumber = originalNumber;
                            newFeature.properties.rootParcelNumber = rootNumber;
                            newFeature.properties.rootParcelId = rootParcelId;
                            newFeature.properties.proposalId = safeId;
                            newFeature.properties.isRoad = parentIsRoad;
                            newFeature.properties.isCorridor = parentIsRoad === true;

                            _assignOwnershipDetails(newFeature, {
                                parentFeature: originalFeature,
                                defaultOwnerName: proposalData?.author || 'User'
                            });
                            childFeatures.push(newFeature);
                        });
                    } catch (error) {
                        console.error(`Error processing parcel ${parcelId} (Number: ${originalNumber}):`, error);
                    }
                });
            }

            this._assignSyntheticChildIdentities(safeId, childFeatures);
            return childFeatures;
        }

        const proposal = new Proposal({
            id: safeId,
            proposalId: safeId,
            name: proposalData.title || proposalData.name || 'Road',
            type: 'road',
            definition: definition,
            parentFeatures: this._cloneFeatures(parentFeatures),
            author: proposalData.author,
            description: proposalData.description,
            offer: proposalData.offer,
            budget: proposalData.budget
        });
        proposal.calculateChildFeatures();
        const childFeatures = this._cloneFeatures(Array.isArray(proposal.childFeatures) ? proposal.childFeatures : []);
        // Ensure synthetic ids stay deterministic across restores
        this._assignSyntheticChildIdentities(safeId, childFeatures);
        return childFeatures;
    },

    _loadRoadProposalAssets(proposalData, options = {}) {
        const includeParents = options.includeParents !== false;
        const includeChildren = options.includeChildren !== false;
        const allowMissing = options.allowMissing === true;

        const canonicalParentParcelIds = Array.isArray(proposalData?.parentParcelIds) ? proposalData.parentParcelIds : [];
        const canonicalChildParcelIds = Array.isArray(proposalData?.childParcelIds) ? proposalData.childParcelIds : [];
        const canonicalRoadPlan = proposalData?.geometry?.roadPlan || null;
        const canonicalRoadGeometry = proposalData?.geometry?.roadGeometry || null;
        const roadProposal = proposalData?.roadProposal || null;

        const result = {
            parentFeatures: [],
            childFeatures: []
        };

        const parentIds = canonicalParentParcelIds.slice();
        const childIds = canonicalChildParcelIds.slice();

        if (includeParents) {
            // Always fetch by ID - never cache parentFeatures on proposal objects
            if (parentIds.length > 0) {
                result.parentFeatures = this._resolveParcelFeaturesByIds(parentIds, { preferMap: true, allowStorage: true, allowMissing });
            }
        }

        if (includeChildren && Array.isArray(childIds) && childIds.length > 0) {
            // Pass allowMissing through to the children resolver. Without it, a single unresolved
            // synthetic descendant id (e.g. on a fresh client where _persistParcelFeature has not
            // yet indexed it into parcelLayerById) throws and aborts the entire asset load,
            // preventing _applyRoadProposal from ever reaching the rebuild-from-definition branch.
            // In restore mode missing children are expected — they will be rebuilt deterministically
            // from (parent geometry, road definition) further down the apply pipeline.
            result.childFeatures = this._resolveParcelFeaturesByIds(childIds, { preferMap: true, allowStorage: true, allowMissing });
        }

        // Rebuild from definition if we still lack features
        const needsParents = includeParents && result.parentFeatures.length === 0 && parentIds.length > 0;
        const needsChildren = includeChildren && result.childFeatures.length === 0;

        if (needsParents) {
            result.parentFeatures = this._resolveParcelFeaturesByIds(parentIds, { preferMap: false, allowStorage: true, fallbackToMap: true, allowMissing });
        }

        return result;
    },

    _assignSyntheticChildIdentities(proposalId, childFeatures) {
        _assignSyntheticChildIdentitiesImpl(proposalId, childFeatures);
    },

    _buildSyntheticToken,
    _composeSyntheticParcelNumber,
    _composeSyntheticParcelId,
    isSyntheticParcelId,

    _collectStructureParentLayers(structureProposal, proposalData) {
        const ids = Array.isArray(structureProposal?.parentParcelIds) && structureProposal.parentParcelIds.length > 0
            ? structureProposal.parentParcelIds
            : (proposalData?.parcelIds || []);
        if (!Array.isArray(ids) || ids.length === 0) {
            return [];
        }
        const layers = [];
        if (typeof multiParcelSelection !== 'undefined' && typeof multiParcelSelection.findParcelById === 'function') {
            ids.forEach(rawId => {
                const id = rawId && rawId.toString ? rawId.toString() : (rawId ? String(rawId) : null);
                if (!id) return;
                try {
                    const layer = multiParcelSelection.findParcelById(id);
                    if (layer && layer.feature) {
                        layers.push(layer);
                    }
                } catch (error) {
                    console.warn('collectStructureParentLayers: failed to resolve parcel layer', id, error);
                }
            });
        }

        // When parcels were removed from the map (e.g., after another structure was applied), fall back to persisted parcel features.
        if (!layers.length && typeof this._resolveParcelFeaturesByIds === 'function') {
            const features = this._resolveParcelFeaturesByIds(ids, { preferMap: true, allowStorage: true, fallbackToMap: true, allowMissing: true });
            features.forEach(feature => {
                if (feature && typeof feature === 'object') {
                    layers.push({ feature });
                }
            });
        }
        return layers;
    },

    _getCanonicalStructureGeometry(proposalData, kindHint = null) {
        if (!proposalData || !proposalData.geometry) return null;
        const geometry = proposalData.geometry;
        const kind = this._normalizeGoalKey(kindHint || proposalData.goal);
        if (kind === 'lake') {
            if (geometry.lakeGraphics && geometry.lakeGraphics.geometry) return geometry.lakeGraphics.geometry;
            if (geometry.lakeGraphics && geometry.lakeGraphics.type && geometry.lakeGraphics.coordinates) return geometry.lakeGraphics;
        }
        if (kind === 'park' && geometry.parkGraphics) return geometry.parkGraphics;
        if (kind === 'square' && geometry.squareGraphics) return geometry.squareGraphics;
        if (geometry.squareGraphics) return geometry.squareGraphics;
        return null;
    },

    _rebuildStructureGeometry(structureProposal, proposalData) {
        if (!structureProposal) {
            return null;
        }
        if (structureProposal.geometry && Array.isArray(structureProposal.geometry.coordinates)) {
            return structureProposal.geometry;
        }
        const canonicalGeometry = this._getCanonicalStructureGeometry(proposalData, structureProposal.kind);
        if (canonicalGeometry && canonicalGeometry.type && Array.isArray(canonicalGeometry.coordinates)) {
            try { structureProposal.geometry = JSON.parse(JSON.stringify(canonicalGeometry)); } catch (_) { structureProposal.geometry = canonicalGeometry; }
            return structureProposal.geometry;
        }
        if (typeof buildGeometryFromParcels !== 'function') {
            return null;
        }
        try {
            const parentLayers = this._collectStructureParentLayers(structureProposal, proposalData);
            const layerCount = Array.isArray(parentLayers) ? parentLayers.length : 0;
            if (!layerCount) {
                console.warn('[ProposalManager] _rebuildStructureGeometry: no parent layers found for structure', {
                    parentIdsCount: Array.isArray(structureProposal?.parentParcelIds) ? structureProposal.parentParcelIds.length : 0,
                    proposalId: _resolveProposalId(proposalData) || proposalData?.proposalId || proposalData?.id || 'unknown'
                });
                return null;
            }
            const rebuilt = buildGeometryFromParcels(parentLayers);
            if (rebuilt && rebuilt.type && Array.isArray(rebuilt.coordinates)) {
                console.debug('[ProposalManager] _rebuildStructureGeometry: rebuilt geometry', {
                    type: rebuilt.type,
                    rings: Array.isArray(rebuilt.coordinates) ? rebuilt.coordinates.length : 0,
                    parentLayers: layerCount
                });
                structureProposal.geometry = rebuilt;
                return rebuilt;
            }
            console.warn('[ProposalManager] _rebuildStructureGeometry: failed to build geometry from parent layers', {
                parentLayers: layerCount
            });
        } catch (error) {
            console.warn('rebuildStructureGeometry failed', error);
        }
        return null;
    },

    _inferStructureKindFromProposal(proposalData) {
        if (!proposalData) return null;
        const kind = this._normalizeGoalKey(proposalData.goal);
        return (kind === 'park' || kind === 'square' || kind === 'lake') ? kind : null;
    },

    _bootstrapStructureProposalFromMetadata(proposalData) {
        if (!proposalData) return null;
        if (proposalData.structureProposal && typeof proposalData.structureProposal === 'object') {
            return proposalData.structureProposal;
        }
        const inferredKind = this._inferStructureKindFromProposal(proposalData);
        if (!inferredKind) {
            return null;
        }
        const parentIds = Array.isArray(proposalData.parentParcelIds)
            ? proposalData.parentParcelIds.map(id => id && id.toString ? id.toString() : String(id || ''))
            : [];
        if (!parentIds.length) {
            return null;
        }
        const synthetic = {
            kind: inferredKind,
            parentParcelIds: parentIds,
            blockName: proposalData.blockName || null,
            status: proposalData.status && proposalData.status.toLowerCase() === 'applied' ? 'applied' : 'unapplied'
        };
        const canonicalGeometry = this._getCanonicalStructureGeometry(proposalData, inferredKind);
        const geometry = canonicalGeometry && canonicalGeometry.type && Array.isArray(canonicalGeometry.coordinates)
            ? canonicalGeometry
            : this._rebuildStructureGeometry(synthetic, proposalData);
        if (!geometry) {
            try {
                const cityId = typeof window !== 'undefined' && window.cityConfigManager && typeof window.cityConfigManager.getCurrentCityId === 'function'
                    ? window.cityConfigManager.getCurrentCityId()
                    : null;
                console.warn('[ProposalManager] Failed to bootstrap structure geometry from metadata', {
                    cityId,
                    inferredKind,
                    parentIdsCount: parentIds.length,
                    parcelIdsSample: parentIds.slice(0, 5)
                });
            } catch (_) { /* ignore logging errors */ }
            return null;
        }
        try { synthetic.geometry = JSON.parse(JSON.stringify(geometry)); } catch (_) { synthetic.geometry = geometry; }
        proposalData.structureProposal = synthetic;
        try {
            proposalData.proposalId = _resolveProposalId(proposalData) || proposalData.id || 'unknown-proposal';
            if (typeof proposalStorage._indexProposal === 'function') {
                proposalStorage._indexProposal(proposalData);
            } else {
                proposalStorage.proposals.set(proposalData.proposalId, proposalData);
            }
            if (typeof proposalStorage.save === 'function') {
                proposalStorage.save();
            }
        } catch (_) { }
        return synthetic;
    },

    canApplyProposal(proposalId) {
        // Ancestor proposal gating disabled; rely on parcel presence checks instead
        return { ok: true, missing: [] };
    },

    _supersedeCopiedRoadSource(proposalId, proposalData) {
        if (typeof supersedeCopiedRoadSource !== 'function') return null;
        const source = supersedeCopiedRoadSource(proposalData, proposalId, id => _getProposalRecord(id));
        if (!source) return null;
        if (typeof proposalStorage.save === 'function') proposalStorage.save();
        const sourceName = source.title || source.name || source.proposalName || source.proposalId || 'the previous road';
        const message = (typeof window !== 'undefined' && window.i18n && typeof window.i18n.t === 'function')
            ? window.i18n.t('alerts.messages.road_source_incorporated', { name: sourceName })
            : `Applied the combined road and removed “${sourceName}” from the map.`;
        try { if (typeof showEphemeralMessage === 'function') showEphemeralMessage(message, 5000, 'success'); } catch (_) { }
        console.info('[ProposalManager] Incorporated copied road source into replacement', {
            sourceProposalId: source.proposalId,
            replacementProposalId: proposalId
        });
        return source;
    },

    _restoreSupersededRoadSources(proposalId, proposalData) {
        if (typeof restoreSupersededRoadSources !== 'function') return [];
        const restored = restoreSupersededRoadSources(proposalData, proposalId, id => _getProposalRecord(id));
        if (restored.length && typeof proposalStorage.save === 'function') proposalStorage.save();
        return restored;
    },

    _beginReplacementSupersession(proposalId, proposalData) {
        if (typeof beginReplacementSupersession !== 'function') return null;
        const transaction = beginReplacementSupersession(proposalData, proposalId, id => _getProposalRecord(id));
        if (transaction && typeof proposalStorage.save === 'function') proposalStorage.save();
        return transaction;
    },

    _commitReplacementSupersession(proposalId, proposalData) {
        if (typeof commitReplacementSupersession !== 'function') return null;
        const transaction = commitReplacementSupersession(proposalData, proposalId, id => _getProposalRecord(id));
        if (transaction && typeof proposalStorage.save === 'function') proposalStorage.save();
        return transaction;
    },

    async _restoreReplacementSource(proposalId, proposalData) {
        if (!proposalData || proposalData.roadProposal || typeof releaseReplacementSource !== 'function') return null;
        if (typeof proposalIsAppliedForReplacement === 'function' && proposalIsAppliedForReplacement(proposalData)) return null;
        const restoration = releaseReplacementSource(proposalData, proposalId, id => _getProposalRecord(id));
        if (!restoration) return null;
        if (typeof proposalStorage.save === 'function') proposalStorage.save();
        if (!restoration.shouldReapply || !restoration.source) return restoration;
        try {
            const restored = await this.applyProposal(restoration.sourceId, {
                applyAnyway: true,
                _restoringReplacementSource: true
            });
            if (!restored) throw new Error('The source proposal could not be reapplied.');
            delete proposalData.replacementRestorationError;
            if (typeof proposalStorage.save === 'function') proposalStorage.save();
        } catch (error) {
            if (typeof markReplacementRestorationFailed === 'function') {
                markReplacementRestorationFailed(proposalData, restoration.sourceId, error);
            }
            if (typeof proposalStorage.save === 'function') proposalStorage.save();
            console.error('[ProposalManager] Failed to restore replacement source', {
                proposalId,
                sourceProposalId: restoration.sourceId,
                error
            });
        }
        return restoration;
    },

    async applyProposal(proposalId, options = {}) {
        const safeId = _normalizeProposalId(proposalId) || '';
        const applyOptions = options || {};

        try { this._clearLastApplyFailure(safeId); } catch (_) { }

        if (typeof proposalStorage === 'undefined') {
            console.warn(`[ProposalManager.applyProposal] proposalStorage is undefined`);
            return false;
        }

        const proposalData = _getProposalRecord(safeId);
        if (!proposalData) {
            console.warn(`[ProposalManager.applyProposal] Proposal not found: ${safeId}`);
            return false;
        }

        if (typeof activeReplacementSuperseder === 'function') {
            const superseder = activeReplacementSuperseder(proposalData, id => _getProposalRecord(id));
            if (superseder) {
                const replacementName = superseder.title || superseder.name || superseder.proposalName || superseder.proposalId || 'the replacement proposal';
                const message = `This proposal is superseded by “${replacementName}”. Remove the replacement from the map before applying this source.`;
                try { this._setLastApplyFailure(safeId, message); } catch (_) { }
                try { if (typeof updateStatus === 'function') updateStatus(message); } catch (_) { }
                try { if (typeof showEphemeralMessage === 'function') showEphemeralMessage(message, 5000, 'warning'); } catch (_) { }
                return false;
            }
        }

        // A copied road that has been incorporated into an applied replacement is deliberately parked:
        // applying it as well would paint the same corridor twice. Removing the replacement restores it.
        if (typeof activeRoadSuperseder === 'function') {
            const superseder = activeRoadSuperseder(proposalData, id => _getProposalRecord(id));
            if (superseder) {
                const replacementName = superseder.title || superseder.name || superseder.proposalName || superseder.proposalId || 'the combined road';
                const message = (typeof window !== 'undefined' && window.i18n && typeof window.i18n.t === 'function')
                    ? window.i18n.t('ephemeral.messages.road_source_included_in_replacement', { name: replacementName })
                    : `This road is included in “${replacementName}”. Remove the combined road from the map before applying this one.`;
                try { this._setLastApplyFailure(safeId, message); } catch (_) { }
                try { if (typeof updateStatus === 'function') updateStatus(message); } catch (_) { }
                try { if (typeof showEphemeralMessage === 'function') showEphemeralMessage(message, 5000, 'warning'); } catch (_) { }
                return false;
            }
        }

        // Check if already applied to prevent duplicate applies
        // Note: We check status here rather than relying on isProposalApplied to avoid
        // race conditions where status hasn't been updated yet
        const roadStatus = proposalData.roadProposal?.status?.toLowerCase();
        const decideLaterState = proposalData.decideLaterProposal || {};
        const decideLaterStatus = decideLaterState.status ? decideLaterState.status.toLowerCase() : '';
        const globalStatus = (proposalData.status || '').toLowerCase();
        // Note: 'executed' means all parcels accepted but not yet drawn on map.
        // Only 'applied' means the proposal has been rendered on the map.
        const isAlreadyApplied = roadStatus === 'applied'
            || globalStatus === 'applied'
            || decideLaterStatus === 'applied';

        const isDecideLater = this._isDecideLaterProposal(proposalData);

        if (isAlreadyApplied) {
            // For decide-later proposals, always check if child parcels are on the map
            // Even if _restored is true, child parcels might not be loaded yet
            if (isDecideLater) {
                const decideLaterState = proposalData.decideLaterProposal || {};
                const childParcelIds = Array.from(new Set([
                    ...(Array.isArray(decideLaterState.childParcelIds) ? decideLaterState.childParcelIds : []),
                    ...(Array.isArray(proposalData.childParcelIds) ? proposalData.childParcelIds : [])
                ].map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));

                // Check if any child parcels are missing from the map
                const childParcelsOnMap = childParcelIds.filter(id => this._getParcelLayerById(id));
                const allChildrenOnMap = childParcelIds.length > 0 && childParcelsOnMap.length === childParcelIds.length;

                // If not all children are on map, restore them
                if (!allChildrenOnMap || decideLaterState._restored !== true) {
                    console.debug(`[ProposalManager.applyProposal] Decide later proposal ${safeId} needs restoration:`, {
                        childParcelIds: childParcelIds.length,
                        childParcelsOnMap: childParcelsOnMap.length,
                        _restored: decideLaterState._restored
                    });
                    const restored = await _runProposalApplyWithSummary(
                        safeId,
                        proposalData,
                        () => this._applyDecideLaterProposal(safeId, proposalData)
                    );
                    if (restored) {
                        try { this._clearLastApplyFailure(safeId); } catch (_) { }
                    }
                    return restored;
                } else {
                    console.debug(`[ProposalManager.applyProposal] Decide later proposal ${safeId} already fully restored (${childParcelsOnMap.length}/${childParcelIds.length} children on map)`);
                }
            }

            // Same restore check for road/track proposals. A proposal that arrives from the
            // server already marked status=applied (e.g. a shared /proposals/:id deep-link on
            // a fresh client) has never run _applyRoadProposal locally, so its descendants
            // are not on the map. Without this check applyProposal short-circuits and the
            // road corridor never materializes. Mirrors the decide-later fast path above.
            const roadGoalKey = this._normalizeGoalKey(proposalData.goal);
            if (roadGoalKey === 'road-track' && proposalData.roadProposal) {
                const roadState = proposalData.roadProposal || {};
                const roadChildParcelIds = Array.from(new Set([
                    ...(Array.isArray(roadState.childParcelIds) ? roadState.childParcelIds : []),
                    ...(Array.isArray(proposalData.childParcelIds) ? proposalData.childParcelIds : [])
                ].map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));

                // Two restore triggers:
                //  (a) the proposal lists children, but none are on the map yet
                //  (b) the proposal lists no children at all but has a road definition — this
                //      is the server-fetched case where applyProposal has never run locally
                const hasDefinition = !!(roadState.definition
                    && (roadState.definition.polygon || Array.isArray(roadState.definition.points)));
                const roadChildrenOnMap = roadChildParcelIds.filter(id => this._getParcelLayerById(id));
                const noChildrenLoaded = roadChildParcelIds.length > 0 && roadChildrenOnMap.length === 0;
                const needsInitialApply = roadChildParcelIds.length === 0 && hasDefinition;

                if (noChildrenLoaded || needsInitialApply) {
                    console.debug(`[ProposalManager.applyProposal] Road proposal ${safeId} marked applied but needs restoration:`, {
                        childParcelIds: roadChildParcelIds.length,
                        childParcelsOnMap: roadChildrenOnMap.length,
                        noChildrenLoaded,
                        needsInitialApply
                    });
                    const restored = await _runProposalApplyWithSummary(
                        safeId,
                        proposalData,
                        () => this._applyRoadProposal(safeId, proposalData, { ...applyOptions, _restoreFromAlreadyAppliedState: true })
                    );
                    if (restored) {
                        try { this._clearLastApplyFailure(safeId); } catch (_) { }
                    }
                    return restored;
                }
            }
            return true; // Already applied for other types
        }

        const goalKey = this._normalizeGoalKey(proposalData.goal);
        let result = false;

        // Ownership-transfer proposals (generic "parcel", ownership-transfer-to-me/from-me,
        // and the post-sale "to-buyer") have no visual map payload — ownership is moved at
        // execute time by the chokepoint, not here — so apply is an idempotent no-op success.
        // Without this, every parcel load re-applies these executed proposals and logs
        // "Unsupported proposal goal" once per proposal per pan.
        if (goalKey === 'parcel'
            || goalKey === 'to-buyer'
            || (typeof goalKey === 'string' && goalKey.startsWith('ownership-transfer'))) {
            try { this._clearLastApplyFailure(safeId); } catch (_) { }
            return true;
        }

        if (!(goalKey === 'road-track'
            || goalKey === 'reparcellization'
            || goalKey === 'decide-later'
            || this._isBuildingProposal(proposalData)
            || goalKey === 'park'
            || goalKey === 'square'
            || goalKey === 'lake')) {
            const message = `Unsupported proposal goal: ${goalKey || 'missing goal'}`;
            try { this._setLastApplyFailure(safeId, message); } catch (_) { }
            console.warn(`[ProposalManager.applyProposal] ${message}`, { proposalId: safeId, goal: proposalData.goal });
            console.warn(`Applying proposal ${_getProposalApplyLabel(safeId, proposalData)} ... failed`);
            return false;
        }

        if (goalKey !== 'road-track') this._beginReplacementSupersession(safeId, proposalData);

        result = await _runProposalApplyWithSummary(safeId, proposalData, async () => {
            if (goalKey === 'road-track') {
                return await this._applyRoadProposal(safeId, proposalData, applyOptions);
            }
            if (goalKey === 'reparcellization') {
                return await this._applyReparcellizationProposal(safeId, proposalData, applyOptions);
            }
            if (goalKey === 'decide-later') {
                return await this._applyDecideLaterProposal(safeId, proposalData);
            }
            if (this._isBuildingProposal(proposalData)) {
                return await this._applyBuildingProposal(safeId, proposalData, applyOptions);
            }
            if (!proposalData.structureProposal) {
                this._bootstrapStructureProposalFromMetadata(proposalData);
                console.debug(`[ProposalManager.applyProposal] Bootstrapped structure proposal metadata for ${safeId}`);
            }
            return await this._applyStructureProposal(safeId, proposalData, applyOptions);
        });

        if (result) {
            if (goalKey === 'road-track') this._supersedeCopiedRoadSource(safeId, proposalData);
            else this._commitReplacementSupersession(safeId, proposalData);
            try { this._clearLastApplyFailure(safeId); } catch (_) { }
        }
        return result;
    },

    async _applyStructureProposal(proposalId, proposalData, options = {}) {
        const startTime = performance.now();
        const idLabel = _normalizeProposalId(proposalId) || 'unknown-proposal';
        console.debug(`[_applyStructureProposal] Starting application for ${idLabel}...`);
        try {
            const step1Time = performance.now();
            const sp = proposalData.structureProposal || {};
            const structureStatus = (sp.status || '').toLowerCase();
            const proposalStatus = (proposalData.status || '').toLowerCase();
            const kind = (sp.kind === 'park' || sp.kind === 'square' || sp.kind === 'lake') ? sp.kind : 'square';
            console.debug(`[_applyStructureProposal] Step 1: Initialized structure proposal (${(performance.now() - step1Time).toFixed(2)}ms) - kind: ${kind}`);

            const collection = (kind === 'park') ? window.parks : (kind === 'lake' ? window.lakes : window.squares);
            const alreadyInLayer = Array.isArray(collection)
                ? collection.some(feature => feature && feature.properties && feature.properties.proposalId === proposalId)
                : false;
            const alreadyAppliedStatus = (structureStatus === 'applied' || structureStatus === 'executed'
                || proposalStatus === 'applied' || proposalStatus === 'executed');
            if (alreadyAppliedStatus && alreadyInLayer) {
                return true;
            }
            const step2Time = performance.now();
            const canonicalGeometry = this._getCanonicalStructureGeometry(proposalData, kind);
            let geometry = sp.geometry;
            if (!geometry || !geometry.type || !Array.isArray(geometry.coordinates)) {
                geometry = canonicalGeometry;
            }
            if (!geometry || !geometry.type || !Array.isArray(geometry.coordinates)) {
                if (typeof updateStatus === 'function') updateStatus('Cannot apply structure proposal: missing geometry.');
                console.warn('[_applyStructureProposal] Missing geometry for structure proposal; refusing to apply', {
                    proposalId: idLabel,
                    kind,
                    hasStructureGeometry: !!sp.geometry,
                    hasCanonicalGeometry: !!canonicalGeometry
                });
                try { this._setLastApplyFailure(idLabel, 'Cannot apply structure proposal: missing geometry.'); } catch (_) { }
                return false;
            }
            const blockName = sp.blockName || null;
            const parentIds = Array.from(new Set([
                ...(Array.isArray(sp.parentParcelIds) ? sp.parentParcelIds : []),
                ...(Array.isArray(proposalData.parentParcelIds) ? proposalData.parentParcelIds : [])
            ].map(x => x && x.toString ? x.toString() : (x !== undefined && x !== null ? String(x) : null)).filter(Boolean)));

            // Persist canonical geometry/parents onto the structureProposal for downstream consumers
            if (geometry) {
                try { sp.geometry = JSON.parse(JSON.stringify(geometry)); } catch (_) { sp.geometry = geometry; }
            }
            sp.parentParcelIds = parentIds;

            if (!geometry || !geometry.type || !Array.isArray(geometry.coordinates)) {
                // Fallback: attempt to resolve parent parcel features directly and rebuild geometry
                let resolvedGeometry = null;
                try {
                    const parentFeatures = this._resolveParcelFeaturesByIds(parentIds, { preferMap: true, allowStorage: true, fallbackToMap: true, allowMissing: true });
                    if (Array.isArray(parentFeatures) && parentFeatures.length > 0) {
                        const pseudoLayers = parentFeatures.map(feature => ({ feature }));
                        resolvedGeometry = buildGeometryFromParcels(pseudoLayers);
                    }
                } catch (fallbackErr) {
                    console.warn('[_applyStructureProposal] Fallback geometry rebuild failed', fallbackErr);
                }

                if (resolvedGeometry && resolvedGeometry.type && Array.isArray(resolvedGeometry.coordinates)) {
                    geometry = resolvedGeometry;
                } else {
                    if (typeof updateStatus === 'function') updateStatus('Cannot apply structure proposal: missing geometry.');
                    try {
                        const cityId = typeof window !== 'undefined' && window.cityConfigManager && typeof window.cityConfigManager.getCurrentCityId === 'function'
                            ? window.cityConfigManager.getCurrentCityId()
                            : null;
                        console.warn('[_applyStructureProposal] Missing geometry after rebuild', {
                            cityId,
                            parentIdsCount: parentIds.length,
                            kind,
                            hasStoredGeometry: !!sp.geometry,
                            parentIdsSample: parentIds.slice(0, 5)
                        });
                    } catch (_) { /* ignore logging errors */ }
                    return false;
                }
            }
            console.debug(`[_applyStructureProposal] Step 2: Prepared geometry and parent IDs (${(performance.now() - step2Time).toFixed(2)}ms) - ${parentIds.length} parents`);

            const step3Time = performance.now();
            // Enforce only one structure per block: unapply other applied structure proposals on same block
            if (blockName) {
                try {
                    const all = proposalStorage.getAllProposals();
                    all.filter(p => p.proposalId !== proposalId && p.structureProposal && p.structureProposal.blockName === blockName)
                        .forEach(p => {
                            const st = p.structureProposal.status || (p.status === 'Applied' ? 'applied' : 'unapplied');
                            if (st === 'applied' || p.status === 'Applied') {
                                const hasFamilyUnapply = typeof this.unapplyWholeFamily === 'function';
                                if (hasFamilyUnapply) {
                                    this.unapplyWholeFamily(p.proposalId);
                                } else if (typeof this.unapplyProposal === 'function') {
                                    this.unapplyProposal(p.proposalId, { skipConfirm: true });
                                }
                            }
                        });
                } catch (e) { }
            }
            console.debug(`[_applyStructureProposal] Step 3: Unapplied conflicting structures (${(performance.now() - step3Time).toFixed(2)}ms)`);

            // Cross-type conflict / availability check. A structure OVERLAYS its parents (never hides
            // them), so "apply anyway" just renders it. Same-block structures were already
            // auto-unapplied above; this catches parcels occupied by OTHER proposal types
            // (road/building/reparcellization) and offers unapply-or-apply-anyway.
            {
                const parentFeatures = this._resolveParcelFeaturesByIds(parentIds, { preferMap: true, allowStorage: true, fallbackToMap: true, allowMissing: true });
                const decision = await this._resolveParentAvailabilityOrDefer({ idLabel, proposalData, declaredParentIds: parentIds, parentFeatures, options });
                if (decision.defer) {
                    return false;
                }
            }

            const step4Time = performance.now();
            // Add to appropriate collection and layer
            // Ensure canonical geometry container is populated for downstream consumers
            if (!proposalData.geometry || typeof proposalData.geometry !== 'object') {
                proposalData.geometry = {
                    superParcel: null,
                    lakeGraphics: kind === 'lake' ? (sp.lakeGraphics || null) : null,
                    parkGraphics: kind === 'park' ? geometry : null,
                    squareGraphics: kind === 'square' ? geometry : null,
                    roadGeometry: null,
                    roadPlan: null,
                    buildings: null,
                    reparcellizationPolygons: null
                };
            } else {
                if (kind === 'lake' && sp.lakeGraphics && !proposalData.geometry.lakeGraphics) {
                    proposalData.geometry.lakeGraphics = sp.lakeGraphics;
                }
                if (kind === 'park' && !proposalData.geometry.parkGraphics) {
                    proposalData.geometry.parkGraphics = geometry;
                }
                if (kind === 'square' && !proposalData.geometry.squareGraphics) {
                    proposalData.geometry.squareGraphics = geometry;
                }
            }

            const feature = { type: 'Feature', properties: { structureType: kind, blockName: blockName, proposalId, lakeGraphics: sp.lakeGraphics || null }, geometry: JSON.parse(JSON.stringify(geometry)) };
            if (kind === 'park') {
                if (!Array.isArray(window.parks)) window.parks = [];
                // Only remove if it's the same proposal (to avoid duplicates when re-applying)
                window.parks = window.parks.filter(f => {
                    if (!f || !f.properties) return true;
                    return f.properties.proposalId !== proposalId;
                });
                try { if (typeof ensureParkDecorations === 'function') ensureParkDecorations(feature); } catch (_) { }
                window.parks.push(feature);
                try { if (typeof updateParksLayer === 'function') updateParksLayer(); } catch (_) { }
                try { PersistentStorage.setItem('cb_parks', JSON.stringify(window.parks)); } catch (_) { }
            } else if (kind === 'lake') {
                if (!Array.isArray(window.lakes)) window.lakes = [];
                // Only remove if it's the same proposal (to avoid duplicates when re-applying)
                window.lakes = window.lakes.filter(f => {
                    if (!f || !f.properties) return true;
                    return f.properties.proposalId !== proposalId;
                });
                try { if (typeof ensureLakeGraphics === 'function') ensureLakeGraphics(feature); } catch (_) { }
                window.lakes.push(feature);
                try { if (typeof updateLakesLayer === 'function') updateLakesLayer(); } catch (_) { }
                try { PersistentStorage.setItem('cb_lakes', JSON.stringify(window.lakes)); } catch (_) { }
            } else {
                if (!Array.isArray(window.squares)) window.squares = [];
                // Only remove if it's the same proposal (to avoid duplicates when re-applying)
                window.squares = window.squares.filter(f => {
                    if (!f || !f.properties) return true;
                    return f.properties.proposalId !== proposalId;
                });
                try { if (typeof ensureSquareDecorations === 'function') ensureSquareDecorations(feature); } catch (_) { }
                window.squares.push(feature);
                try { if (typeof updateSquaresLayer === 'function') updateSquaresLayer(); } catch (_) { }
                try { PersistentStorage.setItem('cb_squares', JSON.stringify(window.squares)); } catch (_) { }
            }
            console.debug(`[_applyStructureProposal] Step 4: Added ${kind} to map and storage (${(performance.now() - step4Time).toFixed(2)}ms)`);

            const step5Time = performance.now();
            // Link to ancestors without hiding parent parcels; keep parcels clickable beneath the square overlay
            const uniqueParentIds = Array.from(new Set((parentIds || []).filter(Boolean)));

            this._setDescendantProposalOnParcels(uniqueParentIds, proposalId);
            this._linkProposalToAncestors(proposalId, uniqueParentIds);
            uniqueParentIds.forEach(id => this._unmarkParcelModified(id));
            console.debug(`[_applyStructureProposal] Step 5: Linked ${uniqueParentIds.length} ancestors without removing parcels (${(performance.now() - step5Time).toFixed(2)}ms)`);

            const step6Time = performance.now();
            // Update status
            const wasExecuted = structureStatus === 'executed' || proposalStatus === 'executed';
            sp.status = wasExecuted ? 'executed' : 'applied';
            proposalData.structureProposal = sp;
            if (wasExecuted) {
                proposalData.status = 'Executed';
            } else if (typeof isAppliedStatus === 'function') {
                if (!isAppliedStatus(proposalData.status)) proposalData.status = 'Applied';
            } else if (proposalData.status !== 'Applied') {
                proposalData.status = 'Applied';
            }
            proposalData.proposalId = proposalData.proposalId || proposalId;
            if (typeof proposalStorage._indexProposal === 'function') {
                proposalStorage._indexProposal(proposalData);
            } else {
                proposalStorage.proposals.set(proposalData.proposalId, proposalData);
            }
            if (proposalStorage.save) proposalStorage.save();
            console.debug(`[_applyStructureProposal] Step 6: Updated and saved proposal status (${(performance.now() - step6Time).toFixed(2)}ms)`);

            const step7Time = performance.now();
            try { if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton(); } catch (_) { }
            try { if (typeof updateProposalList === 'function') updateProposalList(); } catch (_) { }
            try { if (typeof updateStatus === 'function') updateStatus(`Applied ${kind} proposal ${proposalData.title || idLabel}`); } catch (_) { }
            if (typeof refreshParcelStylesForAppliedProposals === 'function') {
                refreshParcelStylesForAppliedProposals();
            }
            console.debug(`[_applyStructureProposal] Step 7: Updated UI (${(performance.now() - step7Time).toFixed(2)}ms)`);

            const totalTime = performance.now() - startTime;
            console.debug(`[_applyStructureProposal] ✓ Structure proposal application completed in ${totalTime.toFixed(2)}ms`);
            return true;
        } catch (e) {
            console.warn('Failed to apply structure proposal', e);
            return false;
        }
    },

    async _applyDecideLaterProposal(proposalId, proposalData) {
        const startTime = performance.now();
        const idLabel = _normalizeProposalId(proposalId) || 'unknown-proposal';
        console.debug(`[_applyDecideLaterProposal] Starting application for ${idLabel}...`);

        const decideLaterState = proposalData.decideLaterProposal || {};
        const parentIds = Array.from(new Set([
            ...(Array.isArray(decideLaterState.parentParcelIds) ? decideLaterState.parentParcelIds : []),
            ...(Array.isArray(proposalData.parentParcelIds) ? proposalData.parentParcelIds : [])
        ].map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));

        let childIdsExisting = Array.from(new Set([
            ...(Array.isArray(decideLaterState.childParcelIds) ? decideLaterState.childParcelIds : []),
            ...(Array.isArray(proposalData.childParcelIds) ? proposalData.childParcelIds : [])
        ].map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));

        // Always try to recover child parcels from PersistentStorage, even if we have some IDs
        // This ensures we find child parcels even if the proposal data is missing childParcelIds
        if (typeof PersistentStorage !== 'undefined' && typeof PersistentStorage.key === 'function' && typeof PersistentStorage.length === 'number') {
            const recovered = [];
            const proposalIdStr = String(proposalId);
            // Also try normalized versions for matching
            const normalizedProposalId = _normalizeProposalId(proposalId) || proposalIdStr;
            const syntheticToken = _buildSyntheticToken(proposalId, 'proposal');
            const escapedToken = _escapeRegExp(syntheticToken);
            const tokenSuffixRegex = new RegExp(`#${escapedToken}-(\\d+)$`);
            const legacyTokenSuffixRegex = new RegExp(`${escapedToken}(?:/(\\d+)|_(\\d+))$`);
            console.debug(`[_applyDecideLaterProposal] Scanning PersistentStorage for child parcels with ancestorProposal=${proposalIdStr} (normalized=${normalizedProposalId})...`);

            // Debug: Log all parcels with ancestorProposal to see what we have
            const allParcelsWithAncestor = [];
            for (let i = 0; i < PersistentStorage.length; i++) {
                const key = PersistentStorage.key(i);
                if (!key || !key.startsWith('parcel_')) continue;
                if (key.includes('_owner') || key.includes('_road')) continue;
                try {
                    const raw = PersistentStorage.getItem(key);
                    const parsed = raw ? JSON.parse(raw) : null;
                    if (parsed && parsed.properties && parsed.properties.ancestorProposal) {
                        allParcelsWithAncestor.push({
                            key,
                            id: parsed.id || key.slice('parcel_'.length),
                            ancestorProposal: parsed.properties.ancestorProposal,
                            mergedFromDecideLater: parsed.properties.mergedFromDecideLater
                        });
                    }
                } catch (_) { }
            }
            if (allParcelsWithAncestor.length > 0) {
                console.debug(`[_applyDecideLaterProposal] Found ${allParcelsWithAncestor.length} parcels with ancestorProposal in storage:`, allParcelsWithAncestor);
            } else {
                console.debug(`[_applyDecideLaterProposal] No parcels with ancestorProposal found in storage`);
            }

            for (let i = 0; i < PersistentStorage.length; i++) {
                const key = PersistentStorage.key(i);
                if (!key || !key.startsWith('parcel_')) continue;
                if (key.includes('_owner') || key.includes('_road')) continue;

                let parsed = null;
                try {
                    const raw = PersistentStorage.getItem(key);
                    parsed = raw ? JSON.parse(raw) : null;
                } catch (_) { /* ignore parse errors */ }

                if (!parsed || !parsed.properties) continue;

                // Check if this parcel was created by this proposal
                // Try multiple matching strategies in case of ID format differences
                const ancestorProposal = String(parsed.properties.ancestorProposal || '');
                const normalizedAncestor = _normalizeProposalId(ancestorProposal) || ancestorProposal;

                const candidateId = String(parsed.id || key.slice('parcel_'.length) || '');
                const candidateProposalId = String(parsed.properties.proposalId || parsed.properties.proposal_id || '');

                // Synthetic-id match: child parcels use `${rootId}#${token}-${index}` (or legacy token forms)
                // This is a strict id-based signal and avoids any similarity heuristics.
                const matchesToken = !!candidateId && (
                    tokenSuffixRegex.test(candidateId)
                    || legacyTokenSuffixRegex.test(candidateId)
                );

                // Match if exact match or normalized match
                const matchesProposal = ancestorProposal === proposalIdStr
                    || ancestorProposal === normalizedProposalId
                    || normalizedAncestor === proposalIdStr
                    || normalizedAncestor === normalizedProposalId
                    || (candidateProposalId && (candidateProposalId === proposalIdStr || candidateProposalId === normalizedProposalId))
                    || matchesToken;

                if (!matchesProposal) continue;

                // Also check mergedFromDecideLater flag as additional confirmation
                const isDecideLaterChild = parsed.properties.mergedFromDecideLater === true;

                if (candidateId) {
                    recovered.push(String(candidateId));
                    console.debug(`[_applyDecideLaterProposal] Found child parcel ${candidateId} in storage (ancestorProposal=${ancestorProposal}, normalized=${normalizedAncestor}, mergedFromDecideLater=${isDecideLaterChild})`);
                }
            }

            if (recovered.length) {
                const uniqueRecovered = Array.from(new Set(recovered.map(String).filter(Boolean)));
                const replacedCount = childIdsExisting.length;
                // Prefer recovered ids over stale `childParcelIds` in the proposal record.
                // Stale ids commonly happen when synthetic id formats change (legacy /token/idx vs new #token-idx).
                childIdsExisting = uniqueRecovered;
                console.debug(`[_applyDecideLaterProposal] Using ${childIdsExisting.length} recovered child parcel id(s) from storage for ${idLabel} (replaced ${replacedCount} stored id(s))`);
            } else {
                console.debug(`[_applyDecideLaterProposal] No child parcels found in PersistentStorage for ${idLabel} (searched for proposalId=${proposalIdStr}, normalized=${normalizedProposalId})`);
            }
        }

        const proposalStatus = (proposalData.status || '').toLowerCase();
        const alreadyApplied = proposalStatus === 'applied' || proposalStatus === 'executed'
            || (decideLaterState.status || '').toLowerCase() === 'applied'
            || (decideLaterState.status || '').toLowerCase() === 'executed';

        const restoreFromExistingChildren = () => {
            if (!childIdsExisting.length) return null;
            // For decide later proposals, child parcels might only exist in PersistentStorage
            // Try to load them from storage if not found in map/cache
            const childFeatures = this._resolveParcelFeaturesByIds(childIdsExisting, {
                preferMap: true,
                allowStorage: true,
                allowMissing: true,  // Allow missing so we can fallback to direct storage load
                fallbackToMap: false
            }) || [];

            // If still not found, try loading directly from PersistentStorage
            // This is critical for decide later proposals where child parcels might only exist in storage
            if (childFeatures.length === 0 && typeof readPersistedParcelRecord === 'function') {
                console.debug(`[_applyDecideLaterProposal] Child parcels not found via _resolveParcelFeaturesByIds, trying direct PersistentStorage load for ${childIdsExisting.length} parcels`);
                for (const childId of childIdsExisting) {
                    try {
                        const record = readPersistedParcelRecord(childId);
                        if (record && record.properties) {
                            let geometry = null;

                            // Handle different geometry storage formats
                            if (record.geometry) {
                                if (record.geometry.type && record.geometry.coordinates) {
                                    // Already in GeoJSON format
                                    geometry = JSON.parse(JSON.stringify(record.geometry));
                                } else if (Array.isArray(record.geometry)) {
                                    // Stored as coordinates array directly - wrap in Polygon
                                    geometry = {
                                        type: 'Polygon',
                                        coordinates: [record.geometry]
                                    };
                                }
                            }

                            if (geometry && geometry.type && geometry.coordinates) {
                                const feature = {
                                    type: 'Feature',
                                    properties: { ...record.properties },
                                    geometry: geometry
                                };
                                // Ensure parcelId is set
                                if (!feature.properties.parcelId && childId) {
                                    feature.properties.parcelId = String(childId);
                                }
                                // Ensure ancestorProposal is set (critical for isParcelReplacedByChildren to work correctly)
                                if (!feature.properties.ancestorProposal) {
                                    feature.properties.ancestorProposal = proposalId;
                                }
                                childFeatures.push(feature);
                                console.debug(`[_applyDecideLaterProposal] Loaded child parcel ${childId} from PersistentStorage`, {
                                    hasGeometry: !!geometry,
                                    geometryType: geometry?.type,
                                    hasAncestorProposal: !!feature.properties.ancestorProposal
                                });
                            } else {
                                console.warn(`[_applyDecideLaterProposal] Child parcel ${childId} found in storage but missing valid geometry`, {
                                    hasRecord: !!record,
                                    hasGeometry: !!record?.geometry,
                                    geometryType: record?.geometry?.type,
                                    hasCoordinates: !!record?.geometry?.coordinates
                                });
                            }
                        }
                    } catch (err) {
                        console.warn(`[_applyDecideLaterProposal] Failed to load child parcel ${childId} from PersistentStorage:`, err);
                    }
                }
            }

            if (!childFeatures.length) {
                console.warn(`[_applyDecideLaterProposal] restoreFromExistingChildren: No child features found for ${idLabel}`, {
                    childIdsExisting,
                    childIdsExistingLength: childIdsExisting.length
                });
                return null;
            }
            console.debug(`[_applyDecideLaterProposal] restoreFromExistingChildren: Found ${childFeatures.length} child features for ${idLabel}`);

            // Only add layers that are not already on the map to avoid duplicates on repeated restores
            const missingFeatures = childFeatures.filter(feature => {
                const id = _getParcelIdFromFeature(feature);
                if (!id) {
                    console.warn(`[_applyDecideLaterProposal] Child feature missing parcelId:`, feature);
                    return false;
                }
                const alreadyOnMap = this._getParcelLayerById(id);
                if (alreadyOnMap) {
                    console.debug(`[_applyDecideLaterProposal] Child parcel ${id} already on map, skipping`);
                    return false;
                }
                return true;
            });
            if (missingFeatures.length) {
                console.debug(`[_applyDecideLaterProposal] Adding ${missingFeatures.length} child parcels to map for ${idLabel}`, {
                    featureIds: missingFeatures.map(f => _getParcelIdFromFeature(f)),
                    features: missingFeatures.map(f => ({
                        id: _getParcelIdFromFeature(f),
                        hasGeometry: !!f.geometry,
                        hasAncestorProposal: !!f.properties?.ancestorProposal,
                        ancestorProposal: f.properties?.ancestorProposal
                    }))
                });

                // Ensure all features have ancestorProposal set before adding
                missingFeatures.forEach(feature => {
                    if (!feature.properties) feature.properties = {};
                    if (!feature.properties.ancestorProposal) {
                        feature.properties.ancestorProposal = proposalId;
                        console.debug(`[_applyDecideLaterProposal] Set ancestorProposal=${proposalId} on feature ${_getParcelIdFromFeature(feature)}`);
                    }
                    if (!feature.properties.mergedFromDecideLater) {
                        feature.properties.mergedFromDecideLater = true;
                    }
                });

                this._addFeaturesToMap(missingFeatures, true, proposalData);

                // Verify they were added - wait a bit for async operations
                setTimeout(() => {
                    const addedIds = missingFeatures.map(f => _getParcelIdFromFeature(f)).filter(Boolean);
                    const verifiedOnMap = addedIds.filter(id => this._getParcelLayerById(id));
                    if (verifiedOnMap.length !== addedIds.length) {
                        console.warn(`[_applyDecideLaterProposal] Only ${verifiedOnMap.length} of ${addedIds.length} child parcels verified on map after add`, {
                            missing: addedIds.filter(id => !verifiedOnMap.includes(id))
                        });
                    } else {
                        console.debug(`[_applyDecideLaterProposal] Successfully added ${verifiedOnMap.length} child parcels to map`);
                    }
                }, 100);
            } else if (childFeatures.length > 0) {
                console.debug(`[_applyDecideLaterProposal] All ${childFeatures.length} child parcels already on map`);
            }

            // Ensure child parcels are NOT flagged as removed and have their linkage set correctly
            childFeatures.forEach(feature => {
                const parcelId = _getParcelIdFromFeature(feature);
                _ensureParcelIdOnProperties(feature.properties, parcelId);
                feature.properties.ancestorProposal = proposalId;
                feature.properties.mergedFromDecideLater = true;
                this._persistParcelFeature(feature);
                this._addProposalAsAncestor(parcelId, proposalId);
                // No longer need to clear removedByProposal - visibility is calculated from parent/child relationships
            });
            this._addChildParcels(proposalId, childFeatures.map(f => _getParcelIdFromFeature(f)).filter(Boolean), proposalData);
            return childFeatures.map(f => _getParcelIdFromFeature(f)).filter(Boolean);
        };

        // Fast path: restoring an already applied proposal with stored children
        if (alreadyApplied) {
            const alreadyRestored = decideLaterState._restored === true;
            const childIdsOnMap = childIdsExisting.filter(id => this._getParcelLayerById(id));

            console.debug(`[_applyDecideLaterProposal] Restoring ${idLabel}:`, {
                childIdsExisting: childIdsExisting.length,
                childIdsOnMap: childIdsOnMap.length,
                alreadyRestored
            });

            // If everything is already in place, skip noisy work
            if (childIdsExisting.length && childIdsOnMap.length === childIdsExisting.length && alreadyRestored) {
                console.debug(`[_applyDecideLaterProposal] All ${childIdsOnMap.length} child parcels already on map and restored for ${idLabel}`);
                return true;
            }

            if (childIdsExisting.length && childIdsOnMap.length === childIdsExisting.length) {
                // Children already present; just ensure linkage/flags and exit
                // Parent parcels will be filtered out by isParcelReplacedByChildren in ingest.js
                this._setDescendantProposalOnParcels(parentIds, proposalId);
                this._linkProposalToAncestors(proposalId, parentIds);
                this._markParcelsModifiedBatch([...parentIds, ...childIdsOnMap]);
                proposalData.decideLaterProposal = {
                    status: decideLaterState.status || 'applied',
                    parentParcelIds: parentIds,
                    childParcelIds: childIdsExisting.map(String),
                    _restored: true
                };
                proposalData.childParcelIds = Array.from(new Set([...(proposalData.childParcelIds || []).map(id => id && id.toString ? id.toString() : String(id)), ...childIdsExisting.map(String)]));
                if (!proposalData.status || proposalStatus === 'active') {
                    proposalData.status = 'Applied';
                }
                if (typeof proposalStorage._indexProposal === 'function') proposalStorage._indexProposal(proposalData);
                if (proposalStorage.save) proposalStorage.save();
                console.debug(`[_applyDecideLaterProposal] Restored ${childIdsOnMap.length} child parcels already on map for ${idLabel}`);
                return true;
            }

            // Try to restore child parcels from storage
            console.debug(`[_applyDecideLaterProposal] Attempting to restore ${childIdsExisting.length} child parcels from storage for ${idLabel}`, {
                childIdsExisting,
                proposalId,
                proposalIdStr: String(proposalId)
            });
            const restoredChildIds = restoreFromExistingChildren();
            if (restoredChildIds && restoredChildIds.length) {
                console.debug(`[_applyDecideLaterProposal] Successfully restored ${restoredChildIds.length} child parcels for ${idLabel}:`, restoredChildIds);
                // Parent parcels will be filtered out by isParcelReplacedByChildren in ingest.js
                this._setDescendantProposalOnParcels(parentIds, proposalId);
                this._linkProposalToAncestors(proposalId, parentIds);
                this._markParcelsModifiedBatch([...parentIds, ...restoredChildIds]);
                proposalData.decideLaterProposal = {
                    status: decideLaterState.status || 'applied',
                    parentParcelIds: parentIds,
                    childParcelIds: restoredChildIds.map(String),
                    _restored: true
                };
                proposalData.childParcelIds = Array.from(new Set([...(proposalData.childParcelIds || []).map(id => id && id.toString ? id.toString() : String(id)), ...restoredChildIds.map(String)]));
                if (!proposalData.status || proposalStatus === 'active') {
                    proposalData.status = 'Applied';
                }
                if (typeof proposalStorage._indexProposal === 'function') proposalStorage._indexProposal(proposalData);
                if (proposalStorage.save) proposalStorage.save();
                console.debug(`[_applyDecideLaterProposal] Restored ${restoredChildIds.length} child parcels for ${idLabel}`);
                return true;
            } else {
                console.warn(`[_applyDecideLaterProposal] Failed to restore child parcels for ${idLabel} - restoreFromExistingChildren returned null or empty`, {
                    childIdsExisting,
                    childIdsExistingLength: childIdsExisting.length
                });
                // Don't return false here - the proposal might still be considered applied even if child parcels aren't found
                // This can happen if the child parcel was never created or was deleted
            }
        }

        if (!parentIds.length) {
            if (typeof updateStatus === 'function') {
                updateStatus('Cannot apply decide later proposal: no ancestor parcels found.');
            }
            return false;
        }

        let parentFeatures = this._resolveParcelFeaturesByIds(parentIds, { preferMap: true, allowStorage: true, allowMissing: true });
        let missingParents = this._getMissingParentParcels(parentFeatures);
        const missingIds = missingParents.map(info => info && info.id ? info.id.toString() : '').filter(Boolean);

        if (missingIds.length && typeof fetchParcelsForIds === 'function') {
            try {
                await fetchParcelsForIds(missingIds, { forceRefresh: true });
                parentFeatures = this._resolveParcelFeaturesByIds(parentIds, { preferMap: true, allowStorage: true, allowMissing: true });
                missingParents = this._getMissingParentParcels(parentFeatures);
            } catch (err) {
                console.warn('[_applyDecideLaterProposal] Failed to fetch missing ancestor parcels', { missingIds, err });
            }
        }

        if (missingParents.length > 0) {
            const summary = missingParents.map(info => info && info.number ? `${info.number} [${info.id}]` : info && info.id ? info.id : '').filter(Boolean).join(', ');
            const message = summary
                ? `Cannot apply decide later proposal: missing parcels ${summary}`
                : 'Cannot apply decide later proposal: missing ancestor parcels.';
            if (typeof updateStatus === 'function') updateStatus(message);
            if (typeof showEphemeralMessage === 'function') showEphemeralMessage(message, 5000, 'error');
            return false;
        }

        const mergedGeometry = _mergeParcelGeometries(parentFeatures);
        if (!mergedGeometry) {
            const message = 'Cannot apply decide later proposal: failed to merge parcel geometry.';
            if (typeof updateStatus === 'function') updateStatus(message);
            if (typeof showEphemeralMessage === 'function') showEphemeralMessage(message, 5000, 'error');
            return false;
        }

        const primaryFeature = parentFeatures.find(f => _getParcelIdFromFeature(f));
        const primaryId = primaryFeature ? _getParcelIdFromFeature(primaryFeature) : parentIds[0];
        const primaryNumber = primaryFeature?.properties?.BROJ_CESTICE
            || primaryFeature?.properties?.parcelNumber
            || primaryFeature?.properties?.parcel_number
            || null;
        const parentNumbers = parentFeatures
            .map(f => f?.properties?.BROJ_CESTICE || f?.properties?.parcelNumber || f?.properties?.parcel_number)
            .filter(Boolean);
        const rootParcelId = _resolveRootParcelIdFromProperties(primaryFeature?.properties || null, primaryId) || null;
        const rootParcelNumber = _resolveRootParcelNumberFromProperties(primaryFeature?.properties || null, primaryId)
            || (primaryNumber ? _extractRootParcelNumber(primaryNumber) : null)
            || primaryNumber
            || 'parcel';

        const childFeature = {
            type: 'Feature',
            geometry: mergedGeometry,
            properties: {
                proposalId,
                ancestorProposal: proposalId,
                parentParcelIds: parentIds,
                parentParcelNumbers: parentNumbers,
                parentParcelId: primaryId || null,
                parentParcelNumber: primaryNumber || null,
                rootParcelId,
                rootParcelNumber,
                calculatedArea: Math.round(_calculateGeoJsonArea(mergedGeometry)),
                isProposed: true,
                mergedFromDecideLater: true
            }
        };

        this._assignSyntheticChildIdentities(proposalId, [childFeature]);

        _assignOwnershipDetails(childFeature, {
            defaultOwnerName: proposalData?.author || 'User',
            forceDefaultOwner: true,
            overwriteExisting: true
        });
        const childParcelId = _getParcelIdFromFeature(childFeature);
        if (!childParcelId) {
            const message = 'Cannot apply decide later proposal: failed to assign parcel id to merged parcel.';
            if (typeof updateStatus === 'function') updateStatus(message);
            if (typeof showEphemeralMessage === 'function') showEphemeralMessage(message, 5000, 'error');
            return false;
        }

        // Authoritative ownership of the merged parcel: transfer to the chosen recipient
        // (to-me / to-city / third-party) when the proposal carries one; otherwise it stays
        // with the author label assigned above.
        if (typeof resolveProposalRecipientAgentId === 'function' && typeof transferParcelOwnership === 'function') {
            const recipientAgentId = resolveProposalRecipientAgentId(proposalData);
            if (recipientAgentId) transferParcelOwnership(childParcelId, null, recipientAgentId);
        }

        // Parent parcels will be filtered out by isParcelReplacedByChildren in ingest.js

        if (typeof window !== 'undefined') {
            if (window.multiParcelSelection && window.multiParcelSelection.selectedParcels) {
                parentIds.forEach(parcelId => {
                    if (window.multiParcelSelection.selectedParcels.has(parcelId)) {
                        try {
                            const layer = window.multiParcelSelection.findParcelById ? window.multiParcelSelection.findParcelById(parcelId) : null;
                            if (layer && typeof window.multiParcelSelection.removeParcelHighlight === 'function') {
                                window.multiParcelSelection.removeParcelHighlight(layer);
                            }
                        } catch (_) { /* best-effort */ }
                        window.multiParcelSelection.selectedParcels.delete(parcelId);
                    }
                });
                if (typeof window.multiParcelSelection.updateUI === 'function') {
                    window.multiParcelSelection.updateUI();
                }
            }

            if (typeof window.selectedParcelId !== 'undefined' && window.selectedParcelId && parentIds.includes(window.selectedParcelId.toString())) {
                window.selectedParcelId = null;
            }
        }

        const filteredChildFeatures = _filterChildFeaturesBlockedByDescendants([childFeature], proposalId);
        const shouldAddChild = filteredChildFeatures.length > 0;
        if (shouldAddChild) {
            const filteredChild = filteredChildFeatures[0];
            // Ensure ancestorProposal is set before persisting (critical for recovery on reload)
            if (!filteredChild.properties.ancestorProposal) {
                filteredChild.properties.ancestorProposal = proposalId;
            }
            // Ensure mergedFromDecideLater flag is set
            filteredChild.properties.mergedFromDecideLater = true;

            // CRITICAL: Ensure ancestorProposal is set before persisting and adding to map
            if (!filteredChild.properties.ancestorProposal) {
                filteredChild.properties.ancestorProposal = proposalId;
                console.debug(`[_applyDecideLaterProposal] Set ancestorProposal=${proposalId} on child parcel ${childParcelId} before persisting`);
            }
            if (!filteredChild.properties.mergedFromDecideLater) {
                filteredChild.properties.mergedFromDecideLater = true;
            }

            console.debug(`[_applyDecideLaterProposal] Persisting child parcel ${childParcelId} with ancestorProposal=${filteredChild.properties.ancestorProposal}`);
            this._persistParcelFeature(filteredChild);

            // Verify it was persisted correctly
            if (typeof readPersistedParcelRecord === 'function') {
                const persisted = readPersistedParcelRecord(childParcelId);
                if (persisted && persisted.properties) {
                    console.debug(`[_applyDecideLaterProposal] Verified child parcel ${childParcelId} persisted with ancestorProposal=${persisted.properties.ancestorProposal}`);
                } else {
                    console.warn(`[_applyDecideLaterProposal] Failed to verify child parcel ${childParcelId} was persisted`);
                }
            }

            this._addFeaturesToMap([filteredChild], true, proposalData);

            this._addProposalAsAncestor(childParcelId, proposalId);
            this._addChildParcels(proposalId, [childParcelId], proposalData);
        } else {
            console.debug(`[_applyDecideLaterProposal] Skipping child parcel ${childParcelId} because a descendant proposal is already applied`);
        }

        this._setDescendantProposalOnParcels(parentIds, proposalId);
        this._linkProposalToAncestors(proposalId, parentIds);
        this._markParcelsModifiedBatch([...parentIds, ...(shouldAddChild ? [childParcelId] : [])]);

        // Hide parents from visible layer but keep in parcelLayerById for descendant proposals
        this._hideFeaturesFromMap(parentFeatures);

        proposalData.decideLaterProposal = {
            status: 'applied',
            parentParcelIds: parentIds,
            childParcelIds: shouldAddChild ? [String(childParcelId)] : [],
            _restored: true
        };
        proposalData.parentParcelIds = parentIds;
        proposalData.childParcelIds = Array.from(new Set([...(proposalData.childParcelIds || []).map(id => id && id.toString ? id.toString() : String(id)), ...(shouldAddChild ? [String(childParcelId)] : [])]));
        proposalData.status = 'Applied';
        proposalData.updatedAt = new Date().toISOString();

        if (typeof proposalStorage._indexProposal === 'function') {
            proposalStorage._indexProposal(proposalData);
        } else {
            proposalStorage.proposals.set(proposalData.proposalId, proposalData);
        }
        if (proposalStorage.save) proposalStorage.save();

        try { if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton(); } catch (_) { }
        try { if (typeof updateProposalList === 'function') updateProposalList(); } catch (_) { }
        if (typeof refreshParcelStylesForAppliedProposals === 'function') {
            refreshParcelStylesForAppliedProposals();
        }
        if (typeof updateStatus === 'function') {
            updateStatus(`Applied decide later proposal ${proposalData.title || idLabel}`);
        }

        console.debug(`[_applyDecideLaterProposal] ✓ Completed application in ${(performance.now() - startTime).toFixed(2)}ms`);
        return true;
    },

    async _applyReparcellizationProposal(proposalId, proposalData, options = {}) {
        const startTime = performance.now();
        const idLabel = _normalizeProposalId(proposalId) || 'unknown-proposal';
        console.debug(`[_applyReparcellizationProposal] Starting application for ${idLabel}...`);

        if (!proposalData || !proposalData.reparcellization) {
            console.warn(`[_applyReparcellizationProposal] Invalid proposal data or missing reparcellization`);
            return false;
        }
        const plan = proposalData.reparcellization;
        if (!Array.isArray(plan.polygons) || plan.polygons.length === 0) {
            if (typeof updateStatus === 'function') {
                updateStatus('Cannot apply reparcellization proposal: missing generated slices.');
            }
            console.warn(`[_applyReparcellizationProposal] Missing polygons: ${plan.polygons?.length || 0}`);
            return false;
        }

        // Skip overlay rendering: add child parcels directly with existing parcel styling
        console.debug(`[_applyReparcellizationProposal] Skipping overlay rendering for ${plan.polygons.length} slice(s); will add child parcels directly.`);

        const parentIds = Array.from(new Set((proposalData.parentParcelIds || []).map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));
        let parentFeatures = parentIds.length
            ? this._resolveParcelFeaturesByIds(parentIds, { preferMap: true, allowStorage: true, allowMissing: true })
            : [];

        // Parent availability + conflict decision (this only runs on a fresh apply — already-applied
        // reparcellizations short-circuit in the dispatcher). Like road, this replaces parents with
        // child slices, so a parent occupied by another applied proposal is a real conflict.
        {
            const decision = await this._resolveParentAvailabilityOrDefer({ idLabel, proposalData, declaredParentIds: parentIds, parentFeatures, options });
            if (decision.defer) {
                if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
                return false;
            }
            parentFeatures = decision.parentFeatures;
        }

        const primaryFeature = parentFeatures.find(f => _getParcelIdFromFeature(f));
        const primaryId = primaryFeature ? _getParcelIdFromFeature(primaryFeature) : (parentIds[0] || null);
        const primaryNumber = primaryFeature?.properties?.BROJ_CESTICE
            || primaryFeature?.properties?.parcelNumber
            || primaryFeature?.properties?.parcel_number
            || null;
        const parentNumbers = parentFeatures
            .map(f => f?.properties?.BROJ_CESTICE || f?.properties?.parcelNumber || f?.properties?.parcel_number)
            .filter(Boolean);
        const rootParcelId = _resolveRootParcelIdFromProperties(primaryFeature?.properties || null, primaryId) || null;
        const rootParcelNumber = _resolveRootParcelNumberFromProperties(primaryFeature?.properties || null, primaryId)
            || (primaryNumber ? _extractRootParcelNumber(primaryNumber) : null)
            || primaryNumber
            || 'parcel';

        const childFeatures = plan.polygons.map((slice, index) => {
            if (!slice || !slice.geometry) return null;
            const feature = {
                type: 'Feature',
                geometry: slice.geometry,
                properties: {
                    proposalId,
                    parentParcelIds: parentIds,
                    parentParcelNumbers: parentNumbers,
                    parentParcelId: primaryId || null,
                    parentParcelNumber: primaryNumber || null,
                    rootParcelId,
                    rootParcelNumber,
                    calculatedArea: Math.round(_calculateGeoJsonArea(slice.geometry)),
                    isProposed: true,
                    color: slice.color || null,
                    ownerKey: slice.ownerKey || null,
                    displayName: slice.displayName || null,
                    percent: slice.percent !== undefined ? slice.percent : null
                }
            };

            const pct = Number(slice.percent);
            if (Number.isFinite(pct)) {
                const isSingleOwnerPlan = proposalData?.reparcellization?.isSingleOwner === true;
                const percentValue = isSingleOwnerPlan ? 100 : (pct > 1 ? pct : pct * 100);
                feature.properties.ownershipDetails = {
                    owners: [{
                        name: slice.displayName || proposalData?.author || 'Owner',
                        ownerLabel: slice.displayName || proposalData?.author || 'Owner',
                        percentageShare: percentValue,
                        actualShareText: `${percentValue}%`
                    }]
                };
            }

            return feature;
        }).filter(Boolean);

        if (!childFeatures.length) {
            if (typeof updateStatus === 'function') {
                updateStatus('Cannot apply reparcellization proposal: failed to build parcel geometries.');
            }
            console.warn(`[_applyReparcellizationProposal] Failed to build child parcel features for ${idLabel}`);
            return false;
        }

        this._assignSyntheticChildIdentities(proposalId, childFeatures);
        this._addFeaturesToMap(childFeatures, true, proposalData);

        const childParcelIds = [];
        childFeatures.forEach(feature => {
            const parcelId = _getParcelIdFromFeature(feature);
            _ensureParcelIdOnProperties(feature.properties, parcelId);
            feature.properties.ancestorProposal = proposalId;
            delete feature.properties.descendantProposal;
            this._persistParcelFeature(feature);
            this._addProposalAsAncestor(parcelId, proposalId);
            if (parcelId !== undefined && parcelId !== null) {
                childParcelIds.push(String(parcelId));
                // Authoritative per-slice ownership from the readjustment plan: an ownerKey
                // that's a real agent id wins; otherwise find-or-create one for the slice label.
                if (typeof transferParcelOwnership === 'function') {
                    const ownerKey = feature.properties.ownerKey;
                    let agentId = null;
                    if (ownerKey && typeof agentStorage !== 'undefined' && agentStorage.getAgent(ownerKey)) {
                        agentId = ownerKey;
                    } else if (typeof getOrCreateAgentForRecipient === 'function' && feature.properties.displayName) {
                        agentId = getOrCreateAgentForRecipient(feature.properties.displayName);
                    }
                    if (agentId) transferParcelOwnership(String(parcelId), null, agentId);
                }
            }
        });

        this._setDescendantProposalOnParcels(parentIds, proposalId);
        this._linkProposalToAncestors(proposalId, parentIds);
        this._hideFeaturesFromMap(parentFeatures);
        if ((!parentFeatures || parentFeatures.length === 0) && Array.isArray(parentIds) && parentIds.length && typeof window.hideParcelLayerById === 'function') {
            parentIds.forEach(pid => window.hideParcelLayerById(pid));
        }
        this._markParcelsModifiedBatch([...parentIds, ...childParcelIds]);
        if (childParcelIds.length) {
            this._addChildParcels(proposalId, childParcelIds, proposalData);
        }

        const step2Time = performance.now();
        plan.status = 'applied';
        plan.appliedAt = new Date().toISOString();
        plan.parentParcelIds = parentIds;
        plan.childParcelIds = childParcelIds;
        proposalData.parentParcelIds = parentIds;
        proposalData.childParcelIds = childParcelIds;
        proposalData.reparcellization = plan;

        if (typeof isAppliedStatus === 'function') {
            if (!isAppliedStatus(proposalData.status)) {
                proposalData.status = 'Applied';
            }
        } else if (proposalData.status !== 'Applied') {
            proposalData.status = 'Applied';
        }
        proposalData.updatedAt = new Date().toISOString();

        proposalData.proposalId = proposalData.proposalId || proposalId;
        if (typeof proposalStorage._indexProposal === 'function') {
            proposalStorage._indexProposal(proposalData);
        } else {
            proposalStorage.proposals.set(proposalData.proposalId, proposalData);
        }
        if (typeof proposalStorage.save === 'function') {
            proposalStorage.save();
        }
        console.debug(`[_applyReparcellizationProposal] Updated and saved proposal status (${(performance.now() - step2Time).toFixed(2)}ms)`);

        const step3Time = performance.now();
        try { if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton(); } catch (_) { }
        try { if (typeof updateProposalList === 'function') updateProposalList(); } catch (_) { }
        if (typeof updateStatus === 'function') {
            updateStatus(`Applied reparcellization proposal ${proposalData.title || idLabel}`);
        }
        console.debug(`[_applyReparcellizationProposal] Updated UI (${(performance.now() - step3Time).toFixed(2)}ms)`);

        const totalTime = performance.now() - startTime;
        console.debug(`[_applyReparcellizationProposal] ✓ Reparcellization proposal application completed in ${totalTime.toFixed(2)}ms`);
        return true;
    },

    async _applyRoadProposal(proposalId, proposalData, options = {}) {
        const startTime = performance.now();
        const proposalIdForSynthetics = (proposalData && proposalData.proposalId) ? String(proposalData.proposalId) : proposalId;
        const idLabel = _normalizeProposalId(proposalIdForSynthetics || proposalId) || 'unknown-proposal';
        const suppressMissingParentAlerts = options && options.suppressMissingParentAlerts === true;
        console.debug(`[_applyRoadProposal] Starting application for ${idLabel}...`);

        const canonicalParentIds = Array.isArray(proposalData?.parentParcelIds) ? proposalData.parentParcelIds.map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean) : [];
        const canonicalChildIds = Array.isArray(proposalData?.childParcelIds) ? proposalData.childParcelIds.map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean) : [];
        const canonicalRoadPlan = proposalData?.geometry?.roadPlan || null;
        const canonicalRoadGeometry = proposalData?.geometry?.roadGeometry || null;

        // Keep a single shared reference so downstream mutations persist to storage
        const roadProposal = proposalData?.roadProposal
            ? { ...proposalData.roadProposal }
            : {
                parentParcelIds: canonicalParentIds.slice(),
                childParcelIds: canonicalChildIds.slice(),
                definition: canonicalRoadPlan,
                roadGeometry: canonicalRoadGeometry,
                status: proposalData?.status || 'unapplied'
            };

        proposalData.roadProposal = roadProposal;
        delete roadProposal.parentFeatures;
        delete roadProposal.childFeatures;

        // Keep canonical fields authoritative
        proposalData.parentParcelIds = canonicalParentIds.length ? canonicalParentIds.slice() : (roadProposal.parentParcelIds || []);
        proposalData.childParcelIds = canonicalChildIds.length ? canonicalChildIds.slice() : (roadProposal.childParcelIds || []);
        proposalData.geometry = proposalData.geometry || {};
        if (canonicalRoadPlan && !proposalData.geometry.roadPlan) {
            proposalData.geometry.roadPlan = canonicalRoadPlan;
        }
        if (canonicalRoadGeometry && !proposalData.geometry.roadGeometry) {
            proposalData.geometry.roadGeometry = canonicalRoadGeometry;
        }

        if (!proposalData || (!proposalData.parentParcelIds && !roadProposal.parentParcelIds)) {
            console.warn(`[_applyRoadProposal] Invalid proposal data: missing parent parcel IDs`);
            return false;
        }

        // PERFORMANCE: Start write cache to batch localStorage operations
        if (typeof window._startParcelWriteCache === 'function') {
            window._startParcelWriteCache();
        }

        // Determine if we're restoring an already-applied proposal
        const isRestoring = roadProposal.status === 'applied';
        console.debug(`[_applyRoadProposal] Mode: ${isRestoring ? 'restoring' : 'new application'}`);

        const step1Time = performance.now();
        let assets;
        try {
            assets = this._loadRoadProposalAssets(proposalData, {
                includeParents: true,
                // Only attempt to load existing children when restoring an already-applied proposal.
                // For new applications we will regenerate children from the definition.
                includeChildren: isRestoring,
                includeKeepDetails: true,
                // Never throw on an unresolved parent here. Missing parents are handled downstream
                // by the single missing-parent decision point (conflict detection + apply-anyway),
                // which can proceed with the parents that ARE present.
                allowMissing: true
            });
        } catch (err) {
            console.error('[_applyRoadProposal] Failed to load proposal assets', err);
            try { this._setLastApplyFailure(idLabel, err); } catch (_) { }
            if (typeof updateStatus === 'function') {
                const msg = isRestoring
                    ? 'Cannot restore proposal: missing parcel geometries.'
                    : 'Cannot apply proposal: missing parcel geometries.';
                updateStatus(msg);
            }
            if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
            return false;
        }
        console.debug(`[_applyRoadProposal] Step 1: Loaded assets (${(performance.now() - step1Time).toFixed(2)}ms) - parents: ${assets.parentFeatures?.length || 0}, children: ${assets.childFeatures?.length || 0}`);

        let parentFeatures = Array.isArray(assets.parentFeatures) ? assets.parentFeatures : [];
        let childFeatures = Array.isArray(assets.childFeatures) ? assets.childFeatures : [];

        // Parent availability + conflict decision (new applications only). Runs BEFORE ownership
        // enrichment and child-building so the settled parent set feeds those steps. See
        // _resolveParentAvailabilityOrDefer for the full rationale.
        if (!isRestoring) {
            const declaredParentIds = Array.from(new Set(this._collectParentParcelIds(roadProposal, proposalData).map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));
            const decision = await this._resolveParentAvailabilityOrDefer({ idLabel, proposalData, declaredParentIds, parentFeatures, options });
            if (decision.defer) {
                if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
                return false;
            }
            parentFeatures = decision.parentFeatures;
        }

        // Enrich parent features with any locally-known ownership data BEFORE building children.
        // _buildChildFeaturesFromDefinition clones the parent feature (JSON deep-clone) when
        // minting each descendant, so whatever ownershipDetails / ownershipList / ownershipType
        // the parent carries gets inherited automatically. Without this step, descendants are
        // cloned from parents that were fetched from the cadastre server with no owner info,
        // so clicking a descendant later triggers a backend lookup that 404s (synthetic id).
        try {
            const parcelStore = (typeof window !== 'undefined' && window.ParcelsState && typeof window.ParcelsState.getParcelCache === 'function')
                ? window.ParcelsState.getParcelCache()
                : (typeof window !== 'undefined' ? window.parcelCache : null);
            if (parcelStore && parcelStore.byId instanceof Map) {
                parentFeatures.forEach(feature => {
                    if (!feature || !feature.properties) return;
                    const pid = _getParcelIdFromFeature(feature);
                    if (pid == null) return;
                    const stored = parcelStore.byId.get(pid.toString());
                    const storedProps = stored && stored.properties;
                    if (!storedProps) return;
                    if (!feature.properties.ownershipDetails && storedProps.ownershipDetails) {
                        feature.properties.ownershipDetails = storedProps.ownershipDetails;
                    }
                    if (!feature.properties.ownershipList && Array.isArray(storedProps.ownershipList)) {
                        feature.properties.ownershipList = storedProps.ownershipList.slice();
                    }
                    if (!feature.properties.ownershipType && storedProps.ownershipType) {
                        feature.properties.ownershipType = storedProps.ownershipType;
                    }
                });
            }
        } catch (e) {
            console.warn('[_applyRoadProposal] parent ownership enrichment failed', e);
        }

        const isGovernmentPlan = proposalData?.tags?.governmentPlan === true
            || proposalData?.roadProposal?.definition?.kind === 'government_plan'
            || proposalData?.geometry?.roadPlan?.kind === 'government_plan';
        const expectedCanonicalChildIds = Array.isArray(proposalData?.childParcelIds) && proposalData.childParcelIds.length
            ? proposalData.childParcelIds.map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)
            : (Array.isArray(roadProposal?.childParcelIds) ? roadProposal.childParcelIds.map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean) : []);
        const providedChildFeatures = Array.isArray(proposalData?.childFeatures)
            ? proposalData.childFeatures
            : (Array.isArray(proposalData?.roadProposal?.childFeatures) ? proposalData.roadProposal.childFeatures : []);

        if (!isRestoring) {
            if (isGovernmentPlan) {
                childFeatures = this._cloneFeatures(providedChildFeatures);
            } else {
                childFeatures = this._buildChildFeaturesFromDefinition(proposalIdForSynthetics, proposalData, parentFeatures);
            }
        } else if (
            !isGovernmentPlan
            && (
                (options._restoreFromAlreadyAppliedState === true && !childFeatures.length)
                || (
                    expectedCanonicalChildIds.length > 0
                    && childFeatures.length > 0
                    && childFeatures.length !== expectedCanonicalChildIds.length
                )
            )
        ) {
            // The proposal was marked status=applied on arrival (e.g. server-fetched /proposals/:id
            // deep-link on a fresh client), so _resolveParcelFeaturesForRoadProposal returned no
            // children — there is nothing stored locally to restore. We still have parent features
            // and a road definition, so rebuild children deterministically from those, same as a
            // fresh apply. This is the primary path that keeps deep-linked applied proposals
            // visible without a separate regeneration scheduler.
            const priorChildCount = childFeatures.length;
            childFeatures = this._buildChildFeaturesFromDefinition(proposalIdForSynthetics, proposalData, parentFeatures);
            if (childFeatures.length > 0) {
                console.debug(`[_applyRoadProposal] Restoring ${idLabel}: rebuilt ${childFeatures.length} child features from definition`, {
                    priorChildCount,
                    expectedCanonicalChildCount: expectedCanonicalChildIds.length,
                    restoreFromAlreadyAppliedState: options._restoreFromAlreadyAppliedState === true
                });
            }
        }

        if (!isRestoring && isGovernmentPlan && !childFeatures.length) {
            if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
            return false;
        }

        // Ensure track proposals carry track flags and points on all child features
        const trackFromDefinition = (proposalData?.roadProposal?.definition?.metadata?.isTrack === true)
            || (proposalData?.roadProposal?.definition?.metadata?.type === 'track')
            || (proposalData?.roadProposal?.definition?.type === 'track');

        const flattenTrackPoints = (points) => {
            if (!Array.isArray(points)) return null;
            const result = [];
            const walk = (arr) => {
                if (!Array.isArray(arr)) return;
                arr.forEach(p => {
                    if (Array.isArray(p)) {
                        walk(p);
                    } else if (p !== undefined && p !== null) {
                        result.push(p);
                    }
                });
            };
            walk(points);
            return result;
        };

        const trackPointsFromDefinitionRaw = proposalData?.roadProposal?.definition?.points;
        const trackPointsFromDefinition = flattenTrackPoints(trackPointsFromDefinitionRaw);
        const trackMetaLog = {
            trackFromDefinition,
            trackDefinitionType: proposalData?.roadProposal?.definition?.type,
            trackMetadataType: proposalData?.roadProposal?.definition?.metadata?.type,
            trackMetadataFlag: proposalData?.roadProposal?.definition?.metadata?.isTrack,
            trackPointCount: Array.isArray(trackPointsFromDefinition) ? trackPointsFromDefinition.length : 0,
            trackPointRawShape: Array.isArray(trackPointsFromDefinitionRaw) ? trackPointsFromDefinitionRaw.length : 0,
            childFeatureCount: Array.isArray(childFeatures) ? childFeatures.length : 0
        };
        if (trackFromDefinition && Array.isArray(childFeatures)) {
            childFeatures.forEach(f => {
                if (!f || typeof f !== 'object') return;
                if (!f.properties) f.properties = {};
                // The corridor parcel is identified by isCorridor or isTrack flag
                const isCorridor = f.properties.isCorridor === true
                    || f.properties.isTrack === true;
                if (isCorridor) {
                    f.properties.isCorridor = true;
                    f.properties.isTrack = true;
                    f.properties.isRoad = false; // tracks are NOT roads
                    if (!f.properties.trackPoints && trackPointsFromDefinition) {
                        f.properties.trackPoints = trackPointsFromDefinition;
                    } else if (Array.isArray(f.properties.trackPoints)) {
                        f.properties.trackPoints = flattenTrackPoints(f.properties.trackPoints) || f.properties.trackPoints;
                    }
                } else {
                    // Ensure non-corridor children don't inherit track styling
                    if (f.properties.isCorridor) delete f.properties.isCorridor;
                    if (f.properties.isTrack) delete f.properties.isTrack;
                    if (f.properties.trackPoints) delete f.properties.trackPoints;
                }
            });
            try {
                const sample = childFeatures.slice(0, 5).map(f => ({
                    pid: _getParcelIdFromFeature(f),
                    isTrack: f?.properties?.isTrack === true,
                    isRoad: f?.properties?.isRoad === true,
                    hasTrackPoints: Array.isArray(f?.properties?.trackPoints),
                    trackPointCount: Array.isArray(f?.properties?.trackPoints) ? f.properties.trackPoints.length : 0
                }));
                console.debug('[_applyRoadProposal] track tagging applied', { ...trackMetaLog, sample });
            } catch (logErr) {
                console.warn('[_applyRoadProposal] track tagging log failed', logErr);
            }
        } else {
            console.debug('[_applyRoadProposal] track tagging skipped', trackMetaLog);
        }

        // Children carry the ids the id subsystem just minted for THIS apply; we never try to
        // reproduce a stored canonical list. A stored count (from a prior apply synced via
        // server/shared link) may differ from what we regenerated — children are derived data
        // (parents + road/track definition), so evolved geometry drifts the count by a few slivers.
        // That is cosmetic: the consensus layer (acceptance, sale, ownership transfer) is entirely
        // parent-keyed. We log the drift for visibility and apply the regenerated children as-is.
        if (!isGovernmentPlan && expectedCanonicalChildIds.length > 0 && childFeatures.length !== expectedCanonicalChildIds.length) {
            console.debug(`[_applyRoadProposal] Child count drifted for ${idLabel}: stored ${expectedCanonicalChildIds.length}, generated ${childFeatures.length}. Applying regenerated children with freshly minted ids.`);
        }

        // When restoring an already-applied proposal, parent parcels are expected to be removed
        // So we only require parent features for new applications, not for restorations
        if (!isRestoring && !parentFeatures.length) {
            console.warn('Cannot apply road proposal: parent parcel geometries are missing.', { proposalId });
            if (typeof updateStatus === 'function') {
                updateStatus('Cannot apply proposal: missing parent parcel geometries.');
            }
            try {
                this._setLastApplyFailure(idLabel, {
                    code: 'dependency-missing',
                    message: 'Cannot apply proposal: missing parent parcel geometries.'
                });
            } catch (_) { }
            if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
            return false;
        }

        // For restoration, we need child features to restore OR child parcels must already be in parcelLayerById
        if (isRestoring && !childFeatures.length) {
            // Check if child parcels are in parcelLayerById (may be hidden but still indexed)
            const childParcelIds = Array.isArray(proposalData.childParcelIds)
                ? proposalData.childParcelIds.map(id => String(id))
                : [];
            const mapById = (typeof window.getParcelLayerIdMap === 'function')
                ? window.getParcelLayerIdMap()
                : (window.parcelLayerById instanceof Map ? window.parcelLayerById : null);
            if (childParcelIds.length > 0 && mapById) {
                const childrenInIndex = new Set();
                childParcelIds.forEach(id => {
                    if (mapById.has(id)) {
                        childrenInIndex.add(id);
                    }
                });
                // If all child parcels are in the index, we can proceed with restoration
                if (childrenInIndex.size === childParcelIds.length) {
                    console.debug(`[_applyRoadProposal] Restoring ${proposalId}: All ${childParcelIds.length} child parcels in parcelLayerById, skipping feature loading`);
                    // Still need to hide parent parcels if they exist
                    // The early return check below will handle this
                } else {
                    console.warn('Cannot restore road proposal: child parcel geometries are missing and not all children are in index.', {
                        proposalId,
                        expected: childParcelIds.length,
                        found: childrenInIndex.size,
                        missing: childParcelIds.filter(id => !childrenInIndex.has(id))
                    });
                    if (typeof updateStatus === 'function') {
                        updateStatus('Cannot restore proposal: missing child parcel geometries.');
                    }
                    if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
                    return false;
                }
            } else {
                console.warn('Cannot restore road proposal: child parcel geometries are missing.', { proposalId });
                if (typeof updateStatus === 'function') {
                    updateStatus('Cannot restore proposal: missing child parcel geometries.');
                }
                if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
                return false;
            }
        }

        console.debug(`Applying proposal ${proposalId}:`, {
            parentFeatures: parentFeatures.length,
            childFeatures: childFeatures.length,
            parentIds: parentFeatures.map(f => _getParcelIdFromFeature(f)),
            childIds: childFeatures.map(f => _getParcelIdFromFeature(f))
        });

        const parentParcelIds = [];
        if (Array.isArray(roadProposal.parentParcelIds)) {
            roadProposal.parentParcelIds.forEach(id => {
                if (id === undefined || id === null) return;
                parentParcelIds.push(id && id.toString ? id.toString() : String(id));
            });
        }
        parentFeatures.forEach(feature => {
            const parcelId = _getParcelIdFromFeature(feature);
            if (parcelId) {
                parentParcelIds.push(parcelId.toString());
            }
        });
        const uniqueParentParcelIds = Array.from(new Set(parentParcelIds.length ? parentParcelIds : parentIdsForFetch));
        roadProposal.parentParcelIds = uniqueParentParcelIds.slice();
        proposalData.parentParcelIds = uniqueParentParcelIds.slice();

        let parentsToRemoveCandidates;
        if (Array.isArray(roadProposal.parentsToRemove)) {
            parentsToRemoveCandidates = roadProposal.parentsToRemove;
        } else if (roadProposal.parentsToRemove === undefined || roadProposal.parentsToRemove === null) {
            // Use uniqueParentParcelIds (which includes all parent parcel IDs) instead of parentParcelIds
            // This ensures we include all parent parcels, even if some features weren't loaded
            parentsToRemoveCandidates = uniqueParentParcelIds;
        } else {
            parentsToRemoveCandidates = [roadProposal.parentsToRemove];
        }

        const parentsToRemoveSet = new Set();
        const addParentIdCandidate = (candidate) => {
            if (candidate === undefined || candidate === null) {
                return;
            }
            const normalized = candidate && candidate.toString ? candidate.toString() : String(candidate);
            if (!normalized) {
                return;
            }
            // Keep the full id (descendants need exact matches) and also the legacy base id used by older synthetic ids with "_" suffixes.
            parentsToRemoveSet.add(normalized);
            const legacyBase = normalized.includes('_') ? normalized.split('_')[0] : null;
            if (legacyBase && legacyBase !== normalized) {
                parentsToRemoveSet.add(legacyBase);
            }
        };

        (parentsToRemoveCandidates || []).forEach(addParentIdCandidate);

        const parentFeaturesToRemove = parentFeatures.filter(feature => {
            const parcelId = _getParcelIdFromFeature(feature);
            return parcelId && parentsToRemoveSet.has(parcelId.toString());
        });

        const parentFeaturesKept = parentFeatures.filter(feature => {
            const parcelId = _getParcelIdFromFeature(feature);
            return !parcelId || !parentsToRemoveSet.has(parcelId.toString());
        });

        // Debug logging to understand why parentFeaturesToRemove might be incomplete
        console.debug(`[_applyRoadProposal] Parent parcel removal analysis:`, {
            proposalId,
            parentFeaturesCount: parentFeatures.length,
            parentFeaturesIds: parentFeatures.map(f => _getParcelIdFromFeature(f)?.toString()).filter(Boolean),
            uniqueParentParcelIds: uniqueParentParcelIds,
            parentsToRemoveSet: Array.from(parentsToRemoveSet),
            parentsToRemoveCandidates: parentsToRemoveCandidates,
            roadProposalHasParentsToRemove: roadProposal.parentsToRemove !== undefined && roadProposal.parentsToRemove !== null,
            parentFeaturesToRemoveCount: parentFeaturesToRemove.length,
            parentFeaturesToRemoveIds: parentFeaturesToRemove.map(f => _getParcelIdFromFeature(f)?.toString()).filter(Boolean),
            parentFeaturesKeptCount: parentFeaturesKept.length,
            parentFeaturesKeptIds: parentFeaturesKept.map(f => _getParcelIdFromFeature(f)?.toString()).filter(Boolean),
            missingFromParentFeatures: uniqueParentParcelIds.filter(id => !parentFeatures.some(f => _getParcelIdFromFeature(f)?.toString() === id)),
            inParentsToRemoveSetButNotInParentFeatures: Array.from(parentsToRemoveSet).filter(id => !parentFeatures.some(f => _getParcelIdFromFeature(f)?.toString() === id))
        });

        // When restoring, parent parcels are already removed, so this check doesn't apply
        if (isRestoring && !childFeatures.length) {
            const childParcelIds = Array.isArray(roadProposal.childParcelIds)
                ? roadProposal.childParcelIds.map(id => String(id))
                : [];
            const mapById = (typeof window.getParcelLayerIdMap === 'function') ? window.getParcelLayerIdMap() : (window.parcelLayerById instanceof Map ? window.parcelLayerById : null);
            if (!mapById) {
                console.error('Cannot restore road proposal: parcelLayerById map is unavailable.');
                if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
                return false;
            }
            const missing = childParcelIds.filter(id => !mapById.has(id));
            if (missing.length === 0) {
                console.debug(`[_applyRoadProposal] Restoring ${proposalId}: All ${childParcelIds.length} child parcels already on map, skipping feature loading`);
            } else {
                console.warn('Cannot restore road proposal: child parcel geometries are missing and not all children are on map.', {
                    proposalId,
                    expected: childParcelIds.length,
                    missing
                });
                if (typeof updateStatus === 'function') {
                    updateStatus('Cannot restore proposal: missing child parcel geometries.');
                }
                if (typeof showEphemeralMessage === 'function') {
                    showEphemeralMessage('Cannot restore proposal: missing child parcel geometries.', 5000, 'error');
                }
                if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
                return false;
            }
        }
        const parentParcelIdsToRemove = Array.from(parentsToRemoveSet || []).reduce((acc, rawId) => {
            const id = (rawId === undefined || rawId === null) ? '' : String(rawId);
            if (!id) return acc;
            acc.push(id);
            const legacyBase = id.includes('_') ? id.split('_')[0] : null;
            if (legacyBase && legacyBase !== id) {
                acc.push(legacyBase);
            }
            return acc;
        }, []);
        const uniqueParentParcelIdsToRemove = Array.from(new Set(parentParcelIdsToRemove));

        // No longer need to set removedByProposal flag - visibility is calculated from parent/child relationships
        // Parent parcels will be hidden automatically by isParcelReplacedByChildren() based on applied proposals

        // Determine which parents are currently on the map.
        const parentParcelsOnMap = [];
        const parentIdSet = new Set(uniqueParentParcelIdsToRemove);
        const mapByIdRemove = (typeof window.getParcelLayerIdMap === 'function') ? window.getParcelLayerIdMap() : (window.parcelLayerById instanceof Map ? window.parcelLayerById : null);
        if (!mapByIdRemove) {
            console.error('[_applyRoadProposal] parcelLayerById map is unavailable; aborting parent removal detection.');
            if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
            return false;
        }
        parentIdSet.forEach(id => {
            if (mapByIdRemove.has(id)) {
                parentParcelsOnMap.push(id);
            }
        });

        // Restoration optimization: only skip if children are present AND no parents are present.
        // NOTE: bypass this fast path when we have rebuilt children from definition
        // (_restoreFromAlreadyAppliedState) — the rebuilt features need to be ingested into the
        // map, even though the stored childParcelIds list may be empty or stale.
        if (isRestoring && options._restoreFromAlreadyAppliedState !== true) {
            const childParcelIds = Array.isArray(roadProposal.childParcelIds)
                ? roadProposal.childParcelIds.map(id => String(id))
                : [];
            const remaining = new Set(childParcelIds);
            const mapByIdRestore = (typeof window.getParcelLayerIdMap === 'function') ? window.getParcelLayerIdMap() : (window.parcelLayerById instanceof Map ? window.parcelLayerById : null);
            if (!mapByIdRestore) {
                console.error('[_applyRoadProposal] parcelLayerById map is unavailable during restoration check.');
                if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
                return false;
            }
            remaining.forEach(id => {
                if (mapByIdRestore.has(id)) {
                    remaining.delete(id);
                }
            });
            const allChildrenOnMap = remaining.size === 0;
            if (allChildrenOnMap && parentParcelsOnMap.length === 0) {
                return true;
            }
        }

        const removeParentParcels = () => {
            if (parentParcelsOnMap.length === 0) return;
            const step5Time = performance.now();
            // Remove from multi-selection if any are selected
            if (typeof window.multiParcelSelection !== 'undefined' && window.multiParcelSelection) {
                parentParcelsOnMap.forEach(parcelId => {
                    if (window.multiParcelSelection.selectedParcels && window.multiParcelSelection.selectedParcels.has(parcelId)) {
                        const parcel = window.multiParcelSelection.findParcelById && window.multiParcelSelection.findParcelById(parcelId);
                        if (parcel && typeof window.multiParcelSelection.removeParcelHighlight === 'function') {
                            window.multiParcelSelection.removeParcelHighlight(parcel);
                        }
                        window.multiParcelSelection.selectedParcels.delete(parcelId);
                    }
                });
                if (typeof window.multiParcelSelection.updateUI === 'function') {
                    window.multiParcelSelection.updateUI();
                }
            }

            // Clear single selection if it's one of the removed parcels
            if (typeof window.selectedParcelId !== 'undefined' && window.selectedParcelId) {
                const selectedId = window.selectedParcelId.toString();
                if (parentParcelsOnMap.includes(selectedId)) {
                    window.selectedParcelId = null;
                }
            }

            console.debug(`[_applyRoadProposal] ${isRestoring ? 'Restoring: ' : ''}Hiding ${parentParcelsOnMap.length} parent parcels from map (keeping in index):`, parentParcelsOnMap);
            parentParcelsOnMap.forEach(parcelId => {
                // Use hideParcelLayerById to keep entry in parcelLayerById so descendant proposals can still find parents
                if (typeof window.hideParcelLayerById === 'function') {
                    window.hideParcelLayerById(parcelId);
                } else if (typeof window.removeParcelLayerById === 'function') {
                    window.removeParcelLayerById(parcelId);
                }
            });
            console.debug(`[_applyRoadProposal] Step 5: Hidden ${parentParcelsOnMap.length} parent parcels (${(performance.now() - step5Time).toFixed(2)}ms)`);
        };

        const filteredChildFeatures = _filterChildFeaturesBlockedByDescendants(childFeatures, proposalId);
        const skippedChildren = childFeatures.length - filteredChildFeatures.length;
        if (skippedChildren > 0) {
            console.debug(`[_applyRoadProposal] Skipping ${skippedChildren} child parcel(s) hidden by applied descendant proposals`);
        }

        let allChildrenAdded = true;
        try {
            const step3Time = performance.now();
            // Add new features using normal map styling (no special proposal coloring)
            // Pass proposal data so track information can be retrieved if needed
            this._addFeaturesToMap(filteredChildFeatures, true, proposalData);
            console.debug(`[_applyRoadProposal] Step 3: Added ${filteredChildFeatures.length} child parcels to map (${(performance.now() - step3Time).toFixed(2)}ms)`);
        } catch (err) {
            allChildrenAdded = false;
            console.error('Failed to add one or more child parcels during road proposal application:', err);
        }

        if (!allChildrenAdded) {
            if (typeof window._discardParcelWriteCache === 'function') window._discardParcelWriteCache();
            return false;
        }

        const step4Time = performance.now();
        this._linkProposalToAncestors(proposalId, uniqueParentParcelIds);
        // PERFORMANCE: Use batched version instead of per-parcel calls
        this._markParcelsModifiedBatch(uniqueParentParcelIds);
        this._setDescendantProposalOnParcels(uniqueParentParcelIds, proposalId);
        console.debug(`[_applyRoadProposal] Step 4: Linked to ${uniqueParentParcelIds.length} ancestors (${(performance.now() - step4Time).toFixed(2)}ms)`);

        // Remove parents only after ancestor linkage/property updates so map lookups succeed.
        removeParentParcels();

        const step6Time = performance.now();
        const childParcelIds = [];
        const childParcelIdsForMark = [];
        filteredChildFeatures.forEach(feature => {
            const parcelId = _getParcelIdFromFeature(feature);
            _ensureParcelIdOnProperties(feature.properties, parcelId);
            // Save coordinates in WGS84 format (same as display format)
            feature.properties.ancestorProposal = proposalId;
            delete feature.properties.descendantProposal;
            this._persistParcelFeature(feature);
            if (feature.properties.isRoad) {
                feature.properties.roadName = feature.properties.roadName || 'Unnamed Road';
                feature.properties.roadId = feature.properties.roadId || '';
                if (typeof window.addRoadParcel === 'function') window.addRoadParcel(parcelId);
            }
            this._addProposalAsAncestor(parcelId, proposalId);
            if (parcelId !== undefined && parcelId !== null) {
                childParcelIds.push(String(parcelId));
                childParcelIdsForMark.push(parcelId);
            }
        });
        // PERFORMANCE: Batch the mark operation instead of per-parcel calls
        this._markParcelsModifiedBatch(childParcelIdsForMark);
        // Always register child IDs so getProposalsForParcel() can find descendants via childParcelIds.
        // _addChildParcels merges with existing (Set-based), so calling it in the restore path is safe
        // and essential for fresh deep-link proposals that arrive with no prior childParcelIds.
        if (childParcelIds.length) {
            this._addChildParcels(proposalId, childParcelIds, proposalData);
        }
        console.debug(`[_applyRoadProposal] Step 6: Saved ${filteredChildFeatures.length} child parcels to storage (${(performance.now() - step6Time).toFixed(2)}ms)`);

        if (parentFeaturesKept.length > 0) {
            const keptIds = parentFeaturesKept
                .map(feature => _getParcelIdFromFeature(feature)?.toString())
                .filter(Boolean);
            console.warn('[GovernmentPlan] Kept existing parent parcel(s); replacement geometry was unavailable or incomplete.', {
                keptCount: parentFeaturesKept.length,
                keptIds
            });
        }
        const uniqueChildIds = Array.from(new Set(childParcelIds.map(id => id.toString())));
        roadProposal.childParcelIds = uniqueChildIds;
        proposalData.childParcelIds = uniqueChildIds;

        // Do not persist child geometries on the proposal object; IDs and persisted storage are the source of truth
        delete roadProposal.childFeatures;
        delete roadProposal.parentFeatures;
        if (proposalData.roadProposal) {
            delete proposalData.roadProposal.childFeatures;
            delete proposalData.roadProposal.parentFeatures;
        }

        const step7Time = performance.now();
        proposalData.geometry = proposalData.geometry || {};
        if (roadProposal.definition) {
            proposalData.geometry.roadPlan = roadProposal.definition;
        }
        if (roadProposal.roadGeometry) {
            proposalData.geometry.roadGeometry = roadProposal.roadGeometry;
        }
        roadProposal.status = 'applied';
        proposalData.status = 'Applied';
        proposalStorage.save();
        console.debug(`[_applyRoadProposal] Step 7: Saved proposal status (${(performance.now() - step7Time).toFixed(2)}ms)`);

        // Keep proposals indicator in sync
        try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }

        if (typeof showAllProposalsModal === 'function') {
            const modal = document.querySelector('.proposal-list-modal');
            if (modal && modal.style.display === 'block') {
                showAllProposalsModal();
            }
        }

        // Update proposals indicator and list button
        try { if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton(); } catch (_) { }
        try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }

        if (typeof window.selectedParcelId !== 'undefined' && window.selectedParcelId) {
            const affectedParcelIds = parentFeatures
                .map(f => _getParcelIdFromFeature(f))
                .filter(Boolean)
                .map(id => id.toString());
            if (affectedParcelIds.includes(window.selectedParcelId.toString())) {
                if (typeof showParcelInfoPanel === 'function') {
                    const parcelLayer = window.parcelLayer.getLayers().find(l =>
                        _getParcelIdFromFeature(l.feature)?.toString() === window.selectedParcelId.toString()
                    );
                    if (parcelLayer) {
                        showParcelInfoPanel(parcelLayer.feature);
                    }
                }
            }
        }

        const step8Time = performance.now();
        // Keep proposals indicator in sync
        try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }
        try { if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton(); } catch (_) { }
        try { if (typeof updateProposalList === 'function') updateProposalList(); } catch (_) { }
        try { if (typeof updateProposalLayer === 'function') updateProposalLayer(); } catch (_) { }
        console.debug(`[_applyRoadProposal] Step 8: Updated UI indicators (${(performance.now() - step8Time).toFixed(2)}ms)`);

        const step9Time = performance.now();
        // Refresh parcel styles to ensure borders and fills are properly displayed
        // This is critical after applying road/track proposals as parcels may have been removed/added
        if (typeof refreshParcelStylesForAppliedProposals === 'function') {
            refreshParcelStylesForAppliedProposals();
        }
        console.debug(`[_applyRoadProposal] Step 9: Refreshed parcel styles (${(performance.now() - step9Time).toFixed(2)}ms)`);

        // Step 10: If this proposal is currently highlighted, re-highlight using the normal flow
        // This updates the button from "Apply to map" to "Remove from map" and clears any hover overlays
        try {
            const isHighlighted = window.currentlyHighlightedProposalId &&
                proposalData.proposalId &&
                String(window.currentlyHighlightedProposalId) === String(proposalData.proposalId);

            if (isHighlighted && typeof selectAndHighlightProposal === 'function') {
                selectAndHighlightProposal(proposalData.proposalId, window.selectedParcelInProposal, false, true);
            }
        } catch (_) { }

        // PERFORMANCE: Flush cached writes to localStorage in one batch
        if (typeof window._flushParcelWriteCache === 'function') {
            window._flushParcelWriteCache();
        }

        const totalTime = performance.now() - startTime;
        console.debug(`[_applyRoadProposal] ✓ Road proposal application completed in ${totalTime.toFixed(2)}ms`);
        return true;
    },

    _isBuildingProposal(proposalData) {
        if (!proposalData) return false;
        const goalKey = this._normalizeGoalKey(proposalData.goal);
        return goalKey === 'buildings' || goalKey === 'single' || goalKey === 'row' || goalKey === 'parcelbased' || goalKey === 'parcelBased';
    },

    _isDecideLaterProposal(proposalData) {
        if (!proposalData) return false;
        const goalKey = this._normalizeGoalKey(proposalData.goal);
        return goalKey === 'decide-later';
    },

    _normalizeGoalKey(rawGoal) {
        if (rawGoal === undefined || rawGoal === null) return '';
        const text = String(rawGoal).trim().toLowerCase();
        if (!text) return '';
        const dashed = text.replace(/\s+/g, '-');
        const key = dashed.replace(/\//g, '-');
        if (key === 'road-track' || key === 'road' || key === 'track') return 'road-track';
        if (key === 'decide-later' || key === 'decide') return 'decide-later';
        if (key === 'reparcellization') return 'reparcellization';
        if (key === 'park' || key === 'square' || key === 'lake') return key;
        if (key === 'buildings' || key === 'residences') return 'buildings';
        if (key === 'building(s)' || key === 'single' || key === 'single-building') return 'single';
        if (key === 'row') return 'row';
        if (key === 'parcelbased' || key === 'parcel-based') return 'parcelBased';
        if (key === 'urban-rule') return 'urban-rule';
        if (key === 'parcel') return 'parcel';
        return key;
    },

    _getBuildingAncestorKey(proposalData) {
        if (!proposalData) return null;
        const buildingProposal = proposalData.buildingProposal || {};
        if (buildingProposal.ancestorKey) return buildingProposal.ancestorKey;
        const ids = Array.isArray(buildingProposal.parentParcelIds) && buildingProposal.parentParcelIds.length > 0
            ? buildingProposal.parentParcelIds
            : proposalData.parentParcelIds;
        if (!Array.isArray(ids) || ids.length === 0) return null;
        return Array.from(new Set(ids.map(id => id.toString()))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join('|');
    },

    async _applyBuildingProposal(proposalId, proposalData, options = {}) {
        const startTime = performance.now();
        const idLabel = _normalizeProposalId(proposalId) || 'unknown-proposal';
        console.debug(`[_applyBuildingProposal] Starting application for ${idLabel}...`);

        if (!proposalData) {
            console.warn(`[_applyBuildingProposal] Invalid proposal data`);
            return false;
        }

        const step1Time = performance.now();
        const buildingProposal = proposalData.buildingProposal ? { ...proposalData.buildingProposal } : {};
        const parentIdsSource = Array.isArray(buildingProposal.parentParcelIds) && buildingProposal.parentParcelIds.length > 0
            ? buildingProposal.parentParcelIds
            : proposalData.parentParcelIds;
        const parentParcelIds = Array.isArray(parentIdsSource) ? parentIdsSource.map(id => id && id.toString ? id.toString() : String(id)) : [];
        const uniqueParentIds = Array.from(new Set(parentParcelIds.filter(Boolean)));
        console.debug(`[_applyBuildingProposal] Step 1: Prepared parent parcel IDs (${(performance.now() - step1Time).toFixed(2)}ms) - ${uniqueParentIds.length} parents`);

        if (uniqueParentIds.length === 0) {
            if (typeof updateStatus === 'function') {
                updateStatus('Cannot apply building proposal: no ancestor parcels found.');
            }
            return false;
        }

        const step2Time = performance.now();
        // Parent availability + conflict decision. A building OVERLAYS its parents (it never hides or
        // splits them), so "apply anyway" simply renders the building over whatever parents are
        // present; but if another applied proposal already sits on / consumed these parcels, that's a
        // conflict the user should resolve first (e.g. two buildings on the same parcel).
        {
            const parentFeatures = this._resolveParcelFeaturesByIds(uniqueParentIds, { preferMap: true, allowStorage: true, fallbackToMap: true, allowMissing: true });
            const decision = await this._resolveParentAvailabilityOrDefer({ idLabel, proposalData, declaredParentIds: uniqueParentIds, parentFeatures, options });
            if (decision.defer) {
                return false;
            }
        }
        console.debug(`[_applyBuildingProposal] Step 2: Parent availability OK (${(performance.now() - step2Time).toFixed(2)}ms)`);

        const step3Time = performance.now();
        const ancestorKey = uniqueParentIds.slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join('|');

        try {
            const allProposals = proposalStorage.getAllProposals();
            allProposals
                .filter(p => p.proposalId !== proposalId && this._isBuildingProposal(p))
                .forEach(p => {
                    const otherKey = this._getBuildingAncestorKey(p);
                    const fallbackStatus = (typeof isAppliedStatus === 'function' ? isAppliedStatus(p.status) : (p.status || '').toLowerCase() === 'applied') ? 'applied' : 'unapplied';
                    const otherStatus = (p.buildingProposal && p.buildingProposal.status) || fallbackStatus;
                    if (otherKey === ancestorKey && (otherStatus === 'applied' || otherStatus === 'executed')) {
                        const hasFamilyUnapply = typeof this.unapplyWholeFamily === 'function';
                        if (hasFamilyUnapply) {
                            this.unapplyWholeFamily(p.proposalId);
                        } else if (typeof this.unapplyProposal === 'function') {
                            this.unapplyProposal(p.proposalId, { skipConfirm: true });
                        }
                    }
                });
        } catch (err) {
            console.warn('Failed to enforce unique building proposal constraint', err);
        }
        console.debug(`[_applyBuildingProposal] Step 3: Enforced unique building constraint (${(performance.now() - step3Time).toFixed(2)}ms)`);

        const step4Time = performance.now();
        const cloneFeature = (raw) => {
            if (!raw || typeof raw !== 'object') return null;
            try { return JSON.parse(JSON.stringify(raw)); } catch (_) { return null; }
        };

        // Legacy buildingFeatures ignored; do not mutate

        const candidateFeatures = Array.isArray(proposalData?.geometry?.buildings)
            ? proposalData.geometry.buildings
                .map(raw => {
                    const cloned = cloneFeature(raw);
                    return cloned && cloned.geometry ? cloned : null;
                })
                .filter(Boolean)
            : [];

        if (!candidateFeatures.length) {
            const message = 'Building proposal missing geometry; cannot apply.';
            console.warn(message, { proposalId });
            if (typeof updateStatus === 'function') updateStatus(message);
            return false;
        }

        const baseProperties = {
            ...(proposalData.buildingProperties || {}),
            ...(proposalData.properties || {})
        };
        const proposalState = buildingProposal.status === 'executed' ? 'executed' : 'applied';

        const preparedFeatures = candidateFeatures
            .map((raw, index) => {
                if (!raw || !raw.geometry) return null;
                const cloned = cloneFeature(raw);
                if (!cloned || !cloned.geometry) return null;
                const properties = {
                    ...baseProperties,
                    ...(cloned.properties || {}),
                    proposalId,
                    proposalState,
                    parentParcelIds: uniqueParentIds,
                    parentParcelNumbers: buildingProposal.parentParcelNumbers || null,
                    title: proposalData.title || null,
                    author: proposalData.author || null,
                    buildingIndex: index
                };
                return {
                    type: 'Feature',
                    geometry: cloned.geometry,
                    properties
                };
            })
            .filter(Boolean);

        if (!preparedFeatures.length) {
            const message = 'Building proposal missing geometry; cannot apply.';
            console.warn(message, { proposalId });
            if (typeof updateStatus === 'function') updateStatus(message);
            return false;
        }
        console.debug(`[_applyBuildingProposal] Step 4: Prepared ${preparedFeatures.length} building feature(s) (${(performance.now() - step4Time).toFixed(2)}ms)`);

        preparedFeatures.forEach(feature => {
            if (typeof upsertProposedBuildingFeature === 'function') {
                upsertProposedBuildingFeature(feature, { updateLayer: false, save: false });
            } else {
                if (typeof proposedBuildings === 'undefined') {
                    if (typeof window !== 'undefined') window.proposedBuildings = [];
                }
                if (typeof proposedBuildings !== 'undefined') {
                    if (!Array.isArray(proposedBuildings)) proposedBuildings = [];
                    const existingIndex = proposedBuildings.findIndex(b => b && b.properties && b.properties.proposalId === proposalId && b.properties.buildingIndex === feature.properties.buildingIndex);
                    if (existingIndex > -1) {
                        proposedBuildings[existingIndex] = feature;
                    } else {
                        proposedBuildings.push(feature);
                    }
                }
            }
        });

        if (typeof updateProposedBuildingsLayer === 'function') updateProposedBuildingsLayer();
        if (typeof saveExecutedBuildingsToStorage === 'function') saveExecutedBuildingsToStorage();

        const showBuildingsCheckbox = document.getElementById('showProposedBuildings');
        if (showBuildingsCheckbox && !showBuildingsCheckbox.checked) {
            showBuildingsCheckbox.checked = true;
        }

        buildingProposal.status = proposalState;
        buildingProposal.appliedAt = new Date().toISOString();
        buildingProposal.parentParcelIds = uniqueParentIds;
        buildingProposal.ancestorKey = ancestorKey;
        proposalData.buildingProposal = buildingProposal;

        if (!proposalData.geometry || typeof proposalData.geometry !== 'object') {
            proposalData.geometry = {};
        }
        proposalData.geometry.buildings = preparedFeatures.map(cloneFeature).filter(Boolean);

        if (typeof isAppliedStatus === 'function') {
            if (!isAppliedStatus(proposalData.status)) {
                proposalData.status = 'Applied';
            }
        } else if (proposalData.status !== 'Applied') {
            proposalData.status = 'Applied';
        }
        proposalData.updatedAt = new Date().toISOString();

        proposalData.proposalId = proposalData.proposalId || proposalId;
        if (typeof proposalStorage._indexProposal === 'function') {
            proposalStorage._indexProposal(proposalData);
        } else {
            proposalStorage.proposals.set(proposalData.proposalId, proposalData);
        }
        proposalStorage.save();

        this._setDescendantProposalOnParcels(uniqueParentIds, proposalId);

        const step7Time = performance.now();
        this._linkProposalToAncestors(proposalId, uniqueParentIds);
        console.debug(`[_applyBuildingProposal] Step 7: Linked to ${uniqueParentIds.length} ancestors (${(performance.now() - step7Time).toFixed(2)}ms)`);

        const step8Time = performance.now();
        if (typeof updateShowProposalsButton === 'function') {
            updateShowProposalsButton();
        }
        if (typeof updateProposalList === 'function') {
            updateProposalList();
        }

        if (typeof updateStatus === 'function') {
            updateStatus(`Applied building proposal ${proposalData.title || idLabel}`);
        }

        if (typeof refreshParcelStylesForAppliedProposals === 'function') {
            refreshParcelStylesForAppliedProposals();
        }
        console.debug(`[_applyBuildingProposal] Step 8: Updated UI (${(performance.now() - step8Time).toFixed(2)}ms)`);

        const totalTime = performance.now() - startTime;
        console.debug(`[_applyBuildingProposal] ✓ Building proposal application completed in ${totalTime.toFixed(2)}ms`);
        return true;
    },

    async unapplyProposal(proposalId, options = {}) {
        if (typeof proposalStorage === 'undefined') return false;
        const skipConfirm = !!options.skipConfirm;

        const proposalData = _getProposalRecord(proposalId);
        if (!proposalData) return false;

        const isRoad = !!proposalData.roadProposal;
        const isBuilding = this._isBuildingProposal(proposalData);
        const isStructure = !!(proposalData && proposalData.structureProposal);
        const isReparcellization = !!(proposalData && proposalData.reparcellization);
        const isDecideLater = this._isDecideLaterProposal(proposalData);

        if (!isRoad && !isBuilding && !isStructure && !isReparcellization && !isDecideLater) return false;

        let currentStatus;
        if (isRoad) {
            currentStatus = proposalData.roadProposal.status;
        } else if (isBuilding) {
            currentStatus = (proposalData.buildingProposal && proposalData.buildingProposal.status)
                || ((typeof isAppliedStatus === 'function'
                    ? isAppliedStatus(proposalData.status)
                    : (proposalData.status || '').toLowerCase() === 'applied') ? 'applied' : 'unapplied');
        } else if (isStructure) {
            currentStatus = (proposalData.structureProposal && proposalData.structureProposal.status)
                || ((typeof isAppliedStatus === 'function'
                    ? isAppliedStatus(proposalData.status)
                    : (proposalData.status || '').toLowerCase() === 'applied') ? 'applied' : 'unapplied');
        } else if (isReparcellization) {
            currentStatus = proposalData.reparcellization.status
                || ((typeof isAppliedStatus === 'function'
                    ? isAppliedStatus(proposalData.status)
                    : (proposalData.status || '').toLowerCase() === 'applied') ? 'applied' : 'unapplied');
        } else if (isDecideLater) {
            currentStatus = (proposalData.decideLaterProposal && proposalData.decideLaterProposal.status)
                || ((typeof isAppliedStatus === 'function'
                    ? isAppliedStatus(proposalData.status)
                    : (proposalData.status || '').toLowerCase() === 'applied') ? 'applied' : 'unapplied');
        }

        const normalizedStatus = (currentStatus || '').toLowerCase();

        if (normalizedStatus === 'unapplied') {
            await this._restoreReplacementSource(proposalId, proposalData);
            return true;
        }

        const descendantProposals = this.findDescendantTree(proposalId).map(node => node.proposalId);
        const childParcels = this._getProposalChildParcels(proposalId) || [];
        const allDescendants = Array.from(new Set([...descendantProposals, ...childParcels.map(id => id && id.toString ? id.toString() : String(id))].filter(Boolean)));
        if (!skipConfirm && allDescendants.length > 0) {
            this._showDescendantsConfirmModal({
                action: 'un-apply',
                proposalId,
                descendants: allDescendants,
                onConfirm: async () => {
                    if (typeof this.unapplyWholeFamily === 'function') {
                        await this.unapplyWholeFamily(proposalId);
                    } else {
                        if (isRoad) {
                            await this._unapplyProposalConfirmed(proposalId);
                        } else if (isBuilding) {
                            await this._unapplyBuildingProposalConfirmed(proposalId);
                        } else if (isStructure) {
                            await this._unapplyStructureProposalConfirmed(proposalId);
                        } else if (isReparcellization) {
                            await this._unapplyReparcellizationProposalConfirmed(proposalId);
                        } else if (isDecideLater) {
                            await this._unapplyDecideLaterProposalConfirmed(proposalId);
                        }
                    }
                    // Refresh UI after bulk unapply from modal
                    this._refreshUIAfterProposalChange(_getProposalRecord(proposalId));
                }
            });
            return false;
        }

        if (isRoad) {
            await this._unapplyProposalConfirmed(proposalId);
        } else if (isBuilding) {
            await Promise.resolve(this._unapplyBuildingProposalConfirmed(proposalId));
        } else if (isStructure) {
            await Promise.resolve(this._unapplyStructureProposalConfirmed(proposalId));
        } else if (isReparcellization) {
            await Promise.resolve(this._unapplyReparcellizationProposalConfirmed(proposalId));
        } else if (isDecideLater) {
            await Promise.resolve(this._unapplyDecideLaterProposalConfirmed(proposalId));
        }

        await this._restoreReplacementSource(proposalId, proposalData);

        // Refresh UI after unapply
        this._refreshUIAfterProposalChange(_getProposalRecord(proposalId));

        return true;
    },

    /**
     * Public: forcefully unapply a proposal and all of its descendants without any confirmation dialogs.
     * Traverses the dependency graph depth-first so children are unapplied before their parent.
     * 
     * NOTE: This function does NOT refresh UI - the caller is responsible for calling
     * _refreshUIAfterProposalChange() after all batch operations are complete.
     * This allows efficient bulk unapply without intermediate UI updates.
     */
    async unapplyWholeFamily(proposalId, visited = new Set()) {
        if (!proposalId || typeof proposalStorage === 'undefined') return;
        const proposalKey = String(proposalId);
        if (visited.has(proposalKey)) return;
        visited.add(proposalKey);

        const proposalData = _getProposalRecord(proposalKey);
        if (!proposalData) return;

        // Unapply all descendants first to avoid dependency prompts.
        // Use both _getAllDescendantProposals AND _getAllDescendants to cover all linked proposals
        const descendantProposals = this._getAllDescendantProposals(proposalKey) || [];
        const allDescendants = this._getAllDescendants(proposalKey) || [];
        // Filter allDescendants to just proposals (not parcels)
        const proposalDescendants = allDescendants.filter(id => _getProposalRecord(String(id)));
        const combinedDescendants = Array.from(new Set([...descendantProposals, ...proposalDescendants]));

        for (const childId of combinedDescendants) {
            await this.unapplyWholeFamily(childId, visited);
        }

        const isRoad = !!proposalData.roadProposal;
        const isBuilding = this._isBuildingProposal(proposalData);
        const isStructure = !!proposalData.structureProposal;
        const isReparcellization = !!proposalData.reparcellization;
        const isDecideLater = this._isDecideLaterProposal(proposalData);

        const currentStatus = (() => {
            if (isRoad) return proposalData.roadProposal?.status;
            if (isBuilding) return proposalData.buildingProposal?.status || proposalData.status;
            if (isStructure) return proposalData.structureProposal?.status || proposalData.status;
            if (isReparcellization) return proposalData.reparcellization?.status || proposalData.status;
            if (isDecideLater) return proposalData.decideLaterProposal?.status || proposalData.status;
            return proposalData.status;
        })();

        const normalizedStatus = (currentStatus || '').toLowerCase();
        if (normalizedStatus === 'unapplied') {
            await this._restoreReplacementSource(proposalKey, proposalData);
            return;
        }

        if (isRoad) {
            await this._unapplyProposalConfirmed(proposalKey);
        } else if (isBuilding) {
            await Promise.resolve(this._unapplyBuildingProposalConfirmed(proposalKey));
        } else if (isStructure) {
            await Promise.resolve(this._unapplyStructureProposalConfirmed(proposalKey));
        } else if (isReparcellization) {
            await Promise.resolve(this._unapplyReparcellizationProposalConfirmed(proposalKey));
        } else if (isDecideLater) {
            await Promise.resolve(this._unapplyDecideLaterProposalConfirmed(proposalKey));
        }
        await this._restoreReplacementSource(proposalKey, proposalData);
    },

    /**
     * Refresh all UI elements after a proposal state change.
     * This is called by callers (unapplyProposal, unapplyWholeFamily) rather than
     * embedded in business logic functions like _unapply*Confirmed.
     */
    _refreshUIAfterProposalChange(proposalData) {
        // Core proposal UI
        // The corridor parcel a road proposal creates has just appeared or vanished; its cross-section
        // has to follow. This is the one place both unapply paths meet — the direct one and the one
        // that runs later, inside the descendants-confirmation modal's callback.
        try { if (typeof scheduleCorridorStripRefresh === 'function') scheduleCorridorStripRefresh(); } catch (_) { }
        try { if (typeof refreshParcelStylesForAppliedProposals === 'function') refreshParcelStylesForAppliedProposals(); } catch (_) { }
        try { if (typeof updateProposalLayer === 'function') updateProposalLayer(); } catch (_) { }
        try { if (typeof updateProposalList === 'function') updateProposalList(); } catch (_) { }
        try { if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton(); } catch (_) { }
        try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }

        // Structure layers (parks, lakes, squares)
        try { if (typeof updateParksLayer === 'function') updateParksLayer(); } catch (_) { }
        try { if (typeof updateLakesLayer === 'function') updateLakesLayer(); } catch (_) { }
        try { if (typeof updateSquaresLayer === 'function') updateSquaresLayer(); } catch (_) { }

        // Building layers
        try { if (typeof updateProposedBuildingsLayer === 'function') updateProposedBuildingsLayer(); } catch (_) { }

        // Reparcellization layers
        try { if (typeof updateReparcellizationLayers === 'function') updateReparcellizationLayers(); } catch (_) { }

        // Refresh the proposals modal if it's open
        try {
            if (typeof showAllProposalsModal === 'function') {
                const modal = document.querySelector('.proposal-list-modal');
                if (modal && modal.style.display === 'block') {
                    showAllProposalsModal();
                }
            }
        } catch (_) { }

        // If a proposal is highlighted, update its panel/highlights
        if (proposalData && window.currentlyHighlightedProposalId &&
            String(window.currentlyHighlightedProposalId) === String(proposalData.proposalId)) {
            try {
                if (typeof selectAndHighlightProposal === 'function') {
                    selectAndHighlightProposal(proposalData.proposalId, window.selectedParcelInProposal, false, true);
                } else if (typeof showProposalInfo === 'function') {
                    showProposalInfo(proposalData, window.selectedParcelInProposal);
                }
                if (typeof applyProposalHighlights === 'function') {
                    applyProposalHighlights();
                }
            } catch (_) { }
        }

        // Refresh parcel info panel if it's open and showing an affected parcel
        try {
            if (proposalData && typeof window.selectedParcelId !== 'undefined' && window.selectedParcelId) {
                const affectedIds = [
                    ...(proposalData.parentParcelIds || []),
                    ...(proposalData.childParcelIds || [])
                ].map(id => id?.toString()).filter(Boolean);
                if (affectedIds.includes(window.selectedParcelId.toString())) {
                    if (typeof showParcelInfoPanel === 'function' && window.parcelLayer) {
                        const parcelLayer = window.parcelLayer.getLayers().find(l =>
                            _getParcelIdFromFeature(l.feature)?.toString() === window.selectedParcelId.toString()
                        );
                        if (parcelLayer) {
                            showParcelInfoPanel(parcelLayer.feature);
                        }
                    }
                }
            }
        } catch (_) { }
    },

    // Internal: perform unapply after confirmation
    async _unapplyProposalConfirmed(proposalId) {
        const proposalData = _getProposalRecord(proposalId);
        if (!proposalData || !proposalData.roadProposal) return;
        const roadProposal = proposalData.roadProposal;

        const descendantProposalIds = this._getAllDescendantProposals(proposalId);
        for (const childId of descendantProposalIds) {
            const childProposal = _getProposalRecord(childId);
            if (!childProposal || !childProposal.roadProposal) continue;
            if (childProposal.roadProposal.status === 'applied') {
                await this._unapplyProposalConfirmed(childId);
            }
        }

        const assets = this._loadRoadProposalAssets(proposalData, {
            includeParents: true,
            includeChildren: true,
            includeKeepDetails: true,
            allowMissing: true
        });

        let parentFeatures = Array.isArray(assets.parentFeatures) ? assets.parentFeatures : [];
        let childFeatures = Array.isArray(assets.childFeatures) ? assets.childFeatures : [];

        // Fallback: rebuild parents from ids if still missing (e.g., not cached but stored ids)
        const parentIds = this._collectParentParcelIds(roadProposal, proposalData);
        if (!parentFeatures.length && parentIds.length) {
            parentFeatures = this._resolveParcelFeaturesByIds(parentIds, { preferMap: true, allowStorage: true, fallbackToMap: true, allowMissing: true });
        }

        // Fetch missing ancestors if any are still unresolved, then retry resolution once
        if (parentIds.length) {
            const resolvedIds = new Set(parentFeatures.map(f => _getParcelIdFromFeature(f)?.toString()).filter(Boolean));
            const missingIds = parentIds.map(id => id && id.toString ? id.toString() : String(id)).filter(id => id && !resolvedIds.has(id));
            if (missingIds.length > 0 && typeof fetchParcelsForIds === 'function') {
                try {
                    await fetchParcelsForIds(missingIds, { forceRefresh: true });
                    const reloaded = this._resolveParcelFeaturesByIds(parentIds, { preferMap: true, allowStorage: true, fallbackToMap: true, allowMissing: true });
                    if (Array.isArray(reloaded) && reloaded.length > parentFeatures.length) {
                        parentFeatures = reloaded;
                    }
                } catch (err) {
                    console.warn('[_unapplyProposalConfirmed] Failed to fetch missing ancestor parcels', { missingIds, err });
                }
            }
            const remainingMissing = parentIds.filter(id => {
                const normalized = id && id.toString ? id.toString() : String(id || '');
                return normalized && !parentFeatures.some(f => _getParcelIdFromFeature(f)?.toString() === normalized);
            });
            if (remainingMissing.length > 0) {
                const message = `Missing ancestor parcels: ${remainingMissing.join(', ')}`;
                console.error(message);
                throw new Error(message);
            }
        }

        // Build a definitive list of descendant parcel ids from multiple sources (no cache dependency)
        const childFeatureById = new Map();
        const childIdsFromFeatures = childFeatures
            .map(f => _getParcelIdFromFeature(f))
            .filter(Boolean)
            .map(id => id.toString());
        childFeatures.forEach(feature => {
            const pid = _getParcelIdFromFeature(feature);
            if (pid !== undefined && pid !== null) {
                childFeatureById.set(pid.toString(), feature);
            }
        });
        const childIdsFromProposal = Array.isArray(proposalData.childParcelIds)
            ? proposalData.childParcelIds.map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)
            : [];
        const childIdsFromRoadProposal = Array.isArray(roadProposal?.childParcelIds)
            ? roadProposal.childParcelIds.map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)
            : [];
        const childIdsFromHelper = Array.isArray(this._getProposalChildParcels(proposalId))
            ? this._getProposalChildParcels(proposalId).map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)
            : [];
        const allChildIds = Array.from(new Set([
            ...childIdsFromFeatures,
            ...childIdsFromProposal,
            ...childIdsFromRoadProposal,
            ...childIdsFromHelper
        ]));

        // If we still have no child ids, nothing to remove; treat as already unapplied
        if (allChildIds.length === 0) {
            roadProposal.status = 'unapplied';
            proposalData.status = 'Active';
            this._restoreSupersededRoadSources(proposalId, proposalData);
            proposalStorage.save();
            console.warn('[_unapplyProposalConfirmed] No child parcel ids resolved; skipping removal', { proposalId, proposalHasChildIds: Array.isArray(proposalData.childParcelIds) && proposalData.childParcelIds.length });
            return;
        }

        // Remove new features from map when we have them
        if (childFeatures && childFeatures.length) {
            this._removeFeaturesFromMap(childFeatures);
        }

        // Always remove by id to cover cases with no cached features
        // But first, remove track rails layers if they exist (similar to _removeFeaturesFromMap)
        allChildIds.forEach(id => {
            // Remove track rails layers if they exist
            // Get it from the parcel layer on the map (most reliable)
            let trackRailsLayer = null;
            if (typeof window.resolveParcelLayerById === 'function') {
                const parcelLayer = window.resolveParcelLayerById(id);
                if (parcelLayer && parcelLayer.feature && parcelLayer.feature._trackRailsLayer) {
                    trackRailsLayer = parcelLayer.feature._trackRailsLayer;
                }
            }

            // Remove the track rails layer if found
            if (trackRailsLayer && window.map && window.map.hasLayer(trackRailsLayer)) {
                window.map.removeLayer(trackRailsLayer);
                trackRailsLayer = null;
            }

            if (typeof window.removeParcelLayerById === 'function') {
                window.removeParcelLayerById(id);
            }
        });

        // Remove new features from PersistentStorage
        allChildIds.forEach(parcelId => {
            const feature = childFeatureById.get(parcelId);
            if (feature && feature.properties) {
                _ensureParcelIdOnProperties(feature.properties, parcelId);
            }
            if (typeof clearPersistedParcelRecord === 'function') {
                clearPersistedParcelRecord(parcelId);
            }
            if (typeof window.removeRoadParcel === 'function') window.removeRoadParcel(parcelId);

            // Remove this proposal as ancestor of the parcel
            this._removeProposalAsAncestor(parcelId, proposalId);
            this._unmarkParcelModified(parcelId);
        });

        // Fetch parent features by ID (don't rely on stored parentFeatures)
        const parentParcelIds = this._collectParentParcelIds(roadProposal, proposalData);
        const parentFeaturesResolved = this._resolveParcelFeaturesByIds(parentParcelIds, { preferMap: true, allowStorage: true });

        // Show hidden parents first (they're in parcelLayerById but not visible)
        this._showFeaturesOnMap(parentFeaturesResolved);
        // If some parents weren't in parcelLayerById, add them via full add
        // IMPORTANT: pass proposalData so the descendant filter can exclude this proposal while it is being unapplied.
        this._addFeaturesToMap(parentFeaturesResolved, true, proposalData); // Pass true to use normal style

        // Restore original features to PersistentStorage
        const parentIdsForUnmark = [];
        parentFeaturesResolved.forEach(feature => {
            const parcelId = _getParcelIdFromFeature(feature);
            _ensureParcelIdOnProperties(feature.properties, parcelId);
            delete feature.properties.descendantProposal;
            if (typeof writePersistedParcelRecord === 'function') {
                writePersistedParcelRecord(parcelId, record => {
                    record.geometry = JSON.parse(JSON.stringify(feature.geometry));
                    record.properties = { ...feature.properties };
                    // No longer need to clear removedByProposal - visibility is calculated from parent/child relationships
                });
            }

            // If the original was a road, restore that too
            if (feature.properties.isRoad) {
                feature.properties.roadName = feature.properties.roadName || 'Unnamed Road';
                feature.properties.roadId = feature.properties.roadId || '';
                if (typeof window.addRoadParcel === 'function') window.addRoadParcel(parcelId);
            }
            parentIdsForUnmark.push(parcelId);
        });

        this._clearDescendantProposalOnParcels(parentIdsForUnmark, proposalId);
        Array.from(new Set(parentIdsForUnmark.map(id => id?.toString()))).forEach(id => this._unmarkParcelModified(id));

        // Clean up dependency tracking
        this._removeChildParcels(proposalId, allChildIds);
        roadProposal.childParcelIds = Array.from(new Set(allChildIds));

        roadProposal.status = 'unapplied';
        proposalData.status = 'Active'; // Update overall proposal status
        this._restoreSupersededRoadSources(proposalId, proposalData);
        proposalStorage.save();

        const removedParcels = allChildIds.length;
        const restoredParcels = parentFeaturesResolved.length;
        console.info('[ProposalManager] Unapplied road proposal', {
            proposalId,
            removedParcels,
            restoredParcels,
            type: 'road'
        });

        // UI refresh is now handled by the caller (unapplyProposal or unapplyWholeFamily)
        // to allow batch operations without intermediate UI updates
    },

    _unapplyDecideLaterProposalConfirmed(proposalId) {
        const proposalData = _getProposalRecord(proposalId);
        if (!proposalData) return false;

        const decideLaterState = proposalData.decideLaterProposal || {};
        const parentIds = Array.from(new Set([
            ...(Array.isArray(decideLaterState.parentParcelIds) ? decideLaterState.parentParcelIds : []),
            ...(Array.isArray(proposalData.parentParcelIds) ? proposalData.parentParcelIds : [])
        ].map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));
        const childIds = Array.from(new Set([
            ...(Array.isArray(decideLaterState.childParcelIds) ? decideLaterState.childParcelIds : []),
            ...(Array.isArray(proposalData.childParcelIds) ? proposalData.childParcelIds : [])
        ].map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));

        const childFeatures = childIds.length
            ? this._resolveParcelFeaturesByIds(childIds, { preferMap: true, allowStorage: true, allowMissing: true })
            : [];
        if (childFeatures.length) {
            this._removeFeaturesFromMap(childFeatures);
        }

        childIds.forEach(parcelId => {
            if (typeof clearPersistedParcelRecord === 'function') {
                clearPersistedParcelRecord(parcelId);
            }
            this._removeProposalAsAncestor(parcelId, proposalId);
            this._unmarkParcelModified(parcelId);
        });

        // No longer need to clear removedByProposal - visibility is calculated from parent/child relationships

        const parentFeatures = parentIds.length
            ? this._resolveParcelFeaturesByIds(parentIds, { preferMap: true, allowStorage: true, allowMissing: true })
            : [];
        if (parentFeatures.length) {
            // IMPORTANT: pass proposalData so the descendant filter can exclude this proposal while it is being unapplied.
            this._addFeaturesToMap(parentFeatures, true, proposalData);
            parentFeatures.forEach(feature => {
                const parcelId = _getParcelIdFromFeature(feature);
                _ensureParcelIdOnProperties(feature.properties, parcelId);
                if (typeof writePersistedParcelRecord === 'function') {
                    writePersistedParcelRecord(parcelId, record => {
                        record.geometry = JSON.parse(JSON.stringify(feature.geometry));
                        record.properties = { ...feature.properties };
                        record.removedByProposal = false;
                    });
                }
            });
        }

        this._clearDescendantProposalOnParcels(parentIds, proposalId);
        parentIds.forEach(id => this._unmarkParcelModified(id));
        this._removeChildParcels(proposalId, childIds, proposalData);

        proposalData.decideLaterProposal = {
            status: 'unapplied',
            parentParcelIds: parentIds,
            childParcelIds: []
        };
        proposalData.childParcelIds = Array.isArray(proposalData.childParcelIds)
            ? proposalData.childParcelIds.filter(id => !childIds.includes(id && id.toString ? id.toString() : String(id)))
            : [];
        proposalData.status = 'Active';
        proposalData.updatedAt = new Date().toISOString();

        if (typeof proposalStorage._indexProposal === 'function') {
            proposalStorage._indexProposal(proposalData);
        }
        if (proposalStorage.save) {
            proposalStorage.save();
        }

        const removedParcels = childIds.length;
        const restoredParcels = parentFeatures.length;
        console.info('[ProposalManager] Unapplied decide-later proposal', {
            proposalId,
            removedParcels,
            restoredParcels,
            type: 'decide-later'
        });

        // UI refresh is now handled by the caller (unapplyProposal or unapplyWholeFamily)
        // to allow batch operations without intermediate UI updates

        return true;
    },

    _unapplyBuildingProposalConfirmed(proposalId) {
        const proposalData = _getProposalRecord(proposalId);
        if (!proposalData) return false;

        const buildingProposal = proposalData.buildingProposal ? { ...proposalData.buildingProposal } : {};
        const parentIdsSource = Array.isArray(buildingProposal.parentParcelIds) && buildingProposal.parentParcelIds.length > 0
            ? buildingProposal.parentParcelIds
            : proposalData.parentParcelIds;
        const parentIds = Array.from(new Set((Array.isArray(parentIdsSource) ? parentIdsSource : []).map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));

        this._clearDescendantProposalOnParcels(parentIds, proposalId);

        if (typeof removeProposedBuildingFeature === 'function') {
            removeProposedBuildingFeature(proposalId, { updateLayer: true, save: true });
        } else if (typeof proposedBuildings !== 'undefined') {
            if (!Array.isArray(proposedBuildings)) proposedBuildings = [];
            const initialLength = proposedBuildings.length;
            for (let i = proposedBuildings.length - 1; i >= 0; i--) {
                const feature = proposedBuildings[i];
                if (feature && feature.properties && feature.properties.proposalId === proposalId) {
                    proposedBuildings.splice(i, 1);
                }
            }
            if (proposedBuildings.length !== initialLength) {
                if (typeof updateProposedBuildingsLayer === 'function') updateProposedBuildingsLayer();
                if (typeof saveExecutedBuildingsToStorage === 'function') saveExecutedBuildingsToStorage();
            }
        }

        if (typeof markProposedBuildingState === 'function') {
            markProposedBuildingState(proposalId, 'unapplied', { updateLayer: false, save: true });
            if (typeof updateProposedBuildingsLayer === 'function') updateProposedBuildingsLayer();
        }

        buildingProposal.status = 'unapplied';
        buildingProposal.appliedAt = null;
        proposalData.buildingProposal = buildingProposal;

        if (proposalData.executedAt) {
            delete proposalData.executedAt;
        }
        proposalData.status = 'Active';
        proposalData.updatedAt = new Date().toISOString();

        proposalData.proposalId = proposalData.proposalId || proposalId;
        if (typeof proposalStorage._indexProposal === 'function') {
            proposalStorage._indexProposal(proposalData);
        } else {
            proposalStorage.proposals.set(proposalData.proposalId, proposalData);
        }
        proposalStorage.save();

        console.info('[ProposalManager] Unapplied building proposal', {
            proposalId,
            removedParcels: 0,
            restoredParcels: 0,
            type: 'building'
        });

        // UI refresh is now handled by the caller (unapplyProposal or unapplyWholeFamily)
        // to allow batch operations without intermediate UI updates

        return true;
    },

    _unapplyStructureProposalConfirmed(proposalId) {
        const proposalData = _getProposalRecord(proposalId);
        if (!proposalData || !proposalData.structureProposal) return false;
        const sp = proposalData.structureProposal;
        const kind = (sp.kind === 'park' || sp.kind === 'square' || sp.kind === 'lake') ? sp.kind : 'square';
        const blockName = sp.blockName || null;
        const normalizedProposalId = proposalId && proposalId.toString ? proposalId.toString() : (proposalId === 0 ? '0' : String(proposalId || ''));

        try {
            let removedParcels = 0;
            if (kind === 'park') {
                if (Array.isArray(window.parks)) {
                    const before = window.parks.length;
                    window.parks = window.parks.filter(f => {
                        const featureProposalId = f && f.properties
                            ? (f.properties.proposalId && f.properties.proposalId.toString ? f.properties.proposalId.toString() : String(f.properties.proposalId || ''))
                            : null;
                        return featureProposalId !== normalizedProposalId;
                    });
                    removedParcels += Math.max(0, before - window.parks.length);
                    if (before !== window.parks.length) {
                        try { PersistentStorage.setItem('cb_parks', JSON.stringify(window.parks)); } catch (_) { }
                        try { if (typeof updateParksLayer === 'function') updateParksLayer(); } catch (_) { }
                    }
                }
            } else if (kind === 'lake') {
                if (Array.isArray(window.lakes)) {
                    const before = window.lakes.length;
                    window.lakes = window.lakes.filter(f => {
                        const featureProposalId = f && f.properties
                            ? (f.properties.proposalId && f.properties.proposalId.toString ? f.properties.proposalId.toString() : String(f.properties.proposalId || ''))
                            : null;
                        return featureProposalId !== normalizedProposalId;
                    });
                    removedParcels += Math.max(0, before - window.lakes.length);
                    if (before !== window.lakes.length) {
                        try { PersistentStorage.setItem('cb_lakes', JSON.stringify(window.lakes)); } catch (_) { }
                        try { if (typeof updateLakesLayer === 'function') updateLakesLayer(); } catch (_) { }
                    }
                }
            } else {
                if (Array.isArray(window.squares)) {
                    const before = window.squares.length;
                    window.squares = window.squares.filter(f => {
                        const featureProposalId = f && f.properties
                            ? (f.properties.proposalId && f.properties.proposalId.toString ? f.properties.proposalId.toString() : String(f.properties.proposalId || ''))
                            : null;
                        return featureProposalId !== normalizedProposalId;
                    });
                    removedParcels += Math.max(0, before - window.squares.length);
                    if (before !== window.squares.length) {
                        try { PersistentStorage.setItem('cb_squares', JSON.stringify(window.squares)); } catch (_) { }
                        try { if (typeof updateSquaresLayer === 'function') updateSquaresLayer(); } catch (_) { }
                    }
                }
            }

            // Unmark modified and unlink ancestor parcels (no parcel restoration needed)
            const parentIds = Array.from(new Set([
                ...(Array.isArray(sp.parentParcelIds) ? sp.parentParcelIds : []),
                ...(Array.isArray(proposalData.parentParcelIds) ? proposalData.parentParcelIds : []),
            ].map(id => id && id.toString ? id.toString() : (id !== undefined && id !== null ? String(id) : null)).filter(Boolean)));
            const uniqueParents = Array.from(new Set(parentIds));

            this._clearDescendantProposalOnParcels(uniqueParents, proposalId);
            uniqueParents.forEach(id => this._unmarkParcelModified(id));

            // Update status
            sp.status = 'unapplied';
            proposalData.structureProposal = sp;
            proposalData.status = 'Active';
            proposalData.proposalId = proposalData.proposalId || proposalId;
            if (typeof proposalStorage._indexProposal === 'function') {
                proposalStorage._indexProposal(proposalData);
            } else {
                proposalStorage.proposals.set(proposalData.proposalId, proposalData);
            }
            if (proposalStorage.save) proposalStorage.save();

            console.info('[ProposalManager] Unapplied structure proposal', {
                proposalId,
                removedParcels,
                restoredParcels: 0,
                type: kind
            });

            // UI refresh is now handled by the caller (unapplyProposal or unapplyWholeFamily)
            // to allow batch operations without intermediate UI updates

            return true;
        } catch (e) {
            console.warn('Failed to unapply structure proposal', e);
            return false;
        }
    },

    _unapplyReparcellizationProposalConfirmed(proposalId) {
        const proposalData = _getProposalRecord(proposalId);
        if (!proposalData || !proposalData.reparcellization) {
            return false;
        }
        const idLabel = _normalizeProposalId(proposalId) || 'unknown-proposal';
        const plan = proposalData.reparcellization;
        const parentIds = Array.from(new Set([
            ...(Array.isArray(plan.parentParcelIds) ? plan.parentParcelIds : []),
            ...(Array.isArray(proposalData.parentParcelIds) ? proposalData.parentParcelIds : [])
        ].map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));
        const childIds = Array.from(new Set([
            ...(Array.isArray(plan.childParcelIds) ? plan.childParcelIds : []),
            ...(Array.isArray(proposalData.childParcelIds) ? proposalData.childParcelIds : [])
        ].map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));

        this._clearDescendantProposalOnParcels(parentIds, proposalId);

        // Remove new parcels from map and storage
        const childFeatures = childIds.length
            ? this._resolveParcelFeaturesByIds(childIds, { preferMap: true, allowStorage: true, allowMissing: true })
            : [];
        if (childFeatures.length) {
            this._removeFeaturesFromMap(childFeatures);
        }
        childIds.forEach(parcelId => {
            if (typeof window.removeParcelLayerById === 'function') {
                window.removeParcelLayerById(parcelId);
            }
            if (typeof clearPersistedParcelRecord === 'function') {
                clearPersistedParcelRecord(parcelId);
            }
            this._removeProposalAsAncestor(parcelId, proposalId);
            this._unmarkParcelModified(parcelId);
        });

        // Restore ancestors
        let parentFeatures = parentIds.length
            ? this._resolveParcelFeaturesByIds(parentIds, { preferMap: true, allowStorage: true, allowMissing: true })
            : [];
        if ((!parentFeatures || !parentFeatures.length) && parentIds.length && typeof fetchParcelsForIds === 'function') {
            try {
                fetchParcelsForIds(parentIds, { forceRefresh: true });
                parentFeatures = this._resolveParcelFeaturesByIds(parentIds, { preferMap: true, allowStorage: true, allowMissing: true });
            } catch (err) {
                console.warn('[_unapplyReparcellizationProposalConfirmed] Failed to fetch parent parcels', err);
            }
        }
        if (parentFeatures.length) {
            this._showFeaturesOnMap(parentFeatures);
            this._addFeaturesToMap(parentFeatures, true, proposalData);
            parentFeatures.forEach(feature => {
                const parcelId = _getParcelIdFromFeature(feature);
                _ensureParcelIdOnProperties(feature.properties, parcelId);
                delete feature.properties.descendantProposal;
                if (typeof writePersistedParcelRecord === 'function') {
                    writePersistedParcelRecord(parcelId, record => {
                        record.geometry = JSON.parse(JSON.stringify(feature.geometry));
                        record.properties = { ...feature.properties };
                    });
                }
                this._unmarkParcelModified(parcelId);
            });
        }

        this._removeReparcellizationLayer(proposalId);
        this._removeChildParcels(proposalId, childIds, proposalData);

        plan.status = 'unapplied';
        if (plan.appliedAt) {
            delete plan.appliedAt;
        }
        plan.childParcelIds = [];
        proposalData.childParcelIds = [];

        if (typeof isAppliedStatus === 'function') {
            if (isAppliedStatus(proposalData.status)) {
                proposalData.status = 'Active';
            }
        } else if ((proposalData.status || '').toLowerCase() === 'applied') {
            proposalData.status = 'Active';
        }
        proposalData.updatedAt = new Date().toISOString();

        proposalData.proposalId = proposalData.proposalId || proposalId;
        if (typeof proposalStorage._indexProposal === 'function') {
            proposalStorage._indexProposal(proposalData);
        } else {
            proposalStorage.proposals.set(proposalData.proposalId, proposalData);
        }
        if (typeof proposalStorage.save === 'function') {
            proposalStorage.save();
        }

        if (typeof updateStatus === 'function') {
            updateStatus(`Removed reparcellization proposal ${proposalData.title || idLabel} from the map.`);
        }

        console.info('[ProposalManager] Unapplied reparcellization proposal', {
            proposalId,
            removedParcels: childIds.length,
            restoredParcels: parentFeatures.length,
            type: 'reparcellization'
        });

        // UI refresh is now handled by the caller (unapplyProposal or unapplyWholeFamily)
        // to allow batch operations without intermediate UI updates

        return true;
    },

    deleteProposal(proposalId) {
        if (typeof proposalStorage === 'undefined') return false;

        const proposalData = _getProposalRecord(proposalId);
        if (!proposalData) return false;

        const isRoad = !!proposalData.roadProposal;
        const isBuilding = this._isBuildingProposal(proposalData);
        const isStructure = !!(proposalData && proposalData.structureProposal);
        const isReparcellization = !!(proposalData && proposalData.reparcellization);

        const allDescendants = this._getAllDescendants(proposalId);
        if (allDescendants.length > 0) {
            this._showDescendantsConfirmModal({
                action: 'delete',
                proposalId,
                descendants: allDescendants,
                onConfirm: () => this._deleteProposalConfirmed(proposalId)
            });
            return false;
        }

        this._deleteProposalConfirmed(proposalId);
        return true;
    },

    // Internal: perform delete after confirmation
    async _deleteProposalConfirmed(proposalId) {
        try {
            const proposalData = _getProposalRecord(proposalId);
            if (!proposalData) return false;

            const isRoad = !!proposalData.roadProposal;
            const roadProposal = isRoad ? proposalData.roadProposal : null;
            const isBuilding = this._isBuildingProposal(proposalData);
            const isStructure = !!(proposalData && proposalData.structureProposal);
            const isReparcellization = !!(proposalData && proposalData.reparcellization);

            // If road proposal is applied, unapply FIRST and await completion.
            // Otherwise we can end up deleting the proposal record while unapply is still running,
            // leaving road geometries orphaned on the map and/or duplicating restored parent parcels.
            if (isRoad && roadProposal && _isAppliedStatusLike(roadProposal.status)) {
                try {
                    await this._unapplyProposalConfirmed(proposalId);
                } catch (err) {
                    // Surface warning but continue deletion to avoid trapping proposals
                    if (err && err.message && typeof updateStatus === 'function') {
                        try { updateStatus(`${err.message} (deleted anyway)`); } catch (_) { }
                    }
                    console.error('[ProposalManager.deleteProposal] Unapply failed; deleting anyway to avoid stuck proposal', err);
                }
            }

            if (isBuilding && proposalData.buildingProposal && proposalData.buildingProposal.status !== 'unapplied') {
                try {
                    this._unapplyBuildingProposalConfirmed(proposalId);
                } catch (err) {
                    console.warn('[ProposalManager.deleteProposal] Building unapply failed; deleting anyway', err);
                }
            }

            if (isStructure && proposalData.structureProposal) {
                try {
                    if ((proposalData.structureProposal.status || '').toLowerCase() === 'applied') {
                        this._unapplyStructureProposalConfirmed(proposalId);
                    }
                    // Remove lingering graphics even if status got out of sync
                    this._unapplyStructureProposalConfirmed(proposalId);
                } catch (err) {
                    console.warn('[ProposalManager.deleteProposal] Structure unapply failed; deleting anyway', err);
                }
            }

            if (isReparcellization && proposalData.reparcellization && (proposalData.reparcellization.status || '').toLowerCase() === 'applied') {
                try {
                    this._unapplyReparcellizationProposalConfirmed(proposalId);
                } catch (err) {
                    console.warn('[ProposalManager.deleteProposal] Reparcellization unapply failed; deleting anyway', err);
                }
            }

            if (isRoad) {
                const childParcelIds = (proposalData.childParcelIds || [])
                    .map(id => id && id.toString ? id.toString() : String(id))
                    .filter(Boolean);
                this._removeChildParcels(proposalId, childParcelIds);

                childParcelIds.forEach(parcelId => {
                    this._removeProposalAsAncestor(parcelId, proposalId);
                });

                try {
                    const parentParcelIds = this._collectParentParcelIds(roadProposal, proposalData);
                    const uniqueParentParcelIds = Array.from(new Set(parentParcelIds.map(id => id?.toString()).filter(Boolean)));
                    uniqueParentParcelIds.forEach(parcelId => {
                        const ancestorHashes = this._getParcelAncestors(parcelId);
                        ancestorHashes.forEach(ancestorHash => {
                            if (String(ancestorHash) !== String(proposalId)) {
                                this._removeChildProposalLink(ancestorHash, proposalId);
                            }
                        });
                    });
                } catch (_) { }
            }

            if (isBuilding) {
                try {
                    const parentParcelIds = proposalData.buildingProposal && Array.isArray(proposalData.buildingProposal.parentParcelIds)
                        ? proposalData.buildingProposal.parentParcelIds
                        : proposalData.parentParcelIds;
                    const uniqueParentParcelIds = Array.from(new Set((parentParcelIds || []).map(id => id && id.toString ? id.toString() : String(id))));
                    uniqueParentParcelIds.forEach(parcelId => {
                        const ancestorHashes = this._getParcelAncestors(parcelId);
                        ancestorHashes.forEach(ancestorHash => {
                            if (String(ancestorHash) !== String(proposalId)) {
                                this._removeChildProposalLink(ancestorHash, proposalId);
                            }
                        });
                    });
                } catch (_) { }
            }

            this._clearChildProposalLinks(proposalId);

            if (typeof proposalStorage.removeProposal === 'function') {
                proposalStorage.removeProposal(proposalId);
            } else if (typeof proposalStorage.deleteProposal === 'function') {
                // Fallback if legacy name exists
                proposalStorage.deleteProposal(proposalId);
            }

            // Update show proposals button
            if (typeof updateShowProposalsButton === 'function') {
                updateShowProposalsButton();
            }

            // Clear selection visuals when the deleted proposal was the selected one. Key-based
            // comparison (the object identity check missed hash/id mismatches and left the blue
            // outline + node handles behind until the next click).
            const selectedKey = (typeof window !== 'undefined')
                ? (window.ProposalSelection?.getKey?.() || window.currentlyHighlightedProposal?.proposalId || null)
                : null;
            if (selectedKey && String(selectedKey) === String(proposalId)) {
                if (typeof clearProposalHighlights === 'function') clearProposalHighlights();
                try { window.ProposalSelection?.clear?.(); } catch (_) { }
                try { if (typeof hideProposalDetailsPanel === 'function') hideProposalDetailsPanel(); } catch (_) { }
            }
            try { if (typeof clearProposalPreviewLayers === 'function') clearProposalPreviewLayers(); } catch (_) { }

            // Update visual layers and lists
            if (typeof updateProposalLayer === 'function') updateProposalLayer();
            if (typeof updateProposalList === 'function') updateProposalList();

            // Hide proposal info panel if it's showing the deleted proposal
            try {
                const parcelInfoPanel = document.getElementById('parcel-info-panel');
                if (parcelInfoPanel && parcelInfoPanel.classList.contains('visible')) {
                    const panelTitle = document.querySelector('#parcel-info-panel h3');
                    if (panelTitle && panelTitle.textContent === 'Proposal Details') {
                        if (typeof hideParcelInfoPanel === 'function') hideParcelInfoPanel();
                    }
                }
            } catch (_) { }

            // Status
            if (typeof updateStatus === 'function') {
                const title = proposalData?.title || 'Proposal';
                updateStatus(`Proposal "${title}" deleted`);
            }

            return true;
        } catch (error) {
            console.error('Error deleting proposal:', error);
            return false;
        }
    },

    // UI: Show a modal with the full list of descendants and ask for confirmation
    _showDescendantsConfirmModal({ action, proposalId, descendants, onConfirm }) {
        try {
            // Remove any existing modal
            const existing = document.querySelector('.descendants-confirm-modal');
            if (existing) existing.remove();

            const proposalData = _getProposalRecord(proposalId);
            const titleAction = action === 'delete' ? 'Delete Proposal' : 'Un-apply Proposal';
            const verb = action === 'delete' ? 'delete' : 'un-apply';

            // Build rich list entries with best-effort details
            const items = (descendants || []).map(id => {
                const idStr = String(id);
                // If it's a proposal hash
                const maybeProposal = _getProposalRecord(idStr);
                if (maybeProposal) {
                    return {
                        kind: 'proposal',
                        id: idStr,
                        label: maybeProposal.title || idStr,
                        extra: maybeProposal.goal ? `(${maybeProposal.goal})` : ''
                    };
                }

                let broj = null; let isRoad = false; let roadName = null;

                // Prefer current map layer data if available
                if (typeof window.resolveParcelLayerById === 'function') {
                    const layer = window.resolveParcelLayerById(idStr, { includeRemoved: true });
                    const props = layer?.feature?.properties;
                    if (props) {
                        broj = props.BROJ_CESTICE || broj;
                        isRoad = isRoad || !!props.isRoad;
                        roadName = roadName || props.roadName || null;
                    }
                }

                // Fallback to PersistentStorage
                if (!broj) {
                    try {
                        const props = (typeof readPersistedParcelRecord === 'function'
                            ? readPersistedParcelRecord(idStr)?.properties
                            : null);
                        if (props) {
                            broj = props.BROJ_CESTICE || broj;
                            isRoad = isRoad || !!props.isRoad;
                            roadName = roadName || props.roadName || null;
                        }
                    } catch (_) { }
                }

                // Fallback to map layer
                if (!broj && typeof multiParcelSelection !== 'undefined' && multiParcelSelection.findParcelById) {
                    try {
                        const layer = multiParcelSelection.findParcelById(idStr);
                        if (layer && layer.feature?.properties) {
                            broj = layer.feature.properties.BROJ_CESTICE || broj;
                            isRoad = isRoad || !!layer.feature.properties.isRoad;
                            roadName = roadName || layer.feature.properties.roadName || null;
                        }
                    } catch (_) { }
                }

                const base = broj ? `Parcel ${broj}` : `Parcel ${idStr}`;
                const extra = isRoad ? (roadName ? ` • Road: ${roadName}` : ' • Road') : '';
                return { kind: 'parcel', id: idStr, label: base, extra };
            });

            const counts = items.reduce((acc, it) => { acc[it.kind]++; return acc; }, { parcel: 0, proposal: 0 });

            const modal = document.createElement('div');
            modal.className = 'descendants-confirm-modal';
            modal.style.cssText = `
                position: fixed;
                inset: 0;
                background: rgba(0,0,0,0.5);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 15000;
            `;

            const listHtml = items.map(it => `
                <div class="desc-item" style="display:flex;align-items:center;gap:8px;padding:8px;border:1px solid #e0e0e0;border-radius:6px;margin-bottom:6px;">
                    <span class="badge" style="font-size:11px;padding:2px 6px;border-radius:10px;background:${it.kind === 'proposal' ? '#e3f2fd' : '#f1f8e9'};color:${it.kind === 'proposal' ? '#1565c0' : '#2e7d32'};text-transform:uppercase;">${it.kind}</span>
                    <span style="font-weight:600;color:#333;">${it.label}</span>
                    <span style="color:#666;">${it.extra || ''}</span>
                </div>
            `).join('');

            modal.innerHTML = `
                <div class="descendants-confirm-content" style="background:#fff;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,0.25);width:min(680px,90vw);max-height:80vh;display:flex;flex-direction:column;">
                    <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #eee;">
                        <h3 style="margin:0;font-size:18px;color:#333;">${titleAction}</h3>
                        <button type="button" title="Close" class="descendants-close close-circle-btn close-circle-btn--lg" aria-label="Close descendants modal">&times;</button>
                    </div>
                    <div style="padding:16px 20px;">
                        <p style="margin:0 0 10px;color:#444;">This proposal has dependent items. The following will be removed from map and storage if you ${verb} it:</p>
                        <div style="color:#666;font-size:13px;margin-bottom:12px;">${counts.parcel} parcel${counts.parcel === 1 ? '' : 's'}${counts.proposal ? ` • ${counts.proposal} proposal${counts.proposal === 1 ? '' : 's'}` : ''}</div>
                        <div style="max-height:45vh;overflow:auto;padding-right:4px;">${listHtml || '<em style="color:#666;">No items found.</em>'}</div>
                    </div>
                    <div style="display:flex;justify-content:flex-end;gap:10px;padding:12px 16px;border-top:1px solid #eee;background:#fafafa;">
                        <button class="btn-cancel" style="padding:8px 14px;border:1px solid #ccc;background:#fff;border-radius:6px;color:#333;cursor:pointer;">Cancel</button>
                        <button class="btn-confirm" style="padding:8px 14px;border:1px solid #c62828;background:#d32f2f;color:#fff;border-radius:6px;cursor:pointer;">${titleAction}</button>
                    </div>
                </div>
            `;

            document.body.appendChild(modal);

            const close = () => { try { modal.remove(); } catch (_) { } };
            const confirmBtn = modal.querySelector('.btn-confirm');
            const cancelBtn = modal.querySelector('.btn-cancel');
            const originalConfirmLabel = confirmBtn ? confirmBtn.innerHTML : '';
            let busy = false;

            const setBusy = (state) => {
                busy = state;
                if (confirmBtn) {
                    confirmBtn.disabled = state;
                    confirmBtn.style.opacity = state ? '0.8' : '';
                    confirmBtn.style.cursor = state ? 'wait' : '';
                    confirmBtn.innerHTML = state
                        ? `<i class="fas fa-spinner fa-spin"></i> ${titleAction}`
                        : originalConfirmLabel;
                }
                if (cancelBtn) {
                    cancelBtn.disabled = state;
                    cancelBtn.style.opacity = state ? '0.6' : '';
                    cancelBtn.style.cursor = state ? 'not-allowed' : '';
                }
            };

            modal.addEventListener('click', (e) => { if (!busy && e.target === modal) close(); });
            modal.querySelector('.descendants-close')?.addEventListener('click', () => { if (!busy) close(); });
            cancelBtn?.addEventListener('click', () => { if (!busy) close(); });
            confirmBtn?.addEventListener('click', async () => {
                if (busy) return;
                setBusy(true);
                try {
                    if (typeof onConfirm === 'function') {
                        await onConfirm();
                    }
                    close();
                } catch (err) {
                    console.warn('Descendants confirm failed', err);
                    close();
                }
            });

            // ESC to close (disabled while busy)
            const onKey = (e) => { if (!busy && e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
            document.addEventListener('keydown', onKey);
        } catch (e) {
            // Fallback to confirm if modal fails for any reason
            const count = Array.isArray(descendants) ? descendants.length : 0;
            if (confirm(`This proposal has ${count} dependent item(s). Continue to ${action}?`)) {
                if (typeof onConfirm === 'function') onConfirm();
            }
        }
    },

    _removeFeaturesFromMap(features) {
        // Use the standard removeParcelLayerById function for each feature
        // This is the same function used elsewhere in the codebase and works correctly
        if (!features || !Array.isArray(features)) {
            return;
        }

        features.forEach(feature => {
            const parcelId = _getParcelIdFromFeature(feature);
            if (parcelId !== undefined && parcelId !== null) {
                // Remove track rails layers if they exist
                // First try to get it from the parcel layer on the map (most reliable)
                // This handles the case where the feature object is a fresh load from storage
                let trackRailsLayer = null;
                if (typeof window.resolveParcelLayerById === 'function') {
                    const parcelLayer = window.resolveParcelLayerById(parcelId);
                    if (parcelLayer && parcelLayer.feature && parcelLayer.feature._trackRailsLayer) {
                        trackRailsLayer = parcelLayer.feature._trackRailsLayer;
                    }
                }

                // Fallback: try to get it from the feature object (if available)
                if (!trackRailsLayer && feature._trackRailsLayer) {
                    trackRailsLayer = feature._trackRailsLayer;
                }

                // Remove the track rails layer if found
                if (trackRailsLayer && window.map && window.map.hasLayer(trackRailsLayer)) {
                    window.map.removeLayer(trackRailsLayer);
                    trackRailsLayer = null;
                }

                // Use the standard removal function
                if (typeof window.removeParcelLayerById === 'function') {
                    window.removeParcelLayerById(parcelId);
                }
            }
        });

        // Refresh parcel number labels if visible
        if (typeof refreshParcelNumberLabelsIfVisible === 'function') {
            refreshParcelNumberLabelsIfVisible();
        }

        // Update visible parcel count if function exists
        if (typeof updateVisibleParcelsCount === 'function') {
            updateVisibleParcelsCount();
        }
    },

    /**
     * Hide parent features from visible parcelLayer but keep them in parcelLayerById.
     * Use this when hiding parents that may still be needed as parents for descendant proposals.
     */
    _hideFeaturesFromMap(features) {
        if (!features || !Array.isArray(features)) {
            return;
        }

        features.forEach(feature => {
            const parcelId = _getParcelIdFromFeature(feature);
            if (parcelId !== undefined && parcelId !== null) {
                // Hide using the new function that keeps entry in parcelLayerById
                if (typeof window.hideParcelLayerById === 'function') {
                    window.hideParcelLayerById(parcelId);
                } else if (typeof window.parcelLayer !== 'undefined' && typeof window.resolveParcelLayerById === 'function') {
                    // Fallback: directly remove from parcelLayer only
                    const layer = window.resolveParcelLayerById(parcelId);
                    if (layer && window.parcelLayer && window.parcelLayer.hasLayer(layer)) {
                        // Clean up attached overlay layers before removing
                        if (layer._roadCenterlineLayer && window.map && window.map.hasLayer(layer._roadCenterlineLayer)) {
                            window.map.removeLayer(layer._roadCenterlineLayer);
                            layer._roadCenterlineLayer = null;
                        }
                        window.parcelLayer.removeLayer(layer);
                    }
                }
            }
        });

        // Refresh parcel number labels if visible
        if (typeof refreshParcelNumberLabelsIfVisible === 'function') {
            refreshParcelNumberLabelsIfVisible();
        }

        // Update visible parcel count if function exists
        if (typeof updateVisibleParcelsCount === 'function') {
            updateVisibleParcelsCount();
        }
    },

    /**
     * Show hidden parent features on parcelLayer (add back to visible layer from parcelLayerById).
     * Use this when unapplying a proposal to make parents visible again.
     */
    _showFeaturesOnMap(features) {
        if (!features || !Array.isArray(features)) {
            return;
        }

        features.forEach(feature => {
            const parcelId = _getParcelIdFromFeature(feature);
            if (parcelId !== undefined && parcelId !== null) {
                // Show using the new function that adds back to parcelLayer from parcelLayerById
                if (typeof window.showParcelLayerById === 'function') {
                    window.showParcelLayerById(parcelId);
                } else if (typeof window.parcelLayer !== 'undefined' && typeof window.resolveParcelLayerById === 'function') {
                    // Fallback: directly add to parcelLayer
                    const layer = window.resolveParcelLayerById(parcelId);
                    if (layer && window.parcelLayer && !window.parcelLayer.hasLayer(layer)) {
                        window.parcelLayer.addLayer(layer);
                    }
                }
            }
        });

        // Refresh parcel number labels if visible
        if (typeof refreshParcelNumberLabelsIfVisible === 'function') {
            refreshParcelNumberLabelsIfVisible();
        }

        // Update visible parcel count if function exists
        if (typeof updateVisibleParcelsCount === 'function') {
            updateVisibleParcelsCount();
        }
    },

    _getActiveMap() {
        if (typeof map !== 'undefined' && map && typeof map.addLayer === 'function') {
            return map;
        }
        if (typeof window !== 'undefined' && window.map && typeof window.map.addLayer === 'function') {
            return window.map;
        }
        return null;
    },

    _ensureReparcellizationRootLayer() {
        if (typeof L === 'undefined') {
            return null;
        }
        const activeMap = this._getActiveMap();
        if (!activeMap) {
            return null;
        }
        if (!this._reparcellizationRootLayer) {
            this._reparcellizationRootLayer = L.layerGroup();
        }
        if (!activeMap.hasLayer(this._reparcellizationRootLayer)) {
            this._reparcellizationRootLayer.addTo(activeMap);
        }
        return this._reparcellizationRootLayer;
    },

    _removeReparcellizationLayer(proposalId) {
        if (!proposalId) return;
        const layerGroup = this._reparcellizationLayers.get(proposalId);
        if (!layerGroup) return;

        const rootLayer = this._reparcellizationRootLayer;
        if (rootLayer && typeof rootLayer.removeLayer === 'function' && rootLayer.hasLayer(layerGroup)) {
            rootLayer.removeLayer(layerGroup);
        }

        const activeMap = this._getActiveMap();
        if (activeMap && typeof activeMap.removeLayer === 'function' && activeMap.hasLayer(layerGroup)) {
            activeMap.removeLayer(layerGroup);
        }

        if (typeof layerGroup.remove === 'function') {
            layerGroup.remove();
        } else {
            try {
                layerGroup.eachLayer(layer => {
                    if (layer && typeof layer.remove === 'function') {
                        layer.remove();
                    }
                });
            } catch (_) { }
        }

        this._reparcellizationLayers.delete(proposalId);

        if (rootLayer && typeof rootLayer.getLayers === 'function' && rootLayer.getLayers().length === 0) {
            if (activeMap && typeof activeMap.removeLayer === 'function' && activeMap.hasLayer(rootLayer)) {
                activeMap.removeLayer(rootLayer);
            }
            this._reparcellizationRootLayer = null;
        }
    },

    _renderReparcellizationPlan(plan, proposalId) {
        if (!plan || !Array.isArray(plan.polygons) || plan.polygons.length === 0) {
            return null;
        }
        if (typeof L === 'undefined') {
            return null;
        }

        const rootLayer = this._ensureReparcellizationRootLayer();
        if (!rootLayer) {
            return null;
        }

        if (proposalId) {
            this._removeReparcellizationLayer(proposalId);
        }

        const group = L.layerGroup();
        plan.polygons.forEach(slice => {
            if (!slice || !slice.geometry) return;
            try {
                const feature = {
                    type: 'Feature',
                    geometry: slice.geometry,
                    properties: {
                        ownerKey: slice.ownerKey || null,
                        displayName: slice.displayName || null,
                        percent: slice.percent || null,
                        color: slice.color || null,
                        proposalId: proposalId || null
                    }
                };
                const fillColor = slice.color || '#2563EB';
                const layer = L.geoJSON(feature, {
                    interactive: false,
                    style: () => ({
                        color: fillColor,
                        weight: 2,
                        fillColor,
                        fillOpacity: 0.35,
                        dashArray: '4 4'
                    })
                });
                layer.addTo(group);
            } catch (error) {
                console.warn('Failed to render reparcellization slice', error);
            }
        });

        if (group.getLayers().length === 0) {
            return null;
        }

        if (typeof rootLayer.addLayer === 'function') {
            rootLayer.addLayer(group);
        }
        if (proposalId) {
            this._reparcellizationLayers.set(proposalId, group);
        }
        if (typeof rootLayer.bringToFront === 'function') {
            rootLayer.bringToFront();
        }
        return group;
    },

    _addFeaturesToMap(features, useNormalStyle = false, proposalData = null) {
        if (!window.parcelLayer) {
            window.parcelLayer = L.featureGroup();
            // Only add to map if zoom is appropriate
            const isZoomAppropriate = typeof isZoomWithinParcelRange === 'function'
                ? isZoomWithinParcelRange()
                : map.getZoom() >= 15; // Default threshold
            if (isZoomAppropriate) {
                window.parcelLayer.addTo(map);
            }
        } else {
            // If parcelLayer exists but is not on map, check if we should add it
            if (!map.hasLayer(window.parcelLayer)) {
                const isZoomAppropriate = typeof isZoomWithinParcelRange === 'function'
                    ? isZoomWithinParcelRange()
                    : map.getZoom() >= 15; // Default threshold
                if (isZoomAppropriate) {
                    window.parcelLayer.addTo(map);
                }
            }
        }

        // Create SVG pattern for striped roads (only once)
        if (!document.getElementById('proposal-road-pattern')) {
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('id', 'proposal-road-pattern-svg');
            svg.style.position = 'absolute';
            svg.style.width = '0';
            svg.style.height = '0';

            const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
            const pattern = document.createElementNS('http://www.w3.org/2000/svg', 'pattern');
            pattern.setAttribute('id', 'proposal-road-pattern');
            pattern.setAttribute('patternUnits', 'userSpaceOnUse');
            pattern.setAttribute('width', '10');
            pattern.setAttribute('height', '10');
            pattern.setAttribute('patternTransform', 'rotate(45)');

            const rect1 = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect1.setAttribute('width', '5');
            rect1.setAttribute('height', '10');
            rect1.setAttribute('fill', '#2d5016'); // Dark green

            const rect2 = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect2.setAttribute('x', '5');
            rect2.setAttribute('width', '5');
            rect2.setAttribute('height', '10');
            rect2.setAttribute('fill', '#3d6a1f'); // Lighter green

            pattern.appendChild(rect1);
            pattern.appendChild(rect2);
            defs.appendChild(pattern);
            svg.appendChild(defs);
            document.body.appendChild(svg);
        }

        const proposalRoadStyle = {
            fillColor: '#2d5016', // Dark green for proposed roads
            fillOpacity: 0.8,
            color: '#1a3d0a',
            weight: 2,
            dashArray: '5, 5'
        };

        const proposalParcelStyle = {
            fillColor: '#FFD700', // Gold for proposed parcels
            fillOpacity: 0.5,
            color: '#000',
            weight: 2,
            dashArray: '5, 5'
        };

        const trackPolygonStyle = {
            color: '#000000',
            weight: 2,
            opacity: 0.9,
            dashArray: '',
            fillColor: '#d3d3d3',
            fillOpacity: 0.35
        };

        const proposalId = proposalData?.proposalId || proposalData?.id || null;
        const trackDefinition = proposalData?.roadProposal?.definition || proposalData?.definition || null;
        const isGovernmentPlan = proposalData?.tags?.governmentPlan === true
            || proposalData?.roadProposal?.definition?.kind === 'government_plan'
            || proposalData?.geometry?.roadPlan?.kind === 'government_plan';
        const debugRoadCenterline = (typeof window !== 'undefined' && window.DEBUG_ROAD_CENTERLINE === true);
        const centerlineWarningCache = (typeof window !== 'undefined')
            ? (window.__roadCenterlineWarnings instanceof Set ? window.__roadCenterlineWarnings : (window.__roadCenterlineWarnings = new Set()))
            : null;
        const shouldLogCenterlineWarning = (type) => {
            if (!centerlineWarningCache) return true;
            const key = `${proposalId || 'unknown-proposal'}::${type}`;
            if (centerlineWarningCache.has(key)) return false;
            centerlineWarningCache.add(key);
            return true;
        };
        const flattenTrackPoints = (points) => {
            if (!Array.isArray(points)) return null;
            const result = [];
            const walk = (arr) => {
                if (!Array.isArray(arr)) return;
                arr.forEach(p => {
                    if (Array.isArray(p)) {
                        walk(p);
                    } else if (p !== undefined && p !== null) {
                        result.push(p);
                    }
                });
            };
            walk(points);
            return result;
        };
        const trackDefinitionPoints = flattenTrackPoints(trackDefinition?.points);
        const trackDefinitionWidth = trackDefinition?.width;

        try {
            const sample = Array.isArray(features)
                ? features.slice(0, 20).map(f => {
                    const pid = _getParcelIdFromFeature(f);
                    const props = f?.properties || {};
                    const hasTrackPts = Array.isArray(props.trackPoints);
                    return {
                        parcelId: pid,
                        isTrack: props.isTrack === true,
                        isRoad: props.isRoad === true,
                        hasTrackPoints: hasTrackPts,
                        trackPointCount: hasTrackPts ? props.trackPoints.length : 0
                    };
                })
                : [];
            console.debug('[_addFeaturesToMap] start', {
                featureCount: Array.isArray(features) ? features.length : 0,
                useNormalStyle,
                proposalId,
                trackDefinitionWidth,
                trackDefinitionPoints: trackDefinitionPoints ? trackDefinitionPoints.length : 0,
                sample
            });
        } catch (logErr) {
            console.warn('[_addFeaturesToMap] failed to log start', logErr);
        }

        const beforeCount = window.parcelLayer ? window.parcelLayer.getLayers().length : 0;

        // Filter out parcels that are ancestors of applied descendants (regardless of which proposal is being applied)
        // BUT: Don't filter out decide later child parcels - they should always be visible
        const beforeFilter = features.length;
        const excludeFromDescendantFilter = proposalData && (proposalData.proposalId || proposalData.id)
            ? String(proposalData.proposalId || proposalData.id)
            : null;
        const originalFeatures = [...features]; // Store original to find what was filtered out
        features = _filterChildFeaturesBlockedByDescendants(features, excludeFromDescendantFilter);
        const afterFilter = features.length;
        if (beforeFilter !== afterFilter) {
            console.debug(`[_addFeaturesToMap] Filtered ${beforeFilter - afterFilter} features (${beforeFilter} -> ${afterFilter})`);
            // Check if any decide later child parcels were filtered out
            const remainingParcelIds = new Set(features.map(f => {
                const id = _getParcelIdFromFeature(f);
                return id ? String(id) : null;
            }).filter(Boolean));
            const filteredOut = originalFeatures.filter(f => {
                const id = _getParcelIdFromFeature(f);
                const key = id ? String(id) : null;
                return key && !remainingParcelIds.has(key) && f?.properties?.mergedFromDecideLater === true;
            });
            if (filteredOut.length > 0) {
                console.warn(`[_addFeaturesToMap] WARNING: ${filteredOut.length} decide later child parcels were filtered out!`);
            }
        }

        // Partition features: bulk-add non-track parcels when using normal style; handle tracks separately
        const trackFeatures = Array.isArray(features)
            ? features.filter(f => f?.properties?.isTrack === true)
            : [];
        const bulkCandidates = Array.isArray(features)
            ? features.filter(f => !(f?.properties?.isTrack === true))
            : [];
        console.debug('[_addFeaturesToMap] partition', {
            totalFeatures: features.length,
            trackFeatures: trackFeatures.length,
            bulkCandidates: bulkCandidates.length,
            trackFeaturesIds: trackFeatures.map(f => _getParcelIdFromFeature(f)),
            trackProps: trackFeatures.map(f => ({ id: _getParcelIdFromFeature(f), isTrack: f?.properties?.isTrack, isRoad: f?.properties?.isRoad }))
        });
        const canBulkAdd = useNormalStyle && bulkCandidates.length > 0;

        if (canBulkAdd) {
            const featureCollection = { type: 'FeatureCollection', features: bulkCandidates };
            const selectionOnEach = (window.Parcels && window.Parcels.selection && window.Parcels.selection.onEachFeature)
                ? window.Parcels.selection.onEachFeature
                : window.onEachFeature;
            const onEachFeature = (feature, layer) => {
                const parcelId = _getParcelIdFromFeature(feature);
                if (parcelId && layer?.feature?.properties) {
                    _ensureParcelIdOnProperties(layer.feature.properties, parcelId);
                }

                // Ensure interaction handlers are wired even when bulk-adding
                if (typeof selectionOnEach === 'function') {
                    selectionOnEach(feature, layer);
                }
                if (layer?.options) {
                    layer.options.interactive = true;
                }
                if (typeof layer?.setInteractive === 'function') {
                    layer.setInteractive(true);
                }
            };

            const styleFn = (feat) => {
                const isRoad = feat?.properties?.isRoad;
                if (isRoad && feat?.properties?.isCorridor === true && window.corridorParcelStyle) {
                    return window.corridorParcelStyle;
                }
                return isRoad ? window.roadStyle : window.normalStyle;
            };

            try {
                const mapById = (typeof window.getParcelLayerIdMap === 'function')
                    ? window.getParcelLayerIdMap()
                    : (window.parcelLayerById instanceof Map ? window.parcelLayerById : null);
                const indexParcelLayer = (window.Parcels && window.Parcels.storage && window.Parcels.storage.indexParcelLayer)
                    ? window.Parcels.storage.indexParcelLayer
                    : window.indexParcelLayer;

                const geoJsonLayer = L.geoJSON(featureCollection, {
                    style: styleFn,
                    onEachFeature
                });
                geoJsonLayer.eachLayer(layer => {
                    const pid = _getParcelIdFromFeature(layer?.feature);
                    const idStr = pid !== undefined && pid !== null ? pid.toString() : null;
                    if (idStr && mapById && typeof window.removeParcelLayerById === 'function') {
                        const existing = mapById.get(idStr);
                        if (existing && existing !== layer && window.parcelLayer && window.parcelLayer.hasLayer(existing)) {
                            try { window.removeParcelLayerById(idStr); } catch (_) { }
                        }
                    }
                    window.parcelLayer.addLayer(layer);

                    // Register in id->layer map for O(1) lookup (do this AFTER any removals to keep mapping consistent)
                    if (idStr && typeof window.setParcelLayerById === 'function') {
                        try { window.setParcelLayerById(idStr, layer); } catch (_) { }
                    }

                    // Index for spatial lookups (only for layers we actually add)
                    if (typeof indexParcelLayer === 'function') {
                        indexParcelLayer(layer);
                    }

                    // For applied roads, draw centerline overlay
                    const feat = layer?.feature;
                    if (feat?.properties?.isRoad && window.map) {
                        const pointsSourceRaw = (proposalData?.roadProposal?.definition?.points)
                            || (proposalData?.definition?.points)
                            || (proposalData?.geometry?.roadPlan?.points)
                            || null;

                        const proposalLabel = proposalId || 'unknown-proposal';

                        const normalizePoint = (pt) => {
                            if (!pt) return null;
                            if (pt && typeof pt.lat === 'number' && typeof pt.lng === 'number') {
                                return [pt.lat, pt.lng];
                            }
                            if (Array.isArray(pt) && pt.length >= 2) {
                                const val1 = Number(pt[0]);
                                const val2 = Number(pt[1]);
                                if (Number.isFinite(val1) && Number.isFinite(val2)) {
                                    return (Math.abs(val1) <= 90 && Math.abs(val2) <= 180)
                                        ? [val1, val2]
                                        : [val2, val1];
                                }
                            }
                            return null;
                        };

                        const normalizeSegments = (pts) => {
                            if (!Array.isArray(pts)) return [];
                            if (Array.isArray(pts[0])) {
                                return pts
                                    .map(seg => Array.isArray(seg) ? seg.map(normalizePoint).filter(Boolean) : [])
                                    .filter(seg => seg.length >= 2);
                            }
                            const single = pts.map(normalizePoint).filter(Boolean);
                            return single.length >= 2 ? [single] : [];
                        };
                        const normalizedSegments = normalizeSegments(pointsSourceRaw);

                        if (normalizedSegments.length > 0) {
                            if (!window.__roadCenterlinePaneCreated && typeof window.map.createPane === 'function') {
                                const pane = window.map.createPane('roadCenterlinePane');
                                if (pane && pane.style) {
                                    pane.style.zIndex = '550';
                                    pane.style.pointerEvents = 'none';
                                }
                                window.__roadCenterlinePaneCreated = true;
                            }

                            const centerlineLayer = L.polyline(normalizedSegments, {
                                color: '#ffffff',
                                weight: 2,
                                dashArray: '8 6',
                                opacity: 0.9,
                                interactive: false,
                                pane: window.map.getPane && window.map.getPane('roadCenterlinePane') ? 'roadCenterlinePane' : undefined,
                                className: 'road-centerline'
                            });
                            centerlineLayer.addTo(window.map);
                            if (typeof centerlineLayer.bringToFront === 'function') {
                                centerlineLayer.bringToFront();
                            }
                            layer._roadCenterlineLayer = centerlineLayer;
                            layer.on('remove', () => {
                                if (layer._roadCenterlineLayer && window.map && window.map.hasLayer(layer._roadCenterlineLayer)) {
                                    window.map.removeLayer(layer._roadCenterlineLayer);
                                }
                            });
                            if (debugRoadCenterline) {
                                console.log('[road centerline] drawn (bulk path)', {
                                    proposalId: proposalLabel,
                                    parcelId: idStr,
                                    segments: normalizedSegments.length,
                                    firstSegmentPreview: normalizedSegments[0]?.slice?.(0, 2)
                                });
                            }
                        } else if (!Array.isArray(pointsSourceRaw)) {
                            if (!isGovernmentPlan && shouldLogCenterlineWarning('missing-points-bulk')) {
                                console.warn('[road centerline] missing points array (bulk path)', { proposalId: proposalLabel, parcelId: idStr });
                            }
                        } else {
                            if (!isGovernmentPlan && shouldLogCenterlineWarning('insufficient-points-bulk')) {
                                console.warn('[road centerline] insufficient points (bulk path)', {
                                    proposalId: proposalLabel,
                                    parcelId: idStr,
                                    segmentsLength: Array.isArray(pointsSourceRaw) ? pointsSourceRaw.length : 0,
                                    sample: Array.isArray(pointsSourceRaw) ? pointsSourceRaw.slice(0, 2) : []
                                });
                            }
                        }
                    }
                });
            } catch (err) {
                console.warn('[_addFeaturesToMap] Bulk add failed, falling back to per-feature path', err);
            }
        }

        // Handle remaining features (tracks, or all if no bulk add)
        const featuresToProcess = canBulkAdd ? trackFeatures : features;

        featuresToProcess.forEach(feature => {
            // Check if this is a track - rely on the isTrack flag provided by upstream flow
            const isTrack = feature.properties.isTrack === true;
            let trackPoints = feature.properties.trackPoints;

            const roadProposal = proposalData?.roadProposal || proposalData;
            const definition = roadProposal?.definition || proposalData?.definition;
            let trackWidth = null;

            if (isTrack) {
                if (!Number.isFinite(trackWidth)) {
                    trackWidth = Number.isFinite(definition?.width) ? definition.width : null;
                }
                if (!Number.isFinite(trackWidth)) {
                    trackWidth = Number.isFinite(trackDefinitionWidth) ? trackDefinitionWidth : 6;
                }
                if (!trackPoints && trackDefinitionPoints) {
                    trackPoints = trackDefinitionPoints;
                }

                const parcelId = _getParcelIdFromFeature(feature);
                console.debug('[_addFeaturesToMap] track candidate', {
                    parcelId,
                    trackPointsPresent: Array.isArray(trackPoints),
                    trackPointCount: Array.isArray(trackPoints) ? trackPoints.length : 0,
                    trackWidth
                });
            }

            // For tracks, render with rails and sleepers plus a visible corridor polygon
            if (isTrack) {
                if (trackPoints && Array.isArray(trackPoints)) {
                    const flattenedTrackPoints = flattenTrackPoints(trackPoints);
                    if (Array.isArray(flattenedTrackPoints) && flattenedTrackPoints.length >= 2) {
                        trackPoints = flattenedTrackPoints;
                    }
                }

                if (trackPoints && Array.isArray(trackPoints) && trackPoints.length >= 2) {
                    const renderFn = typeof renderTrackWithRails === 'function'
                        ? renderTrackWithRails
                        : (typeof window !== 'undefined' && typeof window.renderTrackWithRails === 'function')
                            ? window.renderTrackWithRails
                            : null;

                    if (renderFn) {
                        const normalizedPoints = trackPoints.map(p => {
                            if (p && typeof p.lat === 'function' && typeof p.lng === 'function') {
                                return p;
                            }
                            if (p && typeof p === 'object' && 'lat' in p && 'lng' in p) {
                                return L.latLng(Number(p.lat), Number(p.lng));
                            }
                            if (Array.isArray(p) && p.length >= 2) {
                                const val1 = Number(p[0]);
                                const val2 = Number(p[1]);
                                if (Math.abs(val1) <= 90 && Math.abs(val2) <= 180) {
                                    return L.latLng(val1, val2);
                                }
                                return L.latLng(val2, val1);
                            }
                            return null;
                        }).filter(Boolean);

                        if (normalizedPoints.length >= 2) {
                            const trackRailsLayer = renderFn(normalizedPoints, false, {
                                railColor: '#000000',
                                sleeperColor: '#666666',
                                trackWidth: trackWidth,
                                pane: (window.__proposalHighlightPanes && window.__proposalHighlightPanes.highlight) || undefined
                            });
                            console.debug('[_addFeaturesToMap] rendering track rails', {
                                pointCount: normalizedPoints.length,
                                trackWidth
                            });
                            if (trackRailsLayer) {
                                trackRailsLayer.addTo(window.map);
                                feature._trackRailsLayer = trackRailsLayer;
                            }
                        } else {
                            console.warn('[_addFeaturesToMap] trackPoints normalized but insufficient for rails', {
                                originalCount: Array.isArray(trackPoints) ? trackPoints.length : 0,
                                normalizedCount: normalizedPoints.length
                            });
                        }
                    }
                }

                // Draw a visible corridor so applied tracks differ from roads
                const onEachFeature = (window.Parcels && window.Parcels.selection && window.Parcels.selection.onEachFeature)
                    ? window.Parcels.selection.onEachFeature
                    : window.onEachFeature;

                const newLayer = L.geoJSON(feature, {
                    style: () => ({ ...trackPolygonStyle }),
                    onEachFeature
                });

                newLayer.eachLayer(layer => {
                    if (feature._trackRailsLayer && layer.feature) {
                        layer.feature._trackRailsLayer = feature._trackRailsLayer;
                    }
                    const parcelId = _getParcelIdFromFeature(layer?.feature);
                    if (parcelId && layer?.feature?.properties) {
                        _ensureParcelIdOnProperties(layer.feature.properties, parcelId);
                    }
                    window.parcelLayer.addLayer(layer);
                    if (typeof window.setParcelLayerById === 'function') {
                        try { window.setParcelLayerById(parcelId, layer); } catch (_) { }
                    }
                    const indexParcelLayer = (window.Parcels && window.Parcels.storage && window.Parcels.storage.indexParcelLayer)
                        ? window.Parcels.storage.indexParcelLayer
                        : window.indexParcelLayer;
                    if (typeof indexParcelLayer === 'function') {
                        indexParcelLayer(layer);
                    }
                    // Store track style on layer so getParcelBaseStyle can find it
                    layer._trackStyle = { ...trackPolygonStyle };
                    // Force initial style application (fixes dark grey flicker)
                    if (layer.setStyle) {
                        layer.setStyle({ ...trackPolygonStyle });
                    }
                    console.debug('[_addFeaturesToMap] track layer created', {
                        parcelId,
                        hasTrackStyle: Boolean(layer._trackStyle),
                        isTrackProp: layer?.feature?.properties?.isTrack
                    });
                    // Hover: standard parcel style (weight 5, grey solid); mouseout: return to track style unless selected
                    if (layer.on) {
                        layer.on('mouseover', () => {
                            // Don't override selection style
                            const layerParcelId = _getParcelIdFromFeature(layer?.feature);
                            if (layerParcelId && window.selectedParcelId && layerParcelId.toString() === window.selectedParcelId.toString()) {
                                return;
                            }
                            if (layer.setStyle) layer.setStyle({ weight: 5, color: '#666', dashArray: '' });
                            if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge && typeof layer.bringToFront === 'function') {
                                layer.bringToFront();
                            }
                        });
                        layer.on('mouseout', () => {
                            // Don't reset if this is the selected parcel
                            const layerParcelId = _getParcelIdFromFeature(layer?.feature);
                            if (layerParcelId && window.selectedParcelId && layerParcelId.toString() === window.selectedParcelId.toString()) {
                                return;
                            }
                            if (layer.setStyle) layer.setStyle({ ...trackPolygonStyle });
                        });
                    }
                });
            } else {
                // Regular road or parcel - use normal styling
                let style;
                if (useNormalStyle) {
                    style = feature.properties.isRoad
                        ? ((feature.properties.isCorridor === true && window.corridorParcelStyle) ? window.corridorParcelStyle : window.roadStyle)
                        : window.normalStyle;
                } else {
                    // Use different styles for roads vs parcels in proposals
                    style = feature.properties.isRoad ? proposalRoadStyle : proposalParcelStyle;
                }

                // console.log(`Adding feature: ${_getParcelIdFromFeature(feature)}, isRoad: ${feature.properties.isRoad}`);

                const onEachFeature = (window.Parcels && window.Parcels.selection && window.Parcels.selection.onEachFeature)
                    ? window.Parcels.selection.onEachFeature
                    : window.onEachFeature;

                const newLayer = L.geoJSON(feature, {
                    style: style,
                    onEachFeature
                });

                newLayer.eachLayer(layer => {
                    const parcelId = _getParcelIdFromFeature(layer?.feature);
                    if (layer?.feature?.properties) {
                        _ensureParcelIdOnProperties(layer.feature.properties, parcelId);
                    }
                    const normalizedId = parcelId ? parcelId.toString() : null;
                    const debugAll = (typeof window !== 'undefined' && window.DEBUG_PROPOSAL_ADD_PARCELS === true);
                    const debugTarget = (typeof window !== 'undefined' && window.DEBUG_PROPOSAL_PARCEL_ID !== undefined && window.DEBUG_PROPOSAL_PARCEL_ID !== null)
                        ? String(window.DEBUG_PROPOSAL_PARCEL_ID)
                        : null;
                    const isDebugParcel = !!normalizedId && (debugAll || (debugTarget && debugTarget === normalizedId));

                    if (isDebugParcel) {
                        console.log(`[ProposalManager._addFeaturesToMap] DEBUG: Adding layer for parcel ${normalizedId}`, {
                            useNormalStyle,
                            inParcelLayer: window.parcelLayer && window.parcelLayer.hasLayer(layer),
                            onMap: window.map && window.map.hasLayer(layer),
                            stack: new Error().stack
                        });
                    }

                    // Check if already exists before adding (fast path: map lookup)
                    const mapById = (typeof window.getParcelLayerIdMap === 'function') ? window.getParcelLayerIdMap() : (window.parcelLayerById instanceof Map ? window.parcelLayerById : null);
                    const existing = mapById ? mapById.get(normalizedId) : (window.resolveParcelLayerById ? window.resolveParcelLayerById(normalizedId) : null);
                    if (existing && existing !== layer) {
                        if (isDebugParcel) {
                            console.log(`[ProposalManager._addFeaturesToMap] DEBUG: Parcel ${normalizedId} already exists, removing old layer first`);
                        }
                        if (typeof window.removeParcelLayerById === 'function') {
                            window.removeParcelLayerById(normalizedId);
                        }
                    }

                    // CRITICAL: Check if layer is already in parcelLayer before adding
                    // This prevents duplicates from being added through this code path
                    if (window.parcelLayer && window.parcelLayer.hasLayer(layer)) {
                        if (isDebugParcel) {
                            console.warn(`[ProposalManager._addFeaturesToMap] DEBUG: Layer for parcel ${normalizedId} is already in parcelLayer, skipping add`);
                        }
                        return; // Skip - already added
                    }

                    // Add to parcelLayer (which is already on the map)
                    window.parcelLayer.addLayer(layer);

                    // Keep id->layer map in sync for O(1) lookups
                    if (typeof window.setParcelLayerById === 'function') {
                        try { window.setParcelLayerById(normalizedId, layer); } catch (_) { }
                    }

                    // Verify it was actually added
                    if (!window.parcelLayer.hasLayer(layer)) {
                        console.error(`[ProposalManager._addFeaturesToMap] ERROR: Failed to add layer for parcel ${normalizedId} to parcelLayer`);
                        return;
                    }

                    const indexParcelLayer = (window.Parcels && window.Parcels.storage && window.Parcels.storage.indexParcelLayer)
                        ? window.Parcels.storage.indexParcelLayer
                        : window.indexParcelLayer;
                    if (typeof indexParcelLayer === 'function') {
                        indexParcelLayer(layer);
                    }

                    if (isDebugParcel) {
                        console.log(`[ProposalManager._addFeaturesToMap] DEBUG: After adding, parcelLayer.hasLayer=${window.parcelLayer && window.parcelLayer.hasLayer(layer)}, map.hasLayer=${window.map && window.map.hasLayer(layer)}`);
                    }

                    // Don't add directly to map - layers in parcelLayer are automatically rendered
                    // when parcelLayer is on the map. Adding directly causes double rendering.
                    // The check map.hasLayer(layer) doesn't work correctly for layers in FeatureGroups.

                    // Apply SVG pattern to proposed roads
                    if (!useNormalStyle && feature.properties.isRoad && layer._path) {
                        layer._path.style.fill = 'url(#proposal-road-pattern)';
                    }

                    // Debug: log every feature to trace centerline condition
                    if (debugRoadCenterline) {
                        console.log('[road centerline] checking feature', {
                            parcelId: normalizedId,
                            useNormalStyle,
                            isRoad: feature.properties.isRoad,
                            hasMap: !!window.map,
                            conditionMet: useNormalStyle && feature.properties.isRoad && window.map
                        });
                    }

                    // For applied roads, overlay a white dashed centerline instead of using the stroke as a border
                    if (useNormalStyle && feature.properties.isRoad && window.map) {
                        // Single source of truth: points passed with the road definition
                        const pointsSourceRaw = (proposalData?.roadProposal?.definition?.points)
                            || (proposalData?.definition?.points)
                            || (proposalData?.geometry?.roadPlan?.points)
                            || null;

                        const proposalLabel = proposalData?.proposalId || proposalData?.id || 'unknown-proposal';
                        const parcelLabel = _getParcelIdFromFeature(layer?.feature) || 'unknown-parcel';

                        if (!Array.isArray(pointsSourceRaw)) {
                            if (!isGovernmentPlan && shouldLogCenterlineWarning('missing-points')) {
                                console.warn('[road centerline] missing points array on proposal', {
                                    proposalId: proposalLabel,
                                    parcelId: parcelLabel,
                                    hasRoadProposal: !!proposalData?.roadProposal,
                                    hasDefinition: !!proposalData?.roadProposal?.definition,
                                    hasGeometryPlan: !!proposalData?.geometry?.roadPlan,
                                    keys: Object.keys(proposalData || {})
                                });
                            }
                        }

                        // Normalize points: accept either a flat array of points or an array of segments (arrays of points)
                        const normalizePoint = (pt) => {
                            if (!pt) return null;
                            if (pt && typeof pt.lat === 'number' && typeof pt.lng === 'number') {
                                return [pt.lat, pt.lng];
                            }
                            if (Array.isArray(pt) && pt.length >= 2) {
                                const val1 = Number(pt[0]);
                                const val2 = Number(pt[1]);
                                if (Number.isFinite(val1) && Number.isFinite(val2)) {
                                    return (Math.abs(val1) <= 90 && Math.abs(val2) <= 180)
                                        ? [val1, val2] // assume [lat, lng]
                                        : [val2, val1]; // assume [lng, lat]
                                }
                            }
                            return null;
                        };

                        const normalizeSegments = (pts) => {
                            if (!Array.isArray(pts)) return [];
                            if (Array.isArray(pts[0])) {
                                return pts
                                    .map(seg => Array.isArray(seg) ? seg.map(normalizePoint).filter(Boolean) : [])
                                    .filter(seg => seg.length >= 2);
                            }
                            const single = pts.map(normalizePoint).filter(Boolean);
                            return single.length >= 2 ? [single] : [];
                        };

                        const normalizedSegments = normalizeSegments(pointsSourceRaw);

                        if (normalizedSegments.length === 0) {
                            if (!isGovernmentPlan && shouldLogCenterlineWarning('insufficient-points')) {
                                console.warn('[road centerline] insufficient points to draw centerline', {
                                    proposalId: proposalLabel,
                                    parcelId: parcelLabel,
                                    segmentsLength: Array.isArray(pointsSourceRaw) ? pointsSourceRaw.length : 'not-array',
                                    firstSegmentSample: Array.isArray(pointsSourceRaw) ? pointsSourceRaw.slice(0, 2) : null,
                                    rawSourceType: Array.isArray(pointsSourceRaw) ? (Array.isArray(pointsSourceRaw[0]) ? 'segments' : 'points') : typeof pointsSourceRaw
                                });
                            }
                        } else {
                            // Dedicated pane so the stripe stays visible above fills
                            if (!window.__roadCenterlinePaneCreated && typeof window.map.createPane === 'function') {
                                const pane = window.map.createPane('roadCenterlinePane');
                                if (pane && pane.style) {
                                    pane.style.zIndex = '550';
                                    pane.style.pointerEvents = 'none';
                                }
                                window.__roadCenterlinePaneCreated = true;
                            }

                            const centerlineLayer = L.polyline(normalizedSegments, {
                                color: '#ffffff',
                                weight: 2,
                                dashArray: '8 6',
                                opacity: 0.9,
                                interactive: false,
                                pane: window.map.getPane && window.map.getPane('roadCenterlinePane') ? 'roadCenterlinePane' : undefined,
                                className: 'road-centerline'
                            });
                            centerlineLayer.addTo(window.map);
                            if (typeof centerlineLayer.bringToFront === 'function') {
                                centerlineLayer.bringToFront();
                            }
                            layer._roadCenterlineLayer = centerlineLayer;
                            layer.on('remove', () => {
                                if (layer._roadCenterlineLayer && window.map && window.map.hasLayer(layer._roadCenterlineLayer)) {
                                    window.map.removeLayer(layer._roadCenterlineLayer);
                                }
                            });
                            if (debugRoadCenterline) {
                                console.log('[road centerline] drawn', {
                                    proposalId: proposalLabel,
                                    parcelId: parcelLabel,
                                    segments: normalizedSegments.length,
                                    firstSegmentPreview: normalizedSegments[0]?.slice?.(0, 2),
                                    rawSourceType: Array.isArray(pointsSourceRaw) ? (Array.isArray(pointsSourceRaw[0]) ? 'segments' : 'points') : typeof pointsSourceRaw
                                });
                            }
                        }
                    }
                });
            }
        });

        const afterCount = window.parcelLayer ? window.parcelLayer.getLayers().length : 0;
        console.debug(`[_addFeaturesToMap] Done. Map now has ${afterCount} parcels (added ${afterCount - beforeCount})`);

        if (typeof refreshParcelNumberLabelsIfVisible === 'function') {
            refreshParcelNumberLabelsIfVisible();
        }
    },

    // Helper methods for dependency tracking
    // Record only the immediate creator proposal for a parcel.
    // Persisted shape remains an array for backward compatibility but will contain at most one hash.
    _addProposalAsAncestor(parcelId, proposalId) {
        if (!parcelId || !proposalId) return;
        const normalized = String(proposalId);
        this._upsertParcelProperties(parcelId, props => {
            props.ancestorProposal = normalized;
        }, { persistIfMissing: true });
    },

    _removeProposalAsAncestor(parcelId, proposalId) {
        if (!parcelId) return;
        const target = proposalId ? String(proposalId) : null;
        this._upsertParcelProperties(parcelId, props => {
            if (!target || String(props.ancestorProposal) === target) {
                delete props.ancestorProposal;
            }
        }, { persistIfMissing: false });
    },

    _addChildParcels(proposalId, parcelIds, proposalData = null) {
        const proposal = proposalData || _getProposalRecord(proposalId);
        const normalizedIncoming = parcelIds.map(id => String(id)).filter(Boolean);
        const existing = Array.isArray(proposal?.childParcelIds) ? proposal.childParcelIds.map(id => String(id)) : [];
        const merged = Array.from(new Set([...existing, ...normalizedIncoming]));
        if (proposal) {
            proposal.childParcelIds = merged;
            if (typeof proposalStorage !== 'undefined') {
                if (typeof proposalStorage._indexProposal === 'function') {
                    proposalStorage._indexProposal(proposal);
                }
                if (typeof proposalStorage.save === 'function') {
                    proposalStorage.save();
                }
            }
        }
        return merged;
    },

    _removeChildParcels(proposalId, parcelIds, proposalData = null) {
        const proposal = proposalData || _getProposalRecord(proposalId);
        const removeSet = new Set(parcelIds.map(id => String(id)));
        const existing = Array.isArray(proposal?.childParcelIds) ? proposal.childParcelIds.map(id => String(id)) : [];
        const filtered = existing.filter(id => !removeSet.has(id));
        if (proposal) {
            proposal.childParcelIds = filtered;
            if (typeof proposalStorage !== 'undefined') {
                if (typeof proposalStorage._indexProposal === 'function') {
                    proposalStorage._indexProposal(proposal);
                }
                if (typeof proposalStorage.save === 'function') {
                    proposalStorage.save();
                }
            }
        }
        return filtered;
    },

    _getProposalChildParcels(proposalId) {
        const proposal = _getProposalRecord(proposalId);
        const base = Array.isArray(proposal?.childParcelIds) ? proposal.childParcelIds : [];
        const merged = Array.from(new Set((base || []).map(id => String(id)).filter(Boolean)));
        if (proposal && merged.length !== (proposal.childParcelIds || []).length) {
            proposal.childParcelIds = merged;
            if (typeof proposalStorage !== 'undefined') {
                if (typeof proposalStorage._indexProposal === 'function') {
                    proposalStorage._indexProposal(proposal);
                }
                if (typeof proposalStorage.save === 'function') {
                    proposalStorage.save();
                }
            }
        }
        return merged;
    },

    // Return the immediate creator(s) only; for compatibility we keep an array but cap it to one.
    _getParcelAncestors(parcelId) {
        if (!parcelId) return [];
        const idStr = parcelId && parcelId.toString ? parcelId.toString() : String(parcelId);
        if (!idStr) return [];

        let ancestor = null;
        try {
            const layer = this._getParcelLayerById(idStr);
            if (layer && layer.feature && layer.feature.properties && layer.feature.properties.ancestorProposal) {
                ancestor = layer.feature.properties.ancestorProposal;
            }
        } catch (_) { /* ignore */ }

        if (!ancestor) {
            try {
                const props = (typeof readPersistedParcelRecord === 'function')
                    ? readPersistedParcelRecord(idStr)?.properties
                    : null;
                if (props && props.ancestorProposal) {
                    ancestor = props.ancestorProposal;
                }
            } catch (_) { /* ignore */ }
        }

        return ancestor ? [String(ancestor)] : [];
    },

    _setDescendantProposalOnParcels(parcelIds, proposalId) {
        if (!proposalId || !Array.isArray(parcelIds)) return;
        const normalized = String(proposalId);
        const uniqueIds = Array.from(new Set(parcelIds.map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));
        uniqueIds.forEach(id => {
            this._upsertParcelProperties(id, props => {
                props.descendantProposal = normalized;
            }, { persistIfMissing: true });
        });
    },

    _clearDescendantProposalOnParcels(parcelIds, proposalId) {
        if (!Array.isArray(parcelIds)) return;
        const target = proposalId ? String(proposalId) : null;
        const uniqueIds = Array.from(new Set(parcelIds.map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean)));
        uniqueIds.forEach(id => {
            this._upsertParcelProperties(id, props => {
                if (!target || String(props.descendantProposal) === target) {
                    delete props.descendantProposal;
                }
            }, { persistIfMissing: false });
        });
    },

    // Return full transitive dependency list (parcels and proposals)
    _getAllDescendants(proposalId) {
        const rootHash = String(proposalId);
        const results = [];
        const visitedProposals = new Set([rootHash]);
        const visitedParcels = new Set();
        const queue = [rootHash];

        while (queue.length) {
            const currentHash = queue.shift();
            const childParcels = this._getProposalChildParcels(currentHash) || [];
            childParcels.forEach(parcelId => {
                const parcelStr = String(parcelId);
                if (!visitedParcels.has(parcelStr)) {
                    visitedParcels.add(parcelStr);
                    results.push(parcelStr);
                }
            });

            const childProposals = this._getChildProposalsForProposal(currentHash);
            childProposals.forEach(childHash => {
                const childStr = String(childHash);
                if (visitedProposals.has(childStr)) return;
                visitedProposals.add(childStr);
                results.push(childStr);
                queue.push(childStr);
            });
        }

        return results;
    },

    /**
     * Parcel ids only (transitive), for map bounds / centering — excludes child proposal hashes.
     */
    _getAllDescendantParcelIds(proposalId) {
        const rootHash = String(proposalId);
        const results = [];
        const visitedProposals = new Set([rootHash]);
        const visitedParcels = new Set();
        const queue = [rootHash];

        while (queue.length) {
            const currentHash = queue.shift();
            const childParcels = this._getProposalChildParcels(currentHash) || [];
            childParcels.forEach(parcelId => {
                const parcelStr = String(parcelId);
                if (!visitedParcels.has(parcelStr)) {
                    visitedParcels.add(parcelStr);
                    results.push(parcelStr);
                }
            });

            const childProposals = this._getChildProposalsForProposal(currentHash);
            childProposals.forEach(childHash => {
                const childStr = String(childHash);
                if (visitedProposals.has(childStr)) return;
                visitedProposals.add(childStr);
                queue.push(childStr);
            });
        }

        return results;
    },

    _addChildProposalLink(parentProposalId, childProposalId) {
        if (!parentProposalId || !childProposalId || typeof proposalStorage === 'undefined') return;
        const parent = _getProposalRecord(parentProposalId);
        if (!parent) return;
        const existing = Array.isArray(parent.childProposalIds) ? parent.childProposalIds : [];
        const merged = Array.from(new Set([...existing.map(String), String(childProposalId)].filter(Boolean)));
        const unchanged = existing.length === merged.length && merged.every(id => existing.map(String).includes(id));
        if (unchanged) return;
        parent.childProposalIds = merged;
        if (typeof proposalStorage._indexProposal === 'function') proposalStorage._indexProposal(parent);
        if (typeof proposalStorage.save === 'function') proposalStorage.save();
    },

    _removeChildProposalLink(parentProposalId, childProposalId) {
        if (!parentProposalId || !childProposalId || typeof proposalStorage === 'undefined') return;
        const parent = _getProposalRecord(parentProposalId);
        if (!parent || !Array.isArray(parent.childProposalIds)) return;
        const filtered = parent.childProposalIds.filter(id => String(id) !== String(childProposalId));
        const unchanged = filtered.length === parent.childProposalIds.length;
        if (unchanged) return;
        parent.childProposalIds = filtered;
        if (typeof proposalStorage._indexProposal === 'function') proposalStorage._indexProposal(parent);
        if (typeof proposalStorage.save === 'function') proposalStorage.save();
    },

    _clearChildProposalLinks(proposalId) {
        if (typeof proposalStorage === 'undefined') return;
        const proposal = _getProposalRecord(proposalId);
        if (proposal) {
            proposal.childProposalIds = [];
            if (typeof proposalStorage._indexProposal === 'function') proposalStorage._indexProposal(proposal);
            if (typeof proposalStorage.save === 'function') proposalStorage.save();
        }
    },

    _getChildProposalsForProposal(proposalId) {
        if (!proposalId) return [];
        const proposal = _getProposalRecord(proposalId);
        const base = Array.isArray(proposal?.childProposalIds) ? proposal.childProposalIds : [];
        return Array.from(new Set((base || []).map(v => v && v.toString ? v.toString() : String(v)).filter(Boolean)));
    },
    _getAllDescendantProposals(proposalId) {
        const rootHash = String(proposalId);
        const result = [];
        const visited = new Set([rootHash]);
        const stack = [...(this._getChildProposalsForProposal(rootHash) || [])].reverse();
        while (stack.length) {
            const current = stack.pop();
            const currentStr = String(current);
            if (visited.has(currentStr)) continue;
            visited.add(currentStr);
            result.push(currentStr);
            const children = this._getChildProposalsForProposal(currentStr) || [];
            children.forEach(child => {
                const childStr = String(child);
                if (!visited.has(childStr)) {
                    stack.push(childStr);
                }
            });
        }

        return result;
    },

    // Public: return transitive descendants (proposals + parcel ids)
    _getProposalDescendants(proposalId) {
        if (!proposalId) return [];
        try {
            const list = this._getAllDescendants(proposalId);
            return Array.isArray(list) ? list : [];
        } catch (err) {
            console.warn('[_getProposalDescendants] Failed to resolve descendants', { proposalId, err });
            return [];
        }
    },

    findDescendantTree(proposalId, options = {}) {
        const maxDepth = Number.isFinite(options.depthLimit) ? Number(options.depthLimit) : 8;
        const root = String(proposalId);
        const nodes = [];
        const visited = new Set([root]);
        const queue = [{ hash: root, depth: 0, parent: null }];

        while (queue.length) {
            const current = queue.shift();
            const children = this._getChildProposalsForProposal(current.hash) || [];
            children.forEach(child => {
                const childHash = String(child);
                if (visited.has(childHash)) return;
                const depth = current.depth + 1;
                const node = { proposalId: childHash, parent: current.hash, depth };
                nodes.push(node);
                visited.add(childHash);
                if (depth < maxDepth) {
                    queue.push({ hash: childHash, depth, parent: current.hash });
                }
            });
        }

        return nodes;
    },

    findAncestorTree(proposalId, options = {}) {
        const maxDepth = Number.isFinite(options.depthLimit) ? Number(options.depthLimit) : 8;
        const root = String(proposalId);
        const nodes = [];
        const visited = new Set([root]);
        const queue = [{ hash: root, depth: 0, child: null }];

        while (queue.length) {
            const current = queue.shift();
            const proposal = _getProposalRecord(current.hash);
            if (!proposal) continue;
            const parentParcelIds = this._collectParentParcelIds(proposal.roadProposal || {}, proposal) || [];
            const ancestorProposals = [];
            parentParcelIds.forEach(pid => {
                const ancestors = this._getParcelAncestors(pid) || [];
                const last = ancestors.length ? ancestors[ancestors.length - 1] : null;
                if (last) ancestorProposals.push(String(last));
            });

            ancestorProposals.forEach(parentHash => {
                if (visited.has(parentHash)) return;
                const depth = current.depth + 1;
                const node = { proposalId: parentHash, child: current.hash, depth };
                nodes.push(node);
                visited.add(parentHash);
                if (depth < maxDepth) {
                    queue.push({ hash: parentHash, depth, child: current.hash });
                }
            });
        }

        return nodes;
    },

    // Link this proposal as a child only of the immediate creator proposals of the given parent parcels.
    _linkProposalToAncestors(proposalId, parentParcelIds) {
        if (!proposalId || !Array.isArray(parentParcelIds)) return;
        const uniqueParcelIds = Array.from(new Set(parentParcelIds.map(id => String(id))));
        uniqueParcelIds.forEach(parcelId => {
            const ancestorHashes = this._getParcelAncestors(parcelId) || [];
            // Only the immediate creator should be present; loop kept for shape consistency
            ancestorHashes.slice(-1).forEach(ancestorHash => {
                if (String(ancestorHash) !== String(proposalId)) {
                    this._addChildProposalLink(ancestorHash, proposalId);
                }
            });
        });
    },

    _markParcelModified(parcelId) {
        if (!parcelId) return;
        // Use batched version with single ID for backward compatibility
        this._markParcelsModifiedBatch([parcelId]);
    },

    // PERFORMANCE: Batched version to avoid N read/write cycles
    _markParcelsModifiedBatch(parcelIds) {
        if (!Array.isArray(parcelIds) || parcelIds.length === 0) return;
        const key = 'modified_parcels';
        let list;
        try {
            list = JSON.parse(PersistentStorage.getItem(key) || '[]');
            if (!Array.isArray(list)) list = [];
        } catch (_) {
            list = [];
        }
        const existingSet = new Set(list);
        let changed = false;
        parcelIds.forEach(parcelId => {
            if (!parcelId) return;
            const strId = String(parcelId);
            if (!existingSet.has(strId)) {
                existingSet.add(strId);
                changed = true;
            }
        });
        if (changed) {
            const newList = Array.from(existingSet);
            PersistentStorage.setItem(key, JSON.stringify(newList));
            if (this._cachedModifiedParcelSet instanceof Set) {
                parcelIds.forEach(parcelId => {
                    if (parcelId) this._cachedModifiedParcelSet.add(String(parcelId));
                });
            }
        }
    },

    _unmarkParcelModified(parcelId) {
        if (!parcelId) return;
        const key = 'modified_parcels';
        let list;
        try {
            list = JSON.parse(PersistentStorage.getItem(key) || '[]');
            if (!Array.isArray(list)) list = [];
        } catch (_) {
            list = [];
        }
        const strId = String(parcelId);
        const index = list.indexOf(strId);
        if (index > -1) {
            list.splice(index, 1);
            PersistentStorage.setItem(key, JSON.stringify(list));
            if (this._cachedModifiedParcelSet instanceof Set) {
                this._cachedModifiedParcelSet.delete(strId);
            }
        }
    },

    _getModifiedParcelsSet() {
        const hydrated = this._ensureModifiedParcelIndexHydrated();
        return hydrated instanceof Set ? new Set(hydrated) : new Set();
    },

    _ensureModifiedParcelIndexHydrated(force) {
        if (!force && this._modifiedParcelIndexHydrated && this._cachedModifiedParcelSet instanceof Set) {
            return this._cachedModifiedParcelSet;
        }

        let list;
        try {
            list = JSON.parse(PersistentStorage.getItem('modified_parcels') || '[]');
            if (!Array.isArray(list)) list = [];
        } catch (_) {
            list = [];
        }

        const set = new Set(list.map(String));
        let updated = false;
        let hydratedFromProposals = false;

        if (typeof proposalStorage !== 'undefined' && typeof proposalStorage.getAllProposals === 'function') {
            try {
                hydratedFromProposals = true;
                const proposals = proposalStorage.getAllProposals();
                proposals.forEach(proposal => {
                    if (!proposal || !proposal.roadProposal) {
                        return;
                    }
                    const road = proposal.roadProposal;
                    const roadStatus = road.status ? String(road.status).toLowerCase() : '';
                    const proposalStatus = proposal.status ? String(proposal.status).toLowerCase() : '';
                    const isApplied = roadStatus === 'applied' || proposalStatus === 'applied' || proposalStatus === 'executed';
                    if (!isApplied) {
                        return;
                    }
                    let childIds = Array.isArray(road.childParcelIds) ? road.childParcelIds.slice() : [];
                    if ((!childIds || childIds.length === 0) && proposal.roadProposal && proposal.roadProposal.definition) {
                        const parents = this._collectParentParcelIds(road, proposal);
                        if (parents.length > 0) {
                            const rebuilt = this._rebuildRoadFromDefinition(proposal, parents);
                            childIds = (rebuilt.childFeatures || [])
                                .map(feature => _getParcelIdFromFeature(feature))
                                .filter(Boolean)
                                .map(id => id.toString());
                            if (childIds.length) {
                                road.childParcelIds = Array.from(new Set(childIds));
                                proposal.childParcelIds = Array.from(new Set([...(proposal.childParcelIds || []), ...road.childParcelIds]));
                                proposal.proposalId = proposal.proposalId || proposal.proposalId;
                                if (typeof proposalStorage._indexProposal === 'function') {
                                    proposalStorage._indexProposal(proposal);
                                } else {
                                    proposalStorage.proposals.set(proposal.proposalId, proposal);
                                }
                            }
                        }
                    }

                    if (!childIds || childIds.length === 0) {
                        return;
                    }

                    childIds.forEach(childId => {
                        if (childId === undefined || childId === null) {
                            return;
                        }
                        const key = childId && childId.toString ? childId.toString() : String(childId);
                        if (!set.has(key)) {
                            set.add(key);
                            updated = true;
                        }
                    });
                });
            } catch (err) {
                console.warn('Failed to hydrate modified parcel index from proposals', err);
            }
        }

        if (updated) {
            try { PersistentStorage.setItem('modified_parcels', JSON.stringify(Array.from(set))); } catch (_) { }
        }

        this._modifiedParcelIndexHydrated = hydratedFromProposals || !!force;
        this._cachedModifiedParcelSet = set;
        return set;
    },

    _getMissingParentParcels(parentFeatures) {
        if (!Array.isArray(parentFeatures) || parentFeatures.length === 0) {
            return [];
        }

        const existingIds = new Set();
        try {
            if (typeof parcelLayer !== 'undefined' && parcelLayer && typeof parcelLayer.eachLayer === 'function') {
                parcelLayer.eachLayer(layer => {
                    const layerId = _getParcelIdFromFeature(layer?.feature);
                    if (layerId !== undefined && layerId !== null) {
                        existingIds.add(layerId.toString());
                    }
                });
            }
        } catch (_) { }

        // A feature that already carries a polygon was resolved through cache or persistent
        // storage and does not need a network fetch — even if its layer is not currently
        // indexed in parcelLayer (e.g. zoomed out, tiles not yet rebuilt). Trusting in-feature
        // geometry here prevents redundant fetches when the caller already supplied the data.
        const hasPolygonGeometry = (feature) => {
            const g = feature && feature.geometry;
            if (!g || !g.type) return false;
            return g.type === 'Polygon' || g.type === 'MultiPolygon';
        };

        return parentFeatures.reduce((missing, feature) => {
            const id = _getParcelIdFromFeature(feature);
            if (!id) {
                return missing;
            }
            if (hasPolygonGeometry(feature)) {
                return missing;
            }
            const idStr = id.toString();
            if (existingIds.has(idStr)) {
                return missing;
            }
            missing.push({
                id: idStr,
                number: feature?.properties?.BROJ_CESTICE ? feature.properties.BROJ_CESTICE.toString() : null
            });
            return missing;
        }, []);
    },

    /**
     * Classify parent-parcel availability for the apply-anyway/conflict flow.
     *  - CONFLICT: a declared parent (whether or not it currently resolves) is OCCUPIED by another
     *    APPLIED proposal — that proposal's rule already replaced the parcel with children. This is
     *    checked over ALL declared parents, because an occupied parent can still resolve from
     *    storage, so it would not show up as "missing".
     *  - NOT LOADED: a parent that could not be resolved AND is not occupied by anyone — just not
     *    fetched yet.
     * For each occupying proposal we flag whether it can be unapplied cleanly, or whether another
     * applied proposal is built on top of its children (a dependency chain a single unapply would
     * orphan — we surface it but never auto-cascade).
     */
    // A declared parent like "HR-1997/1#p-token-3" can stop existing when slice ids drift between
    // devices (different load order, changed cutting rules). If the ROOT parcel's fabric exists in
    // any form — the root itself, or any of its current descendants — the missing derived id is
    // cosmetic, not a real prerequisite: the proposal carries its own geometry and can apply.
    _missingDerivedParentHasLiveFabric(parcelId) {
        const id = String(parcelId || '');
        const cut = id.indexOf('#p-');
        if (cut <= 0) return false;
        const root = id.slice(0, cut);
        try {
            if (typeof isParcelReplacedByChildren === 'function' && isParcelReplacedByChildren(root)) return true;
        } catch (_) { }
        const layerIndex = (typeof window !== 'undefined' && window.parcelLayerById instanceof Map) ? window.parcelLayerById : null;
        if (layerIndex) {
            if (layerIndex.has(root)) return true;
            const prefix = root + '#p-';
            for (const key of layerIndex.keys()) {
                if (typeof key === 'string' && key.startsWith(prefix)) return true;
            }
        }
        return false;
    },

    _analyzeParentAvailability(declaredParentIds, unresolvableIds, selfProposalId) {
        const declared = Array.isArray(declaredParentIds) ? declaredParentIds.map(id => String(id)).filter(Boolean) : [];
        const unresolvable = new Set((Array.isArray(unresolvableIds) ? unresolvableIds : []).map(id => String(id)).filter(Boolean));
        const store = (typeof proposalStorage !== 'undefined') ? proposalStorage : null;
        const self = String(selfProposalId || '');
        const occupiers = new Map(); // occupyingProposalId -> Set(parcelIds)
        const occupiedIds = new Set();

        declared.forEach(pid => {
            const occ = (store && typeof store.getAppliedProposalsOccupyingParcel === 'function')
                ? store.getAppliedProposalsOccupyingParcel(pid).filter(x => String(x) !== self)
                : [];
            if (occ.length) {
                occupiedIds.add(pid);
                occ.forEach(op => {
                    const key = String(op);
                    if (!occupiers.has(key)) occupiers.set(key, new Set());
                    occupiers.get(key).add(pid);
                });
            }
        });

        // Not-loaded = unresolvable AND not occupied by anyone (occupied ones are a conflict instead).
        const notLoaded = Array.from(unresolvable).filter(id => !occupiedIds.has(id));

        const conflicts = Array.from(occupiers.entries()).map(([op, set]) => {
            const rec = _getProposalRecord(op);
            let dependents = [];
            try {
                dependents = (typeof this._getAllDescendantProposals === 'function')
                    ? (this._getAllDescendantProposals(op) || []).map(String).filter(x => x && x !== String(op))
                    : [];
            } catch (_) { dependents = []; }
            const dependentTitles = dependents.map(dp => {
                const dr = _getProposalRecord(dp);
                return (dr && (dr.title || dr.name)) || dp;
            });
            return {
                proposalId: String(op),
                title: (rec && (rec.title || rec.name)) || String(op),
                parcelIds: Array.from(set),
                canUnapplyCleanly: dependents.length === 0,
                blockedBy: dependents,
                blockedByTitles: dependentTitles
            };
        });

        return { conflicts, notLoaded };
    },

    /**
     * Shared parent-availability gate for every apply path (road, reparcellization, building,
     * structure). Given the declared parent ids and the currently-resolved parent features, it:
     *   1. computes which declared parents are unresolvable — (A) never resolved, (B) resolved
     *      without geometry / off the map;
     *   2. classifies each unavailable/occupied parent (via _analyzeParentAvailability) into
     *      CONFLICT (occupied by another applied proposal — checked over ALL declared parents, since
     *      an occupied parcel can still resolve) vs NOT-LOADED;
     *   3. auto-fetches only the genuinely not-loaded (unoccupied) parcels and re-analyzes — we never
     *      re-fetch an occupied parcel, which would redraw something another proposal owns;
     *   4. decides: if clear, proceed; if the caller opted in (options.applyAnyway) proceed with the
     *      parents present; otherwise show the conflict/apply-anyway modal and defer.
     * Returns { defer, parentFeatures, analysis }. The caller discards its write cache and returns
     * false when defer is true. Callers with no split (overlays) can ignore the returned features.
     */
    async _resolveParentAvailabilityOrDefer({ idLabel, proposalData, declaredParentIds, parentFeatures, options, allowFetch = true }) {
        const applyAnyway = options && options.applyAnyway === true;
        const suppress = options && options.suppressMissingParentAlerts === true;
        let features = Array.isArray(parentFeatures) ? parentFeatures.slice() : [];
        const declared = Array.isArray(declaredParentIds) ? declaredParentIds.map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean) : [];

        const computeUnresolvable = () => {
            const resolvedIds = new Set(features.map(f => { const id = _getParcelIdFromFeature(f); return id ? id.toString() : null; }).filter(Boolean));
            const absent = declared.filter(id => !resolvedIds.has(id)); // (A)
            const noGeom = this._getMissingParentParcels(features).map(info => info && info.id ? info.id.toString() : '').filter(Boolean); // (B)
            return Array.from(new Set([...absent, ...noGeom]));
        };

        const relaxDriftedDerivedParents = (a) => {
            if (!a || !Array.isArray(a.notLoaded) || !a.notLoaded.length) return a;
            a.notLoaded = a.notLoaded.filter(id => !this._missingDerivedParentHasLiveFabric(id));
            return a;
        };
        let analysis = relaxDriftedDerivedParents(this._analyzeParentAvailability(declared, computeUnresolvable(), idLabel));
        if (allowFetch && analysis.notLoaded.length && typeof fetchParcelsForIds === 'function') {
            try {
                await fetchParcelsForIds(analysis.notLoaded, { forceRefresh: true });
                const reloaded = this._resolveParcelFeaturesByIds(declared, { preferMap: true, allowStorage: true, fallbackToMap: true, allowMissing: true });
                if (Array.isArray(reloaded) && reloaded.length >= features.length) {
                    features = reloaded;
                }
                analysis = relaxDriftedDerivedParents(this._analyzeParentAvailability(declared, computeUnresolvable(), idLabel));
            } catch (err) {
                console.warn(`[${idLabel}] Failed to fetch not-loaded parent parcels before apply`, err);
            }
        }

        // SimCity-style creation: the freshest drawing wins. When the caller opts in, occupying
        // proposals are parked (unapplied, never deleted) instead of asking — but only when every
        // conflict can be unapplied cleanly; dependency chains still go through the modal, and
        // genuinely missing parcels always do.
        if (options && options.autoParkConflicts === true
            && analysis.conflicts.length > 0
            && analysis.notLoaded.length === 0
            && analysis.conflicts.every(conflict => conflict.canUnapplyCleanly)) {
            // The source a geometry edit is about to absorb is replaced, not parked — unapply it
            // without announcing it, or every edit ends with a misleading "Parked …" toast.
            const absorbSourceId = options.absorbSourceProposalId ? String(options.absorbSourceProposalId) : null;
            const parked = [];
            for (const conflict of analysis.conflicts) {
                const done = await this.unapplyProposal(conflict.proposalId, { skipConfirm: true });
                if (done !== false && String(conflict.proposalId) !== absorbSourceId) parked.push(conflict.title);
            }
            analysis = relaxDriftedDerivedParents(this._analyzeParentAvailability(declared, computeUnresolvable(), idLabel));
            if (parked.length && typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(`Unapplied ${parked.map(title => `“${title}”`).join(', ')} — still in your proposals list.`, 5000, 'info');
            }
        }

        const needsDecision = analysis.conflicts.length > 0 || analysis.notLoaded.length > 0;
        if (needsDecision && !applyAnyway) {
            console.warn(`[${idLabel}] Parent availability requires a decision`, analysis);
            try {
                if (analysis.conflicts.length > 0 && analysis.notLoaded.length === 0) {
                    // Pure geography conflict: retrying will never help — report it as occupancy.
                    const occupiers = analysis.conflicts.map(c => c.title).filter(Boolean);
                    this._setLastApplyFailure(idLabel, {
                        code: 'parcel-conflict',
                        message: `Overlaps applied proposal(s): ${occupiers.join(', ')}`,
                        conflictTitles: occupiers,
                        missingIds: []
                    });
                } else {
                    this._setLastApplyFailure(idLabel, { code: 'dependency-missing', message: 'Prerequisite parcels unavailable or in conflict', missingIds: analysis.notLoaded });
                }
            } catch (_) { }
            if (!suppress) {
                this._showParentConflictModal({
                    proposalId: idLabel,
                    proposalTitle: proposalData.title || proposalData.name || idLabel,
                    analysis,
                    onApplyAnyway: () => this.applyProposal(idLabel, { ...options, applyAnyway: true }),
                    onUnapplyAndRetry: async (conflictProposalId) => {
                        await this.unapplyProposal(conflictProposalId, { skipConfirm: true });
                        return this.applyProposal(idLabel, { ...options, applyAnyway: true });
                    }
                });
            }
            return { defer: true, parentFeatures: features, analysis };
        }

        if (needsDecision && applyAnyway) {
            const skipped = analysis.notLoaded.length;
            const overlapped = analysis.conflicts.reduce((n, c) => n + c.parcelIds.length, 0);
            console.debug(`[${idLabel}] Applying anyway`, { skipped, overlapped });
            if (typeof showEphemeralMessage === 'function' && !suppress && (skipped || overlapped)) {
                const bits = [];
                if (skipped) bits.push(`${skipped} unavailable parcel${skipped === 1 ? '' : 's'}`);
                if (overlapped) bits.push(`overlapping ${overlapped} occupied parcel${overlapped === 1 ? '' : 's'}`);
                showEphemeralMessage(`Applied ${bits.join(', ')}.`, 4000, 'info');
            }
        }

        return { defer: false, parentFeatures: features, analysis };
    },

    /**
     * Modal for the missing-parent / geography-conflict decision. Offers a clean unapply-and-retry
     * for each simple conflict, explains (but does not auto-cascade) chained conflicts, and offers
     * "apply anyway" to proceed with the parcels that are present.
     */
    _showParentConflictModal({ proposalId, proposalTitle, analysis, onApplyAnyway, onUnapplyAndRetry }) {
        try {
            const existing = document.querySelector('.parent-conflict-modal');
            if (existing) existing.remove();

            const conflicts = (analysis && Array.isArray(analysis.conflicts)) ? analysis.conflicts : [];
            const notLoaded = (analysis && Array.isArray(analysis.notLoaded)) ? analysis.notLoaded : [];
            const hasConflicts = conflicts.length > 0;

            const t = (typeof getProposalI18nHelper === 'function')
                ? getProposalI18nHelper()
                : ((key, fallback) => fallback);
            const plural = (n) => (n === 1 ? '' : 's');
            const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

            const conflictHtml = conflicts.map(c => {
                const count = c.parcelIds.length;
                const overlaps = esc(t('ephemeral.messages.proposal_conflict_overlaps', 'Overlaps applied proposal "{{title}}"', { title: c.title }));
                if (c.canUnapplyCleanly) {
                    const shares = esc(t('ephemeral.messages.proposal_conflict_shares', 'Shares {{count}} parcel{{suffix}} with this proposal.', { count, suffix: plural(count) }));
                    const btnLabel = esc(t('ephemeral.messages.proposal_conflict_unapply_continue', 'Unapply it & continue'));
                    return `
                        <div class="parent-conflict-item">
                            <div class="parent-conflict-item-title">${overlaps}</div>
                            <div class="parent-conflict-item-detail">${shares}</div>
                            <button type="button" class="btn btn-warning pc-unapply" data-conflict-id="${esc(c.proposalId)}">${btnLabel}</button>
                        </div>`;
                }
                const sharesBlocked = esc(t('ephemeral.messages.proposal_conflict_shares_blocked', "Shares {{count}} parcel{{suffix}}, but it can't be unapplied on its own — these are built on top of it:", { count, suffix: plural(count) }));
                const hint = esc(t('ephemeral.messages.proposal_conflict_unapply_those_first', 'Unapply those first.'));
                return `
                    <div class="parent-conflict-item parent-conflict-item--blocked">
                        <div class="parent-conflict-item-title">${overlaps}</div>
                        <div class="parent-conflict-item-detail">${sharesBlocked}</div>
                        <div class="parent-conflict-item-blocked-list">${c.blockedByTitles.map(bt => `• ${esc(bt)}`).join('<br>')}</div>
                        <div class="parent-conflict-item-hint">${hint}</div>
                    </div>`;
            }).join('');

            const notLoadedHtml = notLoaded.length
                ? `<div class="parent-conflict-item parent-conflict-item--info">${esc(t('ephemeral.messages.proposal_conflict_not_loaded', '{{count}} ancestor parcel{{suffix}} not loaded. Applying anyway will proceed with the parcels that are present.', { count: notLoaded.length, suffix: plural(notLoaded.length) }))}</div>`
                : '';

            const title = hasConflicts
                ? esc(t('ephemeral.messages.proposal_conflict_title', 'Proposal conflict — same geography'))
                : esc(t('ephemeral.messages.proposal_conflict_missing_title', 'Some parcels are missing'));
            const intro = esc(t('ephemeral.messages.proposal_conflict_intro', 'Applying "{{title}}" needs parcels that aren\'t available:', { title: proposalTitle }));
            const closeLabel = esc(t('ephemeral.messages.proposal_conflict_close', 'Close'));
            const cancelLabel = esc(t('ephemeral.messages.proposal_conflict_cancel', 'Cancel'));
            const applyAnywayLabel = esc(t('ephemeral.messages.proposal_conflict_apply_anyway', 'Apply anyway'));

            const modal = document.createElement('div');
            // Reuse the shared modal shell (.create-proposal-modal + .proposal-modal-*); the extra
            // .parent-conflict-modal class only scopes the body list-item styling.
            modal.className = 'create-proposal-modal parent-conflict-modal';
            modal.innerHTML = `
                <div class="proposal-modal-content">
                    <div class="proposal-modal-header">
                        <h2>${title}</h2>
                        <button type="button" class="proposal-modal-close close-circle-btn close-circle-btn--lg pc-close" aria-label="${closeLabel}">&times;</button>
                    </div>
                    <div class="proposal-modal-body">
                        <p class="parent-conflict-intro">${intro}</p>
                        ${conflictHtml}
                        ${notLoadedHtml}
                    </div>
                    <div class="proposal-modal-footer">
                        <button type="button" class="btn btn-secondary pc-cancel">${cancelLabel}</button>
                        <button type="button" class="btn pc-apply-anyway">${applyAnywayLabel}</button>
                    </div>
                </div>`;

            document.body.appendChild(modal);
            const close = () => { try { modal.remove(); } catch (_) { } };

            modal.querySelector('.pc-close')?.addEventListener('click', close);
            modal.querySelector('.pc-cancel')?.addEventListener('click', close);
            modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

            modal.querySelector('.pc-apply-anyway')?.addEventListener('click', () => {
                close();
                if (typeof onApplyAnyway === 'function') { try { onApplyAnyway(); } catch (err) { console.error('[parent-conflict] applyAnyway failed', err); } }
            });

            modal.querySelectorAll('.pc-unapply').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const conflictId = btn.getAttribute('data-conflict-id');
                    btn.disabled = true;
                    btn.textContent = t('ephemeral.messages.proposal_conflict_unapplying', 'Unapplying…');
                    close();
                    if (typeof onUnapplyAndRetry === 'function') {
                        try { await onUnapplyAndRetry(conflictId); } catch (err) { console.error('[parent-conflict] unapplyAndRetry failed', err); }
                    }
                });
            });
        } catch (err) {
            console.error('[_showParentConflictModal] failed to render', err);
        }
    },
};

// --- HELPER FUNCTIONS (moved from road-drawing.js) ---

function _extractPolygonsWithHolesFromGeometry(geometry) {
    if (!geometry || !geometry.type) return [];
    if (geometry.type === 'Polygon') {
        const coords = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
        return coords.length ? [{ outer: coords[0] || [], holes: coords.slice(1) }] : [];
    }
    if (geometry.type === 'MultiPolygon') {
        const polys = [];
        (geometry.coordinates || []).forEach(poly => {
            if (Array.isArray(poly) && poly.length) {
                polys.push({ outer: poly[0] || [], holes: poly.slice(1) });
            }
        });
        return polys;
    }
    return [];
}

function _getParcelOuterRingsLngLat(feature) {
    const rings = [];
    try {
        const geom = feature.geometry;
        if (geom && geom.type) {
            if (geom.type === 'Polygon') {
                if (Array.isArray(geom.coordinates) && geom.coordinates.length > 0) {
                    const ring = _ensurePolygonIsClosed(geom.coordinates[0]);
                    if (Array.isArray(ring) && ring.length >= 4) rings.push(ring);
                }
            } else if (geom.type === 'MultiPolygon') {
                if (Array.isArray(geom.coordinates)) {
                    geom.coordinates.forEach(poly => {
                        if (Array.isArray(poly) && poly.length > 0) {
                            const ring = _ensurePolygonIsClosed(poly[0]);
                            if (Array.isArray(ring) && ring.length >= 4) rings.push(ring);
                        }
                    });
                }
            }
        }
    } catch (_) { }
    return rings;
}

function _ensurePolygonIsClosed(coords) {
    if (!coords || coords.length < 3) return coords;
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
        const newCoords = [...coords];
        newCoords.push([...first]);
        return newCoords;
    }
    return coords;
}

function _polygonHasSelfIntersection(latLngPolygon) {
    if (!Array.isArray(latLngPolygon) || latLngPolygon.length < 4) return false;

    // Planar self-intersection check on the ring edges (more reliable than Turf validity heuristics).
    const pts = [];
    const EPS = 1e-6;

    for (const p of latLngPolygon) {
        if (!p || !isFinite(p.lat) || !isFinite(p.lng)) continue;
        try {
            const xy = wgs84ToHTRS96(p.lat, p.lng);
            if (!Array.isArray(xy) || xy.length < 2 || !isFinite(xy[0]) || !isFinite(xy[1])) continue;
            const next = { x: xy[0], y: xy[1] };
            if (pts.length > 0) {
                const prev = pts[pts.length - 1];
                if (Math.hypot(next.x - prev.x, next.y - prev.y) < EPS) {
                    continue;
                }
            }
            pts.push(next);
        } catch (_) {
            return false;
        }
    }

    if (pts.length < 4) return false;

    const first = pts[0];
    const last = pts[pts.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) > EPS) {
        pts.push({ x: first.x, y: first.y });
    }

    const segCount = pts.length - 1;
    if (segCount < 3) return false;

    const orient = (a, b, c) => {
        const val = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        if (Math.abs(val) < 1e-9) return 0;
        return val > 0 ? 1 : 2;
    };

    const onSegment = (a, b, c) => {
        return b.x <= Math.max(a.x, c.x) + 1e-9 && b.x + 1e-9 >= Math.min(a.x, c.x)
            && b.y <= Math.max(a.y, c.y) + 1e-9 && b.y + 1e-9 >= Math.min(a.y, c.y);
    };

    const segmentsIntersect = (p1, q1, p2, q2) => {
        const o1 = orient(p1, q1, p2);
        const o2 = orient(p1, q1, q2);
        const o3 = orient(p2, q2, p1);
        const o4 = orient(p2, q2, q1);

        if (o1 !== o2 && o3 !== o4) return true;
        if (o1 === 0 && onSegment(p1, p2, q1)) return true;
        if (o2 === 0 && onSegment(p1, q2, q1)) return true;
        if (o3 === 0 && onSegment(p2, p1, q2)) return true;
        if (o4 === 0 && onSegment(p2, q1, q2)) return true;
        return false;
    };

    for (let i = 0; i < segCount; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        for (let j = i + 1; j < segCount; j++) {
            if (j === i + 1) continue;
            if (i === 0 && j === segCount - 1) continue;
            const c = pts[j];
            const d = pts[j + 1];
            if (segmentsIntersect(a, b, c, d)) return true;
        }
    }

    return false;
}

function _isValidPolygonLatLngs(latLngs) {
    if (!Array.isArray(latLngs) || latLngs.length === 0) return false;
    const isLatLng = (p) => p && typeof p.lat === 'number' && typeof p.lng === 'number';

    if (isLatLng(latLngs[0])) {
        return latLngs.length >= 3;
    }
    if (Array.isArray(latLngs[0]) && latLngs[0].length && isLatLng(latLngs[0][0])) {
        return latLngs[0].length >= 3;
    }
    if (Array.isArray(latLngs[0]) && Array.isArray(latLngs[0][0]) && latLngs[0][0].length && isLatLng(latLngs[0][0][0])) {
        return latLngs.some(poly => Array.isArray(poly) && poly.length > 0 && Array.isArray(poly[0]) && poly[0].length >= 3);
    }
    return false;
}

function _polylineHasSelfIntersection(latLngPoints) {
    if (!Array.isArray(latLngPoints) || latLngPoints.length < 4) return false;

    const pts = [];
    const EPS = 1e-9;
    for (const p of latLngPoints) {
        if (!p || !isFinite(p.lat) || !isFinite(p.lng)) return false;
        try {
            const xy = wgs84ToHTRS96(p.lat, p.lng);
            if (!Array.isArray(xy) || xy.length < 2 || !isFinite(xy[0]) || !isFinite(xy[1])) return false;
            const next = { x: xy[0], y: xy[1] };
            if (pts.length > 0) {
                const prev = pts[pts.length - 1];
                if (Math.hypot(next.x - prev.x, next.y - prev.y) < EPS) continue;
            }
            pts.push(next);
        } catch (_) {
            return false;
        }
    }

    if (pts.length < 4) return false;

    const orient = (a, b, c) => {
        const val = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        if (Math.abs(val) < EPS) return 0;
        return val > 0 ? 1 : 2;
    };

    const onSegment = (a, b, c) => {
        return b.x <= Math.max(a.x, c.x) + EPS && b.x + EPS >= Math.min(a.x, c.x)
            && b.y <= Math.max(a.y, c.y) + EPS && b.y + EPS >= Math.min(a.y, c.y);
    };

    const segmentsIntersect = (p1, q1, p2, q2) => {
        const o1 = orient(p1, q1, p2);
        const o2 = orient(p1, q1, q2);
        const o3 = orient(p2, q2, p1);
        const o4 = orient(p2, q2, q1);

        if (o1 !== o2 && o3 !== o4) return true;
        if (o1 === 0 && onSegment(p1, p2, q1)) return true;
        if (o2 === 0 && onSegment(p1, q2, q1)) return true;
        if (o3 === 0 && onSegment(p2, p1, q2)) return true;
        if (o4 === 0 && onSegment(p2, q1, q2)) return true;
        return false;
    };

    // Segment i is pts[i] -> pts[i+1]
    for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        for (let j = i + 2; j < pts.length - 1; j++) {
            // Skip adjacent segments
            if (j === i + 1) continue;
            const c = pts[j];
            const d = pts[j + 1];
            if (segmentsIntersect(a, b, c, d)) return true;
        }
    }

    return false;
}

function _calculateRoadPolygonFromBuffer(points, width) {
    if (!points || points.length < 2 || !isFinite(width)) {
        return null;
    }

    if (typeof turf === 'undefined' || !turf || typeof turf.lineString !== 'function' || typeof turf.buffer !== 'function') {
        return null;
    }

    try {
        const lineCoords = points.map(p => [p.lng, p.lat]);
        const centerline = turf.lineString(lineCoords);
        const halfWidth = width / 2;

        const buffered = turf.buffer(centerline, halfWidth, {
            units: 'meters',
            steps: 16
        });

        if (!buffered || !buffered.geometry) return null;

        let coords;
        if (buffered.geometry.type === 'Polygon') {
            coords = buffered.geometry.coordinates[0];
        } else if (buffered.geometry.type === 'MultiPolygon') {
            let maxArea = 0;
            let largestCoords = null;
            for (const poly of buffered.geometry.coordinates) {
                try {
                    const polyFeature = turf.polygon([poly[0]]);
                    const area = turf.area(polyFeature);
                    if (area > maxArea) {
                        maxArea = area;
                        largestCoords = poly[0];
                    }
                } catch (_) { }
            }
            coords = largestCoords;
        } else {
            return null;
        }

        if (!coords || coords.length < 4) return null;
        return coords.map(coord => L.latLng(coord[1], coord[0]));
    } catch (error) {
        console.warn('Failed to calculate road polygon from buffer', error);
        return null;
    }
}

function _calculateRoadPolygon(points, width) {
    const isLatLng = (p) => p && typeof p.lat === 'number' && typeof p.lng === 'number';

    // Normalize into an array of centerline segments so we can support multi-segment roads.
    const segments = [];
    if (Array.isArray(points)) {
        if (points.length && isLatLng(points[0])) {
            segments.push(points);
        } else if (points.length && Array.isArray(points[0])) {
            points.forEach(seg => {
                if (Array.isArray(seg) && seg.length >= 2 && isLatLng(seg[0])) {
                    segments.push(seg);
                }
            });
        }
    }

    if (!segments.length || !isFinite(width)) {
        console.warn('Invalid inputs to calculateRoadPolygon:', { pointsLength: Array.isArray(points) ? points.length : undefined, width });
        return null;
    }

    let combined = null;
    for (const segment of segments) {
        if (!Array.isArray(segment) || segment.length < 2) continue;
        const poly = _calculateRoadPolygonRectangular(segment, width);
        if (!poly) continue;
        combined = combined ? (_combineRoadPolygons(combined, poly) || combined) : poly;
    }

    return combined;
}

function _calculateRoadPolygonRectangular(points, width) {
    if (!points || points.length < 2 || !isFinite(width)) {
        console.warn('Invalid inputs to calculateRoadPolygonRectangular:', { pointsLength: points?.length, width });
        return null;
    }

    if (points.length === 2) {
        return _createRectangularRoadSegment(points[0], points[1], width);
    }

    let combinedPolygon = null;

    for (let i = 0; i < points.length - 1; i++) {
        const segment = _createRectangularRoadSegment(points[i], points[i + 1], width);

        if (!segment) {
            console.warn(`Failed to create segment ${i}`);
            continue;
        }

        if (combinedPolygon === null) {
            combinedPolygon = segment;
        } else {
            combinedPolygon = _combineRoadPolygons(combinedPolygon, segment);
        }

        if (!combinedPolygon) {
            console.error(`Failed to combine segment ${i}, reverting to single segment`);
            combinedPolygon = segment;
        }

        if (i >= 1 && i < points.length - 1) {
            try {
                const wedge = _createJointWedgePolygon(points[i - 1], points[i], points[i + 1], width);
                if (wedge) {
                    const combinedWithWedge = _combineRoadPolygons(combinedPolygon, wedge);
                    if (combinedWithWedge) {
                        combinedPolygon = combinedWithWedge;
                    }
                }
            } catch (e) {
                // Silent failure for wedge calculation to avoid interrupting drawing
            }
        }
    }

    return combinedPolygon;
}

function _buildOffsetRoadPolygon(points, width) {
    try {
        const halfWidth = width / 2;
        if (!isFinite(halfWidth) || halfWidth <= 0) {
            return null;
        }

        const rawHTRS = points
            .map(p => wgs84ToHTRS96(p.lat, p.lng))
            .filter(_isValidPoint);

        if (rawHTRS.length < 2) return null;

        const cleanedHTRS = [];
        const minDistance = 0.05;
        for (const pt of rawHTRS) {
            if (cleanedHTRS.length === 0) {
                cleanedHTRS.push(pt);
                continue;
            }
            const prev = cleanedHTRS[cleanedHTRS.length - 1];
            const dx = pt[0] - prev[0];
            const dy = pt[1] - prev[1];
            if (Math.hypot(dx, dy) >= minDistance) {
                cleanedHTRS.push(pt);
            }
        }

        if (cleanedHTRS.length < 2) return null;

        const directions = [];
        for (let i = 0; i < cleanedHTRS.length - 1; i++) {
            const dx = cleanedHTRS[i + 1][0] - cleanedHTRS[i][0];
            const dy = cleanedHTRS[i + 1][1] - cleanedHTRS[i][1];
            const len = Math.hypot(dx, dy);
            directions.push(len < 1e-6 ? null : [dx / len, dy / len]);
        }

        const resolvePrevDirection = (idx) => {
            for (let i = idx - 1; i >= 0; i--) {
                if (directions[i]) return directions[i];
            }
            for (let i = 0; i < directions.length; i++) {
                if (directions[i]) return directions[i];
            }
            return null;
        };

        const resolveNextDirection = (idx) => {
            for (let i = idx; i < directions.length; i++) {
                if (directions[i]) return directions[i];
            }
            for (let i = directions.length - 1; i >= 0; i--) {
                if (directions[i]) return directions[i];
            }
            return null;
        };

        const addVec = (a, b) => [a[0] + b[0], a[1] + b[1]];
        const scaleVec = (v, scalar) => [v[0] * scalar, v[1] * scalar];
        const vecLength = (v) => Math.hypot(v[0], v[1]);
        const leftNormal = (dir) => [-dir[1], dir[0]];
        const rightNormal = (dir) => [dir[1], -dir[0]];

        const computeOffsetPoint = (point, dirPrev, dirNext, side) => {
            const normalFromDir = side === 1 ? leftNormal : rightNormal;

            if (!dirPrev && dirNext) {
                const normal = normalFromDir(dirNext);
                return addVec(point, scaleVec(normal, halfWidth));
            }
            if (dirPrev && !dirNext) {
                const normal = normalFromDir(dirPrev);
                return addVec(point, scaleVec(normal, halfWidth));
            }
            if (!dirPrev && !dirNext) {
                return [point[0], point[1]];
            }

            const normalPrev = normalFromDir(dirPrev);
            const normalNext = normalFromDir(dirNext);
            const summed = addVec(normalPrev, normalNext);
            const sumLen = vecLength(summed);

            if (sumLen < 1e-6) {
                return addVec(point, scaleVec(normalNext, halfWidth));
            }

            const miter = [summed[0] / sumLen, summed[1] / sumLen];
            let dot = miter[0] * normalNext[0] + miter[1] * normalNext[1];
            if (Math.abs(dot) < 1e-6) {
                dot = 1e-6 * Math.sign(dot || 1);
            }

            let scaleFactor = halfWidth / dot;
            const miterLimit = 6;
            const maxScale = miterLimit * halfWidth;
            if (Math.abs(scaleFactor) > maxScale) {
                const fallbackNormal = dot > 0 ? normalNext : normalPrev;
                return addVec(point, scaleVec(fallbackNormal, halfWidth));
            }

            return addVec(point, scaleVec(miter, scaleFactor));
        };

        const leftPts = [];
        const rightPts = [];
        for (let i = 0; i < cleanedHTRS.length; i++) {
            const dirPrev = i > 0 ? resolvePrevDirection(i) : null;
            const dirNext = i < cleanedHTRS.length - 1 ? resolveNextDirection(i) : null;

            const leftPt = computeOffsetPoint(cleanedHTRS[i], dirPrev, dirNext, 1);
            const rightPt = computeOffsetPoint(cleanedHTRS[i], dirPrev, dirNext, -1);

            leftPts.push(leftPt);
            rightPts.push(rightPt);
        }

        const polygonHTRS = [...leftPts, ...rightPts.reverse()];
        if (polygonHTRS.length < 4) return null;

        const first = polygonHTRS[0];
        const last = polygonHTRS[polygonHTRS.length - 1];
        if (Math.hypot(first[0] - last[0], first[1] - last[1]) > 0.001) {
            polygonHTRS.push([...first]);
        }

        return polygonHTRS.map(([x, y]) => {
            const [lat, lng] = htrs96ToWGS84(x, y);
            return L.latLng(lat, lng);
        });
    } catch (error) {
        console.warn('Failed to build offset road polygon', error);
        return null;
    }
}

function _createRectangularRoadSegment(point1, point2, width) {
    // Validate input
    if (!point1 || !point2 || !isFinite(width) || width <= 0) {
        console.warn('Invalid inputs to createRectangularRoadSegment');
        return null;
    }

    if (!isFinite(point1.lat) || !isFinite(point1.lng) ||
        !isFinite(point2.lat) || !isFinite(point2.lng)) {
        console.warn('Invalid coordinates in createRectangularRoadSegment');
        return null;
    }

    // Convert to HTRS96/TM for accurate distance calculations
    const htrsPoint1 = wgs84ToHTRS96(point1.lat, point1.lng);
    const htrsPoint2 = wgs84ToHTRS96(point2.lat, point2.lng);

    // Validate converted points
    if (!_isValidPoint(htrsPoint1) || !_isValidPoint(htrsPoint2)) {
        console.warn('Invalid HTRS points in createRectangularRoadSegment');
        return null;
    }

    // Calculate segment direction
    const dx = htrsPoint2[0] - htrsPoint1[0];
    const dy = htrsPoint2[1] - htrsPoint1[1];
    const length = Math.sqrt(dx * dx + dy * dy);

    // Skip if segment has near-zero length
    if (length < 0.001) {
        return null;
    }

    // Calculate perpendicular vector (normalized)
    const perpX = -dy / length;
    const perpY = dx / length;
    const halfWidth = width / 2;

    const corners = [
        [htrsPoint1[0] + perpX * halfWidth, htrsPoint1[1] + perpY * halfWidth],
        [htrsPoint2[0] + perpX * halfWidth, htrsPoint2[1] + perpY * halfWidth],
        [htrsPoint2[0] - perpX * halfWidth, htrsPoint2[1] - perpY * halfWidth],
        [htrsPoint1[0] - perpX * halfWidth, htrsPoint1[1] - perpY * halfWidth],
        [htrsPoint1[0] + perpX * halfWidth, htrsPoint1[1] + perpY * halfWidth]
    ];

    const wgsCorners = [];
    for (const corner of corners) {
        const [lat, lng] = htrs96ToWGS84(corner[0], corner[1]);
        if (isFinite(lat) && isFinite(lng)) {
            wgsCorners.push(L.latLng(lat, lng));
        }
    }

    if (wgsCorners.length < 4) {
        console.warn('Not enough valid corners for rectangle');
        return null;
    }

    return wgsCorners;
}

function _createJointWedgePolygon(prevPoint, jointPoint, nextPoint, width) {
    if (!prevPoint || !jointPoint || !nextPoint || !isFinite(width) || width <= 0) {
        return null;
    }

    const p0 = wgs84ToHTRS96(prevPoint.lat, prevPoint.lng);
    const pj = wgs84ToHTRS96(jointPoint.lat, jointPoint.lng);
    const p1 = wgs84ToHTRS96(nextPoint.lat, nextPoint.lng);

    if (!_isValidPoint(p0) || !_isValidPoint(pj) || !_isValidPoint(p1)) {
        return null;
    }

    const v1 = [pj[0] - p0[0], pj[1] - p0[1]];
    const v2 = [p1[0] - pj[0], p1[1] - pj[1]];

    const len1 = Math.hypot(v1[0], v1[1]);
    const len2 = Math.hypot(v2[0], v2[1]);
    if (len1 < 1e-6 || len2 < 1e-6) {
        return null;
    }

    const u1 = [v1[0] / len1, v1[1] / len1];
    const u2 = [v2[0] / len2, v2[1] / len2];

    const n1L = [-u1[1], u1[0]];
    const n2L = [-u2[1], u2[0]];
    const n1R = [u1[1], -u1[0]];
    const n2R = [u2[1], -u2[0]];

    const cross = u1[0] * u2[1] - u1[1] * u2[0];
    const outerIsRight = cross > 0;

    const halfWidth = width / 2;

    const n1 = outerIsRight ? n1R : n1L;
    const n2 = outerIsRight ? n2R : n2L;

    const pA = [pj[0] + n1[0] * halfWidth, pj[1] + n1[1] * halfWidth];
    const pB = [pj[0] + n2[0] * halfWidth, pj[1] + n2[1] * halfWidth];

    // Bevel join patch (matches road-drawing.js behavior):
    // Use an interior anchor so only the bevel edge pA->pB can remain on the outer boundary.
    const bisector = [n1[0] + n2[0], n1[1] + n2[1]];
    const bisLen = Math.hypot(bisector[0], bisector[1]);
    if (bisLen < 1e-8) {
        return null;
    }
    const inward = [-bisector[0] / bisLen, -bisector[1] / bisLen];
    const innerAnchor = [pj[0] + inward[0] * (halfWidth * 0.25), pj[1] + inward[1] * (halfWidth * 0.25)];

    const wedgeHTRS = [pA, pB, innerAnchor, pA];

    const result = [];
    for (const pt of wedgeHTRS) {
        const [lat, lng] = htrs96ToWGS84(pt[0], pt[1]);
        if (isFinite(lat) && isFinite(lng)) {
            result.push(L.latLng(lat, lng));
        }
    }

    return result.length >= 3 ? result : null;
}

function _combineRoadPolygons(polygon1, polygon2) {
    if (!polygon1 && polygon2) return polygon2;
    if (polygon1 && !polygon2) return polygon1;
    if (!polygon1 && !polygon2) return null;

    // Prefer the shared implementation from road-drawing.js when available — it has a
    // multi-step fallback ladder (raw union → cleanCoords union → truncate union) that
    // recovers from JSTS topology side-location failures on rectangular road segments.
    // Without this, the first failing union returns one of the two input polygons and
    // the corridor ends up missing every segment after that, which means most parents
    // are never tested for intersection by turf.difference and very few descendants
    // get rebuilt.
    if (typeof window !== 'undefined' && typeof window.combineRoadPolygons === 'function') {
        try {
            const merged = window.combineRoadPolygons(polygon1, polygon2);
            if (merged) return merged;
        } catch (_) { /* fall through to local union */ }
    }

    try {
        if (typeof turf === 'undefined' || !turf || typeof turf.union !== 'function') {
            return polygon2 || polygon1;
        }

        // Union in local planar meters (HTRS) for robustness (see road-drawing.js rationale).
        const toHTRS = (p) => {
            if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number') return null;
            if (typeof wgs84ToHTRS96 !== 'function') return null;
            try {
                const xy = wgs84ToHTRS96(p.lat, p.lng);
                return (Array.isArray(xy) && xy.length >= 2 && isFinite(xy[0]) && isFinite(xy[1])) ? xy : null;
            } catch (_) {
                return null;
            }
        };

        const fromHTRS = (coord) => {
            if (!Array.isArray(coord) || coord.length < 2) return null;
            const x = Number(coord[0]);
            const y = Number(coord[1]);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
            if (typeof htrs96ToWGS84 !== 'function') return null;
            try {
                const out = htrs96ToWGS84(x, y);
                if (!Array.isArray(out) || out.length < 2) return null;
                const lat = Number(out[0]);
                const lng = Number(out[1]);
                if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
                return L.latLng(lat, lng);
            } catch (_) {
                return null;
            }
        };

        if (typeof wgs84ToHTRS96 !== 'function' || typeof htrs96ToWGS84 !== 'function') {
            return polygon2 || polygon1;
        }

        const isLatLng = (p) => p && typeof p.lat === 'number' && typeof p.lng === 'number';

        const toClosedLngLatRing = (ring) => {
            const coords = (Array.isArray(ring) ? ring : [])
                .filter(isLatLng)
                .map(toHTRS)
                .filter(Boolean);
            const closed = _ensurePolygonIsClosed(coords);
            return Array.isArray(closed) && closed.length >= 4 ? closed : null;
        };

        const toTurfFeature = (poly) => {
            if (!Array.isArray(poly) || poly.length === 0) return null;

            // LatLng[]
            if (isLatLng(poly[0])) {
                const ring = toClosedLngLatRing(poly);
                return ring ? turf.polygon([ring]) : null;
            }

            // LatLng[][]
            if (Array.isArray(poly[0]) && poly[0].length && isLatLng(poly[0][0])) {
                const rings = poly.map(toClosedLngLatRing).filter(Boolean);
                return rings.length ? turf.polygon(rings) : null;
            }

            // LatLng[][][]
            if (Array.isArray(poly[0]) && Array.isArray(poly[0][0]) && poly[0][0].length && isLatLng(poly[0][0][0])) {
                const polys = poly
                    .map(polyRings => (Array.isArray(polyRings) ? polyRings : []).map(toClosedLngLatRing).filter(Boolean))
                    .filter(rings => rings.length > 0);
                return polys.length ? turf.multiPolygon(polys) : null;
            }

            return null;
        };

        const feature1 = toTurfFeature(polygon1);
        const feature2 = toTurfFeature(polygon2);
        if (!feature1 && feature2) return polygon2;
        if (feature1 && !feature2) return polygon1;
        if (!feature1 || !feature2) return null;

        // Layered union: raw → cleanCoords → truncate. JSTS occasionally fails with
        // "Unable to complete output ring" on adjacent rectangular road segments because
        // of duplicate or near-duplicate vertices; cleanCoords removes those, and truncate
        // snaps coordinates to a centimetre grid which heals topology-side-location errors.
        // Without this ladder, a single failing union loses the rest of the corridor and
        // most parents never get cut by the road.
        const tryUnion = (a, b) => turf.union(a, b);
        let combined = null;
        const unionAttempts = [
            () => tryUnion(feature1, feature2),
            () => {
                if (typeof turf.cleanCoords !== 'function') return null;
                const f1 = turf.cleanCoords(feature1, { mutate: false }) || feature1;
                const f2 = turf.cleanCoords(feature2, { mutate: false }) || feature2;
                return tryUnion(f1, f2);
            },
            () => {
                if (typeof turf.truncate !== 'function') return null;
                const f1 = turf.truncate(feature1, { precision: 2, coordinates: 2, mutate: false }) || feature1;
                const f2 = turf.truncate(feature2, { precision: 2, coordinates: 2, mutate: false }) || feature2;
                return tryUnion(f1, f2);
            },
            () => {
                if (typeof turf.truncate !== 'function') return null;
                const f1 = turf.truncate(feature1, { precision: 1, coordinates: 2, mutate: false }) || feature1;
                const f2 = turf.truncate(feature2, { precision: 1, coordinates: 2, mutate: false }) || feature2;
                return tryUnion(f1, f2);
            }
        ];
        for (const attempt of unionAttempts) {
            try {
                const result = attempt();
                if (result && result.geometry) {
                    combined = result;
                    break;
                }
            } catch (_) { /* try next */ }
        }
        if (!combined || !combined.geometry) return polygon2 || polygon1;

        const geom = combined.geometry;
        const toLatLngRing = (ring) => (Array.isArray(ring) ? ring : []).map(fromHTRS).filter(Boolean);

        if (geom.type === 'Polygon') {
            const rings = (geom.coordinates || []).map(toLatLngRing).filter(r => r.length >= 4);
            if (!rings.length) return null;
            return rings.length === 1 ? rings[0] : rings;
        }

        if (geom.type === 'MultiPolygon') {
            const polys = (geom.coordinates || [])
                .map(polyRings => (Array.isArray(polyRings) ? polyRings : [])
                    .map(toLatLngRing)
                    .filter(r => r.length >= 4))
                .filter(rings => rings.length > 0);
            return polys.length ? polys : null;
        }

        return null;
    } catch (error) {
        console.error('Error combining road polygons:', error);
        return polygon2 || polygon1;
    }
}

function _isValidPoint(point) {
    return point &&
        Array.isArray(point) &&
        point.length === 2 &&
        isFinite(point[0]) &&
        isFinite(point[1]);
}

function _calculateAreaFromLatLngPolygon(latLngPolygon) {
    try {
        if (!latLngPolygon || typeof turf === 'undefined' || !turf || typeof turf.area !== 'function') {
            return 0;
        }

        const isLatLng = (p) => p && typeof p.lat === 'number' && typeof p.lng === 'number';
        const toClosedLngLatRing = (ring) => {
            const coords = (Array.isArray(ring) ? ring : [])
                .filter(isLatLng)
                .map(p => [p.lng, p.lat]);
            const closed = _ensurePolygonIsClosed(coords);
            return Array.isArray(closed) && closed.length >= 4 ? closed : null;
        };

        const toTurfFeature = (poly) => {
            if (!Array.isArray(poly) || poly.length === 0) return null;
            if (isLatLng(poly[0])) {
                const ring = toClosedLngLatRing(poly);
                return ring ? turf.polygon([ring]) : null;
            }
            if (Array.isArray(poly[0]) && poly[0].length && isLatLng(poly[0][0])) {
                const rings = poly.map(toClosedLngLatRing).filter(Boolean);
                return rings.length ? turf.polygon(rings) : null;
            }
            if (Array.isArray(poly[0]) && Array.isArray(poly[0][0]) && poly[0][0].length && isLatLng(poly[0][0][0])) {
                const polys = poly
                    .map(polyRings => (Array.isArray(polyRings) ? polyRings : []).map(toClosedLngLatRing).filter(Boolean))
                    .filter(rings => rings.length > 0);
                return polys.length ? turf.multiPolygon(polys) : null;
            }
            return null;
        };

        const feature = toTurfFeature(latLngPolygon);
        if (!feature) return 0;
        return turf.area(feature) || 0;
    } catch (e) {
        return 0;
    }
}

function _ensureClosedRing(ring = []) {
    if (!Array.isArray(ring)) return null;
    const filtered = ring
        .map(pair => {
            if (!Array.isArray(pair) || pair.length < 2) return null;
            const lng = Number(pair[0]);
            const lat = Number(pair[1]);
            return (Number.isFinite(lng) && Number.isFinite(lat)) ? [lng, lat] : null;
        })
        .filter(Boolean);
    if (filtered.length < 3) return null;

    const first = filtered[0];
    const last = filtered[filtered.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
        filtered.push([first[0], first[1]]);
    }

    return filtered.length >= 4 ? filtered : null;
}

function _mergeParcelGeometries(features = []) {
    if (!Array.isArray(features) || typeof turf === 'undefined') return null;

    const normalizePolygon = (rings) => {
        if (!Array.isArray(rings)) return null;
        const normalized = rings.map(_ensureClosedRing).filter(Boolean);
        return normalized.length ? normalized : null;
    };

    const polygons = [];
    features.forEach(feature => {
        const geometry = feature?.geometry;
        if (!geometry) return;
        if (geometry.type === 'Polygon') {
            const normalized = normalizePolygon(geometry.coordinates);
            if (normalized) polygons.push(normalized);
        } else if (geometry.type === 'MultiPolygon') {
            (geometry.coordinates || []).forEach(poly => {
                const normalized = normalizePolygon(poly);
                if (normalized) polygons.push(normalized);
            });
        }
    });

    if (!polygons.length) return null;

    let merged;
    try {
        merged = turf.polygon(polygons[0]);
    } catch (err) {
        console.warn('[_mergeParcelGeometries] Failed to initialise polygon', err);
        return null;
    }

    for (let i = 1; i < polygons.length; i++) {
        try {
            merged = turf.union(merged, turf.polygon(polygons[i]));
        } catch (err) {
            console.warn('[_mergeParcelGeometries] Failed to union polygons', err);
            return null;
        }
    }

    return merged?.geometry || null;
}

function _calculateGeoJsonArea(geometry) {
    if (!geometry || typeof turf === 'undefined') return 0;
    try {
        const area = turf.area(geometry);
        return Number.isFinite(area) ? area : 0;
    } catch (_) {
        return 0;
    }
}

function _geometryHash(coords) {
    return JSON.stringify(coords.map(ring => ring.map(
        pt => [Number(pt[0].toFixed(6)), Number(pt[1].toFixed(6))]
    )));
}

function _stripSyntheticSuffix(value) {
    let current = (value !== undefined && value !== null) ? String(value).trim() : '';
    if (!current) return '';

    let previous = '';
    while (current && current !== previous) {
        previous = current;
        current = current.replace(/#[A-Za-z0-9_-]+-\d+$/i, '');
    }

    return current;
}

function _extractRootParcelNumber(parcelNumber) {
    if (!parcelNumber && parcelNumber !== 0) return '';
    const str = _stripSyntheticSuffix(parcelNumber);
    if (str.length === 0) return '';
    return str.split('/')[0];
}

function _extractRootParcelId(parcelId) {
    if (!parcelId && parcelId !== 0) return '';
    return _stripSyntheticSuffix(parcelId);
}

function _deriveRootParcelNumberFromParcelId(parcelId) {
    const rootId = _extractRootParcelId(parcelId);
    if (!rootId) return '';

    const hrMatch = String(rootId).match(/^HR-\d+-([^#]+)$/i);
    if (hrMatch && hrMatch[1]) {
        return _extractRootParcelNumber(hrMatch[1]);
    }

    return '';
}

function _resolveRootParcelIdFromProperties(props, fallbackParcelId = null) {
    const candidates = [
        props?.rootParcelId,
        props?.parentParcelId,
        props?.parcelId,
        fallbackParcelId
    ];

    for (const candidate of candidates) {
        const rootId = _extractRootParcelId(candidate);
        if (rootId) return rootId;
    }

    return '';
}

function _resolveRootParcelNumberFromProperties(props, fallbackParcelId = null) {
    const candidates = [
        props?.rootParcelNumber,
        props?.parentParcelNumber,
        props?.BROJ_CESTICE,
        props?.parcelNumber,
        props?.parcel_number
    ];

    for (const candidate of candidates) {
        const rootNumber = _extractRootParcelNumber(candidate);
        if (rootNumber) return rootNumber;
    }

    return _deriveRootParcelNumberFromParcelId(fallbackParcelId);
}

// A split piece below this area (m²) is geometric noise from turf.difference (a degenerate
// sliver along the corridor edge), not a real cadastral sub-parcel. Dropping these keeps the
// regenerated child set stable — such slivers used to flip a parcel between 1 and 2 children
// depending on sub-metre differences in the regenerated corridor edge.
const MIN_MEANINGFUL_CHILD_AREA = 1; // m²

function _shouldSkipUncutRemainder(parentParcelArea, pieceArea) {
    const parentArea = Number(parentParcelArea);
    const remainderArea = Number(pieceArea);
    if (!Number.isFinite(parentArea) || !Number.isFinite(remainderArea) || parentArea <= 0 || remainderArea <= 0) {
        return false;
    }

    // "Uncut remainder" means the road did not actually intersect this parcel — turf.difference
    // handed back (essentially) the whole parent polygon. Detect that with a RELATIVE tolerance so
    // the threshold scales with parcel size instead of a flat 1 m² cliff. The old flat floor made
    // a genuine ~1 m² clip on a small parcel read as "uncut", so the parcel flipped between 0 and 1
    // child on sub-metre corridor differences. A tiny relative window (0.01% of the parent, with a
    // small absolute floor to absorb floating-point noise) skips only the true no-intersection case
    // and keeps real small cuts — matching this function's original stated intent.
    const tolerance = Math.max(0.01, parentArea * 1e-4);
    return Math.abs(parentArea - remainderArea) <= tolerance;
}

(function hydrateAppliedReparcellizationOverlays() {
    if (typeof window === 'undefined') return;
    let attempts = 0;
    const maxAttempts = 12;

    const hydrate = () => {
        const mapInstance = ProposalManager._getActiveMap ? ProposalManager._getActiveMap() : null;
        if ((!mapInstance || typeof proposalStorage === 'undefined' || typeof proposalStorage.getAllProposals !== 'function') && attempts < maxAttempts) {
            attempts += 1;
            setTimeout(hydrate, 800);
            return;
        }
        if (!mapInstance || typeof proposalStorage === 'undefined' || typeof proposalStorage.getAllProposals !== 'function') {
            return;
        }
        try {
            const proposals = proposalStorage.getAllProposals();
            proposals.forEach(proposal => {
                if (!proposal || !proposal.reparcellization) return;
                const status = (proposal.reparcellization.status || '').toLowerCase();
                if (status === 'applied') {
                    ProposalManager._renderReparcellizationPlan(proposal.reparcellization, proposal.proposalId);
                }
            });
        } catch (error) {
            console.warn('Failed to hydrate reparcellization overlays', error);
        }
    };

    setTimeout(hydrate, 600);
})();

(function registerProposalReapplyHooks() {
    if (typeof window === 'undefined') return;

    // Full reapply once on load (after parcels start arriving)
    window.addEventListener('load', () => {
        setTimeout(() => {
            if (window.ProposalManager && typeof window.ProposalManager.reapplyAppliedProposals === 'function') {
                window.ProposalManager.reapplyAppliedProposals();
            }
        }, 300);
    });
})();


// Make it accessible globally
window.ProposalManager = ProposalManager;
