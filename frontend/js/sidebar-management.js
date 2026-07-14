// Add function to toggle sidebar sections (for checkboxes)
function toggleAccordion(checkbox, options = {}) {
    const skipParcelFetch = options.skipParcelFetch === true;
    // Checkbox is now inside the accordion-content, so we need to find the section differently
    const section = checkbox.closest('.accordion-section');
    const content = section ? section.querySelector('.accordion-content') : null;
    const header = section ? section.querySelector('.accordion-header') : null;
    const layerName = checkbox.dataset.layer;

    // Note: Roads section no longer has a checkbox, so it's always visible
    // Mutual exclusivity between Roads and Parcel Blocks is no longer applicable

    // Handle Game section special behavior
    if (layerName === 'game') {
        const gameHeaderSpan = header ? header.querySelector('[data-section-title="game"]') : null;
        const i18nApi = (typeof window !== 'undefined') ? window.i18n : null;
        const setGameHeaderKey = (key) => {
            if (!gameHeaderSpan) return;
            gameHeaderSpan.setAttribute('data-i18n-key', key);
            if (i18nApi && typeof i18nApi.applyTranslations === 'function') {
                i18nApi.applyTranslations(gameHeaderSpan);
            } else if (key === 'sidebar.game.titlePaused') {
                gameHeaderSpan.textContent = 'Game (paused)';
            } else {
                gameHeaderSpan.textContent = 'Game';
            }
        };

        if (checkbox.checked) {
            setGameHeaderKey('sidebar.game.title');
        } else {
            // Game disabled - pause game and update header
            if (typeof gameState !== 'undefined' && gameState.isRunning && typeof stopGameLoop === 'function') {
                stopGameLoop();
            }
            setGameHeaderKey('sidebar.game.titlePaused');
        }
    }

    // Expansion is now independent from check state; do not toggle content visibility here

    // Toggle layer visibility
    if (layerName === 'parcels') {
        const showParcelNumbersCheckbox = document.getElementById('showParcelNumbers');

        const uiVisibility = (window.Parcels && window.Parcels.uiVisibility) ? window.Parcels.uiVisibility : {};
        const uiLabels = (window.Parcels && window.Parcels.uiLabels) ? window.Parcels.uiLabels : {};
        const showAll = uiVisibility.showAllParcels || showAllParcels;
        const hideAll = uiVisibility.hideAllParcels || hideAllParcels;
        const isRoadFn = uiVisibility.isRoad || isRoad;
        const toggleNumbers = uiLabels.toggleParcelNumbers || toggleParcelNumbers;

        if (checkbox.checked) {
            // If main section is checked, ensure "All parcels" layer is shown (implicitly, by calling showAllParcels)
            if (typeof showAll === 'function') {
                // Only show if zoom policy allows parcels
                const within = (typeof window.isZoomWithinParcelRange === 'function') ? window.isZoomWithinParcelRange() : true;
                if (within) {
                    const parcelLayer = (window.ParcelsState && typeof window.ParcelsState.getParcelLayer === 'function')
                        ? window.ParcelsState.getParcelLayer()
                        : window.parcelLayer;

                    if (skipParcelFetch && !parcelLayer) {
                        // Avoid double-fetch on startup; map core will trigger the first load.
                        return;
                    }
                    showAll();
                } else {
                    // Immediately uncheck if outside zoom
                    checkbox.checked = false;
                }
            }
        } else {
            // If main section is unchecked, hide all parcel layers and parcel numbers
            if (typeof hideAll === 'function') {
                hideAll();
            }
            if (showParcelNumbersCheckbox && showParcelNumbersCheckbox.checked && typeof toggleNumbers === 'function') {
                showParcelNumbersCheckbox.checked = false;
                toggleNumbers(); // Hide parcel numbers
            }
        }
    } else if (layerName === 'blocks') {
        toggleBlocksVisibility();
    } else if (layerName === 'buildings') {
        const showBuildings = document.getElementById('showBuildings').checked;
        if (showBuildings) {
            if (typeof fetchBuildings === 'function') {
                fetchBuildings();
            }
        } else if (typeof buildingLayer !== 'undefined' && buildingLayer) {
            map.removeLayer(buildingLayer);
        }
    } else if (layerName === 'buildingsDgu') {
        const showDgu = document.getElementById('showBuildingsDgu').checked;
        if (showDgu) {
            if (typeof fetchDguBuildings === 'function') fetchDguBuildings();
        } else if (typeof hideDguBuildingLayer === 'function') {
            hideDguBuildingLayer();
        }
    }
    // Proposals section no longer has a checkbox - proposals are always shown
    // Update interactivity of this section controls if it's expanded
    try {
        const section = header ? header.closest('.accordion-section') : null;
        if (section && typeof updateSectionControlsState === 'function') {
            updateSectionControlsState(section);
        }
    } catch (_) { }

    if (layerName === 'blocks' && typeof updateBlockButtonStates === 'function') {
        updateBlockButtonStates();
    }
}

