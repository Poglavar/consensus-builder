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

        let proposals = proposalStorage.getProposalsForParcel(parcelId, { hydrateRoadAssets: false }).filter(p => p.status !== 'Executed');
        if (proposals.length === 0) {
            proposals = proposalStorage.getProposalsForParcel(parcelId).filter(p => p.status !== 'Executed');
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

function formatParcelSelectionLabel(parcelIds = []) {
    if (!parcelIds || parcelIds.length === 0) return 'Selected Parcels';
    if (parcelIds.length === 1) {
        return `Parcel ${parcelIds[0]}`;
    }
    return `${parcelIds.length} Parcels`;
}

function launchStructureToolForSelection(kind) {
    const selection = getCurrentParcelSelectionContext();
    if (!selection.layers.length) {
        updateStatus('Select parcels before launching the structure tool.');
        return;
    }
    if (kind === 'lake') {
        const contiguity = (typeof areParcelsContiguous === 'function') ? areParcelsContiguous(selection.layers) : { contiguous: true };
        if (!contiguity.contiguous) {
            if (typeof showProposalAlertMessage === 'function') {
                showProposalAlertMessage('parcels_not_contiguous', 'Parcels not contiguous');
            } else if (typeof alert === 'function') {
                alert('Parcels not contiguous');
            }
            return;
        }
    }
    const geometry = buildGeometryFromParcels(selection.layers);
    if (!geometry) {
        updateStatus('Could not build geometry for the selected parcels.');
        return;
    }
    if (typeof showStructureProposalDialog !== 'function') {
        updateStatus('Structure proposal dialog is unavailable.');
        return;
    }
    closeProposalDialog();
    showStructureProposalDialog({
        kind,
        parcelIds: selection.ids,
        geometry,
        blockName: formatParcelSelectionLabel(selection.ids)
    });
}

function launchSingleBuildingToolForSelection() {
    const selection = getCurrentParcelSelectionContext();
    if (!selection.layers.length) {
        updateStatus('Select parcels before launching the single building tool.');
        return;
    }
    if (typeof openSingleBuildingForParcels !== 'function') {
        updateStatus('Single building tool is unavailable.');
        return;
    }
    // Reopen on the existing design (a copied proposal, or your own in-progress edits) when the
    // pending context matches this selection. Position lives in the geometry, so pass features.
    const seed = (typeof getPendingBuildingSeedFor === 'function') ? getPendingBuildingSeedFor(selection.ids) : null;
    openSingleBuildingForParcels({
        blockName: formatParcelSelectionLabel(selection.ids),
        parcels: selection.layers,
        initialBuildings: seed ? pendingBuildingSeedFeatures(seed) : null
    });
}

function launchRowHouseToolForSelection() {
    const selection = getCurrentParcelSelectionContext();
    if (!selection.layers.length) {
        updateStatus('Select parcels before launching the row house tool.');
        return;
    }
    if (typeof openRowHouseForParcels !== 'function') {
        updateStatus('Row house tool is unavailable.');
        return;
    }
    const seed = (typeof getPendingBuildingSeedFor === 'function') ? getPendingBuildingSeedFor(selection.ids) : null;
    openRowHouseForParcels({
        blockName: formatParcelSelectionLabel(selection.ids),
        parcels: selection.layers,
        initialParameters: seed ? seed.parameters : null
    });
}

function launchParcelBasedToolForSelection() {
    const selection = getCurrentParcelSelectionContext();
    if (!selection.layers.length) {
        updateStatus('Select parcels before launching the parcel-based tool.');
        return;
    }
    if (typeof openParcelBasedForParcels !== 'function') {
        updateStatus('Parcel-based tool is unavailable.');
        return;
    }
    const seed = (typeof getPendingBuildingSeedFor === 'function') ? getPendingBuildingSeedFor(selection.ids) : null;
    openParcelBasedForParcels({
        blockName: formatParcelSelectionLabel(selection.ids),
        parcels: selection.layers,
        initialParameters: seed ? seed.parameters : null
    });
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
    const isStructureGoal = ['park', 'square', 'lake'].includes(goalKey) || ['park', 'square', 'lake'].includes(structureKind);
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

    if (goalKey === 'park' || goalKey === 'square' || goalKey === 'lake') {
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
        const isExecuted = (proposal.status || '').toLowerCase() === 'executed';
        const classes = ['proposal-list-item'];

        if (metrics.isApplied) classes.push('is-applied');
        if (isExecuted) classes.push('is-executed');
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

        // Determine minted/status badges
        const isMinted = isProposalMinted(proposal);
        const downloadEligible = isServerSource && !!proposalId;
        const isDownloaded = downloadEligible && downloadedLookup(proposal);
        const mintLabels = {
            minted: t('panel.proposal.lifecycle.minted', 'Minted'),
            inMemory: t('panel.proposal.lifecycle.inMemory', 'In-memory'),
            onServer: t('modal.roadWidth.proposalList.labels.onServer', 'On server')
        };

        let mintLabel = mintLabels.inMemory;
        let mintStyles = {
            color: '#7a6000',
            background: '#fff7d6',
            border: '#ffe08a'
        };

        if (isMinted) {
            mintLabel = mintLabels.minted;
            mintStyles = {
                color: '#065f46',
                background: '#d1fae5',
                border: '#34d399'
            };
        } else if (isServerSource) {
            if (isDownloaded) {
                mintLabel = mintLabels.inMemory;
            } else {
                mintLabel = mintLabels.onServer;
                mintStyles = {
                    color: '#0b4f91',
                    background: '#e5f0ff',
                    border: '#a7c2ff'
                };
            }
        }
        const downloadButtonHtml = downloadEligible
            ? `<button class="proposal-download-btn" data-proposal-id="${escapeHtml(proposalId)}" data-server-id="${escapeHtml(proposal.serverProposalId || proposal.id || '')}" ${isDownloaded ? 'disabled' : ''}>${escapeHtml(isDownloaded ? downloadedLabel : downloadLabel)}</button>`
            : '';
        const deleteButtonHtml = isServerSource ? '' : `
                    <button class="proposal-delete-btn" onclick="event.stopPropagation(); deleteProposal('${proposalId}')" title="${escapeHtml(deleteTooltip)}">
                        <i class="fas fa-trash"></i>
                    </button>`;

        const thumbHtml = buildProposalThumbHtml(proposal);
        const bodyHtml = `
            <div class="proposal-list-body">
                <div class="proposal-list-header">
                    <div class="proposal-color-dot" style="background-color: ${color};"></div>
                    <span class="proposal-list-title">${safeTitle}</span>
                    <span class="proposal-type-pill">${typeLabel}</span>
                    ${buildProposalActionButtons(proposal, isExecuted)}
                    <div class="proposal-status-indicator ${statusClass}">${statusLabel}</div>
                    ${downloadButtonHtml || deleteButtonHtml}
                </div>
                <div class="proposal-list-meta">
                    ${serialProposalId ? `<span><span class="proposal-meta-value proposal-meta-number">#${escapeHtml(serialProposalId)}</span></span>` : ''}
                    <span><strong>${escapeHtml(metaLabels.author)}</strong> <span class="proposal-meta-value">${safeAuthor}</span></span>
                    <span><strong>${escapeHtml(metaLabels.created)}</strong> <span class="proposal-meta-value">${escapeHtml(createdDate)}</span></span>
                    <span><strong>${escapeHtml(metaLabels.acceptance)}</strong> <span class="proposal-meta-value">${escapeHtml(acceptanceText)}</span></span>
                    <span><strong>${escapeHtml(metaLabels.parcels)}</strong> <span class="proposal-meta-value">${escapeHtml(String(metrics.parcelCount))}</span></span>
                    <span><strong>${escapeHtml(metaLabels.offer)}</strong> <span class="proposal-meta-value">${escapeHtml(offerText)}</span></span>
                </div>
                <div class="proposal-list-badges" style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; align-items: center;">
                    <div class="proposal-application-status ${appliedClass}">${escapeHtml(appliedLabel)}</div>
                    <div class="proposal-conditionality ${isConditional ? 'conditional' : 'partial'}">${escapeHtml(disbursementLabel)}</div>
                    <div class="proposal-mint-state" style="
                        display: inline-flex;
                        align-items: center;
                        gap: 4px;
                        padding: 2px 6px;
                        border-radius: 10px;
                        font-size: 11px;
                        font-weight: 500;
                        text-transform: uppercase;
                        letter-spacing: 0.5px;
                        color: ${mintStyles.color};
                        background: ${mintStyles.background};
                        border: 1px solid ${mintStyles.border};
                    ">
                        ${escapeHtml(mintLabel)}
                    </div>
                </div>
                ${proposal.description ? `<div class="proposal-list-description">${escapeHtml(proposal.description)}</div>` : ''}
            </div>
        `;
        return `
            <div class="${classAttr}" data-proposal-id="${proposalId}" style="border-left: 4px solid ${color};">
                ${thumbHtml ? `<div class="proposal-list-row">${thumbHtml}${bodyHtml}</div>` : bodyHtml}
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
    proposalListState.selectedId = resolvedId;

    resetParcelSelectionForProposalListInteraction();
    openProposalFromList(resolvedId, {
        proposal,
        closeProposalList: true,
        closeParcelInfo: true,
        closeAgentDialog: false,
        collapseSidebar: true,
        centerOnProposal: true,
        showDetails: true
    });
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

function closeProposalList(options = {}) {
    const normalized = options && typeof options === 'object' ? options : {};
    const clearHighlights = normalized.clearHighlights !== false;
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

function updateShowProposalsButton() {
    const button = document.getElementById('showProposalsButton');
    if (button) {
        const allLocal = proposalStorage.getAllProposals();
        const localCount = allLocal.length;
        const serverCount = serverProposalCache.count;
        let totalProposals;
        if (serverCount !== null && serverCount !== undefined) {
            // server count + local-only proposals (never uploaded)
            const localOnlyCount = allLocal.filter(p => !p.serverProposalId).length;
            totalProposals = serverCount + localOnlyCount;
        } else {
            totalProposals = localCount;
        }
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
    if (sharePlanButton) {
        const appliedCount = proposalStorage.getAllProposals().filter(isProposalCurrentlyApplied).length;
        sharePlanButton.disabled = appliedCount === 0;
    }

    // Also sync the proposals presence indicator
    if (typeof syncProposalsIndicator === 'function') {
        syncProposalsIndicator();
    }

    if (typeof refreshBlockInfoProposalTab === 'function') {
        try { refreshBlockInfoProposalTab(); } catch (_) { }
    }
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

function handleShowProposalsChange() {
    // No-op: proposal mode removed
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
