// map-controls.js — behaviour of the map's layer/tool/game controls (formerly the left sidebar's,
// now rehoused in the floating shell's sheets, see js/ui/map-shell.js): the section-checkbox layer
// toggles, per-section control gating, block/building layer toggles, debug mode, the local-data wipe,
// zoom gating of the parcels controls, and initializeMapControls() run from the boot in index.html.

// A section's layer checkbox (#parcelsCheckbox; data-layer names the layer) changed.
function toggleAccordion(checkbox) {
    const section = checkbox.closest('.accordion-section');
    const layerName = checkbox.dataset.layer;

    // Note: Roads section no longer has a checkbox, so it's always visible
    // Mutual exclusivity between Roads and Parcel Blocks is no longer applicable

    // Expansion is now independent from check state; do not toggle content visibility here

    // Toggle layer visibility
    if (layerName === 'parcels') {
        if (!window.isThreeModeActive?.()) {
            if (checkbox.checked) window.ParcelsUIVisibility?.showAllParcels();
            else window.ParcelsUIVisibility?.hideAllParcels();
        }
        window.dispatchEvent(new Event('parcellayerchange'));
    } else if (layerName === 'blocks') {
        toggleBlocksVisibility();
    }
    // Proposals section no longer has a checkbox - proposals are always shown
    // Update interactivity of this section's controls
    try {
        if (section && typeof updateSectionControlsState === 'function') {
            updateSectionControlsState(section);
        }
    } catch (_) { }

    if (layerName === 'blocks' && typeof updateBlockButtonStates === 'function') {
        updateBlockButtonStates();
    }
}

// Every building survey loads only from zoom 17 (map-core.js fetchBuildings / fetchDguBuildings /
// fetchOsmBuildings), and the layer then follows the map. Ticking a box further out used to do
// nothing visible at all, so say why; the layer appears by itself once the map is zoomed in.
function announceBuildingZoomGate() {
    const z = (typeof map !== 'undefined' && map && typeof map.getZoom === 'function') ? map.getZoom() : null;
    if (typeof z !== 'number' || !Number.isFinite(z) || z >= 17 || typeof updateStatus !== 'function') return;
    const key = 'status.messages.zoom_in_to_see_buildings';
    const text = window.i18n && typeof window.i18n.t === 'function' ? window.i18n.t(key) : null;
    updateStatus(text && text !== key ? text : 'Zoom in closer to see buildings.');
}

