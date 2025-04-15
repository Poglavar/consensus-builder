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
    // Ensure both parcels have the stored HTRS coordinates
    if (!p1?.feature?.properties?.htrsCoordinates || !p2?.feature?.properties?.htrsCoordinates) {
        console.warn("Missing HTRS coordinates for boundary check", p1, p2);
        return false;
    }

    const coords1 = p1.feature.properties.htrsCoordinates; // HTRS96/TM [easting, northing]
    const coords2 = p2.feature.properties.htrsCoordinates; // HTRS96/TM [easting, northing]

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
            status.textContent = `Finished count. Found ${blockCount} blocks, removed ${blocksToRemove.size} blocks that lost parcels.`;
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

    // Highlight the block
    highlightBlock(blockName);

    // Calculate bounds of the block
    const block = blockStorage.blocks.get(blockName);
    if (block.parcels.length > 0) {
        const bounds = L.latLngBounds(block.parcels.map(p => p.getBounds()));
        // Fit map to the block bounds with some padding
        map.fitBounds(bounds, { padding: [50, 50] });
    }
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
}

