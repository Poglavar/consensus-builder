// proposals/execution.js — extracted from proposals.js (behavior-preserving relocation).

function proposalApplyFailureReason(proposalId, error = null) {
    try {
        const manager = typeof ProposalManager === 'undefined' ? null : ProposalManager;
        const info = manager?.getLastApplyFailureInfo?.(proposalId);
        if (info?.message) return String(info.message);
        const message = manager?.getLastApplyFailure?.(proposalId);
        if (message) return String(message);
    } catch (_) { }
    return String(error?.message || error || '').trim();
}

// After a failed apply: 'applied' when a local draft's parcels were re-derived from its geometry
// and it applied, 'fork' when a published record should be offered a new proposal with the same
// geometry, else null. Never throws: a failed re-derivation leaves the original error standing.
async function rebaseAfterApplyFailure(proposalId, proposal) {
    const rebaseApi = window.ProposalGroundRebase;
    if (!rebaseApi || !proposal) return null;
    try {
        const failure = typeof ProposalManager !== 'undefined' ? ProposalManager.getLastApplyFailureInfo?.(proposalId) : null;
        const published = typeof isPublishedProposalRecord === 'function' && isPublishedProposalRecord(proposal);
        const route = rebaseApi.rebaseRoute(proposal, failure, published);
        if (route !== 'rederive') return route;
        const result = await rebaseApi.rederiveAndApply(proposal, rebaseApi.browserDeps());
        console.log(`[${new Date().toISOString()}] [applyProposalToMap] ${proposalId}: ground changed (${failure.code}); `
            + `re-derived its parcels from its geometry → ${result.outcome} (${result.ids.length} parcels)`);
        if (result.outcome !== 'applied') return null;
        if (typeof showEphemeralMessage === 'function') {
            showEphemeralMessage(rebaseApi.t('proposalGroundRebase.rederived',
                'The cadastre changed under this draft: its parcels now follow its geometry ({{count}}).', { count: result.ids.length }), 5000, 'info');
        }
        return 'applied';
    } catch (error) {
        console.error(`[${new Date().toISOString()}] [applyProposalToMap] ${proposalId}: re-deriving its parcels failed`, error);
        return null;
    }
}

function reportProposalMapActionFailure(proposalId, reason = '', fallbackKey = 'applyFailedUnknown', action = 'apply', extra = {}) {
    const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
    let fallback;
    switch (fallbackKey) {
        case 'unapplyUnavailable': fallback = t ? t('panel.proposal.actions.unapplyUnavailable', 'This proposal cannot be removed from the map.') : 'This proposal cannot be removed from the map.'; break;
        case 'applyUnavailable': fallback = t ? t('panel.proposal.actions.applyUnavailable', 'This proposal cannot be applied to the map.') : 'This proposal cannot be applied to the map.'; break;
        case 'applyUnsupported': fallback = t ? t('panel.proposal.actions.applyUnsupported', 'This proposal type does not support map application.') : 'This proposal type does not support map application.'; break;
        case 'proposalNotLoaded': fallback = t ? t('panel.proposal.actions.proposalNotLoaded', 'This proposal is not loaded in this browser. Open it from the proposals list, then try again.') : 'This proposal is not loaded in this browser. Open it from the proposals list, then try again.'; break;
        case 'missingProposal': fallback = t ? t('panel.proposal.actions.missingProposal', 'No proposal was selected to apply.') : 'No proposal was selected to apply.'; break;
        case 'applyFailedUnknown': fallback = t ? t('panel.proposal.actions.applyFailedUnknown', 'Could not apply this proposal. Please try again.') : 'Could not apply this proposal. Please try again.'; break;
        default: fallback = t ? t('panel.proposal.actions.unapplyFailedUnknown', 'Could not remove this proposal from the map. Please try again.') : 'Could not remove this proposal from the map. Please try again.';
    }
    let message = fallback;
    if (reason) {
        const template = action === 'unapply'
            ? (t ? t('panel.proposal.actions.unapplyFailed', 'Could not remove this proposal from the map: {{reason}}') : 'Could not remove this proposal from the map: {{reason}}')
            : (t ? t('panel.proposal.actions.applyFailed', 'Could not apply this proposal: {{reason}}') : 'Could not apply this proposal: {{reason}}');
        message = typeof template === 'string' ? template.replace('{{reason}}', String(reason)) : template;
    }
    if (proposalId) {
        const failures = window.__proposalMapActionFailures || (window.__proposalMapActionFailures = Object.create(null));
        failures[String(proposalId)] = message;
        const forkOffers = window.__proposalGroundForkOffers || (window.__proposalGroundForkOffers = Object.create(null));
        if (extra && extra.offerFork) forkOffers[String(proposalId)] = true;
        else delete forkOffers[String(proposalId)];
        const detailsContent = typeof document !== 'undefined' ? document.getElementById('proposal-details-content') : null;
        if (detailsContent?.dataset?.proposalId === String(proposalId)) {
            const panelError = [...document.querySelectorAll('[data-proposal-map-action-error]')]
                .find(element => element.dataset.proposalMapActionError === String(proposalId));
            let notice = panelError || null;
            if (panelError) panelError.textContent = message;
            else {
                const footer = document.getElementById('proposal-details-footer');
                if (footer?.appendChild && typeof document.createElement === 'function') {
                    notice = document.createElement('div');
                    notice.className = 'proposal-editor-approval-error proposal-map-action-error';
                    notice.dataset.proposalMapActionError = String(proposalId);
                    notice.setAttribute('role', 'alert');
                    notice.textContent = message;
                    footer.appendChild(notice);
                }
            }
            // Ground changed under a published record: the way forward sits under the error.
            if (notice && forkOffers[String(proposalId)] && window.ProposalGroundRebase && notice.insertAdjacentHTML) {
                const escape = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                notice.insertAdjacentHTML('beforeend', window.ProposalGroundRebase.offerButtonHtml(String(proposalId), escape));
            }
        }
    }
    if (typeof showEphemeralMessage === 'function') showEphemeralMessage(message, 8000, 'error');
    return message;
}

