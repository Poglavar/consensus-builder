// proposals/sharing-routes.js — proposal share actions and URL route handlers
// (handleSharedPlanRoute etc.). Extracted from proposals.js. The share codec it uses
// (base64UrlEncodeBytes/base64UrlDecodeToBytes/compressBytes/inflateBytes/decodeBytesToJson/
// decodeSharedPayload) and the SHARE_* constants live in proposals/sharing.js and are used here as
// globals; this file used to carry a duplicate set of them, which sharing.js (loaded later) shadowed
// so they never actually ran.

function getSharedGroundService() {
    if (typeof CadastralParcelRepository !== 'undefined' && CadastralParcelRepository) {
        return CadastralParcelRepository;
    }
    return (typeof window !== 'undefined') ? window.CadastralParcelRepository : null;
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
            const polygon = proposal.roadProposal.definition?.polygon;
            if (polygon) geometryFeatures.push({ type: 'Feature', properties: {}, geometry: polygon });
            (proposal.roadProposal.definition?.features || []).forEach(feature => {
                if (feature?.geometry) geometryFeatures.push(feature);
            });
        }
        (proposal.geometry?.buildings || []).forEach(feature => {
            if (feature?.geometry) geometryFeatures.push(feature);
        });
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

        const parcelLayers = ensureArrayOfStrings(proposal.cadastreParcelIds)
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

/** Spinner on the sidebar's "Share entire plan" button. The label/subtext give way to it so the
    button keeps its size, and the busy flag survives updateShowProposalsButton re-enabling it. */
function setSharePlanButtonBusy(busy) {
    const button = document.getElementById('shareAppliedProposalsButton');
    if (!button) return;
    const label = button.querySelector('.share-plan-label');
    const subtext = button.querySelector('.share-plan-subtext');
    const spinner = button.querySelector('.share-plan-spinner');
    if (busy) {
        button.dataset.sharePlanBusy = '1';
        button.disabled = true;
        if (label) label.style.display = 'none';
        if (subtext) subtext.style.display = 'none';
        if (spinner) spinner.style.display = 'inline-flex';
    } else {
        delete button.dataset.sharePlanBusy;
        button.disabled = false;
        if (label) label.style.display = '';
        if (subtext) subtext.style.display = '';
        if (spinner) spinner.style.display = 'none';
    }
}

