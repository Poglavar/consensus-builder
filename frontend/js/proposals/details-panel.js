// proposals/details-panel.js — extracted from proposals.js (behavior-preserving relocation).

function safeAgentText(value) {
    return typeof escapeHtml === 'function' ? escapeHtml(String(value ?? '')) : String(value ?? '');
}

async function focusProposalDetails(proposalIdOrHash, options = {}) {
    if (typeof proposalStorage === 'undefined') return false;
    const proposal = getProposalByIdOrHash(proposalIdOrHash);
    if (!proposal) return false;

    const parcelIds = Array.isArray(proposal.cadastreParcelIds) ? proposal.cadastreParcelIds : [];
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

    // Background hydration uses the proposal's explicit cadastral claim. Fire-and-forget — never
    // await before returning, so a 3,000-parent proposal opens just as fast as a 3-parent one.
    const realCadastreIds = (typeof window !== 'undefined' && window.__claims?.cadastreParcelIdsOf)
        ? window.__claims.cadastreParcelIdsOf(proposal)
        : [];
    const ground = (typeof CadastralParcelRepository !== 'undefined' && CadastralParcelRepository)
        ? CadastralParcelRepository
        : ((typeof window !== 'undefined') ? window.CadastralParcelRepository : null);
    if (realCadastreIds.length > 0 && ground && typeof ground.ensureIds === 'function') {
        Promise.resolve()
            .then(() => ground.ensureIds(realCadastreIds))
            .catch(error => {
                console.warn('[focusProposalDetails] background parcel hydration failed', error);
            });
    }

    return true;
}