function clearProposalMapActionFailure(proposalId) {
    if (!proposalId || typeof window === 'undefined') return;
    if (window.__proposalMapActionFailures) delete window.__proposalMapActionFailures[String(proposalId)];
    if (window.__proposalGroundForkOffers) delete window.__proposalGroundForkOffers[String(proposalId)];
    if (typeof document !== 'undefined') {
        [...document.querySelectorAll('[data-proposal-map-action-error]')]
            .filter(element => element.dataset.proposalMapActionError === String(proposalId))
            .forEach(element => element.remove());
    }
}

async function applyProposalToMap(proposalIdOrHash, options = {}) {
    const startTime = performance.now();
    const safeId = proposalIdOrHash ? String(proposalIdOrHash) : '';
    console.debug(`[applyProposalToMap] Starting application for proposal ${safeId}...`);

    if (!safeId || typeof ProposalManager === 'undefined' || typeof ProposalManager.applyProposal !== 'function') {
        console.warn(`[applyProposalToMap] Invalid proposal id/hash or ProposalManager unavailable`);
        reportProposalMapActionFailure(safeId, '', safeId ? 'applyUnavailable' : 'missingProposal');
        return false;
    }

    const step1Time = performance.now();
    const proposal = (typeof proposalStorage !== 'undefined' && typeof proposalStorage?.getProposal === 'function')
        ? proposalStorage.getProposal(safeId)
        : null;
    console.debug(`[applyProposalToMap] Step 1: Retrieved proposal from storage (${(performance.now() - step1Time).toFixed(2)}ms)`);

    if (!proposal) {
        console.warn(`[applyProposalToMap] Proposal is not loaded locally: ${safeId}`);
        reportProposalMapActionFailure(safeId, '', 'proposalNotLoaded');
        return false;
    }

    const { supportsMapToggle, isRoadProposal } = computeProposalCategoryFlags(proposal, { fallbackProposal: proposal });
    if (!supportsMapToggle) {
        console.debug(`[applyProposalToMap] Skipping unsupported map apply action for proposal ${safeId}`);
        reportProposalMapActionFailure(safeId, '', 'applyUnsupported');
        return false;
    }

    const normalizedType = resolveProposalActionTypeKey(proposal, null);
    if (!isRoadProposal && APPLY_DISABLED_TYPE_KEYS.has(normalizedType)) {
        const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
        const message = t
            ? t('panel.proposal.actions.apply_disabled_for_type', 'Apply is disabled for this proposal type.')
            : 'Apply is disabled for this proposal type.';
        if (typeof showEphemeralMessage === 'function') {
            showEphemeralMessage(message, 3500, 'info');
        }
        console.debug(`[applyProposalToMap] Apply disabled for proposal type: ${normalizedType}`);
        return false;
    }

    const step2Time = performance.now();
    // Update button to show loading state
    const buttonId = `proposal-action-btn-${safeId}`;
    const button = document.getElementById(buttonId);
    let originalButtonContent = null;
    if (button) {
        originalButtonContent = button.innerHTML;
        const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
        const applyingText = t
            ? t('panel.proposal.actions.applying', 'Applying...')
            : 'Applying...';
        button.disabled = true;
        button.innerHTML = `<span class="metric-spinner" aria-hidden="true"></span> ${applyingText}`;
    }
    console.debug(`[applyProposalToMap] Step 2: Updated button UI (${(performance.now() - step2Time).toFixed(2)}ms)`);

    try {
        const step3Time = performance.now();
        // Use setTimeout to allow UI to update before heavy operation
        await new Promise(resolve => setTimeout(resolve, 0));
        console.debug(`[applyProposalToMap] Step 3: UI update delay (${(performance.now() - step3Time).toFixed(2)}ms)`);

        const step4Time = performance.now();
        console.debug(`[applyProposalToMap] Step 4: Calling ProposalManager.applyProposal...`);
        const applied = await ProposalManager.applyProposal(safeId);
        const step4Duration = performance.now() - step4Time;
        console.debug(`[applyProposalToMap] Step 4: ProposalManager.applyProposal completed (${step4Duration.toFixed(2)}ms)`);

        let rebase = null;
        if (applied === false) {
            console.warn(`[applyProposalToMap] Proposal application returned false`);
            // Ground that changed under the stored parcels (proposals/ground-rebase.js): a local
            // draft re-derives its parcels from its geometry and applies; a published record keeps
            // its error and is offered a new proposal with the same geometry.
            rebase = await rebaseAfterApplyFailure(safeId, proposal);
        }
        if (applied === false && rebase !== 'applied') {
            const reason = proposalApplyFailureReason(safeId);
            reportProposalMapActionFailure(safeId, reason, 'applyFailedUnknown', 'apply', { offerFork: rebase === 'fork' });
            if (button && originalButtonContent) {
                button.innerHTML = originalButtonContent;
                button.disabled = false;
            }
            return false;
        }
    } catch (error) {
        console.error(`[applyProposalToMap] Error applying proposal to map (${(performance.now() - startTime).toFixed(2)}ms):`, error);
        const reason = proposalApplyFailureReason(safeId, error);
        reportProposalMapActionFailure(safeId, reason);
        // Restore button on error
        if (button && originalButtonContent) {
            button.innerHTML = originalButtonContent;
            button.disabled = false;
        }
        return false;
    }

    clearProposalMapActionFailure(safeId);

    const step5Time = performance.now();
    // Clear the preview overlay (dashed outline) when proposal is applied
    // The actual parcels are now on the map with normal styling, so preview is no longer needed
    if (typeof clearProposalPreviewLayers === 'function') {
        clearProposalPreviewLayers();
    }
    console.debug(`[applyProposalToMap] Step 5: Cleared preview layers (${(performance.now() - step5Time).toFixed(2)}ms)`);

    // Immediately restore button state to prevent it from being stuck in loading state
    // The button will be updated to "Remove from map" by showProposalInfo below
    const currentButton = document.getElementById(buttonId);
    if (currentButton) {
        const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
        ProposalMapAction.renderButton(currentButton, safeId, true, t);
    }

    const step6Time = performance.now();
    let step6Label = 'Revealed details';
    // Do not auto-refresh proposal details during apply by default; it is expensive for large proposals.
    // Callers can opt-in with options.revealDetails = true.
    const revealDetails = options.revealDetails === true;

    let proposalUpdated = false;
    if (revealDetails && typeof proposalStorage !== 'undefined') {
        const proposalForRefresh = proposalStorage.getProposal(safeId);
        if (proposalForRefresh) {
            const parcelIds = Array.isArray(proposalForRefresh.cadastreParcelIds) ? proposalForRefresh.cadastreParcelIds : [];
            const fallbackParcelId = options.parcelId || (parcelIds.length > 0 ? parcelIds[0] : null);
            const proposalKey = typeof getProposalKey === 'function' ? getProposalKey(proposalForRefresh) : null;
            const alreadyHighlighted = proposalKey && window.currentlyHighlightedProposalId === proposalKey;
            const resolvedParcel = options.parcelId || window.selectedParcelInProposal || fallbackParcelId;

            if (alreadyHighlighted && options.forceRefocus !== true) {
                // When the proposal is already selected (common when clicking Apply inside its panel),
                // avoid re-running highlight + fitBounds work; just update button state.
                // Don't call showProposalInfo during apply - it's expensive and not needed.
                // The button will be updated by the fallback code below.
                proposalUpdated = true;
                step6Label = 'Reused existing selection (skipped refocus)';
            } else {
                focusProposalDetails(safeId, {
                    parcelId: resolvedParcel,
                    centerOnProposal: options.centerOnProposal !== false,
                    showDetails: options.showDetails !== false
                });
                proposalUpdated = true;

                // Clear overlays again after focusProposalDetails (which may have re-added them via applyProposalHighlights)
                // For applied proposals, we want normal parcel styling, not dashed outline overlays
                if (typeof clearProposalPreviewLayers === 'function') {
                    clearProposalPreviewLayers();
                }
            }
        }
    }

    // Fallback: If showProposalInfo wasn't called, ensure button is still updated
    if (!proposalUpdated) {
        const fallbackButton = document.getElementById(buttonId);
        if (fallbackButton && (fallbackButton.innerHTML.includes('Applying') || fallbackButton.innerHTML.includes('metric-spinner'))) {
            const t = typeof getProposalI18nHelper === 'function' ? getProposalI18nHelper() : null;
            ProposalMapAction.renderButton(fallbackButton, safeId, true, t);
        }
    }

    console.debug(`[applyProposalToMap] Step 6: ${step6Label} (${(performance.now() - step6Time).toFixed(2)}ms)`);

    // An applied road becomes a corridor parcel; draw its cross-section over it.
    if (typeof scheduleCorridorStripRefresh === 'function') scheduleCorridorStripRefresh();

    const totalTime = performance.now() - startTime;
    console.debug(`[applyProposalToMap] ✓ Application completed successfully in ${totalTime.toFixed(2)}ms`);
    return true;
}

