/*
    Proposals functionality for the cadastre application.
    This file contains the functionality for creating and managing proposals
    for parcels, roads, and building blocks.
*/

// Proposal storage management
const proposalStorage = {
    proposals: new Map(),  // Key: proposalHash, Value: proposal object

    // Save proposals to localStorage
    save() {
        const data = Array.from(this.proposals.entries()).map(([hash, proposal]) => ({
            hash,
            ...proposal
        }));
        localStorage.setItem('cadastre_proposals', JSON.stringify(data));
    },

    // Load proposals from localStorage
    load() {
        const data = localStorage.getItem('cadastre_proposals');
        if (data) {
            this.proposals.clear();
            JSON.parse(data).forEach(proposal => {
                const { hash, ...proposalData } = proposal;
                this.proposals.set(hash, proposalData);
            });
        }
    },

    // Add a new proposal
    addProposal(proposal) {
        const hash = this.generateProposalHash(proposal.parcelIds);
        if (this.proposals.has(hash)) {
            throw new Error('A proposal with these parcels already exists');
        }
        proposal.proposalHash = hash;
        proposal.createdAt = new Date().toISOString();
        this.proposals.set(hash, proposal);
        this.save();
        return hash;
    },

    // Generate hash from sorted parcel IDs
    generateProposalHash(parcelIds) {
        const sortedIds = [...parcelIds].sort().join(',');
        let hash = 0;
        for (let i = 0; i < sortedIds.length; i++) {
            const char = sortedIds.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash).toString(36);
    },

    // Get proposal by hash
    getProposal(hash) {
        return this.proposals.get(hash);
    },

    // Get all proposals
    getAllProposals() {
        return Array.from(this.proposals.values());
    },

    // Get proposals containing a specific parcel
    getProposalsForParcel(parcelId) {
        return this.getAllProposals().filter(proposal =>
            proposal.parcelIds.includes(parcelId.toString())
        );
    },

    // Remove a proposal
    removeProposal(hash) {
        const deleted = this.proposals.delete(hash);
        if (deleted) {
            this.save();
        }
        return deleted;
    },

    // Clear all proposals
    clear() {
        this.proposals.clear();
        localStorage.removeItem('cadastre_proposals');
    }
};