// Update enabled/disabled state for controls inside a section based on expansion and checkbox state
function updateSectionControlsState(section) {
    if (!section) return;
    const sectionName = section.dataset && section.dataset.section;
    if (sectionName === 'blocks') {
        const content = section.querySelector('.accordion-content');
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
    const header = section.querySelector('.accordion-header');
    const content = section.querySelector('.accordion-content');
    if (!content) return;
    // Checkbox is now inside the content, not the header
    const checkbox = content.querySelector('input[type="checkbox"][data-layer]');
    const isExpanded = content.classList.contains('active');

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

    // For sections with checkboxes, disable controls when expanded but unchecked
    const isChecked = !!checkbox.checked;
    // Check if there's a section-dependent-content div (for sections like Game)
    const dependentContent = content.querySelector('.section-dependent-content');
    // If dependent content exists, only target elements within it; otherwise target all in content
    const targetContainer = dependentContent || content;
    const interactive = targetContainer.querySelectorAll('input, button, select, textarea');
    const shouldDisable = isExpanded && !isChecked;

    interactive.forEach(el => {
        try {
            // Never disable the checkbox itself - it should always be enabled
            if (el === checkbox) {
                return;
            }
            const sectionIndependent = el.dataset && el.dataset.sectionIndependent === 'true';
            if (sectionIndependent) {
                el.removeAttribute('data-section-disabled');
                el.removeAttribute('data-prev-disabled');
                el.disabled = false;
                if (el.classList && el.classList.contains('btn')) {
                    el.classList.remove('disabled');
                }
                return;
            }

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

// Expand/collapse a section by clicking on the header
function toggleSectionExpansion(triggerEl) {
    if (!triggerEl) return;
    // triggerEl can be the header itself or an element inside it
    const header = triggerEl.classList && triggerEl.classList.contains('accordion-header')
        ? triggerEl
        : triggerEl.closest('.accordion-header');
    if (!header) return;
    const section = header.closest('.accordion-section');
    const content = section ? section.querySelector('.accordion-content') : null;
    if (!content) return;

    const chevronIcon = header.querySelector('.accordion-chevron');

    const willExpand = !content.classList.contains('active');
    if (willExpand) {
        content.classList.add('active');
        if (chevronIcon) {
            if (chevronIcon.classList.contains('fa-chevron-down')) {
                chevronIcon.classList.replace('fa-chevron-down', 'fa-chevron-up');
            }
        }
        header.setAttribute('aria-expanded', 'true');

        // After layout updates, scroll into view if needed (no setTimeout - use rAF)
        const sidebarScrollable = document.getElementById('sidebar-scrollable-content');
        if (sidebarScrollable) {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    try {
                        const containerRect = sidebarScrollable.getBoundingClientRect();
                        const contentRect = content.getBoundingClientRect();

                        let targetTop = sidebarScrollable.scrollTop;
                        // If content taller than container, align top
                        if (contentRect.height >= containerRect.height) {
                            targetTop += (contentRect.top - containerRect.top);
                        } else {
                            if (contentRect.top < containerRect.top) {
                                targetTop += (contentRect.top - containerRect.top);
                            }
                            if (contentRect.bottom > containerRect.bottom) {
                                targetTop += (contentRect.bottom - containerRect.bottom);
                            }
                        }
                        sidebarScrollable.scrollTo({ top: targetTop, behavior: 'smooth' });
                    } catch (_) { }
                });
            });
        }
    } else {
        content.classList.remove('active');
        if (chevronIcon) {
            if (chevronIcon.classList.contains('fa-chevron-up')) {
                chevronIcon.classList.replace('fa-chevron-up', 'fa-chevron-down');
            }
        }
        header.setAttribute('aria-expanded', 'false');
    }

    // Adjust controls disabled/enabled depending on expansion and checkbox state
    try { updateSectionControlsState(section); } catch (_) { }
}

// Add function to toggle button-based accordion sections (for Measurement and Information)
function toggleButtonAccordion(button) {
    const content = button.nextElementSibling;
    // Target the chevron icon specifically (the second i.fas element or the one with chevron class)
    const chevronIcon = button.querySelector('i.fas.fa-chevron-down, i.fas.fa-chevron-up');

    if (content) {
        if (content.classList.contains('active')) {
            // Hide the content
            content.classList.remove('active');
            content.style.display = ''; // Clear inline style to let CSS take over
            if (chevronIcon && chevronIcon.classList.contains('fa-chevron-up')) {
                chevronIcon.classList.replace('fa-chevron-up', 'fa-chevron-down');
            }
        } else {
            // Show the content
            content.classList.add('active');
            content.style.display = ''; // Clear inline style to let CSS take over
            if (chevronIcon && chevronIcon.classList.contains('fa-chevron-down')) {
                chevronIcon.classList.replace('fa-chevron-down', 'fa-chevron-up');
            }

            // Auto-scroll to make expanded content visible (use rAF instead of setTimeout)
            const sidebarScrollable = document.getElementById('sidebar-scrollable-content');
            if (sidebarScrollable) {
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        try {
                            const containerRect = sidebarScrollable.getBoundingClientRect();
                            const contentRect = content.getBoundingClientRect();
                            let targetTop = sidebarScrollable.scrollTop;
                            if (contentRect.height >= containerRect.height) {
                                targetTop += (contentRect.top - containerRect.top);
                            } else {
                                if (contentRect.top < containerRect.top) {
                                    targetTop += (contentRect.top - containerRect.top);
                                }
                                if (contentRect.bottom > containerRect.bottom) {
                                    targetTop += (contentRect.bottom - containerRect.bottom);
                                }
                            }
                            sidebarScrollable.scrollTo({ top: targetTop, behavior: 'smooth' });
                        } catch (_) { }
                    });
                });
            }
        }
    }
}

