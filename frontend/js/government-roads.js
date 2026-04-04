(function () {
    let isFetchingGovernmentPlan = false;
    let cachedPlanCollection = null;
    let cachedPlanSource = null;
    let lastPlanDescriptor = null;
    let planLayer = null;
    let cachedPlanGeometryHash = null;
    let cachedPlanVertexCount = 0;
    let governmentPlanProposalId = null;
    let isApplyingGovernmentPlan = false;
    let activePlanHashToken = null;
    let lastAutoApplyStats = null;
    let lastSuccessfulApplyTime = 0;
    let planComputationWorker = null;
    let planWorkerRequestSeq = 0;
    const planWorkerPending = new Map();
    let planWorkerDisabledReason = null;
    let lastPlanComputationMode = 'not-run';

    function isLocalFileOrigin() {
        try {
            return typeof window !== 'undefined' && window.location && window.location.protocol === 'file:';
        } catch (_) {
            lastPlanComputationMode = 'not-run';
            const stats = (typeof window !== 'undefined' && window.lastGovernmentPlanAutoApplyStats)
                ? window.lastGovernmentPlanAutoApplyStats
                : null;
        }
    }

    function ensurePlanWorker() {
        if (planWorkerDisabledReason) {
            return null;
        }
        if (typeof Worker === 'undefined') {
            planWorkerDisabledReason = 'Web Workers are not supported in this environment.';
            console.warn(planWorkerDisabledReason);
            return null;
        }
        if (isLocalFileOrigin()) {
            planWorkerDisabledReason = 'Government plan worker disabled: browsers block Worker() when running from the file:// protocol. Serve the frontend via a local web server (for example "npx serve frontend") to enable background processing.';
            console.warn(planWorkerDisabledReason);
            return null;
        }
        if (planComputationWorker) {
            return planComputationWorker;
        }
        try {
            planComputationWorker = new Worker('js/government-plan-worker.js');
            console.log('[GovernmentPlan] Background worker started for plan processing.');
            planComputationWorker.onmessage = event => {
                const data = event.data || {};
                const requestId = data.requestId;
                if (!requestId || !planWorkerPending.has(requestId)) {
                    return;
                }
                const { resolve, reject } = planWorkerPending.get(requestId);
                planWorkerPending.delete(requestId);
                if (data.success) {
                    resolve(data.result);
                    return;
                }

                let error = data.error;
                if (!(error instanceof Error)) {
                    const message = error && error.message
                        ? error.message
                        : 'Government plan worker returned an unknown error.';
                    error = new Error(message);
                    if (error && data.error && data.error.stack) {
                        error.stack = data.error.stack;
                    }
                }
                reject(error);
            };
            planComputationWorker.onerror = err => {
                console.warn('Government plan worker encountered an error.', err);
                planWorkerPending.forEach(({ reject }) => {
                    try { reject(err); } catch (_) { }
                });
                planWorkerPending.clear();
                if (planComputationWorker) {
                    planComputationWorker.terminate();
                }
                planComputationWorker = null;
            };
        } catch (err) {
            planWorkerDisabledReason = err && err.message ? err.message : 'Failed to initialize government plan worker.';
            console.warn('Failed to initialize government plan worker.', err);
            planComputationWorker = null;
        }
        return planComputationWorker;
    }

    function terminatePlanWorker() {
        if (planComputationWorker) {
            try { planComputationWorker.terminate(); } catch (_) { }
            planComputationWorker = null;
        }
        planWorkerPending.forEach(({ reject }) => {
            try { reject(new Error('Government plan worker terminated.')); } catch (_) { }
        });
        planWorkerPending.clear();
    }

    function invokePlanWorker(payload) {
        const worker = ensurePlanWorker();
        if (!worker) {
            return Promise.reject(new Error('Government plan worker unavailable.'));
        }
        const requestId = ++planWorkerRequestSeq;
        return new Promise((resolve, reject) => {
            planWorkerPending.set(requestId, { resolve, reject });
            try {
                worker.postMessage(Object.assign({}, payload, { requestId }));
            } catch (err) {
                planWorkerPending.delete(requestId);
                reject(err);
            }
        });
    }

    function normalizeSyntheticToken(value, fallback = 'proposal') {
        const base = (value !== undefined && value !== null) ? String(value) : String(fallback || 'proposal');
        const sanitized = base.replace(/[^a-zA-Z0-9]+/g, '').toLowerCase();
        if (!sanitized) {
            return (fallback || 'proposal').replace(/[^a-zA-Z0-9]+/g, '').toLowerCase() || 'proposal';
        }
        const maxLength = 8;
        return sanitized.length <= maxLength ? sanitized : sanitized.slice(-maxLength);
    }

    function composeSyntheticParcelNumber(rootNumber, token, index) {
        const rawRoot = (rootNumber !== undefined && rootNumber !== null && String(rootNumber).trim().length)
            ? String(rootNumber).trim()
            : null;
        const safeRoot = rawRoot ? rawRoot.replace(/\s+/g, '') : null;
        const safeIndex = Number(index) || 1;
        return safeRoot ? `${safeRoot}/${token}/${safeIndex}` : `${token}/${safeIndex}`;
    }

    function composeSyntheticParcelId(rootParcelId, token, index) {
        const rawRoot = (rootParcelId !== undefined && rootParcelId !== null && String(rootParcelId).trim().length)
            ? String(rootParcelId).trim()
            : null;
        const safeRoot = rawRoot ? rawRoot.replace(/\s+/g, '') : null;
        const safeIndex = Number(index) || 1;
        return safeRoot ? `${safeRoot}_${token}_${safeIndex}` : `${token}_${safeIndex}`;
    }

    // Maintain the "remaining plan" geometry in memory
    // This is the original plan minus all applied road segments
    let remainingPlanGeometry = null;
    let remainingPlanHash = null;

    function rememberAutoApplyStats(stats) {
        if (!stats) {
            lastAutoApplyStats = null;
        } else {
            lastAutoApplyStats = Object.assign({}, stats);
        }
        if (typeof window !== 'undefined') {
            window.lastGovernmentPlanAutoApplyStats = lastAutoApplyStats;
        }
    }

    /**
     * Initialize or reset the remaining plan geometry from the cached plan collection.
     * This should be called when a new plan is loaded.
     */
    function initializeRemainingPlanGeometry() {
        if (!cachedPlanCollection || !Array.isArray(cachedPlanCollection.features) || !cachedPlanCollection.features.length) {
            remainingPlanGeometry = null;
            remainingPlanHash = null;
            return;
        }

        const planHash = computePlanGeometryHash(cachedPlanCollection);

        // If the plan hasn't changed, keep the current remaining geometry
        if (planHash && remainingPlanHash === planHash && remainingPlanGeometry) {
            return;
        }

        // New plan - start with the full geometry
        remainingPlanHash = planHash;
        remainingPlanGeometry = unionFeatures(cachedPlanCollection.features.filter(isPolygonGeometry));
    }

    /**
     * Subtract applied road geometry from the remaining plan.
     * This should be called immediately after applying a proposal.
     */
    function subtractFromRemainingPlan(appliedRoadFeatures) {
        if (!remainingPlanGeometry || !Array.isArray(appliedRoadFeatures) || !appliedRoadFeatures.length) {
            return;
        }

        if (typeof turf === 'undefined') {
            return;
        }

        try {
            // Union all the applied road features
            const appliedUnion = unionFeatures(appliedRoadFeatures);
            if (!appliedUnion) {
                return;
            }

            // Subtract from the remaining plan
            const diff = turf.difference(remainingPlanGeometry, appliedUnion);
            if (diff) {
                remainingPlanGeometry = diff;
            }
        } catch (err) {
            if (console && typeof console.debug === 'function') {
                console.debug('Failed to subtract applied roads from remaining plan:', err);
            }
        }
    }

    function removeAppliedSegmentsFromCachedPlan(appliedRoadFeatures) {
        if (!cachedPlanCollection || !Array.isArray(cachedPlanCollection.features) || !cachedPlanCollection.features.length) {
            return;
        }
        if (!Array.isArray(appliedRoadFeatures) || !appliedRoadFeatures.length) {
            return;
        }
        if (typeof turf === 'undefined') {
            return;
        }

        const appliedUnion = unionFeatures(appliedRoadFeatures);
        if (!appliedUnion) {
            return;
        }

        const trimmedFeatures = [];
        cachedPlanCollection.features.forEach(feature => {
            if (!feature || !isPolygonGeometry(feature)) {
                return;
            }
            try {
                const diff = turf.difference(feature, appliedUnion);
                if (!diff) {
                    return;
                }
                const diffPieces = normalizeFeatureLike(diff, feature.properties);
                if (diffPieces.length) {
                    diffPieces.forEach(piece => trimmedFeatures.push(piece));
                }
            } catch (err) {
                console.warn('Failed to subtract applied segments from government plan feature', err);
                trimmedFeatures.push(feature);
            }
        });

        cachedPlanCollection.features = trimmedFeatures;
        cachedPlanGeometryHash = computePlanGeometryHash(cachedPlanCollection);
        cachedPlanVertexCount = countVerticesInFeatureCollection(cachedPlanCollection);
        remainingPlanHash = null;
        initializeRemainingPlanGeometry();
        activePlanHashToken = cachedPlanGeometryHash || null;
    }

    /**
     * Get the current remaining plan geometry, clipped to the given bounds.
     * Returns only the portion of the plan that intersects with the current view.
     */
    function getRemainingPlanForView(bounds) {
        if (!remainingPlanGeometry) {
            return [];
        }

        if (typeof turf === 'undefined') {
            console.warn('Turf.js not available - cannot clip plan to view bounds');
            return [];
        }

        if (!bounds) {
            console.warn('No bounds provided - cannot clip plan to view');
            return [];
        }

        const mapPolygon = buildBoundsPolygon(bounds);
        if (!mapPolygon) {
            console.warn('Failed to build bounds polygon - cannot clip plan to view');
            return [];
        }

        try {
            const intersection = turf.intersect(remainingPlanGeometry, mapPolygon);
            if (!intersection) {
                return [];
            }
            return normalizeFeatureLike(intersection, remainingPlanGeometry.properties);
        } catch (err) {
            console.warn('Failed to clip remaining plan to view bounds:', err);
            return [];
        }
    }



    function areParcelsVisibleAtCurrentZoom() {
        try {
            if (typeof window.isZoomWithinParcelRange === 'function') {
                return !!window.isZoomWithinParcelRange();
            }
        } catch (_) { }
        return true;
    }

    // Applying the government road plan is expensive — restrict to the 4 most zoomed-in levels.
    function isZoomSuitableForGovernmentPlanApply() {
        try {
            if (typeof map === 'undefined' || !map || typeof map.getZoom !== 'function') return true;
            const z = map.getZoom();
            const maxZ = typeof map.getMaxZoom === 'function' ? map.getMaxZoom() : 19;
            return z >= maxZ - 3;
        } catch (_) { return true; }
    }



    function getActivePlanTargetParcelIds() {
        const ids = new Set();
        try {
            const multi = (typeof window !== 'undefined' && window.multiParcelSelection)
                ? window.multiParcelSelection
                : (typeof multiParcelSelection !== 'undefined' ? multiParcelSelection : null);
            if (multi && multi.isActive && multi.selectedParcels && multi.selectedParcels.size) {
                multi.selectedParcels.forEach(id => {
                    if (id !== undefined && id !== null) {
                        ids.add(id.toString());
                    }
                });
                return ids;
            }
        } catch (_) { }
        if (typeof window !== 'undefined' && window.selectedParcelId) {
            ids.add(window.selectedParcelId.toString());
        }
        return ids;
    }

    function extractPolygonOuterRings(geometry) {
        if (!geometry) return [];
        if (geometry.type === 'Polygon') {
            return Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0
                ? [geometry.coordinates[0]]
                : [];
        }
        if (geometry.type === 'MultiPolygon') {
            const rings = [];
            geometry.coordinates.forEach(poly => {
                if (Array.isArray(poly) && poly.length > 0) {
                    rings.push(poly[0]);
                }
            });
            return rings;
        }
        return [];
    }

    function extractPolygonsWithHoles(geometry) {
        if (!geometry) return [];
        if (geometry.type === 'Polygon') {
            const coords = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
            return coords.length ? [{ outer: coords[0], holes: coords.slice(1) }] : [];
        }
        if (geometry.type === 'MultiPolygon') {
            const polys = [];
            geometry.coordinates.forEach(poly => {
                if (Array.isArray(poly) && poly.length) {
                    polys.push({ outer: poly[0], holes: poly.slice(1) });
                }
            });
            return polys;
        }
        return [];
    }

    function mergeBboxes(bboxes) {
        if (!Array.isArray(bboxes) || !bboxes.length) {
            return null;
        }
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        bboxes.forEach(bbox => {
            if (!Array.isArray(bbox) || bbox.length !== 4) {
                return;
            }
            if (bbox[0] < minX) minX = bbox[0];
            if (bbox[1] < minY) minY = bbox[1];
            if (bbox[2] > maxX) maxX = bbox[2];
            if (bbox[3] > maxY) maxY = bbox[3];
        });
        if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
            return null;
        }
        return [minX, minY, maxX, maxY];
    }

    function filterPlanPiecesForTargets(planPieces, candidateParcels, stats) {
        if (!Array.isArray(planPieces) || !planPieces.length) {
            return [];
        }
        if (!Array.isArray(candidateParcels) || !candidateParcels.length) {
            return planPieces.slice();
        }
        const parcelBboxes = candidateParcels
            .map(item => (item && item.feature) ? computeFeatureBbox(item.feature) : null)
            .filter(Boolean);
        const targetBbox = mergeBboxes(parcelBboxes);
        if (!targetBbox) {
            return planPieces.slice();
        }
        const filtered = [];
        let filteredOut = 0;
        for (let index = 0; index < planPieces.length; index++) {
            const piece = planPieces[index];
            if (!piece) {
                continue;
            }
            const bbox = computeFeatureBbox(piece);
            if (!bbox || bboxesOverlap(bbox, targetBbox)) {
                filtered.push(piece);
            } else {
                filteredOut += 1;
            }
        }
        if (stats && typeof stats === 'object') {
            stats.planPiecesFiltered = filtered.length;
            stats.planPiecesFilteredOut = filteredOut;
        }
        return filtered;
    }

    function computePlanGeometryHash(collection) {
        if (!collection || !Array.isArray(collection.features) || collection.features.length === 0) {
            return null;
        }
        try {
            const hashes = [];
            collection.features.forEach(feature => {
                if (!isPolygonGeometry(feature)) return;
                const rings = extractPolygonOuterRings(feature.geometry);
                rings.forEach(ring => {
                    try {
                        const closed = Array.isArray(ring) ? _ensurePolygonIsClosed(ring) : null;
                        if (closed && closed.length > 3) {
                            hashes.push(_geometryHash([closed]));
                        }
                    } catch (_) { }
                });
            });
            hashes.sort();
            return hashes.join('|') || null;
        } catch (err) {
            console.warn('Failed to compute government plan geometry hash', err);
            return null;
        }
    }

    function countVerticesInGeometry(geometry) {
        if (!geometry || !geometry.type) {
            return 0;
        }
        const type = geometry.type;
        const coords = geometry.coordinates;
        if (!Array.isArray(coords)) {
            return 0;
        }
        if (type === 'Polygon') {
            return coords.reduce((total, ring) => {
                if (!Array.isArray(ring)) return total;
                return total + ring.length;
            }, 0);
        }
        if (type === 'MultiPolygon') {
            return coords.reduce((total, polygon) => {
                if (!Array.isArray(polygon)) return total;
                return total + polygon.reduce((polyTotal, ring) => {
                    if (!Array.isArray(ring)) return polyTotal;
                    return polyTotal + ring.length;
                }, 0);
            }, 0);
        }
        if (type === 'GeometryCollection' && Array.isArray(geometry.geometries)) {
            return geometry.geometries.reduce((total, geom) => total + countVerticesInGeometry(geom), 0);
        }
        return 0;
    }

    function countVerticesInFeature(feature) {
        if (!feature || !feature.geometry) {
            return 0;
        }
        return countVerticesInGeometry(feature.geometry);
    }

    function countVerticesInFeatureCollection(collection) {
        if (!collection || !Array.isArray(collection.features)) {
            return 0;
        }
        return collection.features.reduce((total, feature) => total + countVerticesInFeature(feature), 0);
    }

    function countVerticesInPieces(pieces) {
        if (!Array.isArray(pieces) || !pieces.length) {
            return 0;
        }
        const features = collectPlanPiecesAsFeatures(pieces);
        return features.reduce((total, feature) => total + countVerticesInFeature(feature), 0);
    }

    function normalizeParcelIdValue(value) {
        if (value === undefined || value === null) {
            return null;
        }
        try {
            return value.toString();
        } catch (err) {
            return String(value);
        }
    }

    function resolveParcelIdFromProps(props) {
        if (!props || typeof props !== 'object') return null;
        try {
            if (typeof ensureParcelId === 'function') {
                const ensured = ensureParcelId({ properties: props });
                const normalized = normalizeParcelIdValue(ensured);
                if (normalized) return normalized;
            }
        } catch (_) { }
        const candidate = props.parcelId
        return normalizeParcelIdValue(candidate);
    }

    function resolveParcelId(feature) {
        if (feature && typeof feature === 'object') {
            try {
                if (typeof ensureParcelId === 'function') {
                    const ensured = ensureParcelId(feature);
                    const normalized = normalizeParcelIdValue(ensured);
                    if (normalized) return normalized;
                }
            } catch (_) { }
            if (feature.properties) {
                const fromProps = resolveParcelIdFromProps(feature.properties);
                if (fromProps) return fromProps;
            }
        }
        return null;
    }

    function collectVisibleParcels(bounds, targetParcelIds) {
        if (!window.parcelLayer || typeof window.parcelLayer.eachLayer !== 'function') {
            return { parcels: [], hasMore: false };
        }

        const viewBounds = bounds || getActiveMapBounds();
        const totalLayerCount = (typeof window.parcelLayer.getLayers === 'function')
            ? window.parcelLayer.getLayers().length
            : 0;

        let candidateLayers = [];
        if (viewBounds && typeof window.getParcelLayersWithinBounds === 'function') {
            try {
                const result = window.getParcelLayersWithinBounds(viewBounds);
                if (Array.isArray(result)) {
                    candidateLayers = result;
                }
            } catch (_) { }
        }

        if (!Array.isArray(candidateLayers) || !candidateLayers.length) {
            // Fallback: only use full scan if parcel count is reasonable
            // This should rarely happen now that getParcelLayersWithinBounds exists
            if (totalLayerCount < 1000) {
                window.parcelLayer.eachLayer(layer => {
                    if (layer) {
                        candidateLayers.push(layer);
                    }
                });
                candidateLayers._source = 'full-scan';
            } else {
                // Too many parcels - return empty rather than scanning all
                console.warn('[collectVisibleParcels] Too many parcels and getParcelLayersWithinBounds unavailable, returning empty');
                candidateLayers = [];
                candidateLayers._source = 'skipped-too-many';
            }
        }

        const layerSource = (candidateLayers && candidateLayers._source) ? candidateLayers._source : 'full-scan';

        const seenLayers = new Set();
        const uniqueLayers = [];
        candidateLayers.forEach(layer => {
            if (layer && !seenLayers.has(layer)) {
                seenLayers.add(layer);
                uniqueLayers.push(layer);
            }
        });

        const targetIds = (targetParcelIds && targetParcelIds.size)
            ? new Set(Array.from(targetParcelIds).map(id => normalizeParcelIdValue(id)).filter(Boolean))
            : null;

        const parcels = [];
        let outsideBounds = 0;
        let skippedRoads = 0;
        let skippedTargets = 0;

        uniqueLayers.forEach(layer => {
            if (!layer) {
                return;
            }

            if (viewBounds && typeof layer.getBounds === 'function') {
                try {
                    const layerBounds = layer.getBounds();
                    if (!layerBounds || !layerBounds.isValid || !layerBounds.isValid() || !layerBounds.intersects(viewBounds)) {
                        outsideBounds++;
                        return;
                    }
                } catch (_) { }
            }

            const featureRef = layer.feature || (typeof layer.toGeoJSON === 'function' ? layer.toGeoJSON() : null);
            if (!featureRef) {
                return;
            }

            const parcelId = resolveParcelId(featureRef);
            if (!parcelId) {
                return;
            }

            if (targetIds && !targetIds.has(parcelId)) {
                skippedTargets++;
                return;
            }

            if (featureRef?.properties?.isRoad && featureRef?.properties?.proposalSource === 'government_plan') {
                skippedRoads++;
                return;
            }

            parcels.push({
                parcelId,
                feature: cloneFeatureSafely(featureRef),
                layer
            });
        });

        console.log(`[collectVisibleParcels] Total layers: ${totalLayerCount}, Considered: ${uniqueLayers.length}, Collected: ${parcels.length}, Outside bounds: ${outsideBounds}, Skipped roads: ${skippedRoads}, Skipped targets: ${skippedTargets}, Source: ${layerSource}`);

        return { parcels, hasMore: false, source: layerSource };
    }
    function isParcelMergeInProgress() {
        try {
            if (typeof window !== 'undefined') {
                if (typeof window.isParcelMergeInProgress === 'function') {
                    return !!window.isParcelMergeInProgress();
                }
                if (typeof window.parcelMergeInProgress !== 'undefined') {
                    return !!window.parcelMergeInProgress;
                }
            }
        } catch (_) { }
        return false;
    }


    function getNowMs() {
        if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
            return performance.now();
        }
        return Date.now();
    }

    async function yieldToAutoApply() {
        // Give the browser more breathing room by using multiple yields
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
            // Use rAF to ensure UI can update
            await new Promise(resolve => window.requestAnimationFrame(() => resolve()));
            // Add a small delay to let events process
            await new Promise(resolve => setTimeout(resolve, 10));
            return;
        }
        // Fallback: longer timeout for better responsiveness
        await new Promise(resolve => setTimeout(resolve, 20));
    }

    function logAutoApplyStats(stats) {
        if (!stats) {
            return;
        }
        rememberAutoApplyStats(stats);
        const payload = Object.assign({ timestamp: new Date().toISOString() }, stats);
        try {
            console.info('[GovernmentPlan] auto-apply stats', payload);
        } catch (_) {
            console.log('[GovernmentPlan] auto-apply stats', payload);
        }
    }

    function reportAutoApplyOutcome(stats) {
        if (!stats || typeof window === 'undefined' || typeof window.updateStatus !== 'function') {
            return;
        }
        const hasSelection = Number(stats.selectionTargets || 0) > 0;
        const treatAsSelection = hasSelection;
        const messageByResult = {
            applied: 'Road plan applied to current map view.',
            'filtered-no-new': 'Road plan applied to current map view.',
            'no-build': 'Road plan applied to current map view.',
            'selection-not-visible': treatAsSelection
                ? 'Selected parcels are outside the current view or already aligned with the government plan.'
                : 'Government road plan already matches the current map view.',
            'selection-already-road': 'Selected parcels already match the government road plan.',
            'no-visible-parcels': 'No parcels available in the current map view for the government plan.',
            'no-plan-pieces-for-selection': 'Government road plan has no coverage in the current map view.',
            'skipped-merge-in-progress': 'Waiting for parcel data merge to finish before applying the government road plan.'
        };
        const message = messageByResult[stats.result];
        if (message) {
            window.updateStatus(message);
        }
    }


    function getProposalManager() {
        if (typeof ProposalManager !== 'undefined' && ProposalManager) {
            return ProposalManager;
        }
        if (typeof window !== 'undefined' && window.ProposalManager) {
            return window.ProposalManager;
        }
        return null;
    }

    function normalizeProposalForStorage(proposal) {
        if (!proposal) {
            return proposal;
        }
        if (typeof proposalStorage !== 'undefined' && typeof proposalStorage._normalizeProposal === 'function') {
            return proposalStorage._normalizeProposal({ ...proposal });
        }
        return proposal;
    }

    function updateProposalFromBuild(storedProposal, build) {
        if (!storedProposal || !build || !build.roadProposal) {
            return null;
        }

        // Replace core proposal fields with the current batch (canonical schema)
        storedProposal.parentParcelIds = build.proposalData.parentParcelIds || [];
        storedProposal.childParcelIds = build.proposalData.childParcelIds || [];
        storedProposal.geometry = Object.assign({}, storedProposal.geometry || {}, {
            roadPlan: build.proposalData.geometry?.roadPlan || build.roadProposal?.definition || null,
            roadGeometry: build.proposalData.geometry?.roadGeometry || build.roadProposal?.roadGeometry || null
        });

        // Keep minimal roadProposal for metadata/status only (no embedded features)
        storedProposal.roadProposal = Object.assign({}, build.roadProposal || {}, {
            parentParcelIds: storedProposal.parentParcelIds.slice(),
            childParcelIds: storedProposal.childParcelIds.slice(),
            parentFeatures: undefined,
            childFeatures: undefined
        });
        delete storedProposal.roadProposal.parentFeatures;
        delete storedProposal.roadProposal.childFeatures;

        // Update tags, preserving governmentPlan markers
        storedProposal.tags = Object.assign({}, storedProposal.tags || {}, build.proposalData.tags || {});

        // Update counts
        storedProposal.segmentCount = build.segmentCount
            ?? build.roadProposal?.segmentCount
            ?? 0;
        storedProposal.parcelCount = storedProposal.parentParcelIds.length;
        storedProposal.updatedAt = new Date().toISOString();

        return storedProposal;
    }

    async function applyGovernmentPlanIncrement(proposalId, storedProposal, mergeResult, planHash) {
        const manager = getProposalManager();
        if (!manager || typeof manager.applyProposal !== 'function') {
            return { applied: false, reason: 'manager-unavailable' };
        }

        const { aggregated, newParentFeatures, newChildFeatures, newParentsToRemove } = mergeResult;
        if (!aggregated || !newChildFeatures.length) {
            return { applied: false, reason: 'no-new-features' };
        }

        const originalSnapshot = cloneFeatureSafely(storedProposal);
        const aggregatedSnapshot = cloneFeatureSafely(aggregated);

        const batchProposal = cloneFeatureSafely(storedProposal);
        batchProposal.parentParcelIds = Array.isArray(aggregatedSnapshot.parentParcelIds)
            ? aggregatedSnapshot.parentParcelIds.slice()
            : [];
        batchProposal.tags = Object.assign({}, aggregatedSnapshot.tags || {});
        batchProposal.status = 'Active';
        batchProposal.updatedAt = new Date().toISOString();
        const parentIdsFromBatch = newParentFeatures
            .map(feature => resolveParcelId(feature))
            .filter(Boolean)
            .map(id => id.toString());
        const parentsToRemove = Array.isArray(newParentsToRemove) && newParentsToRemove.length
            ? newParentsToRemove
            : (parentIdsFromBatch.length
                ? parentIdsFromBatch
                : (Array.isArray(aggregatedSnapshot.roadProposal?.parentsToRemove)
                    ? aggregatedSnapshot.roadProposal.parentsToRemove.map(id => id && id.toString ? id.toString() : String(id))
                    : []));

        batchProposal.roadProposal = Object.assign({}, batchProposal.roadProposal || {}, {
            status: 'unapplied',
            planDescriptor: aggregatedSnapshot.roadProposal?.planDescriptor,
            planSource: aggregatedSnapshot.roadProposal?.planSource,
            planHash: aggregatedSnapshot.roadProposal?.planHash || planHash,
            parentsToRemove,
            parentParcelIds: batchProposal.parentParcelIds.slice(),
            childParcelIds: Array.isArray(aggregatedSnapshot.childParcelIds) ? aggregatedSnapshot.childParcelIds.slice() : [],
            segmentCount: aggregatedSnapshot.roadProposal?.segmentCount || aggregatedSnapshot.segmentCount || 0
        });
        batchProposal.geometry = Object.assign({}, batchProposal.geometry || {}, {
            roadPlan: aggregatedSnapshot.geometry?.roadPlan || aggregatedSnapshot.roadProposal?.definition || null,
            roadGeometry: aggregatedSnapshot.geometry?.roadGeometry || aggregatedSnapshot.roadProposal?.roadGeometry || null
        });

        const normalizedBatch = normalizeProposalForStorage(batchProposal) || batchProposal;
        normalizedBatch.proposalId = storedProposal.proposalId || proposalId;
        normalizedBatch.createdAt = storedProposal.createdAt;

        if (typeof proposalStorage._indexProposal === 'function') {
            proposalStorage._indexProposal(normalizedBatch);
        }
        proposalStorage.save();

        const applied = await manager.applyProposal(proposalId);
        if (!applied) {
            if (typeof proposalStorage._indexProposal === 'function') {
                proposalStorage._indexProposal(originalSnapshot);
            }
            proposalStorage.save();
            return { applied: false, reason: 'apply-failed' };
        }

        const normalizedAggregated = normalizeProposalForStorage(aggregatedSnapshot) || aggregatedSnapshot;
        normalizedAggregated.proposalId = proposalId;
        normalizedAggregated.createdAt = storedProposal.createdAt;
        const nextStatus = (typeof PROPOSAL_STATUS_APPLIED !== 'undefined') ? PROPOSAL_STATUS_APPLIED : 'Applied';
        normalizedAggregated.status = nextStatus;
        normalizedAggregated.updatedAt = new Date().toISOString();
        if (normalizedAggregated.roadProposal) {
            normalizedAggregated.roadProposal.status = 'applied';
        }

        if (typeof proposalStorage._indexProposal === 'function') {
            proposalStorage._indexProposal(normalizedAggregated);
        }
        proposalStorage.save();

        if (typeof updateProposalLayer === 'function') {
            try { updateProposalLayer(); } catch (_) { }
        }
        if (typeof updateProposalList === 'function') {
            try { updateProposalList(); } catch (_) { }
        }

        return { applied: true, aggregated: normalizedAggregated };
    }

    async function upsertGovernmentPlanProposalFromBuild(build, context) {
        if (typeof proposalStorage === 'undefined' || typeof proposalStorage.addProposal !== 'function') {
            return { applied: false, reason: 'storage-unavailable' };
        }

        const planHash = context?.planHash || null;
        const newSegmentHashes = Array.isArray(context?.newSegmentHashes) ? context.newSegmentHashes : [];

        // Always create a fresh proposal for each application batch.
        // This prevents issues where updating an existing proposal causes
        // parent parcels to be removed without having their complete child replacements.
        // The remainingPlanGeometry mechanism handles incremental application.
        const proposalId = proposalStorage.addProposal(build.proposalData);
        if (!proposalId) {
            return { applied: false, reason: 'add-failed' };
        }
        governmentPlanProposalId = proposalId;

        const manager = getProposalManager();
        if (!manager || typeof manager.applyProposal !== 'function') {
            return { applied: false, reason: 'manager-unavailable', proposalId };
        }
        const applied = await manager.applyProposal(proposalId);
        if (!applied) {
            return { applied: false, reason: 'apply-failed', proposalId };
        }
        return { applied: true, proposalId, aggregated: proposalStorage.getProposal(proposalId), newSegmentHashes };
    }

    async function performAutoApply(options) {
        const opts = Object.assign({ reason: null, force: false, ignoreZoomGuard: false, maxCandidateParcels: undefined, ignoreSelection: false }, options || {});
        const stats = {
            reason: opts.reason || 'auto',
            force: !!opts.force,
            ignoreZoomGuard: !!opts.ignoreZoomGuard,
            result: 'pending',
            planPieces: 0,
            candidateParcels: 0,
            impactedParcels: 0,
            intersectionsFound: 0,
            roadSegments: 0,
            remainderSegments: 0,
            newSegments: 0,
            batchHasMore: false,
            candidateSource: null,
            selectionTargets: 0,
            selectionVisible: 0,
            selectionMissing: 0,
            selectionAlreadyRoad: 0,
            selectionFallback: null
        };
        lastPlanComputationMode = 'not-run';
        const startTime = getNowMs();

        const useSelection = !opts.ignoreSelection;
        const targetParcelIds = useSelection ? getActivePlanTargetParcelIds() : new Set();
        stats.selectionTargets = targetParcelIds.size;
        let hasSelection = useSelection && targetParcelIds.size > 0;
        if (opts.requireSelection && !hasSelection) {
            stats.result = 'skipped-no-selection';
            stats.durationMs = Math.round(getNowMs() - startTime);
            logAutoApplyStats(stats);
            if (opts.reason === 'manual-invoke' && typeof window !== 'undefined' && typeof window.updateStatus === 'function') {
                window.updateStatus('Select parcels before applying the government road plan.');
            }
            return false;
        }

        if (isApplyingGovernmentPlan) {
            stats.result = 'skipped-in-progress';
            stats.durationMs = Math.round(getNowMs() - startTime);
            logAutoApplyStats(stats);
            return false;
        }

        if (!isZoomSuitableForGovernmentPlanApply()) {
            stats.result = 'skipped-zoom';
            stats.durationMs = Math.round(getNowMs() - startTime);
            logAutoApplyStats(stats);
            if (typeof window !== 'undefined' && typeof window.updateStatus === 'function') {
                window.updateStatus('Zoom in further to apply the government road plan.');
            }
            return false;
        }

        if (isParcelMergeInProgress()) {
            lastPlanComputationMode = 'merge-wait';
            stats.result = 'skipped-merge-in-progress';
            stats.mergeInProgress = true;
            stats.durationMs = Math.round(getNowMs() - startTime);
            logAutoApplyStats(stats);
            if (opts.reason === 'manual-invoke' && typeof window !== 'undefined' && typeof window.updateStatus === 'function') {
                window.updateStatus('Waiting for parcel merge to complete before applying the government road plan…');
            }
            return false;
        }

        if (isFetchingGovernmentPlan) {
            stats.result = 'waiting-fetch';
            stats.durationMs = Math.round(getNowMs() - startTime);
            logAutoApplyStats(stats);
            if (opts.reason === 'manual-invoke' && typeof window !== 'undefined' && typeof window.updateStatus === 'function') {
                window.updateStatus('Government road plan is still loading. Try again in a moment.');
            }
            return false;
        }

        isApplyingGovernmentPlan = true;
        try {

            if (!cachedPlanCollection || !Array.isArray(cachedPlanCollection.features) || !cachedPlanCollection.features.length) {
                await drawGovernmentRoadPlan({ skipStatus: true });
            }

            if (!cachedPlanCollection || !Array.isArray(cachedPlanCollection.features) || !cachedPlanCollection.features.length) {
                stats.result = 'no-plan-data';
                stats.durationMs = Math.round(getNowMs() - startTime);
                logAutoApplyStats(stats);
                return false;
            }

            const bounds = getActiveMapBounds();
            if (!bounds) {
                stats.result = 'no-bounds';
                stats.durationMs = Math.round(getNowMs() - startTime);
                logAutoApplyStats(stats);
                return false;
            }

            const planPiecesStart = getNowMs();
            const planPreparation = preparePlanPiecesForAutoApply(bounds);
            const planPieces = planPreparation.planPieces;
            const planPiecesSource = planPreparation.source;
            stats.planPiecesSource = planPiecesSource;
            stats.planPiecesMs = Math.round(getNowMs() - planPiecesStart);
            if (!Array.isArray(planPieces) || !planPieces.length) {
                stats.planPieces = Array.isArray(planPieces) ? planPieces.length : 0;
                stats.result = 'no-plan-pieces';
                return false;
            }
            stats.planPieces = planPieces.length;

            const planVerticesUsed = countVerticesInPieces(planPieces);
            stats.planVerticesUsed = planVerticesUsed;
            if (typeof window !== 'undefined' && typeof window.updateStatus === 'function') {
                const suffix = lastPlanDescriptor ? ` (${lastPlanDescriptor})` : '';
                const vertexLabel = planVerticesUsed === 1 ? 'vertex' : 'vertices';
                window.updateStatus(`Preparing government plan${suffix}: ${planVerticesUsed} plan ${vertexLabel}…`);
            }

            // No need to compute hash anymore - we track geometry directly
            let planHash = remainingPlanHash || null;
            if (!planHash && Array.isArray(planPieces) && planPieces.length) {
                try {
                    const collectionHash = computePlanGeometryHash({ type: 'FeatureCollection', features: planPieces });
                    planHash = collectionHash || planPiecesHash || null;
                    if (collectionHash) {
                        cachedPlanGeometryHash = collectionHash;
                    }
                } catch (_) {
                    planHash = planPiecesHash || null;
                }
            }
            if (!planHash && planPiecesHash) {
                planHash = planPiecesHash;
            }
            if (planHash) {
                activePlanHashToken = planHash;
            }
            stats.planHash = planHash || null;
            stats.planDescriptor = lastPlanDescriptor || null;
            stats.planSource = cachedPlanSource || null;

            stats.maxCandidateLimit = 'viewport';

            const collectStart = getNowMs();
            const visibleBatch = collectVisibleParcels(bounds, targetParcelIds);
            stats.collectVisibleMs = Math.round(getNowMs() - collectStart);
            if (hasSelection && visibleBatch && Array.isArray(visibleBatch.targetRoads) && visibleBatch.targetRoads.length) {
                stats.selectionAlreadyRoad = visibleBatch.targetRoads.length;
            }
            let candidateParcels = Array.isArray(visibleBatch.parcels) ? visibleBatch.parcels : [];
            const batchHasMore = visibleBatch.hasMore;
            stats.batchHasMore = !!batchHasMore;
            if (visibleBatch && typeof visibleBatch.source === 'string') {
                stats.candidateSource = visibleBatch.source;
            }

            console.log(`[performAutoApply] candidateParcels: ${candidateParcels.length}, hasSelection: ${hasSelection}, targetParcelIds: ${targetParcelIds.size}`);

            let selectionMatches = hasSelection
                ? candidateParcels.filter(item => item && targetParcelIds.has(item.parcelId))
                : candidateParcels;

            console.log(`[performAutoApply] selectionMatches: ${selectionMatches.length}`);

            if (hasSelection) {
                const matchedIds = new Set(selectionMatches.map(item => item.parcelId));
                const missingTargets = [];
                targetParcelIds.forEach(id => {
                    if (!matchedIds.has(id)) {
                        missingTargets.push(id);
                    }
                });
                stats.selectionVisible = selectionMatches.length;
                stats.selectionMissing = missingTargets.length;
            }
            stats.candidateParcels = selectionMatches.length;

            if (hasSelection && !selectionMatches.length) {
                const fallbackBatch = collectVisibleParcels(bounds, null);
                const fallbackParcels = Array.isArray(fallbackBatch.parcels) ? fallbackBatch.parcels : [];
                if (fallbackParcels.length) {
                    const fallbackMatches = fallbackParcels.filter(item => item && targetParcelIds.has(item.parcelId));
                    if (fallbackMatches.length) {
                        candidateParcels = fallbackParcels;
                        selectionMatches = fallbackMatches;
                        stats.selectionVisible = fallbackMatches.length;
                        stats.selectionMissing = Math.max(0, targetParcelIds.size - fallbackMatches.length);
                        stats.candidateParcels = fallbackMatches.length;
                        stats.selectionFallback = 'bounds-relaxed';
                    } else {
                        candidateParcels = fallbackParcels;
                        selectionMatches = fallbackParcels;
                        stats.selectionVisible = 0;
                        stats.selectionMissing = targetParcelIds.size;
                        stats.candidateParcels = fallbackParcels.length;
                        stats.selectionFallback = 'viewport';
                        hasSelection = false;
                        if (opts.reason === 'manual-invoke' && typeof window !== 'undefined' && typeof window.updateStatus === 'function') {
                            window.updateStatus('Selected parcels were not found in the current view. Applying the government plan to visible parcels instead.');
                        }
                    }
                }
            }

            if (!selectionMatches.length) {
                if (hasSelection && stats.selectionAlreadyRoad && stats.selectionAlreadyRoad === stats.selectionTargets) {
                    stats.result = 'selection-already-road';
                } else {
                    stats.result = hasSelection ? 'selection-not-visible' : 'no-visible-parcels';
                }
                if (opts.reason === 'manual-invoke' && typeof window !== 'undefined' && typeof window.updateStatus === 'function') {
                    if (stats.result === 'selection-already-road') {
                        window.updateStatus('Selected parcels already match the government road plan.');
                    } else if (hasSelection) {
                        window.updateStatus('Selected parcels are outside the view or already aligned with the government road plan.');
                    } else {
                        window.updateStatus('No parcels available in the current view.');
                    }
                }
                return false;
            }

            const targetPlanPieces = filterPlanPiecesForTargets(planPieces, selectionMatches, stats);
            if (!Array.isArray(targetPlanPieces) || !targetPlanPieces.length) {
                stats.result = 'no-plan-pieces-for-selection';
                if (opts.reason === 'manual-invoke' && typeof window !== 'undefined' && typeof window.updateStatus === 'function') {
                    window.updateStatus('Government road plan has no geometry overlapping the parcels in view.');
                }
                return false;
            }
            stats.planVerticesFiltered = countVerticesInPieces(targetPlanPieces);

            if (typeof window !== 'undefined' && typeof window.updateStatus === 'function') {
                const suffix = lastPlanDescriptor ? ` (${lastPlanDescriptor})` : '';
                const targetLabel = hasSelection
                    ? `${selectionMatches.length} selected parcel${selectionMatches.length === 1 ? '' : 's'}`
                    : `${selectionMatches.length} parcels in view`;
                const pieceCountLabel = (stats.planPiecesFiltered !== undefined)
                    ? `${stats.planPiecesFiltered} plan piece${stats.planPiecesFiltered === 1 ? '' : 's'}`
                    : `${stats.planPieces} plan piece${stats.planPieces === 1 ? '' : 's'}`;
                const vertexCount = (stats.planVerticesFiltered !== undefined)
                    ? stats.planVerticesFiltered
                    : stats.planVerticesUsed;
                const vertexLabelFiltered = vertexCount === 1 ? 'vertex' : 'vertices';
                window.updateStatus(`Applying government plan${suffix}: ${targetLabel}, ${pieceCountLabel}, ${vertexCount} plan ${vertexLabelFiltered}…`);
            }

            const planPolygon = unionFeatures(targetPlanPieces);
            if (!planPolygon) {
                stats.result = 'no-plan-polygon';
                return false;
            }

            const buildStart = getNowMs();
            const build = await buildGovernmentPlanProposalData(planPolygon, {
                descriptor: lastPlanDescriptor,
                source: cachedPlanSource,
                planHash,
                candidateParcels: selectionMatches,
                stats
            });
            stats.buildMs = Math.round(getNowMs() - buildStart);
            if (!build) {
                stats.result = 'no-build';
                return false;
            }

            if (build.stats && build.stats !== stats) {
                Object.assign(stats, build.stats);
            }

            const roadSegmentCount = Number.isFinite(build.segmentCount) ? build.segmentCount : 0;
            const hasChildFeatureData = Array.isArray(build.childFeatures) || Array.isArray(build.roadProposal?.childFeatures);
            const buildChildFeatures = Array.isArray(build.childFeatures)
                ? build.childFeatures
                : (Array.isArray(build.roadProposal?.childFeatures) ? build.roadProposal.childFeatures : []);
            const appliedRoadFeatures = hasChildFeatureData
                ? buildChildFeatures.filter(f => f?.properties?.isRoad)
                : [];

            stats.roadSegments = roadSegmentCount;
            stats.newSegments = hasChildFeatureData ? appliedRoadFeatures.length : roadSegmentCount;
            if (hasChildFeatureData) {
                stats.remainderSegments = buildChildFeatures.length - roadSegmentCount;
            }

            const upsertStart = getNowMs();
            const upsertResult = await upsertGovernmentPlanProposalFromBuild(build, {
                planHash,
                descriptor: lastPlanDescriptor,
                source: cachedPlanSource
            });
            stats.upsertMs = Math.round(getNowMs() - upsertStart);

            if (upsertResult && upsertResult.applied) {
                stats.result = 'applied';
                stats.appliedProposalId = upsertResult.proposalId || null;
                lastSuccessfulApplyTime = Date.now();

                // Subtract the applied road segments from the remaining plan geometry
                if (appliedRoadFeatures.length) {
                    subtractFromRemainingPlan(appliedRoadFeatures);
                    removeAppliedSegmentsFromCachedPlan(appliedRoadFeatures);

                    // Immediately re-render the plan overlay so applied segments disappear at parcel zoom levels
                    renderGovernmentPlanForView({ skipStatus: true });
                }

                return Object.assign({ planHash }, upsertResult);
            }

            if (upsertResult) {
                stats.result = upsertResult.reason || 'apply-failed';
            } else {
                stats.result = 'apply-failed';
            }

            return upsertResult || null;
        } finally {
            isApplyingGovernmentPlan = false;
            if (stats.durationMs === undefined) {
                stats.durationMs = Math.round(getNowMs() - startTime);
            }
            const modeLabel = lastPlanComputationMode || 'unknown';
            const outcome = stats.result || 'unknown';
            const success = outcome === 'applied';
            console.log(`[GovernmentPlan] auto-apply ${success ? 'completed' : 'finished'} (mode: ${modeLabel}, result: ${outcome}).`, {
                durationMs: stats.durationMs,
                impactedParcels: stats.impactedParcels,
                roadSegments: stats.roadSegments,
                remainderSegments: stats.remainderSegments
            });
            logAutoApplyStats(stats);
            reportAutoApplyOutcome(stats);
        }
    }

    function collectPlanPiecesAsFeatures(pieces) {
        if (!Array.isArray(pieces)) return [];
        return pieces.map(piece => {
            if (!piece) return null;
            if (piece.type === 'Feature') {
                return piece;
            }
            if (piece.geometry) {
                return { type: 'Feature', geometry: piece.geometry, properties: Object.assign({}, piece.properties || {}) };
            }
            return null;
        }).filter(Boolean);
    }

    function computeFeatureBbox(feature) {
        if (!feature || typeof turf === 'undefined') {
            return null;
        }
        try {
            return turf.bbox(feature);
        } catch (_) {
            return null;
        }
    }

    function bboxesOverlap(a, b) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 4 || b.length !== 4) {
            return true;
        }
        return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
    }

    function subtractAppliedSegmentsFromPieces(pieces, appliedUnion, stats) {
        if (!Array.isArray(pieces) || !pieces.length) {
            return pieces || [];
        }
        if (!appliedUnion || typeof turf === 'undefined') {
            return pieces;
        }

        const unionBbox = computeFeatureBbox(appliedUnion);
        const trimmed = [];
        let processed = 0;
        const start = getNowMs();

        pieces.forEach(piece => {
            if (!piece) {
                return;
            }
            processed += 1;
            const pieceBbox = computeFeatureBbox(piece);
            if (pieceBbox && unionBbox && !bboxesOverlap(pieceBbox, unionBbox)) {
                trimmed.push(piece);
                return;
            }
            try {
                const diff = turf.difference(piece, appliedUnion);
                if (!diff) {
                    return;
                }
                const diffPieces = normalizeFeatureLike(diff, piece.properties);
                if (diffPieces.length) {
                    diffPieces.forEach(resultPiece => trimmed.push(resultPiece));
                    return;
                }
            } catch (err) {
                console.warn('Failed to subtract applied road union from plan piece.', err);
            }
            trimmed.push(piece);
        });

        if (stats && typeof stats === 'object') {
            stats.appliedCullProcessedPieces = processed;
            stats.appliedCullRemainingPieces = trimmed.length;
            stats.appliedCullMs = Math.round(getNowMs() - start);
        }

        return trimmed;
    }

    async function collectImpactedParcels(pieces, candidateParcels, stats) {
        const statsTarget = (stats && typeof stats === 'object') ? stats : null;
        const featureEntries = [];

        if (Array.isArray(pieces)) {
            for (let index = 0; index < pieces.length; index++) {
                const item = pieces[index];
                if (!item) {
                    continue;
                }
                if (item.feature && item.feature.geometry) {
                    featureEntries.push({
                        feature: item.feature,
                        bbox: item.bbox !== undefined ? item.bbox : computeFeatureBbox(item.feature)
                    });
                } else {
                    const normalized = collectPlanPiecesAsFeatures([item]);
                    normalized.forEach(feature => {
                        featureEntries.push({ feature, bbox: computeFeatureBbox(feature) });
                    });
                }
                if ((index + 1) % 25 === 0) {
                    await yieldToAutoApply();
                }
            }
        }

        if (!featureEntries.length) {
            if (statsTarget) {
                statsTarget.impactedParcels = 0;
            }
            return [];
        }

        const impacted = [];
        const hasCandidates = Array.isArray(candidateParcels) && candidateParcels.length > 0;

        if (statsTarget && hasCandidates) {
            statsTarget.candidateParcels = candidateParcels.length;
        }

        if (hasCandidates) {
            for (let idx = 0; idx < candidateParcels.length; idx++) {
                const candidate = candidateParcels[idx];
                if (!candidate) {
                    continue;
                }
                const feature = candidate.feature ? cloneFeatureSafely(candidate.feature) : cloneFeatureSafely(candidate);
                if (!isPolygonGeometry(feature)) {
                    continue;
                }
                const candidateBbox = computeFeatureBbox(feature);
                let intersects = false;
                for (const entry of featureEntries) {
                    const piece = entry.feature;
                    if (!piece) continue;
                    if (candidateBbox && entry.bbox && !bboxesOverlap(candidateBbox, entry.bbox)) {
                        if (statsTarget) {
                            statsTarget.booleanBBoxSkips = (statsTarget.booleanBBoxSkips || 0) + 1;
                        }
                        continue;
                    }
                    try {
                        if (statsTarget) {
                            statsTarget.booleanChecks = (statsTarget.booleanChecks || 0) + 1;
                        }
                        if (turf.booleanIntersects(feature, piece)) {
                            intersects = true;
                            if (statsTarget) {
                                statsTarget.booleanHits = (statsTarget.booleanHits || 0) + 1;
                            }
                            break;
                        }
                    } catch (_) { }
                }
                if (intersects) {
                    const canonicalParcelId = resolveParcelId(feature) || normalizeParcelIdValue(candidate.parcelId);
                    impacted.push({
                        feature,
                        layer: candidate.layer || null,
                        parcelId: canonicalParcelId
                    });
                }
                if ((idx + 1) % 10 === 0) {
                    await yieldToAutoApply();
                }
            }
            if (statsTarget) {
                statsTarget.impactedParcels = impacted.length;
            }
            return impacted;
        }

        if (!window.parcelLayer || typeof window.parcelLayer.eachLayer !== 'function') {
            if (statsTarget) {
                statsTarget.impactedParcels = impacted.length;
            }
            return impacted;
        }

        const layers = [];
        window.parcelLayer.eachLayer(layer => {
            if (layer) {
                layers.push(layer);
            }
        });

        for (let idx = 0; idx < layers.length; idx++) {
            const layer = layers[idx];
            if (!layer || typeof layer.toGeoJSON !== 'function') continue;
            const feature = layer.toGeoJSON();
            if (!isPolygonGeometry(feature)) continue;
            const candidateBbox = computeFeatureBbox(feature);
            let intersects = false;
            for (const entry of featureEntries) {
                const piece = entry.feature;
                if (!piece) continue;
                if (candidateBbox && entry.bbox && !bboxesOverlap(candidateBbox, entry.bbox)) {
                    if (statsTarget) {
                        statsTarget.booleanBBoxSkips = (statsTarget.booleanBBoxSkips || 0) + 1;
                    }
                    continue;
                }
                try {
                    if (statsTarget) {
                        statsTarget.booleanChecks = (statsTarget.booleanChecks || 0) + 1;
                    }
                    if (turf.booleanIntersects(feature, piece)) {
                        intersects = true;
                        if (statsTarget) {
                            statsTarget.booleanHits = (statsTarget.booleanHits || 0) + 1;
                        }
                        break;
                    }
                } catch (_) { }
            }
            if (intersects) {
                impacted.push({
                    feature: cloneFeatureSafely(feature),
                    layer
                });
            }
            if ((idx + 1) % 10 === 0) {
                await yieldToAutoApply();
            }
        }
        if (statsTarget) {
            statsTarget.impactedParcels = impacted.length;
        }
        return impacted;
    }

    function findExistingGovernmentPlanProposal(planHash) {
        if (!planHash || typeof proposalStorage === 'undefined' || typeof proposalStorage.getAllProposals !== 'function') {
            return null;
        }
        try {
            const all = proposalStorage.getAllProposals();
            return all.find(proposal => proposal && proposal.tags && proposal.tags.governmentPlanHash === planHash) || null;
        } catch (err) {
            console.warn('Failed to search for existing government plan proposal', err);
            return null;
        }
    }

    async function buildGovernmentPlanProposalDataSync(planPolygon, options) {
        lastPlanComputationMode = 'main-thread';
        const descriptor = options?.descriptor || null;
        const source = options?.source || null;
        const planHash = options?.planHash || null;
        const candidateParcels = Array.isArray(options?.candidateParcels) ? options.candidateParcels : [];
        const statsTarget = (options && typeof options.stats === 'object') ? options.stats : {};

        console.log(`[buildGovernmentPlanProposalData] candidateParcels: ${candidateParcels.length}, planPolygon exists: ${!!planPolygon}`);

        if (!planPolygon || !candidateParcels.length) {
            statsTarget.impactedParcels = 0;
            statsTarget.intersectionsFound = 0;
            statsTarget.roadSegments = 0;
            statsTarget.remainderSegments = 0;
            console.log(`[buildGovernmentPlanProposalData] Early return: no planPolygon or no candidates`);
            return null;
        }

        const impactedParcels = [];
        const planBbox = computeFeatureBbox(planPolygon);

        for (let i = 0; i < candidateParcels.length; i++) {
            const candidate = candidateParcels[i];
            const parcelFeature = candidate.feature;
            if (!isPolygonGeometry(parcelFeature)) continue;

            const parcelBbox = computeFeatureBbox(parcelFeature);
            if (planBbox && parcelBbox && !bboxesOverlap(planBbox, parcelBbox)) {
                if (statsTarget) statsTarget.booleanBBoxSkips = (statsTarget.booleanBBoxSkips || 0) + 1;
                continue;
            }

            try {
                if (statsTarget) statsTarget.booleanChecks = (statsTarget.booleanChecks || 0) + 1;
                if (turf.booleanIntersects(parcelFeature, planPolygon)) {
                    if (statsTarget) statsTarget.booleanHits = (statsTarget.booleanHits || 0) + 1;
                    impactedParcels.push(candidate);
                }
            } catch (err) {
                console.warn('Error checking parcel intersection with plan polygon', err);
            }
            if ((i + 1) % 25 === 0) await yieldToAutoApply();
        }

        statsTarget.impactedParcels = impactedParcels.length;

        console.log(`[buildGovernmentPlanProposalData] impactedParcels: ${impactedParcels.length}, bboxSkips: ${statsTarget.booleanBBoxSkips || 0}, booleanChecks: ${statsTarget.booleanChecks || 0}, booleanHits: ${statsTarget.booleanHits || 0}`);

        if (!impactedParcels.length) {
            statsTarget.intersectionsFound = 0;
            statsTarget.roadSegments = 0;
            statsTarget.remainderSegments = 0;
            return null;
        }

        const allocatorState = new Map();
        const parentFeatures = impactedParcels.map(item => cloneFeatureSafely(item.feature));
        const childFeatures = [];
        const parentsToRemoveSet = new Set();
        const parentIdsSet = new Set();
        const parentNumbersSet = new Set();
        let intersectionsFoundCount = 0;
        let roadSegmentsCount = 0;

        const proposalId = `gov_plan_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const proposalToken = normalizeSyntheticToken(proposalId, 'govplan');
        const roadName = descriptor || 'Government Road Plan';

        function getRootInfo(feature) {
            const props = feature?.properties || {};
            const parcelId = resolveParcelId(feature);
            const parcelNumber = props.BROJ_CESTICE ? String(props.BROJ_CESTICE) : '';
            const rootNumber = props.rootParcelNumber || _extractRootParcelNumber(parcelNumber);
            const rootParcelId = props.rootParcelId || _extractRootParcelId(parcelId || '');
            return { rootNumber, rootParcelId };
        }

        function getNextIdentity(rootNumber, rootParcelId) {
            if (!rootNumber || !rootParcelId) return null;
            const key = `${rootNumber || ''}__${rootParcelId || ''}`;
            let state = allocatorState.get(key);
            if (!state) {
                state = { baseId: rootParcelId, nextIndex: 1 };
                allocatorState.set(key, state);
            }
            const current = state.nextIndex++;
            return {
                parcelNumber: composeSyntheticParcelNumber(rootNumber, proposalToken, current),
                parcelId: composeSyntheticParcelId(state.baseId, proposalToken, current),
                subNumber: current
            };
        }

        const parentIdsList = impactedParcels
            .map(item => resolveParcelId(item.feature))
            .filter(Boolean)
            .map(String);
        const parentNumbersList = impactedParcels.map(item => item.feature?.properties?.BROJ_CESTICE).filter(Boolean).map(String);

        for (let parcelIndex = 0; parcelIndex < impactedParcels.length; parcelIndex++) {
            const item = impactedParcels[parcelIndex];
            const originalFeature = item.feature;

            // Yield every 3 parcels for better UI responsiveness
            if ((parcelIndex + 1) % 3 === 0) {
                await yieldToAutoApply();
            }

            // Show progress for long operations
            if ((parcelIndex + 1) % 5 === 0 && typeof window !== 'undefined' && typeof window.updateStatus === 'function') {
                const progress = Math.round(((parcelIndex + 1) / impactedParcels.length) * 100);
                window.updateStatus(`Processing parcels: ${parcelIndex + 1}/${impactedParcels.length} (${progress}%)…`);
            }

            if (!originalFeature || !isPolygonGeometry(originalFeature)) {
                continue;
            }

            const originalProps = originalFeature.properties || {};
            const parcelRoadFeatures = [];
            const parcelRemainderFeatures = [];
            const parcelId = resolveParcelId(originalFeature);
            if (parcelId) parentIdsSet.add(parcelId);
            if (originalProps.BROJ_CESTICE) parentNumbersSet.add(originalProps.BROJ_CESTICE.toString());

            const rootInfo = getRootInfo(originalFeature);
            let parcelGeometry;
            let parcelArea = 0;
            try {
                parcelGeometry = turf.feature(originalFeature.geometry);
                parcelArea = turf.area(parcelGeometry);
            } catch (err) {
                console.warn('Failed to process original parcel geometry', err, originalFeature);
                continue;
            }

            let intersection;
            try {
                intersection = turf.intersect(parcelGeometry, planPolygon);
                if (intersection && intersection.geometry && extractPolygonsWithHoles(intersection.geometry).length) {
                    intersectionsFoundCount++;
                } else {
                    intersection = null;
                }
            } catch (err) {
                intersection = null;
                if (console && typeof console.debug === 'function') {
                    console.debug('Failed to intersect government plan piece with parcel', err);
                }
            }

            if (!intersection) {
                if ((parcelIndex + 1) % 5 === 0) await yieldToAutoApply();
                continue;
            }

            const roadPolygons = extractPolygonsWithHoles(intersection.geometry);
            const parentIsRoad = originalProps.isRoad === true || originalProps.isRoad === 'true';
            let roadAreaForParcel = 0;

            for (let rpIndex = 0; rpIndex < roadPolygons.length; rpIndex++) {
                const poly = roadPolygons[rpIndex];
                const outer = poly?.outer || poly;
                const closedOuter = _ensurePolygonIsClosed(outer);
                if (!closedOuter || closedOuter.length < 4) continue;

                const closedHoles = (Array.isArray(poly?.holes) ? poly.holes : [])
                    .map(hole => _ensurePolygonIsClosed(hole))
                    .filter(ring => Array.isArray(ring) && ring.length >= 4);
                const coords = [closedOuter, ...closedHoles];

                const area = turf.area(turf.polygon(coords));
                if (!Number.isFinite(area) || area <= 0.01) continue;
                roadAreaForParcel += area;

                const identity = getNextIdentity(rootInfo.rootNumber, rootInfo.rootParcelId);
                const allocatedParcelId = identity ? identity.parcelId : `${parcelId || 'road'}_${Date.now()}`;
                const allocatedParcelNumber = identity ? identity.parcelNumber : `${originalProps.BROJ_CESTICE || 'road'}/${Date.now()}`;
                const roadProperties = {
                    parcelId: allocatedParcelId,
                    BROJ_CESTICE: allocatedParcelNumber,
                    isRoad: true,
                    calculatedArea: area,
                    roadName,
                    isProposed: true,
                    proposalId,
                    proposalSource: 'government_plan',
                    parentParcelId: parcelId,
                    parentParcelNumber: originalProps.BROJ_CESTICE || null,
                    parentParcelIds: parentIdsList.slice(),
                    parentParcelNumbers: parentNumbersList.slice(),
                    rootParcelNumber: rootInfo.rootNumber,
                    rootParcelId: rootInfo.rootParcelId,
                    planDescriptor: descriptor,
                    planSource: source,
                    governmentPlanHash: planHash,
                    ownershipDetails: {
                        owners: [{
                            name: 'Government Plan',
                            ownerLabel: 'Government Plan',
                            percentageShare: 100,
                            actualShareText: '100%'
                        }]
                    }
                };

                parcelRoadFeatures.push({
                    type: 'Feature',
                    properties: roadProperties,
                    geometry: { type: 'Polygon', coordinates: coords }
                });
                if ((rpIndex + 1) % 10 === 0) await yieldToAutoApply();
            }

            let remainder;
            try {
                remainder = turf.difference(parcelGeometry, intersection);
                if (statsTarget) statsTarget.differenceAttempts = (statsTarget.differenceAttempts || 0) + 1;
            } catch (err) {
                console.warn('Failed to compute remainder geometry', err);
                if (statsTarget) statsTarget.differenceFailed = (statsTarget.differenceFailed || 0) + 1;
            }

            let remainderStatus = 'difference-success';
            if (!remainder || !remainder.geometry) {
                if (statsTarget) statsTarget.differenceNull = (statsTarget.differenceNull || 0) + 1;
                remainderStatus = 'difference-null';
            }

            const remainderPolygons = remainder ? extractPolygonsWithHoles(remainder.geometry) : [];
            if (!remainderPolygons.length) {
                if (statsTarget) statsTarget.differenceEmpty = (statsTarget.differenceEmpty || 0) + 1;
                if (remainderStatus !== 'difference-null') {
                    remainderStatus = 'difference-empty';
                }
            } else if (statsTarget) {
                statsTarget.differenceSuccess = (statsTarget.differenceSuccess || 0) + 1;
            }

            const uniquePolygons = new Map();
            for (let remIndex = 0; remIndex < remainderPolygons.length; remIndex++) {
                const poly = remainderPolygons[remIndex];
                const outer = poly?.outer || poly;
                const closedOuter = _ensurePolygonIsClosed(outer);
                if (!closedOuter || closedOuter.length < 4) continue;
                const closedHoles = (Array.isArray(poly?.holes) ? poly.holes : [])
                    .map(hole => _ensurePolygonIsClosed(hole))
                    .filter(ring => Array.isArray(ring) && ring.length >= 4);
                const coords = [closedOuter, ...closedHoles];
                try {
                    const hash = _geometryHash(coords);
                    const area = turf.area(turf.polygon(coords));
                    if (!Number.isFinite(area) || area <= 0.01) continue;
                    uniquePolygons.set(hash, { coords, area });
                } catch (_) { }
                if ((remIndex + 1) % 10 === 0) await yieldToAutoApply();
            }

            const polygonsWithArea = Array.from(uniquePolygons.values()).sort((a, b) => b.area - a.area);
            for (let partIndex = 0; partIndex < polygonsWithArea.length; partIndex++) {
                const part = polygonsWithArea[partIndex];
                const identity = getNextIdentity(rootInfo.rootNumber, rootInfo.rootParcelId);
                const allocatedParcelId = identity ? identity.parcelId : `${parcelId || 'parcel'}_${Date.now()}`;
                const allocatedParcelNumber = identity ? identity.parcelNumber : `${originalProps.BROJ_CESTICE || 'parcel'}/${Date.now()}`;
                const newProperties = { ...originalProps };
                newProperties.parcelId = allocatedParcelId;
                newProperties.BROJ_CESTICE = allocatedParcelNumber;
                newProperties.calculatedArea = part.area;
                newProperties.parentParcelId = parcelId;
                newProperties.parentParcelNumber = originalProps.BROJ_CESTICE || null;
                newProperties.rootParcelNumber = rootInfo.rootNumber;
                newProperties.rootParcelId = rootInfo.rootParcelId;
                newProperties.proposalId = proposalId;
                newProperties.proposalSource = 'government_plan';
                newProperties.isRoad = parentIsRoad;
                delete newProperties.roadName;
                delete newProperties.roadId;

                parcelRemainderFeatures.push({
                    type: 'Feature',
                    properties: newProperties,
                    geometry: { type: 'Polygon', coordinates: part.coords }
                });
                if ((partIndex + 1) % 10 === 0) await yieldToAutoApply();
            }

            if (parcelId) {
                const fullyCovered = Number.isFinite(parcelArea) && parcelArea > 0 && roadAreaForParcel >= parcelArea * 0.95;
                const remainderAdded = parcelRemainderFeatures.length > 0;
                if (remainderAdded || fullyCovered) {
                    parentsToRemoveSet.add(parcelId.toString());
                    if (fullyCovered && statsTarget) {
                        statsTarget.parentsFullyCovered = (statsTarget.parentsFullyCovered || 0) + 1;
                    }
                } else {
                    if (statsTarget) statsTarget.parentsKeptDueToRemainderFailure = (statsTarget.parentsKeptDueToRemainderFailure || 0) + 1;
                    console.warn('Skipping removal of parent parcel because remainder geometry was unavailable', {
                        parcelId,
                        parcelArea,
                        roadAreaForParcel,
                        remainderAdded,
                        remainderPolygons: remainderPolygons.length,
                        remainderStatus
                    });
                }

                if (remainderAdded || fullyCovered) {
                    const parcelRoadCount = parcelRoadFeatures.length;
                    if (parcelRoadCount) {
                        parcelRoadFeatures.forEach(feature => childFeatures.push(feature));
                        roadSegmentsCount += parcelRoadCount;
                    }
                    parcelRemainderFeatures.forEach(feature => childFeatures.push(feature));
                } else {
                    if (parcelRoadFeatures.length || parcelRemainderFeatures.length) {
                        console.warn('Discarded generated government plan features because parent parcel remains intact', {
                            parcelId,
                            roadPieces: parcelRoadFeatures.length,
                            remainderPieces: parcelRemainderFeatures.length
                        });
                    }
                }
            }

            // Yield handled at top of loop for consistency
        }

        if (typeof window !== 'undefined' && typeof window.updateStatus === 'function') {
            const totalProcessed = impactedParcels.length;
            window.updateStatus(`Processing parcels: ${totalProcessed}/${totalProcessed} (100%)`);
        }

        if (!childFeatures.length) {
            statsTarget.intersectionsFound = intersectionsFoundCount;
            statsTarget.roadSegments = 0;
            statsTarget.remainderSegments = 0;
            statsTarget.parentParcelsTouched = parentIdsSet.size;
            return null;
        }

        const parcelIds = Array.from(parentIdsSet);
        const title = descriptor ? `Government Plan · ${descriptor}` : 'Government Road Plan';
        const description = descriptor ? `Government road plan segments from ${descriptor}` : 'Government road plan segments.';

        const roadProposal = {
            id: proposalId,
            definition: { kind: 'government_plan', descriptor, source, planHash, isCorridor: true },
            parentParcelIds: parcelIds.slice(),
            childParcelIds: [],
            status: 'unapplied',
            planDescriptor: descriptor,
            planSource: source,
            planHash,
            parentsToRemove: Array.from(parentsToRemoveSet),
            segmentCount: roadSegmentsCount,
            isCorridor: true
        };

        const proposalData = {
            type: 'road',
            title,
            author: 'Government Plan',
            description,
            parentParcelIds: parcelIds.slice(),
            childParcelIds: [],
            childFeatures,
            geometry: {
                roadPlan: roadProposal.definition,
                roadGeometry: null
            },
            roadProposal,
            isCorridor: true,
            tags: {
                governmentPlan: true,
                governmentPlanHash: planHash,
                planDescriptor: descriptor,
                planSource: source
            },
            segmentCount: roadSegmentsCount,
            parcelCount: parcelIds.length
        };

        statsTarget.intersectionsFound = intersectionsFoundCount;
        statsTarget.roadSegments = roadSegmentsCount;
        statsTarget.remainderSegments = Math.max(0, childFeatures.length - roadSegmentsCount);
        statsTarget.parentParcelsTouched = parcelIds.length;

        return {
            proposalData,
            roadProposal,
            parcelCount: parcelIds.length,
            segmentCount: roadSegmentsCount,
            childFeatures,
            stats: statsTarget
        };
    }

    async function buildGovernmentPlanProposalDataWithWorker(planPolygon, options) {
        const descriptor = options?.descriptor || null;
        const source = options?.source || null;
        const planHash = options?.planHash || null;
        const candidateParcels = Array.isArray(options?.candidateParcels) ? options.candidateParcels : [];
        const statsTarget = (options && typeof options.stats === 'object') ? options.stats : {};

        if (!planPolygon || !candidateParcels.length) {
            statsTarget.impactedParcels = 0;
            statsTarget.intersectionsFound = 0;
            statsTarget.roadSegments = 0;
            statsTarget.remainderSegments = 0;
            return null;
        }

        const parcelsForWorker = [];
        const featureMap = new Map();
        candidateParcels.forEach(item => {
            const feature = item && item.feature ? item.feature : null;
            if (!feature || !isPolygonGeometry(feature)) {
                return;
            }
            const props = feature.properties || {};
            const parcelId = resolveParcelId(feature);
            if (!parcelId) {
                return;
            }
            const idString = parcelId.toString();
            featureMap.set(idString, cloneFeatureSafely(feature));
            parcelsForWorker.push({
                id: idString,
                number: props.BROJ_CESTICE !== undefined && props.BROJ_CESTICE !== null ? props.BROJ_CESTICE.toString() : null,
                isRoad: props.isRoad,
                geometry: JSON.parse(JSON.stringify(feature.geometry))
            });
        });

        if (!parcelsForWorker.length) {
            statsTarget.impactedParcels = 0;
            statsTarget.intersectionsFound = 0;
            statsTarget.roadSegments = 0;
            statsTarget.remainderSegments = 0;
            return null;
        }

        const workerPayload = {
            type: 'process-plan',
            planPolygon: cloneFeatureSafely(planPolygon),
            parcels: parcelsForWorker
        };

        const workerResult = await invokePlanWorker(workerPayload);
        lastPlanComputationMode = 'worker';
        const workerStats = workerResult && workerResult.stats ? workerResult.stats : {};

        if (statsTarget) {
            statsTarget.booleanBBoxSkips = workerStats.booleanBBoxSkips || 0;
            statsTarget.booleanChecks = workerStats.booleanChecks || 0;
            statsTarget.booleanHits = workerStats.booleanHits || 0;
            statsTarget.differenceAttempts = workerStats.differenceAttempts || 0;
            statsTarget.differenceSuccess = workerStats.differenceSuccess || 0;
            statsTarget.differenceFailed = workerStats.differenceFailed || 0;
            statsTarget.differenceNull = workerStats.differenceNull || 0;
            statsTarget.differenceEmpty = workerStats.differenceEmpty || 0;
        }

        const processedParcels = Array.isArray(workerResult?.parcels)
            ? workerResult.parcels.filter(entry => Array.isArray(entry?.roadPieces) && entry.roadPieces.length)
            : [];

        statsTarget.impactedParcels = processedParcels.length;

        if (!processedParcels.length) {
            statsTarget.intersectionsFound = 0;
            statsTarget.roadSegments = 0;
            statsTarget.remainderSegments = 0;
            return null;
        }

        const allocatorState = new Map();
        const parentFeatures = [];
        const childFeatures = [];
        const parentsToRemoveSet = new Set();
        const parentIdsSet = new Set();
        const parentNumbersSet = new Set();
        let intersectionsFoundCount = 0;
        let roadSegmentsCount = 0;

        const proposalId = `gov_plan_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const proposalToken = normalizeSyntheticToken(proposalId, 'govplan');
        const roadName = descriptor || 'Government Road Plan';

        function getRootInfo(feature) {
            const props = feature?.properties || {};
            const parcelNumber = props.BROJ_CESTICE ? String(props.BROJ_CESTICE) : '';
            const parcelId = resolveParcelId(feature) || '';
            const rootNumber = props.rootParcelNumber || _extractRootParcelNumber(parcelNumber);
            const rootParcelId = props.rootParcelId || _extractRootParcelId(parcelId);
            return { rootNumber, rootParcelId };
        }

        function getNextIdentity(rootNumber, rootParcelId) {
            if (!rootNumber || !rootParcelId) return null;
            const key = `${rootNumber || ''}__${rootParcelId || ''}`;
            let state = allocatorState.get(key);
            if (!state) {
                state = { baseId: rootParcelId, nextIndex: 1 };
                allocatorState.set(key, state);
            }
            const current = state.nextIndex++;
            return {
                parcelNumber: composeSyntheticParcelNumber(rootNumber, proposalToken, current),
                parcelId: composeSyntheticParcelId(state.baseId, proposalToken, current),
                subNumber: current
            };
        }

        const parentIdsList = processedParcels
            .map(item => normalizeParcelIdValue(item.parcelId ?? item.parcel_id ?? item.id))
            .filter(Boolean)
            .map(String);
        const parentNumbersList = processedParcels
            .map(item => item.parcelNumber)
            .filter(number => number !== undefined && number !== null)
            .map(number => number.toString());

        for (let parcelIndex = 0; parcelIndex < processedParcels.length; parcelIndex++) {
            const entry = processedParcels[parcelIndex];
            const parcelId = entry.parcelId ? entry.parcelId.toString() : null;
            const originalFeature = parcelId ? featureMap.get(parcelId) : null;
            if (!originalFeature) {
                continue;
            }

            if ((parcelIndex + 1) % 3 === 0) {
                await yieldToAutoApply();
            }
            if ((parcelIndex + 1) % 5 === 0 && typeof window !== 'undefined' && typeof window.updateStatus === 'function') {
                const progress = Math.round(((parcelIndex + 1) / processedParcels.length) * 100);
                window.updateStatus(`Worker Processing parcels: ${parcelIndex + 1}/${processedParcels.length} (${progress}%)…`);
            }

            parentFeatures.push(cloneFeatureSafely(originalFeature));

            const originalProps = originalFeature.properties || {};
            const parentIsRoad = originalProps.isRoad === true || originalProps.isRoad === 'true';
            const rootInfo = getRootInfo(originalFeature);
            if (parcelId) parentIdsSet.add(parcelId);
            if (entry.parcelNumber) parentNumbersSet.add(entry.parcelNumber.toString());

            const parcelRoadFeatures = [];
            const parcelRemainderFeatures = [];

            const normalizePolygonRings = (rawCoords) => {
                if (!Array.isArray(rawCoords) || !rawCoords.length) return null;

                // Array of rings
                if (Array.isArray(rawCoords[0]) && Array.isArray(rawCoords[0][0])) {
                    const rings = rawCoords
                        .map(ring => _ensurePolygonIsClosed(ring))
                        .filter(ring => Array.isArray(ring) && ring.length >= 4);
                    return rings.length ? rings : null;
                }

                // Single ring
                if (Array.isArray(rawCoords[0]) && typeof rawCoords[0][0] === 'number') {
                    const closed = _ensurePolygonIsClosed(rawCoords);
                    return (closed && closed.length >= 4) ? [closed] : null;
                }

                return null;
            };

            const roadPieces = Array.isArray(entry.roadPieces) ? entry.roadPieces : [];
            const remainderPieces = Array.isArray(entry.remainderPieces) ? entry.remainderPieces : [];

            if (roadPieces.length) {
                intersectionsFoundCount++;
            }

            roadPieces.forEach(piece => {
                const coords = normalizePolygonRings(piece?.coords);
                const areaValue = Number(piece?.area);
                const area = Number.isFinite(areaValue) && areaValue > 0
                    ? areaValue
                    : (coords ? turf.area(turf.polygon(coords)) : NaN);
                if (!coords || !Number.isFinite(area) || area <= 0) {
                    return;
                }
                const identity = getNextIdentity(rootInfo.rootNumber, rootInfo.rootParcelId);
                const allocatedParcelId = identity ? identity.parcelId : `${parcelId || 'road'}_${Date.now()}`;
                const allocatedParcelNumber = identity ? identity.parcelNumber : `${originalProps.BROJ_CESTICE || 'road'}/${Date.now()}`;
                const roadProperties = {
                    parcelId: allocatedParcelId,
                    BROJ_CESTICE: allocatedParcelNumber,
                    isRoad: true,
                    calculatedArea: area,
                    roadName,
                    isProposed: true,
                    proposalId,
                    proposalSource: 'government_plan',
                    parentParcelId: parcelId,
                    parentParcelNumber: originalProps.BROJ_CESTICE || null,
                    parentParcelIds: parentIdsList.slice(),
                    parentParcelNumbers: parentNumbersList.slice(),
                    rootParcelNumber: rootInfo.rootNumber,
                    rootParcelId: rootInfo.rootParcelId,
                    planDescriptor: descriptor,
                    planSource: source,
                    governmentPlanHash: planHash,
                    ownershipDetails: {
                        owners: [{
                            name: 'Government Plan',
                            ownerLabel: 'Government Plan',
                            percentageShare: 100,
                            actualShareText: '100%'
                        }]
                    }
                };
                parcelRoadFeatures.push({
                    type: 'Feature',
                    properties: roadProperties,
                    geometry: { type: 'Polygon', coordinates: coords }
                });
            });

            remainderPieces.forEach(piece => {
                const coords = normalizePolygonRings(piece?.coords);
                const areaValue = Number(piece?.area);
                const area = Number.isFinite(areaValue) && areaValue > 0
                    ? areaValue
                    : (coords ? turf.area(turf.polygon(coords)) : NaN);
                if (!coords || !Number.isFinite(area) || area <= 0) {
                    return;
                }
                const identity = getNextIdentity(rootInfo.rootNumber, rootInfo.rootParcelId);
                const allocatedParcelId = identity ? identity.parcelId : `${parcelId || 'parcel'}_${Date.now()}`;
                const allocatedParcelNumber = identity ? identity.parcelNumber : `${originalProps.BROJ_CESTICE || 'parcel'}/${Date.now()}`;
                const newProperties = { ...originalProps };
                newProperties.parcelId = allocatedParcelId;
                newProperties.BROJ_CESTICE = allocatedParcelNumber;
                newProperties.calculatedArea = area;
                newProperties.parentParcelId = parcelId;
                newProperties.parentParcelNumber = originalProps.BROJ_CESTICE || null;
                newProperties.rootParcelNumber = rootInfo.rootNumber;
                newProperties.rootParcelId = rootInfo.rootParcelId;
                newProperties.proposalId = proposalId;
                newProperties.proposalSource = 'government_plan';
                newProperties.isRoad = parentIsRoad;
                delete newProperties.roadName;
                delete newProperties.roadId;

                parcelRemainderFeatures.push({
                    type: 'Feature',
                    properties: newProperties,
                    geometry: { type: 'Polygon', coordinates: coords }
                });
            });

            const fullyCovered = Number.isFinite(entry.coverageRatio) && entry.coverageRatio >= 0.95;
            const remainderAdded = parcelRemainderFeatures.length > 0;

            if (remainderAdded || fullyCovered) {
                if (parcelId) {
                    parentsToRemoveSet.add(parcelId);
                }
                if (fullyCovered && statsTarget) {
                    statsTarget.parentsFullyCovered = (statsTarget.parentsFullyCovered || 0) + 1;
                }
                if (parcelRoadFeatures.length) {
                    parcelRoadFeatures.forEach(feature => childFeatures.push(feature));
                    roadSegmentsCount += parcelRoadFeatures.length;
                }
                parcelRemainderFeatures.forEach(feature => childFeatures.push(feature));
            } else {
                if (statsTarget) {
                    statsTarget.parentsKeptDueToRemainderFailure = (statsTarget.parentsKeptDueToRemainderFailure || 0) + 1;
                }
                console.warn('Skipping removal of parent parcel because remainder geometry was unavailable', {
                    parcelId,
                    parcelArea: entry.parcelArea,
                    roadAreaForParcel: entry.roadArea,
                    remainderAdded,
                    remainderPolygons: entry.remainderPolygonCount || 0,
                    remainderStatus: entry.remainderStatus
                });
                if (parcelRoadFeatures.length || parcelRemainderFeatures.length) {
                    console.warn('Discarded generated government plan features because parent parcel remains intact', {
                        parcelId,
                        roadPieces: parcelRoadFeatures.length,
                        remainderPieces: parcelRemainderFeatures.length
                    });
                }
            }
        }

        if (!childFeatures.length) {
            statsTarget.intersectionsFound = intersectionsFoundCount;
            statsTarget.roadSegments = 0;
            statsTarget.remainderSegments = 0;
            statsTarget.parentParcelsTouched = parentIdsSet.size;
            return null;
        }

        const parcelIds = Array.from(parentIdsSet);
        const title = descriptor ? `Government Plan · ${descriptor}` : 'Government Road Plan';
        const description = descriptor ? `Government road plan segments from ${descriptor}` : 'Government road plan segments.';

        const roadProposal = {
            id: proposalId,
            definition: { kind: 'government_plan', descriptor, source, planHash, isCorridor: true },
            parentParcelIds: parcelIds.slice(),
            childParcelIds: [],
            status: 'unapplied',
            planDescriptor: descriptor,
            planSource: source,
            planHash,
            parentsToRemove: Array.from(parentsToRemoveSet),
            segmentCount: roadSegmentsCount,
            isCorridor: true
        };

        const proposalData = {
            type: 'road',
            title,
            author: 'Government Plan',
            description,
            parentParcelIds: parcelIds.slice(),
            childParcelIds: [],
            childFeatures,
            geometry: {
                roadPlan: roadProposal.definition,
                roadGeometry: null
            },
            roadProposal,
            isCorridor: true,
            tags: {
                governmentPlan: true,
                governmentPlanHash: planHash,
                planDescriptor: descriptor,
                planSource: source
            },
            segmentCount: roadSegmentsCount,
            parcelCount: parcelIds.length
        };

        statsTarget.intersectionsFound = intersectionsFoundCount;
        statsTarget.roadSegments = roadSegmentsCount;
        statsTarget.remainderSegments = Math.max(0, childFeatures.length - roadSegmentsCount);
        statsTarget.parentParcelsTouched = parcelIds.length;

        return {
            proposalData,
            roadProposal,
            parcelCount: parcelIds.length,
            segmentCount: roadSegmentsCount,
            childFeatures,
            stats: statsTarget
        };
    }

    async function buildGovernmentPlanProposalData(planPolygon, options) {
        const worker = ensurePlanWorker();
        if (worker) {
            try {
                const result = await buildGovernmentPlanProposalDataWithWorker(planPolygon, options);
                if (result) {
                    return result;
                }
            } catch (err) {
                console.warn('Government plan worker failed, falling back to main thread processing.', err);
                lastPlanComputationMode = 'main-thread';
                terminatePlanWorker();
            }
        }
        if (planWorkerDisabledReason) {
            console.warn('[GovernmentPlan] Using main-thread plan processing:', planWorkerDisabledReason);
        }
        lastPlanComputationMode = 'main-thread';
        return buildGovernmentPlanProposalDataSync(planPolygon, options);
    }

    async function ensureGovernmentPlanProposal(pieces, options) {
        if (typeof proposalStorage === 'undefined' || typeof proposalStorage.addProposal !== 'function') {
            return null;
        }

        const planHash = options?.planHash || null;
        const descriptor = options?.descriptor || null;
        const source = options?.source || null;

        const existing = planHash ? findExistingGovernmentPlanProposal(planHash) : null;

        if (existing && existing.roadProposal && existing.roadProposal.status === 'applied') {
            governmentPlanProposalId = existing.proposalId;
            return {
                proposalId: existing.proposalId,
                proposalData: existing,
                parcelCount: Array.isArray(existing.parentParcelIds) ? existing.parentParcelIds.length : 0,
                segmentCount: existing.roadProposal?.segmentCount || existing.segmentCount || 0,
                wasExisting: true,
                isApplied: true
            };
        }

        const planPolygon = unionFeatures(pieces);
        if (!planPolygon) return null;

        const build = await buildGovernmentPlanProposalData(planPolygon, {
            descriptor,
            source,
            planHash,
            candidateParcels: options.candidateParcels || []
        });
        if (!build || !build.proposalData) {
            return null;
        }

        if (existing) {
            try {
                const merged = Object.assign({}, existing, build.proposalData, { proposalId: existing.proposalId });
                merged.tags = Object.assign({}, existing.tags || {}, build.proposalData.tags || {});
                merged.updatedAt = new Date().toISOString();
                merged.status = existing.status === 'Applied' ? 'Applied' : 'Active';
                if (existing.roadProposal && existing.roadProposal.status === 'applied') {
                    merged.roadProposal = Object.assign({}, existing.roadProposal, { status: 'applied' });
                } else {
                    merged.roadProposal = Object.assign({}, build.roadProposal, { status: 'unapplied' });
                }
                if (typeof proposalStorage._normalizeProposal === 'function') {
                    const normalized = proposalStorage._normalizeProposal(merged);
                    normalized.proposalId = existing.proposalId;
                    normalized.updatedAt = new Date().toISOString();
                    normalized.status = merged.status;
                    normalized.roadProposal.status = merged.roadProposal.status;
                    if (typeof proposalStorage._indexProposal === 'function') {
                        proposalStorage._indexProposal(normalized);
                    } else {
                        proposalStorage.proposals.set(normalized.proposalId, normalized);
                    }
                } else {
                    if (typeof proposalStorage._indexProposal === 'function') {
                        proposalStorage._indexProposal(merged);
                    } else {
                        proposalStorage.proposals.set(existing.proposalId, merged);
                    }
                }
                proposalStorage.save();
                governmentPlanProposalId = existing.proposalId;
                return {
                    proposalId: existing.proposalId,
                    proposalData: proposalStorage.getProposal(existing.proposalId) || merged,
                    parcelCount: build.parcelCount,
                    segmentCount: build.segmentCount,
                    wasExisting: true,
                    isApplied: merged.roadProposal.status === 'applied'
                };
            } catch (err) {
                console.warn('Failed to update existing government plan proposal', err);
            }
        }

        const proposalId = proposalStorage.addProposal(build.proposalData);
        if (!proposalId) {
            return null;
        }
        governmentPlanProposalId = proposalId;
        return {
            proposalId,
            proposalData: proposalStorage.getProposal(proposalId),
            parcelCount: build.parcelCount,
            segmentCount: build.segmentCount,
            wasExisting: false,
            isApplied: false
        };
    }

    const basePlanStyle = {
        color: '#c98a00',
        weight: 2,
        fillColor: '#ffd54f',
        fillOpacity: 0.35,
        opacity: 0.9,
        dashArray: '6 6',
        interactive: false
    };

    const highlightPlanStyle = {
        color: '#1c54b2',
        weight: 2,
        fillColor: '#4f83ff',
        fillOpacity: 0.6,
        opacity: 0.95,
        dashArray: '',
        interactive: false
    };

    const planCatalogState = {
        promise: null
    };
    const planGeoCache = new Map();

    function ensureMapReady() {
        if (typeof window === 'undefined' || typeof window.map === 'undefined' || !window.map) {
            throw new Error('Map is not initialized yet.');
        }
    }

    function initialiseGovernmentPlanProposalState() {
        if (typeof proposalStorage === 'undefined' || typeof proposalStorage.getAllProposals !== 'function') {
            return;
        }
        try {
            const all = proposalStorage.getAllProposals();
            const existing = all.find(proposal => proposal && proposal.tags && proposal.tags.governmentPlan);
            if (existing) {
                governmentPlanProposalId = existing.proposalId;
                if (!cachedPlanGeometryHash) {
                    cachedPlanGeometryHash = existing.tags?.governmentPlanHash || null;
                }
            }
        } catch (err) {
            console.warn('Failed to initialise government plan proposal state', err);
        }
    }

    function getActiveMapBounds() {
        if (!window.map || typeof window.map.getBounds !== 'function') {
            return null;
        }

        // // Check if sidebar is visible and adjust bounds to exclude it
        // const sidebar = document.getElementById('sidebar');
        // const isSidebarVisible = sidebar && !sidebar.classList.contains('collapsed');

        // if (isSidebarVisible && typeof window.map.getSize === 'function' &&
        //     typeof window.map.containerPointToLatLng === 'function') {
        //     try {
        //         const mapSize = window.map.getSize();
        //         const sidebarWidth = 320; // From index.css #sidebar width

        //         // Get bounds excluding the sidebar area
        //         const topLeft = window.map.containerPointToLatLng([sidebarWidth, 0]);
        //         const bottomRight = window.map.containerPointToLatLng([mapSize.x, mapSize.y]);

        //         const adjustedBounds = L.latLngBounds(topLeft, bottomRight);
        //         console.log(`[getActiveMapBounds] Adjusted for sidebar. Map size: ${mapSize.x}x${mapSize.y}, Visible: ${mapSize.x - sidebarWidth}x${mapSize.y}`);
        //         return adjustedBounds;
        //     } catch (err) {
        //         console.warn('Failed to calculate visible bounds, falling back to full map bounds:', err);
        //     }
        // }

        return window.map.getBounds();
    }

    function getBboxFromBounds(bounds) {
        if (!bounds || typeof window.getBboxFromBounds !== 'function') {
            return '';
        }
        try {
            return window.getBboxFromBounds(bounds);
        } catch (err) {
            console.warn('Failed to obtain bbox from bounds.', err);
            return '';
        }
    }

    function buildBoundsPolygon(bounds) {
        if (!bounds || typeof turf === 'undefined') {
            return null;
        }
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        const nw = bounds.getNorthWest();
        const se = bounds.getSouthEast();
        return turf.polygon([[
            [sw.lng, sw.lat],
            [se.lng, se.lat],
            [ne.lng, ne.lat],
            [nw.lng, nw.lat],
            [sw.lng, sw.lat]
        ]]);
    }

    function isPolygonGeometry(feature) {
        if (!feature || !feature.geometry) return false;
        const type = feature.geometry.type;
        if (type === 'Polygon' || type === 'MultiPolygon') {
            const coords = feature.geometry.coordinates;
            return Array.isArray(coords) && coords.length > 0;
        }
        return false;
    }

    function cloneFeatureSafely(feature) {
        try {
            return JSON.parse(JSON.stringify(feature));
        } catch (_) {
            return feature;
        }
    }

    function sanitizeFeatureCollection(collection) {
        if (!collection || typeof collection !== 'object') {
            return { type: 'FeatureCollection', features: [] };
        }
        const features = Array.isArray(collection.features) ? collection.features : [];
        const sanitized = [];
        for (const feature of features) {
            if (!isPolygonGeometry(feature)) continue;
            const clone = cloneFeatureSafely(feature);
            if (!isPolygonGeometry(clone)) continue;
            clone.properties = Object.assign({}, clone.properties || {});
            sanitized.push(clone);
        }
        return { type: 'FeatureCollection', features: sanitized };
    }

    function deepCloneFeatureCollection(collection) {
        try {
            return JSON.parse(JSON.stringify(collection));
        } catch (_) {
            return collection;
        }
    }

    function normalizeSingleFeature(feature, templateProps) {
        if (!feature) return null;
        let base = feature;
        if (feature.type !== 'Feature' && feature.geometry) {
            base = {
                type: 'Feature',
                geometry: feature.geometry,
                properties: {}
            };
        }
        if (!isPolygonGeometry(base)) {
            return null;
        }
        base.properties = Object.assign({}, base.properties || {}, templateProps || {});
        return base;
    }

    function normalizeFeatureLike(result, templateProps) {
        const output = [];
        if (!result) {
            return output;
        }
        if (result.type === 'FeatureCollection' && Array.isArray(result.features)) {
            result.features.forEach(f => {
                const normalized = normalizeSingleFeature(f, templateProps);
                if (normalized) {
                    output.push(normalized);
                }
            });
            return output;
        }
        const normalized = normalizeSingleFeature(result, templateProps);
        if (normalized) {
            output.push(normalized);
        }
        return output;
    }

    function describePlan(plan) {
        if (!plan) return null;
        const pieces = [];
        if (plan.planName) pieces.push(plan.planName);
        if (plan.planVersion) pieces.push(`v${plan.planVersion}`);
        if (plan.governmentName) pieces.push(plan.governmentName);
        return pieces.length ? pieces.join(' · ') : null;
    }

    function normalizePlanEntry(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const geometry = raw.plan_geometry || raw.geometry || null;
        if (!geometry || !geometry.type || !geometry.coordinates) return null;
        const dataSource = raw['data source'] || raw.data_source || raw.source || raw.url || '';
        if (!dataSource) return null;
        return {
            governmentName: raw.government_name || raw.governmentName || '',
            planName: raw.plan_name || raw.planName || '',
            planVersion: raw.plan_version || raw.planVersion || '',
            dataSource,
            geometry
        };
    }

    async function loadPlanCatalog() {
        if (planCatalogState.promise) {
            return planCatalogState.promise;
        }

        const planJsonPath = 'js/plan.json';
        const readEmbeddedCatalog = () => {
            try {
                if (typeof window === 'undefined') return null;
                const catalog = window.government_plans;
                return Array.isArray(catalog) ? catalog : null;
            } catch (_) {
                return null;
            }
        };

        planCatalogState.promise = (async () => {
            let rawCatalog = null;

            if (typeof fetch === 'function') {
                try {
                    const response = await fetch(planJsonPath, { headers: { 'Accept': 'application/json' } });
                    if (response.ok) {
                        rawCatalog = await response.json();
                    } else {
                        console.warn(`plan.json could not be loaded (status ${response.status}).`);
                    }
                } catch (err) {
                    console.warn('plan.json fetch failed; will fallback to embedded catalog if available.', err);
                }
            } else {
                console.warn('fetch is not available; skipping plan.json request.');
            }

            if (!Array.isArray(rawCatalog)) {
                const fallback = readEmbeddedCatalog();
                if (Array.isArray(fallback)) {
                    rawCatalog = fallback;
                } else {
                    planCatalogState.promise = null;
                    return [];
                }
            }

            try {
                return rawCatalog.map(normalizePlanEntry).filter(Boolean);
            } catch (err) {
                console.error('Unable to normalize government plan catalog.', err);
                planCatalogState.promise = null;
                return [];
            }
        })().catch(err => {
            console.error('Unable to load government plan catalog.', err);
            planCatalogState.promise = null;
            return [];
        });

        return planCatalogState.promise;
    }

    function buildMapBoundsPolygon(bounds) {
        return buildBoundsPolygon(bounds);
    }

    async function selectPlanForBounds(bounds) {
        if (typeof turf === 'undefined') {
            console.warn('turf.js is required to select government plans.');
            return null;
        }
        const plans = await loadPlanCatalog();
        if (!plans.length) return null;
        const mapPolygon = buildMapBoundsPolygon(bounds);
        if (!mapPolygon) return null;

        let bestPlan = null;
        let bestOverlapArea = 0;

        for (const plan of plans) {
            const planFeature = turf.feature(plan.geometry);
            let intersects = false;
            try {
                intersects = turf.booleanIntersects(planFeature, mapPolygon);
            } catch (err) {
                console.warn('booleanIntersects failed for plan geometry.', err);
                continue;
            }
            if (!intersects) continue;

            let overlapArea = 0;
            try {
                const intersection = turf.intersect(planFeature, mapPolygon);
                overlapArea = intersection ? turf.area(intersection) : 1;
            } catch (err) {
                overlapArea = 1;
            }

            if (!bestPlan || overlapArea > bestOverlapArea) {
                bestPlan = plan;
                bestOverlapArea = overlapArea;
            }
        }

        return bestPlan;
    }

    function getCurrentDataSource() {
        if (typeof window.getCurrentDataSource === 'function') {
            return window.getCurrentDataSource();
        }
        return 'oss.uredjenazemlja.hr';
    }

    async function fetchPlanGeoJSON(plan) {
        if (!plan || !plan.dataSource) {
            throw new Error('Plan is missing data source URL.');
        }
        if (planGeoCache.has(plan.dataSource)) {
            return planGeoCache.get(plan.dataSource);
        }
        const promise = (async () => {
            const response = await fetch(plan.dataSource, { headers: { 'Accept': 'application/json' } });
            if (!response.ok) {
                throw new Error(`Failed to fetch plan data from ${plan.dataSource} (status ${response.status})`);
            }
            return response.json();
        })();
        planGeoCache.set(plan.dataSource, promise);
        try {
            return await promise;
        } catch (err) {
            planGeoCache.delete(plan.dataSource);
            throw err;
        }
    }

    function decoratePlanFeatures(collection, plan) {
        const features = Array.isArray(collection?.features) ? collection.features : [];
        const descriptor = describePlan(plan) || 'Government Plan';
        return {
            type: 'FeatureCollection',
            features: features
                .map(feature => {
                    if (!feature || !feature.geometry) return null;
                    const clone = JSON.parse(JSON.stringify(feature));
                    clone.properties = Object.assign({}, clone.properties, {
                        planStatus: (clone.properties && clone.properties.planStatus) || 'planned',
                        planName: clone.properties?.planName || plan?.planName || '',
                        planVersion: clone.properties?.planVersion || plan?.planVersion || '',
                        planGovernment: clone.properties?.planGovernment || plan?.governmentName || '',
                        source: clone.properties?.source || 'government_plan',
                        displayColor: clone.properties?.displayColor || basePlanStyle.fillColor,
                        strokeColor: clone.properties?.strokeColor || basePlanStyle.color,
                        strokeWeight: clone.properties?.strokeWeight || basePlanStyle.weight,
                        fillOpacity: typeof clone.properties?.fillOpacity === 'number'
                            ? clone.properties.fillOpacity
                            : basePlanStyle.fillOpacity,
                        descriptor
                    });
                    return clone;
                })
                .filter(Boolean)
        };
    }

    async function fetchGovernmentPlanFromCatalog(bounds) {
        const plan = await selectPlanForBounds(bounds);
        if (!plan) {
            return {
                collection: { type: 'FeatureCollection', features: [] },
                descriptor: null,
                source: 'catalog'
            };
        }
        const raw = await fetchPlanGeoJSON(plan);
        const decorated = decoratePlanFeatures(raw, plan);
        const projected = toLeafletGeoJSON(decorated);
        return {
            collection: projected,
            descriptor: describePlan(plan),
            source: 'catalog'
        };
    }

    async function fetchGovernmentPlanFromBackend(bounds) {
        const bbox = getBboxFromBounds(bounds);
        const builder = (typeof window.buildPlannedRoadRequestParams === 'function') ? window.buildPlannedRoadRequestParams : null;
        let request = null;
        if (builder) {
            request = builder(bbox || '');
        } else {
            const fallbackBase = (typeof window.getBackendBase === 'function') ? window.getBackendBase() : 'http://localhost:3000';
            const trimmed = typeof bbox === 'string' ? bbox.trim() : '';
            const url = trimmed ? `${fallbackBase}/planned-road?bbox=${encodeURIComponent(trimmed)}` : `${fallbackBase}/planned-road`;
            request = { url, base: fallbackBase };
        }
        if (!request || !request.url) {
            throw new Error('Unable to resolve backend endpoint for planned roads.');
        }
        const response = await fetch(request.url, { headers: { 'Accept': 'application/json' } });
        if (!response.ok) {
            throw new Error(`Failed to fetch planned roads (status ${response.status})`);
        }
        const json = await response.json();
        const projected = toLeafletGeoJSON(json, { sourceSrid: 'EPSG:3765', suppressHTRSWarning: true });
        return {
            collection: projected,
            descriptor: null,
            source: 'backend'
        };
    }

    async function fetchGovernmentPlan(bounds) {
        const dataSource = getCurrentDataSource();
        if (dataSource === 'localhost' || dataSource === 'api.urbangametheory.xyz') {
            return fetchGovernmentPlanFromBackend(bounds);
        }
        return fetchGovernmentPlanFromCatalog(bounds);
    }

    function toLeafletGeoJSON(rawData, options) {
        if (!rawData) return { type: 'FeatureCollection', features: [] };
        let geojson = rawData;
        try {
            if (typeof window.convertGeoJSON === 'function') {
                geojson = window.convertGeoJSON(rawData, options) || rawData;
            }
        } catch (err) {
            console.warn('convertGeoJSON failed for planned roads, using original data.', err);
            geojson = rawData;
        }
        if (!geojson || !Array.isArray(geojson.features)) {
            return { type: 'FeatureCollection', features: [] };
        }
        return geojson;
    }

    function clearGovernmentRoadPlanLayer() {
        if (planLayer && window.map) {
            try { window.map.removeLayer(planLayer); } catch (_) { }
        }
        planLayer = null;
        try { window.governmentRoadPlanLayer = null; } catch (_) { }
        if (!cachedPlanCollection || !Array.isArray(cachedPlanCollection.features) || !cachedPlanCollection.features.length) {
            activePlanHashToken = null;
        }
        window.dispatchEvent(new CustomEvent('governmentPlanCleared'));
    }

    function getPlanLayerStyle(useHighlightStyle) {
        return useHighlightStyle ? highlightPlanStyle : basePlanStyle;
    }

    function ensurePlanLayer(useHighlightStyle) {
        if (planLayer && window.map) {
            if (typeof planLayer.setStyle === 'function') {
                planLayer.setStyle(getPlanLayerStyle(useHighlightStyle));
            }
            return planLayer;
        }
        ensureMapReady();
        planLayer = L.geoJSON([], {
            style: () => getPlanLayerStyle(useHighlightStyle)
        }).addTo(window.map);
        try { planLayer.bringToFront(); } catch (_) { }
        try { window.governmentRoadPlanLayer = planLayer; } catch (_) { }
        return planLayer;
    }

    function setPlanLayerFeatures(features, useHighlightStyle) {
        const layer = ensurePlanLayer(useHighlightStyle);
        if (typeof layer.clearLayers === 'function') {
            layer.clearLayers();
        }
        if (Array.isArray(features) && features.length && typeof layer.addData === 'function') {
            layer.addData({ type: 'FeatureCollection', features });
        }
        if (typeof layer.setStyle === 'function') {
            layer.setStyle(getPlanLayerStyle(useHighlightStyle));
        }
        try { layer.bringToFront(); } catch (_) { }
    }

    function isRoadParcelProperties(props) {
        const normalizedCategory = typeof props?.category === 'string' ? props.category.toLowerCase() : '';
        const normalizedCurrent = typeof props?.current === 'string' ? props.current.toLowerCase() : '';
        const explicitRoadFlag = props?.isRoad === true
            || props?.isRoad === 'true'
            || props?.road === true
            || props?.road === 'true'
            || normalizedCurrent === 'road'
            || normalizedCategory === 'road';
        const parcelId = resolveParcelIdFromProps(props);
        const storedRoadFlag = (typeof window.isRoad === 'function' && parcelId)
            ? window.isRoad(parcelId)
            : false;
        return explicitRoadFlag || storedRoadFlag;
    }

    function collectRoadParcelsInView(bounds) {
        const features = [];
        if (!window.parcelLayer || typeof window.parcelLayer.eachLayer !== 'function') {
            return features;
        }
        window.parcelLayer.eachLayer(layer => {
            if (!layer || typeof layer.toGeoJSON !== 'function' || typeof layer.getBounds !== 'function') {
                return;
            }
            let intersects = true;
            try {
                const layerBounds = layer.getBounds();
                intersects = layerBounds && layerBounds.isValid && layerBounds.isValid() && layerBounds.intersects(bounds);
            } catch (_) { }
            if (!intersects) return;
            const feature = layer.toGeoJSON();
            if (!isPolygonGeometry(feature)) return;
            if (!isRoadParcelProperties(feature.properties || {})) return;
            features.push(cloneFeatureSafely(feature));
        });
        return features;
    }

    const unionErrorCache = new Set();
    function safeUnion(base, addition) {
        if (typeof turf === 'undefined') return base;
        try {
            const result = turf.union(base, addition);
            return result || base;
        } catch (err) {
            const errMsg = err?.message || String(err);
            const errKey = errMsg.substring(0, 100);
            if (!unionErrorCache.has(errKey)) {
                unionErrorCache.add(errKey);
                if (console && typeof console.debug === 'function') {
                    console.debug('turf.union failed (suppressing duplicates):', errMsg);
                }
            }
            return base;
        }
    }

    function unionFeatures(features) {
        if (!Array.isArray(features) || !features.length) {
            return null;
        }
        if (typeof turf === 'undefined') {
            return null;
        }
        let unionFeature = null;
        for (const feature of features) {
            unionFeature = unionFeature ? safeUnion(unionFeature, feature) : feature;
        }
        return unionFeature;
    }

    function computePlanPiecesForView(bounds, options) {
        const opts = Object.assign({ subtractRoads: false }, options || {});
        if (!cachedPlanCollection || !Array.isArray(cachedPlanCollection.features)) {
            return [];
        }
        if (typeof turf === 'undefined') {
            return cachedPlanCollection.features.slice();
        }

        const mapPolygon = buildBoundsPolygon(bounds);
        const subtractRoads = !!opts.subtractRoads;
        let roadUnion = null;
        if (subtractRoads) {
            const roadParcels = collectRoadParcelsInView(bounds);
            roadUnion = unionFeatures(roadParcels);
        }

        const pieces = [];
        for (const planFeature of cachedPlanCollection.features) {
            if (!isPolygonGeometry(planFeature)) continue;
            let workingFeature = planFeature;
            if (mapPolygon) {
                try {
                    const intersection = turf.intersect(planFeature, mapPolygon);
                    if (!intersection) {
                        continue;
                    }
                    workingFeature = intersection;
                } catch (err) {
                    console.warn('turf.intersect failed for plan feature; using original geometry.', err);
                }
            }
            const clippedPieces = normalizeFeatureLike(workingFeature, planFeature.properties);
            if (!clippedPieces.length) {
                continue;
            }
            if (!subtractRoads || !roadUnion) {
                pieces.push(...clippedPieces);
                continue;
            }
            for (const piece of clippedPieces) {
                try {
                    const diff = turf.difference(piece, roadUnion);
                    if (!diff) {
                        continue;
                    }
                    const diffPieces = normalizeFeatureLike(diff, piece.properties);
                    if (diffPieces.length) {
                        pieces.push(...diffPieces);
                    }
                } catch (err) {
                    console.warn('Failed to subtract road parcels from plan piece.', err);
                    pieces.push(piece);
                }
            }
        }
        return pieces;
    }

    function computeRemainingPlanPiecesForView(bounds, options) {
        const opts = Object.assign({ subtractRoads: false }, options || {});
        if (!remainingPlanGeometry) {
            return computePlanPiecesForView(bounds, options);
        }

        const basePieces = getRemainingPlanForView(bounds);
        if (!Array.isArray(basePieces) || !basePieces.length) {
            return [];
        }

        const clonedPieces = basePieces.map(piece => cloneFeatureSafely(piece));
        if (!opts.subtractRoads) {
            return clonedPieces;
        }

        if (typeof turf === 'undefined') {
            return clonedPieces;
        }

        const roadParcels = collectRoadParcelsInView(bounds);
        const roadUnion = unionFeatures(roadParcels);
        if (!roadUnion) {
            return clonedPieces;
        }

        const trimmed = [];
        clonedPieces.forEach(piece => {
            if (!piece) {
                return;
            }
            try {
                const diff = turf.difference(piece, roadUnion);
                if (!diff) {
                    return;
                }
                const diffPieces = normalizeFeatureLike(diff, piece.properties);
                if (Array.isArray(diffPieces) && diffPieces.length) {
                    diffPieces.forEach(resultPiece => trimmed.push(resultPiece));
                    return;
                }
            } catch (err) {
                console.warn('Failed to subtract road parcels from remaining plan piece.', err);
            }
            trimmed.push(piece);
        });

        return trimmed;
    }

    /**
     * Prepare plan pieces for auto-apply using the in-memory remaining plan geometry.
     * This ensures we never apply the same segment twice:
     * - remainingPlanGeometry starts as the full plan
     * - After applying, the applied geometry is immediately subtracted from it
     * - On subsequent runs, only the truly remaining geometry is returned
     */
    function preparePlanPiecesForAutoApply(bounds) {
        // Ensure the remaining plan geometry is initialized
        if (!remainingPlanGeometry) {
            initializeRemainingPlanGeometry();
        }

        // Get the remaining plan clipped to the current view
        const planPieces = getRemainingPlanForView(bounds);

        return { planPieces: Array.isArray(planPieces) ? planPieces : [], source: 'memory' };
    }

    function isGovernmentPlanOverlayEnabled() {
        try {
            const checkbox = document.getElementById('showGovernmentRoadPlan');
            if (!checkbox) return true;
            return !!checkbox.checked;
        } catch (_) {
            return true;
        }
    }

    function renderGovernmentPlanForView(options) {
        const opts = Object.assign({ skipStatus: false, statusMessage: null }, options || {});

        if (!isGovernmentPlanOverlayEnabled()) {
            clearGovernmentRoadPlanLayer();
            return;
        }

        if (!cachedPlanCollection || !Array.isArray(cachedPlanCollection.features)) {
            clearGovernmentRoadPlanLayer();
            if (!opts.skipStatus && typeof window.updateStatus === 'function') {
                window.updateStatus('No government plan segments available for this view.');
            }
            return;
        }

        const features = cachedPlanCollection.features;
        if (!features.length) {
            clearGovernmentRoadPlanLayer();
            if (!opts.skipStatus && typeof window.updateStatus === 'function') {
                window.updateStatus('Government road plan fully applied.');
            }
            return;
        }

        setPlanLayerFeatures(features, false);
        window.dispatchEvent(new CustomEvent('governmentPlanLoaded', { detail: { featureCount: features.length } }));

        if (!opts.skipStatus && typeof window.updateStatus === 'function') {
            const suffix = lastPlanDescriptor ? ` (${lastPlanDescriptor})` : '';
            const featureCount = features.length;
            const baseMessage = opts.statusMessage
                ? `${opts.statusMessage.trim()}${suffix}`
                : `Government road plan drawn${suffix}`;
            window.updateStatus(`${baseMessage}: ${featureCount} feature${featureCount === 1 ? '' : 's'}.`);
        }
    }

    async function drawGovernmentRoadPlan(options) {
        const opts = Object.assign({ forceRefetch: false, skipStatus: false }, options || {});
        if (isFetchingGovernmentPlan) {
            return;
        }
        try {
            ensureMapReady();
        } catch (err) {
            if (!opts.skipStatus && typeof window.updateStatus === 'function') {
                window.updateStatus('Map is not ready yet. Please wait.');
            }
            console.warn(err.message);
            return;
        }

        const bounds = getActiveMapBounds();
        if (!bounds) {
            if (!opts.skipStatus && typeof window.updateStatus === 'function') {
                window.updateStatus('Unable to determine map bounds for government plans.');
            }
            return;
        }

        if (!opts.skipStatus && typeof window.updateStatus === 'function') {
            window.updateStatus('Fetching government road plan...');
        }

        isFetchingGovernmentPlan = true;
        try {
            const result = await fetchGovernmentPlan(bounds);
            const sanitized = sanitizeFeatureCollection(result.collection);
            cachedPlanCollection = deepCloneFeatureCollection(sanitized);
            cachedPlanGeometryHash = computePlanGeometryHash(cachedPlanCollection);
            cachedPlanVertexCount = countVerticesInFeatureCollection(cachedPlanCollection);
            activePlanHashToken = cachedPlanGeometryHash || null;
            cachedPlanSource = result.source || null;
            lastPlanDescriptor = result.descriptor || null;

            // Initialize the remaining plan geometry with the full plan
            initializeRemainingPlanGeometry();
            if (!Array.isArray(cachedPlanCollection.features) || !cachedPlanCollection.features.length) {
                clearGovernmentRoadPlanLayer();
                if (!opts.skipStatus && typeof window.updateStatus === 'function') {
                    const vertexSummary = cachedPlanVertexCount ? ` (${cachedPlanVertexCount} plan vertices)` : ' (0 plan vertices)';
                    window.updateStatus(`No government plan segments overlap this view${vertexSummary}.`);
                }
                try { window.governmentRoadPlanLastDescriptor = () => lastPlanDescriptor; } catch (_) { }
                return;
            }

            renderGovernmentPlanForView({ skipStatus: opts.skipStatus });
            if (!opts.skipStatus && typeof window.updateStatus === 'function') {
                const suffix = lastPlanDescriptor ? ` (${lastPlanDescriptor})` : '';
                const vertexSummary = cachedPlanVertexCount ? ` · ${cachedPlanVertexCount} plan vertices` : ' · 0 plan vertices';
                window.updateStatus(`Government road plan loaded${suffix}${vertexSummary}.`);
            }
        } catch (error) {
            console.error('Failed to draw government road plan:', error);
            clearGovernmentRoadPlanLayer();
            if (!opts.skipStatus && typeof window.updateStatus === 'function') {
                window.updateStatus('Failed to draw government road plan. Check console for details.');
            }
            activePlanHashToken = null;
        } finally {
            isFetchingGovernmentPlan = false;
        }
    }

    async function applyGovernmentRoadPlan(options) {
        const opts = Object.assign({ skipStatus: false, ignoreZoomGuard: true }, options || {});
        const applyButton = document.getElementById('applyGovernmentRoadPlanButton');
        const originalLabel = applyButton ? applyButton.textContent : null;
        if (applyButton) {
            applyButton.disabled = true;
            applyButton.textContent = 'Applying...';
        }

        let result = null;
        try {
            const suffix = lastPlanDescriptor ? ` (${lastPlanDescriptor})` : '';

            if (!opts.skipStatus && typeof window.updateStatus === 'function') {
                window.updateStatus(`Applying government road plan${suffix}...`);
            }

            result = await performAutoApply({
                force: true,
                ignoreZoomGuard: !!opts.ignoreZoomGuard,
                reason: 'manual-invoke',
                ignoreSelection: true,
                maxCandidateParcels: Number.POSITIVE_INFINITY
            });

            if (!opts.skipStatus && typeof window.updateStatus === 'function') {
                const stats = (typeof window !== 'undefined' && window.lastGovernmentPlanAutoApplyStats)
                    ? window.lastGovernmentPlanAutoApplyStats
                    : null;

                if (result && result.applied) {
                    let newSegmentCount = Array.isArray(result.newSegmentHashes) ? result.newSegmentHashes.length : 0;
                    if ((!newSegmentCount || newSegmentCount === 0) && stats && typeof stats.newSegments === 'number') {
                        newSegmentCount = stats.newSegments;
                    }
                    if (newSegmentCount && newSegmentCount > 0) {
                        window.updateStatus(`Applied government road plan${suffix}: added ${newSegmentCount} new segment${newSegmentCount === 1 ? '' : 's'}.`);
                    }
                } else {
                    const reason = stats ? stats.result : null;
                    const messages = {
                        'skipped-no-selection': 'Select at least one parcel to apply the government road plan.',
                        'selection-not-visible': 'Selected parcels are outside the current view or already match the government road plan. Zoom or adjust the selection.',
                        'selection-already-road': 'Selected parcels already match the government road plan.',
                        'no-visible-parcels': 'No parcels available in the current view for the government road plan.',
                        'no-plan-data': 'No government road plan data is available for this view.',
                        'no-plan-pieces': 'No government plan segments remain in this view.',
                        'no-plan-pieces-for-selection': 'Government road plan has no segments overlapping the current map view.',
                        'no-build': 'Government road plan has no overlap with the current map view.',
                        'filtered-no-new': 'Government road plan already matches the current map view.',
                        'waiting-fetch': 'Government road plan is still loading. Try again in a moment.',
                        'skipped-zoom': 'Zoom in further to apply the government road plan.',
                        'apply-failed': 'Could not apply the government road plan. Check the console for details.',
                        'skipped-merge-in-progress': 'Parcel data is still merging. We will apply the government road plan as soon as the map finishes updating.'
                    };
                    const message = (reason && messages[reason])
                        ? messages[reason]
                        : `No unapplied government road plan segments in this view${suffix}.`;
                    if (message) {
                        window.updateStatus(message);
                    }
                }
            }
        } finally {
            if (applyButton) {
                applyButton.disabled = false;
                applyButton.textContent = originalLabel || 'Apply Government Road Plan';
            }
        }

        return result;
    }

    document.addEventListener('DOMContentLoaded', () => {
        initialiseGovernmentPlanProposalState();

        const planCheckbox = document.getElementById('showGovernmentRoadPlan');
        if (planCheckbox) {
            planCheckbox.addEventListener('change', () => {
                if (planCheckbox.checked) {
                    drawGovernmentRoadPlan();
                } else {
                    clearGovernmentRoadPlanLayer();
                    if (typeof window.updateStatus === 'function') {
                        window.updateStatus('Government road plan hidden.');
                    }
                }
            });
        }

        const applyButton = document.getElementById('applyGovernmentRoadPlanButton');
        if (applyButton) {
            applyButton.addEventListener('click', () => {
                applyGovernmentRoadPlan();
            });
        }
    });

    window.drawGovernmentRoadPlan = drawGovernmentRoadPlan;
    window.applyGovernmentRoadPlan = applyGovernmentRoadPlan;
    window.clearGovernmentRoadPlanLayer = clearGovernmentRoadPlanLayer;
    window.governmentRoadPlanLastDescriptor = () => lastPlanDescriptor;
    window.governmentPlanProposalId = () => governmentPlanProposalId;
    window.getGovernmentPlanCollection = () => cachedPlanCollection;

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('beforeunload', () => {
            terminatePlanWorker();
        });
    }
})();
