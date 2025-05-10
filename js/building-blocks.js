// Building blocks functionality
let selectedBlockName = null;
// Add blockify modal variables
let blockifyMap = null;
let blockifyParcelLayer = null;
let blockifyBuildingLayer = null;
let generatedBuildingFeature = null;
// Default parameter values
const DEFAULT_SETBACK = 2; // meters
const DEFAULT_BUILDING_WIDTH = 10; // meters
let currentSetback = DEFAULT_SETBACK;
let currentBuildingWidth = DEFAULT_BUILDING_WIDTH;
let livePreviewEnabled = false;
let blockifyBlock = null;

// Algorithm descriptions
const algorithmDescriptions = {
    "donji-grad": "Fully enclosed blocks with no gaps, courtyards in the middle.",
    "spansko-1": "Blocks enclosed from three sides, one side is open.",
    "stenjevec-1": "Rounded blocks with two gaps."
};

function updateBlockifyButton() {
    // Use the updateBlockButtonStates function in index.html to handle all button states
    if (typeof updateBlockButtonStates === 'function') {
        updateBlockButtonStates();
    } else {
        // Fallback if the function doesn't exist yet (to prevent errors during page load)
        const blockifyButton = document.getElementById('blockifyButton');
        const showBlocks = document.getElementById('showBlocks').checked;
        blockifyButton.style.display = showBlocks && selectedBlockName ? 'inline-block' : 'none';
    }
}

// Function to show error popup
function showErrorPopup(message) {
    // Create modal container
    const modal = document.createElement('div');
    modal.style.position = 'fixed';
    modal.style.top = '0';
    modal.style.left = '0';
    modal.style.width = '100%';
    modal.style.height = '100%';
    modal.style.backgroundColor = 'rgba(0,0,0,0.5)';
    modal.style.display = 'flex';
    modal.style.justifyContent = 'center';
    modal.style.alignItems = 'center';
    modal.style.zIndex = '2000';

    // Create modal content
    const modalContent = document.createElement('div');
    modalContent.style.backgroundColor = 'white';
    modalContent.style.padding = '20px';
    modalContent.style.borderRadius = '5px';
    modalContent.style.maxWidth = '400px';
    modalContent.style.textAlign = 'center';

    // Add message
    const messageElement = document.createElement('p');
    messageElement.textContent = message;
    messageElement.style.marginBottom = '20px';

    // Add OK button
    const okButton = document.createElement('button');
    okButton.textContent = 'OK';
    okButton.style.padding = '8px 16px';
    okButton.style.backgroundColor = '#007bff';
    okButton.style.color = 'white';
    okButton.style.border = 'none';
    okButton.style.borderRadius = '4px';
    okButton.style.cursor = 'pointer';
    okButton.onclick = function () {
        document.body.removeChild(modal);
    };

    // Assemble modal
    modalContent.appendChild(messageElement);
    modalContent.appendChild(okButton);
    modal.appendChild(modalContent);

    // Add to document
    document.body.appendChild(modal);
}

// Update the highlightBlock function to handle blockify button
const originalHighlightBlock = highlightBlock;
highlightBlock = function (blockName) {
    selectedBlockName = blockName;
    updateBlockifyButton();
    originalHighlightBlock(blockName);
};

// Update the toggleLayer function to handle blockify button
const originalToggleLayer = toggleLayer;
toggleLayer = function (layerType) {
    originalToggleLayer(layerType);
    if (layerType === 'blocks') {
        updateBlockifyButton();
    }
};

// Add these variables at the top with other layer variables
let proposedBuildingLayer = null;
let proposedBuildings = [];

