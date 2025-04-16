// Add block storage management
const blockStorage = {
    blocks: new Map(),  // Key: blockName, Value: { parcels: [], valid: boolean }

    // Save blocks to localStorage
    save() {
        const data = Array.from(this.blocks.entries()).map(([name, block]) => ({
            name,
            parcelIds: block.parcels.map(p => p.feature.properties.CESTICA_ID),
            valid: block.valid
        }));
        localStorage.setItem('cadastre_blocks', JSON.stringify(data));
    },

    // Load blocks from localStorage
    load() {
        const data = localStorage.getItem('cadastre_blocks');
        if (data) {
            this.blocks.clear();
            JSON.parse(data).forEach(block => {
                // Find all parcels that match the stored IDs
                const parcels = [];
                if (parcelLayer) {
                    parcelLayer.eachLayer(layer => {
                        if (block.parcelIds.includes(layer.feature.properties.CESTICA_ID)) {
                            parcels.push(layer);
                        }
                    });
                }

                this.blocks.set(block.name, {
                    parcels,
                    parcelIds: block.parcelIds,
                    valid: block.valid
                });
            });
        }
    },

    // Add a new block
    addBlock(name, parcels, valid = true) {
        this.blocks.set(name, {
            parcels,
            parcelIds: parcels.map(p => p.feature.properties.CESTICA_ID),
            valid
        });
        this.save();
    },

    // Update block parcels (used when reloading the map)
    updateBlockParcels(name, parcels) {
        if (this.blocks.has(name)) {
            const block = this.blocks.get(name);
            block.parcels = parcels;
            this.blocks.set(name, block);
        }
    },

    // Clear all blocks
    clear() {
        this.blocks.clear();
        localStorage.removeItem('cadastre_blocks');
        console.log('Cleared all blocks.');
    },

    // Remove a block
    removeBlock(name) {
        const deleted = this.blocks.delete(name);
        if (deleted) {
            console.log(`Removed block: ${name}`);
            this.save();
        }
        return deleted;
    }
};

// Load blocks when the page loads
blockStorage.load();

// Add these arrays before the countBlocks function
const blockAdjectives = [
    "red", "blue", "green", "yellow", "purple", "orange", "white", "black", "gray", "brown",
    "tall", "short", "wide", "narrow", "deep", "shallow", "round", "square", "flat", "curved",
    "soft", "hard", "smooth", "rough", "sharp", "dull", "bright", "dark", "clear", "cloudy",
    "hot", "cold", "warm", "cool", "dry", "wet", "fresh", "stale", "clean", "dirty",
    "new", "old", "young", "ancient", "modern", "classic", "early", "late", "fast", "slow",
    "big", "small", "huge", "tiny", "long", "brief", "heavy", "light", "thick", "thin",
    "rich", "poor", "dense", "sparse", "full", "empty", "half", "double", "triple", "single",
    "sweet", "sour", "bitter", "mild", "wild", "tame", "calm", "busy", "quiet", "loud",
    "brave", "wise", "kind", "fair", "pure", "prime", "proud", "plain", "rare", "raw",
    "safe", "bold", "nice", "fine", "real", "free", "firm", "true", "sure", "main"
];

const blockNouns = [
    "hill", "lake", "tree", "rock", "bird", "fish", "star", "moon", "sun", "cloud",
    "river", "ocean", "beach", "field", "forest", "garden", "valley", "mountain", "desert", "island",
    "house", "door", "window", "table", "chair", "bed", "desk", "lamp", "clock", "book",
    "cat", "dog", "horse", "bear", "wolf", "lion", "tiger", "eagle", "owl", "deer",
    "rose", "daisy", "lily", "pine", "maple", "oak", "palm", "vine", "grass", "bush",
    "road", "path", "bridge", "gate", "wall", "fence", "tower", "castle", "palace", "temple",
    "wind", "rain", "snow", "storm", "fire", "water", "earth", "stone", "metal", "wood",
    "king", "queen", "knight", "guard", "sage", "chief", "guide", "friend", "hero", "child",
    "song", "bell", "drum", "flute", "voice", "sound", "echo", "wave", "light", "shade",
    "spring", "summer", "autumn", "winter", "dawn", "dusk", "day", "night", "time", "space"
];

