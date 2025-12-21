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

    const resolveParcelId = (feature) => {
        const props = feature?.properties || {};
        const id = typeof ensureParcelId === 'function'
            ? ensureParcelId(feature)
            : (props.parcelId ?? props.parcel_id ?? props.id);
        return id !== undefined && id !== null ? id.toString() : null;
    };

    function showParcelInfoPanel(feature) {
        const props = feature?.properties || {};
        const areaSource = props.calculatedArea
            || props.area
            || props.parcelArea
            || props.informationTechnical?.superficie_total;
        const area = Number.isFinite(Number(areaSource)) ? Number(areaSource) : 0;
        const formattedArea = area ? Math.round(area).toLocaleString('hr-HR') : 'N/A';

        // Use market price from backend if available, otherwise calculate
        const backendPrice = props.estimatedMarketPrice;
        const backendCurrency = props.estimatedMarketPriceCurrency || props.currency || 'EUR';
        const estimatedPrice = Number.isFinite(Number(backendPrice))
            ? Number(backendPrice)
            : (area ? area * SQM_AVG_PRICE : 0);
        const formattedPrice = estimatedPrice ? estimatedPrice.toLocaleString('hr-HR', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 0
        }) : 'N/A';

        const areaUnit = tParcel('panel.parcel.metrics.areaUnit', {}, 'm²');
        const priceCurrency = backendCurrency === 'EUR' ? '€' : backendCurrency;
        const ownerLabel = tParcel('panel.parcel.metrics.owner', {}, 'Owner:');
        const shareLabel = tParcel('panel.parcel.metrics.share', {}, 'Share:');
        const ownersLabel = tParcel('panel.parcel.metrics.owners', {}, 'Owners:');
        const blockLabel = tParcel('panel.parcel.metrics.block', {}, 'Block:');
        const detectBlockLabel = tParcel('panel.parcel.block.detect', {}, 'Detect');
        const areaLabel = tParcel('panel.parcel.metrics.area', {}, 'Area:');
        const marketPriceLabel = tParcel('panel.parcel.metrics.marketPrice', {}, 'Est. Mkt. Price:');

        const normalizedParcelId = resolveParcelId(feature);
        const brojCestice = feature.properties.BROJ_CESTICE ?? feature.properties.broj_cestice;
        const maticniBrojKo = feature.properties.MATICNI_BROJ_KO ?? feature.properties.maticni_broj_ko ?? (feature.properties.cadastralMunicipality && feature.properties.cadastralMunicipality.id);
        let parcelId = normalizedParcelId;

        if (brojCestice !== undefined && brojCestice !== null && maticniBrojKo !== undefined && maticniBrojKo !== null) {
            const numberStr = String(brojCestice).trim();
            const municipalityStr = String(maticniBrojKo).trim();
            if (numberStr && municipalityStr) {
                parcelId = `HR-${municipalityStr}-${numberStr}`;
            }
        }
        if (!parcelId && normalizedParcelId) {
            parcelId = normalizedParcelId;
        }
        const parcelKey = parcelId ? parcelId.toString() : '';

        // Check if ownership data is already in feature properties (from backend)
        const rawOwnershipListFromProps = Array.isArray(feature.properties.ownershipList)
            ? feature.properties.ownershipList
            : null;
        let ownershipListFromProps = rawOwnershipListFromProps;

        // Normalize ownership data from backend format (ownerLabel, percentageShare) to frontend format (name, actualShareText)
        if (ownershipListFromProps && ownershipListFromProps.length > 0) {
            const formatPercentValueFn = global.formatPercentValue
                || (global.ParcelsOwnershipUi && global.ParcelsOwnershipUi.formatPercentValue);

            ownershipListFromProps = ownershipListFromProps.map(owner => {
                // Convert ownerLabel to name
                const name = owner.name || owner.ownerLabel || owner.possessorName || '';

                // Convert percentageShare to actualShareText
                // percentageShare is already a percentage (0-100), not a decimal (0-1)
                // Always prefer percentageShare if it exists, as it's the authoritative source from backend
                let actualShareText = null;
                if (Number.isFinite(owner.percentageShare)) {
                    const pctValue = owner.percentageShare;
                    // Ensure we're working with the actual numeric value, not a string
                    const numValue = typeof pctValue === 'string' ? parseFloat(pctValue) : pctValue;
                    if (Number.isFinite(numValue)) {
                        // Use formatPercentValue if available (it expects percentage values 0-100)
                        if (typeof formatPercentValueFn === 'function') {
                            actualShareText = formatPercentValueFn(numValue);
                        } else {
                            // Fallback formatting - percentageShare is already 0-100 range
                            const abs = Math.abs(numValue);
                            const decimals = abs >= 10 ? 0 : (abs >= 1 ? 1 : 2);
                            const formatted = numValue.toFixed(decimals);
                            // Remove trailing zeros only after the decimal point, not from whole numbers
                            const cleaned = formatted.includes('.') ? formatted.replace(/\.?0+$/, '') : formatted;
                            actualShareText = `${cleaned}%`;
                        }
                    }
                }
                // Fall back to existing actualShareText if percentageShare is not available or invalid
                if (!actualShareText) {
                    actualShareText = owner.actualShareText || owner.ownership || owner.shareText || '100%';
                }

                // Return normalized owner object
                return {
                    ...owner,
                    name: name,
                    ownerLabel: owner.ownerLabel || name,
                    actualShareText: actualShareText,
                    ownership: owner.ownership || actualShareText,
                    shareText: owner.shareText || actualShareText
                };
            });
        }

        const ownershipTypeFromProps = feature.properties.ownershipType || null;

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
            blockHtml = `<button type="button" class="btn btn-primary btn-sm parcel-block-detect-btn" data-i18n-key="panel.parcel.block.detect" onclick="(window.animateFloodfillFromSelected || function(){} )();" style="box-sizing: border-box; margin: 0; padding: 0 8px; font-size: 12px; height: 22px; line-height: 22px; min-height: 0; background-color: #007bff; border-color: #007bff; color: #fff;">${detectBlockLabel}</button>`;
        }

        const storage = (typeof global.Proposals !== 'undefined' && global.Proposals.storage) ? global.Proposals.storage : global.proposalStorage;
        const parcelProposals = storage && typeof storage.getProposalsForParcel === 'function'
            ? storage.getProposalsForParcel(parcelKey, { hydrateRoadAssets: false })
            : [];

        const shouldUseRealOwnersFn = ownershipUi.shouldUseRealParcelOwners
            || (global.Parcels && global.Parcels.ownership && global.Parcels.ownership.shouldUseRealParcelOwners)
            || global.shouldUseRealParcelOwners;
        const shouldFetchRealOwners = typeof shouldUseRealOwnersFn === 'function'
            ? shouldUseRealOwnersFn()
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

        // If ownership data is available from feature properties, use it directly
        let initialOwnerCount = 1;
        if (ownershipListFromProps && ownershipListFromProps.length > 0) {
            const buildRealOwnerRowsHtmlFn = global.buildRealOwnerRowsHtml
                || (global.ParcelsOwnershipUi && global.ParcelsOwnershipUi.buildRealOwnerRowsHtml)
                || (ownershipUi && ownershipUi.buildRealOwnerRowsHtml);
            if (typeof buildRealOwnerRowsHtmlFn === 'function') {
                ownershipHtml = buildRealOwnerRowsHtmlFn(ownershipListFromProps);
                initialOwnerCount = ownershipListFromProps.length;
            } else {
                // Fallback: build simple HTML from ownership list
                ownershipHtml = ownershipListFromProps.map(owner => {
                    const name = (owner.name || owner.ownerLabel || owner.possessorName || fallbackOwnerName).trim();
                    let share = owner.actualShareText || owner.ownership || owner.shareText;
                    // Handle percentageShare if actualShareText is not available
                    if (!share && Number.isFinite(owner.percentageShare)) {
                        const value = owner.percentageShare;
                        const abs = Math.abs(value);
                        const decimals = abs >= 10 ? 0 : (abs >= 1 ? 1 : 2);
                        const formatted = value.toFixed(decimals).replace(/\.?0+$/, '');
                        share = `${formatted}%`;
                    }
                    share = share || '100%';
                    const safeName = typeof global.escapeHtml === 'function' ? global.escapeHtml(name) : name;
                    const safeShare = typeof global.escapeHtml === 'function' ? global.escapeHtml(share) : share;
                    return `
                        <div class="owner-row" style="display: flex; justify-content: space-between; gap: 8px;">
                            <span>${safeName}</span>
                            <span style="color: #666; font-size: 0.9em;">${safeShare}</span>
                        </div>
                    `;
                }).join('');
                initialOwnerCount = ownershipListFromProps.length;
            }
            // Cache the ownership data for future use
            const ownershipUiCache = ownershipUi.parcelOwnerDataCache
                || (global.Parcels && global.Parcels.ownershipUi && global.Parcels.ownershipUi.parcelOwnerDataCache)
                || (global.ParcelsOwnershipUi && global.ParcelsOwnershipUi.parcelOwnerDataCache);
            if (ownershipUiCache && typeof ownershipUiCache.set === 'function') {
                ownershipUiCache.set(parcelId.toString(), ownershipListFromProps);
            }
        } else if (shouldFetchRealOwners) {
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
            const resolvedId = proposal.proposalId;
            if (resolvedId) {
                const str = String(resolvedId);
                if (str.startsWith('local-') || str.startsWith('local_prop') || str.startsWith('local-prop')) {
                    return str;
                }
                return str;
            }
        };

        if (parcelProposals.length > 0) {
            const proposalItems = parcelProposals.map(proposal => {
                const goalKey = (typeof window.normalizeProposalGoalKey === 'function') ? window.normalizeProposalGoalKey(proposal.goal) : (proposal.goal || '').toLowerCase();
                const isRoadProposal = goalKey === 'road-track' || (!!proposal.roadProposal && goalKey === '');
                const isBuildingProposal = (!isRoadProposal) && (['buildings', 'building(s)', 'single-building', 'parcelBased'].includes(goalKey) || !!proposal.buildingProposal);
                const isStructureProposal = (!isRoadProposal && !isBuildingProposal) && (['park', 'square', 'lake'].includes(goalKey) || !!proposal.structureProposal);
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

                const proposalTypeKey = (typeof global.getProposalDisplayType === 'function') ? global.getProposalDisplayType(proposal) : (goalKey || 'other');
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
                    <div class="proposal-item" onclick="showProposalDetails('${proposal.proposalId}', '${parcelId}')" style="cursor: pointer;">
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

        const resolveAdLink = () => {
            const api = global?.Parcels?.adParcels || global?.ParcelsAdParcels || {};
            if (typeof api.getAdLink === 'function') {
                const link = api.getAdLink(parcelId);
                if (!link) return null;
                try {
                    const url = new URL(link, window.location.href);
                    return url.toString();
                } catch (_) {
                    return null;
                }
            }
            return null;
        };
        const adLink = resolveAdLink();
        const adButtonHtml = adLink ? `
            <button class="btn btn-success btn-sm parcel-ad-link-btn"
                onclick="(window.toggleAdActionsDialog || function(){} )('${adLink}'); return false;"
                data-i18n-key="panel.parcel.forSale">
                ${tParcel('panel.parcel.forSale', {}, 'For sale')}
            </button>
        ` : '';

        // Determine ownership type for display - will be updated when owners are fetched
        const ownershipTypeLabel = '<span class="parcel-ownership-type-label" style="display: none;"></span>';

        const infoContent = `
        <div class="parcel-owner-section">
            <div class="parcel-owner-header">
                <div class="parcel-owner-header-label" data-i18n-key="panel.parcel.metrics.owner">${ownerLabel}</div>
                ${ownershipTypeLabel}
                ${adButtonHtml}
                <div class="parcel-owner-header-label parcel-owner-header-share" data-i18n-key="panel.parcel.metrics.share">${shareLabel}</div>
            </div>
            ${adLink ? `
            <div class="parcel-ad-dialog" id="parcel-ad-dialog" data-ad-link="${adLink}" style="display:none;">
                <button class="parcel-info-btn parcel-builder-button"
                    onclick="window.open('${adLink}', '_blank', 'noopener,noreferrer'); return false;">
                    <i class="fas fa-shopping-cart" aria-hidden="true"></i>
                    <span data-i18n-key="panel.parcel.marketplace">${tParcel('panel.parcel.marketplace', {}, 'Marketplace')}</span>
                </button>
                <button class="parcel-info-btn parcel-builder-button"
                    onclick="(window.Parcels?.uiClaim?.openParcelBuilder || window.openParcelBuilder || function(){})(); return false;">
                    <svg class="parcel-builder-icon" viewBox="0 0 64 32" aria-hidden="true" focusable="false">
                        <path d="M6 22h30v-8h6l7 8v6h7v4H45a6 6 0 0 1-12 0h-9a6 6 0 0 1-12 0H6z" fill="currentColor"></path>
                        <rect x="14" y="9" width="12" height="8" rx="2" ry="2" fill="currentColor"></rect>
                        <path d="M50 12h10v12H50l-4-5v-2z" fill="currentColor"></path>
                        <circle cx="14" cy="30" r="4" fill="currentColor"></circle>
                        <circle cx="32" cy="30" r="4" fill="currentColor"></circle>
                    </svg>
                    <span data-i18n-key="panel.parcel.builderButton">${tParcel('panel.parcel.builderButton', {}, 'Parcel Builder')}</span>
                </button>
            </div>
            ` : ''}
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

        const roadToolsEnabled = (typeof global.CityConfigManager !== 'undefined'
            && typeof global.CityConfigManager.isFeatureEnabled === 'function')
            ? global.CityConfigManager.isFeatureEnabled('roadTools')
            : true;

        const roadDrawingActions = roadToolsEnabled ? `
        <div class="parcel-road-actions btn-group" data-feature="roadTools">
            <button type="button" class="btn btn-action" onclick="toggleRoadDrawTool()"
                data-i18n-key="sidebar.roads.drawManualTooltip" data-i18n-attr="title"
                title="Draw road manually">
                <i class="fas fa-road" aria-hidden="true"></i>
                <span data-i18n-key="sidebar.roads.drawManual">Draw Road</span>
            </button>
            <button type="button" class="btn btn-action" onclick="toggleTrackDrawTool()"
                data-i18n-key="sidebar.roads.drawTrackTooltip" data-i18n-attr="title"
                title="Draw track">
                <i class="fas fa-train" aria-hidden="true"></i>
                <span data-i18n-key="sidebar.roads.drawTrack">Draw Track</span>
            </button>
        </div>
    ` : '';

        const proposalsContent = `
        <div id="parcel-proposal-actions" class="parcel-proposal-actions">
            <div id="parcel-proposal-primary-actions"></div>
            ${roadDrawingActions}
        </div>
        ${parcelProposals.length > 0 ? proposalsHtml : ''}
    `;

        const titleElement = global.document.getElementById('parcel-info-title');
        if (titleElement) {
            const broj = brojCestice;
            const displayParcelId = parcelId;
            const brojValue = broj ? broj.toString() : '';
            const fallbackTitle = tParcel('panel.parcel.title', {}, 'Parcel Info');

            titleElement.removeAttribute('data-i18n-key');
            titleElement.removeAttribute('data-i18n-params');

            const resolvedId = displayParcelId || brojValue;
            const headerText = resolvedId ? `Parcel ${resolvedId}` : fallbackTitle;
            titleElement.textContent = headerText;

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

        // Update ownership type label - use from feature properties first, then check cache
        // Use requestAnimationFrame to ensure DOM is ready after innerHTML update
        global.requestAnimationFrame(() => {
            const getOwnershipTypeFn = global?.Parcels?.ownershipUi?.getOwnershipType || global?.getOwnershipType;
            const infoContentEl = global.document.getElementById('info-content');
            const ownershipTypeLabelEl = infoContentEl ? infoContentEl.querySelector('.parcel-ownership-type-label') : null;

            if (!ownershipTypeLabelEl) {
                return;
            }

            let typeLabel = '';

            // Re-check feature properties directly in case variables weren't set correctly
            const directOwnershipType = feature?.properties?.ownershipType;
            const directOwnershipList = Array.isArray(feature?.properties?.ownershipList) ? feature.properties.ownershipList : null;

            // First priority: use ownershipType directly from feature properties (from backend)
            const ownershipTypeToUse = ownershipTypeFromProps || directOwnershipType;
            if (ownershipTypeToUse && typeof ownershipTypeToUse === 'string') {
                const type = ownershipTypeToUse.trim();
                if (type) {
                    // Normalize the type to match expected values
                    const normalizedType = type === 'private individual' ? 'individual' : type;
                    typeLabel = tParcel(`panel.parcel.ownershipType.${normalizedType}`, {},
                        normalizedType === 'government' ? 'Government' :
                            normalizedType === 'institution' ? 'Institution' :
                                normalizedType === 'company' ? 'Company' :
                                    normalizedType === 'mixed' ? 'Mixed' : 'Individual');
                }
            }
            // Second priority: calculate from ownershipList in feature properties (from backend)
            const ownershipListToUse = rawOwnershipListFromProps || directOwnershipList;
            if (!typeLabel && ownershipListToUse && ownershipListToUse.length > 0 && typeof getOwnershipTypeFn === 'function') {
                // Use raw ownership list from backend (before normalization) to get ownerLabels
                // Extract ownerLabel from owner objects before calling getOwnershipType
                const types = ownershipListToUse.map(owner => {
                    const ownerLabel = owner?.ownerLabel || owner?.name || owner?.possessorName || '';
                    if (!ownerLabel) return null;
                    // getOwnershipType expects a string (ownerLabel), not an object
                    return getOwnershipTypeFn(ownerLabel);
                }).filter(Boolean);
                const uniqueTypes = Array.from(new Set(types));
                if (uniqueTypes.length === 1) {
                    const type = uniqueTypes[0];
                    // Normalize the type to match expected values
                    const normalizedType = type === 'private individual' ? 'individual' : type;
                    typeLabel = tParcel(`panel.parcel.ownershipType.${normalizedType}`, {},
                        normalizedType === 'government' ? 'Government' :
                            normalizedType === 'institution' ? 'Institution' :
                                normalizedType === 'company' ? 'Company' : 'Individual');
                } else if (uniqueTypes.length > 1) {
                    typeLabel = tParcel('panel.parcel.ownershipType.mixed', {}, 'Mixed');
                }
            }
            // Third priority: check cache
            else if (typeof getOwnershipTypeFn === 'function') {
                const ownershipUi = global?.Parcels?.ownershipUi || {};
                const parcelOwnerDataCache = ownershipUi.parcelOwnerDataCache || new Map();
                if (parcelOwnerDataCache.has(parcelId.toString())) {
                    const cachedOwners = parcelOwnerDataCache.get(parcelId.toString());
                    if (Array.isArray(cachedOwners) && cachedOwners.length > 0) {
                        // Extract ownerLabel from owner objects before calling getOwnershipType
                        const types = cachedOwners.map(owner => {
                            const ownerLabel = owner?.ownerLabel || owner?.name || owner?.possessorName || '';
                            if (!ownerLabel) return null;
                            // getOwnershipType expects a string (ownerLabel), not an object
                            return getOwnershipTypeFn(ownerLabel);
                        }).filter(Boolean);
                        const uniqueTypes = Array.from(new Set(types));
                        if (uniqueTypes.length === 1) {
                            const type = uniqueTypes[0];
                            // Normalize the type to match expected values
                            const normalizedType = type === 'private individual' ? 'individual' : type;
                            typeLabel = tParcel(`panel.parcel.ownershipType.${normalizedType}`, {},
                                normalizedType === 'government' ? 'Government' :
                                    normalizedType === 'institution' ? 'Institution' :
                                        normalizedType === 'company' ? 'Company' : 'Individual');
                        } else if (uniqueTypes.length > 1) {
                            typeLabel = tParcel('panel.parcel.ownershipType.mixed', {}, 'Mixed');
                        }
                    }
                }
            }

            if (typeLabel) {
                ownershipTypeLabelEl.textContent = typeLabel;
                ownershipTypeLabelEl.style.display = 'inline-block';

                // Add color class based on ownership type
                // Remove any existing ownership type classes
                ownershipTypeLabelEl.classList.remove(
                    'ownership-type-government',
                    'ownership-type-institution',
                    'ownership-type-company',
                    'ownership-type-mixed',
                    'ownership-type-individual'
                );

                // Determine the type for class assignment
                let typeForClass = null;
                if (ownershipTypeToUse && typeof ownershipTypeToUse === 'string') {
                    typeForClass = ownershipTypeToUse.trim();
                } else if (ownershipListToUse && ownershipListToUse.length > 0 && typeof getOwnershipTypeFn === 'function') {
                    const types = ownershipListToUse.map(owner => {
                        const ownerLabel = owner?.ownerLabel || owner?.name || owner?.possessorName || '';
                        if (!ownerLabel) return null;
                        return getOwnershipTypeFn(ownerLabel);
                    }).filter(Boolean);
                    const uniqueTypes = Array.from(new Set(types));
                    if (uniqueTypes.length === 1) {
                        typeForClass = uniqueTypes[0];
                    } else if (uniqueTypes.length > 1) {
                        typeForClass = 'mixed';
                    }
                }

                // Normalize and add class
                if (typeForClass) {
                    const normalizedType = typeForClass === 'private individual' ? 'individual' : typeForClass;
                    ownershipTypeLabelEl.classList.add(`ownership-type-${normalizedType}`);
                }
            } else {
                ownershipTypeLabelEl.style.display = 'none';
            }
        });

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
                const id = resolveParcelId(layer?.feature);
                return id !== undefined && id !== null && id.toString() === previouslySelectedId;
            });
            if (previousLayer) {
                const isRoad = (typeof global.isRoadParcel === 'function') ? global.isRoadParcel(previouslySelectedId) : false;
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

    function toggleAdActionsDialog(link) {
        const dialog = document.getElementById('parcel-ad-dialog');
        if (!dialog) return;
        const isVisible = dialog.style.display === 'flex';
        if (!isVisible) {
            if (link) {
                dialog.setAttribute('data-ad-link', link);
                const btn = dialog.querySelector('[data-i18n-key="panel.parcel.marketplace"]');
                if (btn) {
                    btn.setAttribute('onclick', `window.open('${link}', '_blank', 'noopener,noreferrer'); return false;`);
                }
            }
            dialog.style.display = 'flex';
        } else {
            dialog.style.display = 'none';
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
    if (!global.toggleAdActionsDialog) global.toggleAdActionsDialog = toggleAdActionsDialog;
})(typeof window !== 'undefined' ? window : globalThis);