// Multi-parcel selection state
const multiParcelSelection = {
    isActive: false,
    selectedParcels: new Set(),

    // Toggle multi-selection mode
    toggle() {
        this.isActive = !this.isActive;
        if (!this.isActive) {
            this.clearSelection();
            // Hide multi-parcel info panel if it's showing
            this.hideParcelInfo();
        } else {
            // When activating multi-selection, clear any existing single parcel selection
            this.clearSingleParcelSelection();
        }
        this.updateUI();
    },

    // Clear any currently selected single parcel
    clearSingleParcelSelection() {
        if (typeof selectedParcelId !== 'undefined' && selectedParcelId && typeof parcelLayer !== 'undefined' && parcelLayer) {
            parcelLayer.eachLayer(layer => {
                if (layer.feature && layer.feature.properties &&
                    layer.feature.properties.CESTICA_ID.toString() === selectedParcelId) {
                    // Reset to normal style based on road status
                    const isRoad = localStorage.getItem(`parcel_${selectedParcelId}_isRoad`) === 'true';
                    const globalRoadStyle = window.roadStyle || {
                        fillColor: '#00ff00', fillOpacity: 0.2, color: '#00ff00', weight: 1
                    };
                    const globalNormalStyle = window.normalStyle || {
                        fillColor: 'red', fillOpacity: 0.2, color: 'red', weight: 1
                    };
                    layer.setStyle(isRoad ? globalRoadStyle : globalNormalStyle);
                }
            });

            // Clear the global selected parcel state
            window.selectedParcelId = null;
            if (typeof currentParcel !== 'undefined') {
                window.currentParcel = null;
            }

            // Hide single parcel info panel if it's showing and showing parcel info
            const parcelInfoPanel = document.getElementById('parcel-info-panel');
            const panelTitle = document.querySelector('#parcel-info-panel h3');
            if (parcelInfoPanel && parcelInfoPanel.classList.contains('visible') &&
                panelTitle && panelTitle.textContent === 'Parcel Info') {
                if (typeof hideParcelInfoPanel === 'function') {
                    hideParcelInfoPanel();
                }
            }
        }
    },

    // Add or remove parcel from selection
    toggleParcel(parcel) {
        if (!this.isActive) return false;

        const parcelId = parcel.feature.properties.CESTICA_ID.toString();
        console.log('toggleParcel called with parcelId:', parcelId, 'current selectedParcels size:', this.selectedParcels.size);

        if (this.selectedParcels.has(parcelId)) {
            this.selectedParcels.delete(parcelId);
            this.removeParcelHighlight(parcel);
            console.log('Removed parcel', parcelId, 'new size:', this.selectedParcels.size);
        } else {
            this.selectedParcels.add(parcelId);
            this.addParcelHighlight(parcel);
            console.log('Added parcel', parcelId, 'new size:', this.selectedParcels.size);
        }

        console.log('Current selectedParcels Set:', Array.from(this.selectedParcels));
        this.updateUI();
        return true;
    },

    // Clear all selected parcels
    clearSelection() {
        // Remove highlights from all selected parcels
        this.selectedParcels.forEach(parcelId => {
            const parcel = this.findParcelById(parcelId);
            if (parcel) {
                this.removeParcelHighlight(parcel);
            }
        });
        this.selectedParcels.clear();

        // Also clear any currently selected single parcel to avoid conflicts
        if (typeof selectedParcelId !== 'undefined' && selectedParcelId && typeof parcelLayer !== 'undefined' && parcelLayer) {
            parcelLayer.eachLayer(layer => {
                if (layer.feature && layer.feature.properties && layer.feature.properties.CESTICA_ID.toString() === selectedParcelId) {
                    const isRoad = localStorage.getItem(`parcel_${selectedParcelId}_isRoad`) === 'true';
                    // Access styles from global scope (defined in parcels.js)
                    const globalRoadStyle = window.roadStyle || {
                        fillColor: '#00ff00', fillOpacity: 0.2, color: '#00ff00', weight: 1
                    };
                    const globalNormalStyle = window.normalStyle || {
                        fillColor: 'red', fillOpacity: 0.2, color: 'red', weight: 1
                    };
                    layer.setStyle(isRoad ? globalRoadStyle : globalNormalStyle);
                }
            });
            window.selectedParcelId = null;
        }

        this.updateUI();
    },

    // Find parcel layer by ID
    findParcelById(parcelId) {
        console.log('findParcelById called with:', parcelId, 'type:', typeof parcelId);
        let foundParcel = null;
        let checkedCount = 0;

        if (typeof parcelLayer !== 'undefined' && parcelLayer) {
            parcelLayer.eachLayer(layer => {
                checkedCount++;
                if (layer.feature && layer.feature.properties &&
                    layer.feature.properties.CESTICA_ID) {
                    const layerId = layer.feature.properties.CESTICA_ID.toString();
                    if (layerId === parcelId.toString()) {
                        foundParcel = layer;
                        console.log('Found matching parcel:', layerId);
                    }
                }
            });
            console.log('Checked', checkedCount, 'layers for parcel ID:', parcelId);
        } else {
            console.warn('findParcelById: parcelLayer not available');
        }

        if (!foundParcel) {
            console.warn('findParcelById: Could not find parcel with ID:', parcelId);
        }

        return foundParcel;
    },

    // Add highlight to selected parcel
    addParcelHighlight(parcel) {
        parcel.setStyle({
            fillColor: '#ff9800',
            fillOpacity: 0.6,
            color: '#f57c00',
            weight: 3
        });
        parcel.bringToFront();
    },

    // Remove highlight from parcel
    removeParcelHighlight(parcel) {
        const isRoad = localStorage.getItem(`parcel_${parcel.feature.properties.CESTICA_ID}_isRoad`) === 'true';
        // Access styles from global scope (defined in parcels.js)
        const globalRoadStyle = window.roadStyle || {
            fillColor: '#00ff00', fillOpacity: 0.2, color: '#00ff00', weight: 1
        };
        const globalNormalStyle = window.normalStyle || {
            fillColor: 'red', fillOpacity: 0.2, color: 'red', weight: 1
        };
        parcel.setStyle(isRoad ? globalRoadStyle : globalNormalStyle);
    },

    // Get selected parcels as array
    getSelectedParcels() {
        const parcels = Array.from(this.selectedParcels).map(id => this.findParcelById(id)).filter(p => p);
        console.log('getSelectedParcels called, selectedParcels size:', this.selectedParcels.size, 'found parcels:', parcels.length);
        return parcels;
    },

    // Update UI based on current selection
    updateUI() {
        const checkbox = document.getElementById('multiSelectCheckbox');
        if (checkbox) {
            checkbox.checked = this.isActive;
        }

        // Hide single-parcel proposal button when multi-select is active
        const singleParcelButton = document.getElementById('createProposalFromParcelButton');
        if (singleParcelButton) {
            if (this.isActive) {
                singleParcelButton.style.display = 'none';
            }
            // When multi-select is off, the button visibility is controlled by single parcel selection
        }

        const count = this.selectedParcels.size;
        if (count >= 2) {
            this.showMultiParcelInfo();
        } else if (count === 1 && this.isActive) {
            // Show single parcel info even in multi-select mode
            const parcels = this.getSelectedParcels();
            if (parcels.length === 1) {
                const parcel = parcels[0];
                if (typeof showParcelInfoPanel === 'function') {
                    // Reset panel title for single parcel
                    const panelTitle = document.querySelector('#parcel-info-panel h3');
                    if (panelTitle) {
                        panelTitle.textContent = 'Parcel Info';
                    }

                    // Ensure parcel-specific buttons are visible for single parcel view
                    const parcelButtons = document.querySelector('.parcel-info-buttons');
                    if (parcelButtons) {
                        parcelButtons.style.display = '';
                    }

                    // Ensure road checkbox is visible for single parcel view
                    const roadCheckboxGroup = document.querySelector('#parcel-info-panel .road-checkbox');
                    if (roadCheckboxGroup) {
                        roadCheckboxGroup.style.display = '';
                    }

                    document.getElementById('parcel-info-content').innerHTML = '';
                    showParcelInfoPanel(parcel.feature);
                    document.getElementById('parcel-info-panel').classList.add('visible');
                }
            }
        } else if (count === 0 && this.isActive) {
            this.hideParcelInfo();
        } else if (!this.isActive && count === 0) {
            // Multi-select is off and no selection - hide panel
            this.hideParcelInfo();
        }

        // Update create proposal button visibility
        this.updateCreateProposalButton();
    },

    // Show multi-parcel info panel
    showMultiParcelInfo() {
        const parcels = this.getSelectedParcels();
        const totalArea = parcels.reduce((sum, parcel) =>
            sum + (parcel.feature.properties.calculatedArea || 0), 0);
        const totalEstimatedPrice = totalArea * (typeof SQM_AVG_PRICE !== 'undefined' ? SQM_AVG_PRICE : 133);

        // Update the panel title
        const panelTitle = document.querySelector('#parcel-info-panel h3');
        if (panelTitle) {
            panelTitle.textContent = 'Multiple Parcels Selected';
        }

        // Hide parcel-specific buttons when showing multiple parcels
        const parcelButtons = document.querySelector('.parcel-info-buttons');
        if (parcelButtons) {
            parcelButtons.style.display = 'none';
        }

        // Hide road checkbox section
        const roadCheckboxGroup = document.querySelector('#parcel-info-panel .road-checkbox');
        if (roadCheckboxGroup) {
            roadCheckboxGroup.style.display = 'none';
        }

        // Clear the regular info content and use parcel-info-content for multi-parcel display
        document.getElementById('info-content').innerHTML = '';

        const content = `
            <div class="multi-parcel-actions" style="margin-bottom: 15px; text-align: center;">
                <button class="btn btn-secondary" onclick="cancelMultiParcelSelection()" style="padding: 8px 16px;">
                    Cancel Selection
                </button>
            </div>
            <div class="metric-group">
                <div class="metric-label">Selected Parcels:</div>
                <div class="metric-value">${parcels.length}</div>
            </div>
            <div class="metric-group">
                <div class="metric-label">Total Area:</div>
                <div class="metric-value">${Math.round(totalArea).toLocaleString('hr-HR')} m²</div>
            </div>
            <div class="metric-group">
                <div class="metric-label">Est. Total Value:</div>
                <div class="metric-value">${Math.round(totalEstimatedPrice).toLocaleString('hr-HR')} €</div>
            </div>
            <hr style="border: 0; height: 1px; background-color: #ddd; margin: 10px 0;">
            <div class="metric-group">
                <div class="metric-label">Selected Parcels:</div>
                <div class="selected-parcels-list">
                    ${parcels.map(parcel => {
            const area = parcel.feature.properties.calculatedArea || 0;
            const price = area * (typeof SQM_AVG_PRICE !== 'undefined' ? SQM_AVG_PRICE : 133);
            const isRoad = localStorage.getItem(`parcel_${parcel.feature.properties.CESTICA_ID}_isRoad`) === 'true';
            return `
                            <div class="selected-parcel-item">
                                <div class="parcel-number">Parcel ${parcel.feature.properties.BROJ_CESTICE}</div>
                                <div class="parcel-details">
                                    ${Math.round(area).toLocaleString('hr-HR')} m² • 
                                    ${Math.round(price).toLocaleString('hr-HR')} €
                                    ${isRoad ? ' • <span style="color: #28a745;">Road</span>' : ''}
                                </div>
                            </div>
                        `;
        }).join('')}
                </div>
            </div>
        `;

        document.getElementById('parcel-info-content').innerHTML = content;
        document.getElementById('parcel-info-panel').classList.add('visible');
    },

    // Hide parcel info panel
    hideParcelInfo() {
        // Reset the panel title back to original
        const panelTitle = document.querySelector('#parcel-info-panel h3');
        if (panelTitle) {
            panelTitle.textContent = 'Parcel Info';
        }

        // Show parcel-specific buttons again (they might have been hidden for proposal view)
        const parcelButtons = document.querySelector('.parcel-info-buttons');
        if (parcelButtons) {
            parcelButtons.style.display = '';
        }

        // Show road checkbox section again
        const roadCheckboxGroup = document.querySelector('#parcel-info-panel .road-checkbox');
        if (roadCheckboxGroup) {
            roadCheckboxGroup.style.display = '';
        }

        // Clear both content areas
        document.getElementById('info-content').innerHTML = '';
        document.getElementById('parcel-info-content').innerHTML = '';
        document.getElementById('parcel-info-panel').classList.remove('visible');

        // Clear any proposal highlights
        clearProposalHighlights();
    },

    // Update create proposal button visibility
    updateCreateProposalButton() {
        const button = document.getElementById('createProposalButton');
        if (button) {
            // Show button if we have multiple parcels selected OR a single parcel selected
            const hasMultipleParcels = this.selectedParcels.size > 0;
            const hasSingleParcel = typeof selectedParcelId !== 'undefined' && selectedParcelId &&
                typeof currentParcel !== 'undefined' && currentParcel;
            button.style.display = (hasMultipleParcels || hasSingleParcel) ? 'inline-block' : 'none';
        }
    },

    // Reapply highlights to all currently selected parcels
    reapplyMultiParcelHighlights() {
        if (!this.isActive || !this.selectedParcels || this.selectedParcels.size === 0) return;
        this.selectedParcels.forEach(parcelId => {
            const parcel = this.findParcelById(parcelId);
            if (parcel) {
                this.addParcelHighlight(parcel);
            }
        });
    }
};

