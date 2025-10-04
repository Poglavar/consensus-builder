// Add function to toggle sidebar sections (for checkboxes)
function toggleAccordion(checkbox) {
    const header = checkbox.parentElement;
    const content = header.nextElementSibling;
    const layerName = checkbox.dataset.layer;
    const iconLabel = header.querySelector('label[for="' + checkbox.id + '"] i.fas'); // More specific selector for the icon within the label

    // Handle mutual exclusivity between Roads and Parcel Blocks
    if (checkbox.checked) {
        if (checkbox.id === 'roadsCheckbox') {
            // If Roads is being checked, uncheck Parcel Blocks
            const parcelBlocksCheckbox = document.getElementById('parcelBlocksCheckbox');
            if (parcelBlocksCheckbox && parcelBlocksCheckbox.checked) {
                parcelBlocksCheckbox.checked = false;
                toggleAccordion(parcelBlocksCheckbox); // Recursively handle the unchecking
            }
        } else if (checkbox.id === 'parcelBlocksCheckbox') {
            // If Parcel Blocks is being checked, uncheck Roads
            const roadsCheckbox = document.getElementById('roadsCheckbox');
            if (roadsCheckbox && roadsCheckbox.checked) {
                roadsCheckbox.checked = false;
                toggleAccordion(roadsCheckbox); // Recursively handle the unchecking
            }
        }
    }

    // Handle Game section special behavior
    if (layerName === 'game') {
        const gameLabel = header.querySelector('label[for="gameCheckbox"] span');
        if (checkbox.checked) {
            // Expanding game section - remove (paused) from title but don't auto-start
            if (gameLabel) {
                gameLabel.innerHTML = '<i class="fas fa-gamepad"></i> Game';
            }
        } else {
            // Collapsing game section - pause game and update title
            if (typeof gameState !== 'undefined' && gameState.isRunning && typeof stopGameLoop === 'function') {
                stopGameLoop();
            }
            if (gameLabel) {
                gameLabel.innerHTML = '<i class="fas fa-gamepad"></i> Game (paused)';
            }
        }
    }

    if (checkbox.checked) {
        content.classList.add('active');
        if (iconLabel && iconLabel.classList.contains('fa-chevron-down')) {
            iconLabel.classList.replace('fa-chevron-down', 'fa-chevron-up');
        }
    } else {
        content.classList.remove('active');
        if (iconLabel && iconLabel.classList.contains('fa-chevron-up')) {
            iconLabel.classList.replace('fa-chevron-up', 'fa-chevron-down');
        }
    }

    // Toggle layer visibility
    if (layerName === 'parcels') {
        const showParcelNumbersCheckbox = document.getElementById('showParcelNumbers');

        if (checkbox.checked) {
            // If main section is checked, ensure "All parcels" layer is shown (implicitly, by calling showAllParcels)
            if (typeof showAllParcels === 'function') {
                // Only show if zoom policy allows parcels
                const within = (typeof window.isZoomWithinParcelRange === 'function') ? window.isZoomWithinParcelRange() : true;
                if (within) {
                    showAllParcels();
                } else {
                    // Immediately uncheck if outside zoom
                    checkbox.checked = false;
                }
            }
        } else {
            // If main section is unchecked, hide all parcel layers and parcel numbers
            if (typeof hideAllParcels === 'function') {
                hideAllParcels();
            }
            if (showParcelNumbersCheckbox && showParcelNumbersCheckbox.checked && typeof toggleParcelNumbers === 'function') {
                showParcelNumbersCheckbox.checked = false;
                toggleParcelNumbers(); // Hide parcel numbers
            }
        }
    } else if (layerName === 'roads') {
        const showOSMRoadLinesCheckbox = document.getElementById('showOSMRoadLines');
        if (showOSMRoadLinesCheckbox && typeof toggleOSMRoadLines === 'function') {
            const osmLayerIsCurrentlyVisible = window.osmRoadLayer && map.hasLayer(window.osmRoadLayer);
            if (checkbox.checked) { // If section checked 
                if (!osmLayerIsCurrentlyVisible) {
                    showOSMRoadLinesCheckbox.checked = true;
                    toggleOSMRoadLines();
                }
            } else { // If section unchecked
                if (osmLayerIsCurrentlyVisible) {
                    showOSMRoadLinesCheckbox.checked = false;
                    toggleOSMRoadLines();
                }
            }
        }
    } else if (layerName === 'blocks') {
        const blocksListContainer = document.getElementById('blocks-list-container');
        if (checkbox.checked) {
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
            if (typeof blockLayer !== 'undefined' && blockLayer && map.hasLayer(blockLayer)) {
                map.removeLayer(blockLayer);
                blockLayer = null;
            }
            if (typeof window.blockPolygonsLayer !== 'undefined' && window.blockPolygonsLayer && map.hasLayer(window.blockPolygonsLayer)) {
                map.removeLayer(window.blockPolygonsLayer);
                window.blockPolygonsLayer = null;
            }
            // When turning blocks off, clear any blue parcel highlights for the selected block
            try {
                if (typeof clearHighlightedBlockParcels === 'function') {
                    clearHighlightedBlockParcels();
                }
            } catch (_) { }
            if (typeof hideBlockInfo === 'function') {
                hideBlockInfo(); // Also hide info panel if open
            }
        }
        if (typeof updateBlockButtonStates === 'function') {
            updateBlockButtonStates();
        }
    } else if (layerName === 'buildings') {
        const showBuildings = document.getElementById('showBuildings').checked;
        if (showBuildings) {
            if (typeof fetchBuildings === 'function') {
                fetchBuildings();
            }
        } else if (typeof buildingLayer !== 'undefined' && buildingLayer) {
            map.removeLayer(buildingLayer);
        }
    }
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

            // Auto-scroll to make expanded content visible
            setTimeout(() => {
                const rect = content.getBoundingClientRect();
                const sidebarScrollable = document.getElementById('sidebar-scrollable-content');

                // If the content extends below the visible area, scroll to show it
                if (rect.bottom > window.innerHeight) {
                    const scrollTarget = sidebarScrollable.scrollTop + rect.bottom - window.innerHeight + 20;
                    sidebarScrollable.scrollTo({
                        top: scrollTarget,
                        behavior: 'smooth'
                    });
                }
            }, 100); // Small delay to let the content expand first
        }
    }
}

