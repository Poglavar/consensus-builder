// proposals/list-ui.js — extracted from proposals.js (behavior-preserving relocation).

function applyLensPatternToButton(button, entries) {
    const normalized = normalizeLensEntries(entries || []).filter(e => e && e.address);
    if (!normalized.length || typeof getLensPatternDataUrl !== 'function') return;
    try {
        const url = getLensPatternDataUrl(normalized);
        if (url) {
            button.style.backgroundImage = `url("${url}")`;
            button.style.backgroundSize = 'cover';
            button.style.backgroundRepeat = 'no-repeat';
            button.style.backgroundPosition = 'center';
        }
    } catch (err) {
        console.warn('applyLensPatternToButton failed', err);
    }
}

async function ensureProposalListTranslations(lang) {
    const api = (typeof window !== 'undefined') ? window.i18n : null;
    if (!api || typeof api.registerTranslations !== 'function') return false;
    const targetLang = lang || (typeof api.getLanguage === 'function' ? api.getLanguage() : 'en');
    if (proposalListTranslationsHydrated.has(targetLang)) return false;
    const cacheBust = (typeof window !== 'undefined' && typeof window.getCacheBustToken === 'function')
        ? window.getCacheBustToken()
        : ((typeof window !== 'undefined' && Array.isArray(window.APP_VERSIONS) && window.APP_VERSIONS.length > 0)
            ? window.APP_VERSIONS[0].version_number
            : Date.now());
    try {
        const response = await fetch(`i18n/${targetLang}.json?proposalListHydrate=${cacheBust}`, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`Failed to load i18n/${targetLang}.json: ${response.status}`);
        const json = await response.json();
        const flat = flattenObject(json);
        // Only register the proposal list subtree to avoid clobbering other runtime translations
        const subset = {};
        const prefix = 'modal.roadWidth.proposalList.';
        Object.entries(flat).forEach(([k, v]) => {
            if (k.startsWith(prefix)) {
                subset[k] = v;
            }
        });
        if (Object.keys(subset).length > 0) {
            api.registerTranslations(targetLang, subset);
            proposalListTranslationsHydrated.add(targetLang);
            if (typeof api.applyTranslations === 'function') {
                api.applyTranslations();
            }
            return true;
        }
    } catch (err) {
        console.warn('[i18n] Failed to hydrate proposal list translations', err);
    }
    return false;
}

function syncMultiSelectCheckboxes(isChecked) {
    const checkboxIds = ['multiSelectCheckbox', 'multiSelectCheckboxInfo'];
    checkboxIds.forEach(id => {
        const checkbox = document.getElementById(id);
        if (checkbox) {
            checkbox.checked = !!isChecked;
        }
    });
}

function collapseSidebarIfOpen() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar || sidebar.classList.contains('collapsed')) return;
    if (typeof toggleSidebar === 'function') {
        try { toggleSidebar(); } catch (_) { }
    }
}

function handleDescendantItemHover(element) {
    if (!element) return;
    const type = element.getAttribute('data-descendant-type');
    if (type === 'proposal') {
        const proposalId = element.getAttribute('data-proposal-id');
        if (proposalId) {
            highlightProposalHoverById(proposalId, {
                color: '#4DB6AC',
                weight: 4,
                dashArray: '4 4',
                showLabels: true,
                includeParents: false
            });
        }
    } else if (type === 'parcel') {
        const parcelId = element.getAttribute('data-parcel-id');
        if (parcelId) {
            highlightParcelHover(parcelId, {
                color: '#FFEB3B',
                weight: 6,
                dashArray: '10 8',
                showLabels: true
            });
        }
    }
}

function handleDescendantItemClick(element) {
    if (!element) return;
    clearProposalHoverLayers();

    const type = element.getAttribute('data-descendant-type');
    if (type === 'proposal') {
        const proposalIdAttr = element.getAttribute('data-proposal-id');
        if (!proposalIdAttr) return;
        const descendantProposal = getProposalByIdOrHash(proposalIdAttr);
        if (!descendantProposal) return;
        const parentIds = Array.isArray(descendantProposal.parentParcelIds) ? descendantProposal.parentParcelIds : [];
        const fallbackParcel = parentIds[0] || null;
        selectAndHighlightProposal(getProposalKey(descendantProposal) || proposalIdAttr, fallbackParcel, true);
    } else if (type === 'parcel') {
        const parcelId = element.getAttribute('data-parcel-id');
        if (!parcelId) return;
        focusParcelInMap(parcelId);
        highlightParcelHover(parcelId, {
            color: '#FFEB3B',
            weight: 6,
            dashArray: '10 8',
            showLabels: true
        });
    }
}

function handleAncestorItemHover(element) {
    if (!element) return;
    const proposalId = element.getAttribute('data-proposal-id');
    if (!proposalId) return;
    highlightProposalHoverById(proposalId, {
        color: '#FFB74D',
        weight: 4,
        dashArray: '6 3',
        showLabels: true,
        includeParents: false
    });
}

function handleAncestorItemClick(element) {
    if (!element) return;
    clearProposalHoverLayers();

    const proposalIdAttr = element.getAttribute('data-proposal-id');
    if (!proposalIdAttr) return;
    const ancestorProposal = getProposalByIdOrHash(proposalIdAttr);
    if (!ancestorProposal) return;
    const parentIds = Array.isArray(ancestorProposal.parentParcelIds) ? ancestorProposal.parentParcelIds : [];
    const fallbackParcel = parentIds[0] || null;
    selectAndHighlightProposal(getProposalKey(ancestorProposal) || proposalIdAttr, fallbackParcel, true);
}

function handleProposalParcelClick(parcelId, event) {
    // Handle case where event is not provided (legacy call)
    if (!event) {
        // Clear any currently selected single parcel to avoid conflicts
        if (typeof multiParcelSelection !== 'undefined' && typeof multiParcelSelection.clearSingleParcelSelection === 'function') {
            multiParcelSelection.clearSingleParcelSelection();
        }

        let proposals = proposalStorage.getProposalsForParcel(parcelId).filter(p => getLifecycleStatus(p) !== 'Executed');
        if (proposals.length === 0) {
            proposals = proposalStorage.getProposalsForParcel(parcelId).filter(p => getLifecycleStatus(p) !== 'Executed');
        }

        if (proposals.length === 1) {
            const proposal = proposals[0];
            selectAndHighlightProposal(getProposalKey(proposal), parcelId, true);
        } else if (proposals.length > 1) {
            // With multiple proposals just pick the first one for now; the old chooser modal was unused
            const proposal = proposals[0];
            selectAndHighlightProposal(getProposalKey(proposal), parcelId, true);
        }
        return;
    }

    // Handle event-based call (from proposal details modal)
    let node = event.target || event.srcElement || null;
    if (node && node.nodeType === Node.TEXT_NODE) {
        node = node.parentElement;
    }

    let hasOwnerAcceptanceTarget = false;
    while (node && node !== event.currentTarget) {
        if (node.classList && (
            node.classList.contains('owner-acceptance-row') ||
            node.classList.contains('owner-acceptance-list') ||
            node.classList.contains('owner-actions') ||
            node.classList.contains('owner-share') ||
            node.classList.contains('owner-identity') ||
            node.classList.contains('parcel-owner-acceptance')
        )) {
            hasOwnerAcceptanceTarget = true;
            break;
        }
        node = node.parentElement;
    }

    if (hasOwnerAcceptanceTarget) {
        event.stopPropagation();
        event.preventDefault();
        return false;
    }

    event.stopPropagation();
    event.preventDefault();

    // Check if this is a removed ancestor parcel
    const parcelItem = event.currentTarget;
    const isRemoved = parcelItem && parcelItem.getAttribute('data-parcel-removed') === 'true';

    if (isRemoved) {
        // Focus on the location where the parcel was, but don't try to select it
        focusOnRemovedParcelLocation(parcelId, parcelItem);
        return false;
    }

    returnToParcelInfo(parcelId, event);
    return false;
}