function computeOwnershipStatsFromSelection(selection) {
    const result = {
        ownerKeys: new Set(),
        ownerCount: 0,
        mode: 'multiple'
    };
    const parcelIds = selection && Array.isArray(selection.ids) ? selection.ids.map(String).filter(Boolean) : [];

    if (!parcelIds.length) {
        return result;
    }

    parcelIds.forEach((parcelId, index) => {
        let addedOwnerForParcel = false;

        if (parcelId && typeof getParcelOwnerSlots === 'function') {
            try {
                const slots = getParcelOwnerSlots(String(parcelId));
                if (Array.isArray(slots) && slots.length) {
                    slots.forEach(slot => {
                        const key = slot && (slot.key || slot.ownerKey || slot.displayName || slot.name);
                        if (key) {
                            result.ownerKeys.add(String(key));
                            addedOwnerForParcel = true;
                        }
                    });
                }
            } catch (error) {
                console.warn('Failed to resolve owner slots for parcel', parcelId, error);
            }
        }

        if (!addedOwnerForParcel) {
            const fallbackKey = parcelId ? `parcel:${parcelId}:owner` : `parcel:index:${index}`;
            result.ownerKeys.add(fallbackKey);
        }
    });

    result.ownerCount = result.ownerKeys.size;
    result.mode = result.ownerCount <= 1 ? 'single' : 'multiple';
    return result;
}

