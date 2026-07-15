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
        // Relabel the submit action for vote proposals (no ownership/parcel change), so the
        // proposer sees the outcome ("Submit for voting" → status "Open for voting").
        const facets = (typeof window !== 'undefined' && window.proposalFacets) || {};
        const isVote = facets.ownership === 'no-change' && facets.parcels === 'as-is';
        const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
        btn.textContent = isVote
            ? (t ? t('panel.proposal.voting.submit', 'Submit for voting') : 'Submit for voting')
            : (t ? t('modal.createProposal.submit', 'Create Proposal') : 'Create Proposal');
    }
    if (hint) {
        hint.textContent = (!hasGeometry) ? 'Please add a geometry first.' : '';
    }
    // Show/hide the vote expiry field alongside the relabel.
    if (typeof updateVoteExpiryFieldVisibility === 'function') {
        updateVoteExpiryFieldVisibility();
    }
}

// Show the "voting period (days)" input only for vote proposals, and clamp it to 1..365.
function updateVoteExpiryFieldVisibility() {
    const wrap = document.getElementById('proposalVoteExpiryWrap');
    if (!wrap) return;
    const facets = (typeof window !== 'undefined' && window.proposalFacets) || {};
    const isVote = facets.ownership === 'no-change' && facets.parcels === 'as-is';
    wrap.style.display = isVote ? '' : 'none';
    const input = document.getElementById('proposalVoteExpiryDays');
    if (input && !input.value) {
        input.value = '365';
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
    'decide later': 'modal.createProposal.goalOptions.decideLater',
    'reparcellization': 'modal.createProposal.goalOptions.reparcellization',
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

function generateDefaultProposalName(proposalType) {
    const localizedType = localizeProposalTypeLabel(proposalType);
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const minute = String(now.getMinutes()).padStart(2, '0');
    return `${localizedType} ${day}${month}-${hour}${minute}`;
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
        if (forceUpdate || !nameInput.value.trim()) {
            nameInput.value = generateDefaultProposalName(proposalType);
        }
    }

    if (descriptionInput) {
        if (forceUpdate || !descriptionInput.value.trim()) {
            const proposalName = nameInput && nameInput.value.trim() ? nameInput.value.trim() : generateDefaultProposalName(proposalType);
            descriptionInput.value = generateDefaultProposalDescription(proposalType, proposalName);
        }
    }
}

async function createStructureProposalFromDialog(kind, parcelIds, geometry, blockName) {
    const author = getProposalAuthorValue();
    const title = (document.getElementById('proposalName')?.value || '').trim();
    const description = (document.getElementById('proposalDescription')?.value || '').trim();
    const offer = window.parseProposalOfferValue(document.getElementById('proposalOffer')?.value) || 0;
    const offerCurrency = document.getElementById('proposalCurrency')?.value || 'USDT';
    if (!author || !title || offer <= 0) {
        showProposalAlertMessage('please_provide_author_name_and_a_valid_offer', 'Please provide author, name, and a valid offer.');
        return;
    }
    if (!Array.isArray(parcelIds) || parcelIds.length === 0 || !geometry) {
        showProposalAlertMessage('missing_parcels_or_geometry_for_this_proposal', 'Missing parcels or geometry for this proposal.');
        return;
    }

    // Check for expiry option
    const expireCheckbox = document.getElementById('proposalExpireCheckbox');
    const expiryTimeInput = document.getElementById('proposalExpiryTime');
    let expiresAt = null;
    if (expireCheckbox && expireCheckbox.checked && expiryTimeInput) {
        const expiryMs = parseExpiryTime(expiryTimeInput.value);
        if (expiryMs > 0) {
            expiresAt = new Date(Date.now() + expiryMs).toISOString();
        }
    }

    // Check for decay option
    const decayCheckbox = document.getElementById('proposalDecayCheckbox');
    const decayPercentInput = document.getElementById('proposalDecayPercent');
    const decayTimeInput = document.getElementById('proposalDecayTime');
    let decayEnabled = false;
    let decayPercent = 0;
    let decayDurationMs = 0;
    if (decayCheckbox && decayCheckbox.checked && decayPercentInput && decayTimeInput) {
        decayEnabled = true;
        decayPercent = Math.min(100, Math.max(1, parseInt(decayPercentInput.value, 10) || 50));
        decayDurationMs = parseExpiryTime(decayTimeInput.value);
    }

    // Check for deposit option
    const depositCheckbox = document.getElementById('proposalDepositCheckbox');
    const depositPercentInput = document.getElementById('proposalDepositPercent');
    let depositEnabled = false;
    let depositPercent = 0;
    if (depositCheckbox && depositCheckbox.checked && depositPercentInput) {
        depositEnabled = true;
        // Clamp between 10% and 200%
        depositPercent = Math.min(200, Math.max(10, parseInt(depositPercentInput.value, 10) || 100));
    }

    let lakeGraphics = null;
    let structureGeometry = geometry;
    if (kind === 'lake') {
        lakeGraphics = buildLakeGraphicsFromGeometry(geometry);
        if (!lakeGraphics || !lakeGraphics.geometry) {
            showProposalAlertMessage('parcels_not_contiguous', 'Parcels not contiguous');
            return;
        }
        structureGeometry = lakeGraphics.geometry || geometry;
    }

    const parentParcelIds = normalizeParcelIdList(parcelIds || []);

    const proposal = {
        author,
        title,
        name: title,
        proposalName: title,
        description: description || title,
        offer,
        offerCurrency,
        budget: offer,
        budgetCurrency: offerCurrency,
        parentParcelIds,
        city: getProposalCityId(),
        type: 'structure',
        structureProposal: {
            kind: (kind === 'park' || kind === 'square' || kind === 'lake') ? kind : 'square',
            status: 'unapplied',
            geometry: structureGeometry,
            parentParcelIds,
            blockName: blockName || null,
            lakeGraphics: lakeGraphics || null,
            // Structures clear their ground by default — no prompt.
            demolishedBuildings: (typeof demolishBuildingsUnderFootprint === 'function')
                ? (typeof ensureCorridorBuildingFootprintsLoaded === 'function'
                    ? await ensureCorridorBuildingFootprintsLoaded().then(() => demolishBuildingsUnderFootprint(structureGeometry))
                    : await demolishBuildingsUnderFootprint(structureGeometry))
                : []
        },
        termsConfirmed: true,
        createdAt: new Date().toISOString(),
        expiresAt: expiresAt,
        decayEnabled: decayEnabled,
        decayPercent: decayPercent,
        decayDurationMs: decayDurationMs,
        depositEnabled: depositEnabled,
        depositPercent: depositPercent
    };

    const lensSnapshot = normalizeLensEntries(typeof getLensEntries === 'function' ? getLensEntries() : []);
    if (lensSnapshot.length) {
        proposal.lens = lensSnapshot;
    }

    const proposalId = proposalStorage.addProposal(proposal);
    if (!proposalId) {
        showProposalAlertMessage('an_identical_proposal_already_exists', 'An identical proposal already exists.');
        return;
    }
    const primaryParcelId = parentParcelIds.length ? parentParcelIds[0] : null;
    // Link proposal to ancestors
    try { if (typeof ProposalManager !== 'undefined' && ProposalManager._linkProposalToAncestors) ProposalManager._linkProposalToAncestors(proposalId, parentParcelIds); } catch (_) { }

    // Close and update UI
    closeProposalDialog();
    try { if (typeof updateShowProposalsButton === 'function') updateShowProposalsButton(); } catch (_) { }
    try { if (typeof enableShowProposalsMode === 'function') enableShowProposalsMode(); } catch (_) { }

    // Open the details panel collapsed on first appearance (see showProposalInfo).
    if (typeof window !== 'undefined') window.__openProposalDetailsCollapsed = true;

    // No auto-apply on creation: the structure geometry is already on the map as an applied draft
    // before the proposal exists (we switched to auto-applying drafts). Just focus the details.
    if (typeof focusProposalDetails === 'function') {
        focusProposalDetails(proposalId, { parcelId: primaryParcelId, centerOnProposal: true });
    }
}

async function createProposal() {
    console.debug('[createProposal] START - Create proposal button clicked');
    const startTime = performance.now();
    const t = getProposalI18nHelper();
    const publishingDraftId = (typeof window !== 'undefined' && window.pendingProposalDraftId)
        ? String(window.pendingProposalDraftId)
        : null;
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
    const goalBadge = getProposalGoalBadge(selectedTool);

    // All proposal types are handled uniformly below.
    // Building/urban-rule geometry is expected in pendingBuildingProposalContext (set by geometry tools).

    const author = getProposalAuthorValue();
    const proposalTypeInput = document.getElementById('proposalType');
    const proposalType = proposalTypeInput && proposalTypeInput.value ? proposalTypeInput.value : DEFAULT_PROPOSAL_TYPE;
    const proposalMainTypeInput = document.getElementById('proposalMainType');
    const proposalMainType = proposalMainTypeInput && proposalMainTypeInput.value ? proposalMainTypeInput.value : 'Purchase';
    const pendingReparcelPlan = (typeof window !== 'undefined') ? window.pendingReparcellizationPlan : null;
    if (proposalMainType === 'Reparcellization') {
        if (!pendingReparcelPlan || !Array.isArray(pendingReparcelPlan.polygons) || pendingReparcelPlan.polygons.length === 0) {
            showProposalAlertMessage('run_the_reparcellization_algorithm_and_click_done_before_creating_this_proposal', 'Run the reparcellization algorithm and click Done before creating this proposal.');
            return;
        }
    }
    const proposalName = (document.getElementById('proposalName') && document.getElementById('proposalName').value || '').trim();
    const description = document.getElementById('proposalDescription').value.trim();
    const offer = window.parseProposalOfferValue(document.getElementById('proposalOffer').value) || 0;
    const offerCurrencySelect = document.getElementById('proposalCurrency');
    const offerCurrency = offerCurrencySelect && offerCurrencySelect.value ? offerCurrencySelect.value : 'USDT';
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
    if (offer <= 0) {
        showProposalAlertMessage('please_enter_a_valid_offer_amount', 'Please enter a valid offer amount.');
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

        const createdFromMultiSelect = multiParcelSelection.isActive && multiParcelSelection.selectedParcels.size > 1;

        if (multiParcelSelection.selectedParcels.size > 0) {
            finalParcelIds = Array.from(multiParcelSelection.selectedParcels);
        } else if (typeof selectedParcelId !== 'undefined' && selectedParcelId) {
            finalParcelIds = [selectedParcelId];
        }

        console.debug('[createProposal] Final parcel IDs:', finalParcelIds.length, 'parcels');
        if (finalParcelIds.length === 0) {
            showProposalAlertMessage('no_parcels_selected_please_select_parcels_before_creating_a_proposal', 'No parcels selected. Please select parcels before creating a proposal.');
            return;
        }

        // Check if parcels have NFTs on-chain before proceeding
        console.debug('[createProposal] Checking blockchain support and wallet connection');
        const blockchainSupported = typeof window.ProposalChainBridge !== 'undefined'
            && window.ProposalChainBridge.isSupported();
        const solanaBlockchainSupported = typeof window.SolanaProposalChainBridge !== 'undefined'
            && window.SolanaProposalChainBridge.isSupported();

        // First check if wallet is connected - skip all NFT checking if not connected
        let walletManager = window.walletManager;
        let isEvmWalletConnected = false;
        if (walletManager && typeof walletManager.getState === 'function') {
            const walletState = walletManager.getState();
            isEvmWalletConnected = walletState && walletState.status === 'connected'
                && Array.isArray(walletState.accounts) && walletState.accounts.length > 0;
        }
        const solWm = window.solanaWalletManager;
        const isSolanaWalletConnected = solWm && typeof solWm.getState === 'function'
            && solWm.getState().status === 'connected'
            && Array.isArray(solWm.getState().accounts) && solWm.getState().accounts.length > 0;
        const isWalletConnected = isEvmWalletConnected || isSolanaWalletConnected;
        // Canton is a custodial network (no wallet) selected via CantonMode. When
        // active we mint on Canton instead of EVM/Solana — and skip NFT checks.
        const cantonActive = !!(window.CantonMode && typeof window.CantonMode.isActive === 'function' && window.CantonMode.isActive());

        console.debug('[createProposal] Blockchain supported:', blockchainSupported, 'Solana supported:', solanaBlockchainSupported, 'Wallet connected:', isWalletConnected, 'Canton:', cantonActive);
        let shouldMintOnchain = ((((blockchainSupported || solanaBlockchainSupported) && isWalletConnected) || cantonActive) && finalParcelIds.length > 0);

        // Use the parent parcel IDs directly - these are what the proposal references
        const parcelIds = finalParcelIds.map(id => (id && id.toString ? id.toString() : String(id))).filter(Boolean);

        // Build a feature map for parcels (used when minting prerequisites to get parcel names)
        const parcelFeatureById = new Map();
        for (const parcelId of parcelIds) {
            let parcelLayer = null;
            if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection.findParcelById) {
                parcelLayer = multiParcelSelection.findParcelById(parcelId);
            }
            if (!parcelLayer && typeof resolveParcelLayerById === 'function') {
                parcelLayer = resolveParcelLayerById(parcelId);
            }
            if (parcelLayer && parcelLayer.feature) {
                parcelFeatureById.set(parcelId, parcelLayer.feature);
            }
        }

        if (shouldMintOnchain && !cantonActive) {
            // Get chain ID from wallet or use default
            let chainId = null;
            if (isSolanaWalletConnected) {
                const cluster = solWm.getCluster ? solWm.getCluster() : 'devnet';
                chainId = `solana-${cluster}`;
            } else if (walletManager && typeof walletManager.getState === 'function') {
                const walletState = walletManager.getState();
                chainId = walletState?.chainId || null;
            }

            // If no chain ID from wallet, try to get from default
            if (!chainId) {
                const globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
                if (globalScope && globalScope.DEFAULT_CHAIN_ID !== undefined && globalScope.DEFAULT_CHAIN_ID !== null) {
                    chainId = globalScope.DEFAULT_CHAIN_ID;
                } else {
                    const env = globalScope?.current_environment || 'production';
                    chainId = env === 'development' ? '31337' : '84532';
                }
            }

            // Check if parent parcels have NFTs on-chain
            console.debug('[createProposal] Checking if parcels have NFTs on-chain, parcel count:', parcelIds.length);
            const nftCheckStartTime = performance.now();
            updateStatus('Checking if parcels have NFTs on-chain...');
            const isSolanaChain = typeof chainId === 'string' && chainId.startsWith('solana');
            const parcelCheckResult = isSolanaChain
                ? await checkParcelsHaveNFTsSolana(parcelIds, chainId)
                : await checkParcelsHaveNFTs(parcelIds, chainId);
            console.debug('[createProposal] NFT check took:', (performance.now() - nftCheckStartTime).toFixed(2), 'ms');

            if (!parcelCheckResult.allHaveNFTs && parcelCheckResult.missingParcels.length > 0) {
                // Some parcels don't have NFTs - show modal
                const chainDisplay = parcelCheckResult.chainName || parcelCheckResult.chainId || 'the blockchain';
                const action = await showMissingParcelsModal(parcelCheckResult.missingParcels, chainDisplay);

                if (action === 'mint') {
                    const mintableParcels = parcelCheckResult.missingParcels.map((parcelId) => {
                        const idStr = parcelId && parcelId.toString ? parcelId.toString() : String(parcelId);
                        const feature = parcelFeatureById.get(idStr) || null;
                        const props = feature && feature.properties ? feature.properties : {};
                        const parcelName = props.name || props.parcel_name || props.parcel || props.BROJ_CESTICE || `Parcel ${idStr}`;
                        return { parcelId: idStr, parcelName, feature };
                    });

                    try {
                        await openParcelMintModal({
                            parcels: mintableParcels,
                            onExit: () => {
                                updateStatus('Mint the prerequisite parcel NFTs, then click Create again.');
                            }
                        });
                        updateStatus('Mint the prerequisite parcel NFTs, then click Create again.');
                    } catch (mintModalError) {
                        console.error('Unable to open mint modal for missing parcels', mintModalError);
                        updateStatus('Unable to open mint modal. Please mint parcels before creating the proposal.');
                    }
                    return;
                }

                if (action !== 'memory') {
                    updateStatus('Proposal creation cancelled.');
                    return;
                }

                // User chose to proceed with local-only proposal
                shouldMintOnchain = false;
                updateStatus('Creating in-memory proposal (not minted on-chain)...');
            } else if (parcelCheckResult.allHaveNFTs) {
                // All parcels have NFTs - proceed silently with on-chain minting
                updateStatus('All parcels have NFTs. Proceeding with on-chain proposal...');
            }
        }

        // Calculate bounds for the proposal (for reliable positioning)
        console.debug('[createProposal] Calculating proposal bounds');
        const boundsStartTime = performance.now();
        const bounds = calculateProposalBounds(finalParcelIds);
        console.debug('[createProposal] Bounds calculation took:', (performance.now() - boundsStartTime).toFixed(2), 'ms');

        // Check for expiry option
        const expireCheckbox = document.getElementById('proposalExpireCheckbox');
        const expiryTimeInput = document.getElementById('proposalExpiryTime');
        let expiresAt = null;
        if (expireCheckbox && expireCheckbox.checked && expiryTimeInput) {
            const expiryMs = parseExpiryTime(expiryTimeInput.value);
            if (expiryMs > 0) {
                expiresAt = new Date(Date.now() + expiryMs).toISOString();
            }
        }

        // A proposal that changes neither ownership nor parcels is a non-binding VOTE. It gets a
        // voting deadline (default and max 1 year) instead of the short auction-style expiry above,
        // and carries no offer/budget — the tally is a public record of support, nothing settles.
        const voteFacets = (typeof window !== 'undefined' && window.proposalFacets) || {};
        const isVoteCreate = voteFacets.ownership === 'no-change' && voteFacets.parcels === 'as-is';
        const VOTE_MAX_DAYS = 365;
        let voteExpiryDays = 0;
        if (isVoteCreate) {
            const voteExpiryInput = document.getElementById('proposalVoteExpiryDays');
            const rawDays = voteExpiryInput ? parseInt(voteExpiryInput.value, 10) : NaN;
            voteExpiryDays = (Number.isFinite(rawDays) && rawDays > 0) ? Math.min(rawDays, VOTE_MAX_DAYS) : VOTE_MAX_DAYS;
            expiresAt = new Date(Date.now() + voteExpiryDays * 86400000).toISOString();
        }

        // Check for decay option
        const decayCheckbox = document.getElementById('proposalDecayCheckbox');
        const decayPercentInput = document.getElementById('proposalDecayPercent');
        const decayTimeInput = document.getElementById('proposalDecayTime');
        let decayEnabled = false;
        let decayPercent = 0;
        let decayDurationMs = 0;
        if (decayCheckbox && decayCheckbox.checked && decayPercentInput && decayTimeInput) {
            decayEnabled = true;
            decayPercent = Math.min(100, Math.max(1, parseInt(decayPercentInput.value, 10) || 50));
            decayDurationMs = parseExpiryTime(decayTimeInput.value);
        }

        // Check for deposit option
        const depositCheckbox = document.getElementById('proposalDepositCheckbox');
        const depositPercentInput = document.getElementById('proposalDepositPercent');
        let depositEnabled = false;
        let depositPercent = 0;
        if (depositCheckbox && depositCheckbox.checked && depositPercentInput) {
            depositEnabled = true;
            // Clamp between 10% and 200%
            depositPercent = Math.min(200, Math.max(10, parseInt(depositPercentInput.value, 10) || 100));
        }

        // Check for conditional proposal option (default to false if not available)
        const conditionalCheckbox = document.getElementById('proposalConditionalCheckbox');
        const isConditional = conditionalCheckbox ? conditionalCheckbox.checked : false;

        const normalizedParentParcelIds = finalParcelIds.map(id => id && id.toString ? id.toString() : String(id));

        if (publishingDraftId && window.proposalDraftStore?.getDraft?.(publishingDraftId)) {
            window.proposalDraftStore.updateDraft(publishingDraftId, {
                fields: {
                    name: proposalName || proposalType,
                    description,
                    parentParcelIds: normalizedParentParcelIds,
                    offer,
                    offerCurrency,
                    acquisitionMode,
                    boundaryAdjustment: boundaryMode,
                    isConditional,
                    expiresAt,
                    decayEnabled,
                    decayPercent,
                    decayDurationMs,
                    depositEnabled,
                    depositPercent
                }
            }, { coalesceKey: 'publish-form' });
        }

        const proposal = {
            author,
            title: proposalName || proposalType, // Keep a stable human-readable title
            name: proposalName || proposalType,
            proposalName: proposalName || proposalType,
            description: description || proposalName || proposalType,
            offer,
            offerCurrency,
            budget: offer, // Add budget field - initially same as offer
            budgetCurrency: offerCurrency,
            acquisitionMode: acquisitionMode,
            boundaryAdjustment: boundaryMode,
            parentParcelIds: normalizedParentParcelIds,
            primaryType: proposalMainType,
            goal: selectedTool,
            acceptedParcelIds: [], // Track which parcels have accepted the proposal
            ownerAcceptances: {},
            bounds: bounds, // Store bounds for reliable positioning
            createdAt: new Date().toISOString(), // Add creation timestamp
            expiresAt: expiresAt, // Expiry timestamp (null if no expiry)
            decayEnabled: decayEnabled, // Whether amount decay is enabled
            decayPercent: decayPercent, // Percentage of offer that decays (e.g., 50 means 50%)
            decayDurationMs: decayDurationMs, // Duration over which decay happens (in ms)
            depositEnabled: depositEnabled, // Whether deposit is enabled
            depositPercent: depositPercent, // Percentage of offer deposited (10-200%)
            isConditional: isConditional,
            disbursementMode: isConditional ? 'conditional' : 'partial', // conditional = all must accept; partial = per-acceptance payouts
            isVote: isVoteCreate, // non-binding vote proposal (no ownership/parcel change, no funds)
            voteExpiryDays: isVoteCreate ? voteExpiryDays : undefined, // voting period in days (≤365)
            // The city this proposal's parcels belong to. Stamped at creation, not at upload, so a
            // proposal made in Zagreb and uploaded later from New York is still labelled Zagreb —
            // and so a shared link can be recognised as cross-city even without a ?city= param.
            city: getProposalCityId()
        };

        // Lineage for "Copy into new proposal". The source is never mutated — the fork just
        // records where it came from. Set by showProposalDialog() from its `copySource` override,
        // and re-cleared on every dialog open, so a plain create leaves this undefined.
        const proposalCopySource = (typeof window !== 'undefined') ? window.pendingProposalCopySource : null;
        if (proposalCopySource && proposalCopySource.proposalId) {
            proposal.copiedFromProposalId = String(proposalCopySource.proposalId);
            proposal.copiedFromName = proposalCopySource.name || null;
        }
        if (publishingDraftId) {
            const source = window.pendingProposalReplacementSource || {};
            const draft = window.proposalDraftStore?.getDraft?.(publishingDraftId);
            const immutableSourceId = draft?.sourceProposalId || source.proposalId || proposal.copiedFromProposalId || null;
            if (immutableSourceId) {
                proposal.sourceProposalId = String(immutableSourceId);
                proposal.replacementOfProposalId = String(immutableSourceId);
            }
            proposal.proposalDraftId = publishingDraftId;
            proposal.proposalDraftRevision = draft?.revision ?? source.revision ?? null;
        }

        if (selectedTool === 'decide-later') {
            proposal.decideLaterProposal = {
                parentParcelIds: normalizedParentParcelIds.slice(),
                childParcelIds: [],
                status: 'unapplied'
            };
        }

        // "Ownership transfer from me" proposals are automatically accepted but not funded
        // This means all parcels are marked as accepted, but the proposal cannot be executed
        if (selectedTool === 'ownership-transfer-from-me') {
            proposal.acceptedParcelIds = normalizedParentParcelIds.slice();
            proposal.funded = false; // Explicitly mark as not funded - prevents execution
            proposal.ownershipTransferProposal = {
                direction: 'from-me',
                parentParcelIds: normalizedParentParcelIds.slice(),
                status: 'accepted-not-funded'
            };
        }

        // "Ownership transfer to me" proposals work like decide-later
        if (selectedTool === 'ownership-transfer-to-me') {
            proposal.ownershipTransferProposal = {
                direction: 'to-me',
                parentParcelIds: normalizedParentParcelIds.slice(),
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
                    parentParcelIds: normalizedParentParcelIds.slice(),
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
                if (typeof buildGeometryFromParcels === 'function') {
                    const layers = finalParcelIds.map(id => {
                        if (multiParcelSelection && typeof multiParcelSelection.findParcelById === 'function') {
                            const layer = multiParcelSelection.findParcelById(id);
                            if (layer && layer.feature) return layer;
                        }
                        if (typeof resolveParcelLayerById === 'function') {
                            const layer = resolveParcelLayerById(id);
                            if (layer && layer.feature) return layer;
                        }
                        return null;
                    }).filter(Boolean);
                    if (layers.length) {
                        structureGeometry = buildGeometryFromParcels(layers);
                    }
                }
            } catch (_) { /* geometry rebuild best-effort */ }

            proposal.structureProposal = {
                kind,
                status: 'unapplied',
                geometry: structureGeometry || null,
                parentParcelIds: normalizedParentParcelIds,
                blockName: formatParcelSelectionLabel(normalizedParentParcelIds),
                // Structures clear their ground by default — no prompt.
                demolishedBuildings: (structureGeometry && typeof demolishBuildingsUnderFootprint === 'function')
                    ? (typeof ensureCorridorBuildingFootprintsLoaded === 'function'
                        ? await ensureCorridorBuildingFootprintsLoaded().then(() => demolishBuildingsUnderFootprint(structureGeometry))
                        : await demolishBuildingsUnderFootprint(structureGeometry))
                    : []
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
                const parentIds = (Array.isArray(roadDrawingContext.parentParcelIds) ? roadDrawingContext.parentParcelIds : normalizedParentParcelIds)
                    .map(id => id && id.toString ? id.toString() : String(id))
                    .filter(Boolean);

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
                    demolishedBuildings: safeClone(roadDrawingContext.demolishedBuildings) || [],
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
                proposal.definition = roadDefinition;
                proposal.parentParcelIds = parentIds;

                if (!proposal.geometry) proposal.geometry = {};
                proposal.geometry.roadPlan = safeClone(roadDefinition);
                if (roadDrawingContext.polygon) {
                    proposal.geometry.roadGeometry = { polygon: safeClone(roadDrawingContext.polygon) };
                }

                proposal.roadProposal = {
                    definition: safeClone(roadDefinition),
                    parentParcelIds: parentIds.slice(),
                    childParcelIds: [],
                    status: 'unapplied',
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

                const corridorParents = (Array.isArray(corridor.parentParcelIds) ? corridor.parentParcelIds : normalizedParentParcelIds)
                    .map(id => id && id.toString ? id.toString() : String(id))
                    .filter(Boolean);
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
                proposal.definition = roadDefinition;
                proposal.parentParcelIds = corridorParents;

                if (!proposal.geometry) proposal.geometry = {};
                proposal.geometry.roadPlan = safeClone(roadDefinition);
                if (polygonGeometry && polygonGeometry.type) {
                    proposal.geometry.roadGeometry = { polygon: safeClone(polygonGeometry) };
                }

                proposal.roadProposal = {
                    definition: safeClone(roadDefinition),
                    parentParcelIds: corridorParents.slice(),
                    childParcelIds: [],
                    status: 'unapplied',
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
        console.debug('[createProposal] Proposal object ready, shouldMintOnchain:', shouldMintOnchain);

        // Duplicate pre-check temporarily disabled (false positives were blocking creation)
        // try {
        //     if (proposalStorage && typeof proposalStorage._buildHashSeed === 'function' && typeof proposalStorage._findDuplicateBySeed === 'function') {
        //         const duplicateSeed = proposalStorage._buildHashSeed(proposal);
        //         const duplicate = proposalStorage._findDuplicateBySeed(duplicateSeed);
        //         if (duplicate) {
        //             hideWaitingPopupSafe();
        //             setProposalModalInteractivity(true);
        //             setProposalCreateButtonState(false);
        //             showProposalAlertMessage('this_exact_proposal_already_exists', 'This exact proposal already exists');
        //             return;
        //         }
        //     }
        // } catch (dupCheckError) {
        //     console.warn('Duplicate proposal pre-check failed', dupCheckError);
        // }

        if (proposalMainType === 'Reparcellization') {
            if (!pendingReparcelPlan || !Array.isArray(pendingReparcelPlan.parcelIds)) {
                showProposalAlertMessage('reparcellization_plan_is_missing_please_rerun_the_algorithm', 'Reparcellization plan is missing. Please rerun the algorithm.');
                return;
            }
            const planParcelSet = new Set((pendingReparcelPlan.parcelIds || []).map(id => id && id.toString()));
            const finalParcelSet = new Set(finalParcelIds.map(id => id && id.toString()));
            const parcelsMatch = planParcelSet.size === finalParcelSet.size && Array.from(planParcelSet).every(id => finalParcelSet.has(id));
            if (!parcelsMatch) {
                showProposalAlertMessage('selected_parcels_changed_after_running_reparcellization_please_rerun_the_algorithm', 'Selected parcels changed after running reparcellization. Please rerun the algorithm.');
                return;
            }
            proposal.goal = 'reparcellization';
            proposal.reparcellization = JSON.parse(JSON.stringify(pendingReparcelPlan));
            proposal.reparcellization.parcelIds = finalParcelIds.slice();
        }

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

            const primaryBuildingFeature = buildingFeatures[0];
            const buildingGeometry = primaryBuildingFeature ? primaryBuildingFeature.geometry : null;
            const buildingProperties = primaryBuildingFeature && primaryBuildingFeature.properties ? { ...primaryBuildingFeature.properties } : {};

            const parentDetails = Array.isArray(pendingBuildingContext.parentDetails) && pendingBuildingContext.parentDetails.length
                ? pendingBuildingContext.parentDetails.map(detail => ({ id: detail.id, number: detail.number || detail.id }))
                : normalizedParentParcelIds.map(id => ({ id, number: id }));
            const ancestorKey = normalizedParentParcelIds.slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join('|');

            proposal.primaryType = 'Urban Rule';
            proposal.goal = selectedTool === 'single' ? 'single' : 'buildings';
            proposal.typologyType = resolvedTypology;
            proposal.buildingGeometry = buildingGeometry;
            proposal.buildingProperties = buildingProperties;
            proposal.properties = { ...buildingProperties };
            proposal.tags = ['buildings'];

            if (!proposal.geometry) proposal.geometry = {};
            proposal.geometry.buildings = buildingFeatures;

            proposal.buildingProposal = {
                parentParcelIds: normalizedParentParcelIds.slice(),
                parentParcelNumbers: parentDetails,
                status: 'unapplied',
                createdFrom: resolvedTypology === 'row' ? 'rowHouse' : (resolvedTypology === 'parcelBased' ? 'parcelBased' : 'blockify'),
                blockName: pendingBuildingContext.blockName || formatParcelSelectionLabel(normalizedParentParcelIds),
                parameters: safeClone(pendingBuildingContext.parameters) || {},
                buildingFeature: primaryBuildingFeature,
                buildings: buildingFeatures,
                ancestorKey
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

        let hash = null;

        // Try to mint on-chain if blockchain is available and parcels have NFTs
        const recoveredPublish = publishingDraftId
            ? window.proposalDraftStore?.getDraft?.(publishingDraftId)?.publish
            : null;
        let onchainResult = recoveredPublish?.onchainResult || null;
        if (onchainResult && recoveredPublish?.proposalOnchain) {
            proposal.onchain = { ...recoveredPublish.proposalOnchain };
            proposal.nft = recoveredPublish.proposalNft ? { ...recoveredPublish.proposalNft } : undefined;
            shouldMintOnchain = false;
            console.info('[createProposal] Reusing the persisted on-chain result for this draft publish operation.');
        }
        // walletManager already declared above
        let hasWalletProvider = (walletManager && walletManager.getProvider()) || isSolanaWalletConnected || cantonActive;

        // If blockchain is supported but wallet is not connected, prompt user to connect
        if (shouldMintOnchain && !hasWalletProvider) {
            if (walletManager && typeof walletManager.openConnectorModal === 'function') {
                updateStatus('Please connect your wallet to mint the proposal on blockchain...');

                // Open wallet connection modal and wait for connection
                walletManager.openConnectorModal();

                // Wait for wallet connection with a timeout
                const connectionPromise = new Promise((resolve) => {
                    let resolved = false;
                    const timeout = setTimeout(() => {
                        if (!resolved) {
                            resolved = true;
                            walletManager.off('connect', handleConnect);
                            walletManager.off('error', handleError);
                            walletManager.off('disconnect', handleDisconnect);
                            walletManager.closeConnectorModal();
                            updateStatus('Wallet connection timeout.');
                            resolve(false);
                        }
                    }, 60000); // 60 second timeout

                    const handleConnect = () => {
                        if (!resolved) {
                            resolved = true;
                            clearTimeout(timeout);
                            walletManager.off('connect', handleConnect);
                            walletManager.off('error', handleError);
                            walletManager.off('disconnect', handleDisconnect);
                            walletManager.closeConnectorModal();
                            updateStatus('Wallet connected! Proceeding with blockchain minting...');
                            resolve(true);
                        }
                    };

                    const handleError = () => {
                        if (!resolved) {
                            resolved = true;
                            clearTimeout(timeout);
                            walletManager.off('connect', handleConnect);
                            walletManager.off('error', handleError);
                            walletManager.off('disconnect', handleDisconnect);
                            walletManager.closeConnectorModal();
                            updateStatus('Wallet connection cancelled.');
                            resolve(false);
                        }
                    };

                    const handleDisconnect = () => {
                        // If disconnected while waiting, treat as cancellation
                        handleError();
                    };

                    walletManager.on('connect', handleConnect);
                    walletManager.on('error', handleError);
                    walletManager.on('disconnect', handleDisconnect);
                });

                const connected = await connectionPromise;
                if (!connected) {
                    // User cancelled or timeout - cancel creation entirely, keep modal filled
                    updateStatus('Proposal creation cancelled.');
                    hideWaitingPopupSafe();
                    setProposalModalInteractivity(true);
                    setProposalCreateButtonState(false);
                    markDraftPublishFailed(Object.assign(new Error('Wallet connection was cancelled or timed out.'), { code: 'WALLET_CONNECTION_CANCELLED' }));
                    return;
                } else {
                    // Wallet connected - check provider again
                    hasWalletProvider = walletManager && walletManager.getProvider();
                }
            } else {
                // Fallback: show alert if wallet manager is not available
                const walletPrompt = t('alerts.messages.blockchain_mint_wallet_prompt', 'Blockchain minting is available but no wallet is connected. Would you like to connect a wallet to mint this proposal on-chain?');
                const connectWallet = confirm(walletPrompt);
                if (connectWallet && walletManager && typeof walletManager.openConnectorModal === 'function') {
                    walletManager.openConnectorModal();
                    markDraftPublishFailed(Object.assign(new Error('Connect the wallet, then retry publishing.'), { code: 'WALLET_CONNECTION_REQUIRED' }));
                    return; // User will need to click Create Proposal again after connecting
                }
            }
        }

        if (shouldMintOnchain && hasWalletProvider) {
            try {
                console.debug('[createProposal] Starting on-chain minting process');
                const mintStartTime = performance.now();
                updateStatus('Preparing proposal for blockchain minting...');

                // Get parcel features for screenshot generation
                console.debug('[createProposal] Loading parcel data for screenshot generation');
                const parcelDataStartTime = performance.now();
                updateStatus('Loading parcel data...');
                showProposalWaitingPopup('Loading parcel data...');
                waitingPopupVisible = true;
                setProposalModalDimmed(true);
                const parcelFeatures = [];
                const parcelPolygons = [];
                console.debug('[proposal-mint] Building parcel polygons for proposal', {
                    parcelIds: finalParcelIds.slice(0, 10),
                    parcelCount: finalParcelIds.length
                });

                const pushParcelPolygons = (coords) => {
                    if (!Array.isArray(coords) || !coords.length) return;
                    // Polygon: [rings]
                    if (Array.isArray(coords[0]) && Array.isArray(coords[0][0]) && typeof coords[0][0][0] === 'number') {
                        parcelPolygons.push(coords);
                        return;
                    }
                    // MultiPolygon: [ [rings], [rings], ... ]
                    if (Array.isArray(coords[0]) && Array.isArray(coords[0][0])) {
                        coords.forEach(poly => {
                            if (Array.isArray(poly) && poly.length) {
                                parcelPolygons.push(poly);
                            }
                        });
                    }
                };

                for (const parcelId of finalParcelIds) {
                    let parcelLayer = null;
                    if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection.findParcelById) {
                        parcelLayer = multiParcelSelection.findParcelById(parcelId);
                    }
                    if (!parcelLayer && typeof resolveParcelLayerById === 'function') {
                        parcelLayer = resolveParcelLayerById(parcelId);
                    }
                    // If still not resolved, fetch it to ensure geometry is available
                    if (!parcelLayer && typeof fetchSingleParcelById === 'function') {
                        try {
                            parcelLayer = await fetchSingleParcelById(parcelId, { forceRefresh: false });
                        } catch (err) {
                            console.warn(`[proposal-mint] Unable to fetch parcel ${parcelId} for proposal minting:`, err);
                        }
                    }
                    if (parcelLayer && parcelLayer.feature) {
                        const normalizedFeature = ensureParcelIdOnFeature(parcelLayer.feature);
                        parcelFeatures.push(normalizedFeature);
                        // Extract coordinates for polygon
                        if (parcelLayer.feature.geometry && parcelLayer.feature.geometry.coordinates) {
                            pushParcelPolygons(parcelLayer.feature.geometry.coordinates);
                        }
                    } else {
                        console.warn('[proposal-mint] Missing parcel layer or feature for', parcelId);
                    }
                }

                console.debug('[createProposal] Parcel data loading took:', (performance.now() - parcelDataStartTime).toFixed(2), 'ms');
                console.debug('[proposal-mint] Parcel polygon collection result', {
                    parcelFeaturesCount: parcelFeatures.length,
                    parcelPolygonsCount: parcelPolygons.length,
                    firstPolygonSample: parcelPolygons[0]
                });

                if (parcelFeatures.length === 0) {
                    console.warn('No parcel features found for screenshot generation');
                    hideWaitingPopupSafe();
                } else {
                    // Use the parent parcel IDs from earlier - these are what the proposal references
                    let parcelIdsForMinting = proposal.parentParcelIds;
                    if (!parcelIdsForMinting || parcelIdsForMinting.length === 0) {
                        // Derive parcel IDs in the format expected by the contract
                        parcelIdsForMinting = parcelFeatures
                            .map(feature => {
                                if (window.ProposalChainBridge && window.ProposalChainBridge.deriveParcelIdFromFeature) {
                                    return window.ProposalChainBridge.deriveParcelIdFromFeature(feature);
                                }
                                // Fallback: try to format from properties
                                const props = feature.properties || {};
                                const canonicalId = getParcelIdFromFeature(feature);
                                if (canonicalId) return canonicalId.toString();
                                if (props.MATICNI_BROJ_KO && props.BROJ_CESTICE) {
                                    return window.ProposalChainBridge ?
                                        window.ProposalChainBridge.formatParcelId(props.MATICNI_BROJ_KO, props.BROJ_CESTICE) :
                                        `HR-${props.MATICNI_BROJ_KO}-${props.BROJ_CESTICE}`;
                                }
                                return null;
                            })
                            .filter(Boolean);
                    }

                    if (parcelIdsForMinting.length === 0) {
                        console.warn('Could not derive formatted parcel IDs for on-chain minting');
                        hideWaitingPopupSafe();
                    } else {
                        // Verify required services are available
                        if (!window.MapScreenshot) {
                            throw new Error('Map screenshot capture is not available.');
                        }
                        if (!window.AssetService || typeof window.AssetService.uploadProposalAssets !== 'function') {
                            throw new Error('Asset upload service is not available.');
                        }

                        // Build combined polygon from all parcels for screenshot
                        console.debug('[createProposal] Preparing proposal geometry for screenshot');
                        const geometryStartTime = performance.now();
                        updateStatus('Preparing proposal geometry...');
                        showProposalWaitingPopup('Preparing proposal geometry...');
                        const combinedPolygon = [];
                        let minLat = Infinity;
                        let maxLat = -Infinity;
                        let minLng = Infinity;
                        let maxLng = -Infinity;

                        const addPoint = (lat, lng) => {
                            if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                                return;
                            }
                            combinedPolygon.push([lat, lng]);
                            minLat = Math.min(minLat, lat);
                            maxLat = Math.max(maxLat, lat);
                            minLng = Math.min(minLng, lng);
                            maxLng = Math.max(maxLng, lng);
                        };

                        const addCoords = (segment) => {
                            if (!Array.isArray(segment)) return;
                            // If this looks like a point [lng, lat]
                            if (segment.length === 2 && Number.isFinite(segment[0]) && Number.isFinite(segment[1])) {
                                const lat = Math.abs(segment[0]) <= 90 ? segment[0] : segment[1];
                                const lng = Math.abs(segment[0]) <= 90 ? segment[1] : segment[0];
                                addPoint(lat, lng);
                                return;
                            }
                            // If this is a ring or nested array, recurse
                            segment.forEach(inner => addCoords(inner));
                        };

                        parcelPolygons.forEach(poly => addCoords(poly));

                        if (combinedPolygon.length < 3) {
                            // Derive a rectangle from min/max if we collected any coords
                            if (Number.isFinite(minLat) && Number.isFinite(maxLat) && Number.isFinite(minLng) && Number.isFinite(maxLng)) {
                                console.warn('[proposal-mint] Fallback rectangle from min/max bounds', { minLat, maxLat, minLng, maxLng });
                                combinedPolygon.length = 0;
                                combinedPolygon.push([minLat, minLng]);
                                combinedPolygon.push([minLat, maxLng]);
                                combinedPolygon.push([maxLat, maxLng]);
                                combinedPolygon.push([maxLat, minLng]);
                                combinedPolygon.push([minLat, minLng]);
                            }
                        }

                        if (combinedPolygon.length < 3) {
                            // Fallback: use map bounds if available
                            if (bounds && typeof bounds.getSouthWest === 'function') {
                                const sw = bounds.getSouthWest();
                                const ne = bounds.getNorthEast();
                                console.warn('[proposal-mint] Fallback rectangle from map bounds', { sw, ne });
                                combinedPolygon.push([sw.lat, sw.lng]);
                                combinedPolygon.push([sw.lat, ne.lng]);
                                combinedPolygon.push([ne.lat, ne.lng]);
                                combinedPolygon.push([ne.lat, sw.lng]);
                                combinedPolygon.push([sw.lat, sw.lng]);
                            }
                        }

                        if (combinedPolygon.length < 3) {
                            console.error('[proposal-mint] Unable to derive proposal polygon', {
                                parcelIds: finalParcelIds.slice(0, 10),
                                parcelPolygonsCount: parcelPolygons.length
                            });
                            throw new Error('Unable to derive proposal polygon for NFT metadata.');
                        }

                        const buildBoundsFromParcelPolygons = (polys, fallbackBounds) => {
                            if (fallbackBounds && typeof fallbackBounds.isValid === 'function' && fallbackBounds.isValid()) {
                                return fallbackBounds;
                            }
                            if (!Array.isArray(polys) || typeof L === 'undefined' || !L || typeof L.latLngBounds !== 'function') return null;
                            try {
                                const latLngs = [];
                                polys.forEach(poly => {
                                    const collect = (node) => {
                                        if (!Array.isArray(node)) return;
                                        if (node.length && Array.isArray(node[0]) && typeof node[0][0] === 'number' && typeof node[0][1] === 'number') {
                                            node.forEach(pair => {
                                                if (Array.isArray(pair) && pair.length >= 2 && Number.isFinite(pair[0]) && Number.isFinite(pair[1])) {
                                                    // GeoJSON order is [lng, lat]
                                                    latLngs.push(L.latLng(pair[1], pair[0]));
                                                }
                                            });
                                            return;
                                        }
                                        node.forEach(collect);
                                    };
                                    collect(poly);
                                });
                                return latLngs.length ? L.latLngBounds(latLngs) : null;
                            } catch (err) {
                                console.warn('[proposal-mint] Failed to derive bounds from parcel polygons', err);
                                return null;
                            }
                        };

                        const screenshotBounds = buildBoundsFromParcelPolygons(parcelPolygons, bounds);
                        // A road proposal's image is about the designed corridor, not the much larger
                        // set of cadastral parents it crosses. The modal preview already uses this
                        // geometry; keep the final stored/minted capture on the same source of truth.
                        const screenshotGeometry = resolveCorridorScreenshotGeometry(proposal, combinedPolygon);
                        const screenshotPolygon = screenshotGeometry.polygon;
                        const screenshotPolygonOrder = screenshotGeometry.polygonOrder;
                        const screenshotFitToPolygonOnly = screenshotGeometry.fitToPolygonOnly;

                        console.debug('[createProposal] Geometry preparation took:', (performance.now() - geometryStartTime).toFixed(2), 'ms');

                        // Capture screenshot from the preview (stitched image runs in the background)
                        const tShare = typeof getShareI18nHelper === 'function' ? getShareI18nHelper() : null;
                        const processingImageMessage = tShare
                            ? tShare('processingImageForUpload', 'Processing image for upload...')
                            : 'Processing image for upload...';
                        const showProcessingImageMessage = () => {
                            updateStatus(processingImageMessage);
                            showProposalWaitingPopup(processingImageMessage);
                        };

                        showProcessingImageMessage();

                        let screenshotDataUrl = null;
                        let captureError = null;

                        const computeByteSize = (dataUrl) => {
                            if (!dataUrl || !dataUrl.startsWith('data:image/')) return 0;
                            const base64Part = dataUrl.split(',')[1];
                            return base64Part ? Math.ceil(base64Part.length * 3 / 4) : 0;
                        };

                        const attemptTileStitchCapture = async () => {
                            if (!window.MapScreenshot?.captureViaTileStitch) return null;
                            try {
                                const dataUrl = await window.MapScreenshot.captureViaTileStitch({
                                    polygon: screenshotPolygon,
                                    parcelPolygons: parcelPolygons,
                                    padding: 0.12,
                                    bounds: screenshotBounds,
                                    zoom: 19,
                                    badge: goalBadge,
                                    polygonOrder: screenshotPolygonOrder,
                                    parcelPolygonOrder: 'auto',
                                    fitToPolygonOnly: screenshotFitToPolygonOnly
                                });
                                const bytes = computeByteSize(dataUrl);
                                console.debug('[createProposal] Tile stitch capture size:', bytes, 'bytes');
                                if (bytes >= 5000) {
                                    return dataUrl;
                                }
                                console.warn('[createProposal] Tile stitch capture too small:', bytes, 'bytes');
                                return null;
                            } catch (err) {
                                console.error('[createProposal] Tile stitch capture failed:', err);
                                return null;
                            }
                        };

                        const awaitBackgroundStitch = async () => {
                            if (!proposalModalScreenshotPromise) return null;
                            showProcessingImageMessage();
                            try {
                                const dataUrl = await proposalModalScreenshotPromise;
                                return computeByteSize(dataUrl) >= 5000 ? dataUrl : null;
                            } catch (err) {
                                console.warn('[createProposal] Awaiting stitched screenshot failed:', err);
                                return null;
                            }
                        };

                        // Prefer the background-stitched image; if it's still processing, wait for it
                        screenshotDataUrl = await awaitBackgroundStitch();

                        // If no stitched image yet, kick off (or reuse) capture and await it
                        if (!screenshotDataUrl) {
                            const capturePromise = attemptTileStitchCapture();
                            if (capturePromise && typeof capturePromise.then === 'function') {
                                proposalModalScreenshotPromise = capturePromise;
                                showProcessingImageMessage();
                                screenshotDataUrl = await capturePromise;
                            }
                        }

                        if (!screenshotDataUrl) {
                            captureError = 'Tile stitch capture failed or produced a tiny image.';
                        }

                        // If the stitched attempts failed but we cached a good preview earlier, fall back to it
                        if ((!screenshotDataUrl || captureError) && proposalModalScreenshotDataUrl) {
                            screenshotDataUrl = proposalModalScreenshotDataUrl;
                            captureError = null;
                            console.debug('[createProposal] Using cached preview screenshot as fallback');
                        }

                        if (!screenshotDataUrl || !screenshotDataUrl.startsWith('data:image/')) {
                            const errorDetail = captureError ? `: ${captureError}` : '';
                            throw new Error(`Unable to capture proposal screenshot${errorDetail}`);
                        }

                        console.debug('[createProposal] Using screenshot:', { length: screenshotDataUrl.length });

                        // Store screenshot on proposal for later use (e.g., minting from share dialog)
                        proposal.screenshotDataUrl = screenshotDataUrl;

                        // Convert offer to native currency amount (ETH for EVM, SOL for Solana)
                        // If currency is ETH or SOL, use the offer amount directly
                        // Otherwise, set to 0 (no native funding, but proposal can still be minted)
                        const nativeAmount = (offerCurrency === 'ETH' || offerCurrency === 'SOL') ? offer : 0;

                        const storageLabel = (typeof window.getStorageProviderLabel === 'function') ? window.getStorageProviderLabel() : 'decentralized storage';
                        console.debug(`[createProposal] Uploading proposal image to ${storageLabel}`);
                        const ipfsStartTime = performance.now();
                        updateStatus(`Uploading proposal image to ${storageLabel}...`);
                        showProposalWaitingPopup(`Uploading proposal image to ${storageLabel}...`);
                        const createdAtIso = proposal.createdAt || new Date().toISOString();
                        proposal.createdAt = createdAtIso;

                        const lensEntriesForMint = getProposalLensEntries(proposal, { fallbackToGlobal: true });
                        const lensAddressesForMint = lensEntriesForMint
                            .filter(entry => entry && entry.address && entry.address.trim())
                            .map(entry => entry.address.trim());
                        // Skip lens requirement for ownership-transfer-from-me proposals and Solana (wallet used as fallback lens)
                        const isFromMeProposal = selectedTool === 'ownership-transfer-from-me';
                        if (!lensAddressesForMint.length && !isFromMeProposal && !isSolanaWalletConnected && !cantonActive) {
                            throw new Error('Cannot mint proposal: lens list is empty. Set your lens before minting.');
                        }

                        const goalKey = resolveProposalGoalKey(proposal, null) || proposalType || 'proposal';
                        const goalLabel = goalKey.replace(/-/g, ' ');
                        const metadataTitle = proposal.name || proposal.title || `${goalLabel} Proposal`;
                        const geometryPayload = buildGeometryMetadataPayload(proposal);
                        const metadataPayload = {
                            name: metadataTitle,
                            title: metadataTitle,
                            description: description,
                            image: '', // populated after image upload
                            attributes: [
                                {
                                    trait_type: 'Goal',
                                    value: goalLabel
                                },
                                {
                                    trait_type: 'Conditional',
                                    value: isConditional ? 'Yes' : 'No'
                                },
                                {
                                    trait_type: 'Parcel Count',
                                    value: parcelIdsForMinting.length
                                },
                                {
                                    trait_type: 'Author',
                                    value: author
                                },
                                {
                                    trait_type: 'Offer',
                                    value: `${offer} ${offerCurrency}`
                                }
                            ],
                            properties: {
                                proposalId: proposal.proposalId || hash || '',
                                goal: goalKey,
                                title: metadataTitle,
                                parcelIds: parcelIdsForMinting,
                                conditional: isConditional,
                                lens: lensAddressesForMint,
                                offer: {
                                    amount: offer,
                                    currency: offerCurrency
                                },
                                nativeAmount: nativeAmount,
                                createdAt: createdAtIso,
                                author,
                                description,
                                ...(geometryPayload ? { geometry: geometryPayload } : {})
                            }
                        };

                        const fileNameBase = `proposal-${Date.now()}`;
                        const uploadChainId = isSolanaWalletConnected
                            ? `solana-${solWm.getCluster ? solWm.getCluster() : 'devnet'}`
                            : ((walletManager && typeof walletManager.getState === 'function')
                                ? walletManager.getState()?.chainId
                                : null);
                        const assetUploadResult = await window.AssetService.uploadProposalAssets({
                            imageData: screenshotDataUrl,
                            metadata: metadataPayload,
                            fileName: fileNameBase,
                            chainId: uploadChainId,
                            target: 'auto'
                        });
                        console.debug('[createProposal] IPFS upload took:', (performance.now() - ipfsStartTime).toFixed(2), 'ms');
                        const metadataUri = assetUploadResult?.metadataUri || assetUploadResult?.metadataUrl || '';

                        if (!metadataUri) {
                            throw new Error('Metadata URI missing from asset upload response.');
                        }

                        console.debug('[createProposal] Minting proposal on blockchain');
                        const mintTxStartTime = performance.now();
                        showProposalWaitingPopup('Waiting for transaction...');
                        waitingPopupVisible = true;
                        setProposalModalDimmed(true);
                        updateStatus('Minting proposal on blockchain...');

                        if (cantonActive && window.CantonProposalChainBridge) {
                            // Canton (custodial): create via the backend; the current
                            // Canton identity is the buyer, owner/lens auto-allocated.
                            onchainResult = await window.CantonProposalChainBridge.mintProposal({
                                parcelIds: parcelIdsForMinting,
                                price: offer,
                                imageURI: metadataUri
                            });
                        } else if (isSolanaWalletConnected && window.SolanaProposalChainBridge) {
                            // For Solana, use the connected wallet as the lens if no valid Solana pubkeys are available
                            const solanaWalletAddress = solWm.getState().accounts[0];
                            const solanaLens = lensAddressesForMint.filter(a => !a.startsWith('0x'));
                            if (solanaLens.length === 0 && solanaWalletAddress) {
                                solanaLens.push(solanaWalletAddress);
                            }
                            onchainResult = await window.SolanaProposalChainBridge.mintProposal({
                                parcelIds: parcelIdsForMinting,
                                isConditional: isConditional,
                                solAmount: nativeAmount,
                                imageURI: metadataUri,
                                lens: solanaLens
                            });
                        } else {
                            onchainResult = await window.ProposalChainBridge.mintProposal({
                                parcelIds: parcelIdsForMinting,
                                isConditional: isConditional,
                                ethAmount: nativeAmount,
                                tokenAmount: 0n,
                                imageURI: metadataUri,
                                lens: lensAddressesForMint,
                                // Vote proposals mint fund-less via mintVote with a voting deadline (EVM only).
                                isVote: proposal.isVote === true,
                                expiryDays: proposal.isVote === true ? proposal.voteExpiryDays : undefined
                            });
                        }
                        console.debug('[createProposal] Blockchain minting took:', (performance.now() - mintTxStartTime).toFixed(2), 'ms');
                        console.debug('[createProposal] Total on-chain minting process took:', (performance.now() - mintStartTime).toFixed(2), 'ms');
                        hideWaitingPopupSafe();

                        proposal.onchain = {
                            transactionHash: onchainResult.transactionHash,
                            proposalId: onchainResult.proposalId,
                            chainId: onchainResult.chainId,
                            contractAddress: onchainResult.contractAddress,
                            metadataUri,
                            metadataUrl: assetUploadResult?.metadataGatewayUrl || null,
                            imageUri: assetUploadResult?.imageUri || null,
                            imageUrl: assetUploadResult?.imageGatewayUrl || null
                        };
                        proposal.nft = {
                            chain: onchainResult.chainId || chainId || null,
                            contract: onchainResult.contractAddress || null,
                            tokenId: onchainResult.proposalId != null ? onchainResult.proposalId.toString() : null
                        };

                        const chainProposalIdValue = buildChainProposalId(onchainResult.chainId || chainId, onchainResult.contractAddress, onchainResult.proposalId);
                        proposal.chainProposalId = chainProposalIdValue;
                        proposal.tokenId = proposal.tokenId || (onchainResult.proposalId != null ? onchainResult.proposalId.toString() : null);
                        proposal.onchain.chainProposalId = chainProposalIdValue;
                        proposal.nft.chainProposalId = chainProposalIdValue;

                        // Update stored proposal with on-chain data
                        const stored = proposalStorage.getProposal(proposal.proposalId || proposal.proposalId);
                        if (stored) {
                            stored.onchain = { ...proposal.onchain };
                            stored.nft = { ...proposal.nft };
                            stored.chainProposalId = stored.chainProposalId || chainProposalIdValue;
                            stored.tokenId = stored.tokenId || proposal.tokenId;
                            stored.proposalId = stored.proposalId || hash || stored.proposalId;
                            // After mint we have a permanent image URL — promote it from on-chain to the
                            // top-level screenshotUrl and drop the local data URL to free localStorage.
                            if (proposal.onchain.imageUrl) {
                                stored.screenshotUrl = proposal.onchain.imageUrl;
                                if (stored.screenshotDataUrl) delete stored.screenshotDataUrl;
                            }
                            if (typeof proposalStorage._indexProposal === 'function') {
                                proposalStorage._indexProposal(stored);
                            }
                            if (typeof proposalStorage.save === 'function') {
                                proposalStorage.save();
                            }
                            if (stored.screenshotUrl) {
                                try {
                                    document.dispatchEvent(new CustomEvent('proposalScreenshotUpdated', {
                                        detail: { proposalId: stored.proposalId, screenshotUrl: stored.screenshotUrl }
                                    }));
                                } catch (_) { }
                            }
                        }

                        updateStatus(`Proposal minted on blockchain! Transaction: ${onchainResult.transactionHash.substring(0, 10)}...`);
                    }
                }
            } catch (error) {
                hideWaitingPopupSafe();
                console.error('On-chain mint failed:', error);

                const isUserCancelled = (err) => {
                    const code = err && (err.code || err.error?.code || err.data?.code || err.info?.error?.code);
                    const rawMessage = err && (err.message || err.error?.message || err.data?.message || err.shortMessage || err.info?.error?.message || '');
                    const message = (rawMessage || '').toLowerCase();
                    return code === 4001
                        || code === 'ACTION_REJECTED'
                        || code === 'TRANSACTION_REJECTED'
                        || message.includes('user rejected')
                        || message.includes('user denied')
                        || message.includes('user canceled')
                        || message.includes('user cancelled')
                        || message.includes('rejected by user')
                        || message.includes('transaction was rejected')
                        || message.includes('transaction rejected')
                        || message.includes('request rejected');
                };

                if (isUserCancelled(error)) {
                    showProposalWaitingPopupTemporary('Transaction rejected', 2000);
                    updateStatus('Proposal creation cancelled.');
                    setProposalModalInteractivity(true);
                    setProposalCreateButtonState(false);
                    markDraftPublishFailed(error);
                    return;
                }

                const failureReason = error?.message
                    || error?.error?.message
                    || error?.data?.message
                    || error?.details
                    || t('modal.createProposal.onchainMintFailed.unknown', 'Unknown error');

                const decision = await showOnchainMintFailedModal(failureReason);
                if (decision !== 'memory') {
                    updateStatus('Proposal creation cancelled.');
                    setProposalModalInteractivity(true);
                    setProposalCreateButtonState(false);
                    markDraftPublishFailed(error);
                    return;
                }

                updateStatus('Creating in-memory proposal (on-chain mint skipped).');
                shouldMintOnchain = false;
                onchainResult = null;
            }
        }

        if (publishingDraftId && onchainResult && window.proposalDraftStore?.getDraft?.(publishingDraftId)) {
            window.proposalDraftStore.updateDraft(publishingDraftId, {
                publish: {
                    onchainResult: { ...onchainResult },
                    proposalOnchain: proposal.onchain ? { ...proposal.onchain } : null,
                    proposalNft: proposal.nft ? { ...proposal.nft } : null,
                    externalPersistenceComplete: true
                }
            }, { force: true, recordHistory: false, dirty: false });
        }

        // Dialog-created proposals have confirmed terms: the details panel shows "Proposal
        // details" instead of "Propose" until a later edit produces a fresh unproposed object.
        proposal.termsConfirmed = true;

        // Persist proposal after on-chain handling (or local-only)
        console.debug('[createProposal] Saving proposal to storage');
        const saveStartTime = performance.now();
        updateStatus('Saving proposal...');
        if (!waitingPopupVisible) {
            showProposalWaitingPopup('Saving proposal...');
            waitingPopupVisible = true;
            setProposalModalDimmed(true);
        }
        const proposalId = proposalStorage.addProposal(proposal);
        console.debug('[createProposal] Proposal save took:', (performance.now() - saveStartTime).toFixed(2), 'ms');
        if (proposalId === null) {
            hideWaitingPopupSafe();
            updateStatus('Unable to save proposal.');
            setProposalModalInteractivity(true);
            setProposalCreateButtonState(false);
            markDraftPublishFailed(Object.assign(new Error('Unable to save the replacement proposal.'), { code: 'PROPOSAL_STORAGE_FAILED' }));
            return;
        }
        const storedForOnchain = proposalStorage.getProposal(proposalId);
        const storedProposalId = storedForOnchain?.proposalId || proposal.proposalId || proposalId;
        // Every editor draft survives modal closes and failures. Only successful proposal
        // persistence consumes it, atomically recording a receipt for retry idempotency.
        if (publishingDraftId && window.proposalDraftStore?.getDraft?.(publishingDraftId)) {
            window.proposalDraftStore.consumeAfterPublish(publishingDraftId, storedProposalId);
        }

        // Update stored proposal with on-chain data if available
        if (onchainResult) {
            const stored = storedForOnchain;
            if (stored) {
                stored.onchain = { ...(stored.onchain || {}), ...(proposal.onchain || {}) };
                if (typeof proposalStorage._indexProposal === 'function') {
                    proposalStorage._indexProposal(stored);
                }
                if (typeof proposalStorage.save === 'function') {
                    proposalStorage.save();
                }
            }
        }

        // Vote proposals need no special map handling: like every proposal, their geometry is
        // already on the map as the applied draft they were created from — nothing to re-apply.

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
            const proposalLinkHtml = `<a href="#" data-proposal-id="${proposalIdAttr}" class="proposal-link proposal-link-clickable">${proposalIdForLog}</a>`;
            const budgetCurrencyLabel = offerCurrency || 'USDT';
            const onchainNote = onchainResult ? ' (on-chain)' : '';
            addUserActionToGameLog(`<a href="#" data-agent-id="${userAgent.id}" class="agent-link agent-link-clickable">${userAgent.name}</a> created a ${proposalType} proposal${onchainNote} (${proposalLinkHtml}) for ${proposal.parentParcelIds.length} parcel(s) with budget ${offer} ${budgetCurrencyLabel}.`);

            // Update user agent's created proposals
            if (!userAgent.proposalsCreated) {
                userAgent.proposalsCreated = [];
            }
            if (!userAgent.proposalsCreated.includes(proposalId)) {
                userAgent.proposalsCreated.push(proposalId);
                agentStorage.updateAgent(userAgent.id, { proposalsCreated: userAgent.proposalsCreated });
            }
        }

        // Enable show proposals mode and clear multi-selection
        console.debug('[createProposal] Enabling show proposals mode and cleaning up UI');
        enableShowProposalsMode();

        // Hide parcel info panel if needed
        if (typeof hideParcelInfoPanel === 'function') {
            hideParcelInfoPanel();
        }

        // Close dialog
        closeProposalDialog();

        // Update proposal list if open
        updateProposalList();

        const statusMessage = onchainResult
            ? `Proposal "${proposalType}" created and minted on blockchain with ${proposal.parentParcelIds.length} parcels.`
            : `Proposal "${proposalType}" created successfully with ${proposal.parentParcelIds.length} parcels.`;
        updateStatus(statusMessage);

        if (proposalMainType === 'Reparcellization' && typeof window !== 'undefined') {
            window.pendingReparcellizationPlan = null;
        }

        if (typeof multiParcelSelection !== 'undefined') {
            if (createdFromMultiSelect && multiParcelSelection.isActive) {
                multiParcelSelection.toggle({ restoreSingleSelection: false });
            } else if (multiParcelSelection.selectedParcels) {
                multiParcelSelection.selectedParcels.clear();
                multiParcelSelection.lastSelectedParcelId = null;
                if (typeof multiParcelSelection.updateUI === 'function') {
                    multiParcelSelection.updateUI();
                }
            }
        }

        // No auto-apply on creation: the geometry is already on the map as an applied draft before
        // the proposal exists (we switched to auto-applying drafts). Re-applying the proposal here
        // was redundant and caused conflict toasts/modals against the very draft it was made from.

        // Proposing an existing LOCAL object absorbs it: the record it was created from is
        // removed, so exactly one thing remains on the map and in the list. A minted source is
        // immutable — it stays behind, parked as superseded by the replacement.
        try {
            const absorbedSourceId = proposal.sourceProposalId || proposal.replacementOfProposalId || null;
            const sourceRecord = absorbedSourceId ? proposalStorage.getProposal(absorbedSourceId) : null;
            if (sourceRecord && !(typeof isProposalMinted === 'function' && isProposalMinted(sourceRecord))) {
                if (typeof isProposalApplied === 'function' && isProposalApplied(sourceRecord)) {
                    await ProposalManager.unapplyProposal(absorbedSourceId, { skipConfirm: true, skipRestoreSource: true });
                }
                proposalStorage.removeProposal(absorbedSourceId);
                // The stored replacement no longer supersedes anything — its source is gone.
                const storedReplacement = proposalStorage.getProposal(proposalId);
                if (storedReplacement) {
                    delete storedReplacement.replacementLifecycle;
                    delete storedReplacement.supersedesProposalIds;
                    // Carry the one-jump undo through proposing too: the original object the edit
                    // chain started from stays restorable from the Delete prompt.
                    try {
                        const snapshot = JSON.parse(JSON.stringify(sourceRecord.revertSnapshot || sourceRecord));
                        ['revertSnapshot', 'childParcelIds', 'replacementLifecycle', 'supersedesProposalIds', 'proposalDraftId', 'acceptedParcelIds', 'ownerAcceptances'].forEach(key => delete snapshot[key]);
                        snapshot.status = 'unapplied';
                        ['roadProposal', 'buildingProposal', 'structureProposal', 'reparcellization', 'decideLaterProposal'].forEach(kind => {
                            if (snapshot[kind] && typeof snapshot[kind] === 'object') {
                                snapshot[kind].status = 'unapplied';
                                if (Array.isArray(snapshot[kind].childParcelIds)) snapshot[kind].childParcelIds = [];
                            }
                        });
                        storedReplacement.revertSnapshot = snapshot;
                    } catch (_) { }
                    if (typeof proposalStorage._indexProposal === 'function') proposalStorage._indexProposal(storedReplacement);
                    if (typeof proposalStorage.save === 'function') proposalStorage.save();
                }
                try { ProposalManager._refreshUIAfterProposalChange?.(storedReplacement); } catch (_) { }
            }
        } catch (absorbError) {
            console.warn('[createProposal] Could not absorb the local source object', absorbError);
        }

        const focusParcelId = proposal.parentParcelIds[0] || null;
        const openProposalDetails = () => {
            if (!waitingPopupVisible) {
                waitingPopupVisible = true;
                setProposalModalDimmed(true);
            }
            // Open the details panel collapsed on first appearance (see showProposalInfo).
            if (typeof window !== 'undefined') window.__openProposalDetailsCollapsed = true;
            if (typeof selectAndHighlightProposal === 'function') {
                // Do not refocus map when opening details immediately after creation
                selectAndHighlightProposal(proposalId, focusParcelId, false, true);
            } else if (typeof showProposalDetailsModal === 'function') {
                showProposalDetailsModal(proposalId);
            }
            // Hide popup after a short delay to allow panel to render
            setTimeout(() => {
                hideWaitingPopupSafe();
            }, 500);
        };

        console.debug('[createProposal] All proposal creation steps complete, opening details. Total elapsed:', (performance.now() - startTime).toFixed(2), 'ms');
        if (onchainResult) {
            showProposalMintSuccessModal({
                proposalId: onchainResult.proposalId,
                proposalId: hash,
                txHash: onchainResult.transactionHash,
                chainId: onchainResult.chainId,
                onClose: openProposalDetails
            });
        } else {
            openProposalDetails();
        }

    } catch (error) {
        console.error('Error creating proposal:', error);
        markDraftPublishFailed(error);
        const fallback = t('alerts.messages.failed_to_create_proposal', 'Failed to create proposal.');
        const message = (error && error.message) ? error.message : fallback;
        if (typeof window !== 'undefined' && typeof window.showStyledAlert === 'function') {
            window.showStyledAlert(message);
        } else {
            alert(message);
        }
    } finally {
        hideWaitingPopupSafe();
        setProposalModalInteractivity(true);
        setProposalCreateButtonState(false);
    }
}

function buildUploadReadyProposal(proposal) {
    if (!proposal) return null;
    const uploadProposal = { ...proposal };

    // Ensure backend-required proposal.type is set using the proposal goal
    const rawType = uploadProposal.type ? String(uploadProposal.type).trim().toLowerCase() : '';
    const goalKey = resolveProposalGoalKey(uploadProposal, null);
    const derivedType = mapGoalToBackendType(goalKey);
    uploadProposal.type = derivedType || rawType || 'parcel';

    // Proposals created since the `city` stamp carry their own origin; older ones fall back to the
    // current city, which is only right if you upload from where you created it.
    uploadProposal.city = uploadProposal.city || getProposalCityId() || 'city';

    // "Applied" describes *this browser's* map, not the proposal: it says the geometry has been
    // drawn onto the local cadastre. It is meaningless on the server, where every client has its
    // own map — publishing it is what made a downloaded proposal claim to be applied when nothing
    // had been drawn. Strip it. "Executed" is different: that is a global, on-chain fact and stays.
    //
    // Nested proposals are replaced with copies rather than mutated: uploadProposal is a shallow
    // copy of the caller's stored proposal, so writing through them would un-apply the user's own
    // proposal on their own map.
    if (uploadProposal.status === 'Applied') {
        uploadProposal.status = 'Active';
    }
    ['roadProposal', 'buildingProposal', 'structureProposal', 'reparcellization', 'decideLaterProposal']
        .forEach(key => {
            const nested = uploadProposal[key];
            if (!nested || typeof nested !== 'object') return;
            const sanitized = { ...nested };
            if (sanitized.status !== 'executed') sanitized.status = 'unapplied';
            delete sanitized.appliedAt;
            uploadProposal[key] = sanitized;
        });

    // Remove parentFeatures - we only upload IDs, not full geometries
    if (uploadProposal.parentFeatures) {
        delete uploadProposal.parentFeatures;
    }
    if (uploadProposal.roadProposal) {
        if (uploadProposal.roadProposal.parentFeatures) {
            delete uploadProposal.roadProposal.parentFeatures;
        }
        // Remove childFeatures - child parcel geometries are fetched by ID when needed
        if (uploadProposal.roadProposal.childFeatures) {
            delete uploadProposal.roadProposal.childFeatures;
        }
        // Ensure parentParcelIds are set (for fetching ancestors on load)
        if (!uploadProposal.roadProposal.parentParcelIds || uploadProposal.roadProposal.parentParcelIds.length === 0) {
            const parentIds = uploadProposal.parentParcelIds || [];
            uploadProposal.roadProposal.parentParcelIds = ensureArrayOfStrings(parentIds);
        }
    }
    return uploadProposal;
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

    // Open the Create Proposal dialog
    event.preventDefault();
    showProposalDialog();
}

function attachCreateProposalHotkey() {
    if (createProposalHotkeyAttached) return;
    document.addEventListener('keydown', handleCreateProposalHotkey);
    createProposalHotkeyAttached = true;
}