// Update enabled/disabled state for controls inside a section based on its layer checkbox. Sections
// live in always-open sheets, so an unchecked section (game off, parcels off or zoomed out) greys
// its controls; data-section-independent controls stay usable.
function updateSectionControlsState(section) {
    if (!section) return;
    const sectionName = section.dataset && section.dataset.section;
    if (sectionName === 'blocks') {
        const content = section.querySelector('.sheet-section-body');
        if (!content) return;
        content.classList.remove('section-disabled');
        const interactive = content.querySelectorAll('input, button, select, textarea');
        interactive.forEach(el => {
            try {
                if (el.getAttribute && el.getAttribute('data-section-disabled') === '1') {
                    const prevDisabled = el.getAttribute('data-prev-disabled');
                    el.removeAttribute('data-section-disabled');
                    if (prevDisabled !== null) el.removeAttribute('data-prev-disabled');
                    const originallyDisabled = prevDisabled === '1';
                    const threeDisabled = el.getAttribute && el.getAttribute('data-three-disabled') === '1';
                    el.disabled = originallyDisabled || !!threeDisabled;
                    if (el.classList && el.classList.contains('btn')) {
                        if (el.disabled) {
                            el.classList.add('disabled');
                        } else {
                            el.classList.remove('disabled');
                        }
                    }
                }
            } catch (_) { }
        });
        return;
    }
    const content = section.querySelector('.sheet-section-body');
    if (!content) return;
    const checkbox = content.querySelector('input[type="checkbox"][data-layer]');
    // A disclosure can contain independent tools. Its descendant's switch owns only that tool.
    if (checkbox && checkbox.closest('.accordion-section') !== section) return;

    // If there's no checkbox (Data, Proposals sections), always enable controls
    if (!checkbox) {
        const interactive = content.querySelectorAll('input, button, select, textarea');
        interactive.forEach(el => {
            try {
                // Re-enable if we disabled it due to section gating
                const wasSectionDisabled = el.getAttribute && el.getAttribute('data-section-disabled') === '1';
                if (wasSectionDisabled) {
                    const prevDisabled = el.getAttribute('data-prev-disabled');
                    el.removeAttribute('data-section-disabled');
                    if (prevDisabled !== null) el.removeAttribute('data-prev-disabled');
                    // Restore original disabled state, then apply any other locks (e.g., 3D mode)
                    const originallyDisabled = prevDisabled === '1';
                    const threeDisabled = el.getAttribute && el.getAttribute('data-three-disabled') === '1';
                    el.disabled = originallyDisabled || !!threeDisabled;
                    if (el.classList && el.classList.contains('btn')) {
                        if (el.disabled) {
                            el.classList.add('disabled');
                        } else {
                            el.classList.remove('disabled');
                        }
                    }
                }
            } catch (_) { }
        });
        content.classList.remove('section-disabled');
        return;
    }

    // For sections with checkboxes, disable controls while unchecked
    const isChecked = !!checkbox.checked;
    // Check if there's a section-dependent-content div (for sections like Game)
    const dependentContent = content.querySelector('.section-dependent-content');
    // If dependent content exists, only target elements within it; otherwise target all in content
    const targetContainer = dependentContent || content;
    const interactive = targetContainer.querySelectorAll('input, button, select, textarea');
    const shouldDisable = !isChecked || (sectionName === 'parcels' && checkbox.disabled);

    interactive.forEach(el => {
        try {
            // These controls manage their own availability (zoom, photo boundaries or editor locks).
            if (el === checkbox || el.dataset?.sectionIndependent === 'true') return;

            if (shouldDisable) {
                // Mark as disabled by section gating and remember previous disabled state
                if (!el.getAttribute('data-section-disabled')) {
                    el.setAttribute('data-prev-disabled', el.disabled ? '1' : '0');
                }
                el.setAttribute('data-section-disabled', '1');
                el.disabled = true;
                if (el.classList && el.classList.contains('btn')) {
                    el.classList.add('disabled');
                }
            } else {
                // Only re-enable if we disabled it due to section gating
                const wasSectionDisabled = el.getAttribute && el.getAttribute('data-section-disabled') === '1';
                if (wasSectionDisabled) {
                    const prevDisabled = el.getAttribute('data-prev-disabled');
                    el.removeAttribute('data-section-disabled');
                    if (prevDisabled !== null) el.removeAttribute('data-prev-disabled');
                    // Restore original disabled state, then apply any other locks (e.g., 3D mode)
                    const originallyDisabled = prevDisabled === '1';
                    const threeDisabled = el.getAttribute && el.getAttribute('data-three-disabled') === '1';
                    el.disabled = originallyDisabled || !!threeDisabled;
                    if (el.classList && el.classList.contains('btn')) {
                        if (el.disabled) {
                            el.classList.add('disabled');
                        } else {
                            el.classList.remove('disabled');
                        }
                    }
                }
            }
        } catch (_) { }
    });

    // Visual hint for disabled section
    // Apply to section-dependent-content if it exists, otherwise to the entire content
    const targetForDisabledClass = dependentContent || content;
    if (shouldDisable) {
        targetForDisabledClass.classList.add('section-disabled');
    } else {
        targetForDisabledClass.classList.remove('section-disabled');
    }
}

// Toggle debug mode
function toggleDebugMode() {
    const debugCheckbox = document.getElementById('debugModeCheckbox');
    const body = document.body;
    const statusText = (key, fallback) => {
        const fullKey = `status.messages.${key}`;
        const text = window.i18n && typeof window.i18n.t === 'function' ? window.i18n.t(fullKey) : null;
        return text && text !== fullKey ? text : fallback;
    };

    if (debugCheckbox.checked) {
        body.classList.add('debug-mode');
        if (typeof updateStatus === 'function') {
            updateStatus(statusText('debug_mode_enabled', 'Debug mode enabled - dangerous actions are now visible'));
        }
        if (typeof window.updateBadgeVisibility === 'function') {
            try { window.updateBadgeVisibility(); } catch (_) { }
        } else {
            const debugBadge = document.getElementById('debug-badge');
            if (debugBadge) debugBadge.hidden = false;
        }
    } else {
        body.classList.remove('debug-mode');
        if (typeof updateStatus === 'function') {
            updateStatus(statusText('debug_mode_disabled', 'Debug mode disabled - dangerous actions are hidden'));
        }
        if (typeof window.updateBadgeVisibility === 'function') {
            try { window.updateBadgeVisibility(); } catch (_) { }
        } else {
            const debugBadge = document.getElementById('debug-badge');
            if (debugBadge) debugBadge.hidden = true;
        }
    }
}