function showProposalInfo(proposal, currentParcelId = null, preserveScrollPosition = null) {
    // The proposal action panel is 2D-only for now: in 3D the selection/isolation machinery
    // still runs, but the button box would float context-less over the scene.
    if (typeof document !== 'undefined' && document.body?.classList?.contains('three-mode-active')) {
        try { hideProposalDetailsPanel(true); } catch (_) { }
        return;
    }

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

    collapseSidebarIfOpen();

    const parcelIds = ensureArrayOfStrings(proposal.cadastreParcelIds);

    // Check proposal category for map application controls
    // Ensure we have the full proposal from storage if needed
    // This needs to be done early because we use fullProposal for ancestor parcels
    let fullProposal = proposal;
    if (proposal.proposalId && typeof proposalStorage !== 'undefined' && typeof proposalStorage.getProposal === 'function') {
        try {
            const stored = proposalStorage.getProposal(proposal.proposalId);
            if (stored) {
                fullProposal = stored;
            } else {
            }
        } catch (err) {
            console.warn('[showProposalInfo] Error getting proposal from storage:', err);
        }
    } else {
    }

    // Remember which proposal is currently shown in details so downstream actions can use it directly
    currentProposalDetailsContext = fullProposal;

    // PERFORMANCE: Start timing parent parcel processing
    const perfStartParentIds = performance.now();

    // The proposal has one durable land declaration. Typology-specific parent arrays are not
    // alternate sources of truth and generated output ids never appear in this ancestor list.
    const cadastreParcelIds = Array.isArray(fullProposal.cadastreParcelIds)
        ? fullProposal.cadastreParcelIds.map(String)
        : [];

    const perfEndParentIds = performance.now();

    // Lazy ancestor list: we resolve each row's feature only when its DOM is rendered, so a
    // 700-parent proposal opens just as fast as a 7-parent one. The first batch resolves
    // synchronously to populate the panel, and setupLazyList streams the rest as the user
    // scrolls. parcelDataLoaded → scheduleHighlightRefresh fills in geometry as it arrives.
    const buildAncestorRow = (canonicalIdRaw) => {
        const canonicalId = canonicalIdRaw && canonicalIdRaw.toString ? canonicalIdRaw.toString() : String(canonicalIdRaw || '');
        if (!canonicalId) return null;

        const feature = window.CadastralParcelRepository?.get?.(canonicalId) || null;
        const geometry = feature?.geometry || null;

        const displayFeature = feature || (() => {
            // No data yet — render a stub row that the user can still click. The lazy list
            // will be re-rendered on parcelDataLoaded if scheduleHighlightRefresh promotes it.
            return ensureParcelIdOnFeature({
                type: 'Feature',
                properties: { parcelId: canonicalId, BROJ_CESTICE: canonicalId },
                geometry: null
            });
        })();

        const isReplaced = (typeof isParcelReplacedByChildren === 'function') ? isParcelReplacedByChildren(canonicalId) : false;
        const isRemoved = isReplaced || !displayFeature.geometry;

        return {
            parcelId: getParcelIdFromFeature(displayFeature) || canonicalId,
            parcel: null,
            feature: displayFeature,
            geometry,
            isRemoved
        };
    };

    const MAX_LIST_INITIAL = 20;
    const perfStartParcelFeatures = performance.now();
    // Resolve only the first batch synchronously. Remaining rows resolve via setupLazyList
    // (string ids → buildAncestorRow on render) so initial open cost is bounded by MAX_LIST_INITIAL,
    // not by cadastreParcelIds.length.
    const parentParcels = cadastreParcelIds.slice(0, MAX_LIST_INITIAL).map(buildAncestorRow).filter(Boolean);
    const perfEndParcelFeatures = performance.now();

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
            <div class="proposal-parcel-item" data-parcel-id="${parcelId}" ${removedDataAttr} ${geometryDataAttr} onclick="handleProposalParcelClick(${inlineJsArg(parcelId)}, event)" style="display: flex; flex-direction: column; gap:6px; padding: 8px; border: 1px solid #ddd; margin-bottom: 5px; border-radius: 4px; cursor: pointer; ${hasAccepted ? 'background-color: #f8fff8;' : ''} ${isRemoved ? 'opacity: 0.7;' : ''}" title="${parcelTooltip}">
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
    const parentParcelItemsRemaining = cadastreParcelIds.slice(MAX_LIST_INITIAL);

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

        const liveFeature = window.LiveParcelFabric?.get?.(descendantKey) || null;
        if (liveFeature?.properties) {
            parcelNumber = getParcelDisplayNumberFromProperties(liveFeature.properties, parcelNumber);
            isRoad = !!liveFeature.properties.isRoad;
            roadName = liveFeature.properties.roadName || null;
        }

        const label = parcelNumber ? `Parcel ${parcelNumber}` : `Parcel ${descendantKey}`;
        const roadSuffix = isRoad ? (roadName ? ` • Road: ${roadName}` : ' • Road') : '';
        return `<div class="descendant-item" data-descendant-type="parcel" data-parcel-id="${descendantKey}" tabindex="0">
            ${label}${roadSuffix}
        </div>`;
    };

    const descendantKeys = (typeof window !== 'undefined'
        && window.__claims?.materializedParcelIdsOf)
        ? window.__claims.materializedParcelIdsOf(fullProposal)
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
        applyProposalTitleMarquee(proposalPanelTitle, headerTitle);
        proposalPanelTitle.title = headerTitle; // tooltip while paused or when the marquee is off
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
    // Check multiple signals for minted state: explicit flag, onchain data, or tokenId-style proposalId
    const isMinted = isProposalMinted(fullProposal);
    const lifecycleKey = getProposalLifecycleKey(fullProposal);
    const statusBadgeClass = getProposalLifecycleClass(lifecycleKey);
    const statusBadgeLabel = getProposalLifecycleLabel(lifecycleKey);
    const mapStatusBadgeClass = appliedState ? 'applied' : 'not-applied';
    const mapStatusBadgeLabel = appliedState
        ? tProposal('panel.proposal.mapStatus.applied', 'Applied')
        : tProposal('panel.proposal.mapStatus.notApplied', 'Not Applied');
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
    const nftChain = nftInfo && String(nftInfo.chain || nftInfo.chainId || '');
    const isSolanaPledgeProposal = Boolean(isMinted && nftInfo?.tokenId && nftChain.startsWith('solana'));

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
        const actionView = ProposalMapAction.presentation(appliedState, tProposal);
        const buttonLabel = actionView.label;
        const iconClass = actionView.iconClass;
        const isDisabled = isApplyAction && applyDisabledForType;
        const buttonClass = appliedState
            ? actionView.className
            : (isDisabled ? 'btn btn-secondary disabled' : 'btn btn-success');
        const defaultActionClass = (isApplyAction && !isDisabled) ? ' proposal-action-default' : '';
        const defaultActionAttrs = (isApplyAction && !isDisabled)
            ? 'data-default-action="true" aria-keyshortcuts="Enter"'
            : '';
        const handler = appliedState
            ? `removeProposalFromMap(${inlineJsArg(proposalKey)})`
            : (isDisabled ? null : `applyProposalToMap(${inlineJsArg(proposalKey)})`);
        const disabledStyle = 'cursor: not-allowed; opacity: 0.55; pointer-events: none; background-color: #d1d5db; border-color: #cbd5e1; color: #555;';
        const enabledStyle = '';
        const disabledAttrs = isDisabled
            ? `disabled aria-disabled="true" style="${disabledStyle}"`
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
            <i class="fas fa-share-alt"></i> ${tProposal('panel.proposal.actions.share', 'Share')}
        </button>
    `;

    // A proposal's details are an immutable inspection surface. Any authoring starts from an
    // explicit fork: the create dialog receives a cloned draft, while this source proposal remains
    // untouched. Naming the action matters — the old "Details" label made the editable clone look
    // like an editor for the proposal being viewed.
    const forkButtonHtml = proposalKey
        ? `
        <button class="btn btn-primary btn-counterpropose-proposal"
            onclick="proposeExistingProposal(${inlineJsArg(proposalKey)})"
            title="${tProposal('panel.proposal.actions.counterproposeHint', 'Create an editable copy. The proposal you are viewing stays unchanged.')}"
            aria-label="${tProposal('panel.proposal.actions.counterproposeHint', 'Create an editable copy. The proposal you are viewing stays unchanged.')}">
            <i class="fas fa-code-branch"></i> ${tProposal('panel.proposal.actions.counterpropose', 'Fork proposal')}
        </button>
    `
        : '';
    // Same counterproposal fork, but the parcel set is edited on the map before the create dialog.
    const landForkHint = tProposal('panel.proposal.actions.forkChangedLandHint', 'Fork with changed land set: add or remove parcels on the map, then create the counterproposal. The proposal you are viewing stays unchanged.');
    const landForkButtonHtml = (proposalKey && typeof forkProposalWithChangedLand === 'function')
        ? `
        <button class="btn btn-outline-primary btn-fork-changed-land"
            onclick="forkProposalWithChangedLand(${inlineJsArg(proposalKey)})"
            title="${safeAgentText(landForkHint)}"
            aria-label="${safeAgentText(landForkHint)}">
            <i class="fas fa-object-ungroup"></i> ${tProposal('panel.proposal.actions.forkChangedLand', 'Fork with changed land')}
        </button>
    `
        : '';

    const buyOfferProposal = fullProposal || proposal;
    const buyButtonHtml = (typeof isProposalOpenSaleOffer === 'function' && isProposalOpenSaleOffer(buyOfferProposal))
        ? `<button type="button" class="btn btn-success proposal-buy-btn" onclick="claimSaleOffer(${inlineJsArg(buyOfferProposal.proposalId || '')})">🤝 ${tProposal('panel.proposal.buy.button', 'Buy')}</button>`
        : '';

    // "Drive this track" — opens the external 3D tram sim in a new tab with the
    // cab riding on this proposal's drawn centerline. Shown for uploaded (serial
    // id) track proposals in every city; outside Zagreb the surroundings are
    // empty until the sim's world data goes multi-city, but the ride itself works.
    const driveProposal = fullProposal || proposal;
    const driveWalkConfig = (typeof CityConfigManager !== 'undefined' && typeof CityConfigManager.getDriveConfig === 'function')
        ? CityConfigManager.getDriveConfig()
        : null;
    const driveSerialId = (typeof window !== 'undefined' && typeof window.getSerialProposalId === 'function')
        ? window.getSerialProposalId(driveProposal)
        : null;
    const drivePlan = driveProposal?.roadProposal?.definition;
    const isDrivableTrack = corridorIsTrack(drivePlan);
    const driveButtonHtml = (driveWalkConfig && driveWalkConfig.url && isDrivableTrack && driveSerialId && proposalKey)
        ? `
        <button type="button" class="btn btn-outline-primary btn-drive-proposal" onclick="driveTrackProposalIn3DSim(${inlineJsArg(proposalKey)})">
            🚋 ${tProposal('panel.proposal.actions.drive', 'Drive')}
        </button>
    `
        : '';
    const supportLifecycle = getLifecycleStatus(fullProposal);
    const supportWalletState = window.solanaWalletManager?.getState?.();
    const supportWalletConnected = supportWalletState?.status === 'connected'
        && Array.isArray(supportWalletState.accounts) && supportWalletState.accounts.length > 0;
    const supportButtonHtml = (action) => {
        const supportButtons = {
            connect: `<button type="button" class="btn btn-outline-primary btn-connect-proposal-support" onclick="handleWalletButtonClick()">${tProposal('panel.proposal.support.connect', 'Connect Solana wallet')}</button>`,
            donate: `<button type="button" class="btn btn-outline-primary btn-donate-proposal" onclick="openProposalBoostDialog(${inlineJsArg(proposalKey)}, 'donate')">🎁 ${tProposal('panel.proposal.support.donate', 'Donate USDC')}</button>`,
            pledge: `<button type="button" class="btn btn-outline-primary btn-pledge-proposal" onclick="openProposalBoostDialog(${inlineJsArg(proposalKey)}, 'pledge')">💪 ${tProposal('panel.proposal.boost.send', 'Pledge USDC')}</button>`,
            revokePledge: `<button type="button" class="btn btn-outline-secondary" onclick="settleProposalSupport(${inlineJsArg(proposalKey)}, 'revokePledge')">${tProposal('panel.proposal.support.revoke', 'Revoke my pledge')}</button>`,
            releaseDonations: `<button type="button" class="btn btn-outline-primary" onclick="settleProposalSupport(${inlineJsArg(proposalKey)}, 'releaseDonations')">${tProposal('panel.proposal.support.release', 'Release donations')}</button>`,
            fulfillPledge: `<button type="button" class="btn btn-outline-primary" onclick="settleProposalSupport(${inlineJsArg(proposalKey)}, 'fulfillPledge')">${tProposal('panel.proposal.support.fulfill', 'Fulfill my pledge')}</button>`,
            refundMyDonations: `<button type="button" class="btn btn-outline-primary" onclick="settleProposalSupport(${inlineJsArg(proposalKey)}, 'refundMyDonations')">${tProposal('panel.proposal.support.refund', 'Refund my donations')}</button>`,
            voidPledge: `<button type="button" class="btn btn-outline-secondary" onclick="settleProposalSupport(${inlineJsArg(proposalKey)}, 'voidPledge')">${tProposal('panel.proposal.support.void', 'Clear my pledge')}</button>`
        };
        return supportButtons[action] || '';
    };
    const renderSupportButtons = (summary = null, summaryReady = false) => {
        const actions = window.ProposalSupportView?.actionKeys?.({
            lifecycle: supportLifecycle, walletConnected: supportWalletConnected, summary, summaryReady
        }) || [];
        return actions.map(supportButtonHtml).join('');
    };
    let proposalSupportButtonsHtml = '';
    if (isSolanaPledgeProposal && proposalKey) {
        proposalSupportButtonsHtml = `<span class="proposal-support-actions" data-proposal-support-actions="${nftInfo.tokenId}">${renderSupportButtons()}</span>`;
    }

    // The details footer is deliberately view/action-only. Geometry, terms, and ownership are
    // edited only on the clone produced by Counterpropose / Fork. Contextual extras (Buy, Drive)
    // append at the end. Deletion lives
    // in the proposal lists (type-aware there) — the panel only offers the reversible Unapply,
    // which means the same thing for local, server, and on-chain proposals.
    // Colors are role-coded: blue = fork, green = apply, yellow = unapply,
    // neutral outline = edit/share.
    const primaryActionsHtml = `
        <div class="proposal-actions proposal-actions-group">
            ${forkButtonHtml}
            ${landForkButtonHtml}
            ${mapActionButtonHtml ? mapActionButtonHtml : ''}
            ${proposalSupportButtonsHtml}
            ${shareButtonHtml}
            ${buyButtonHtml}
            ${driveButtonHtml}
        </div>
    `;

    const escapedProposalDescription = proposalDisplayDescription && typeof escapeHtml === 'function'
        ? escapeHtml(proposalDisplayDescription)
        : proposalDisplayDescription;

    // "Based on <name>" — set when this proposal was forked via "Copy into new proposal". The
    // link jumps to the source; fall back to the stored name if the source is no longer local.
    const copiedFromId = (fullProposal && (fullProposal.sourceProposalId || fullProposal.replacementOfProposalId || fullProposal.copiedFromProposalId))
        || proposal.sourceProposalId || proposal.replacementOfProposalId || proposal.copiedFromProposalId || null;
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
            ? `<a href="#" class="proposal-based-on-link" onclick="event.preventDefault(); focusProposalDetails(${inlineJsArg(copiedFromId)});">${safeLabel} <i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i></a>`
            : `<span class="proposal-based-on-name">${safeLabel}</span>`;
        copiedFromHtml = `<div class="proposal-based-on-row">${basedOnLabel}: ${inner}</div>`;
        // A land fork names how its parcels relate to the origin's, instead of a bare "Based on".
        const landFork = (fullProposal && fullProposal.landFork) || proposal.landFork || null;
        const landForkMessage = landFork && window.ParcelSetRelations?.landForkSummaryMessage?.(landFork);
        if (landForkMessage) {
            const forkedLabel = tProposal('panel.proposal.landFork.forkedFrom', 'Forked on different land from');
            const relationText = safeAgentText(tProposal(landForkMessage.key, landForkMessage.fallback, landForkMessage.params));
            copiedFromHtml = `<div class="proposal-based-on-row proposal-land-fork-row">${safeAgentText(forkedLabel)}: ${inner}<div class="proposal-land-fork-relation">${relationText}</div></div>`;
        }
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
            onclick="openProposalLens(${inlineJsArg(lensProposalId)})"
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

    const parcelSetRelationsHtml = (() => {
        const relationApi = (typeof window !== 'undefined') ? window.ParcelSetRelations : null;
        if (!relationApi || typeof relationApi.findParcelSetRelations !== 'function') return '';

        const activeProposal = fullProposal || proposal;
        const canonicalIds = relationApi.normalizeParcelIds(activeProposal);
        if (!canonicalIds.length) return '';

        let allProposals = [];
        try {
            allProposals = (typeof proposalStorage !== 'undefined'
                && typeof proposalStorage.getAllProposals === 'function')
                ? proposalStorage.getAllProposals()
                : [];
        } catch (error) {
            console.warn('[showProposalInfo] Could not enumerate parcel-set alternatives:', error);
        }
        const relations = relationApi.findParcelSetRelations(activeProposal, allProposals, { limit: 12 });
        const exactCount = relations.filter(relation => relation.kind === 'same').length;
        const overlapCount = relations.length - exactCount;
        const setHash = typeof activeProposal?.parcelSet?.setHash === 'string'
            ? activeProposal.parcelSet.setHash
            : '';
        const shortHash = setHash ? `${setHash.slice(0, 13)}…${setHash.slice(-6)}` : '';
        const summary = relations.length
            ? tProposal(
                'panel.proposal.parcelSet.summary',
                '{{count}} real parcels anchor this proposal. {{exact}} alternatives use the same set and {{overlap}} overlap it.',
                { count: canonicalIds.length, exact: exactCount, overlap: overlapCount }
            )
            : tProposal(
                'panel.proposal.parcelSet.noRelated',
                '{{count}} real parcels anchor this proposal. No other proposal currently references this land.',
                { count: canonicalIds.length }
            );
        const relationLabels = {
            same: tProposal('panel.proposal.parcelSet.relationSame', 'Same parcel set'),
            'contains-target': tProposal('panel.proposal.parcelSet.relationContains', 'Includes this whole set'),
            'inside-target': tProposal('panel.proposal.parcelSet.relationInside', 'Inside this parcel set'),
            overlap: tProposal('panel.proposal.parcelSet.relationOverlap', 'Overlapping land')
        };
        const rows = relations.map(relation => {
            const candidate = relation.proposal || {};
            const candidateId = safeAgentText(relation.proposalId);
            const title = safeAgentText(candidate.title || candidate.name || relation.proposalId);
            const author = candidate.author ? safeAgentText(candidate.author) : '';
            const shared = safeAgentText(tProposal(
                'panel.proposal.parcelSet.sharedCount',
                '{{shared}} of {{count}} parcels shared',
                { shared: relation.sharedCount, count: relation.targetCount }
            ));
            const lifecycle = typeof getProposalLifecycleLabel === 'function'
                ? safeAgentText(getProposalLifecycleLabel(getProposalLifecycleKey(candidate)))
                : '';
            return `
                <button type="button" class="proposal-parcel-set-relation" data-related-proposal-id="${candidateId}">
                    <span class="proposal-parcel-set-relation-main">
                        <strong>${title}</strong>
                        <small>${safeAgentText(relationLabels[relation.kind])} · ${shared}${author ? ` · ${author}` : ''}</small>
                    </span>
                    ${lifecycle ? `<span class="proposal-parcel-set-relation-state">${lifecycle}</span>` : ''}
                    <i class="fas fa-chevron-right" aria-hidden="true"></i>
                </button>`;
        }).join('');

        return `
            <section class="proposal-parcel-set-card" aria-label="${safeAgentText(tProposal('panel.proposal.parcelSet.title', 'Proposals on this land'))}">
                <div class="proposal-parcel-set-head">
                    <div>
                        <div class="proposal-funding-eyebrow">${safeAgentText(tProposal('panel.proposal.parcelSet.eyebrow', 'Canonical parcel set'))}</div>
                        <h3>${safeAgentText(tProposal('panel.proposal.parcelSet.title', 'Proposals on this land'))}</h3>
                    </div>
                    <span class="proposal-parcel-set-count">${canonicalIds.length}</span>
                </div>
                <p>${safeAgentText(summary)}</p>
                ${shortHash ? `<div class="proposal-parcel-set-hash" title="${safeAgentText(setHash)}"><span>${safeAgentText(tProposal('panel.proposal.parcelSet.hash', 'Set identity'))}</span><code>${safeAgentText(shortHash)}</code></div>` : ''}
                ${rows ? `<div class="proposal-parcel-set-relations">${rows}</div>` : ''}
                <div class="proposal-parcel-set-activity">
                    <button type="button" class="activity-scope-link" data-activity-scope="proposalId" data-activity-value="${safeAgentText(relationApi.proposalKey(activeProposal))}">${safeAgentText(tProposal('panel.proposal.parcelSet.activityProposal', 'Activity on this proposal'))}</button>
                    ${setHash ? `<button type="button" class="activity-scope-link" data-activity-scope="parcelSet" data-activity-value="${safeAgentText(setHash)}">${safeAgentText(tProposal('panel.proposal.parcelSet.activityLand', 'Activity on this land'))}</button>` : ''}
                </div>
            </section>`;
    })();

    // Build expiry countdown HTML if proposal has an expiry set and is not executed
    let expiryCountdownHtml = '';
    if (proposal.expiresAt && getLifecycleStatus(proposal) !== 'Executed') {
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

    const agentProvenance = typeof ProposalAgentProvenance !== 'undefined'
        ? ProposalAgentProvenance.read(fullProposal)
        : null;
    const agentBadgeHtml = agentProvenance
        ? `<div class="proposal-agent-badge proposal-agent-badge--panel"><span aria-hidden="true">✦</span> ${safeAgentText(tProposal('panel.proposal.agent.badge', 'Agent proposal'))}</div>`
        : '';
    const agentProvenanceHtml = agentProvenance ? `
        <section class="proposal-agent-provenance" aria-label="${safeAgentText(tProposal('panel.proposal.agent.sectionLabel', 'Agent provenance'))}">
            <div class="proposal-agent-provenance-head">
                <div>
                    <div class="proposal-agent-eyebrow">${safeAgentText(tProposal('panel.proposal.agent.verified', 'Verified x402 submission'))}</div>
                    <div class="proposal-agent-persona">${safeAgentText(agentProvenance.persona)}</div>
                </div>
                <div class="proposal-agent-payment">${safeAgentText(agentProvenance.paymentLabel)}</div>
            </div>
            ${agentProvenance.rationale ? `<p class="proposal-agent-rationale">${safeAgentText(agentProvenance.rationale)}</p>` : ''}
            <dl class="proposal-agent-facts">
                <div><dt>${safeAgentText(tProposal('panel.proposal.agent.payer', 'Paying wallet'))}</dt><dd title="${safeAgentText(agentProvenance.wallet)}">${safeAgentText(agentProvenance.walletShort)}</dd></div>
                ${agentProvenance.runId ? `<div><dt>${safeAgentText(tProposal('panel.proposal.agent.run', 'Agent run'))}</dt><dd title="${safeAgentText(agentProvenance.runId)}">${safeAgentText(agentProvenance.runId)}</dd></div>` : ''}
                <div><dt>${safeAgentText(tProposal('panel.proposal.agent.settlement', 'Settlement'))}</dt><dd><a href="${safeAgentText(agentProvenance.explorerUrl)}" target="_blank" rel="noopener" title="${safeAgentText(agentProvenance.transaction)}">${safeAgentText(agentProvenance.transactionShort)} <i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i></a></dd></div>
            </dl>
            <div class="proposal-agent-flow" aria-label="${safeAgentText(tProposal('panel.proposal.agent.flowLabel', 'How this proposal was created'))}">
                <span>${safeAgentText(tProposal('panel.proposal.agent.flowDiscover', 'Discoverable API'))}</span>
                <i class="fas fa-arrow-right" aria-hidden="true"></i>
                <span>${safeAgentText(tProposal('panel.proposal.agent.flowPay', 'x402 payment'))}</span>
                <i class="fas fa-arrow-right" aria-hidden="true"></i>
                <span>${safeAgentText(tProposal('panel.proposal.agent.flowStore', 'Stored proposal'))}</span>
            </div>
        </section>
    ` : '';

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
                ${agentBadgeHtml}
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
            ${parcelSetRelationsHtml}
            ${agentProvenanceHtml}
            ${isSolanaPledgeProposal ? `<section class="proposal-possibility-card" data-proposal-timeline="${nftInfo.tokenId}" aria-label="Proposal timeline">
                <div class="proposal-funding-head">
                    <div>
                        <div class="proposal-funding-eyebrow">Verifiable hyperstition</div>
                        <h3>From possible future to public fact</h3>
                    </div>
                    <span class="proposal-funding-state" data-timeline-state>Loading evidence…</span>
                </div>
                <ol class="proposal-possibility-timeline" data-timeline-stages aria-live="polite">
                    <li class="is-pending"><span>Loading the shared activity and oracle evidence…</span></li>
                </ol>
            </section>` : ''}
            ${isSolanaPledgeProposal ? `<section class="proposal-funding-card proposal-pledge-summary" data-proposal-account="${nftInfo.tokenId}" aria-label="${tProposal('panel.proposal.pledge.summary', 'Proposal funding')}">
                <div class="proposal-funding-head">
                    <div>
                        <div class="proposal-funding-eyebrow">${tProposal('panel.proposal.pledge.onchain', 'On-chain support')}</div>
                        <h3>${tProposal('panel.proposal.pledge.summary', 'Funding & commitments')}</h3>
                    </div>
                    <span class="proposal-funding-state">${safeAgentText(supportLifecycle)}</span>
                </div>
                <div class="proposal-funding-grid" aria-live="polite">
                    <div><span>${tProposal('panel.proposal.pledge.donations', 'Donations')}</span><strong data-funding="donated">${tProposal('panel.proposal.pledge.loading', 'Loading…')}</strong><small data-funding="donation-status"></small></div>
                    <div><span>${tProposal('panel.proposal.pledge.pledges', 'Pledges')}</span><strong data-funding="pledged">${tProposal('panel.proposal.pledge.loading', 'Loading…')}</strong><small data-funding="pledge-status"></small></div>
                </div>
                <div class="proposal-funding-explainer">
                    <div><strong>${tProposal('panel.proposal.pledge.donationMeaningTitle', 'Donation')}</strong> ${tProposal('panel.proposal.pledge.donationMeaning', 'moves USDC into escrow now; it is refundable if the proposal is cancelled or expires.')}</div>
                    <div><strong>${tProposal('panel.proposal.pledge.pledgeMeaningTitle', 'Pledge')}</strong> ${tProposal('panel.proposal.pledge.pledgeMeaning', 'is a revocable public commitment; no USDC moves until you fulfil it after execution.')}</div>
                </div>
                <div class="proposal-funding-you" data-funding="you">${tProposal('panel.proposal.pledge.connect', 'Connect a Solana wallet to see your support.')}</div>
                <div class="proposal-funding-links">
                    <a href="https://explorer.solana.com/address/${nftInfo.tokenId}?cluster=devnet" target="_blank" rel="noopener">${tProposal('panel.proposal.pledge.proposalExplorer', 'Proposal account')} ↗</a>
                    <a href="https://explorer.solana.com/address/${window.SolanaPledgeClient?.constants?.PROGRAM_ID || '1jESRS3mJiPUJTtmQ5ncyBhGNmGeXTpUqPyJcTYrp6g'}?cluster=devnet" target="_blank" rel="noopener">${tProposal('panel.proposal.pledge.programExplorer', 'Funding program')} ↗</a>
                </div>
            </section>` : ''}
            ${isSolanaPledgeProposal ? `<section class="proposal-market-card proposal-market-summary" data-proposal-account="${nftInfo.tokenId}" data-proposal-id="${safeAgentText(fullProposal?.proposalId || '')}" data-proposal-lifecycle="${safeAgentText(supportLifecycle)}" aria-label="Prediction market">
                <div class="proposal-funding-head">
                    <div>
                        <div class="proposal-funding-eyebrow">On-chain prediction market</div>
                        <h3>Will this proposal execute?</h3>
                    </div>
                    <span class="proposal-funding-state" data-market="state">Loading…</span>
                </div>
                <div class="proposal-market-grid" aria-live="polite">
                    <div><span>YES · executes</span><strong data-market="yes">Loading…</strong><small data-market="yes-odds"></small></div>
                    <div><span>NO · cancelled</span><strong data-market="no">Loading…</strong><small data-market="no-odds"></small></div>
                </div>
                <div class="proposal-market-lifecycle">
                    <div><strong>Resolution rule</strong><span data-market="rule">Reading the on-chain market rule…</span></div>
                    <div><strong>What happens next</strong><span data-market="next">Loading proposal and market state…</span></div>
                </div>
                <div class="proposal-market-oracle" data-market="oracle">
                    <strong>${tProposal('panel.proposal.market.oracleTitle', 'Oracle recipe')}</strong>
                    <span data-market="oracle-state">${tProposal('panel.proposal.market.oracleLoading', 'Loading proposal-lifecycle-v1…')}</span>
                    <div class="proposal-funding-links">
                        <a data-market="recipe-link" href="#" target="_blank" rel="noopener" hidden>${tProposal('panel.proposal.market.recipeLink', 'Recipe declaration ↗')}</a>
                        <a data-market="event-link" href="#" target="_blank" rel="noopener" hidden>${tProposal('panel.proposal.market.eventLink', 'Source event ↗')}</a>
                    </div>
                </div>
                <div class="proposal-market-you" data-market="you">Connect a Solana wallet to see your market position.</div>
                <div class="proposal-market-controls" data-market="controls"></div>
                <div class="proposal-market-status" data-market="status" aria-live="polite"></div>
                <div class="proposal-market-history" data-market="history"><strong>Recent market transactions</strong><span>Loading activity evidence…</span></div>
                <div class="proposal-funding-links">
                    <a href="https://explorer.solana.com/address/${nftInfo.tokenId}?cluster=devnet" target="_blank" rel="noopener">Proposal account ↗</a>
                    <a data-market="account-link" href="#" target="_blank" rel="noopener" hidden>Market account ↗</a>
                    <a href="https://explorer.solana.com/address/${window.SolanaMarketClient?.constants?.PROGRAM_ID || 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB'}?cluster=devnet" target="_blank" rel="noopener">Market program ↗</a>
                </div>
            </section>` : ''}
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
            // Check if this is an ownership-transfer-from-me proposal
            const isFromMeProposal = resolveProposalGoalKey(proposal, null) === 'ownership-transfer-from-me';
            const acceptTransferLabel = tProposal('panel.proposal.acceptTransfer.buttonLabel', 'Accept ownership transfer');
            const acceptTransferButtonHtml = isFromMeProposal
                ? `<button type="button" class="offer-boost-button" title="${acceptTransferLabel}" aria-label="${acceptTransferLabel}" onclick="openAcceptOwnershipTransferDialog(${inlineJsArg(proposal.proposalId || '')})">🤝</button>`
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
                </div>
                ${hasDeposit ? `<div class="offer-bar-deposit-container">${depositBarsHtml}</div>` : ''}
            </div>${noDepositWarningHtml}`;
            }
        })() : ''}
            <div class="metric-group">
                <span class="metric-label">${tProposal('panel.proposal.metrics.parcels', 'Parcels in Proposal:')}</span> <span class="metric-value">${parcelIds.length}</span>
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
            ${cadastreParcelIds.length > 0 ? `
            <div class="metric-group">
                <div class="metric-label-count-container">
                    <span class="metric-label">${tProposal('panel.proposal.sections.cadastralParcels', 'Cadastral parcels:')}</span> <span class="metric-value">${cadastreParcelIds.length}</span>
                </div>
                <div class="proposal-parcels-list" id="proposal-parent-parcels-list" style="max-height: 420px; overflow-y: auto;">
                    ${parentParcelItemsInitial}
                </div>
            </div>
            ` : `
            <div class="metric-group">
                <span class="metric-label">${tProposal('panel.proposal.sections.cadastralParcels', 'Cadastral parcels:')}</span> <span class="metric-value">0</span>
            </div>
            `}
            
            <!-- Generated parcel output -->
            ${(() => {
            if (typeof ProposalManager !== 'undefined') {
                if (descendantKeys.length > 0) {
                    return `
            <div class="metric-group">
                <div class="metric-label-count-container">
                    <span class="metric-label">${tProposal('panel.proposal.sections.generatedParcels', 'Generated parcels:')}</span> <span class="metric-value">${descendantKeys.length}</span>
                </div>
                <div class="proposal-descendants-list" id="proposal-descendants-list" style="max-height: 420px; overflow-y: auto;">
                    ${descendantItemsInitial}
                </div>
            </div>`;
                } else {
                    return `
            <div class="metric-group">
                <span class="metric-label">${tProposal('panel.proposal.sections.generatedParcels', 'Generated parcels:')}</span> <span class="metric-value">0</span>
            </div>`;
                }
            }
            return `
            <div class="metric-group">
                <span class="metric-label">${tProposal('panel.proposal.sections.generatedParcels', 'Generated parcels:')}</span> <span class="metric-value">0</span>
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
    const detailsContent = document.getElementById('proposal-details-content');
    function populateAcceptanceSectionsAsync(proposalForStatus, precomputedOwnerSummary) {
        const parcelContainer = document.getElementById('proposal-parcel-acceptance-section');
        const ownerContainer = document.getElementById('proposal-owner-acceptance-section');
        if (!parcelContainer && !ownerContainer) return;

        const doWork = () => {
            if (parcelContainer) {
                const parcelHtml = buildParcelAcceptanceStatusHtml(proposalForStatus);
                parcelContainer.innerHTML = parcelHtml || '';
            }

            let ownerSummary = precomputedOwnerSummary || buildProposalOwnerAcceptanceSummaryFast(proposalForStatus);
            if (!ownerSummary || ownerSummary.totalOwners === 0) {
                ownerSummary = buildProposalOwnerAcceptanceSummary(proposalForStatus);
            }
            if (ownerContainer) {
                const ownerHtml = buildOwnerAcceptanceStatusHtml(proposalForStatus, ownerSummary);
                ownerContainer.innerHTML = ownerHtml || '';
            }
        };

        // Let the panel paint first, then populate acceptance sections
        requestAnimationFrame(() => setTimeout(doWork, 0));
    }

    const runPostRender = () => {
        // Claims breadcrumb: the BASE parcels this proposal stands on, always one tap away.
        try {
            if (window.__claimsUi && typeof window.__claimsUi.injectProposalBreadcrumb === 'function') {
                window.__claimsUi.injectProposalBreadcrumb(detailsContent, fullProposal || proposal);
            }
        } catch (_) { }
        detailsContent?.querySelectorAll('[data-related-proposal-id]').forEach(button => {
            button.addEventListener('click', () => {
                const relatedProposalId = button.dataset.relatedProposalId;
                if (!relatedProposalId || typeof focusProposalDetails !== 'function') return;
                focusProposalDetails(relatedProposalId, { centerOnProposal: true, showDetails: true });
            });
        });
        // Lazy append remaining ancestor parcels
        setupLazyList('proposal-parent-parcels-list', parentParcelItemsRemaining, renderAncestorParcelItem);
        // Lazy append remaining descendant parcels
        setupLazyList('proposal-descendants-list', descendantItemsRemaining, renderDescendantItem);
        // Populate acceptance sections asynchronously to avoid blocking panel open
        populateAcceptanceSectionsAsync(fullProposal || proposal, ownerAcceptanceSummaryFast);
    };

    if (detailsContent && parcelIds.length > 20) {
        // Only show spinner for proposals with many parcels
        const loadingText = tProposal('panel.proposal.rendering', 'Rendering proposal details...');
        detailsContent.innerHTML = `
            <div class="loader-spinner" role="status" aria-live="polite" style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px; min-height: 200px;">
                <div class="spinner-circle" aria-hidden="true"></div>
                <span class="loader-text" style="margin-top: 16px; color: #666;">${loadingText}</span>
            </div>
        `;

        // Defer heavy DOM insertion and chunk it across animation frames
        setTimeout(() => {
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
                    runPostRender();
                }
            };

            requestAnimationFrame(appendChunk);
        }, 0);
    } else {
        // Set innerHTML which resets scroll to 0
        if (detailsContent) {
            detailsContent.innerHTML = content;
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

    // Pledge totals are chain state, not proposal metadata. Hydrate after rendering so a slow RPC
    // never delays opening Details, and guard the DOM node in case the user selected another plan.
    if (isSolanaPledgeProposal && window.SolanaPledgeBridge?.readSummary) {
        Promise.resolve(window.SolanaPledgeBridge.readSummary(nftInfo.tokenId))
            .then(summary => {
                const card = document.querySelector(`.proposal-pledge-summary[data-proposal-account="${nftInfo.tokenId}"]`);
                if (!card) return;
                const donated = summary?.donations?.totalDonated || 0n;
                const pledged = summary?.pledges?.activePledged || 0n;
                const donors = summary?.donations?.donorCount || 0n;
                const pledgers = summary?.pledges?.activeCount || 0n;
                const released = summary?.donations?.totalReleased || 0n;
                const refunded = summary?.donations?.totalRefunded || 0n;
                const fulfilled = summary?.pledges?.totalFulfilled || 0n;
                const format = window.SolanaPledgeClient.formatUsdc;
                const donationStatus = summary?.donations?.released
                    ? `${format(released)} USDC released`
                    : (supportLifecycle === 'Cancelled' || supportLifecycle === 'Expired')
                        ? `${format(refunded)} USDC refunded · remaining donations refundable`
                        : 'Held in refundable escrow until execution';
                const pledgeStatus = fulfilled > 0n
                    ? `${format(fulfilled)} USDC fulfilled`
                    : 'Soft commitments; funds stay in each wallet';
                const donatedNode = card.querySelector('[data-funding="donated"]');
                const pledgedNode = card.querySelector('[data-funding="pledged"]');
                const donationStatusNode = card.querySelector('[data-funding="donation-status"]');
                const pledgeStatusNode = card.querySelector('[data-funding="pledge-status"]');
                if (donatedNode) donatedNode.textContent = `${format(donated)} USDC · ${donors} donor${donors === 1n ? '' : 's'}`;
                if (pledgedNode) pledgedNode.textContent = `${format(pledged)} USDC · ${pledgers} active`;
                if (donationStatusNode) donationStatusNode.textContent = donationStatus;
                if (pledgeStatusNode) pledgeStatusNode.textContent = pledgeStatus;

                const myDonationRows = Array.isArray(summary?.myDonations) ? summary.myDonations : [];
                const myDonated = myDonationRows.reduce((total, row) => total + (row.refunded ? 0n : row.amount), 0n);
                const myRefunded = myDonationRows.reduce((total, row) => total + (row.refunded ? row.amount : 0n), 0n);
                const myPledge = summary?.myPledge;
                const pledgeLabels = ['active', 'fulfilled', 'revoked', 'voided'];
                const mySupport = card.querySelector('[data-funding="you"]');
                if (mySupport && summary?.wallet) {
                    const donationCopy = myDonationRows.length
                        ? `${format(myDonated)} USDC donated${myRefunded ? ` · ${format(myRefunded)} refunded` : ''}`
                        : 'no donations';
                    const pledgeCopy = myPledge
                        ? `${format(myPledge.amount)} USDC pledge · ${pledgeLabels[myPledge.status] || 'unknown'}`
                        : 'no pledge';
                    mySupport.textContent = `Your support: ${donationCopy}; ${pledgeCopy}.`;
                }
                const actions = document.querySelector(`[data-proposal-support-actions="${nftInfo.tokenId}"]`);
                if (actions) actions.innerHTML = renderSupportButtons(summary, true);
            })
            .catch(error => {
                console.warn('Could not load proposal pledge totals', error);
                const card = document.querySelector(`.proposal-pledge-summary[data-proposal-account="${nftInfo.tokenId}"]`);
                if (card) card.querySelectorAll('[data-funding="donated"], [data-funding="pledged"]').forEach(node => {
                    node.textContent = tProposal('panel.proposal.pledge.unavailable', 'Unavailable');
                });
            });
    }

    if (isSolanaPledgeProposal && window.ProposalPossibilityTimeline?.build) {
        hydrateProposalPossibilityTimeline(
            nftInfo.tokenId,
            fullProposal?.proposalId || '',
            fullProposal?.createdAt || fullProposal?.created_at || proposal?.createdAt || proposal?.created_at || null
        );
    }

    // Market reads use the same proposal account and wallet context as pledge hydration, but the
    // market itself is optional: agent runs may open it later. Never make Details wait on RPC.
    if (isSolanaPledgeProposal && window.SolanaMarketBridge?.readSummary) {
        hydrateProposalMarketCard(nftInfo.tokenId, supportLifecycle);
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

    } catch (_) { }

    // Initialize expiry countdown timer if present
    initializeExpiryCountdown();

    // Initialize decay countdown animation if present
    initializeDecayCountdown();

    const detailsPanel = document.getElementById('proposal-details-panel');
    if (detailsPanel) {
        // Normally opening details expands the panel. Right after creating a proposal we open it
        // collapsed instead (one-shot flag set by the create flow) — the collapsed card still shows
        // the Apply/Share actions, so the freshly-made proposal isn't a wall of detail on arrival.
        const startCollapsed = (typeof window !== 'undefined' && window.__openProposalDetailsCollapsed === true);
        if (typeof window !== 'undefined') window.__openProposalDetailsCollapsed = false;
        setProposalDetailsPanelMinimized(detailsPanel, startCollapsed, getProposalDetailsPanelLabels());
        detailsPanel.classList.add('visible');
    } else {
        console.warn('[showProposalInfo] Proposal details panel element not found');
    }
    document.body.classList.add('proposal-details-open');
    // Close on Escape when this panel is the active proposal surface
    installProposalDetailsEscapeHandler();
    bindProposalSupportWalletRefresh();

    // Setup click listeners for any clickable links in the proposal info
    if (typeof setupGameLogClickListeners === 'function') {
        setupGameLogClickListeners();
    }
}

let proposalSupportWalletRefreshBound = false;
let proposalSupportWalletRefreshTimer = null;

function bindProposalSupportWalletRefresh() {
    if (proposalSupportWalletRefreshBound || !window.solanaWalletManager?.on) return;
    proposalSupportWalletRefreshBound = true;
    const refresh = () => {
        clearTimeout(proposalSupportWalletRefreshTimer);
        proposalSupportWalletRefreshTimer = setTimeout(() => {
            const panel = document.getElementById('proposal-details-panel');
            const content = document.getElementById('proposal-details-content');
            if (!panel?.classList.contains('visible') || !currentProposalDetailsContext) return;
            showProposalInfo(currentProposalDetailsContext, null, { scrollTop: content?.scrollTop || 0 });
        }, 0);
    };
    ['connect', 'disconnect', 'accountsChanged'].forEach(event => window.solanaWalletManager.on(event, refresh));
}

function resolveProposalForBoost(idOrHash) {
    if (typeof proposalStorage !== 'undefined' && typeof proposalStorage.findProposalByIdOrHash === 'function') {
        const found = proposalStorage.findProposalByIdOrHash(idOrHash);
        if (found) return found;
    }
    if (window.currentlyHighlightedProposal) return window.currentlyHighlightedProposal;
    return null;
}

const proposalSupportInFlight = new Set();
const proposalMarketInFlight = new Set();

function proposalTimelineEvidenceText(evidence) {
    if (!evidence) return '';
    const parts = [];
    if (evidence.actor) parts.push(evidence.actor);
    if (evidence.action) parts.push(evidence.action);
    if (evidence.amount) parts.push(`${evidence.amount} USDC`);
    if (evidence.side) parts.push(String(evidence.side).toUpperCase());
    if (evidence.occurredAt) {
        const parsed = Date.parse(evidence.occurredAt);
        parts.push(Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : evidence.occurredAt);
    }
    return parts.join(' · ');
}

function renderProposalPossibilityTimeline(card, model) {
    const list = card?.querySelector('[data-timeline-stages]');
    const state = card?.querySelector('[data-timeline-state]');
    if (!list) return;
    if (state) state.textContent = model.complete ? 'Loop complete' : `Next: ${model.current || 'public outcome'}`;
    list.replaceChildren();
    model.stages.forEach((stage, index) => {
        const item = document.createElement('li');
        item.className = `is-${stage.status}`;
        const marker = document.createElement('span');
        marker.className = 'proposal-possibility-marker';
        marker.textContent = String(index + 1).padStart(2, '0');
        const copy = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = stage.title;
        const description = document.createElement('p');
        description.textContent = stage.description;
        copy.append(title, description);
        if (stage.evidence) {
            const evidence = document.createElement('small');
            evidence.textContent = proposalTimelineEvidenceText(stage.evidence);
            copy.append(evidence);
            const href = stage.evidence.sourceUrl || (stage.evidence.transaction
                ? `https://explorer.solana.com/tx/${encodeURIComponent(stage.evidence.transaction)}?cluster=devnet`
                : null);
            if (href) {
                const link = document.createElement('a');
                link.href = href; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Verify ↗';
                copy.append(link);
            }
        } else {
            const pending = document.createElement('small');
            pending.textContent = stage.status === 'current' ? 'Open for action' : 'No public evidence yet';
            copy.append(pending);
        }
        item.append(marker, copy);
        list.append(item);
    });
}

