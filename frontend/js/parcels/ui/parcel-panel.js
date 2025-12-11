(function (global) {
    'use strict';

    const tParcel = (key, params = {}, fallback = '') => {
        if (typeof global.tParcel === 'function') {
            return global.tParcel(key, params, fallback);
        }
        const api = global?.i18n;
        if (api && typeof api.t === 'function') {
            const translated = api.t(key, params);
            if (translated && translated !== key) {
                return translated;
            }
        }
        return fallback || key || '';
    };

    const ownershipUi = global?.Parcels?.ownershipUi || {};
    const uiProposals = global?.Parcels?.uiProposals || {};

    const buildSimulatedOwnerHtml = (parcelId) => {
        const fn = global?.Parcels?.ownership?.buildSimulatedOwnerHtml || global.buildSimulatedOwnerHtml;
        return typeof fn === 'function' ? fn(parcelId) : '';
    };

    const PARCEL_OWNER_VALUE_ELEMENT_ID = global.PARCEL_OWNER_VALUE_ELEMENT_ID || 'parcel-owner-value';

    const applyParcelTranslations = (root) => {
        const i18nApply = global?.i18n?.applyTranslations;
        const ownerApply = global?.Parcels?.ownership?.applyParcelTranslations;
        const legacyApply = global.applyParcelTranslations;
        const fn = typeof i18nApply === 'function' ? i18nApply
            : (typeof ownerApply === 'function' ? ownerApply
                : (typeof legacyApply === 'function' ? legacyApply : null));
        if (typeof fn === 'function') {
            return fn(root);
        }
        return root;
    };

    function showParcelInfoPanel(feature) {
        const area = feature.properties.calculatedArea;
        const formattedArea = area ? Math.round(Number(area)).toLocaleString('hr-HR') : 'N/A';
        const estimatedPrice = area ? area * SQM_AVG_PRICE : 0;
        const formattedPrice = estimatedPrice ? estimatedPrice.toLocaleString('hr-HR', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 0
        }) : 'N/A';

        const areaUnit = tParcel('panel.parcel.metrics.areaUnit', {}, 'm²');
        const priceCurrency = tParcel('panel.parcel.metrics.priceCurrency', {}, '€');
        const ownerLabel = tParcel('panel.parcel.metrics.owner', {}, 'Owner:');
        const shareLabel = tParcel('panel.parcel.metrics.share', {}, 'Share:');
        const ownersLabel = tParcel('panel.parcel.metrics.owners', {}, 'Owners:');
        const blockLabel = tParcel('panel.parcel.metrics.block', {}, 'Block:');
        const areaLabel = tParcel('panel.parcel.metrics.area', {}, 'Area:');
        const marketPriceLabel = tParcel('panel.parcel.metrics.marketPrice', {}, 'Est. Market Price:');

        const parcelId = feature.properties.CESTICA_ID;

        const blockName = feature.properties.block;
        const cityId = typeof global.getCurrentCityId === 'function' ? global.getCurrentCityId() : 'zagreb';
        const isBuenosAires = cityId === 'buenos_aires';

        let blockHtml;
        if (blockName) {
            if (isBuenosAires) {
                blockHtml = `<span class="block-tag" onclick="selectBuenosAiresBlock('${parcelId}')" style="cursor: pointer; background-color: #007bff; color: white; padding: 2px 8px; border-radius: 12px;">${blockName}</span>`;
            } else {
                blockHtml = `<span class="block-tag" onclick="highlightAndCenterBlock('${blockName}')" style="cursor: pointer; background-color: #007bff; color: white; padding: 2px 8px; border-radius: 12px;">${blockName}</span>`;
            }
        } else {
            blockHtml = `<span data-i18n-key="panel.parcel.block.notPart">${tParcel('panel.parcel.block.notPart', {}, 'Not part of a block')}</span>`;
        }

        const storage = (typeof global.Proposals !== 'undefined' && global.Proposals.storage) ? global.Proposals.storage : global.proposalStorage;
        const parcelProposals = storage && typeof storage.getProposalsForParcel === 'function'
            ? storage.getProposalsForParcel(parcelId.toString(), { hydrateRoadAssets: false })
            : [];

        const shouldFetchRealOwners = (typeof global !== 'undefined' && global.Parcels && global.Parcels.ownership && typeof global.Parcels.ownership.shouldUseRealParcelOwners === 'function')
            ? global.Parcels.ownership.shouldUseRealParcelOwners()
            : false;
        const simulatedOwnerHtml = buildSimulatedOwnerHtml(parcelId);
        const fallbackOwnerName = tParcel('panel.parcel.owner.single', {}, 'Single owner');
        const fallbackOwnerHtml = simulatedOwnerHtml || `
            <div class="owner-row" style="display: flex; justify-content: space-between; gap: 8px;">
                <span data-i18n-key="panel.parcel.owner.single">${fallbackOwnerName}</span>
                <span style="color: #666; font-size: 0.9em;">100%</span>
            </div>
        `;
        let ownershipHtml = fallbackOwnerHtml;

        const initialOwnerCount = 1;

        if (shouldFetchRealOwners) {
            ownershipHtml = `<span class="owner-loading" data-i18n-key="panel.parcel.owner.loading" style="color: #666;">${tParcel('panel.parcel.owner.loading', {}, 'Loading real ownership data...')}</span>`;
        }

        let proposalsHtml = tParcel('panel.parcel.proposalsSection.empty', {}, 'No proposals');
        const proposalFallbackTitle = tParcel('panel.parcel.proposalsSection.fallbackTitle', {}, 'Proposal');
        const proposalRoadSuffix = tParcel('panel.parcel.proposalsSection.roadSuffix', {}, ' (Road)');
        const proposalIdLabel = tParcel('panel.parcel.proposalsSection.details.id', {}, 'ID:');
        const proposalAuthorLabel = tParcel('panel.parcel.proposalsSection.details.author', {}, 'Author:');
        const proposalUnknownAuthor = tParcel('panel.parcel.proposalsSection.details.unknownAuthor', {}, 'Unknown');
        const proposalOfferLabel = tParcel('panel.parcel.proposalsSection.details.offer', {}, 'Offer:');
        const activeStatusLabel = tParcel('panel.parcel.proposalsSection.status.active', {}, 'Active');
        const appliedBadgeLabel = tParcel('panel.parcel.proposalsSection.badges.applied', {}, 'Applied');

        const getProposalDisplayId = (proposal) => {
            const resolvedId = proposal.proposalId || proposal.proposal_id;
            if (resolvedId) {
                const str = String(resolvedId);
                if (str.startsWith('local-') || str.startsWith('local_prop') || str.startsWith('local-prop')) {
                    return str;
                }
                return str;
            }
            return proposal.proposalHash ? proposal.proposalHash.substring(0, 8) : '';
        };

        if (parcelProposals.length > 0) {
            const proposalItems = parcelProposals.map(proposal => {
                const isRoadProposal = proposal.type === 'road' && proposal.roadProposal;
                const isBuildingProposal = (!isRoadProposal) && (proposal.type === 'building' || !!proposal.buildingProposal);
                const isStructureProposal = (!isRoadProposal && !isBuildingProposal) && !!proposal.structureProposal;
                const lifecycleKey = (typeof global.getProposalLifecycleKey === 'function') ? global.getProposalLifecycleKey(proposal) : null;
                const statusText = (typeof global.getProposalLifecycleLabel === 'function' && lifecycleKey)
                    ? global.getProposalLifecycleLabel(lifecycleKey)
                    : (proposal.status || activeStatusLabel);
                const statusClass = (typeof global.getProposalLifecycleClass === 'function' && lifecycleKey)
                    ? global.getProposalLifecycleClass(lifecycleKey)
                    : 'active';
                const mapApplied = (typeof global.isProposalApplied === 'function') ? global.isProposalApplied(proposal) : false;

                const hasAccepted = proposal.acceptedParcelIds && proposal.acceptedParcelIds.includes(parcelId.toString());

                const isActive = proposal.status !== 'Executed' && proposal.status !== 'Applied';

                let actionButtons = '';

                const parcelAcceptanceIndicatorsHtml = global.buildParcelAcceptanceIndicators ? global.buildParcelAcceptanceIndicators(proposal) : '';
                const ownerAcceptanceIndicatorsHtml = global.buildOwnerAcceptanceIndicators ? global.buildOwnerAcceptanceIndicators(proposal) : '';
                const rawOfferValue = Number.isFinite(Number(proposal.offer))
                    ? Number(proposal.offer)
                    : (Number.isFinite(Number(proposal.budget)) ? Number(proposal.budget) : null);
                const offerCurrencyRaw = proposal.offerCurrency || proposal.budgetCurrency || proposal.currency || 'ETH';
                const offerCurrency = typeof offerCurrencyRaw === 'string' ? offerCurrencyRaw.toUpperCase() : offerCurrencyRaw;
                const currencySymbol = offerCurrency === 'EUR' ? '€' : '';
                const currencySuffix = offerCurrency && offerCurrency !== 'EUR' ? ` ${offerCurrency}` : '';
                const formattedOfferValue = rawOfferValue !== null && rawOfferValue > 0
                    ? Math.round(rawOfferValue).toLocaleString('hr-HR')
                    : null;

                const proposalTypeKey = (typeof global.getProposalDisplayType === 'function') ? global.getProposalDisplayType(proposal) : (proposal.type || 'other');
                const proposalTypeLabel = tParcel(
                    `modal.roadProposal.proposalList.typeLabels.${proposalTypeKey}`,
                    {},
                    typeof global.formatProposalTypeLabel === 'function' ? global.formatProposalTypeLabel(proposalTypeKey) : (proposalTypeKey || proposalFallbackTitle)
                );
                const proposalNameCandidates = [
                    proposal.title,
                    proposal.name,
                    proposal.proposalName,
                    proposal.structureProposal && proposal.structureProposal.name,
                    proposal.buildingProposal && proposal.buildingProposal.name,
                    proposal.roadProposal && proposal.roadProposal.name,
                    proposal.description
                ].map(v => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
                const proposalTitle = proposalNameCandidates[0] || proposalTypeLabel || proposalFallbackTitle;
                const roadSuffix = isRoadProposal ? proposalRoadSuffix : '';
                const proposalIdText = `
                    <span class="proposal-item-label" data-i18n-key="panel.parcel.proposalsSection.details.id">${proposalIdLabel}</span>
                    ${getProposalDisplayId(proposal)}
                `.trim();
                const authorValue = proposal.author || proposal.username || proposalUnknownAuthor;

                return `
                    <div class="proposal-item" onclick="showProposalDetails('${proposal.proposalHash}', '${parcelId}')" style="cursor: pointer;">
                        <div class="proposal-item-header">
                            <span class="proposal-item-title">${proposalTitle}${roadSuffix}</span>
                            <div class="proposal-item-badges">
                                <span class="proposal-item-status ${statusClass}">${statusText}</span>
                                ${mapApplied ? `<span class="proposal-item-map-badge applied">${appliedBadgeLabel}</span>` : ''}
                            </div>
                        </div>
                        <div class="proposal-item-details">
                            ${proposalIdText}
                        </div>
                        <div class="proposal-item-details">
                            <span class="proposal-item-label" data-i18n-key="panel.parcel.proposalsSection.details.author">${proposalAuthorLabel}</span> <span class="proposal-author-value">${authorValue}</span>
                        </div>
                        ${formattedOfferValue && !isRoadProposal ? `
                            <div class="proposal-item-details">
                                <span class="proposal-item-label" data-i18n-key="panel.parcel.proposalsSection.details.offer">${proposalOfferLabel}</span> ${currencySymbol}${formattedOfferValue}${currencySuffix}
                            </div>
                        ` : ''}
                        ${parcelAcceptanceIndicatorsHtml ? `<div class="proposal-item-indicators">${parcelAcceptanceIndicatorsHtml}</div>` : ''}
                        ${ownerAcceptanceIndicatorsHtml ? `<div class="proposal-item-indicators">${ownerAcceptanceIndicatorsHtml}</div>` : ''}
                        ${actionButtons ? `
                        <div class="proposal-item-actions" style="margin-top: 8px; text-align: right;">
                            ${actionButtons}
                        </div>` : ''}
                    </div>
                `;
            }).join('');

            proposalsHtml = `
            <div class="parcel-proposals-list">
                ${proposalItems}
            </div>
        `;
        }

        const infoContent = `
        <div class="parcel-owner-section">
            <div class="parcel-owner-header">
                <div class="parcel-owner-header-label" data-i18n-key="panel.parcel.metrics.owner">${ownerLabel}</div>
                <div class="parcel-owner-header-label parcel-owner-header-share" data-i18n-key="panel.parcel.metrics.share">${shareLabel}</div>
            </div>
            <div class="parcel-owners-container" id="${PARCEL_OWNER_VALUE_ELEMENT_ID}">${ownershipHtml}</div>
        </div>
        <div style="display: flex; gap: 8px;">
            <div class="metric-group" style="flex: 1;">
                <div class="metric-label" data-i18n-key="panel.parcel.metrics.owners">${ownersLabel}</div>
                <div class="metric-value" id="parcel-owners-count">-</div>
            </div>
            <div class="metric-group" style="flex: 1;">
                <div class="metric-label" data-i18n-key="panel.parcel.metrics.block">${blockLabel}</div>
                <div class="metric-value">${blockHtml}</div>
            </div>
        </div>
        <div style="display: flex; gap: 8px;">
            <div class="metric-group" style="flex: 1;">
                <div class="metric-label" data-i18n-key="panel.parcel.metrics.area">${areaLabel}</div>
                <div class="metric-value">${formattedArea} ${areaUnit}</div>
            </div>
            <div class="metric-group" style="flex: 1;">
                <div class="metric-label" data-i18n-key="panel.parcel.metrics.marketPrice">${marketPriceLabel}</div>
                <div class="metric-value">${formattedPrice} ${priceCurrency}</div>
            </div>
        </div>
        <div id="roadMeasurements" style="display: none;">
        </div>
    `;

        const proposalsContent = parcelProposals.length > 0 ? `
        <div id="parcel-proposal-actions" class="parcel-proposal-actions"></div>
        ${proposalsHtml}
    ` : `
        <div id="parcel-proposal-actions" class="parcel-proposal-actions"></div>
    `;

        const titleElement = global.document.getElementById('parcel-info-title');
        if (titleElement) {
            const broj = feature.properties.BROJ_CESTICE;
            const cesticaId = feature.properties.CESTICA_ID;
            const brojValue = broj ? broj.toString() : '';
            const idMarkup = cesticaId
                ? `<span class="parcel-title-id">${tParcel('panel.parcel.idLabel', {}, 'ID:')} <span class="parcel-title-id-value">${cesticaId}</span></span>`
                : '';
            const hasNumber = !!brojValue;
            const titleText = hasNumber
                ? tParcel('panel.parcel.titleWithNumber', { number: brojValue }, `Parcel Info (${brojValue})`)
                : tParcel('panel.parcel.title', {}, 'Parcel Info');

            titleElement.setAttribute('data-i18n-key', hasNumber ? 'panel.parcel.titleWithNumber' : 'panel.parcel.title');
            if (hasNumber) {
                titleElement.setAttribute('data-i18n-params', JSON.stringify({ number: brojValue }));
            } else {
                titleElement.removeAttribute('data-i18n-params');
            }
            titleElement.innerHTML = `<span class="parcel-title-label">${titleText}</span>${idMarkup ? ` ${idMarkup}` : ''}`;
            if (typeof global.i18n !== 'undefined' && typeof global.i18n.applyTranslations === 'function') {
                try { global.i18n.applyTranslations(titleElement); } catch (_) { /* ignore */ }
            }
        }

        const proposalCount = parcelProposals.length;
        const proposalsTabButton = global.document.querySelector('.parcel-tab-btn[onclick*="proposals-tab"]');
        if (proposalsTabButton) {
            if (proposalCount > 0) {
                proposalsTabButton.setAttribute('data-i18n-key', 'panel.parcel.tabProposalsWithCount');
                proposalsTabButton.setAttribute('data-i18n-params', JSON.stringify({ count: proposalCount }));
                proposalsTabButton.textContent = tParcel('panel.parcel.tabProposalsWithCount', { count: proposalCount }, `Proposals (${proposalCount})`);
            } else {
                proposalsTabButton.setAttribute('data-i18n-key', 'panel.parcel.tabProposals');
                proposalsTabButton.removeAttribute('data-i18n-params');
                proposalsTabButton.textContent = tParcel('panel.parcel.tabProposals', {}, 'Proposals');
            }
            applyParcelTranslations(proposalsTabButton);
        }

        global.document.getElementById('info-content').innerHTML = infoContent;

        const ownersCountElement = global.document.getElementById('parcel-owners-count');
        if (ownersCountElement) {
            if (shouldFetchRealOwners) {
                const ownerLoadingLabel = tParcel('panel.parcel.owner.loading', {}, 'Loading real ownership data...');
                ownersCountElement.innerHTML = '<span class="metric-spinner" aria-hidden="true"></span>';
                ownersCountElement.setAttribute('role', 'status');
                ownersCountElement.setAttribute('aria-label', ownerLoadingLabel);
            } else {
                ownersCountElement.removeAttribute('role');
                ownersCountElement.removeAttribute('aria-label');
                ownersCountElement.textContent = initialOwnerCount.toString();
            }
        }

        const fetchAndDisplayRealOwners = ownershipUi.fetchAndDisplayRealOwners || global.fetchAndDisplayRealOwners;
        if (shouldFetchRealOwners && typeof fetchAndDisplayRealOwners === 'function') {
            fetchAndDisplayRealOwners(parcelId, {
                fallbackHtml: fallbackOwnerHtml,
                hasSimulatedOwner: !!simulatedOwnerHtml
            });
        }
        global.document.getElementById('proposals-content').innerHTML = proposalsContent;
        const renderParcelProposalActions = uiProposals.renderParcelProposalActions || global.renderParcelProposalActions;
        if (typeof renderParcelProposalActions === 'function') {
            renderParcelProposalActions(parcelId);
        }

        applyParcelTranslations(global.document.getElementById('parcel-info-panel'));

        global.document.getElementById('parcel-info-panel').classList.add('visible');

        global.requestAnimationFrame(() => {
            if (typeof global.CityConfigManager !== 'undefined' &&
                typeof global.CityConfigManager.applyFeatureVisibility === 'function') {
                global.CityConfigManager.applyFeatureVisibility();
            }
        });

        if (typeof global.resetParcelMintStatusState === 'function') {
            global.resetParcelMintStatusState();
        }
        const toolsTabContent = global.document.getElementById('tools-tab');
        if (toolsTabContent && toolsTabContent.classList.contains('active') && typeof global.triggerParcelToolsTabActivated === 'function') {
            global.triggerParcelToolsTabActivated();
        }

        if (typeof global.multiParcelSelection !== 'undefined' && global.multiParcelSelection.isActive) {
            global.switchParcelTab(global.document.querySelector('.parcel-tab-btn[onclick*="info-tab"]'), 'info-tab');
        }

        resetMeasureAsRoadButton();
    }

    function resetMeasureAsRoadButton() {
        const button = global.document.getElementById('measureAsRoadButton');
        const measurementsDiv = global.document.getElementById('roadMeasurements');

        if (button) {
            button.innerHTML = tParcel('panel.parcel.actions.measureAsRoad', {}, 'Measure as road');
            button.disabled = false;
        }

        if (measurementsDiv) {
            measurementsDiv.style.display = 'none';
            measurementsDiv.innerHTML = '';
        }
    }

    function hideParcelInfoPanel() {
        const parcelInfoPanel = global.document.getElementById('parcel-info-panel');
        if (parcelInfoPanel) parcelInfoPanel.classList.remove('visible');
        if (typeof global.clearRoadVisualization === 'function') {
            global.clearRoadVisualization();
        }

        if (typeof global.resetParcelMintStatusState === 'function') {
            global.resetParcelMintStatusState();
        }

        const previouslySelectedId = global.selectedParcelId ? global.selectedParcelId.toString() : null;
        global.selectedParcelId = null;
        global.window.selectedParcelId = null;
        global.currentParcel = null;
        global.window.currentParcel = null;
        global.currentParcelCoordinates = null;

        if (typeof global.refreshParcelStylesForAppliedProposals === 'function') {
            global.refreshParcelStylesForAppliedProposals();
        } else if (previouslySelectedId && global.parcelLayer) {
            const previousLayer = global.parcelLayer.getLayers().find(layer => {
                const id = layer?.feature?.properties?.CESTICA_ID;
                return id !== undefined && id !== null && id.toString() === previouslySelectedId;
            });
            if (previousLayer) {
                const isRoad = global.PersistentStorage.getItem(`parcel_${previouslySelectedId}_isRoad`) === 'true';
                previousLayer.setStyle(global.getParcelBaseStyle(previouslySelectedId, { isRoad }));
            }
        }

        try { if (typeof global.clearProposalInfoHoverOverlay === 'function') global.clearProposalInfoHoverOverlay(); } catch (_) { }
        try { if (typeof global.clearProposalHighlights === 'function') global.clearProposalHighlights(); } catch (_) { }

        const createProposalButton = global.document.getElementById('createProposalFromParcelButton');
        if (createProposalButton) {
            createProposalButton.style.display = 'none';
        }

        if (typeof global.multiParcelSelection !== 'undefined' && global.multiParcelSelection.updateCreateProposalButton) {
            global.multiParcelSelection.updateCreateProposalButton();
        }

        if (typeof global.neighborHighlightActive !== 'undefined' && global.neighborHighlightActive) {
            global.neighborHighlightActive = false;
            const neighborBtn = global.document.getElementById('neighboursButton');
            if (neighborBtn) neighborBtn.classList.remove('active');
            if (typeof global.clearHighlightedNeighbors === 'function') {
                global.clearHighlightedNeighbors();
            }
        }
        if (typeof global.verticesDisplayActive !== 'undefined' && global.verticesDisplayActive) {
            global.verticesDisplayActive = false;
            const verticesBtn = global.document.getElementById('verticesButton');
            if (verticesBtn) verticesBtn.classList.remove('active');
            if (typeof global.clearVertexMarkers === 'function') {
                global.clearVertexMarkers();
            }
        }
    }

    global.ParcelsUIParcelPanel = {
        showParcelInfoPanel,
        resetMeasureAsRoadButton,
        hideParcelInfoPanel
    };

    if (!global.showParcelInfoPanel) global.showParcelInfoPanel = showParcelInfoPanel;
    if (!global.resetMeasureAsRoadButton) global.resetMeasureAsRoadButton = resetMeasureAsRoadButton;
    if (!global.hideParcelInfoPanel) global.hideParcelInfoPanel = hideParcelInfoPanel;
})(typeof window !== 'undefined' ? window : globalThis);