// Danger: wipe all local storage data
async function wipeLocalData(options = {}) {
    const { skipConfirm = false, skipReload = false } = options || {};
    try {
        const confirmMessage = (typeof window !== 'undefined' && window.i18n && typeof window.i18n.t === 'function')
            ? window.i18n.t('modal.dataManagement.wipeWarning')
            : 'This will erase ALL locally stored data (parcels, roads, designs, design drafts, settings). Continue?';
        const confirmed = skipConfirm ? true : await window.showStyledConfirm(confirmMessage, { destructive: true });
        if (!confirmed) return;
        // Delegate to the single canonical eraser (js/wipe-local-data.js) rather than re-clearing a
        // subset here — this wrapper only adds the confirmation, the status line and the reload.
        if (typeof window.wipeAllLocalData === 'function') {
            await window.wipeAllLocalData({ skipReload: true });
        } else {
            try { PersistentStorage.clear(); } catch (_) { }
            try { sessionStorage && sessionStorage.clear && sessionStorage.clear(); } catch (_) { }
        }
        if (typeof updateStatus === 'function') {
            const clearedMessage = (typeof window !== 'undefined' && window.i18n && typeof window.i18n.t === 'function')
                ? window.i18n.t('status.messages.all_local_data_cleared_reloading')
                : 'All local data cleared. Reloading...';
            updateStatus(clearedMessage);
        }
        if (!skipReload) {
            setTimeout(() => { try { window.location.reload(); } catch (_) { } }, 200);
        }
    } catch (e) {
        console.error('Failed to wipe local data:', e);
        const errorLabel = (typeof window !== 'undefined' && window.i18n && typeof window.i18n.t === 'function')
            ? window.i18n.t('alerts.messages.failed_to_wipe_local_data')
            : 'Failed to wipe local data:';
        const message = `${errorLabel} ${e && e.message ? e.message : e}`;
        const alertFn = (typeof window !== 'undefined' && typeof window.showStyledAlert === 'function') ? window.showStyledAlert : window.alert;
        if (typeof alertFn === 'function') {
            alertFn(message);
        }
    }
}

// Toggle parcel block visibility without gating the section controls
function toggleBlocksVisibility() {
    const checkbox = document.getElementById('parcelBlocksCheckbox');
    if (!checkbox) return;

    const blocksListContainer = document.getElementById('blocks-list-container');
    const isChecked = !!checkbox.checked;

    if (isChecked) {
        if (typeof blockStorage !== 'undefined' && typeof blockStorage.load === 'function') {
            blockStorage.load();
        }
        if (typeof updateBlocksList === 'function') {
            updateBlocksList();
        }
        if (blocksListContainer) {
            blocksListContainer.style.display = 'block';
        }
        if (typeof updateBlockLayer === 'function') {
            updateBlockLayer();
        }
    } else {
        if (blocksListContainer) {
            blocksListContainer.style.display = 'none';
        }
        if (typeof blockLayer !== 'undefined' && blockLayer && typeof map !== 'undefined' && map.hasLayer && map.hasLayer(blockLayer)) {
            map.removeLayer(blockLayer);
            blockLayer = null;
        }
        if (typeof window.blockPolygonsLayer !== 'undefined' && window.blockPolygonsLayer && typeof map !== 'undefined' && map.hasLayer && map.hasLayer(window.blockPolygonsLayer)) {
            map.removeLayer(window.blockPolygonsLayer);
            window.blockPolygonsLayer = null;
        }
        try {
            if (typeof clearHighlightedBlockParcels === 'function') {
                clearHighlightedBlockParcels();
            }
        } catch (_) { }
        if (typeof hideBlockInfo === 'function') {
            hideBlockInfo();
        }
    }

    if (typeof updateBlockButtonStates === 'function') {
        updateBlockButtonStates();
    }
}