async function hydrateProposalPossibilityTimeline(proposalAccount, proposalId, createdAt = null) {
    const card = document.querySelector(`[data-proposal-timeline="${proposalAccount}"]`);
    if (!card || !window.ProposalPossibilityTimeline?.build) return;
    const base = typeof window.getBackendBase === 'function'
        ? window.getBackendBase().replace(/\/$/, '')
        : 'https://api.urbangametheory.xyz';
    let events = typeof allActivityEvents === 'function' ? allActivityEvents() : [];
    let oracleEvents = [];
    const [activityResult, oracleResult] = await Promise.allSettled([
        fetch(`${base}/agent/activity?limit=200`).then(response => response.ok ? response.json() : Promise.reject(new Error(`activity returned ${response.status}`))),
        fetch(`${base}/oracle/events?subject=${encodeURIComponent(proposalAccount)}&limit=10`).then(response => response.ok ? response.json() : Promise.reject(new Error(`oracle returned ${response.status}`)))
    ]);
    if (activityResult.status === 'fulfilled') {
        const live = Array.isArray(activityResult.value?.events) ? activityResult.value.events : [];
        events = window.AgentActionEngine?.mergeActivities
            ? window.AgentActionEngine.mergeActivities(events, live)
            : [...events, ...live];
    }
    if (oracleResult.status === 'fulfilled') {
        oracleEvents = Array.isArray(oracleResult.value?.events) ? oracleResult.value.events : [];
    }
    renderProposalPossibilityTimeline(card, window.ProposalPossibilityTimeline.build({
        proposalId, proposalAccount, createdAt, events, oracleEvents
    }));
}