function getBlockName(parcels) {
    // Sort parcel IDs to ensure consistent order
    const parcelIds = parcels
        .map(p => p.feature.properties.CESTICA_ID)
        .sort()
        .join(',');

    // Create a simple hash of the parcel IDs
    let hash = 0;
    for (let i = 0; i < parcelIds.length; i++) {
        const char = parcelIds.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }

    // Use absolute value of hash to get positive numbers
    hash = Math.abs(hash);

    // Get deterministic adjective and noun based on the hash
    const adjIndex = hash % blockAdjectives.length;
    const nounIndex = Math.floor(hash / blockAdjectives.length) % blockNouns.length;

    // Capitalize first letters and add a space between words
    const adjective = blockAdjectives[adjIndex].charAt(0).toUpperCase() +
        blockAdjectives[adjIndex].slice(1);
    const noun = blockNouns[nounIndex].charAt(0).toUpperCase() +
        blockNouns[nounIndex].slice(1);

    return `${adjective} ${noun}`; // Add space between words
}


// Helper function to check if a parcel is fully visible in the viewport
function isParcelFullyVisible(parcel) {
    const coordinates = parcel.feature.geometry.coordinates[0]; // Get the polygon coordinates
    const bounds = map.getBounds();
    return coordinates.every(coord => {
        // Check if each vertex is within the bounds
        return bounds.contains([coord[1], coord[0]]);
    });
}

// Helper function to check if two parcels share a boundary (using HTRS96 with tolerance)
function parcelsShareBoundary(p1, p2) {
    // Debug info for drawn roads
    const p1IsDrawnRoad = p1?.feature?.properties?.CESTICA_ID?.toString().startsWith('road_');
    const p2IsDrawnRoad = p2?.feature?.properties?.CESTICA_ID?.toString().startsWith('road_');

    // if (p1IsDrawnRoad || p2IsDrawnRoad) {
    //     console.log(`Checking boundary between ${p1?.feature?.properties?.CESTICA_ID} and ${p2?.feature?.properties?.CESTICA_ID}`);
    //     console.log(`Drawn road check - p1 is drawn road: ${p1IsDrawnRoad}, p2 is drawn road: ${p2IsDrawnRoad}`);
    // }

    // Ensure both parcels have valid features
    if (!p1?.feature || !p2?.feature) {
        console.warn("Invalid parcel features for boundary check");
        return false;
    }

    // Get HTRS96 coordinates on-the-fly
    const coords1 = getHtrsCoordinates(p1.feature);
    const coords2 = getHtrsCoordinates(p2.feature);

    // Check if we got valid coordinates
    if (!coords1.length || !coords2.length) {
        console.warn("Could not get valid HTRS coordinates for boundary check");
        return false;
    }

    // Define a small tolerance (e.g., 1cm in meters)
    const epsilon = 0.01; // 1 centimeter

    for (let i = 0; i < coords1.length; i++) {
        for (let j = 0; j < coords2.length; j++) {
            // Check if points are within the tolerance distance
            if (Math.abs(coords1[i][0] - coords2[j][0]) < epsilon &&
                Math.abs(coords1[i][1] - coords2[j][1]) < epsilon) {

                // Log match for drawn roads
                // if (p1IsDrawnRoad || p2IsDrawnRoad) {
                //     console.log(`Found boundary match between ${p1.feature.properties.CESTICA_ID} and ${p2.feature.properties.CESTICA_ID}`);
                // }

                return true; // Found a shared vertex within tolerance
            }
        }
    }

    // Log no match found for drawn roads
    // if (p1IsDrawnRoad || p2IsDrawnRoad) {
    //     console.log(`No boundary match found between ${p1.feature.properties.CESTICA_ID} and ${p2.feature.properties.CESTICA_ID}`);
    // }

    return false; // No shared vertices found within tolerance
}

// Helper function to find neighboring parcels
function findNeighbors(parcel, allParcels) {
    return allParcels.filter(p =>
        p !== parcel &&
        parcelsShareBoundary(parcel, p) &&
        !isRoad(p.feature.properties.CESTICA_ID)
    );
}