// Toggle sidebar visibility
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('collapsed');

    if (sidebar.classList.contains('collapsed')) {
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
    }

    // Allow time for transition before resizing map
    setTimeout(() => {
        if (typeof map !== 'undefined' && map.invalidateSize) {
            map.invalidateSize();
        }
    }, 300);
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
    } else {
        body.classList.remove('debug-mode');
        if (typeof updateStatus === 'function') {
            updateStatus('Debug mode disabled - dangerous actions are hidden');
        }
    }
}

// Toggle layer visibility
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
    const showBlocksChecked = document.getElementById('parcelBlocksCheckbox').checked;
    const blockButtons = document.querySelectorAll('.block-operations button');

    // Get references to specific buttons
    const clearBlocksButton = document.querySelector('button[onclick="clearBlocks()"]');
    const countBlocksButton = document.querySelector('button[onclick="countBlocks()"]');
    const floodfillButton = document.querySelector('button[onclick="animateFloodfillFromSelected()"]');
    const buildingsButton = document.getElementById('blockifyButton');
    const singleBuildingButton = document.getElementById('singleBuilding');
    const parkButton = document.getElementById('park');
    const squareButton = document.getElementById('square');
    const breakBlockUpButton = document.getElementById('breakBlockUpButton');

    // First, handle the case when Show Blocks is unchecked - disable all buttons
    if (!showBlocksChecked) {
        blockButtons.forEach(button => {
            button.disabled = true;
            button.classList.add('disabled');
        });
        return;
    }

    // Show Blocks is checked - enable basic block operation buttons
    clearBlocksButton.disabled = false;
    clearBlocksButton.classList.remove('disabled');

    countBlocksButton.disabled = false;
    countBlocksButton.classList.remove('disabled');

    floodfillButton.disabled = false;
    floodfillButton.classList.remove('disabled');

    // Always keep Single Building, Park, and Square buttons disabled
    if (singleBuildingButton) {
        singleBuildingButton.disabled = true;
        singleBuildingButton.classList.add('disabled');
    }
    if (parkButton) {
        parkButton.disabled = true;
        parkButton.classList.add('disabled');
    }
    if (squareButton) {
        squareButton.disabled = true;
        squareButton.classList.add('disabled');
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
        if (showBlocksChecked) {
            showBlockListButton.disabled = false;
            showBlockListButton.classList.remove('disabled');
        } else {
            showBlockListButton.disabled = true;
            showBlockListButton.classList.add('disabled');
        }
    }
}

