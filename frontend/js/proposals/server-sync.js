// proposals/server-sync.js — extracted from proposals.js (behavior-preserving relocation).

function resolveCurrentCityCode() {
    try {
        const mgr = typeof window !== 'undefined' ? window.CityConfigManager : null;
        if (mgr && typeof mgr.getCurrentCityConfig === 'function' && typeof mgr.getCityCodeForCityId === 'function') {
            const cfg = mgr.getCurrentCityConfig();
            if (cfg && cfg.id) {
                const code = mgr.getCityCodeForCityId(cfg.id);
                if (code) return code;
            }
        }
    } catch (_) { /* best effort */ }
    try {
        if (typeof getCurrentCityId === 'function') {
            const id = getCurrentCityId();
            if (id) return id;
        }
    } catch (_) { /* ignore */ }
    return 'city';
}

function normalizeServerProposalSummary(raw, cityCode) {
    if (!raw || typeof raw !== 'object') return null;
    const city = raw.city || cityCode || resolveCurrentCityCode();
    const serverId = raw.id !== undefined && raw.id !== null ? String(raw.id) : null;
    const proposalId = raw.proposalId !== undefined && raw.proposalId !== null
        ? String(raw.proposalId)
        : (serverId || null);
    const titleCandidate = raw.title || raw.name || `Proposal ${proposalId || serverId || ''}`;
    const goalKey = normalizeProposalGoalKey(raw.goal || raw.type || '');

    return {
        id: serverId || proposalId,
        proposalId: proposalId || serverId,
        serverProposalId: serverId || proposalId,
        city,
        name: raw.name || raw.title || null,
        title: titleCandidate || '',
        author: raw.author || '',
        type: raw.type || raw.goal || 'parcel',
        goal: goalKey || 'parcel',
        status: raw.status || 'Active',
        createdAt: raw.createdAt || raw.created_at || null,
        updatedAt: raw.updatedAt || raw.updated_at || null,
        // The summary endpoint serves the server-rendered thumbnail (COALESCE(screenshot_url,
        // onchain_data->>'imageUrl')). Dropping it here is what made the server tab fall back to
        // the goal emoji for every row, even though almost all of them have a picture.
        screenshotUrl: raw.screenshotUrl || raw.screenshot_url || null,
        parentParcelIds: Array.isArray(raw.parentParcelIds) ? raw.parentParcelIds : [],
        childParcelIds: Array.isArray(raw.childParcelIds) ? raw.childParcelIds : [],
        acceptedParcelIds: Array.isArray(raw.acceptedParcelIds) ? raw.acceptedParcelIds : [],
        isMinted: false
    };
}

function isServerProposalDownloaded(summary) {
    if (!summary || typeof proposalStorage === 'undefined' || typeof proposalStorage.getProposal !== 'function') {
        return false;
    }
    const candidates = [summary.serverProposalId, summary.proposalId, summary.id];
    return candidates.some(key => key && proposalStorage.getProposal(key));
}

function resetServerProposalCache(cityCode) {
    serverProposalCache.proposals = [];
    serverProposalCache.count = null;
    serverProposalCache.error = null;
    serverProposalCache.loading = false;
    serverProposalCache.lastCity = cityCode || null;
    // The "have we asked the server yet?" sentinel must be cleared with the rest, or the new city
    // would inherit the previous one's answer and never fetch.
    serverProposalCache.lastFetchedAt = 0;
}