// Modify the countBlocks function to use block names instead of numbers
async function countBlocks() {
    if (!parcelLayer) {
        document.getElementById('status').textContent = 'No parcels loaded. Please refresh data first.';
        return;
    }

    const status = document.getElementById('status');
    const parcelsCountedLabel = document.getElementById('parcels-counted');
    const countButton = document.querySelector('button[onclick="countBlocks()"]');

    // Update button text and state immediately
    countButton.textContent = 'Counting...';
    countButton.disabled = true;
    countButton.style.backgroundColor = '#0056b3';
    countButton.offsetHeight; // Force reflow

    status.textContent = 'Counting blocks in view...';

    // Get current bounds and visible parcels
    const bounds = map.getBounds();
    const currentParcels = parcelLayer.getLayers().filter(layer => {
        // Basic check for valid layer and bounds
        if (!layer || typeof layer.getBounds !== 'function') return false;
        try {
            const parcelBounds = layer.getBounds();
            return bounds.intersects(parcelBounds);
        } catch (e) {
            console.warn("Error getting bounds for layer:", layer, e);
            return false;
        }
    });

    const totalParcelsInView = currentParcels.length;
    if (totalParcelsInView === 0) {
        status.textContent = 'No parcels in the current map view.';
        countButton.textContent = '(Re)count Blocks';
        countButton.disabled = false;
        countButton.style.backgroundColor = '#007bff';
        return;
    }

    console.log(`Starting count with ${totalParcelsInView} parcels in view.`);

    // Track blocks that will need to be removed (blocks that lost parcels)
    const blocksToRemove = new Set();

    // Track processed parcels to avoid double-counting
    const processed = new Set();
    let blockCount = 0;
    let parcelsProcessedCount = 0;

    const processChunk = async (startIndex) => {
        const endIndex = Math.min(startIndex + 50, totalParcelsInView);
        const chunk = currentParcels.slice(startIndex, endIndex);

        for (const parcel of chunk) {
            // Skip if already processed or this is a road
            if (!parcel || !parcel.feature || !parcel.feature.properties || !parcel.feature.properties.CESTICA_ID) {
                console.warn("Skipping invalid parcel:", parcel);
                continue;
            }

            const parcelId = parcel.feature.properties.CESTICA_ID.toString();
            if (processed.has(parcelId) || isRoad(parcelId)) {
                continue;
            }

            // Use floodfill to find connected non-road parcels
            const blockParcels = [];
            const isValid = floodfillBlock(parcel, blockParcels, currentParcels);

            // Mark all parcels found by floodfill as processed
            blockParcels.forEach(p => {
                if (p && p.feature && p.feature.properties && p.feature.properties.CESTICA_ID) {
                    processed.add(p.feature.properties.CESTICA_ID.toString());
                }
            });

            // Only create a block if it's valid and has parcels
            if (isValid && blockParcels.length > 0) {
                const blockName = getBlockName(blockParcels);

                // Check if any parcel is being reassigned to a different block
                blockParcels.forEach(p => {
                    if (p && p.feature && p.feature.properties) {
                        const oldBlock = p.feature.properties.block;
                        // If parcel had a different block before, add old block to removal list
                        if (oldBlock && oldBlock !== blockName) {
                            blocksToRemove.add(oldBlock);
                        }

                        // Update parcel with new block assignment
                        p.feature.properties.block = blockName;
                        p.feature.properties.blockValid = isValid;
                    }
                });

                // Add the block to storage
                blockStorage.addBlock(blockName, blockParcels, isValid);
                blockCount++;
            }
        }

        // Update progress
        parcelsProcessedCount += chunk.length;
        const progress = Math.round((parcelsProcessedCount / totalParcelsInView) * 100);
        parcelsCountedLabel.textContent = `Parcels processed: ${parcelsProcessedCount} / ${totalParcelsInView} (${progress}%)`;
        status.textContent = `Counting blocks... ${progress}%`;

        if (endIndex < totalParcelsInView) {
            // Schedule next chunk
            await new Promise(resolve => setTimeout(resolve, 0)); // Allow UI updates
            await processChunk(endIndex);
        } else {
            // All chunks processed, now remove blocks that lost parcels
            console.log(`Removing ${blocksToRemove.size} blocks that lost parcels:`, Array.from(blocksToRemove));
            blocksToRemove.forEach(blockName => {
                blockStorage.removeBlock(blockName);
            });

            // Update UI
            updateBlocksList();
            if (document.getElementById('showBlocks').checked) {
                updateBlockLayer();
            }

            // Restore button state
            countButton.textContent = '(Re)count Blocks';
            countButton.disabled = false;
            countButton.style.backgroundColor = '#007bff';
            status.textContent = `Finished count. Found ${blockCount} new blocks in the current view, removed ${blocksToRemove.size} blocks that lost parcels.`;
        }
    };

    // Start processing the first chunk
    await processChunk(0);
}

// Update the blocks list UI
function updateBlocksList() {
    const blocksContent = document.getElementById('blocks-content');
    if (!blocksContent) {
        console.warn("Blocks content element not found");
        return;
    }

    blocksContent.innerHTML = '';

    // Create array of blocks with their parcel counts
    const blocks = Array.from(blockStorage.blocks.entries()).map(([name, block]) => ({
        name: name,
        count: block.parcels.length
    }));

    // Sort blocks by parcel count
    blocks.sort((a, b) => b.count - a.count);

    // Create list items
    blocks.forEach(block => {
        const blockItem = document.createElement('div');
        blockItem.className = 'block-item';
        blockItem.dataset.block = block.name;
        blockItem.innerHTML = `
                    <span>${block.name}</span>
                    <span class="block-count">${block.count} parcels</span>
                `;
        blockItem.onclick = () => highlightBlock(block.name);
        blocksContent.appendChild(blockItem);
    });

    // Show the blocks list container
    const blocksListContainer = document.getElementById('blocks-list-container');
    if (blocksListContainer) {
        blocksListContainer.style.display = 'block';
    }
}

