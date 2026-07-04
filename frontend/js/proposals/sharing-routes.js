// proposals/sharing-routes.js — proposal share actions, payload encode/decode, and URL route
// handlers (handleSharedPlanRoute etc.). Extracted from proposals.js. NOTE: 8 low-level helpers
// (base64/compress/decode) are also defined in the pre-existing sharing.js (loaded after, wins) —
// pre-existing duplication preserved as-is; dedup is a pass-2 cleanup.

function base64UrlEncodeBytes(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
        return '';
    }
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
        binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecodeToBytes(input) {
    let working = input || '';
    working = working.replace(/-/g, '+').replace(/_/g, '/');
    while (working.length % 4 !== 0) {
        working += '=';
    }
    const binary = atob(working);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function compressBytes(bytes) {
    if (!(bytes instanceof Uint8Array)) {
        return { bytes, compressed: false };
    }
    if (typeof pako === 'undefined' || typeof pako.deflate !== 'function') {
        return { bytes, compressed: false };
    }
    try {
        const compressedBytes = pako.deflate(bytes, { level: 9 });
        return { bytes: compressedBytes, compressed: true };
    } catch (error) {
        console.warn('pako.deflate failed, falling back to raw payload', error);
        return { bytes, compressed: false };
    }
}

function inflateBytes(bytes, { strict = false } = {}) {
    if (typeof pako === 'undefined' || typeof pako.inflate !== 'function') {
        if (strict) {
            throw new Error('Compressed share links require compression support.');
        }
        return null;
    }
    try {
        return pako.inflate(bytes);
    } catch (error) {
        if (strict) {
            throw error;
        }
        console.warn('pako.inflate failed, falling back to raw payload', error);
        return null;
    }
}

function decodeBytesToJson(bytes) {
    if (typeof TextDecoder !== 'undefined') {
        const decoder = new TextDecoder();
        return decoder.decode(bytes);
    }
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
        binary += String.fromCharCode.apply(null, chunk);
    }
    return decodeURIComponent(escape(binary));
}

function focusMapOnSharedProposal(proposal, payload) {
    if (!proposal || typeof map === 'undefined' || !map) {
        return false;
    }

    const restoreSuppression = (() => {
        const wasSuppressed = isCameraMovementSuppressed();
        if (wasSuppressed) {
            try { window.suppressCameraMoves = false; } catch (_) { }
        }
        return () => {
            if (wasSuppressed) {
                try { window.suppressCameraMoves = true; } catch (_) { }
            }
        };
    })();

    const applyBounds = (bounds, padding = [120, 120]) => {
        if (!bounds || !bounds.isValid()) return false;
        try {
            map.fitBounds(bounds, { padding, maxZoom: 16 });
            return true;
        } catch (error) {
            console.warn('focusMapOnSharedProposal fitBounds failed', error);
            return false;
        }
    };

    try {
        if (payload && payload.camera && Number.isFinite(payload.camera.lat) && Number.isFinite(payload.camera.lng)) {
            const zoom = Number.isFinite(payload.camera.zoom) ? payload.camera.zoom : map.getZoom();
            map.setView([payload.camera.lat, payload.camera.lng], zoom);
            return true;
        }

        // Prefer explicit bounds from payload/proposal (already in WGS84)
        const candidateBounds = buildLeafletBoundsFromArray(payload && payload.bbox ? payload.bbox : null)
            || buildLeafletBoundsFromArray(proposal.bounds)
            || buildLeafletBoundsFromArray(proposal.roadProposal && proposal.roadProposal.bounds);
        if (candidateBounds && applyBounds(candidateBounds, [100, 100])) {
            return true;
        }

        const geometryFeatures = [];
        if (proposal.roadProposal) {
            const childIds = ensureArrayOfStrings(proposal.roadProposal.childParcelIds || []);
            childIds.forEach(id => {
                const feature = getParcelFeatureForHighlight(id, proposal);
                if (feature && feature.geometry) {
                    geometryFeatures.push(feature);
                }
            });
        }
        if (proposal.buildingProposal && proposal.buildingProposal.buildingFeature) {
            geometryFeatures.push(proposal.buildingProposal.buildingFeature);
        }
        if (proposal.structureProposal && proposal.structureProposal.geometry) {
            geometryFeatures.push({ type: 'Feature', geometry: proposal.structureProposal.geometry });
        }
        if (proposal.reparcellization && Array.isArray(proposal.reparcellization.polygons)) {
            proposal.reparcellization.polygons.forEach(polygon => {
                if (polygon && polygon.geometry) {
                    geometryFeatures.push({ type: 'Feature', geometry: polygon.geometry });
                }
            });
        }

        if (geometryFeatures.length) {
            const geoBounds = computeBoundsFromGeoJSONFeatures(geometryFeatures);
            if (applyBounds(geoBounds)) {
                return true;
            }
        }

        const parcelLayers = ensureArrayOfStrings(proposal.parentParcelIds)
            .map(id => findParcelLayerById(id))
            .filter(layer => layer && typeof layer.getBounds === 'function');
        if (parcelLayers.length) {
            let bounds = null;
            parcelLayers.forEach(layer => {
                const layerBounds = layer.getBounds();
                if (layerBounds && layerBounds.isValid()) {
                    bounds = bounds ? bounds.extend(layerBounds) : layerBounds;
                }
            });
            if (applyBounds(bounds)) {
                return true;
            }
        }

        if (payload && payload.bbox) {
            const sharedBounds = buildBoundsFromSharedPayload(payload);
            if (applyBounds(sharedBounds, [120, 120])) {
                return true;
            }
        }
    } finally {
        restoreSuppression();
    }

    return false;
}

function collectProposalParentParcelIdsForShare(proposal) {
    const ids = new Set();
    const normalize = (value) => {
        if (value === undefined || value === null) return null;
        const str = value && value.toString ? value.toString() : String(value);
        return str.trim() || null;
    };
    const addValue = (value) => {
        const normalized = normalize(value);
        if (normalized) ids.add(normalized);
    };
    const addMany = (list) => {
        if (!list) return;
        (Array.isArray(list) ? list : [list]).forEach(addValue);
    };

    if (!proposal) return [];

    addMany(proposal.parentParcelIds);

    if (proposal.roadProposal) {
        addMany(proposal.roadProposal.parentParcelIds);
    }

    if (proposal.buildingProposal) {
        addMany(proposal.buildingProposal.parentParcelIds);
    }

    if (proposal.structureProposal) {
        addMany(proposal.structureProposal.parentParcelIds);
    }

    if (proposal.reparcellization && Array.isArray(proposal.reparcellization.parcelIds)) {
        addMany(proposal.reparcellization.parcelIds);
    }

    if (ids.size === 0) {
        addMany(proposal.parentParcelIds);
    }

    return Array.from(ids);
}

function getSerialProposalId(proposal) {
    if (!proposal) return null;
    // Prefer serverProposalId if it's numeric (serial ID)
    if (proposal.serverProposalId) {
        const id = String(proposal.serverProposalId);
        if (/^\d+$/.test(id)) {
            return id;
        }
    }
    // Check if proposalId is numeric
    if (proposal.proposalId) {
        const id = String(proposal.proposalId);
        if (/^\d+$/.test(id)) {
            return id;
        }
    }
    // Check if id is numeric
    if (proposal.id) {
        const id = String(proposal.id);
        if (/^\d+$/.test(id)) {
            return id;
        }
    }
    return null;
}

function shareAppliedProposals() {
    showSharePlanModal();
}

function shareSingleProposal(proposalIdOrProposal) {
    try {
        const t = getProposalI18nHelper();
        const tShare = getShareI18nHelper();
        const hasStorage = typeof proposalStorage !== 'undefined';

        // Accept either a proposal object or an identifier
        const requestedId = (proposalIdOrProposal && typeof proposalIdOrProposal === 'object')
            ? (getProposalKey(proposalIdOrProposal)
                || proposalIdOrProposal.serverProposalId
                || proposalIdOrProposal.id
                || proposalIdOrProposal.proposalId)
            : proposalIdOrProposal;

        // Prefer the proposal object if provided directly
        let proposal = (proposalIdOrProposal && typeof proposalIdOrProposal === 'object')
            ? proposalIdOrProposal
            : null;

        // Next, prefer the proposal currently rendered in the details panel
        if (!proposal && currentProposalDetailsContext) {
            const currentId = getProposalKey(currentProposalDetailsContext)
                || currentProposalDetailsContext.serverProposalId
                || currentProposalDetailsContext.id;
            if (!requestedId || String(currentId) === String(requestedId)) {
                proposal = currentProposalDetailsContext;
            }
        }

        // Finally, fall back to storage lookups when needed
        if (!proposal && requestedId && hasStorage) {
            proposal = proposalStorage.getProposal(requestedId);
        }
        if (!proposal && requestedId && hasStorage) {
            const all = typeof proposalStorage.getAllProposals === 'function' ? proposalStorage.getAllProposals() : [];
            proposal = all.find(p => String(p.serverProposalId || p.id || p.proposalId) === String(requestedId));
        }
        if (!proposal && requestedId && typeof getProposalByIdOrHash === 'function') {
            proposal = getProposalByIdOrHash(requestedId);
        }
        if (!proposal) {
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(t('ephemeral.messages.cannot_share_this_proposal_right_now', 'Cannot share this proposal right now.'), 4000, 'error');
            }
            return;
        }

        // If the proposal is already minted, still show the full share modal
        // (the upload modal handles minted state in the mint row UI)

        const parentParcelIdsForShare = collectProposalParentParcelIdsForShare(proposal);
        const nonOriginalParcels = checkParcelsOriginal(parentParcelIdsForShare);
        if (nonOriginalParcels.length > 0) {
            showNonOriginalParcelShareBlockedModal(proposal, parentParcelIdsForShare);
            return;
        }

        showUploadProposalModal(proposal);
    } catch (error) {
        console.error('shareSingleProposal failed', error);
        if (typeof showEphemeralMessage === 'function') {
            const t = getProposalI18nHelper();
            showEphemeralMessage(t('ephemeral.messages.unable_to_generate_share_link', 'Unable to generate share link.'), 5000, 'error');
        }
    }
}

function shareProposalFromDetails() {
    try {
        if (currentProposalDetailsContext) {
            shareSingleProposal(currentProposalDetailsContext);
            return;
        }

        const panel = document.getElementById('proposal-details-content');
        const idElement = panel ? panel.querySelector('[data-proposal-id]') : null;
        const fallbackId = idElement ? idElement.getAttribute('data-proposal-id') : null;
        shareSingleProposal(fallbackId);
    } catch (error) {
        console.error('shareProposalFromDetails failed', error);
        shareSingleProposal(null);
    }
}