// Add this function to update the proposed buildings layer
function updateProposedBuildingsLayer() {
    if (proposedBuildingLayer) {
        map.removeLayer(proposedBuildingLayer);
        proposedBuildingLayer = null;
    }

    if (proposedBuildings.length > 0) {
        proposedBuildingLayer = L.featureGroup().addTo(map);

        proposedBuildings.forEach((building, index) => {
            try {
                L.geoJSON(building, {
                    style: {
                        fillColor: '#ff3300',
                        fillOpacity: 0.4,
                        color: '#ff3300',
                        weight: 2
                    }
                }).addTo(proposedBuildingLayer);
            } catch (error) {
                console.error(`Error rendering proposed building at index ${index}:`, error, building);
                // Remove the faulty building from the array to prevent further errors
                proposedBuildings.splice(index, 1);
                // Show the popup to the user
                showErrorPopup('Building block creation failed -- Error rendering the generated building shape. The parcel might be too complex.');
                // Optionally, stop processing further buildings if one fails
                // return; // Uncomment this line if you want to stop after the first error
            }
        });
    }
}

// Function to show the blockify modal
function showBlockifyModal() {
    if (!selectedBlockName || !blockStorage.blocks.has(selectedBlockName)) {
        document.getElementById('status').textContent = 'No block selected';
        return;
    }

    const block = blockStorage.blocks.get(selectedBlockName);
    if (!block.parcels.length) {
        document.getElementById('status').textContent = 'Block has no parcels';
        return;
    }

    // Store the block globally for the modal
    blockifyBlock = block;

    console.log('Blockify modal');

    // Create modal elements
    if (!document.getElementById('blockify-modal')) {
        const modalDiv = document.createElement('div');
        modalDiv.id = 'blockify-modal';
        modalDiv.style.position = 'fixed';
        modalDiv.style.top = '0';
        modalDiv.style.left = '0';
        modalDiv.style.width = '100%';
        modalDiv.style.height = '100%';
        modalDiv.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
        modalDiv.style.zIndex = '1000';
        modalDiv.style.display = 'flex';
        modalDiv.style.alignItems = 'center';
        modalDiv.style.justifyContent = 'center';

        const container = document.createElement('div');
        container.id = 'blockify-container';
        container.style.backgroundColor = 'white';
        container.style.padding = '0';
        container.style.borderRadius = '8px';
        container.style.maxWidth = '90%';
        container.style.maxHeight = '90%';
        container.style.display = 'flex';
        container.style.flexDirection = 'row';

        container.innerHTML = `
            <div id="blockify-main" style="flex: 1; display: flex; flex-direction: column; min-width: 0;">
                <div id="blockify-header">
                    <h2>Blockify - Block ${selectedBlockName}</h2>
                    <button id="blockify-close">×</button>
                </div>
                <div id="blockify-map" style="flex: 1;"></div>
                <div id="blockify-controls">
                    <div id="blockify-info">Generating building...</div>
                    <div id="blockify-buttons">
                        <button class="blockify-button" id="btn-apply">Apply to Map</button>
                        <button class="blockify-button" id="btn-cancel">Cancel</button>
                    </div>
                </div>
            </div>
            <div id="blockify-sidebar">
                <div class="parameter-group">
                    <label for="algorithm-select">Algorithm:</label>
                    <select id="algorithm-select" disabled>
                        <option value="donji-grad" selected>Donji Grad</option>
                        <option value="spansko-1">Spansko 1</option>
                        <option value="stenjevec-1">Stenjevec 1</option>
                    </select>
                    <div id="algorithm-description" class="algorithm-description">
                        ${algorithmDescriptions["donji-grad"]}
                    </div>
                </div>
                <h3>Parameters</h3>
                <div class="parameter-group">
                    <label for="setback-slider">Setback (m): <span id="setback-value">${DEFAULT_SETBACK}</span></label>
                    <input type="range" id="setback-slider" min="0" max="50" value="${DEFAULT_SETBACK}" step="0.5">
                </div>
                <div class="parameter-group">
                    <label for="width-slider">Building Width (m): <span id="width-value">${DEFAULT_BUILDING_WIDTH}</span></label>
                    <input type="range" id="width-slider" min="1" max="100" value="${DEFAULT_BUILDING_WIDTH}" step="0.5">
                </div>
                <div class="parameter-group">
                    <label for="gaps-slider">Number of gaps: <span id="gaps-value">5</span></label>
                    <input type="range" id="gaps-slider" min="1" max="10" value="5" step="1" disabled>
                </div>
                <div class="parameter-group">
                    <label for="gap-width-slider">Gap width (m): <span id="gap-width-value">5</span></label>
                    <input type="range" id="gap-width-slider" min="1" max="20" value="5" step="1" disabled>
                </div>
                <div class="parameter-info">
                    <p>Adjust parameters using the sliders to modify the building shape.</p>
                    <p>Setback is the distance from the parcel boundary to the outer building edge.</p>
                    <p>Building width is the thickness of the building from outer to inner edge.</p>
                </div>
            </div>
        `;

        modalDiv.appendChild(container);
        document.body.appendChild(modalDiv);

        // Add event listeners
        document.getElementById('blockify-close').addEventListener('click', closeBlockifyModal);
        document.getElementById('btn-apply').addEventListener('click', applyBuildingToMap);
        document.getElementById('btn-cancel').addEventListener('click', closeBlockifyModal);

        // Add slider event listeners
        document.getElementById('setback-slider').addEventListener('input', function (e) {
            currentSetback = parseFloat(e.target.value);
            document.getElementById('setback-value').textContent = currentSetback.toFixed(1);
            generateBuildingInModal();
        });

        document.getElementById('width-slider').addEventListener('input', function (e) {
            currentBuildingWidth = parseFloat(e.target.value);
            document.getElementById('width-value').textContent = currentBuildingWidth.toFixed(1);
            generateBuildingInModal();
        });

        // Close modal when clicking outside the container
        modalDiv.addEventListener('click', (e) => {
            if (e.target === modalDiv) {
                closeBlockifyModal();
            }
        });
    }

    // Initialize the blockify map if needed
    if (!blockifyMap) {
        blockifyMap = L.map('blockify-map', {
            zoomControl: true,
            dragging: true,
            scrollWheelZoom: true
        });

        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '© OpenStreetMap contributors'
        }).addTo(blockifyMap);
    }

    // Display the block on the map
    displayBlockOnMap(block);

    // Reset parameter values
    currentSetback = DEFAULT_SETBACK;
    currentBuildingWidth = DEFAULT_BUILDING_WIDTH;

    // Update sliders if they exist
    const setbackSlider = document.getElementById('setback-slider');
    const widthSlider = document.getElementById('width-slider');

    if (setbackSlider) {
        setbackSlider.value = currentSetback;
        document.getElementById('setback-value').textContent = currentSetback.toFixed(1);
    }
    if (widthSlider) {
        widthSlider.value = currentBuildingWidth;
        document.getElementById('width-value').textContent = currentBuildingWidth.toFixed(1);
    }

    // Generate building immediately
    setTimeout(() => {
        generateBuildingInModal();
    }, 500); // Small delay to ensure the map is fully initialized
}

