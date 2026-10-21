// proposals/execution.js — extracted from proposals.js (behavior-preserving relocation).

// normalizeOwnerAcceptances and ensureOwnerAcceptanceEntry moved to
// frontend/js/proposals/owner-acceptance.js (loaded first) so they are unit-tested. The globals
// they define are used here and in proposals/core.js and data.js.
//
// A design has no consent of its own (plan-design-agreement.md, M2): owners decide on agreements
// (proposals/approval-panel.js in the agreement panel). The local owner-acceptance records below
// remain only for the agent simulation and the parcel panels that still read them.

function getProposalOwnerAcceptanceState(proposal, parcelId, options = {}) {
    if (!proposal) {
        return { entries: [] };
    }
    const ownerSlots = getOwnerSlotsForParcel(parcelId);
    const entry = ensureOwnerAcceptanceEntry(proposal, parcelId, ownerSlots);
    refreshProposalAcceptanceValidity(proposal);
    if (!entry) {
        return { entries: [] };
    }

    const acceptedKeys = new Set(currentProposalOwnerAcceptanceKeys(proposal, entry));
    const consentHash = currentConsentBindingHash(proposal);
    const currentUser = typeof getCurrentUserAgent === 'function' ? getCurrentUserAgent() : null;
    const entries = (entry.ownerOrder || []).map(ownerKey => {
        const slot = entry.owners[ownerKey] || ownerSlots.find(s => s.key === ownerKey) || { key: ownerKey };
        const acceptanceMeta = entry.acceptedBy[ownerKey] || {};
        const isAccepted = acceptedKeys.has(ownerKey);
        const slotType = slot.type || 'unknown';
        const slotAgentId = slot.agentId || null;
        let canAccept = !isAccepted && !!currentUser && getLifecycleStatus(proposal) !== 'Unknown';
        if (slotType === 'agent' && slotAgentId && (!currentUser || slotAgentId !== currentUser.id)) {
            canAccept = false;
        }
        if (!currentUser && slotType !== 'oss') {
            canAccept = false;
        }
        let canUndo = false;
        if (isAccepted && currentUser && acceptanceMeta.agentId === currentUser.id) {
            canUndo = true;
        }

        return {
            key: ownerKey,
            displayName: slot.displayName || `Owner ${ownerKey}`,
            shareText: slot.shareText || '',
            shareDetail: slot.shareDetail || '',
            accepted: isAccepted,
            termsChanged: !isAccepted && !!acceptanceMeta.effectHash && !!consentHash
                && acceptanceMeta.effectHash !== consentHash,
            acceptedAt: acceptanceMeta.acceptedAt || null,
            acceptedByName: acceptanceMeta.username || '',
            acceptedByAgentId: acceptanceMeta.agentId || null,
            slotType,
            agentId: slotAgentId,
            canAccept,
            canUndo
        };
    });

    return {
        entries,
        ownerEntry: entry
    };
}

// Evaluate a copy against the current roster and terms before presenting or sorting a tally.
// Opening the list must not rewrite stored consent. Count only unique declared references;
// neither non-binding votes nor a stored aggregate alone can establish owner consent.
function getProposalConsentMetrics(proposal) {
    const parcelIds = normalizeParcelIdList(proposal?.cadastreParcelIds);
    // A parcel layout is a design, which nobody consents to: it has no tally.
    if (proposal?.goal === 'parcel-layout') {
        return { parcelCount: parcelIds.length, acceptedCount: 0, acceptanceRatio: 0, acceptancePercent: 0, consentBasis: null };
    }
    const evaluated = { ...proposal, ownerAcceptances: normalizeOwnerAcceptances(proposal?.ownerAcceptances), acceptedParcelIds: [] };
    buildProposalOwnerAcceptanceSummaryFast(evaluated);
    const accepted = new Set(normalizeParcelIdList(evaluated.acceptedParcelIds));
    const acceptedCount = parcelIds.filter(id => accepted.has(id)).length;
    const acceptanceRatio = parcelIds.length ? acceptedCount / parcelIds.length : 0;
    return { parcelCount: parcelIds.length, acceptedCount, acceptanceRatio,
        acceptancePercent: acceptanceRatio * 100, consentBasis: 'local-records' };
}