function setOwnershipTransferDirection(direction) {
    currentOwnershipTransferDirection = direction;
    const buttons = document.querySelectorAll('.proposal-ownership-transfer-button');
    buttons.forEach(btn => {
        btn.setAttribute('aria-pressed', String(btn.getAttribute('data-transfer-direction') === direction));
    });

    // Update proposal type based on direction - directly set currentProposalTool
    // Don't call setProposalType() as it would reset currentProposalTool to null
    // (there's no button with data-proposal-type matching the direction-specific goal)
    const effectiveGoal = direction === 'from-me' ? 'ownership-transfer-from-me' : 'ownership-transfer-to-me';
    currentProposalTool = effectiveGoal;

    // Update the hidden input for the proposal type
    const typeInput = document.getElementById('proposalType');
    if (typeInput) {
        typeInput.value = effectiveGoal;
    }

    // Update name and description
    updateProposalNameAndDescription(effectiveGoal, true);

    // Update screenshot icon
    updateProposalScreenshotGoalIcon('ownership-transfer');

    // No geometry for ownership transfer
    renderGeometrySection('ownership-transfer');

    // Update submit state
    updateCreateProposalSubmitState();
}

function getProposalRecipientAddress() {
    const el = document.getElementById('proposalRecipientAddress');
    return el && el.value ? el.value.trim() : '';
}