// Update highlightBlock function
function highlightBlock(blockName) {
    if (!blockStorage.blocks.has(blockName)) {
        document.getElementById('status').textContent = `Block ${blockName} not found`;
        return;
    }

    // Store the selected block name
    selectedBlockName = blockName;
    updateBlockifyButton();

    // Update block items UI
    document.querySelectorAll('.block-item').forEach(item => {
        item.classList.toggle('active', item.dataset.block === blockName);
    });

    // If block layer is visible, update the styles
    if (blockLayer) {
        blockLayer.eachLayer(layer => {
            const isSelected = layer.blockName === blockName;
            layer.setStyle({
                fillColor: isSelected ? '#3388ff' : 'yellow',
                fillOpacity: isSelected ? 0.4 : 0.2,
                color: isSelected ? '#3388ff' : 'yellow',
                weight: isSelected ? 2 : 1
            });
        });
    }

    // Calculate bounds and center map on block
    const block = blockStorage.blocks.get(blockName);
    if (block.parcels.length > 0) {
        const bounds = L.latLngBounds(block.parcels.map(p => p.getBounds()));
        map.fitBounds(bounds, { padding: [50, 50] });
    }

    // Show block info panel
    showBlockInfo(blockName);

    document.getElementById('status').textContent =
        `Highlighted block ${blockName} with ${block.parcels.length} parcels`;
}

// Modify the floodfill function to collect parcels instead of numbering them
function floodfillBlock(startParcel, blockParcels, allParcels) {
    const queue = [startParcel];
    const visited = new Set();
    let isValid = true;

    while (queue.length > 0) {
        const currentParcel = queue.shift();

        // Check for valid parcel structure
        if (!currentParcel || !currentParcel.feature || !currentParcel.feature.properties || !currentParcel.feature.properties.CESTICA_ID) {
            console.warn("Invalid parcel in floodfill queue:", currentParcel);
            continue;
        }

        const parcelId = currentParcel.feature.properties.CESTICA_ID.toString();

        if (visited.has(parcelId)) continue;
        visited.add(parcelId);

        // Check if parcel is fully visible
        if (!isParcelFullyVisible(currentParcel)) {
            isValid = false;
        }

        // Add to block parcels
        blockParcels.push(currentParcel);

        // Find and add neighbors to the queue
        const neighbors = findNeighbors(currentParcel, allParcels);
        queue.push(...neighbors);
    }

    return isValid;
}

// Add this function after the highlightBlock function
function hideBlocksList() {
    const blocksListContainer = document.getElementById('blocks-list-container');
    if (blocksListContainer) {
        blocksListContainer.style.display = 'none';
    }
}

// Add function to highlight block and center map on it
function highlightAndCenterBlock(blockName) {
    if (!blockStorage.blocks.has(blockName)) {
        document.getElementById('status').textContent = `Block ${blockName} not found`;
        return;
    }

    // Make sure the "Show Blocks" checkbox is checked
    const showBlocksCheckbox = document.getElementById('showBlocks');
    if (!showBlocksCheckbox.checked) {
        showBlocksCheckbox.checked = true;
        // Trigger the onchange event to ensure the layer is toggled
        toggleLayer('blocks');
    }

    // Highlight the block
    highlightBlock(blockName);

    // Calculate bounds of the block
    const block = blockStorage.blocks.get(blockName);
    if (block.parcels.length > 0) {
        const bounds = L.latLngBounds(block.parcels.map(p => p.getBounds()));
        // Fit map to the block bounds with some padding
        map.fitBounds(bounds, { padding: [50, 50] });
    }

    document.getElementById('status').textContent = `Focused on block ${blockName}`;
}