function buildProposalOwnerAcceptanceSummaryFast(proposal) {
    const summary = {
        entries: [],
        totalOwners: 0,
        acceptedOwners: 0
    };
    if (!proposal || !Array.isArray(proposal.cadastreParcelIds)) {
        return summary;
    }

    const parcelIds = normalizeParcelIdList(proposal.cadastreParcelIds);
    parcelIds.forEach(parcelId => ensureOwnerAcceptanceEntry(proposal, parcelId, getOwnerSlotsForParcel(parcelId)));
    refreshProposalAcceptanceValidity(proposal);
    const acceptances = proposal.ownerAcceptances || {};
    let includeEntries = true;

    parcelIds.forEach(parcelId => {
        const normalizedParcelId = parcelId !== undefined && parcelId !== null
            ? parcelId.toString()
            : '';
        if (!normalizedParcelId) return;

        const entry = acceptances[normalizedParcelId];
        if (!entry) return;

        const ownerOrder = Array.isArray(entry.ownerOrder)
            ? entry.ownerOrder
            : Object.keys(entry.owners || {});
        const acceptedKeysArray = currentProposalOwnerAcceptanceKeys(proposal, entry);
        const acceptedSet = new Set(acceptedKeysArray.map(key => key && key.toString()).filter(Boolean));

        summary.totalOwners += ownerOrder.length;
        summary.acceptedOwners += acceptedSet.size;

        if (includeEntries) {
            ownerOrder.forEach(ownerKey => {
                if (!ownerKey) return;
                const ownerMeta = entry.owners && entry.owners[ownerKey] ? entry.owners[ownerKey] : {};
                summary.entries.push({
                    key: ownerKey,
                    displayName: ownerMeta.displayName || `Owner ${ownerKey}`,
                    shareText: ownerMeta.shareText || '',
                    parcelId: normalizedParcelId,
                    accepted: acceptedSet.has(ownerKey.toString())
                });
            });
            if (summary.totalOwners > 65) {
                summary.entries = [];
                includeEntries = false;
            }
        }
    });

    return summary;
}

function buildProposalOwnerAcceptanceSummary(proposal) {
    const summary = {
        entries: [],
        totalOwners: 0,
        acceptedOwners: 0
    };
    if (!proposal || !Array.isArray(proposal.cadastreParcelIds) || typeof getProposalOwnerAcceptanceState !== 'function') {
        return summary;
    }

    const entries = [];
    normalizeParcelIdList(proposal.cadastreParcelIds).forEach(parcelId => {
        const normalizedParcelId = parcelId !== undefined && parcelId !== null
            ? parcelId.toString()
            : '';
        if (!normalizedParcelId) {
            return;
        }
        try {
            const parcelAcceptance = typeof getProposalOwnerAcceptanceState === 'function'
                ? getProposalOwnerAcceptanceState(proposal, normalizedParcelId)
                : { entries: [] };
            const parcelEntries = Array.isArray(parcelAcceptance.entries) ? parcelAcceptance.entries.slice() : [];
            const entriesForParcel = parcelEntries;

            entriesForParcel.forEach((entry, index) => {
                if (!entry) return;
                const entryKey = (entry.key || `${normalizedParcelId}_${index}`).toString();
                entries.push({
                    key: entryKey,
                    parcelId: normalizedParcelId,
                    displayName: entry.displayName || `Owner ${index + 1}`,
                    shareText: entry.shareText || '',
                    accepted: !!entry.accepted,
                    acceptedByName: entry.acceptedByName || '',
                    acceptanceMeta: entry
                });
            });
        } catch (error) {
            console.warn('buildProposalOwnerAcceptanceSummary: failed to gather owners', error);
        }
    });

    // Total owners = sum of per-parcel owner slots (no metadata shortcuts)
    summary.totalOwners = entries.length;
    summary.entries = entries;
    summary.acceptedOwners = Math.min(entries.filter(entry => entry.accepted).length, summary.totalOwners);
    return summary;
}

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