// Initialize UI
function initializeSidebar() {
    // Open first section by default (Parcels)
    const firstCheckbox = document.getElementById('parcelsCheckbox');
    if (firstCheckbox) {
        // Respect zoom policy when initializing parcels section
        const within = (typeof window.isZoomWithinParcelRange === 'function') ? window.isZoomWithinParcelRange() : true;
        firstCheckbox.checked = within;
        toggleAccordion(firstCheckbox); // Initialize correctly
        if (typeof updateParcelsCheckboxByZoom === 'function') {
            try { updateParcelsCheckboxByZoom(within); } catch (_) { }
        }
    } else {
        // Fallback for older structure if needed, though ideally not.
        const firstContent = document.querySelector('.accordion-content');
        if (firstContent) firstContent.classList.add('active');
        const firstIcon = document.querySelector('.accordion-header i.fas.fa-chevron-down');
        if (firstIcon) firstIcon.classList.replace('fa-chevron-down', 'fa-chevron-up');
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
}

// Manage parcels checkbox state based on zoom policy
function updateParcelsCheckboxByZoom(within) {
    try {
        const parcelsHeader = document.querySelector('.accordion-header label[for="parcelsCheckbox"] span');
        const parcelsCheckbox = document.getElementById('parcelsCheckbox');
        if (!parcelsCheckbox || !parcelsHeader) return;

        const hintSuffix = ' (zoom in more)';
        if (within) {
            // Enable and check
            parcelsCheckbox.disabled = false;
            if (!parcelsCheckbox.checked) {
                parcelsCheckbox.checked = true;
                // Trigger showing parcels if available
                if (typeof showAllParcels === 'function') {
                    showAllParcels();
                }
            }
            // Remove hint text if present
            const baseHtml = '<i class="fas fa-map-marker-alt"></i> Parcels';
            if (parcelsHeader.innerHTML.indexOf(hintSuffix) !== -1) {
                parcelsHeader.innerHTML = baseHtml;
            } else if (parcelsHeader.innerHTML !== baseHtml) {
                parcelsHeader.innerHTML = baseHtml;
            }
        } else {
            // Disable, uncheck, hide parcels and show hint
            if (parcelsCheckbox.checked) {
                parcelsCheckbox.checked = false;
                if (typeof hideAllParcels === 'function') {
                    hideAllParcels();
                }
            }
            parcelsCheckbox.disabled = true;
            const baseHtml = '<i class="fas fa-map-marker-alt"></i> Parcels';
            if (parcelsHeader.innerHTML.indexOf(hintSuffix) === -1) {
                parcelsHeader.innerHTML = baseHtml + hintSuffix;
            }
        }
    } catch (_) { }
}

window.updateParcelsCheckboxByZoom = updateParcelsCheckboxByZoom;

// Make functions globally available
window.toggleAccordion = toggleAccordion;
window.toggleButtonAccordion = toggleButtonAccordion;
window.toggleSidebar = toggleSidebar;
window.toggleDebugMode = toggleDebugMode;
window.toggleLayer = toggleLayer;
window.updateBlockButtonStates = updateBlockButtonStates;
window.initializeSidebar = initializeSidebar;

window.addEventListener('DOMContentLoaded', () => {
    // Auto-collapse sidebar on small screens (<768px)
    if (window.innerWidth < 768) {
        const sidebar = document.getElementById('sidebar');
        if (sidebar && !sidebar.classList.contains('collapsed')) {
            toggleSidebar();
        }
    }
}); 