function buildSharedProposalsPayload(appliedProposals) {
    if (!Array.isArray(appliedProposals) || appliedProposals.length === 0) {
        return null;
    }

    const featuresForBounds = [];
    const sanitized = appliedProposals.map(proposal => {
        const parentIdsSet = new Set();

        const goalKey = resolveProposalGoalKey(proposal) || null;

        const sanitizedProposal = {
            proposalId: proposal.proposalId,
            goal: goalKey,
            title: proposal.title || '',
            description: proposal.description || '',
            author: proposal.author || '',
            createdAt: proposal.createdAt || new Date().toISOString(),
            updatedAt: proposal.updatedAt || proposal.createdAt || new Date().toISOString(),
            offer: typeof proposal.offer === 'number' ? proposal.offer : (proposal.offer || null),
            parcelIds: ensureArrayOfStrings(proposal.parentParcelIds),
            acceptedParcelIds: ensureArrayOfStrings(proposal.acceptedParcelIds),
            color: proposal.color || null,
            status: 'Applied',
            minted: isProposalMinted(proposal),
            onchain: proposal.onchain ? {
                transactionHash: proposal.onchain.transactionHash || null,
                proposalId: proposal.onchain.proposalId || null,
                chainId: proposal.onchain.chainId || null,
                contractAddress: proposal.onchain.contractAddress || null,
                metadataUri: proposal.onchain.metadataUri || null,
                metadataUrl: proposal.onchain.metadataUrl || null,
                imageUri: proposal.onchain.imageUri || null,
                imageUrl: proposal.onchain.imageUrl || null
            } : null
        };

        // Ancestors will be computed per proposal type below (prefer true parents)
        const lensEntries = normalizeLensEntries(proposal.lens || proposal.lensEntries || proposal.lensAddresses);
        if (lensEntries.length) {
            sanitizedProposal.lens = lensEntries;
        }

        if (proposal.roadProposal) {
            const childParcelIds = ensureArrayOfStrings(proposal.roadProposal.childParcelIds || []);
            childParcelIds.forEach(id => {
                const feature = getParcelFeatureForHighlight(id, proposal);
                if (feature) featuresForBounds.push(feature);
            });

            // Extract parent parcel IDs (not full geometries)
            const parentIds = (function () {
                if (Array.isArray(proposal.roadProposal.parentParcelIds)) {
                    return ensureArrayOfStrings(proposal.roadProposal.parentParcelIds);
                }
                return [];
            })();
            parentIds.forEach(id => parentIdsSet.add(id));

            sanitizedProposal.roadProposal = {
                definition: deepClone(proposal.roadProposal.definition),
                childParcelIds,
                roadGeometry: deepClone(proposal.roadProposal.roadGeometry),
                metadata: deepClone(proposal.roadProposal.metadata),
                id: proposal.roadProposal.id || proposal.roadProposal.proposalId || undefined,
                parentParcelIds: parentIds // IDs only, not full geometries
                // Note: parentFeatures is intentionally excluded - will be fetched on load
            };
        }

        if (proposal.buildingProposal) {
            const buildingFeature = proposal.buildingProposal.buildingFeature
                ? deepClone(proposal.buildingProposal.buildingFeature)
                : null;
            if (buildingFeature) {
                featuresForBounds.push(buildingFeature);
            }

            const parentIds = ensureArrayOfStrings(proposal.buildingProposal.parentParcelIds);
            parentIds.forEach(id => parentIdsSet.add(id));

            sanitizedProposal.buildingProposal = {
                parameters: deepClone(proposal.buildingProposal.parameters) || {},
                parentParcelIds: parentIds,
                parentParcelNumbers: deepCloneArray(proposal.buildingProposal.parentParcelNumbers),
                ancestorKey: proposal.buildingProposal.ancestorKey || parentIds.join('|'),
                buildingFeature,
                metadata: deepClone(proposal.buildingProposal.metadata)
            };
        } else if (proposal.buildingGeometry) {
            const buildingFeature = {
                type: 'Feature',
                geometry: deepClone(proposal.buildingGeometry),
                properties: deepClone(proposal.buildingProperties) || {}
            };
            featuresForBounds.push(buildingFeature);
            const parentIds = ensureArrayOfStrings(proposal.parentParcelIds);
            parentIds.forEach(id => parentIdsSet.add(id));
            sanitizedProposal.buildingProposal = {
                parameters: {},
                parentParcelIds: parentIds,
                parentParcelNumbers: [],
                ancestorKey: parentIds.join('|'),
                buildingFeature
            };
        }

        // Structure proposals
        if (proposal.structureProposal) {
            const sp = proposal.structureProposal;
            // Collect for bounds
            if (sp.geometry) {
                try { featuresForBounds.push({ type: 'Feature', geometry: deepClone(sp.geometry), properties: { structureKind: sp.kind || 'square' } }); } catch (_) { }
            }
            // Parents
            const parentIds = ensureArrayOfStrings(sp.parentParcelIds && sp.parentParcelIds.length ? sp.parentParcelIds : proposal.parentParcelIds);
            parentIds.forEach(id => parentIdsSet.add(id));

            sanitizedProposal.structureProposal = {
                kind: sp.kind || 'square',
                geometry: deepClone(sp.geometry),
                blockName: sp.blockName || null,
                parentParcelIds: parentIds
            };
        }

        if (proposal.reparcellization && Array.isArray(proposal.reparcellization.polygons) && proposal.reparcellization.polygons.length > 0) {
            const reparcelParcelIds = ensureArrayOfStrings(proposal.reparcellization.parcelIds && proposal.reparcellization.parcelIds.length > 0
                ? proposal.reparcellization.parcelIds
                : proposal.parentParcelIds);
            reparcelParcelIds.forEach(id => parentIdsSet.add(id));

            const clonedOwnerShares = deepCloneArray(proposal.reparcellization.ownerShares);
            const clonedPolygons = deepCloneArray(proposal.reparcellization.polygons);

            sanitizedProposal.goal = 'reparcellization';
            sanitizedProposal.reparcellization = {
                algorithm: proposal.reparcellization.algorithm || 'sweep-line',
                generatedAt: proposal.reparcellization.generatedAt || proposal.updatedAt || proposal.createdAt || new Date().toISOString(),
                parcelIds: reparcelParcelIds.slice(),
                totalArea: Number.isFinite(Number(proposal.reparcellization.totalArea))
                    ? Number(proposal.reparcellization.totalArea)
                    : null,
                ownerShares: clonedOwnerShares,
                polygons: clonedPolygons,
                status: 'unapplied'
            };

            clonedPolygons.forEach(slice => {
                if (!slice || !slice.geometry) return;
                try {
                    featuresForBounds.push({
                        type: 'Feature',
                        properties: {
                            ownerKey: slice.ownerKey || null,
                            displayName: slice.displayName || null,
                            color: slice.color || null,
                            percent: slice.percent || null
                        },
                        geometry: deepClone(slice.geometry)
                    });
                } catch (err) {
                    console.warn('Failed to include reparcellization slice in shared payload bounds', err);
                }
            });
        }

        // If no explicit parents were collected, fall back to this proposal's parentParcelIds
        if (parentIdsSet.size === 0) {
            ensureArrayOfStrings(proposal.parentParcelIds).forEach(id => parentIdsSet.add(id));
        }
        const parentIds = Array.from(parentIdsSet).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        sanitizedProposal.parentParcelIds = parentIds;

        return sanitizedProposal;
    });

    const camera = (typeof map !== 'undefined' && map && typeof map.getCenter === 'function')
        ? { lat: map.getCenter().lat, lng: map.getCenter().lng, zoom: map.getZoom() }
        : null;

    const bbox = computeSharedBoundingBoxFromFeatures(featuresForBounds) || (function () {
        if (typeof map !== 'undefined' && map && typeof map.getBounds === 'function') {
            const bounds = map.getBounds();
            return {
                west: bounds.getWest(),
                south: bounds.getSouth(),
                east: bounds.getEast(),
                north: bounds.getNorth()
            };
        }
        return null;
    })();

    return {
        version: SHARE_PAYLOAD_VERSION,
        generatedAt: new Date().toISOString(),
        author: (typeof getCurrentUsername === 'function' && getCurrentUsername())
            ? getCurrentUsername()
            : (appliedProposals[0]?.author || 'Unknown'),
        proposals: sanitized,
        bbox,
        camera
    };
}

function decodeSharedPayload(encoded) {
    if (!encoded) return null;
    let working = encoded.trim();
    let compressionMode = 'legacy';
    if (working.startsWith(SHARE_ENCODING_PREFIX_COMPRESSED)) {
        compressionMode = 'compressed';
        working = working.slice(SHARE_ENCODING_PREFIX_COMPRESSED.length);
    } else if (working.startsWith(SHARE_ENCODING_PREFIX_RAW)) {
        compressionMode = 'raw';
        working = working.slice(SHARE_ENCODING_PREFIX_RAW.length);
    }
    try {
        if (SHARE_BASE64_ALLOWED.test(working)) {
            const bytes = base64UrlDecodeToBytes(working);
            let decodedBytes = bytes;
            if (compressionMode === 'compressed') {
                decodedBytes = inflateBytes(bytes, { strict: true });
            } else if (compressionMode === 'legacy') {
                const inflated = inflateBytes(bytes, { strict: false });
                if (inflated && inflated.length) {
                    decodedBytes = inflated;
                }
            }
            const json = decodeBytesToJson(decodedBytes);
            return JSON.parse(json);
        }

        if (compressionMode === 'compressed') {
            throw new Error('Compressed shared payload is not base64 encoded.');
        }

        const json = decodeURIComponent(working);
        return JSON.parse(json);
    } catch (error) {
        console.error('decodeSharedPayload failed', error);
        throw error;
    }
}

function isTruthyUrlFlag(params, key) {
    try {
        if (!params || typeof params.has !== 'function') return false;
        if (!params.has(key)) return false;
        const raw = params.get(key);
        if (raw === null || raw === undefined) return false;
        const value = String(raw).trim().toLowerCase();
        if (value === '') return true; // e.g. ?mode3d
        if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
        if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true;
        // Any other value: presence is treated as enabled.
        return true;
    } catch (_) {
        return false;
    }
}

function handleSingleProposalShareFromUrl(attempt = 0) {
    try {
        const t = getProposalI18nHelper();
        const tShare = getShareI18nHelper();
        if (singleProposalShareHandled) return;
        const params = new URLSearchParams(window.location.search);
        const encoded = params.get('proposalShare');
        if (!encoded) return;

        if (typeof map === 'undefined' || !map) {
            if (attempt < 15) {
                setTimeout(() => handleSingleProposalShareFromUrl(attempt + 1), 400);
            }
            return;
        }

        let payload;
        try {
            payload = decodeSharedPayload(encoded);
        } catch (_) {
            showSimpleShareModal({
                title: tShare('invalidTitle', 'Invalid Share Link'),
                body: `<p>${tShare('invalidBody', 'We could not decode this shared proposal link. Please ask the sender to regenerate it.')}</p>`,
                actions: [{ label: t('modal.common.close', 'Close'), primary: true }]
            });
            params.delete('proposalShare');
            cleanSharedQuery(params);
            singleProposalShareHandled = true;
            return;
        }

        params.delete('proposalShare');
        cleanSharedQuery(params);
        singleProposalShareHandled = true;

        if (!payload || !Array.isArray(payload.proposals) || payload.proposals.length === 0) {
            showSimpleShareModal({
                title: tShare('emptyTitle', 'No Proposal Found'),
                body: `<p>${tShare('emptyBody', 'The shared link did not contain a proposal to load.')}</p>`,
                actions: [{ label: t('modal.common.close', 'Close'), primary: true }]
            });
            return;
        }

        const sharedProposal = payload.proposals[0];

        // Update Open Graph metadata for social sharing
        if (typeof updateProposalOGMetadata === 'function') {
            updateProposalOGMetadata(sharedProposal);
        }

        (async () => {
            try {
                await loadSharedProposalFromLink(sharedProposal, payload);
            } catch (error) {
                const message = error && error.message
                    ? escapeHtml(error.message)
                    : tShare('unknownError', 'An unknown error occurred while loading the shared proposal.');
                showSimpleShareModal({
                    title: tShare('failureTitle', 'Unable to Load Shared Proposal'),
                    body: `<p>${message}</p>`,
                    actions: [{ label: t('modal.common.close', 'Close'), primary: true }]
                });
            }
        })();
    } catch (error) {
        console.error('handleSingleProposalShareFromUrl failed', error);
    }
}

async function loadSharedProposalFromLink(sharedProposal, payload) {
    if (!sharedProposal) {
        throw new Error('Shared proposal data is missing.');
    }

    let suppressedHere = false;
    if (!isCameraMovementSuppressed()) {
        try {
            window.suppressCameraMoves = true;
            suppressedHere = true;
        } catch (_) { }
    }

    try {
        const normalized = prepareProposalForImport(sharedProposal);
        if (!normalized) {
            throw new Error('Unable to normalise shared proposal data.');
        }

        // Ensure parent parcels are fetched (this replaces the old stageSharedProposalDependencies logic)
        const fetchedParentIds = await ensureParentParcelsFetched(sharedProposal, normalized);

        // For road proposals, resolve and store parentFeatures (needed for rebuilding road geometry)
        if (normalized.roadProposal && !resolveRoadParentFeatures(sharedProposal, normalized, fetchedParentIds)) {
            throw new Error('Missing parcel geometry required for this proposal.');
        }

        normalized.status = 'Active';
        normalized.acceptedParcelIds = [];

        const targetHash = normalized.proposalId || sharedProposal.proposalId || `shared_${Date.now()}`;
        normalized.proposalId = targetHash;

        let stored = proposalStorage.getProposal(targetHash);
        if (!stored) {
            const imported = proposalStorage.importProposal(normalized, { overwrite: false, preserveStatus: true });
            stored = imported || proposalStorage.getProposal(targetHash);
        }

        if (!stored) {
            const addedId = proposalStorage.addProposal({ ...normalized, proposalId: undefined });
            stored = addedId ? proposalStorage.getProposal(addedId) : null;
        }

        if (!stored) {
            throw new Error('Failed to store the shared proposal locally.');
        }

        if (normalized.roadProposal && stored.proposalId) {
            stored.roadProposal = stored.roadProposal || {};
            // Only store parentParcelIds - geometries fetched when needed
            if (normalized.roadProposal.parentParcelIds) {
                stored.roadProposal.parentParcelIds = normalized.roadProposal.parentParcelIds;
            } else if (normalized.roadProposal.parentFeatures) {
                // Legacy: extract IDs from parentFeatures if they exist (from old data)
                stored.roadProposal.parentParcelIds = ensureArrayOfStrings(normalized.roadProposal.parentFeatures.map(feature => getParcelIdFromFeature(feature)));
            }
            if (typeof proposalStorage._indexProposal === 'function') {
                proposalStorage._indexProposal(stored);
            }
            proposalStorage.save();
        }

        if (suppressedHere) {
            try {
                window.suppressCameraMoves = false;
                suppressedHere = false;
            } catch (_) { }
        }

        await preloadProposalParcelOwners(stored.parentParcelIds, { forceRefresh: true });

        const focusParcelId = Array.isArray(stored.parentParcelIds) ? stored.parentParcelIds[0] : null;
        const storedKey = getProposalKey(stored);
        selectAndHighlightProposal(storedKey, focusParcelId, true);
        showProposalInfo(stored, focusParcelId);
        const panel = document.getElementById('proposal-details-panel');
        if (panel) {
            panel.classList.add('visible');
            document.body.classList.add('proposal-details-open');
        }
        await focusMapThenMaybeEnter3D(() => focusMapOnSharedProposal(stored, payload));
        if (typeof showEphemeralMessage === 'function') {
            const t = getProposalI18nHelper();
            showEphemeralMessage(t('ephemeral.messages.shared_proposal_loaded', 'Shared proposal loaded.'));
        }
    } finally {
        if (suppressedHere) {
            try { window.suppressCameraMoves = false; } catch (_) { }
        }
    }
}

