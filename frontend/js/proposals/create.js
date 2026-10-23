// proposals/create.js — extracted from proposals.js (behavior-preserving relocation).

// The city a proposal belongs to, as a city id ('zagreb', 'new_york', …) — the same form the
// backend's `proposal.city` column stores. Recorded on the proposal itself so its origin survives
// being uploaded from elsewhere, opened from a link, or copied.
function getProposalCityId() {
    try {
        if (typeof window !== 'undefined' && window.CityConfigManager
            && typeof window.CityConfigManager.getCurrentCityId === 'function') {
            return window.CityConfigManager.getCurrentCityId() || null;
        }
        if (typeof getCurrentCityId === 'function') return getCurrentCityId() || null;
    } catch (_) { }
    return null;
}

function updateCreateProposalSubmitState() {
    const btn = document.getElementById('createProposalSubmitButton');
    const hint = document.getElementById('proposalGeometryRequirementHint');
    const goalKey = currentGeometryGoal || getSelectedProposalTool();
    const needsGeometry = goalRequiresGeometry(goalKey);
    const hasGeometry = proposalGeometrySubmitted || !needsGeometry;

    if (btn) {
        btn.disabled = !hasGeometry;
        const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
        const createsReplacement = !!(typeof window !== 'undefined'
            && window.pendingProposalReplacementSource?.proposalId);
        btn.textContent = createsReplacement
            ? window.ProposalLineage.forkSubmitLabel(window.pendingProposalReplacementSource.proposalId,
                { fork: window.pendingProposalReplacementSource.fork === true })
            : (t ? t('modal.createProposal.submit', 'Create Proposal') : 'Create Proposal');
    }
    if (hint) {
        hint.textContent = !hasGeometry ? 'Please add a geometry first.' : '';
    }
}

function resolveProposalAuthorName() {
    let authorName = '';
    if (typeof getCurrentUsername === 'function') {
        try {
            authorName = getCurrentUsername() || '';
        } catch (e) {
            console.warn('Failed to resolve username for proposal author', e);
        }
    }
    if (!authorName && typeof getCurrentUserAgent === 'function') {
        try {
            const agent = getCurrentUserAgent();
            if (agent && agent.name) {
                authorName = agent.name;
            }
        } catch (e) {
            console.warn('Failed to resolve agent for proposal author', e);
        }
    }
    return authorName;
}

function populateProposalAuthorUI({ inputId = 'proposalAuthor', avatarId = 'proposalAuthorAvatar' } = {}) {
    const input = document.getElementById(inputId);
    const avatarImg = document.getElementById(avatarId);
    const authorName = resolveProposalAuthorName();

    if (input) {
        input.value = authorName;
        input.disabled = true;
    }

    if (avatarImg) {
        let avatarApplied = false;
        if (typeof getCurrentUserAgent === 'function' && typeof getAvatarImagePath === 'function') {
            try {
                const agent = getCurrentUserAgent();
                if (agent && typeof agent.avatarIndex !== 'undefined') {
                    const src = getAvatarImagePath(agent.avatarIndex);
                    if (src) {
                        avatarImg.src = src;
                        avatarImg.alt = `${agent.name || authorName || 'Author'} avatar`;
                        avatarImg.style.display = 'block';
                        avatarApplied = true;
                    }
                }
            } catch (e) {
                console.warn('Failed to set proposal author avatar', e);
            }
        }
        if (!avatarApplied) {
            avatarImg.style.display = 'none';
        }
    }

    return authorName;
}

function getProposalAuthorValue(inputId = 'proposalAuthor') {
    const input = document.getElementById(inputId);
    const value = (input && typeof input.value === 'string') ? input.value.trim() : '';
    return value || resolveProposalAuthorName();
}

// The type a proposal is born with is an internal English token ('Road', 'Track', 'Residences', …).
// Both the default name and the default description are persisted, so they are localized HERE, at
// creation time, in the language the author is actually using.
const PROPOSAL_TYPE_TRANSLATION_KEYS = {
    'residences': 'modal.createProposal.goalOptions.buildings',
    'single building': 'modal.createProposal.goalOptions.single',
    'building(s)': 'modal.createProposal.goalOptions.single',
    'park': 'modal.createProposal.goalOptions.park',
    'square': 'modal.createProposal.goalOptions.square',
    'lake': 'modal.createProposal.goalOptions.lake',
    // A drawn corridor knows whether it is a road or a track — say so, instead of the "Road/Track"
    // category name the user never picked.
    'road': 'modal.roadWidth.proposalList.goalLabels.road',
    'track': 'modal.roadWidth.proposalList.goalLabels.track',
    'road/track': 'modal.createProposal.goalOptions.roadTrack',
    'urban rule': 'modal.createProposal.proposalTypeOptions.urbanRule',
    'joint investment': 'modal.createProposal.proposalTypeOptions.jointInvestment',
    'purchase': 'modal.createProposal.proposalTypeOptions.purchase',
    'ownership-transfer-to-me': 'modal.createProposal.ownershipTransfer.nameToMe',
    'ownership-transfer-from-me': 'modal.createProposal.ownershipTransfer.nameFromMe',
    'ownership-transfer-to-city': 'modal.createProposal.ownershipTransfer.nameToCity',
    'ownership-transfer-third-party': 'modal.createProposal.ownershipTransfer.nameThirdParty',
    'offer-to-sell': 'modal.createProposal.ownershipTransfer.nameOfferToSell'
};