// Function to close the blockify modal
function closeBlockifyModal() {
    // Remove the map instance properly
    if (blockifyMap) {
        if (blockifyParcelLayer) {
            blockifyMap.removeLayer(blockifyParcelLayer);
            blockifyParcelLayer = null;
        }
        if (blockifyBuildingLayer) {
            blockifyMap.removeLayer(blockifyBuildingLayer);
            blockifyBuildingLayer = null;
        }
        blockifyMap.remove();
        blockifyMap = null;
    }

    // Clear the generated building
    generatedBuildingFeature = null;
    blockifyBlock = null;

    // Remove the modal from DOM
    const modal = document.getElementById('blockify-modal');
    if (modal) {
        // Remove all event listeners
        const closeBtn = document.getElementById('blockify-close');
        const applyBtn = document.getElementById('btn-apply');
        const cancelBtn = document.getElementById('btn-cancel');
        const setbackSlider = document.getElementById('setback-slider');
        const widthSlider = document.getElementById('width-slider');

        if (closeBtn) closeBtn.removeEventListener('click', closeBlockifyModal);
        if (applyBtn) applyBtn.removeEventListener('click', applyBuildingToMap);
        if (cancelBtn) cancelBtn.removeEventListener('click', closeBlockifyModal);
        if (setbackSlider) setbackSlider.removeEventListener('input', null);
        if (widthSlider) widthSlider.removeEventListener('input', null);

        modal.removeEventListener('click', closeBlockifyModal);

        // Remove the modal
        modal.remove();
    }

    // Force a reflow of the main map
    if (map) {
        map.invalidateSize();
    }

    // Reset parameters to defaults
    currentSetback = DEFAULT_SETBACK;
    currentBuildingWidth = DEFAULT_BUILDING_WIDTH;
}

