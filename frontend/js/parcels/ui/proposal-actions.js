(function (global) {
    'use strict';

    const tParcel = (key, params = {}, fallback = '') => {
        if (typeof global.tParcel === 'function') {
            return global.tParcel(key, params, fallback);
        }
        try {
            const api = global.i18n;
            if (api && typeof api.t === 'function') {
                const translated = api.t(key, params || {});
                if (translated !== undefined && translated !== null) {
                    return translated;
                }
            }
        } catch (_) { }
        return fallback || key || '';
    };

    function createProposalFromSingleParcel() {
        // Gate: require personalized profile to create proposals
        if (typeof global.requirePersonalizedUser === 'function' && global.requirePersonalizedUser()) {
            return;
        }

        if (!global.currentParcel || !global.currentParcel.layer) {
            if (typeof global.updateStatus === 'function') {
                global.updateStatus(tParcel('panel.parcel.build.noParcelSelected', {}, 'No parcel selected. Please select a parcel first.'));
            }
            return;
        }
        if (typeof global.multiParcelSelection !== 'undefined') {
            if (!global.multiParcelSelection.isActive) {
                global.multiParcelSelection.selectedParcels.clear();
                global.multiParcelSelection.selectedParcels.add(global.currentParcel.id);
                if (typeof global.showProposalDialog === 'function') {
                    // Offer negotiates ownership only — building/land-use/parcel changes have
                    // their own palette tools.
                    global.showProposalDialog({ ownershipOnly: true });
                }
            } else {
                console.warn('createProposalFromSingleParcel called while multi-select is active - this should not happen');
                if (typeof global.updateStatus === 'function') {
                    global.updateStatus(tParcel('panel.parcel.build.useMainCreateButton', {}, 'Please use the main "Create Proposal" button when multiple parcels are selected.'));
                }
            }
        }
    }

    function createProposalFromSelectedParcels() {
        // Gate: require personalized profile to create proposals
        if (typeof global.requirePersonalizedUser === 'function' && global.requirePersonalizedUser()) {
            return;
        }

        if (typeof global.multiParcelSelection === 'undefined' || !global.multiParcelSelection || !global.multiParcelSelection.isActive) {
            if (typeof global.updateStatus === 'function') {
                global.updateStatus(tParcel('panel.parcel.build.enableMultiSelect', {}, 'Enable multi-parcel selection to use this action.'));
            }
            return;
        }

        const hasSelection = global.multiParcelSelection.selectedParcels && global.multiParcelSelection.selectedParcels.size > 0;
        if (!hasSelection) {
            if (typeof global.updateStatus === 'function') {
                global.updateStatus(tParcel('panel.parcel.build.selectAtLeastOne', {}, 'Select at least one parcel to create a proposal.'));
            }
            return;
        }

        if (typeof global.showProposalDialog === 'function') {
            global.showProposalDialog({ ownershipOnly: true });
        }
    }

    // The Build palette: everything creatable on the current parcel(s), each button jumping
    // straight into that type's design tool (SimCity: draw first, propose later). Building
    // typologies and reparcellization open their design tools; park/square/lake are one click.
    const PARCEL_BUILD_TOOLS = [
        { key: 'buildings', icon: 'fa-city', labelKey: 'panel.parcel.build.block', fallback: 'Block' },
        { key: 'row', icon: 'fa-grip-horizontal', labelKey: 'panel.parcel.build.row', fallback: 'Row houses' },
        { key: 'parcelBased', icon: 'fa-home', labelKey: 'panel.parcel.build.parcelBased', fallback: 'Detached' },
        { key: 'single', icon: 'fa-ruler-combined', labelKey: 'panel.parcel.build.single', fallback: 'Freeform' },
        { key: 'reparcellization', icon: 'fa-vector-square', labelKey: 'panel.parcel.build.reparcel', fallback: 'Reparcel' },
        { key: 'park', icon: 'fa-tree', labelKey: 'panel.parcel.build.park', fallback: 'Park' },
        { key: 'square', icon: 'fa-chess-board', labelKey: 'panel.parcel.build.square', fallback: 'Square' },
        { key: 'lake', icon: 'fa-water', labelKey: 'panel.parcel.build.lake', fallback: 'Lake' }
    ];

    // Terms-first proposals change rights rather than the map. Keep them visually and
    // conceptually separate from both construction and transport tools.
    const PARCEL_OWNERSHIP_TOOLS = [
        { key: 'offer', icon: 'fa-handshake', labelKey: 'panel.parcel.build.offer', fallback: 'Offer' }
    ];

    // Corridors and stops are all transport-network proposals. Keep them together at the end of
    // the parcel palette instead of presenting Road/Track as unrelated full-width form buttons.
    const PARCEL_TRANSPORT_TOOLS = [
        {
            key: 'road', icon: 'fa-road', labelKey: 'panel.parcel.build.road', fallback: 'Road',
            titleKey: 'sidebar.roads.drawManualTooltip', titleFallback: 'Open the manual road drawing tool'
        },
        {
            key: 'track', icon: 'fa-train', labelKey: 'panel.parcel.build.track', fallback: 'Track',
            titleKey: 'sidebar.roads.drawTrackTooltip', titleFallback: 'Open the manual track drawing tool with curvature constraints'
        },
        {
            key: 'bus', stationType: 'bus', icon: 'fa-bus', labelKey: 'panel.parcel.build.busStation', fallback: 'Bus station',
            titleKey: 'sidebar.stations.bus', titleFallback: 'Bus station'
        },
        {
            key: 'tram', stationType: 'tram', icon: 'fa-tram', labelKey: 'panel.parcel.build.tramStation', fallback: 'Tram station',
            titleKey: 'sidebar.stations.tram', titleFallback: 'Tram station'
        },
        {
            key: 'underground', stationType: 'underground', icon: 'fa-train-subway',
            labelKey: 'panel.parcel.build.undergroundStation', fallback: 'Metro station',
            titleKey: 'sidebar.stations.underground', titleFallback: 'Underground station'
        },
        {
            key: 'elevated', stationType: 'elevated', icon: 'fa-train',
            labelKey: 'panel.parcel.build.elevatedStation', fallback: 'Elevated station',
            titleKey: 'sidebar.stations.elevated', titleFallback: 'Elevated train station'
        }
    ];

    function roadToolsEnabled() {
        return (typeof global.CityConfigManager !== 'undefined'
            && typeof global.CityConfigManager.isFeatureEnabled === 'function')
            ? global.CityConfigManager.isFeatureEnabled('roadTools')
            : true;
    }

    function startParcelTransportTool(toolKey) {
        const key = String(toolKey || '').trim().toLowerCase();
        if (key === 'road') {
            global.requestRoadDrawTool?.();
            return;
        }
        if (key === 'track') {
            global.requestTrackDrawTool?.();
            return;
        }
        const stationType = PARCEL_TRANSPORT_TOOLS.find(tool => tool.stationType === key)?.stationType;
        if (stationType) global.startTransitStationPlacement?.(stationType);
    }

    function parcelBuildSelectionIds() {
        const multi = global.multiParcelSelection;
        if (multi && multi.isActive && multi.selectedParcels && multi.selectedParcels.size > 0) {
            return [...multi.selectedParcels].map(String);
        }
        return global.currentParcel && global.currentParcel.id ? [String(global.currentParcel.id)] : [];
    }

    // One policy for every FRESH parcel-based design. Terms-only offers and corridors target the
    // exact parcel(s) selected, while these land/building tools commonly operate on a whole block.
    const WHOLE_BLOCK_FRESH_PROPOSAL_GOALS = new Set([
        'buildings', 'block', 'row', 'parcelbased', 'single', 'reparcellization',
        'park', 'square', 'lake', 'urban-rule'
    ]);

    function shouldSuggestWholeBlockForFreshProposal(goal) {
        const key = String(goal || '').trim().toLowerCase();
        return WHOLE_BLOCK_FRESH_PROPOSAL_GOALS.has(key);
    }

    // Single parcel selected but it sits in a multi-parcel block: the user may simply have
    // forgotten to select the block first. Offer to do it for them — Yes selects the whole
    // block (and lands on the Proposals tab, tool NOT auto-launched); No proceeds one-parcel.
    // Returns true when the tool launch should stop here.
    async function maybeSuggestWholeBlockForFreshProposal(goal, ids = []) {
        if (!shouldSuggestWholeBlockForFreshProposal(goal) || ids.length !== 1) return false;
        if (typeof global.detectBlockParcelIdsForParcel !== 'function') return false;
        const block = global.detectBlockParcelIdsForParcel(ids[0]);
        // The count belongs in the question, not in a hidden policy gate. A large block is still
        // a block, and silently skipping the question made Detached behave differently depending
        // on where in the city it was launched.
        if (!block || block.count <= 1) return false;
        if (typeof global.showStyledConfirm !== 'function') return false;
        const message = tParcel('panel.parcel.suggestWholeBlock', { count: block.count },
            `Only one parcel is selected. Did you mean the whole block (${block.count} parcels)?`);
        const wantsBlock = await global.showStyledConfirm(message, {
            okText: tParcel('panel.parcel.suggestWholeBlockYes', {}, 'Yes, select the block'),
            cancelText: tParcel('panel.parcel.suggestWholeBlockNo', {}, 'No, just this parcel')
        });
        if (!wantsBlock) return false;
        try { await Promise.resolve(global.animateFloodfillFromSelected?.()); } catch (error) {
            console.warn('[buildPalette] block selection failed', error);
        }
        try {
            document.querySelector('.parcel-tab-btn[data-i18n-key="panel.parcel.tabProposals"]')?.click();
        } catch (_) { }
        return true;
    }

    async function startParcelBuildTool(toolKey) {
        const ids = parcelBuildSelectionIds();
        if (!ids.length) {
            if (typeof global.updateStatus === 'function') {
                global.updateStatus(tParcel('panel.parcel.build.selectParcelFirst', {}, 'Select a parcel first.'));
            }
            return;
        }
        // The shared policy decides which fresh proposal types have block semantics. Run it before
        // per-tool guards (a row on one parcel is exactly where selecting the block solves it).
        if (await maybeSuggestWholeBlockForFreshProposal(toolKey, ids)) return;
        // A row dictates form across parcels — on a single parcel it degenerates to a building.
        if (toolKey === 'row' && ids.length < 2) {
            const message = tParcel('panel.parcel.build.rowNeedsTwo', {}, 'Row houses need at least two parcels.');
            if (typeof global.showEphemeralMessage === 'function') global.showEphemeralMessage(message, 4000, 'info');
            else if (typeof global.updateStatus === 'function') global.updateStatus(message);
            return;
        }
        if (toolKey === 'offer') {
            const multi = global.multiParcelSelection;
            if (multi && multi.isActive) createProposalFromSelectedParcels();
            else createProposalFromSingleParcel();
            return;
        }
        if (['park', 'square', 'lake'].includes(toolKey)) {
            Promise.resolve(global.instantCreateStructureFromSelection?.(toolKey, ids))
                .catch(error => console.warn('[buildPalette] structure creation failed', error));
        } else {
            Promise.resolve(global.startInstantProposalDesign?.(toolKey, ids))
                .catch(error => console.warn('[buildPalette] design tool failed to open', error));
        }
    }

    function buildPaletteHtml() {
        const buttonHtml = tool => `
            <button type="button" class="parcel-build-btn parcel-build-btn--${tool.key}" onclick="startParcelBuildTool('${tool.key}')"
                title="${tParcel(tool.labelKey, {}, tool.fallback)}">
                <i class="fas ${tool.icon}"></i>
                <span>${tParcel(tool.labelKey, {}, tool.fallback)}</span>
            </button>
        `;
        // Block, Row and Detached are all RULES-based tools (form follows parameters); one
        // thin frame groups them so the seam against the free-design tools reads at a glance.
        const RULE_KEYS = ['buildings', 'row', 'parcelBased'];
        const ruleButtons = PARCEL_BUILD_TOOLS.filter(tool => RULE_KEYS.includes(tool.key)).map(buttonHtml).join('');
        const otherButtons = PARCEL_BUILD_TOOLS.filter(tool => !RULE_KEYS.includes(tool.key)).map(buttonHtml).join('');
        const ownershipButtons = PARCEL_OWNERSHIP_TOOLS.map(buttonHtml).join('');
        const transportButtons = PARCEL_TRANSPORT_TOOLS
            .filter(tool => tool.stationType || roadToolsEnabled())
            .map(tool => {
                const label = tParcel(tool.labelKey, {}, tool.fallback);
                const title = tParcel(tool.titleKey, {}, tool.titleFallback);
                const stationAttribute = tool.stationType ? ` data-station-type="${tool.stationType}"` : '';
                return `
                    <button type="button" class="parcel-build-btn parcel-transport-btn parcel-transport-btn--${tool.key}"
                        onclick="startParcelTransportTool('${tool.key}')"${stationAttribute}
                        title="${title}" aria-label="${title}">
                        <i class="fas ${tool.icon}" aria-hidden="true"></i>
                        <span>${label}</span>
                    </button>
                `;
            }).join('');
        const transportTitle = tParcel('panel.parcel.build.transport', {}, 'Transport');
        const ownershipTitle = tParcel('panel.parcel.build.ownershipCategory', {}, 'Ownership');
        return `
            <div class="parcel-build-palette">
                <div class="parcel-build-grid">
                    <div class="parcel-build-rules-group">${ruleButtons}</div>
                    ${otherButtons}
                    <fieldset class="parcel-transport-group">
                        <legend>${transportTitle}</legend>
                        <div class="parcel-transport-grid">${transportButtons}</div>
                    </fieldset>
                    <fieldset class="parcel-ownership-group">
                        <legend>${ownershipTitle}</legend>
                        <div class="parcel-ownership-grid">${ownershipButtons}</div>
                    </fieldset>
                </div>
            </div>
        `;
    }

    function renderParcelProposalActions(parcelIdOverride = null) {
        const container = document.getElementById('parcel-proposal-primary-actions')
            || document.getElementById('parcel-proposal-actions');
        if (!container) return;

        const hasMultiSelect = typeof global.multiParcelSelection !== 'undefined' && !!global.multiParcelSelection;
        const multiSelectActive = hasMultiSelect && global.multiParcelSelection.isActive;
        const selectionCount = multiSelectActive && global.multiParcelSelection.selectedParcels
            ? global.multiParcelSelection.selectedParcels.size
            : 0;

        const parcelContextId = parcelIdOverride || (global.currentParcel && global.currentParcel.id);
        if ((multiSelectActive && selectionCount > 0) || parcelContextId) {
            container.innerHTML = buildPaletteHtml();
        } else {
            container.innerHTML = '';
        }
    }

    global.createProposalFromSingleParcel = createProposalFromSingleParcel;
    global.createProposalFromSelectedParcels = createProposalFromSelectedParcels;
    global.shouldSuggestWholeBlockForFreshProposal = shouldSuggestWholeBlockForFreshProposal;
    global.maybeSuggestWholeBlockForFreshProposal = maybeSuggestWholeBlockForFreshProposal;
    global.startParcelBuildTool = startParcelBuildTool;
    global.startParcelTransportTool = startParcelTransportTool;
    global.renderParcelProposalActions = renderParcelProposalActions;
})(typeof window !== 'undefined' ? window : globalThis);