function marketSideLabel(side) {
    return Number(side) === 1 ? 'YES' : 'NO';
}

function marketSideValue(side) {
    return Number(side) === 1 ? 1 : 0;
}

function marketCardForProposal(proposalAccount) {
    return document.querySelector(`.proposal-market-summary[data-proposal-account="${proposalAccount}"]`);
}

function setProposalMarketStatus(card, text = '', explorerUrl = '') {
    const node = card?.querySelector('[data-market="status"]');
    if (!node) return;
    node.textContent = text;
    if (explorerUrl) {
        const link = document.createElement('a');
        link.href = explorerUrl;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = ' View on Solana Explorer ↗';
        node.appendChild(link);
    }
}

function hydrateProposalMarketCard(proposalAccount, lifecycle) {
    const card = marketCardForProposal(proposalAccount);
    if (!card || !window.SolanaMarketBridge?.readSummary || !window.ProposalMarketView) return;
    Promise.resolve(window.SolanaMarketBridge.readSummary(proposalAccount))
        .then(summary => {
            renderProposalMarketCard(card, proposalAccount, lifecycle, summary);
            hydrateProposalMarketOracle(card, proposalAccount, summary?.marketAddress || '');
            hydrateProposalMarketHistory(card, proposalAccount, card.dataset.proposalId || '');
        })
        .catch(error => {
            const state = card.querySelector('[data-market="state"]');
            if (state) state.textContent = 'Unavailable';
            card.querySelectorAll('[data-market="yes"], [data-market="no"]').forEach(node => { node.textContent = 'Unavailable'; });
            setProposalMarketStatus(card, window.ProposalMarketView?.errorText?.(error) || error?.message || 'Could not load market state.');
        });
}