// Display the block on the blockify map
function displayBlockOnMap(block) {
    // Clear existing layers
    if (blockifyParcelLayer) {
        blockifyMap.removeLayer(blockifyParcelLayer);
        blockifyParcelLayer = null;
    }

    // Create a feature collection for all parcels in the block
    const features = block.parcels.map(parcel => parcel.feature);
    const featureCollection = {
        type: 'FeatureCollection',
        features: features
    };

    // Add the parcels to the map
    blockifyParcelLayer = L.geoJSON(featureCollection, {
        style: {
            fillColor: 'red',
            fillOpacity: 0.2,
            color: 'red',
            weight: 2
        }
    }).addTo(blockifyMap);

    // Fit the map to the bounds of the block
    blockifyMap.fitBounds(blockifyParcelLayer.getBounds(), {
        padding: [50, 50]
    });
}

// Function to generate building in the modal only
function generateBuildingInModal() {
    if (!selectedBlockName || !blockStorage.blocks.has(selectedBlockName)) {
        return;
    }

    const block = blockStorage.blocks.get(selectedBlockName);
    if (!block.parcels.length) {
        return;
    }

    // Update info text to show generating status
    const infoElement = document.getElementById('blockify-info');
    if (infoElement) {
        infoElement.textContent = "Generating building...";
    }

    try {
        // Create a superparcel by merging all parcels in the block
        console.log(`Creating superparcel from ${block.parcels.length} parcels`);

        // Start with the first parcel
        let superparcel = block.parcels[0].feature;

        // Merge each subsequent parcel with the superparcel
        for (let i = 1; i < block.parcels.length; i++) {
            const nextParcel = block.parcels[i].feature;
            const merged = turf.union(superparcel, nextParcel);
            if (merged) {
                superparcel = merged;
            } else {
                console.warn(`Failed to merge parcel ${i} with superparcel`);
            }
        }

        if (!superparcel) {
            throw new Error('Failed to create superparcel');
        }

        // Create a simplified version of the superparcel
        const simplified = turf.simplify(superparcel, { tolerance: 0.0001, highQuality: true });
        if (!simplified || !simplified.geometry) {
            throw new Error('Failed to simplify superparcel');
        }

        // Calculate the maximum possible setback
        const area = turf.area(simplified);
        const perimeter = turf.length(simplified);
        const maxSetback = Math.sqrt(area / Math.PI) * 0.5; // Use 50% of the radius as max setback

        // Validate and adjust setback if needed
        let SETBACK = currentSetback;
        if (SETBACK > maxSetback) {
            SETBACK = maxSetback;
            // Update the slider and display value
            const setbackSlider = document.getElementById('setback-slider');
            if (setbackSlider) {
                setbackSlider.value = SETBACK;
                document.getElementById('setback-value').textContent = SETBACK.toFixed(1);
                currentSetback = SETBACK;
            }
        }

        // Create the outer building polygon (setback from superparcel)
        const outerBuilding = turf.buffer(simplified, -SETBACK, { units: 'meters' });
        if (!outerBuilding || !outerBuilding.geometry) {
            throw new Error('Failed to create outer building polygon');
        }

        // Try to create the inner building polygon
        let innerBuilding = null;
        let currentWidth = currentBuildingWidth;
        let minSideLength = Infinity;
        let attempts = 0;
        const MAX_ATTEMPTS = 20; // Limit the number of attempts to prevent infinite loops

        // Try with progressively smaller widths if needed
        while (currentWidth > 0 && !innerBuilding && attempts < MAX_ATTEMPTS) {
            try {
                const tempInner = turf.buffer(outerBuilding, -currentWidth, { units: 'meters' });
                if (tempInner && tempInner.geometry && tempInner.geometry.coordinates[0]) {
                    // Calculate minimum side length of the inner polygon
                    const coordinates = tempInner.geometry.coordinates[0];
                    minSideLength = Infinity;

                    for (let i = 0; i < coordinates.length - 1; i++) {
                        const p1 = coordinates[i];
                        const p2 = coordinates[i + 1];
                        const distance = turf.distance(turf.point(p1), turf.point(p2), { units: 'meters' });
                        minSideLength = Math.min(minSideLength, distance);
                    }

                    // If minimum side length is acceptable, use this inner building
                    if (minSideLength >= 2) {
                        innerBuilding = tempInner;
                        break;
                    }
                }
            } catch (e) {
                console.log(`Buffer operation failed (attempt ${attempts + 1}/${MAX_ATTEMPTS}), trying smaller width`);
            }
            currentWidth *= 0.8; // Reduce width by 20% each attempt
            attempts++;
        }

        if (!innerBuilding) {
            if (attempts >= MAX_ATTEMPTS) {
                throw new Error('Could not create valid inner building polygon - too many attempts. The parcel might be too complex or the requested dimensions too large.');
            } else {
                throw new Error('Could not create valid inner building polygon - minimum side length would be less than 2 meters');
            }
        }

        // If we had to reduce the width significantly, show a warning
        if (currentWidth < currentBuildingWidth * 0.5) {
            console.warn(`Building width was reduced from ${currentBuildingWidth}m to ${currentWidth}m to maintain minimum side length of 2m`);
        }

        // Create a building feature that represents the space between the two polygons
        const buildingFeature = {
            type: 'Feature',
            properties: {
                type: 'proposedBuilding',
                width: currentWidth,
                setback: SETBACK,
                block: selectedBlockName,
                minSideLength: minSideLength
            },
            geometry: {
                type: 'Polygon',
                coordinates: [
                    outerBuilding.geometry.coordinates[0],
                    innerBuilding.geometry.coordinates[0].reverse()
                ]
            }
        };

        // Store the generated building
        generatedBuildingFeature = buildingFeature;

        // Display the building on the modal map
        displayBuildingInModal(buildingFeature);

        // Update the sliders to reflect the actual values used
        const setbackSlider = document.getElementById('setback-slider');
        const widthSlider = document.getElementById('width-slider');

        if (setbackSlider) {
            // Only update if the value is different to avoid triggering another regeneration
            if (Math.abs(parseFloat(setbackSlider.value) - SETBACK) > 0.01) {
                // Temporarily remove the event listener
                const oldSetbackListener = setbackSlider.onchange;
                setbackSlider.onchange = null;

                setbackSlider.value = SETBACK;
                document.getElementById('setback-value').textContent = SETBACK.toFixed(1);
                currentSetback = SETBACK;

                // Restore the event listener
                setTimeout(() => {
                    setbackSlider.onchange = oldSetbackListener;
                }, 10);
            }
        }

        if (widthSlider) {
            // Only update if the value is different to avoid triggering another regeneration
            if (Math.abs(parseFloat(widthSlider.value) - currentWidth) > 0.01) {
                // Temporarily remove the event listener
                const oldWidthListener = widthSlider.onchange;
                widthSlider.onchange = null;

                widthSlider.value = currentWidth;
                document.getElementById('width-value').textContent = currentWidth.toFixed(1);
                currentBuildingWidth = currentWidth;

                // Restore the event listener
                setTimeout(() => {
                    widthSlider.onchange = oldWidthListener;
                }, 10);
            }
        }

        // Update the info text
        document.getElementById('blockify-info').textContent =
            `Building generated (width: ${currentWidth.toFixed(1)}m, setback: ${SETBACK.toFixed(1)}m)`;

        // Enable the apply button
        const applyButton = document.getElementById('btn-apply');
        if (applyButton) {
            applyButton.disabled = false;
        }

    } catch (error) {
        console.error('Error creating building block:', error);
        document.getElementById('blockify-info').textContent = `Error: ${error.message}`;

        // Only show error popup for algorithmic failures, not for slider validation
        if (!error.message.includes('Failed to create outer building polygon')) {
            showErrorPopup('Building block creation failed -- perhaps the parcel is too complex. Consider breaking it up with roads or try a different blockification algorithm.');
        }

        // Disable apply button if there was an error
        const applyButton = document.getElementById('btn-apply');
        if (applyButton) {
            applyButton.disabled = true;
        }
    }
}

