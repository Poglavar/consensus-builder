// proposals/details-panel.js — extracted from proposals.js (behavior-preserving relocation).

function showRoadProposalInfo(proposal) {
    // Clear any existing highlights
    clearProposalHighlights();

    // Show road proposal info in the parcel info panel (reusing existing UI)
    const roadGeometry = proposal.roadGeometry;
    const displayId = proposal.proposalId || '';
    const safeDisplayId = typeof escapeHtml === 'function'
        ? escapeHtml(String(displayId))
        : (displayId || '');
    const infoHTML = `
        <div class="proposal-info">
            <h4>Road Proposal</h4>
            <div class="proposal-hash">ID: ${safeDisplayId}</div>
            <div class="metric-group">
                <div class="metric-label">Type:</div>
                <div class="metric-value">${(typeof escapeHtml === 'function' ? escapeHtml(String(resolveProposalGoalKey(proposal) || '')) : String(resolveProposalGoalKey(proposal) || ''))}</div>
            </div>
            <div class="metric-group">
                <div class="metric-label">Road Name:</div>
                <div class="metric-value">${roadGeometry.name}</div>
            </div>
            <div class="metric-group">
                <div class="metric-label">Road Width:</div>
                <div class="metric-value">${roadGeometry.width}m</div>
            </div>
            <div class="metric-group">
                <div class="metric-label">${tProposal('panel.proposal.metrics.author', 'Author:')}</div>
                <div class="metric-value">${proposal.username}</div>
            </div>
            <div class="metric-group">
                <div class="metric-label">Date:</div>
                <div class="metric-value">${new Date(proposal.timestamp).toLocaleDateString()}</div>
            </div>
            <div class="metric-group">
                <div class="metric-label">Description:</div>
                <div class="metric-value">${proposal.description}</div>
            </div>
            ${proposal.offer ? `
                <div class="metric-group">
                    <div class="metric-label">Offer:</div>
                    <div class="metric-value">${proposal.offer}</div>
                </div>
            ` : ''}
        </div>
    `;

    // Show in parcel info panel (Info tab)
    const parcelInfoPanel = document.getElementById('parcel-info-panel');
    const infoContent = document.getElementById('info-content');

    if (parcelInfoPanel && infoContent) {
        infoContent.innerHTML = infoHTML;
        parcelInfoPanel.classList.add('visible');

        // Update the panel title
        const panelTitle = parcelInfoPanel.querySelector('h3');
        if (panelTitle) {
            panelTitle.textContent = 'Road Proposal Info';
        }
    }
}

async function focusProposalDetails(proposalIdOrHash, options = {}) {
    if (typeof proposalStorage === 'undefined') return false;
    const proposal = getProposalByIdOrHash(proposalIdOrHash);
    if (!proposal) return false;

    const parcelIds = Array.isArray(proposal.parentParcelIds) ? proposal.parentParcelIds : [];
    const fallbackParcelId = options.parcelId || (parcelIds.length > 0 ? parcelIds[0] : null);
    const shouldCenter = options.centerOnProposal !== false;
    const shouldShowDetails = options.showDetails !== false;
    const proposalKey = getProposalKey(proposal) || resolveProposalIdKey(proposalIdOrHash);

    // Open the panel + paint highlights immediately. selectAndHighlightProposal already knows
    // how to derive bounds from metadata (road definition / structure geometry / stored bounds /
    // in-memory ancestors); whatever it can find now, it uses now. As parcels arrive in the
    // background, scheduleHighlightRefresh repaints.
    selectAndHighlightProposal(
        proposalKey,
        fallbackParcelId,
        shouldCenter,
        shouldShowDetails
    );

    // Background hydration. Synthetic descendant IDs are not fetchable; only ask the parcel
    // server for real cadastre parents. Fire-and-forget — never await before returning, so
    // a 3,000-parent proposal opens just as fast as a 3-parent one.
    const synth = (typeof ProposalManager !== 'undefined' && typeof ProposalManager.isSyntheticParcelId === 'function')
        ? ProposalManager.isSyntheticParcelId.bind(ProposalManager)
        : (id) => id && (id.includes('#') || /_[0-9a-f]{4,}_/.test(id) || /^HR-\d+-\d+_[a-z0-9]+_\d+$/i.test(id));
    const realCadastreIds = [...new Set(
        parcelIds.map(id => id?.toString()).filter(id => id && !synth(id))
    )];
    if (realCadastreIds.length > 0 && typeof ensureParentParcelsLoaded === 'function') {
        Promise.resolve()
            .then(() => ensureParentParcelsLoaded(realCadastreIds))
            .catch(error => {
                console.warn('[focusProposalDetails] background parcel hydration failed', error);
            });
    }

    return true;
}