// Resolves when the panel is ready to look at, so a caller that opened this from its own dialog
// can keep that dialog up meanwhile. `options` is passed straight through (see showSharePlanPanel).
function shareAppliedProposals(options) {
    if (typeof setSharePlanButtonBusy === 'function') setSharePlanButtonBusy(true);
    // Opening the panel starts with a long SYNCHRONOUS block: a row per applied proposal, plus one
    // map overlay each (turf intersections + a Leaflet layer), plus fitting the map. Starting it in
    // this same task would freeze the page before the spinner ever painted, so yield two frames —
    // one to apply the style, one to be sure it reached the screen.
    return new Promise((resolve) => {
        const open = () => {
            let ready = null;
            try {
                ready = showSharePlanPanel(options);
            } finally {
                // The panel folds the sidebar away, so this is mostly for the next time it is opened —
                // and for the failure path, where the button must not stay stuck spinning.
                if (typeof setSharePlanButtonBusy === 'function') setSharePlanButtonBusy(false);
            }
            // A thenable is adopted; an older build that returns nothing resolves right away, which
            // is the previous behaviour rather than a hang.
            resolve(ready);
        };
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => requestAnimationFrame(open));
        } else {
            open();
        }
    });
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
    const ancestryApi = (typeof window !== 'undefined') ? window.__cadastreAncestry : null;
    const depthApi = (typeof window !== 'undefined') ? window.__formationDepth : null;
    if (!ancestryApi || typeof ancestryApi.validateCadastreParcelIds !== 'function'
        || !depthApi || typeof depthApi.preparePublishRecord !== 'function') {
        throw new Error('Cannot share: the cadastral publish gate is unavailable.');
    }

    const featuresForBounds = [];
    const addGeometry = (geometry, properties = {}) => {
        if (!geometry || !/Polygon$/.test(String(geometry.type || ''))) return;
        featuresForBounds.push({ type: 'Feature', properties, geometry: deepClone(geometry) });
    };
    const addFeature = feature => {
        if (feature?.type === 'Feature' && feature.geometry) featuresForBounds.push(deepClone(feature));
    };
    const sanitized = appliedProposals.map(proposal => {
        // Sharing publishes the same authored record the local store owns. It never reconstructs
        // parcel parents or children from runtime output; those pieces belong to LiveParcelFabric.
        const candidate = deepClone(proposal);
        candidate.goal = resolveProposalGoalKey(proposal) || proposal.goal || null;
        candidate.cadastreParcelIds = ancestryApi.validateCadastreParcelIds(proposal);
        candidate.ownershipFlow = typeof ancestryApi.computeOwnershipFlow === 'function'
            ? ancestryApi.computeOwnershipFlow(proposal)
            : (Array.isArray(proposal.ownershipFlow) ? deepCloneArray(proposal.ownershipFlow) : []);
        candidate.minted = isProposalMinted(proposal);

        addGeometry(candidate.roadProposal?.definition?.polygon, { proposalId: candidate.proposalId });
        (candidate.roadProposal?.definition?.features || []).forEach(addFeature);
        (candidate.geometry?.buildings || []).forEach(addFeature);
        addFeature(candidate.geometry?.blockMassing);
        addFeature(candidate.geometry?.groundSurface);
        addGeometry(candidate.structureProposal?.geometry, {
            proposalId: candidate.proposalId,
            structureKind: candidate.structureProposal?.kind || null
        });
        (candidate.reparcellization?.polygons || []).forEach(slice => addGeometry(slice?.geometry, {
            proposalId: candidate.proposalId,
            ownerKey: slice?.ownerKey || null
        }));

        const gate = depthApi.preparePublishRecord(candidate);
        if (!gate.verdict.flat) {
            const detail = gate.verdict.violations
                .map(item => item.code + (item.field ? ` (${item.field})` : ''))
                .join(', ');
            throw new Error(`Cannot share non-conforming proposal ${proposal.proposalId || ''}: ${detail}`);
        }
        return gate.proposal;
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

function coordinatedPlanIdOfSharedRecord(record) {
    if (!record || record.coordinatedPlanId === undefined || record.coordinatedPlanId === null) return '';
    return String(record.coordinatedPlanId).trim();
}

function sharedMaterializationPhase(record) {
    const rawGoal = record && record.goal;
    const goal = (typeof applyRoute !== 'undefined' && applyRoute && typeof applyRoute.normalizeGoalKey === 'function')
        ? applyRoute.normalizeGoalKey(rawGoal)
        : String(rawGoal || '');
    // A coordinated plan explicitly publishes complementary readjustment plots and road bands.
    // Its plots must stand first so corridor derivation can retain them and fill their intentional
    // gaps. Ordinary packages keep the interactive authoring order: roads form blocks first, then
    // a readjustment partitions the remainders.
    if (coordinatedPlanIdOfSharedRecord(record)) {
        if (goal === 'reparcellization' || goal === 'decide-later'
            || !!(record && (record.reparcellization || record.decideLaterProposal))) return 0;
        if (goal === 'road-track' || !!(record && record.roadProposal)) return 1;
        const coordinatedBuilding = !!(record && record.buildingProposal)
            || !!(typeof applyRoute !== 'undefined' && applyRoute
                && typeof applyRoute.isBuildingGoal === 'function' && applyRoute.isBuildingGoal(goal));
        if (coordinatedBuilding) return 2;
        if (goal === 'park' || goal === 'square' || goal === 'lake' || goal === 'station'
            || !!(record && record.structureProposal)) return 3;
        return 4;
    }
    if (goal === 'road-track' || !!(record && record.roadProposal)) return 0;
    if (goal === 'reparcellization' || goal === 'decide-later'
        || !!(record && (record.reparcellization || record.decideLaterProposal))) return 1;
    const building = !!(record && record.buildingProposal)
        || !!(typeof applyRoute !== 'undefined' && applyRoute
            && typeof applyRoute.isBuildingGoal === 'function' && applyRoute.isBuildingGoal(goal));
    if (building) return 2;
    if (goal === 'park' || goal === 'square' || goal === 'lake' || goal === 'station'
        || !!(record && record.structureProposal)) return 3;
    return 4;
}

function orderQueuedSharedProposalIds(proposalIds) {
    return Array.from(new Set((Array.isArray(proposalIds) ? proposalIds : [])
        .map(id => String(id || '')).filter(Boolean)))
        .map((id, index) => {
            let record = null;
            try {
                record = (typeof proposalStorage !== 'undefined' && proposalStorage.getProposal)
                    ? proposalStorage.getProposal(id) : null;
            } catch (_) { record = null; }
            return { id, index, phase: sharedMaterializationPhase(record) };
        })
        .sort((a, b) => a.phase - b.phase || a.index - b.index)
        .map(entry => entry.id);
}

// Presentation focus is chosen only from the FINAL result sets. An imported record is parked before
// materialisation, so "last imported" is not proof that it ever reached the map; keeping that value
// as a fallback made an all-failed queue focus a proposal whose geometry/fabric was never applied.
function selectSharedPlanFocusId(appliedItems, skippedItems, alreadyAppliedProposals, linkOrderResolver) {
    let selectedId = null;
    let selectedOrder = -1;
    const consider = (candidateId, order) => {
        if (!candidateId) return;
        const effectiveOrder = Number.isFinite(order) ? order : -1;
        if (effectiveOrder >= selectedOrder) {
            selectedOrder = effectiveOrder;
            selectedId = String(candidateId);
        }
    };

    (Array.isArray(appliedItems) ? appliedItems : [])
        .forEach(item => consider(item && item.id, item && item.ord));
    (Array.isArray(skippedItems) ? skippedItems : [])
        .forEach(item => consider(item && item.id, item && item.ord));
    (Array.isArray(alreadyAppliedProposals) ? alreadyAppliedProposals : []).forEach(proposal => {
        const order = (typeof linkOrderResolver === 'function') ? linkOrderResolver(proposal) : -1;
        consider(proposal && (proposal.proposalId || proposal.serverProposalId), order);
    });

    return selectedId;
}

function sharedCorridorCountPhrase(roads, tracks, tShare) {
    const roadCount = Math.max(0, Number(roads) || 0);
    const trackCount = Math.max(0, Number(tracks) || 0);
    const parts = [];
    if (roadCount) {
        parts.push(tShare('plan.progress.roadCount',
            roadCount === 1 ? '{{count}} road' : '{{count}} roads', { count: roadCount }));
    }
    if (trackCount) {
        parts.push(tShare('plan.progress.trackCount',
            trackCount === 1 ? '{{count}} track' : '{{count}} tracks', { count: trackCount }));
    }
    if (parts.length === 2) {
        return tShare('plan.progress.corridorCounts', '{{roads}} and {{tracks}}', {
            roads: parts[0],
            tracks: parts[1]
        });
    }
    return parts[0] || tShare('plan.progress.corridorCountNone', 'corridors');
}

// Structured materializer/service events become user-facing text only here. The ground service and
// ProposalManager do not know about the overlay or translations; they report facts and this route
// describes them.
function sharedPlanProgressView(event, tShare) {
    if (!event || typeof tShare !== 'function') return null;
    const title = tShare('plan.applyingAllTitle', 'Applying the shared plan');
    const count = () => sharedCorridorCountPhrase(event.roads, event.tracks, tShare);
    switch (event.phase) {
        case 'ground-check':
            return {
                title,
                status: tShare('plan.progress.groundCheck',
                    'Checking cadastral ground for {{count}} proposals…', { count: event.members })
            };
        case 'ground-check-ids':
            return {
                title,
                status: tShare('plan.progress.groundIdCheck',
                    'Checking {{count}} declared cadastral parcels…', { count: event.total })
            };
        case 'ground-load-ids':
            return {
                title,
                status: tShare('plan.progress.groundIdLoad',
                    'Loading {{requested}} missing cadastral parcels; {{cached}} already cached…', event),
                progress: { done: event.cached || 0, total: event.total || 0 }
            };
        case 'ground-load-ids-progress':
            return {
                title,
                status: tShare('plan.progress.groundIdLoadProgress',
                    'Loading cadastral parcels ({{done}}/{{total}})…', event),
                progress: { done: event.done || 0, total: event.total || 0 }
            };
        case 'ground-wait-ids':
            return {
                title,
                status: tShare('plan.progress.groundIdWait',
                    'Waiting for an existing cadastral-ground request…')
            };
        case 'ground-wait-footprints':
            return {
                title,
                status: tShare('plan.progress.groundFootprintWait',
                    'Waiting for an existing footprint-ground request…')
            };
        case 'ground-ids-ready':
            return {
                title,
                status: event.missing
                    ? tShare('plan.progress.groundIdsMissing',
                        'Cadastral parcel check finished: {{missing}} unavailable.', event)
                    : tShare('plan.progress.groundIdsReady',
                        'Cadastral parcels ready: {{cached}} cached, {{loaded}} loaded.', event),
                progress: { done: Math.max(0, (event.total || 0) - (event.missing || 0)), total: event.total || 0 }
            };
        case 'ground-load-footprints':
            return {
                title,
                status: tShare('plan.progress.groundFootprintLoad',
                    'Loading footprint ground for {{members}} proposals in {{batches}} batches…', event),
                progress: { done: 0, total: event.batches || 0 }
            };
        case 'ground-load-footprints-progress':
            return {
                title,
                status: tShare('plan.progress.groundFootprintProgress',
                    'Loading footprint ground (batch {{done}}/{{total}}, {{parcels}} parcels)…', event),
                progress: { done: event.done || 0, total: event.total || 0 }
            };
        case 'ground-ready':
            return {
                title,
                status: event.unavailableMembers
                    ? tShare('plan.progress.groundIncomplete',
                        'Ground check finished: {{unavailableMembers}} proposals still have unavailable parcels.', event)
                    : tShare('plan.progress.groundReady',
                        'Cadastral ground ready: {{cachedMembers}} proposals reused loaded ground; {{loadedMembers}} needed loading.', event)
            };
        case 'building-ground-load':
            return {
                title,
                status: tShare('plan.progress.buildingGroundLoad',
                    'Loading buildings in {{regions}} affected areas ({{batches}} batches)…', event),
                progress: { done: 0, total: event.batches || 0 }
            };
        case 'building-ground-progress':
            return {
                title,
                status: tShare('plan.progress.buildingGroundProgress',
                    'Loading affected buildings (batch {{done}}/{{total}}, {{covered}} areas covered)…', event),
                progress: { done: event.done || 0, total: event.total || 0 }
            };
        case 'building-ground-ready':
            return {
                title,
                status: tShare('plan.progress.buildingGroundReady',
                    'Affected-building data ready: {{covered}} areas loaded; {{fallback}} will be checked individually.', event)
            };
        case 'rebuild-reset':
            return {
                title,
                status: tShare('plan.progress.rebuildReset',
                    'Clearing derived map output for {{members}} proposals…', event)
            };
        case 'corridor-start':
            return {
                title,
                status: tShare('plan.progress.corridorStart', 'Preparing {{corridors}}…', { corridors: count() })
            };
        case 'fabric-scope-ready':
            return {
                title,
                status: tShare('plan.progress.scopeReady',
                    'Affected ground resolved: {{parcels}} cadastral parcels.', event)
            };
        case 'fabric-scan':
            return {
                title,
                status: tShare('plan.progress.fabricScan',
                    'Finding corridor intersections ({{done}}/{{total}} loaded parcels)…', event),
                progress: { done: event.done || 0, total: event.total || 0 }
            };
        case 'fabric-arrange':
            return {
                title,
                status: tShare('plan.progress.fabricArrange',
                    'Cutting affected cadastral parcels ({{done}}/{{total}})…', event),
                progress: { done: event.done || 0, total: event.total || 0 }
            };
        case 'map-update':
            return {
                title,
                status: tShare('plan.progress.mapUpdate',
                    'Updating the map: {{added}} parcel pieces added, {{removed}} removed…', event)
            };
        case 'fabric-ready':
            return {
                title,
                status: tShare('plan.progress.fabricReady',
                    'Parcel fabric ready across {{parcels}} cadastral parcels.', event)
            };
        case 'proposal-apply':
            return {
                title,
                status: tShare('plan.applyingNamed',
                    'Applying {{label}} ({{done}}/{{total}})…', event),
                progress: { done: event.done || 0, total: event.total || 0 }
            };
        case 'save':
            return { title, status: tShare('plan.progress.saving', 'Saving applied proposals…') };
        case 'corridor-ready':
            return {
                title,
                status: tShare('plan.progress.corridorReady', 'Finished applying {{corridors}}.', { corridors: count() })
            };
        case 'rollback':
            return { title, status: tShare('plan.progress.rollback', 'Restoring the parcel fabric after an error…') };
        case 'presentation':
            return { title, status: tShare('plan.progress.presentation', 'Refreshing the map and proposal list…') };
        case 'corridor-strips':
            return { title, status: tShare('plan.progress.corridorStrips', 'Refreshing road and track surfaces…') };
        case 'rebuild-ready':
            return {
                title,
                status: tShare('plan.progress.rebuildReady',
                    'Rebuild finished: {{members}} proposals, {{corridors}} corridors, {{failed}} failures.', event)
            };
        default:
            return null;
    }
}

function reportSharedPlanProgress(event) {
    if (typeof updateProposalLoadOverlay !== 'function') return;
    try {
        const view = sharedPlanProgressView(event, getShareI18nHelper());
        if (view) updateProposalLoadOverlay(view);
    } catch (_) { /* progress must never break an apply */ }
}


// Materialise only the records this shared link just imported.
//
// Startup has already restored the standing plan before either shared-import path reaches here.
// Rebuilding that whole plan again made opening ONE proposal proportional to everything the user
// happened to have applied locally (and, on a 26-member plan, paid the same 20-second replay twice).
// Each parked member goes directly through the canonical replay materializer. It keeps the rollback
// boundary, but avoids the explicit-click state transition and supersession pass that used to run
// before the same materializer. Package dependency order remains immutable inside each phase.
async function materializeQueuedSharedProposals(proposalIds, options = {}) {
    // Package dependencies outrank URL and creation order. Ordinary packages form road-bounded
    // blocks before partitioning them; explicitly coordinated packages publish a pre-tessellated
    // readjustment first, then fill its reserved road bands. Buildings and public spaces follow in
    // both cases. Immutable input order still breaks ties within each phase.
    const orderedIds = orderQueuedSharedProposalIds(proposalIds);
    const appliedIds = [];
    const failedIds = [];
    const now = () => ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now());
    const started = now();
    // Cached proposal applies often resolve as one uninterrupted chain of microtasks. Updating the
    // overlay inside that chain does not mean the browser paints it: without a real task boundary
    // Šibenik visibly stayed on its first post-corridor member (132/298) until the whole plan was
    // done. Yield on a small time budget rather than after every member, preserving throughput while
    // keeping the counter and final phases honest.
    const progressPaintIntervalMs = 80;
    let lastProgressPaintAt = started;
    let proposalProgressStarted = false;
    const paintSharedPlanProgress = async (force = false) => {
        if (typeof window === 'undefined' || typeof window.yieldToBrowser !== 'function') return;
        const current = now();
        if (!force && current - lastProgressPaintAt < progressPaintIntervalMs) return;
        lastProgressPaintAt = current;
        try { await window.yieldToBrowser(); } catch (_) { /* progress must never break an apply */ }
    };
    let presentationMs = 0;
    let storageMs = 0;
    const batchStore = (typeof proposalStorage !== 'undefined') ? proposalStorage : null;
    const storageBatched = !!(batchStore
        && typeof batchStore.beginBatch === 'function'
        && typeof batchStore.endBatch === 'function');
    // Who belongs to THIS plan. A member standing on ground another member holds is the plan
    // working as designed — on a re-open that is nearly every member — so those are not the
    // "someone else's applied work" the supersede refusal is protecting.
    const planMemberIds = new Set(orderedIds.map(id => String(id)));
    const suppliedPlanMembership = options.planMemberIds;
    if (suppliedPlanMembership && typeof suppliedPlanMembership[Symbol.iterator] === 'function') {
        for (const id of suppliedPlanMembership) {
            if (id !== undefined && id !== null && String(id)) planMemberIds.add(String(id));
        }
    }
    const orderedRecords = orderedIds
        .map(id => {
            try { return proposalStorage.getProposal(id); } catch (_) { return null; }
        })
        .filter(Boolean);
    // Incoming records are parked at this point. Capture only what stood before the plan began;
    // otherwise every newly-applied sibling enlarges the next member's geometric holder scan and a
    // 299-member plan degenerates into ~90,000 pairwise checks before plan-mates are filtered out.
    let preexistingAppliedRecords = null;
    try {
        if (proposalStorage && typeof proposalStorage.getAllProposals === 'function') {
            preexistingAppliedRecords = proposalStorage.getAllProposals()
                .filter(record => {
                    if (!record || !isProposalCurrentlyApplied(record)) return false;
                    const identities = [record.proposalId, record.serverProposalId];
                    try {
                        if (typeof getServerProposalId === 'function') identities.push(getServerProposalId(record));
                    } catch (_) { }
                    return !identities.some(id => id !== undefined && id !== null
                        && planMemberIds.has(String(id)));
                });
        }
    } catch (_) { preexistingAppliedRecords = null; }
    try {
        if (ProposalManager) {
            ProposalManager._lastReplayGroundProfile = null;
            ProposalManager._lastDemolitionPrefetchProfile = null;
        }
    } catch (_) { }
    // Start the one existing-stock request immediately. Ordinary packages begin with a corridor
    // batch, so this network wait runs behind their ground derivation and is normally finished by
    // the time the first building needs its exact slice.
    const demolitionPromise = (ProposalManager && typeof ProposalManager._prefetchDemolitionBuildings === 'function')
        ? Promise.resolve(ProposalManager._prefetchDemolitionBuildings(orderedRecords, {
            onProgress: reportSharedPlanProgress
        }))
            .catch(error => {
                console.warn('[shared-apply] demolition prefetch failed; members fall back individually', error);
                return new Map();
            })
        : Promise.resolve(new Map());
    let demolitionBuildings = null;
    const demolitionFor = async id => {
        if (!demolitionBuildings) demolitionBuildings = await demolitionPromise;
        if (!demolitionBuildings || typeof demolitionBuildings.has !== 'function'
            || !demolitionBuildings.has(String(id))) return { covered: false, features: undefined };
        return { covered: true, features: demolitionBuildings.get(String(id)) };
    };
    // This loop is the tail of a plan open. Without phase reports the overlay held one "Applying
    // shared plan…" across ground loading, parcel cutting, noding, and storage, and even named the
    // first track while the whole corridor batch ran. Roads now report their batch phases; `index`
    // remains the position used for ordinary per-proposal progress.
    const reportProgress = (record, id, done) => {
        if (typeof updateProposalLoadOverlay !== 'function') return;
        // The name alone. formatSharedProposalLabel appends "(#id)", which is useful in a failure
        // report but noisy in a status line that changes every second.
        const title = (record && typeof record.title === 'string') ? record.title.trim() : '';
        reportSharedPlanProgress({
            phase: 'proposal-apply',
            label: title || formatSharedProposalLabel(record, id),
            done,
            total: orderedIds.length
        });
    };
    if (storageBatched) batchStore.beginBatch();
    try {
        for (let index = 0; index < orderedIds.length;) {
            const id = orderedIds[index];
            let record = null;
            try { record = proposalStorage.getProposal(id); } catch (_) { record = null; }
            const goal = (typeof applyRoute !== 'undefined' && applyRoute && typeof applyRoute.normalizeGoalKey === 'function')
                ? applyRoute.normalizeGoalKey(record && record.goal)
                : String((record && record.goal) || '');
            const isRoad = goal === 'road-track' || !!(record && record.roadProposal);

            // Consecutive roads in the ordered package are one network mutation. This is equally valid
            // before an ordinary readjustment and after a coordinated one; only their phase changes.
            if (isRoad && ProposalManager && typeof ProposalManager.materializeCorridorBatch === 'function') {
                const roadIds = [];
                let cursor = index;
                while (cursor < orderedIds.length) {
                    const roadId = orderedIds[cursor];
                    let roadRecord = null;
                    try { roadRecord = proposalStorage.getProposal(roadId); } catch (_) { roadRecord = null; }
                    const roadGoal = (typeof applyRoute !== 'undefined' && applyRoute && typeof applyRoute.normalizeGoalKey === 'function')
                        ? applyRoute.normalizeGoalKey(roadRecord && roadRecord.goal)
                        : String((roadRecord && roadRecord.goal) || '');
                    if (!(roadGoal === 'road-track' || !!(roadRecord && roadRecord.roadProposal))) break;
                    roadIds.push(roadId);
                    cursor += 1;
                }
                try {
                    const batch = await ProposalManager.materializeCorridorBatch(roadIds, {
                        deferPresentation: true,
                        deferSave: true,
                        onProgress: reportSharedPlanProgress
                    });
                    appliedIds.push(...(Array.isArray(batch?.appliedIds) ? batch.appliedIds : []));
                    failedIds.push(...(Array.isArray(batch?.failedIds) ? batch.failedIds : (batch?.ok ? [] : roadIds)));
                } catch (error) {
                    console.error('[shared-apply] corridor batch failed', error);
                    failedIds.push(...roadIds);
                }
                index = cursor;
                continue;
            }

            const proposalPosition = index + 1;
            reportProgress(record, id, proposalPosition);
            const firstProposalProgress = !proposalProgressStarted;
            proposalProgressStarted = true;
            await paintSharedPlanProgress(firstProposalProgress || proposalPosition === orderedIds.length);
            try {
                // Refuse unrelated holders in memory, then use the direct one-boundary materializer for
                // every shared member. The old non-coordinated path first marked state in one full-map
                // transaction and then replay-applied in a second; neither extra snapshot nor the
                // explicit-Apply supersession path belongs to opening a plan link.
                if (!coordinatedPlanIdOfSharedRecord(record)
                    && ProposalManager && typeof ProposalManager.validateSharedProposalGround === 'function') {
                    const validation = ProposalManager.validateSharedProposalGround(
                        id,
                        planMemberIds,
                        preexistingAppliedRecords
                    );
                    if (!validation || validation.ok !== true) {
                        failedIds.push(id);
                        index += 1;
                        continue;
                    }
                }
                const applyOptions = { replay: true, silent: true, deferPresentation: true };
                const demolition = await demolitionFor(id);
                if (demolition.covered) applyOptions.preloadedBuildings = demolition.features;
                const ok = await ProposalManager.applyProposal(id, applyOptions);
                if (ok) appliedIds.push(id);
                else failedIds.push(id);
            } catch (error) {
                console.error('[shared-apply] scoped apply failed', id, error);
                failedIds.push(id);
            }
            index += 1;
        }
    } finally {
        // Every handler has updated the canonical arrays and live parcel fabric, but deliberately
        // skipped list/style/layer presentation. Flush the complete view once, even after a failed
        // member, so partial-success plans never leave stale UI behind.
        reportSharedPlanProgress({ phase: 'presentation' });
        await paintSharedPlanProgress(true);
        const presentationStarted = now();
        try {
            if (ProposalManager && typeof ProposalManager._refreshUIAfterProposalChange === 'function') {
                ProposalManager._refreshUIAfterProposalChange(null);
            }
        } catch (error) {
            console.error('[shared-apply] final presentation refresh failed', error);
        }
        presentationMs = now() - presentationStarted;

        reportSharedPlanProgress({ phase: 'save' });
        await paintSharedPlanProgress(true);
        const storageStarted = now();
        try {
            // Imports may have suppressed their own save. Ensure the outer batch has one pending
            // write even if every queued member was refused before reaching a type handler.
            if (batchStore && typeof batchStore.save === 'function') batchStore.save();
        } finally {
            if (storageBatched) batchStore.endBatch();
        }
        storageMs = now() - storageStarted;

        const ground = (ProposalManager && ProposalManager._lastReplayGroundProfile) || {};
        const demolition = (ProposalManager && ProposalManager._lastDemolitionPrefetchProfile) || {};
        const profile = {
            members: orderedIds.length,
            applied: appliedIds.length,
            failed: failedIds.length,
            proposalBatchRequests: Number(options.recordFetchProfile?.batchRequests) || 0,
            proposalIndividualRequests: Number(options.recordFetchProfile?.individualRequests) || 0,
            proposalBatchSupported: options.recordFetchProfile?.batchSupported === true,
            holderCandidates: Array.isArray(preexistingAppliedRecords) ? preexistingAppliedRecords.length : null,
            groundCoveredMembers: Number(ground.coveredMembers) || 0,
            groundFetchedMembers: Number(ground.fetchedMembers) || 0,
            groundRequests: Number(ground.requests) || 0,
            demolitionRegions: Number(demolition.regions) || 0,
            demolitionRequests: Number(demolition.requests) || 0,
            demolitionFallbacks: Number(demolition.fallbackRegions) || 0,
            presentationMs,
            storageMs,
            totalMs: now() - started
        };
        try { if (ProposalManager) ProposalManager._lastSharedApplyProfile = profile; } catch (_) { }
        console.info('[shared-apply] profile', profile);
    }
    return { appliedIds, failedIds };
}

// Enter URL-driven 3D framed on `focusIds`, waiting (capped) until at least one of those
// proposals has a materialized building feature. Entering the instant the route decides
// raced hydration/reapply: the focus subset matched nothing yet, and the camera silently
// fell back to framing EVERY applied proposal.
// A proposal that has no BUILDINGS can never satisfy a wait for proposedBuildings. A road or a
// structure link therefore sat out the whole 8 s deadline before 3D opened — measured at 9 s on
// prod for /proposals/95 — with nothing on screen to explain it. Waiting is only meaningful for
// building proposals; anything else is ready as soon as it is applied.
function urlFocusNeedsBuildings(ids) {
    try {
        const all = (typeof proposalStorage !== 'undefined' && proposalStorage.getAllProposals)
            ? proposalStorage.getAllProposals() : [];
        const focused = all.filter(p => {
            const key = String((typeof getProposalKey === 'function' ? getProposalKey(p) : null)
                || p.proposalId || p.serverProposalId || '');
            return ids.includes(key) || ids.includes(String(p.serverProposalId || ''));
        });
        // Unknown to storage yet: keep the old behaviour and wait.
        if (!focused.length) return true;
        return focused.some(p => p && p.buildingProposal);
    } catch (_) {
        return true;
    }
}

function enterUrlDrivenViewWhenReady(focusIds) {
    const ids = (Array.isArray(focusIds) ? focusIds : []).filter(Boolean).map(String);
    const deadline = Date.now() + 8000;
    const attempt = () => {
        let ready = ids.length === 0 || !urlFocusNeedsBuildings(ids);
        try {
            const feats = (typeof window !== 'undefined' && Array.isArray(window.proposedBuildings))
                ? window.proposedBuildings : [];
            ready = ready || feats.some(f => f && f.properties && ids.includes(String(f.properties.proposalId)));
        } catch (_) { ready = true; }
        if (ready || Date.now() > deadline) {
            enterUrlDrivenView(ids.length ? ids : undefined);
            return;
        }
        setTimeout(attempt, 200);
    };
    attempt();
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

        const ground = getSharedGroundService();
        if (!ground || typeof ground.ensureProposalGround !== 'function') {
            throw new Error('Cadastral ground service is unavailable.');
        }
        await ground.ensureProposalGround([normalized], { purpose: 'application' });

        parkProposalForImport(normalized);
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

        if (suppressedHere) {
            try {
                window.suppressCameraMoves = false;
                suppressedHere = false;
            } catch (_) { }
        }

        await preloadProposalParcelOwners(stored.cadastreParcelIds, { forceRefresh: true });

        const focusParcelId = Array.isArray(stored.cadastreParcelIds) ? stored.cadastreParcelIds[0] : null;
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

// §11's first rung — replay fidelity. After a shared apply, verify each proposal takes the SAME
// ground here as when it was published: the stamped ownership flow against one re-derived from
// the receiver's live cadastre. A green apply proves the mechanics ran, not that the effect
// reproduced (invariant #5) — a different cadastre vintage or a missing sibling formation shows
// up as a flow difference, and that is a fact the user should see, not a silent divergence.
// Returns [{ id, title, diff }]; detail goes to the console, the summary shows one line.
function collectRebasedSharedProposals(appliedIds) {
    try {
        const flowApi = (typeof window !== 'undefined') ? window.__ownershipFlow : null;
        const ancestry = (typeof window !== 'undefined') ? window.__cadastreAncestry : null;
        if (!flowApi || !ancestry || typeof flowApi.compareOwnershipFlows !== 'function') return [];
        const knownParcelIds = new Set(ancestry.loadedCadastreParcels().map(entry => String(entry.id)));
        const rebased = [];
        (Array.isArray(appliedIds) ? appliedIds : []).forEach(id => {
            const stored = (typeof getProposalByIdOrHash === 'function')
                ? getProposalByIdOrHash(id)
                : ((typeof proposalStorage !== 'undefined' && proposalStorage.getProposal) ? proposalStorage.getProposal(id) : null);
            if (!stored || !Array.isArray(stored.ownershipFlow) || !stored.ownershipFlow.length) return;
            const live = ancestry.computeOwnershipFlow(stored);
            const diff = flowApi.compareOwnershipFlows(stored.ownershipFlow, live, { knownParcelIds });
            if (!diff.same) rebased.push({ id: String(id), title: stored.title || String(id), diff });
        });
        if (rebased.length) {
            console.info('[shared-apply] re-based: these take different ground here than when published', rebased);
        }
        return rebased;
    } catch (error) {
        console.warn('[shared-apply] replay-fidelity check failed', error);
        return [];
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
            updateStatus(`Preparing ${proposals.length} shared proposal${proposals.length === 1 ? '' : 's'}...`);
        }

        // Declare the records themselves, not their bounding box. The service chooses registry,
        // in-flight, negative-cache, id transport, or footprint transport for each one.
        const normalizedForGround = proposals.map(proposal => {
            try { return prepareProposalForImport(proposal); } catch (_) { return null; }
        }).filter(Boolean);
        const ground = getSharedGroundService();
        if (!ground || typeof ground.ensureProposalGround !== 'function') {
            throw new Error('Cadastral ground service is unavailable.');
        }
        await ground.ensureProposalGround(normalizedForGround, { purpose: 'application' });

        // Same single-flight restore barrier as handleSharedPlanRoute. Do not inspect applied
        // flags to decide whether to wait: ordered replay deliberately clears them mid-pass.
        if (typeof ProposalManager !== 'undefined'
            && typeof ProposalManager.reapplyAppliedProposals === 'function') {
            await ProposalManager.reapplyAppliedProposals();
        }

        const t = getProposalI18nHelper();
        const tShare = getShareI18nHelper();

        // The same immutable order drives imports and every later replay. No geometry or map state
        // participates, so loading tiles cannot reshuffle the plan.
        const sorted = (typeof window !== 'undefined' && window.__planOrder
            && typeof window.__planOrder.orderFormations === 'function')
            ? window.__planOrder.orderFormations(proposals)
            : proposals.slice().sort((a, b) => {
                const at = Date.parse(a?.createdAt) || 0;
                const bt = Date.parse(b?.createdAt) || 0;
                return at - bt || String(a?.proposalId || '').localeCompare(String(b?.proposalId || ''), undefined, { numeric: true });
            });

        // Position of each proposal in the sorted payload (oldest-first), so the view can end
        // up framing the most recently created loaded proposal.
        const payloadOrder = new Map();
        sorted.forEach((p, idx) => {
            [getProposalKey(p), p.proposalId].forEach(key => {
                if (key) payloadOrder.set(String(key), idx);
            });
        });

        const actuallyApplied = [];
        const skipped = [];
        const failures = [];
        let lastLoadedProposalIdFor3D = null;

        // ONE ordered pass (A6). Records are flat and the ground a formation consumes resolves
        // geometrically at apply time (§15a), so there is nothing a requeue lap could discover:
        // a member that cannot apply is a loud failure with its reason, never healed.
        for (let proposalIndex = 0; proposalIndex < sorted.length; proposalIndex += 1) {
            const proposal = sorted[proposalIndex];
            try {
                if (typeof updateStatus === 'function') {
                    const displayId = proposal.proposalId ? String(proposal.proposalId) : '?';
                    const label = proposal.title || `#${displayId}`;
                    updateStatus(tShare('plan.preparingNamed',
                        'Preparing {{label}} ({{done}}/{{total}})…', {
                            label,
                            done: proposalIndex + 1,
                            total: sorted.length
                        }));
                }
            } catch (_) { }

            const result = await importAndApplySharedProposal(proposal, {
                deferSave: true,
                skipDependencyFetch: true
            });
            const proposalId = (result && result.proposalId) || getProposalKey(proposal) || proposal.proposalId;

            if (result && result.skipped) {
                skipped.push(proposalId);
                if (proposalId) lastLoadedProposalIdFor3D = proposalId;
                continue;
            }

            if (result && result.applied) {
                actuallyApplied.push(proposalId);
                if (proposalId) lastLoadedProposalIdFor3D = proposalId;
                continue;
            }

            failures.push(proposalId || proposal.proposalId || '');
        }

        if (actuallyApplied.length > 0) {
            const payloadPlanMemberIds = new Set();
            sorted.forEach(record => {
                [getProposalKey(record), record && record.proposalId, record && record.serverProposalId]
                    .filter(Boolean)
                    .forEach(id => payloadPlanMemberIds.add(String(id)));
            });
            const scoped = await materializeQueuedSharedProposals(actuallyApplied, {
                planMemberIds: payloadPlanMemberIds
            });
            const scopedFailures = new Set(scoped.failedIds.map(String));
            for (let i = actuallyApplied.length - 1; i >= 0; i -= 1) {
                if (!scopedFailures.has(String(actuallyApplied[i]))) continue;
                failures.push(actuallyApplied[i]);
                actuallyApplied.splice(i, 1);
            }
        }

        if (actuallyApplied.length > 0 || skipped.length > 0 || failures.length > 0) {
            if (typeof updateProposalLayer === 'function') {
                updateProposalLayer();
            }
            if (typeof updateShowProposalsButton === 'function') {
                updateShowProposalsButton();
            }

            // Center map on the most recently loaded proposal (latest in payload order among
            // applied and skipped-as-duplicate), framed as if it had been loaded alone:
            // fit its current derived bounds and open its details panel.
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
                    const bounds = calculateBoundsForLastAppliedProposal(lastProposalId);
                    if (bounds && bounds.isValid && bounds.isValid()) {
                        map.fitBounds(bounds, { padding: [80, 80], maxZoom: 18 });
                    }
                    if (typeof focusProposalDetails === 'function') {
                        await focusProposalDetails(lastProposalId, {
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
                    count: actuallyApplied.length
                })}</p>`);
                const rebased = collectRebasedSharedProposals(actuallyApplied);
                if (rebased.length) {
                    const escapeRebased = typeof escapeHtml === 'function' ? escapeHtml : (v => v);
                    bodyLines.push(`<p class="shared-plan-rebased">${tShare('rebased',
                        '{{count}} of them take different ground here than when published: {{titles}} (details in the console).', {
                            count: rebased.length,
                            titles: rebased.map(r => escapeRebased(r.title)).join(', ')
                        })}</p>`);
                }
            }
            if (skipped.length > 0) {
                bodyLines.push(`<p>${tShare('summary.skippedCount', 'Skipped {{count}} duplicate proposals (already present).', {
                    count: skipped.length
                })}</p>`);
            }
            if (failures.length > 0) {
                bodyLines.push(`<p>${tShare('summary.failedCount', '{{count}} failed.', {
                    count: failures.length
                })}</p>`);
                // Name them, with the gate's own words. "3 failed." with no titles and no reason
                // left a plan that was visibly missing its readjustment looking like a lost record
                // rather than a refused one — every reason already existed, it just never surfaced.
                const escape = typeof escapeHtml === 'function' ? escapeHtml : (v => String(v));
                const failureItems = failures.map(id => {
                    const record = (typeof proposalStorage !== 'undefined' && proposalStorage
                        && typeof proposalStorage.getProposal === 'function') ? proposalStorage.getProposal(id) : null;
                    const title = (record && (record.title || record.name)) || String(id || '');
                    const reason = (typeof ProposalManager !== 'undefined' && ProposalManager
                        && typeof ProposalManager.getLastApplyFailure === 'function')
                        ? ProposalManager.getLastApplyFailure(id) : null;
                    return `<li>${escape(title)}${reason ? ` — ${escape(reason)}` : ''}</li>`;
                }).filter(Boolean);
                if (failureItems.length) {
                    bodyLines.push(`<ul class="shared-plan-failures">${failureItems.join('')}</ul>`);
                }
            }
            showSimpleShareModal({
                title: tShare('summary.title', 'Applied Shared Proposals'),
                body: bodyLines.join(''),
                actions: [
                    { label: t('modal.common.close', 'Close'), primary: true },
                    ...(actuallyApplied.length > 0 ? [{
                        label: tShare('summary.unapplyApplied', 'Unapply applied'),
                        onClick: async () => {
                            try {
                                actuallyApplied.forEach(hash => {
                                    const record = proposalStorage.getProposal(hash);
                                    if (!record) return;
                                    if (typeof setProposalApplied === 'function') {
                                        setProposalApplied(record, false, { stamp: false });
                                    } else {
                                        record.applied = false;
                                    }
                                });
                                proposalStorage.save?.();
                                await ProposalManager.rebuildAppliedFabric();
                                ProposalManager._refreshUIAfterProposalChange?.(null);
                            } catch (_) { }
                        }
                    }] : [])
                ]
            });

            // Nothing was loaded (only failures): firmly return to parcel-mode
            // hover/leave behavior. When a proposal was loaded we keep its highlight and
            // details panel, matching the single shared-proposal flow.
            if (!lastProposalId) {
                try { clearProposalInfoHoverOverlay(); } catch (_) { }
                try { clearProposalHighlights(); } catch (_) { }
                try { if (typeof setParcelNumberLabelFilter === 'function') setParcelNumberLabelFilter(null); } catch (_) { }
            }
        }

        if (failures.length > 0 && typeof showEphemeralMessage === 'function') {
            showEphemeralMessage(t('ephemeral.messages.failed_to_apply_shared_proposals_summary', `Unable to apply ${failures.length} shared proposal${failures.length === 1 ? '' : 's'}.`, {
                count: failures.length
            }), 6000, 'error');
        }

        // Optional URL-driven 3D mode: after shared apply completes, enter 3D framed on THIS
        // link's proposals only.
        try {
            if (!url3DModeHandled && is3DModeRequestedFromUrl()) {
                // Wait for map centering to complete (if we centered on proposals above)
                const allProposalIds = [...actuallyApplied, ...skipped].filter(Boolean);
                if (allProposalIds.length > 0) {
                    await createLeafletViewSettlePromise(null, null);
                }
                // Pass the link's LOCAL proposal ids as the 3D focus — without them the camera
                // framed the union of every applied proposal (this is the path every fresh
                // download of a shared link takes; the already-applied fast paths pass ids).
                url3DModeHandled = true;
                enterUrlDrivenViewWhenReady(allProposalIds);
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

    let existing = proposalStorage.getProposal(normalized.proposalId);
    if (existing && isProposalCurrentlyApplied(existing)) {
        try { if (typeof syncProposalsIndicator === 'function') syncProposalsIndicator(); } catch (_) { }
        return { applied: false, skipped: true, proposalId, reason: 'Already applied' };
    }

    const skipDependencyFetch = options && options.skipDependencyFetch === true;
    let parentIds = [];
    if (!skipDependencyFetch) {
        try {
            parentIds = ensureArrayOfStrings(computeRequiredParentIdsForSharedProposal(sharedProposal));
            const ground = getSharedGroundService();
            if (!ground || typeof ground.ensureProposalGround !== 'function') {
                throw new Error('Cadastral ground service is unavailable.');
            }
            await ground.ensureProposalGround([normalized], { purpose: 'application' });
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

    // A parked local copy may be an older server snapshot left by an interrupted/partial package
    // apply. Replace it too; otherwise the route repairs its order but faithfully replays stale
    // road and readjustment geometry forever. Applied records returned above remain untouched.
    // Import and the parked-state adjustment below are one record mutation. Suppress the storage
    // write here so a standalone import persists once after both changes, while a shared-plan
    // caller can defer all members to the plan's single batch commit.
    existing = proposalStorage.importProposal(normalized, { overwrite: true, deferSave: true });
    if (!existing) return { applied: false, skipped: false, proposalId, reason: 'Failed to import proposal' };

    // Import changes records only. Keep every queued member parked until the complete ordered set
    // is present; the caller then sends them through the direct scoped materializer one by one.
    // Pre-marking them made later members look as if they already stood on the map, and forced the
    // caller to rebuild every unrelated local proposal merely to materialise this queue.
    if (typeof setProposalApplied === 'function') setProposalApplied(existing, false, { stamp: false });
    else existing.applied = false;
    proposalStorage._indexProposal?.(existing);
    if (options.deferSave !== true) proposalStorage.save?.();
    return { applied: true, skipped: false, proposalId: existing.proposalId || proposalId, queued: true };
}

// Reads the shared proposal's own `city` and, when it disagrees with the city on screen, hands the
// decision to the user. Returns true when the caller must stop: either we are reloading into the
// other city, or the user chose to stay and the route was dropped. Never blocks on legacy proposals
// that predate the `city` stamp, nor on a server that cannot be reached — those fall through to the
// existing behaviour rather than stranding the user on a dialog.
async function fetchSharedProposalBatch(ids, backendBase) {
    const requested = Array.from(new Set((Array.isArray(ids) ? ids : [])
        .map(id => String(id || '').trim()).filter(Boolean)));
    const records = new Map();
    const missing = new Set();
    if (!requested.length) return { records, missing, supported: true, requests: 0 };
    try {
        const response = await fetch(`${backendBase}/proposals/batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ ids: requested })
        });
        if (!response.ok) return { records, missing, supported: false, requests: 1 };
        const payload = await response.json();
        if (!payload || !Array.isArray(payload.items)) return { records, missing, supported: false, requests: 1 };
        const seen = new Set();
        payload.items.forEach(item => {
            const id = item && item.id !== undefined && item.id !== null ? String(item.id) : '';
            if (!id) return;
            seen.add(id);
            if (item.proposal) records.set(id, item.proposal);
            else missing.add(id);
        });
        return { records, missing, supported: requested.every(id => seen.has(id)), requests: 1 };
    } catch (error) {
        console.warn('[shared-plan] batch proposal fetch unavailable; falling back', error);
        return { records, missing, supported: false, requests: 1 };
    }
}