function setProposalCreateButtonState(isCreating) {
    const modal = document.querySelector('.create-proposal-modal');
    if (!modal) return;
    const createButton = document.getElementById('createProposalSubmitButton')
        || modal.querySelector('.proposal-actions-block .btn-proposal')
        || modal.querySelector('.proposal-modal-footer .btn-proposal');
    if (!createButton) return;
    const t = getProposalI18nHelper();
    const creatingLabel = t('modal.createProposal.creating', 'Creating...');
    const submitLabel = t('modal.createProposal.submit', 'Create Proposal');

    if (isCreating) {
        if (!createButton.dataset.originalText) {
            createButton.dataset.originalText = createButton.textContent || submitLabel;
        }
        createButton.textContent = creatingLabel;
        createButton.disabled = true;
        createButton.classList.add('is-creating');
    } else {
        const originalText = createButton.dataset.originalText || submitLabel;
        createButton.textContent = originalText;
        createButton.disabled = false;
        createButton.classList.remove('is-creating');
        delete createButton.dataset.originalText;
    }
}

function getCurrentParcelSelectionContext() {
    const context = { layers: [], ids: [] };
    try {
        if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection && multiParcelSelection.selectedParcels && multiParcelSelection.selectedParcels.size > 0) {
            context.ids = Array.from(multiParcelSelection.selectedParcels).map(id => id.toString());
            if (typeof multiParcelSelection.getSelectedParcels === 'function') {
                context.layers = (multiParcelSelection.getSelectedParcels() || []).filter(Boolean);
            } else if (typeof multiParcelSelection.findParcelById === 'function') {
                context.layers = context.ids.map(id => multiParcelSelection.findParcelById(id)).filter(Boolean);
            }
        } else if (typeof selectedParcelId !== 'undefined' && selectedParcelId && currentParcel && currentParcel.layer) {
            context.ids = [selectedParcelId.toString()];
            context.layers = [currentParcel.layer];
        }
    } catch (e) {
        console.warn('Failed to resolve parcel selection context', e);
    }
    return context;
}

// Shared classic-dialog boundary for fresh parcel-based proposals. The parcel panel owns the
// block detection/prompt implementation; classic launchers only supply their goal and selection.
async function shouldStopFreshProposalForWholeBlock(goal, selectionOverride = null) {
    const selection = selectionOverride || getCurrentParcelSelectionContext();
    if (!selection || !Array.isArray(selection.ids)) return false;
    // Copies/replacements already carry an intentional parcel scope, and instant-build drafts ran
    // this gate before their editor opened. Never ask again while publishing or editing one.
    if (window.pendingProposalCopySource?.proposalId
        || window.pendingProposalReplacementSource?.proposalId
        || window.pendingProposalDraftId) return false;
    if (typeof window.maybeSuggestWholeBlockForFreshProposal !== 'function') return false;
    try {
        const stopped = await window.maybeSuggestWholeBlockForFreshProposal(goal, selection.ids);
        if (stopped && typeof closeProposalDialog === 'function') closeProposalDialog();
        return stopped;
    } catch (error) {
        console.warn(`[${goal || 'proposal'}] whole-block suggestion failed`, error);
        return false;
    }
}

function formatParcelSelectionLabel(parcelIds = []) {
    if (!parcelIds || parcelIds.length === 0) return 'Selected Parcels';
    if (parcelIds.length === 1) {
        return `Parcel ${parcelIds[0]}`;
    }
    return `${parcelIds.length} Parcels`;
}

async function launchStructureToolForSelection(kind) {
    const selection = getCurrentParcelSelectionContext();
    if (!selection.layers.length) {
        updateStatus('Select parcels before launching the structure tool.');
        return false;
    }
    if (await shouldStopFreshProposalForWholeBlock(kind, selection)) return false;
    if (kind === 'lake') {
        const contiguity = (typeof areParcelsContiguous === 'function') ? areParcelsContiguous(selection.layers) : { contiguous: true };
        if (!contiguity.contiguous) {
            if (typeof showProposalAlertMessage === 'function') {
                showProposalAlertMessage('parcels_not_contiguous', 'Parcels not contiguous');
            } else if (typeof alert === 'function') {
                alert('Parcels not contiguous');
            }
            return false;
        }
    }
    const geometry = buildGeometryFromParcels(selection.layers);
    if (!geometry) {
        updateStatus('Could not build geometry for the selected parcels.');
        return false;
    }
    if (typeof showStructureProposalDialog !== 'function') {
        updateStatus('Structure proposal dialog is unavailable.');
        return false;
    }
    closeProposalDialog();
    showStructureProposalDialog({
        kind,
        parcelIds: selection.ids,
        geometry,
        blockName: formatParcelSelectionLabel(selection.ids)
    });
    return true;
}

async function launchSingleBuildingToolForSelection() {
    const selection = getCurrentParcelSelectionContext();
    if (!selection.layers.length) {
        updateStatus('Select parcels before launching the single building tool.');
        return false;
    }
    if (await shouldStopFreshProposalForWholeBlock('single', selection)) return false;
    if (typeof openSingleBuildingForParcels !== 'function') {
        updateStatus('Single building tool is unavailable.');
        return false;
    }
    // Reopen on the existing design (a copied proposal, or your own in-progress edits) when the
    // pending context matches this selection. Position lives in the geometry, so pass features.
    const seed = (typeof getPendingBuildingSeedFor === 'function') ? getPendingBuildingSeedFor(selection.ids) : null;
    openSingleBuildingForParcels({
        blockName: formatParcelSelectionLabel(selection.ids),
        parcels: selection.layers,
        initialBuildings: seed ? pendingBuildingSeedFeatures(seed) : null,
        initialGroundTreatment: seed?.groundSurface?.treatment || null
    });
    return true;
}