// Proposal layer management
let proposalLayer = null;

function updateProposalLayer() {
    // Remove existing proposal layer
    if (proposalLayer) {
        map.removeLayer(proposalLayer);
        proposalLayer = null;
    }

    const showProposals = document.getElementById('showProposalsCheckbox')?.checked;

    if (!showProposals) {
        // Disable proposal click interception when proposals are hidden
        disableProposalClickInterception();
        return;
    }

    // Enable proposal click interception when proposals are shown
    enableProposalClickInterception();

    proposalLayer = L.featureGroup().addTo(map);

    // Add all proposals to the layer
    proposalStorage.getAllProposals().forEach(proposal => {
        proposal.parcelIds.forEach(parcelId => {
            const parcel = multiParcelSelection.findParcelById(parcelId);
            if (parcel) {
                // Create hatched pattern for proposal parcels
                const proposalStyle = {
                    fillColor: '#4caf50',
                    fillOpacity: 0.3,
                    color: '#2e7d32',
                    weight: 2,
                    dashArray: '5, 5'
                };

                const proposalParcel = L.geoJSON(parcel.toGeoJSON(), {
                    style: proposalStyle,
                    onEachFeature: function (feature, layer) {
                        layer.proposalHash = proposal.proposalHash;
                        layer.on('click', function (e) {
                            handleProposalParcelClick(parcelId);
                            L.DomEvent.stopPropagation(e);
                        });
                    }
                });

                proposalParcel.addTo(proposalLayer);
            }
        });
    });

    // Update status
    const proposalCount = proposalStorage.getAllProposals().length;
    if (proposalCount > 0) {
        updateStatus(`Showing ${proposalCount} proposal${proposalCount > 1 ? 's' : ''} on map`);
    }
}