// The Built disclosure names the city's sources in use and any outlined for comparison.
function renderBuildingSourceSummary() {
    const line = document.getElementById('building-sources-summary');
    if (!line) return;
    try { line.textContent = window.ParcelSourceSettings?.buildingSourceSummary?.(window) || ''; }
    catch (error) { console.warn(`[${new Date().toISOString()}] [buildings] source summary unavailable`, error); }
}

// Outlined sources (reference outlines from a source not in use) cannot be filtered by the working
// stock's demolitions, so while buildings are shown with any outlined, the existing-buildings view
// leaves the scope that would hide them, including one set by a share link.
function applyOutlinedSourceScope() {
    if (!window.PlanningViews?.isBuiltVisible()) return;
    const sources = window.CityConfigManager?.getBuildingSources?.();
    if (!sources || !window.SourceList?.outlined(sources).length) return;
    const state = window.PlanningViews?.getState?.();
    if (state?.existingScope && state.existingScope !== 'all') window.PlanningViews.configure('existingScope', 'all');
}

let buildingSourceListListening = false;
function onBuildingSourceListChanged() {
    renderBuildingSourceSummary();
    applyOutlinedSourceScope();
}

// Toggle layer visibility.
function toggleLayer(layerType) {
    if (layerType === 'proposedBuildings') {
        if (document.getElementById('showProposedBuildings').checked) {
            if (typeof updateProposedBuildingsLayer === 'function') {
                updateProposedBuildingsLayer();
            }
        } else if (typeof proposedBuildingLayer !== 'undefined' && proposedBuildingLayer) {
            map.removeLayer(proposedBuildingLayer);
        }
    }

    // Ground-floor layouts in Buildings and massing draw from building zoom.
    if (layerType === 'suggestedLayouts') {
        const showSuggested = !!document.getElementById('showSuggestedLayouts')?.checked;
        if (showSuggested) announceBuildingZoomGate();
        window.__suggestedLayouts2D.setEnabled(showSuggested);
    }

    if (layerType === 'blocks') {
        // This is now primarily handled by toggleAccordion for the 'blocks' section.
        // updateBlockButtonStates() is called from there.
        // We might still need to call updateBlockifyButton if it's separate
        if (typeof updateBlockifyButton === 'function') {
            updateBlockifyButton();
        }
    }
}

