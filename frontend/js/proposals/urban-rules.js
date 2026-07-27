// proposals/urban-rules.js — extracted from proposals.js (behavior-preserving relocation).

function handleUrbanRuleMainTypeClick() {
    setProposalMainType('Urban Rule');
    setProposalType('Urban Rule');
    updateProposalDescription('Urban Rule', true);
    resetUrbanRuleTypologySelection();
    // Contiguity check is already done when modal opens, but re-apply when switching to Urban Rule
    applyContiguityConstraints();
}

function applyContiguityConstraints() {
    const selection = getCurrentParcelSelectionContext();
    const contiguity = (typeof areParcelsContiguous === 'function') ? areParcelsContiguous(selection.layers) : { contiguous: true };
    const isContiguous = contiguity.contiguous;

    const disabledMessage = (typeof t === 'function')
        ? t('proposals.contiguityDisabledReason', 'Disabled because the parcels in the proposal are not contiguous')
        : 'Disabled because the parcels in the proposal are not contiguous';

    // Urban Rule typology buttons (Block and Row)
    const blockButton = document.querySelector('.proposal-typology-button[data-proposal-typology="block"]');
    const rowButton = document.querySelector('.proposal-typology-button[data-proposal-typology="row"]');

    // Land-use radios that need contiguous parcels (Park, Square, Lake)
    const parkButton = document.querySelector('input[name="proposalLandUse"][value="park"]');
    const squareButton = document.querySelector('input[name="proposalLandUse"][value="square"]');
    const lakeButton = document.querySelector('input[name="proposalLandUse"][value="lake"]');

    const buttonsRequiringContiguity = [blockButton, rowButton, parkButton, squareButton, lakeButton];

    buttonsRequiringContiguity.forEach(btn => {
        if (!btn) return;
        if (!isContiguous) {
            btn.setAttribute('disabled', 'disabled');
            btn.setAttribute('data-contiguity-disabled', 'true');
            btn.title = disabledMessage;
        } else {
            // Only re-enable if it was disabled due to contiguity (not for other reasons)
            if (btn.getAttribute('data-contiguity-disabled') === 'true') {
                btn.removeAttribute('disabled');
                btn.removeAttribute('data-contiguity-disabled');
                btn.title = '';
            }
        }
    });
}

function resetUrbanRuleTypologySelection() {
    const buttons = document.querySelectorAll('.proposal-typology-button');
    buttons.forEach(btn => btn.classList.remove('selected'));
}

function handleUrbanRuleTypologyClick(typologyKey = 'block', options = {}) {
    const { skipLaunch = false } = options;
    setProposalMainType('Urban Rule');

    const buttons = document.querySelectorAll('.proposal-typology-button');
    let targetButton = null;
    buttons.forEach(btn => {
        const btnTypology = btn.getAttribute('data-proposal-typology');
        const isTarget = btnTypology === typologyKey;
        if (isTarget) {
            targetButton = btn;
            btn.classList.add('selected');
        } else {
            btn.classList.remove('selected');
        }
    });

    if (!targetButton) return false;
    // Allow 'block', 'row', and 'parcelBased' typologies
    const supportedTypologies = ['block', 'row', 'parcelBased'];
    if (targetButton.disabled || !supportedTypologies.includes(typologyKey)) {
        targetButton.classList.remove('selected');
        return false;
    }

    if (!skipLaunch) {
        setProposalType('Residences');
    }

    if (skipLaunch) {
        return true;
    }

    if (typologyKey === 'row') {
        // Row typology uses the row house flow
        currentProposalTool = 'row';
        return launchRowHouseToolForSelection();
    } else if (typologyKey === 'parcelBased') {
        // Parcel-based typology generates individual buildings per parcel
        currentProposalTool = 'parcelBased';
        return launchParcelBasedToolForSelection();
    } else {
        // Block typology uses the buildings/urban rule flow
        currentProposalTool = 'buildings';
        return launchUrbanRuleToolForSelection();
    }
}