async function fetchServerProposalSummaries(cityCode) {
    const city = normalizeCityCodeForApi(cityCode || resolveCurrentCityCode());
    serverProposalCache.loading = true;
    serverProposalCache.error = null;
    serverProposalCache.lastCity = city;
    renderProposalListModal();

    const backendBase = resolveBackendBaseUrl();
    // The summary already returns the full total via COUNT(*) OVER(), so the separate
    // /proposals/count round-trip was redundant — one request, not two.
    const summaryUrl = `${backendBase}/proposals/summary?limit=${SERVER_PROPOSAL_SUMMARY_LIMIT}&offset=0${city ? `&city=${encodeURIComponent(city)}` : ''}`;

    try {
        const summaryResp = await fetch(summaryUrl);

        if (!summaryResp.ok) {
            const text = await summaryResp.text();
            throw new Error(text || 'Failed to fetch proposal summaries');
        }

        const summaryPayload = await summaryResp.json();

        const summaries = Array.isArray(summaryPayload?.proposals)
            ? summaryPayload.proposals
            : [];

        serverProposalCache.proposals = summaries
            .map(item => normalizeServerProposalSummary(item, city))
            .filter(Boolean);

        serverProposalCache.count = Number.isFinite(summaryPayload?.count)
            ? Number(summaryPayload.count)
            : serverProposalCache.proposals.length;
    } catch (error) {
        serverProposalCache.error = error?.message || 'Unable to load server proposals';
    } finally {
        serverProposalCache.loading = false;
        // Record the attempt, not just the success. This is what stops the re-render below from
        // being mistaken for "we have never asked" — renderProposalListModal() calls back into
        // ensureServerProposals(), so a city with no server proposals (or an unreachable backend)
        // would otherwise refetch forever and sit on "Loading server proposals…".
        serverProposalCache.lastFetchedAt = Date.now();
        renderProposalListModal();
    }
}

function ensureServerProposals(cityCode) {
    const city = normalizeCityCodeForApi(cityCode || resolveCurrentCityCode());
    const cacheCity = serverProposalCache.lastCity;
    const cityChanged = cacheCity && cacheCity !== city;

    if (cityChanged) {
        resetServerProposalCache(city);
    }

    if (serverProposalCache.loading) return;
    // "No proposals" is an answer, not a missing one — testing proposals.length here made a city
    // with an empty server list refetch on every render, forever.
    const alreadyAsked = serverProposalCache.lastFetchedAt > 0;
    if (!alreadyAsked || cityChanged) {
        fetchServerProposalSummaries(city);
    }
}

async function fetchServerProposalById(serverId, cityCode) {
    if (!serverId) {
        throw new Error('proposal id is required');
    }

    const backendBase = resolveBackendBaseUrl();
    const url = `${backendBase}/proposals/${encodeURIComponent(serverId)}`;

    const resp = await fetch(url);
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text || `Failed to download proposal ${serverId}`);
    }
    const payload = await resp.json();
    const normalized = { ...payload };
    // `serverProposalId` must be the server's serial id — the numeric `id` column. The payload's
    // `proposalId` is the uploader's *local* id (e.g. "p-1lo0n6ope6h"), and using it here left the
    // downloaded proposal without a shareable id: share links require /^\d+$/, so the share dialog
    // decided the proposal had never been uploaded and offered to upload it again.
    const serialId = (payload && payload.id !== undefined && payload.id !== null) ? String(payload.id) : null;
    const numericFallback = /^\d+$/.test(String(serverId || '')) ? String(serverId) : null;
    normalized.serverProposalId = serialId || numericFallback || normalized.serverProposalId || serverId;
    normalized.proposalId = payload.proposalId || payload.proposal_id || serverId;
    return normalized;
}

function syncProposalsIndicator() {
    // Proposals are always shown now, no checkbox to sync
    // Reset any previously set opacity on the Proposals header to keep it consistent
    const sections = document.querySelectorAll('.accordion-section[data-section="proposals"]');
    sections.forEach(section => {
        const header = section.querySelector('.accordion-header');
        if (header) {
            header.style.opacity = ''; // Clear inline opacity
        }
    });
}

function getServerProposalId(proposal) {
    if (!proposal) return null;
    const candidates = [proposal.serverProposalId, proposal.proposalId, proposal.id];
    for (const candidate of candidates) {
        if (!candidate) continue;
        const id = String(candidate);
        // Local proposals are not shareable via server links.
        // Example: local-0, local-1
        if (/^local-\d+$/i.test(id)) return null;
        return id;
    }
    return null;
}