// ── Effect-hash consent binding (rethink-proposals.md §11/§12 step 4) ────────────────────────────
// An acceptance binds to what the proposal DOES — footprint + per-parcel cession (the effect
// fingerprint from ownership-flow.js); a proposal with no effect has nothing to bind to, so it takes
// no local acceptance. The fingerprint derives from STORED fields only, so the hash is identical on
// every machine. An edit that changes the effect changes the hash and the stored
// acceptances stop counting — automatically, with the records preserved (consent history is
// immutable; an edit back to the accepted effect even revalidates them). Every counted record
// requires its current terms hash.
function currentProposalOwnerAcceptanceKeys(proposal, entry) {
    const hash = currentConsentBindingHash(proposal);
    const api = window.__ownershipFlow;
    return (entry?.acceptedOwnerKeys || []).filter(key => (entry.ownerOrder || []).includes(key)
        && entry.owners?.[key]?.placeholder !== true
        && api?.isAcceptanceRecordValid(entry.acceptedBy?.[key], hash) === true);
}

function currentConsentBindingHash(proposal) {
    try {
        const flowApi = (typeof window !== 'undefined') ? window.__ownershipFlow : null;
        return (flowApi && flowApi.effectFingerprintOf(proposal)) || null;
    } catch (error) {
        console.warn(`[${new Date().toISOString()}] [currentConsentBindingHash] no effect fingerprint for ${proposal && proposal.proposalId}`, error);
        return null;
    }
}

// The validity logic itself is pure and lives in ownership-flow.js (isAcceptanceRecordValid,
// refreshAcceptanceValidity); this wrapper supplies the current hash. Without the evaluator,
// no owner acceptance can count toward the parcel tally.
function refreshProposalAcceptanceValidity(proposal) {
    const flowApi = (typeof window !== 'undefined') ? window.__ownershipFlow : null;
    if (!proposal) return { lapsedOwners: 0 };
    if (!flowApi) {
        proposal.acceptedParcelIds = [];
        return { lapsedOwners: 0 };
    }
    const result = flowApi.refreshAcceptanceValidity(proposal, currentConsentBindingHash(proposal));
    if (result.lapsedOwners > 0) {
        console.debug('[refreshProposalAcceptanceValidity] acceptances lapsed against the current effect', {
            proposalId: proposal.proposalId, lapsedOwners: result.lapsedOwners
        });
    }
    return result;
}