async function sharedProposalCityBlocksLoad(firstProposalId, prefetchedPayload = null) {
    // Returns { blocked, payload }. Measured: this fetch (of the WHOLE proposal, just to read its
    // .city) was the biggest single cost on a shared-link open, and the apply loop then fetched the
    // very same proposal a SECOND time. Hand the payload back so the caller can reuse it — one fetch
    // instead of two. `blocked` is true only when the user chose to stay in the other city.
    if (!firstProposalId) return { blocked: false, payload: null, requestMade: false };
    let payload = prefetchedPayload || null;
    let requestMade = false;
    try {
        if (!payload) {
            const backendBase = resolveBackendBaseUrl();
            requestMade = true;
            const response = await fetch(`${backendBase}/proposals/${encodeURIComponent(firstProposalId)}`);
            if (!response.ok) return { blocked: false, payload: null, requestMade };
            payload = await response.json();
        }
        if (typeof promptCityMismatchForProposal !== 'function') return { blocked: false, payload, requestMade };
        const proposalCityId = payload && (payload.city || (payload.proposal_data && payload.proposal_data.city));
        if (!proposalCityId) return { blocked: false, payload, requestMade };
        const blocked = await promptCityMismatchForProposal(String(proposalCityId));
        return { blocked, payload, requestMade };
    } catch (error) {
        console.warn('[sharedProposalCityBlocksLoad] Could not determine the proposal city:', error);
        return { blocked: false, payload, requestMade };
    }
}