async function hydrateProposalMarketOracle(card, proposalAccount, marketAccount) {
    const state = card?.querySelector('[data-market="oracle-state"]');
    const recipeLink = card?.querySelector('[data-market="recipe-link"]');
    const eventLink = card?.querySelector('[data-market="event-link"]');
    if (!state || !window.ProposalMarketView?.oracleEvidence) return;
    const t = getProposalI18nHelper();
    const base = typeof window.getBackendBase === 'function'
        ? window.getBackendBase().replace(/\/$/, '')
        : 'https://api.urbangametheory.xyz';
    const recipeUrl = `${base}/oracle/recipes/proposal-lifecycle-v1?proposal=${encodeURIComponent(proposalAccount)}${marketAccount ? `&market=${encodeURIComponent(marketAccount)}` : ''}`;
    const eventsUrl = `${base}/oracle/events?subject=${encodeURIComponent(proposalAccount)}&limit=1`;
    if (recipeLink) { recipeLink.href = recipeUrl; recipeLink.hidden = false; }
    try {
        const [recipeResponse, eventResponse] = await Promise.all([fetch(recipeUrl), fetch(eventsUrl)]);
        if (!recipeResponse.ok) throw new Error(`recipe returned ${recipeResponse.status}`);
        if (!eventResponse.ok) throw new Error(`events returned ${eventResponse.status}`);
        const [{ recipe }, eventPayload] = await Promise.all([recipeResponse.json(), eventResponse.json()]);
        const event = Array.isArray(eventPayload.events) ? eventPayload.events[0] || null : null;
        const model = window.ProposalMarketView.oracleEvidence(recipe, event);
        state.textContent = `${model.label}. ${model.detail}`;
        card.dataset.oracleTone = model.tone;
        const eventUrl = event?.source?.transactionUrl || event?.source?.url || null;
        if (eventLink && eventUrl) { eventLink.href = eventUrl; eventLink.hidden = false; }
    } catch (error) {
        const model = window.ProposalMarketView.oracleEvidence(null, null, error.message || error);
        state.textContent = `${model.label}. ${model.detail} ${t('panel.proposal.market.finalVerifier', 'The Solana program remains the final verifier.')}`;
        card.dataset.oracleTone = model.tone;
    }
}