async function acceptProposal(proposalId, parcelId, ownerKey, metadata = {}) {
    try {
        const suppressAlerts = metadata && metadata.suppressAlerts === true;
        const notifyAcceptIssue = (key, fallback) => {
            if (suppressAlerts) {
                console.debug('[acceptProposal] Suppressed user alert for automated acceptance', {
                    key,
                    proposalId,
                    parcelId,
                    ownerKey
                });
                return;
            }
            showProposalAlertMessage(key, fallback);
        };

        const proposal = proposalStorage.getProposal(proposalId);
        if (!proposal) {
            notifyAcceptIssue('proposal_not_found', 'Proposal not found.');
            return null;
        }
        if (getLifecycleStatus(proposal) === 'Unknown') {
            notifyAcceptIssue('proposal_lifecycle_unknown', 'The proposal status is unknown. Reload it before accepting.');
            return null;
        }
        const normalizedParcelId = normalizeParcelId(parcelId);
        if (!normalizedParcelId) {
            notifyAcceptIssue('invalid_parcel_identifier', 'Invalid parcel identifier.');
            return null;
        }

        const parcelIds = (proposal.cadastreParcelIds || []).map(id => normalizeParcelId(id));
        if (!parcelIds.includes(normalizedParcelId)) {
            notifyAcceptIssue('this_parcel_is_not_part_of_the_proposal', 'This parcel is not part of the proposal.');
            return null;
        }

        const consentHash = currentConsentBindingHash(proposal);
        if (!consentHash) {
            notifyAcceptIssue('proposal_terms_unavailable', 'The current proposal terms could not be verified. Reload the proposal before accepting.');
            return null;
        }
        refreshProposalAcceptanceValidity(proposal);
        proposal.acceptedParcelIds = normalizeParcelIdList(proposal.acceptedParcelIds || []);

        const ownerSlots = getOwnerSlotsForParcel(normalizedParcelId);
        const entry = ensureOwnerAcceptanceEntry(proposal, normalizedParcelId, ownerSlots);
        if (!entry?.ownerOrder.length) {
            notifyAcceptIssue('unable_to_determine_owner_shares_for_this_parcel', 'Unable to determine owner shares for this parcel.');
            return null;
        }

        const currentAcceptedKeys = currentProposalOwnerAcceptanceKeys(proposal, entry);
        let effectiveOwnerKey = ownerKey;
        if (!effectiveOwnerKey) {
            if (entry.ownerOrder.length === 1) {
                effectiveOwnerKey = entry.ownerOrder[0];
            } else if (suppressAlerts) {
                const firstUnacceptedOwnerKey = entry.ownerOrder.find(key => !currentAcceptedKeys.includes(key));
                effectiveOwnerKey = firstUnacceptedOwnerKey || null;
            } else {
                notifyAcceptIssue('select_which_owner_share_you_are_accepting_for', 'Select which owner share you are accepting for.');
                return null;
            }
        }

        if (!effectiveOwnerKey || !entry.ownerOrder.includes(effectiveOwnerKey)) {
            notifyAcceptIssue('unable_to_determine_which_owner_share_to_accept', 'Unable to determine which owner share to accept.');
            return null;
        }

        if (currentAcceptedKeys.includes(effectiveOwnerKey)) {
            notifyAcceptIssue('this_owner_has_already_accepted_the_proposal', 'This owner has already accepted the proposal.');
            return null;
        }

        if (entry.acceptedBy[effectiveOwnerKey]) {
            entry.acceptanceHistory = [...(entry.acceptanceHistory || []), {
                ownerKey: effectiveOwnerKey, ...entry.acceptedBy[effectiveOwnerKey]
            }];
        }
        if (!entry.acceptedOwnerKeys.includes(effectiveOwnerKey)) entry.acceptedOwnerKeys.push(effectiveOwnerKey);
        entry.acceptedBy[effectiveOwnerKey] = {
            agentId: metadata.acceptedByAgentId || null,
            username: metadata.acceptedByName || null,
            acceptedAt: new Date().toISOString(),
            // What this owner is consenting TO (§12 step 4): the proposal's effect as it stands
            // right now. If the effect later changes, this acceptance stops counting.
            effectHash: consentHash
        };

        proposal.ownerAcceptances[normalizedParcelId] = entry;

        const validKeys = currentProposalOwnerAcceptanceKeys(proposal, entry);
        const ownerOrder = entry.ownerOrder.length > 0 ? entry.ownerOrder : validKeys;
        const parcelFullyAccepted = ownerOrder.length > 0
            ? ownerOrder.every(key => validKeys.includes(key))
            : validKeys.length > 0;

        if (parcelFullyAccepted) {
            if (!proposal.acceptedParcelIds.includes(normalizedParcelId)) {
                proposal.acceptedParcelIds.push(normalizedParcelId);
            }
        } else {
            proposal.acceptedParcelIds = proposal.acceptedParcelIds.filter(id => id !== normalizedParcelId);
        }

        // Persist the same consent validity decision the UI uses, including other parcels.
        refreshProposalAcceptanceValidity(proposal);
        if (typeof proposalStorage._indexProposal === 'function') {
            proposalStorage._indexProposal(proposal);
        }
        proposalStorage.save();

        const parcelFeature = window.LiveParcelFabric?.get?.(normalizedParcelId)
            || window.CadastralParcelRepository?.get?.(normalizedParcelId)
            || null;
        const parcelNumber = parcelFeature?.properties?.BROJ_CESTICE || normalizedParcelId;

        // Recording consent does not execute the proposal, apply it to the map or transfer value.
        return {
            ownerAccepted: true,
            parcelAccepted: parcelFullyAccepted,
            parcelNumber
        };
    } catch (error) {
        console.error('Error accepting proposal:', error);
        showProposalAlertMessage('error_accepting_proposal_please_try_again', 'Error accepting proposal. Please try again.');
        return null;
    }
}