function handleSharedProposalsFromUrl(attempt = 0) {
    try {
        const t = getProposalI18nHelper();
        const tShare = getShareI18nHelper();
        if (sharedProposalsHandled) return;
        const params = new URLSearchParams(window.location.search);
        const encoded = params.get('shared');
        if (!encoded) return;

        if (typeof map === 'undefined' || !map) {
            if (attempt < 15) {
                setTimeout(() => handleSharedProposalsFromUrl(attempt + 1), 400);
            }
            return;
        }

        let payload;
        try {
            payload = decodeSharedPayload(encoded);
        } catch (error) {
            showSimpleShareModal({
                title: tShare('invalidBulkTitle', 'Invalid Shared Proposals Link'),
                body: `<p>${tShare('invalidBulkBody', 'We could not decode the shared proposals link. Please ask the sender to regenerate it.')}</p>`,
                actions: [{ label: t('modal.common.close', 'Close'), primary: true }]
            });
            params.delete('shared');
            cleanSharedQuery(params);
            sharedProposalsHandled = true;
            return;
        }

        params.delete('shared');
        cleanSharedQuery(params);
        sharedProposalsHandled = true;

        if (!payload || !Array.isArray(payload.proposals) || payload.proposals.length === 0) {
            showSimpleShareModal({
                title: tShare('noBulkTitle', 'No Proposals Found'),
                body: `<p>${tShare('noBulkBody', 'The shared link did not contain any proposals to apply.')}</p>`,
                actions: [{ label: t('modal.common.close', 'Close'), primary: true }]
            });
            return;
        }

        // Update Open Graph metadata for social sharing (use first proposal or create summary)
        if (typeof updateProposalOGMetadata === 'function' && payload.proposals.length > 0) {
            const firstProposal = payload.proposals[0];
            // Enhance with summary info if multiple proposals
            if (payload.proposals.length > 1) {
                const summaryProposal = {
                    ...firstProposal,
                    title: `${firstProposal.title || 'Proposal'} (+${payload.proposals.length - 1} more)`,
                    description: `A collection of ${payload.proposals.length} proposals shared on Consensus Builder. ${firstProposal.description || ''}`
                };
                updateProposalOGMetadata(summaryProposal);
            } else {
                updateProposalOGMetadata(firstProposal);
            }
        }

        // Before applying anything, show a full payload inspector with per-proposal checkboxes
        ; (async () => {
            try {
                const selected = await showSharedPayloadInspector(payload);
                if (!selected || !(selected instanceof Set)) {
                    if (typeof showEphemeralMessage === 'function') {
                        showEphemeralMessage(tShare('importCancelled', 'Shared proposal import cancelled.'));
                    }
                    return;
                }
                await applySharedProposalsFromPayload(payload, selected);
            } catch (e) {
                console.error('Shared payload inspector error:', e);
            }
        })();
    } catch (error) {
        console.error('handleSharedProposalsFromUrl failed', error);
    }
}

async function applySharedProposalsFromPayload(payload, selectedIds) {
    try {
        // Suppress camera moves for the duration of shared apply
        try { window.suppressCameraMoves = true; } catch (_) { }
        let proposals = Array.isArray(payload.proposals) ? payload.proposals.slice() : [];
        if (selectedIds && selectedIds.size >= 0) {
            proposals = proposals.filter(p => selectedIds.has(getProposalKey(p)));
        }
        if (proposals.length === 0) return;

        if (typeof updateStatus === 'function') {
            updateStatus(`Applying ${proposals.length} shared proposal${proposals.length === 1 ? '' : 's'}...`);
        }

        // Do not move camera; if bbox is provided, fetch parcels for that area explicitly
        if (typeof fetchParcelData === 'function') {
            const bounds = (function () {
                try {
                    if (payload && payload.bbox && isFinite(payload.bbox.south) && isFinite(payload.bbox.north) && isFinite(payload.bbox.west) && isFinite(payload.bbox.east) && typeof L !== 'undefined') {
                        return L.latLngBounds([
                            [payload.bbox.south, payload.bbox.west],
                            [payload.bbox.north, payload.bbox.east]
                        ]);
                    }
                } catch (_) { }
                return null;
            })();
            await fetchParcelData(bounds || undefined);
        }

        // No global ancestor pre-check; proceed proposal by proposal

        const t = getProposalI18nHelper();
        const tShare = getShareI18nHelper();

        const sorted = proposals.slice().sort((a, b) => {
            // Extract numeric ID from proposalId (e.g., "58" or "local-3" -> 3)
            const extractNumericId = (proposal) => {
                if (!proposal || !proposal.proposalId) return null;
                const str = String(proposal.proposalId);
                if (/^\d+$/.test(str)) {
                    return parseInt(str, 10);
                }
                const match = str.match(/^local-(\d+)$/);
                if (match) {
                    return parseInt(match[1], 10);
                }
                return null;
            };
            const aId = extractNumericId(a);
            const bId = extractNumericId(b);
            const aHasId = aId !== null && Number.isFinite(aId);
            const bHasId = bId !== null && Number.isFinite(bId);
            if (aHasId && bHasId) {
                return aId - bId; // includes 0
            }
            if (aHasId && !bHasId) return -1;
            if (!aHasId && bHasId) return 1;
            const aRaw = new Date(a.createdAt || 0).getTime();
            const bRaw = new Date(b.createdAt || 0).getTime();
            const aTime = Number.isFinite(aRaw) ? aRaw : 0;
            const bTime = Number.isFinite(bRaw) ? bRaw : 0;
            return aTime - bTime;
        });

        // Position of each proposal in the sorted payload (oldest-first), so the view can end
        // up framing the most recently created loaded proposal regardless of the chronological
        // order dependency requeueing applied them in.
        const payloadOrder = new Map();
        sorted.forEach((p, idx) => {
            [getProposalKey(p), p.proposalId].forEach(key => {
                if (key) payloadOrder.set(String(key), idx);
            });
        });

        const actuallyApplied = [];
        const skipped = [];
        const failures = [];
        const blockedAncestors = new Map();
        let lastLoadedProposalIdFor3D = null;

        let pending = sorted.slice();
        const maxPasses = 8;
        let pass = 0;

        while (pending.length && pass < maxPasses) {
            pass += 1;
            let progress = false;
            const nextPending = [];

            for (const proposal of pending) {
                try {
                    if (typeof updateStatus === 'function') {
                        const displayId = proposal.proposalId ? String(proposal.proposalId) : '?';
                        updateStatus(t('status.messages.applying_specific_shared_proposal', `Applying shared proposal ${proposal.title || ''} #${displayId}...`, {
                            title: proposal.title || '',
                            id: displayId
                        }));
                    }
                } catch (_) { }

                const result = await importAndApplySharedProposal(proposal);
                const proposalId = (result && result.proposalId) || getProposalKey(proposal) || proposal.proposalId;

                if (result && result.skipped) {
                    skipped.push(proposalId);
                    if (proposalId) lastLoadedProposalIdFor3D = proposalId;
                    blockedAncestors.delete(proposalId);
                    progress = true;
                    continue;
                }

                if (result && result.applied) {
                    actuallyApplied.push(proposalId);
                    if (proposalId) lastLoadedProposalIdFor3D = proposalId;
                    blockedAncestors.delete(proposalId);
                    progress = true;
                    await new Promise(res => setTimeout(res, 3000));
                    continue;
                }

                const ancestryCheck = (proposalId && typeof ProposalManager !== 'undefined' && typeof ProposalManager.canApplyProposal === 'function')
                    ? ProposalManager.canApplyProposal(proposalId)
                    : { ok: true, missing: [] };

                if (!ancestryCheck.ok && ancestryCheck.missing.length) {
                    blockedAncestors.set(proposalId || proposal.title || `pending-${pass}-${nextPending.length}`, {
                        missing: ancestryCheck.missing.slice(),
                        proposal
                    });
                    nextPending.push(proposal);
                    continue;
                }

                failures.push(proposalId || proposal.proposalId || '');
                progress = true;
            }

            pending = nextPending;
            if (!progress) break;
        }

        pending.forEach(proposal => {
            const hash = getProposalKey(proposal) || proposal.proposalId || proposal.title || 'unknown';
            if (!blockedAncestors.has(hash)) {
                blockedAncestors.set(hash, { missing: [], proposal });
            }
        });

        if (actuallyApplied.length > 0 || skipped.length > 0 || failures.length > 0 || blockedAncestors.size > 0) {
            if (typeof updateProposalLayer === 'function') {
                updateProposalLayer();
            }
            if (typeof updateShowProposalsButton === 'function') {
                updateShowProposalsButton();
            }

            // Center map on the most recently loaded proposal (latest in payload order among
            // applied and skipped-as-duplicate), framed as if it had been loaded alone:
            // fit its visible descendant's bounds and open its details panel.
            let lastProposalId = null;
            let lastProposalOrd = -1;
            [...actuallyApplied, ...skipped].forEach(pid => {
                if (!pid) return;
                const key = String(pid);
                const ord = payloadOrder.has(key) ? payloadOrder.get(key) : -1;
                if (ord >= lastProposalOrd) {
                    lastProposalOrd = ord;
                    lastProposalId = pid;
                }
            });
            if (!lastProposalId) {
                lastProposalId = lastLoadedProposalIdFor3D
                    || (actuallyApplied.length > 0 ? actuallyApplied[actuallyApplied.length - 1] : null)
                    || (skipped.length > 0 ? skipped[skipped.length - 1] : null);
            }
            if (lastProposalId && typeof map !== 'undefined' && map) {
                try {
                    const visibleId = (typeof findVisibleDescendant === 'function')
                        ? (findVisibleDescendant(lastProposalId) || lastProposalId)
                        : lastProposalId;
                    const bounds = calculateBoundsForLastAppliedProposal(visibleId);
                    if (bounds && bounds.isValid && bounds.isValid()) {
                        map.fitBounds(bounds, { padding: [80, 80], maxZoom: 18 });
                    }
                    if (typeof focusProposalDetails === 'function') {
                        await focusProposalDetails(visibleId, {
                            centerOnProposal: false, // camera has already been fit to bounds above
                            showDetails: true
                        });
                    }
                } catch (error) {
                    console.warn('Failed to center map on last applied proposal:', error);
                }
            }

            // Do not auto-enable proposals mode; keep interactions normal
            const bodyLines = [];
            const authorName = payload.author || t('common.userFallback', 'User');
            bodyLines.push(`<p>${tShare('summary.appliedFrom', 'Applied proposals from {{author}}.', { author: escapeHtml(authorName) })}</p>`);
            if (actuallyApplied.length > 0) {
                bodyLines.push(`<p>${tShare('summary.appliedCount', '{{count}} applied.', {
                    count: actuallyApplied.length,
                    suffix: actuallyApplied.length === 1 ? '' : 's'
                })}</p>`);
            }
            if (skipped.length > 0) {
                bodyLines.push(`<p>${tShare('summary.skippedCount', 'Skipped {{count}} duplicate proposal{{suffix}} (already present).', {
                    count: skipped.length,
                    suffix: skipped.length === 1 ? '' : 's'
                })}</p>`);
            }
            if (failures.length > 0) {
                bodyLines.push(`<p>${tShare('summary.failedCount', '{{count}} failed.', {
                    count: failures.length,
                    suffix: failures.length === 1 ? '' : 's'
                })}</p>`);
            }
            if (blockedAncestors.size > 0) {
                const blockedList = Array.from(blockedAncestors.entries());
                const limitedBlocked = blockedList.slice(0, 5);
                const escape = typeof escapeHtml === 'function' ? escapeHtml : (value => value);
                bodyLines.push(`<p>${tShare('summary.blockedAncestors', 'Blocked by missing applied ancestors:')}</p><ul>${limitedBlocked.map(([hash, info]) => {
                    const label = info && info.proposal && info.proposal.title
                        ? `${escape(info.proposal.title)}${hash ? ` (${escape(hash)})` : ''}`
                        : escape(hash || '');
                    const missingList = info && info.missing && info.missing.length ? escape(info.missing.join(', ')) : '';
                    return `<li>${label}${missingList ? ` · ${missingList}` : ''}</li>`;
                }).join('')}${blockedList.length > limitedBlocked.length ? '<li>…</li>' : ''}</ul>`);
            }
            showSimpleShareModal({
                title: tShare('summary.title', 'Applied Shared Proposals'),
                body: bodyLines.join(''),
                actions: [
                    { label: t('modal.common.close', 'Close'), primary: true },
                    ...(actuallyApplied.length > 0 ? [{
                        label: tShare('summary.unapplyApplied', 'Unapply applied'),
                        onClick: () => {
                            try {
                                const hasFamilyUnapply = typeof ProposalManager !== 'undefined' && typeof ProposalManager.unapplyWholeFamily === 'function';
                                actuallyApplied.forEach(hash => {
                                    try {
                                        if (hasFamilyUnapply) {
                                            ProposalManager.unapplyWholeFamily(hash);
                                        } else if (typeof ProposalManager.unapplyProposal === 'function') {
                                            ProposalManager.unapplyProposal(hash, { skipConfirm: true });
                                        }
                                    } catch (_) { }
                                });
                                // Refresh UI once after all bulk unapplies
                                if (typeof ProposalManager._refreshUIAfterProposalChange === 'function') {
                                    ProposalManager._refreshUIAfterProposalChange(null);
                                }
                            } catch (_) { }
                        }
                    }] : [])
                ]
            });

            // Nothing was loaded (only failures/blocked): firmly return to parcel-mode
            // hover/leave behavior. When a proposal was loaded we keep its highlight and
            // details panel, matching the single shared-proposal flow.
            if (!lastProposalId) {
                try { clearProposalInfoHoverOverlay(); } catch (_) { }
                try { clearProposalHighlights(); } catch (_) { }
                try { if (typeof setParcelNumberLabelFilter === 'function') setParcelNumberLabelFilter(null); } catch (_) { }
            }
        }

        if ((failures.length > 0 || blockedAncestors.size > 0) && typeof showEphemeralMessage === 'function') {
            const blockedCount = blockedAncestors.size;
            const failureCount = failures.length;
            const total = failureCount + blockedCount;
            showEphemeralMessage(t('ephemeral.messages.failed_to_apply_shared_proposals_summary', `Unable to apply ${total} shared proposal${total === 1 ? '' : 's'} (missing ancestors or errors).`, {
                count: total,
                suffix: total === 1 ? '' : 's'
            }), 6000, 'error');
        }

        // Optional URL-driven 3D mode: after shared apply completes, center on all proposals then enter 3D.
        try {
            if (!url3DModeHandled && is3DModeRequestedFromUrl()) {
                // Wait for map centering to complete (if we centered on proposals above)
                const allProposalIds = [...actuallyApplied, ...skipped].filter(Boolean);
                if (allProposalIds.length > 0) {
                    await createLeafletViewSettlePromise(null, null);
                }
                // Enter 3D mode - camera will rotate around the current map center (which is the center of proposals)
                const entered = tryEnterThreeMode({ fromUrl: true });
                if (entered) url3DModeHandled = true;
            }
        } catch (_) { }
    } catch (error) {
        console.error('applySharedProposalsFromPayload failed', error);
        if (typeof showEphemeralMessage === 'function') {
            const t = getProposalI18nHelper();
            showEphemeralMessage(t('ephemeral.messages.failed_to_apply_shared_proposals', 'Failed to apply shared proposals.'), 6000, 'error');
        }
    } finally {
        // Re-enable camera moves after shared apply completes
        try { window.suppressCameraMoves = false; } catch (_) { }
    }
}