function buildCityQueryParam() {
    const mgr = (typeof window !== 'undefined') ? window.CityConfigManager : null;
    if (!mgr) return '';

    // Get current city config
    const cfg = mgr.getCurrentCityConfig && typeof mgr.getCurrentCityConfig === 'function' ? mgr.getCurrentCityConfig() : null;
    if (!cfg || !cfg.id) return '';

    // Get city code from city config manager
    const getCityCode = mgr.getCityCodeForCityId && typeof mgr.getCityCodeForCityId === 'function' ? mgr.getCityCodeForCityId : null;
    if (!getCityCode) return '';

    const code = getCityCode(cfg.id);
    if (!code) return '';

    return `?city=${encodeURIComponent(code)}`;
}

function mapGoalToBackendType(goalKey) {
    switch (goalKey) {
        case 'road-track':
            return 'road';
        case 'buildings':
        case 'single':
        case 'row':
            return 'building';
        case 'parcelbased':
        case 'parcel-based':
        case 'parcel':
            return 'parcel';
        case 'park':
        case 'square':
        case 'lake':
            return 'structure';
        default:
            return null;
    }
}

function syncProposalWithServerId(proposal, serverProposalId) {
    if (!serverProposalId || typeof proposalStorage === 'undefined') return null;
    const oldProposalId = proposal.proposalId;
    const proposalId = proposal.proposalId;
    let storedProposal = oldProposalId ? proposalStorage.getProposal(oldProposalId) : null;
    if (!storedProposal && proposalId) {
        storedProposal = proposalStorage.getProposal(proposalId);
    }
    if (!storedProposal) return null;

    // Preserve local proposalId; store server reference separately
    storedProposal.serverProposalId = String(serverProposalId);
    storedProposal.id = storedProposal.id || storedProposal.proposalId;

    // Older versions indexed the same proposal under the server id key, which caused duplicates in getAllProposals().
    // We resolve server ids via proposalStorage._resolveProposalId now, so ensure any legacy alias entry is removed.
    if (proposalStorage.proposals) {
        const serverKey = String(serverProposalId);
        const canonicalKey = storedProposal.proposalId ? String(storedProposal.proposalId) : null;
        if (serverKey && canonicalKey && serverKey !== canonicalKey) {
            const aliased = proposalStorage.proposals.get(serverKey);
            if (aliased === storedProposal) {
                proposalStorage.proposals.delete(serverKey);
            }
        }
    }

    migrateRoadAssetsToNewId(oldProposalId, serverProposalId);

    if (typeof proposalStorage._indexProposal === 'function') {
        proposalStorage._indexProposal(storedProposal);
    }

    if (typeof proposalStorage.save === 'function') {
        proposalStorage.save();
    }

    return storedProposal;
}