// Add function to clear blocks
function clearBlocks() {
    // Clear blocks from storage
    blockStorage.clear();

    // Clear blocks layer from map
    if (blockLayer) {
        map.removeLayer(blockLayer);
        blockLayer = null;
    }

    // Clear blocks layer from map
    if (window.verticesLayer) {
        map.removeLayer(window.verticesLayer);
        window.verticesLayer = null;
    }

    // Clear block properties from parcels
    if (parcelLayer) {
        parcelLayer.eachLayer(layer => {
            if (layer.feature && layer.feature.properties) {
                delete layer.feature.properties.block;
                delete layer.feature.properties.blockValid;
            }
        });
    }

    // Hide blocks list and info panel
    const blocksListContainer = document.getElementById('blocks-list-container');
    if (blocksListContainer) {
        blocksListContainer.style.display = 'none';
    }
    hideBlockInfo();

    // Reset selected block name in case it wasn't reset by hideBlockInfo
    selectedBlockName = null;

    // Update button states
    if (typeof updateBlockButtonStates === 'function') {
        updateBlockButtonStates();
    }

    // Update status
    document.getElementById('status').textContent = 'Blocks cleared from storage';
}

function showBlockInfo(blockName) {
    if (!blockStorage.blocks.has(blockName)) {
        return;
    }

    const block = blockStorage.blocks.get(blockName);
    const totalArea = block.parcels.reduce((sum, parcel) =>
        sum + (parcel.feature.properties.calculatedArea || 0), 0);

    // Format the content
    const content = `
        <div class="metric-group">
            <div class="metric-label">Block Name:</div>
            <div class="metric-value">${blockName}</div>
        </div>
        <div class="metric-group">
            <div class="metric-label">Number of Parcels:</div>
            <div class="metric-value">${block.parcels.length}</div>
        </div>
        <div class="metric-group">
            <div class="metric-label">Total Area:</div>
            <div class="metric-value">${Number(totalArea).toLocaleString('hr-HR')} m²</div>
        </div>
    `;

    // Update the parcels list
    const parcelsList = block.parcels.map(parcel => {
        const parcelId = parcel.feature.properties.CESTICA_ID;
        const parcelNumber = parcel.feature.properties.BROJ_CESTICE;
        const parcelArea = parcel.feature.properties.calculatedArea;
        return `
            <div class="parcel-item" style="cursor: pointer;" data-parcel-id="${parcelId}">
                Parcel ${parcelNumber} 
                (${Number(parcelArea).toLocaleString('hr-HR')} m²)
            </div>
        `;
    }).join('');

    document.getElementById('block-info-content').innerHTML = content;
    document.getElementById('block-parcels-list').innerHTML = parcelsList;
    document.getElementById('block-info-panel').classList.add('visible');

    // Add click event listeners to all parcel items
    document.querySelectorAll('.parcel-item').forEach(item => {
        item.addEventListener('click', function () {
            const parcelId = this.dataset.parcelId;
            console.log('Clicked parcel ID:', parcelId);

            // Find the parcel in the parcel layer
            let selectedParcel = null;
            parcelLayer.eachLayer(layer => {
                if (layer.feature.properties.CESTICA_ID.toString() === parcelId) {
                    selectedParcel = layer;
                    return false; // Break the loop
                }
            });

            if (selectedParcel) {
                // Store the selected parcel ID
                selectedParcelId = parcelId;

                // First remove any existing highlight from all parcels
                parcelLayer.eachLayer(layer => {
                    const isRoad = localStorage.getItem(`parcel_${layer.feature.properties.CESTICA_ID}_isRoad`) === 'true';
                    layer.setStyle(isRoad ? roadStyle : normalStyle);
                    layer.bringToBack();
                });

                // Then update the block layer if it exists
                if (blockLayer) {
                    blockLayer.eachLayer(layer => {
                        layer.bringToBack();
                    });
                }

                // Center map on parcel with some padding
                // Set isMapMoving to false to prevent unnecessary data fetch
                isMapMoving = false;
                map.fitBounds(selectedParcel.getBounds(), { padding: [50, 50] });

                // Now highlight the selected parcel and bring it to front
                selectedParcel.setStyle(selectedParcelStyle);
                selectedParcel.bringToFront();

                // Store the current parcel for checkbox updates
                currentParcel = {
                    id: parcelId,
                    layer: selectedParcel,
                    isRoad: localStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true'
                };

                // Show parcel info panel with metrics
                const metrics = calculateRoadMetrics(selectedParcel.feature.geometry.coordinates);
                showParcelInfoPanel(selectedParcel.feature, metrics);

                // Update the checkbox state
                document.getElementById('roadCheckbox').checked = currentParcel.isRoad;

                // Show the parcel info panel
                document.getElementById('parcel-info-panel').classList.add('visible');

                // Update status
                document.getElementById('status').textContent =
                    `Selected parcel ${selectedParcel.feature.properties.BROJ_CESTICE}`;
            } else {
                console.error('Could not find parcel with ID:', parcelId);
                document.getElementById('status').textContent = `Could not find parcel with ID: ${parcelId}`;
            }
        });
    });
}