// Update block section button states based on checkbox and selection state
function updateBlockButtonStates() {
    const blockButtons = document.querySelectorAll('[data-feature="parcelBlocks"] .cb-actions button');

    // Predicate used below to exclude road parcels from the block's parcel count. It resolves the
    // same way toggleAccordion does; previously this was referenced as a bare `isRoadFn`, which only
    // existed as a local in toggleAccordion, so the guard silently never fired and roads were counted.
    const uiVisibility = (window.Parcels && window.Parcels.uiVisibility) ? window.Parcels.uiVisibility : {};
    const isRoadFn = uiVisibility.isRoad || (typeof window !== 'undefined' ? window.isRoad : null);

    // Get references to specific buttons
    const clearBlocksButton = document.querySelector('button[onclick="clearBlocks()"]');
    const countBlocksButton = document.querySelector('button[onclick="countBlocks()"]');
    const floodfillButton = document.querySelector('button[onclick="animateFloodfillFromSelected()"]');
    const buildingsButton = document.getElementById('blockifyButton');
    const singleBuildingButton = document.getElementById('singleBuilding');
    const parkButton = document.getElementById('park');
    const squareButton = document.getElementById('square');

    // Basic block operation buttons are always available; other buttons are conditionally enabled below
    clearBlocksButton.disabled = false;
    clearBlocksButton.classList.remove('disabled');

    countBlocksButton.disabled = false;
    countBlocksButton.classList.remove('disabled');

    floodfillButton.disabled = false;
    floodfillButton.classList.remove('disabled');

    // Enable Single Building when a block is selected
    if (singleBuildingButton) {
        let enableSingle = false;
        try {
            const hasSelectedBlock = typeof selectedBlockName !== 'undefined' && selectedBlockName;
            if (hasSelectedBlock && typeof blockStorage !== 'undefined' && blockStorage && blockStorage.blocks && blockStorage.blocks.has(selectedBlockName)) {
                const blk = blockStorage.blocks.get(selectedBlockName);
                enableSingle = !!(blk && Array.isArray(blk.parcels) && blk.parcels.length > 0);
            }
        } catch (_) { enableSingle = false; }
        if (enableSingle) {
            singleBuildingButton.disabled = false;
            singleBuildingButton.classList.remove('disabled');
        } else {
            singleBuildingButton.disabled = true;
            singleBuildingButton.classList.add('disabled');
        }
    }
    if (parkButton) {
        let enablePark = false;
        try {
            const hasSelectedBlock = typeof selectedBlockName !== 'undefined' && selectedBlockName;
            if (hasSelectedBlock) {
                if (typeof blockStorage !== 'undefined' && blockStorage && blockStorage.blocks && blockStorage.blocks.has(selectedBlockName)) {
                    const blk = blockStorage.blocks.get(selectedBlockName);
                    const ids = Array.isArray(blk?.parcelIds) ? blk.parcelIds : [];
                    enablePark = ids.some(id => window.LiveParcelFabric?.get?.(String(id))
                        && !(typeof isRoadFn === 'function' && isRoadFn(String(id))));
                }
            }
        } catch (_) { enablePark = false; }
        if (enablePark) {
            parkButton.disabled = false;
            parkButton.classList.remove('disabled');
        } else {
            parkButton.disabled = true;
            parkButton.classList.add('disabled');
        }
    }
    if (squareButton) {
        let enableSquare = false;
        try {
            const hasSelectedBlock = typeof selectedBlockName !== 'undefined' && selectedBlockName;
            if (hasSelectedBlock) {
                if (typeof blockStorage !== 'undefined' && blockStorage && blockStorage.blocks && blockStorage.blocks.has(selectedBlockName)) {
                    const blk = blockStorage.blocks.get(selectedBlockName);
                    const ids = Array.isArray(blk?.parcelIds) ? blk.parcelIds : [];
                    enableSquare = ids.some(id => window.LiveParcelFabric?.get?.(String(id))
                        && !(typeof isRoadFn === 'function' && isRoadFn(String(id))));
                }
            }
        } catch (_) { enableSquare = false; }
        if (enableSquare) {
            squareButton.disabled = false;
            squareButton.classList.remove('disabled');
        } else {
            squareButton.disabled = true;
            squareButton.classList.add('disabled');
        }
    }

    // Only enable the Buildings button (blockifyButton) if a block is selected
    if (buildingsButton) {
        if (typeof selectedBlockName !== 'undefined' && selectedBlockName) {
            buildingsButton.disabled = false;
            buildingsButton.classList.remove('disabled');
            buildingsButton.style.display = 'inline-block';
        } else {
            buildingsButton.disabled = true;
            buildingsButton.classList.add('disabled');
        }
    }

    // Enable/disable Show Block List button
    const showBlockListButton = document.getElementById('showBlockListButton');
    if (showBlockListButton) {
        showBlockListButton.disabled = false;
        showBlockListButton.classList.remove('disabled');
    }
}