// Toggle sidebar visibility
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('collapsed');
    const isCollapsed = sidebar.classList.contains('collapsed');
    document.body.classList.toggle('sidebar-collapsed', isCollapsed);

    if (isCollapsed) {
        // Hide content when collapsed
        document.querySelectorAll('.accordion-section').forEach(section => {
            section.style.display = 'none';
        });
        document.querySelector('.sidebar-header h2').style.display = 'none';
    } else {
        // Show content when expanded
        document.querySelectorAll('.accordion-section').forEach(section => {
            section.style.display = 'block';
        });
        document.querySelector('.sidebar-header h2').style.display = 'block';

        // Re-apply sidebar configuration to hide disabled sections according to city config
        // This ensures that sections disabled for the current city (e.g., Buenos Aires) remain hidden
        if (typeof window.CityConfigManager !== 'undefined' &&
            typeof window.CityConfigManager.applySidebarConfiguration === 'function') {
            window.CityConfigManager.applySidebarConfiguration();
            // applySidebarConfiguration already calls applyFeatureVisibility internally
        }
    }

    // Allow time for transition before resizing map
    setTimeout(() => {
        if (typeof map !== 'undefined' && map.invalidateSize) {
            map.invalidateSize();
        }
    }, 300);

    updateSidebarToggleButtonPosition();
}