function normalizeProposalGoalKey(rawGoal) {
    if (rawGoal === undefined || rawGoal === null) return '';
    const text = String(rawGoal).trim().toLowerCase();
    if (!text) return '';
    const dashed = text.replace(/\s+/g, '-');

    // Canonical mappings (human labels -> goal keys)
    if (text === 'road/track' || text === 'road' || text === 'track') return 'road-track';
    if (text === 'decide later' || text === 'decide-later') return 'decide-later';
    if (text === 'building(s)' || text === 'single building' || text === 'single') return 'single';
    if (text === 'buildings' || text === 'residences') return 'buildings';

    // Normalize separators (e.g. road/track -> road-track)
    const key = dashed.replace(/\//g, '-');

    if (key === 'road-track') return 'road-track';
    if (key === 'decide-later') return 'decide-later';
    if (key === 'reparcellization') return 'reparcellization';
    if (key === 'park' || key === 'square' || key === 'lake' || key === 'station' || key === 'transit-station') {
        return key === 'transit-station' ? 'station' : key;
    }
    if (key === 'buildings') return 'buildings';
    if (key === 'single') return 'single';
    if (key === 'row') return 'row';
    if (key === 'parcelbased' || key === 'parcel-based') return 'parcelBased';
    if (key === 'urban-rule') return 'urban-rule';
    if (key === 'parcel') return 'parcel';

    return key;
}

function resolveProposalGoalKey(proposal, fallbackProposal) {
    const subject = proposal || fallbackProposal || {};
    const raw = subject.goal !== undefined && subject.goal !== null
        ? subject.goal
        : (fallbackProposal && fallbackProposal.goal !== undefined && fallbackProposal.goal !== null ? fallbackProposal.goal : null);
    return normalizeProposalGoalKey(raw);
}

function getSelectedProposalTool() {
    return currentProposalTool;
}

function openUrbanRuleGeometry() {
    const selectedBtn = document.querySelector('.proposal-typology-button.selected');
    const selectedKey = selectedBtn ? selectedBtn.getAttribute('data-proposal-typology') : null;

    // Prefer selected typology when enabled; otherwise fall back to the first enabled typology.
    let typologyKey = null;
    if (selectedBtn && !selectedBtn.disabled && selectedKey) {
        typologyKey = selectedKey;
    } else {
        const firstEnabledBtn = Array.from(document.querySelectorAll('.proposal-typology-button'))
            .find(btn => !btn.disabled && btn.getAttribute('data-proposal-typology'));
        typologyKey = firstEnabledBtn
            ? firstEnabledBtn.getAttribute('data-proposal-typology')
            : (selectedKey || 'block');
    }

    handleUrbanRuleTypologyClick(typologyKey || 'block');
}

function setProposalAcquisitionMode(mode = 'full', options = {}) {
    const normalized = mode === 'partial-preferred' ? 'partial' : (mode || 'full');
    document.querySelectorAll('input[name="proposalAcquisition"]').forEach(radio => {
        radio.checked = (radio.value === normalized);
    });
    const input = document.getElementById('proposalAcquisitionMode');
    if (input) {
        input.value = mode || 'full';
    }
}

function setProposalBoundaryMode(mode = 'multiple', options = {}) {
    const normalized = mode || 'multiple';
    const lockSelection = options.lock === true;
    const unlockSelection = options.unlock === true;
    const buttons = document.querySelectorAll('.proposal-boundary-button');
    buttons.forEach(btn => {
        const btnMode = btn.getAttribute('data-boundary-mode');
        const isSelected = btnMode === normalized;
        if (isSelected) {
            btn.classList.add('selected');
        } else {
            btn.classList.remove('selected');
        }
        if (lockSelection) {
            btn.disabled = true;
            btn.setAttribute('aria-disabled', 'true');
        } else if (unlockSelection) {
            btn.disabled = false;
            btn.removeAttribute('aria-disabled');
        }
    });
    const input = document.getElementById('proposalBoundaryMode');
    if (input) {
        input.value = normalized;
        if (lockSelection) {
            input.setAttribute('data-ownership-locked', 'true');
        } else if (unlockSelection) {
            input.removeAttribute('data-ownership-locked');
        }
    }
    currentOwnershipMode = normalized;
}

function updateGoalDependentSections(toolKey) {
    const acquisitionGroup = document.getElementById('proposalAcquisitionGroup');
    const typologyGroup = document.getElementById('proposalTypologyGroup');
    const boundaryGroup = document.getElementById('proposalBoundaryGroup');
    const ownershipTransferGroup = document.getElementById('proposalOwnershipTransferGroup');
    const partialButton = document.querySelector('.proposal-acquisition-partial-label');

    const isUrbanRule = toolKey === 'urban-rule';
    const isReparcellization = toolKey === 'reparcellization';
    const isRoad = toolKey === 'road-track';
    const isOwnershipTransfer = toolKey === 'ownership-transfer';

    if (acquisitionGroup) {
        // Acquisition strategy is derived from the goal and locked (non-selectable).
        // Only road/track carries a meaningful value (partial-preferred); for every
        // other goal it's always "full", so hide the section as it offers no choice.
        acquisitionGroup.style.display = isRoad ? '' : 'none';
    }
    if (typologyGroup) {
        typologyGroup.style.display = isUrbanRule ? '' : 'none';
    }
    if (boundaryGroup) {
        boundaryGroup.style.display = isReparcellization ? '' : 'none';
    }
    if (ownershipTransferGroup) {
        // Replaced by the persistent Ownership radio group. The legacy direction
        // buttons stay in the DOM (still driven by setOwnershipTransferDirection for
        // the to-me mechanic) but are kept hidden.
        ownershipTransferGroup.style.display = 'none';
    }

    if (partialButton) {
        partialButton.textContent = isRoad ? proposalAcquisitionLabels.partialPreferred : proposalAcquisitionLabels.partial;
    }

    if (isUrbanRule) {
        setProposalMainType('Urban Rule');
        handleUrbanRuleTypologyClick('block', { skipLaunch: true });
    } else if (isReparcellization) {
        setProposalMainType('Reparcellization', { skipReparcelLaunch: true });
        const selection = getCurrentParcelSelectionContext();
        const ownershipStats = computeOwnershipStatsFromSelection(selection);
        setProposalBoundaryMode(ownershipStats.mode, { lock: true });
    } else if (isOwnershipTransfer) {
        setProposalMainType('Purchase');
        // Reset to default 'to-me' direction when ownership-transfer is selected
        setOwnershipTransferDirection('to-me');
    } else {
        setProposalMainType('Purchase');
        const acquisitionMode = isRoad ? 'partial-preferred' : 'full';
        setProposalAcquisitionMode(acquisitionMode);
        setProposalBoundaryMode('multiple', { unlock: true });
        // Reset options when switching away from ownership transfer
        resetOwnershipTransferOptions();
    }

    renderGeometrySection(toolKey);
}

function applyFacetLockUI(groupId, staticId, name, mode, lock, reason) {
    const group = document.getElementById(groupId);
    const staticEl = document.getElementById(staticId);
    document.querySelectorAll(`input[name="${name}"]`).forEach(r => {
        r.checked = (r.value === mode);
        r.disabled = false; // locked facets are hidden, not disabled
    });
    if (lock) {
        if (group) group.style.display = 'none';
        if (staticEl) {
            staticEl.style.display = '';
            staticEl.innerHTML = `<span class="lock-ico">🔒</span>${facetModeLabel(name, mode)}${reason ? ` · ${reason}` : ''}`;
        }
    } else {
        if (group) group.style.display = '';
        if (staticEl) staticEl.style.display = 'none';
    }
}

function setProposalLandUseMode(key) {
    proposalFacetState.landUse = key;
    document.querySelectorAll('input[name="proposalLandUse"]').forEach(r => { r.checked = (r.value === key); });
}

async function selectFreshProposalLandUse(key, options = {}) {
    // Park/square/lake have no separate geometry editor, so their user-triggered land-use choice
    // is the creation boundary where the shared whole-block offer belongs.
    if (['park', 'square', 'lake'].includes(key)
        && typeof shouldStopFreshProposalForWholeBlock === 'function'
        && await shouldStopFreshProposalForWholeBlock(key)) {
        return false;
    }
    selectLandUse(key, options);
    return true;
}

function onProposalLandUseChange() {
    const sel = document.querySelector('input[name="proposalLandUse"]:checked');
    return selectFreshProposalLandUse(sel ? sel.value : 'as-is');
}

function selectLandUse(key, { skipChecks = false } = {}) {
    if (key === 'decide-later') {
        console.warn('[proposals] Merge / Decide Later is no longer a creatable goal.');
        return false;
    }
    if (!skipChecks && key === 'lake') {
        const selection = getCurrentParcelSelectionContext();
        const contiguity = (typeof areParcelsContiguous === 'function') ? areParcelsContiguous(selection.layers) : { contiguous: true };
        if (!contiguity.contiguous) {
            if (typeof showProposalAlertMessage === 'function') showProposalAlertMessage('parcels_not_contiguous', 'Parcels not contiguous');
            return;
        }
    }
    setProposalLandUseMode(key);
    showProposalPerSliceOption(false);
    const luLabel = facetModeLabel('proposalLandUse', key);
    if (key === 'urban-rule') {
        setProposalParcelsMode('as-is', { lock: true, reason: luLabel });   // a rule doesn't change parcels
        setProposalOwnershipMode('no-change', { lock: true, reason: luLabel }); // or transfer ownership
    } else if (PROPOSAL_PUBLIC_GOOD_USES.has(key)) {
        // Public goods can span several selected parcels without changing cadastral boundaries.
        setProposalParcelsMode('as-is', { lock: true, reason: luLabel });
        setProposalOwnershipMode('to-city');               // default (overridable)
    } else if (key === 'single') {
        // Build on the parcels as they are: like Urban Rule, Building(s) neither merges
        // nor subdivides, so lock Parcels to No change. Ownership defaults to the proposer
        // but stays editable.
        setProposalParcelsMode('as-is', { lock: true, reason: luLabel });
        setProposalOwnershipMode('to-me', { unlock: true });
    } else { // 'as-is'
        setProposalParcelsMode('as-is', { unlock: true });
        setProposalOwnershipMode('no-change', { unlock: true });
    }
    syncProposalFacets();
}

function syncProposalFacets() {
    // Reflect the land-use selection on the radios.
    document.querySelectorAll('input[name="proposalLandUse"]').forEach(r => {
        r.checked = (r.value === proposalFacetState.landUse);
    });

    const recipientScopeSel = document.querySelector('input[name="proposalRecipientScope"]:checked');
    window.proposalFacets = {
        landUse: proposalFacetState.landUse,
        parcels: proposalFacetState.parcels,
        ownership: proposalFacetState.ownership,
        recipientScope: recipientScopeSel ? recipientScopeSel.value : 'any',
        recipientAddress: getProposalRecipientAddress()
    };

    const goalKey = deriveProposalGoalKey();
    if (!goalKey) {
        currentProposalTool = null;
        const typeInput = document.getElementById('proposalType');
        if (typeInput) typeInput.value = '';
        // Close every conditional/inset section (typology, acquisition, geometry) so
        // none is left hanging after switching to the do-nothing state.
        updateGoalDependentSections(null);
        relocateProposalGeometryGroup(null);
        updateProposalScreenshotGoalIcon('as-is');
        const btn = document.getElementById('createProposalSubmitButton');
        const hint = document.getElementById('proposalGeometryRequirementHint');
        if (btn) btn.disabled = true;
        if (hint) hint.textContent = 'Choose a land use, parcel change, or ownership change.';
        return;
    }

    if (goalKey === 'ownership-transfer') {
        updateGoalDependentSections('ownership-transfer');
        // Third party + Anyone = an open offer to sell → the from-me (accepted, unfunded,
        // awaiting a buyer) mechanic. Everything else is an incoming/directed transfer.
        const sell = (proposalFacetState.ownership === 'third-party'
            && (window.proposalFacets && window.proposalFacets.recipientScope) === 'any');
        setOwnershipTransferDirection(sell ? 'from-me' : 'to-me');
        updateProposalNameAndDescription(ownershipNameType(), true); // recipient-aware title
        relocateProposalGeometryGroup(null); // ownership transfer has no geometry
    } else {
        currentProposalTool = goalKey;
        const typeLabel = PROPOSAL_GOAL_TYPE_LABELS[goalKey] || goalKey;
        const typeInput = document.getElementById('proposalType');
        if (typeInput) typeInput.value = typeLabel;
        updateGoalDependentSections(goalKey); // main type + geometry + typology/boundary visibility
        relocateProposalGeometryGroup(goalKey); // move geometry inline next to its section
        updateProposalNameAndDescription(typeLabel, true);
    }
    updateProposalScreenshotGoalIcon(currentProposalTool || goalKey);
    updateCreateProposalSubmitState();
}

function initProposalFacets(overrideGoal) {
    setProposalLandUseMode('as-is');
    setProposalParcelsMode('as-is', { unlock: true });
    setProposalOwnershipMode('no-change', { unlock: true });
    showProposalPerSliceOption(false);

    const g = overrideGoal ? (typeof normalizeGoalKey === 'function' ? normalizeGoalKey(overrideGoal) : overrideGoal) : null;
    if (!g || g === 'as-is') { syncProposalFacets(); return; }
    if (g === 'decide-later') { syncProposalFacets(); return; }
    if (g === 'reparcellization') { setProposalParcelsMode('readjust'); onProposalParcelsChange(); return; }
    if (g === 'ownership-transfer' || g === 'ownership-transfer-to-me' || g === 'ownership-transfer-from-me') {
        setProposalOwnershipMode('to-me'); onProposalOwnershipChange(); return;
    }
    selectLandUse(g); // a land use
}

function setProposalType(type) {
    const effectiveType = type || DEFAULT_PROPOSAL_TYPE;
    const input = document.getElementById('proposalType');
    if (input) {
        input.value = effectiveType;
    }
    // Support both old .proposal-tool-button and new .proposal-type-button classes
    const buttons = document.querySelectorAll('.proposal-tool-button, .proposal-type-button[data-proposal-tool]');
    let resolvedTool = null;
    buttons.forEach(btn => {
        const btnType = btn.getAttribute('data-proposal-type');
        if (btnType === effectiveType) {
            btn.classList.add('selected');
            resolvedTool = btn.getAttribute('data-proposal-tool') || null;
        } else {
            btn.classList.remove('selected');
        }
    });
    // Only adopt a tool actually resolved from the (legacy) type buttons. The facets-based dialog
    // has no such buttons, so resolvedTool is null there — in that case keep the tool the caller
    // already set (e.g. setProposalMainType('Reparcellization') before setProposalType in the
    // reparcellization "Done" path). Clobbering it to null nulled the goal and blocked Create with
    // "Select a proposal goal before creating a proposal."
    if (resolvedTool) {
        currentProposalTool = resolvedTool;
    }

    updateProposalScreenshotGoalIcon(currentProposalTool || effectiveType);

    // Update description with default text if empty
    updateProposalDescription(effectiveType);
}

function setProposalMainType(type, options = {}) {
    const skipReparcelLaunch = options.skipReparcelLaunch === true;
    const buttons = document.querySelectorAll('.proposal-type-button[data-proposal-main-type]');
    buttons.forEach(btn => {
        const btnType = btn.getAttribute('data-proposal-main-type');
        if (btnType === type) {
            btn.classList.add('selected');
        } else {
            btn.classList.remove('selected');
        }
    });

    const input = document.getElementById('proposalMainType');
    if (input) {
        input.value = type || 'Purchase';
    }

    const algorithmGroup = document.getElementById('reparcellizationAlgorithmGroup');
    if (algorithmGroup) {
        algorithmGroup.style.display = 'none';
    }

    const isReparcellization = type === 'Reparcellization';
    const isUrbanRule = type === 'Urban Rule';

    if (isReparcellization) {
        currentProposalTool = 'reparcellization';
        const typeInput = document.getElementById('proposalType');
        if (typeInput) {
            typeInput.value = 'Reparcellization';
        }
        if (!skipReparcelLaunch) {
            handleReparcellizationAlgorithmClick('sweep-line');
        }
    } else if (isUrbanRule) {
        currentProposalTool = 'urban-rule';
        setProposalType('Urban Rule');
    } else {
        if (currentProposalTool === 'buildings') {
            currentProposalTool = null;
        }
        if (!currentProposalTool) {
            setProposalType(DEFAULT_PROPOSAL_TYPE);
        }
    }
}

async function launchUrbanRuleToolForSelection() {
    const selection = getCurrentParcelSelectionContext();
    if (!selection.layers.length) {
        updateStatus('Select parcels before launching the urban rule tool.');
        return false;
    }
    if (typeof shouldStopFreshProposalForWholeBlock === 'function'
        && await shouldStopFreshProposalForWholeBlock('urban-rule', selection)) return false;
    if (typeof openUrbanRuleForParcels !== 'function' && typeof openBlockifyForParcels !== 'function') {
        updateStatus('Urban rule generator is unavailable.');
        return false;
    }
    const opener = (typeof openUrbanRuleForParcels === 'function') ? openUrbanRuleForParcels : openBlockifyForParcels;
    // Reopen on the existing design (a copied proposal, or your own in-progress edits) rather than
    // resetting to the defaults. The saved parameters carry mode/gaps/wings/manual outline too.
    const seed = (typeof getPendingBuildingSeedFor === 'function') ? getPendingBuildingSeedFor(selection.ids) : null;
    opener({
        blockName: formatParcelSelectionLabel(selection.ids),
        parcels: selection.layers,
        initialState: (seed && typeof buildBlockifySeed === 'function') ? buildBlockifySeed(seed) : null
    });
    return true;
}

function handleProposalToolButton(toolKey) {
    // The Land-use buttons call selectLandUse() directly. This remains as the entry
    // point for external geometry tools (single-building, urban-rule, structures) that
    // set the proposal goal programmatically — route every goal through the facet model
    // so the three persistent sections (Land use / Parcels / Ownership) stay in sync.
    const key = (typeof normalizeGoalKey === 'function' ? (normalizeGoalKey(toolKey) || toolKey) : toolKey);
    if (key === 'decide-later') return false;
    if (key === 'reparcellization') { setProposalParcelsMode('readjust'); onProposalParcelsChange(); return; }
    if (key === 'ownership-transfer' || key === 'ownership-transfer-to-me' || key === 'ownership-transfer-from-me') {
        setProposalOwnershipMode('to-me'); onProposalOwnershipChange(); return;
    }
    return selectFreshProposalLandUse(key, { skipChecks: true }); // land use (square/park/lake/single/road-track/urban-rule)
}

function resolveStructureProposal(proposal, options = {}) {
    if (!proposal) return null;
    if (proposal.structureProposal && typeof proposal.structureProposal === 'object') {
        return proposal.structureProposal;
    }

    const fallbackToStorage = options && Object.prototype.hasOwnProperty.call(options, 'fallbackToStorage')
        ? options.fallbackToStorage !== false
        : true;
    if (!fallbackToStorage) {
        return null;
    }

    if (!proposal.proposalId || typeof proposalStorage === 'undefined' || typeof proposalStorage.getProposal !== 'function') {
        return null;
    }

    try {
        const stored = proposalStorage.getProposal(proposal.proposalId);
        if (stored && stored.structureProposal && typeof stored.structureProposal === 'object') {
            return stored.structureProposal;
        }
    } catch (_) { }
    return null;
}