async function hydrateProposalMarketHistory(card, proposalAccount, proposalId) {
    const container = card?.querySelector('[data-market="history"]');
    if (!container || !window.ProposalMarketView?.marketHistory) return;
    let events = typeof allActivityEvents === 'function' ? allActivityEvents() : [];
    try {
        const base = typeof window.getBackendBase === 'function'
            ? window.getBackendBase().replace(/\/$/, '')
            : 'https://api.urbangametheory.xyz';
        const response = await fetch(`${base}/agent/activity?limit=100`);
        if (response.ok) {
            const payload = await response.json();
            const live = Array.isArray(payload.events) ? payload.events : [];
            events = window.AgentActionEngine?.mergeActivities
                ? window.AgentActionEngine.mergeActivities(events, live)
                : [...events, ...live];
        }
    } catch (_) {
        // Local confirmed wallet actions remain useful when the public feed is temporarily offline.
    }
    const history = window.ProposalMarketView.marketHistory(events, [proposalAccount, proposalId]).slice(0, 5);
    const heading = document.createElement('strong');
    heading.textContent = 'Recent market transactions';
    container.replaceChildren(heading);
    if (!history.length) {
        const empty = document.createElement('span');
        empty.textContent = 'No transaction-backed market actions found in the recent activity window.';
        container.append(empty);
        return;
    }
    history.forEach(event => {
        const row = document.createElement('span');
        const label = event.action?.type === 'createMarket' ? 'Opened market' : event.action?.type === 'stake' ? 'Staked' : event.action?.type === 'resolve' ? 'Resolved' : 'Claimed';
        const actor = event.actor?.name ? `${event.actor.name} · ` : '';
        row.append(document.createTextNode(`${actor}${label} · `));
        const link = document.createElement('a');
        link.href = `https://explorer.solana.com/tx/${encodeURIComponent(event.transaction)}?cluster=devnet`;
        link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'transaction ↗';
        row.append(link);
        container.append(row);
    });
}

function renderProposalMarketCard(card, proposalAccount, lifecycle, summary) {
    const view = window.ProposalMarketView;
    const model = view.model(summary?.market, { yes: summary?.yes, no: summary?.no });
    const lifecycleModel = view.lifecycle(lifecycle, model);
    const state = card.querySelector('[data-market="state"]');
    const yes = card.querySelector('[data-market="yes"]');
    const no = card.querySelector('[data-market="no"]');
    const yesOdds = card.querySelector('[data-market="yes-odds"]');
    const noOdds = card.querySelector('[data-market="no-odds"]');
    const mine = card.querySelector('[data-market="you"]');
    const controls = card.querySelector('[data-market="controls"]');
    const rule = card.querySelector('[data-market="rule"]');
    const next = card.querySelector('[data-market="next"]');
    const marketAccountLink = card.querySelector('[data-market="account-link"]');
    if (rule) rule.textContent = lifecycleModel.rule;
    if (next) next.textContent = lifecycleModel.next;
    if (marketAccountLink && summary?.marketAddress) {
        marketAccountLink.href = `https://explorer.solana.com/address/${encodeURIComponent(summary.marketAddress)}?cluster=devnet`;
        marketAccountLink.hidden = !model.exists;
    }
    if (!model.exists) {
        if (state) state.textContent = lifecycleModel.state;
        if (yes) yes.textContent = '—';
        if (no) no.textContent = '—';
        if (yesOdds) yesOdds.textContent = 'No stakes yet';
        if (noOdds) noOdds.textContent = 'No stakes yet';
        if (mine) mine.textContent = 'No market has been opened for this proposal yet.';
        if (controls) controls.innerHTML = !summary?.wallet
            ? (lifecycleModel.canOpen ? '<button type="button" class="btn btn-outline-primary" onclick="handleWalletButtonClick()">Connect Solana wallet</button>' : `<span class="proposal-market-muted">${safeAgentText(lifecycleModel.next)}</span>`)
            : !lifecycleModel.canOpen
                ? `<span class="proposal-market-muted">${safeAgentText(lifecycleModel.next)}</span>`
                : `<button type="button" class="btn btn-outline-primary" onclick="settleProposalMarket(${inlineJsArg(proposalAccount)}, 'createMarket')">Open market</button>`;
        return;
    }
    if (state) state.textContent = lifecycleModel.state;
    if (yes) yes.textContent = `${view.formatAtomic(model.yesPool)} USDC`;
    if (no) no.textContent = `${view.formatAtomic(model.noPool)} USDC`;
    if (yesOdds) yesOdds.textContent = model.yesOdds === null ? 'No odds yet' : `${model.yesOdds}% implied odds`;
    if (noOdds) noOdds.textContent = model.noOdds === null ? 'No odds yet' : `${model.noOdds}% implied odds`;
    const positionLines = [];
    if (model.yesPosition) positionLines.push(`YES: ${view.formatAtomic(model.yesPosition.amount)} USDC${model.yesPosition.claimed ? ' · claimed' : ''}`);
    if (model.noPosition) positionLines.push(`NO: ${view.formatAtomic(model.noPosition.amount)} USDC${model.noPosition.claimed ? ' · claimed' : ''}`);
    if (mine) mine.textContent = summary?.wallet ? (positionLines.length ? `Your position — ${positionLines.join('; ')}.` : 'You have no position in this market.') : 'Connect a Solana wallet to see your market position.';
    if (!controls) return;
    if (!summary?.wallet) {
        controls.innerHTML = (lifecycleModel.canStake || lifecycleModel.canResolve || model.canClaim)
            ? '<button type="button" class="btn btn-outline-primary" onclick="handleWalletButtonClick()">Connect Solana wallet</button>'
            : `<span class="proposal-market-muted">${safeAgentText(lifecycleModel.next)}</span>`;
        return;
    }
    if (model.resolved) {
        controls.innerHTML = model.claimSides.map(side => `<button type="button" class="btn btn-success" onclick="settleProposalMarket(${inlineJsArg(proposalAccount)}, 'claim', ${side === 'yes' ? 1 : 0})">Claim ${side.toUpperCase()}</button>`).join('')
            || '<span class="proposal-market-muted">No claimable position.</span>';
        return;
    }
    if (lifecycleModel.canResolve) {
        controls.innerHTML = `<button type="button" class="btn btn-outline-secondary" onclick="settleProposalMarket(${inlineJsArg(proposalAccount)}, 'resolve')">Resolve ${lifecycleModel.expectedOutcome.toUpperCase()} from proposal status</button>`;
    } else if (lifecycleModel.canStake) {
        controls.innerHTML = `
            <button type="button" class="btn btn-market-yes" onclick="openProposalMarketStakeDialog(${inlineJsArg(proposalAccount)}, 1)">Stake YES</button>
            <button type="button" class="btn btn-market-no" onclick="openProposalMarketStakeDialog(${inlineJsArg(proposalAccount)}, 0)">Stake NO</button>`;
    } else {
        controls.innerHTML = `<span class="proposal-market-muted">${safeAgentText(lifecycleModel.next)}</span>`;
    }
}

function openProposalMarketStakeDialog(proposalAccount, side) {
    const existing = document.getElementById('proposalMarketOverlay');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    const label = marketSideLabel(side);
    overlay.id = 'proposalMarketOverlay';
    overlay.className = 'proposal-boost-overlay';
    overlay.addEventListener('click', event => { if (event.target === overlay) overlay.remove(); });
    overlay.innerHTML = `
        <div class="proposal-boost-modal" role="dialog" aria-modal="true" aria-labelledby="proposal-market-title">
            <div class="proposal-boost-header"><h3 id="proposal-market-title">Stake ${label}</h3><button type="button" class="proposal-boost-close" aria-label="Close market dialog">×</button></div>
            <div class="proposal-boost-body">
                <p class="proposal-boost-copy">Stake devnet USDC on whether this proposal executes (YES) or is cancelled (NO). Stakes remain locked until market resolution.</p>
                <div class="proposal-offer-row proposal-boost-row" style="display:flex; gap:8px; align-items:center;"><input type="text" data-market-amount placeholder="1.00" inputmode="decimal" autocomplete="off"><span class="proposal-market-currency">USDC</span></div>
                <div class="proposal-boost-actions"><button type="button" class="btn proposal-boost-send" data-market-submit>Stake ${label}</button></div>
                <div class="proposal-market-status" data-market-dialog-status aria-live="polite"></div>
            </div>
        </div>`;
    overlay.querySelector('.proposal-boost-close')?.addEventListener('click', () => overlay.remove());
    overlay.querySelector('[data-market-submit]')?.addEventListener('click', () => submitProposalMarketStake(proposalAccount, marketSideValue(side), overlay));
    document.body.appendChild(overlay);
    overlay.querySelector('[data-market-amount]')?.focus();
}