async function launchRowHouseToolForSelection() {
    const selection = getCurrentParcelSelectionContext();
    if (!selection.layers.length) {
        updateStatus('Select parcels before launching the row house tool.');
        return false;
    }
    if (await shouldStopFreshProposalForWholeBlock('row', selection)) return false;
    if (typeof openRowHouseForParcels !== 'function') {
        updateStatus('Row house tool is unavailable.');
        return false;
    }
    const seed = (typeof getPendingBuildingSeedFor === 'function') ? getPendingBuildingSeedFor(selection.ids) : null;
    openRowHouseForParcels({
        blockName: formatParcelSelectionLabel(selection.ids),
        parcels: selection.layers,
        initialParameters: seed ? seed.parameters : null
    });
    return true;
}

async function launchParcelBasedToolForSelection() {
    const selection = getCurrentParcelSelectionContext();
    if (!selection.layers.length) {
        updateStatus('Select parcels before launching the parcel-based tool.');
        return false;
    }
    // Every classic building launcher uses the same goal-aware selection gate before its editor.
    // Accepting the offer selects the block and deliberately stops this one-parcel launch.
    if (await shouldStopFreshProposalForWholeBlock('parcelBased', selection)) return false;
    if (typeof openParcelBasedForParcels !== 'function') {
        updateStatus('Parcel-based tool is unavailable.');
        return false;
    }
    const seed = (typeof getPendingBuildingSeedFor === 'function') ? getPendingBuildingSeedFor(selection.ids) : null;
    openParcelBasedForParcels({
        blockName: formatParcelSelectionLabel(selection.ids),
        parcels: selection.layers,
        initialParameters: seed ? seed.parameters : null
    });
    return true;
}

function toggleDepositInput() {
    const checkbox = document.getElementById('proposalDepositCheckbox');
    const percentInput = document.getElementById('proposalDepositPercent');
    if (checkbox && percentInput) {
        const enabled = checkbox.checked;
        percentInput.disabled = !enabled;
        if (enabled) {
            percentInput.focus();
            percentInput.select();
        }
    }
}

function computeProposalCategoryFlags(proposal, options = {}) {
    const fallback = options && options.fallbackProposal ? options.fallbackProposal : null;
    const subject = proposal || fallback || {};
    const goalKey = resolveProposalGoalKey(subject, fallback) || '';

    let structureProposal = resolveStructureProposal(subject, { fallbackToStorage: options.fallbackToStorage !== false });
    if (!structureProposal && fallback && fallback !== subject) {
        structureProposal = resolveStructureProposal(fallback, { fallbackToStorage: options.fallbackToStorage !== false });
    }
    if (!structureProposal && subject.structureProposal) {
        structureProposal = subject.structureProposal;
    }
    if (!structureProposal && fallback && fallback.structureProposal) {
        structureProposal = fallback.structureProposal;
    }

    const hasStructureProposal = !!structureProposal;
    const structureKind = ((structureProposal && structureProposal.kind) || (subject.structureProposal && subject.structureProposal.kind) || (fallback && fallback.structureProposal && fallback.structureProposal.kind) || '').toLowerCase();
    const isRoadProposal = goalKey === 'road-track';
    const isReparcellizationProposal = goalKey === 'reparcellization' || !!subject.reparcellization || !!(fallback && fallback.reparcellization);
    const isDecideLaterProposal = goalKey === 'decide-later' || !!subject.decideLaterProposal || !!(fallback && fallback.decideLaterProposal);
    const isBuildingGoal = ['buildings', 'building(s)', 'single-building', 'parcelBased'].includes(goalKey);
    const isStructureGoal = ['park', 'square', 'lake', 'station'].includes(goalKey) || ['park', 'square', 'lake', 'station'].includes(structureKind);
    const isBuildingProposal = (!isRoadProposal) && (isBuildingGoal || !!subject.buildingProposal || !!subject.buildingGeometry || !!(fallback && (fallback.buildingProposal || fallback.buildingGeometry)));
    const isStructureProposal = (!isRoadProposal) && (!isBuildingProposal) && (isStructureGoal || hasStructureProposal);

    const supportsMapToggle = isRoadProposal || isBuildingProposal || isStructureProposal || isReparcellizationProposal || isDecideLaterProposal;

    return {
        structureProposal: structureProposal || null,
        isRoadProposal,
        isBuildingProposal,
        isStructureProposal,
        isReparcellizationProposal,
        isDecideLaterProposal,
        supportsMapToggle
    };
}

function getProposalDisplayType(proposal) {
    if (!proposal) return 'other';

    const goalKey = resolveProposalGoalKey(proposal, null);

    if (goalKey === 'road-track') {
        return 'road';
    }

    if (goalKey === 'buildings' || goalKey === 'single' || goalKey === 'row' || goalKey === 'parcelBased') {
        return 'building';
    }

    if (goalKey === 'park' || goalKey === 'square' || goalKey === 'lake' || goalKey === 'station') {
        return goalKey;
    }

    if (goalKey === 'reparcellization') {
        return 'reparcellization';
    }

    if (goalKey === 'decide-later') {
        return 'decide later';
    }

    return 'other';
}

function collectProposalDisplayCandidates(proposal, fallbackProposal = null) {
    const subject = proposal || fallbackProposal || {};
    const fallback = fallbackProposal || null;
    const structureProposal = resolveStructureProposal(subject, { fallbackToStorage: true })
        || (fallback ? resolveStructureProposal(fallback, { fallbackToStorage: true }) : null)
        || subject.structureProposal
        || (fallback && fallback.structureProposal)
        || null;

    return [
        subject.title,
        subject.name,
        subject.proposalName,
        subject.blockName,
        structureProposal && structureProposal.blockName,
        subject.structureProposal && subject.structureProposal.blockName,
        subject.roadProposal && subject.roadProposal.name,
        subject.buildingProposal && subject.buildingProposal.name,
        subject.metadata && subject.metadata.title,
        subject.metadata && subject.metadata.name,
        subject.metadata && subject.metadata.properties && subject.metadata.properties.title,
        subject.metadata && subject.metadata.properties && subject.metadata.properties.name,
        subject.onchain && subject.onchain.metadata && subject.onchain.metadata.title,
        subject.onchain && subject.onchain.metadata && subject.onchain.metadata.name,
        subject.onchain && subject.onchain.metadata && subject.onchain.metadata.properties && subject.onchain.metadata.properties.title,
        subject.onchain && subject.onchain.metadata && subject.onchain.metadata.properties && subject.onchain.metadata.properties.name,
        fallback && fallback.title,
        fallback && fallback.name,
        fallback && fallback.proposalName,
        fallback && fallback.blockName,
        fallback && fallback.structureProposal && fallback.structureProposal.blockName,
        fallback && fallback.metadata && fallback.metadata.title,
        fallback && fallback.metadata && fallback.metadata.name,
        fallback && fallback.metadata && fallback.metadata.properties && fallback.metadata.properties.title,
        fallback && fallback.metadata && fallback.metadata.properties && fallback.metadata.properties.name
    ];
}

