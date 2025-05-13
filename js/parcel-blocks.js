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
                return true; // Found a shared vertex within tolerance
            }
        }
    }

    return false; // No shared vertices found within tolerance
}

// Helper function to find neighboring parcels using a precomputed map
function findNeighbors(parcel, neighborMap) {
    if (!parcel || !parcel.feature || !parcel.feature.properties) return [];
    const parcelId = parcel.feature.properties.CESTICA_ID.toString();
    // Return neighbors from the map, filtering out any potential road parcels if needed elsewhere
    // (floodfill already checks isRoad, so maybe not needed here)
    return neighborMap.get(parcelId) || [];
}

// Modify the countBlocks function to pre-calculate neighbors
async function countBlocks() {
    if (!parcelLayer) {
        document.getElementById('status').textContent = 'No parcels loaded. Please refresh data first.';
        return;
    }

    const status = document.getElementById('status');
    const parcelsCountedLabel = document.getElementById('parcels-counted');
    const countButton = document.querySelector('button[onclick="countBlocks()"]');

    // Update button text and state immediately
    countButton.textContent = 'Preparing...';
    countButton.disabled = true;
    countButton.style.backgroundColor = '#0056b3';
    countButton.offsetHeight; // Force reflow

    status.textContent = 'Filtering visible parcels...';
    await new Promise(resolve => setTimeout(resolve, 0)); // Allow UI update

    // Get current bounds and visible parcels
    const bounds = map.getBounds();
    const currentParcels = parcelLayer.getLayers().filter(layer => {
        if (!layer || typeof layer.getBounds !== 'function') return false;
        try {
            const parcelBounds = layer.getBounds();
            // Optimization: Check bounds intersection first
            if (!bounds.intersects(parcelBounds)) {
                return false;
            }
            // Optional: Add a check for minimum overlap area if needed
            return true;
        } catch (e) {
            console.warn("Error getting bounds for layer:", layer, e);
            return false;
        }
    });

    const totalParcelsInView = currentParcels.length;
    if (totalParcelsInView === 0) {
        status.textContent = 'No parcels in the current map view.';
        countButton.textContent = '(Re)form blocks';
        countButton.disabled = false;
        countButton.style.backgroundColor = '#007bff';
        return;
    }

    console.log(`Starting count with ${totalParcelsInView} parcels in view.`);
    status.textContent = `Found ${totalParcelsInView} parcels. Pre-calculating neighbors...`;
    parcelsCountedLabel.textContent = `Parcels processed: 0 / ${totalParcelsInView} (0%)`;
    await new Promise(resolve => setTimeout(resolve, 0)); // Allow UI update

    // --- Pre-calculate Neighbors ---
    const neighborMap = new Map();
    const nonRoadParcels = currentParcels.filter(p => p.feature && p.feature.properties && !isRoad(p.feature.properties.CESTICA_ID));
    const totalNonRoad = nonRoadParcels.length;
    let pairsChecked = 0;
    const totalPairs = (totalNonRoad * (totalNonRoad - 1)) / 2; // Rough estimate

    for (let i = 0; i < totalNonRoad; i++) {
        const p1 = nonRoadParcels[i];
        const p1Id = p1.feature.properties.CESTICA_ID.toString();
        if (!neighborMap.has(p1Id)) neighborMap.set(p1Id, []);

        for (let j = i + 1; j < totalNonRoad; j++) {
            const p2 = nonRoadParcels[j];
            const p2Id = p2.feature.properties.CESTICA_ID.toString();
            if (!neighborMap.has(p2Id)) neighborMap.set(p2Id, []);

            // Optimization: Check bounding box intersection before expensive check
            try {
                if (p1.getBounds().intersects(p2.getBounds())) {
                    if (parcelsShareBoundary(p1, p2)) {
                        neighborMap.get(p1Id).push(p2);
                        neighborMap.get(p2Id).push(p1);
                    }
                }
            } catch (e) {
                console.warn(`Error checking boundary between ${p1Id} and ${p2Id}:`, e);
            }
            pairsChecked++;
        }

        // Update progress periodically during neighbor calculation
        if (i % 50 === 0 || i === totalNonRoad - 1) {
            const progress = totalPairs > 0 ? Math.round((pairsChecked / totalPairs) * 100) : 100;
            status.textContent = `Pre-calculating neighbors... (${progress}%)`;
            await new Promise(resolve => setTimeout(resolve, 0)); // Allow UI update
        }
    }
    console.log("Neighbor map calculated:", neighborMap.size, "parcels have neighbors.");
    status.textContent = 'Neighbor calculation complete. Counting blocks...';
    await new Promise(resolve => setTimeout(resolve, 0)); // Allow UI update
    // --- End Pre-calculate Neighbors ---


    // Track blocks that will need to be removed (blocks that lost parcels)
    const blocksToRemove = new Set();

    // Track processed parcels to avoid double-counting
    const processed = new Set();
    let blockCount = 0;
    let parcelsProcessedCount = 0;

    // Use the nonRoadParcels for the main loop now
    const processChunk = async (startIndex) => {
        const endIndex = Math.min(startIndex + 50, totalNonRoad); // Use totalNonRoad
        const chunk = nonRoadParcels.slice(startIndex, endIndex); // Use nonRoadParcels

        for (const parcel of chunk) {
            // Skip if already processed (road check is implicitly done by using nonRoadParcels)
            if (!parcel || !parcel.feature || !parcel.feature.properties || !parcel.feature.properties.CESTICA_ID) {
                console.warn("Skipping invalid parcel:", parcel);
                continue;
            }

            const parcelId = parcel.feature.properties.CESTICA_ID.toString();
            if (processed.has(parcelId)) {
                continue;
            }

            // Use floodfill to find connected non-road parcels, passing the neighborMap
            const blockParcels = [];
            // Pass neighborMap to floodfill
            const isValid = floodfillBlock(parcel, blockParcels, neighborMap);

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

        // Update progress based on non-road parcels processed
        parcelsProcessedCount += chunk.length;
        const progress = Math.round((parcelsProcessedCount / totalNonRoad) * 100);
        parcelsCountedLabel.textContent = `Parcels processed: ${parcelsProcessedCount} / ${totalNonRoad} (${progress}%)`;
        status.textContent = `Counting blocks... ${progress}%`;

        if (endIndex < totalNonRoad) {
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
            countButton.textContent = '(Re)form blocks';
            countButton.disabled = false;
            countButton.style.backgroundColor = '#007bff';
            status.textContent = `Finished count. Found ${blockCount} new blocks, removed ${blocksToRemove.size} blocks. Total non-road parcels processed: ${totalNonRoad}.`;
        }
    };

    // Start processing the first chunk
    await processChunk(0);
}

// Modify the floodfill function to accept the neighborMap
function floodfillBlock(startParcel, blockParcels, neighborMap) { // Changed last parameter
    const queue = [startParcel];
    const visited = new Set();
    let isValid = true; // Assume valid unless a non-visible parcel is found

    // Check visibility of the starting parcel itself
    if (!isParcelFullyVisible(startParcel)) {
        isValid = false;
        return isValid; // Return immediately if starting parcel is not visible
    }

    while (queue.length > 0 && isValid) { // Stop if block becomes invalid
        const currentParcel = queue.shift();

        // Check for valid parcel structure
        if (!currentParcel || !currentParcel.feature || !currentParcel.feature.properties || !currentParcel.feature.properties.CESTICA_ID) {
            console.warn("Invalid parcel in floodfill queue:", currentParcel);
            continue;
        }

        const parcelId = currentParcel.feature.properties.CESTICA_ID.toString();

        if (visited.has(parcelId)) continue;
        visited.add(parcelId);

        // Add to block parcels *before* checking visibility of neighbors
        blockParcels.push(currentParcel);

        // Find neighbors using the precomputed map
        const neighbors = findNeighbors(currentParcel, neighborMap); // Use the map

        for (const neighbor of neighbors) {
            if (neighbor && neighbor.feature && neighbor.feature.properties) {
                const neighborId = neighbor.feature.properties.CESTICA_ID.toString();
                if (!visited.has(neighborId)) {
                    // Check if the neighbor is fully visible *before* adding to queue
                    // If any neighbor isn't fully visible, the whole block is invalid
                    if (!isParcelFullyVisible(neighbor)) {
                        isValid = false;
                        break; // Break out of neighbor loop
                    }
                    queue.push(neighbor);
                }
            }
        }
        if (!isValid) break; // Break out of main loop if block is invalid
    }

    // The block is only valid if *all* its constituent parcels were fully visible
    return isValid;
}

// Show the blocks list popup
function showBlocksList() {
    const blocksListContainer = document.getElementById('blocks-list-container');
    if (blocksListContainer) {
        blocksListContainer.style.display = 'block';
    }
    updateBlocksList();
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

// Helper for labeling rejected parcels
function addRejectionLabel(parcel, reason) {
    // Get centroid
    const coords = parcel.feature.geometry.coordinates[0];
    let latSum = 0, lngSum = 0;
    coords.forEach(coord => {
        lngSum += coord[0];
        latSum += coord[1];
    });
    const n = coords.length;
    const centroid = [latSum / n, lngSum / n];
    // Add label
    const label = L.marker([centroid[0], centroid[1]], {
        icon: L.divIcon({
            className: 'parcel-rejection-label',
            html: `<span style="background: #fff3f3; color: #c00; border: 1px solid #c00; border-radius: 6px; padding: 2px 8px; font-size: 13px;">${reason}</span>`,
            iconSize: [120, 24],
            iconAnchor: [60, 12]
        }),
        interactive: false
    }).addTo(map);
    if (!window.rejectionLabels) window.rejectionLabels = [];
    window.rejectionLabels.push(label);
}

// Clear all rejection labels
function clearRejectionLabels() {
    if (window.rejectionLabels) {
        window.rejectionLabels.forEach(label => map.removeLayer(label));
        window.rejectionLabels = [];
    }
}

// Rewrite: Animate block formation from selected parcel, highlight accepted, label rejected
function animateFloodfillFromSelected() {
    if (window.debugLayer) window.debugLayer.clearLayers();
    clearRejectionLabels();
    if (!currentParcel || !currentParcel.layer) {
        document.getElementById('status').textContent = 'No parcel selected. Please select a parcel first.';
        return;
    }
    const startParcel = currentParcel.layer;
    const bounds = map.getBounds();
    const allParcels = parcelLayer.getLayers().filter(layer => {
        if (!layer || typeof layer.getBounds !== 'function') return false;
        try { return bounds.intersects(layer.getBounds()); } catch { return false; }
    });
    // Precompute neighbors
    const neighborMap = new Map();
    const nonRoadParcels = allParcels.filter(p => p.feature && p.feature.properties && !isRoad(p.feature.properties.CESTICA_ID));
    for (let i = 0; i < nonRoadParcels.length; i++) {
        const p1 = nonRoadParcels[i];
        const p1Id = p1.feature.properties.CESTICA_ID.toString();
        if (!neighborMap.has(p1Id)) neighborMap.set(p1Id, []);
        for (let j = i + 1; j < nonRoadParcels.length; j++) {
            const p2 = nonRoadParcels[j];
            const p2Id = p2.feature.properties.CESTICA_ID.toString();
            if (!neighborMap.has(p2Id)) neighborMap.set(p2Id, []);
            try {
                if (p1.getBounds().intersects(p2.getBounds()) && parcelsShareBoundary(p1, p2)) {
                    neighborMap.get(p1Id).push(p2);
                    neighborMap.get(p2Id).push(p1);
                }
            } catch { }
        }
    }
    // Animation state
    const visited = new Set();
    const blockParcels = [];
    const queue = [startParcel];
    let step = 0;
    let blockInvalid = false;
    // Style for accepted
    const acceptedStyle = {
        fillColor: '#3388ff', fillOpacity: 0.4, color: '#3388ff', weight: 2
    };
    // Style for rejected
    const rejectedStyle = {
        fillColor: '#fff3f3', fillOpacity: 0.7, color: '#c00', weight: 2
    };
    // Helper to animate next step
    function animateStep() {
        if (queue.length === 0 || blockInvalid) {
            // Animation complete, check if we have a valid block
            if (!blockInvalid && blockParcels.length > 0) {
                // Create and store the block
                const blockName = getBlockName(blockParcels);
                blockStorage.addBlock(blockName, blockParcels, true);

                // Update block properties on parcels
                blockParcels.forEach(p => {
                    if (p && p.feature && p.feature.properties) {
                        p.feature.properties.block = blockName;
                        p.feature.properties.blockValid = true;
                    }
                });

                // Show success popup
                const popup = L.popup()
                    .setLatLng(startParcel.getBounds().getCenter())
                    .setContent(`A block was successfully formed starting from the selected parcel. Block name: ${blockName}, parcel count: ${blockParcels.length}`)
                    .openOn(map);

                // Update UI
                updateBlocksList();
                if (document.getElementById('showBlocks').checked) {
                    updateBlockLayer();
                }
            } else {
                // Show failure popup
                const popup = L.popup()
                    .setLatLng(startParcel.getBounds().getCenter())
                    .setContent('A block was not formed starting from the selected parcel. No valid block could be formed. Make sure the parcel is part of a group of parcels fully enclosed by roads and that they are all visible in the current map view.')
                    .openOn(map);
            }
            return;
        }
        const current = queue.shift();
        const parcelId = current.feature.properties.CESTICA_ID.toString();
        if (visited.has(parcelId)) {
            setTimeout(animateStep, 400);
            return;
        }
        visited.add(parcelId);
        // Check reasons for rejection
        let reason = null;
        if (isRoad(parcelId)) reason = 'is road';
        else if (!isParcelFullyVisible(current)) {
            reason = 'not fully visible';
            blockInvalid = true; // Mark block as invalid when we find a non-visible parcel
        }
        else if (blockParcels.includes(current)) reason = 'already in block';
        if (reason) {
            // Highlight rejected
            L.geoJSON(current.toGeoJSON(), { style: rejectedStyle, interactive: false }).addTo(map);
            addRejectionLabel(current, reason);
            setTimeout(animateStep, 400);
            return;
        }
        // Accept
        blockParcels.push(current);
        L.geoJSON(current.toGeoJSON(), { style: acceptedStyle, interactive: false }).addTo(map);
        // Queue neighbors
        const neighbors = findNeighbors(current, neighborMap);
        for (const neighbor of neighbors) {
            const nId = neighbor.feature.properties.CESTICA_ID.toString();
            if (!visited.has(nId)) queue.push(neighbor);
        }
        setTimeout(animateStep, 400);
    }
    animateStep();
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

// --- Parcel Number Labels ---
let parcelNumberLabels = [];

function toggleParcelNumbers() {
    const show = document.getElementById('showParcelNumbers').checked;
    clearParcelNumberLabels();
    if (show && parcelLayer) {
        parcelLayer.eachLayer(layer => {
            if (!layer.feature || !layer.feature.properties) return;
            const brojCestice = layer.feature.properties.BROJ_CESTICE;
            if (!brojCestice) return;
            // Get centroid of the parcel polygon
            const coords = layer.feature.geometry.coordinates && layer.feature.geometry.coordinates[0];
            if (!coords || coords.length === 0) return;
            let latSum = 0, lngSum = 0;
            coords.forEach(coord => {
                if (!Array.isArray(coord) || coord.length < 2) return;
                lngSum += coord[0];
                latSum += coord[1];
            });
            const n = coords.length;
            if (n === 0) return;
            const centroid = [latSum / n, lngSum / n]; // [lat, lng]
            if (!isFinite(centroid[0]) || !isFinite(centroid[1])) return;
            // Create a label marker
            const label = L.marker([centroid[0], centroid[1]], {
                icon: L.divIcon({
                    className: 'parcel-number-label',
                    html: `${brojCestice}`,
                    iconSize: [40, 18],
                    iconAnchor: [20, 9]
                }),
                interactive: false
            }).addTo(map);
            parcelNumberLabels.push(label);
        });
    }
}

function clearParcelNumberLabels() {
    parcelNumberLabels.forEach(label => map.removeLayer(label));
    parcelNumberLabels = [];
}