// Initialize the map controls (run once from the boot in index.html)
function initializeMapControls() {
    // Apply city-specific section configuration (disabled sections, etc.)
    try {
        if (typeof window.CityConfigManager !== 'undefined' &&
            typeof window.CityConfigManager.applySidebarConfiguration === 'function') {
            window.CityConfigManager.applySidebarConfiguration();
        }
    } catch (_) { }

    // The building source list's summary line and outline scope follow every change to the list.
    onBuildingSourceListChanged();
    if (!buildingSourceListListening) {
        buildingSourceListListening = true;
        window.addEventListener(window.SourceList?.EVENT || 'sourceListChanged', onBuildingSourceListChanged);
        window.i18n?.onChange?.(renderBuildingSourceSummary);
    }

    // Gate every section by its layer checkbox now: the sheets are always "expanded".
    document.querySelectorAll('.accordion-section').forEach(section => updateSectionControlsState(section));

    // Initialize button states
    updateBlockButtonStates();

    // Ensure debug mode defaults based on environment
    try {
        if (window.current_environment === 'development') {
            const debugCheckbox = document.getElementById('debugModeCheckbox');
            if (debugCheckbox) {
                debugCheckbox.checked = true;
            }
            document.body.classList.add('debug-mode');
        } else {
            document.body.classList.remove('debug-mode');
            const debugCheckbox = document.getElementById('debugModeCheckbox');
            if (debugCheckbox) {
                debugCheckbox.checked = false;
            }
        }
    } catch (_) { }

    // Refresh badge visibility after debug defaults are applied
    if (typeof window.updateBadgeVisibility === 'function') {
        try { window.updateBadgeVisibility(); } catch (_) { }
    } else {
        const debugBadge = document.getElementById('debug-badge');
        if (debugBadge) {
            debugBadge.hidden = !document.body.classList.contains('debug-mode');
        }
    }
}

// Manage parcels checkbox state based on zoom policy
function updateParcelsCheckboxByZoom(within) {
    try {
        const parcelsCheckbox = document.getElementById('parcelsCheckbox');
        if (!parcelsCheckbox) return;

        // Find the parcels section header (checkbox is now inside content)
        const parcelsSection = parcelsCheckbox.closest('.accordion-section');
        const parcelsHeader = parcelsSection ? parcelsSection.querySelector('[data-section-title="parcels"]') : null;
        const i18nApi = (typeof window !== 'undefined') ? window.i18n : null;

        // The model and aerial views can show parcel ground independently of Leaflet's zoom.
        const available = within || (window.__mapModeState?.desired ?? '2d') !== '2d';
        parcelsCheckbox.disabled = !available;
        if (parcelsHeader) {
            parcelsHeader.setAttribute('data-i18n-key', available ? 'sidebar.parcels.title' : 'sidebar.parcels.titleZoomHint');
            if (typeof i18nApi?.applyTranslations === 'function') i18nApi.applyTranslations(parcelsHeader);
            else parcelsHeader.textContent = available ? 'Parcels' : 'Parcels (zoom in more)';
        }
        if (parcelsSection && typeof updateSectionControlsState === 'function') {
            updateSectionControlsState(parcelsSection);
        }

        // Leaflet building overlays require building zoom.
        const showProposedBuildingsCheckbox = document.getElementById('showProposedBuildings');
        const showSuggestedLayoutsCheckbox = document.getElementById('showSuggestedLayouts');
        [showProposedBuildingsCheckbox, showSuggestedLayoutsCheckbox].forEach(cb => {
            if (!cb) return;
            cb.disabled = !within;
        });
    } catch (_) { }
}

window.updateParcelsCheckboxByZoom = updateParcelsCheckboxByZoom;
window.addEventListener('mapmodechange', ({ detail }) => {
    if (detail?.pending || typeof isZoomWithinParcelRange !== 'function') return;
    updateParcelsCheckboxByZoom(isZoomWithinParcelRange());
    if (detail?.desired === '2d') window.ParcelsUIVisibility?.syncParcelLayerVisibility();
});

// Make functions globally available
window.toggleAccordion = toggleAccordion;
window.toggleDebugMode = toggleDebugMode;
window.wipeLocalData = wipeLocalData;
window.toggleLayer = toggleLayer;
window.updateBlockButtonStates = updateBlockButtonStates;
window.initializeMapControls = initializeMapControls;

window.addEventListener('DOMContentLoaded', () => {
    // Ensure "Show Proposed Buildings" is checked and applied on load
    try {
        const proposedCb = document.getElementById('showProposedBuildings');
        if (proposedCb && !proposedCb.checked) {
            proposedCb.checked = true;
            // Activate the layer to reflect the checked state immediately
            if (typeof window.toggleLayer === 'function') window.toggleLayer('proposedBuildings');
        } else if (proposedCb && proposedCb.checked) {
            // If already checked, still ensure layer is updated
            if (typeof window.toggleLayer === 'function') window.toggleLayer('proposedBuildings');
        }
    } catch (_) { }
});