async function submitProposalMarketStake(proposalAccount, side, overlay) {
    const view = window.ProposalMarketView;
    const rawAmount = overlay?.querySelector('[data-market-amount]')?.value || '';
    const button = overlay?.querySelector('[data-market-submit]');
    const status = (text, url = '') => {
        const node = overlay?.querySelector('[data-market-dialog-status]');
        if (!node) return;
        node.textContent = text;
        if (url) {
            const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener'; link.textContent = ' View on Solana Explorer ↗'; node.appendChild(link);
        }
    };
    let amount;
    try { amount = view.parseUsdc(rawAmount); } catch (error) { status(error.message); return; }
    const wallet = window.solanaWalletManager?.getState?.()?.accounts?.[0] || 'wallet';
    const key = `stake:${proposalAccount}:${wallet}:${side}`;
    if (proposalMarketInFlight.has(key)) return;
    proposalMarketInFlight.add(key);
    if (button) button.disabled = true;
    try {
        const result = await window.SolanaMarketBridge.stake({ proposal: proposalAccount, side, amount, onStatus: item => status(view.statusText(item), item.explorerUrl) });
        status('Confirmed on Solana.', result.explorerUrl);
        await recordHumanProposalSupport({ wallet, action: 'stake', proposalId: proposalAccount, amount: rawAmount, result, message: `${proposalSupportActor(wallet).name} staked ${rawAmount} USDC on ${marketSideLabel(side)}.` });
        setTimeout(() => { overlay?.remove(); hydrateProposalMarketCard(proposalAccount, currentProposalDetailsContext ? getLifecycleStatus(currentProposalDetailsContext) : ''); }, 300);
    } catch (error) {
        status(view.errorText(error), error?.explorerUrl);
    } finally {
        proposalMarketInFlight.delete(key);
        if (button) button.disabled = false;
    }
}

async function settleProposalMarket(proposalAccount, action, side = null) {
    const card = marketCardForProposal(proposalAccount);
    const view = window.ProposalMarketView;
    const wallet = window.solanaWalletManager?.getState?.()?.accounts?.[0] || 'wallet';
    const key = `${action}:${proposalAccount}:${wallet}:${side ?? ''}`;
    if (proposalMarketInFlight.has(key)) return;
    proposalMarketInFlight.add(key);
    setProposalMarketStatus(card, action === 'claim' ? 'Preparing claim…'
        : action === 'createMarket' ? 'Preparing market…' : 'Preparing market resolution…');
    try {
        const result = await window.SolanaMarketBridge[action]({ proposal: proposalAccount, ...(side === null ? {} : { side }), onStatus: item => setProposalMarketStatus(card, view.statusText(item), item.explorerUrl) });
        const message = action === 'claim' ? `Claimed ${marketSideLabel(side)} position.`
            : action === 'createMarket' ? 'Opened the proposal prediction market.'
                : 'Market resolved from the proposal’s on-chain terminal status.';
        setProposalMarketStatus(card, 'Confirmed on Solana.', result.explorerUrl);
        await recordHumanProposalSupport({ wallet, action, proposalId: proposalAccount, result, message: `${proposalSupportActor(wallet).name}: ${message}` });
        hydrateProposalMarketCard(proposalAccount, currentProposalDetailsContext ? getLifecycleStatus(currentProposalDetailsContext) : '');
    } catch (error) {
        setProposalMarketStatus(card, view?.errorText?.(error) || error?.message || 'Market transaction failed.', error?.explorerUrl);
    } finally {
        proposalMarketInFlight.delete(key);
    }
}

function proposalSupportActor(wallet) {
    return { id: wallet, name: wallet ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : 'Wallet user', wallet, controller: 'human' };
}

async function recordHumanProposalSupport({ wallet, action, proposalId, amount = null, result, message }) {
    if (typeof window.dispatchAgentAction !== 'function') return;
    const transaction = result?.transactionHash || result?.transactionHashes?.[0] || null;
    await window.dispatchAgentAction(proposalSupportActor(wallet), { type: action, proposalId, amount }, {
        source: 'live',
        outcome: {
            id: transaction ? `solana:${transaction}` : `wallet:${wallet}:${action}:${proposalId}:${Date.now()}`,
            ok: true, transaction, message
        }
    });
}