function getProposalDisplayTitle(proposal, fallbackProposal = null) {
    const subject = proposal || fallbackProposal || {};
    const goalKey = resolveProposalGoalKey(subject, fallbackProposal) || '';
    const typeLabel = goalKey ? getProposalGoalLabel(goalKey) : '';
    const fallbackId = subject.onchain?.proposalId || subject.tokenId || subject.proposalId || '';
    const candidates = collectProposalDisplayCandidates(subject, fallbackProposal);

    let best = '';
    let bestScore = -Infinity;
    const seen = new Set();

    candidates.forEach(candidate => {
        const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
        if (!trimmed || seen.has(trimmed)) return;
        seen.add(trimmed);

        let score = trimmed.length;
        if (isGenericProposalDisplayText(trimmed)) {
            score -= 120;
        }
        if (typeLabel && trimmed.toLowerCase() === typeLabel.toLowerCase()) {
            score -= 20;
        }

        if (score > bestScore) {
            bestScore = score;
            best = trimmed;
        }
    });

    if (best && bestScore > -100) {
        return best;
    }

    if (typeLabel) {
        return typeLabel;
    }

    return fallbackId ? `Proposal ${fallbackId}` : 'Proposal';
}

function getProposalDisplayTypeLabel(proposal, fallbackProposal = null) {
    const subject = proposal || fallbackProposal || {};
    const goalKey = resolveProposalGoalKey(subject, fallbackProposal) || '';
    if (!goalKey || goalKey === 'other' || goalKey === 'parcel') {
        return '';
    }
    // 'road-track' is the goal *category*; a built corridor is one or the other, so name it.
    // (goalKey has to be bypassed here: normalizeProposalGoalKey folds 'road' and 'track' back
    // into 'road-track'.)
    if (goalKey === 'road-track' && typeof isTrackProposal === 'function') {
        const isTrack = isTrackProposal(subject) || (fallbackProposal ? isTrackProposal(fallbackProposal) : false);
        const t = getProposalI18nHelper();
        return isTrack
            ? t('modal.roadWidth.proposalList.goalLabels.track', 'Track')
            : t('modal.roadWidth.proposalList.goalLabels.road', 'Road');
    }
    return formatProposalTypeLabel(goalKey);
}

function getProposalDisplayDescription(proposal, fallbackProposal = null, currentTitle = '') {
    const subject = proposal || fallbackProposal || {};
    const fallback = fallbackProposal || null;
    const candidates = [
        subject.description,
        subject.metadata && subject.metadata.description,
        subject.onchain && subject.onchain.metadata && subject.onchain.metadata.description,
        fallback && fallback.description,
        fallback && fallback.metadata && fallback.metadata.description,
        fallback && fallback.onchain && fallback.onchain.metadata && fallback.onchain.metadata.description
    ];

    const normalizedTitle = typeof currentTitle === 'string' ? currentTitle.trim().toLowerCase() : '';
    for (const candidate of candidates) {
        const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
        if (!trimmed) continue;
        if (isGenericProposalDisplayText(trimmed)) continue;
        if (normalizedTitle && trimmed.toLowerCase() === normalizedTitle) continue;
        return trimmed;
    }
    return '';
}

function applyProposalListFilters(dataset) {
    const goalFilter = proposalListState.filterType;
    const authorFilter = proposalListState.authorFilter.trim().toLowerCase();
    const searchFilter = proposalListState.searchText.trim().toLowerCase();
    // Lifecycle status (all + every getProposalLifecycleKey value) and applied state are two
    // orthogonal dropdown filters — they replaced the old Active/Executed tabs.
    const lifecycleFilter = proposalListState.lifecycleFilter || 'all';
    const appliedFilter = proposalListState.appliedFilter || 'all';

    // Vremenska crta plana: kumulativni filtar po epohi (null = bez filtra).
    if (window.__proposalEpoch) {
        dataset = window.__proposalEpoch.filterEntriesCumulative(dataset, window.__proposalEpoch.getSelectedYear());
    }

    return dataset.filter(entry => {
        const { metrics } = entry;
        if (goalFilter !== 'all' && metrics.goalKey !== goalFilter) {
            return false;
        }

        if (authorFilter && !metrics.authorLower.includes(authorFilter)) {
            return false;
        }

        if (searchFilter) {
            const haystack = `${metrics.authorLower} ${metrics.titleLower}`;
            if (!haystack.includes(searchFilter)) {
                return false;
            }
        }

        if (lifecycleFilter !== 'all') {
            const key = (typeof getProposalLifecycleKey === 'function') ? getProposalLifecycleKey(entry.proposal) : 'active';
            if (key !== lifecycleFilter) return false;
        }

        if (appliedFilter !== 'all') {
            const applied = (typeof isProposalApplied === 'function') ? !!isProposalApplied(entry.proposal) : !!(entry.proposal && entry.proposal.applied);
            if (appliedFilter === 'applied' && !applied) return false;
            if (appliedFilter === 'not-applied' && applied) return false;
        }

        return true;
    });
}

function sortProposalDataset(dataset) {
    const sortKey = proposalListState.sortKey || 'created-desc';

    const sorted = dataset.slice();
    sorted.sort((a, b) => {
        const am = a.metrics;
        const bm = b.metrics;

        switch (sortKey) {
            case 'created-asc':
                return am.createdAt - bm.createdAt;
            case 'acceptance-desc':
                return bm.acceptanceRatio - am.acceptanceRatio;
            case 'acceptance-asc':
                return am.acceptanceRatio - bm.acceptanceRatio;
            case 'value-desc':
                return bm.offerValue - am.offerValue;
            case 'value-asc':
                return am.offerValue - bm.offerValue;
            case 'parcels-desc':
                return bm.parcelCount - am.parcelCount;
            case 'parcels-asc':
                return am.parcelCount - bm.parcelCount;
            case 'area-desc':
                return bm.area - am.area;
            case 'area-asc':
                return am.area - bm.area;
            case 'author-asc':
                return am.authorLower.localeCompare(bm.authorLower);
            case 'author-desc':
                return bm.authorLower.localeCompare(am.authorLower);
            case 'created-desc':
            default:
                return bm.createdAt - am.createdAt;
        }
    });

    return sorted;
}