// Handle clicks on proposal parcels
function handleProposalParcelClick(parcelId) {
    // Clear any currently selected single parcel to avoid conflicts
    multiParcelSelection.clearSingleParcelSelection();

    const proposals = proposalStorage.getProposalsForParcel(parcelId);

    if (proposals.length === 1) {
        const proposal = proposals[0];

        // Highlight all parcels in the proposal
        highlightProposalParcels(proposal);

        // Center map on all parcels in the proposal
        centerMapOnProposal(proposal);

        // Show proposal info
        showProposalInfo(proposal);

    } else if (proposals.length > 1) {
        showMultipleProposalsForParcel(proposals, parcelId);
    }
}

// Proposal highlighting state
let currentlyHighlightedProposal = null;

// Highlight all parcels in a proposal
function highlightProposalParcels(proposal) {
    // Clear any existing highlights first
    clearProposalHighlights();

    // Store the currently highlighted proposal
    currentlyHighlightedProposal = proposal;

    applyProposalHighlights();
}

// Apply proposal highlights (can be called repeatedly)
function applyProposalHighlights() {
    if (!currentlyHighlightedProposal) return;

    const highlightStyle = {
        fillColor: '#4caf50',
        fillOpacity: 0.6,
        color: '#2e7d32',
        weight: 4,
        dashArray: '5, 5'
    };

    window.proposalHighlights = [];

    currentlyHighlightedProposal.parcelIds.forEach(parcelId => {
        const parcel = multiParcelSelection.findParcelById(parcelId);
        if (parcel) {
            // Store original style if not already stored
            if (!parcel._originalProposalStyle) {
                const isRoad = localStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
                // Access styles from global scope (defined in parcels.js)
                const globalRoadStyle = window.roadStyle || {
                    fillColor: '#00ff00', fillOpacity: 0.2, color: '#00ff00', weight: 1
                };
                const globalNormalStyle = window.normalStyle || {
                    fillColor: 'red', fillOpacity: 0.2, color: 'red', weight: 1
                };

                parcel._originalProposalStyle = isRoad ? {
                    fillColor: globalRoadStyle.fillColor,
                    fillOpacity: globalRoadStyle.fillOpacity,
                    color: globalRoadStyle.color,
                    weight: globalRoadStyle.weight,
                    dashArray: globalRoadStyle.dashArray
                } : {
                    fillColor: globalNormalStyle.fillColor,
                    fillOpacity: globalNormalStyle.fillOpacity,
                    color: globalNormalStyle.color,
                    weight: globalNormalStyle.weight,
                    dashArray: globalNormalStyle.dashArray
                };
            }

            // Apply highlight style
            parcel.setStyle(highlightStyle);
            parcel.bringToFront();
            window.proposalHighlights.push(parcel);
        }
    });
}

// Clear proposal highlights
function clearProposalHighlights() {
    currentlyHighlightedProposal = null;

    if (window.proposalHighlights) {
        window.proposalHighlights.forEach(parcel => {
            if (parcel._originalProposalStyle) {
                parcel.setStyle(parcel._originalProposalStyle);
                delete parcel._originalProposalStyle; // Clean up
            } else {
                // Fallback to determining style based on road status
                const parcelId = parcel.feature.properties.CESTICA_ID;
                const isRoad = localStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
                // Access styles from global scope (defined in parcels.js)
                const globalRoadStyle = window.roadStyle || {
                    fillColor: '#00ff00', fillOpacity: 0.2, color: '#00ff00', weight: 1
                };
                const globalNormalStyle = window.normalStyle || {
                    fillColor: 'red', fillOpacity: 0.2, color: 'red', weight: 1
                };
                parcel.setStyle(isRoad ? globalRoadStyle : globalNormalStyle);
            }
        });
        window.proposalHighlights = [];
    }
}

// Function to re-apply highlights after parcel layer updates
function reapplyProposalHighlights() {
    if (currentlyHighlightedProposal) {
        // Small delay to ensure parcel layer is fully updated
        setTimeout(() => {
            applyProposalHighlights();
        }, 100);
    }
}

// Center map on all parcels in a proposal
function centerMapOnProposal(proposal) {
    const parcels = proposal.parcelIds.map(id => multiParcelSelection.findParcelById(id)).filter(p => p);
    if (parcels.length === 0) return;

    // Calculate bounds of all parcels in the proposal
    const bounds = L.latLngBounds();
    parcels.forEach(parcel => {
        bounds.extend(parcel.getBounds());
    });

    // Fit map to proposal bounds with padding
    map.fitBounds(bounds, { padding: [50, 50] });
}

// Override the parcel click when proposals are shown
let originalOnParcelClick = null;

function enableProposalClickInterception() {
    if (!originalOnParcelClick && typeof onParcelClick === 'function') {
        originalOnParcelClick = onParcelClick;

        // Override the global onParcelClick function
        window.onParcelClick = function (e) {
            const showProposals = document.getElementById('showProposalsCheckbox')?.checked;
            if (showProposals) {
                const parcelId = e.target.feature?.properties?.CESTICA_ID?.toString();
                if (parcelId) {
                    const proposals = proposalStorage.getProposalsForParcel(parcelId);
                    if (proposals.length > 0) {
                        // Clear any existing proposal highlights
                        clearProposalHighlights();

                        handleProposalParcelClick(parcelId);
                        L.DomEvent.stopPropagation(e);
                        return;
                    }
                }
            }

            // If not a proposal parcel or proposals not shown, use original handler
            if (originalOnParcelClick && typeof originalOnParcelClick === 'function') {
                originalOnParcelClick.call(this, e);
            }
        };
    }
}