function showProposalInfo(proposal, currentParcelId = null, preserveScrollPosition = null) {
    console.debug('[showProposalInfo] Called', {
        proposalId: proposal?.proposalId,
        proposalId: proposal?.proposalId,
        title: proposal?.title,
        currentParcelId,
        preserveScrollPosition
    });

    const i18nProposal = (typeof window !== 'undefined') ? window.i18n : null;
    const formatProposalString = (template, params = {}) => {
        if (!template) return '';
        return String(template).replace(/\{\{\s*(\w+)\s*\}\}|\{(\w+)\}/g, (match, k1, k2) => {
            const key = k1 || k2;
            return Object.prototype.hasOwnProperty.call(params, key) ? params[key] : match;
        });
    };
    const tProposal = (key, fallback, params = {}) => {
        if (i18nProposal && typeof i18nProposal.t === 'function') {
            const translated = i18nProposal.t(key, params);
            // If translation returns the key itself (meaning translation not found), use fallback
            if (translated && translated !== key) {
                return translated;
            }
        }
        return formatProposalString(fallback, params);
    };

    console.debug('[showProposalInfo] Collapsing sidebar...');
    collapseSidebarIfOpen();
    console.debug('[showProposalInfo] Sidebar collapsed');

    const parcelIds = ensureArrayOfStrings(proposal.parentParcelIds);
    console.debug('[showProposalInfo] Got parcel IDs', { parcelIdsCount: parcelIds.length });

    // Check proposal category for map application controls
    // Ensure we have the full proposal from storage if needed
    // This needs to be done early because we use fullProposal for ancestor parcels
    console.debug('[showProposalInfo] Getting full proposal from storage...');
    let fullProposal = proposal;
    if (proposal.proposalId && typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function') {
        try {
            const stored = proposalStorage.getProposal(proposal.proposalId);
            if (stored) {
                console.debug('[showProposalInfo] Found full proposal in storage');
                fullProposal = stored;
            } else {
                console.debug('[showProposalInfo] Proposal not found in storage, using provided proposal');
            }
        } catch (err) {
            console.warn('[showProposalInfo] Error getting proposal from storage:', err);
        }
    } else {
        console.debug('[showProposalInfo] Storage not available, using provided proposal');
    }

    // Remember which proposal is currently shown in details so downstream actions can use it directly
    currentProposalDetailsContext = fullProposal;

    // PERFORMANCE: Start timing parent parcel processing
    const perfStartParentIds = performance.now();

    // Get parent parcel IDs from proposal (parentParcelIds for road/building proposals)
    // WHY: We need to show which parcels were used to create this proposal in the UI
    // The parent parcels are the ones that were split/merged to create new parcels
    let parentParcelIds = [];
    if (fullProposal.roadProposal) {
        if (Array.isArray(fullProposal.roadProposal.parentParcelIds) && fullProposal.roadProposal.parentParcelIds.length > 0) {
            parentParcelIds = fullProposal.roadProposal.parentParcelIds;
        }
    } else if (fullProposal.buildingProposal) {
        if (Array.isArray(fullProposal.buildingProposal.parentParcelIds) && fullProposal.buildingProposal.parentParcelIds.length > 0) {
            parentParcelIds = fullProposal.buildingProposal.parentParcelIds;
        }
    }

    // If no parent parcel IDs found, fall back to proposal.parentParcelIds (for proposals that haven't been applied yet)
    // But only if the proposal hasn't been applied (no childParcelIds exist)
    if (parentParcelIds.length === 0) {
        const hasChildren = (fullProposal.roadProposal && Array.isArray(fullProposal.roadProposal.childParcelIds) && fullProposal.roadProposal.childParcelIds.length > 0)
            || (fullProposal.buildingProposal && fullProposal.buildingProposal.buildingFeature);

        if (!hasChildren) {
            parentParcelIds = parcelIds;
        }
    }

    const perfEndParentIds = performance.now();
    console.debug('[showProposalInfo] Parent parcel IDs extracted', {
        count: parentParcelIds.length,
        timeMs: (perfEndParentIds - perfStartParentIds).toFixed(2),
        source: fullProposal.roadProposal ? 'roadProposal' : fullProposal.buildingProposal ? 'buildingProposal' : 'parcelIds'
    });

    // Lazy ancestor list: we resolve each row's feature only when its DOM is rendered, so a
    // 700-parent proposal opens just as fast as a 7-parent one. The first batch resolves
    // synchronously to populate the panel, and setupLazyList streams the rest as the user
    // scrolls. parcelDataLoaded → scheduleHighlightRefresh fills in geometry as it arrives.
    const buildAncestorRow = (canonicalIdRaw) => {
        const canonicalId = canonicalIdRaw && canonicalIdRaw.toString ? canonicalIdRaw.toString() : String(canonicalIdRaw || '');
        if (!canonicalId) return null;

        let feature = getCachedParcelFeature(canonicalId, fullProposal);
        let geometry = null;

        if (!feature) {
            try {
                const record = readPersistedParcelRecord(canonicalId);
                if (record && record.geometry && record.properties) {
                    geometry = record.geometry;
                    feature = ensureParcelIdOnFeature({
                        type: 'Feature',
                        properties: record.properties,
                        geometry: {
                            type: 'Polygon',
                            coordinates: [geometry]
                        }
                    });
                }
            } catch (_) { }
        }

        if (!feature) {
            // No data yet — render a stub row that the user can still click. The lazy list
            // will be re-rendered on parcelDataLoaded if scheduleHighlightRefresh promotes it.
            feature = ensureParcelIdOnFeature({
                type: 'Feature',
                properties: { parcelId: canonicalId, BROJ_CESTICE: canonicalId },
                geometry: null
            });
        }

        const isReplaced = (typeof isParcelReplacedByChildren === 'function') ? isParcelReplacedByChildren(canonicalId) : false;
        const isRemoved = isReplaced || !feature.geometry;

        return {
            parcelId: getParcelIdFromFeature(feature) || canonicalId,
            parcel: null,
            feature,
            geometry,
            isRemoved
        };
    };

    const MAX_LIST_INITIAL = 20;
    const perfStartParcelFeatures = performance.now();
    // Resolve only the first batch synchronously. Remaining rows resolve via setupLazyList
    // (string ids → buildAncestorRow on render) so initial open cost is bounded by MAX_LIST_INITIAL,
    // not by parentParcelIds.length.
    const parentParcels = parentParcelIds.slice(0, MAX_LIST_INITIAL).map(buildAncestorRow).filter(Boolean);
    const perfEndParcelFeatures = performance.now();
    console.debug('[showProposalInfo] Initial ancestor batch resolved', {
        totalIds: parentParcelIds.length,
        resolvedNow: parentParcels.length,
        timeMs: (perfEndParcelFeatures - perfStartParcelFeatures).toFixed(2)
    });

    // Total area: sum across whatever we have resolved so far. As parcelDataLoaded fires and
    // more rows hydrate via the lazy list, this number is best-effort — accuracy improves as
    // the user scrolls / panes parcels into view.
    const totalArea = parentParcels.reduce((sum, ap) => {
        const area = ap?.feature?.properties?.calculatedArea;
        if (Number.isFinite(area)) return sum + area;
        return sum;
    }, 0);

    const renderAncestorParcelItem = (parentParcelOrId) => {
        const parentParcel = (typeof parentParcelOrId === 'string')
            ? buildAncestorRow(parentParcelOrId)
            : parentParcelOrId;
        if (!parentParcel) return '';
        const parcelId = parentParcel.parcelId;
        const feature = parentParcel.feature;
        const isRemoved = parentParcel.isRemoved;
        const hasAccepted = proposal.acceptedParcelIds && proposal.acceptedParcelIds.includes(parcelId.toString());

        // Get parcel owner information
        const ownerId = PersistentStorage.getItem(`parcel_${parcelId}_owner`);
        let ownerAvatarHtml = '';

        if (ownerId && typeof agentStorage !== 'undefined') {
            const owner = agentStorage.getAgent(ownerId);
            if (owner && typeof getAvatarImagePath === 'function') {
                ownerAvatarHtml = `<img src="${getAvatarImagePath(owner.avatarIndex)}" class="parcel-owner-avatar" style="width: 24px; height: 24px; border-radius: 50%; border: 2px solid #007bff; margin-right: 8px;" title="Owner: ${owner.name}">`;
            }
        }

        const ownerAcceptanceHtml = (typeof buildOwnerAcceptanceSectionHtml === 'function')
            ? buildOwnerAcceptanceSectionHtml(proposal, parcelId, { compact: true, skipParcelPanelFocus: true })
            : '';

        const parcelNumberDisplay = getParcelDisplayNumberFromProperties(feature?.properties, parcelId);
        const parcelLabelText = tProposal('panel.proposal.parcels.label', 'Parcel {{id}}', { id: parcelNumberDisplay || parcelId });
        const parcelTooltip = isRemoved
            ? tProposal('panel.proposal.parcels.tooltipRemoved', 'Click to focus on where this parcel was')
            : tProposal('panel.proposal.parcels.tooltip', 'Click to view parcel details');
        const acceptedLabel = tProposal('panel.proposal.acceptance.accepted', 'Accepted');
        const pendingLabel = tProposal('panel.proposal.acceptance.pending', 'Pending');
        const removedLabel = tProposal('panel.proposal.parcels.removed', 'Removed');

        // Store geometry data for removed parcels so we can focus on location
        const removedGeometry = isRemoved
            ? (parentParcel.geometry || (feature && feature.geometry) || null)
            : null;
        const geometryDataAttr = removedGeometry
            ? `data-parcel-geometry='${JSON.stringify(removedGeometry)}'`
            : '';
        const removedDataAttr = isRemoved ? 'data-parcel-removed="true"' : '';

        return `
            <div class="proposal-parcel-item" data-parcel-id="${parcelId}" ${removedDataAttr} ${geometryDataAttr} onclick="handleProposalParcelClick('${parcelId}', event)" style="display: flex; flex-direction: column; gap:6px; padding: 8px; border: 1px solid #ddd; margin-bottom: 5px; border-radius: 4px; cursor: pointer; ${hasAccepted ? 'background-color: #f8fff8;' : ''} ${isRemoved ? 'opacity: 0.7;' : ''}" title="${parcelTooltip}">
                <div class="parcel-info" style="display: flex; align-items: center; justify-content: space-between;">
                    <div style="display:flex; align-items:center; gap:8px;">
                        ${ownerAvatarHtml}
                        <div>
                            <span class="parcel-number" style="font-weight: 500;">${parcelLabelText}</span>
                            <span style="margin: 0 4px; color: #999;">·</span>
                            ${isRemoved
                ? `<span class="parcel-status parcel-status-removed" style="color: #999; font-size: 12px; font-style: italic;">${removedLabel}</span>`
                : (hasAccepted ?
                    `<span class="parcel-status parcel-status-accepted" style="color: #28a745; font-size: 12px; font-weight: 500;">✓ ${acceptedLabel}</span>` :
                    `<span class="parcel-status parcel-status-pending" style="color: #666; font-size: 12px;">${pendingLabel}</span>`)
            }
                        </div>
                    </div>
                </div>
                ${ownerAcceptanceHtml ? `<div class="parcel-owner-acceptance" onclick="event.stopPropagation(); event.preventDefault(); return false;">${ownerAcceptanceHtml}</div>` : ''}
            </div>
        `;
    };

    // First batch is already resolved objects; remainder is just IDs which buildAncestorRow
    // will resolve lazily as setupLazyList streams them in on scroll.
    const parentParcelItemsInitial = parentParcels.map(renderAncestorParcelItem).join('');
    const parentParcelItemsRemaining = parentParcelIds.slice(MAX_LIST_INITIAL);

    const renderDescendantItem = (descendant) => {
        const descendantKey = (descendant !== undefined && descendant !== null) ? String(descendant) : '';
        const descendantData = proposalStorage.getProposal(descendantKey);
        if (descendantData) {
            const descendantId = descendantData.proposalId || descendantKey;
            return `<div class="descendant-item" data-descendant-type="proposal" data-proposal-id="${descendantId}" tabindex="0">
                <strong>${descendantData.title}</strong> (${descendantData.type || 'proposal'})
            </div>`;
        }

        let parcelNumber = null;
        let isRoad = false;
        let roadName = null;

        // Prefer cached proposal features to avoid hydrating parcel layers
        const cachedFeature = getCachedParcelFeature(descendantKey);
        if (cachedFeature?.properties) {
            parcelNumber = getParcelDisplayNumberFromProperties(cachedFeature.properties, parcelNumber);
            isRoad = isRoad || !!cachedFeature.properties.isRoad;
            roadName = roadName || cachedFeature.properties.roadName || null;
        }

        if (!parcelNumber) {
            try {
                const record = readPersistedParcelRecord(descendantKey);
                const props = record?.properties;
                if (props) {
                    parcelNumber = getParcelDisplayNumberFromProperties(props, parcelNumber);
                    isRoad = isRoad || !!props.isRoad;
                    roadName = roadName || props.roadName || record?.roadName || null;
                }
            } catch (_) { }
        }

        const label = parcelNumber ? `Parcel ${parcelNumber}` : `Parcel ${descendantKey}`;
        const roadSuffix = isRoad ? (roadName ? ` • Road: ${roadName}` : ' • Road') : '';
        return `<div class="descendant-item" data-descendant-type="parcel" data-parcel-id="${descendantKey}" tabindex="0">
            ${label}${roadSuffix}
        </div>`;
    };

    const descendantKeys = (typeof ProposalManager !== 'undefined')
        ? (ProposalManager._getProposalDescendants(proposal.proposalId) || [])
        : [];
    const descendantItemsInitial = descendantKeys.slice(0, MAX_LIST_INITIAL).map(renderDescendantItem).join('');
    const descendantItemsRemaining = descendantKeys.slice(MAX_LIST_INITIAL);

    // PERFORMANCE: Start timing HTML generation
    const perfStartHtml = performance.now();

    // Determine current parcel - try passed parameter first, then global selectedParcelId
    const tProposalUI = getProposalI18nHelper();
    const ownerAcceptanceSummaryFast = buildProposalOwnerAcceptanceSummaryFast(proposal);

    const proposalDisplayTitle = getProposalDisplayTitle(fullProposal, proposal);

    // Panel header shows the proposal's own name so the collapsed card still says which proposal
    // it is. Read the name fields directly rather than getProposalDisplayTitle() — that helper
    // scores candidates by length and happily returns a parcel label instead of the name.
    const proposalPanelTitle = document.getElementById('proposal-details-title');
    if (proposalPanelTitle) {
        const nameSource = fullProposal || proposal || {};
        const proposalOwnName = [nameSource.title, nameSource.name, nameSource.proposalName]
            .find(candidate => typeof candidate === 'string' && candidate.trim());
        const headerTitle = proposalOwnName
            ? proposalOwnName.trim()
            : tProposal('panel.proposal.title', 'Proposal Details');
        proposalPanelTitle.textContent = headerTitle;
        proposalPanelTitle.title = headerTitle; // tooltip when the name is truncated
    }
    const proposalDisplayTypeRaw = getProposalDisplayTypeLabel(fullProposal, proposal);
    const proposalDisplayType = proposalDisplayTypeRaw
        && proposalDisplayTypeRaw.trim().toLowerCase() !== proposalDisplayTitle.trim().toLowerCase()
        ? proposalDisplayTypeRaw
        : '';
    const proposalDisplayDescription = getProposalDisplayDescription(fullProposal, proposal, proposalDisplayTitle);
    const escapedProposalDisplayTitle = typeof escapeHtml === 'function'
        ? escapeHtml(proposalDisplayTitle)
        : proposalDisplayTitle;
    const escapedProposalDisplayType = proposalDisplayType && typeof escapeHtml === 'function'
        ? escapeHtml(proposalDisplayType)
        : proposalDisplayType;

    const formatAuthorForDisplay = (authorRaw) => {
        const author = authorRaw || '';
        const isHexAddress = author.startsWith('0x') && author.length > 12;
        const isSolanaAddress = !author.startsWith('0x') && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(author);
        const truncated = (isHexAddress || isSolanaAddress)
            ? `${author.slice(0, 6)}...${author.slice(-4)}`
            : author;
        const safeText = typeof escapeHtml === 'function' ? escapeHtml(truncated) : truncated;
        const safeTitle = typeof escapeHtml === 'function' ? escapeHtml(author) : author;
        return `<span class="author-text" style="display: inline-block; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${safeTitle}">${safeText}</span>`;
    };

    const {
        isRoadProposal,
        isBuildingProposal,
        isStructureProposal,
        isReparcellizationProposal,
        supportsMapToggle
    } = computeProposalCategoryFlags(fullProposal, { fallbackProposal: proposal });

    const normalizedTypeForActions = resolveProposalActionTypeKey(fullProposal, proposal);
    // Road proposals should always be able to be applied
    const applyDisabledForType = isRoadProposal ? false : APPLY_DISABLED_TYPE_KEYS.has(normalizedTypeForActions);

    const appliedState = isProposalApplied(fullProposal);
    const activeRoadReplacement = (isRoadProposal && typeof activeRoadSuperseder === 'function')
        ? activeRoadSuperseder(fullProposal, id => (typeof getProposalByIdOrHash === 'function' ? getProposalByIdOrHash(id) : null))
        : null;
    const activeRoadReplacementName = activeRoadReplacement
        ? (activeRoadReplacement.title || activeRoadReplacement.name || activeRoadReplacement.proposalName || activeRoadReplacement.proposalId || 'combined road')
        : null;
    // Check multiple signals for minted state: explicit flag, onchain data, or tokenId-style proposalId
    const isMinted = isProposalMinted(fullProposal);
    const lifecycleKey = getProposalLifecycleKey(fullProposal);
    const statusBadgeClass = getProposalLifecycleClass(lifecycleKey);
    const statusBadgeLabel = getProposalLifecycleLabel(lifecycleKey);
    const mapStatusBadgeClass = appliedState ? 'applied' : 'not-applied';
    const mapStatusBadgeLabel = activeRoadReplacement
        ? tProposal('panel.proposal.mapStatus.includedIn', 'Included in {{name}}', { name: activeRoadReplacementName })
        : (appliedState
            ? tProposal('panel.proposal.mapStatus.applied', 'Applied')
            : tProposal('panel.proposal.mapStatus.notApplied', 'Not Applied'));
    const disbursementModeRaw = (fullProposal.disbursementMode || proposal.disbursementMode || '').toLowerCase();
    const isConditional = fullProposal.isConditional === true || proposal.isConditional === true || disbursementModeRaw === 'conditional';
    const conditionalBadgeClass = isConditional ? 'conditional' : 'partial';
    const conditionalBadgeLabel = isConditional
        ? tProposal('panel.proposal.disbursement.conditional', 'Conditional')
        : tProposal('panel.proposal.disbursement.partial', 'Partial payouts');
    const conditionalBadgeTitle = isConditional
        ? tProposal('panel.proposal.disbursement.conditionalHint', 'All owners must accept before payout')
        : tProposal('panel.proposal.disbursement.partialHint', 'Payout released as each owner accepts');

    const nftInfo = getProposalNftInfo(fullProposal);
    const mintedExplorerUrl = nftInfo ? buildProposalNftExplorerUrl(fullProposal) : null;

    // ENS line for minted proposals (numeric on-chain token id → <id>.proposals.…).
    // Self-gates: proposalEnsName returns '' for non-numeric ids, so drafts show nothing.
    const proposalEnsHtml = (isMinted && nftInfo
        && typeof proposalEnsName === 'function' && typeof ensNameLineHtml === 'function')
        ? ensNameLineHtml(proposalEnsName(nftInfo.tokenId))
        : '';

    // Use stable proposalId only (hash support removed)
    const proposalKey = fullProposal.proposalId
        || proposal.proposalId;
    const hasProposalManager = typeof ProposalManager !== 'undefined'
        && typeof ProposalManager.applyProposal === 'function'
        && typeof ProposalManager.unapplyProposal === 'function';
    const canShowMapActions = !!proposalKey && supportsMapToggle && hasProposalManager;

    let mapActionButtonHtml = '';
    if (canShowMapActions) {
        const isApplyAction = !appliedState;
        const buttonLabel = activeRoadReplacement
            ? tProposal('panel.proposal.actions.includedInRoad', 'Included in combined road')
            : (appliedState
                ? tProposal('panel.proposal.actions.remove', 'Remove from map')
                : tProposal('panel.proposal.actions.apply', 'Apply to map'));
        const iconClass = appliedState ? 'fa-eye-slash' : 'fa-check';
        const isDisabled = isApplyAction && (applyDisabledForType || !!activeRoadReplacement);
        const buttonClass = appliedState
            ? 'btn btn-warning'
            : (isDisabled ? 'btn btn-secondary disabled' : 'btn btn-success');
        const defaultActionClass = (isApplyAction && !isDisabled) ? ' proposal-action-default' : '';
        const defaultActionAttrs = (isApplyAction && !isDisabled)
            ? 'data-default-action="true" aria-keyshortcuts="Enter"'
            : '';
        const handler = appliedState
            ? `removeProposalFromMap('${proposalKey}')`
            : (isDisabled ? null : `applyProposalToMap('${proposalKey}')`);
        const disabledStyle = 'cursor: not-allowed; opacity: 0.55; pointer-events: none; background-color: #d1d5db; border-color: #cbd5e1; color: #555;';
        const enabledStyle = '';
        const replacementTitle = activeRoadReplacement
            ? tProposal('panel.proposal.actions.includedInRoadHint', 'Remove {{name}} from the map to restore this road.', { name: activeRoadReplacementName })
            : '';
        const safeReplacementTitle = replacementTitle && typeof escapeHtml === 'function' ? escapeHtml(replacementTitle) : replacementTitle;
        const disabledAttrs = isDisabled
            ? `disabled aria-disabled="true" ${safeReplacementTitle ? `title="${safeReplacementTitle}"` : ''} style="${disabledStyle}"`
            : (enabledStyle ? `style="${enabledStyle}"` : '');
        const buttonId = `proposal-action-btn-${proposalKey}`;
        mapActionButtonHtml = `
            <button id="${buttonId}" type="button" class="${buttonClass}${defaultActionClass}" ${handler ? `onclick="${handler}"` : ''} ${disabledAttrs} ${defaultActionAttrs}>
                <i class="fas ${iconClass}"></i> ${buttonLabel}
            </button>
        `;
    }

    const shareButtonHtml = `
        <button class="btn btn-outline-primary btn-share-proposal" onclick="shareProposalFromDetails()">
            <i class="fas fa-share-alt"></i> ${tProposal('panel.proposal.actions.share', 'Share Proposal')}
        </button>
    `;

    // Proposals are immutable, so there is no "edit" — you fork into a new, editable draft that
    // points back at this one.
    const copyButtonHtml = proposalKey
        ? `
        <button class="btn btn-outline-secondary btn-copy-proposal" onclick="copyProposalIntoNewProposal('${proposalKey}')">
            <i class="fas fa-clone"></i> ${tProposal('panel.proposal.actions.copy', 'Copy into new proposal')}
        </button>
    `
        : '';

    // A road's cross-section can be reshuffled without moving the road. Applying the edit reopens its
    // geometry in the drawing tool; proposal creation remains a separate, explicit step there.
    const corridorProposal = fullProposal || proposal;
    const corridorButtonHtml = (proposalKey && typeof proposalHasEditableCorridor === 'function' && proposalHasEditableCorridor(corridorProposal))
        ? `
        <button class="btn btn-outline-secondary btn-corridor-profile" onclick="openCorridorProfileEditor('${proposalKey}')">
            <i class="fas fa-road"></i> ${tProposal('panel.proposal.actions.crossSection', 'Cross-section')}
        </button>
    `
        : '';

    const buyOfferProposal = fullProposal || proposal;
    const buyButtonHtml = (typeof isProposalOpenSaleOffer === 'function' && isProposalOpenSaleOffer(buyOfferProposal))
        ? `<button type="button" class="btn btn-success proposal-buy-btn" onclick="claimSaleOffer('${buyOfferProposal.proposalId || ''}')">🤝 ${tProposal('panel.proposal.buy.button', 'Buy')}</button>`
        : '';

    const primaryActionsHtml = `
        <div class="proposal-actions proposal-actions-group">
            ${buyButtonHtml}
            ${mapActionButtonHtml ? mapActionButtonHtml : ''}
            ${shareButtonHtml}
            ${corridorButtonHtml}
            ${copyButtonHtml}
        </div>
    `;

    const escapedProposalDescription = proposalDisplayDescription && typeof escapeHtml === 'function'
        ? escapeHtml(proposalDisplayDescription)
        : proposalDisplayDescription;

    // "Based on <name>" — set when this proposal was forked via "Copy into new proposal". The
    // link jumps to the source; fall back to the stored name if the source is no longer local.
    const copiedFromId = (fullProposal && fullProposal.copiedFromProposalId) || proposal.copiedFromProposalId || null;
    let copiedFromHtml = '';
    if (copiedFromId) {
        const storedName = (fullProposal && fullProposal.copiedFromName) || proposal.copiedFromName || null;
        let sourceLabel = storedName || copiedFromId;
        let sourceExists = false;
        try {
            const sourceProposal = (typeof getProposalByIdOrHash === 'function') ? getProposalByIdOrHash(copiedFromId) : null;
            if (sourceProposal) {
                sourceExists = true;
                sourceLabel = sourceProposal.title || sourceProposal.name || sourceLabel;
            }
        } catch (_) { }
        const safeLabel = typeof escapeHtml === 'function' ? escapeHtml(String(sourceLabel)) : String(sourceLabel);
        const safeId = typeof escapeHtml === 'function' ? escapeHtml(String(copiedFromId)) : String(copiedFromId);
        const basedOnLabel = tProposal('panel.proposal.basedOn', 'Based on');
        const inner = sourceExists
            ? `<a href="#" class="proposal-based-on-link" onclick="event.preventDefault(); focusProposalDetails('${safeId}');">${safeLabel} <i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i></a>`
            : `<span class="proposal-based-on-name">${safeLabel}</span>`;
        copiedFromHtml = `<div class="proposal-based-on-row">${basedOnLabel}: ${inner}</div>`;
    }

    const proposalDisplayId = proposal.proposalId ? String(proposal.proposalId) : null;

    const escapedProposalDisplayId = proposalDisplayId && typeof escapeHtml === 'function'
        ? escapeHtml(proposalDisplayId)
        : proposalDisplayId;
    const proposalLensEntries = getProposalLensEntries(fullProposal || proposal);
    const hasProposalLens = proposalLensEntries.length > 0;
    const lensPatternUrl = hasProposalLens && typeof getLensPatternDataUrl === 'function'
        ? getLensPatternDataUrl(proposalLensEntries)
        : null;
    const translateLensKey = (key, fallback) => {
        if (i18nProposal && typeof i18nProposal.t === 'function') {
            const value = i18nProposal.t(key);
            if (value && value !== key) return value;
        }
        return fallback;
    };
    const lensButtonLabel = translateLensKey('modal.lens.proposalTriggerTitle', 'View proposal lens');
    const safeLensButtonLabel = typeof escapeHtml === 'function' ? escapeHtml(lensButtonLabel) : lensButtonLabel;
    const lensProposalId = fullProposal.proposalId || proposal.proposalId || '';
    const lensButtonHtml = hasProposalLens ? `
        <button type="button"
            class="lens-pattern-button proposal-lens-button"
            onclick="openProposalLens('${lensProposalId}')"
            title="${safeLensButtonLabel}"
            aria-label="${safeLensButtonLabel}"
            ${lensPatternUrl ? `style="background-image: url(&quot;${lensPatternUrl}&quot;);"` : ''}>
            👓
        </button>
    ` : `
        <button type="button"
            class="lens-pattern-button proposal-lens-button proposal-lens-button--empty"
            title="${safeLensButtonLabel}"
            aria-label="${safeLensButtonLabel}"
            disabled>
            👓
        </button>
    `;

    // Build expiry countdown HTML if proposal has an expiry set and is not executed
    let expiryCountdownHtml = '';
    const proposalStatus = (proposal.status || '').toLowerCase();
    if (proposal.expiresAt && proposalStatus !== 'executed') {
        const expiresAt = new Date(proposal.expiresAt).getTime();
        const now = Date.now();
        const isExpired = expiresAt <= now;

        if (isExpired) {
            expiryCountdownHtml = `
                <div class="proposal-expiry-countdown expired" style="background: #f8d7da; border: 1px solid #f5c6cb; padding: 10px; border-radius: 6px; margin-bottom: 10px; text-align: center;">
                    <i class="fas fa-clock" style="margin-right: 6px;"></i>
                    <span class="expiry-label" style="color: #721c24; font-weight: 600;">${tProposal('panel.proposal.expiry.expired', 'Proposal Expired')}</span>
                </div>
            `;
        } else {
            expiryCountdownHtml = `
                <div class="proposal-expiry-countdown" data-expires-at="${proposal.expiresAt}" data-proposal-id="${proposal.proposalId}" style="background: #fff3cd; border: 1px solid #ffeaa8; padding: 10px; border-radius: 6px; margin-bottom: 10px; text-align: center;">
                    <i class="fas fa-hourglass-half" style="margin-right: 6px; color: #856404;"></i>
                    <span class="expiry-label" style="color: #856404; font-weight: 500;">${tProposal('panel.proposal.expiry.countdown', 'Expires in:')} </span>
                    <span class="expiry-timer" style="color: #856404; font-weight: 700; font-family: monospace;"></span>
                </div>
            `;
        }
    }

    const acceptanceLoadingLabel = tProposal('panel.proposal.rendering', 'Loading...');
    const parcelAcceptanceLabel = tProposalUI('panel.proposal.acceptance.parcelTitle', 'Parcel Acceptance Status:');
    const ownerAcceptanceLabel = tProposalUI('panel.proposal.acceptance.ownerTitle', 'Owner Acceptance Status:');
    const acceptanceSpinnerHtml = `
        <div class="acceptance-loading" style="display: inline-flex; align-items: center; gap: 8px; color: #666; font-size: 12px; margin: 6px 0;">
            <div class="spinner-circle" aria-hidden="true" style="width: 16px; height: 16px; border: 2px solid #ccc; border-top-color: #555; border-radius: 50%; animation: spin 0.8s linear infinite;"></div>
            <span>${acceptanceLoadingLabel}</span>
        </div>`;
    const parcelAcceptancePlaceholder = `
        <div class="proposal-acceptance-status placeholder" id="proposal-parcel-acceptance-section">
            <div class="acceptance-label">${parcelAcceptanceLabel}</div>
            ${acceptanceSpinnerHtml}
        </div>`;
    const ownerAcceptancePlaceholder = `
        <div class="proposal-acceptance-status owner placeholder" id="proposal-owner-acceptance-section">
            <div class="acceptance-label">${ownerAcceptanceLabel}</div>
            ${acceptanceSpinnerHtml}
        </div>`;

    const createdAtLabel = fullProposal.createdAt
        ? new Date(fullProposal.createdAt).toLocaleString(undefined, {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        })
        : '—';

    const content = `
        <div class="proposal-info">
            ${expiryCountdownHtml}
            <div class="proposal-badges-row" style="display: flex; justify-content: center; align-items: center; gap: 6px; margin: 10px 0;">
                <div class="proposal-status ${statusBadgeClass}">${statusBadgeLabel}</div>
                <div class="proposal-application-status ${mapStatusBadgeClass}">
                    ${mapStatusBadgeLabel}
                </div>
                <div class="proposal-conditionality ${conditionalBadgeClass}" title="${conditionalBadgeTitle}">
                    ${conditionalBadgeLabel}
                </div>
                ${(() => {
            const label = isMinted
                ? tProposal('panel.proposal.lifecycle.minted', 'Minted')
                : tProposal('panel.proposal.lifecycle.inMemory', 'In-memory');
            const baseClasses = 'proposal-mint-state' + (isMinted ? ' is-minted minted-glow' : ' is-local');
            const style = `display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; border-radius: 10px; font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; color: ${isMinted ? '#065f46' : '#7a6000'}; background: ${isMinted ? '#d1fae5' : '#fff7d6'}; border: 1px solid ${isMinted ? '#34d399' : '#ffe08a'}; text-decoration: none; cursor: ${mintedExplorerUrl ? 'pointer' : 'default'};`;
            if (isMinted && mintedExplorerUrl) {
                return `<a class="${baseClasses}" style="${style}" href="${mintedExplorerUrl}" target="_blank" rel="noopener" title="${tProposal('panel.proposal.lifecycle.viewOnExplorer', 'View on explorer')}">${label}</a>`;
            }
            return `<div class="${baseClasses}" style="${style}" title="${isMinted ? tProposal('panel.proposal.lifecycle.mintedHint', 'Minted on-chain') : ''}">${label}</div>`;
        })()}
            </div>
            <div class="proposal-heading-row" style="text-align: center; margin: 10px 0 6px; padding: 0 10px;">
                <div class="proposal-display-title" style="font-size: 20px; font-weight: 700; line-height: 1.25;">${escapedProposalDisplayTitle}</div>
                ${escapedProposalDisplayType ? `<div class="proposal-display-type" style="font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #666; margin-top: 4px;">${escapedProposalDisplayType}</div>` : ''}
            </div>
            <div class="proposal-description-row" style="text-align: center; margin: 6px 0 10px; padding: 0 10px;">
                ${escapedProposalDescription ? `<div class="proposal-description-text" style="margin-bottom: 6px;">${escapedProposalDescription}</div>` : ''}
                ${copiedFromHtml}
                ${escapedProposalDisplayId ? `<div class="proposal-id-row">
                    <div class="proposal-id-label" style="font-size: 12px; color: #666;">ID: ${escapedProposalDisplayId}</div>
                    ${lensButtonHtml}
                </div>` : ''}
                ${proposalEnsHtml ? `<div class="proposal-ens-row" style="text-align: center; margin-top: 4px;">${proposalEnsHtml}</div>` : ''}
            </div>
            ${parcelAcceptancePlaceholder}
            ${ownerAcceptancePlaceholder}

            <hr style="border: 0; height: 1px; background-color: #ddd; margin: 15px 0;">
            <div class="metric-group">
                <div class="metric-label">${tProposal('panel.proposal.metrics.author', 'Author:')}</div>
                <div class="metric-value author-with-avatar">
                    ${(() => {
            // Find the agent with matching name
            if (typeof agentStorage !== 'undefined') {
                const agents = agentStorage.getAllAgents();
                const agent = agents.find(a => a.name === proposal.author);
                if (agent && typeof getAvatarImagePath === 'function') {
                    return `
                                        <img src="${getAvatarImagePath(agent.avatarIndex)}" class="author-avatar" style="width: 24px; height: 24px; border-radius: 50%; border: 2px solid #007bff; margin-right: 8px; vertical-align: middle;">
                                        <a href="#" data-agent-id="${agent.id}" class="agent-link agent-link-clickable" style="text-decoration: none; color: #007bff; font-weight: 500;">${formatAuthorForDisplay(proposal.author)}</a>
                                    `;
                }
            }
            return formatAuthorForDisplay(proposal.author);
        })()}
                </div>
            </div>
            ${proposal.offer ? (() => {
            const currentOffer = typeof calculateDecayedOffer === 'function' ? calculateDecayedOffer(proposal) : proposal.offer;
            const decayProgress = proposal.decayEnabled && typeof getDecayProgress === 'function' ? getDecayProgress(proposal) : 0;
            const hasDecay = proposal.decayEnabled && proposal.decayPercent > 0 && proposal.decayDurationMs > 0;
            const decayedPercent = hasDecay ? (proposal.decayPercent * decayProgress) : 0;
            const remainingPercent = 100 - decayedPercent;
            const targetPercent = hasDecay ? (100 - proposal.decayPercent) : 100;
            const currencySymbol = proposal.offerCurrency === 'EUR' ? '€' : '';
            const currencySuffix = proposal.offerCurrency && proposal.offerCurrency !== 'EUR' ? ' ' + proposal.offerCurrency : '';
            const originalAmountText = tProposal('panel.proposal.metrics.offerOriginal', '(was {{amount}})', {
                amount: `${currencySymbol}${proposal.offer.toLocaleString('hr-HR')}${currencySuffix}`
            });

            // Deposit indicator - bars inside offer bar, warning text only if no deposit
            const hasDeposit = proposal.depositEnabled && proposal.depositPercent > 0;
            const depositPercent = hasDeposit ? proposal.depositPercent : 0;

            // Generate deposit bars HTML (to go inside offer bar)
            let depositBarsHtml = '';
            if (hasDeposit) {
                const fullRows = Math.floor(depositPercent / 100);
                const partialPercent = depositPercent % 100;

                for (let i = 0; i < fullRows; i++) {
                    depositBarsHtml += `<div class="deposit-bar-row"><div class="deposit-bar-fill" style="width: 100%;"></div></div>`;
                }
                if (partialPercent > 0 || fullRows === 0) {
                    depositBarsHtml += `<div class="deposit-bar-row"><div class="deposit-bar-fill${fullRows > 0 ? ' overflow' : ''}" style="width: ${partialPercent || depositPercent}%;"></div></div>`;
                }
            }

            // Warning text only shown when no deposit
            const noDepositWarningHtml = !hasDeposit ? `
            <div class="proposal-no-deposit-warning">⚠️ ${tProposal('panel.proposal.offer.noDepositWarning', 'No deposit - proposal not backed by funds')}</div>` : '';
            const boostLabel = tProposal('panel.proposal.boost.buttonLabel', 'Boost this proposal');

            // Check if this is an ownership-transfer-from-me proposal
            const isFromMeProposal = resolveProposalGoalKey(proposal, null) === 'ownership-transfer-from-me';
            const acceptTransferLabel = tProposal('panel.proposal.acceptTransfer.buttonLabel', 'Accept ownership transfer');
            const acceptTransferButtonHtml = isFromMeProposal
                ? `<button type="button" class="offer-boost-button" title="${acceptTransferLabel}" aria-label="${acceptTransferLabel}" onclick="openAcceptOwnershipTransferDialog('${proposal.proposalId || ''}')">🤝</button>`
                : '';

            if (hasDecay) {
                return `
            <div class="proposal-offer-bar with-decay${hasDeposit ? ' with-deposit' : ''}" data-proposal-id="${proposal.proposalId || ''}" data-original-offer="${proposal.offer}" data-decay-percent="${proposal.decayPercent}" data-decay-duration="${proposal.decayDurationMs}" data-created-at="${proposal.createdAt}">
                <div class="offer-bar-background">
                    <div class="offer-bar-remaining" style="width: ${remainingPercent}%;"></div>
                    <div class="offer-bar-decayed" style="width: ${decayedPercent}%;"></div>
                    <div class="offer-bar-target-line" style="left: ${targetPercent}%;"></div>
                </div>
                <div class="offer-bar-content">
                    <div class="offer-bar-main">
                        <span class="offer-label">${tProposal('panel.proposal.metrics.offer', 'Offer:')}</span>
                        <span class="offer-amount decaying">${currencySymbol}${Math.round(currentOffer).toLocaleString('hr-HR')}${currencySuffix}</span>
                        <span class="offer-original">${originalAmountText}</span>
                    </div>
                    ${acceptTransferButtonHtml}
                    <button type="button" class="offer-boost-button" title="${boostLabel}" aria-label="${boostLabel}" onclick="openProposalBoostDialog('${proposal.proposalId || proposal.proposalId || ''}')">💪</button>
                </div>
                ${hasDeposit ? `<div class="offer-bar-deposit-container">${depositBarsHtml}</div>` : ''}
            </div>${noDepositWarningHtml}`;
            } else {
                return `
            <div class="proposal-offer-bar${hasDeposit ? ' with-deposit' : ''}">
                <div class="offer-bar-content-simple">
                    <div class="offer-bar-main">
                        <span class="offer-label">${tProposal('panel.proposal.metrics.offer', 'Offer:')}</span>
                        <span class="offer-amount">${currencySymbol}${proposal.offer.toLocaleString('hr-HR')}${currencySuffix}</span>
                    </div>
                    ${acceptTransferButtonHtml}
                    <button type="button" class="offer-boost-button" title="${boostLabel}" aria-label="${boostLabel}" onclick="openProposalBoostDialog('${proposal.proposalId || proposal.proposalId || ''}')">💪</button>
                </div>
                ${hasDeposit ? `<div class="offer-bar-deposit-container">${depositBarsHtml}</div>` : ''}
            </div>${noDepositWarningHtml}`;
            }
        })() : ''}
            <div class="metric-group">
                <span class="metric-label">${tProposal('panel.proposal.metrics.parcels', 'Parcels in Proposal:')}</span> <span class="metric-value">${proposal.parentParcelIds.length}</span>
            </div>
            <div class="metric-group">
                <span class="metric-label">${tProposal('panel.proposal.metrics.owners', 'Owners in Proposal:')}</span> <span class="metric-value">${(() => {
            // For road/track proposals, use individualOwners from ownershipAndAcquisitionStats if available
            // This is more accurate than counting ownerAcceptance entries which may not be populated
            const roadProposal = fullProposal.roadProposal || proposal.roadProposal;
            const stats = roadProposal?.definition?.metadata?.ownershipAndAcquisitionStats ||
                fullProposal.ownershipAndAcquisitionStats ||
                proposal.ownershipAndAcquisitionStats;
            if (stats && stats.individualOwners !== null && stats.individualOwners !== undefined) {
                return stats.individualOwners;
            }
            // Fallback to owner acceptance count if stats not available
            return ownerAcceptanceSummaryFast.totalOwners;
        })()}</span>
            </div>
            <div class="metric-group">
                <span class="metric-label">${tProposal('panel.proposal.metrics.area', 'Total Area:')}</span> <span class="metric-value">${Math.round(totalArea).toLocaleString('hr-HR')} m²</span>
            </div>
            <div class="metric-group">
                <span class="metric-label">${tProposal('panel.proposal.metrics.created', 'Created:')}</span> <span class="metric-value">${createdAtLabel}</span>
            </div>
            <hr style="border: 0; height: 1px; background-color: #ddd; margin: 10px 0;">
            ${parentParcelIds.length > 0 ? `
            <div class="metric-group">
                <div class="metric-label-count-container">
                    <span class="metric-label">${tProposal('panel.proposal.sections.ancestorsParcels', 'Parents (Parcels):')}</span> <span class="metric-value">${parentParcelIds.length}</span>
                </div>
                <div class="proposal-parcels-list" id="proposal-parent-parcels-list" style="max-height: 420px; overflow-y: auto;">
                    ${parentParcelItemsInitial}
                </div>
            </div>
            ` : `
            <div class="metric-group">
                <span class="metric-label">${tProposal('panel.proposal.sections.ancestorsParcels', 'Ancestors (Parcels):')}</span> <span class="metric-value">0</span>
            </div>
            `}
            
            <!-- Ancestors (Proposals) Section -->
            <div class="metric-group" id="proposal-ancestors-proposals-section">
                <div class="metric-label">${tProposal('panel.proposal.sections.ancestorsProposals', 'Ancestors (Proposals):')}</div>
                <div class="metric-value" id="proposal-ancestors-proposals-content">Loading...</div>
            </div>
            
            <!-- Descendants Section -->
            ${(() => {
            if (typeof ProposalManager !== 'undefined') {
                if (descendantKeys.length > 0) {
                    return `
            <div class="metric-group">
                <div class="metric-label-count-container">
                    <span class="metric-label">${tProposal('panel.proposal.sections.descendantsParcels', 'Descendants (parcels):')}</span> <span class="metric-value">${descendantKeys.length}</span>
                </div>
                <div class="proposal-descendants-list" id="proposal-descendants-list" style="max-height: 420px; overflow-y: auto;">
                    ${descendantItemsInitial}
                </div>
            </div>`;
                } else {
                    return `
            <div class="metric-group">
                <span class="metric-label">${tProposal('panel.proposal.sections.descendantsParcels', 'Descendants (parcels):')}</span> <span class="metric-value">0</span>
            </div>`;
                }
            }
            return `
            <div class="metric-group">
                <span class="metric-label">${tProposal('panel.proposal.sections.descendantsParcels', 'Descendants (parcels):')}</span> <span class="metric-value">0</span>
            </div>`;
        })()}
            
            <!-- Ownership & Acquisition Stats Section -->
            ${(() => {
            // Check if proposal has ownershipAndAcquisitionStats
            const roadProposal = fullProposal.roadProposal || proposal.roadProposal;
            const stats = roadProposal?.definition?.metadata?.ownershipAndAcquisitionStats ||
                fullProposal.ownershipAndAcquisitionStats ||
                proposal.ownershipAndAcquisitionStats;

            if (!stats) {
                return '';
            }

            const statsItems = [];

            if (stats.individualOwners !== null && stats.individualOwners !== undefined) {
                statsItems.push(`
                    <div class="metric-group">
                        <span class="metric-label">${tProposal('panel.proposal.stats.individualOwners', 'Individual Owners:')}</span>
                        <span class="metric-value">${stats.individualOwners}</span>
                    </div>
                `);
            }
            if (stats.ownershipCounts) {
                if (stats.ownershipCounts.individual !== null && stats.ownershipCounts.individual !== undefined) {
                    statsItems.push(`
                        <div class="metric-group">
                            <span class="metric-label">${tProposal('panel.proposal.stats.ownedByIndividuals', 'Owned by Individuals:')}</span>
                            <span class="metric-value">${stats.ownershipCounts.individual}</span>
                        </div>
                    `);
                }
                if (stats.ownershipCounts.company !== null && stats.ownershipCounts.company !== undefined) {
                    statsItems.push(`
                        <div class="metric-group">
                            <span class="metric-label">${tProposal('panel.proposal.stats.ownedByCompanies', 'Owned by Companies:')}</span>
                            <span class="metric-value">${stats.ownershipCounts.company}</span>
                        </div>
                    `);
                }
                if (stats.ownershipCounts.government !== null && stats.ownershipCounts.government !== undefined) {
                    statsItems.push(`
                        <div class="metric-group">
                            <span class="metric-label">${tProposal('panel.proposal.stats.ownedByGovernment', 'Owned by Government:')}</span>
                            <span class="metric-value">${stats.ownershipCounts.government}</span>
                        </div>
                    `);
                }
                if (stats.ownershipCounts.institution !== null && stats.ownershipCounts.institution !== undefined) {
                    statsItems.push(`
                        <div class="metric-group">
                            <span class="metric-label">${tProposal('panel.proposal.stats.ownedByInstitution', 'Owned by Institution:')}</span>
                            <span class="metric-value">${stats.ownershipCounts.institution}</span>
                        </div>
                    `);
                }
                if (stats.ownershipCounts.mixed !== null && stats.ownershipCounts.mixed !== undefined) {
                    statsItems.push(`
                        <div class="metric-group">
                            <span class="metric-label">${tProposal('panel.proposal.stats.ownershipMixed', 'Ownership Mixed:')}</span>
                            <span class="metric-value">${stats.ownershipCounts.mixed}</span>
                        </div>
                    `);
                }
            }
            if (stats.totalMarketPrice !== null && stats.totalMarketPrice !== undefined) {
                statsItems.push(`
                    <div class="metric-group">
                        <span class="metric-label">${tProposal('panel.proposal.stats.totalMarketPrice', 'Total Market Price:')}</span>
                        <span class="metric-value">${Math.round(stats.totalMarketPrice).toLocaleString('hr-HR')} EUR</span>
                    </div>
                `);
            }
            if (stats.totalAcquiringDifficulty !== null && stats.totalAcquiringDifficulty !== undefined) {
                statsItems.push(`
                    <div class="metric-group">
                        <span class="metric-label">${tProposal('panel.proposal.stats.totalAcquiringDifficulty', 'Total Acquiring Difficulty:')}</span>
                        <span class="metric-value">${Math.round(stats.totalAcquiringDifficulty).toLocaleString('hr-HR')}</span>
                    </div>
                `);
            }

            if (statsItems.length === 0) {
                return '';
            }

            return `
            <hr style="border: 0; height: 1px; background-color: #ddd; margin: 15px 0;">
            <div class="metric-group">
                <div class="metric-label" style="font-weight: 600; margin-bottom: 10px;">${tProposal('panel.proposal.sections.ownershipStats', 'Ownership & Acquisition Stats')}</div>
            </div>
            ${statsItems.join('')}
            `;
        })()}
        </div>
    `;

    const perfEndHtml = performance.now();
    console.debug('[showProposalInfo] HTML content generated', {
        timeMs: (perfEndHtml - perfStartHtml).toFixed(2),
        htmlLength: content.length,
        note: 'HTML includes proposal metadata, ancestor parcels list, owner acceptance status, etc.'
    });

    // Preserve scroll/anchor before the DOM rewrite
    const panel = document.getElementById('proposal-details-panel');
    const panelBody = panel ? panel.querySelector('.panel-body') : null;
    let preservedScrollTop = panelBody ? panelBody.scrollTop : 0;
    let anchorKey = null;
    let anchorOffset = null;

    if (preserveScrollPosition && typeof preserveScrollPosition === 'object') {
        if (typeof preserveScrollPosition.scrollTop === 'number') {
            preservedScrollTop = preserveScrollPosition.scrollTop;
        }
        if (typeof preserveScrollPosition.anchorKey === 'string') {
            anchorKey = preserveScrollPosition.anchorKey;
        }
        if (typeof preserveScrollPosition.anchorOffset === 'number') {
            anchorOffset = preserveScrollPosition.anchorOffset;
        }
    } else if (typeof preserveScrollPosition === 'number') {
        preservedScrollTop = preserveScrollPosition;
    }

    // Show loading spinner briefly while rendering (for large proposals)
    // WHY HTML: The HTML string contains the entire proposal details UI:
    //   - Proposal metadata (title, description, author, dates)
    //   - Status badges (applied, minted, conditional, etc.)
    //   - Offer/decay visualization
    //   - Owner acceptance status
    //   - List of all ancestor parcels with their details (parcel numbers, owners, acceptance status)
    //   - Ancestors/descendants proposals
    //   - Ownership & acquisition stats
    // This HTML is inserted into #proposal-details-content to display the proposal info panel
    console.debug('[showProposalInfo] Getting proposal details content element...', { parcelIdsCount: parcelIds.length });
    const detailsContent = document.getElementById('proposal-details-content');
    function populateAcceptanceSectionsAsync(proposalForStatus, precomputedOwnerSummary) {
        const parcelContainer = document.getElementById('proposal-parcel-acceptance-section');
        const ownerContainer = document.getElementById('proposal-owner-acceptance-section');
        if (!parcelContainer && !ownerContainer) return;

        const doWork = () => {
            const parcelStart = performance.now();
            if (parcelContainer) {
                const parcelHtml = buildParcelAcceptanceStatusHtml(proposalForStatus);
                parcelContainer.innerHTML = parcelHtml || '';
            }
            const parcelAcceptanceMs = (performance.now() - parcelStart).toFixed(2);

            const ownerStart = performance.now();
            let ownerSummary = precomputedOwnerSummary || buildProposalOwnerAcceptanceSummaryFast(proposalForStatus);
            if (!ownerSummary || ownerSummary.totalOwners === 0) {
                ownerSummary = buildProposalOwnerAcceptanceSummary(proposalForStatus);
            }
            if (ownerContainer) {
                const ownerHtml = buildOwnerAcceptanceStatusHtml(proposalForStatus, ownerSummary);
                ownerContainer.innerHTML = ownerHtml || '';
            }
            const ownerAcceptanceMs = (performance.now() - ownerStart).toFixed(2);

            console.info('[showProposalInfo] Acceptance async render', {
                ownerAcceptanceMs,
                ownerCount: ownerSummary?.totalOwners || 0,
                parcelAcceptanceMs,
                parcelCount: Array.isArray(proposalForStatus?.parentParcelIds) ? proposalForStatus.parentParcelIds.length : 0
            });
        };

        // Let the panel paint first, then populate acceptance sections
        requestAnimationFrame(() => setTimeout(doWork, 0));
    }

    const runPostRender = () => {
        // Lazy append remaining ancestor parcels
        setupLazyList('proposal-parent-parcels-list', parentParcelItemsRemaining, renderAncestorParcelItem);
        // Lazy append remaining descendant parcels
        setupLazyList('proposal-descendants-list', descendantItemsRemaining, renderDescendantItem);
        // Render ancestor proposals list (after DOM exists)
        renderAncestorsProposalsSection();
        // Populate acceptance sections asynchronously to avoid blocking panel open
        populateAcceptanceSectionsAsync(fullProposal || proposal, ownerAcceptanceSummaryFast);
    };

    if (detailsContent && parcelIds.length > 20) {
        console.debug('[showProposalInfo] Large proposal detected, showing loading spinner first...');
        // Only show spinner for proposals with many parcels
        const loadingText = tProposal('panel.proposal.rendering', 'Rendering proposal details...');
        detailsContent.innerHTML = `
            <div class="loader-spinner" role="status" aria-live="polite" style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px; min-height: 200px;">
                <div class="spinner-circle" aria-hidden="true"></div>
                <span class="loader-text" style="margin-top: 16px; color: #666;">${loadingText}</span>
            </div>
        `;
        console.debug('[showProposalInfo] Loading spinner set, scheduling content render...');

        // Defer heavy DOM insertion and chunk it across animation frames
        setTimeout(() => {
            console.debug('[showProposalInfo] Rendering proposal content (large proposal) in chunks...');
            if (!detailsContent) return;

            const container = document.createElement('div');
            container.innerHTML = content;
            const nodes = Array.from(container.childNodes);
            detailsContent.innerHTML = '';

            const chunkSize = 50;
            let index = 0;

            const appendChunk = () => {
                const frag = document.createDocumentFragment();
                for (let i = 0; i < chunkSize && index < nodes.length; i++, index++) {
                    frag.appendChild(nodes[index]);
                }
                detailsContent.appendChild(frag);
                if (index < nodes.length) {
                    requestAnimationFrame(appendChunk);
                } else {
                    console.debug('[showProposalInfo] Proposal content rendered to DOM');
                    runPostRender();
                }
            };

            requestAnimationFrame(appendChunk);
        }, 0);
    } else {
        console.debug('[showProposalInfo] Rendering proposal content directly (small proposal or no spinner needed)...');
        // Set innerHTML which resets scroll to 0
        if (detailsContent) {
            detailsContent.innerHTML = content;
            console.debug('[showProposalInfo] Proposal content rendered to DOM');
            runPostRender();
        } else {
            console.warn('[showProposalInfo] Proposal details content element not found');
        }
    }

    // Populate footer with action buttons
    const footer = document.getElementById('proposal-details-footer');
    if (footer) {
        footer.innerHTML = primaryActionsHtml;
        const defaultActionButton = footer.querySelector('.proposal-action-default');
        if (defaultActionButton && typeof defaultActionButton.focus === 'function' && !defaultActionButton.disabled) {
            requestAnimationFrame(() => {
                defaultActionButton.focus({ preventScroll: true });
            });
        }
    }

    // Ensure lens pattern is applied after render when lens exists
    try {
        if (hasProposalLens) {
            const btn = document.querySelector('#proposal-details-content .proposal-lens-button');
            if (btn) {
                applyLensPatternToButton(btn, proposalLensEntries);
            }
        }
    } catch (err) {
        console.warn('post-render lens pattern apply failed', err);
    }

    // If lens missing but on-chain, attempt a lazy fetch to hydrate and repaint the button
    (async () => {
        try {
            if (!hasProposalLens && fullProposal && fullProposal.onchain && fullProposal.onchain.proposalId) {
                const fetchedLens = await fetchLensFromChain(fullProposal);
                if (fetchedLens && fetchedLens.length) {
                    fullProposal.lens = fetchedLens;
                    if (typeof proposalStorage !== 'undefined' && typeof proposalStorage._indexProposal === 'function') {
                        proposalStorage._indexProposal(fullProposal);
                        if (typeof proposalStorage.save === 'function') proposalStorage.save();
                    }
                    const btn = document.querySelector('#proposal-details-content .proposal-lens-button');
                    if (btn) {
                        applyLensPatternToButton(btn, fetchedLens);
                        btn.classList.remove('proposal-lens-button--empty');
                        btn.disabled = false;
                        btn.onclick = () => openProposalLens(lensProposalId);
                    }
                }
            }
        } catch (err) {
            console.warn('lazy lens hydration failed', err);
        }
    })();

    // Lazily hydrate on-chain proposal metadata so synced/minted proposals recover their real title/type.
    (async () => {
        try {
            const hadMetadata = !!(
                (fullProposal && fullProposal.metadata && Object.keys(fullProposal.metadata).length)
                || (fullProposal && fullProposal.onchain && fullProposal.onchain.metadata && Object.keys(fullProposal.onchain.metadata).length)
            );
            if (hadMetadata) return;

            const refreshedProposal = await ensureProposalMetadataLoaded(fullProposal);
            if (!refreshedProposal) return;

            const currentDetailsKey = currentProposalDetailsContext
                ? (getProposalKey(currentProposalDetailsContext) || currentProposalDetailsContext.proposalId || null)
                : null;
            const refreshedKey = getProposalKey(refreshedProposal) || refreshedProposal.proposalId || null;
            if (!currentDetailsKey || !refreshedKey || currentDetailsKey !== refreshedKey) {
                return;
            }

            const panelBodyCurrent = panel ? panel.querySelector('.panel-body') : null;
            const scrollTop = panelBodyCurrent ? panelBodyCurrent.scrollTop : preservedScrollTop;
            showProposalInfo(refreshedProposal, currentParcelId, scrollTop);
        } catch (err) {
            console.warn('lazy proposal metadata hydration failed', err);
        }
    })();

    function renderAncestorsProposalsSection() {
        try {
            const ancestorsSection = document.getElementById('proposal-ancestors-proposals-section');
            const ancestorsContent = document.getElementById('proposal-ancestors-proposals-content');
            if (!ancestorsSection || !ancestorsContent) return false;

            // Fast path: derive ancestors from in-memory parentParcels (already built above) to avoid
            // reading/parsing persisted parcel records.
            const ancestorsSet = new Set();
            if (Array.isArray(parentParcels) && parentParcels.length > 0) {
                parentParcels.forEach(ap => {
                    const anc = ap?.feature?.properties?.ancestorProposal;
                    if (anc) ancestorsSet.add(String(anc));
                });
            }

            // Backup: consult persisted parcel records for ancestorProposal linkage without hydrating layers.
            // Cap the scan at MAX_LIST_INITIAL — this is a best-effort detection used to render a small
            // ancestors section, not a correctness invariant. For very large proposals we sample the first
            // batch and accept that the section may need a refresh after later rows are scrolled into view.
            if (ancestorsSet.size === 0 && Array.isArray(parentParcelIds) && parentParcelIds.length > 0) {
                const cap = Math.min(parentParcelIds.length, MAX_LIST_INITIAL);
                for (let i = 0; i < cap; i++) {
                    try {
                        const record = readPersistedParcelRecord(parentParcelIds[i]);
                        const anc = record?.properties?.ancestorProposal;
                        if (anc) ancestorsSet.add(String(anc));
                    } catch (_) { }
                }
            }

            // Fallback: query ProposalManager for ancestor linkage using parcel IDs
            if (ancestorsSet.size === 0 && typeof ProposalManager !== 'undefined') {
                const parcelsToCheck = (fullProposal.roadProposal && Array.isArray(parentParcelIds) && parentParcelIds.length > 0)
                    ? parentParcelIds
                    : proposal.parentParcelIds;

                parcelsToCheck.forEach(parcelId => {
                    const parcelAncestors = ProposalManager._getParcelAncestors(parcelId);
                    parcelAncestors.forEach(ancestorHash => {
                        ancestorsSet.add(String(ancestorHash));
                    });
                });
            }

            const ancestors = Array.from(ancestorsSet);

            if (ancestors.length > 0) {
                const ancestorsHtml = ancestors.map(ancestorId => {
                    const ancestorData = proposalStorage.getProposal(ancestorId);
                    if (ancestorData) {
                        return `<div class="ancestor-item" data-proposal-id="${ancestorData.proposalId || ancestorId}" tabindex="0" style="padding: 5px; border: 1px solid #ddd; margin: 2px 0; border-radius: 3px; cursor: pointer;">
                            <strong>${ancestorData.title}</strong> (${ancestorData.type || 'proposal'})
                        </div>`;
                    }
                    return null;
                }).filter(Boolean).join('');

                ancestorsSection.innerHTML = `
                    <div class="metric-label">${tProposal('panel.proposal.sections.ancestorsProposals', 'Ancestors (Proposals):')}</div>
                    <div class="proposal-ancestors-list" id="proposal-ancestors-proposals-content">${ancestorsHtml}</div>
                `;

                // Attach event listeners for ancestor items (same as in showProposalInfo)
                const ancestorItems = ancestorsSection.querySelectorAll('.ancestor-item[data-proposal-id]');
                ancestorItems.forEach(item => {
                    item.addEventListener('mouseenter', () => {
                        try {
                            if (typeof handleAncestorItemHover === 'function') {
                                handleAncestorItemHover(item);
                            }
                        } catch (_) { }
                    });
                    item.addEventListener('mouseleave', () => {
                        try {
                            if (typeof clearProposalHoverLayers === 'function') {
                                clearProposalHoverLayers();
                            }
                        } catch (_) { }
                    });
                    item.addEventListener('focus', () => {
                        try {
                            if (typeof handleAncestorItemHover === 'function') {
                                handleAncestorItemHover(item);
                            }
                        } catch (_) { }
                    });
                    item.addEventListener('blur', () => {
                        try {
                            if (typeof clearProposalHoverLayers === 'function') {
                                clearProposalHoverLayers();
                            }
                        } catch (_) { }
                    });
                    item.addEventListener('click', event => {
                        event.preventDefault();
                        event.stopPropagation();
                        try {
                            if (typeof handleAncestorItemClick === 'function') {
                                handleAncestorItemClick(item);
                            }
                        } catch (_) { }
                    });
                    item.addEventListener('keydown', event => {
                        if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            event.stopPropagation();
                            try {
                                if (typeof handleAncestorItemClick === 'function') {
                                    handleAncestorItemClick(item);
                                }
                            } catch (_) { }
                        }
                    });
                });
            } else {
                ancestorsSection.innerHTML = `
                    <div class="metric-label">${tProposal('panel.proposal.sections.ancestorsProposals', 'Ancestors (Proposals):')}</div>
                    <div class="metric-value" id="proposal-ancestors-proposals-content">0</div>
                `;
            }
            return true;
        } catch (err) {
            console.warn('Failed to populate ancestors proposals section', err);
            const ancestorsSection = document.getElementById('proposal-ancestors-proposals-section');
            const ancestorsContent = document.getElementById('proposal-ancestors-proposals-content');
            if (ancestorsSection && ancestorsContent) {
                ancestorsSection.innerHTML = `
                    <div class="metric-label">${tProposal('panel.proposal.sections.ancestorsProposals', 'Ancestors (Proposals):')}</div>
                    <div class="metric-value">0</div>
                `;
            }
            return false;
        }
    }

    function setupLazyList(containerId, items, renderItem) {
        if (!items || items.length === 0) return;
        const container = document.getElementById(containerId);
        if (!container) return;

        let nextIndex = 0;
        const batchSize = 20;

        const appendBatch = () => {
            const frag = document.createDocumentFragment();
            for (let i = 0; i < batchSize && nextIndex < items.length; i++, nextIndex++) {
                const html = renderItem(items[nextIndex]);
                const wrapper = document.createElement('div');
                wrapper.innerHTML = html;
                while (wrapper.firstChild) frag.appendChild(wrapper.firstChild);
            }
            container.appendChild(frag);
        };

        // Append as the user scrolls near the end
        const maybeAppend = () => {
            if (!container) return;
            const { scrollTop, clientHeight, scrollHeight } = container;
            const threshold = 120;
            if (scrollTop + clientHeight >= scrollHeight - threshold) {
                appendBatch();
                if (nextIndex >= items.length) {
                    container.removeEventListener('scroll', maybeAppend);
                }
            }
        };

        // Initial batch
        appendBatch();
        if (nextIndex < items.length) {
            container.addEventListener('scroll', maybeAppend);
        }
    }

    // Restore scroll position or anchor row after the DOM rewrite
    const combinedPreserveState = {
        scrollTop: preservedScrollTop,
        anchorKey,
        anchorOffset,
        parcelId: preserveScrollPosition && typeof preserveScrollPosition === 'object'
            ? preserveScrollPosition.parcelId || currentParcelId || null
            : currentParcelId
    };
    restoreProposalDetailsScroll(combinedPreserveState);

    // Show dashed building outlines while the details modal is open (only for unapplied building proposals)
    try {
        if (isBuildingProposal && !appliedState) {
            renderProposalBuildingPreview(fullProposal || proposal);
        } else {
            const groups = ensureProposalOverlayGroups();
            if (groups.buildingPreview) groups.buildingPreview.clearLayers();
        }
    } catch (error) {
        console.warn('Failed to render building preview overlay', error);
    }

    // Add hover-based map highlighting for parcels listed in the proposal details
    try {
        // Clear any previous hover overlay when rendering
        clearProposalInfoHoverOverlay();
        const proposalDetailsContainer = document.getElementById('proposal-details-content');
        const proposalParcelItems = proposalDetailsContainer
            ? proposalDetailsContainer.querySelectorAll('.proposal-parcel-item[data-parcel-id]')
            : [];
        proposalParcelItems.forEach(item => {
            const hoveredParcelId = item.getAttribute('data-parcel-id');
            if (!hoveredParcelId) return;
            item.addEventListener('mouseenter', () => {
                try {
                    showProposalInfoHoverOverlay(hoveredParcelId);
                } catch (_) { }
            });
            item.addEventListener('mouseleave', () => {
                try {
                    clearProposalInfoHoverOverlay();
                } catch (_) { }
            });
        });

        const descendantItems = proposalDetailsContainer
            ? proposalDetailsContainer.querySelectorAll('.descendant-item[data-descendant-type]')
            : [];
        descendantItems.forEach(item => {
            item.addEventListener('mouseenter', () => {
                try {
                    handleDescendantItemHover(item);
                } catch (_) { }
            });
            item.addEventListener('mouseleave', () => {
                try {
                    clearProposalHoverLayers();
                } catch (_) { }
            });
            item.addEventListener('focus', () => {
                try {
                    handleDescendantItemHover(item);
                } catch (_) { }
            });
            item.addEventListener('blur', () => {
                try {
                    clearProposalHoverLayers();
                } catch (_) { }
            });
            item.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                try {
                    handleDescendantItemClick(item);
                } catch (_) { }
            });
            item.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    try {
                        handleDescendantItemClick(item);
                    } catch (_) { }
                }
            });
        });

        const ancestorItems = proposalDetailsContainer
            ? proposalDetailsContainer.querySelectorAll('.ancestor-item[data-proposal-id]')
            : [];
        ancestorItems.forEach(item => {
            item.addEventListener('mouseenter', () => {
                try {
                    handleAncestorItemHover(item);
                } catch (_) { }
            });
            item.addEventListener('mouseleave', () => {
                try {
                    clearProposalHoverLayers();
                } catch (_) { }
            });
            item.addEventListener('focus', () => {
                try {
                    handleAncestorItemHover(item);
                } catch (_) { }
            });
            item.addEventListener('blur', () => {
                try {
                    clearProposalHoverLayers();
                } catch (_) { }
            });
            item.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                try {
                    handleAncestorItemClick(item);
                } catch (_) { }
            });
            item.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    try {
                        handleAncestorItemClick(item);
                    } catch (_) { }
                }
            });
        });
    } catch (_) { }

    console.debug('[showProposalInfo] Initializing expiry and decay countdowns...');
    // Initialize expiry countdown timer if present
    initializeExpiryCountdown();

    // Initialize decay countdown animation if present
    initializeDecayCountdown();
    console.debug('[showProposalInfo] Countdowns initialized');

    console.debug('[showProposalInfo] Making proposal details panel visible...');
    const detailsPanel = document.getElementById('proposal-details-panel');
    if (detailsPanel) {
        // Normally opening details expands the panel. Right after creating a proposal we open it
        // collapsed instead (one-shot flag set by the create flow) — the collapsed card still shows
        // the Apply/Share actions, so the freshly-made proposal isn't a wall of detail on arrival.
        const startCollapsed = (typeof window !== 'undefined' && window.__openProposalDetailsCollapsed === true);
        if (typeof window !== 'undefined') window.__openProposalDetailsCollapsed = false;
        setProposalDetailsPanelMinimized(detailsPanel, startCollapsed, getProposalDetailsPanelLabels());
        detailsPanel.classList.add('visible');
        console.debug('[showProposalInfo] Panel made visible');
    } else {
        console.warn('[showProposalInfo] Proposal details panel element not found');
    }
    document.body.classList.add('proposal-details-open');
    console.debug('[showProposalInfo] Body class added, proposal details should now be visible');
    // Close on Escape when this panel is the active proposal surface
    installProposalDetailsEscapeHandler();

    // Setup click listeners for any clickable links in the proposal info
    if (typeof setupGameLogClickListeners === 'function') {
        setupGameLogClickListeners();
    }
}