async function uploadProposalToServer(proposal) {
    const uploadProposal = buildUploadReadyProposal(proposal);
    if (!uploadProposal) {
        return { ok: false, message: 'Invalid proposal.' };
    }

    const backendBase = resolveBackendBaseUrl();
    try {
        const response = await fetch(`${backendBase}/proposals/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(uploadProposal)
        });

        let errorBody = null;
        if (!response.ok) {
            try { errorBody = await response.json(); } catch (_) { }

            if (response.status === 409 && errorBody && errorBody.id) {
                const serverProposalId = errorBody.id ? String(errorBody.id) : (errorBody.proposalId ? String(errorBody.proposalId) : null);
                if (serverProposalId) {
                    syncProposalWithServerId(proposal, serverProposalId);
                }
                return { ok: true, id: errorBody.id, proposalId: serverProposalId || errorBody.id };
            }

            const errorMessage = errorBody && errorBody.error
                ? errorBody.error
                : 'Failed to upload proposal. Please try again.';
            return { ok: false, message: errorMessage };
        }

        const result = await response.json();
        const serverProposalId = result && result.id ? String(result.id) : String(result.proposalId);
        syncProposalWithServerId(proposal, serverProposalId);
        return { ok: true, id: result.id, proposalId: serverProposalId };
    } catch (error) {
        console.error('uploadProposalToServer failed', error);
        return { ok: false, message: error.message || 'Upload failed.' };
    }
}

async function headProposalExists(proposalId, _city, proposalForSync) {
    if (!proposalId) return false;
    const backendBase = resolveBackendBaseUrl();
    const id = String(proposalId).trim();
    const isNumericId = /^\d+$/.test(id);

    const url = `${backendBase}/proposals/${encodeURIComponent(id)}`;

    try {
        const response = await fetch(url, { method: isNumericId ? 'HEAD' : 'GET' });
        if (response.ok) {
            if (!isNumericId && proposalForSync) {
                try {
                    const payload = await response.clone().json();
                    const serverDbId = payload && payload.id ? String(payload.id) : null;
                    if (serverDbId && !isLocalProposalId(serverDbId)) {
                        syncProposalWithServerId(proposalForSync, serverDbId);
                    }
                } catch (_) { /* ignore json parse */ }
            }
            return true;
        }
        if (response.status === 404) return false;
    } catch (error) {
        console.warn('headProposalExists failed', error);
    }
    return false;
}

async function ensureAncestorProposalsUploaded(proposal) {
    const missing = [];
    if (!proposal || typeof ProposalManager === 'undefined' || typeof ProposalManager.findAncestorTree !== 'function' || typeof proposalStorage === 'undefined') {
        return { ok: true, missing };
    }

    const proposalKey = getProposalKey(proposal) || proposal.proposalId;
    if (!proposalKey) {
        return { ok: true, missing };
    }

    let ancestorNodes = [];
    try {
        ancestorNodes = ProposalManager.findAncestorTree(String(proposalKey), { depthLimit: 32 }) || [];
    } catch (error) {
        console.warn('ensureAncestorProposalsUploaded: failed to compute ancestor tree', error);
        return { ok: true, missing };
    }

    const ancestorHashes = Array.from(new Set(ancestorNodes.map(n => n.proposalId).filter(Boolean)));
    if (!ancestorHashes.length) {
        return { ok: true, missing };
    }

    const checks = await Promise.all(ancestorHashes.map(async hash => {
        const ancestor = proposalStorage.getProposal(hash);
        if (!ancestor) {
            return { hash, reason: 'missing-local', id: null };
        }
        const serverId = getServerProposalId(ancestor);
        if (!serverId) {
            return { hash, reason: 'local-only', id: null };
        }
        const exists = await headProposalExists(serverId, ancestor.city || proposal.city, ancestor);
        return exists ? null : { hash, reason: 'not-found', id: serverId };
    }));

    checks.filter(Boolean).forEach(entry => missing.push(entry));
    return { ok: missing.length === 0, missing };
}

async function ensureParentParcelsLoaded(parcelIds, options = {}) {
    if (!Array.isArray(parcelIds) || parcelIds.length === 0) return;
    const missing = findMissingParentParcels(parcelIds);
    if (!missing.length) {
        if (options.preloadOwners) {
            await preloadProposalParcelOwners(parcelIds, { forceRefresh: !!options.forceOwnerRefresh });
        }
        return;
    }

    // Single bulk fetch — no individual retries. If bulk didn't resolve them,
    // they're either unreachable or in a different city and will load when
    // the viewport moves there.
    await fetchParcelsForIds(missing, {
        forceRefresh: options.forceRefreshParcels,
        onProgress: options.onProgress
    });

    const finalMissing = findMissingParentParcels(parcelIds);
    if (finalMissing.length) {
        console.debug(`[ensureParentParcelsLoaded] ${finalMissing.length}/${parcelIds.length} parcels still missing after bulk fetch`);
    }
    if (!finalMissing.length && options.preloadOwners) {
        await preloadProposalParcelOwners(parcelIds, { forceRefresh: !!options.forceOwnerRefresh });
    }
}

async function fetchParcelsForIds(parcelIds, options = {}) {
    if (!Array.isArray(parcelIds) || parcelIds.length === 0) return;
    const unique = Array.from(new Set(parcelIds.map(id => id && id.toString ? id.toString() : id).filter(Boolean)));
    if (!unique.length) return;

    if (typeof fetchParcelsByIds === 'function') {
        await fetchParcelsByIds(unique, {
            forceRefresh: !!options.forceRefresh,
            onProgress: options.onProgress
        });
        return;
    }

    if (typeof fetchSingleParcelById === 'function') {
        await Promise.allSettled(unique.map(id => fetchSingleParcelById(id)));
        return;
    }

    if (typeof fetchParcelData === 'function') {
        try {
            await fetchParcelData();
        } catch (error) {
            console.warn('fetchParcelsForIds fallback fetchParcelData failed', error);
        }
    }
}

async function preloadProposalParcelOwners(parcelIds, options = {}) {
    if (!Array.isArray(parcelIds) || parcelIds.length === 0) {
        return;
    }
    if (typeof ensureParcelOwnerSlots !== 'function') {
        return;
    }
    const forceRefresh = options && options.forceRefresh === true;
    const uniqueIds = Array.from(new Set(
        parcelIds
            .map(id => (id && id.toString ? id.toString() : id))
            .filter(Boolean)
    ));
    if (!uniqueIds.length) {
        return;
    }

    await Promise.allSettled(uniqueIds.map(async parcelId => {
        try {
            await ensureParcelOwnerSlots(parcelId, { forceRefresh });
        } catch (error) {
            console.warn('preloadProposalParcelOwners: failed to fetch owners for', parcelId, error);
        }
    }));
}

function findMissingParentParcels(parentIds) {
    if (!Array.isArray(parentIds) || parentIds.length === 0) return [];

    // Check if parcelLayer is available before checking for missing parcels
    // This prevents warnings when the layer isn't ready yet
    const isParcelLayerReady = (typeof parcelLayer !== 'undefined' && parcelLayer && typeof parcelLayer.eachLayer === 'function') ||
        (typeof multiParcelSelection !== 'undefined' && multiParcelSelection && typeof multiParcelSelection.findParcelById === 'function');

    if (!isParcelLayerReady) {
        // If parcel layer isn't ready, assume all parcels are missing (they'll be loaded)
        return parentIds.map(id => id && id.toString ? id.toString() : String(id)).filter(Boolean);
    }

    const missing = [];
    parentIds.forEach(id => {
        const parcelId = id && id.toString ? id.toString() : String(id);
        if (!parcelId) return;
        if (typeof ProposalManager !== 'undefined' && typeof ProposalManager.isSyntheticParcelId === 'function'
            && ProposalManager.isSyntheticParcelId(parcelId)) {
            return;
        }
        const layer = (typeof multiParcelSelection !== 'undefined' && typeof multiParcelSelection.findParcelById === 'function')
            ? multiParcelSelection.findParcelById(parcelId)
            : null;
        if (!layer || !layer.feature) {
            missing.push(parcelId);
        }
    });
    return missing;
}

function prepareProposalForImport(sharedProposal) {
    if (!sharedProposal || typeof sharedProposal !== 'object') return null;

    const parentIds = ensureArrayOfStrings(sharedProposal.parentParcelIds);
    const inferredGoal = (() => {
        try {
            const explicit = normalizeProposalGoalKey(sharedProposal.goal);
            if (explicit) return explicit;
            if (sharedProposal.decideLaterProposal) return 'decide-later';
            if (sharedProposal.roadProposal) return 'road-track';
            if (sharedProposal.reparcellization) return 'reparcellization';
            if (sharedProposal.structureProposal && sharedProposal.structureProposal.kind) {
                const kind = normalizeProposalGoalKey(sharedProposal.structureProposal.kind);
                if (kind === 'park' || kind === 'square' || kind === 'lake') return kind;
            }
            if (sharedProposal.buildingProposal || (sharedProposal.geometry && Array.isArray(sharedProposal.geometry.buildings) && sharedProposal.geometry.buildings.length)) {
                return 'buildings';
            }
            return 'parcel';
        } catch (_) {
            return 'parcel';
        }
    })();

    const isDecideLater = inferredGoal === 'decide-later';

    // Preserve server ID for lookup by URL parameter later.
    const serverId = sharedProposal.id || sharedProposal.proposalId || sharedProposal.proposal_id;
    const serverProposalId = (serverId && /^\d+$/.test(String(serverId))) ? String(serverId) : (sharedProposal.serverProposalId || null);

    const base = {
        proposalId: sharedProposal.proposalId || sharedProposal.proposal_id || sharedProposal.id || null,
        serverProposalId,
        title: sharedProposal.title || sharedProposal.name || null,
        goal: inferredGoal,
        childParcelIds: ensureArrayOfStrings(sharedProposal.childParcelIds),
        acceptedParcelIds: ensureArrayOfStrings(sharedProposal.acceptedParcelIds),
        author: sharedProposal.author || sharedProposal.createdBy || sharedProposal.owner || null,
        description: typeof sharedProposal.description === 'string' ? sharedProposal.description : '',
        offer: (typeof sharedProposal.offer === 'number') ? sharedProposal.offer : (sharedProposal.offer || null),
        createdAt: sharedProposal.createdAt || new Date().toISOString(),
        updatedAt: sharedProposal.updatedAt || sharedProposal.createdAt || new Date().toISOString(),
        status: sharedProposal.status || 'Active',
        color: sharedProposal.color || null,
        parentParcelIds: parentIds
    };
    const lensEntries = normalizeLensEntries(sharedProposal.lens || sharedProposal.lensEntries || sharedProposal.lensAddresses);
    if (lensEntries.length) {
        base.lens = lensEntries;
    }

    // Decide-later proposals intentionally have no uploaded geometry.
    // They are applied by deriving geometry from parent parcels on the target.
    if (isDecideLater) {
        const raw = sharedProposal.decideLaterProposal && typeof sharedProposal.decideLaterProposal === 'object'
            ? sharedProposal.decideLaterProposal
            : {};
        const parentParcelIds = ensureArrayOfStrings(raw.parentParcelIds && raw.parentParcelIds.length ? raw.parentParcelIds : base.parentParcelIds);
        const childParcelIds = ensureArrayOfStrings(raw.childParcelIds || sharedProposal.childParcelIds || []);
        base.decideLaterProposal = {
            ...deepClone(raw),
            parentParcelIds,
            childParcelIds,
            status: raw.status || base.status || 'Active'
        };
        if (base.parentParcelIds.length === 0 && parentParcelIds.length > 0) {
            base.parentParcelIds = parentParcelIds.slice();
        }
    }

    if (sharedProposal.roadProposal) {
        const childParcelIds = ensureArrayOfStrings(sharedProposal.roadProposal.childParcelIds || base.childParcelIds || []);
        base.roadProposal = {
            definition: deepClone(sharedProposal.roadProposal.definition),
            childParcelIds,
            roadGeometry: deepClone(sharedProposal.roadProposal.roadGeometry),
            metadata: deepClone(sharedProposal.roadProposal.metadata),
            status: 'unapplied',
            parentFeatures: [],
            parentParcelIds: ensureArrayOfStrings(sharedProposal.roadProposal.parentParcelIds)
        };
    }

    if (sharedProposal.buildingProposal) {
        const bp = sharedProposal.buildingProposal;
        const buildingFeatures = (() => {
            const features = [];
            if (sharedProposal.geometry && Array.isArray(sharedProposal.geometry.buildings)) {
                deepCloneArray(sharedProposal.geometry.buildings)
                    .filter(feature => feature && feature.geometry)
                    .forEach(feature => features.push(feature));
            }
            if (!features.length && Array.isArray(bp.buildings)) {
                bp.buildings
                    .map(entry => entry && entry.feature ? deepClone(entry.feature) : null)
                    .filter(feature => feature && feature.geometry)
                    .forEach(feature => features.push(feature));
            }
            return features;
        })();

        base.buildingProposal = {
            parameters: deepClone(bp.parameters) || {},
            parentParcelIds: ensureArrayOfStrings(bp.parentParcelIds),
            parentParcelNumbers: deepCloneArray(bp.parentParcelNumbers),
            ancestorKey: bp.ancestorKey || ensureArrayOfStrings(bp.parentParcelIds).join('|'),
            status: 'unapplied'
        };
        if (base.buildingProposal.parentParcelIds.length === 0) {
            base.buildingProposal.parentParcelIds = base.parentParcelIds.slice();
        }
        if (buildingFeatures.length) {
            base.geometry = base.geometry || {};
            base.geometry.buildings = deepCloneArray(buildingFeatures);
        }
    }

    // Structure proposals (parks/squares)
    if (sharedProposal.structureProposal && !isDecideLater) {
        base.structureProposal = {
            kind: (sharedProposal.structureProposal.kind === 'park' || sharedProposal.structureProposal.kind === 'square' || sharedProposal.structureProposal.kind === 'lake') ? sharedProposal.structureProposal.kind : 'square',
            geometry: deepClone(sharedProposal.structureProposal.geometry),
            decorations: deepClone(sharedProposal.structureProposal.decorations || null),
            blockName: sharedProposal.structureProposal.blockName || null,
            parentParcelIds: ensureArrayOfStrings(sharedProposal.structureProposal.parentParcelIds && sharedProposal.structureProposal.parentParcelIds.length ? sharedProposal.structureProposal.parentParcelIds : base.parentParcelIds)
        };
        base.goal = normalizeProposalGoalKey(base.structureProposal.kind) || base.goal;
    }

    if (sharedProposal.reparcellization && Array.isArray(sharedProposal.reparcellization.polygons) && sharedProposal.reparcellization.polygons.length > 0) {
        const reparcelParcelIds = (sharedProposal.reparcellization.parcelIds && sharedProposal.reparcellization.parcelIds.length > 0)
            ? ensureArrayOfStrings(sharedProposal.reparcellization.parcelIds)
            : (base.parentParcelIds.length > 0 ? base.parentParcelIds.slice() : []);
        const childParcelIds = ensureArrayOfStrings(sharedProposal.reparcellization.childParcelIds || base.childParcelIds || []);
        const ownerShares = deepCloneArray(sharedProposal.reparcellization.ownerShares);
        const polygons = deepCloneArray(sharedProposal.reparcellization.polygons);

        base.goal = 'reparcellization';
        base.reparcellization = {
            algorithm: sharedProposal.reparcellization.algorithm || 'sweep-line',
            generatedAt: sharedProposal.reparcellization.generatedAt || sharedProposal.generatedAt || new Date().toISOString(),
            parcelIds: reparcelParcelIds.slice(),
            totalArea: Number.isFinite(Number(sharedProposal.reparcellization.totalArea))
                ? Number(sharedProposal.reparcellization.totalArea)
                : null,
            ownerShares,
            polygons,
            childParcelIds,
            status: 'unapplied'
        };

        if (base.parentParcelIds.length === 0 && reparcelParcelIds.length > 0) {
            base.parentParcelIds = reparcelParcelIds.slice();
        }
        if (base.childParcelIds.length === 0 && childParcelIds.length > 0) {
            base.childParcelIds = childParcelIds.slice();
        }
    }

    return base;
}

async function ensureParentParcelsFetched(sharedProposal, normalized) {
    const parentIds = computeRequiredParentIdsForSharedProposal(sharedProposal);
    if (parentIds.length === 0) {
        return [];
    }

    // Check which parcels are missing and fetch them
    const missingIds = [];
    parentIds.forEach(id => {
        const layer = (typeof multiParcelSelection !== 'undefined' && typeof multiParcelSelection.findParcelById === 'function')
            ? multiParcelSelection.findParcelById(id)
            : null;
        if (!layer || !layer.feature) {
            missingIds.push(id);
        }
    });

    if (missingIds.length > 0) {
        // Fetch missing parcels from server/local storage
        try {
            await fetchParcelsForIds(missingIds, { forceRefresh: false });
        } catch (error) {
            console.warn('Failed to fetch ancestor parcels for proposal', sharedProposal.proposalId, error);
            throw error;
        }
    }

    return parentIds;
}
