// Building blocks functionality
let selectedBlockName = null;

function updateBlockifyButton() {
    const blockifyButton = document.getElementById('blockifyButton');
    const showBlocks = document.getElementById('showBlocks').checked;
    blockifyButton.style.display = showBlocks && selectedBlockName ? 'inline-block' : 'none';
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

// Update the blockifySelectedBlock function to create proposed buildings
function blockifySelectedBlock() {
    if (!selectedBlockName || !blockStorage.blocks.has(selectedBlockName)) {
        document.getElementById('status').textContent = 'No block selected';
        return;
    }

    const block = blockStorage.blocks.get(selectedBlockName);
    if (!block.parcels.length) {
        document.getElementById('status').textContent = 'Block has no parcels';
        return;
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

        // Create a building with setback and width
        const SETBACK = 5; // meters
        const BUILDING_WIDTH = 15; // meters

        // Create a simplified version of the superparcel
        const simplified = turf.simplify(superparcel, { tolerance: 0.0001, highQuality: true });
        if (!simplified || !simplified.geometry) {
            throw new Error('Failed to simplify superparcel');
        }

        // Calculate the area of the superparcel
        const area = turf.area(simplified);
        const minDimension = Math.sqrt(area) * 0.1; // Rough estimate of minimum dimension

        // Adjust setback and building width if they're too large
        const adjustedSetback = Math.min(SETBACK, minDimension * 0.2);
        const adjustedBuildingWidth = Math.min(BUILDING_WIDTH, minDimension * 0.3);

        // Create the outer building polygon (setback from superparcel)
        const outerBuilding = turf.buffer(simplified, -adjustedSetback, { units: 'meters' });
        if (!outerBuilding || !outerBuilding.geometry) {
            throw new Error('Failed to create outer building polygon');
        }

        // Try to create the inner building polygon
        let innerBuilding = null;
        let currentWidth = adjustedBuildingWidth;

        // Try with progressively smaller widths if needed
        while (currentWidth > 0 && !innerBuilding) {
            try {
                const tempInner = turf.buffer(outerBuilding, -currentWidth, { units: 'meters' });
                if (tempInner && tempInner.geometry && tempInner.geometry.coordinates[0]) {
                    innerBuilding = tempInner;
                    break;
                }
            } catch (e) {
                console.log('Buffer operation failed, trying smaller width');
            }
            currentWidth *= 0.8; // Reduce width by 20% each attempt
        }

        if (!innerBuilding) {
            throw new Error('Could not create valid inner building polygon');
        }

        // Create a building feature that represents the space between the two polygons
        const buildingFeature = {
            type: 'Feature',
            properties: {
                type: 'proposedBuilding',
                width: currentWidth,
                setback: adjustedSetback,
                block: selectedBlockName
            },
            geometry: {
                type: 'Polygon',
                coordinates: [
                    outerBuilding.geometry.coordinates[0],
                    innerBuilding.geometry.coordinates[0].reverse()
                ]
            }
        };

        // Add the building to the proposed buildings array
        proposedBuildings.push(buildingFeature);

        // Update the proposed buildings layer
        updateProposedBuildingsLayer();

        // Show proposed buildings layer
        document.getElementById('showProposedBuildings').checked = true;

        document.getElementById('status').textContent =
            `Created proposed building block in parcel block ${selectedBlockName} (width: ${currentWidth.toFixed(1)}m, setback: ${adjustedSetback.toFixed(1)}m)`;
    } catch (error) {
        console.error('Error creating building block:', error);
        document.getElementById('status').textContent = `Error creating building: ${error.message}`;
        showErrorPopup('Building block creation failed -- perhaps the parcel is too complex. Consider breaking it up with roads or try a different blockification algorithm.');
    }
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