function updateSidebarToggleButtonPosition() {
    try {
        const sidebar = document.getElementById('sidebar');
        const toggleBtnDesktop = document.getElementById('toggle-sidebar-desktop');
        if (!sidebar) {
            return;
        }

        const isCollapsed = sidebar.classList.contains('collapsed');
        if (toggleBtnDesktop) {
            toggleBtnDesktop.style.left = isCollapsed ? '10px' : '330px';
        }
    } catch (_) { }
}

function setSidebarDisabled(isDisabled, message = '') {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;

    const desktopToggle = document.getElementById('toggle-sidebar-desktop');
    const mobileToggle = document.getElementById('toggle-sidebar-mobile');
    const toggles = [desktopToggle, mobileToggle].filter(Boolean);

    let overlay = sidebar.querySelector('.sidebar-disabled-overlay');

    if (isDisabled) {
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'sidebar-disabled-overlay';

            const content = document.createElement('div');
            content.className = 'sidebar-disabled-overlay__content';
            content.setAttribute('role', 'status');
            content.setAttribute('aria-live', 'polite');

            const spinner = document.createElement('div');
            spinner.className = 'sidebar-disabled-overlay__spinner';

            const text = document.createElement('span');
            text.className = 'sidebar-disabled-overlay__text';

            content.appendChild(spinner);
            content.appendChild(text);
            overlay.appendChild(content);
            sidebar.appendChild(overlay);
        }

        const textEl = overlay.querySelector('.sidebar-disabled-overlay__text');
        if (textEl) {
            textEl.textContent = message || '';
        }

        overlay.style.display = 'flex';
        sidebar.classList.add('sidebar-disabled');
        sidebar.setAttribute('aria-busy', 'true');

        toggles.forEach(btn => {
            const prev = btn.disabled ? '1' : '0';
            btn.setAttribute('data-prev-disabled', prev);
            btn.disabled = true;
        });
    } else {
        if (overlay) {
            overlay.remove();
        }

        sidebar.classList.remove('sidebar-disabled');
        sidebar.removeAttribute('aria-busy');

        toggles.forEach(btn => {
            const prev = btn.getAttribute('data-prev-disabled');
            if (prev !== null) {
                btn.disabled = prev === '1';
                btn.removeAttribute('data-prev-disabled');
            }
        });
    }
}

// Toggle debug mode
function toggleDebugMode() {
    const debugCheckbox = document.getElementById('debugModeCheckbox');
    const body = document.body;

    if (debugCheckbox.checked) {
        body.classList.add('debug-mode');
        if (typeof updateStatus === 'function') {
            updateStatus('Debug mode enabled - dangerous actions are now visible');
        }
        try { if (typeof updateDataSectionVisibility === 'function') updateDataSectionVisibility(); } catch (_) { }
        if (typeof window.updateBadgeVisibility === 'function') {
            try { window.updateBadgeVisibility(); } catch (_) { }
        } else {
            const debugBadge = document.getElementById('debug-badge');
            if (debugBadge) debugBadge.style.display = 'inline-flex';
        }
    } else {
        body.classList.remove('debug-mode');
        if (typeof updateStatus === 'function') {
            updateStatus('Debug mode disabled - dangerous actions are hidden');
        }
        try { if (typeof updateDataSectionVisibility === 'function') updateDataSectionVisibility(); } catch (_) { }
        if (typeof window.updateBadgeVisibility === 'function') {
            try { window.updateBadgeVisibility(); } catch (_) { }
        } else {
            const debugBadge = document.getElementById('debug-badge');
            if (debugBadge) debugBadge.style.display = 'none';
        }
    }
}

// Keep Data section available regardless of debug mode
function updateDataSectionVisibility() {
    try {
        const dataSection = document.querySelector('.accordion-section[data-section="data"]');
        if (!dataSection) return;

        dataSection.style.display = 'block';
    } catch (_) { }
}