async function importAndApplySharedProposal(sharedProposal, options = {}) {
    const fallbackHash = sharedProposal ? (sharedProposal.proposalId || getProposalKey(sharedProposal)) : null;
    if (!sharedProposal || !sharedProposal.proposalId) return { applied: false, skipped: false, proposalId: fallbackHash, reason: 'Missing proposal payload' };

    const normalized = prepareProposalForImport(sharedProposal);
    const proposalId = normalized?.proposalId || fallbackHash;
    if (!normalized) return { applied: false, skipped: false, proposalId, reason: 'Unable to normalize shared proposal' };

    // If this proposal is already present AND already applied AND its descendants are actually
    // on the map, there is nothing to do — skip. Critically, we do NOT early-skip when the
    // proposal is marked applied but its descendants are missing, because that is exactly the
    // case we need to handle: a cross-client or cross-session deep-link where the local copy
    // has stale childParcelIds but no materialized geometry. For that case we must fall through
    // to applyProposal, which rebuilds children from definition via _restoreFromAlreadyAppliedState.
    const existing = proposalStorage.getProposal(normalized.proposalId);
    if (existing && syncCanonicalSharedProposalState(existing, normalized)) {
        if (typeof proposalStorage._indexProposal === 'function') {
            proposalStorage._indexProposal(existing);
        }
        if (typeof proposalStorage.save === 'function') {
            proposalStorage.save();
        }
    }
    if (existing) {
        const alreadyApplied = isProposalCurrentlyApplied(existing) || existing.status === 'Executed';
        if (alreadyApplied) {
            const descendantsMaterialized = (() => {
                try {
                    const mapById = (typeof window !== 'undefined' && window.parcelLayerById instanceof Map)
                        ? window.parcelLayerById
                        : null;
                    if (!mapById) return false;
                    const descendantIds = [];
                    const push = (arr) => {
                        if (!Array.isArray(arr)) return;
                        for (const id of arr) {
                            if (id != null) descendantIds.push(String(id));
                        }
                    };
                    push(existing.childParcelIds);
                    push(existing.roadProposal && existing.roadProposal.childParcelIds);
                    push(existing.decideLaterProposal && existing.decideLaterProposal.childParcelIds);
                    if (descendantIds.length === 0) {
                        // Nothing stored to verify; treat as "needs apply" so we re-derive from definition.
                        return false;
                    }
                    return descendantIds.every(id => mapById.has(id));
                } catch (_) {
                    return false;
                }
            })();
            if (descendantsMaterialized) {
                try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }
                return { applied: false, skipped: true, proposalId, reason: 'Already applied' };
            }
            console.debug('[importAndApplySharedProposal] Proposal marked applied but descendants not on map — falling through to re-apply', { proposalId: normalized.proposalId });
        }
    }

    const skipDependencyFetch = options && options.skipDependencyFetch === true;
    const applyOptions = skipDependencyFetch ? { suppressMissingParentAlerts: true } : {};

    // Some flows (notably /proposals/:id1,id2,...) want to apply a queue where missing parcels
    // are expected to appear after other proposals apply. In that case do NOT fetch parcels here;
    // let ProposalManager apply or throw, and let the caller requeue.
    let parentIds = [];
    if (!skipDependencyFetch) {
        try {
            parentIds = await ensureParentParcelsFetched(sharedProposal, normalized);
        } catch (error) {
            console.warn('Failed to fetch parent parcels for shared proposal', sharedProposal.proposalId, error);
            return { applied: false, skipped: false, proposalId, reason: `Failed to fetch parent parcels: ${error && error.message ? error.message : 'unknown error'}` };
        }
    } else {
        try {
            parentIds = ensureArrayOfStrings(computeRequiredParentIdsForSharedProposal(sharedProposal));
        } catch (_) {
            parentIds = [];
        }
    }

    // For road proposals: ensure parentParcelIds are set
    // (geometries will be fetched by ID when needed for reconstruction)
    if (normalized.roadProposal) {
        if (!ensureRoadParentParcelIds(sharedProposal, normalized, parentIds)) {
            console.warn('Missing parent parcel IDs for road proposal', sharedProposal.proposalId);
            return { applied: false, skipped: false, proposalId, reason: 'Missing parent parcel IDs for road proposal' };
        }
    }

    if (existing) {
        // Try applying existing without re-importing (idempotent)
        // For roads, ensure parent features exist on stored object
        if (normalized.roadProposal && normalized.roadProposal.parentParcelIds) {
            existing.roadProposal = existing.roadProposal || {};
            existing.roadProposal.parentParcelIds = normalized.roadProposal.parentParcelIds;
            if (typeof proposalStorage._indexProposal === 'function') {
                proposalStorage._indexProposal(existing);
            }
            proposalStorage.save();
        }
        const appliedExisting = await ProposalManager.applyProposal(existing.proposalId, applyOptions);
        try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }
        if (appliedExisting) {
            return { applied: true, skipped: false, proposalId };
        }

        if (skipDependencyFetch) {
            try {
                const lastInfo = getStoredApplyFailureInfo(existing.proposalId);
                if (lastInfo && lastInfo.message) {
                    return {
                        applied: false,
                        skipped: false,
                        proposalId,
                        reason: lastInfo.message,
                        failureInfo: lastInfo
                    };
                }
            } catch (_) { }
        }

        // If apply failed and we *did* do dependency fetch, provide a reason that upstream
        // can treat as retryable. (When skipDependencyFetch=true, caller will handle via thrown errors.)
        if (!skipDependencyFetch) {
            try {
                const required = ensureArrayOfStrings(parentIds);
                const missing = findMissingParentParcels(required);
                if (missing && missing.length > 0) {
                    const sample = missing.slice(0, 10).join(', ');
                    const suffix = missing.length > 10 ? '…' : '';
                    return { applied: false, skipped: false, proposalId, reason: `Missing required parcels: ${sample}${suffix}` };
                }
            } catch (_) { }
        }

        return { applied: false, skipped: false, proposalId, reason: 'Proposal did not apply' };
    }

    // Fresh import then apply
    const imported = proposalStorage.importProposal(normalized, { overwrite: true });
    if (!imported) {
        return { applied: false, skipped: false, proposalId, reason: 'Failed to import proposal' };
    }

    if (normalized.roadProposal && normalized.roadProposal.parentParcelIds) {
        imported.roadProposal = imported.roadProposal || {};
        imported.roadProposal.parentParcelIds = normalized.roadProposal.parentParcelIds;
        if (typeof proposalStorage._indexProposal === 'function') {
            proposalStorage._indexProposal(imported);
        }
        proposalStorage.save();
    }

    const applied = await ProposalManager.applyProposal(normalized.proposalId, applyOptions);
    try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }
    if (applied) {
        return { applied: true, skipped: false, proposalId };
    }

    if (skipDependencyFetch) {
        try {
            const lastInfo = getStoredApplyFailureInfo(normalized.proposalId);
            if (lastInfo && lastInfo.message) {
                return {
                    applied: false,
                    skipped: false,
                    proposalId,
                    reason: lastInfo.message,
                    failureInfo: lastInfo
                };
            }
        } catch (_) { }
    }

    if (!skipDependencyFetch) {
        try {
            const required = ensureArrayOfStrings(parentIds);
            const missing = findMissingParentParcels(required);
            if (missing && missing.length > 0) {
                const sample = missing.slice(0, 10).join(', ');
                const suffix = missing.length > 10 ? '…' : '';
                return { applied: false, skipped: false, proposalId, reason: `Missing required parcels: ${sample}${suffix}` };
            }
        } catch (_) { }
    }

    return { applied: false, skipped: false, proposalId, reason: 'Proposal did not apply' };
}

