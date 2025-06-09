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
                // Ensure backward compatibility - add acceptedParcelIds if missing
                if (!proposalData.acceptedParcelIds) {
                    proposalData.acceptedParcelIds = [];
                }
                this.proposals.set(hash, proposalData);
            });
        }
    },

    // Add a new proposal
    addProposal(proposal) {
        const hash = this.generateProposalHash(proposal);
        if (this.proposals.has(hash)) {
            throw new Error('This exact proposal already exists');
        }
        proposal.proposalHash = hash;
        proposal.createdAt = new Date().toISOString();
        this.proposals.set(hash, proposal);
        this.save();
        return hash;
    },

    // Generate hash based on proposal content - includes geometry for design-based proposals
    generateProposalHash(proposal) {
        const sortedIds = [...proposal.parcelIds].sort().join(',');
        let content = `${sortedIds}|${proposal.type}`;

        // For proposals with geometry, include geometry in hash to allow different designs
        if (proposal.roadGeometry && proposal.roadGeometry.polygon) {
            // For road proposals, include the road coordinates
            const coords = proposal.roadGeometry.polygon.coordinates[0];
            const coordsString = coords.map(c => `${c[0].toFixed(6)},${c[1].toFixed(6)}`).join(';');
            content += `|road:${coordsString}`;
        } else if (proposal.buildingGeometry) {
            // For building proposals, include building geometry
            const geomString = JSON.stringify(proposal.buildingGeometry);
            content += `|building:${geomString}`;
        } else {
            // For simple conversion proposals without geometry, include title to prevent exact duplicates
            content += `|${proposal.title}`;
        }

        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
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

            // Also remove any executed building associated with this proposal
            if (typeof removeExecutedBuildingByProposalHash === 'function') {
                removeExecutedBuildingByProposalHash(hash);
            }
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

                    // Reset style
                    const isRoad = localStorage.getItem(`parcel_${selectedParcelId}_isRoad`) === 'true';
                    const globalRoadStyle = window.roadStyle || { fillColor: '#00ff00', fillOpacity: 0.2, color: '#00ff00', weight: 1 };
                    const globalNormalStyle = window.normalStyle || { fillColor: 'red', fillOpacity: 0.2, color: 'red', weight: 1 };
                    layer.setStyle(isRoad ? globalRoadStyle : globalNormalStyle);

                    // ALWAYS use the authoritative function to re-attach the click handler
                    layer.off('click').on('click', getCorrectClickHandler());
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

// --- Proposal Color Palette ---
const PROPOSAL_COLORS = [
    '#4caf50', // green
    '#2196f3', // blue
    '#ff9800', // orange
    '#e91e63', // pink
    '#9c27b0', // purple
    '#f44336', // red
    '#00bcd4', // cyan
    '#8bc34a', // light green
    '#ffc107', // amber
    '#795548', // brown
    '#607d8b', // blue grey
];
function getProposalColor(hash) {
    // Simple hash to color mapping
    let sum = 0;
    for (let i = 0; i < hash.length; i++) sum += hash.charCodeAt(i);
    return PROPOSAL_COLORS[sum % PROPOSAL_COLORS.length];
}
function blendColors(colors) {
    // Simple average RGB blend
    if (colors.length === 1) return colors[0];
    let r = 0, g = 0, b = 0;
    colors.forEach(hex => {
        const c = hex.replace('#', '');
        r += parseInt(c.substring(0, 2), 16);
        g += parseInt(c.substring(2, 4), 16);
        b += parseInt(c.substring(4, 6), 16);
    });
    r = Math.floor(r / colors.length);
    g = Math.floor(g / colors.length);
    b = Math.floor(b / colors.length);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// --- Enhanced Proposal Layer Management ---
// Store road proposal polygons so we can remove them
window.roadProposalPolygons = window.roadProposalPolygons || [];

// Store checkmark markers so we can remove them
window.proposalCheckmarkMarkers = window.proposalCheckmarkMarkers || [];

function updateProposalLayer() {
    const showProposalsCheckbox = document.getElementById('showProposalsCheckbox');
    const show = showProposalsCheckbox ? showProposalsCheckbox.checked : false;
    if (typeof parcelLayer !== 'undefined' && parcelLayer) {
        if (show) {
            parcelLayer.eachLayer(layer => {
                layer.off('click', onParcelClick).on('click', proposalAwareParcelClickHandler);
                const parcelId = layer.feature.properties.CESTICA_ID.toString();
                const proposals = proposalStorage.getProposalsForParcel(parcelId).filter(p => p.status !== 'Executed');
                if (proposals.length > 0) {
                    const colors = proposals.map(p => getProposalColor(p.proposalHash));
                    const fillColor = blendColors(colors);
                    const fillOpacity = Math.max(0.25, 0.5 - 0.1 * (proposals.length - 1));
                    layer.setStyle({
                        fillColor,
                        fillOpacity,
                        color: '#222',
                        weight: 3,
                        dashArray: '5, 5',
                    });
                } else {
                    const isRoad = localStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
                    const globalRoadStyle = window.roadStyle || { fillColor: '#00ff00', fillOpacity: 0.2, color: '#00ff00', weight: 1 };
                    const globalNormalStyle = window.normalStyle || { fillColor: 'red', fillOpacity: 0.2, color: 'red', weight: 1 };
                    layer.setStyle(isRoad ? globalRoadStyle : globalNormalStyle);
                }
            });
            // Draw road polygons for proposals with roadGeometry
            // Remove any previous road proposal polygons
            if (window.roadProposalPolygons && Array.isArray(window.roadProposalPolygons)) {
                window.roadProposalPolygons.forEach(poly => map.removeLayer(poly));
            }
            window.roadProposalPolygons = [];
            // Remove any previous building proposal polygons
            if (window.buildingProposalPolygons && Array.isArray(window.buildingProposalPolygons)) {
                window.buildingProposalPolygons.forEach(poly => map.removeLayer(poly));
            }
            window.buildingProposalPolygons = [];
            proposalStorage.getAllProposals().filter(p => p.status !== 'Executed').forEach(proposal => {
                // Road polygons
                if (proposal.roadGeometry && proposal.roadGeometry.polygon && proposal.roadGeometry.polygon.coordinates) {
                    const coordinates = proposal.roadGeometry.polygon.coordinates[0];
                    const latLngs = coordinates.map(coord => [coord[1], coord[0]]); // [lng, lat] to [lat, lng]
                    const color = getProposalColor(proposal.proposalHash);
                    const roadPolygon = L.polygon(latLngs, {
                        fillColor: color,
                        fillOpacity: 0.4,
                        color: color,
                        weight: 4,
                        dashArray: '10, 5',
                        interactive: false
                    }).addTo(map);
                    window.roadProposalPolygons.push(roadPolygon);
                }
                // Building polygons
                if (proposal.buildingGeometry && (proposal.buildingGeometry.type === 'Polygon' || proposal.buildingGeometry.type === 'MultiPolygon')) {
                    const color = getProposalColor(proposal.proposalHash);
                    const buildingLayer = L.geoJSON(proposal.buildingGeometry, {
                        style: {
                            fillColor: color,
                            fillOpacity: 0.4,
                            color: color,
                            weight: 2,
                            dashArray: '4, 4',
                            interactive: false
                        }
                    }).addTo(map);
                    window.buildingProposalPolygons.push(buildingLayer);
                }
            });

            // Clean up previous acceptance highlight layers
            if (window.acceptanceHighlightLayers && Array.isArray(window.acceptanceHighlightLayers)) {
                window.acceptanceHighlightLayers.forEach(layer => map.removeLayer(layer));
            }
            window.acceptanceHighlightLayers = [];

            // Add acceptance overlays for all proposals
            proposalStorage.getAllProposals().filter(p => p.status !== 'Executed').forEach(proposal => {
                if (proposal.acceptedParcelIds && proposal.acceptedParcelIds.length > 0) {
                    const proposalColor = getProposalColor(proposal.proposalHash);
                    proposal.acceptedParcelIds.forEach(parcelId => {
                        const parcel = multiParcelSelection.findParcelById(parcelId);
                        if (parcel) {
                            const acceptanceOverlay = L.polygon(parcel.getLatLngs(), {
                                fillColor: proposalColor,
                                fillOpacity: 0.6,
                                stroke: true,
                                color: proposalColor,
                                weight: 3,
                                interactive: false
                            }).addTo(map);
                            window.acceptanceHighlightLayers.push(acceptanceOverlay);
                        }
                    });
                }
            });
        } else {
            parcelLayer.eachLayer(layer => {
                layer.off('click', proposalAwareParcelClickHandler).on('click', onParcelClick);
                const parcelId = layer.feature.properties.CESTICA_ID.toString();
                const isRoad = localStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
                const globalRoadStyle = window.roadStyle || { fillColor: '#00ff00', fillOpacity: 0.2, color: '#00ff00', weight: 1 };
                const globalNormalStyle = window.normalStyle || { fillColor: 'red', fillOpacity: 0.2, color: 'red', weight: 1 };
                layer.setStyle(isRoad ? globalRoadStyle : globalNormalStyle);
            });
            clearProposalHighlights();
            // Remove road proposal polygons
            if (window.roadProposalPolygons && Array.isArray(window.roadProposalPolygons)) {
                window.roadProposalPolygons.forEach(poly => map.removeLayer(poly));
                window.roadProposalPolygons = [];
            }
            // Remove building proposal polygons
            if (window.buildingProposalPolygons && Array.isArray(window.buildingProposalPolygons)) {
                window.buildingProposalPolygons.forEach(poly => map.removeLayer(poly));
                window.buildingProposalPolygons = [];
            }
            // Remove acceptance highlight layers
            if (window.acceptanceHighlightLayers && Array.isArray(window.acceptanceHighlightLayers)) {
                window.acceptanceHighlightLayers.forEach(layer => map.removeLayer(layer));
                window.acceptanceHighlightLayers = [];
            }
        }
    }
    if (proposalLayer) {
        map.removeLayer(proposalLayer);
        proposalLayer = null;
    }
}

// Refresh the proposals layer (called when proposals are updated)
function refreshProposalsLayer() {
    console.log('refreshProposalsLayer called');
    const showProposalsCheckbox = document.getElementById('showProposalsCheckbox');
    console.log('Show proposals checkbox checked:', showProposalsCheckbox?.checked);

    if (showProposalsCheckbox && showProposalsCheckbox.checked) {
        console.log('Calling updateProposalLayer to refresh');
        updateProposalLayer();
    } else {
        console.log('Not refreshing - checkbox not checked or not found');
    }
}

// Handle clicks on road proposals
function showRoadProposalInfo(proposal) {
    // Clear any existing highlights
    clearProposalHighlights();

    // Show road proposal info in the parcel info panel (reusing existing UI)
    const roadGeometry = proposal.roadGeometry;
    const infoHTML = `
        <div class="proposal-info">
            <h4>Road Proposal</h4>
            <div class="proposal-hash">ID: ${proposal.proposalHash.substring(0, 8)}</div>
            <div class="metric-group">
                <div class="metric-label">Type:</div>
                <div class="metric-value">${proposal.type}</div>
            </div>
            <div class="metric-group">
                <div class="metric-label">Road Name:</div>
                <div class="metric-value">${roadGeometry.name}</div>
            </div>
            <div class="metric-group">
                <div class="metric-label">Road Width:</div>
                <div class="metric-value">${roadGeometry.width}m</div>
            </div>
            <div class="metric-group">
                <div class="metric-label">Author:</div>
                <div class="metric-value">${proposal.username}</div>
            </div>
            <div class="metric-group">
                <div class="metric-label">Date:</div>
                <div class="metric-value">${new Date(proposal.timestamp).toLocaleDateString()}</div>
            </div>
            <div class="metric-group">
                <div class="metric-label">Description:</div>
                <div class="metric-value">${proposal.description}</div>
            </div>
            ${proposal.offer ? `
                <div class="metric-group">
                    <div class="metric-label">Offer:</div>
                    <div class="metric-value">${proposal.offer}</div>
                </div>
            ` : ''}
        </div>
    `;

    // Show in parcel info panel
    const parcelInfoPanel = document.getElementById('parcel-info-panel');
    const parcelInfoContent = document.getElementById('parcel-info-content');

    if (parcelInfoPanel && parcelInfoContent) {
        parcelInfoContent.innerHTML = infoHTML;
        parcelInfoPanel.classList.add('visible');

        // Update the panel title
        const panelTitle = parcelInfoPanel.querySelector('h3');
        if (panelTitle) {
            panelTitle.textContent = 'Road Proposal Info';
        }
    }
}

// Handle clicks on proposal parcels
function handleProposalParcelClick(parcelId) {
    // Clear any currently selected single parcel to avoid conflicts
    multiParcelSelection.clearSingleParcelSelection();

    const proposals = proposalStorage.getProposalsForParcel(parcelId).filter(p => p.status !== 'Executed');

    if (proposals.length === 1) {
        const proposal = proposals[0];

        // First, clear any existing proposal highlights
        clearProposalHighlights();

        // Now, set the new state for the proposal and the selected parcel
        window.currentlyHighlightedProposal = proposal;
        window.selectedParcelInProposal = parcelId;

        // Apply the new highlighting
        applyProposalHighlights();

        // Center map on all parcels in the proposal
        centerMapOnProposal(proposal);

        // Show proposal info, passing the currently selected parcel ID
        showProposalInfo(proposal, parcelId);

    } else if (proposals.length > 1) {
        // If there are multiple proposals, we also need to set the selected parcel
        // so it can be highlighted when the list appears.
        selectedParcelInProposal = parcelId;
        showMultipleProposalsForParcel(proposals, parcelId);
    }
}

// Proposal highlighting state
window.currentlyHighlightedProposal = null;
window.selectedParcelInProposal = null;

// Apply proposal highlights (can be called repeatedly)
function applyProposalHighlights() {
    if (!window.currentlyHighlightedProposal) return;

    // Clean up previous acceptance highlight layers
    if (window.acceptanceHighlightLayers && Array.isArray(window.acceptanceHighlightLayers)) {
        window.acceptanceHighlightLayers.forEach(layer => map.removeLayer(layer));
    }
    window.acceptanceHighlightLayers = [];

    window.proposalHighlights = [];

    const proposal = window.currentlyHighlightedProposal;
    const acceptedIds = proposal.acceptedParcelIds || [];

    proposal.parcelIds.forEach(parcelId => {
        const parcel = multiParcelSelection.findParcelById(parcelId);
        if (parcel) {
            if (!parcel._originalProposalStyle) {
                const isRoad = localStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
                const globalRoadStyle = window.roadStyle || { fillColor: '#00ff00', fillOpacity: 0.2, color: '#00ff00', weight: 1 };
                const globalNormalStyle = window.normalStyle || { fillColor: 'red', fillOpacity: 0.2, color: 'red', weight: 1 };
                parcel._originalProposalStyle = isRoad ? { ...globalRoadStyle } : { ...globalNormalStyle };
            }

            let style;
            const isSelectedParcel = parcelId === window.selectedParcelInProposal;

            if (isSelectedParcel && window.currentlyHighlightedProposal) {
                const proposalColor = getProposalColor(window.currentlyHighlightedProposal.proposalHash);
                style = {
                    fillColor: proposalColor,
                    fillOpacity: 0.5,
                    color: 'gold',
                    weight: 5,
                    dashArray: ''
                };
            } else {
                const proposals = proposalStorage.getProposalsForParcel(parcelId).filter(p => p.status !== 'Executed');
                const colors = proposals.map(p => getProposalColor(p.proposalHash));
                style = {
                    fillColor: blendColors(colors),
                    fillOpacity: Math.max(0.25, 0.5 - 0.1 * (proposals.length - 1)),
                    color: '#222',
                    weight: 3,
                    dashArray: '5, 5'
                };
            }

            parcel.setStyle(style);
            parcel.bringToFront();
            window.proposalHighlights.push(parcel);

            // If accepted, add a darker overlay layer using the proposal's color
            if (acceptedIds.includes(parcelId)) {
                const proposalColor = getProposalColor(proposal.proposalHash);
                const acceptanceOverlay = L.polygon(parcel.getLatLngs(), {
                    fillColor: proposalColor,
                    fillOpacity: 0.6,
                    stroke: true,
                    color: proposalColor,
                    weight: 3,
                    interactive: false
                }).addTo(map);
                window.acceptanceHighlightLayers.push(acceptanceOverlay);
            }
        }
    });

    if (window.selectedParcelInProposal) {
        const selectedParcelLayer = multiParcelSelection.findParcelById(window.selectedParcelInProposal);
        if (selectedParcelLayer) {
            selectedParcelLayer.bringToFront();
        }
    }
}

// Clear proposal highlights
function clearProposalHighlights() {
    window.currentlyHighlightedProposal = null;
    window.selectedParcelInProposal = null;

    if (window.acceptanceHighlightLayers && Array.isArray(window.acceptanceHighlightLayers)) {
        window.acceptanceHighlightLayers.forEach(layer => map.removeLayer(layer));
        window.acceptanceHighlightLayers = [];
    }

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
    if (window.currentlyHighlightedProposal) {
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

/**
 * Returns the correct parcel click handler based on the current UI state.
 * This is the single source of truth for parcel click behavior.
 */
function getCorrectClickHandler() {
    const showProposals = document.getElementById('showProposalsCheckbox')?.checked;
    if (showProposals) {
        return proposalAwareParcelClickHandler;
    }
    // If proposal mode is off, return the original handler.
    // It's critical that originalOnParcelClick is defined in parcels.js before this can be called.
    return originalOnParcelClick;
}

/**
 * A robust click handler that is aware of the proposal mode.
 * It checks if a clicked parcel is part of a proposal and routes
 * the click to the appropriate handler.
 * @param {L.LeafletEvent} e The Leaflet click event.
 */
function proposalAwareParcelClickHandler(e) {
    const showProposals = document.getElementById('showProposalsCheckbox')?.checked;
    const parcelId = e.target.feature?.properties?.CESTICA_ID?.toString();

    if (showProposals && parcelId) {
        const proposals = proposalStorage.getProposalsForParcel(parcelId);
        if (proposals.length > 0) {
            // This is a proposal parcel, handle it with the proposal logic.
            L.DomEvent.stopPropagation(e); // Stop event from propagating further
            handleProposalParcelClick(parcelId);
            return; // End execution here
        }
    }

    // If not in proposal mode, or if the parcel is not in any proposal,
    // fall back to the original click handler.
    if (originalOnParcelClick && typeof originalOnParcelClick === 'function') {
        originalOnParcelClick.call(this, e);
    } else {
        console.error("Original onParcelClick handler is not available.");
    }
}

// Show proposal info panel
function showProposalInfo(proposal, currentParcelId = null) {
    const parcels = proposal.parcelIds.map(id => multiParcelSelection.findParcelById(id)).filter(p => p);
    const totalArea = parcels.reduce((sum, parcel) =>
        sum + (parcel.feature.properties.calculatedArea || 0), 0);

    // Determine current parcel - try passed parameter first, then global selectedParcelId
    const selectedParcelId = currentParcelId || window.selectedParcelId;
    const isCurrentParcelInProposal = selectedParcelId && proposal.parcelIds.includes(selectedParcelId);
    const hasCurrentParcelAccepted = selectedParcelId && proposal.acceptedParcelIds && proposal.acceptedParcelIds.includes(selectedParcelId);

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
            <div class="proposal-acceptance-status">
                <div class="acceptance-label">Parcel Acceptance Status:</div>
                <div class="acceptance-circles">
                    ${(() => {
            const total = proposal.parcelIds.length;
            const accepted = proposal.acceptedParcelIds ? proposal.acceptedParcelIds.length : 0;
            let html = '';
            // Add green circles for accepted parcels
            for (let i = 0; i < accepted; i++) {
                html += '<div class="acceptance-circle accepted" title="Accepted"></div>';
            }
            // Add grey circles for pending parcels
            for (let i = 0; i < total - accepted; i++) {
                html += '<div class="acceptance-circle pending" title="Pending"></div>';
            }
            return html;
        })()}
                </div>
                <div class="acceptance-summary">
                    ${proposal.acceptedParcelIds ? proposal.acceptedParcelIds.length : 0} of ${proposal.parcelIds.length} parcels accepted
                </div>
            </div>
            <div class="proposal-actions">
                ${isCurrentParcelInProposal ?
            (hasCurrentParcelAccepted ?
                `<button class="btn btn-reject-proposal" onclick="rejectProposal('${proposal.proposalHash}', '${selectedParcelId}')" 
                                 title="Reject this proposal for the currently selected parcel">
                             <i class="fas fa-times"></i> Reject Proposal
                         </button>` :
                `<button class="btn btn-accept-proposal" onclick="acceptProposal('${proposal.proposalHash}', '${selectedParcelId}')" 
                                 title="Accept this proposal for the currently selected parcel">
                             <i class="fas fa-check"></i> Accept Proposal
                         </button>`
            ) :
            `<button class="btn btn-accept-proposal" disabled 
                             title="Select a parcel that is part of this proposal to accept/reject it">
                         <i class="fas fa-info-circle"></i> Select Parcel to Accept/Reject
                     </button>`
        }
            </div>
            <hr style="border: 0; height: 1px; background-color: #ddd; margin: 15px 0;">
            <div class="metric-group">
                <div class="metric-label">Author:</div>
                <div class="metric-value author-with-avatar">
                    ${(() => {
            // Find the agent with matching name
            if (typeof agentStorage !== 'undefined') {
                const agents = agentStorage.getAllAgents();
                const agent = agents.find(a => a.name === proposal.author);
                if (agent && typeof getAvatarImagePath === 'function') {
                    return `
                                        <img src="${getAvatarImagePath(agent.avatarIndex)}" class="author-avatar" style="width: 24px; height: 24px; border-radius: 50%; border: 2px solid #007bff; margin-right: 8px; vertical-align: middle;">
                                        <a href="#" data-agent-id="${agent.id}" class="agent-link agent-link-clickable" style="text-decoration: none; color: #007bff; font-weight: 500;">${proposal.author}</a>
                                    `;
                }
            }
            return proposal.author;
        })()}
                </div>
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

    // Setup click listeners for any clickable links in the proposal info
    if (typeof setupGameLogClickListeners === 'function') {
        setupGameLogClickListeners();
    }
}

// Show proposal list in parcel info panel
function showMultipleProposalsForParcel(proposals, parcelId) {
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
                    <div class="proposal-item" onclick="selectProposalFromList('${proposal.proposalHash}', '${parcelId}')" style="border-left: 10px solid ${getProposalColor(proposal.proposalHash)};">
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
        </div>
    `;

    document.getElementById('info-content').innerHTML = content;
    document.getElementById('parcel-info-panel').classList.add('visible');

    // Setup click listeners for any clickable links in the proposal info
    if (typeof setupGameLogClickListeners === 'function') {
        setupGameLogClickListeners();
    }
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
            budget: offer, // Add budget field - initially same as offer
            parcelIds: finalParcelIds,
            type: 'parcel', // For future extension to road/building proposals
            acceptedParcelIds: [] // Track which parcels have accepted the proposal
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
                        <div class="proposal-list-item" onclick="centerOnProposal('${proposal.proposalHash}')" style="border-left: 4px solid ${getProposalColor(proposal.proposalHash)};">
                            <div class="proposal-list-header">
                                <div class="proposal-color-dot" style="background-color: ${getProposalColor(proposal.proposalHash)};"></div>
                                <div class="proposal-list-title">${proposal.title}</div>
                                <div class="proposal-actions">
                                    <div class="proposal-status-indicator ${proposal.status === 'Executed' ? 'executed' : 'active'}">
                                        ${proposal.status || 'Active'}
                                    </div>
                                    <button class="proposal-delete-btn" onclick="event.stopPropagation(); deleteProposal('${proposal.proposalHash}')" title="Delete proposal">
                                        <i class="fas fa-trash"></i>
                                    </button>
                                </div>
                            </div>
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

// Delete a single proposal
function deleteProposal(proposalHash) {
    try {
        const proposal = proposalStorage.getProposal(proposalHash);
        if (!proposal) {
            updateStatus('Error: Proposal not found');
            return;
        }

        // Remove the proposal from storage
        proposalStorage.removeProposal(proposalHash);

        // Clear any proposal highlights if this was the currently highlighted proposal
        if (window.currentlyHighlightedProposal && window.currentlyHighlightedProposal.proposalHash === proposalHash) {
            clearProposalHighlights();
        }

        // Update the proposal layer to remove visual representation
        updateProposalLayer();

        // Update the proposal list if it's open
        updateProposalList();

        // Hide proposal info panel if it's showing the deleted proposal
        const parcelInfoPanel = document.getElementById('parcel-info-panel');
        if (parcelInfoPanel && parcelInfoPanel.classList.contains('visible')) {
            const panelTitle = document.querySelector('#parcel-info-panel h3');
            if (panelTitle && panelTitle.textContent === 'Proposal Details') {
                hideParcelInfoPanel();
            }
        }

        updateStatus(`Proposal "${proposal.title}" deleted`);

    } catch (error) {
        console.error('Error deleting proposal:', error);
        updateStatus('Error deleting proposal. Please try again.');
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
window.deleteProposal = deleteProposal;

// Handle selection of a proposal from the multiple proposals list
function selectProposalFromList(proposalHash, parcelId) {
    const proposal = proposalStorage.getProposal(proposalHash);
    if (!proposal) {
        console.error('Proposal not found:', proposalHash);
        updateStatus('Error: Proposal not found');
        return;
    }

    // First, clear any existing proposal highlights
    clearProposalHighlights();

    // Now, set the new state for the proposal and the selected parcel
    window.currentlyHighlightedProposal = proposal;
    window.selectedParcelInProposal = parcelId;

    // Apply the new highlighting
    applyProposalHighlights();

    // Center map on all parcels in the proposal
    centerMapOnProposal(proposal);

    // Show proposal info, passing the currently selected parcel ID
    showProposalInfo(proposal, parcelId);

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

// Accept proposal function (for specific parcel)
function acceptProposal(proposalHash, parcelId) {
    console.log('Accept proposal called for hash:', proposalHash, 'parcel:', parcelId);

    try {
        // Get the proposal
        const proposal = proposalStorage.getProposal(proposalHash);
        if (!proposal) {
            alert('Proposal not found.');
            return;
        }

        // Check if parcel is part of this proposal
        if (!proposal.parcelIds.includes(parcelId)) {
            alert('This parcel is not part of the proposal.');
            return;
        }

        // Check if parcel has already accepted
        if (proposal.acceptedParcelIds && proposal.acceptedParcelIds.includes(parcelId)) {
            alert('This parcel has already accepted the proposal.');
            return;
        }

        // Initialize acceptedParcelIds if it doesn't exist
        if (!proposal.acceptedParcelIds) {
            proposal.acceptedParcelIds = [];
        }

        // Accept the proposal for this parcel
        proposal.acceptedParcelIds.push(parcelId);

        // Update the proposal in storage
        proposalStorage.proposals.set(proposalHash, proposal);
        proposalStorage.save();

        // Find the parcel info for display
        const parcel = multiParcelSelection.findParcelById(parcelId);
        const parcelNumber = parcel?.feature?.properties?.BROJ_CESTICE || parcelId;

        updateStatus(`Accepted proposal "${proposal.title}" for parcel ${parcelNumber}.`);

        // Refresh the proposal info display FIRST to show the final acceptance
        showProposalInfo(proposal, parcelId);

        // Check if all parcels have now accepted the proposal
        if (proposal.acceptedParcelIds.length === proposal.parcelIds.length) {
            // All parcels have accepted - execute the proposal
            proposal.status = 'Executed';
            proposalStorage.proposals.set(proposalHash, proposal);
            proposalStorage.save();

            // Execute the proposal based on its type
            if (proposal.type === 'road' && proposal.roadGeometry) {
                // Execute road proposal
                const affectedParcels = proposal.parcelIds.map(id => {
                    const parcel = multiParcelSelection.findParcelById(id);
                    return {
                        id: id,
                        number: parcel?.feature?.properties?.BROJ_CESTICE || id,
                        layer: parcel
                    };
                });

                // Convert roadGeometry to the format expected by updateParcelsWithRoad
                if (proposal.roadGeometry.polygon && proposal.roadGeometry.polygon.coordinates) {
                    const coordinates = proposal.roadGeometry.polygon.coordinates[0];
                    const roadPolygon = coordinates.map(coord => ({
                        lat: coord[1],
                        lng: coord[0]
                    }));
                    const roadName = proposal.roadGeometry.name || 'New Road';

                    if (typeof updateParcelsWithRoad === 'function') {
                        updateParcelsWithRoad(roadPolygon, affectedParcels, roadName);
                    }
                }
                updateStatus(`Proposal ${proposal.proposalHash.substring(0, 6)} executed! All ${proposal.parcelIds.length} parcels accepted`);
            } else if (proposal.buildingGeometry && (proposal.buildingGeometry.type === 'Polygon' || proposal.buildingGeometry.type === 'MultiPolygon')) {
                // Execute building proposal - add to proposed buildings layer
                const buildingFeature = {
                    type: 'Feature',
                    geometry: proposal.buildingGeometry,
                    properties: {
                        name: proposal.title,
                        type: 'executed_proposal',
                        proposalHash: proposal.proposalHash,
                        executedAt: new Date().toISOString()
                    }
                };

                // Add to proposed buildings array (from building-blocks.js)
                if (typeof proposedBuildings !== 'undefined') {
                    proposedBuildings.push(buildingFeature);

                    // Save executed buildings to localStorage
                    if (typeof saveExecutedBuildingsToStorage === 'function') {
                        saveExecutedBuildingsToStorage();
                    }

                    // Update the proposed buildings layer
                    if (typeof updateProposedBuildingsLayer === 'function') {
                        updateProposedBuildingsLayer();
                    }

                    // Auto-check the show proposed buildings checkbox
                    const showProposedBuildingsCheckbox = document.getElementById('showProposedBuildings');
                    if (showProposedBuildingsCheckbox) {
                        showProposedBuildingsCheckbox.checked = true;
                    }
                }

                updateStatus(`Proposal ${proposal.proposalHash.substring(0, 6)} executed! All ${proposal.parcelIds.length} parcels accepted`);
            }

            // Show celebratory popup
            if (typeof showCelebratoryPopup === 'function') {
                showCelebratoryPopup(proposal.proposalHash.substring(0, 6), proposal.parcelIds.length);
            }

            // Close the Proposal Details panel
            hideParcelInfoPanel();

            // Refresh the proposals layer to hide executed proposal
            updateProposalLayer();
            clearProposalHighlights();

            return; // Don't continue with normal UI updates since proposal is now executed
        }

        // For non-executed proposals, also refresh the visual highlights
        setTimeout(() => {
            applyProposalHighlights();
        }, 10);

    } catch (error) {
        console.error('Error accepting proposal:', error);
        alert('Error accepting proposal. Please try again.');
    }
}

// Reject proposal function (for specific parcel)
function rejectProposal(proposalHash, parcelId) {
    console.log('Reject proposal called for hash:', proposalHash, 'parcel:', parcelId);

    try {
        // Get the proposal
        const proposal = proposalStorage.getProposal(proposalHash);
        if (!proposal) {
            alert('Proposal not found.');
            return;
        }

        // Check if parcel is part of this proposal
        if (!proposal.parcelIds.includes(parcelId)) {
            alert('This parcel is not part of the proposal.');
            return;
        }

        // Check if parcel has accepted (can't reject if not accepted)
        if (!proposal.acceptedParcelIds || !proposal.acceptedParcelIds.includes(parcelId)) {
            alert('This parcel has not accepted the proposal yet.');
            return;
        }

        // Remove the parcel from acceptedParcelIds
        proposal.acceptedParcelIds = proposal.acceptedParcelIds.filter(id => id !== parcelId);

        // Update the proposal in storage
        proposalStorage.proposals.set(proposalHash, proposal);
        proposalStorage.save();

        // Find the parcel info for display
        const parcel = multiParcelSelection.findParcelById(parcelId);
        const parcelNumber = parcel?.feature?.properties?.BROJ_CESTICE || parcelId;

        updateStatus(`Rejected proposal "${proposal.title}" for parcel ${parcelNumber}.`);

        // Refresh the proposal info display
        showProposalInfo(proposal, parcelId);

        // IMMEDIATE visual refresh - this should happen right after the data is updated
        setTimeout(() => {
            applyProposalHighlights();
        }, 10);

    } catch (error) {
        console.error('Error rejecting proposal:', error);
        alert('Error rejecting proposal. Please try again.');
    }
}

// Ensure this runs after the main DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    // Event listener for the "Show Proposals" checkbox
    const showProposalsCheckbox = document.getElementById('showProposalsCheckbox');
    if (showProposalsCheckbox) {
        showProposalsCheckbox.addEventListener('change', updateProposalLayer);
    }
});

// Celebratory popup function when proposal is fully accepted
function showCelebratoryPopup(proposalId, parcelCount) {
    // Create a temporary celebration popup
    const popup = document.createElement('div');
    popup.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: linear-gradient(45deg, #4CAF50, #45a049);
        color: white;
        padding: 20px;
        border-radius: 10px;
        font-size: 18px;
        font-weight: bold;
        text-align: center;
        z-index: 10000;
        box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        animation: celebration 0.5s ease-out;
    `;
    popup.innerHTML = `🎉 Proposal ${proposalId} executed! 🎉<br><small>All ${parcelCount} parcels accepted!</small>`;

    // Add CSS animation if not already present
    if (!document.getElementById('celebration-style')) {
        const style = document.createElement('style');
        style.id = 'celebration-style';
        style.textContent = `
            @keyframes celebration {
                0% { opacity: 0; transform: translate(-50%, -50%) scale(0.5); }
                100% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
            }
        `;
        document.head.appendChild(style);
    }

    document.body.appendChild(popup);

    // Remove the popup after 3 seconds
    setTimeout(() => {
        if (popup.parentNode) {
            popup.parentNode.removeChild(popup);
        }
    }, 3000);
}