async function handleSharedPlanRoute(idParts, attempt = 0, options = {}) {
    try {
        const t = getProposalI18nHelper();
        const tShare = getShareI18nHelper();

        console.log('[handleSharedPlanRoute] Starting with IDs:', idParts, 'attempt:', attempt);

        if (typeof map === 'undefined' || !map) {
            if (attempt < 15) {
                console.log('[handleSharedPlanRoute] Map not ready, retrying... attempt:', attempt);
                setTimeout(() => handleSharedPlanRoute(idParts, attempt + 1, options), 400);
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

        // Import the complete flat record set, prefetch its base cadastral anchors, then replay it
        // once. Derived ids are invalid transport data and are never prerequisites.
        const normalizeId = (raw) => {
            const s = (raw !== undefined && raw !== null) ? String(raw).trim() : '';
            return s;
        };

        const uniqueIncomingIds = Array.from(new Set(idParts.map(normalizeId).filter(Boolean)));
        const totalProposals = uniqueIncomingIds.length;
        const firstProposalId = uniqueIncomingIds[0];

        // Show the overlay BEFORE the city check: that check fetches the first proposal (the slowest
        // single step on a shared-link open), and it used to run with a frozen, feedback-less screen.
        console.log('[handleSharedPlanRoute] Showing load overlay and fetching proposals...', { totalProposals });
        showProposalLoadOverlay(tShare('plan.fetchingPlan', 'Fetching plan…'), {
            total: totalProposals,
            title: tShare('plan.fetchingPlanTitle', 'Fetching proposal')
        });

        const backendBase = resolveBackendBaseUrl();
        const batchRecords = await fetchSharedProposalBatch(uniqueIncomingIds, backendBase);
        const recordFetchProfile = {
            batchRequests: batchRecords.requests,
            individualRequests: 0,
            batchSupported: batchRecords.supported
        };

        // The ?city= param is only a hint the sharer's browser attached; it can be absent or lost.
        // The proposal itself knows which city it belongs to, so ask before applying it to whatever
        // map happens to be on screen. The fetched payload is reused below (see prefetchedFirst) so
        // the apply loop does not fetch this same proposal again.
        const cityCheck = await sharedProposalCityBlocksLoad(firstProposalId, batchRecords.records.get(firstProposalId));
        if (cityCheck.requestMade) recordFetchProfile.individualRequests += 1;
        if (cityCheck.blocked) {
            console.log('[handleSharedPlanRoute] Aborting: proposal belongs to another city.');
            hideProposalLoadOverlay();
            return { applied: [], skipped: [], failed: [], blocked: true };
        }
        const prefetchedFirst = cityCheck.payload || null;

        const applied = [];
        const skipped = [];
        const failed = [];

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
        const getCadastrePrerequisiteIds = (proposal) => {
            if (!proposal || typeof proposal !== 'object') return [];
            const normalized = (typeof canonicalizeProposalCadastreAnchors === 'function')
                ? canonicalizeProposalCadastreAnchors(proposal)
                : proposal;
            const claims = (typeof window !== 'undefined') ? window.__claims : null;
            if (!claims || typeof claims.cadastreParcelIdsOf !== 'function') {
                throw new Error('Proposal cadastre claims service is unavailable.');
            }
            return claims.cadastreParcelIdsOf(normalized);
        };
        let queue = idParts.map(normalizeId).filter(Boolean);
        // Position of each id in the link. Share URLs list proposals oldest-first, so the
        // highest position is the most recently created proposal — the one the view should
        // end up framing, exactly as if it had been loaded alone.
        const linkOrder = new Map();
        queue.forEach((id, idx) => linkOrder.set(id, idx));
        // The /proposals/... path is the canonical share state and STAYS in the address bar:
        // a refresh re-enters through the already-applied fast path, so stripping it (the old
        // cleanPlanUrl) only broke refresh and re-sharing from the URL bar.
        updateProposalLoadOverlay({ progress: { done: fetchProgressIds.size, total: totalProposals } });
        const loadedById = new Map();
        batchRecords.records.forEach((proposal, id) => loadedById.set(id, proposal));
        // Reuse the proposal the city check already fetched — keyed by the same normalized id the
        // apply loop shifts off the queue — so the loop's `if (!proposal)` fetch is skipped for it.
        if (prefetchedFirst && firstProposalId) loadedById.set(firstProposalId, prefetchedFirst);
        const proposalTypeById = new Map();
        const lastMissingCadastrePrereqIdsById = new Map();
        const groundService = getSharedGroundService();
        if (!groundService || typeof groundService.ensureIds !== 'function') {
            throw new Error('Cadastral ground service is unavailable.');
        }

        // Wait for PersistentStorage to be ready before checking local proposals.
        if (typeof PersistentStorage !== 'undefined' && PersistentStorage && typeof PersistentStorage.ensureReady === 'function') {
            await new Promise(resolve => PersistentStorage.ensureReady(resolve));
        }

        // Ensure previously-applied proposals have finished re-materializing before we analyse
        // conflicts OR synchronize an incoming snapshot onto a local record. The replay is an
        // ordered fold and temporarily marks its whole target set unapplied; testing "is anything
        // applied?" here therefore races with the exact interval this barrier exists to protect.
        // `reapplyAppliedProposals` is single-flight and returns its in-flight promise, so always
        // await it. A reload is a reader of the completed fabric, never a concurrent apply pass.
        if (typeof ProposalManager !== 'undefined' && typeof ProposalManager.reapplyAppliedProposals === 'function') {
            updateProposalLoadOverlay({
                title: tShare('plan.rebuildingPlanTitle', 'Rebuilding applied plan'),
                status: tShare('plan.rebuildingPlan', 'Replaying its formations from the cadastre…')
            });
            await ProposalManager.reapplyAppliedProposals({ onProgress: reportSharedPlanProgress });
        }

        const urlRequests3D = is3DModeRequestedFromUrl();

        // Analyze what's currently applied vs what's incoming
        const incomingIds = new Set(queue.map(normalizeId).filter(Boolean));
        let incomingAlreadyApplied = [];

        console.log('[handleSharedPlanRoute] Incoming IDs from URL:', Array.from(incomingIds));

        // proposalIds identifying THIS link's proposals, so 3D entry frames only them (not a big
        // cached proposal elsewhere). Read lazily — loadedById fills in during apply. Include the
        // server id and the payload's proposalId/serverProposalId to match whatever the proposed
        // building features carry; if none match, computeProposalQueryGeometry falls back to all.
        const getFocusProposalIds = () => {
            const ids = [];
            for (const serverId of incomingIds) {
                if (serverId) ids.push(String(serverId));
                const payload = loadedById.get(serverId);
                if (payload) {
                    if (payload.proposalId) ids.push(String(payload.proposalId));
                    if (payload.serverProposalId) ids.push(String(payload.serverProposalId));
                }
            }
            // A linked proposal that was ALREADY applied locally never enters loadedById — its
            // features carry the LOCAL proposalId, so resolve the incoming server ids against
            // the store too. Without this the focus set matches nothing and 3D entry silently
            // falls back to framing EVERY applied proposal, not just the link's.
            try {
                if (typeof proposalStorage !== 'undefined' && proposalStorage) {
                    (proposalStorage.getAllProposals() || []).forEach(p => {
                        if (!p || !p.proposalId) return;
                        const candidates = [
                            p.serverProposalId != null ? String(p.serverProposalId) : null,
                            String(p.proposalId),
                            (typeof getServerProposalId === 'function' && getServerProposalId(p) != null)
                                ? String(getServerProposalId(p)) : null
                        ];
                        if (candidates.some(id => id && incomingIds.has(id))) {
                            ids.push(String(p.proposalId));
                        }
                    });
                }
            } catch (_) { }
            return ids;
        };

        // Ids each proposal answers to — its own, PLUS, for a replacement snapshot, every id
        // along its replacement chain. An edited road keeps its share-link identity: the URL
        // names the SOURCE while the fabric holds the replacement, and without the chain a
        // reload re-applied the source next to its own replacement (two "Road 2043" standing).
        const coveredIncomingIds = new Set();
        if (typeof proposalStorage !== 'undefined' && proposalStorage) {
            const allProposals = proposalStorage.getAllProposals() || [];
            const byKey = new Map();
            allProposals.forEach(p => { if (p && p.proposalId) byKey.set(String(p.proposalId), p); });

            const idsAnsweredBy = (proposal) => {
                const out = [];
                const push = value => {
                    if (value === undefined || value === null) return;
                    const key = String(value);
                    if (key) out.push(key);
                };
                const seen = new Set();
                let current = proposal;
                let hops = 0;
                while (current && hops < 10) {
                    push(current.serverProposalId);
                    push(current.proposalId);
                    try { push(typeof getServerProposalId === 'function' ? getServerProposalId(current) : null); } catch (_) { }
                    const prevKey = current.replacementOfProposalId || current.sourceProposalId || null;
                    if (!prevKey || seen.has(String(prevKey))) break;
                    seen.add(String(prevKey));
                    push(prevKey);
                    current = byKey.get(String(prevKey)) || null;
                    hops += 1;
                }
                return out;
            };

            allProposals.forEach(p => {
                if (!isProposalCurrentlyApplied(p)) return;
                const matched = idsAnsweredBy(p).filter(id => incomingIds.has(id));
                if (matched.length) {
                    incomingAlreadyApplied.push(p);
                    matched.forEach(id => coveredIncomingIds.add(id));
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

        // What is already on the map STAYS on the map. A partly applied plan used to be torn down
        // and rebuilt from scratch — every standing member unapplied one at a time, then the whole
        // plan re-applied — on the reasoning that the remainder would otherwise be tested against
        // stale ground. The cost was out of all proportion to that, and it could not converge: one
        // member that can never apply (an unalignable park) leaves the plan permanently "partly
        // applied", so EVERY re-open unapplied 298 members to re-derive the same 298. Measured.
        //
        // Now the already-applied members are simply skipped by the filter below and only what is
        // missing is attempted. The one thing this gives up is that a member applied locally will
        // not pick up a repaired server definition on re-open; unapplying it explicitly still will.

        // Counted over COVERED incoming ids, not list length — with a source and its
        // replacement both standing, the list double-counts one member.
        const allIncomingApplied = coveredIncomingIds.size === totalProposals;

        console.log('[handleSharedPlanRoute] Applied-state analysis:',
            'totalProposals=' + totalProposals,
            'incomingAlreadyApplied=' + incomingAlreadyApplied.length,
            'allIncomingApplied=' + allIncomingApplied
        );

        // Helper: focus on applied proposals — frame and open them the same way a
        // single-proposal link would (center on its current derivation + details panel).
        // Move the camera to the plan and open its details. Separate from the 3D advance below so
        // it can run unconditionally: framing is what a link to a proposal is FOR, and it is not a
        // decision the user needs to confirm.
        const frameAppliedProposals = async (proposalIdToFocus) => {
            if (!proposalIdToFocus || typeof map === 'undefined' || !map) return;
            try {
                const bounds = calculateBoundsForLastAppliedProposal(proposalIdToFocus);
                if (bounds && bounds.isValid && bounds.isValid()) {
                    map.fitBounds(bounds, { padding: [80, 80], maxZoom: 18 });
                }
                if (typeof focusProposalDetails === 'function') {
                    await focusProposalDetails(proposalIdToFocus, {
                        centerOnProposal: false,
                        showDetails: true
                    });
                }
            } catch (err) {
                console.warn('[handleSharedPlanRoute] Failed to focus on applied proposal:', err);
            }
        };

        const focusOnAppliedProposals = async (proposalIdToFocus) => {
            hideProposalLoadOverlay();
            await frameAppliedProposals(proposalIdToFocus);
            if (urlRequests3D) {
                try { url3DModeHandled = true; enterUrlDrivenViewWhenReady(getFocusProposalIds()); } catch (_) { }
            }
        };

        // Plan already fully applied.
        // → "Plan Already Applied [Show me] [OK]"
        if (allIncomingApplied) {
            hideProposalLoadOverlay();
            const lastApplied = mostRecentIncomingApplied() || incomingAlreadyApplied[0];
            const focusId = lastApplied ? (lastApplied.proposalId || lastApplied.serverProposalId) : null;
            // Go there FIRST. Reloading a proposal link used to leave the map wherever it opened —
            // usually the city centre — because the only thing that moved the camera was the
            // "Show me" button on this dialog. Opening the link is already the request to see it;
            // the dialog just explains why nothing needed applying.
            await frameAppliedProposals(focusId);
            if (options.suppressSummary) {
                return {
                    applied: [],
                    skipped: incomingAlreadyApplied.map(proposal => ({
                        id: proposal.proposalId || proposal.serverProposalId,
                        label: formatSharedProposalLabel(proposal, proposal.proposalId || proposal.serverProposalId)
                    })),
                    failed: []
                };
            }
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
            return { applied: [], skipped: incomingAlreadyApplied, failed: [] };
        }

        // Build set of already-applied server IDs to exclude from queue — including members
        // covered through a replacement chain (the replacement itself has no server id).
        const alreadyAppliedServerIds = new Set(coveredIncomingIds);
        incomingAlreadyApplied.forEach(p => {
            if (p.serverProposalId) alreadyAppliedServerIds.add(String(p.serverProposalId));
            const extracted = typeof getServerProposalId === 'function' ? getServerProposalId(p) : null;
            if (extracted) alreadyAppliedServerIds.add(String(extracted));
        });

        // Queue only proposals that are NOT already applied (deduplicated). The excluded ones
        // still count as skipped-duplicates in the summary — otherwise a reload that skips the
        // whole plan reports "Skipped 7" with the eighth member silently unaccounted for.
        queue = Array.from(new Set(idParts.map(normalizeId).filter(id => {
            if (!id) return false;
            if (alreadyAppliedServerIds.has(id)) {
                console.log('[handleSharedPlanRoute] Skipping already-applied proposal:', id);
                const local = incomingAlreadyApplied.find(p => p && (
                    (p.serverProposalId && String(p.serverProposalId) === id)
                    || (typeof getServerProposalId === 'function' && String(getServerProposalId(p) || '') === id)));
                skipped.push({ id, label: formatSharedProposalLabel(local, (local && local.proposalId) || id) });
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
            return { applied: [], skipped, failed: [] };
        }

        // Fetch every record once, then use the same immutable record order as canonical replay.
        try {
            if (typeof window !== 'undefined' && window.__planOrder && queue.length > 1) {
                await Promise.all(queue.map(async (qid) => {
                    if (loadedById.has(qid)) return;
                    if (batchRecords.supported && batchRecords.missing.has(qid)) return;
                    try {
                        recordFetchProfile.individualRequests += 1;
                        const resp = await fetch(`${backendBase}/proposals/${encodeURIComponent(qid)}`);
                        if (resp.ok) loadedById.set(qid, await resp.json());
                    } catch (_) { /* the apply loop retries and reports this id itself */ }
                }));
                const items = queue.map(qid => {
                    const payload = loadedById.get(qid);
                    return payload
                        ? { ...payload, key: qid, serverProposalId: payload.serverProposalId || qid }
                        : { key: qid, serverProposalId: qid, createdAt: null };
                });
                if (typeof window.__planOrder.orderFormations === 'function') {
                    queue = window.__planOrder.orderFormations(items).map(item => String(item.key));
                    console.log('[handleSharedPlanRoute] Immutable apply order:', queue);
                }
            }
        } catch (orderError) {
            console.warn('[handleSharedPlanRoute] Record ordering failed; keeping link order', orderError);
        }

        // One union prefetch for the whole plan: every preloaded proposal's
        // declared cadastral anchors start downloading in one batched chain up
        // front, so the per-proposal awaits inside the loop find them fetched
        // or in flight instead of paying one serial round-trip chain per
        // proposal. Proposals whose payload was not preloaded (single-proposal
        // links, fetch failures) still fetch their bases in the loop as before.
        try {
            const unionCadastreIds = [];
            for (const qid of queue) {
                const payload = loadedById.get(qid);
                if (!payload) continue;
                unionCadastreIds.push(...getCadastrePrerequisiteIds(payload));
            }
            if (unionCadastreIds.length > 0) {
                groundService.ensureIds(unionCadastreIds, { onProgress: reportSharedPlanProgress }).catch(err => {
                    console.warn('[handleSharedPlanRoute] Union cadastral-ground load failed', err);
                });
            }
        } catch (err) {
            console.warn('[handleSharedPlanRoute] Union cadastral-ground prefetch failed; per-proposal loads cover it', err);
        }

        // Judge the WHOLE plan from its records before applying any of it. The apply already
        // refuses in ~30 named ways, but it does so one member at a time after the expensive setup,
        // so a plan of 299 learns at member 140 that member 140 was never applicable. Blocked
        // members are reported at the end alongside real failures — the clear ones still apply,
        // which is the point: one unusable record must not cost the other 298.
        //
        // The precheck is deliberately conservative and defers to the apply whenever it is unsure,
        // so this can only ever skip work the apply would itself have refused.
        try {
            const validator = (typeof window !== 'undefined') ? window.__applyValidate : null;
            const routeApi = (typeof window !== 'undefined') ? window.__applyRoute : null;
            if (validator && typeof validator.validatePlan === 'function') {
                const report = validator.validatePlan(
                    queue.map(qid => ({ proposalId: qid, record: loadedById.get(qid) })),
                    routeApi ? { classify: (record) => routeApi.classifyApplyRoute(record) } : null
                );
                // Announced on every plan, including the clean case: a precheck that only speaks
                // when it refuses something is indistinguishable from one that never ran.
                console.log(`[handleSharedPlanRoute] precheck: ${report.applicable.length} applicable, `
                    + `${report.blocked.length} refused of ${report.total}`);
                if (report.blocked.length) {
                    const blockedIds = new Set(report.blocked.map(item => String(item.proposalId)));
                    report.blocked.forEach(item => {
                        console.warn('[handleSharedPlanRoute] precheck refused', item.proposalId,
                            item.verdict.code, item.verdict.message);
                        failed.push({
                            id: item.proposalId,
                            label: formatSharedProposalLabel(loadedById.get(item.proposalId), item.proposalId),
                            reason: item.verdict.message
                        });
                        markFetchProgress(item.proposalId);
                    });
                    queue = queue.filter(qid => !blockedIds.has(String(qid)));
                }
            }
        } catch (precheckError) {
            // A precheck that throws must never cost the plan its apply.
            console.warn('[handleSharedPlanRoute] precheck failed; applying without it', precheckError);
        }

        // Captured before the loop drains it. Applying is the long half of a plan open — a
        // 299-proposal plan spends minutes here, one proposal at a time — and until now the
        // overlay had no counter for it: it sat at the fetch phase's completed 299/299 while
        // the real work scrolled past in the console. The bar now follows what is happening.
        const applyTotal = queue.length;
        let applyDone = 0;

        while (queue.length > 0) {
            const id = queue.shift();
            try {
                let proposal = loadedById.get(id);
                if (!proposal) {
                    if (batchRecords.supported && batchRecords.missing.has(id)) {
                        failed.push({
                            id,
                            label: formatSharedProposalLabel(null, id),
                            reason: tShare('plan.notFoundOnServer', 'Not found on server')
                        });
                        markFetchProgress(id);
                        continue;
                    }
                    const baseStatus = tShare('plan.fetching', 'Fetching proposal #{{id}}…', { id });
                    const ordinal = getFetchOrdinal(id);
                    const fetchingStatus = (totalProposals > 0)
                        ? `${baseStatus} (${ordinal}/${totalProposals})`
                        : baseStatus;
                    updateProposalLoadOverlay({
                        status: fetchingStatus,
                        progress: { done: fetchProgressIds.size, total: totalProposals }
                    });
                    recordFetchProfile.individualRequests += 1;
                    const response = await fetch(`${backendBase}/proposals/${encodeURIComponent(id)}`);
                    if (!response.ok) {
                        let reason;
                        if (response.status === 404) {
                            reason = tShare('plan.notFoundOnServer', 'Not found on server');
                        } else {
                            reason = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`.trim();
                        }
                        failed.push({ id, label: formatSharedProposalLabel(null, id), reason });
                        markFetchProgress(id);
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

                // Ensure the proposal's normalized cadastral declaration before the attempt.
                // The repository decides whether each fact is cached, in flight, absent, or needs
                // transport; the route neither classifies IDs nor resolves geometry itself.
                const cadastreIds = getCadastrePrerequisiteIds(proposal);

                if (cadastreIds.length > 0) {
                    const fetchResult = await groundService.ensureIds(cadastreIds, { onProgress: reportSharedPlanProgress });
                    try {
                        lastMissingCadastrePrereqIdsById.set(String(id), fetchResult.missingIds);
                        if (proposal && proposal.proposalId) lastMissingCadastrePrereqIdsById.set(String(proposal.proposalId), fetchResult.missingIds);
                    } catch (_) { }
                }

                // Fallback wording matches the locale entry — en.json wins over the fallback, so a
                // divergent fallback only ever lies about what the user will see.
                applyDone += 1;
                updateProposalLoadOverlay({
                    status: tShare(
                        'plan.preparingNamed',
                        'Preparing {{label}} ({{done}}/{{total}})…',
                        { label: formatSharedProposalLabel(proposal, id), done: applyDone, total: applyTotal }
                    ),
                    progress: { done: applyDone, total: applyTotal }
                });
                const result = await importAndApplySharedProposal(proposal, {
                    skipDependencyFetch: true,
                    deferSave: true
                });

                const proposalId = (result && result.proposalId) || proposal?.proposalId || id;
                const label = formatSharedProposalLabel(proposal, proposalId);
                try {
                    const inferredType = proposalTypeById.get(id) || formatSharedProposalTypeLabel(proposal);
                    if (inferredType) {
                        proposalTypeById.set(id, inferredType);
                        if (proposalId) proposalTypeById.set(String(proposalId), inferredType);
                    }
                } catch (_) { }

                // Ensure the repository result is also keyed by the final resolved proposal id.
                try {
                    const pidKey = proposalId ? String(proposalId) : '';
                    if (pidKey && Array.isArray(cadastreIds)) {
                        const missingCadastre = lastMissingCadastrePrereqIdsById.get(String(id))
                            || lastMissingCadastrePrereqIdsById.get((proposal && proposal.proposalId) ? String(proposal.proposalId) : '')
                            || [];
                        if (Array.isArray(missingCadastre) && missingCadastre.length) {
                            lastMissingCadastrePrereqIdsById.set(pidKey, missingCadastre);
                        }
                    }
                } catch (_) { }

                if (result && result.skipped) {
                    skipped.push({ id: proposalId, label, ord: linkOrder.has(normalizeId(id)) ? linkOrder.get(normalizeId(id)) : -1 });
                    continue;
                }

                if (result && result.applied) {
                    applied.push({ id: proposalId, label, ord: linkOrder.has(normalizeId(id)) ? linkOrder.get(normalizeId(id)) : -1 });
                    continue;
                }

                const reason = (result && result.reason) || tShare('plan.applyUnknownFailure', 'Unknown error while importing.');
                failed.push({
                    id: proposalId,
                    label,
                    type: (proposalTypeById.get(String(proposalId)) || proposalTypeById.get(String(id)) || formatSharedProposalTypeLabel(proposal) || ''),
                    missingPrereqs: ensureArrayOfStrings(lastMissingCadastrePrereqIdsById.get(String(proposalId || id)) || []),
                    reason
                });
            } catch (error) {
                console.error('apply plan item failed', id, error);
                const reason = (error && error.message) ? error.message : 'Unexpected error';
                // No requeue and no healing (§15a): a thrown apply is a loud failure with its
                // reason and named prerequisites.
                {
                    const cachedProposal = loadedById.get(id) || null;
                    failed.push({
                        id,
                        label: formatSharedProposalLabel(cachedProposal, id),
                        type: (proposalTypeById.get(id) || formatSharedProposalTypeLabel(cachedProposal) || ''),
                        missingPrereqs: (() => {
                            try {
                                const key = String(id);
                                const explicitMissing = lastMissingCadastrePrereqIdsById.get(key);
                                if (Array.isArray(explicitMissing) && explicitMissing.length) return explicitMissing;
                                const storedFailure = getStoredApplyFailureInfo(key);
                                if (storedFailure && Array.isArray(storedFailure.missingIds) && storedFailure.missingIds.length) {
                                    return ensureArrayOfStrings(storedFailure.missingIds);
                                }
                                return [];
                            } catch (_) {
                                return [];
                            }
                        })(),
                        reason
                    });
                }
                markFetchProgress(id);
            }

        }

        // All imported members are now parked records. Materialise only that queue through the
        // direct replay materializer; startup already restored everything else on the map.
        if (applied.length > 0) {
            updateProposalLoadOverlay({ status: tShare('plan.materializing', 'Starting proposal materialization…') });
            const sharedPlanMemberIds = new Set(uniqueIncomingIds);
            [...incomingAlreadyApplied, ...applied].forEach(entry => {
                const record = entry && entry.id ? proposalStorage.getProposal(entry.id) : entry;
                [entry && entry.id, record && record.proposalId, record && record.serverProposalId]
                    .filter(Boolean)
                    .forEach(id => sharedPlanMemberIds.add(String(id)));
                try {
                    const serverId = record && typeof getServerProposalId === 'function'
                        ? getServerProposalId(record)
                        : null;
                    if (serverId) sharedPlanMemberIds.add(String(serverId));
                } catch (_) { }
            });
            const scoped = await materializeQueuedSharedProposals(applied.map(entry => entry.id), {
                recordFetchProfile,
                planMemberIds: sharedPlanMemberIds
            });
            const scopedFailures = new Set(scoped.failedIds.map(String));
            for (let i = applied.length - 1; i >= 0; i -= 1) {
                const entry = applied[i];
                if (!scopedFailures.has(String(entry.id))) continue;
                const record = proposalStorage.getProposal(entry.id);
                failed.push({
                    id: entry.id,
                    label: entry.label,
                    type: formatSharedProposalTypeLabel(record) || '',
                    missingPrereqs: [],
                    reason: getStoredApplyFailureInfo(entry.id)?.message || 'The proposal could not be derived from the loaded cadastre.'
                });
                applied.splice(i, 1);
            }
        }

        hideProposalLoadOverlay();


        const escape = typeof escapeHtml === 'function' ? escapeHtml : (value => value);
        const renderList = (items, formatter) => {
            const content = items.map(formatter).join('');
            return `<div class="shared-plan-list" style="max-height: 320px; overflow-y: auto; padding-right: 4px;"><ul style="margin: 0; padding-left: 18px;">${content}</ul></div>`;
        };

        const bodyLines = [];
        if (applied.length > 0) {
            const appliedItems = renderList(applied, item => `<li>${escape(item.label || formatSharedProposalLabel(null, item.id))}</li>`);
            bodyLines.push(`<p>${tShare('plan.appliedCountDetailed', 'Applied {{count}} proposals:', {
                count: applied.length
            })}</p>${appliedItems}`);
            const rebased = collectRebasedSharedProposals(applied.map(item => item.id));
            if (rebased.length) {
                bodyLines.push(`<p class="shared-plan-rebased">${tShare('rebased',
                    '{{count}} of them take different ground here than when published: {{titles}} (details in the console).', {
                        count: rebased.length,
                        titles: rebased.map(r => escape(r.title)).join(', ')
                    })}</p>`);
            }
        }
        if (skipped.length > 0) {
            if (bodyLines.length > 0) bodyLines.push('<br>');
            const skippedItems = renderList(skipped, item => `<li>${escape(item.label || formatSharedProposalLabel(null, item.id))}</li>`);
            bodyLines.push(`<p>${tShare('plan.skippedCountDetailed', 'Skipped {{count}} duplicate proposals (already present):', {
                count: skipped.length
            })}</p>${skippedItems}`);
        }
        if (failed.length > 0) {
            if (bodyLines.length > 0) bodyLines.push('<br>');
            // Raw prerequisite-id dumps belong in the console, not in the user's face.
            try { console.warn('[handleSharedPlanRoute] failed proposals detail', failed); } catch (_) { }
            const failedItems = renderList(failed, item => {
                const label = escape(item.label || formatSharedProposalLabel(null, item.id));
                const type = item.type ? ` (${escape(item.type)})` : '';
                const reason = item.reason ? ` · ${escape(item.reason)}` : '';
                return `<li>${label}${type}${reason}</li>`;
            });
            bodyLines.push(`<p>${tShare('plan.failedCountDetailed', 'Failed to apply {{count}} proposals:', {
                count: failed.length
            })}</p>${failedItems}`);
        }

        const wants3DFromUrl = (!url3DModeHandled && is3DModeRequestedFromUrl());

        if (applied.length > 0) {
            if (typeof updateProposalLayer === 'function') updateProposalLayer();
            if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton();
        }

        // Center map on the most recently loaded proposal — the one
        // latest in link order among everything now on the map (applied, skipped as duplicate,
        // or filtered out earlier because it was already applied) — as if it were loaded alone.
        // Link order is a presentation choice; fabric precedence remains immutable record order.
        const lastProposalId = selectSharedPlanFocusId(
            applied,
            skipped,
            incomingAlreadyApplied,
            linkOrderForProposal
        );
        console.log('[handleSharedPlanRoute] Centering on proposal:', lastProposalId);

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
        if (!options.suppressDetails && lastProposalId && typeof focusProposalDetails === 'function') {
            try {
                await focusProposalDetails(lastProposalId, {
                    centerOnProposal: false, // camera has already been fit to bounds above
                    showDetails: true
                });
            } catch (error) {
                console.warn('[handleSharedPlanRoute] focusProposalDetails failed', error);
            }
        }

        const summaryHasIssues = failed.length > 0;
        const showSummaryModal = !options.suppressSummary
            && bodyLines.length > 0
            && (summaryHasIssues || !wants3DFromUrl);

        let planSummaryModal = null;
        if (showSummaryModal) {
            planSummaryModal = showSimpleShareModal({
                title: tShare('plan.summary', 'Shared Plan Result'),
                body: bodyLines.join(''),
                actions: [
                    {
                        label: tShare('plan.copyResult', 'Copy'),
                        keepOpen: true,
                        onClick: (api) => {
                            try {
                                const text = `${tShare('plan.summary', 'Shared Plan Result')}\n\n`
                                    + String(api && api.body ? api.body.innerText : '').trim();
                                const copied = () => {
                                    if (typeof showEphemeralMessage === 'function') {
                                        showEphemeralMessage(tShare('plan.copiedResult', 'Result copied.'), 2500, 'success');
                                    }
                                };
                                if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                                    navigator.clipboard.writeText(text).then(copied, err => {
                                        console.warn('[handleSharedPlanRoute] copy failed', err);
                                    });
                                } else {
                                    const scratch = document.createElement('textarea');
                                    scratch.value = text;
                                    document.body.appendChild(scratch);
                                    scratch.select();
                                    document.execCommand('copy');
                                    scratch.remove();
                                    copied();
                                }
                            } catch (err) {
                                console.warn('[handleSharedPlanRoute] copy failed', err);
                            }
                        }
                    },
                    { label: t('modal.common.close', 'Close'), primary: true }
                ],
                onClose: () => {
                    // Dismissing the summary takes you to what it just told you about. The camera
                    // is already framed by the time this dialog opens — but only when the framing
                    // above found usable bounds, and it can miss (a read-only second tab, parcels
                    // not yet loaded, a proposal whose children are still materialising). Doing it
                    // again on Close costs nothing when the view is already right and rescues the
                    // case where the dialog was dismissed onto the city centre.
                    try { frameAppliedProposals(lastProposalId); } catch (_) { }
                    // URL-driven 3D mode: only enter after the user dismisses the results dialog.
                    try {
                        if (wants3DFromUrl && !url3DModeHandled) {
                            url3DModeHandled = true;
                            enterUrlDrivenViewWhenReady(getFocusProposalIds());
                        }
                    } catch (_) { }
                }
            });
        } else if ((applied.length > 0 || skipped.length > 0) && wants3DFromUrl && typeof showEphemeralMessage === 'function') {
            // Clean-enough apply, auto-advancing into 3D: lightweight feedback instead of a modal.
            const bits = [];
            const appliedOrPresent = applied.length + skipped.length;
            if (appliedOrPresent > 0) {
                bits.push(tShare('plan.appliedToast', 'Applied {{count}} proposals.', {
                    count: appliedOrPresent
                }));
            }
            showEphemeralMessage(bits.join(' '), 6000, 'info');
        }

        // No dialog shown -> honor URL-driven 3D immediately after focusing.
        if (!planSummaryModal) {
            try {
                if (wants3DFromUrl && !url3DModeHandled) {
                    url3DModeHandled = true;
                    enterUrlDrivenViewWhenReady(getFocusProposalIds());
                }
            } catch (_) { }
        }
        return { applied, skipped, failed };
    } catch (error) {
        console.error('handleSharedPlanRoute failed', error);
        hideProposalLoadOverlay();
        return {
            applied: [],
            skipped: [],
            failed: [{ id: null, label: '', reason: error && error.message ? error.message : 'Unexpected error' }]
        };
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
        const hasProposalParams = params.has('proposalShare') || params.has('shared')
            || window.location.pathname.startsWith('/proposals/')
            || window.location.pathname.startsWith('/plans/');
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
                const entered = enterUrlDrivenView();
                if (entered) url3DModeHandled = true;
            }
        }, 300);
    } catch (error) {
        console.error('handleStandalone3DModeFromUrl failed', error);
    }
}