async function handleUserRejectProposal(proposalId, parcelId, ownerKey = null) {
    const userAgent = typeof getCurrentUserAgent === 'function' ? getCurrentUserAgent() : null;
    if (!userAgent) {
        showProposalAlertMessage('you_must_be_logged_in_to_undo_an_acceptance', 'You must be logged in to undo an acceptance.');
        return;
    }

    const proposal = proposalStorage.getProposal(proposalId);
    if (!proposal) {
        showProposalAlertMessage('proposal_not_found', 'Proposal not found.');
        return;
    }
    const acceptanceState = getProposalOwnerAcceptanceState(proposal, parcelId);
    if (!acceptanceState.entries.length) {
        showProposalAlertMessage('no_recorded_owner_acceptance_to_undo', 'No recorded owner acceptance to undo.');
        return;
    }

    let targetEntry = acceptanceState.entries.find(entry => entry.key === ownerKey);
    if (!targetEntry) {
        targetEntry = acceptanceState.entries.find(entry => entry.accepted && entry.acceptedByAgentId === userAgent.id);
    }

    if (!targetEntry) {
        showProposalAlertMessage('unable_to_determine_which_acceptance_to_undo', 'Unable to determine which acceptance to undo.');
        return;
    }

    if (targetEntry.acceptedByAgentId && targetEntry.acceptedByAgentId !== userAgent.id) {
        showProposalAlertMessage('only_the_user_who_recorded_this_acceptance_can_undo_it', 'Only the user who recorded this acceptance can undo it.');
        return;
    }

    // Check if this proposal is minted on-chain — if so, withdraw on-chain first
    const rejectNftInfo = typeof getProposalNftInfo === 'function' ? getProposalNftInfo(proposal) : null;
    const rejectBridge = window.ProposalChainBridge;
    const isOnChain = rejectNftInfo && rejectBridge && typeof rejectBridge.withdrawAcceptance === 'function';
    const normalizedParcelIdForChain = normalizeParcelId(parcelId);

    if (isOnChain && String(rejectNftInfo.chain || '').startsWith('solana')) {
        showProposalAlertMessage('solana_acceptance_final', 'Acceptances on Solana are final: a signed yes cannot be withdrawn.');
        return;
    }

    if (isOnChain) {
        // Map application is a local preview, not execution. The chain enforces withdrawal
        // eligibility; retain these lifecycle and conditional pre-checks independently of it.
        if (getLifecycleStatus(proposal) === 'Executed') {
            showProposalAlertMessage('cannot_withdraw_executed_proposal',
                'This acceptance cannot be withdrawn because the proposal has been executed.');
            return;
        }
        if (!proposal.isConditional) {
            showProposalAlertMessage('cannot_withdraw_non_conditional',
                'This acceptance cannot be withdrawn because the proposal is not conditional.');
            return;
        }
        try {
            if (typeof updateStatus === 'function') updateStatus(getProposalI18nHelper()('status.messages.withdrawing_acceptance_on_chain', 'Withdrawing acceptance on chain…'));
            await rejectBridge.withdrawAcceptance({
                proposalId: rejectNftInfo.tokenId,
                parcelId: normalizedParcelIdForChain,
                chainId: rejectNftInfo.chain,
                contractAddress: rejectNftInfo.contract
            });
        } catch (onchainErr) {
            console.warn('On-chain withdrawal failed:', onchainErr);
            showProposalAlertMessage('on_chain_withdrawal_failed', parseOnChainErrorMessage(onchainErr));
            return;
        }
    }

    // On-chain succeeded (or not on-chain) — now record locally
    const result = await rejectProposal(proposalId, parcelId, targetEntry.key);
    if (!result) {
        return;
    }

    if (isOnChain && typeof updateStatus === 'function') updateStatus(getProposalI18nHelper()('status.messages.acceptance_withdrawn_on_chain', 'Acceptance withdrawn on chain.'));

    const ownerLabel = targetEntry.shareText
        ? `${targetEntry.displayName} (${targetEntry.shareText})`
        : targetEntry.displayName;

    if (typeof addUserActionToGameLog === 'function') {
        // The agent's name runs script (the game log binds .agent-link-clickable), so it is a cb-link button.
        const agentLink = `<button type="button" data-agent-id="${userAgent.id}" class="cb-link agent-link-clickable">${userAgent.name}</button>`;
        addUserActionToGameLog(`${agentLink} revoked acceptance recorded for ${ownerLabel} on parcel ${parcelId}.`);
    }

    if (typeof updateStatus === 'function') updateStatus(`Revoked acceptance for ${ownerLabel} on parcel ${parcelId}.`);
}