// Function to display the building in the modal map
function displayBuildingInModal(buildingFeature) {
    // Remove existing building layer if it exists
    if (blockifyBuildingLayer) {
        blockifyMap.removeLayer(blockifyBuildingLayer);
        blockifyBuildingLayer = null;
    }

    // Add the building to the map
    blockifyBuildingLayer = L.geoJSON(buildingFeature, {
        style: {
            fillColor: '#ff3300',
            fillOpacity: 0.4,
            color: '#ff3300',
            weight: 2
        }
    }).addTo(blockifyMap);

    // Fit the map to show both the parcel and the building
    const bounds = blockifyParcelLayer.getBounds();
    blockifyMap.fitBounds(bounds, {
        padding: [50, 50]
    });
}

// Function to apply the building to the main map
function applyBuildingToMap() {
    if (generatedBuildingFeature) {
        // Add the building to the proposed buildings array
        proposedBuildings.push(generatedBuildingFeature);

        // Update the proposed buildings layer
        updateProposedBuildingsLayer();

        // Show proposed buildings layer
        document.getElementById('showProposedBuildings').checked = true;

        // Update status
        document.getElementById('status').textContent =
            `Created proposed building block in parcel block ${selectedBlockName} (width: ${generatedBuildingFeature.properties.width.toFixed(1)}m, setback: ${generatedBuildingFeature.properties.setback.toFixed(1)}m)`;

        // Close the modal
        closeBlockifyModal();
    } else {
        // Show error message if no building has been generated
        document.getElementById('blockify-info').textContent = "No building generated yet. Please try regenerating.";
    }
}

// Replace the existing generateBuilding function
function generateBuilding() {
    // This function is deprecated, using generateBuildingInModal instead
    generateBuildingInModal();
}

// Update the blockifySelectedBlock function to show modal
function blockifySelectedBlock() {
    console.log('Blockify selected block');
    showBlockifyModal();
}

document.getElementById('showBlocks').addEventListener('change', function (e) {
    if (e.target.checked) {
        // Load blocks from localStorage
        blockStorage.load();
        // Update the blocks list UI
        updateBlocksList();
        // Show the blocks list container
        const blocksListContainer = document.getElementById('blocks-list-container');
        if (blocksListContainer) {
            blocksListContainer.style.display = 'block';
        }
        // Update the block layer on the map
        updateBlockLayer();
    } else {
        // Hide the blocks list container
        const blocksListContainer = document.getElementById('blocks-list-container');
        if (blocksListContainer) {
            blocksListContainer.style.display = 'none';
        }
        // Remove block layer from map if it exists
        if (blockLayer) {
            map.removeLayer(blockLayer);
            blockLayer = null;
        }
    }
});