function disableProposalClickInterception() {
    if (originalOnParcelClick && typeof originalOnParcelClick === 'function') {
        window.onParcelClick = originalOnParcelClick;
        originalOnParcelClick = null;
    }

    // Clear any proposal highlights when disabling
    clearProposalHighlights();

    // Re-attach the onParcelClick handler to all parcel layers
    if (typeof parcelLayer !== 'undefined' && parcelLayer) {
        parcelLayer.eachLayer(layer => {
            layer.off('click');
            layer.on('click', onParcelClick);
            layer.options.interactive = true;
            if (layer._path) {
                L.DomUtil.removeClass(layer._path, 'leaflet-disabled');
                layer._path.style.pointerEvents = 'auto';
            }
        });
    }
}

// Show proposal info panel
function showProposalInfo(proposal) {
    const parcels = proposal.parcelIds.map(id => multiParcelSelection.findParcelById(id)).filter(p => p);
    const totalArea = parcels.reduce((sum, parcel) =>
        sum + (parcel.feature.properties.calculatedArea || 0), 0);

    // Update the panel title
    const panelTitle = document.querySelector('#parcel-info-panel h3');
    if (panelTitle) {
        panelTitle.textContent = 'Proposal Details';
    }

    // Hide parcel-specific buttons when showing proposal info
    const parcelButtons = document.querySelector('.parcel-info-buttons');
    if (parcelButtons) {
        parcelButtons.style.display = 'none';
    }

    // Hide road checkbox section
    const roadCheckboxGroup = document.querySelector('#parcel-info-panel .road-checkbox');
    if (roadCheckboxGroup) {
        roadCheckboxGroup.style.display = 'none';
    }

    // Clear the regular info content and use parcel-info-content for proposal display
    document.getElementById('info-content').innerHTML = '';

    const content = `
        <div class="proposal-info">
            <div class="proposal-header">
                <h4>${proposal.title}</h4>
                <div class="proposal-hash">ID: ${proposal.proposalHash}</div>
            </div>
            <div class="metric-group">
                <div class="metric-label">Author:</div>
                <div class="metric-value">${proposal.author}</div>
            </div>
            <div class="metric-group">
                <div class="metric-label">Description:</div>
                <div class="metric-value">${proposal.description}</div>
            </div>
            <div class="metric-group">
                <div class="metric-label">Offer:</div>
                <div class="metric-value">€${proposal.offer.toLocaleString('hr-HR')}</div>
            </div>
            <div class="metric-group">
                <div class="metric-label">Parcels in Proposal:</div>
                <div class="metric-value">${proposal.parcelIds.length}</div>
            </div>
            <div class="metric-group">
                <div class="metric-label">Total Area:</div>
                <div class="metric-value">${Math.round(totalArea).toLocaleString('hr-HR')} m²</div>
            </div>
            <div class="metric-group">
                <div class="metric-label">Created:</div>
                <div class="metric-value">${new Date(proposal.createdAt).toLocaleDateString()}</div>
            </div>
            <hr style="border: 0; height: 1px; background-color: #ddd; margin: 10px 0;">
            <div class="metric-group">
                <div class="metric-label">Parcels:</div>
                <div class="proposal-parcels-list">
                    ${parcels.map(parcel => {
        const area = parcel.feature.properties.calculatedArea || 0;
        const isRoad = localStorage.getItem(`parcel_${parcel.feature.properties.CESTICA_ID}_isRoad`) === 'true';
        return `
                            <div class="proposal-parcel-item">
                                <span class="parcel-number">Parcel ${parcel.feature.properties.BROJ_CESTICE}</span>
                                <span class="parcel-details">
                                    ${Math.round(area).toLocaleString('hr-HR')} m²
                                    ${isRoad ? ' • <span style="color: #28a745;">Road</span>' : ''}
                                </span>
                            </div>
                        `;
    }).join('')}
                </div>
            </div>
        </div>
    `;

    document.getElementById('parcel-info-content').innerHTML = content;
    document.getElementById('parcel-info-panel').classList.add('visible');
}