function hideBlockInfo() {
    document.getElementById('block-info-panel').classList.remove('visible');

    // Reset selected block name
    selectedBlockName = null;

    // Update button states if function exists (it will after DOM is loaded)
    if (typeof updateBlockButtonStates === 'function') {
        updateBlockButtonStates();
    }
}

// Debug function to visualize floodfill algorithm from the currently selected parcel
let animationInProgress = false;
let animationQueue = [];
let animationLayers = [];

function animateFloodfillFromSelected() {
    // Check if animation is already running
    if (animationInProgress) {
        document.getElementById('status').textContent = 'Animation already in progress...';
        return;
    }

    // Check if a parcel is selected
    if (!currentParcel || !currentParcel.layer) {
        document.getElementById('status').textContent = 'No parcel selected. Please select a parcel first.';
        return;
    }

    const startParcel = currentParcel.layer;
    const bounds = map.getBounds();

    // Get all visible parcels in the current view
    const allParcels = parcelLayer.getLayers().filter(layer => {
        if (!layer || typeof layer.getBounds !== 'function') return false;
        try {
            return bounds.intersects(layer.getBounds());
        } catch (e) {
            console.warn("Error getting bounds for layer:", layer, e);
            return false;
        }
    });

    // Create a debug layer group to hold our animation
    if (!window.debugLayer) {
        window.debugLayer = L.layerGroup().addTo(map);
    } else {
        window.debugLayer.clearLayers();
    }

    // Clear previous animation artifacts
    animationLayers.forEach(layer => {
        if (map.hasLayer(layer)) {
            map.removeLayer(layer);
        }
    });
    animationLayers = [];

    // Start the animation
    animationInProgress = true;
    animationQueue = [];
    const blockParcels = [];
    const visited = new Set();
    const queue = [startParcel];

    document.getElementById('status').textContent = 'Starting floodfill animation...';

    // Create a style functions for our visualization
    const queuedStyle = {
        fillColor: '#FFA500', // Orange
        fillOpacity: 0.5,
        color: '#FFA500',
        weight: 2
    };

    const examiningStyle = {
        fillColor: '#FF00FF', // Magenta
        fillOpacity: 0.7,
        color: '#FF00FF',
        weight: 3
    };

    const rejectedStyle = {
        fillColor: '#FF0000', // Red
        fillOpacity: 0.3,
        color: '#FF0000',
        weight: 2
    };

    const addedStyle = {
        fillColor: '#00FF00', // Green
        fillOpacity: 0.4,
        color: '#00FF00',
        weight: 2
    };

    // Mark the starting parcel
    visited.add(startParcel.feature.properties.CESTICA_ID.toString());
    blockParcels.push(startParcel);

    // Visualize the starting parcel
    const startVisual = L.geoJSON(startParcel.toGeoJSON(), {
        style: addedStyle,
        interactive: false
    }).addTo(window.debugLayer);
    animationLayers.push(startVisual);

    // Process the queue with animation
    function processNextStep() {
        if (queue.length === 0) {
            // We're done
            finishAnimation(blockParcels);
            return;
        }

        const current = queue.shift();

        // Visualize the current parcel being examined
        const examiningVisual = L.geoJSON(current.toGeoJSON(), {
            style: examiningStyle,
            interactive: false
        }).addTo(window.debugLayer);
        animationLayers.push(examiningVisual);

        // Find neighbors
        const neighbors = findNeighbors(current, allParcels);

        // Process each neighbor
        let queuedCount = 0;
        const neighborVisuals = [];

        // Schedule processing of neighbors
        function processNeighbors(index) {
            if (index >= neighbors.length) {
                // Update the examining visual to "added" style
                window.debugLayer.removeLayer(examiningVisual);
                const addedVisual = L.geoJSON(current.toGeoJSON(), {
                    style: addedStyle,
                    interactive: false
                }).addTo(window.debugLayer);
                animationLayers.push(addedVisual);

                // Move to the next parcel in the queue
                setTimeout(processNextStep, 1000);
                return;
            }

            const neighbor = neighbors[index];
            const neighborId = neighbor.feature.properties.CESTICA_ID.toString();

            // Visualize this neighbor
            let neighborVisual;

            if (!visited.has(neighborId) && !isRoad(neighborId)) {
                // Unvisited non-road parcel - add to queue
                visited.add(neighborId);
                queue.push(neighbor);
                blockParcels.push(neighbor);
                queuedCount++;

                // Visualize as queued
                neighborVisual = L.geoJSON(neighbor.toGeoJSON(), {
                    style: queuedStyle,
                    interactive: false
                }).addTo(window.debugLayer);
            } else {
                // Already visited or is a road - rejected
                neighborVisual = L.geoJSON(neighbor.toGeoJSON(), {
                    style: rejectedStyle,
                    interactive: false
                }).addTo(window.debugLayer);
            }

            animationLayers.push(neighborVisual);
            neighborVisuals.push(neighborVisual);

            // Process the next neighbor after a delay
            setTimeout(() => processNeighbors(index + 1), 500);
        }

        processNeighbors(0);

        // Update status
        document.getElementById('status').textContent =
            `Floodfill animation: Examining parcel ${current.feature.properties.BROJ_CESTICE}, found ${queuedCount} new neighbors`;
    }

    // Start the animation
    setTimeout(processNextStep, 1000);

    function finishAnimation(blockParcels) {
        // Clear the debug layer after a moment
        setTimeout(() => {
            window.debugLayer.clearLayers();

            // Highlight the final block
            const blockHighlight = L.featureGroup().addTo(window.debugLayer);
            blockParcels.forEach(parcel => {
                L.geoJSON(parcel.toGeoJSON(), {
                    style: {
                        fillColor: '#3388ff',
                        fillOpacity: 0.4,
                        color: '#3388ff',
                        weight: 2
                    },
                    interactive: false
                }).addTo(blockHighlight);
            });

            animationInProgress = false;
            document.getElementById('status').textContent =
                `Floodfill animation complete. Found ${blockParcels.length} parcels in block.`;
        }, 2000);
    }
}