function localizeProposalTypeLabel(proposalType) {
    const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
    const normalizedType = (proposalType || '').toString().trim();
    if (!t || !normalizedType) return normalizedType;

    const key = normalizedType.toLowerCase();
    const translationKey = PROPOSAL_TYPE_TRANSLATION_KEYS[key];
    if (translationKey) return t(translationKey, normalizedType);
    if (typeof getProposalTypeLabel === 'function') return getProposalTypeLabel(normalizedType);
    return normalizedType;
}

// "Block · parcel 2143", "Park · 24 parcels", or, without a parcel set, "Block · 3 Oct 2026, 00:26".
// It used to be a clock code ("Block 0310-0026"), which told the reader nothing about the proposal.
function generateDefaultProposalName(proposalType, context = {}) {
    const localizedType = localizeProposalTypeLabel(proposalType);
    const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : ((_k, fallback) => fallback);
    let ids = Array.isArray(context.parcelIds) ? context.parcelIds.filter(Boolean).map(String) : [];
    if (!ids.length && typeof getCurrentParcelSelectionContext === 'function') {
        // The create dialog names a proposal before the caller knows its parcels: use the selection.
        try { ids = (getCurrentParcelSelectionContext()?.ids || []).filter(Boolean).map(String); } catch (_) { ids = []; }
    }
    let place;
    if (ids.length === 1) {
        // The cadastral number is the part people recognise; the municipality prefix is not.
        const short = ids[0].split('-').pop();
        place = t('proposals.autoName.parcel', 'parcel {{id}}', { id: short });
    } else if (ids.length > 1) {
        place = t('proposals.autoName.parcels', '{{count}} parcels', { count: ids.length });
    } else {
        place = typeof CbFormat !== 'undefined' ? CbFormat.formatDateTime(new Date()) : new Date().toLocaleString();
    }
    return `${localizedType} · ${place}`;
}

function generateDefaultProposalDescription(proposalType, proposalName) {
    const authorName = resolveProposalAuthorName() || 'User';
    const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
    const localizedType = localizeProposalTypeLabel(proposalType);

    // Generate simpler description without repeating the name
    // The name is shown separately in the proposal details
    const fallback = `A new ${localizedType} proposal by ${authorName}`;
    return t
        ? t('modal.createProposal.defaultDescription', fallback, { type: localizedType, author: authorName })
        : fallback;
}

function updateProposalNameAndDescription(proposalType, forceUpdate = false) {
    const nameInput = document.getElementById('proposalName');
    const descriptionInput = document.getElementById('proposalDescription');

    if (nameInput) {
        if (nameInput.dataset.titleOriginBound !== 'true') {
            nameInput.addEventListener('input', () => { nameInput.dataset.titleOrigin = 'user'; });
            nameInput.dataset.titleOriginBound = 'true';
        }
        if (forceUpdate || !nameInput.value.trim()) {
            nameInput.value = generateDefaultProposalName(proposalType);
            nameInput.dataset.titleOrigin = 'generated';
        }
    }

    if (descriptionInput) {
        if (forceUpdate || !descriptionInput.value.trim()) {
            const proposalName = nameInput && nameInput.value.trim() ? nameInput.value.trim() : generateDefaultProposalName(proposalType);
            descriptionInput.value = generateDefaultProposalDescription(proposalType, proposalName);
        }
    }
}