function buildProposalActionButtons(proposal, isExecuted = false) {
    // Action buttons (Apply to map / Remove from map) are now only available in proposal details modal.
    // Exception: open sale offers (Ownership: Third party · Anyone) get a Buy button so a buyer can
    // claim the offer directly from the list. stopPropagation so the row click (→ details) doesn't fire.
    const t = getProposalI18nHelper();
    const buttons = [];
    if (!isExecuted && typeof isProposalOpenSaleOffer === 'function' && isProposalOpenSaleOffer(proposal)) {
        const buyLabel = t('panel.proposal.buy.button', 'Buy');
        const pid = proposal.proposalId || proposal.id || '';
        buttons.push(`<button type="button" class="proposal-buy-btn" title="${buyLabel}" onclick="event.stopPropagation(); claimSaleOffer('${pid}');">🤝 ${buyLabel}</button>`);
    }
    // No editor dialog anymore: the row click selects the object and the details panel carries
    // every action (node edit, cross-section, Create proposal, Park, Delete).
    return buttons.join('');
}

function buildProposalListItemsHtml(dataset, options = {}) {
    const t = getProposalI18nHelper();
    const { source = 'local', downloadedLookup = () => false } = options || {};
    const isServerSource = source === 'server';
    const metaLabels = {
        author: t('modal.roadWidth.proposalList.meta.author', 'Author:'),
        created: t('modal.roadWidth.proposalList.meta.created', 'Created:'),
        acceptance: t('modal.roadWidth.proposalList.meta.acceptance', 'Acceptance:'),
        parcels: t('modal.roadWidth.proposalList.meta.parcels', 'Parcels:'),
        area: t('modal.roadWidth.proposalList.meta.area', 'Area:'),
        offer: t('modal.roadWidth.proposalList.meta.offer', 'Offer:'),
        applied: t('modal.roadWidth.proposalList.meta.applied', 'Applied:'),
        disbursement: t('modal.roadWidth.proposalList.meta.disbursement', 'Disbursement:'),
        minted: t('modal.roadWidth.proposalList.meta.minted', 'Minted:')
    };
    const emptyText = t('modal.roadWidth.proposalList.empty', 'No proposals match the current filters.');
    const untitledLabel = t('modal.roadWidth.proposalList.untitled', 'Untitled proposal');
    const unknownAuthor = t('common.unknown', 'Unknown');
    const deleteTooltip = t('modal.roadWidth.proposalList.deleteTooltip', 'Delete proposal');
    const downloadLabel = t('modal.roadWidth.proposalList.actions.download', 'Download');
    const downloadedLabel = t('modal.roadWidth.proposalList.actions.downloaded', 'Downloaded');

    if (!dataset || dataset.length === 0) {
        return `<p class="empty-proposals">${escapeHtml(emptyText)}</p>`;
    }

    return dataset.map(entry => {
        const { proposal, metrics } = entry;
        const proposalId = getProposalKey(proposal);
        const serialProposalId = typeof getSerialProposalId === 'function' ? getSerialProposalId(proposal) : null;
        const color = typeof getProposalColor === 'function' ? getProposalColor(proposalId || '') : '#007bff';
        const lifecycleKey = getProposalLifecycleKey(proposal);
        const statusLabel = escapeHtml(getProposalLifecycleLabel(lifecycleKey));
        const statusClass = getProposalLifecycleClass(lifecycleKey);
        const typeLabel = escapeHtml(formatProposalTypeLabel(metrics.goalKey));
        const acceptanceText = metrics.parcelCount > 0
            ? `${metrics.acceptedCount}/${metrics.parcelCount} (${Math.round(metrics.acceptancePercent)}%)`
            : '—';
        const areaText = formatAreaMetric(metrics.area);
        const offerText = formatCurrencyMetric(metrics.offerValue);
        const createdDate = metrics.createdAt ? new Date(metrics.createdAt).toLocaleDateString() : '—';
        const isExecuted = getLifecycleStatus(proposal) === 'Executed';
        // Save state is a property of the PROPOSAL, not of which tab it is shown in: it is "Unsaved"
        // (local-only, at risk) unless it is minted on-chain or uploaded to the server (numeric serial).
        const isMinted = isProposalMinted(proposal);
        const isUnsaved = !isMinted && !serialProposalId;
        const classes = ['proposal-list-item'];

        if (metrics.isApplied) classes.push('is-applied');
        if (isExecuted) classes.push('is-executed');
        if (isUnsaved) classes.push('is-unsaved');
        if (proposalHighlightState.activeProposalId === proposalId || proposalListState.selectedId === proposalId) {
            classes.push('is-selected');
        }
        if (currentProposalPreviewId === proposalId) classes.push('is-previewing');

        const classAttr = classes.join(' ');
        const safeTitle = escapeHtml(proposal.title || untitledLabel);
        const safeAuthor = escapeHtml(metrics.author || unknownAuthor);

        // Determine applied status
        const appliedState = typeof isProposalApplied === 'function' ? isProposalApplied(proposal) : metrics.isApplied;
        const appliedLabel = appliedState
            ? t('modal.roadWidth.proposalList.labels.applied', 'Applied')
            : t('modal.roadWidth.proposalList.labels.notApplied', 'Not Applied');
        const appliedClass = appliedState ? 'applied' : 'not-applied';

        // Determine disbursement mode (conditional/partial)
        const disbursementModeRaw = (proposal.disbursementMode || '').toLowerCase();
        const isConditional = proposal.isConditional === true || disbursementModeRaw === 'conditional';
        const disbursementLabel = isConditional
            ? t('modal.roadWidth.proposalList.labels.conditional', 'Conditional')
            : t('modal.roadWidth.proposalList.labels.partial', 'Partial payouts');

        // Save-state badge — driven by the proposal itself (see isUnsaved above), so uploaded and
        // never-uploaded proposals are told apart even in the same local list. Minted → green,
        // uploaded (has a server serial) → blue, otherwise → amber "Unsaved".
        const downloadEligible = isServerSource && !!proposalId;
        const isDownloaded = downloadEligible && downloadedLookup(proposal);
        // Where a proposal LIVES is two independent facts, and the mint badge only ever told one of
        // them: minted / on the server / neither. Held-locally was left implied — true in the Local
        // tab, and in the Server tab only visible as a greyed-out Download button. So a downloaded
        // proposal still read "On server" and nothing said the copy in front of you was yours.
        //
        // The second badge states it, in both tabs, from the same lookup the Download button uses.
        const isLocal = typeof downloadedLookup === 'function' ? !!downloadedLookup(proposal) : !isServerSource;
        const mintLabels = {
            minted: t('panel.proposal.lifecycle.minted', 'Minted'),
            onServer: t('modal.roadWidth.proposalList.labels.onServer', 'On server'),
            unsaved: t('modal.roadWidth.proposalList.labels.unsaved', 'Unsaved'),
            local: t('modal.roadWidth.proposalList.labels.local', 'Local')
        };

        let mintLabel, mintStyles;
        if (isMinted) {
            mintLabel = mintLabels.minted;
            mintStyles = { color: '#065f46', background: '#d1fae5', border: '#34d399' };
        } else if (serialProposalId) {
            mintLabel = mintLabels.onServer;
            mintStyles = { color: '#0b4f91', background: '#e5f0ff', border: '#a7c2ff' };
        } else {
            mintLabel = mintLabels.unsaved;
            mintStyles = { color: '#7a6000', background: '#fff7d6', border: '#ffe08a' };
        }
        const downloadButtonHtml = downloadEligible
            ? `<button class="proposal-download-btn" data-proposal-id="${escapeHtml(proposalId)}" data-server-id="${escapeHtml(proposal.serverProposalId || proposal.id || '')}" ${isDownloaded ? 'disabled' : ''}>${escapeHtml(isDownloaded ? downloadedLabel : downloadLabel)}</button>`
            : '';
        const deleteButtonHtml = isServerSource ? '' : `
                    <button class="proposal-delete-btn" onclick="event.stopPropagation(); deleteProposal('${proposalId}')" title="${escapeHtml(deleteTooltip)}">
                        <i class="fas fa-trash"></i>
                    </button>`;

        // Compact card: a full-width title (no longer squeezed to an ellipsis by the pill + buttons),
        // one dim meta line, and just the state badges. The big thumbnail is dropped for a small
        // goal-emoji icon (local proposals have no image anyway) and the auto-generated description is
        // dropped, so 5+ cards fit on screen instead of 2–3.
        const goalBadge = (typeof getProposalGoalBadge === 'function') ? getProposalGoalBadge(metrics.goalKey) : null;
        const goalIcon = (goalBadge && goalBadge.text) ? goalBadge.text : '📄';
        const goalIconTitle = (goalBadge && goalBadge.label) ? goalBadge.label : typeLabel;
        const buyButtonHtml = buildProposalActionButtons(proposal, isExecuted); // usually empty (Buy on open sale offers)
        const metaBits = [
            offerText ? `<span class="proposal-card-offer">${escapeHtml(offerText)}</span>` : '',
            `<span>${safeAuthor}</span>`,
            `<span>${escapeHtml(createdDate)}</span>`,
            `<span title="${escapeHtml(metaLabels.parcels)} ${escapeHtml(String(metrics.parcelCount))}">${escapeHtml(String(metrics.parcelCount))}p</span>`,
            `<span title="${escapeHtml(metaLabels.acceptance)}">${escapeHtml(acceptanceText)}</span>`
        ].filter(Boolean).join('<span class="proposal-card-dot">·</span>');

        return `
            <div class="${classAttr} proposal-list-item--compact" data-proposal-id="${proposalId}" style="border-left: 4px ${isUnsaved ? 'dashed' : 'solid'} ${color};">
                <div class="proposal-card-head">
                    <span class="proposal-card-icon" title="${escapeHtml(goalIconTitle)}" aria-hidden="true">${escapeHtml(goalIcon)}</span>
                    <span class="proposal-list-title" title="${safeTitle}">${safeTitle}</span>
                    ${serialProposalId ? `<span class="proposal-meta-number">#${escapeHtml(serialProposalId)}</span>` : ''}
                    <div class="proposal-status-indicator ${statusClass}">${statusLabel}</div>
                    ${downloadButtonHtml || deleteButtonHtml}
                </div>
                <div class="proposal-card-sub">${metaBits}</div>
                <div class="proposal-card-badges">
                    ${window.__proposalEpoch ? window.__proposalEpoch.cardEpochSelectHtml(proposal, proposalId) : ''}
                    <span class="proposal-application-status ${appliedClass}">${escapeHtml(appliedLabel)}</span>
                    <span class="proposal-mint-state proposal-mint-state--compact" style="color:${mintStyles.color};background:${mintStyles.background};border:1px solid ${mintStyles.border};">${escapeHtml(mintLabel)}</span>
                    ${isLocal ? `<span class="proposal-mint-state proposal-mint-state--compact proposal-local-state" style="color:#334155;background:#f1f5f9;border:1px solid #cbd5e1;">${escapeHtml(mintLabels.local)}</span>` : ''}
                    ${buyButtonHtml}
                </div>
            </div>
        `;
    }).join('');
}

function clearProposalListFilterInputDebounce() {
    if (_proposalListFilterInputDebounceTimer == null) return;
    try { clearTimeout(_proposalListFilterInputDebounceTimer); } catch (_) { }
    _proposalListFilterInputDebounceTimer = null;
}

function resetParcelSelectionForProposalListInteraction() {
    try {
        if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection) {
            if (typeof multiParcelSelection.clearSelection === 'function') {
                multiParcelSelection.clearSelection();
            }
            if (typeof multiParcelSelection.clearSingleParcelSelection === 'function') {
                multiParcelSelection.clearSingleParcelSelection();
            }
        }
    } catch (_) { }

    try {
        if (typeof hideParcelInfoPanel === 'function') {
            hideParcelInfoPanel();
        } else {
            const panel = document.getElementById('parcel-info-panel');
            if (panel) {
                panel.classList.remove('visible');
            }
        }
    } catch (_) { }

    try {
        if (typeof refreshParcelStylesForAppliedProposals === 'function') {
            refreshParcelStylesForAppliedProposals();
        }
    } catch (_) { }
}

async function handleProposalListItemClick(event) {
    const item = event.currentTarget;
    if (!item) return;

    // Izbornik epohe na kartici mijenja godinu, ne otvara prijedlog.
    if (event.target && event.target.closest && event.target.closest('.proposal-epoch-card-select')) return;

    const proposalIdAttr = item.getAttribute('data-proposal-id');
    if (!proposalIdAttr) return;

    const source = proposalListState.source || 'local';
    console.log('[ProposalList] click on proposal item', { proposalIdAttr, source });

    // Check local storage first, even when browsing the server tab
    let proposal = getProposalByIdOrHash(proposalIdAttr);

    let justDownloaded = false;
    if (!proposal && source === 'server') {
        const confirmed = await showProposalDownloadConfirm();
        if (!confirmed) return;

        const serverId = proposalIdAttr;
        try {
            updateStatus('Downloading proposal…');
            const serverProposal = await fetchServerProposalById(serverId, resolveCurrentCityCode());
            // preserveStatus:false — downloading does not apply the proposal to this map, so its
            // status must not survive the trip. Keeping the uploader's "applied" made the details
            // panel announce a proposal as on the map while no geometry had been drawn, and offer
            // "Remove from map" where "Apply to map" belonged.
            proposal = proposalStorage.importProposal(serverProposal, { overwrite: true, preserveStatus: false });
            if (!proposal) {
                updateStatus('Failed to import proposal');
                return;
            }
            justDownloaded = true;
            updateShowProposalsButton();
            // The card still said "Download". Downloading by clicking the ROW leaves the same card
            // on screen as downloading by its own button does, so it has to end in the same state —
            // otherwise the list keeps offering to fetch something it already holds.
            if (typeof markProposalCardDownloaded === 'function') {
                markProposalCardDownloaded(proposalIdAttr, proposal);
            }
        } catch (error) {
            console.error('Failed to download server proposal on click', serverId, error);
            updateStatus('Failed to download proposal');
            return;
        }
    }

    if (!proposal) return;

    // A freshly downloaded proposal opens collapsed, the same way a freshly created one does:
    // the collapsed card still exposes Apply to map and Share (see showProposalInfo).
    if (justDownloaded && typeof window !== 'undefined') {
        window.__openProposalDetailsCollapsed = true;
    }

    const resolvedId = getProposalKey(proposal) || proposalIdAttr;

    // A list click only PREVIEWS the proposal: pan/zoom the map to it (framed in the visible area,
    // clear of the list panel) and mark the row — the list stays open and nothing is selected, so
    // browsing ten proposals costs ten previews rather than ten selections.
    //
    // SELECTING it (open details + close the list + restore the normal, fully-clickable map) happens
    // when the user clicks the proposal ON THE MAP, or when they close the list on the row they were
    // previewing — see the browse-mode guard in onParcelClick, the tail of
    // selectAndHighlightProposal, and closeProposalList({ selectPreviewed: true }).
    //
    // "Select" is the word on purpose. In this codebase COMMIT means ending an editing session so a
    // draft becomes a stored record (see reparcellization.js, building-blocks.js), and APPLY means
    // enacting a stored proposal on the map — two separate axes, two separate columns in the
    // database. Selection stores nothing and enacts nothing; it is only what the user is looking at.
    try {
        const listModal = document.querySelector('.proposal-list-modal');
        if (listModal) {
            listModal.querySelectorAll('.proposal-list-item.is-previewing').forEach(el => el.classList.remove('is-previewing'));
            item.classList.add('is-previewing');
        }
    } catch (_) { }
    if (typeof previewProposalOnMap === 'function') {
        previewProposalOnMap(resolvedId, { center: true, blink: true });
    }
}

function switchProposalTab(clickedTabOrName, maybeTabName) {
    const tabName = typeof maybeTabName === 'string'
        ? maybeTabName
        : (typeof clickedTabOrName === 'string' ? clickedTabOrName : null);

    if (!tabName) return;

    if (proposalListState.activeTab !== tabName) {
        proposalListState.activeTab = tabName;
        renderProposalListModal();
    }
}

// `selectPreviewed` is opt-in, and deliberately not inferred from `clearHighlights`. Of the six
// callers, two close the list while a selection is already being made (they pass clearHighlights
// false), and two more close it bare while LEAVING proposals entirely — returnToParcelInfo, and the
// clear-all-proposals path, where re-selecting would reopen a proposal the user just dismissed or
// deleted. Only a genuine dismissal of the list asks for it.
function closeProposalList(options = {}) {
    const normalized = options && typeof options === 'object' ? options : {};
    const selectPreviewed = normalized.selectPreviewed === true;
    const clearHighlights = normalized.clearHighlights !== false && !selectPreviewed;
    // Leaving the list also exits browse mode, so the map returns to normal (parcels clickable
    // again). This runs BEFORE any selection below: selectAndHighlightProposal closes the list
    // itself while browse mode is on, and clearing the flag first is what stops that recursing.
    if (typeof window !== 'undefined') window.proposalListBrowseMode = false;

    // The row the user was looking at when they closed the list. Read from the DOM before the modal
    // is torn down.
    let previewedId = null;
    if (selectPreviewed) {
        try {
            const previewing = document.querySelector('.proposal-list-item.is-previewing');
            previewedId = previewing ? previewing.getAttribute('data-proposal-id') : null;
        } catch (_) { previewedId = null; }
    }

    const modal = document.querySelector('.proposal-list-modal');
    if (modal) {
        modal.style.display = 'none';
        // When the Proposal List closes, clear any proposal-specific overlays/highlights
        try { clearProposalInfoHoverOverlay(); } catch (_) { }
        if (clearHighlights) {
            try { clearProposalHighlights(); } catch (_) { }
        }
        proposalListState.selectedId = null;
    }

    // Browsing picked a proposal out; closing the list keeps it. Without this the map was left
    // showing a highlight belonging to nothing selected, so none of the proposal's own buttons were
    // reachable and the same proposal had to be found and clicked again on the map.
    //
    // No re-centring: the preview already framed it, and moving the map again on a close reads as
    // the app wandering off on its own.
    if (previewedId && typeof selectAndHighlightProposal === 'function') {
        try { selectAndHighlightProposal(previewedId, null, false, true); } catch (error) {
            console.warn('[closeProposalList] could not select the previewed proposal', error);
        }
    }
}

// fitBounds padding that keeps content in the VISIBLE map, clear of whichever right/bottom-docked
// proposal panel is currently covering it: the list panel while browsing, or the details panel once a
// proposal is selected. That side is padded out (right ~third / 400px on desktop, lower half on
// mobile). Returns a plain {paddingTopLeft, paddingBottomRight} for fitBounds — a symmetric margin
// when neither panel is open. Shared by fit-all-on-open, the preview zoom, and proposal selection.
function getProposalPanelFitPadding(margin = 40) {
    let paddingTopLeft = [margin, margin];
    let paddingBottomRight = [margin, margin];
    try {
        let rect = null;
        // The share-plan panel exists in the DOM only while open, so presence means visible.
        const sharePanel = document.querySelector('.share-plan-panel-content');
        const listModal = document.querySelector('.proposal-list-modal');
        const listPanel = document.querySelector('.proposal-list-modal-content');
        if (sharePanel) {
            rect = sharePanel.getBoundingClientRect();
        } else if (listModal && listModal.style.display === 'block' && listPanel) {
            rect = listPanel.getBoundingClientRect();
        } else {
            const details = document.getElementById('proposal-details-panel');
            if (details && details.classList.contains('visible')) rect = details.getBoundingClientRect();
        }
        if (rect && rect.width > 0 && rect.height > 0) {
            const docksBottom = rect.top > window.innerHeight * 0.4; // bottom dock (mobile)
            if (docksBottom) paddingBottomRight = [margin, Math.round(rect.height) + margin];
            else paddingBottomRight = [Math.round(rect.width) + margin, margin];
        }
    } catch (_) { }
    return { paddingTopLeft, paddingBottomRight };
}

// Frame every currently-applied proposal in one view — used when the list opens so the user starts
// from an overview. Bounds come from each proposal's own geometry (resolveStandaloneProposalFocusBounds),
// with a parcel-layer fallback, combined into one L.latLngBounds. The side the panel covers is padded
// so nothing is framed behind it (right third on desktop, lower half on mobile).
function fitMapToAppliedProposals() {
    if (typeof map === 'undefined' || !map || typeof L === 'undefined') return false;
    const all = (typeof proposalStorage !== 'undefined' && typeof proposalStorage.getAllProposals === 'function')
        ? proposalStorage.getAllProposals() : [];
    const applied = all.filter(p => typeof isProposalCurrentlyApplied === 'function'
        ? isProposalCurrentlyApplied(p)
        : !!(p && p.applied));
    if (!applied.length) return false;

    let combined = null;
    const extend = (b) => {
        if (b && typeof b.isValid === 'function' && b.isValid()) {
            combined = combined ? combined.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast());
        }
    };
    for (const proposal of applied) {
        let bounds = null;
        try {
            if (typeof resolveStandaloneProposalFocusBounds === 'function') {
                bounds = resolveStandaloneProposalFocusBounds(proposal);
            }
        } catch (_) { }
        if (bounds) { extend(bounds); continue; }
        // Fallback: frame the proposal's parent parcels' layers (same pattern selectAndHighlightProposal uses).
        try {
            const ids = Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds : [];
            ids.forEach(pid => {
                const layer = (typeof findParcelLayerById === 'function') ? findParcelLayerById(pid) : null;
                if (layer && typeof layer.getBounds === 'function') extend(layer.getBounds());
            });
        } catch (_) { }
    }

    if (!combined || !combined.isValid()) return false;

    // Pad the side the open panel covers (proposals list OR share-plan panel) so proposals
    // aren't framed underneath it.
    const { paddingTopLeft, paddingBottomRight } = getProposalPanelFitPadding(40);

    try {
        // animate:false — an instant overview when the list opens (no distracting pan), and it avoids
        // relying on requestAnimationFrame, which is throttled when the tab isn't actively rendering.
        map.fitBounds(combined, { paddingTopLeft, paddingBottomRight, maxZoom: 18, animate: false });
        return true;
    } catch (_) {
        return false;
    }
}

function updateProposalList() {
    const modal = document.querySelector('.proposal-list-modal');
    if (modal && modal.style.display === 'block') {
        showAllProposalsModal();
    }

    if (typeof refreshBlockInfoProposalTab === 'function') {
        try { refreshBlockInfoProposalTab(); } catch (_) { }
    }
}

// ONE number on the button: the union of the three list tabs (Local / Server / Blockchain). They
// overlap — Blockchain is the minted subset of Local, and an uploaded local proposal is also a
// server row — so the union is the server total plus the local records never uploaded. The second,
// circled number here used to count unsaved work, which read as a contradiction of the first.
function proposalUnionCountNow() {
    const local = proposalStorage.getAllProposals().map(proposal => ({
        // "On server" by the same test the list card uses for its badge — a DOWNLOADED proposal
        // carries the serial as proposalId/id, and counting it as local-only would double it.
        onServer: !!(typeof getSerialProposalId === 'function' && getSerialProposalId(proposal))
    }));
    const counts = (typeof window !== 'undefined') ? window.__proposalCounts : null;
    return counts
        ? counts.unionProposalCount(local, serverProposalCache.count)
        : local.length;
}

function updateShowProposalsButton() {
    const button = document.getElementById('showProposalsButton');
    if (button) {
        const totalProposals = proposalUnionCountNow();
        const i18nApi = (typeof window !== 'undefined') ? window.i18n : null;
        button.setAttribute('data-i18n-key', 'sidebar.proposals.listButton');
        button.setAttribute('data-i18n-params', JSON.stringify({ count: totalProposals }));
        if (i18nApi && typeof i18nApi.t === 'function') {
            button.textContent = i18nApi.t('sidebar.proposals.listButton', { count: totalProposals });
        } else {
            button.textContent = `Proposals List (${totalProposals})`;
        }
    }

    const sharePlanButton = document.getElementById('shareAppliedProposalsButton');
    // While the plan is being prepared the button owns its own disabled state — re-enabling it here
    // would invite a second click straight into a half-built panel.
    if (sharePlanButton && !sharePlanButton.dataset.sharePlanBusy) {
        const appliedCount = proposalStorage.getAllProposals().filter(isProposalCurrentlyApplied).length;
        sharePlanButton.disabled = appliedCount === 0;
    }

    // no-op safety: the observer below is idempotent, and the button may only now exist
    watchProposalsSectionVisibility();

    // Also sync the proposals presence indicator
    if (typeof syncProposalsIndicator === 'function') {
        syncProposalsIndicator();
    }

    if (typeof refreshBlockInfoProposalTab === 'function') {
        try { refreshBlockInfoProposalTab(); } catch (_) { }
    }
}

// Half the count is local (always current) and half is the server's, which goes stale the moment
// anyone else uploads. So it is refreshed when the Proposals section BECOMES VISIBLE. A collapsed
// accordion is display:none, so one IntersectionObserver covers every case the number could be
// looked at: the first expand, every re-expand, the sidebar being re-opened, and the section being
// scrolled back into view. Observing is idempotent — the button is never re-created, but this is
// called from updateShowProposalsButton, which runs on every proposal change.
function watchProposalsSectionVisibility() {
    const button = document.getElementById('showProposalsButton');
    if (!button || button.__proposalCountObserved) return false;
    if (typeof IntersectionObserver !== 'function') return false;
    button.__proposalCountObserved = true;

    const observer = new IntersectionObserver(entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        updateShowProposalsButton();                 // the local half, immediately
        try {
            // The server half, at most once per SERVER_COUNT_MAX_AGE_MS; it updates the button again
            // when it lands. Never awaited — a slow backend must not hold up the sidebar.
            if (typeof refreshServerProposalCount === 'function') refreshServerProposalCount();
        } catch (_) { }
    }, { threshold: 0 });
    observer.observe(button);
    return true;
}

function handleMultiSelectChange(checked, source) {
    const desiredState = typeof checked === 'boolean'
        ? checked
        : !!(document.getElementById('multiSelectCheckbox') && document.getElementById('multiSelectCheckbox').checked);

    syncMultiSelectCheckboxes(desiredState);

    const showProposalsCheckbox = document.getElementById('showProposalsCheckbox');
    if (desiredState && showProposalsCheckbox && showProposalsCheckbox.checked) {
        showProposalsCheckbox.checked = false;
        updateProposalLayer();
    }

    if (!!multiParcelSelection.isActive !== desiredState) {
        if (desiredState) {
            const preserveSelected = source === 'tools' || source === 'info';
            multiParcelSelection.toggle({ preserveSelectedParcel: preserveSelected });
        } else {
            multiParcelSelection.toggle();
        }
    }
}

function cancelMultiParcelSelection() {
    // Clear selection first
    multiParcelSelection.clearSelection();

    // Exit multi-select mode if it's active
    if (multiParcelSelection.isActive) {
        multiParcelSelection.toggle({ restoreSingleSelection: false });
    }

    // Update checkboxes to reflect that multi-select is off
    syncMultiSelectCheckboxes(false);

    updateStatus('Multi-parcel selection cleared');
}