function resolveProposalForBoost(idOrHash) {
    if (typeof proposalStorage !== 'undefined' && typeof proposalStorage.findProposalByIdOrHash === 'function') {
        const found = proposalStorage.findProposalByIdOrHash(idOrHash);
        if (found) return found;
    }
    if (window.currentlyHighlightedProposal) return window.currentlyHighlightedProposal;
    return null;
}

function openProposalBoostDialog(idOrHash = null) {
    const tProposalUI = getProposalI18nHelper();
    const proposal = resolveProposalForBoost(idOrHash);
    if (!proposal) {
        showProposalAlertMessage('proposal_not_found', 'Proposal not found.');
        return;
    }

    const existing = document.getElementById('proposalBoostOverlay');
    if (existing && existing.parentNode) {
        existing.parentNode.removeChild(existing);
    }

    const boostKey = proposal.proposalId || proposal.proposalId || '';
    const overlay = document.createElement('div');
    overlay.id = 'proposalBoostOverlay';
    overlay.className = 'proposal-boost-overlay';
    overlay.addEventListener('click', event => {
        if (event.target === overlay) {
            closeProposalBoostDialog();
        }
    });

    // Detect if Solana wallet is active for currency options
    const boostSolWm = window.solanaWalletManager;
    const boostSolState = boostSolWm && typeof boostSolWm.getState === 'function' ? boostSolWm.getState() : null;
    const boostIsSolana = boostSolState && boostSolState.status === 'connected'
        && Array.isArray(boostSolState.accounts) && boostSolState.accounts.length > 0;

    const modalTitle = tProposalUI('panel.proposal.boost.title', 'Boost the proposal');
    const modalCloseLabel = tProposalUI('panel.proposal.boost.closeLabel', 'Close boost dialog');
    const modalCopy = tProposalUI('panel.proposal.boost.copy', 'The proposal creator, but also anyone else, can boost any proposal by sending money to it. If the proposal expires before executing the donations will be refunded.');
    const sendLabel = tProposalUI('panel.proposal.boost.send', 'Send');
    const expiryLabel = tProposalUI('panel.proposal.boost.expiryLabel', 'Boost expiry timestamp (optional)');
    const expiryPlaceholder = tProposalUI('panel.proposal.boost.expiryPlaceholder', 'YYYY-MM-DDTHH:MM:SSZ or epoch seconds');
    const expiryHint = tProposalUI('panel.proposal.boost.expiryHint', 'Optional: add a timestamp after which this boost should expire.');
    const cityTokenLabel = tProposalUI('panel.proposal.boost.cityTokenLabel', 'City Meme Token');

    const currencyOptionsHtml = boostIsSolana
        ? `<option value="SOL">SOL</option>`
        : `<option value="CITY">${cityTokenLabel}</option>
                        <option value="ETH">ETH</option>
                        <option value="USDC">USDC</option>
                        <option value="USDT">USDT</option>
                        <option value="EUR">EUR</option>
                        <option value="USD">USD</option>
                        <option value="ARS">ARS</option>`;

    overlay.innerHTML = `
        <div class="proposal-boost-modal" role="dialog" aria-modal="true">
            <div class="proposal-boost-header">
                <h3>${modalTitle}</h3>
                <button type="button" class="proposal-boost-close" aria-label="${modalCloseLabel}" onclick="closeProposalBoostDialog()">×</button>
            </div>
            <div class="proposal-boost-body">
                <p class="proposal-boost-copy">${modalCopy}</p>
                <div class="proposal-offer-row proposal-boost-row" style="display:flex; gap:8px; align-items:center;">
                    <input type="text" id="proposalBoostAmount" placeholder="0" inputmode="numeric" style="flex:1 1 auto;" oninput="handleProposalOfferInput(this)">
                    <select id="proposalBoostCurrency" style="flex:0 0 112px; max-width:112px; min-width:112px;">
                        ${currencyOptionsHtml}
                    </select>
                </div>
                <div class="proposal-boost-row proposal-boost-expiry">
                    <label for="proposalBoostExpiry" class="proposal-boost-expiry-label">${expiryLabel}</label>
                    <input type="text" id="proposalBoostExpiry" placeholder="${expiryPlaceholder}" autocomplete="off" inputmode="text">
                    <div class="proposal-boost-expiry-hint">${expiryHint}</div>
                </div>
                <div class="proposal-boost-actions" style="display:flex; flex-direction:column; align-items:center; gap:6px;">
                    <button type="button" class="btn proposal-boost-send" style="min-width:100px; width:120px;" onclick="submitProposalBoost('${boostKey}')">${sendLabel}</button>
                    <div class="proposal-boost-status" id="proposalBoostStatus" aria-live="polite" style="font-size:12px; text-align:center; min-height:18px;"></div>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    const currencySelect = overlay.querySelector('#proposalBoostCurrency');
    const defaultCurrency = proposal.offerCurrency || (boostIsSolana ? 'SOL' : 'CITY');
    if (currencySelect) {
        const optionExists = Array.from(currencySelect.options).some(opt => opt.value === defaultCurrency);
        if (optionExists) {
            currencySelect.value = defaultCurrency;
        } else {
            currencySelect.value = boostIsSolana ? 'SOL' : 'CITY';
        }
    }
    if (currencySelect && !currencySelect.value) {
        currencySelect.value = 'CITY';
    }

    const amountInput = overlay.querySelector('#proposalBoostAmount');
    if (amountInput) {
        amountInput.focus();
        if (typeof amountInput.select === 'function') {
            amountInput.select();
        }
    }
}

function closeProposalBoostDialog() {
    const overlay = document.getElementById('proposalBoostOverlay');
    if (overlay && overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
    }
}

async function submitProposalBoost(idOrHash = null) {
    const tProposalUI = getProposalI18nHelper();
    const amountInput = document.getElementById('proposalBoostAmount');
    const currencySelect = document.getElementById('proposalBoostCurrency');
    const expiryInput = document.getElementById('proposalBoostExpiry');
    const statusEl = document.getElementById('proposalBoostStatus');
    const setBoostStatus = (text = '') => {
        if (statusEl) {
            statusEl.textContent = text;
        }
    };
    setBoostStatus('');
    const rawAmount = amountInput ? amountInput.value : '';
    const amount = typeof parseProposalOfferValue === 'function'
        ? parseProposalOfferValue(rawAmount)
        : 0;

    if (!amount || amount <= 0) {
        showProposalAlertMessage('please_enter_a_valid_boost_amount', 'Please enter a valid boost amount.');
        return;
    }

    const currency = (currencySelect && currencySelect.value) ? currencySelect.value : 'USDT';
    const rawBoostExpiry = expiryInput ? expiryInput.value.trim() : '';
    const boostExpiryTimestamp = rawBoostExpiry ? parseBoostExpiryInput(rawBoostExpiry) : null;
    if (rawBoostExpiry && !boostExpiryTimestamp) {
        showProposalAlertMessage('please_enter_a_valid_boost_expiry', 'Please enter a valid boost expiry timestamp.');
        return;
    }

    const supportedBoostCurrencies = ['CITY', 'ETH', 'SOL'];
    if (!supportedBoostCurrencies.includes(currency)) {
        showProposalAlertMessage('proposal_boost_failed', 'Currency currently not supported [OK]');
        return;
    }

    const proposal = resolveProposalForBoost(idOrHash);
    if (!proposal) {
        showProposalAlertMessage('proposal_not_found', 'Proposal not found.');
        return;
    }

    const nftInfo = getProposalNftInfo(proposal);
    if (!nftInfo || !nftInfo.tokenId) {
        showProposalAlertMessage('proposal_boost_not_minted', 'This proposal is not on-chain yet. Mint it before boosting.');
        return;
    }

    // Check if any wallet is connected (EVM or Solana)
    const solWm = window.solanaWalletManager;
    const solState = solWm && typeof solWm.getState === 'function' ? solWm.getState() : null;
    const isSolanaConnected = solState && solState.status === 'connected' && Array.isArray(solState.accounts) && solState.accounts.length > 0;

    const evmWm = window.walletManager;
    const walletState = evmWm && typeof evmWm.getState === 'function' ? evmWm.getState() : null;
    const isEvmConnected = walletState && walletState.status === 'connected' && walletState.accounts && walletState.accounts.length > 0;

    if (!isEvmConnected && !isSolanaConnected) {
        showProposalAlertMessage('proposal_boost_wallet_required', 'Connect a wallet to boost this proposal.');
        if (typeof handleWalletButtonClick === 'function') {
            handleWalletButtonClick();
        }
        return;
    }

    const targetChainId = normalizeChainIdForBoost(nftInfo.chain || (walletState && walletState.chainId) || window.DEFAULT_CHAIN_ID || null);
    const contractAddress = nftInfo.contract || null;

    if (!targetChainId || !contractAddress) {
        showProposalAlertMessage('proposal_boost_contract_missing', 'Proposal contract address is not configured for this network.');
        return;
    }

    // Only do chain switching for EVM wallets, not Solana
    const isSolanaChain = typeof targetChainId === 'string' && targetChainId.startsWith('solana');
    if (!isSolanaChain && isEvmConnected) {
        const walletChainId = normalizeChainIdForBoost(walletState.chainId);
        if (walletChainId && walletChainId !== targetChainId && evmWm && typeof evmWm.switchChain === 'function') {
            try {
                await evmWm.switchChain(targetChainId);
            } catch (switchError) {
                console.warn('Boost: network switch rejected or failed', switchError);
                showProposalAlertMessage('proposal_boost_switch_network', 'Switch your wallet to network {{chainId}} to boost this proposal.', { chainId: targetChainId });
                return;
            }
        }
    }

    if (!window.ProposalChainBridge || typeof window.ProposalChainBridge.contributeToProposal !== 'function') {
        showProposalAlertMessage('proposal_boost_failed', 'Boost transaction failed: blockchain bridge unavailable.');
        return;
    }

    const handleStatusUpdate = status => {
        if (status === 'approve') {
            setBoostStatus('Waiting for approve confirmation...');
        } else if (status === 'transfer') {
            setBoostStatus('Waiting for transfer confirmation...');
        }
    };

    if (currency === 'CITY') {
        setBoostStatus('You will be asked for two transactions, Approve and Transfer');
    } else {
        setBoostStatus('Waiting for transfer confirmation...');
    }

    let txResult = null;
    try {
        txResult = await window.ProposalChainBridge.contributeToProposal({
            proposalId: nftInfo.tokenId,
            chainId: targetChainId,
            contractAddress,
            currency,
            amount,
            onStatus: handleStatusUpdate
        });
    } catch (error) {
        setBoostStatus('');
        const code = error && error.code;
        if (code === 'CITY_TOKEN_MISSING') {
            showProposalAlertMessage('proposal_boost_missing_token', 'City Meme Token address is not configured for the connected network.');
            return;
        }
        if (code === 'CONTRACT_MISSING' || code === 'CONTRACT_NOT_FOUND' || code === 'CONTRACT_INVALID') {
            showProposalAlertMessage('proposal_boost_contract_missing', 'Proposal contract address is not configured for this network.');
            return;
        }
        if (code === 'WALLET_NOT_CONNECTED' || code === 'WALLET_NOT_READY') {
            showProposalAlertMessage('proposal_boost_wallet_required', 'Connect a wallet to boost this proposal.');
            if (typeof handleWalletButtonClick === 'function') {
                handleWalletButtonClick();
            }
            return;
        }
        if (code === 'WRONG_NETWORK') {
            showProposalAlertMessage('proposal_boost_switch_network', 'Switch your wallet to network {{chainId}} to boost this proposal.', { chainId: targetChainId });
            return;
        }
        if (code === 'UNSUPPORTED_CURRENCY') {
            showProposalAlertMessage('proposal_boost_failed', 'Currency currently not supported [OK]');
            return;
        }

        const reason = error && (error.reason || error.shortMessage || error.message) ? (error.reason || error.shortMessage || error.message) : 'Unknown error';
        showProposalAlertMessage('proposal_boost_failed', `Boost transaction failed: ${reason}`, { reason });
        return;
    }

    const baseOffer = typeof proposal.offer === 'number'
        ? proposal.offer
        : parseProposalOfferValue(proposal.offer);
    const updatedOffer = (baseOffer || 0) + amount;

    const updatedProposal = {
        ...proposal,
        offer: updatedOffer,
        offerCurrency: currency,
        lastBoostExpiryTimestamp: boostExpiryTimestamp || null,
        updatedAt: new Date().toISOString(),
        proposalId: proposal.proposalId || idOrHash
    };

    if (typeof proposalStorage !== 'undefined' && typeof proposalStorage._indexProposal === 'function') {
        proposalStorage._indexProposal(updatedProposal);
        if (typeof proposalStorage.save === 'function') {
            proposalStorage.save();
        }
    }

    window.currentlyHighlightedProposal = updatedProposal;

    closeProposalBoostDialog();

    const txLink = txResult && txResult.explorerUrl
        ? txResult.explorerUrl
        : '';
    const amountDisplay = typeof rawAmount === 'string' && rawAmount.trim() ? rawAmount.trim() : String(amount);
    const alertOptions = txLink
        ? { linkUrl: txLink, linkText: 'See transaction on Etherscan' }
        : {};

    showProposalAlertMessage(
        'proposal_boost_success',
        'Success! Thank you for boosting this proposal with {{amount}} of {{currency}}. This could help it happen 🤞 See transaction {{txLink}}',
        { amount: amountDisplay, currency, txLink: txLink },
        alertOptions
    );

    try {
        showProposalInfo(updatedProposal, window.selectedParcelInProposal);
    } catch (error) {
        console.warn('Failed to refresh proposal details after boost', error);
    }

    if (typeof refreshProposalsLayer === 'function') {
        try { refreshProposalsLayer(); } catch (_) { }
    }

    function parseBoostExpiryInput(rawValue) {
        if (!rawValue) return null;

        // Accept epoch seconds/milliseconds
        const numeric = Number(rawValue);
        if (!Number.isNaN(numeric) && numeric > 0) {
            const milliseconds = numeric < 1e12 ? numeric * 1000 : numeric;
            const numericDate = new Date(milliseconds);
            return Number.isNaN(numericDate.getTime()) ? null : numericDate.toISOString();
        }

        // Accept ISO 8601 or other date-compatible strings
        const date = new Date(rawValue);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
}

function openProposalLens(proposalIdOrHash) {
    try {
        if (!proposalIdOrHash || typeof proposalStorage === 'undefined' || typeof proposalStorage.getProposal !== 'function') {
            return;
        }
        const proposal = getProposalByIdOrHash(proposalIdOrHash);
        if (!proposal) return;
        const entries = getProposalLensEntries(proposal, { fallbackToGlobal: false });
        if (!entries.length) {
            return;
        }
        const i18nApi = (typeof window !== 'undefined') ? window.i18n : null;
        const translate = (key, fallback) => {
            if (i18nApi && typeof i18nApi.t === 'function') {
                const value = i18nApi.t(key);
                if (value && value !== key) return value;
            }
            return fallback;
        };
        if (typeof showLensModal !== 'function') {
            return;
        }
        showLensModal({
            subtitle: translate('modal.lens.readOnlySubtitle', 'Saved with this proposal; editing is disabled.'),
            readOnly: true,
            entries: entries
        });
    } catch (error) {
        console.error('[openProposalLens] Error opening proposal lens:', error);
    }
}

function returnToParcelInfo(parcelId, event) {
    // Prevent event bubbling to avoid triggering parcel click handlers
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    // 1) Close Proposal UI (details/modal/list) and leave proposal mode
    if (typeof hideProposalDetailsPanel === 'function') hideProposalDetailsPanel(true);
    if (typeof closeProposalList === 'function') closeProposalList();
    if (typeof hideProposalCompareModal === 'function') hideProposalCompareModal();
    if (typeof closeProposalInfoDialog === 'function') closeProposalInfoDialog();

    // 2) Disable proposal mode by unchecking the checkbox and updating layers immediately
    const showProposalsCheckbox = document.getElementById('showProposalsCheckbox');
    if (showProposalsCheckbox && showProposalsCheckbox.checked) {
        showProposalsCheckbox.checked = false;
        if (typeof updateProposalLayer === 'function') {
            updateProposalLayer();
        }
    }

    // 3) Exit Parcel Block mode fully (uncheck, collapse, and clear related UI)
    const parcelBlocksCheckbox = document.getElementById('parcelBlocksCheckbox');
    if (parcelBlocksCheckbox && parcelBlocksCheckbox.checked) {
        parcelBlocksCheckbox.checked = false;
        if (typeof toggleBlocksVisibility === 'function') {
            toggleBlocksVisibility();
        } else {
            if (typeof hideBlocksList === 'function') hideBlocksList();
            if (typeof hideBlockInfo === 'function') hideBlockInfo();
            if (typeof updateBlockLayer === 'function') updateBlockLayer();
        }
    }

    // 4) Select the parcel and show Parcel Info immediately (switch to parcel mode)
    if (typeof selectParcel === 'function') {
        selectParcel(parcelId);
    }
}

function hideProposalDetailsPanel(clearHighlights = false) {
    const proposalPanel = document.getElementById('proposal-details-panel');
    if (proposalPanel) {
        setProposalDetailsPanelMinimized(proposalPanel, false);
        proposalPanel.classList.remove('visible');
    }
    document.body.classList.remove('proposal-details-open');
    teardownProposalDetailsEscapeHandler();

    // Clear cached proposal context when panel closes
    currentProposalDetailsContext = null;

    // Clear hover overlay when closing
    try { clearProposalInfoHoverOverlay(); } catch (_) { }

    // Clear any proposal highlights when closing
    if (clearHighlights && typeof clearProposalHighlights === 'function') {
        clearProposalHighlights();
    }
}

function getProposalDetailsPanelLabels() {
    const tProposalUI = getProposalI18nHelper();
    return {
        minimizeLabel: tProposalUI('sidebar.areaMonitor.minimize', 'Minimize'),
        expandLabel: tProposalUI('sidebar.areaMonitor.expand', 'Expand'),
        closeLabel: tProposalUI('modal.common.close', 'Close')
    };
}

function setProposalDetailsPanelMinimized(panel, minimized, labels = null) {
    if (!panel) return;

    const resolvedLabels = labels || getProposalDetailsPanelLabels();
    panel.classList.toggle('is-minimized', minimized);

    const body = panel.querySelector('.panel-body');
    if (body) {
        body.hidden = minimized;
    }

    const footer = panel.querySelector('.panel-footer');
    if (footer) {
        // Keep the footer (Apply to map / Share) visible even when collapsed — the collapsed
        // card is meant to still expose those two primary actions.
        footer.hidden = false;
    }

    const toggleButton = panel.querySelector('#proposal-details-minimize');
    if (toggleButton) {
        const nextLabel = minimized
            ? (resolvedLabels.expandLabel || 'Expand')
            : (resolvedLabels.minimizeLabel || 'Minimize');
        toggleButton.setAttribute('aria-label', nextLabel);
        toggleButton.setAttribute('title', nextLabel);
        toggleButton.setAttribute('aria-expanded', minimized ? 'false' : 'true');
        toggleButton.innerHTML = minimized ? '+' : '&#8722;';
    }

    const closeButton = panel.querySelector('#proposal-details-close');
    if (closeButton) {
        closeButton.setAttribute('aria-label', resolvedLabels.closeLabel || 'Close');
        closeButton.setAttribute('title', resolvedLabels.closeLabel || 'Close');
    }
}

function toggleProposalDetailsPanelMinimized(forceMinimized = null) {
    const panel = document.getElementById('proposal-details-panel');
    if (!panel || !panel.classList.contains('visible')) return;

    const nextMinimized = typeof forceMinimized === 'boolean'
        ? forceMinimized
        : !panel.classList.contains('is-minimized');
    setProposalDetailsPanelMinimized(panel, nextMinimized);
}

function installProposalDetailsEscapeHandler() {
    if (proposalDetailsEscapeHandler) return;
    proposalDetailsEscapeHandler = (event) => {
        if (event.key !== 'Escape') return;
        const panel = document.getElementById('proposal-details-panel');
        const isActive = panel && panel.classList.contains('visible') && document.body.classList.contains('proposal-details-open');
        if (!isActive) return;
        hideProposalDetailsPanel(true);
    };
    document.addEventListener('keydown', proposalDetailsEscapeHandler);
}

function teardownProposalDetailsEscapeHandler() {
    if (!proposalDetailsEscapeHandler) return;
    document.removeEventListener('keydown', proposalDetailsEscapeHandler);
    proposalDetailsEscapeHandler = null;
}

function showProposalDetailsModal(proposalId, options = {}) {
    if (!proposalId) return;
    openProposalFromList(proposalId, options);
}

function restoreProposalDetailsScroll(preserveState) {
    if (!preserveState) return;

    const { scrollTop, anchorKey, anchorOffset, parcelId } = preserveState;

    const resolvePanelBody = () => {
        const panel = document.getElementById('proposal-details-panel');
        return panel ? panel.querySelector('.panel-body') : null;
    };

    const apply = () => {
        const panelBody = resolvePanelBody();
        if (!panelBody) return;

        if (anchorKey && typeof anchorOffset === 'number') {
            const ownerRow = panelBody.querySelector(`.owner-acceptance-row[data-owner-key="${anchorKey}"]`);
            if (ownerRow) {
                const bodyRect = panelBody.getBoundingClientRect();
                const rowRect = ownerRow.getBoundingClientRect();
                const delta = (rowRect.top - bodyRect.top) - anchorOffset;
                if (!Number.isNaN(delta)) {
                    panelBody.scrollTop += delta;
                    return;
                }
            }
        }

        if (parcelId) {
            const parcelRow = panelBody.querySelector(`.proposal-parcel-item[data-parcel-id="${parcelId}"]`);
            if (parcelRow && typeof parcelRow.scrollIntoView === 'function') {
                parcelRow.scrollIntoView({ block: 'nearest' });
            }
        }

        if (typeof scrollTop === 'number') {
            panelBody.scrollTop = scrollTop;
        }
    };

    apply();
    requestAnimationFrame(apply);
    setTimeout(apply, 0);
    setTimeout(apply, 30);
    setTimeout(apply, 120);
}

function showProposalInfoHoverOverlay(parcelId) {
    try {
        if (!parcelId) return;
        if (typeof isProposalUIActive === 'function' && !isProposalUIActive()) {
            // Proposal UI is not active; do not show proposal-style hover
            return;
        }
        highlightParcelHover(parcelId, {
            color: '#FFEB3B',
            weight: 6,
            dashArray: '10 8',
            showLabels: true
        });
    } catch (error) {
        console.warn('showProposalInfoHoverOverlay failed', error);
    }
}