// Danger: wipe all local storage data
async function wipeLocalData(options = {}) {
    const { skipConfirm = false, skipReload = false } = options || {};
    try {
        const confirmMessage = (typeof window !== 'undefined' && window.i18n && typeof window.i18n.t === 'function')
            ? window.i18n.t('modal.dataManagement.wipeWarning')
            : 'This will erase ALL locally stored data (parcels, roads, proposals, proposal drafts, settings). Continue?';
        const confirmed = skipConfirm ? true : await window.showStyledConfirm(confirmMessage);
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

// Toggle layer visibility.
// `buildings` = the GDI footprints (the model). `buildingsDgu` = the DGU cadastre reference.
// They are independent — both can be on at once — and NEITHER changes what a corridor cuts:
// detection reads window.buildingFeaturePool (the data), never a Leaflet layer.
function toggleLayer(layerType) {
    const showBuildings = document.getElementById('showBuildings').checked;
    const showProposedBuildings = document.getElementById('showProposedBuildings').checked;

    if (layerType === 'parcels') {
        // This is now handled by toggleAccordion calling showAllParcels/hideAllParcels
        // And by handleParcelLayerChange for internal parcel type toggles (if those are re-introduced)
    }

    if (layerType === 'buildings') {
        if (showBuildings) {
            if (typeof fetchBuildings === 'function') {
                fetchBuildings();
            }
        } else if (typeof buildingLayer !== 'undefined' && buildingLayer) {
            map.removeLayer(buildingLayer);
        }
    }

    if (layerType === 'buildingsDgu') {
        const showDgu = document.getElementById('showBuildingsDgu')?.checked;
        if (showDgu) {
            if (typeof fetchDguBuildings === 'function') fetchDguBuildings();
        } else if (typeof hideDguBuildingLayer === 'function') {
            hideDguBuildingLayer();
        }
    }

    if (layerType === 'proposedBuildings') {
        if (showProposedBuildings) {
            if (typeof updateProposedBuildingsLayer === 'function') {
                updateProposedBuildingsLayer();
            }
        } else if (typeof proposedBuildingLayer !== 'undefined' && proposedBuildingLayer) {
            map.removeLayer(proposedBuildingLayer);
        }
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
    const blockButtons = document.querySelectorAll('.accordion-section[data-section="blocks"] .btn-group button');

    // Get references to specific buttons
    const clearBlocksButton = document.querySelector('button[onclick="clearBlocks()"]');
    const countBlocksButton = document.querySelector('button[onclick="countBlocks()"]');
    const floodfillButton = document.querySelector('button[onclick="animateFloodfillFromSelected()"]');
    const buildingsButton = document.getElementById('blockifyButton');
    const singleBuildingButton = document.getElementById('singleBuilding');
    const parkButton = document.getElementById('park');
    const squareButton = document.getElementById('square');
    const breakBlockUpButton = document.getElementById('breakBlockUpButton');

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
                // Prefer live parcelLayer scan (parcels tagged with block), fallback to blockStorage
                if (typeof parcelLayer !== 'undefined' && parcelLayer) {
                    let count = 0;
                    parcelLayer.getLayers().forEach(l => {
                        try {
                            const props = l && l.feature && l.feature.properties;
                            if (!props) return;
                            if (props.block === selectedBlockName) {
                                if (typeof isRoadFn === 'function' && isRoadFn(props.parcelId)) return;
                                count++;
                            }
                        } catch (_) { }
                    });
                    enablePark = count > 0;
                }
                if (!enablePark && typeof blockStorage !== 'undefined' && blockStorage && blockStorage.blocks && blockStorage.blocks.has(selectedBlockName)) {
                    const blk = blockStorage.blocks.get(selectedBlockName);
                    enablePark = !!(blk && Array.isArray(blk.parcels) && blk.parcels.length > 0);
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
                if (typeof parcelLayer !== 'undefined' && parcelLayer) {
                    let count = 0;
                    parcelLayer.getLayers().forEach(l => {
                        try {
                            const props = l && l.feature && l.feature.properties;
                            if (!props) return;
                            if (props.block === selectedBlockName) {
                                if (typeof isRoadFn === 'function' && isRoadFn(props.parcelId)) return;
                                count++;
                            }
                        } catch (_) { }
                    });
                    enableSquare = count > 0;
                }
                if (!enableSquare && typeof blockStorage !== 'undefined' && blockStorage && blockStorage.blocks && blockStorage.blocks.has(selectedBlockName)) {
                    const blk = blockStorage.blocks.get(selectedBlockName);
                    enableSquare = !!(blk && Array.isArray(blk.parcels) && blk.parcels.length > 0);
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

    // Enable Break Block Up only if a block is selected
    if (breakBlockUpButton) {
        if (typeof selectedBlockName !== 'undefined' && selectedBlockName) {
            breakBlockUpButton.disabled = false;
            breakBlockUpButton.classList.remove('disabled');
        } else {
            breakBlockUpButton.disabled = true;
            breakBlockUpButton.classList.add('disabled');
        }
    }

    // Enable/disable Show Block List button
    const showBlockListButton = document.getElementById('showBlockListButton');
    if (showBlockListButton) {
        showBlockListButton.disabled = false;
        showBlockListButton.classList.remove('disabled');
    }
}

// Initialize UI
function initializeSidebar() {
    // Auto-collapse sidebar on mobile view (<768px)
    try {
        const sidebar = document.getElementById('sidebar');
        if (sidebar && window.innerWidth < 768) {
            if (!sidebar.classList.contains('collapsed')) {
                sidebar.classList.add('collapsed');
                // Hide content when collapsed
                document.querySelectorAll('.accordion-section').forEach(section => {
                    section.style.display = 'none';
                });
                const headerTitle = document.querySelector('.sidebar-header h2');
                if (headerTitle) headerTitle.style.display = 'none';
            }
        }
        document.body.classList.toggle('sidebar-collapsed', sidebar ? sidebar.classList.contains('collapsed') : false);
        updateSidebarToggleButtonPosition();
    } catch (_) { }

    // Apply city-specific sidebar configuration (disabled sections, etc.)
    try {
        if (typeof window.CityConfigManager !== 'undefined' &&
            typeof window.CityConfigManager.applySidebarConfiguration === 'function') {
            window.CityConfigManager.applySidebarConfiguration();
        }
    } catch (_) { }

    // Headers are now clickable directly via onclick attribute
    // Chevrons are visual only, no separate click handlers needed

    // Initialize Parcels checkbox state by zoom policy (no auto-expand)
    const firstCheckbox = document.getElementById('parcelsCheckbox');
    if (firstCheckbox) {
        const within = (typeof window.isZoomWithinParcelRange === 'function') ? window.isZoomWithinParcelRange() : true;
        firstCheckbox.checked = within;
        toggleAccordion(firstCheckbox, { skipParcelFetch: true }); // Apply visibility logic without triggering initial fetch
        if (typeof updateParcelsCheckboxByZoom === 'function') {
            try { updateParcelsCheckboxByZoom(within); } catch (_) { }
        }
    }

    // Initialize button states
    updateBlockButtonStates();

    // Initialize game section title
    if (typeof updateGameSectionTitle === 'function') {
        updateGameSectionTitle();
    }

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
            debugBadge.style.display = document.body.classList.contains('debug-mode') ? 'inline-flex' : 'none';
        }
    }

    // Show/hide Data section depending on environment and debug mode
    try { updateDataSectionVisibility(); } catch (_) { }
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

        const baseKey = 'sidebar.parcels.title';
        const hintKey = 'sidebar.parcels.titleZoomHint';
        const uiVisibility = (window.Parcels && window.Parcels.uiVisibility) ? window.Parcels.uiVisibility : {};
        const showAll = uiVisibility.showAllParcels || showAllParcels;
        const hideAll = uiVisibility.hideAllParcels || hideAllParcels;

        if (within) {
            // Enable and check
            parcelsCheckbox.disabled = false;
            if (!parcelsCheckbox.checked) {
                parcelsCheckbox.checked = true;
                // Don't auto-call showAllParcels() here - the zoom handler in map-core.js
                // already manages parcel layer visibility directly. This prevents parcels
                // from being re-added when zooming out to fit large proposals.
                // The checkbox state is just for UI feedback, not for triggering parcel display.
            }
            if (parcelsHeader) {
                parcelsHeader.setAttribute('data-i18n-key', baseKey);
                if (i18nApi && typeof i18nApi.applyTranslations === 'function') {
                    i18nApi.applyTranslations(parcelsHeader);
                } else {
                    parcelsHeader.textContent = 'Parcels';
                }
            }
        } else {
            // Disable, uncheck, hide parcels and show hint
            if (parcelsCheckbox.checked) {
                parcelsCheckbox.checked = false;
                if (typeof hideAll === 'function') {
                    hideAll();
                }
            }
            parcelsCheckbox.disabled = true;
            if (parcelsHeader) {
                parcelsHeader.setAttribute('data-i18n-key', hintKey);
                if (i18nApi && typeof i18nApi.applyTranslations === 'function') {
                    i18nApi.applyTranslations(parcelsHeader);
                } else {
                    parcelsHeader.textContent = 'Parcels (zoom in more)';
                }
            }
        }

        // Enable/disable parcel checkboxes based purely on zoom; keep ad parcels always enabled
        if (parcelsSection) {
            const parcelCheckboxes = parcelsSection.querySelectorAll('input[type="checkbox"]');
            parcelCheckboxes.forEach(cb => {
                if (cb.id === 'showAdParcelsCheckbox') {
                    cb.disabled = false;
                    return;
                }
                cb.disabled = !within;
            });
        }

        // Enable/disable building toggles based on zoom so they stay usable only when parcels are visible
        const showBuildingsCheckbox = document.getElementById('showBuildings');
        const showBuildingsDguCheckbox = document.getElementById('showBuildingsDgu');
        const showProposedBuildingsCheckbox = document.getElementById('showProposedBuildings');
        [showBuildingsCheckbox, showBuildingsDguCheckbox, showProposedBuildingsCheckbox].forEach(cb => {
            if (!cb) return;
            cb.disabled = !within;
        });
    } catch (_) { }
}

window.updateParcelsCheckboxByZoom = updateParcelsCheckboxByZoom;

// Make functions globally available
window.toggleAccordion = toggleAccordion;
window.toggleButtonAccordion = toggleButtonAccordion;
window.toggleSidebar = toggleSidebar;
window.toggleDebugMode = toggleDebugMode;
window.wipeLocalData = wipeLocalData;
window.setSidebarDisabled = setSidebarDisabled;
window.toggleLayer = toggleLayer;
window.updateBlockButtonStates = updateBlockButtonStates;
window.initializeSidebar = initializeSidebar;
window.toggleSectionExpansion = toggleSectionExpansion;
window.updateDataSectionVisibility = updateDataSectionVisibility;

window.addEventListener('DOMContentLoaded', () => {
    // Auto-collapse sidebar on small screens (<768px)
    const sidebar = document.getElementById('sidebar');
    if (sidebar && window.innerWidth < 768) {
        if (!sidebar.classList.contains('collapsed')) {
            sidebar.classList.add('collapsed');
            // Hide content when collapsed
            document.querySelectorAll('.accordion-section').forEach(section => {
                section.style.display = 'none';
            });
            const headerTitle = document.querySelector('.sidebar-header h2');
            if (headerTitle) headerTitle.style.display = 'none';
        }
    }
    document.body.classList.toggle('sidebar-collapsed', sidebar ? sidebar.classList.contains('collapsed') : false);
    updateSidebarToggleButtonPosition();

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