// Show proposal list in parcel info panel
function showMultipleProposalsForParcel(proposals, parcelId) {
    // Update the panel title
    const panelTitle = document.querySelector('#parcel-info-panel h3');
    if (panelTitle) {
        panelTitle.textContent = 'Multiple Proposals Found';
    }

    // Hide parcel-specific buttons when showing multiple proposals
    const parcelButtons = document.querySelector('.parcel-info-buttons');
    if (parcelButtons) {
        parcelButtons.style.display = 'none';
    }

    // Hide road checkbox section
    const roadCheckboxGroup = document.querySelector('#parcel-info-panel .road-checkbox');
    if (roadCheckboxGroup) {
        roadCheckboxGroup.style.display = 'none';
    }

    // Clear the regular info content
    document.getElementById('info-content').innerHTML = '';

    // Find the parcel to get its number for display
    const parcel = multiParcelSelection.findParcelById(parcelId);
    const parcelNumber = parcel?.feature?.properties?.BROJ_CESTICE || parcelId;

    const content = `
        <div class="multiple-proposals-info">
            <div class="multiple-proposals-header">
                <div class="emphasis-message">
                    <i class="fas fa-exclamation-triangle" style="color: #ff9800; margin-right: 8px;"></i>
                    <strong>Parcel ${parcelNumber} is part of multiple proposals</strong>
                </div>
                <p style="margin: 10px 0; font-size: 13px; color: #666;">
                    This parcel appears in ${proposals.length} different proposals. 
                    Click on any proposal below to view its details and highlight all parcels in that proposal.
                </p>
            </div>
            <div class="proposals-container">
                ${proposals.map(proposal => `
                    <div class="proposal-item" onclick="selectProposalFromList('${proposal.proposalHash}', '${parcelId}')">
                        <div class="proposal-item-header">
                            <div class="proposal-title">${proposal.title}</div>
                            <div class="proposal-offer">€${proposal.offer.toLocaleString('hr-HR')}</div>
                        </div>
                        <div class="proposal-meta">
                            <span class="proposal-author">by ${proposal.author}</span>
                            <span class="proposal-parcels">${proposal.parcelIds.length} parcel${proposal.parcelIds.length > 1 ? 's' : ''}</span>
                            <span class="proposal-date">${new Date(proposal.createdAt).toLocaleDateString()}</span>
                        </div>
                        <div class="proposal-description">
                            ${proposal.description.length > 80
            ? proposal.description.substring(0, 80) + '...'
            : proposal.description}
                        </div>
                    </div>
                `).join('')}
            </div>
            <div class="multiple-proposals-footer">
                <p style="font-size: 12px; color: #888; margin: 10px 0 0 0;">
                    <i class="fas fa-info-circle" style="margin-right: 4px;"></i>
                    To create a new proposal or modify existing ones, use the proposal controls in the sidebar.
                </p>
            </div>
        </div>
    `;

    document.getElementById('parcel-info-content').innerHTML = content;
    document.getElementById('parcel-info-panel').classList.add('visible');
}