async function rejectProposal(proposalId, parcelId, ownerKey = null) {
    try {
        const proposal = proposalStorage.getProposal(proposalId);
        if (!proposal) {
            showProposalAlertMessage('proposal_not_found', 'Proposal not found.');
            return null;
        }
        const normalizedParcelId = normalizeParcelId(parcelId);
        if (!normalizedParcelId) {
            showProposalAlertMessage('invalid_parcel_identifier', 'Invalid parcel identifier.');
            return null;
        }

        proposal.ownerAcceptances = normalizeOwnerAcceptances(proposal.ownerAcceptances || {});
        const entry = ensureOwnerAcceptanceEntry(proposal, normalizedParcelId, getOwnerSlotsForParcel(normalizedParcelId));
        if (!entry || !entry.acceptedOwnerKeys || entry.acceptedOwnerKeys.length === 0) {
            showProposalAlertMessage('this_parcel_has_not_accepted_the_proposal_yet', 'This parcel has not accepted the proposal yet.');
            return null;
        }

        let targetOwnerKey = ownerKey;
        if (!targetOwnerKey) {
            if (entry.acceptedOwnerKeys.length === 1) {
                targetOwnerKey = entry.acceptedOwnerKeys[0];
            } else {
                showProposalAlertMessage('please_specify_which_owner_acceptance_to_undo', 'Please specify which owner acceptance to undo.');
                return null;
            }
        }

        if (!entry.acceptedOwnerKeys.includes(targetOwnerKey)) {
            showProposalAlertMessage('this_owner_has_not_accepted_the_proposal_yet', 'This owner has not accepted the proposal yet.');
            return null;
        }

        entry.acceptedOwnerKeys = entry.acceptedOwnerKeys.filter(key => key !== targetOwnerKey);
        if (entry.acceptedBy && entry.acceptedBy[targetOwnerKey]) {
            delete entry.acceptedBy[targetOwnerKey];
        }
        proposal.ownerAcceptances[normalizedParcelId] = entry;

        const ownerOrder = entry.ownerOrder.length > 0 ? entry.ownerOrder : entry.acceptedOwnerKeys;
        const parcelFullyAccepted = ownerOrder.length > 0
            ? ownerOrder.every(key => entry.acceptedOwnerKeys.includes(key))
            : entry.acceptedOwnerKeys.length > 0;

        if (!parcelFullyAccepted) {
            proposal.acceptedParcelIds = normalizeParcelIdList((proposal.acceptedParcelIds || []).filter(id => id !== normalizedParcelId));
        }

        // Withdrawing a local acceptance changes consent only. Neither the recorded execution
        // lifecycle/time nor this browser's map application is reversed by that decision.

        if (typeof proposalStorage._indexProposal === 'function') {
            proposalStorage._indexProposal(proposal);
        }
        proposalStorage.save();

        setTimeout(() => {
            if (typeof applyProposalHighlights === 'function') {
                applyProposalHighlights();
            }
        }, 10);

        return { ownerKey: targetOwnerKey, parcelAccepted: parcelFullyAccepted };
    } catch (error) {
        console.error('Error rejecting proposal:', error);
        showProposalAlertMessage('error_rejecting_proposal_please_try_again', 'Error rejecting proposal. Please try again.');
        return null;
    }
}