async function createProposal() {
    console.debug('[createProposal] START - Create proposal button clicked');
    const startTime = performance.now();
    const t = getProposalI18nHelper();
    const publishingDraftId = (typeof window !== 'undefined' && window.pendingProposalDraftId)
        ? String(window.pendingProposalDraftId)
        : null;
    // Set below when this save edits one's own local record in place (proposals/lineage.js).
    let inPlaceSourceId = null;
    const markDraftPublishFailed = (error) => {
        if (!publishingDraftId || !window.proposalDraftStore?.getDraft?.(publishingDraftId)) return;
        window.proposalDraftStore.markPublishFailed(publishingDraftId, error);
    };
    const selectedTool = getSelectedProposalTool();
    if (!selectedTool) {
        showProposalAlertMessage('select_a_proposal_goal_before_creating_a_proposal', 'Select a proposal goal before creating a proposal.');
        return;
    }
    if (goalRequiresGeometry(selectedTool) && !proposalGeometrySubmitted) {
        showProposalAlertMessage('please_add_a_geometry_first', 'Please add a geometry first.');
        updateCreateProposalSubmitState();
        return;
    }
    console.debug('[createProposal] Selected tool:', selectedTool);

    // All proposal types are handled uniformly below.
    // Building/urban-rule geometry is expected in pendingBuildingProposalContext (set by geometry tools).

    const author = getProposalAuthorValue();
    const proposalTypeInput = document.getElementById('proposalType');
    const proposalType = proposalTypeInput && proposalTypeInput.value ? proposalTypeInput.value : DEFAULT_PROPOSAL_TYPE;
    const proposalMainTypeInput = document.getElementById('proposalMainType');
    const proposalMainType = proposalMainTypeInput && proposalMainTypeInput.value ? proposalMainTypeInput.value : 'Purchase';
    const proposalName = (document.getElementById('proposalName') && document.getElementById('proposalName').value || '').trim();
    const titleOrigin = document.getElementById('proposalName')?.dataset?.titleOrigin === 'generated' ? 'generated' : 'user';
    const description = document.getElementById('proposalDescription').value.trim();
    const acquisitionInput = document.getElementById('proposalAcquisitionMode');
    const acquisitionMode = acquisitionInput && acquisitionInput.value ? acquisitionInput.value : null;
    const boundaryInput = document.getElementById('proposalBoundaryMode');
    const boundaryMode = boundaryInput && boundaryInput.value ? boundaryInput.value : null;

    // Validation
    if (!author) {
        showProposalAlertMessage('please_enter_an_author_name', 'Please enter an author name.');
        return;
    }
    if (!description) {
        showProposalAlertMessage('please_enter_a_description', 'Please enter a description.');
        return;
    }

    // Lock UI while creating
    console.debug('[createProposal] Locking UI and starting proposal creation');
    setProposalCreateButtonState(true);
    setProposalModalInteractivity(false);
    let waitingPopupVisible = false;
    const hideWaitingPopupSafe = () => {
        if (waitingPopupVisible) {
            hideProposalWaitingPopup();
            waitingPopupVisible = false;
        }
        setProposalModalDimmed(false);
    };

    try {
        // Get the parcelIds that were determined in showProposalDialog
        console.debug('[createProposal] Collecting parcel IDs');
        let finalParcelIds = [];

        const createdFromMultiSelect = multiParcelSelection.selectedParcels.size > 1;

        if (multiParcelSelection.selectedParcels.size > 0) {
            finalParcelIds = Array.from(multiParcelSelection.selectedParcels);
        } else if (typeof selectedParcelId !== 'undefined' && selectedParcelId) {
            finalParcelIds = [selectedParcelId];
        }

        // A site-first proposal (the dialog's site context, js/site-drawing.js) has its ground as a
        // site and its declaration as the binding — possibly empty on bare ground.
        const siteContext = (typeof window !== 'undefined' && window.pendingProposalSiteContext
            && window.pendingProposalSiteContext.site) ? window.pendingProposalSiteContext : null;
        if (siteContext) finalParcelIds = [];
        console.debug('[createProposal] Final parcel IDs:', finalParcelIds.length, 'parcels', siteContext ? '(site-first)' : '');
        if (finalParcelIds.length === 0 && !siteContext) {
            showProposalAlertMessage('no_parcels_selected_please_select_parcels_before_creating_a_proposal', 'No parcels selected. Please select parcels before creating a proposal.');
            return;
        }

        // The selection is a set of current live pieces. It is transient authoring input only;
        // every durable or external relationship (proposal storage, ownership and chain minting)
        // uses the immutable cadastral projection.
        const selectedLiveParcelIds = finalParcelIds.map(id => id && id.toString ? id.toString() : String(id));
        const liveFabric = window.LiveParcelFabric;
        if (!liveFabric || typeof liveFabric.cadastreIdsForParcelIds !== 'function') {
            throw new Error('Live parcel fabric is required to author proposal ground.');
        }
        const authoredCadastreParcelIds = siteContext
            ? (siteContext.cadastreParcelIds || []).map(String)
            : liveFabric.cadastreIdsForParcelIds(selectedLiveParcelIds);
        // The intrusion tolerance (the dialog's Options): linear metres, default 0.
        const toleranceInput = document.getElementById('proposalToleranceM');
        const toleranceRaw = toleranceInput ? Number(toleranceInput.value) : 0;
        const toleranceM = Number.isFinite(toleranceRaw) && toleranceRaw > 0 ? Math.min(toleranceRaw, 1) : 0;

        // Calculate bounds for the proposal (for reliable positioning)
        console.debug('[createProposal] Calculating proposal bounds');
        const boundsStartTime = performance.now();
        const bounds = calculateProposalBounds(finalParcelIds, siteContext ? { site: siteContext.site } : {});
        console.debug('[createProposal] Bounds calculation took:', (performance.now() - boundsStartTime).toFixed(2), 'ms');

        if (publishingDraftId && window.proposalDraftStore?.getDraft?.(publishingDraftId)) {
            window.proposalDraftStore.updateDraft(publishingDraftId, {
                fields: {
                    name: proposalName || proposalType,
                    titleOrigin,
                    description,
                    selectedParcelIds: selectedLiveParcelIds,
                    acquisitionMode,
                    boundaryAdjustment: boundaryMode
                }
            }, { coalesceKey: 'publish-form' });
        }

        const proposal = {
            author,
            lifecycleStatus: 'Active',
            title: proposalName || proposalType, // Keep a stable human-readable title
            name: proposalName || proposalType,
            proposalName: proposalName || proposalType,
            titleOrigin,
            description: description || proposalName || proposalType,
            acquisitionMode: acquisitionMode,
            boundaryAdjustment: boundaryMode,
            cadastreParcelIds: authoredCadastreParcelIds,
            primaryType: proposalMainType,
            goal: selectedTool,
            applied: false,
            bounds: bounds, // Store bounds for reliable positioning
            createdAt: new Date().toISOString(), // Add creation timestamp
            // Which decade of the plan this builds — set in the dialog, sticky between creates.
            epochYear: (typeof window !== 'undefined' && window.__proposalEpoch)
                ? window.__proposalEpoch.readCreateDialogEpoch()
                : null,
            // The city this proposal's parcels belong to. Stamped at creation, not at upload, so a
            // proposal made in Zagreb and uploaded later from New York is still labelled Zagreb —
            // and so a shared link can be recognised as cross-city even without a ?city= param.
            city: getProposalCityId()
        };
        if (siteContext && siteContext.authored !== false) proposal.site = JSON.parse(JSON.stringify(siteContext.site));
        if (siteContext && siteContext.binding) proposal.binding = JSON.parse(JSON.stringify(siteContext.binding));
        if (toleranceM > 0) proposal.toleranceM = toleranceM;

        // Lineage for "Copy into new proposal". The source is never mutated — the fork just
        // records where it came from. Set by showProposalDialog() from its `copySource` override,
        // and re-cleared on every dialog open, so a plain create leaves this undefined.
        const proposalCopySource = (typeof window !== 'undefined') ? window.pendingProposalCopySource : null;
        if (proposalCopySource && proposalCopySource.proposalId) {
            const copySource = proposalStorage.getProposal(String(proposalCopySource.proposalId)) || proposalCopySource;
            proposal.proposalOrigin = window.ProposalOrigin.fromRecord(copySource, { relation: 'copy' });
            if (copySource.sourceReferences) proposal.sourceReferences = JSON.parse(JSON.stringify(copySource.sourceReferences));
        }
        if (publishingDraftId) {
            const source = window.pendingProposalReplacementSource || {};
            const draft = window.proposalDraftStore?.getDraft?.(publishingDraftId);
            const immutableSourceId = draft?.sourceLocalProposalId || source.proposalId || proposalCopySource?.proposalId || null;
            if (immutableSourceId) {
                // One's own local record is saved in place; a published one, or an explicit Fork,
                // makes a new record that links back (proposals/lineage.js editsInPlace).
                const editSource = proposalStorage.getProposal(String(immutableSourceId));
                proposal.proposalOrigin = window.ProposalOrigin.fromRecord(editSource || draft?.sourceSnapshot || {}, {
                    relation: 'revision', localProposalId: String(immutableSourceId)
                });
                if (window.ProposalLineage.editsInPlace(editSource, { fork: source.fork === true })) {
                    inPlaceSourceId = String(editSource.proposalId);
                }
            }
            proposal.proposalDraftId = publishingDraftId;
            proposal.proposalDraftRevision = draft?.revision ?? source.revision ?? null;
            // A counterproposal whose land differs from its origin's is a land fork: record the
            // origin set it departed from. Decided from the authored parcels, not from which button
            // started it, so an unchanged set stays a plain counterproposal with no landFork.
            const relationApi = window.ParcelSetRelations;
            const originSnapshot = draft?.sourceSnapshot || null;
            if (immutableSourceId && originSnapshot && relationApi && typeof relationApi.buildLandForkLineage === 'function') {
                const landFork = relationApi.buildLandForkLineage(
                    { ...originSnapshot, proposalId: String(immutableSourceId) },
                    authoredCadastreParcelIds, proposal.binding?.parcelSource || null
                );
                if (landFork) proposal.landFork = landFork;
            }
        }

        // Offering one's land expresses sale intent, not acceptance by every parcel owner.
        // Funding and consent remain separate; an unfunded offer cannot execute by local acceptance.
        if (selectedTool === 'ownership-transfer-from-me') {
            proposal.funded = false; // Explicitly mark as not funded - prevents execution
            proposal.ownershipTransferProposal = {
                direction: 'from-me'
            };
        }

        // "Ownership transfer to me" proposals record the direction and wait for the transfer.
        if (selectedTool === 'ownership-transfer-to-me') {
            proposal.ownershipTransferProposal = {
                direction: 'to-me',
                status: 'pending'
            };
        }

        // Record the three facets, and the explicit recipient (to-me / to-city /
        // third-party) so the proposal carries who receives the land beyond the
        // legacy to-me/from-me direction. (Recipient-accept enforcement is a later phase.)
        const chosenFacets = window.proposalFacets || null;
        if (chosenFacets) {
            proposal.facets = {
                landUse: chosenFacets.landUse,
                parcels: chosenFacets.parcels,
                ownership: chosenFacets.ownership
            };
            const recip = chosenFacets.ownership;
            if (recip === 'to-me' || recip === 'to-city' || recip === 'third-party') {
                proposal.ownershipTransferProposal = proposal.ownershipTransferProposal || {
                    direction: 'to-me',
                    status: 'pending'
                };
                proposal.ownershipTransferProposal.recipient = recip;
                if (recip === 'third-party') {
                    // 'any' = open offer to sell (recipient unspecified); 'specific' = named address.
                    proposal.ownershipTransferProposal.recipientScope = chosenFacets.recipientScope || 'specific';
                    if (chosenFacets.recipientScope !== 'any') {
                        proposal.ownershipTransferProposal.recipientAddress = chosenFacets.recipientAddress || '';
                    }
                }
            }
        }

        // Auto-tag structure proposals (park/square/lake) created from Purchase flow so they carry geometry and parent ids
        if (proposalMainType === 'Purchase' && (selectedTool === 'park' || selectedTool === 'square' || selectedTool === 'lake')) {
            const kind = selectedTool;
            let structureGeometry = null;
            try {
                if (siteContext) {
                    // A site-first structure is its authored geometry (the draft), else its site.
                    const draft = publishingDraftId ? window.proposalDraftStore?.getDraft?.(publishingDraftId) : null;
                    const authored = draft?.editorPayload?.structureProposal?.geometry || draft?.editorPayload?.geometry || null;
                    structureGeometry = authored || (siteContext.site.coordinates.length === 1
                        ? { type: 'Polygon', coordinates: siteContext.site.coordinates[0] } : siteContext.site);
                } else if (typeof buildGeometryFromParcels === 'function') {
                    if (finalParcelIds.length) {
                        structureGeometry = buildGeometryFromParcels(finalParcelIds);
                    }
                }
            } catch (_) { /* geometry rebuild best-effort */ }

            proposal.structureProposal = {
                kind,
                geometry: structureGeometry || null,
                blockName: formatParcelSelectionLabel(selectedLiveParcelIds)
            };
        }

        // Road/track proposals created through the constrained corridor modal
        if (selectedTool === 'road-track') {
            const corridor = pendingConstrainedCorridor || (typeof window !== 'undefined' ? window.pendingConstrainedCorridor : null);
            const roadDrawingContext = (typeof window !== 'undefined' && window.pendingRoadDrawingProposal)
                ? window.pendingRoadDrawingProposal
                : pendingRoadDrawingProposal;
            const safeClone = (value) => {
                if (!value) return value;
                try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
            };

            if (roadDrawingContext) {
                const isTrackContext = roadDrawingContext?.metadata?.isTrack === true;
                const selectedRoadParcelIds = (Array.isArray(roadDrawingContext.parcelIds) ? roadDrawingContext.parcelIds : selectedLiveParcelIds)
                    .map(id => id && id.toString ? id.toString() : String(id))
                    .filter(Boolean);
                // The parcels the drawing tool found, extended by every loaded cadastral parcel the
                // corridor polygon covers — including streets already under an applied road, which
                // the tool's live query skips (corridor pieces) but this road still takes.
                const roadCadastreParcelIds = typeof window.__cadastreAncestry?.declarationCoveringFootprint === 'function'
                    ? window.__cadastreAncestry.declarationCoveringFootprint({
                        cadastreParcelIds: liveFabric.cadastreIdsForParcelIds(selectedRoadParcelIds),
                        roadProposal: { definition: { polygon: roadDrawingContext.polygon } }
                    })
                    : liveFabric.cadastreIdsForParcelIds(selectedRoadParcelIds);

                const centerlinePoints = Array.isArray(roadDrawingContext.centerline)
                    ? roadDrawingContext.centerline
                        .map(segment => Array.isArray(segment)
                            ? segment.map(pt => {
                                if (!pt) return null;
                                const lat = Number(pt.lat !== undefined ? pt.lat : (Array.isArray(pt) ? pt[1] : null));
                                const lng = Number(pt.lng !== undefined ? pt.lng : (Array.isArray(pt) ? pt[0] : null));
                                if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
                                return { lat, lng };
                            }).filter(Boolean)
                            : null)
                        .filter(seg => Array.isArray(seg) && seg.length >= 2)
                    : [];

                const baseMetadata = (roadDrawingContext.metadata && typeof roadDrawingContext.metadata === 'object')
                    ? { ...roadDrawingContext.metadata }
                    : {};
                const resolvedMetadata = {
                    ...baseMetadata,
                    mode: baseMetadata.mode || 'draw',
                    type: baseMetadata.type || (isTrackContext ? 'track' : 'road'),
                    source: baseMetadata.source || 'road-drawing',
                    isTrack: isTrackContext,
                    isRoad: !isTrackContext, // tracks are NOT roads
                    isCorridor: true
                };
                const roadDefinition = {
                    points: centerlinePoints,
                    segments: centerlinePoints,
                    // Index-aligned with `segments`: identity survives a copy, so continuing a road in a
                    // later session extends the same segment instead of minting a new one.
                    segmentIds: Array.isArray(roadDrawingContext.segmentIds)
                        ? roadDrawingContext.segmentIds.slice(0, centerlinePoints.length)
                        : [],
                    // The cross-section. `width` below is its total, kept as a cache for the many
                    // consumers that only need the corridor's footprint.
                    profile: safeClone(roadDrawingContext.profile) || null,
                    width: Number.isFinite(roadDrawingContext.width) ? roadDrawingContext.width : (isTrackContext ? DEFAULT_CORRIDOR_WIDTHS.track : DEFAULT_CORRIDOR_WIDTHS.road),
                    sidewalkWidth: Number.isFinite(roadDrawingContext.sidewalkWidth) ? roadDrawingContext.sidewalkWidth : null,
                    tunnels: safeClone(roadDrawingContext.tunnels) || [],
                    gradeSeparations: safeClone(roadDrawingContext.gradeSeparations) || [],
                    segmentProfiles: safeClone(roadDrawingContext.segmentProfiles) || {},
                    polygon: roadDrawingContext.polygon ? safeClone(roadDrawingContext.polygon) : null,
                    metadata: resolvedMetadata
                };

                // The profile is the truth; if one is present the stored width must be its sum, or the
                // corridor polygon and its cross-section would disagree about the footprint.
                const profileWidth = (typeof corridorProfileWidth === 'function') ? corridorProfileWidth(roadDefinition.profile) : 0;
                if (profileWidth > 0) roadDefinition.width = profileWidth;

                if (roadDrawingContext.stats) {
                    const statsClone = safeClone(roadDrawingContext.stats);
                    roadDefinition.metadata.ownershipAndAcquisitionStats = statsClone;
                    proposal.ownershipAndAcquisitionStats = statsClone;
                }

                proposal.primaryType = isTrackContext ? 'Track' : 'Road';
                proposal.goal = 'road-track';
                proposal.isCorridor = true;
                proposal.cadastreParcelIds = roadCadastreParcelIds;

                proposal.roadProposal = {
                    definition: safeClone(roadDefinition),
                    mode: resolvedMetadata.mode,
                    isCorridor: true,
                    ownershipAndAcquisitionStats: roadDrawingContext.stats ? safeClone(roadDrawingContext.stats) : null
                };
            } else {
                if (!corridor) {
                    const tCorridor = getCorridorI18nHelper();
                    showProposalAlertMessage('corridor_missing', tCorridor('statusMissing', 'Open the constrained corridor tool and click Done before creating a road/track proposal.'));
                    return;
                }

                const selectedCorridorParcelIds = (Array.isArray(corridor.parcelIds) ? corridor.parcelIds : selectedLiveParcelIds)
                    .map(id => id && id.toString ? id.toString() : String(id))
                    .filter(Boolean);
                const corridorCadastreParcelIds = liveFabric.cadastreIdsForParcelIds(selectedCorridorParcelIds);
                const polygonGeometry = corridor.polygon || corridor.superGeometry || null;
                const centerlinePoints = Array.isArray(corridor.centerline)
                    ? corridor.centerline.map(pair => {
                        if (!Array.isArray(pair) || pair.length < 2) return null;
                        const lng = Number(pair[0]);
                        const lat = Number(pair[1]);
                        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
                        return { lat, lng };
                    }).filter(Boolean)
                    : [];
                const fallbackWidth = corridor.type === 'track' ? DEFAULT_CORRIDOR_WIDTHS.track : DEFAULT_CORRIDOR_WIDTHS.road;
                const isTrackCorridor = corridor.type === 'track';
                const roadDefinition = {
                    points: centerlinePoints,
                    width: Number.isFinite(corridor.width) ? corridor.width : fallbackWidth,
                    polygon: polygonGeometry ? safeClone(polygonGeometry) : null,
                    metadata: {
                        mode: corridor.mode || 'draw',
                        type: corridor.type || 'road',
                        isTrack: isTrackCorridor,
                        isRoad: !isTrackCorridor, // tracks are NOT roads
                        isCorridor: true,
                        source: 'constrained-corridor'
                    }
                };

                proposal.primaryType = corridor.type === 'track' ? 'Track' : 'Road';
                proposal.goal = 'road-track';
                proposal.isCorridor = true;
                proposal.cadastreParcelIds = corridorCadastreParcelIds;

                proposal.roadProposal = {
                    definition: safeClone(roadDefinition),
                    mode: corridor.mode || 'draw',
                    isCorridor: true
                };

                // Clear the pending corridor so it isn't reused accidentally
                pendingConstrainedCorridor = null;
                if (typeof window !== 'undefined') {
                    window.pendingConstrainedCorridor = null;
                }
            }

            // Clear any consumed road drawing context
            pendingRoadDrawingProposal = null;
            if (typeof window !== 'undefined') {
                window.pendingRoadDrawingProposal = null;
            }
        }

        console.debug('[createProposal] Building proposal object complete, adding lens data');
        // Skip lens for ownership-transfer-from-me proposals
        const skipLens = selectedTool === 'ownership-transfer-from-me';
        if (!skipLens) {
            const lensSnapshot = normalizeLensEntries(typeof getLensEntries === 'function' ? getLensEntries() : []);
            if (lensSnapshot.length) {
                proposal.lens = lensSnapshot;
            }
        }
        console.debug('[createProposal] Proposal object ready');

        // Local authored records are distinct; publication deduplication uses the content fingerprint.

        // Building/urban-rule proposals: consume pendingBuildingProposalContext
        const pendingBuildingContext = (typeof window !== 'undefined' ? window.pendingBuildingProposalContext : null)
            || (typeof pendingBuildingProposalContext !== 'undefined' ? pendingBuildingProposalContext : null);
        if (selectedTool === 'buildings' || selectedTool === 'row' || selectedTool === 'parcelBased' || selectedTool === 'single') {
            if (!pendingBuildingContext || !pendingBuildingContext.parcelIds || !pendingBuildingContext.parcelIds.length) {
                showProposalAlertMessage('building_design_missing', 'Open the building/urban rule tool and click Done before creating this proposal.');
                setProposalModalInteractivity(true);
                setProposalCreateButtonState(false);
                return;
            }

            const safeClone = (value) => {
                if (!value) return value;
                try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
            };

            const rawBuildings = (pendingBuildingContext.buildings && pendingBuildingContext.buildings.length)
                ? pendingBuildingContext.buildings
                : (pendingBuildingContext.buildingFeature ? [pendingBuildingContext.buildingFeature] : []);
            const buildingFeatures = rawBuildings.map(safeClone).filter(f => f && f.geometry);

            if (!buildingFeatures.length) {
                showProposalAlertMessage('building_design_missing', 'Open the building/urban rule tool and click Done before creating this proposal.');
                setProposalModalInteractivity(true);
                setProposalCreateButtonState(false);
                return;
            }

            const resolvedTypology = (pendingBuildingContext.parameters && pendingBuildingContext.parameters.typology)
                ? String(pendingBuildingContext.parameters.typology)
                : (selectedTool === 'row' ? 'row' : (selectedTool === 'parcelBased' ? 'parcelBased' : 'block'));

            const designParcelIds = pendingBuildingContext.parcelIds.map(String).filter(Boolean);

            proposal.primaryType = 'Urban Rule';
            proposal.goal = selectedTool === 'single' ? 'single' : 'buildings';
            proposal.typologyType = resolvedTypology;
            // This is the complete authored selection, including block parcels where the rule did
            // not manage to place a building. addProposal projects it to one flat root
            // cadastreParcelIds declaration; output buildings must never redefine that scope.
            // A site design's parcels are synthetic (the site, or plots cut from it): its
            // declaration is the site's binding, never a projection of those ids.
            proposal.cadastreParcelIds = siteContext
                ? authoredCadastreParcelIds.slice()
                : liveFabric.cadastreIdsForParcelIds(designParcelIds);
            proposal.tags = ['buildings'];

            if (!proposal.geometry) proposal.geometry = {};
            proposal.geometry.buildings = buildingFeatures;
            // "Based on existing buildings" keeps each real footprint whole, and the server returns
            // any building at least half inside the block — so one can stand partly on a neighbour
            // or street parcel. That land is genuinely under the proposal: declare it.
            if (pendingBuildingContext.parameters?.mode === 'existing'
                && typeof window.__cadastreAncestry?.declarationCoveringFootprint === 'function') {
                proposal.cadastreParcelIds = window.__cadastreAncestry.declarationCoveringFootprint(proposal);
            }
            const blockMassing = resolvedTypology === 'block'
                ? safeClone(pendingBuildingContext.blockMassing)
                : null;
            if (blockMassing?.geometry) proposal.geometry.blockMassing = blockMassing;
            else delete proposal.geometry.blockMassing;
            // Building surroundings belong to the same authored design for every typology.
            const groundSurface = safeClone(pendingBuildingContext.groundSurface);
            if (groundSurface) proposal.geometry.groundSurface = groundSurface;
            else delete proposal.geometry.groundSurface;

            proposal.buildingProposal = {
                typologyType: resolvedTypology,
                createdFrom: resolvedTypology === 'row' ? 'rowHouse' : (resolvedTypology === 'parcelBased' ? 'parcelBased' : 'blockify'),
                blockName: pendingBuildingContext.blockName || formatParcelSelectionLabel(designParcelIds),
                parameters: safeClone(pendingBuildingContext.parameters) || {},
                ineligibleParcels: safeClone(pendingBuildingContext.ineligibleParcels) || [],
                // §15a: how a FREEFORM building forms its parcel — footprint parcel by default,
                // whole host parcels when the author chose so in the design modal.
                ...(selectedTool === 'single' && pendingBuildingContext.takeWholeParcels === true
                    ? { takeWholeParcels: true } : {})
            };

            // Clear the pending context so it isn't reused accidentally
            if (typeof window !== 'undefined') {
                window.pendingBuildingProposalContext = null;
                window.pendingBuildingFromBlockify = null;
            }
            if (typeof setPendingBuildingProposalContext === 'function') {
                setPendingBuildingProposalContext(null);
            }
        }

        if (publishingDraftId) {
            const validatedDraft = window.proposalDraftStore?.validateDraft?.(publishingDraftId);
            if (!validatedDraft?.validation?.valid) {
                const validationError = new Error('Draft validation failed before publishing.');
                validationError.code = 'DRAFT_VALIDATION_FAILED';
                validationError.validation = validatedDraft?.validation || null;
                markDraftPublishFailed(validationError);
                throw validationError;
            }
            window.proposalDraftStore.markPublishing(publishingDraftId);
        }

        // Persist the proposal (this device only; publishing is a separate step)
        console.debug('[createProposal] Saving proposal to storage');
        const saveStartTime = performance.now();
        updateStatus('Saving proposal...');
        if (!waitingPopupVisible) {
            showProposalWaitingPopup('Saving proposal...');
            waitingPopupVisible = true;
            setProposalModalDimmed(true);
        }
        // An edit of one's own local record rewrites it in place, and takes what stands on ground
        // the edit changes off the map once the user agrees; every other save adds a new record.
        let proposalId = null;
        if (inPlaceSourceId) {
            const dependents = ProposalManager.findEditDependents(inPlaceSourceId, proposal);
            if (dependents.length && !(await window.confirmProposalEditDependents(dependents))) {
                hideWaitingPopupSafe();
                updateStatus(t('proposalDrafts.dependents.notSaved', 'The edit was not saved. The design has been reopened.'));
                setProposalModalInteractivity(true);
                setProposalCreateButtonState(false);
                return;
            }
            const updated = await ProposalManager.updateProposalInPlace(inPlaceSourceId, proposal, {
                unapplyIds: dependents.map(record => String(record.proposalId))
            });
            if (updated) proposalId = inPlaceSourceId;
        } else {
            proposalId = proposalStorage.addProposal(proposal);
        }
        console.debug('[createProposal] Proposal save took:', (performance.now() - saveStartTime).toFixed(2), 'ms');
        if (proposalId === null) {
            hideWaitingPopupSafe();
            updateStatus('Unable to save proposal.');
            setProposalModalInteractivity(true);
            setProposalCreateButtonState(false);
            markDraftPublishFailed(Object.assign(new Error('Unable to save the proposal.'), { code: 'PROPOSAL_STORAGE_FAILED' }));
            return;
        }
        const storedRecord = proposalStorage.getProposal(proposalId);
        const storedProposalId = storedRecord?.proposalId || proposal.proposalId || proposalId;
        // Every editor draft survives modal closes and failures. Only successful proposal
        // persistence consumes it, atomically recording a receipt for retry idempotency.
        if (publishingDraftId && window.proposalDraftStore?.getDraft?.(publishingDraftId)) {
            window.proposalDraftStore.consumeAfterPublish(publishingDraftId, storedProposalId);
        }

        // Update the show proposals button count
        console.debug('[createProposal] Updating UI and logging user action');
        updateShowProposalsButton();
        // Log user action for proposal creation
        const userAgent = getCurrentUserAgent();
        if (userAgent && typeof addUserActionToGameLog === 'function') {
            const storedProposal = typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function'
                ? proposalStorage.getProposal(proposalId)
                : null;
            const proposalIdForLog = storedProposal && storedProposal.proposalId !== undefined && storedProposal.proposalId !== null
                ? String(storedProposal.proposalId)
                : String(storedProposalId);
            const proposalIdAttr = storedProposal && storedProposal.proposalId !== undefined && storedProposal.proposalId !== null
                ? String(storedProposal.proposalId)
                : String(proposalId);
            // The links run script (the game log binds the -clickable hooks): cb-link buttons.
            const proposalLinkHtml = `<button type="button" data-proposal-id="${proposalIdAttr}" class="cb-link proposal-link-clickable">${proposalIdForLog}</button>`;
            addUserActionToGameLog(`<button type="button" data-agent-id="${userAgent.id}" class="cb-link agent-link-clickable">${userAgent.name}</button> created a ${proposalType} proposal (${proposalLinkHtml}) for ${proposal.cadastreParcelIds.length} parcel(s).`);

            // Update user agent's created proposals
            if (!userAgent.proposalsCreated) {
                userAgent.proposalsCreated = [];
            }
            if (!userAgent.proposalsCreated.includes(proposalId)) {
                userAgent.proposalsCreated.push(proposalId);
                agentStorage.updateAgent(userAgent.id, { proposalsCreated: userAgent.proposalsCreated });
            }
        }

        // Hide parcel info panel if needed
        if (typeof hideParcelInfoPanel === 'function') {
            hideParcelInfoPanel();
        }

        // Close dialog
        closeProposalDialog();

        // Update proposal list if open
        updateProposalList();

        updateStatus(`Proposal "${proposalType}" created successfully with ${proposal.cadastreParcelIds.length} parcels.`);

        if (typeof multiParcelSelection !== 'undefined') {
            if (createdFromMultiSelect && multiParcelSelection.isActive) {
                cancelMultiParcelSelection();
            } else if (multiParcelSelection.selectedParcels) {
                multiParcelSelection.selectedParcels.clear();
                multiParcelSelection.lastSelectedParcelId = null;
                if (typeof multiParcelSelection.updateUI === 'function') {
                    multiParcelSelection.updateUI();
                }
            }
        }

        // Records are the only source of live fabric. The canonical apply path flips the snapshot
        // and derives the local tessellation once (an in-place save already stands applied).
        try {
            const applied = await ProposalManager.applyProposal(proposalId);
            if (!applied) throw new Error('The saved proposal could not be derived from the cadastral fabric.');
        } catch (replayError) {
            console.warn('[createProposal] Could not replay the saved proposal', replayError);
            updateStatus('Proposal saved, but it could not be applied to the cadastral fabric.');
        }

        const openProposalDetails = () => {
            if (!waitingPopupVisible) {
                waitingPopupVisible = true;
                setProposalModalDimmed(true);
            }
            // The placed proposal opens in the click stack, its Design section expanded, without
            // moving the map (click-stack.md).
            window.ClickStack.showDesign(proposalId);
            // Hide popup after a short delay to allow panel to render
            setTimeout(() => {
                hideWaitingPopupSafe();
            }, 500);
        };

        console.debug('[createProposal] All proposal creation steps complete, opening details. Total elapsed:', (performance.now() - startTime).toFixed(2), 'ms');
        openProposalDetails();

    } catch (error) {
        console.error('Error creating proposal:', error);
        markDraftPublishFailed(error);
        const fallback = t('alerts.messages.failed_to_create_proposal', 'Failed to create proposal.');
        const message = (error && error.message) ? error.message : fallback;
        if (typeof window !== 'undefined' && typeof window.showStyledAlert === 'function') {
            window.showStyledAlert(message);
        } else {
            window.CbDialog.alert(message);
        }
    } finally {
        hideWaitingPopupSafe();
        setProposalModalInteractivity(true);
        setProposalCreateButtonState(false);
    }
}