// Variables to keep track of highlighted neighbors
let neighborHighlightActive = false;
let highlightedNeighbors = [];

// Function to toggle neighbor highlighting
function toggleNeighborsHighlight() {
    // Get the button
    const neighborBtn = document.getElementById('neighboursButton');

    if (!neighborHighlightActive) {
        // Activate highlighting
        neighborHighlightActive = true;
        neighborBtn.classList.add('active');

        // Check if we have a selected parcel
        if (!currentParcel || !currentParcel.layer) {
            document.getElementById('status').textContent = 'No parcel selected. Please select a parcel first.';
            return;
        }

        highlightNeighbors(currentParcel.layer);
    } else {
        // Deactivate highlighting
        neighborHighlightActive = false;
        neighborBtn.classList.remove('active');

        // Clear all highlighted neighbors
        clearHighlightedNeighbors();
    }
}

// Function to highlight neighbors
function highlightNeighbors(parcel) {
    // Clear any existing highlighted neighbors first
    clearHighlightedNeighbors();

    // Get all visible parcels in the current view
    const bounds = map.getBounds();
    const allParcels = parcelLayer.getLayers().filter(layer => {
        if (!layer || typeof layer.getBounds !== 'function') return false;
        try {
            return bounds.intersects(layer.getBounds());
        } catch (e) {
            console.warn("Error getting bounds for layer:", layer, e);
            return false;
        }
    });

    // Find neighbors using the same boundary detection as in floodfill
    const neighbors = allParcels.filter(p =>
        p !== parcel &&
        parcelsShareBoundary(parcel, p)
    );

    // Style for normal (non-road) neighboring parcels
    const normalNeighborStyle = {
        color: 'white',
        weight: 3,
        opacity: 1,
        fillColor: 'white',
        fillOpacity: 0.4
    };

    // Style for road neighboring parcels
    const roadNeighborStyle = {
        color: 'black',
        weight: 3,
        opacity: 1,
        fillColor: 'black',
        fillOpacity: 0.4
    };

    // Create highlight layers for each neighbor
    neighbors.forEach(neighbor => {
        const isNeighborRoad = isRoad(neighbor.feature.properties.CESTICA_ID);

        // Create a highlight layer from the neighbor's GeoJSON
        const highlightLayer = L.geoJSON(neighbor.toGeoJSON(), {
            style: isNeighborRoad ? roadNeighborStyle : normalNeighborStyle,
            interactive: false
        }).addTo(map);

        // Store the created layer for later removal
        highlightedNeighbors.push(highlightLayer);
    });

    document.getElementById('status').textContent = `Highlighted ${neighbors.length} neighboring parcels`;
}

// Function to clear highlighted neighbors
function clearHighlightedNeighbors() {
    // Remove all highlighted neighbor layers from the map
    highlightedNeighbors.forEach(layer => {
        if (map.hasLayer(layer)) {
            map.removeLayer(layer);
        }
    });

    // Clear the array
    highlightedNeighbors = [];
}

// Variables to keep track of displayed vertices
let verticesDisplayActive = false;
let vertexMarkers = [];

