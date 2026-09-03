/* proposals/bootstrap.js — final browser wiring for the proposal subsystem. */

if (typeof window !== 'undefined') {
    window.claimSaleOffer = claimSaleOffer;
    window.recordRecipientConsent = recordRecipientConsent;
    window.isProposalOpenSaleOffer = isProposalOpenSaleOffer;
    window.acceptAsRecipient = acceptAsRecipient;
    window.proposalHighlightStyleOverride = proposalHighlightStyleOverride;

    window.currentlyHighlightedProposal = null;
    window.selectedParcelInProposal = null;
    window.isApplyingProposalHighlights = false;

    window.openProposalFromList = openProposalFromList;
    window.normalizeProposalGoalKey = normalizeProposalGoalKey;
    window.resolveProposalGoalKey = resolveProposalGoalKey;
    window.focusProposalDetails = focusProposalDetails;
    window.applyProposalToMap = applyProposalToMap;
    window.removeProposalFromMap = removeProposalFromMap;
    window.returnToParcelInfo = returnToParcelInfo;
    window.hideProposalDetailsPanel = hideProposalDetailsPanel;
    window.toggleProposalDetailsPanelMinimized = toggleProposalDetailsPanelMinimized;
    window.shouldSkipProposalScreenshot = shouldSkipProposalScreenshot;
    window.openRoadDesignationModal = openRoadDesignationModal;
    window.areParcelsContiguous = areParcelsContiguous;
}

// Upgrade proposal-card thumbnails without rebuilding the proposal list.
if (typeof document !== 'undefined') {
    document.addEventListener('proposalScreenshotUpdated', (event) => {
        const detail = event && event.detail ? event.detail : {};
        const { proposalId } = detail;
        const rawSrc = detail.screenshotUrl || detail.screenshotDataUrl;
        // A stored thumbnail is a served path; resolve it against the backend (data URLs pass through).
        const imageSrc = (typeof resolveBackendAssetUrl === 'function') ? (resolveBackendAssetUrl(rawSrc) || rawSrc) : rawSrc;
        if (!proposalId || !imageSrc) return;
        const escapedId = (typeof CSS !== 'undefined' && CSS.escape)
            ? CSS.escape(String(proposalId))
            : String(proposalId);
        document.querySelectorAll(`.proposal-thumb[data-proposal-id="${escapedId}"]`).forEach(node => {
            node.classList.remove('proposal-thumb-empty');
            node.classList.add('proposal-thumb-has-image');
            node.removeAttribute('title');
            node.innerHTML = `
                <img class="proposal-thumb-img" src="${imageSrc}" alt="" loading="lazy">
                <div class="proposal-thumb-large"><img src="${imageSrc}" alt=""></div>
            `;
        });
    });
}

// Clicking the selected goal expands the collapsed proposal-goal grid.
if (typeof document !== 'undefined' && !window.__proposalGoalCollapseInstalled) {
    document.addEventListener('click', (event) => {
        const group = document.getElementById('proposalGoalGroup');
        if (!group || !group.classList.contains('is-collapsed') || !group.contains(event.target)) return;
        const button = event.target.closest('.proposal-type-button[data-proposal-tool]');
        if (!button || !button.classList.contains('selected')) return;
        event.stopPropagation();
        event.preventDefault();
        expandProposalGoalGroup();
    }, true);
    window.__proposalGoalCollapseInstalled = true;
}

if (typeof window !== 'undefined') {
    window.showStructureProposalDialog = showStructureProposalDialog;
    window.handleProposalToolButton = handleProposalToolButton;
    window.selectLandUse = selectLandUse;
    window.onProposalLandUseChange = onProposalLandUseChange;
    window.onProposalParcelsChange = onProposalParcelsChange;
    window.onProposalOwnershipChange = onProposalOwnershipChange;
    window.onProposalRecipientScopeChange = onProposalRecipientScopeChange;
    window.setProposalType = setProposalType;
    window.setProposalMainType = setProposalMainType;
    window.setProposalAcquisitionMode = setProposalAcquisitionMode;
    window.setProposalBoundaryMode = setProposalBoundaryMode;
    window.handleUrbanRuleMainTypeClick = handleUrbanRuleMainTypeClick;
    window.handleUrbanRuleTypologyClick = handleUrbanRuleTypologyClick;
    window.handleReparcellizationAlgorithmClick = handleReparcellizationAlgorithmClick;
    window.applyContiguityConstraints = applyContiguityConstraints;
    window.populateProposalAuthorUI = populateProposalAuthorUI;
    window.getProposalAuthorValue = getProposalAuthorValue;
    window.getSelectedProposalTool = getSelectedProposalTool;
    window.buildGeometryFromParcels = buildGeometryFromParcels;
    window.getCurrentParcelSelectionContext = getCurrentParcelSelectionContext;
    window.resolveStructureProposal = resolveStructureProposal;
    window.getProposalLifecycleKey = getProposalLifecycleKey;
    window.getProposalLifecycleLabel = getProposalLifecycleLabel;
    window.getProposalLifecycleClass = getProposalLifecycleClass;
    window.getParcelAreaById = getParcelAreaById;
    window.buildProposalThumbHtml = buildProposalThumbHtml;
    window.isProposalUIActive = isProposalUIActive;
    window.shareProposalFromDetails = shareProposalFromDetails;
    window.showWalkUploadGateModal = showWalkUploadGateModal;

    window.requirePersonalizedUser = requirePersonalizedUser;
    window.showProposalDialog = showProposalDialog;
    window.closeProposalDialog = closeProposalDialog;
    window.createProposal = createProposal;
    window.showAllProposalsModal = showAllProposalsModal;
    window.switchProposalTab = switchProposalTab;
    window.closeProposalList = closeProposalList;
    window.showProposalDetailsModal = showProposalDetailsModal;
    window.updateShowProposalsButton = updateShowProposalsButton;
    window.updateProposalLayer = updateProposalLayer;
    window.toggleExpiryInput = toggleExpiryInput;
    window.toggleDecayInput = toggleDecayInput;
    window.calculateDecayedOffer = calculateDecayedOffer;
    window.getDecayProgress = getDecayProgress;
    window.initializeDecayCountdown = initializeDecayCountdown;
    window.isProposalExpired = isProposalExpired;
    window.checkAndUpdateProposalExpiry = checkAndUpdateProposalExpiry;
    window.initializeExpiryCountdown = initializeExpiryCountdown;
    window.clearLocalProposalData = clearLocalProposalData;
    window.centerOnProposal = centerOnProposal;
    window.reapplyProposalHighlights = reapplyProposalHighlights;
    window.selectProposalFromList = selectProposalFromList;
    window.cancelMultiParcelSelection = cancelMultiParcelSelection;
    window.deleteProposal = deleteProposal;
    window.handleMultiSelectChange = handleMultiSelectChange;
    window.refreshProposalData = refreshProposalData;
    window.selectAndHighlightProposal = selectAndHighlightProposal;
    window.calculateProposalBounds = calculateProposalBounds;
    window.shareAppliedProposals = shareAppliedProposals;
}

