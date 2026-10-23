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
                if (translated !== undefined && translated !== null && translated !== key) {
                    return translated;
                }
            }
        } catch (_) { }
        return fallback || key || '';
    };

    // The Build palette: everything creatable on the current parcel(s), each button jumping
    // straight into that type's design tool (SimCity: draw first, propose later). Building
    // typologies and the parcel layout open their design tools; park/square/lake are one click.
    const PARCEL_BUILD_TOOLS = [
        { key: 'buildings', icon: 'fa-city', labelKey: 'panel.parcel.build.block', fallback: 'Block' },
        { key: 'row', icon: 'fa-grip-horizontal', labelKey: 'panel.parcel.build.row', fallback: 'Row houses' },
        { key: 'parcelBased', icon: 'fa-home', labelKey: 'panel.parcel.build.parcelBased', fallback: 'Detached' },
        { key: 'single', icon: 'fa-ruler-combined', labelKey: 'panel.parcel.build.single', fallback: 'Freeform' },
        { key: 'parcel-layout', icon: 'fa-vector-square', labelKey: 'panel.parcel.build.layOutParcels', fallback: 'Lay out parcels' },
        { key: 'park', icon: 'fa-tree', labelKey: 'panel.parcel.build.park', fallback: 'Park' },
        { key: 'square', icon: 'fa-chess-board', labelKey: 'panel.parcel.build.square', fallback: 'Square' },
        { key: 'lake', icon: 'fa-water', labelKey: 'panel.parcel.build.lake', fallback: 'Lake' }
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
        if (multi && multi.selectedParcels && multi.selectedParcels.size > 0) {
            return [...multi.selectedParcels].map(String);
        }
        return global.currentParcel && global.currentParcel.id ? [String(global.currentParcel.id)] : [];
    }

    // One policy for every FRESH parcel-based design. Corridors target the exact parcel(s)
    // selected, while these land/building tools commonly operate on a whole block.
    const WHOLE_BLOCK_FRESH_PROPOSAL_GOALS = new Set([
        'buildings', 'block', 'row', 'parcelbased', 'single', 'parcel-layout',
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
        const block = global.detectBlockParcelIdsForParcel?.(ids[0]);
        const isBlock = ['block', 'buildings', 'urban-rule'].includes(String(goal).trim().toLowerCase());
        if ((!block || block.count <= 1) && !isBlock) return false;
        // The count belongs in the question, not in a hidden policy gate. A large block is still
        // a block, and silently skipping the question made Detached behave differently depending
        // on where in the city it was launched.
        if (typeof global.showStyledConfirm !== 'function') return false;
        // Silent detection only sees loaded neighbours. Missing results must not remove the
        // user's choice to run detection explicitly.
        const message = block?.count > 1
            ? tParcel('panel.parcel.suggestWholeBlock', { count: block.count },
                `Only one parcel is selected. Did you mean the whole block (${block.count} parcels)?`)
            : tParcel('panel.parcel.chooseBlockScope', {},
                'Only one parcel is selected. Use this parcel, or detect the whole block?');
        const wantsBlock = await global.showStyledConfirm(message, {
            okText: tParcel('panel.parcel.suggestWholeBlockYes', {}, 'Yes, select the block'),
            cancelText: tParcel('panel.parcel.suggestWholeBlockNo', {}, 'No, just this parcel')
        });
        if (!wantsBlock) return false;
        try { await Promise.resolve(global.animateFloodfillFromSelected?.({ replaceSelection: true })); } catch (error) {
            console.warn('[buildPalette] block selection failed', error);
        }
        // Land on the build palette in the Selected parcels section.
        const multi = global.multiParcelSelection;
        if (multi && multi.selectedParcels && multi.selectedParcels.size > 0
            && typeof multi.showSelectionInPanel === 'function') {
            multi.showSelectionInPanel();
        }
        if (typeof global.switchParcelTab === 'function') global.switchParcelTab(null, 'propose-tab');
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
        if (['park', 'square', 'lake'].includes(toolKey)) {
            if (typeof global.instantCreateStructureFromSelection !== 'function') {
                global.reportProposalDesignSaveFailure?.('proposalDrafts.design.unavailable');
                return;
            }
            return Promise.resolve(global.instantCreateStructureFromSelection(toolKey, ids))
                .catch(error => {
                    if (typeof global.reportProposalDesignSaveFailure === 'function') global.reportProposalDesignSaveFailure(error);
                    else console.warn('[buildPalette] structure creation failed', error);
                });
        } else {
            if (typeof global.startInstantProposalDesign !== 'function') {
                global.reportProposalDesignSaveFailure?.('proposalDrafts.design.unavailable');
                return;
            }
            // Returned so the tile spins until the object exists or its design tool is open.
            return Promise.resolve(global.startInstantProposalDesign(toolKey, ids))
                .catch(error => {
                    if (typeof global.reportProposalDesignSaveFailure === 'function') global.reportProposalDesignSaveFailure(error);
                    else console.warn('[buildPalette] design tool failed to open', error);
                });
        }
    }

    // options (the site tool's palette, js/site-drawing.js, reuses this one):
    //   buildHandler     — global called with the tool key (default startParcelBuildTool);
    //   disabled         — { toolKey: reason } shown disabled, the reason as its title and a note;
    //   labels           — { toolKey: label } replaces a tool's label (the site tool names Lay out
    //                      parcels "Subdivide" on a site with open ground).
    // The palette is the shared choice tiles (cb-tiles > cb-tile, css/primitives.css) under section
    // kickers. parcel-build-btn and its --<tool> / parcel-transport-btn--<tool> modifiers stay on each
    // tile as the hooks the specs and the site tool find them by; they paint nothing.
    function buildPaletteHtml(options = {}) {
        const buildHandler = options.buildHandler || 'startParcelBuildTool';
        const disabled = options.disabled || {};
        const labels = options.labels || {};
        const escapeAttr = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        const buttonHtml = tool => {
            const label = labels[tool.key] || tParcel(tool.labelKey, {}, tool.fallback);
            const reason = disabled[tool.key];
            return `
            <button type="button" class="cb-tile parcel-build-btn parcel-build-btn--${tool.key}" onclick="BusyControl.track(this, () => ${buildHandler}('${tool.key}'))"
                title="${escapeAttr(reason || label)}"${reason ? ' disabled aria-disabled="true"' : ''}>
                <i class="cb-tile__icon fas ${tool.icon}" aria-hidden="true"></i>
                <span class="cb-tile__label">${label}</span>
            </button>
            ${reason ? `<p class="parcel-build-disabled-reason">${escapeAttr(reason)}</p>` : ''}
        `;
        };
        // The §15a taxonomy, drawn as labelled groups (rethink-proposals.md, decision 2026-08-05):
        // Lay out parcels stands alone first — the formation primitive; Block/Row/Detached are
        // RULES-based tools (form follows parameters → Urban rules); Freeform Building, Park,
        // Square and Lake all TAKE their parcel (→ Structures). The urban-rule park (use
        // restriction, no taking) joins the rules group when rules grow that vocabulary.
        const RULE_KEYS = ['buildings', 'row', 'parcelBased'];
        const STRUCTURE_KEYS = ['single', 'park', 'square', 'lake'];
        const layoutButton = PARCEL_BUILD_TOOLS.filter(tool => tool.key === 'parcel-layout').map(buttonHtml).join('');
        const ruleButtons = PARCEL_BUILD_TOOLS.filter(tool => RULE_KEYS.includes(tool.key)).map(buttonHtml).join('');
        const structureButtons = PARCEL_BUILD_TOOLS.filter(tool => STRUCTURE_KEYS.includes(tool.key)).map(buttonHtml).join('');
        const rulesTitle = tParcel('panel.parcel.build.rulesCategory', {}, 'Urban rules');
        const structuresTitle = tParcel('panel.parcel.build.structuresCategory', {}, 'Structures');
        // A station tile is a toggle: transit-stations.js marks the type being placed.
        const transportButtons = PARCEL_TRANSPORT_TOOLS
            .filter(tool => tool.stationType || roadToolsEnabled())
            .map(tool => {
                const label = tParcel(tool.labelKey, {}, tool.fallback);
                const title = tParcel(tool.titleKey, {}, tool.titleFallback);
                const stationAttribute = tool.stationType ? ` data-station-type="${tool.stationType}" aria-pressed="false"` : '';
                return `
                    <button type="button" class="cb-tile parcel-build-btn parcel-transport-btn parcel-transport-btn--${tool.key}"
                        onclick="${options.transportHandler || 'startParcelTransportTool'}('${tool.key}')"${stationAttribute}
                        title="${title}" aria-label="${title}">
                        <i class="cb-tile__icon fas ${tool.icon}" aria-hidden="true"></i>
                        <span class="cb-tile__label">${label}</span>
                    </button>
                `;
            }).join('');
        const transportTitle = tParcel('panel.parcel.build.transport', {}, 'Transport');
        return `
            <div class="parcel-build-palette">
                <div class="cb-tiles parcel-build-grid">${layoutButton}</div>
                <section class="parcel-rules-group">
                    <h4 class="cb-kicker">${rulesTitle}</h4>
                    <div class="cb-tiles parcel-rules-grid">${ruleButtons}</div>
                </section>
                <section class="parcel-structures-group">
                    <h4 class="cb-kicker">${structuresTitle}</h4>
                    <div class="cb-tiles parcel-structures-grid">${structureButtons}</div>
                </section>
                <section class="parcel-transport-group">
                    <h4 class="cb-kicker">${transportTitle}</h4>
                    <div class="cb-tiles parcel-transport-grid">${transportButtons}</div>
                </section>
            </div>
        `;
    }

    function renderParcelProposalActions(parcelIdOverride = null) {
        const container = document.getElementById('parcel-proposal-primary-actions')
            || document.getElementById('parcel-proposal-actions');
        if (!container) return;

        const hasMultiSelect = typeof global.multiParcelSelection !== 'undefined' && !!global.multiParcelSelection;
        const multiSelectActive = hasMultiSelect && (global.multiParcelSelection.isActive || global.multiParcelSelection.selectedParcels?.size > 0);
        const selectionCount = multiSelectActive && global.multiParcelSelection.selectedParcels
            ? global.multiParcelSelection.selectedParcels.size
            : 0;

        const parcelContextId = parcelIdOverride || (global.currentParcel && global.currentParcel.id);
        // The one palette predicate (ui/parcel-menu-model.js buildPaletteAvailable).
        if (global.ParcelMenuModel.buildPaletteAvailable({ multiSelectActive, selectionCount, parcelContextId })) {
            container.innerHTML = buildPaletteHtml();
        } else {
            container.innerHTML = '';
        }
    }

    global.shouldSuggestWholeBlockForFreshProposal = shouldSuggestWholeBlockForFreshProposal;
    global.maybeSuggestWholeBlockForFreshProposal = maybeSuggestWholeBlockForFreshProposal;
    global.startParcelBuildTool = startParcelBuildTool;
    global.startParcelTransportTool = startParcelTransportTool;
    global.renderParcelProposalActions = renderParcelProposalActions;
    global.buildProposalPaletteHtml = buildPaletteHtml;
})(typeof window !== 'undefined' ? window : globalThis);