// Function to toggle vertices display
function toggleVerticesDisplay() {
    // Get the button
    const verticesBtn = document.getElementById('verticesButton');

    if (!verticesDisplayActive) {
        // Activate vertices display
        verticesDisplayActive = true;
        verticesBtn.classList.add('active');

        // Check if we have a selected parcel
        if (!currentParcel || !currentParcel.layer) {
            document.getElementById('status').textContent = 'No parcel selected. Please select a parcel first.';
            return;
        }

        displayVertices(currentParcel.layer);
    } else {
        // Deactivate vertices display
        verticesDisplayActive = false;
        verticesBtn.classList.remove('active');

        // Clear all vertex markers
        clearVertexMarkers();
    }
}

// Function to display vertices for a parcel
function displayVertices(parcel) {
    // Clear any existing vertex markers first
    clearVertexMarkers();

    // Create a layer group for the vertices if it doesn't exist
    if (!window.verticesLayer) {
        window.verticesLayer = L.layerGroup().addTo(map);
    }

    // Get coordinates of the parcel
    if (!parcel.feature || !parcel.feature.geometry || !parcel.feature.geometry.coordinates) {
        console.error('Invalid parcel geometry for displaying vertices:', parcel);
        return;
    }

    // Extract the coordinates array (first polygon ring)
    const coordinates = parcel.feature.geometry.coordinates[0];

    // Generate HTRS96 coordinates on-the-fly
    const htrsCoordinates = getHtrsCoordinates(parcel.feature);

    // Create a marker for each vertex
    coordinates.forEach((coord, index) => {
        // For WGS84 coordinates, Leaflet expects [lat, lng]
        // coord is [lng, lat] in GeoJSON
        const latLng = L.latLng(coord[1], coord[0]);

        // Create SVG marker for better hover effects
        const marker = L.circleMarker(latLng, {
            radius: 4,
            className: 'vertex-marker'
        }).addTo(window.verticesLayer);

        // Format coordinate data for popup
        let popupContent;

        // Always show both coordinate systems since we're generating HTRS on-the-fly
        const htrsCoord = htrsCoordinates[index];
        if (htrsCoord) {
            popupContent = `
                <div style="font-family: monospace; font-size: 12px;">
                    <strong>Vertex #${index}</strong><br>
                    <strong>WGS84:</strong><br>
                    Lat: ${coord[1].toFixed(6)}°<br>
                    Lng: ${coord[0].toFixed(6)}°<br>
                    <hr style="margin: 4px 0;">
                    <strong>HTRS96/TM:</strong><br>
                    E: ${htrsCoord[0].toFixed(3)} m<br>
                    N: ${htrsCoord[1].toFixed(3)} m
                </div>`;
        } else {
            // Fallback if HTRS conversion failed
            popupContent = `
                <div style="font-family: monospace; font-size: 12px;">
                    <strong>Vertex #${index}</strong><br>
                    <strong>WGS84:</strong><br>
                    Lat: ${coord[1].toFixed(6)}°<br>
                    Lng: ${coord[0].toFixed(6)}°
                </div>`;
        }

        // Create the popup but don't bind it (we'll show it on hover)
        const popup = L.popup({
            offset: L.point(0, -4),
            closeButton: false,
            className: 'vertex-popup'
        }).setContent(popupContent);

        // Show popup on hover
        marker.on('mouseover', function (e) {
            this.bindPopup(popup).openPopup();
        });

        // Hide popup when not hovering
        marker.on('mouseout', function (e) {
            this.closePopup();
        });

        // Store markers for later cleanup
        vertexMarkers.push(marker);
    });

    document.getElementById('status').textContent = `Showing ${coordinates.length} vertices for parcel ${parcel.feature.properties.BROJ_CESTICE}`;
}

// Function to clear vertex markers
function clearVertexMarkers() {
    // Remove all vertex markers from the map
    vertexMarkers.forEach(marker => {
        if (map.hasLayer(marker)) {
            map.removeLayer(marker);
        }
    });

    // Clear the array
    vertexMarkers = [];

    // Clear the vertices layer if it exists
    if (window.verticesLayer) {
        window.verticesLayer.clearLayers();
    }
}

// Helper function to get HTRS96 coordinates on-the-fly from GeoJSON coordinates
function getHtrsCoordinates(feature) {
    if (!feature || !feature.geometry || !feature.geometry.coordinates || !feature.geometry.coordinates[0]) {
        console.warn('Invalid feature for HTRS conversion', feature);
        return [];
    }

    // Convert WGS84 [lng, lat] to HTRS96 [easting, northing]
    return feature.geometry.coordinates[0].map(coord => wgs84ToHTRS96(coord[1], coord[0]));
}