async function handleSharedPlanRoute(idParts, attempt = 0) {
    try {
        const t = getProposalI18nHelper();
        const tShare = getShareI18nHelper();

        console.log('[handleSharedPlanRoute] Starting with IDs:', idParts, 'attempt:', attempt);

        if (typeof map === 'undefined' || !map) {
            if (attempt < 15) {
                console.log('[handleSharedPlanRoute] Map not ready, retrying... attempt:', attempt);
                setTimeout(() => handleSharedPlanRoute(idParts, attempt + 1), 400);
            } else {
                console.error('[handleSharedPlanRoute] Map not ready after 15 attempts');
            }
            return;
        }

        const skipWelcomeGate = typeof window.shouldSkipWelcomeForProposalLink === 'function'
            ? window.shouldSkipWelcomeForProposalLink()
            : false;

        if (!skipWelcomeGate) {
            const welcomeModal = document.getElementById('welcome-modal');
            const isWelcomeModalVisible = welcomeModal && welcomeModal.style.display !== 'none';
            const hasUserAgent = typeof currentUserAgent !== 'undefined' && currentUserAgent !== null;

            console.log('[handleSharedPlanRoute] Welcome gate check:', {
                skipWelcomeGate,
                isWelcomeModalVisible,
                hasUserAgent
            });

            if (isWelcomeModalVisible || !hasUserAgent) {
                console.log('[handleSharedPlanRoute] Waiting for welcome modal to complete...');
                await new Promise((resolve) => {
                    if (!isWelcomeModalVisible && hasUserAgent) {
                        resolve();
                        return;
                    }
                    const onWelcomeComplete = () => {
                        console.log('[handleSharedPlanRoute] Welcome modal completed');
                        window.removeEventListener('welcomeModalComplete', onWelcomeComplete);
                        resolve();
                    };
                    window.addEventListener('welcomeModalComplete', onWelcomeComplete, { once: true });
                });
            }
        }

        // Apply many proposals robustly:
        // - descendant-only prerequisites: do NOT fetch, just requeue until available
        // - base-only prerequisites: fetch base parcels before applying
        // - mixed base + descendant prerequisites: kick off base fetch, then requeue
        const normalizeId = (raw) => {
            const s = (raw !== undefined && raw !== null) ? String(raw).trim() : '';
            return s;
        };

        const totalProposals = Array.from(new Set(idParts.map(normalizeId).filter(Boolean))).length;

        console.log('[handleSharedPlanRoute] Showing load overlay and fetching proposals...', { totalProposals });
        showProposalLoadOverlay(tShare('plan.fetchingPlan', 'Fetching plan…'), {
            total: totalProposals,
            title: tShare('plan.fetchingPlanTitle', 'Fetching proposal')
        });

        const backendBase = resolveBackendBaseUrl();
        const applied = [];
        const skipped = [];
        const failed = [];
        let lastLoadedProposalIdFor3D = null;

        const fetchProgressIds = new Set();
        const markFetchProgress = (rawId) => {
            const normalized = normalizeId(rawId);
            if (!normalized || fetchProgressIds.has(normalized)) return;
            fetchProgressIds.add(normalized);
            updateProposalLoadOverlay({ progress: { done: fetchProgressIds.size, total: totalProposals } });
        };
        const getFetchOrdinal = (rawId) => {
            const normalized = normalizeId(rawId);
            if (!normalized) return fetchProgressIds.size + 1;
            return fetchProgressIds.has(normalized) ? fetchProgressIds.size : fetchProgressIds.size + 1;
        };
        const getFailureMessage = (value) => {
            if (value && value.message) return String(value.message);
            if (typeof value === 'string') return value;
            return '';
        };
        const getDependencyFailureInfo = (value) => {
            if (!value) return null;
            const message = getFailureMessage(value);
            const code = (value && typeof value === 'object' && value.code) ? String(value.code) : '';
            const missingIds = (value && typeof value === 'object' && Array.isArray(value.missingIds))
                ? ensureArrayOfStrings(value.missingIds)
                : [];
            if (code === 'dependency-missing') {
                return { message, code, missingIds };
            }
            if (!message) return null;
            // Typical failure when parcels aren't yet available in parcelLayerById / cache.
            if (/Missing\s+parcel\s+.+\s+in\s+parcelLayerById/i.test(message)) return { message, code, missingIds };
            if (/missing\s+in\s+parcelLayerById/i.test(message)) return { message, code, missingIds };
            if (/prerequisite\s+parcels\s+are\s+missing/i.test(message)) return { message, code, missingIds };
            if (/Cannot\s+apply\s+proposal:\s+missing\s+parent\s+parcel\s+geometries/i.test(message)) return { message, code, missingIds };
            if (/Cannot\s+apply\s+proposal:\s+missing\s+parcel\s+geometries/i.test(message)) return { message, code, missingIds };
            return null;
        };
        const extractMissingParcelId = (value) => {
            const structuredMissingIds = (value && typeof value === 'object' && Array.isArray(value.missingIds))
                ? ensureArrayOfStrings(value.missingIds)
                : [];
            if (structuredMissingIds.length > 0) return structuredMissingIds[0];
            const msg = getFailureMessage(value);
            if (!msg) return null;
            const match = msg.match(/Missing\s+parcel\s+([^\s]+)\s+in\s+parcelLayerById/i);
            return match && match[1] ? String(match[1]) : null;
        };
        const isDerivedParcelId = (parcelId) => {
            const s = parcelId ? String(parcelId) : '';
            return s.includes('#p-');
        };

        const getPrerequisiteParcelIdsForProposal = (proposal) => {
            try {
                // Keep this minimal: only consult explicit parentParcelIds fields.
                // Do NOT attempt parcel feature resolution here.
                const ids = [];
                const computed = (typeof computeRequiredParentIdsForSharedProposal === 'function')
                    ? computeRequiredParentIdsForSharedProposal(proposal)
                    : [];
                ensureArrayOfStrings(computed).forEach(id => ids.push(id));

                // Some payloads keep ids under nested objects; include them defensively.
                if (proposal && proposal.roadProposal && Array.isArray(proposal.roadProposal.parentParcelIds)) {
                    ensureArrayOfStrings(proposal.roadProposal.parentParcelIds).forEach(id => ids.push(id));
                }
                if (proposal && proposal.buildingProposal && Array.isArray(proposal.buildingProposal.parentParcelIds)) {
                    ensureArrayOfStrings(proposal.buildingProposal.parentParcelIds).forEach(id => ids.push(id));
                }
                if (proposal && proposal.structureProposal && Array.isArray(proposal.structureProposal.parentParcelIds)) {
                    ensureArrayOfStrings(proposal.structureProposal.parentParcelIds).forEach(id => ids.push(id));
                }
                if (proposal && proposal.decideLaterProposal && Array.isArray(proposal.decideLaterProposal.parentParcelIds)) {
                    ensureArrayOfStrings(proposal.decideLaterProposal.parentParcelIds).forEach(id => ids.push(id));
                }
                if (proposal && Array.isArray(proposal.parentParcelIds)) {
                    ensureArrayOfStrings(proposal.parentParcelIds).forEach(id => ids.push(id));
                }

                return Array.from(new Set(ids.map(x => String(x)).filter(Boolean)));
            } catch (_) {
                return [];
            }
        };

        const splitBaseAndDerivedIds = (ids) => {
            const baseIds = [];
            const derivedIds = [];
            (Array.isArray(ids) ? ids : []).forEach(id => {
                const s = id && id.toString ? id.toString() : String(id || '');
                if (!s) return;
                (isDerivedParcelId(s) ? derivedIds : baseIds).push(s);
            });
            return {
                baseIds: Array.from(new Set(baseIds)),
                derivedIds: Array.from(new Set(derivedIds))
            };
        };
        const isDependencyFailure = (value) => {
            return Boolean(getDependencyFailureInfo(value));
        };

        let queue = idParts.map(normalizeId).filter(Boolean);
        // Position of each id in the link. Share URLs list proposals oldest-first, so the
        // highest position is the most recently created proposal — the one the view should
        // end up framing, exactly as if it had been loaded alone.
        const linkOrder = new Map();
        queue.forEach((id, idx) => linkOrder.set(id, idx));
        const cleanPlanUrl = () => {
            try {
                const newUrl = window.location.pathname.replace(/\/proposals\/[^/?#]+$/, '') + window.location.search + window.location.hash;
                if (window.history && typeof window.history.replaceState === 'function') {
                    window.history.replaceState({}, document.title, newUrl);
                }
            } catch (_) { }
        };
        updateProposalLoadOverlay({ progress: { done: fetchProgressIds.size, total: totalProposals } });
        const loadedById = new Map();
        const proposalTypeById = new Map();
        const basePrereqIdsById = new Map();
        const lastUnfetchedBasePrereqIdsById = new Map();
        const prereqIdsById = new Map();
        const lastMissingPrereqsById = new Map();
        const attemptById = new Map();
        const lastReasonById = new Map();
        const fetchedBaseParcels = new Set();
        const baseParcelFetchInFlight = new Map();
        const maxAttemptsPerId = 120;
        let stepsSinceProgress = 0;
        const attemptedSinceProgress = new Set();

        // Wait for PersistentStorage to be ready before checking local proposals.
        if (typeof PersistentStorage !== 'undefined' && PersistentStorage && typeof PersistentStorage.ensureReady === 'function') {
            await new Promise(resolve => PersistentStorage.ensureReady(resolve));
        }

        const urlRequests3D = is3DModeRequestedFromUrl();

        // Analyze what's currently applied vs what's incoming
        const incomingIds = new Set(queue.map(normalizeId).filter(Boolean));
        let allAppliedProposals = [];
        let incomingAlreadyApplied = [];
        let otherAppliedProposals = [];

        console.log('[handleSharedPlanRoute] Incoming IDs from URL:', Array.from(incomingIds));

        if (typeof proposalStorage !== 'undefined' && proposalStorage) {
            const allProposals = proposalStorage.getAllProposals() || [];
            // Only treat as "applied" for conflict analysis if descendants are actually on the map.
            // A proposal marked status=applied but with no descendants on parcelLayerById (e.g. a
            // fresh page reload before any apply has run) must NOT be skipped — we need to reach
            // the apply path so _applyRoadProposal can rebuild children from the definition.
            allAppliedProposals = allProposals.filter(p => isProposalAppliedAndMaterialized(p));

            // Categorize applied proposals
            allAppliedProposals.forEach(p => {
                const serverId = p.serverProposalId ? String(p.serverProposalId) : null;
                const hashId = p.proposalId ? String(p.proposalId) : null;
                // Also check using getServerProposalId helper which may extract from nested structures
                const extractedServerId = typeof getServerProposalId === 'function' ? getServerProposalId(p) : null;

                const isIncoming = (serverId && incomingIds.has(serverId))
                    || (hashId && incomingIds.has(hashId))
                    || (extractedServerId && incomingIds.has(String(extractedServerId)));

                console.log('[handleSharedPlanRoute] Checking applied proposal:',
                    'serverId=' + serverId,
                    'hashId=' + hashId,
                    'extractedServerId=' + extractedServerId,
                    'isIncoming=' + isIncoming
                );

                if (isIncoming) {
                    incomingAlreadyApplied.push(p);
                } else {
                    otherAppliedProposals.push(p);
                }
            });
        }

        const linkOrderForProposal = (p) => {
            if (!p) return -1;
            const candidates = [];
            if (p.serverProposalId) candidates.push(String(p.serverProposalId));
            if (p.proposalId) candidates.push(String(p.proposalId));
            try {
                const extracted = typeof getServerProposalId === 'function' ? getServerProposalId(p) : null;
                if (extracted) candidates.push(String(extracted));
            } catch (_) { }
            let best = -1;
            candidates.forEach(c => {
                if (linkOrder.has(c) && linkOrder.get(c) > best) best = linkOrder.get(c);
            });
            return best;
        };

        const mostRecentIncomingApplied = () => {
            let best = null;
            let bestOrd = -1;
            incomingAlreadyApplied.forEach(p => {
                const ord = linkOrderForProposal(p);
                if (ord >= bestOrd) {
                    bestOrd = ord;
                    best = p;
                }
            });
            return best;
        };

        const allIncomingApplied = incomingAlreadyApplied.length === totalProposals;
        const hasOtherApplied = otherAppliedProposals.length > 0;
        const noProposalsApplied = allAppliedProposals.length === 0;

        console.log('[handleSharedPlanRoute] Conflict analysis:',
            'totalProposals=' + totalProposals,
            'incomingAlreadyApplied=' + incomingAlreadyApplied.length,
            'otherApplied=' + otherAppliedProposals.length,
            'allIncomingApplied=' + allIncomingApplied,
            'hasOtherApplied=' + hasOtherApplied
        );

        // Helper: focus on applied proposals — frame and open them the same way a
        // single-proposal link would (center on visible descendant + details panel).
        const focusOnAppliedProposals = async (proposalIdToFocus) => {
            hideProposalLoadOverlay();
            if (proposalIdToFocus && typeof map !== 'undefined' && map) {
                try {
                    const visibleId = (typeof findVisibleDescendant === 'function')
                        ? (findVisibleDescendant(proposalIdToFocus) || proposalIdToFocus)
                        : proposalIdToFocus;
                    const bounds = calculateBoundsForLastAppliedProposal(visibleId);
                    if (bounds && bounds.isValid && bounds.isValid()) {
                        map.fitBounds(bounds, { padding: [80, 80], maxZoom: 18 });
                    }
                    if (typeof focusProposalDetails === 'function') {
                        await focusProposalDetails(visibleId, {
                            centerOnProposal: false,
                            showDetails: true
                        });
                    }
                } catch (err) {
                    console.warn('[handleSharedPlanRoute] Failed to focus on applied proposal:', err);
                }
            }
            if (urlRequests3D) {
                try { tryEnterThreeMode({ fromUrl: true }); } catch (_) { }
            }
        };

        // Scenario 1: Plan already fully applied, no other proposals
        // → "Plan Already Applied [Show me] [OK]"
        if (allIncomingApplied && !hasOtherApplied) {
            hideProposalLoadOverlay();
            const lastApplied = mostRecentIncomingApplied() || incomingAlreadyApplied[0];
            const focusId = lastApplied ? (lastApplied.proposalId || lastApplied.serverProposalId) : null;
            // Resolve via onClose so dismissing the modal (×, Escape, overlay click)
            // does not leave this promise — and the whole route handler — hanging.
            await new Promise(resolve => {
                showSimpleShareModal({
                    title: tShare('plan.alreadyAppliedTitle', 'Plan Already Applied'),
                    body: `<p>${tShare('plan.alreadyAppliedMessage', 'This shared plan is already applied to the map.')}</p>`,
                    actions: [
                        {
                            label: tShare('plan.showMe', 'Show me'),
                            primary: true,
                            onClick: () => { focusOnAppliedProposals(focusId); }
                        },
                        {
                            label: t('modal.common.ok', 'OK'),
                            primary: false
                        }
                    ],
                    onClose: () => resolve()
                });
            });
            cleanPlanUrl();
            return;
        }

        // Scenario 2: other proposals are already on the map. Instead of prompting, auto-unapply only
        // the CONFLICTING ones — proposals that consume the same base parcels as an incoming proposal
        // (e.g. an alternative form for the same block). Non-conflicting proposals on other parcels
        // are left applied, so unrelated proposals stack rather than being cleared.
        if (hasOtherApplied) {
            // Learn the incoming proposals' ancestor parcels. Pre-fetching caches each payload in
            // loadedById so the apply loop below reuses it instead of fetching a second time.
            const incomingAncestors = new Set();
            for (const rawId of queue) {
                const id = normalizeId(rawId);
                if (!id) continue;
                let proposal = loadedById.get(id);
                if (!proposal) {
                    try {
                        const resp = await fetch(`${backendBase}/proposals/${encodeURIComponent(id)}`);
                        if (resp.ok) { proposal = await resp.json(); loadedById.set(id, proposal); }
                    } catch (err) {
                        console.warn('[handleSharedPlanRoute] Conflict pre-fetch failed for', id, err);
                    }
                }
                getPrerequisiteParcelIdsForProposal(proposal).forEach(pid => incomingAncestors.add(pid));
            }

            // A currently-applied proposal conflicts when its ancestor parcels overlap the incoming
            // ones (both consume the same base parcels, so they are mutually exclusive).
            const proposalKey = (p) => String(p.proposalId || p.serverProposalId || '');
            const conflicting = otherAppliedProposals.filter(p =>
                getPrerequisiteParcelIdsForProposal(p).some(pid => incomingAncestors.has(pid))
            );

            if (conflicting.length > 0 && typeof ProposalManager !== 'undefined') {
                console.log('[handleSharedPlanRoute] Auto-unapplying', conflicting.length, 'conflicting proposal(s)');
                for (const p of conflicting) {
                    const pid = p.proposalId || p.serverProposalId;
                    if (!pid) continue;
                    try {
                        if (typeof ProposalManager.unapplyWholeFamily === 'function') {
                            await ProposalManager.unapplyWholeFamily(pid);
                        } else if (typeof ProposalManager.unapplyProposal === 'function') {
                            await ProposalManager.unapplyProposal(pid, { skipConfirm: true });
                        }
                    } catch (err) {
                        console.warn('[handleSharedPlanRoute] Failed to unapply conflicting proposal', pid, err);
                    }
                }
                if (typeof ProposalManager._refreshUIAfterProposalChange === 'function') {
                    ProposalManager._refreshUIAfterProposalChange(null);
                }
                // Drop the unapplied ones from the applied-tracking so later logic stays consistent.
                const conflictingKeys = new Set(conflicting.map(proposalKey));
                otherAppliedProposals = otherAppliedProposals.filter(p => !conflictingKeys.has(proposalKey(p)));
                allAppliedProposals = allAppliedProposals.filter(p => !conflictingKeys.has(proposalKey(p)));

                if (typeof showEphemeralMessage === 'function') {
                    const names = conflicting.map(p => {
                        const sid = p.serverProposalId || (typeof getServerProposalId === 'function' ? getServerProposalId(p) : null);
                        return sid ? `#${sid}` : (p.title || p.proposalId);
                    }).filter(Boolean);
                    showEphemeralMessage(tShare('plan.replacedConflicting', 'Replaced {{count}} proposal(s) on the same parcels: {{list}}', {
                        count: conflicting.length,
                        list: names.join(', ')
                    }));
                }
            }

            // Re-show the loading overlay and continue applying the incoming proposals.
            showProposalLoadOverlay(tShare('plan.fetchingPlan', 'Fetching plan…'), {
                total: totalProposals,
                title: tShare('plan.fetchingPlanTitle', 'Fetching proposal')
            });
        }

        // Scenario 3: No proposals on map → proceed silently (no dialog needed)

        // Build set of already-applied server IDs to exclude from queue
        const alreadyAppliedServerIds = new Set();
        incomingAlreadyApplied.forEach(p => {
            if (p.serverProposalId) alreadyAppliedServerIds.add(String(p.serverProposalId));
            const extracted = typeof getServerProposalId === 'function' ? getServerProposalId(p) : null;
            if (extracted) alreadyAppliedServerIds.add(String(extracted));
        });

        // Queue only proposals that are NOT already applied (deduplicated)
        queue = Array.from(new Set(idParts.map(normalizeId).filter(id => {
            if (!id) return false;
            if (alreadyAppliedServerIds.has(id)) {
                console.log('[handleSharedPlanRoute] Skipping already-applied proposal:', id);
                return false;
            }
            return true;
        })));

        console.log('[handleSharedPlanRoute] Queue after filtering out already-applied:', queue.length, 'of', totalProposals);
        updateProposalLoadOverlay({ progress: { done: fetchProgressIds.size, total: totalProposals } });

        // If nothing left to apply after filtering, focus on what's already applied and we're done
        if (queue.length === 0) {
            console.log('[handleSharedPlanRoute] All proposals already applied, focusing on them');
            const lastApplied = mostRecentIncomingApplied() || incomingAlreadyApplied[0];
            const focusId = lastApplied ? (lastApplied.proposalId || lastApplied.serverProposalId) : null;
            await focusOnAppliedProposals(focusId);
            cleanPlanUrl();
            return;
        }

        const startFetchBaseParcels = async (parcelIds, options = {}) => {
            const ids = ensureArrayOfStrings(parcelIds);
            if (!ids.length) return { attempted: [], missingAfter: [] };

            const unique = Array.from(new Set(ids));
            const toFetch = [];
            unique.forEach(id => {
                if (!id) return;
                if (fetchedBaseParcels.has(id)) return;
                if (baseParcelFetchInFlight.has(id)) return;
                // Skip parcels already consumed by an earlier applied proposal; ingest
                // would skip them anyway and waiting for them causes an infinite loop.
                if (typeof isParcelReplacedByChildren === 'function' && isParcelReplacedByChildren(id)) return;
                toFetch.push(id);
            });

            // If nothing new to fetch, optionally await any in-flight fetches for these ids.
            if (!toFetch.length) {
                if (options.await === true) {
                    const inflight = unique.map(id => baseParcelFetchInFlight.get(id)).filter(Boolean);
                    if (inflight.length) {
                        await Promise.allSettled(inflight);
                    }
                }
                const missingAfter = unique.filter(id => {
                    if (typeof isParcelLayerReady === 'function' && isParcelLayerReady(id)) return false;
                    if (typeof isParcelReplacedByChildren === 'function' && isParcelReplacedByChildren(id)) return false;
                    return true;
                });
                return { attempted: [], missingAfter };
            }

            // Bulk fetch (per proposal): one request chain for the full list.
            const batchPromise = (async () => {
                try {
                    if (typeof fetchParcelsForIds === 'function') {
                        await fetchParcelsForIds(toFetch, { forceRefresh: true });
                    } else if (typeof ensureParentParcelsLoaded === 'function') {
                        await ensureParentParcelsLoaded(toFetch, { forceRefreshParcels: true });
                    }
                    if (typeof waitForParcelLayersReady === 'function') {
                        await waitForParcelLayersReady(toFetch, { timeoutMs: 15000, pollIntervalMs: 200 });
                    }
                } catch (err) {
                    console.warn('[handleSharedPlanRoute] Failed to bulk fetch base parcels for apply plan', { ids: toFetch, err });
                } finally {
                    toFetch.forEach(id => baseParcelFetchInFlight.delete(id));
                }
            })();

            // Track per-id promise for this batch so later proposals can await without duplicating work.
            toFetch.forEach(id => baseParcelFetchInFlight.set(id, batchPromise));

            if (options.await === true) {
                await Promise.allSettled([batchPromise]);
            }

            // Mark fetched ids that are now ready.
            toFetch.forEach(id => {
                try {
                    if (typeof isParcelLayerReady === 'function' && isParcelLayerReady(id)) {
                        fetchedBaseParcels.add(id);
                    }
                } catch (_) { }
            });

            const missingAfter = unique.filter(id => {
                try {
                    if (typeof isParcelLayerReady === 'function' && isParcelLayerReady(id)) return false;
                    if (typeof isParcelReplacedByChildren === 'function' && isParcelReplacedByChildren(id)) return false;
                    return true;
                } catch (_) {
                    return true;
                }
            });

            return { attempted: toFetch, missingAfter };
        };

        while (queue.length > 0) {
            const id = queue.shift();
            try { attemptedSinceProgress.add(normalizeId(id)); } catch (_) { }
            const priorAttempts = attemptById.get(id) || 0;
            attemptById.set(id, priorAttempts + 1);

            // Hard stop for a single proposal to avoid infinite loops.
            if (attemptById.get(id) > maxAttemptsPerId) {
                const cachedProposal = loadedById.get(id) || null;
                const cachedType = proposalTypeById.get(id) || formatSharedProposalTypeLabel(cachedProposal);
                const key = String(id);

                const missingPrereqs = (() => {
                    try {
                        const explicitMissing = lastMissingPrereqsById.get(key) || lastUnfetchedBasePrereqIdsById.get(key);
                        if (Array.isArray(explicitMissing) && explicitMissing.length) return explicitMissing;
                        const storedFailure = getStoredApplyFailureInfo(key);
                        if (storedFailure && Array.isArray(storedFailure.missingIds) && storedFailure.missingIds.length) {
                            return ensureArrayOfStrings(storedFailure.missingIds);
                        }
                        const basePrereqs = basePrereqIdsById.get(key) || [];
                        return ensureArrayOfStrings(basePrereqs)
                            .filter(pid => !(typeof isParcelLayerReady === 'function' && isParcelLayerReady(pid)));
                    } catch (_) {
                        return [];
                    }
                })();

                const fallbackReason = (() => {
                    try {
                        const cached = lastReasonById.get(key);
                        if (cached) return String(cached);
                        const storedFailure = getStoredApplyFailureInfo(key);
                        return storedFailure && storedFailure.message ? String(storedFailure.message) : '';
                    } catch (_) {
                        return '';
                    }
                })();

                const reasonParts = [];
                if (fallbackReason) reasonParts.push(fallbackReason);
                if (missingPrereqs.length) reasonParts.push(`Missing prerequisite parcels: ${missingPrereqs.join(', ')}`);
                const reason = reasonParts.length
                    ? reasonParts.join(' · ') + ` (too many retries: ${maxAttemptsPerId})`
                    : tShare('plan.applyUnknownFailure', 'Unknown error while applying.') + ` (too many retries: ${maxAttemptsPerId})`;

                console.warn('[handleSharedPlanRoute] Giving up after max retries', { id, reason, missingPrereqs });

                failed.push({
                    id,
                    label: formatSharedProposalLabel(cachedProposal, id),
                    type: cachedType,
                    missingPrereqs,
                    reason
                });
                stepsSinceProgress += 1;
                continue;
            }

            try {
                let proposal = loadedById.get(id);
                if (!proposal) {
                    const baseStatus = tShare('plan.fetching', 'Fetching proposal #{{id}}…', { id });
                    const ordinal = getFetchOrdinal(id);
                    const fetchingStatus = (totalProposals > 0)
                        ? `${baseStatus} (${ordinal}/${totalProposals})`
                        : baseStatus;
                    updateProposalLoadOverlay({
                        status: fetchingStatus,
                        progress: { done: fetchProgressIds.size, total: totalProposals }
                    });
                    const response = await fetch(`${backendBase}/proposals/${encodeURIComponent(id)}`);
                    await addResponseBytes(response);
                    if (!response.ok) {
                        let reason;
                        if (response.status === 404) {
                            reason = tShare('plan.notFoundOnServer', 'Not found on server');
                        } else {
                            reason = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`.trim();
                        }
                        failed.push({ id, label: formatSharedProposalLabel(null, id), reason });
                        markFetchProgress(id);
                        stepsSinceProgress += 1;
                        continue;
                    }
                    proposal = await response.json();
                    loadedById.set(id, proposal);
                    try {
                        const inferredType = formatSharedProposalTypeLabel(proposal);
                        if (inferredType) proposalTypeById.set(id, inferredType);
                    } catch (_) { }
                }

                markFetchProgress(id);

                // Decide whether to fetch base parcels before applying.
                // - only base prerequisites: fetch and wait, then apply now
                // - mixed base+derived: kick off base fetch, then requeue without applying
                // - only derived: do not fetch; attempt apply
                const prereqIds = getPrerequisiteParcelIdsForProposal(proposal);
                const { baseIds, derivedIds } = splitBaseAndDerivedIds(prereqIds);
                try {
                    const queueKey = String(id);
                    const payloadKey = (proposal && proposal.proposalId) ? String(proposal.proposalId) : '';

                    prereqIdsById.set(queueKey, prereqIds);
                    basePrereqIdsById.set(queueKey, baseIds);
                    if (payloadKey) {
                        prereqIdsById.set(payloadKey, prereqIds);
                        basePrereqIdsById.set(payloadKey, baseIds);
                    }
                } catch (_) { }

                const computeMissingParentsNow = () => {
                    try {
                        const unique = Array.from(new Set(ensureArrayOfStrings(prereqIds)));
                        return unique.filter(pid => !(typeof isParcelLayerReady === 'function' && isParcelLayerReady(pid)));
                    } catch (_) {
                        return [];
                    }
                };

                const parseMissingFromString = (text) => {
                    try {
                        if (!text || typeof text !== 'string') return [];
                        const match = text.match(/missing[^:]*:\s*(.+)$/i);
                        if (match && match[1]) {
                            return match[1].split(/[,\s]+/).map(x => x.trim()).filter(Boolean);
                        }
                        return [];
                    } catch (_) { return []; }
                };

                if (baseIds.length > 0 && derivedIds.length > 0) {
                    // Mixed: fetch base parents and wait once before deciding whether to apply or requeue.
                    const fetchResult = await startFetchBaseParcels(baseIds, { await: true });
                    try {
                        lastUnfetchedBasePrereqIdsById.set(String(id), fetchResult.missingAfter);
                        if (proposal && proposal.proposalId) lastUnfetchedBasePrereqIdsById.set(String(proposal.proposalId), fetchResult.missingAfter);
                    } catch (_) { }

                    try {
                        const missingNow = computeMissingParentsNow();
                        lastMissingPrereqsById.set(String(id), missingNow);
                        if (proposal && proposal.proposalId) lastMissingPrereqsById.set(String(proposal.proposalId), missingNow);

                        const baseMissingNow = baseIds.filter(pid => {
                            if (typeof isParcelLayerReady === 'function' && isParcelLayerReady(pid)) return false;
                            // Parcel consumed by an earlier applied proposal — not missing, just off-map by design.
                            if (typeof isParcelReplacedByChildren === 'function' && isParcelReplacedByChildren(pid)) return false;
                            return true;
                        });
                        const derivedMissingNow = derivedIds.filter(pid => !(typeof isParcelLayerReady === 'function' && isParcelLayerReady(pid)));
                        const hint = baseMissingNow.length
                            ? `Waiting for base prerequisites (${baseMissingNow.slice(0, 6).join(', ')}${baseMissingNow.length > 6 ? ', …' : ''})`
                            : (derivedMissingNow.length
                                ? `Waiting for derived prerequisites (${derivedMissingNow.slice(0, 6).join(', ')}${derivedMissingNow.length > 6 ? ', …' : ''})`
                                : 'Waiting for prerequisites (mixed base + derived).');
                        lastReasonById.set(String(id), hint);
                        if (proposal && proposal.proposalId) lastReasonById.set(String(proposal.proposalId), hint);

                        // If base parents are still missing, requeue (do not apply yet).
                        if (baseMissingNow.length > 0) {
                            queue.push(id);
                            stepsSinceProgress += 1;
                            continue;
                        }
                        // Base parents are present; proceed to apply now (derived can still cause requeue on failure).
                    } catch (_) {
                        queue.push(id);
                        stepsSinceProgress += 1;
                        continue;
                    }
                }
                if (baseIds.length > 0 && derivedIds.length === 0) {
                    // Base-only: fetch before attempting apply.
                    const fetchResult = await startFetchBaseParcels(baseIds, { await: true });
                    try {
                        lastUnfetchedBasePrereqIdsById.set(String(id), fetchResult.missingAfter);
                        if (proposal && proposal.proposalId) lastUnfetchedBasePrereqIdsById.set(String(proposal.proposalId), fetchResult.missingAfter);
                        const missingNow = computeMissingParentsNow();
                        lastMissingPrereqsById.set(String(id), missingNow);
                        if (proposal && proposal.proposalId) lastMissingPrereqsById.set(String(proposal.proposalId), missingNow);
                    } catch (_) { }
                }

                updateProposalLoadOverlay({ status: tShare('plan.applying', 'Applying proposal #{{id}}…', { id }) });
                let result;
                try {
                    // For /proposals/:id1,id2,… we intentionally do NOT fetch/resolve parcels here.
                    // Missing parcels are expected to be created by earlier applies.
                    result = await importAndApplySharedProposal(proposal, { skipDependencyFetch: true });
                } catch (err) {
                    // Convert thrown dependency errors into retryable results.
                    if (isDependencyFailure(err)) {
                        result = { applied: false, skipped: false, proposalId: proposal?.proposalId || id, reason: err.message || String(err) };
                    } else {
                        throw err;
                    }
                }

                const proposalId = (result && result.proposalId) || proposal?.proposalId || id;
                const label = formatSharedProposalLabel(proposal, proposalId);
                try {
                    const inferredType = proposalTypeById.get(id) || formatSharedProposalTypeLabel(proposal);
                    if (inferredType) {
                        proposalTypeById.set(id, inferredType);
                        if (proposalId) proposalTypeById.set(String(proposalId), inferredType);
                    }
                } catch (_) { }

                // Ensure prereq maps are also keyed by the final resolved proposal id.
                try {
                    const pidKey = proposalId ? String(proposalId) : '';
                    if (pidKey && prereqIds && Array.isArray(prereqIds)) {
                        prereqIdsById.set(pidKey, prereqIds);
                        basePrereqIdsById.set(pidKey, baseIds);
                        const baseMissing = lastUnfetchedBasePrereqIdsById.get(String(id))
                            || lastUnfetchedBasePrereqIdsById.get((proposal && proposal.proposalId) ? String(proposal.proposalId) : '')
                            || [];
                        if (Array.isArray(baseMissing) && baseMissing.length) {
                            lastUnfetchedBasePrereqIdsById.set(pidKey, baseMissing);
                        }
                    }
                } catch (_) { }

                if (result && result.skipped) {
                    skipped.push({ id: proposalId, label, ord: linkOrder.has(normalizeId(id)) ? linkOrder.get(normalizeId(id)) : -1 });
                    if (proposalId) lastLoadedProposalIdFor3D = proposalId;
                    stepsSinceProgress = 0;
                    attemptedSinceProgress.clear();
                    continue;
                }

                if (result && result.applied) {
                    applied.push({ id: proposalId, label, ord: linkOrder.has(normalizeId(id)) ? linkOrder.get(normalizeId(id)) : -1 });
                    if (proposalId) lastLoadedProposalIdFor3D = proposalId;
                    stepsSinceProgress = 0;
                    attemptedSinceProgress.clear();
                    continue;
                }

                const reason = (result && result.reason) || tShare('plan.applyUnknownFailure', 'Unknown error while applying.');
                const dependencyFailure = getDependencyFailureInfo((result && result.failureInfo) ? result.failureInfo : reason);
                try { if (proposalId) lastReasonById.set(String(proposalId), String(reason || '')); } catch (_) { }
                if (dependencyFailure) {
                    const dependencyMissingIds = ensureArrayOfStrings(dependencyFailure.missingIds || []);
                    if (dependencyMissingIds.length > 0) {
                        const existingMissing = ensureArrayOfStrings(lastMissingPrereqsById.get(String(id)) || []);
                        const combinedMissing = Array.from(new Set(existingMissing.concat(dependencyMissingIds)));
                        lastMissingPrereqsById.set(String(id), combinedMissing);
                        if (proposalId) lastMissingPrereqsById.set(String(proposalId), combinedMissing);
                    }
                    // If the dependency is a *base* parcel (no #p- suffix), try fetching it once.
                    const missingParcelId = extractMissingParcelId(dependencyFailure);
                    if (missingParcelId && !isDerivedParcelId(missingParcelId) && !fetchedBaseParcels.has(missingParcelId)) {
                        fetchedBaseParcels.add(missingParcelId);
                        try {
                            const fetchResult = await startFetchBaseParcels([missingParcelId], { await: true });
                            try {
                                const key = String(proposalId || id);
                                const basePrereqs = basePrereqIdsById.get(key) || [];
                                const missingNow = Array.from(new Set([...(fetchResult.missingAfter || []), ...basePrereqs]))
                                    .filter(pid => pid && !(typeof isParcelLayerReady === 'function' && isParcelLayerReady(pid)));
                                lastUnfetchedBasePrereqIdsById.set(key, missingNow);
                            } catch (_) { }
                        } catch (fetchErr) {
                            // Best-effort only; still requeue.
                            console.warn('[handleSharedPlanRoute] Failed to fetch missing base parcel for apply plan', { missingParcelId, fetchErr });
                        }
                    }

                    // Bump to end of queue and try others; a later proposal may load required parcels.
                    try {
                        const missingNow = (() => {
                            try {
                                const full = prereqIdsById.get(String(id)) || prereqIdsById.get(String(proposalId)) || [];
                                const unique = Array.from(new Set(ensureArrayOfStrings(full)));
                                return unique.filter(pid => !(typeof isParcelLayerReady === 'function' && isParcelLayerReady(pid)));
                            } catch (_) { return []; }
                        })();
                        lastMissingPrereqsById.set(String(id), missingNow);
                        if (proposalId) lastMissingPrereqsById.set(String(proposalId), missingNow);
                    } catch (_) { }
                    queue.push(id);
                    stepsSinceProgress += 1;
                } else {
                    failed.push({
                        id: proposalId,
                        label,
                        type: (proposalTypeById.get(String(proposalId)) || proposalTypeById.get(String(id)) || formatSharedProposalTypeLabel(proposal) || ''),
                        missingPrereqs: (() => {
                            try {
                                const key = String(proposalId || id);
                                const explicitMissing = lastUnfetchedBasePrereqIdsById.get(key);
                                if (Array.isArray(explicitMissing) && explicitMissing.length) return explicitMissing;
                                const storedFailure = getStoredApplyFailureInfo(key);
                                if (storedFailure && Array.isArray(storedFailure.missingIds) && storedFailure.missingIds.length) {
                                    return ensureArrayOfStrings(storedFailure.missingIds);
                                }
                                const basePrereqs = basePrereqIdsById.get(key) || [];
                                const missing = ensureArrayOfStrings(basePrereqs)
                                    .filter(pid => !(typeof isParcelLayerReady === 'function' && isParcelLayerReady(pid)));
                                return missing;
                            } catch (_) {
                                return [];
                            }
                        })(),
                        reason
                    });
                    stepsSinceProgress += 1;
                }
            } catch (error) {
                console.error('apply plan item failed', id, error);
                const reason = (error && error.message) ? error.message : 'Unexpected error';
                try { lastReasonById.set(String(id), String(reason || '')); } catch (_) { }
                if (isDependencyFailure(error) || isDependencyFailure(reason)) {
                    queue.push(id);
                } else {
                    const cachedProposal = loadedById.get(id) || null;
                    failed.push({
                        id,
                        label: formatSharedProposalLabel(cachedProposal, id),
                        type: (proposalTypeById.get(id) || formatSharedProposalTypeLabel(cachedProposal) || ''),
                        missingPrereqs: (() => {
                            try {
                                const key = String(id);
                                const explicitMissing = lastUnfetchedBasePrereqIdsById.get(key);
                                if (Array.isArray(explicitMissing) && explicitMissing.length) return explicitMissing;
                                const storedFailure = getStoredApplyFailureInfo(key);
                                if (storedFailure && Array.isArray(storedFailure.missingIds) && storedFailure.missingIds.length) {
                                    return ensureArrayOfStrings(storedFailure.missingIds);
                                }
                                const basePrereqs = basePrereqIdsById.get(key) || [];
                                const missing = ensureArrayOfStrings(basePrereqs)
                                    .filter(pid => !(typeof isParcelLayerReady === 'function' && isParcelLayerReady(pid)));
                                return missing;
                            } catch (_) {
                                return [];
                            }
                        })(),
                        reason
                    });
                }
                markFetchProgress(id);
                stepsSinceProgress += 1;
            }

            // If we've attempted every remaining unique id since last progress and still made no progress,
            // stop to avoid an infinite loop. (This also ensures we capture at least one failure reason per id.)
            if (queue.length > 0) {
                const remainingUnique = new Set(queue.map(normalizeId).filter(Boolean));
                let allAttempted = true;
                for (const rem of remainingUnique) {
                    if (!attemptedSinceProgress.has(rem)) {
                        allAttempted = false;
                        break;
                    }
                }
                if (allAttempted && stepsSinceProgress >= remainingUnique.size) {
                    break;
                }
            }
        }

        // Anything left in the queue after the loop is considered blocked.
        if (queue.length > 0) {
            const seen = new Set();
            queue.forEach(id => {
                const norm = normalizeId(id);
                if (!norm || seen.has(norm)) return;
                seen.add(norm);
                const cachedProposal = loadedById.get(norm) || null;
                const cachedType = proposalTypeById.get(norm) || formatSharedProposalTypeLabel(cachedProposal);
                const missingPrereqs = (() => {
                    try {
                        const combined = new Set();
                        const explicitMissing = lastMissingPrereqsById.get(norm) || lastUnfetchedBasePrereqIdsById.get(norm);
                        ensureArrayOfStrings(explicitMissing).forEach(id => combined.add(id));
                        const storedFailure = getStoredApplyFailureInfo(norm);
                        ensureArrayOfStrings(storedFailure && storedFailure.missingIds ? storedFailure.missingIds : []).forEach(id => combined.add(id));

                        const basePrereqs = basePrereqIdsById.get(norm) || [];
                        ensureArrayOfStrings(basePrereqs)
                            .filter(pid => !(typeof isParcelLayerReady === 'function' && isParcelLayerReady(pid)))
                            .forEach(id => combined.add(id));

                        const allPrereqs = prereqIdsById.get(norm) || [];
                        ensureArrayOfStrings(allPrereqs)
                            .filter(pid => !(typeof isParcelLayerReady === 'function' && isParcelLayerReady(pid)))
                            .forEach(id => combined.add(id));

                        const fallback = (() => {
                            try {
                                const reason = lastReasonById.get(norm) || fallbackReason;
                                return parseMissingFromString(reason);
                            } catch (_) { return []; }
                        })();
                        ensureArrayOfStrings(fallback).forEach(id => combined.add(id));

                        return Array.from(combined);
                    } catch (_) {
                        return [];
                    }
                })();
                const lastReason = (() => {
                    try {
                        const cached = lastReasonById.get(norm);
                        return cached ? String(cached) : '';
                    } catch (_) {
                        return '';
                    }
                })();

                const fallbackReason = (() => {
                    try {
                        if (lastReason) return '';
                        const storedFailure = getStoredApplyFailureInfo(norm);
                        return storedFailure && storedFailure.message ? String(storedFailure.message) : '';
                    } catch (_) {
                        return '';
                    }
                })();

                const reasonParts = [tShare('plan.applyBlockedByDependencies', 'Blocked: dependencies not satisfied after retries.')];
                if (lastReason) reasonParts.push(lastReason);
                else if (fallbackReason) reasonParts.push(fallbackReason);
                if (missingPrereqs.length) {
                    reasonParts.push(`Missing prerequisite parcels: ${missingPrereqs.join(', ')}`);
                }

                failed.push({
                    id: norm,
                    label: formatSharedProposalLabel(cachedProposal, norm),
                    type: cachedType,
                    missingPrereqs,
                    reason: reasonParts.join(' · ')
                });
            });
        }

        hideProposalLoadOverlay();

        cleanPlanUrl();

        const escape = typeof escapeHtml === 'function' ? escapeHtml : (value => value);
        const renderList = (items, formatter) => {
            const content = items.map(formatter).join('');
            return `<div class="shared-plan-list" style="max-height: 320px; overflow-y: auto; padding-right: 4px;"><ul style="margin: 0; padding-left: 18px;">${content}</ul></div>`;
        };

        const bodyLines = [];
        if (applied.length > 0) {
            const appliedItems = renderList(applied, item => `<li>${escape(item.label || formatSharedProposalLabel(null, item.id))}</li>`);
            bodyLines.push(`<p>${tShare('plan.appliedCountDetailed', 'Applied {{count}} proposal{{suffix}}:', {
                count: applied.length,
                suffix: applied.length === 1 ? '' : 's'
            })}</p>${appliedItems}`);
        }
        if (skipped.length > 0) {
            if (bodyLines.length > 0) bodyLines.push('<br>');
            const skippedItems = renderList(skipped, item => `<li>${escape(item.label || formatSharedProposalLabel(null, item.id))}</li>`);
            bodyLines.push(`<p>${tShare('plan.skippedCountDetailed', 'Skipped {{count}} duplicate proposal{{suffix}} (already present):', {
                count: skipped.length,
                suffix: skipped.length === 1 ? '' : 's'
            })}</p>${skippedItems}`);
        }
        if (failed.length > 0) {
            if (bodyLines.length > 0) bodyLines.push('<br>');
            const failedItems = renderList(failed, item => {
                const label = escape(item.label || formatSharedProposalLabel(null, item.id));
                const type = item.type ? ` (${escape(item.type)})` : '';
                const reason = item.reason ? ` · ${escape(item.reason)}` : '';
                const missing = ensureArrayOfStrings(item.missingPrereqs || []);
                const missingBlock = missing.length
                    ? `<ul style="margin: 4px 0 0 16px; padding-left: 16px; list-style-type: circle;">
                        ${missing.map(pid => `<li>${escape(pid)}</li>`).join('')}
                    </ul>`
                    : '';
                return `<li>${label}${type}${reason}${missingBlock}</li>`;
            });
            bodyLines.push(`<p>${tShare('plan.failedCountDetailed', 'Failed to apply {{count}} proposal{{suffix}}:', {
                count: failed.length,
                suffix: failed.length === 1 ? '' : 's'
            })}</p>${failedItems}`);
        }

        const wants3DFromUrl = (!url3DModeHandled && is3DModeRequestedFromUrl());

        if (applied.length > 0) {
            if (typeof updateProposalLayer === 'function') updateProposalLayer();
            if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton();
        }

        // Center map on the visible descendant of the most recently loaded proposal — the one
        // latest in link order among everything now on the map (applied, skipped as duplicate,
        // or filtered out earlier because it was already applied) — as if it were loaded alone.
        // Link order is used instead of chronological apply order because dependency requeueing
        // can apply an older proposal after a newer one.
        let rawLastProposalId = null;
        let rawLastOrd = -1;
        const considerFocusCandidate = (candidateId, ord) => {
            if (!candidateId) return;
            const effectiveOrd = Number.isFinite(ord) ? ord : -1;
            if (effectiveOrd >= rawLastOrd) {
                rawLastOrd = effectiveOrd;
                rawLastProposalId = candidateId;
            }
        };
        applied.forEach(item => considerFocusCandidate(item.id, item.ord));
        skipped.forEach(item => considerFocusCandidate(item.id, item.ord));
        incomingAlreadyApplied.forEach(p => considerFocusCandidate(p.proposalId || p.serverProposalId, linkOrderForProposal(p)));
        if (!rawLastProposalId) {
            rawLastProposalId = lastLoadedProposalIdFor3D
                || (applied.length > 0 ? applied[applied.length - 1].id : null)
                || (skipped.length > 0 ? skipped[skipped.length - 1].id : null);
        }
        const lastProposalId = rawLastProposalId ? findVisibleDescendant(rawLastProposalId) : null;
        console.log('[handleSharedPlanRoute] Centering on proposal:', rawLastProposalId, '→ visible descendant:', lastProposalId);

        if (lastProposalId && typeof map !== 'undefined' && map) {
            try {
                const beforeCenter = (typeof map.getCenter === 'function') ? map.getCenter() : null;
                const beforeZoom = (typeof map.getZoom === 'function') ? map.getZoom() : null;
                const settlePromise = createLeafletViewSettlePromise(beforeCenter, beforeZoom);
                const bounds = calculateBoundsForLastAppliedProposal(lastProposalId);
                if (bounds && bounds.isValid && bounds.isValid()) {
                    map.fitBounds(bounds, { padding: [80, 80], maxZoom: 18 });
                }
                await settlePromise;
            } catch (error) {
                console.warn('Failed to center map on last applied proposal:', error);
            }
        }

        // Highlight the loaded proposal + open details panel. handleSharedPlanRoute only applied
        // the proposal and centered the map; without this call, window.currentlyHighlightedProposal
        // stays null and no overlays are drawn. For a multi-id share we highlight the last one
        // (same semantics as centering, which uses the last applied id).
        if (lastProposalId && typeof focusProposalDetails === 'function') {
            try {
                await focusProposalDetails(lastProposalId, {
                    centerOnProposal: false, // camera has already been fit to bounds above
                    showDetails: true
                });
            } catch (error) {
                console.warn('[handleSharedPlanRoute] focusProposalDetails failed', error);
            }
        }

        // Only make the user read/dismiss the summary when there is something worth reading —
        // failures or skipped duplicates. A clean apply on a 3D link goes straight to 3D (with a
        // brief toast) instead of a modal that would just get auto-closed by the 3D transition.
        const summaryHasIssues = failed.length > 0 || skipped.length > 0;
        const showSummaryModal = bodyLines.length > 0 && (summaryHasIssues || !wants3DFromUrl);

        let planSummaryModal = null;
        if (showSummaryModal) {
            planSummaryModal = showSimpleShareModal({
                title: tShare('plan.summary', 'Shared Plan Result'),
                body: bodyLines.join(''),
                actions: [
                    { label: t('modal.common.close', 'Close'), primary: true }
                ],
                onClose: () => {
                    // URL-driven 3D mode: only enter after the user dismisses the results dialog.
                    try {
                        if (wants3DFromUrl && !url3DModeHandled) {
                            const entered = tryEnterThreeMode({ fromUrl: true });
                            if (entered) url3DModeHandled = true;
                        }
                    } catch (_) { }
                }
            });
        } else if (applied.length > 0 && wants3DFromUrl && typeof showEphemeralMessage === 'function') {
            // Clean apply, auto-advancing into 3D: give lightweight feedback that it worked.
            showEphemeralMessage(tShare('plan.appliedToast', 'Applied {{count}} proposal{{suffix}}.', {
                count: applied.length,
                suffix: applied.length === 1 ? '' : 's'
            }));
        }

        // No dialog shown -> honor URL-driven 3D immediately after focusing.
        if (!planSummaryModal) {
            try {
                if (wants3DFromUrl && !url3DModeHandled) {
                    const entered = tryEnterThreeMode({ fromUrl: true });
                    if (entered) url3DModeHandled = true;
                }
            } catch (_) { }
        }
    } catch (error) {
        console.error('handleSharedPlanRoute failed', error);
        hideProposalLoadOverlay();
    } finally {
        if (typeof window !== 'undefined') {
            window.skipParcelFetchUntilProposalLoaded = false;
        }
    }
}

function handleStandalone3DModeFromUrl(attempt = 0) {
    try {
        if (url3DModeHandled) return;
        const wants3D = is3DModeRequestedFromUrl();
        if (!wants3D) return;

        // Check if there are proposal-related URL params - if so, let proposal handlers deal with 3D
        const params = new URLSearchParams(window.location.search || '');
        const hasProposalParams = params.has('proposalShare') || params.has('shared') || window.location.pathname.startsWith('/proposals/');
        if (hasProposalParams) {
            // Proposal handlers will handle 3D mode, so we don't need to do anything here
            return;
        }

        if (typeof map === 'undefined' || !map) {
            if (attempt < 15) {
                setTimeout(() => handleStandalone3DModeFromUrl(attempt + 1), 400);
            }
            return;
        }

        // No proposal params, so enter 3D mode directly after map is ready
        // Wait a short moment to ensure map is fully initialized
        setTimeout(() => {
            if (!url3DModeHandled && is3DModeRequestedFromUrl()) {
                const entered = tryEnterThreeMode({ fromUrl: true });
                if (entered) url3DModeHandled = true;
            }
        }, 300);
    } catch (error) {
        console.error('handleStandalone3DModeFromUrl failed', error);
    }
}