function handleCreateProposalHotkey(event) {
    if (!event) return;
    // Don't trigger if modifier keys are pressed
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // Don't trigger if typing in an input field
    if (isEditableElement(event.target)) return;
    // Skip while any parcel drawing mode is active (drawing tools manage their own flows)
    if (typeof window !== 'undefined' && typeof window.isParcelDrawingModeActive === 'function' && window.isParcelDrawingModeActive()) return;
    // Only respond to 'C' key
    if (event.key !== 'c' && event.key !== 'C') return;

    // Check if a modal is already open (don't open another one)
    const existingModal = document.querySelector('.create-proposal-modal');
    if (existingModal) return;

    const commands = typeof window !== 'undefined' ? window.UiCommands : null;
    if (!commands || typeof commands.createBrowserContext !== 'function'
        || typeof commands.isAvailable !== 'function' || typeof commands.runCommand !== 'function') return;
    const commandContext = commands.createBrowserContext(window);
    const multi = typeof window !== 'undefined' ? window.multiParcelSelection : null;
    const commandId = multi && multi.isActive ? 'selection.propose' : 'parcel.propose';
    // Match the parcel menu or selection tray authoring capability. In model/photo views C has no effect.
    if (!commands.supportsMode(commandId, commandContext)) return;

    // Check if there are any parcels selected (single or multi-selection)
    const selection = getCurrentParcelSelectionContext();
    if (!selection || !selection.ids || selection.ids.length === 0) {
        // No parcels selected, show a status message
        if (typeof updateStatus === 'function') {
            const t = getProposalI18nHelper();
            const noParcelsMessage = t(
                'status.messages.please_select_at_least_one_parcel_to_create_a_proposal',
                'Please select at least one parcel to create a proposal.'
            );
            updateStatus(noParcelsMessage);
        }
        return;
    }

    if (!commands.isAvailable(commandId, commandContext)) return;

    // Dispatch the same canonical proposal palette as the selection tray.
    event.preventDefault();
    commands.runCommand(commandId, commandContext);
}

function attachCreateProposalHotkey() {
    if (createProposalHotkeyAttached) return;
    document.addEventListener('keydown', handleCreateProposalHotkey);
    createProposalHotkeyAttached = true;
}