// Show proposal creation dialog
function showProposalDialog() {
    console.log('showProposalDialog called, selectedParcels size:', multiParcelSelection.selectedParcels.size);
    console.log('selectedParcels contents:', Array.from(multiParcelSelection.selectedParcels));

    let selectedParcels = [];
    let parcelIds = [];

    // Check if we have multi-selected parcels
    if (multiParcelSelection.selectedParcels.size > 0) {
        selectedParcels = multiParcelSelection.getSelectedParcels();
        parcelIds = Array.from(multiParcelSelection.selectedParcels);
    }
    // Check if we have a single parcel selected
    else if (typeof selectedParcelId !== 'undefined' && selectedParcelId && typeof currentParcel !== 'undefined' && currentParcel) {
        selectedParcels = [currentParcel.layer];
        parcelIds = [selectedParcelId];
        console.log('Using single selected parcel:', selectedParcelId);
    }

    if (selectedParcels.length === 0) {
        updateStatus('Please select at least one parcel to create a proposal.');
        return;
    }

    console.log('Selected parcels for proposal:', selectedParcels);
    console.log('Selected parcel IDs:', parcelIds);

    const totalArea = selectedParcels.reduce((sum, parcel) => {
        const area = parcel.feature?.properties?.calculatedArea || 0;
        return sum + area;
    }, 0);

    // Create parcel list HTML with error handling
    const parcelListHTML = selectedParcels.map(parcel => {
        const parcelNumber = parcel.feature?.properties?.BROJ_CESTICE || 'Unknown';
        const area = parcel.feature?.properties?.calculatedArea || 0;
        console.log('Processing parcel for list:', parcelNumber, 'area:', area);
        return `
            <div class="proposal-parcel-item">
                <span class="parcel-number">Parcel ${parcelNumber}</span>
                <span class="parcel-area">(${Math.round(area).toLocaleString('hr-HR')} m²)</span>
            </div>
        `;
    }).join('');

    console.log('Final parcelListHTML length:', parcelListHTML.length, 'selectedParcels.length:', selectedParcels.length);

    // Create modal dialog
    const modal = document.createElement('div');
    modal.className = 'proposal-modal';
    modal.innerHTML = `
        <div class="proposal-modal-content">
            <div class="proposal-modal-header">
                <h2>Create Proposal</h2>
                <button class="proposal-modal-close" onclick="closeProposalDialog()">&times;</button>
            </div>
            <div class="proposal-modal-body">
                <div class="form-group">
                    <label for="proposalAuthor">Author:</label>
                    <input type="text" id="proposalAuthor" placeholder="Your name">
                </div>
                <div class="form-group">
                    <label for="proposalType">Proposal Type:</label>
                    <select id="proposalType">
                        <option value="Road">Road</option>
                        <option value="Park">Park</option>
                        <option value="Square" selected>Square</option>
                        <option value="Residences">Residences</option>
                        <option value="Commercial">Commercial</option>
                        <option value="Industrial">Industrial</option>
                        <option value="Mixed">Mixed</option>
                        <option value="Other">Other</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="proposalDescription">Description:</label>
                    <textarea id="proposalDescription" rows="4" placeholder="Describe your proposal..."></textarea>
                </div>
                <div class="form-group">
                    <label for="proposalOffer">Offer (EUR):</label>
                    <input type="number" id="proposalOffer" placeholder="0" min="0" step="0.01">
                </div>
                <div class="proposal-summary collapsible collapsed" id="proposalSummarySection">
                    <div class="collapsible-header" tabindex="0" role="button" aria-expanded="false" aria-controls="proposalSummaryContent" onclick="(function(e){
                        var section = document.getElementById('proposalSummarySection');
                        var content = document.getElementById('proposalSummaryContent');
                        var icon = document.getElementById('proposalSummaryChevron');
                        var expanded = section.classList.toggle('collapsed');
                        if (section.classList.contains('collapsed')) {
                            content.style.display = 'none';
                            icon.classList.remove('fa-chevron-up');
                            icon.classList.add('fa-chevron-down');
                            section.setAttribute('aria-expanded', 'false');
                        } else {
                            content.style.display = '';
                            icon.classList.remove('fa-chevron-down');
                            icon.classList.add('fa-chevron-up');
                            section.setAttribute('aria-expanded', 'true');
                        }
                    })(event)">
                        <h3 style="display:inline; font-size: 1.1em; font-weight: 600; margin:0;">Proposal Summary</h3>
                        <i id="proposalSummaryChevron" class="fas fa-chevron-down" style="margin-left: 8px;"></i>
                    </div>
                    <div id="proposalSummaryContent" style="display:none;">
                        <div class="summary-stats">
                            <p><strong>Parcels Selected:</strong> ${selectedParcels.length}</p>
                            <p><strong>Total Area:</strong> ${Math.round(totalArea).toLocaleString('hr-HR')} m²</p>
                        </div>
                        <div class="parcel-list">
                            <h4>Selected Parcels:</h4>
                            ${parcelListHTML}
                        </div>
                    </div>
                </div>
            </div>
            <div class="proposal-modal-footer">
                <button class="btn btn-secondary" onclick="closeProposalDialog()">Cancel</button>
                <button class="btn btn-proposal" onclick="createProposal()">Create Proposal</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // Pre-fill the author field with current username
    const authorInput = document.getElementById('proposalAuthor');
    if (typeof getCurrentUsername === 'function') {
        const username = getCurrentUsername();
        if (username) {
            authorInput.value = username;
        }
    }

    // Focus on description field since author and type are pre-filled
    document.getElementById('proposalDescription').focus();
}

// Close proposal dialog
function closeProposalDialog() {
    const modal = document.querySelector('.proposal-modal');
    if (modal) {
        modal.remove();
    }
}

// Create proposal from dialog
function createProposal() {
    const author = document.getElementById('proposalAuthor').value.trim();
    const proposalType = document.getElementById('proposalType').value;
    const description = document.getElementById('proposalDescription').value.trim();
    const offer = parseFloat(document.getElementById('proposalOffer').value) || 0;

    // Validation
    if (!author) {
        alert('Please enter an author name.');
        return;
    }
    if (!proposalType) {
        alert('Please select a proposal type.');
        return;
    }
    if (!description) {
        alert('Please enter a description.');
        return;
    }
    if (offer <= 0) {
        alert('Please enter a valid offer amount.');
        return;
    }

    try {
        // Get the parcelIds that were determined in showProposalDialog
        let finalParcelIds = [];

        if (multiParcelSelection.selectedParcels.size > 0) {
            finalParcelIds = Array.from(multiParcelSelection.selectedParcels);
        } else if (typeof selectedParcelId !== 'undefined' && selectedParcelId) {
            finalParcelIds = [selectedParcelId];
        }

        if (finalParcelIds.length === 0) {
            alert('No parcels selected. Please select parcels before creating a proposal.');
            return;
        }

        const proposal = {
            author,
            title: proposalType, // Use proposal type as the title
            description,
            offer,
            parcelIds: finalParcelIds,
            type: 'parcel' // For future extension to road/building proposals
        };

        const hash = proposalStorage.addProposal(proposal);

        // Auto-check the show proposals checkbox
        const showProposalsCheckbox = document.getElementById('showProposalsCheckbox');
        if (showProposalsCheckbox && !showProposalsCheckbox.checked) {
            showProposalsCheckbox.checked = true;
        }

        // Update proposal layer
        updateProposalLayer();

        // Clear selection - both multi-select and single select
        multiParcelSelection.clearSelection();
        if (typeof hideParcelInfoPanel === 'function') {
            hideParcelInfoPanel();
        }

        // Close dialog
        closeProposalDialog();

        // Update proposal list if open
        updateProposalList();

        updateStatus(`Proposal "${proposalType}" created successfully with ${proposal.parcelIds.length} parcels.`);

    } catch (error) {
        alert(error.message);
    }
}

// Show proposal list dialog
function showAllProposalsModal() {
    const proposals = proposalStorage.getAllProposals();

    // Create or update proposal list modal
    let modal = document.querySelector('.proposal-list-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.className = 'proposal-list-modal';
        document.body.appendChild(modal);
    }

    modal.innerHTML = `
        <div class="proposal-list-modal-content">
            <div class="proposal-list-modal-header">
                <h2>Parcel Proposals</h2>
                <button class="proposal-list-modal-close" onclick="closeProposalList()">&times;</button>
            </div>
            <div class="proposal-list-modal-body">
                ${proposals.length === 0 ?
            '<p>No proposals created yet.</p>' :
            proposals.map(proposal => `
                        <div class="proposal-list-item" onclick="centerOnProposal('${proposal.proposalHash}')">
                            <div class="proposal-list-title">${proposal.title}</div>
                            <div class="proposal-list-meta">
                                ${proposal.parcelIds.length} parcel${proposal.parcelIds.length > 1 ? 's' : ''} • 
                                €${proposal.offer.toLocaleString('hr-HR')} • 
                                ${proposal.author}
                            </div>
                        </div>
                    `).join('')
        }
            </div>
        </div>
    `;

    modal.style.display = 'block';
}

// Close proposal list dialog
function closeProposalList() {
    const modal = document.querySelector('.proposal-list-modal');
    if (modal) {
        modal.style.display = 'none';
    }
}

// Update proposal list (if open)
function updateProposalList() {
    const modal = document.querySelector('.proposal-list-modal');
    if (modal && modal.style.display === 'block') {
        showAllProposalsModal();
    }
}

// Center map on proposal
function centerOnProposal(proposalHash) {
    const proposal = proposalStorage.getProposal(proposalHash);
    if (!proposal) return;

    const parcels = proposal.parcelIds.map(id => multiParcelSelection.findParcelById(id)).filter(p => p);
    if (parcels.length === 0) return;

    // Calculate bounds of all parcels in the proposal
    const bounds = L.latLngBounds(parcels.map(p => p.getBounds()));

    // Fit map to proposal bounds
    map.fitBounds(bounds, { padding: [50, 50] });

    // Temporarily highlight proposal parcels
    const highlightStyle = {
        fillColor: '#ffeb3b',
        fillOpacity: 0.7,
        color: '#f57f17',
        weight: 3
    };

    const tempHighlights = [];
    parcels.forEach(parcel => {
        const highlight = L.geoJSON(parcel.toGeoJSON(), {
            style: highlightStyle,
            interactive: false
        }).addTo(map);
        tempHighlights.push(highlight);
    });

    // Remove highlights after 3 seconds
    setTimeout(() => {
        tempHighlights.forEach(highlight => map.removeLayer(highlight));
    }, 3000);

    updateStatus(`Centered on proposal "${proposal.title}"`);
}

// Clear all proposals from localStorage
function clearLocalProposalData() {
    // Show confirmation dialog
    const confirmClear = confirm(
        'This will permanently delete all proposals from local storage. ' +
        'This action cannot be undone. Are you sure you want to continue?'
    );

    if (!confirmClear) {
        return;
    }

    try {
        // Get count of proposals before clearing
        const proposalCount = proposalStorage.getAllProposals().length;

        // Clear all proposals from storage
        proposalStorage.clear();

        // Clear any proposal highlights
        clearProposalHighlights();

        // Hide and clear the proposal layer
        if (proposalLayer) {
            map.removeLayer(proposalLayer);
            proposalLayer = null;
        }

        // Disable proposal click interception
        disableProposalClickInterception();

        // Uncheck the show proposals checkbox
        const showProposalsCheckbox = document.getElementById('showProposalsCheckbox');
        if (showProposalsCheckbox) {
            showProposalsCheckbox.checked = false;
        }

        // Hide any open proposal info panel
        const parcelInfoPanel = document.getElementById('parcel-info-panel');
        if (parcelInfoPanel && parcelInfoPanel.classList.contains('visible')) {
            const panelTitle = document.querySelector('#parcel-info-panel h3');
            if (panelTitle && panelTitle.textContent === 'Proposal Details') {
                if (typeof hideParcelInfoPanel === 'function') {
                    hideParcelInfoPanel();
                } else {
                    // Fallback manual hiding
                    parcelInfoPanel.classList.remove('visible');
                    const infoContent = document.getElementById('info-content');
                    const parcelInfoContent = document.getElementById('parcel-info-content');
                    if (infoContent) infoContent.innerHTML = '';
                    if (parcelInfoContent) parcelInfoContent.innerHTML = '';
                }
            }
        }

        // Close proposal list modal if open
        closeProposalList();

        // Update status
        updateStatus(`Cleared ${proposalCount} proposal${proposalCount !== 1 ? 's' : ''} from local storage`);

    } catch (error) {
        console.error('Error clearing proposal data:', error);
        updateStatus('Error clearing proposal data. Please try again.');
    }
}

// Load proposals when page loads
proposalStorage.load();

// Make functions available globally
window.showProposalDialog = showProposalDialog;
window.closeProposalDialog = closeProposalDialog;
window.createProposal = createProposal;
window.showAllProposalsModal = showAllProposalsModal;
window.closeProposalList = closeProposalList;
window.updateProposalLayer = updateProposalLayer;
window.clearLocalProposalData = clearLocalProposalData;
window.centerOnProposal = centerOnProposal;
window.reapplyProposalHighlights = reapplyProposalHighlights;
window.selectProposalFromList = selectProposalFromList;
window.cancelMultiParcelSelection = cancelMultiParcelSelection;

// Handle selection of a proposal from the multiple proposals list
function selectProposalFromList(proposalHash, parcelId) {
    const proposal = proposalStorage.getProposal(proposalHash);
    if (!proposal) {
        console.error('Proposal not found:', proposalHash);
        updateStatus('Error: Proposal not found');
        return;
    }

    // Clear any existing proposal highlights
    clearProposalHighlights();

    // Highlight all parcels in the selected proposal
    highlightProposalParcels(proposal);

    // Center map on all parcels in the proposal
    centerMapOnProposal(proposal);

    // Show proposal info
    showProposalInfo(proposal);

    // Update status to indicate which proposal was selected
    updateStatus(`Selected proposal "${proposal.title}" (contains ${proposal.parcelIds.length} parcels)`);
}

// Cancel multi-parcel selection
function cancelMultiParcelSelection() {
    multiParcelSelection.clearSelection();
    updateStatus('Multi-parcel selection cleared');
}

// Set up map event listeners to reapply multi-parcel highlights after move/zoom
function setupMultiParcelHighlightListeners() {
    if (typeof map !== 'undefined' && map && typeof map.on === 'function') {
        map.on('moveend zoomend', function () {
            if (multiParcelSelection.isActive && multiParcelSelection.selectedParcels.size > 0) {
                multiParcelSelection.reapplyMultiParcelHighlights();
            }
        });
        return true;
    }
    return false;
}

// Try to set up listeners immediately, or retry until map is available
if (!setupMultiParcelHighlightListeners()) {
    document.addEventListener('DOMContentLoaded', function () {
        let attempts = 0;
        const maxAttempts = 20;
        const interval = setInterval(() => {
            if (setupMultiParcelHighlightListeners() || ++attempts > maxAttempts) {
                clearInterval(interval);
            }
        }, 200);
    });
} 