function openProposalBoostDialog(idOrHash = null, supportKind = 'pledge') {
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

    const boostKey = proposal.proposalId || proposal.tokenId || idOrHash || '';
    const overlay = document.createElement('div');
    overlay.id = 'proposalBoostOverlay';
    overlay.className = 'proposal-boost-overlay';
    overlay.addEventListener('click', event => {
        if (event.target === overlay) {
            closeProposalBoostDialog();
        }
    });

    const isDonation = supportKind === 'donate';
    const modalTitle = isDonation ? 'Donate to this proposal' : tProposalUI('panel.proposal.boost.title', 'Pledge to this proposal');
    const modalCloseLabel = isDonation ? 'Close donation dialog' : tProposalUI('panel.proposal.boost.closeLabel', 'Close pledge dialog');
    const modalCopy = isDonation
        ? 'Donate devnet USDC now. It stays in proposal escrow until execution, and you can refund it if the proposal is cancelled or expires.'
        : 'Publish a revocable USDC commitment. No USDC leaves your wallet now; after execution, you choose whether to fulfil it.';
    const sendLabel = isDonation ? 'Donate' : tProposalUI('panel.proposal.boost.send', 'Pledge');
    overlay.dataset.supportKind = isDonation ? 'donate' : 'pledge';
    overlay.dataset.pledgeOperationId = (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function')
        ? globalThis.crypto.randomUUID()
        : `pledge-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    overlay.innerHTML = `
        <div class="proposal-boost-modal" role="dialog" aria-modal="true">
            <div class="proposal-boost-header">
                <h3>${modalTitle}</h3>
                <button type="button" class="proposal-boost-close" aria-label="${modalCloseLabel}" onclick="closeProposalBoostDialog()">×</button>
            </div>
            <div class="proposal-boost-body">
                <p class="proposal-boost-copy">${modalCopy}</p>
                <div class="proposal-support-wallet-summary" data-support-wallet-summary aria-live="polite">Checking wallet balances…</div>
                <div class="proposal-offer-row proposal-boost-row" style="display:flex; gap:8px; align-items:center;">
                    <input type="text" id="proposalBoostAmount" placeholder="1.00" inputmode="decimal" autocomplete="off" style="flex:1 1 auto;">
                    <select id="proposalBoostCurrency" style="flex:0 0 112px; max-width:112px; min-width:112px;">
                        <option value="USDC">USDC</option>
                    </select>
                </div>
                <div class="proposal-boost-actions" style="display:flex; flex-direction:column; align-items:center; gap:6px;">
                    <button type="button" class="btn proposal-boost-send" data-support-submit style="min-width:100px; width:120px;" onclick="submitProposalBoost(${inlineJsArg(boostKey)})">${sendLabel}</button>
                    <div class="proposal-boost-status" id="proposalBoostStatus" aria-live="polite" style="font-size:12px; text-align:center; min-height:18px;"></div>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    const walletSummary = overlay.querySelector('[data-support-wallet-summary]');
    if (window.SolanaPledgeBridge?.walletBalances) {
        window.SolanaPledgeBridge.walletBalances().then(balance => {
            if (!walletSummary?.isConnected) return;
            walletSummary.textContent = `${balance.usdc} devnet USDC · ${balance.sol.toFixed(4)} SOL for fees${isDonation ? '' : ' · pledging does not move USDC now'}`;
        }).catch(error => {
            if (!walletSummary?.isConnected) return;
            walletSummary.textContent = window.ProposalSupportView?.errorText?.(error, supportKind) || error.message;
        });
    } else if (walletSummary) {
        walletSummary.textContent = 'Connect a Solana devnet wallet to view balances.';
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
    const overlay = document.getElementById('proposalBoostOverlay');
    const supportKind = overlay?.dataset?.supportKind === 'donate' ? 'donate' : 'pledge';
    const submitButton = overlay?.querySelector('[data-support-submit]');
    const amountInput = document.getElementById('proposalBoostAmount');
    const statusEl = document.getElementById('proposalBoostStatus');
    const setBoostStatus = (text = '') => {
        if (statusEl) {
            statusEl.textContent = text;
        }
    };
    setBoostStatus('');
    const rawAmount = amountInput ? amountInput.value.trim() : '';
    try {
        if (!window.SolanaPledgeClient || window.SolanaPledgeClient.parseUsdc(rawAmount) <= 0n) throw new Error('invalid');
    } catch (_) {
        showProposalAlertMessage('please_enter_a_valid_boost_amount', 'Please enter a valid boost amount.');
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

    const solWm = window.solanaWalletManager;
    const solState = solWm && typeof solWm.getState === 'function' ? solWm.getState() : null;
    const isSolanaConnected = solState && solState.status === 'connected' && Array.isArray(solState.accounts) && solState.accounts.length > 0;
    if (!isSolanaConnected) {
        showProposalAlertMessage('proposal_boost_wallet_required', `Connect a Solana wallet to ${supportKind === 'donate' ? 'donate to' : 'pledge to'} this proposal.`);
        if (typeof handleWalletButtonClick === 'function') {
            handleWalletButtonClick();
        }
        return;
    }
    const targetChainId = normalizeChainIdForBoost(nftInfo.chain || null);
    if (typeof targetChainId !== 'string' || !targetChainId.startsWith('solana')) {
        showProposalAlertMessage('proposal_boost_failed', `${supportKind === 'donate' ? 'Donations' : 'Pledges'} currently require a Solana proposal.`);
        return;
    }
    if (!window.SolanaPledgeBridge || typeof window.SolanaPledgeBridge[supportKind] !== 'function') {
        showProposalAlertMessage('proposal_boost_failed', `${supportKind === 'donate' ? 'Donation' : 'Pledge'} transaction failed: blockchain bridge unavailable.`);
        return;
    }
    const pendingKey = `proposalSupportPending:${supportKind}:${nftInfo.tokenId}:${solState.accounts[0]}`;
    if (proposalSupportInFlight.has(pendingKey)) return;
    let operationId = overlay?.dataset?.pledgeOperationId;
    try {
        const pending = JSON.parse(sessionStorage.getItem(pendingKey) || 'null');
        if (pending?.amount === rawAmount && pending?.operationId) operationId = pending.operationId;
        sessionStorage.setItem(pendingKey, JSON.stringify({ amount: rawAmount, operationId }));
    } catch (_) { /* sessionStorage is optional; the open dialog still preserves this retry id */ }
    proposalSupportInFlight.add(pendingKey);
    if (submitButton) submitButton.disabled = true;
    setBoostStatus('Checking your wallet…');
    let txResult;
    try {
        txResult = await window.SolanaPledgeBridge[supportKind]({
            proposal: nftInfo.tokenId,
            amount: rawAmount,
            operationId,
            onStatus: status => setBoostStatus(window.ProposalSupportView?.statusText?.(status, supportKind) || status.state)
        });
    } catch (error) {
        proposalSupportInFlight.delete(pendingKey);
        if (submitButton) submitButton.disabled = false;
        const reason = window.ProposalSupportView?.errorText?.(error, supportKind)
            || (error && (error.reason || error.shortMessage || error.message) ? (error.reason || error.shortMessage || error.message) : 'Unknown error');
        setBoostStatus(reason);
        console.error(`USDC ${supportKind} failed`, error, error?.logs || []);
        const linkOptions = error?.explorerUrl ? { linkUrl: error.explorerUrl, linkText: 'Check transaction on Solana Explorer' } : {};
        showProposalAlertMessage('proposal_boost_failed', `${supportKind === 'donate' ? 'Donation' : 'Pledge'}: ${reason}`, { reason }, linkOptions);
        return;
    }
    proposalSupportInFlight.delete(pendingKey);
    closeProposalBoostDialog();
    try { sessionStorage.removeItem(pendingKey); } catch (_) { }
    const txLink = txResult?.explorerUrl || '';
    const alertOptions = txLink
        ? { linkUrl: txLink, linkText: 'See transaction on Solana Explorer' }
        : {};
    showProposalAlertMessage(
        'proposal_boost_success',
        supportKind === 'donate'
            ? 'Success! {{amount}} USDC was donated into refundable proposal escrow.'
            : 'Success! {{amount}} USDC is publicly pledged; no funds moved yet.',
        { amount: rawAmount, currency: 'USDC', txLink },
        alertOptions
    );
    await recordHumanProposalSupport({
        wallet: solState.accounts[0], action: supportKind,
        proposalId: proposal.proposalId || proposal.tokenId || nftInfo.tokenId,
        amount: rawAmount, result: txResult,
        message: supportKind === 'donate'
            ? `${proposalSupportActor(solState.accounts[0]).name} donated ${rawAmount} USDC to proposal ${proposal.proposalId || proposal.tokenId || nftInfo.tokenId}.`
            : `${proposalSupportActor(solState.accounts[0]).name} pledged ${rawAmount} USDC to proposal ${proposal.proposalId || proposal.tokenId || nftInfo.tokenId}.`
    });
    showProposalInfo(proposal);
}

async function settleProposalSupport(idOrHash, action) {
    const proposal = resolveProposalForBoost(idOrHash);
    const nftInfo = proposal ? getProposalNftInfo(proposal) : null;
    if (!nftInfo?.tokenId || !window.SolanaPledgeBridge?.[action]) {
        showProposalAlertMessage('proposal_boost_failed', 'Proposal support action is unavailable.');
        return;
    }
    const solState = window.solanaWalletManager?.getState?.();
    const wallet = solState?.accounts?.[0] || null;
    const key = `${action}:${nftInfo.tokenId}:${wallet || 'wallet'}`;
    if (proposalSupportInFlight.has(key)) return;
    proposalSupportInFlight.add(key);
    try {
        const result = await window.SolanaPledgeBridge[action]({ proposal: nftInfo.tokenId });
        const linkOptions = result?.explorerUrl ? { linkUrl: result.explorerUrl, linkText: 'See transaction on Solana Explorer' } : {};
        const messages = {
            revokePledge: 'Your pledge was revoked; no USDC moved.',
            fulfillPledge: 'Your pledged USDC was transferred to the proposal owner.',
            voidPledge: 'Your pledge was cleared; no USDC moved.',
            refundMyDonations: 'Your refundable donations were returned.',
            releaseDonations: 'Escrowed donations were released to the proposal owner.'
        };
        const message = messages[action] || 'Proposal support updated successfully.';
        showProposalAlertMessage('proposal_boost_success', message, {}, linkOptions);
        await recordHumanProposalSupport({
            wallet, action, proposalId: proposal.proposalId || proposal.tokenId || nftInfo.tokenId,
            result, message: `${proposalSupportActor(wallet).name}: ${message}`
        });
        showProposalInfo(proposal);
    } catch (error) {
        const reason = window.ProposalSupportView?.errorText?.(error, action) || error?.reason || error?.shortMessage || error?.message || 'Unknown error';
        console.error(`Proposal support ${action} failed`, error, error?.logs || []);
        const linkOptions = error?.explorerUrl ? { linkUrl: error.explorerUrl, linkText: 'Check transaction on Solana Explorer' } : {};
        showProposalAlertMessage('proposal_boost_failed', `Proposal support action failed: ${reason}`, { reason }, linkOptions);
    } finally {
        proposalSupportInFlight.delete(key);
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

    // Drop the amber selected-segment corridor outline: closing the panel means the road is no
    // longer selected. This path (panel close / a parcel taking over the selection) clears proposal
    // highlights but never touched ProposalSelection, so the ProposalSelection subscription that
    // normally repaints/clears the amber never fired here — the outline lingered. Nulling the
    // remembered segment also stops a later strip refresh from repainting it.
    try {
        if (typeof window !== 'undefined') {
            window.corridorLastClickedSegment = null;
            if (typeof window.refreshSelectedCorridorSegmentHighlight === 'function') {
                window.refreshSelectedCorridorSegmentHighlight();
            }
        }
    } catch (_) { }

    // The "At this spot" stack described this selection; with nothing selected it has nothing to
    // describe. It stays put when a parcel is still selected underneath.
    try { window.__drillUi?.hideIfNothingSelected?.(); } catch (_) { }
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

// Opens the external 3D tram sim (city-config walk.url) in a new tab with the
// cab riding on this track proposal's drawn centerline. URL contract consumed
// by zagreb-isochrone's transit.js: ?st3d=cab&track=<serial>&proposals=<serials>.
// The proposals param carries every APPLIED proposal that has a serial id so
// the sim shows the same scene the user built (same filter as the walk
// launcher in three-mode.js, which is closure-private to 3D mode).
function driveTrackProposalIn3DSim(proposalKey) {
    const proposal = (typeof getProposalByIdOrHash === 'function') ? getProposalByIdOrHash(proposalKey) : null;
    const serialId = (proposal && typeof window.getSerialProposalId === 'function')
        ? window.getSerialProposalId(proposal)
        : null;
    const driveConfig = (typeof CityConfigManager !== 'undefined' && typeof CityConfigManager.getDriveConfig === 'function')
        ? CityConfigManager.getDriveConfig()
        : null;
    if (!serialId || !driveConfig || !driveConfig.url) {
        console.warn('[drive] cannot open 3D sim: missing serial id or sim url', { proposalKey, serialId, driveConfig });
        return;
    }

    const appliedSerialIds = [];
    const seenSerialIds = new Set();
    try {
        const storage = window.proposalStorage;
        const all = (storage && typeof storage.getAllProposals === 'function') ? storage.getAllProposals() : [];
        for (const p of all) {
            if (!p) continue;
            const applied = isApplied(p)
                || ['roadProposal', 'buildingProposal', 'structureProposal', 'reparcellization', 'decideLaterProposal']
                    .some(key => p[key] && isApplied(p, p[key]));
            if (!applied) continue;
            const sid = window.getSerialProposalId(p);
            if (sid && !seenSerialIds.has(sid)) {
                seenSerialIds.add(sid);
                appliedSerialIds.push(sid);
            }
        }
    } catch (error) {
        console.warn('[drive] failed to enumerate applied proposals:', error);
    }
    appliedSerialIds.sort((a, b) => Number(a) - Number(b));

    const params = new URLSearchParams();
    params.set('st3d', 'cab');
    params.set('track', serialId);
    if (appliedSerialIds.length) params.set('proposals', appliedSerialIds.join(','));
    // loc selects the sim's per-city world sources (station-3d/core/locations.js).
    if (driveConfig.locParam) params.set('loc', driveConfig.locParam);
    const url = `${driveConfig.url}?${params.toString()}`;
    console.log('[drive] opening 3D cab on track proposal:', url);
    window.open(url, '_blank', 'noopener,noreferrer');
}

if (typeof window !== 'undefined') {
    window.driveTrackProposalIn3DSim = driveTrackProposalIn3DSim;
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
            // No number label on plain MAP hover: it only appeared over proposal-owned parcels,
            // and that inconsistency read as meaning something. Labels for everything live behind
            // the "Show parcel numbers" checkbox; panel-driven hovers (list rows, drill rows)
            // still label, because there the label answers "which shape just lit up".
            showLabels: false
        });
    } catch (error) {
        console.warn('showProposalInfoHoverOverlay failed', error);
    }
}

// A too-long proposal name rotates like text on a cylinder instead of ellipsizing: two copies
// of the name slide left by exactly one copy-width plus the gap (48px, matching the CSS), so
// the loop is seamless. Plain text is both the reset and the fallback — no overflow, a hidden
// panel (clientWidth 0), or reduced motion all keep the ordinary ellipsis.
function applyProposalTitleMarquee(el, text) {
    if (!el) return;
    el.classList.remove('title-marquee');
    el.textContent = text;
    requestAnimationFrame(() => {
        try {
            if (el.textContent !== text) return; // a newer title landed meanwhile
            if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
            if (el.clientWidth === 0 || el.scrollWidth <= el.clientWidth) return;
            const track = document.createElement('span');
            track.className = 'title-marquee-track';
            const first = document.createElement('span');
            first.textContent = text;
            const second = document.createElement('span');
            second.textContent = text;
            second.setAttribute('aria-hidden', 'true');
            track.appendChild(first);
            track.appendChild(second);
            el.textContent = '';
            el.appendChild(track);
            el.classList.add('title-marquee');
            const width = first.getBoundingClientRect().width || el.scrollWidth;
            const distance = width + 48;
            track.style.setProperty('--marquee-distance', `${distance}px`);
            track.style.setProperty('--marquee-duration', `${Math.max(6, Math.round(distance / 30))}s`);
        } catch (_) { /* the plain text set above stays as the fallback */ }
    });
}
