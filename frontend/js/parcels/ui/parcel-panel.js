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
        const id = typeof global.getParcelId === 'function'
            ? global.getParcelId(feature)
            : (props.parcelId ?? props.parcel_id ?? props.id);
        return id !== undefined && id !== null ? id.toString() : null;
    };

    const findParcelTabButton = (tabId) => global.document
        .querySelector(`#parcel-info-panel .parcel-tab-btn[data-parcel-tab-id="${tabId}"]`);

    const buildRawOwnershipList = (props) => {
        if (Array.isArray(props?.ownershipList) && props.ownershipList.length > 0) {
            return props.ownershipList;
        }

        if (!Array.isArray(props?.owners) || props.owners.length === 0) {
            return null;
        }

        return props.owners.map(owner => {
            const name = owner?.name || owner?.ownerLabel || owner?.possessorName || '';
            const share = owner?.actualShareText || owner?.ownership || owner?.shareText || owner?.share || '100%';
            return {
                ...owner,
                name,
                ownerLabel: owner?.ownerLabel || name,
                actualShareText: share,
                ownership: owner?.ownership || share,
                shareText: owner?.shareText || share
            };
        });
    };

    const deriveOwnershipTypeFromSummary = (summary) => {
        if (!summary || typeof summary !== 'object') return null;
        const activeTypes = ['government', 'institution', 'company'].filter(type => summary[type] === true);
        if (activeTypes.length === 1) return activeTypes[0];
        if (activeTypes.length > 1) return 'mixed';
        return null;
    };

    function bindParcelPanelControls() {
        const panel = global.document && global.document.getElementById('parcel-info-panel');
        if (!panel) return;

        const closeButton = panel.querySelector('.close-button');
        if (closeButton && closeButton.dataset.parcelPanelBound !== 'true') {
            closeButton.removeAttribute('onclick');
            closeButton.onclick = null;
            closeButton.addEventListener('click', function (event) {
                event.preventDefault();
                hideParcelInfoPanel();
            });
            closeButton.dataset.parcelPanelBound = 'true';
            // index.html ships an English aria-label; hand it to the i18n attribute pass so every
            // later language change re-translates it too.
            closeButton.setAttribute('data-i18n-key', 'panel.parcel.closeAria');
            closeButton.setAttribute('data-i18n-attr', 'aria-label,title');
            if (global.i18n && typeof global.i18n.applyTranslations === 'function') {
                global.i18n.applyTranslations(closeButton);
            }
        }

        const minimizeButton = panel.querySelector('#parcel-info-minimize');
        if (minimizeButton && minimizeButton.dataset.parcelPanelBound !== 'true') {
            minimizeButton.addEventListener('click', function (event) {
                event.preventDefault();
                setParcelInfoPanelMinimized(panel, !panel.classList.contains('is-minimized'));
            });
            minimizeButton.dataset.parcelPanelBound = 'true';
        }

        panel.querySelectorAll('.parcel-tab-btn[data-parcel-tab-id]').forEach(button => {
            const tabId = button.dataset.parcelTabId;
            if (button.dataset.parcelTabBound === 'true') {
                return;
            }
            button.removeAttribute('onclick');
            button.onclick = null;
            button.addEventListener('click', function (event) {
                event.preventDefault();
                if (typeof global.switchParcelTab === 'function') {
                    global.switchParcelTab(button, tabId);
                }
            });
            button.dataset.parcelTabBound = 'true';
        });
    }

    // Collapse the panel to its header: the tabs and the body fold away, the title stays. Used when
    // the panel is the SECONDARY surface — selecting a road opens the road's own parcel beneath the
    // proposal card without the parcel detail competing for the screen. Mirrors the proposal
    // details panel's own minimize (setProposalDetailsPanelMinimized).
    function setParcelInfoPanelMinimized(panel, minimized) {
        if (!panel) return;
        panel.classList.toggle('is-minimized', minimized);

        const body = panel.querySelector('.panel-body');
        if (body) body.hidden = minimized;
        const tabs = panel.querySelector('.parcel-tabs');
        if (tabs) tabs.hidden = minimized;

        const toggleButton = panel.querySelector('#parcel-info-minimize');
        if (toggleButton) {
            const label = minimized
                ? tParcel('sidebar.areaMonitor.expand', {}, 'Expand')
                : tParcel('sidebar.areaMonitor.minimize', {}, 'Minimize');
            toggleButton.setAttribute('aria-label', label);
            toggleButton.setAttribute('title', label);
            toggleButton.setAttribute('aria-expanded', minimized ? 'false' : 'true');
            toggleButton.innerHTML = minimized ? '+' : '&#8722;';
        }
    }

    // The Info tab's collapsed History section (proposals/parcel-history-card.js renderSection) for
    // the cadastral parcels this live parcel stands on, by the parcel menu's rule; none for open
    // ground or when the panel shows no single parcel (feature null).
    function renderParcelHistory(feature) {
        const host = global.document.getElementById('parcel-history-section');
        if (!host) return;
        let historyIds = [];
        if (feature) {
            const fabric = global.LiveParcelFabric;
            const parcelId = resolveParcelId(feature);
            const live = fabric && typeof fabric.get === 'function' ? (fabric.get(parcelId) || feature) : feature;
            historyIds = global.ParcelMenuModel.parcelHistoryIds({
                parcelId,
                cadastreIds: fabric && typeof fabric.explicitCadastreIds === 'function' ? fabric.explicitCadastreIds(live) : [],
                groundIds: fabric && typeof fabric.explicitGroundIds === 'function' ? fabric.explicitGroundIds(live) : []
            }).historyIds;
        }
        global.ProposalParcelHistoryCard.renderSection(host, { parcelIds: historyIds });
    }

    // The Proposals tab's count badge: the proposals listed there, hidden at zero.
    function setProposalsTabCount(count) {
        const badge = global.document.querySelector('#parcel-info-panel [data-parcel-tab-id="proposals-tab"] .parcel-tab-count');
        if (!badge) return;
        badge.textContent = count > 0 ? String(count) : '';
        badge.hidden = !(count > 0);
    }

    function showParcelInfoPanel(feature) {
        const panel = global.document.getElementById('parcel-info-panel');
        const refreshingHostedParcel = panel?.classList.contains('visible')
            && !!panel.closest?.('#click-stack')
            && resolveParcelId(feature) !== null
            && String(global.selectedParcelId ?? '') === resolveParcelId(feature);
        if (!global.ClickStack.isDriving() && !refreshingHostedParcel) {
            return global.ClickStack.showParcel(feature);
        }
        global.PlanningViews?.select(null);
        bindParcelPanelControls();
        renderParcelHistory(feature);
        const props = feature?.properties || {};
        const areaSource = props.calculatedArea
            || props.area
            || props.parcelArea
            || props.informationTechnical?.superficie_total;
        const area = Number.isFinite(Number(areaSource)) ? Number(areaSource) : 0;
        const formattedArea = area ? CbFormat.formatArea(area) : 'N/A';

        const estimate = global.ParcelPriceModel
            ? global.ParcelPriceModel.buildEstimate(props, area, global.CityMoney.currentLandPriceOptions('land'))
            : { amount: null, currency: null, basis: 'unavailable' };
        const formattedPrice = estimate.amount === null
            ? 'N/A'
            : CbFormat.formatMoney(estimate.amount, estimate.currency, { maxFractionDigits: 0 });

        const ownerLabel = tParcel('panel.parcel.metrics.owner', {}, 'Owner:');
        const shareLabel = tParcel('panel.parcel.metrics.share', {}, 'Share:');
        const ownersLabel = tParcel('panel.parcel.metrics.owners', {}, 'Owners:');
        const blockLabel = tParcel('panel.parcel.metrics.block', {}, 'Block:');
        const notPartOfBlockLabel = tParcel('panel.parcel.block.notPart', {}, 'Not part of a block');
        const areaLabel = tParcel('panel.parcel.metrics.area', {}, 'Area:');
        const marketPriceLabel = estimate.basis === 'area-model'
            ? tParcel('economicSources.modeled', { rate: CbFormat.formatMoney(estimate.rate, estimate.currency, { maxFractionDigits: 2 }) },
                `Modeled area estimate (${CbFormat.formatMoney(estimate.rate, estimate.currency, { maxFractionDigits: 2 })}/m²):`)
            : tParcel('panel.parcel.metrics.marketPrice', {}, 'Est. Mkt. Price:');
        const economicEvidence = global.EconomicSourceSettings?.describe(estimate.economicSource, global) || '';

        const normalizedParcelId = resolveParcelId(feature);
        const brojCestice = feature.properties.BROJ_CESTICE ?? feature.properties.broj_cestice;
        const maticniBrojKo = feature.properties.MATICNI_BROJ_KO ?? feature.properties.maticni_broj_ko ?? (feature.properties.cadastralMunicipality && feature.properties.cadastralMunicipality.id);
        let parcelId = normalizedParcelId;

        // The normalised id is the parcel's identity everywhere else (proposals, storage, fabric).
        // The cadastral number and KO only stand in for a feature that carries no id of its own.
        if (!parcelId && brojCestice !== undefined && brojCestice !== null && maticniBrojKo !== undefined && maticniBrojKo !== null) {
            const numberStr = String(brojCestice).trim();
            const municipalityStr = String(maticniBrojKo).trim();
            if (numberStr && municipalityStr) {
                parcelId = `HR-${municipalityStr}-${numberStr}`;
            }
        }
        const parcelKey = parcelId ? parcelId.toString() : '';
        const identityFeature = global.LiveParcelFabric?.peek?.(parcelKey) || feature;
        const identityProps = identityFeature.properties || {};
        const identityModel = global.ParcelMenuModel;
        const identityKind = identityModel.parcelIdentityKind(identityProps, parcelKey);
        const identityTitle = identityModel.parcelIdentityTitle(identityKind);
        const displayId = identityModel.displayParcelId(identityProps, parcelId);
        let identityNoteKey = '';
        let identityNoteFallback = '';
        if (identityKind === 'plotPiece') {
            identityNoteKey = 'panel.parcel.identity.plotNote';
            identityNoteFallback = 'Ground derived from one authored parcel-layout plot. Several live pieces can refer to the same plot.';
        } else if (identityKind === 'remainder') {
            identityNoteKey = 'panel.parcel.identity.remainderNote';
            identityNoteFallback = 'Ground left outside the authored plots by this parcel layout. It is kept separately from the plot outputs.';
        } else if (identityKind === 'formed') {
            identityNoteKey = 'panel.parcel.identity.formedNote';
            identityNoteFallback = 'Ground formed by the applied designs. This reference identifies the current piece, not a registered parcel or an authored plot.';
        } else if (identityKind === 'sourcePart') {
            identityNoteKey = 'panel.parcel.identity.sourcePartNote';
            identityNoteFallback = 'One connected part of a source parcel. This reference identifies the displayed part; the source parcel can contain other parts.';
        } else if (identityProps.parcelIdentityKind === 'geometry-sha256-v1' && identityProps.geometryDisplayId) {
            identityNoteKey = 'panel.parcel.geometryReferenceNote';
            identityNoteFallback = 'Application reference derived from geometry. Source registry number unavailable; boundary changes create a new reference.';
        }
        const identityNoteHtml = identityNoteKey
            ? `<div class="parcel-identity-note" role="note" data-i18n-key="${identityNoteKey}">${tParcel(identityNoteKey, {}, identityNoteFallback)}</div>`
            : '';
        const sourceReplaced = !global.LiveParcelFabric?.get?.(parcelKey)
            && (global.LiveParcelFabric?.entriesForCadastre?.([parcelKey]) || []).length > 0;
        const sourceNoteKey = 'panel.parcel.identity.originalBoundary';
        const sourceNoteHtml = sourceReplaced
            ? `<div class="parcel-identity-note" role="note" data-original-parcel-boundary data-i18n-key="${sourceNoteKey}">${tParcel(sourceNoteKey, {}, 'This is the original cadastral parcel. Applied designs have replaced it in the working map. Its original boundary is highlighted.')}</div>`
            : '';

        // Check if ownership data is already in feature properties (from backend)
        const simulatedOwnershipMode = !!global.gameState?.isRunning;
        const ownershipSupported = simulatedOwnershipMode
            || global.CityConfigManager?.getCurrentCityConfig?.()?.parcels?.ownership !== false;
        const rawOwnershipListFromProps = ownershipSupported ? buildRawOwnershipList(feature.properties) : null;
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

        const rawOwnershipType = feature.properties.ownershipType;
        const ownershipTypeFromProps = ownershipSupported
            ? (rawOwnershipType || deriveOwnershipTypeFromSummary(feature.properties.ownership_summary) || null)
            : null;

        const blockName = typeof global.parcelBlockNameForId === 'function'
            ? global.parcelBlockNameForId(parcelId)
            : null;
        const cityId = typeof global.getCurrentCityId === 'function' ? global.getCurrentCityId() : 'zagreb';
        const isBuenosAires = cityId === 'buenos_aires';

        // The block's name is a script link that shows the block on the map.
        let blockHtml;
        if (blockName) {
            const blockAction = isBuenosAires
                ? `selectBuenosAiresBlock(${inlineJsArg(parcelId)})`
                : `highlightAndCenterBlock(${inlineJsArg(blockName)})`;
            blockHtml = `<button type="button" class="cb-link block-tag" onclick="${blockAction}">${blockName}</button>`;
        } else {
            // The detect ACTION lives in the "Select multiple parcels" group at the top of the
            // tab (Detect block button); this row only reports block membership.
            blockHtml = `<span class="parcel-block-none" data-i18n-key="panel.parcel.block.notPart">${notPartOfBlockLabel}</span>`;
        }

        const storage = (typeof global.Proposals !== 'undefined' && global.Proposals.storage) ? global.Proposals.storage : global.proposalStorage;
        const allParcelProposals = storage && typeof storage.getProposalsForParcel === 'function'
            ? storage.getProposalsForParcel(parcelKey)
            : [];
        const parcelProposals = allParcelProposals.slice();
        // The live fabric is the only authority that projects this connected parcel back to
        // cadastral ground. proposalStorage performs the same flat projection when it builds the
        // list above; geometry intersections and child-id scans are deliberately not recovery paths.
        let parcelCadastreIds = [];
        try {
            const fabric = global.LiveParcelFabric;
            if (fabric && typeof fabric.explicitCadastreIds === 'function') {
                const liveFeature = typeof fabric.get === 'function'
                    ? (fabric.get(resolveParcelId(feature)) || feature)
                    : feature;
                parcelCadastreIds = fabric.explicitCadastreIds(liveFeature);
            }
        } catch (_) { }

        // The triaged dossier (rethink-proposals.md §10/§12 step 3): every listed proposal lands in
        // one consent channel for THIS parcel — acceptance (takes its ground), offer, vote, or
        // disclosure — plus the remainder report (what the owner keeps once the formations cut).
        // Read-only annotation over the list the panel already collected; failure costs the chips,
        // never the list.
        function cadastralBaseParcels(ids) {
            const repository = global.CadastralParcelRepository;
            if (!repository || typeof repository.peekMany !== 'function' || !ids.length) return [];
            return repository.peekMany(ids).map(cadastral => ({ id: String(cadastral.properties.parcelId), feature: cadastral }));
        }
        const parcelDossier = (() => {
            try {
                if (!global.__dossier || !parcelProposals.length) return null;
                const cadastralBase = cadastralBaseParcels(parcelCadastreIds);
                // The parcel's own outline for measuring takes: the cadastral record when the clicked
                // piece belongs to exactly one parcel; the live piece only when there is none.
                const parcelOutline = cadastralBase.length === 1
                    ? cadastralBase[0].feature
                    : ((feature && feature.geometry) ? feature : undefined);
                return global.__dossier.buildDossier(parcelId, parcelProposals, {
                    assumeMembership: true,
                    cadastreParcelIds: parcelCadastreIds,
                    // Unstamped records compute their take from the parcel's CADASTRAL ground (the
                    // repository record, not the clicked live piece, which an applied road has already
                    // cut — measuring against that makes the road's own take zero). Without it every
                    // formation reads "takes nothing" and triages as information, not consent.
                    baseParcels: cadastralBase,
                    isApplied: (typeof global.isProposalApplied === 'function') ? global.isProposalApplied : undefined,
                    parcelFeature: parcelOutline
                });
            } catch (error) {
                console.warn('[parcel-panel] dossier triage unavailable', error);
                return null;
            }
        })();
        const dossierEntryByPid = new Map(
            ((parcelDossier && parcelDossier.entries) || []).map(entry => [String(entry.proposalId), entry])
        );

        const shouldUseRealOwnersFn = ownershipUi.shouldUseRealParcelOwners
            || (global.Parcels && global.Parcels.ownership && global.Parcels.ownership.shouldUseRealParcelOwners)
            || global.shouldUseRealParcelOwners;
        const shouldFetchRealOwners = ownershipSupported && typeof shouldUseRealOwnersFn === 'function'
            ? shouldUseRealOwnersFn()
            : false;
        const unknownOwnershipType = typeof feature?.properties?.ownershipType === 'string'
            && ['unknown', 'unavailable', 'not available'].includes(feature.properties.ownershipType.trim().toLowerCase());
        const ownershipIsUnknown = !ownershipSupported
            || (unknownOwnershipType && !ownershipListFromProps && !shouldFetchRealOwners && !simulatedOwnershipMode);
        const unknownOwnerLabel = tParcel('common.unknownOwner', {}, 'Unknown owner');
        const unknownOwnerHtml = `<span data-i18n-key="common.unknownOwner">${unknownOwnerLabel}</span>`;
        const simulatedOwnerHtml = ownershipIsUnknown ? '' : buildSimulatedOwnerHtml(parcelId);
        const fallbackOwnerName = tParcel('panel.parcel.owner.single', {}, 'Single owner');
        const fallbackOwnerHtml = ownershipIsUnknown ? unknownOwnerHtml : (simulatedOwnerHtml || `
            <div class="owner-row parcel-owner-row">
                <span data-i18n-key="panel.parcel.owner.single">${fallbackOwnerName}</span>
                <span class="parcel-owner-share">100%</span>
            </div>
        `);
        let ownershipHtml = fallbackOwnerHtml;

        // If ownership data is available from feature properties, use it directly
        let initialOwnerCount = ownershipIsUnknown ? null : 1;
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
                    // Handle percentageShare if actualShareText is not available. Route through the
                    // shared formatter — the old inline copy stripped zeros from whole numbers too,
                    // so 100 rendered as "1%".
                    if (!share && Number.isFinite(owner.percentageShare)) {
                        share = (typeof global.formatPercentValue === 'function')
                            ? global.formatPercentValue(owner.percentageShare)
                            : `${owner.percentageShare}%`;
                    }
                    share = share || '100%';
                    const safeName = typeof global.escapeHtml === 'function' ? global.escapeHtml(name) : name;
                    const safeShare = typeof global.escapeHtml === 'function' ? global.escapeHtml(share) : share;
                    return `
                        <div class="owner-row parcel-owner-row">
                            <span>${safeName}</span>
                            <span class="parcel-owner-share">${safeShare}</span>
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
            ownershipHtml = `<span class="owner-loading" data-i18n-key="panel.parcel.owner.loading">${tParcel('panel.parcel.owner.loading', {}, 'Loading real ownership data...')}</span>`;
        }

        let proposalsHtml = tParcel('panel.parcel.proposalsSection.empty', {}, 'No designs');
        const proposalFallbackTitle = tParcel('panel.parcel.proposalsSection.fallbackTitle', {}, 'Design');
        const proposalRoadSuffix = tParcel('panel.parcel.proposalsSection.roadSuffix', {}, ' (Road)');
        const proposalIdLabel = tParcel('panel.parcel.proposalsSection.details.id', {}, 'ID:');
        const proposalAuthorLabel = tParcel('panel.parcel.proposalsSection.details.author', {}, 'Author:');
        const proposalUnknownAuthor = tParcel('panel.parcel.proposalsSection.details.unknownAuthor', {}, 'Unknown');

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
                const mapApplied = (typeof global.isProposalApplied === 'function') ? global.isProposalApplied(proposal) : false;

                // One-hop output provenance: which proposal produced this disposable live piece.
                // It is presentation metadata, not a proposal dependency or ancestry edge.
                const isParcelProducer = parcelProposals.length > 1 && (
                    String(feature?.properties?.producedByProposalId || '') === String(proposal.proposalId)
                );
                const producerPill = isParcelProducer
                    ? `<span class="cb-badge proposal-item-producer-pill" data-i18n-key="panel.parcel.proposalsSection.producerPill">${tParcel('panel.parcel.proposalsSection.producerPill', {}, 'Parcel source')}</span>`
                    : '';

                // The consent channel this proposal lands in for THIS parcel (§10), plus what its
                // formation takes when it takes anything. A cb-badge whose tone says how much it asks
                // of the owner: acceptance (their signature) is the loud one.
                const dossierEntry = dossierEntryByPid.get(String(proposal.proposalId)) || null;
                const channelChip = dossierEntry ? (() => {
                    const labels = {
                        acceptance: tParcel('panel.parcel.dossier.channel.acceptance', {}, 'Consent needed'),
                        offer: tParcel('panel.parcel.dossier.channel.offer', {}, 'Offer to you'),
                        vote: tParcel('panel.parcel.dossier.channel.vote', {}, 'Vote'),
                        disclosure: tParcel('panel.parcel.dossier.channel.disclosure', {}, 'Info')
                    };
                    const tones = { acceptance: ' cb-badge--expired', offer: ' cb-badge--applied', vote: ' cb-badge--published', disclosure: '' };
                    const label = labels[dossierEntry.channel];
                    return label ? `<span class="cb-badge${tones[dossierEntry.channel]} proposal-item-channel" data-channel="${dossierEntry.channel}">${label}</span>` : '';
                })() : '';
                const takesLine = (dossierEntry && dossierEntry.channel === 'acceptance' && dossierEntry.cededM2 > 0) ? (() => {
                    const destinations = {
                        'public': tParcel('panel.parcel.dossier.destination.public', {}, 'public'),
                        'proposer': tParcel('panel.parcel.dossier.destination.proposer', {}, 'the proposer'),
                        'carry-over': tParcel('panel.parcel.dossier.destination.carryOver', {}, 'stays with its owners')
                    };
                    const destination = destinations[dossierEntry.destination] || dossierEntry.destination || '';
                    return `<div class="proposal-item-details proposal-item-takes">${tParcel('panel.parcel.dossier.takes', {
                        area: CbFormat.formatNumber(dossierEntry.cededM2),
                        destination
                    }, 'Takes {{area}} m² of this parcel → {{destination}}')}</div>`;
                })() : '';

                const proposalTypeKey = (typeof global.getProposalDisplayType === 'function') ? global.getProposalDisplayType(proposal) : (goalKey || 'other');
                const proposalTypeLabel = tParcel(
                    `modal.roadWidth.proposalList.typeLabels.${proposalTypeKey}`,
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

                const thumbHtml = (typeof global.buildProposalThumbHtml === 'function')
                    ? global.buildProposalThumbHtml(proposal)
                    : '';
                const proposalBody = `
                    <div class="proposal-item-body">
                        <div class="proposal-item-header">
                            <span class="proposal-item-title">${proposalTitle}${roadSuffix}</span>
                            <div class="proposal-item-badges">
                                ${producerPill}
                                ${channelChip}
                                ${global.proposalLadderBadgesHtml(proposal, { applied: mapApplied })}
                            </div>
                        </div>
                        ${takesLine}
                        <div class="proposal-item-details">
                            ${proposalIdText}
                        </div>
                        <div class="proposal-item-details">
                            <span class="proposal-item-label" data-i18n-key="panel.parcel.proposalsSection.details.author">${proposalAuthorLabel}</span> <span class="proposal-author-value">${authorValue}</span>
                        </div>
                    </div>
                `;
                return `
                    <div class="proposal-item" data-proposal-id="${escapeHtml(String(proposal.proposalId))}" onclick="showProposalDetails(${inlineJsArg(proposal.proposalId)}, ${inlineJsArg(parcelId)})">
                        ${thumbHtml ? `<div class="proposal-item-row">${thumbHtml}${proposalBody}</div>` : proposalBody}
                    </div>
                `;
            }).join('');

            // The remainder report (§3.8 as disclosure, per the 2026-08 decision: remainders stay
            // with the owner): what this parcel cedes to the listed formations and what is left,
            // piece by piece — the fragmentation is the fact an owner most needs before consenting.
            const remainderNote = (parcelDossier && parcelDossier.remainder && parcelDossier.remainder.takenM2 > 0) ? (() => {
                const r = parcelDossier.remainder;
                const pieces = r.pieces.map(p => CbFormat.formatNumber(p.areaM2)).join(' / ');
                const text = r.pieces.length > 1
                    ? tParcel('panel.parcel.dossier.remainderSplit', {
                        taken: CbFormat.formatNumber(r.takenM2),
                        kept: CbFormat.formatNumber(r.remainderM2),
                        count: r.pieces.length,
                        pieces
                    }, 'Proposed formations take {{taken}} m²; you keep {{kept}} m² in {{count}} separate pieces ({{pieces}} m²).')
                    : tParcel('panel.parcel.dossier.remainder', {
                        taken: CbFormat.formatNumber(r.takenM2),
                        kept: CbFormat.formatNumber(r.remainderM2)
                    }, 'Proposed formations take {{taken}} m²; you keep {{kept}} m².');
                return `<div class="parcel-dossier-remainder${r.pieces.length > 1 ? ' fragmented' : ''}">${text}</div>`;
            })() : '';

            proposalsHtml = `
            ${remainderNote}
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
            <button type="button" class="btn btn-success btn-sm parcel-ad-link-btn"
                onclick="(window.toggleAdActionsDialog || function(){} )('${adLink}'); return false;"
                data-i18n-key="panel.parcel.forSale">
                ${tParcel('panel.parcel.forSale', {}, 'For sale')}
            </button>
        ` : '';

        // Determine ownership type for display - will be updated when owners are fetched
        const ownershipTypeLabel = '<span class="parcel-ownership-type-label" style="display: none;"></span>';

        const infoContent = `
        ${sourceNoteHtml}
        <div class="parcel-owner-section">
            <div class="parcel-owner-header">
                <div class="parcel-owner-header-label" data-i18n-key="panel.parcel.metrics.owner">${ownerLabel}</div>
                ${ownershipTypeLabel}
                ${adButtonHtml}
                ${ownershipIsUnknown ? '' : `<div class="parcel-owner-header-label parcel-owner-header-share" data-i18n-key="panel.parcel.metrics.share">${shareLabel}</div>`}
            </div>
            ${adLink ? `
            <div class="parcel-ad-dialog" id="parcel-ad-dialog" data-ad-link="${adLink}" style="display:none;">
                <button type="button" class="btn btn-sm"
                    onclick="window.open(${inlineJsArg(adLink)}, '_blank', 'noopener,noreferrer'); return false;">
                    <i class="fas fa-cart-shopping" aria-hidden="true"></i>
                    <span data-i18n-key="panel.parcel.marketplace">${tParcel('panel.parcel.marketplace', {}, 'Marketplace')}</span>
                </button>
                <button type="button" class="btn btn-sm"
                    onclick="(window.Parcels?.uiClaim?.openParcelBuilder || window.openParcelBuilder || function(){})(); return false;">
                    <i class="fas fa-trowel-bricks" aria-hidden="true"></i>
                    <span data-i18n-key="panel.parcel.builderButton">${tParcel('panel.parcel.builderButton', {}, 'Parcel builder')}</span>
                </button>
            </div>
            ` : ''}
            <div class="parcel-owners-container" id="${PARCEL_OWNER_VALUE_ELEMENT_ID}">${ownershipHtml}</div>
        </div>
        ${identityNoteHtml}
        <div class="parcel-metric-row">
            <div class="metric-group">
                <div class="metric-label" data-i18n-key="panel.parcel.metrics.owners">${ownersLabel}</div>
                <div class="metric-value" id="parcel-owners-count">-</div>
            </div>
            <div class="metric-group">
                <div class="metric-label" data-i18n-key="panel.parcel.metrics.block">${blockLabel}</div>
                <div class="metric-value">${blockHtml}</div>
            </div>
        </div>
        <div class="parcel-metric-row">
            <div class="metric-group">
                <div class="metric-label" data-i18n-key="panel.parcel.metrics.area">${areaLabel}</div>
                <div class="metric-value">${formattedArea}</div>
            </div>
            <div class="metric-group">
                <div class="metric-label">${marketPriceLabel}</div>
                <div class="metric-value" title="${escapeHtml(economicEvidence)}">${formattedPrice}</div>
            </div>
        </div>
        ${(typeof ensNameLineHtml === 'function' && parcelId) ? ensNameLineHtml(parcelEnsName(parcelId)) : ''}
        <div id="roadMeasurements" style="display: none;">
        </div>
    `;

        const proposeContent = `
        <div id="parcel-proposal-actions" class="parcel-proposal-actions">
            <div id="parcel-proposal-primary-actions"></div>
        </div>
    `;
        // With nothing here yet, the empty list points to the Propose tab instead of a blank page.
        const proposalsEmptyHtml = `
        <div class="parcel-proposals-empty">
            <p data-i18n-key="panel.parcel.proposalsSection.empty">${tParcel('panel.parcel.proposalsSection.empty', {}, 'No designs on this parcel yet.')}</p>
            <button type="button" class="btn btn-primary btn-sm parcel-proposals-empty-btn" data-i18n-key="parcelMenu.actions.propose"
                onclick="(window.switchParcelTab || function(){})(null, 'propose-tab')">${tParcel('parcelMenu.actions.propose', {}, 'Propose here')}</button>
        </div>
    `;
        // The published proposals this browser holds no copy of are asked from the server and added
        // under the list (ParcelSetProposals.renderPublishedOnly), with the tab's count.
        const proposalsContent = `
        ${parcelProposals.length > 0 ? proposalsHtml : proposalsEmptyHtml}
        <div class="parcel-published-proposals"></div>
    `;

        const titleElement = global.document.getElementById('parcel-info-title');
        if (titleElement) {
            const broj = brojCestice;
            const displayParcelId = parcelId;
            const brojValue = broj ? broj.toString() : '';
            const fallbackTitle = tParcel('panel.parcel.title', {}, 'Parcel Info');

            titleElement.removeAttribute('data-i18n-key');
            titleElement.removeAttribute('data-i18n-params');

            const resolvedId = displayId || displayParcelId || brojValue;
            titleElement.textContent = '';
            // A piece on open ground (PARCEL-OPTIONAL.md phase 3) is no cadastral parcel: its id is a
            // proposal-local name, so the title uses its explicit plot role or says "Open ground".
            let groundPiece = false;
            try {
                groundPiece = !!(global.__openGround && global.__openGround.isGroundPiece(identityFeature));
            } catch (_) { groundPiece = false; }
            if (groundPiece && identityKind !== 'plotPiece') {
                titleElement.textContent = tParcel('parcelMenu.groundTitle', {}, 'Open ground');
            } else if (resolvedId) {
                const numberMarker = '__PARCEL_NUMBER__';
                const headerTemplate = tParcel(
                    identityTitle.key,
                    { number: numberMarker },
                    identityTitle.fallback
                ).replace('{{number}}', numberMarker);
                const markerIndex = headerTemplate.indexOf(numberMarker);
                const prefix = markerIndex >= 0 ? headerTemplate.slice(0, markerIndex) : `${headerTemplate} `;
                const suffix = markerIndex >= 0 ? headerTemplate.slice(markerIndex + numberMarker.length) : '';
                const copyHintKey = 'common.copyToClipboard';
                const copyHint = tParcel(copyHintKey, {}, 'Copy to clipboard');

                titleElement.appendChild(global.document.createTextNode(prefix));
                const copyTarget = global.document.createElement('span');
                copyTarget.className = 'parcel-title-id';
                copyTarget.tabIndex = 0;
                copyTarget.setAttribute('role', 'button');
                copyTarget.setAttribute('aria-label', `${copyHint}: ${resolvedId}`);
                copyTarget.title = copyHint;

                const valueElement = global.document.createElement('span');
                valueElement.className = 'parcel-title-id-value';
                valueElement.textContent = resolvedId;
                copyTarget.appendChild(valueElement);

                const copyParcelId = () => {
                    if (typeof global.copyTextWithFeedback === 'function') {
                        global.copyTextWithFeedback(resolvedId);
                    }
                };
                copyTarget.addEventListener('click', copyParcelId);
                copyTarget.addEventListener('keydown', event => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    copyParcelId();
                });
                titleElement.appendChild(copyTarget);
                if (suffix) titleElement.appendChild(global.document.createTextNode(suffix));
            } else {
                titleElement.textContent = fallbackTitle;
            }
        }

        global.document.getElementById('info-content').innerHTML = infoContent;
        global.PlanningViews?.showParcelEvidence(global.document.getElementById('info-content'), parcelId);

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
                ownersCountElement.textContent = initialOwnerCount === null
                    ? tParcel('common.unknown', {}, 'Unknown')
                    : initialOwnerCount.toString();
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
            if (!ownershipSupported) {
                ownershipTypeLabelEl.style.display = 'none';
                return;
            }

            let typeLabel = '';

            // Re-check feature properties directly in case variables weren't set correctly
            const directOwnershipType = ownershipSupported ? feature?.properties?.ownershipType : null;
            const directOwnershipList = ownershipSupported && Array.isArray(feature?.properties?.ownershipList)
                ? feature.properties.ownershipList : null;

            // First priority: use ownershipType directly from feature properties (from backend)
            const ownershipTypeToUse = ownershipTypeFromProps || directOwnershipType;
            if (ownershipTypeToUse && typeof ownershipTypeToUse === 'string') {
                const type = ownershipTypeToUse.trim();
                if (type && !['unknown', 'unavailable', 'not available'].includes(type.toLowerCase())) {
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
        global.document.getElementById('propose-content').innerHTML = proposeContent;
        global.document.getElementById('proposals-content').innerHTML = proposalsContent;
        // Tick boxes + Compare on the listed proposals (proposals/parcel-compare-ui.js).
        if (global.ParcelCompare) global.ParcelCompare.decoratePanelList(global.document.getElementById('proposals-content'), parcelId);
        // The tab count updates ONLY after the list content is in the DOM — updating it earlier
        // let a mid-render exception show "Proposals (1)" over a stale/empty list.
        setProposalsTabCount(parcelProposals.length);
        global.ParcelSetProposals.renderPublishedOnly(
            global.document.querySelector('#proposals-content .parcel-published-proposals'), parcelKey, {
                emptyNote: global.document.querySelector('#proposals-content .parcel-proposals-empty'),
                onCount: published => setProposalsTabCount(parcelProposals.length + published)
            });
        const renderParcelProposalActions = uiProposals.renderParcelProposalActions || global.renderParcelProposalActions;
        if (typeof renderParcelProposalActions === 'function') {
            renderParcelProposalActions(parcelId);
        }

        applyParcelTranslations(global.document.getElementById('parcel-info-panel'));

        const panelEl = global.document.getElementById('parcel-info-panel');
        setParcelInfoPanelMinimized(panelEl, false);
        panelEl.classList.add('visible');

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
        if (toolsTabContent && !toolsTabContent.hidden && typeof global.triggerParcelToolsTabActivated === 'function') {
            global.triggerParcelToolsTabActivated();
        }

        if (typeof global.multiParcelSelection !== 'undefined' && global.multiParcelSelection.isActive) {
            const activeTab = panelEl.querySelector('.parcel-tab-btn[aria-selected="true"]')?.dataset.parcelTabId || 'propose-tab';
            global.switchParcelTab(findParcelTabButton(activeTab), activeTab);
        }

        resetMeasureAsRoadButton();
    }

    function resetMeasureAsRoadButton() {
        const button = global.document.getElementById('measureAsRoadButton');
        const measurementsDiv = global.document.getElementById('roadMeasurements');

        if (button) {
            // The Tools tab's icon + label (index.html); measuring writes its progress over them.
            button.innerHTML = `<i class="fas fa-ruler" aria-hidden="true"></i><span data-i18n-key="panel.parcel.actions.measureAsRoad">${tParcel('panel.parcel.actions.measureAsRoad', {}, 'Measure as road')}</span>`;
            button.disabled = false;
        }

        if (measurementsDiv) {
            measurementsDiv.style.display = 'none';
            measurementsDiv.innerHTML = '';
        }
    }

    function hideParcelInfoPanel({ preserveProposalSelection = false } = {}) {
        const parcelInfoPanel = global.document.getElementById('parcel-info-panel');
        if (parcelInfoPanel) parcelInfoPanel.classList.remove('visible');
        renderParcelHistory(null);
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
        } else if (previouslySelectedId && global.LiveParcelFabric?.get?.(previouslySelectedId)) {
            const previousLayer = global.ParcelPresenter?.getLayer?.(previouslySelectedId) || null;
            if (previousLayer) {
                const isRoad = (typeof global.isRoadParcel === 'function') ? global.isRoadParcel(previouslySelectedId) : false;
                previousLayer.setStyle(global.getParcelBaseStyle(previouslySelectedId, { isRoad }));
            }
        }

        try { if (typeof global.clearProposalInfoHoverOverlay === 'function') global.clearProposalInfoHoverOverlay(); } catch (_) { }
        try { if (!preserveProposalSelection && typeof global.clearProposalHighlights === 'function') global.clearProposalHighlights(); } catch (_) { }


        if (typeof global.neighborHighlightActive !== 'undefined' && global.neighborHighlightActive) {
            global.neighborHighlightActive = false;
            const neighborBtn = global.document.getElementById('neighboursButton');
            if (neighborBtn) neighborBtn.setAttribute('aria-pressed', 'false');
            if (typeof global.clearHighlightedNeighbors === 'function') {
                global.clearHighlightedNeighbors();
            }
        }
        if (typeof global.verticesDisplayActive !== 'undefined' && global.verticesDisplayActive) {
            global.verticesDisplayActive = false;
            const verticesBtn = global.document.getElementById('verticesButton');
            if (verticesBtn) verticesBtn.setAttribute('aria-pressed', 'false');
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
                const btn = dialog.querySelector('[data-i18n-key="panel.parcel.marketplace"]')?.closest('button');
                if (btn) {
                    btn.onclick = () => {
                        global.open(link, '_blank', 'noopener,noreferrer');
                        return false;
                    };
                }
            }
            dialog.style.display = 'flex';
        } else {
            dialog.style.display = 'none';
        }
    }

    global.ParcelsUIParcelPanel = {
        showParcelInfoPanel,
        renderParcelHistory,
        setProposalsTabCount,
        resetMeasureAsRoadButton,
        hideParcelInfoPanel,
        setParcelInfoPanelMinimized
    };

    if (!global.showParcelInfoPanel) global.showParcelInfoPanel = showParcelInfoPanel;
    if (!global.resetMeasureAsRoadButton) global.resetMeasureAsRoadButton = resetMeasureAsRoadButton;
    if (!global.hideParcelInfoPanel) global.hideParcelInfoPanel = hideParcelInfoPanel;
    if (!global.toggleAdActionsDialog) global.toggleAdActionsDialog = toggleAdActionsDialog;
    bindParcelPanelControls();
})(typeof window !== 'undefined' ? window : globalThis);