function setProposalOwnershipMode(mode, { lock = false, unlock = false, reason = '' } = {}) {
    proposalFacetState.ownership = mode;
    applyFacetLockUI('proposalOwnershipGroup', 'proposalOwnershipStatic', 'proposalOwnership', mode, lock, reason);
    // Third party reveals the Specific-address / Anyone sub-choice (Anyone = open sale offer).
    const opts = document.getElementById('proposalRecipientOptions');
    if (opts) opts.style.display = (!lock && mode === 'third-party') ? '' : 'none';
    updateRecipientAddressVisibility();
}

function updateRecipientAddressVisibility() {
    const addr = document.getElementById('proposalRecipientAddress');
    if (!addr) return;
    const opts = document.getElementById('proposalRecipientOptions');
    const optsVisible = !!opts && opts.style.display !== 'none';
    const scopeSel = document.querySelector('input[name="proposalRecipientScope"]:checked');
    const scope = scopeSel ? scopeSel.value : 'any';
    addr.style.display = (optsVisible && scope === 'specific') ? '' : 'none';
}

function onProposalRecipientScopeChange() {
    updateRecipientAddressVisibility();
    syncProposalFacets();
}

function ownershipNameType() {
    const o = proposalFacetState.ownership;
    const scope = (window.proposalFacets && window.proposalFacets.recipientScope) || 'any';
    if (o === 'to-city') return 'ownership-transfer-to-city';
    if (o === 'third-party') return (scope === 'any') ? 'offer-to-sell' : 'ownership-transfer-third-party';
    return 'ownership-transfer-to-me';
}

function onProposalOwnershipChange() {
    const sel = document.querySelector('input[name="proposalOwnership"]:checked');
    // Route through setProposalOwnershipMode so the Third-party inset (Specific/Anyone)
    // and the address field show/hide correctly.
    setProposalOwnershipMode(sel ? sel.value : 'no-change');
    syncProposalFacets();
}

function isProposalApplied(proposal) {
    if (!proposal) return false;

    const structureData = resolveStructureProposal(proposal);
    const goalKey = resolveProposalGoalKey(proposal, null);
    const hasSpatialComponent = Boolean(
        goalKey === 'road-track'
        || goalKey === 'buildings'
        || goalKey === 'single'
        || goalKey === 'row'
        || goalKey === 'parcelBased'
        || goalKey === 'park'
        || goalKey === 'square'
        || goalKey === 'lake'
        || goalKey === 'parcel-layout'
        || proposal.buildingProposal
        || proposal.buildingGeometry
        || structureData
        || proposal.parcelLayout
    );

    if (!hasSpatialComponent) return false;

    // Canonical map-application axis (proposals/status.js): one root boolean, no nested or legacy
    // inference. isApplied is a global defined by status.js, loaded first.
    return isApplied(proposal);
}

function isProposalCurrentlyApplied(proposal) {
    return !!proposal && isApplied(proposal);
}