if (typeof document !== 'undefined') {
    document.addEventListener('blockifyModalOpened', () => setProposalModalDimmed(true));
    document.addEventListener('blockifyModalClosed', () => setProposalModalDimmed(false));
    document.addEventListener('urbanRuleModalOpened', () => setProposalModalDimmed(true));
    document.addEventListener('urbanRuleModalClosed', () => setProposalModalDimmed(false));
}

if (typeof PersistentStorage !== 'undefined' && PersistentStorage.ensureReady) {
    PersistentStorage.ensureReady(initialiseProposalStorage);
} else {
    initialiseProposalStorage();
}

try {
    if (typeof window !== 'undefined') {
        if (window.i18n && typeof window.i18n.onChange === 'function') {
            window.i18n.onChange(rerenderProposalListIfOpen);
        }
        window.addEventListener('i18n:translationsLoaded', rerenderProposalListIfOpen);
    }
} catch (_) { }

if (typeof window !== 'undefined') {
    window.addEventListener('load', () => {
        setTimeout(() => handleProposalRouteFromUrl(), 100);
        setTimeout(() => handleSingleProposalShareFromUrl(), 200);
        setTimeout(() => handleSharedProposalsFromUrl(), 250);
        setTimeout(() => { try { syncProposalsIndicator(); } catch (_) { } }, 300);
        setTimeout(() => handleStandalone3DModeFromUrl(), 500);
    });
}

if (typeof document !== 'undefined' && !setupMultiParcelHighlightListeners()) {
    document.addEventListener('DOMContentLoaded', () => {
        let attempts = 0;
        const interval = setInterval(() => {
            if (setupMultiParcelHighlightListeners() || ++attempts > 20) clearInterval(interval);
        }, 200);
    });
}

if (typeof document !== 'undefined') {
    const initialiseProposalDom = () => {
        updateShowProposalsButton();
        attachCreateProposalHotkey();
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialiseProposalDom, { once: true });
    } else {
        initialiseProposalDom();
    }
}

if (typeof window !== 'undefined') {
    window.proposalStorage = proposalStorage;
    window.multiParcelSelection = multiParcelSelection;
    window.getProposalOwnerAcceptanceState = getProposalOwnerAcceptanceState;
    window.buildOwnerAcceptanceSectionHtml = buildOwnerAcceptanceSectionHtml;
    window.handleUserRejectProposal = handleUserRejectProposal;
    window.handleProposalParcelClick = handleProposalParcelClick;
    window.openProposalBoostDialog = openProposalBoostDialog;
    window.submitProposalBoost = submitProposalBoost;
    window.closeProposalBoostDialog = closeProposalBoostDialog;

    window.addEventListener('parcelDataLoaded', (event) => {
        // Cadastral arrivals are already integrated — including road cuts — before this committed
        // presentation event fires. This listener refreshes proposal UI only; it never starts a
        // second derivation over the same ground.
        scheduleHighlightRefresh('parcels-loaded');
        if (typeof updateProposalLayer === 'function') updateProposalLayer();

        const selectedId = window.selectedParcelId;
        if (!selectedId || !window.LiveParcelFabric?.get?.(selectedId)) return;
        const layer = window.ParcelPresenter?.getLayer?.(selectedId) || null;
        if (!layer) return;

        const isTrackSelected = window.LiveParcelFabric.get(selectedId)?.properties?.isTrack === true || Boolean(layer?._trackStyle);
        if (isTrackSelected) {
            const styleFn = typeof getParcelStyle === 'function' ? getParcelStyle : getParcelBaseStyle;
            const style = styleFn ? styleFn(selectedId, layer, { isTrack: true }) : {};
            layer.setStyle({ ...style, weight: 4 });
        } else if (typeof selectedParcelStyle !== 'undefined') {
            layer.setStyle(selectedParcelStyle);
        }
        layer.bringToFront();
    });

    window.formatProposalOfferValue = formatProposalOfferValue;
    window.handleProposalOfferInput = handleProposalOfferInput;
    window.parseProposalOfferValue = parseProposalOfferValue;
}
