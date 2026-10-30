// proposals/details-panel.js — extracted from proposals.js (behavior-preserving relocation).

// The details panel's open tab (Overview or Details; Input or Output parcels on a parcel layout); a different proposal starts on Overview.
let proposalDetailsTab = 'overview';

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
        shouldShowDetails,
        false,
        { presentation: options.presentation || 'details' }
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

function showProposalInfo(proposal, currentParcelId = null, preserveScrollPosition = null, options = {}) {
    // This renderer supplies a click-panel body; routes, lists and refreshes never open a
    // second proposal surface. Only the click panel may request an unhosted initial render.
    const activeActionsPanel = document.getElementById('proposal-details-panel');
    const activeActionsContent = document.getElementById('proposal-details-content');
    const refreshingActions = activeActionsPanel?.classList.contains('visible')
        && activeActionsContent?.dataset.proposalId === String(getProposalKey(proposal))
        && !!activeActionsPanel.closest?.('#click-stack');
    if (!options.hosted && !refreshingActions) {
        return window.ClickStack.showDesign(getProposalKey(proposal));
    }
    // The proposal action panel is 2D-only for now: in 3D the selection/isolation machinery
    // still runs, but the button box would float context-less over the scene.
    if (typeof document !== 'undefined' && document.body?.classList?.contains('three-mode-active')) {
        try { hideProposalDetailsPanel(true); } catch (_) { }
        return;
    }
    // A running before/after belongs to the proposal it was opened for, for as long as it stays
    // applied; any other render of the panel ends it (js/proposals/before-after.js).
    try { window.ProposalBeforeAfter?.reconcile(proposal, getProposalKey(proposal)); } catch (_) { /* no map yet */ }

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

    // The details panel takes the right of the map: fold away an open sheet.
    if (window.MapShell) window.MapShell.closeSheets();

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
        const referenceState = window.ProposalPanelPresentation.parcelReferenceState({
            hasGeometry: !!geometry, replacedInModel: isReplaced
        });

        return {
            parcelId: getParcelIdFromFeature(displayFeature) || canonicalId,
            parcel: null,
            feature: displayFeature,
            geometry,
            referenceState
        };
    };

    const MAX_LIST_INITIAL = 20;
    const perfStartParcelFeatures = performance.now();
    // Resolve only the first batch synchronously. Remaining rows resolve via setupLazyList
    // (string ids → buildAncestorRow on render) so initial open cost is bounded by MAX_LIST_INITIAL,
    // not by cadastreParcelIds.length.
    const parentParcels = cadastreParcelIds.slice(0, MAX_LIST_INITIAL).map(buildAncestorRow).filter(Boolean);
    const perfEndParcelFeatures = performance.now();

    // Site and source-parcel area are different extents. Inspect all retained source records,
    // independently of the first 20 rendered rows; peekMany neither fetches nor clones geometry.
    // Missing areas remain unknown, and a partial source sum states its measurement coverage.
    // Source records may carry calculated_area or its normalized calculatedArea spelling;
    // otherwise measure their retained geometry without fetching another source.
    const sourceFeatures = window.CadastralParcelRepository?.peekMany?.(cadastreParcelIds) || [];
    let siteAreaM2 = null;
    if (fullProposal.site && window.__siteDraft?.siteAreaM2) {
        try { siteAreaM2 = window.__siteDraft.siteAreaM2(fullProposal.site); }
        catch (error) { console.warn('[showProposalInfo] Could not measure the proposal site:', error); }
    }
    const areaSummary = window.ProposalArea.areaSummary({
        hasSite: !!fullProposal.site, siteAreaM2,
        declaredCount: new Set(cadastreParcelIds).size,
        sourceAreas: sourceFeatures.map(feature => {
            try { return window.ProposalArea.sourceAreaM2(feature, window.__siteDraft?.siteAreaM2); }
            catch (error) {
                console.warn('[showProposalInfo] Could not measure a source parcel:', feature.properties?.parcelId, error);
                return null;
            }
        })
    });
    const areaText = area => area === null ? '—' : `${Math.round(area).toLocaleString()} m²`;

    // An object-list item's open button: ObjectList.openButton's arrow, as markup for these
    // HTML-built rows. `attributes` say what it opens; `title` may say how, else it is its name.
    const proposalDetailsOpenButtonHtml = (name, attributes = '', title = '') => {
        const label = safeAgentText(tProposal('lists.openNamed', 'Open {{title}}', { title: name }));
        return `<button type="button" class="btn btn-icon object-list__open" title="${title ? safeAgentText(title) : label}" aria-label="${label}" ${attributes}><i class="fas fa-arrow-right" aria-hidden="true"></i></button>`;
    };

    const renderAncestorParcelItem = (parentParcelOrId) => {
        const parentParcel = (typeof parentParcelOrId === 'string')
            ? buildAncestorRow(parentParcelOrId)
            : parentParcelOrId;
        if (!parentParcel) return '';
        const parcelId = parentParcel.parcelId;
        const feature = parentParcel.feature;
        const isReplaced = parentParcel.referenceState === 'replaced';
        const isUnloaded = parentParcel.referenceState === 'unloaded';

        // This avatar comes from a browser-local model assignment, not a rights register.
        const ownerId = PersistentStorage.getItem(`parcel_${parcelId}_owner`);
        let ownerAvatarHtml = '';

        if (ownerId && typeof agentStorage !== 'undefined') {
            const owner = agentStorage.getAgent(ownerId);
            if (owner && typeof getAvatarImagePath === 'function') {
                const label = getProposalI18nHelper()('panel.proposal.parcels.localModelOwner', 'Local model owner: {{name}}', { name: owner.name });
                ownerAvatarHtml = `<img src="${getAvatarImagePath(owner.avatarIndex)}" class="parcel-owner-avatar" title="${safeAgentText(label)}">`;
            }
        }

        const parcelNumberDisplay = window.ProposalDisplayText.parcelLabel(getParcelDisplayNumberFromProperties(feature?.properties, parcelId));
        const parcelLabelText = tProposal('panel.proposal.parcels.label', 'Parcel {{id}}', { id: parcelNumberDisplay || parcelId });
        // An owner's review of an applied parcel layout (dividers.md, M6): this parcel before, the
        // plots that came out of it after. Same session as the panel's own "Before / after".
        const parcelCompare = (typeof window !== 'undefined') ? window.ProposalBeforeAfter : null;
        const proposalKeyForCompare = (typeof getProposalKey === 'function' ? getProposalKey(fullProposal || proposal) : null) || (fullProposal || proposal).proposalId;
        // An applied parcel layout can replace its inputs in the map model: that is the case to compare.
        const parcelCompareHtml = ((fullProposal || proposal).parcelLayout && parcelCompare && proposalKeyForCompare
            && isProposalApplied(fullProposal || proposal) && parcelCompare.canCompare(fullProposal || proposal))
            ? `<button type="button" class="btn btn-quiet btn-compare-parcel" data-focus-parcel="${safeAgentText(String(parcelId))}" aria-pressed="${parcelCompare.isActive(proposalKeyForCompare) && parcelCompare.activeFocus() === String(parcelId) ? 'true' : 'false'}"
                    title="${tProposal('mapCompare.sliderLabel', 'Before and after comparison')}"
                    onclick="event.stopPropagation(); event.preventDefault(); BusyControl.track(this, () => toggleProposalBeforeAfter(${inlineJsArg(proposalKeyForCompare)}, { focusParcelId: ${inlineJsArg(String(parcelId))} }));"><i class="fas fa-left-right" aria-hidden="true"></i> ${tProposal('mapCompare.toggle', 'Before / after')}</button>`
            : '';
        const parcelTooltip = isReplaced
            ? tProposal('panel.proposal.parcels.tooltipReplaced', 'Click to focus on the source parcel location')
            : tProposal('panel.proposal.parcels.tooltip', 'Click to view parcel details');
        // Any applied formation may replace this source; the viewed proposal need not be its producer.
        const replacedLabel = tProposal('panel.proposal.parcels.replacedInModel', 'Replaced in map model');
        const unloadedLabel = tProposal('panel.proposal.parcels.sourceUnloaded', 'Source geometry not loaded');

        // Store source geometry for replaced parcels so we can focus on location.
        const sourceGeometry = isReplaced
            ? (parentParcel.geometry || (feature && feature.geometry) || null)
            : null;
        const geometryDataAttr = sourceGeometry
            ? `data-parcel-geometry='${JSON.stringify(sourceGeometry)}'`
            : '';
        const replacedDataAttr = isReplaced ? 'data-parcel-replaced="true"' : '';

        // The row and its status take their look from classes (css/proposal-details.css). It is an
        // object-list item (bindProposalDetailsObjectLists): its name outlines the parcel, and only
        // the arrow opens it (the parcel's details, or a replaced source's former location).
        const openHtml = proposalDetailsOpenButtonHtml(parcelLabelText,
            `${replacedDataAttr} ${geometryDataAttr} onclick="handleProposalParcelClick(${inlineJsArg(parcelId)}, event)"`, parcelTooltip);
        return `
            <div class="proposal-parcel-item proposal-parcel-row${isReplaced ? ' is-replaced' : ''}" data-parcel-id="${parcelId}" data-reference-state="${parentParcel.referenceState}" data-object-kind="source" data-object-id="${safeAgentText(String(parcelId))}" ${replacedDataAttr} ${geometryDataAttr}>
                <div class="parcel-info proposal-parcel-row__info">
                    <div class="proposal-parcel-row__main">
                        ${ownerAvatarHtml}
                        <div class="proposal-parcel-row__text">
                            <span class="parcel-number parcel-id-text"><button type="button" class="cb-link" data-object-preview aria-pressed="false">${safeAgentText(parcelLabelText)}</button></span>
                            ${parcelCompareHtml}
                            ${isReplaced
                ? `<span class="parcel-status parcel-status-replaced">${replacedLabel}</span>`
                : (isUnloaded ? `<span class="parcel-status parcel-status-unloaded">${unloadedLabel}</span>` : '')
            }
                        </div>
                        ${openHtml}
                    </div>
                </div>
            </div>
        `;
    };

    // First batch is already resolved objects; remainder is just IDs which buildAncestorRow
    // will resolve lazily as setupLazyList streams them in on scroll.
    const parentParcelItemsInitial = parentParcels.map(renderAncestorParcelItem).join('');
    const parentParcelItemsRemaining = cadastreParcelIds.slice(MAX_LIST_INITIAL);

    // Each formed parcel or design is an object-list item (bindProposalDetailsObjectLists): the
    // button outlines it, and a design's arrow opens that design. A parcel has nothing to open.
    const descendantRow = (kind, id, inner, openHtml = '') => `<div class="proposal-descendant-row" data-object-kind="${kind}" data-object-id="${safeAgentText(id)}">${inner}${openHtml}</div>`;
    const renderDescendantItem = (descendant) => {
        const descendantKey = (descendant !== undefined && descendant !== null) ? String(descendant) : '';
        const descendantData = proposalStorage.getProposal(descendantKey);
        if (descendantData) {
            const descendantId = String(descendantData.proposalId || descendantKey);
            return descendantRow('design', descendantId, `<button type="button" class="btn descendant-item" data-descendant-type="proposal" data-proposal-id="${safeAgentText(descendantId)}" data-object-preview aria-pressed="false">
                <strong>${safeAgentText(descendantData.title)}</strong> (${safeAgentText(descendantData.type || 'proposal')})
            </button>`, proposalDetailsOpenButtonHtml(descendantData.title || descendantId, `data-open-design-id="${safeAgentText(descendantId)}"`));
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

        // A plot this parcel layout made is named as the layout names it (plot number, area, who
        // holds it), not by its internal synthetic id ("2897/2#c2-…-1").
        const plotProps = liveFeature?.properties;
        const plotOwners = Array.isArray(plotProps?.owners) && plotProps.owners.length
            ? plotProps.owners.map(owner => owner?.displayName || owner?.ownerKey).filter(Boolean).join(', ')
            : (plotProps?.displayName || '');
        if ((fullProposal || proposal).parcelLayout && plotProps && Number.isFinite(plotProps.syntheticIndex)
            && String(plotProps.producedByProposalId || '') === String((fullProposal || proposal).proposalId || '')) {
            const plotArea = Number.isFinite(plotProps.calculatedArea) ? CbFormat.formatArea(plotProps.calculatedArea) : '';
            const plotLabel = tProposal('panel.proposal.parcels.newPlot', 'New plot {{n}}', { n: plotProps.syntheticIndex });
            const plotDetail = [plotArea, plotOwners].filter(Boolean).join(' · ');
            return descendantRow('parcel', descendantKey, `<button type="button" class="btn descendant-item" data-descendant-type="parcel" data-parcel-id="${safeAgentText(descendantKey)}" data-object-preview aria-pressed="false">
            <span class="parcel-id-text" title="${safeAgentText(descendantKey)}">${safeAgentText(plotLabel)}</span>${plotDetail ? ` · ${safeAgentText(plotDetail)}` : ''}
        </button>`);
        }
        const label = parcelNumber ? `Parcel ${parcelNumber}` : `Parcel ${descendantKey}`;
        const roadSuffix = isRoad ? (roadName ? ` • Road: ${roadName}` : ' • Road') : '';
        return descendantRow('parcel', descendantKey, `<button type="button" class="btn descendant-item" data-descendant-type="parcel" data-parcel-id="${safeAgentText(descendantKey)}" data-object-preview aria-pressed="false">
            <span class="parcel-id-text" title="${safeAgentText(descendantKey)}">${safeAgentText(label)}</span>${safeAgentText(roadSuffix)}
        </button>`);
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

    const displayText = value => window.ProposalDisplayText.text(value, fullProposal);
    const proposalDisplayTitle = displayText(getProposalDisplayTitle(fullProposal, proposal));

    // Panel header shows the proposal's own name so the collapsed card still says which proposal
    // it is. Read the name fields directly rather than getProposalDisplayTitle() — that helper
    // scores candidates by length and happily returns a parcel label instead of the name.
    const proposalPanelTitle = document.getElementById('proposal-details-title');
    if (proposalPanelTitle) {
        const nameSource = fullProposal || proposal || {};
        const proposalOwnName = [nameSource.title, nameSource.name, nameSource.proposalName]
            .find(candidate => typeof candidate === 'string' && candidate.trim());
        const headerTitle = proposalOwnName
            ? displayText(proposalOwnName.trim())
            : tProposal('panel.proposal.title', 'Design details');
        proposalPanelTitle.textContent = headerTitle;
        proposalPanelTitle.title = headerTitle; // tooltip while paused or when the marquee is off
    }
    const proposalType = window.ClickStackRelations.designType({ proposal: fullProposal || proposal }, window);
    const proposalTypePill = proposalType ? `<span class="cb-badge cb-badge--${proposalType.tone} proposal-type-badge" data-design-goal="${proposalType.goal}"><span aria-hidden="true">${safeAgentText(proposalType.icon)}</span><span>${safeAgentText(proposalType.label)}</span></span>` : '';
    const proposalDisplayDescription = displayText(getProposalDisplayDescription(fullProposal, proposal, proposalDisplayTitle));
    const escapedProposalDisplayTitle = typeof escapeHtml === 'function'
        ? escapeHtml(proposalDisplayTitle)
        : proposalDisplayTitle;

    const formatAuthorForDisplay = (authorRaw) => {
        const author = authorRaw || '';
        const isHexAddress = author.startsWith('0x') && author.length > 12;
        const isSolanaAddress = !author.startsWith('0x') && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(author);
        const truncated = (isHexAddress || isSolanaAddress)
            ? `${author.slice(0, 6)}...${author.slice(-4)}`
            : author;
        const safeText = typeof escapeHtml === 'function' ? escapeHtml(truncated) : truncated;
        const safeTitle = typeof escapeHtml === 'function' ? escapeHtml(author) : author;
        return `<span class="author-text proposal-author-text" title="${safeTitle}">${safeText}</span>`;
    };

    const {
        isRoadProposal,
        isBuildingProposal,
        isStructureProposal,
        supportsMapToggle
    } = computeProposalCategoryFlags(fullProposal, { fallbackProposal: proposal });

    const normalizedTypeForActions = resolveProposalActionTypeKey(fullProposal, proposal);
    // Road proposals should always be able to be applied
    const applyDisabledForType = isRoadProposal ? false : APPLY_DISABLED_TYPE_KEYS.has(normalizedTypeForActions);

    // Badges and the Apply/Unapply action read ONE derived state (proposals/display-state.js), the
    // one the proposal lists read. A design is a draft or published (it has a CID at this index); it
    // has no lifecycle, consent, funding or market of its own (those are its agreement's, M2).
    const publishedCid = window.DesignSync.publishedCid(fullProposal);
    const displayState = window.__proposalDisplayState.of(fullProposal, {
        applied: !!isProposalApplied(fullProposal),
        serial: publishedCid
    });
    const appliedState = displayState.applied;
    const mapStatusBadgeLabel = tProposal('panel.proposal.mapStatus.applied', 'Applied');

    // Use stable proposalId only (hash support removed)
    const proposalKey = fullProposal.proposalId
        || proposal.proposalId;
    const mapActionFailure = proposalKey
        ? window.__proposalMapActionFailures?.[String(proposalKey)]
        : '';
    const mapActionFailureHtml = mapActionFailure
        ? window.ProposalGroundRebase.failureNoticeHtml(String(proposalKey), mapActionFailure,
            !!window.__proposalGroundForkOffers?.[String(proposalKey)], safeAgentText)
        : '';
    const hasProposalManager = typeof ProposalManager !== 'undefined'
        && typeof ProposalManager.applyProposal === 'function'
        && typeof ProposalManager.unapplyProposal === 'function';
    const canShowMapActions = !!proposalKey && supportsMapToggle && hasProposalManager && displayState.mapAction !== null;

    let mapActionButtonHtml = '';
    if (canShowMapActions) {
        const isApplyAction = !appliedState;
        const actionView = ProposalMapAction.presentation(appliedState, tProposal);
        const buttonLabel = actionView.label;
        const iconClass = actionView.iconClass;
        const isDisabled = isApplyAction && applyDisabledForType;
        const buttonClass = appliedState
            ? actionView.className
            : (isDisabled ? 'btn disabled' : 'btn btn-success');
        const defaultActionClass = (isApplyAction && !isDisabled) ? ' proposal-action-default' : '';
        const defaultActionAttrs = (isApplyAction && !isDisabled)
            ? 'data-default-action="true" aria-keyshortcuts="Enter"'
            : '';
        const handler = appliedState
            ? `removeProposalFromMap(${inlineJsArg(proposalKey)})`
            : (isDisabled ? null : `applyProposalToMap(${inlineJsArg(proposalKey)})`);
        const disabledAttrs = isDisabled ? 'disabled aria-disabled="true"' : '';
        const buttonId = `proposal-action-btn-${proposalKey}`;
        mapActionButtonHtml = `
            <button id="${buttonId}" type="button" class="${buttonClass}${defaultActionClass}" ${handler ? `onclick="${handler}"` : ''} ${disabledAttrs} ${defaultActionAttrs}>
                <i class="fas ${iconClass}"></i> ${buttonLabel}
            </button>
        `;
    }

    // A design that cannot be published yet (ProposalPublishTerms.publishRefusal) shows a disabled Share.
    const publishRefusal = window.DesignSync.publishedCid(fullProposal || proposal)
        ? null : window.ProposalPublishTerms.publishRefusal(fullProposal || proposal);
    // Share publishes this exact design; adding it to a plan is a separate action.
    const shareRefusalNote = publishRefusal ? publishRefusal.message : '';
    const shareButtonHtml = publishRefusal
        ? `
        <button type="button" class="btn btn-share-proposal" disabled aria-disabled="true" aria-describedby="proposal-publish-later-note">
            <i class="fas fa-share-alt"></i> ${tProposal('panel.proposal.actions.share', 'Share')}
        </button>
    `
        : `
        <button type="button" class="btn ${appliedState ? 'btn-primary' : ''} btn-share-proposal" onclick="BusyControl.track(this, () => shareProposalFromDetails())"
            title="${safeAgentText(tProposal('planDialog.shareDesignHint', 'Share this design'))}">
            <i class="fas fa-share-alt"></i> ${tProposal('panel.proposal.actions.share', 'Share')}
        </button>
    `;

    const addToPlanButtonHtml = proposalKey
        ? `
        <button type="button" class="btn btn-add-to-plan" onclick="BusyControl.track(this, () => window.PlanDialog.addDesign(${inlineJsArg(proposalKey)}))">
            <i class="fas cb-icon-plan" aria-hidden="true"></i> ${tProposal('planDialog.addToPlan', 'Add to plan')}
        </button>
    ` : '';

    // Agreement creation belongs to a saved plan's actions, whose membership is fixed.
    // Duplicate places fresh movable geometry. Site-bound acts and rules have no free-copy action.
    // Edit geometry below still opens the source's design tool under the ordinary edit contract.
    // The design as a file (a one-design plan file or GeoJSON), PlanFileUI.design.
    const downloadButtonHtml = proposalKey
        ? `
        <button type="button" class="btn btn-download-design" onclick="window.PlanFileUI.design(window.proposalStorage.getProposal(${inlineJsArg(proposalKey)}))">
            <i class="fas fa-download" aria-hidden="true"></i> ${tProposal('common.download', 'Download')}
        </button>
    ` : '';

    const duplicateButtonHtml = proposalKey && window.ProposalDesignGoals.canDuplicate(fullProposal)
        ? `
        <button type="button" class="btn btn-duplicate-design"
            onclick="startDesignDuplication(${inlineJsArg(proposalKey)})"
            title="${tProposal('panel.proposal.actions.duplicateDesignHint', 'Move a copy with the pointer and click to place a new design.')}"
            aria-label="${tProposal('panel.proposal.actions.duplicateDesign', 'Duplicate')}">
            <i class="fas fa-copy" aria-hidden="true"></i> ${tProposal('panel.proposal.actions.duplicateDesign', 'Duplicate')}
        </button>
    `
        : '';
    // A road's cross-section is edited like its nodes are: directly, on the applied road the click
    // selected (proposals/road-actions-model.js decides when). Unlike Fork it does not clone the
    // proposal; it goes through updateLocalCorridorGeometry, which edits one's own local road in
    // place and saves an edit of a published road as a counterproposal, leaving the published
    // road as it is. That is the node handles' rule, not a new one.
    const roadActionFacts = (proposalKey && window.RoadActions)
        ? window.RoadActions.factsFor(fullProposal || proposal, { proposalKey: String(proposalKey), applied: appliedState === true })
        : null;
    const crossSectionHint = tProposal('panel.road.crossSectionHint', 'Edit this road\'s lanes and widths. An edit of a published road is saved as a counterproposal; the published version stays unchanged.');
    const crossSectionButtonHtml = (roadActionFacts && window.RoadActionsModel
        && window.RoadActionsModel.isActionAvailable('crossSection', roadActionFacts))
        ? `
        <button type="button" class="btn btn-quiet btn-cross-section"
            onclick="RoadActions.runAction('crossSection', RoadActions.factsFor(${inlineJsArg(proposalKey)}))"
            title="${safeAgentText(crossSectionHint)}"
            aria-label="${safeAgentText(crossSectionHint)}">
            <i class="fas fa-road"></i> ${tProposal('panel.road.crossSectionButton', 'Edit cross-section')}
        </button>
    `
        : '';

    const geometryEditable = proposalKey && !crossSectionButtonHtml
        && typeof canEditProposalGeometry === 'function'
        && typeof editProposalGeometry === 'function'
        && canEditProposalGeometry(fullProposal || proposal);
    const editGeometryButtonHtml = geometryEditable
        ? `
        <button type="button" class="btn btn-edit-geometry"
            onclick="editProposalGeometry(${inlineJsArg(proposalKey)})">
            <i class="fas fa-draw-polygon" aria-hidden="true"></i> ${tProposal('panel.proposal.actions.editGeometry', 'Edit geometry')}
        </button>
    `
        : '';

    // A block with an enclosed courtyard: its parcels' ground stays private (fenced) until the
    // parcel layout makes the courtyard a parcel of its own. This is the shortcut to that layout.
    const courtyardOf = window.ReparcellizationPlanUtils?.deriveCourtyardFromFootprint;
    const courtyardLayoutButtonHtml = (proposalKey && geometryEditable && courtyardOf
        && typeof window.startCourtyardParcelLayout === 'function'
        && courtyardOf((fullProposal || proposal)?.geometry?.ruleMassing))
        ? `
        <button type="button" class="btn btn-courtyard-layout"
            onclick="BusyControl.track(this, () => startCourtyardParcelLayout(${inlineJsArg(proposalKey)}))"
            title="${safeAgentText(tProposal('panel.proposal.actions.courtyardParcelHint', 'Parcels keep their own fenced ground. Lay out the courtyard as a parcel of its own to share it.'))}">
            <i class="fas fa-vector-square" aria-hidden="true"></i> ${tProposal('panel.proposal.actions.courtyardParcel', 'Courtyard as a parcel')}
        </button>
    `
        : '';

    // Before / after (dividers.md, M2): the ground without this proposal beside the map with it.
    // Only an applied record with a footprint has an "after" to show.
    const beforeAfter = (typeof window !== 'undefined') ? window.ProposalBeforeAfter : null;
    const compareButtonHtml = (appliedState && proposalKey && beforeAfter && beforeAfter.canCompare(fullProposal || proposal))
        ? `
        <button type="button" class="btn btn-compare-proposal"
            aria-pressed="${beforeAfter.isActive(proposalKey) ? 'true' : 'false'}"
            onclick="BusyControl.track(this, () => toggleProposalBeforeAfter(${inlineJsArg(proposalKey)}))">
            <i class="fas fa-left-right" aria-hidden="true"></i> ${tProposal('mapCompare.toggle', 'Before / after')}
        </button>
    `
        : '';

    // "Drive this track" — opens the external 3D tram sim in a new tab with the
    // cab riding on this design's drawn centerline. Shown for published track
    // designs (the sim reads them by CID) in every city; outside Zagreb the surroundings
    // are empty until the sim's world data goes multi-city, but the ride itself works.
    const driveProposal = fullProposal || proposal;
    const driveWalkConfig = (typeof CityConfigManager !== 'undefined' && typeof CityConfigManager.getDriveConfig === 'function')
        ? CityConfigManager.getDriveConfig()
        : null;
    const drivePlan = driveProposal?.roadProposal?.definition;
    const isDrivableTrack = corridorIsTrack(drivePlan);
    const driveButtonHtml = (driveWalkConfig && driveWalkConfig.url && isDrivableTrack && publishedCid && proposalKey)
        ? `
        <button type="button" class="btn btn-drive-proposal" onclick="driveTrackProposalIn3DSim(${inlineJsArg(proposalKey)})">
            <i class="fas fa-train-tram" aria-hidden="true"></i> ${tProposal('panel.proposal.actions.drive', 'Drive')}
        </button>
    `
        : '';
    // A Block or Row proposal is a rule on its parcels; leaving them is a conversion to one Freeform
    // building (proposals/freeform-conversion.js, proposal-editor-shell.js).
    const convertsToFreeform = proposalKey
        && typeof convertProposalToFreeform === 'function'
        && window.__freeformConversion?.convertsToFreeform(fullProposal || proposal) === true;
    const convertToFreeformButtonHtml = convertsToFreeform
        ? `
        <button type="button" class="btn btn-convert-freeform"
            onclick="convertProposalToFreeform(${inlineJsArg(proposalKey)})"
            title="${safeAgentText(tProposal('panel.proposal.actions.convertToFreeformHint', 'Keep the rule\'s massing at the greatest height it allows, as one building you edit directly. The rule\'s parameters no longer apply afterwards.'))}">
            <i class="fas fa-shapes" aria-hidden="true"></i> ${tProposal('proposalDrafts.freeform.title', 'Convert to freeform building')}
        </button>
    `
        : '';
    const additionalActionsHtml = crossSectionButtonHtml + editGeometryButtonHtml + courtyardLayoutButtonHtml + convertToFreeformButtonHtml + compareButtonHtml + driveButtonHtml;
    // Map actions remain available in the compact card and the reader. Details is an explicit
    // transition into the reader; Fork and the contextual design editors keep distinct labels.
    const primaryActionsHtml = `
        <div class="proposal-actions proposal-actions-group proposal-primary-actions">
            ${mapActionButtonHtml}
            ${shareButtonHtml}
            ${addToPlanButtonHtml}
            ${downloadButtonHtml}
            ${duplicateButtonHtml}
            <button type="button" class="btn btn-proposal-details" onclick="toggleProposalDetailsPanelMinimized(false)">
                <i class="fas fa-circle-info" aria-hidden="true"></i> ${tProposal('panel.proposal.actions.details', 'Details')}
            </button>
            ${additionalActionsHtml}
            ${shareRefusalNote ? `<p class="proposal-publish-later" id="proposal-publish-later-note">${safeAgentText(shareRefusalNote)}</p>` : ''}
        </div>
        ${mapActionFailureHtml}
    `;
    const escapedProposalDescription = proposalDisplayDescription && typeof escapeHtml === 'function'
        ? escapeHtml(proposalDisplayDescription)
        : proposalDisplayDescription;

    // A source is navigable when this browser holds it (by its local key, or a copy of the design it
    // names by CID); otherwise the authored relationship keeps its title.
    const origin = window.ProposalOrigin.normalize((fullProposal || proposal).proposalOrigin);
    let copiedFromHtml = '';
    if (origin) {
        let sourceProposal = null;
        try {
            sourceProposal = window.ProposalOrigin.resolveLocal(origin, proposalStorage.getAllProposals());
        } catch (_) { }
        const sourceLabel = sourceProposal?.title || sourceProposal?.name || origin.title
            || tProposal('panel.proposal.lineage.untitled', 'Untitled proposal');
        const safeLabel = typeof escapeHtml === 'function' ? escapeHtml(String(sourceLabel)) : String(sourceLabel);
        const basedOnLabel = tProposal('panel.proposal.basedOn', 'Based on');
        const inner = sourceProposal
            ? `<button type="button" class="cb-link proposal-based-on-link" data-lineage-local-id="${safeAgentText(sourceProposal.proposalId)}">${safeLabel}</button>`
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
    // A design forked from a published one links that design by its CID, and that link is all of
    // its published lineage (plan-design-agreement.md, simplification 8).
    const forkedFromCid = (() => {
        const cid = (fullProposal || proposal).origin?.cid;
        return typeof cid === 'string' && window.Cid?.isCid?.(cid) ? cid : null;
    })();
    let forkedFromHtml = '';
    if (forkedFromCid) {
        const shortCid = `${forkedFromCid.slice(0, 12)}…${forkedFromCid.slice(-6)}`;
        const cityParam = typeof buildCityQueryParam === 'function' ? buildCityQueryParam((fullProposal || proposal).city) : '';
        const href = `${window.DesignSync.designsPath([forkedFromCid])}${cityParam}`;
        forkedFromHtml = `<div class="proposal-based-on-row" data-proposal-forked-from="${safeAgentText(forkedFromCid)}">`
            + `<a class="cb-link" href="${safeAgentText(href)}" title="${safeAgentText(forkedFromCid)}">`
            + `${safeAgentText(tProposal('panel.proposal.forkedFrom', 'Forked from {{cid}}', { cid: shortCid }))}</a></div>`;
    }

    const proposalDisplayId = proposal.proposalId ? String(proposal.proposalId) : null;

    const escapedProposalDisplayId = proposalDisplayId && typeof escapeHtml === 'function'
        ? escapeHtml(proposalDisplayId)
        : proposalDisplayId;
    const parcelSetRelationsHtml = (() => {
        const relationApi = (typeof window !== 'undefined') ? window.ParcelSetRelations : null;
        if (!relationApi || typeof relationApi.findParcelSetRelations !== 'function') return '';

        const activeProposal = fullProposal || proposal;
        const declaredIds = relationApi.normalizeParcelIds(activeProposal);
        if (!declaredIds.length) return '';

        let allProposals = [];
        try {
            allProposals = (typeof proposalStorage !== 'undefined'
                && typeof proposalStorage.getAllProposals === 'function')
                ? proposalStorage.getAllProposals()
                : [];
        } catch (error) {
            console.warn('[showProposalInfo] Could not enumerate declared-reference matches:', error);
        }
        const relations = relationApi.findParcelSetRelations(activeProposal, allProposals);
        const shownRelations = relations.slice(0, 12);
        const exactCount = relations.filter(relation => relation.kind === 'same').length;
        const overlapCount = relations.length - exactCount;
        const setHash = typeof activeProposal?.parcelSet?.setHash === 'string'
            ? activeProposal.parcelSet.setHash
            : '';
        const shortHash = setHash ? `${setHash.slice(0, 13)}…${setHash.slice(-6)}` : '';
        const summary = relations.length
            ? tProposal(
                'panel.proposal.parcelSet.summary',
                '{{count}} declared cadastral references. Of {{total}} loaded matches, {{exact}} use the same references and {{overlap}} share some. Showing {{shown}}.',
                { count: declaredIds.length, total: relations.length, exact: exactCount, overlap: overlapCount, shown: shownRelations.length }
            )
            : tProposal(
                'panel.proposal.parcelSet.noRelated',
                '{{count}} declared cadastral references. No other loaded proposal shares these references.',
                { count: declaredIds.length }
            );
        const relationLabels = {
            same: tProposal('panel.proposal.parcelSet.relationSame', 'Same references'),
            'contains-target': tProposal('panel.proposal.parcelSet.relationContains', 'Includes all these references'),
            'inside-target': tProposal('panel.proposal.parcelSet.relationInside', 'Subset of these references'),
            overlap: tProposal('panel.proposal.parcelSet.relationOverlap', 'Some shared references')
        };
        const rows = shownRelations.map(relation => {
            const candidate = relation.proposal || {};
            const candidateId = safeAgentText(relation.proposalId);
            const name = window.ProposalDisplayText.text(candidate.title || candidate.name || relation.proposalId, candidate);
            const title = safeAgentText(name);
            const author = candidate.author ? safeAgentText(candidate.author) : '';
            const shared = safeAgentText(tProposal(
                'panel.proposal.parcelSet.sharedCount',
                '{{shared}} of {{count}} references shared',
                { shared: relation.sharedCount, count: relation.targetCount }
            ));
            const lifecycle = typeof getProposalLifecycleLabel === 'function'
                ? safeAgentText(getProposalLifecycleLabel(getProposalLifecycleKey(candidate)))
                : '';
            // An object-list item (bindProposalDetailsObjectLists): the row outlines that design,
            // its arrow opens it.
            return `
                <div class="proposal-parcel-set-relation-row" data-object-kind="design" data-object-id="${candidateId}">
                    <button type="button" class="cb-option proposal-parcel-set-relation" data-related-proposal-id="${candidateId}" data-object-preview aria-pressed="false">
                        <span class="cb-option__text proposal-parcel-set-relation-main">
                            <span class="cb-option__title">${title}</span>
                            <span class="cb-option__desc">${safeAgentText(relationLabels[relation.kind])} · ${shared}${author ? ` · ${author}` : ''}</span>
                        </span>
                        ${lifecycle ? `<span class="cb-badge proposal-parcel-set-relation-state">${lifecycle}</span>` : ''}
                    </button>
                    ${proposalDetailsOpenButtonHtml(name, `data-open-design-id="${candidateId}"`)}
                </div>`;
        }).join('');

        return `
            <section class="proposal-parcel-set-card" aria-label="${safeAgentText(tProposal('panel.proposal.parcelSet.title', 'Proposals sharing references'))}">
                <div class="proposal-parcel-set-head">
                    <div>
                        <div class="proposal-funding-eyebrow">${safeAgentText(tProposal('panel.proposal.parcelSet.eyebrow', 'Declared cadastral references'))}</div>
                        <h3>${safeAgentText(tProposal('panel.proposal.parcelSet.title', 'Proposals sharing references'))}</h3>
                    </div>
                    <span class="cb-badge cb-badge--applied proposal-parcel-set-count">${declaredIds.length}</span>
                </div>
                <p>${safeAgentText(summary)}</p>
                ${shortHash ? `<div class="proposal-parcel-set-hash" title="${safeAgentText(setHash)}"><span>${safeAgentText(tProposal('panel.proposal.parcelSet.hash', 'Recorded set hash'))}</span><code>${safeAgentText(shortHash)}</code></div>` : ''}
                ${rows ? `<div class="proposal-parcel-set-relations">${rows}</div>` : ''}
            </section>`;
    })();

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
        ? `<span class="cb-badge cb-badge--published proposal-agent-badge"><i class="fas fa-robot" aria-hidden="true"></i> ${safeAgentText(tProposal('panel.proposal.agent.badge', 'Agent proposal'))}</span>`
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
                <div><dt>${safeAgentText(tProposal('panel.proposal.agent.settlement', 'Settlement'))}</dt><dd><a class="cb-link cb-link--external" href="${safeAgentText(agentProvenance.explorerUrl)}" target="_blank" rel="noopener noreferrer" title="${safeAgentText(agentProvenance.transaction)}">${safeAgentText(agentProvenance.transactionShort)}</a></dd></div>
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

    const sectionStart = (id, title, hint) => `<details class="proposal-detail-section" data-proposal-section="${id}">
        <summary><span class="proposal-detail-section-label"><span>${safeAgentText(title)}</span><small>${safeAgentText(hint)}</small></span><i class="fas fa-chevron-down" aria-hidden="true"></i></summary>
        <div class="proposal-detail-section-content">`;
    const sectionEnd = '</div></details>';
    // Two tabs (Overview and Details): the overview is the name, its rung, type, author and size; the
    // records behind it are under Details. A parcel layout instead has Overview, Input parcels (the
    // cadastral parcels it takes) and Output parcels (the plots it forms), which say what Details
    // would. The actions stay in the footer under every tab.
    // The parcel lists: the cadastral parcels a design takes and the parcels it forms. A parcel layout
    // shows each on a tab of its own, counted in the tab, so without the heading.
    const outputCount = descendantKeys.length;
    const listBlock = (label, count, listClass, listId, items, heading) => count > 0 ? `
            <div class="metric-group">
                ${heading ? `<div class="metric-label-count-container">
                    <span class="metric-label">${label}</span> <span class="metric-value">${count}</span>
                </div>` : ''}
                <div class="${listClass} proposal-parcel-list-scroll" id="${listId}">
                    ${items}
                </div>
            </div>` : `
            <div class="metric-group">
                <span class="metric-label">${label}</span> <span class="metric-value">0</span>
            </div>`;
    const inputListHtml = heading => listBlock(tProposal('panel.proposal.sections.cadastralParcels', 'Cadastral parcels:'), cadastreParcelIds.length,
        'proposal-parcels-list', 'proposal-parent-parcels-list', parentParcelItemsInitial, heading);
    const outputListHtml = heading => listBlock(tProposal('panel.proposal.sections.generatedParcels', 'Generated parcels:'), outputCount,
        'proposal-descendants-list', 'proposal-descendants-list', descendantItemsInitial, heading);
    const landSectionHtml = `
            ${sectionStart('land', tProposal('panel.proposal.detailsSections.land', 'Land & ownership'), tProposal('panel.proposal.detailsSections.landHintDesign', 'Declared references: {{count}} · designs on the same parcels', { count: cadastreParcelIds.length }))}
            ${parcelSetRelationsHtml}
            ${areaSummary.declaredCount ? `<div class="metric-group" data-proposal-area-basis="source-parcels" data-area-complete="${areaSummary.sourceComplete}">
                <span class="metric-label">${areaSummary.sourceComplete
                    ? tProposal('panel.proposal.metrics.sourceArea', 'Source parcel area sum:')
                    : tProposal('panel.proposal.metrics.availableSourceArea', 'Available source parcel area:')}</span>
                <span class="metric-value">${areaText(areaSummary.sourceAreaM2)}</span>
            </div><p class="proposal-area-coverage"><small>${tProposal('panel.proposal.metrics.areaCoverage', 'Areas available for {{known}} of {{total}} declared references.', {
                known: areaSummary.sourceCount, total: areaSummary.declaredCount
            })}</small></p>` : ''}
            ${inputListHtml(true)}
            ${outputListHtml(true)}
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

            if (stats.ownerEntryCount !== null && stats.ownerEntryCount !== undefined) {
                statsItems.push(`
                    <div class="metric-group">
                        <span class="metric-label">${tProposal('panel.proposal.stats.ownerEntryCount', 'Listed owner entries:')}</span>
                        <span class="metric-value">${stats.ownerEntryCount}</span>
                    </div>
                `);
            }
            if (stats.ownershipCounts) {
                if (stats.ownershipCounts.individual !== null && stats.ownershipCounts.individual !== undefined) {
                    statsItems.push(`
                        <div class="metric-group">
                            <span class="metric-label">${tProposal('panel.proposal.stats.ownedByIndividuals', 'Parcels classed as individually owned:')}</span>
                            <span class="metric-value">${stats.ownershipCounts.individual}</span>
                        </div>
                    `);
                }
                if (stats.ownershipCounts.company !== null && stats.ownershipCounts.company !== undefined) {
                    statsItems.push(`
                        <div class="metric-group">
                            <span class="metric-label">${tProposal('panel.proposal.stats.ownedByCompanies', 'Parcels classed as company owned:')}</span>
                            <span class="metric-value">${stats.ownershipCounts.company}</span>
                        </div>
                    `);
                }
                if (stats.ownershipCounts.government !== null && stats.ownershipCounts.government !== undefined) {
                    statsItems.push(`
                        <div class="metric-group">
                            <span class="metric-label">${tProposal('panel.proposal.stats.ownedByGovernment', 'Parcels classed as publicly owned:')}</span>
                            <span class="metric-value">${stats.ownershipCounts.government}</span>
                        </div>
                    `);
                }
                if (stats.ownershipCounts.institution !== null && stats.ownershipCounts.institution !== undefined) {
                    statsItems.push(`
                        <div class="metric-group">
                            <span class="metric-label">${tProposal('panel.proposal.stats.ownedByInstitution', 'Parcels classed as institution owned:')}</span>
                            <span class="metric-value">${stats.ownershipCounts.institution}</span>
                        </div>
                    `);
                }
                if (stats.ownershipCounts.mixed !== null && stats.ownershipCounts.mixed !== undefined) {
                    statsItems.push(`
                        <div class="metric-group">
                            <span class="metric-label">${tProposal('panel.proposal.stats.ownershipMixed', 'Parcels classed as mixed ownership:')}</span>
                            <span class="metric-value">${stats.ownershipCounts.mixed}</span>
                        </div>
                    `);
                }
            }
            if (Number.isFinite(stats.totalMarketPrice) && stats.currency) {
                statsItems.push(`
                    <div class="metric-group">
                        <span class="metric-label">${tProposal('panel.proposal.stats.totalMarketPrice', 'Modeled total parcel value:')}</span>
                        <span class="metric-value">${CbFormat.formatMoney(stats.totalMarketPrice, stats.currency, { maxFractionDigits: 0 })}</span>
                    </div>
                `);
            }
            if (stats.totalAcquiringDifficulty !== null && stats.totalAcquiringDifficulty !== undefined) {
                statsItems.push(`
                    <div class="metric-group">
                        <span class="metric-label">${tProposal('panel.proposal.stats.totalAcquiringDifficulty', 'Modeled acquisition difficulty:')}</span>
                        <span class="metric-value">${Math.round(stats.totalAcquiringDifficulty).toLocaleString('hr-HR')}</span>
                    </div>
                `);
            }

            if (statsItems.length === 0) {
                return '';
            }

            return `
            <hr class="proposal-details-divider">
            <div class="metric-group">
                <div class="metric-label proposal-ownership-stats-heading">${tProposal('panel.proposal.sections.ownershipStats', 'Modeled ownership and acquisition')}</div>
            </div>
            <p><small data-ownership-estimates>${tProposal('panel.proposal.stats.summaryScope', 'Estimates from proposal metadata; owner entries may repeat across parcels and include assumed owners.')}</small></p>
            ${statsItems.join('')}
            `;
        })()}
            ${sectionEnd}`;
    const verificationSectionHtml = `
            ${agentProvenanceHtml ? sectionStart('verification', tProposal('panel.proposal.detailsSections.verification', 'Verification & history'), tProposal('panel.proposal.detailsSections.verificationHint', 'Lens, evidence and activity')) : ''}
            ${agentProvenanceHtml}
            ${agentProvenanceHtml ? sectionEnd : ''}`;
    const recordSectionHtml = `
            ${sectionStart('record', tProposal('panel.proposal.detailsSections.record', 'Proposal record'), tProposal('panel.proposal.detailsSections.recordHint', 'Created date, local ID and links'))}
            <div class="metric-group">
                <span class="metric-label">${tProposal('panel.proposal.metrics.created', 'Created:')}</span> <span class="metric-value">${createdAtLabel}</span>
            </div>
            ${publishedCid ? `<div class="metric-group" data-proposal-published-cid="${safeAgentText(publishedCid)}">
                <span class="metric-label">${tProposal('proposals.share.publishedAs', 'Published as:')}</span>
                <code class="metric-value proposal-published-cid" title="${safeAgentText(publishedCid)}">${safeAgentText(`${publishedCid.slice(0, 12)}…${publishedCid.slice(-6)}`)}</code>
            </div>` : ''}
            ${escapedProposalDisplayId ? `<div class="proposal-id-row">
                    <button type="button" class="btn btn-quiet proposal-id-copy" title="${escapedProposalDisplayId}" onclick="copyProposalIdToClipboard(${inlineJsArg(String(fullProposal.proposalId || proposal.proposalId || ''))})"><i class="fas fa-copy" aria-hidden="true"></i> ${tProposal('panel.proposal.copyId', 'Copy local ID')}</button>
                </div>` : ''}
            ${sectionEnd}`;
    const isParcelLayout = (fullProposal || proposal).goal === 'parcel-layout';
    const detailsTabs = isParcelLayout ? ['overview', 'inputs', 'outputs'] : ['overview', 'details'];
    if (document.getElementById('proposal-details-content')?.dataset.proposalId !== String(proposalKey)
        || !detailsTabs.includes(proposalDetailsTab)) proposalDetailsTab = 'overview';
    const tabButton = (id, label) => `<button type="button" class="cb-tab proposal-details-tab" role="tab" data-proposal-tab="${id}"
        aria-selected="${proposalDetailsTab === id}">${safeAgentText(label)}</button>`;
    const content = `
        <div class="proposal-info">
            <div class="cb-tabs cb-tabs--fill proposal-details-tabs" role="tablist">
                ${tabButton('overview', tProposal('panel.proposal.tabs.overview', 'Overview'))}
                ${isParcelLayout ? `${tabButton('inputs', `${tProposal('agreement.workflow.inputs', 'Input parcels')} (${cadastreParcelIds.length})`)}
                ${tabButton('outputs', `${tProposal('agreement.workflow.outputs', 'Output parcels')} (${outputCount})`)}`
                : tabButton('details', tProposal('proposalDrafts.tabs.details', 'Details'))}
            </div>
            <div class="proposal-details-tabpanel" role="tabpanel" data-proposal-tabpanel="overview"${proposalDetailsTab === 'overview' ? '' : ' hidden'}>
            <div class="proposal-badges-row">
                ${(() => {
            // One badge from the ladder (docs/design-language.md), the same as the list rows: Draft
            // or Published; "Applied" when it is on this map (proposals/display-state.js).
            const ladder = displayState.rung;
            const ladderLabel = window.__proposalDisplayState.rungLabel(ladder, tProposal);
            const ladderTitle = escapeHtml(window.__proposalDisplayState.rungHint(ladder, tProposal));
            const ladderIcon = ladder === 'published' ? 'fa-globe' : 'fa-file-pen';
            const ladderBadge = `<span class="cb-badge cb-badge--${ladder} proposal-ladder-badge" title="${ladderTitle}"><i class="fas ${ladderIcon}" aria-hidden="true"></i> ${ladderLabel}</span>`;
            const applied = appliedState
                ? `<span class="cb-badge cb-badge--applied"><i class="fas fa-check" aria-hidden="true"></i> ${mapStatusBadgeLabel}</span>`
                : '';
            // A parcel layout's title already names its type.
            return (isParcelLayout ? '' : proposalTypePill) + applied + ladderBadge;
        })()}
                ${agentBadgeHtml}
            </div>
            <div class="proposal-description-row">
                ${escapedProposalDescription ? `<p class="proposal-description-text">${escapedProposalDescription}</p>` : ''}
                ${copiedFromHtml}
                ${forkedFromHtml}
            </div>
            <div class="proposal-author-row">
                <div class="metric-label">${tProposal('panel.proposal.metrics.author', 'Author:')}</div>
                <div class="metric-value author-with-avatar">
                    ${(() => {
            // Find the agent with matching name
            if (typeof agentStorage !== 'undefined') {
                const agents = agentStorage.getAllAgents();
                const agent = agents.find(a => a.name === proposal.author);
                if (agent && typeof getAvatarImagePath === 'function') {
                    return `
                                        <img src="${getAvatarImagePath(agent.avatarIndex)}" class="author-avatar proposal-author-avatar">
                                        <button type="button" data-agent-id="${agent.id}" class="cb-link agent-link-clickable">${formatAuthorForDisplay(proposal.author)}</button>
                                    `;
                }
            }
            return formatAuthorForDisplay(proposal.author);
        })()}
                </div>
            </div>
            <div class="proposal-overview-facts">
            ${isParcelLayout ? '' : `<div class="metric-group">
                <span class="metric-label">${tProposal('panel.proposal.metrics.parcels', 'Source parcels:')}</span> <span class="metric-value">${parcelIds.length}</span>
            </div>`}
            ${areaSummary.hasSite ? `<div class="metric-group" data-proposal-area-basis="site">
                <span class="metric-label">${tProposal('panel.proposal.metrics.siteArea', 'Site area:')}</span>
                <span class="metric-value">${areaText(areaSummary.siteAreaM2)}</span>
            </div>` : ''}
            ${!areaSummary.hasSite && areaSummary.declaredCount ? `<div class="metric-group" data-proposal-area-basis="source-parcels-overview">
                <span class="metric-label">${tProposal('panel.proposal.metrics.area', 'Area:')}</span>
                <span class="metric-value">${areaText(areaSummary.sourceAreaM2)}</span>
            </div>` : ''}
            ${!areaSummary.hasSite && !areaSummary.declaredCount ? `<div class="metric-group" data-proposal-area-basis="unknown">
                <span class="metric-label">${tProposal('panel.proposal.metrics.area', 'Area:')}</span><span class="metric-value">—</span>
            </div>` : ''}
            </div>
            ${isParcelLayout ? `${verificationSectionHtml}
            </div>
            <div class="proposal-details-tabpanel" role="tabpanel" data-proposal-tabpanel="inputs"${proposalDetailsTab === 'inputs' ? '' : ' hidden'}>
            ${inputListHtml(false)}
            </div>
            <div class="proposal-details-tabpanel" role="tabpanel" data-proposal-tabpanel="outputs"${proposalDetailsTab === 'outputs' ? '' : ' hidden'}>
            ${outputListHtml(false)}
            </div>` : `
            </div>
            <div class="proposal-details-tabpanel" role="tabpanel" data-proposal-tabpanel="details"${proposalDetailsTab === 'details' ? '' : ' hidden'}>
            ${landSectionHtml}
            ${verificationSectionHtml}
            ${recordSectionHtml}
            </div>`}
        </div>
    `;

    const perfEndHtml = performance.now();

    // Preserve scroll before the DOM rewrite
    const panel = document.getElementById('proposal-details-panel');
    const panelBody = panel ? panel.querySelector('.panel-body') : null;
    let preservedScrollTop = panelBody ? panelBody.scrollTop : 0;

    if (preserveScrollPosition && typeof preserveScrollPosition === 'object') {
        if (typeof preserveScrollPosition.scrollTop === 'number') {
            preservedScrollTop = preserveScrollPosition.scrollTop;
        }
    } else if (typeof preserveScrollPosition === 'number') {
        preservedScrollTop = preserveScrollPosition;
    }

    // Show loading spinner briefly while rendering (for large proposals)
    // WHY HTML: The HTML string contains the entire proposal details UI:
    //   - Design metadata (title, description, author, dates)
    //   - Status badges (draft or published; applied)
    //   - List of all ancestor parcels with their details (parcel numbers, owners)
    //   - Ancestors/descendants proposals
    //   - Ownership & acquisition stats
    // This HTML is inserted into #proposal-details-content to display the proposal info panel
    const detailsContent = document.getElementById('proposal-details-content');
    const sameProposal = detailsContent?.dataset.proposalId === String(proposalKey);
    const openSections = new Set(sameProposal
        ? Array.from(detailsContent.querySelectorAll('details[data-proposal-section][open]'), section => section.dataset.proposalSection)
        : []);
    if (detailsContent) {
        detailsContent.dataset.proposalId = String(proposalKey);
        detailsContent.dataset.outputCount = String(outputCount);
        // Its object lists keep an item outlined across a re-render of the same design only.
        const objectList = bindProposalDetailsObjectLists(detailsContent);
        if (!sameProposal) releaseProposalDetailsObjectList(objectList);
    }
    subscribeProposalDetailsToFabric();
    if (!sameProposal && preserveScrollPosition === null) preservedScrollTop = 0;
    const runPostRender = () => {
        detailsContent?.querySelectorAll('details[data-proposal-section]').forEach(section => {
            section.open = openSections.has(section.dataset.proposalSection);
        });
        detailsContent?.querySelectorAll('[data-proposal-tab]').forEach(tab => {
            tab.addEventListener('click', () => {
                proposalDetailsTab = tab.dataset.proposalTab;
                detailsContent.querySelectorAll('[data-proposal-tab]').forEach(other => other.setAttribute('aria-selected', String(other === tab)));
                detailsContent.querySelectorAll('[data-proposal-tabpanel]').forEach(panel => { panel.hidden = panel.dataset.proposalTabpanel !== proposalDetailsTab; });
            });
        });
        // Claims breadcrumb: the BASE parcels this proposal stands on, always one tap away.
        try {
            if (window.__claimsUi && typeof window.__claimsUi.injectProposalBreadcrumb === 'function') {
                window.__claimsUi.injectProposalBreadcrumb(detailsContent.querySelector('[data-proposal-section="land"] .proposal-detail-section-content'), fullProposal || proposal);
            }
        } catch (_) { }
        // "Based on" opens the source this browser holds, in this panel.
        detailsContent?.querySelectorAll('.proposal-based-on-link[data-lineage-local-id]').forEach(button => {
            button.addEventListener('click', event => {
                event.preventDefault();
                const sourceId = button.getAttribute('data-lineage-local-id');
                const source = proposalStorage.getProposal(sourceId);
                if (source) {
                    openProposalFromList(String(source.proposalId), { proposal: source, closeSheets: true, centerOnProposal: true });
                    return;
                }
                console.warn(`[${new Date().toISOString()}] [showProposalInfo] Based on source ${sourceId} is no longer in this browser`);
                showProposalAlertMessage('proposal_with_id_not_found', tProposal('panel.proposal.lineage.openFailed', 'That proposal could not be opened.'));
            });
        });
        // Lazy append remaining ancestor parcels
        setupLazyList('proposal-parent-parcels-list', parentParcelItemsRemaining, renderAncestorParcelItem);
        // Lazy append remaining descendant parcels
        setupLazyList('proposal-descendants-list', descendantItemsRemaining, renderDescendantItem);
    };

    if (detailsContent && parcelIds.length > 20) {
        // Only show spinner for proposals with many parcels
        const loadingText = tProposal('panel.proposal.rendering', 'Rendering proposal details...');
        detailsContent.innerHTML = `
            <div class="loader-spinner proposal-details-loader" role="status" aria-live="polite">
                <div class="spinner-circle" aria-hidden="true"></div>
                <span class="loader-text proposal-details-loader__text">${loadingText}</span>
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

    // Restore scroll position or the parcel row after the DOM rewrite
    const combinedPreserveState = {
        scrollTop: preservedScrollTop,
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

    // A hover outline left by the previous render goes; the lists' own behaviour is bound once to
    // the content (bindProposalDetailsObjectLists), so rows rendered later need no wiring.
    clearProposalInfoHoverOverlay();

    const detailsPanel = document.getElementById('proposal-details-panel');
    if (detailsPanel) {
        const presentation = window.ProposalPanelPresentation.resolve({
            requested: options.presentation,
            sameProposal,
            visible: detailsPanel.classList.contains('visible'),
            minimized: detailsPanel.classList.contains('is-minimized')
        });
        setProposalDetailsPanelMinimized(detailsPanel, presentation === 'compact', getProposalDetailsPanelLabels());
        detailsPanel.classList.add('visible');
    } else {
        console.warn('[showProposalInfo] Proposal details panel element not found');
    }
    document.body.classList.add('proposal-details-open');
    // Close on Escape when this panel is the active proposal surface
    installProposalDetailsEscapeHandler();

    // Setup click listeners for any clickable links in the proposal info
    if (typeof setupGameLogClickListeners === 'function') {
        setupGameLogClickListeners();
    }
}

// The design panel's lists of map objects (docs/design-language.md, "Object lists"): its source
// parcels, the parcels and designs it formed, and the designs sharing its references. Hovering or
// focusing an item outlines its object; a click keeps it outlined, moving the map only when it is
// out of view, until it is clicked again; only the item's arrow opens the object. Bound once to the
// panel's content, so rows rendered later (a re-render, setupLazyList) behave the same.
let proposalDetailsObjectList = null; // { container, bound }
// Whether a kept item's outline replaced the selection's own (the inspection layer).
let proposalDetailsInspecting = false;

// The shapes an item names, as the click stack outlines them (ClickStackHits.featuresFor): a
// design's own geometry, a parcel wherever it lies (in view or not, so a kept one can be brought into
// view), or the outline a source parcel had before a formation replaced it. A replaced source with no
// known outline shows nothing: resolving it live would light the pieces now covering it, which are outputs.
function proposalDetailsObjectFeatures(kind, id, item) {
    if (kind === 'source' && item.getAttribute('data-parcel-replaced') === 'true') {
        const source = removedParcelSourceFeature(id, item);
        return source ? [source] : [];
    }
    const stackKind = { design: 'designs', source: 'parcels', parcel: 'formed' }[kind];
    return window.ClickStackHits.featuresFor(stackKind, { id, live: !!window.LiveParcelFabric.get(id) });
}

// Brings features into the part of the map the panels leave visible (revealMove): at the same zoom,
// or zoomed out just enough when they do not fit. Features already in view keep the camera.
function revealProposalDetailsFeatures(features) {
    if (!features.length || typeof map === 'undefined' || !map || isCameraMovementSuppressed()) return;
    const bounds = L.geoJSON({ type: 'FeatureCollection', features }).getBounds();
    if (!bounds.isValid()) return;
    const size = map.getSize();
    const northWest = map.latLngToContainerPoint(bounds.getNorthWest());
    const southEast = map.latLngToContainerPoint(bounds.getSouthEast());
    const move = revealMove({ left: northWest.x, top: northWest.y, right: southEast.x, bottom: southEast.y },
        getProposalPanelFreeArea(size.x, size.y));
    const animate = !window.__reducedMotion;
    if (move?.pan) map.panBy(L.point(-move.pan[0], -move.pan[1]), { animate });
    else if (move?.fit) map.fitBounds(bounds, { ...getProposalPanelFitPadding(40), maxZoom: map.getZoom(), animate });
}

function bindProposalDetailsObjectLists(container) {
    if (proposalDetailsObjectList?.container === container) return proposalDetailsObjectList.bound;
    const bound = window.ObjectList.bind(container, {
        item: '[data-object-kind]',
        keyOf: item => `${item.dataset.objectKind}\n${item.dataset.objectId}`,
        pressed: item => item.querySelector('[data-object-preview]'),
        show: (key, { pinned, item }) => {
            clearProposalHoverLayers();
            // Leaving another item: the kept one is still outlined on the inspection layer.
            if (!pinned && key === bound.pinnedKey()) return;
            const [kind, id] = key.split('\n');
            const features = proposalDetailsObjectFeatures(kind, id, item);
            if (!pinned) {
                highlightFeaturesForHover(features, { color: window.MapHighlight.color, weight: 6, dashArray: '10 8', showLabels: true });
                return;
            }
            highlightFeaturesForInspection(features, { weight: 5, className: 'click-stack-map-focus' });
            proposalDetailsInspecting = true;
            revealProposalDetailsFeatures(features);
        },
        restore: () => {
            clearProposalHoverLayers();
            if (!proposalDetailsInspecting) return;
            proposalDetailsInspecting = false;
            // The click stack hosting this panel outlines its selection again.
            if (window.ClickStack?.holdsHighlight()) window.ClickStack.restoreFocus();
            else highlightFeaturesForInspection([]);
        }
    });
    // A design's arrow opens that design here; a parcel's arrow carries its own handler.
    container.addEventListener('click', event => {
        const open = event.target.closest('[data-open-design-id]');
        if (!open || !container.contains(open)) return;
        event.preventDefault();
        clearProposalHoverLayers();
        focusProposalDetails(open.dataset.openDesignId, { centerOnProposal: true, showDetails: true });
    });
    proposalDetailsObjectList = { container, bound };
    return bound;
}

// Another design, or none, takes the panel: nothing stays pressed, and a kept outline goes unless
// the click stack repaints its selection.
function releaseProposalDetailsObjectList(bound = proposalDetailsObjectList?.bound) {
    bound?.reset();
    clearProposalHoverLayers();
    if (proposalDetailsInspecting && !window.ClickStack?.holdsHighlight()) highlightFeaturesForInspection([]);
    proposalDetailsInspecting = false;
}

// A design's output parcels exist once its formation has replayed onto the map, which can finish
// after the panel opened (a reload, a shared link, an apply): the open panel re-renders when the
// number of parcels its design has formed changes, so its counts and lists are never left stale.
let proposalDetailsFabricSubscribed = false;
function subscribeProposalDetailsToFabric() {
    if (proposalDetailsFabricSubscribed || typeof window.LiveParcelFabric?.subscribe !== 'function') return;
    proposalDetailsFabricSubscribed = true;
    window.LiveParcelFabric.subscribe(() => {
        const panel = document.getElementById('proposal-details-panel');
        const content = document.getElementById('proposal-details-content');
        if (!panel?.classList.contains('visible') || !currentProposalDetailsContext || !content) return;
        const formed = window.__claims?.materializedParcelIdsOf?.(currentProposalDetailsContext)?.length || 0;
        if (String(formed) === content.dataset.outputCount) return;
        const body = document.getElementById('proposal-details-body');
        showProposalInfo(currentProposalDetailsContext, null, { scrollTop: body?.scrollTop || 0 });
    });
}

// The panel's buttons and labels are rendered once through tProposal(); re-render the open panel
// when the language changes so nothing stays in the previous language.
function rerenderProposalDetailsForLanguage() {
    const panel = document.getElementById('proposal-details-panel');
    const body = document.getElementById('proposal-details-body');
    if (!panel?.classList.contains('visible') || !currentProposalDetailsContext) return;
    showProposalInfo(currentProposalDetailsContext, null, { scrollTop: body?.scrollTop || 0 });
}

if (typeof window !== 'undefined') {
    if (window.i18n && typeof window.i18n.onChange === 'function') {
        window.i18n.onChange(rerenderProposalDetailsForLanguage);
    }
    window.addEventListener('i18n:translationsLoaded', rerenderProposalDetailsForLanguage);
}

// The Bets sheet and dialog (js/bets/) record a wallet's market action in the activity feed through these.
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

function returnToParcelInfo(parcelId, event) {
    // Prevent event bubbling to avoid triggering parcel click handlers
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    // 1) Close Proposal UI (details/modal/list) and leave proposal mode
    if (typeof hideProposalDetailsPanel === 'function') hideProposalDetailsPanel(true);
    if (typeof closeProposalList === 'function') closeProposalList();
    if (window.ParcelCompare) window.ParcelCompare.close();
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

// The local record key sits behind a copy button (docs/design-language.md); it is not a server row
// or chain token/account identifier, even when an imported authored ID supplies the local key.
function copyProposalIdToClipboard(id) {
    const text = String(id || '');
    if (!text) return;
    const t = getProposalI18nHelper();
    const done = () => {
        if (typeof showEphemeralMessage === 'function') showEphemeralMessage(t('common.copied', 'Copied'), 2000);
    };
    // Without clipboard access the ID is shown in a prompt's field, to copy by hand.
    const showToCopy = () => window.CbDialog.prompt(t('panel.proposal.copyId', 'Copy local ID'), { defaultValue: text });
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(showToCopy);
    } else {
        showToCopy();
    }
}
window.copyProposalIdToClipboard = copyProposalIdToClipboard;

function hideProposalDetailsPanel(clearHighlights = false, { preserveCorridorSegment = false } = {}) {
    const proposalPanel = document.getElementById('proposal-details-panel');
    if (proposalPanel) {
        setProposalDetailsPanelMinimized(proposalPanel, false);
        proposalPanel.classList.remove('visible');
    }
    document.body.classList.remove('proposal-details-open');
    teardownProposalDetailsEscapeHandler();

    // Clear cached proposal context when panel closes
    currentProposalDetailsContext = null;
    // The before/after divider lives and dies with the panel.
    try { window.ProposalBeforeAfter?.dispose(); } catch (_) { /* no map */ }

    // Clear hover overlay when closing, and any list item kept outlined.
    try { clearProposalInfoHoverOverlay(); } catch (_) { }
    releaseProposalDetailsObjectList();

    // Clear any proposal highlights when closing
    if (clearHighlights && typeof clearProposalHighlights === 'function') {
        clearProposalHighlights();
    }

    // A dismissed selection drops the segment edit scope. Switching to the shared inspector
    // for that same road keeps the clicked segment available to its Cross-section action.
    try {
        if (!preserveCorridorSegment && typeof window !== 'undefined') {
            window.corridorLastClickedSegment = null;
            if (typeof window.refreshSelectedCorridorSegmentHighlight === 'function') {
                window.refreshSelectedCorridorSegmentHighlight();
            }
        }
    } catch (_) { }

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
        // The map card keeps its actions while the reader's body is folded away.
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
        // Already handled (an open sheet closed on this Escape): one Escape closes one thing.
        if (event.defaultPrevented) return;
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

    const { scrollTop, parcelId } = preserveState;

    const resolvePanelBody = () => {
        const panel = document.getElementById('proposal-details-panel');
        return panel ? panel.querySelector('.panel-body') : null;
    };

    const apply = () => {
        const panelBody = resolvePanelBody();
        if (!panelBody) return;

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
// cab riding on this track design's drawn centerline. URL contract consumed
// by zagreb-isochrone's transit.js: ?st3d=cab&track=<cid>&proposals=<cids>, the published
// designs it reads from the index (GET /designs/:cid).
function driveTrackProposalIn3DSim(proposalKey) {
    const proposal = (typeof getProposalByIdOrHash === 'function') ? getProposalByIdOrHash(proposalKey) : null;
    const trackCid = proposal ? window.DesignSync.publishedCid(proposal) : null;
    const driveConfig = (typeof CityConfigManager !== 'undefined' && typeof CityConfigManager.getDriveConfig === 'function')
        ? CityConfigManager.getDriveConfig()
        : null;
    if (!trackCid || !driveConfig || !driveConfig.url) {
        console.warn('[drive] cannot open 3D sim: the track is not published, or there is no sim url', { proposalKey, trackCid, driveConfig });
        return;
    }

    // Every published design on this map, so the sim loads the scene the user is looking at.
    const appliedCids = new Set();
    for (const p of window.proposalStorage.getAllProposals()) {
        if (!p || !isProposalCurrentlyApplied(p)) continue;
        const cid = window.DesignSync.publishedCid(p);
        if (cid) appliedCids.add(cid);
    }

    const params = new URLSearchParams();
    params.set('st3d', 'cab');
    params.set('track', trackCid);
    if (appliedCids.size) params.set('proposals', window.DesignSync.sortedCids([...appliedCids]).join(','));
    // loc selects the sim's per-city world sources (station-3d/core/locations.js).
    if (driveConfig.locParam) params.set('loc', driveConfig.locParam);
    const url = `${driveConfig.url}?${params.toString()}`;
    console.log('[drive] opening 3D cab on track design:', url);
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
            color: window.MapHighlight.color,
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
