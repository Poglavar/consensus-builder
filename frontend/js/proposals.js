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
            // console.log('This exact proposal already exists');
            return null;
        }
        proposal.proposalHash = hash;
        proposal.createdAt = new Date().toISOString();
        // Ensure all proposals start with Active status
        if (!proposal.status) {
            proposal.status = 'Active';
        }
        this.proposals.set(hash, proposal);
        this.save();

        // Check if this proposal affects the current user's parcels
        if (typeof userNotifications !== 'undefined' && userNotifications.addProposalIfRelevant) {
            userNotifications.addProposalIfRelevant(hash, proposal);
        }

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
    },

    // Update proposal status
    updateProposalStatus(proposalHash, status) {
        const proposal = this.getProposal(proposalHash);
        if (proposal) {
            proposal.status = status;
            this.proposals.set(proposalHash, proposal);
            this.save();
        }
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

        if (this.selectedParcels.has(parcelId)) {
            this.selectedParcels.delete(parcelId);
            this.removeParcelHighlight(parcel);
        } else {
            this.selectedParcels.add(parcelId);
            this.addParcelHighlight(parcel);
        }

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

    // Find parcel layer by ID with fallback to cache
    findParcelById(parcelId) {
        let foundParcel = null;
        let checkedCount = 0;

        // First, try to find in the existing parcelLayer
        if (typeof parcelLayer !== 'undefined' && parcelLayer) {
            parcelLayer.eachLayer(layer => {
                checkedCount++;
                if (layer.feature && layer.feature.properties &&
                    layer.feature.properties.CESTICA_ID) {
                    const layerId = layer.feature.properties.CESTICA_ID.toString();
                    if (layerId === parcelId.toString()) {
                        foundParcel = layer;
                    }
                }
            });
        } else {
            console.warn('findParcelById: parcelLayer not available');
        }

        // If not found in parcelLayer, try to recover from cache
        if (!foundParcel && typeof parcelCache !== 'undefined') {
            foundParcel = this.recoverParcelFromCache(parcelId);
            if (foundParcel) {
                // console.log(`findParcelById: Recovered parcel ${parcelId} from cache and added to parcelLayer`);
            }
        }

        // Final fallback: try localStorage
        if (!foundParcel) {
            foundParcel = this.recoverParcelFromLocalStorage(parcelId);
            if (foundParcel) {
                //console.log(`findParcelById: Recovered parcel ${parcelId} from localStorage and added to parcelLayer`);
            }
        }

        if (!foundParcel) {
            console.warn('findParcelById: Could not find parcel with ID:', parcelId, 'in parcelLayer, cache, or localStorage');
        }

        return foundParcel;
    },

    // Recover parcel from grid cache and instantiate as layer
    recoverParcelFromCache(parcelId) {
        if (!parcelCache || !parcelCache.grid) return null;

        // Search all grid cells for the parcel
        for (const [gridKey, cellData] of parcelCache.grid) {
            if (cellData && cellData.features) {
                const feature = cellData.features.find(f =>
                    f.properties && f.properties.CESTICA_ID &&
                    f.properties.CESTICA_ID.toString() === parcelId.toString()
                );

                if (feature) {
                    return this.createParcelLayerFromFeature(feature);
                }
            }
        }
        return null;
    },

    // Recover parcel from localStorage and instantiate as layer
    recoverParcelFromLocalStorage(parcelId) {
        const geometryStr = localStorage.getItem(`parcel_${parcelId}_geometry`);
        const propertiesStr = localStorage.getItem(`parcel_${parcelId}_properties`);

        if (geometryStr && propertiesStr) {
            try {
                const geometry = JSON.parse(geometryStr);
                const properties = JSON.parse(propertiesStr);

                // Reconstruct the feature
                const feature = {
                    type: 'Feature',
                    properties: properties,
                    geometry: {
                        type: 'Polygon',
                        coordinates: [geometry]
                    }
                };

                // Ensure calculatedArea is set
                if (!feature.properties.calculatedArea) {
                    // Use the calculateArea function if available
                    if (typeof calculateArea === 'function') {
                        feature.properties.calculatedArea = calculateArea([geometry]);
                    }
                }

                return this.createParcelLayerFromFeature(feature);
            } catch (e) {
                console.error(`Error reconstructing parcel ${parcelId} from localStorage:`, e);
            }
        }
        return null;
    },

    // Create a Leaflet layer from a feature and add it to parcelLayer
    createParcelLayerFromFeature(feature) {
        if (!feature || !feature.geometry || !feature.properties) {
            console.error('createParcelLayerFromFeature: Invalid feature provided');
            return null;
        }

        try {
            // Convert coordinates if needed (same logic as in fetchParcelData)
            let convertedFeature = feature;
            if (typeof convertGeoJSON === 'function') {
                const featureCollection = {
                    type: 'FeatureCollection',
                    features: [feature]
                };
                const converted = convertGeoJSON(featureCollection);
                convertedFeature = converted.features[0];
            }

            // Create the Leaflet layer
            const layer = L.geoJSON(convertedFeature, {
                style: (feature) => {
                    const parcelId = feature.properties.CESTICA_ID;
                    const isRoad = localStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
                    // Use global styles if available
                    const roadStyleToUse = typeof roadStyle !== 'undefined' ? roadStyle : {
                        fillColor: '#00ff00', fillOpacity: 0.2, color: '#00ff00', weight: 1
                    };
                    const normalStyleToUse = typeof normalStyle !== 'undefined' ? normalStyle : {
                        fillColor: 'red', fillOpacity: 0.2, color: 'red', weight: 1
                    };
                    return isRoad ? roadStyleToUse : normalStyleToUse;
                },
                onEachFeature: function (feature, layer) {
                    if (typeof onParcelClick === 'function') {
                        layer.on({
                            mouseover: typeof highlightFeature === 'function' ? highlightFeature : () => { },
                            mouseout: typeof resetHighlight === 'function' ? resetHighlight : () => { },
                            click: onParcelClick
                        });
                    }
                }
            });

            // Extract the actual parcel layer (geoJSON creates a layer group)
            let parcelLayerInstance = null;
            layer.eachLayer(l => {
                if (!parcelLayerInstance) parcelLayerInstance = l;
            });

            if (parcelLayerInstance) {
                // Add road properties if applicable
                const parcelId = feature.properties.CESTICA_ID;
                const isRoad = localStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
                if (isRoad) {
                    const roadName = localStorage.getItem(`parcel_${parcelId}_roadName`) || 'Unnamed Road';
                    parcelLayerInstance.bindTooltip(roadName, {
                        permanent: false,
                        direction: 'center',
                        className: 'road-name-tooltip'
                    });
                    parcelLayerInstance.feature.properties.isRoad = true;
                    parcelLayerInstance.feature.properties.roadName = roadName;
                    parcelLayerInstance.feature.properties.roadId = localStorage.getItem(`parcel_${parcelId}_roadId`) || '';
                    parcelLayerInstance.feature.properties.roadConfidence = localStorage.getItem(`parcel_${parcelId}_roadConfidence`) || '0';
                }

                // Add to parcelLayer if it exists
                if (typeof parcelLayer !== 'undefined' && parcelLayer) {
                    parcelLayer.addLayer(parcelLayerInstance);
                    // Add to map if parcel layer is currently visible
                    if (map && map.hasLayer(parcelLayer)) {
                        parcelLayerInstance.addTo(map);
                    }
                }

                // Validate that the layer has getBounds before returning
                if (typeof parcelLayerInstance.getBounds === 'function') {
                    return parcelLayerInstance;
                } else {
                    console.error('createParcelLayerFromFeature: Created layer does not have getBounds method');
                    return null;
                }
            }
        } catch (e) {
            console.error('Error creating parcel layer from feature:', e);
        }

        return null;
    },

    // Add highlight to selected parcel
    addParcelHighlight(parcel) {
        // Apply multi-selection style (matches .parcel-layer.multi-selected CSS)
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
        // Use the global style objects from parcels.js
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

                    // Clear all tab content
                    const infoContent = document.getElementById('info-content');
                    const proposalsContent = document.getElementById('proposals-content');
                    if (infoContent) infoContent.innerHTML = '';
                    if (proposalsContent) proposalsContent.innerHTML = '';

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

        // Show multi-parcel content in the Info tab
        document.getElementById('info-content').innerHTML = content;
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

        // Clear all tab content areas
        const infoContent = document.getElementById('info-content');
        const proposalsContent = document.getElementById('proposals-content');

        if (infoContent) infoContent.innerHTML = '';
        if (proposalsContent) proposalsContent.innerHTML = '';

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

        // Use a small delay to ensure parcel layer updates are complete
        setTimeout(() => {
            this.selectedParcels.forEach(parcelId => {
                const parcel = this.findParcelById(parcelId);
                if (parcel) {
                    this.addParcelHighlight(parcel);
                }
            });
        }, 50);
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
                                stroke: false,
                                weight: 0,
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

                // Check if this parcel is part of multi-selection
                const isMultiSelected = multiParcelSelection.isActive &&
                    multiParcelSelection.selectedParcels.has(parcelId);

                if (isMultiSelected) {
                    // Preserve multi-selection highlighting
                    layer.setStyle({
                        fillColor: '#ff9800',
                        fillOpacity: 0.6,
                        color: '#f57c00',
                        weight: 3
                    });
                    layer.bringToFront();
                } else {
                    // Apply normal styling
                    const isRoad = localStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
                    const globalRoadStyle = window.roadStyle || { fillColor: '#00ff00', fillOpacity: 0.2, color: '#00ff00', weight: 1 };
                    const globalNormalStyle = window.normalStyle || { fillColor: 'red', fillOpacity: 0.2, color: 'red', weight: 1 };
                    layer.setStyle(isRoad ? globalRoadStyle : globalNormalStyle);
                }
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

    // Reapply multi-parcel highlights if active
    if (multiParcelSelection.isActive && multiParcelSelection.selectedParcels.size > 0) {
        multiParcelSelection.reapplyMultiParcelHighlights();
    }

    // Re-draw highlight for currently selected proposal so its gold outline stays on top
    // Only do this when we're IN proposal mode, not when switching away from it
    if (show && typeof reapplyProposalHighlights === 'function') {
        reapplyProposalHighlights();
    }
}

// Refresh the proposals layer (called when proposals are updated)
function refreshProposalsLayer() {
    console.log('refreshProposalsLayer called');
    const showProposalsCheckbox = document.getElementById('showProposalsCheckbox');
    console.log('Show proposals checkbox checked:', showProposalsCheckbox?.checked);

    if (showProposalsCheckbox && showProposalsCheckbox.checked) {
        console.log('Calling updateProposalLayer to refresh');
        updateProposalLayer(true);
    } else {
        console.log('Not refreshing - checkbox not checked or not found');
    }
}

// Lightweight function to refresh proposal data without rebuilding visual layers
function refreshProposalData() {
    // This function updates proposal-related data without touching the visual layers
    // It's called during game turns when there are active highlights to avoid flicker

    // Update proposal counts and status if needed
    if (typeof updateShowProposalsButton === 'function') {
        updateShowProposalsButton();
    }

    // Only refresh proposal info if the modal is currently open
    if (window.currentlyHighlightedProposal && window.selectedParcelInProposal) {
        // Check if the proposal details panel is actually visible
        const proposalPanel = document.getElementById('parcel-info-panel');
        const isProposalModalOpen = proposalPanel &&
            proposalPanel.classList.contains('visible') &&
            proposalPanel.querySelector('h3')?.textContent === 'Proposal Details';

        if (isProposalModalOpen) {
            const updatedProposal = proposalStorage.getProposal(window.currentlyHighlightedProposal.proposalHash);
            if (updatedProposal) {
                // Update the proposal info only if modal is open
                showProposalInfo(updatedProposal, window.selectedParcelInProposal);
            }
        }
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

    // Show in parcel info panel (Info tab)
    const parcelInfoPanel = document.getElementById('parcel-info-panel');
    const infoContent = document.getElementById('info-content');

    if (parcelInfoPanel && infoContent) {
        infoContent.innerHTML = infoHTML;
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
        selectAndHighlightProposal(proposal.proposalHash, parcelId, true);
    } else if (proposals.length > 1) {
        // If there are multiple proposals, show a simple choice modal
        showProposalChoiceModal(proposals, parcelId);
    }
}

// Proposal highlighting state
window.currentlyHighlightedProposal = null;
window.selectedParcelInProposal = null;
window.isApplyingProposalHighlights = false;

// Apply proposal highlights (can be called repeatedly)
function applyProposalHighlights() {
    if (!window.currentlyHighlightedProposal) return;

    // Clean old layers
    if (window.acceptanceHighlightLayers) {
        window.acceptanceHighlightLayers.forEach(l => map.removeLayer(l));
    }
    window.acceptanceHighlightLayers = [];

    if (window.proposalHighlightLayer) map.removeLayer(window.proposalHighlightLayer);
    window.proposalHighlightLayer = L.featureGroup().addTo(map);

    window.proposalHighlights = [];

    const proposal = window.currentlyHighlightedProposal;
    const acceptedIds = proposal.acceptedParcelIds || [];

    proposal.parcelIds.forEach(pid => {
        const parcel = multiParcelSelection.findParcelById(pid);
        if (!parcel) return;

        // Save original style once
        if (!parcel._originalProposalStyle) {
            const isRoad = localStorage.getItem(`parcel_${pid}_isRoad`) === 'true';
            parcel._originalProposalStyle = isRoad ? { ...window.roadStyle } : { ...window.normalStyle };
        }

        // Transparent outline on base layer
        const proposals = proposalStorage.getProposalsForParcel(pid).filter(p => p.status !== 'Executed');
        const colors = proposals.map(p => getProposalColor(p.proposalHash));
        parcel.setStyle({
            fillColor: blendColors(colors),
            fillOpacity: Math.max(0.25, 0.4 - 0.05 * (proposals.length - 1)),
            color: 'transparent',
            weight: 0
        });

        window.proposalHighlights.push(parcel);

        // Outline overlay
        const outline = L.geoJSON(parcel.toGeoJSON(), {
            style: {
                color: 'gold',
                weight: 6,
                fillOpacity: 0,
                interactive: false
            }
        });
        window.proposalHighlightLayer.addLayer(outline);

        // Accepted darker overlay
        if (acceptedIds.includes(pid)) {
            const proposalColor = getProposalColor(proposal.proposalHash);
            const acc = L.polygon(parcel.getLatLngs(), {
                fillColor: proposalColor,
                fillOpacity: 0.6,
                stroke: false,
                interactive: false
            }).addTo(map);
            window.acceptanceHighlightLayers.push(acc);
        }
    });

    window.proposalHighlightLayer.bringToFront();
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

    // Remove gold outline overlay
    if (window.proposalHighlightLayer) {
        map.removeLayer(window.proposalHighlightLayer);
        window.proposalHighlightLayer = null;
    }
}

// Function to re-apply highlights after parcel layer updates
function reapplyProposalHighlights() {
    if (window.currentlyHighlightedProposal && !window.isApplyingProposalHighlights) {
        // Apply highlights immediately - no delay needed with proper event handling
        applyProposalHighlights();
    }
}

// Show a modal to choose between multiple proposals for a parcel
function showProposalChoiceModal(proposals, parcelId) {
    // Get parcel info for display
    const parcel = multiParcelSelection.findParcelById(parcelId);
    const parcelNumber = parcel?.feature?.properties?.BROJ_CESTICE || parcelId;

    // Remove any existing modal
    const existingModal = document.querySelector('.proposal-choice-modal');
    if (existingModal) {
        existingModal.remove();
    }

    // Create modal
    const modal = document.createElement('div');
    modal.className = 'proposal-choice-modal';
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background-color: rgba(0, 0, 0, 0.5);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 10000;
    `;

    modal.innerHTML = `
        <div class="proposal-choice-content" style="
            background: white;
            border-radius: 8px;
            padding: 20px;
            max-width: 500px;
            width: 90%;
            max-height: 80vh;
            overflow-y: auto;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
        ">
            <div class="proposal-choice-header" style="
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 20px;
                border-bottom: 1px solid #ddd;
                padding-bottom: 15px;
            ">
                <h3 style="margin: 0; color: #333;">Choose Proposal</h3>
                <button class="proposal-choice-close" onclick="closeProposalChoiceModal()" style="
                    background: none;
                    border: none;
                    font-size: 24px;
                    cursor: pointer;
                    color: #666;
                    padding: 0;
                    width: 30px;
                    height: 30px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                ">&times;</button>
            </div>
            <div class="proposal-choice-info" style="
                margin-bottom: 20px;
                padding: 10px;
                background-color: #f8f9fa;
                border-radius: 4px;
                color: #666;
                font-size: 14px;
            ">
                Parcel ${parcelNumber} is part of ${proposals.length} proposals. Choose which one to view:
            </div>
            <div class="proposal-choice-list">
                ${proposals.map(proposal => `
                    <div class="proposal-choice-item" onclick="selectProposalFromChoice('${proposal.proposalHash}', '${parcelId}')" style="
                        border: 1px solid #ddd;
                        border-radius: 6px;
                        padding: 15px;
                        margin-bottom: 10px;
                        cursor: pointer;
                        transition: all 0.2s ease;
                        border-left: 4px solid ${getProposalColor(proposal.proposalHash)};
                    " onmouseover="this.style.backgroundColor='#f8f9fa'; this.style.borderColor='#007bff';" 
                       onmouseout="this.style.backgroundColor='white'; this.style.borderColor='#ddd';">
                        <div class="proposal-choice-title" style="
                            font-weight: 600;
                            color: #333;
                            margin-bottom: 8px;
                            display: flex;
                            align-items: center;
                            gap: 10px;
                        ">
                            <div class="proposal-color-dot" style="
                                width: 12px;
                                height: 12px;
                                border-radius: 50%;
                                background-color: ${getProposalColor(proposal.proposalHash)};
                            "></div>
                            ${proposal.title}
                        </div>
                        <div class="proposal-choice-details" style="
                            color: #666;
                            font-size: 14px;
                            line-height: 1.4;
                        ">
                            <div>Author: ${proposal.author}</div>
                            <div>Offer: €${proposal.offer.toLocaleString('hr-HR')}</div>
                            <div>Parcels: ${proposal.parcelIds.length}</div>
                            <div>Accepted: ${proposal.acceptedParcelIds ? proposal.acceptedParcelIds.length : 0}/${proposal.parcelIds.length}</div>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // Close modal when clicking outside
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeProposalChoiceModal();
        }
    });

    // Close modal with Escape key
    const handleEscape = (e) => {
        if (e.key === 'Escape') {
            closeProposalChoiceModal();
            document.removeEventListener('keydown', handleEscape);
        }
    };
    document.addEventListener('keydown', handleEscape);
}

// Close the proposal choice modal
function closeProposalChoiceModal() {
    const modal = document.querySelector('.proposal-choice-modal');
    if (modal) {
        modal.remove();
    }
}

// Select a proposal from the choice modal
function selectProposalFromChoice(proposalHash, parcelId) {
    closeProposalChoiceModal();
    selectAndHighlightProposal(proposalHash, parcelId, true);
}

// Unified function to select and highlight a proposal with proper sequencing
function selectAndHighlightProposal(proposalHash, parcelId, shouldCenter = false) {
    const proposal = proposalStorage.getProposal(proposalHash);
    if (!proposal) {
        console.error('Proposal not found:', proposalHash);
        updateStatus('Error: Proposal not found');
        return;
    }

    // Clear any existing proposal highlights
    clearProposalHighlights();

    // Set the new state for the proposal and the selected parcel
    window.currentlyHighlightedProposal = proposal;
    window.selectedParcelInProposal = parcelId;

    // Show proposal info immediately (no visual changes yet)
    showProposalInfo(proposal, parcelId);

    // Update status
    updateStatus(`Selected proposal "${proposal.title}" (contains ${proposal.parcelIds.length} parcels)`);

    if (shouldCenter) {
        // Set flag to prevent interference during map movement
        window.isApplyingProposalHighlights = true;

        // Center map first, then apply highlights when movement is complete
        const parcels = proposal.parcelIds.map(id => multiParcelSelection.findParcelById(id))
            .filter(p => {
                if (!p) return false;
                if (typeof p.getBounds !== 'function') return false;
                try {
                    const center = p.getBounds().getCenter();
                    if (!center || isNaN(center.lat) || isNaN(center.lng)) return false;
                    if (Math.abs(center.lat) > 90 || Math.abs(center.lng) > 180) return false;
                    return true;
                } catch (e) {
                    return false;
                }
            });
        if (parcels.length > 0) {
            // Calculate bounds of all parcels in the proposal
            const bounds = L.latLngBounds();
            parcels.forEach(parcel => {
                bounds.extend(parcel.getBounds());
            });

            // Listen for moveend event to know when centering is complete
            const onMoveEnd = () => {
                map.off('moveend', onMoveEnd); // Remove listener
                window.isApplyingProposalHighlights = false;

                // Now apply highlights after map movement is complete
                applyProposalHighlights();
            };

            map.on('moveend', onMoveEnd);

            // Start the map centering
            map.fitBounds(bounds, { padding: [50, 50] });
        } else {
            // No parcels found, just apply highlights immediately
            window.isApplyingProposalHighlights = false;
            applyProposalHighlights();
        }
    } else {
        // No centering needed, apply highlights immediately
        applyProposalHighlights();
    }
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
    // Fallback to the global handler if the original has not been captured yet
    if (!originalOnParcelClick || typeof originalOnParcelClick !== 'function') {
        if (typeof window !== 'undefined' && typeof window.onParcelClick === 'function') {
            originalOnParcelClick = window.onParcelClick;
        }
    }
    // Ensure we always return a function to avoid Leaflet listener errors
    return (typeof originalOnParcelClick === 'function')
        ? originalOnParcelClick
        : (typeof window !== 'undefined' && typeof window.onParcelClick === 'function'
            ? window.onParcelClick
            : function () { });
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
        } else {
            // User clicked on a parcel that's not part of any proposal while in proposals mode
            L.DomEvent.stopPropagation(e); // Stop event from propagating further
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage("Can't select individual parcels in Proposals mode. Uncheck \"Show Proposals\" first.");
            }
            return; // End execution here
        }
    }

    // If not in proposal mode, fall back to the original click handler.
    if (originalOnParcelClick && typeof originalOnParcelClick === 'function') {
        originalOnParcelClick.call(this, e);
    } else {
        console.error("Original onParcelClick handler is not available.");
    }
}

// Show proposal info panel
function showProposalInfo(proposal, currentParcelId = null) {
    const parcels = proposal.parcelIds.map(id => multiParcelSelection.findParcelById(id))
        .filter(p => {
            if (!p) return false;
            if (typeof p.getBounds !== 'function') return false;
            try {
                const center = p.getBounds().getCenter();
                if (!center || isNaN(center.lat) || isNaN(center.lng)) return false;
                if (Math.abs(center.lat) > 90 || Math.abs(center.lng) > 180) return false;
                return true;
            } catch (e) {
                return false;
            }
        });
    const totalArea = parcels.reduce((sum, parcel) =>
        sum + (parcel.feature.properties.calculatedArea || 0), 0);

    // Determine current parcel - try passed parameter first, then global selectedParcelId
    const selectedParcelId = currentParcelId || window.selectedParcelId;
    const isCurrentParcelInProposal = selectedParcelId && proposal.parcelIds.includes(selectedParcelId);
    const hasCurrentParcelAccepted = selectedParcelId && proposal.acceptedParcelIds && proposal.acceptedParcelIds.includes(selectedParcelId);

    // Update the proposal details panel title
    const proposalPanelTitle = document.getElementById('proposal-details-title');
    if (proposalPanelTitle) {
        proposalPanelTitle.textContent = 'Proposal Details';
    }

    const content = `
        <div class="proposal-info">
            <div class="proposal-header">
                                  <div class="proposal-title-row">
                <h4>${proposal.title}</h4>
                      <div class="proposal-status ${proposal.status === 'Executed' ? 'executed' : 'active'}">${proposal.status || 'Active'}</div>
                  </div>
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
            const parcelId = parcel.feature.properties.CESTICA_ID;
            const area = parcel.feature.properties.calculatedArea || 0;
            const isRoad = localStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
            const hasAccepted = proposal.acceptedParcelIds && proposal.acceptedParcelIds.includes(parcelId.toString());

            // Get parcel owner information
            const ownerId = localStorage.getItem(`parcel_${parcelId}_owner`);
            let ownerAvatarHtml = '';

            if (ownerId && typeof agentStorage !== 'undefined') {
                const owner = agentStorage.getAgent(ownerId);
                if (owner && typeof getAvatarImagePath === 'function') {
                    ownerAvatarHtml = `<img src="${getAvatarImagePath(owner.avatarIndex)}" class="parcel-owner-avatar" style="width: 24px; height: 24px; border-radius: 50%; border: 2px solid #007bff; margin-right: 8px;" title="Owner: ${owner.name}">`;
                }
            }

            return `
                            <div class="proposal-parcel-item" onclick="event.stopPropagation(); event.preventDefault(); returnToParcelInfo('${parcelId}', event)" style="display: flex; align-items: center; justify-content: space-between; padding: 8px; border: 1px solid #ddd; margin-bottom: 5px; border-radius: 4px; cursor: pointer; ${hasAccepted ? 'background-color: #f8fff8;' : ''}" title="Click to view parcel details">
                                <div class="parcel-info" style="display: flex; align-items: center;">
                                    ${ownerAvatarHtml}
                                    <div>
                                        <span class="parcel-number" style="font-weight: 500;">Parcel ${parcel.feature.properties.BROJ_CESTICE}</span>
                                        <span class="parcel-details" style="color: #666; margin-left: 8px;">
                                        ${Math.round(area).toLocaleString('hr-HR')} m²
                                        ${isRoad ? ' • <span style="color: #28a745;">Road</span>' : ''}
                                    </span>
                                    </div>
                                </div>
                                <div class="parcel-status">
                                    ${hasAccepted ?
                    `<span style="color: #28a745; font-size: 12px; font-weight: 500;">✓ Accepted</span>` :
                    `<span style="color: #666; font-size: 12px;">Pending</span>`
                }
                                </div>
                            </div>
                        `;
        }).join('')}
                </div>
            </div>
        </div>
    `;

    document.getElementById('proposal-details-content').innerHTML = content;
    document.getElementById('proposal-details-panel').classList.add('visible');

    // Setup click listeners for any clickable links in the proposal info
    if (typeof setupGameLogClickListeners === 'function') {
        setupGameLogClickListeners();
    }
}



/**
 * Return to parcel info when clicking a parcel in the proposal details
 * @param {string} parcelId - The parcel ID to show info for
 */
function returnToParcelInfo(parcelId, event) {
    // Prevent event bubbling to avoid triggering parcel click handlers
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    // 1. Close the Proposal Details panel first
    hideProposalDetailsPanel(true);

    // 2. Uncheck the "show proposals" checkbox and update layers
    const showProposalsCheckbox = document.getElementById('showProposalsCheckbox');
    if (showProposalsCheckbox && showProposalsCheckbox.checked) {
        showProposalsCheckbox.checked = false;
        // Trigger the change event to update the proposal layer
        if (typeof updateProposalLayer === 'function') {
            updateProposalLayer();
        }
    }

    // 3. Select the parcel AFTER updateProposalLayer completes
    // Use setTimeout to ensure updateProposalLayer's synchronous operations complete first
    setTimeout(() => {
        if (typeof selectParcel === 'function') {
            selectParcel(parcelId);
        }
    }, 0); // Use 0ms timeout to defer to next tick of event loop
}

// Make returnToParcelInfo globally available
window.returnToParcelInfo = returnToParcelInfo;

/**
 * Hide the proposal details panel
 */
function hideProposalDetailsPanel(clearHighlights = false) {
    const proposalPanel = document.getElementById('proposal-details-panel');
    if (proposalPanel) {
        proposalPanel.classList.remove('visible');
    }

    // Clear any proposal highlights when closing
    if (clearHighlights && typeof clearProposalHighlights === 'function') {
        clearProposalHighlights();
    }
}

// Make hideProposalDetailsPanel globally available
window.hideProposalDetailsPanel = hideProposalDetailsPanel;

// Show proposal creation dialog
function showProposalDialog() {
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
    }

    if (selectedParcels.length === 0) {
        updateStatus('Please select at least one parcel to create a proposal.');
        return;
    }

    const totalArea = selectedParcels.reduce((sum, parcel) => {
        const area = parcel.feature?.properties?.calculatedArea || 0;
        return sum + area;
    }, 0);

    // Create parcel list HTML with error handling
    const parcelListHTML = selectedParcels.map(parcel => {
        const parcelNumber = parcel.feature?.properties?.BROJ_CESTICE || 'Unknown';
        const area = parcel.feature?.properties?.calculatedArea || 0;
        const parcelId = parcel.feature?.properties?.CESTICA_ID;

        // Get parcel owner information
        let ownerAvatarHtml = '';
        if (parcelId) {
            const ownerId = localStorage.getItem(`parcel_${parcelId}_owner`);
            if (ownerId && typeof agentStorage !== 'undefined') {
                const owner = agentStorage.getAgent(ownerId);
                if (owner && typeof getAvatarImagePath === 'function') {
                    ownerAvatarHtml = `<img src="${getAvatarImagePath(owner.avatarIndex)}" class="parcel-owner-avatar" style="width: 20px; height: 20px; border-radius: 50%; border: 2px solid #007bff; margin-right: 6px;" title="Owner: ${owner.name}">`;
                }
            }
        }

        return `
            <div class="proposal-parcel-item" style="display: flex; align-items: center;">
                ${ownerAvatarHtml}
                <div>
                    <span class="parcel-number">Parcel ${parcelNumber}</span>
                    <span class="parcel-area">(${Math.round(area).toLocaleString('hr-HR')} m²)</span>
                </div>
            </div>
        `;
    }).join('');

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

/**
 * Calculate and return bounds for a set of parcels
 * @param {Array} parcelIds - Array of parcel IDs
 * @returns {Object|null} Bounds object with center, north, south, east, west
 */
function calculateProposalBounds(parcelIds) {
    if (!parcelIds || parcelIds.length === 0) return null;

    const positions = [];
    const missingParcels = [];

    parcelIds.forEach(parcelId => {
        const parcel = multiParcelSelection.findParcelById(parcelId);
        if (parcel && typeof parcel.getBounds === 'function') {
            try {
                const bounds = parcel.getBounds();
                if (bounds && typeof bounds.getCenter === 'function') {
                    const center = bounds.getCenter();
                    if (center && !isNaN(center.lat) && !isNaN(center.lng)) {
                        positions.push(center);
                    }
                }
            } catch (e) {
                console.warn(`Error getting bounds for parcel ${parcelId}:`, e);
                missingParcels.push(parcelId);
            }
        } else {
            missingParcels.push(parcelId);
        }
    });

    if (positions.length === 0) {
        console.warn('Cannot calculate bounds - no valid parcel positions found');
        return null;
    }

    // Calculate bounding box
    let north = positions[0].lat;
    let south = positions[0].lat;
    let east = positions[0].lng;
    let west = positions[0].lng;

    positions.forEach(pos => {
        north = Math.max(north, pos.lat);
        south = Math.min(south, pos.lat);
        east = Math.max(east, pos.lng);
        west = Math.min(west, pos.lng);
    });

    // Calculate center
    const centerLat = (north + south) / 2;
    const centerLng = (east + west) / 2;

    const bounds = {
        center: { lat: centerLat, lng: centerLng },
        north: north,
        south: south,
        east: east,
        west: west,
        calculatedAt: new Date().toISOString(),
        parcelCount: positions.length,
        totalParcels: parcelIds.length
    };

    if (missingParcels.length > 0) {
        bounds.missingParcels = missingParcels;
        console.warn(`Bounds calculated from ${positions.length}/${parcelIds.length} parcels. Missing: ${missingParcels.join(', ')}`);
    }

    return bounds;
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

        // Calculate bounds for the proposal (for reliable positioning)
        const bounds = calculateProposalBounds(finalParcelIds);

        const proposal = {
            author,
            title: proposalType, // Use proposal type as the title
            description,
            offer,
            budget: offer, // Add budget field - initially same as offer
            parcelIds: finalParcelIds,
            type: 'parcel', // For future extension to road/building proposals
            acceptedParcelIds: [], // Track which parcels have accepted the proposal
            bounds: bounds, // Store bounds for reliable positioning
            createdAt: new Date().toISOString() // Add creation timestamp
        };

        const hash = proposalStorage.addProposal(proposal);
        if (hash === null) {
            alert('This exact proposal already exists');
            return;
        }

        // Update the show proposals button count
        updateShowProposalsButton();
        // Log user action for proposal creation
        const userAgent = getCurrentUserAgent();
        if (userAgent && typeof addUserActionToGameLog === 'function') {
            addUserActionToGameLog(`<a href="#" data-agent-id="${userAgent.id}" class="agent-link agent-link-clickable">${userAgent.name}</a> created a ${proposalType} proposal (<a href="#" data-proposal-hash="${hash.substring(0, 8)}" class="proposal-link proposal-link-clickable">${hash.substring(0, 8)}</a>) for ${proposal.parcelIds.length} parcel(s) with budget ${offer} ETH.`);

            // Update user agent's created proposals
            if (!userAgent.proposalsCreated) {
                userAgent.proposalsCreated = [];
            }
            if (!userAgent.proposalsCreated.includes(hash)) {
                userAgent.proposalsCreated.push(hash);
                agentStorage.updateAgent(userAgent.id, { proposalsCreated: userAgent.proposalsCreated });
            }
        }

        // Enable show proposals mode and clear multi-selection
        enableShowProposalsMode();

        // Hide parcel info panel if needed
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
    const allProposals = proposalStorage.getAllProposals();

    // Separate active and executed proposals
    const activeProposals = allProposals.filter(p => p.status !== 'Executed');
    const executedProposals = allProposals.filter(p => p.status === 'Executed');

    // Sort proposals
    // Active: by creation time descending (newest first)
    activeProposals.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Executed: by execution time descending (most recently executed first)
    executedProposals.sort((a, b) => {
        const aTime = a.executedAt || a.createdAt; // fallback to createdAt if no executedAt
        const bTime = b.executedAt || b.createdAt;
        return new Date(bTime) - new Date(aTime);
    });

    // Create or update proposal list modal
    let modal = document.querySelector('.proposal-list-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.className = 'proposal-list-modal';
        document.body.appendChild(modal);
    }

    // Helper function to render proposal items
    const renderProposalItems = (proposals, isExecuted = false) => {
        if (proposals.length === 0) {
            return `<p class="empty-proposals">No ${isExecuted ? 'executed' : 'active'} proposals.</p>`;
        }

        return proposals.map(proposal => `
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
                    ${isExecuted && proposal.executedAt ?
                ` • Executed: ${new Date(proposal.executedAt).toLocaleDateString()}` :
                ` • Created: ${new Date(proposal.createdAt).toLocaleDateString()}`
            }
                            </div>
                        </div>
        `).join('');
    };

    modal.innerHTML = `
        <div class="proposal-list-modal-content">
            <div class="proposal-list-modal-header">
                <h2>Parcel Proposals</h2>
                <button class="proposal-list-modal-close" onclick="closeProposalList()">&times;</button>
            </div>
            <div class="proposal-list-tabs">
                <button class="proposal-tab-btn active" onclick="switchProposalTab(this, 'active')">
                    Active (${activeProposals.length})
                </button>
                <button class="proposal-tab-btn" onclick="switchProposalTab(this, 'executed')">
                    Executed (${executedProposals.length})
                </button>
            </div>
            <div class="proposal-list-modal-body">
                <div id="active-proposals-tab" class="proposal-tab-content active">
                    ${renderProposalItems(activeProposals, false)}
                </div>
                <div id="executed-proposals-tab" class="proposal-tab-content">
                    ${renderProposalItems(executedProposals, true)}
                </div>
            </div>
        </div>
    `;

    modal.style.display = 'block';
}

// Switch between proposal tabs
function switchProposalTab(clickedTab, tabName) {
    // Remove active class from all tab buttons
    const tabButtons = document.querySelectorAll('.proposal-tab-btn');
    tabButtons.forEach(btn => btn.classList.remove('active'));

    // Add active class to clicked tab
    clickedTab.classList.add('active');

    // Hide all tab contents
    const tabContents = document.querySelectorAll('.proposal-tab-content');
    tabContents.forEach(content => content.classList.remove('active'));

    // Show selected tab content
    const targetTab = document.getElementById(`${tabName}-proposals-tab`);
    if (targetTab) {
        targetTab.classList.add('active');
    }
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

// Update the "Proposals List" button text with current count
function updateShowProposalsButton() {
    const button = document.getElementById('showProposalsButton');
    if (button) {
        const totalProposals = proposalStorage.getAllProposals().length;
        button.textContent = `Proposals List (${totalProposals})`;
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

        // Update the show proposals button count
        updateShowProposalsButton();

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

// Center map on proposal (unified function)
function centerOnProposal(proposalHash) {
    const proposal = proposalStorage.getProposal(proposalHash);
    if (!proposal) return;

    // Use the first parcel as the selected parcel for highlighting
    const firstParcelId = proposal.parcelIds[0];
    if (!firstParcelId) return;

    selectAndHighlightProposal(proposalHash, firstParcelId, true);
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
                    const proposalsContent = document.getElementById('proposals-content');
                    if (infoContent) infoContent.innerHTML = '';
                    if (proposalsContent) proposalsContent.innerHTML = '';
                }
            }
        }

        // Close proposal list modal if open
        closeProposalList();

        // Update status
        updateStatus(`Cleared ${proposalCount} proposal${proposalCount !== 1 ? 's' : ''} from local storage`);

        // Update the show proposals button count
        updateShowProposalsButton();

    } catch (error) {
        console.error('Error clearing proposal data:', error);
        updateStatus('Error clearing proposal data. Please try again.');
    }
}

// Load proposals when page loads
proposalStorage.load();

/**
 * Handle multi-select checkbox change with mutual exclusivity
 */
function handleMultiSelectChange() {
    const multiSelectCheckbox = document.getElementById('multiSelectCheckbox');
    const showProposalsCheckbox = document.getElementById('showProposalsCheckbox');

    if (multiSelectCheckbox.checked) {
        // Disable show proposals when multi-select is enabled
        if (showProposalsCheckbox.checked) {
            showProposalsCheckbox.checked = false;
            updateProposalLayer();
        }
        multiParcelSelection.toggle();
    } else {
        multiParcelSelection.toggle();
    }
}

/**
 * Handle show proposals checkbox change with mutual exclusivity
 */
function handleShowProposalsChange() {
    const multiSelectCheckbox = document.getElementById('multiSelectCheckbox');
    const showProposalsCheckbox = document.getElementById('showProposalsCheckbox');

    if (showProposalsCheckbox.checked) {
        // Disable multi-select when show proposals is enabled
        if (multiSelectCheckbox.checked) {
            multiSelectCheckbox.checked = false;
            multiParcelSelection.toggle(); // This will turn off multi-select
        }

        // Close parcel info panel when proposals mode is enabled
        if (typeof hideParcelInfoPanel === 'function') {
            hideParcelInfoPanel();
        }
    } else {
        // Close proposal details panel when proposals mode is disabled
        if (typeof hideProposalDetailsPanel === 'function') {
            hideProposalDetailsPanel(true); // true to clear highlights
        }
    }

    updateProposalLayer();
}

/**
 * Helper function to enable show proposals mode and clear multi-selection
 * This ensures consistent behavior across all places that enable show proposals
 */
function enableShowProposalsMode() {
    const showProposalsCheckbox = document.getElementById('showProposalsCheckbox');
    const multiSelectCheckbox = document.getElementById('multiSelectCheckbox');

    // Clear multi-selection first if it's active
    if (multiSelectCheckbox && multiSelectCheckbox.checked) {
        multiSelectCheckbox.checked = false;
        if (typeof multiParcelSelection !== 'undefined') {
            // Properly disable multi-select mode, not just clear selection
            multiParcelSelection.isActive = false;
            multiParcelSelection.clearSelection();
        }
    }

    // Enable show proposals mode
    if (showProposalsCheckbox && !showProposalsCheckbox.checked) {
        showProposalsCheckbox.checked = true;
        // Trigger the change event to update the proposal layer
        if (typeof updateProposalLayer === 'function') {
            updateProposalLayer();
        }
    }
}

// Make functions available globally
window.showProposalDialog = showProposalDialog;
window.closeProposalDialog = closeProposalDialog;
window.createProposal = createProposal;
window.showAllProposalsModal = showAllProposalsModal;
window.switchProposalTab = switchProposalTab;
window.closeProposalList = closeProposalList;
window.updateShowProposalsButton = updateShowProposalsButton;
window.updateProposalLayer = updateProposalLayer;
window.clearLocalProposalData = clearLocalProposalData;
window.centerOnProposal = centerOnProposal;
window.reapplyProposalHighlights = reapplyProposalHighlights;
window.selectProposalFromList = selectProposalFromList;
window.cancelMultiParcelSelection = cancelMultiParcelSelection;
window.deleteProposal = deleteProposal;
window.handleMultiSelectChange = handleMultiSelectChange;
window.handleShowProposalsChange = handleShowProposalsChange;
window.enableShowProposalsMode = enableShowProposalsMode;
window.refreshProposalData = refreshProposalData;
window.selectAndHighlightProposal = selectAndHighlightProposal;
window.calculateProposalBounds = calculateProposalBounds;

// Handle selection of a proposal from the multiple proposals list
function selectProposalFromList(proposalHash, parcelId) {
    const proposal = proposalStorage.getProposal(proposalHash);
    if (!proposal) {
        console.error('Proposal not found:', proposalHash);
        updateStatus('Error: Proposal not found');
        return;
    }

    selectAndHighlightProposal(proposalHash, parcelId, true);
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

// Accept proposal function (for specific parcel) - pure data function
function acceptProposal(proposalHash, parcelId) {

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

        // Convert parcelId to string to ensure consistency
        const parcelIdStr = String(parcelId);

        // Double-check to prevent duplicates (in case of data type issues)
        if (!proposal.acceptedParcelIds.includes(parcelIdStr)) {
            proposal.acceptedParcelIds.push(parcelIdStr);
        }

        // Also ensure all parcelIds are strings for consistent comparison
        const parcelIdsAsStrings = proposal.parcelIds.map(id => String(id));
        const acceptedIdsAsStrings = proposal.acceptedParcelIds.map(id => String(id));

        // Update the proposal in storage
        proposalStorage.proposals.set(proposalHash, proposal);
        proposalStorage.save();

        // Find the parcel info for display
        const parcel = multiParcelSelection.findParcelById(parcelId);
        const parcelNumber = parcel?.feature?.properties?.BROJ_CESTICE || parcelId;

        // Check if all parcels have now accepted the proposal (using string comparison)
        if (acceptedIdsAsStrings.length === parcelIdsAsStrings.length) {
            // console.log('🎉 All parcels have accepted! Executing proposal...');
            // All parcels have accepted - execute the proposal
            proposal.status = 'Executed';
            proposal.executedAt = new Date().toISOString(); // Add execution timestamp
            proposalStorage.proposals.set(proposalHash, proposal);
            proposalStorage.save();

            // Update the show proposals button count (status changed)
            updateShowProposalsButton();

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
                showEphemeralMessage(`Proposal ${proposal.proposalHash.substring(0, 6)} executed! All ${proposal.parcelIds.length} parcels accepted`);
            } else if (proposal.buildingGeometry && (proposal.buildingGeometry.type === 'Polygon' || proposal.buildingGeometry.type === 'MultiPolygon')) {
                // Execute building proposal - add to proposed buildings layer
                if (typeof addProposedBuildingToMap === 'function') {
                    addProposedBuildingToMap(proposal.buildingGeometry, {
                        proposalHash: proposal.proposalHash,
                        proposalType: proposal.title
                    });
                }

                showEphemeralMessage(`Proposal ${proposal.proposalHash.substring(0, 6)} executed! All ${proposal.parcelIds.length} parcels accepted`);
            }

            return 'All accepted';
        }
    } catch (error) {
        console.error('Error accepting proposal:', error);
        alert('Error accepting proposal. Please try again.');
    }
}

// Accept proposal function (for specific parcel)
function handleUserAcceptProposal(proposalHash, parcelId) {
    // Get current user agent
    const userAgent = getCurrentUserAgent();
    if (!userAgent) {
        alert('You must be logged in to accept proposals.');
        return;
    }

    // Check if user owns this parcel
    const parcelOwner = localStorage.getItem(`parcel_${parcelId}_owner`);
    if (parcelOwner !== userAgent.id) {
        alert('You can only accept proposals for parcels you own.');
        return;
    }

    // Call the data logic function
    const result = acceptProposal(proposalHash, parcelId);
    if (result === 'All accepted') {
        showEphemeralMessage(`Proposal ${proposalHash.substring(0, 8)} executed!`);

        // Log user action for proposal execution
        if (typeof addUserActionToGameLog === 'function') {
            const proposal = proposalStorage.getProposal(proposalHash);
            addUserActionToGameLog(`<a href="#" data-agent-id="${userAgent.id}" class="agent-link agent-link-clickable">${userAgent.name}</a> executed proposal <a href="#" data-proposal-hash="${proposalHash.substring(0, 8)}" class="proposal-link proposal-link-clickable">${proposalHash.substring(0, 8)}</a> by accepting parcel ${parcelId}.`);
        }

        // Update user agent's executed proposals
        if (!userAgent.proposalsExecuted) {
            userAgent.proposalsExecuted = [];
        }
        if (!userAgent.proposalsExecuted.includes(proposalHash)) {
            userAgent.proposalsExecuted.push(proposalHash);
            agentStorage.updateAgent(userAgent.id, { proposalsExecuted: userAgent.proposalsExecuted });
        }
    } else {
        // Log user acceptance action
        if (typeof addUserActionToGameLog === 'function') {
            const proposal = proposalStorage.getProposal(proposalHash);
            addUserActionToGameLog(`<a href="#" data-agent-id="${userAgent.id}" class="agent-link agent-link-clickable">${userAgent.name}</a> accepted proposal <a href="#" data-proposal-hash="${proposalHash.substring(0, 8)}" class="proposal-link proposal-link-clickable">${proposalHash.substring(0, 8)}</a> for parcel ${parcelId}.`);
        }

        // Update user agent's accepted proposals
        if (!userAgent.proposalsAccepted) {
            userAgent.proposalsAccepted = [];
        }
        if (!userAgent.proposalsAccepted.includes(proposalHash)) {
            userAgent.proposalsAccepted.push(proposalHash);
            agentStorage.updateAgent(userAgent.id, { proposalsAccepted: userAgent.proposalsAccepted });
        }
    }

    // After the data is updated, call the UI refresh function
    const updatedProposal = proposalStorage.getProposal(proposalHash);
    if (updatedProposal) {
        showProposalInfo(updatedProposal, parcelId);
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

    // Initialize the show proposals button count
    updateShowProposalsButton();
});

// Make objects globally available
window.proposalStorage = proposalStorage;
window.multiParcelSelection = multiParcelSelection;

// Ensure count is correct once DOM is ready
if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        if (typeof updateShowProposalsButton === 'function') {
            updateShowProposalsButton();
        }
    });
}

// --- Cross-module coordination ---
// When fresh parcel data arrive, restore whichever visual layers are currently active
window.addEventListener('parcelDataLoaded', () => {
    // 1) If proposal mode is active, restyle parcels & handlers
    const showProposalsCheckbox = document.getElementById('showProposalsCheckbox');
    if (showProposalsCheckbox && showProposalsCheckbox.checked && typeof updateProposalLayer === 'function') {
        updateProposalLayer();
    }

    // 2) If a single parcel is selected (parcel mode), restore its highlight
    if (window.selectedParcelId && typeof parcelLayer !== 'undefined' && parcelLayer) {
        const layer = parcelLayer.getLayers().find(l => l.feature && l.feature.properties && l.feature.properties.CESTICA_ID.toString() === window.selectedParcelId.toString());
        if (layer && typeof selectedParcelStyle !== 'undefined') {
            layer.setStyle(selectedParcelStyle);
            layer.bringToFront();
        }
    }

    // 3) If block layer logic needs refresh it can listen separately; we keep focus on proposals/selection here
});