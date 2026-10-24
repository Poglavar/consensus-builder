// proposals/sharing-routes.js — sharing designs and opening shared designs (plan-design-agreement.md,
// M2 "Browser"). Share on a design publishes it (DesignSync.publishDesign) and copies its
// /designs/<cid> link; the sidebar's share panel (dialog-share.js) publishes a selection and links
// /designs/<cid>,<cid>. handleSharedDesignRoute opens such a link: it reads the designs from the index,
// imports them, applies them in replay order, frames them and opens the latest one's details
// (core.js handleProposalRouteFromUrl dispatches the path here; agreement-sync.js reuses it).

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
        if (proposal.parcelLayout && Array.isArray(proposal.parcelLayout.plots)) {
            proposal.parcelLayout.plots.forEach(plot => {
                if (plot && plot.geometry) {
                    geometryFeatures.push({ type: 'Feature', geometry: plot.geometry });
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

/** Spinner on the sidebar's "Share applied proposals" button. The label/subtext give way to it so the
    button keeps its size, and the busy flag survives updateShowProposalsButton re-enabling it. */
function setSharePlanButtonBusy(busy) {
    const button = document.getElementById('shareAppliedProposalsButton');
    if (!button) return;
    const label = button.querySelector('.share-plan-label');
    const subtext = button.querySelector('.share-plan-subtext');
    const spinner = button.querySelector('.share-plan-spinner');
    if (busy) button.dataset.sharePlanBusy = '1';
    else delete button.dataset.sharePlanBusy;
    // Tabs keep keyboard focus while their contents load.
    button.disabled = !!busy && button.getAttribute?.('role') !== 'tab';
    if (label) label.hidden = !!busy;
    if (subtext) subtext.hidden = !!busy;
    if (spinner) spinner.hidden = !busy;
}

// Resolves when the panel is ready to look at, so a caller that opened this from its own dialog
// can keep that dialog up meanwhile. `options` is passed straight through (see showSharePlanPanel).
function shareAppliedProposals(options) {
    // Reading or copying an existing publication needs no profile; publishing asks for an author.
    if (typeof setSharePlanButtonBusy === 'function') setSharePlanButtonBusy(true);
    // Opening the panel starts with a long SYNCHRONOUS block: a row per applied proposal, plus one
    // map overlay each (turf intersections + a Leaflet layer), plus fitting the map. Starting it in
    // this same task would freeze the page before the spinner ever painted, so yield two frames —
    // one to apply the style, one to be sure it reached the screen.
    return new Promise((resolve) => {
        const open = () => {
            let ready = null;
            try {
                // Switching tabs or closing Designs cancels an opening deferred by two frames.
                if (!options?.isCurrent || options.isCurrent()) ready = showSharePlanPanel(options);
            } finally {
                // Release the tab spinner on success, cancellation and failure.
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

// The design a Share action names: the object given, the design open in the details panel, or a
// local key.
function resolveDesignToShare(proposalIdOrProposal) {
    if (proposalIdOrProposal && typeof proposalIdOrProposal === 'object') return proposalIdOrProposal;
    const requested = proposalIdOrProposal == null ? '' : String(proposalIdOrProposal);
    if (currentProposalDetailsContext && (!requested || String(getProposalKey(currentProposalDetailsContext)) === requested)) {
        return currentProposalDetailsContext;
    }
    return requested && typeof proposalStorage !== 'undefined' ? proposalStorage.getProposal(requested) : null;
}

// A link that could not be copied is shown, selected, for copying by hand.
function showDesignLinkDialog(link, title) {
    const t = getProposalI18nHelper();
    const body = document.createElement('div');
    body.className = 'design-link';
    const intro = document.createElement('p');
    intro.textContent = t('proposals.share.copyByHand', 'The link could not be copied automatically. Copy it from here:');
    const input = document.createElement('input');
    input.type = 'text';
    input.readOnly = true;
    input.className = 'design-link__input';
    input.value = link;
    input.setAttribute('aria-label', t('proposals.share.linkLabel', 'Link to the published design'));
    body.append(intro, input);
    // The dialog's own focus lands a frame later: it must land on the link, selected, so Ctrl+C
    // copies it, not on the Close button.
    showSimpleShareModal({ title, body, initialFocus: input, actions: [{ label: t('modal.common.close', 'Close'), primary: true }] });
    input.focus();
    input.select();
}

// Share on a design: publish it (pinned and indexed once; DesignSync.publishDesign) and copy its
// /designs/<cid> link. A parcel layout is published with its agreement, so it is refused
// (ProposalPublishTerms.publishRefusal). Resolves { cid, link } or null.
async function shareSingleProposal(proposalIdOrProposal) {
    const t = getProposalI18nHelper();
    const proposal = resolveDesignToShare(proposalIdOrProposal);
    if (!proposal) {
        showEphemeralMessage(t('ephemeral.messages.cannot_share_this_proposal_right_now', 'Cannot share this proposal right now.'), 4000, 'error');
        return null;
    }
    const refusal = window.DesignSync.publishedCid(proposal) ? null : window.ProposalPublishTerms.publishRefusal(proposal);
    if (refusal) {
        showEphemeralMessage(refusal.message, 5000, 'info');
        return null;
    }
    try {
        const { cid } = await window.DesignSync.publishDesign(proposal);
        const link = window.DesignSync.designLink([cid], { city: proposal.city });
        console.info(`[${new Date().toISOString()}] [share] ${proposal.proposalId} → ${link}`);
        if (await window.DesignSync.copyLink(link)) {
            showEphemeralMessage(t('proposals.share.linkCopied', 'Design published. Its link is copied.'), 5000, 'success');
        } else {
            showDesignLinkDialog(link, t('proposals.share.publishedTitle', 'Design published'));
        }
        // The panel says Published now.
        if (currentProposalDetailsContext && String(getProposalKey(currentProposalDetailsContext)) === String(proposal.proposalId)
            && typeof showProposalInfo === 'function') {
            showProposalInfo(proposalStorage.getProposal(proposal.proposalId) || proposal);
        }
        return { cid, link };
    } catch (error) {
        if (error && error.cancelled) return null;
        console.error(`[${new Date().toISOString()}] [share] publishing ${proposal.proposalId} failed`, error);
        showEphemeralMessage((error && error.message) || t('proposals.share.errors.failed', 'The design could not be published.'), 7000, 'error');
        return null;
    }
}

function shareProposalFromDetails() {
    if (currentProposalDetailsContext) return shareSingleProposal(currentProposalDetailsContext);
    const panel = document.getElementById('proposal-details-content');
    const idElement = panel ? panel.querySelector('[data-proposal-id]') : null;
    return shareSingleProposal(idElement ? idElement.getAttribute('data-proposal-id') : null);
}

function sharedMaterializationPhase(record) {
    const rawGoal = record && record.goal;
    const goal = (typeof applyRoute !== 'undefined' && applyRoute && typeof applyRoute.normalizeGoalKey === 'function')
        ? applyRoute.normalizeGoalKey(rawGoal)
        : String(rawGoal || '');
    if (goal === 'road-track' || !!(record && record.roadProposal)) return 0;
    if (goal === 'parcel-layout' || !!(record && record.parcelLayout)) return 1;
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
    const title = tShare('plan.applyingAllTitle', 'Applying shared proposals');
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
// boundary, but avoids the explicit-click state transition and rival pass that used to run
// before the same materializer. Package dependency order remains immutable inside each phase, and
// a link import uses the non-displacing shared-ground gate below.
async function materializeQueuedSharedProposals(proposalIds, options = {}) {
    // Package dependencies outrank URL and creation order: corridors form road-bounded blocks
    // before parcel layouts partition them. Buildings and public spaces follow. Immutable input
    // order breaks ties within each phase.
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
    // "someone else's applied work" the shared-ground refusal is protecting.
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
                    return !planMemberIds.has(String(record.proposalId));
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

            // Consecutive roads in the ordered package are one network mutation.
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
                // A corridor network is published atomically, but an unrelated proposal may hold
                // only a few of the incoming roads. Validate those members before forming the
                // batch: feeding one refused road into the network transaction rolls back every
                // otherwise-clear road beside it and turns one local conflict into a plan-wide
                // corridor failure.
                const clearRoadIds = [];
                for (const roadId of roadIds) {
                    let roadRecord = null;
                    try { roadRecord = proposalStorage.getProposal(roadId); } catch (_) { roadRecord = null; }
                    if (typeof ProposalManager.validateSharedProposalGround === 'function') {
                        const validation = ProposalManager.validateSharedProposalGround(
                            roadId,
                            planMemberIds,
                            preexistingAppliedRecords
                        );
                        if (!validation || validation.ok !== true) {
                            failedIds.push(roadId);
                            continue;
                        }
                    }
                    clearRoadIds.push(roadId);
                }
                if (!clearRoadIds.length) {
                    index = cursor;
                    continue;
                }
                try {
                    const batch = await ProposalManager.materializeCorridorBatch(clearRoadIds, {
                        deferPresentation: true,
                        deferSave: true,
                        onProgress: reportSharedPlanProgress
                    });
                    appliedIds.push(...(Array.isArray(batch?.appliedIds) ? batch.appliedIds : []));
                    failedIds.push(...(Array.isArray(batch?.failedIds) ? batch.failedIds : (batch?.ok ? [] : clearRoadIds)));
                } catch (error) {
                    console.error('[shared-apply] corridor batch failed', error);
                    failedIds.push(...clearRoadIds);
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
                // every shared member. The old path marked state in one full-map transaction and then
                // replay-applied in a second; neither extra snapshot nor explicit-Apply rival path
                // belongs to opening a plan link.
                if (ProposalManager && typeof ProposalManager.validateSharedProposalGround === 'function') {
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
            if (batchStore && typeof batchStore.save === 'function') await batchStore.save();
        } finally {
            if (storageBatched) await batchStore.endBatch();
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
// prod for a road link — with nothing on screen to explain it. Waiting is only meaningful for
// building proposals; anything else is ready as soon as it is applied.
function urlFocusNeedsBuildings(ids) {
    try {
        const all = (typeof proposalStorage !== 'undefined' && proposalStorage.getAllProposals)
            ? proposalStorage.getAllProposals() : [];
        const focused = all.filter(p => ids.includes(String(p.proposalId || '')));
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

// A newcomer chooses a profile (the welcome dialog) before a link imports anything, unless the link
// opens without one (window.shouldSkipWelcomeForProposalLink).
async function waitForSharedLinkWelcome() {
    if (typeof window.shouldSkipWelcomeForProposalLink === 'function' && window.shouldSkipWelcomeForProposalLink()) return;
    const welcome = document.getElementById('welcome-modal');
    const visible = !!(welcome && !welcome.hidden);
    const hasUserAgent = typeof currentUserAgent !== 'undefined' && currentUserAgent !== null;
    if (!visible && hasUserAgent) return;
    console.log(`[${new Date().toISOString()}] [handleSharedDesignRoute] waiting for the welcome dialog`);
    await new Promise(resolve => window.addEventListener('welcomeModalComplete', resolve, { once: true }));
}

// The latest-authored of the designs now standing for a link: the one a link frames and opens.
function latestAuthoredDesignId(proposalIds) {
    let best = null;
    let bestAt = -Infinity;
    proposalIds.forEach(id => {
        const record = proposalStorage.getProposal(id);
        if (!record) return;
        const at = Date.parse(record.createdAt) || 0;
        if (at >= bestAt) {
            bestAt = at;
            best = String(id);
        }
    });
    return best;
}

/**
 * Opens shared designs: a /designs/<cid>,<cid> link (core.js handleProposalRouteFromUrl). Reads them
 * from the index (DesignSync.fetchDesigns), imports each as a local design (a local copy of the same
 * CID is used as it stands), applies the ones not yet on the map in replay order, frames the
 * latest-authored one and opens its details. Conflicts offer explicit unapply/continue or skip;
 * no existing design is unapplied without that choice. A different city asks to switch first.
 * @param cids the link's design CIDs
 * @param options { openDetails = true, frame = true, enter3D = true, summary = true } — the agreement
 *   route (agreement-sync.js) applies its designs and opens the agreement instead.
 * @returns {Promise<{ applied: string[], skipped: string[], omitted: string[], failed: { id, label, reason }[],
 *   blocked: boolean, localIds: Map<string, string> }>} local proposal ids; localIds maps CID → local id
 */
async function handleSharedDesignRoute(cids, options = {}) {
    const sharedView = window.WorldEntry?.arrivalMapView();
    if (sharedView) options = { ...options, frame: false, openDetails: false };
    const t = getProposalI18nHelper();
    const tShare = getShareI18nHelper();
    const log = (message, ...rest) => console.log(`[${new Date().toISOString()}] [handleSharedDesignRoute] ${message}`, ...rest);
    const result = { applied: [], skipped: [], omitted: [], failed: [], blocked: false, localIds: new Map() };
    const labelOf = (record, fallback) => formatSharedProposalLabel(record, fallback);
    let replayTakeover = null;
    try {
        if (typeof map === 'undefined' || !map) throw new Error('The map is not ready.');
        const requested = Array.from(new Set((Array.isArray(cids) ? cids : []).map(cid => String(cid || '').trim()).filter(Boolean)));
        const valid = requested.filter(cid => window.Cid.isCid(cid));
        requested.filter(cid => !window.Cid.isCid(cid)).forEach(cid => {
            result.failed.push({ id: cid, label: cid, reason: t('proposals.share.errors.notACid', 'This is not a design link.') });
        });
        log(`opening ${valid.length} design(s)`, valid);
        await waitForSharedLinkWelcome();

        showProposalLoadOverlay(t('proposals.share.route.fetching', 'Fetching the shared designs…'), {
            total: valid.length,
            title: t('proposals.share.route.title', 'Shared designs')
        });
        const fetched = options.draftRows ? { rows: options.draftRows, missing: [] }
            : valid.length ? await window.DesignSync.fetchDesigns(valid) : { rows: new Map(), missing: [] };
        fetched.missing.forEach(cid => {
            result.failed.push({ id: cid, label: cid, reason: t('proposals.share.errors.notFound', 'This design is not on the server.') });
        });

        // The designs know their city. The first one that belongs to another city's store asks to
        // switch there; staying drops the link.
        const cityManager = window.CityConfigManager;
        const foreign = [...fetched.rows.values()].find(row => cityManager.foreignCityFor(row.city));
        if (foreign && await promptCityMismatchForProposal(String(foreign.city))) {
            log('the designs belong to another city; the link was dropped or reloads there');
            hideProposalLoadOverlay();
            result.blocked = true;
            return result;
        }

        if (typeof PersistentStorage !== 'undefined' && typeof PersistentStorage.ensureReady === 'function') {
            await new Promise(resolve => PersistentStorage.ensureReady(resolve));
        }
        // The boot replay finishes before the link looks at what is applied (it marks its whole set
        // unapplied while it runs). Its own records are in hand, so the map stays usable meanwhile.
        if (ProposalManager._initialReapplyDone !== true) {
            hideProposalLoadOverlay();
            replayTakeover = window.ReplayStatus.watchUserTakeover(document);
            await ProposalManager.reapplyAppliedProposals({
                onProgress: window.ReplayStatus.statusReporter(tShare,
                    text => { if (typeof updateStatus === 'function') updateStatus(text, { transient: true }); })
            });
            replayTakeover.stop();
            showProposalLoadOverlay(t('proposals.share.route.importing', 'Importing the shared designs…'), {
                total: fetched.rows.size,
                title: t('proposals.share.route.title', 'Shared designs')
            });
        }
        await ProposalManager.reapplyAppliedProposals();

        // Import: a local copy of the CID already applied stands as it is; anything else is stored
        // parked and queued.
        const queue = [];
        await ProposalManager.runParcelMutation('import-shared-designs', null, async transactionOptions => {
            const store = transactionOptions._parcelMutation.proposals;
            for (const cid of valid) {
                const row = fetched.rows.get(cid);
                if (!row) continue;
                try {
                    const existing = window.DesignSync.localCopyOf(cid, { store });
                    if (existing && isProposalCurrentlyApplied(existing)) {
                        result.skipped.push(String(existing.proposalId));
                        result.localIds.set(cid, String(existing.proposalId));
                        continue;
                    }
                    const stored = existing || await (options.draftRows
                        ? window.DesignSync.importDraft(row, transactionOptions)
                        : window.DesignSync.importDesign(row, transactionOptions));
                    result.localIds.set(cid, String(stored.proposalId));
                    queue.push(String(stored.proposalId));
                } catch (error) {
                    console.warn(`[${new Date().toISOString()}] [handleSharedDesignRoute] ${cid} could not be imported`, error);
                    result.failed.push({ id: cid, label: row.title || cid, reason: (error && error.message) || String(error) });
                }
                updateProposalLoadOverlay({ progress: { done: result.localIds.size + result.failed.length, total: valid.length } });
            }
        }, { _mapMutation: false });

        // The cadastral ground of every queued design in one prefetch, then a precheck of the whole
        // set: a design the apply would refuse is reported, and the others still apply.
        const groundService = getSharedGroundService();
        const unionCadastreIds = queue.flatMap(id => window.__claims.cadastreParcelIdsOf(proposalStorage.getProposal(id)));
        if (unionCadastreIds.length && !window.ParcelGroundFallback?.isWithoutParcels?.()) {
            try {
                await groundService.ensureIds(unionCadastreIds, { onProgress: reportSharedPlanProgress });
            } catch (error) {
                // The cadastre did not answer: offer the ways on, as a parcel link does
                // (parcels/route.js). Continue without parcels reloads this link, which then applies
                // its designs by their own geometry.
                window.ParcelGroundFallback?.onGroundUnavailable?.({ error, city: window.CityConfigManager.getCurrentCityId() });
                throw error;
            }
        }
        const report = window.__applyValidate.validatePlan(
            queue.map(id => ({ proposalId: id, record: proposalStorage.getProposal(id) })),
            { classify: record => window.__applyRoute.classifyApplyRoute(record) });
        log(`precheck: ${report.applicable.length} applicable, ${report.blocked.length} refused of ${report.total}`);
        const blockedIds = new Set(report.blocked.map(item => String(item.proposalId)));
        report.blocked.forEach(item => {
            console.warn(`[${new Date().toISOString()}] [handleSharedDesignRoute] precheck refused`, item.proposalId, item.verdict.code, item.verdict.message);
            result.failed.push({ id: item.proposalId, label: labelOf(proposalStorage.getProposal(item.proposalId), item.proposalId), reason: item.verdict.message });
        });
        let toApply = queue.filter(id => !blockedIds.has(id));
        const memberIds = new Set(result.localIds.values());
        const preexistingApplied = proposalStorage.getAllProposals().filter(record =>
            isProposalCurrentlyApplied(record) && !memberIds.has(String(record.proposalId)));
        const conflicts = new Map(), conflictingIncoming = new Set();
        // Include linked members that already stand here: a previous partial open may have left
        // both road versions applied. The warning must name every rival the confirmed apply parks.
        for (const id of memberIds) {
            const verdict = ProposalManager.validateSharedProposalGround(id, memberIds, preexistingApplied);
            for (const blocker of verdict.blockers || []) {
                conflictingIncoming.add(id);
                conflicts.set(String(blocker.proposalId), blocker);
            }
        }
        let replaceConflicts = false;
        if (conflicts.size && !result.failed.length) {
            // Decide before applying any new member. The existing dialog primitive escapes the
            // titles as plain text and gives the same choice on phones and desktops.
            hideProposalLoadOverlay();
            const choice = await window.CbDialog.choice(
                t('proposals.share.route.conflicts', 'This plan conflicts with designs already applied on this device. Unapply the existing conflicting designs and continue, or skip the conflicting designs in this plan. All designs will stay saved.')
                    + '\n\n' + [...conflicts.values()].map(record => record.title || String(record.proposalId)).join('\n'),
                [
                    { value: 'replace', label: t('proposals.share.route.unapplyContinue', 'Unapply existing & continue'), primary: true },
                    { value: 'skip', label: t('proposals.share.route.skipConflicts', 'Skip conflicting designs') },
                    { value: 'cancel', label: t('modal.common.cancel', 'Cancel') }
                ], { title: t('proposals.share.route.conflictTitle', 'Plan conflicts') });
            if (choice !== 'replace' && choice !== 'skip') { result.blocked = true; return result; }
            replaceConflicts = choice === 'replace';
            if (!replaceConflicts) {
                result.omitted.push(...toApply.filter(id => conflictingIncoming.has(id)));
                toApply = toApply.filter(id => !conflictingIncoming.has(id));
            }
            showProposalLoadOverlay(tShare('plan.materializing', 'Starting proposal materialization…'), {
                total: toApply.length, title: t('proposals.share.route.title', 'Shared designs')
            });
        }
        if (replaceConflicts) {
            updateProposalLoadOverlay({ status: tShare('plan.materializing', 'Starting proposal materialization…') });
            const members = [...result.localIds.values()];
            const chosen = await ProposalManager.applyProposalPlan(members, {
                silent: true, onProgress: reportSharedPlanProgress
            });
            if (chosen && chosen.ok === true) {
                result.applied.push(...members);
                result.skipped.length = 0;
            } else {
                const failures = ProposalManager._lastFailedPlanApplySummary?.failed || [];
                for (const failure of failures) {
                    const id = failure.proposalId == null ? null : String(failure.proposalId);
                    const cid = [...result.localIds].find(([, localId]) => localId === id)?.[0];
                    const row = fetched.rows.get(cid);
                    result.failed.push({ id,
                        label: failure.title || row?.title || row?.content?.title
                            || labelOf(proposalStorage.getProposal(id), id || t('proposals.share.route.title', 'Shared designs')),
                        reason: failure.reason || failure.message || t('proposals.share.errors.applyFailed', 'The design could not be applied to the ground here.') });
                }
                if (!failures.length) result.failed.push({ id: null,
                    label: t('proposals.share.route.title', 'Shared designs'),
                    reason: t('proposals.share.errors.applyFailed', 'The design could not be applied to the ground here.') });
            }
            updateProposalLayer();
            updateShowProposalsButton();
        } else if (toApply.length) {
            updateProposalLoadOverlay({ status: tShare('plan.materializing', 'Starting proposal materialization…') });
            const scoped = await materializeQueuedSharedProposals(toApply, {
                planMemberIds: new Set([...result.skipped, ...toApply]),
                recordFetchProfile: { batchRequests: Math.ceil(valid.length / 1000), individualRequests: 0, batchSupported: true }
            });
            const failedIds = new Set(scoped.failedIds.map(String));
            toApply.forEach(id => {
                if (!failedIds.has(id)) {
                    result.applied.push(id);
                    return;
                }
                result.failed.push({
                    id, label: labelOf(proposalStorage.getProposal(id), id),
                    reason: getStoredApplyFailureInfo(id)?.message || t('proposals.share.errors.applyFailed', 'The design could not be applied to the ground here.')
                });
            });
            updateProposalLayer();
            updateShowProposalsButton();
        }
        hideProposalLoadOverlay();
        log(`applied ${result.applied.length}, already applied ${result.skipped.length}, failed ${result.failed.length}`);

        const standing = [...result.applied, ...result.skipped];
        const focusId = latestAuthoredDesignId(standing);
        const userTookOver = () => !!(replayTakeover && replayTakeover.tookOver());
        if (focusId && options.frame !== false && !userTookOver()) {
            if (typeof window.isThreeModeActive === 'function' && window.isThreeModeActive()) {
                window.focusThreeModeOnProposals([focusId]);
            } else {
                const bounds = calculateBoundsForLastAppliedProposal(focusId);
                if (bounds && bounds.isValid()) map.fitBounds(bounds, { padding: [80, 80], maxZoom: 18, animate: false });
            }
        }
        if (focusId && options.openDetails !== false && !userTookOver()) {
            await focusProposalDetails(focusId, { centerOnProposal: false, showDetails: true });
        }

        if (options.summary !== false) {
            if (result.failed.length) {
                const escape = value => escapeHtml(String(value == null ? '' : value));
                const items = result.failed.map(item => `<li>${escape(item.label)}${item.reason ? ` · ${escape(item.reason)}` : ''}</li>`).join('');
                showSimpleShareModal({
                    title: t('proposals.share.route.title', 'Shared designs'),
                    body: `<p>${escape(t('proposals.share.route.failedCount', '{{count}} of the shared designs could not be opened:', { count: result.failed.length }))}</p>`
                        + `<ul class="shared-plan-failures">${items}</ul>`,
                    actions: [{ label: t('modal.common.close', 'Close'), primary: true }]
                });
            } else if (result.omitted.length) {
                showEphemeralMessage(t('proposals.share.route.omitted', 'Opened the shared plan, skipping {{count}} conflicting designs.', { count: result.omitted.length }), 5000, 'info');
            } else if (result.applied.length) {
                showEphemeralMessage(t('proposals.share.route.applied', 'Applied {{count}} shared designs.', { count: result.applied.length }), 5000, 'info');
            } else if (result.skipped.length) {
                showEphemeralMessage(t('proposals.share.route.alreadyApplied', 'These shared designs are already on the map.'), 4000, 'info');
            }
        }

        if (sharedView && !userTookOver()) {
            map.setView([sharedView.lat, sharedView.lon], sharedView.zoom ?? map.getZoom(), { animate: false });
        }
        // A link that asks for 3D restores its captured camera when supplied.
        if (options.enter3D !== false && !url3DModeHandled && is3DModeRequestedFromUrl() && standing.length) {
            url3DModeHandled = true;
            enterUrlDrivenViewWhenReady(standing);
        }
        return result;
    } catch (error) {
        console.error(`[${new Date().toISOString()}] [handleSharedDesignRoute] failed`, error);
        hideProposalLoadOverlay();
        if (replayTakeover) replayTakeover.stop();
        showEphemeralMessage((error && error.message) || t('proposals.share.route.failed', 'The shared designs could not be opened.'), 8000, 'error');
        result.failed.push({ id: null, label: '', reason: (error && error.message) || 'Unexpected error' });
        return result;
    }
}

function handleStandalone3DModeFromUrl(attempt = 0) {
    try {
        if (url3DModeHandled) return;
        if (!is3DModeRequestedFromUrl()) return;

        // A record route (a design link, an agreement, a chain proposal) enters 3D itself, framed on
        // what it opens.
        const pathname = window.location.pathname || '';
        if (pathname.startsWith('/proposals/') || pathname.startsWith('/designs/') || pathname.startsWith('/agreements/')) return;

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

if (typeof window !== 'undefined') window.handleSharedDesignRoute = handleSharedDesignRoute;
