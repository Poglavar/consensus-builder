/*
    Parcel blocks (blocks of parcels) functionality.
    This file contains the functionality for parcel blocks (blocks of parcels).
    NOTE: this is not the same things as building blocks (blocks of buildings).
    It includes the logic for creating parcel blocks from sets of parcels.
*/

function formatBlockText(template, params = {}) {
    if (!template) return '';
    return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
        return Object.prototype.hasOwnProperty.call(params, key) ? params[key] : match;
    });
}

function tBlock(key, params = {}, fallback = '') {
    const api = (typeof window !== 'undefined' && window.i18n) ? window.i18n : null;
    if (api && typeof api.t === 'function') {
        return api.t(key, params);
    }
    return formatBlockText(fallback || key || '', params);
}

function applyBlockTranslations(root) {
    const apply = (typeof window !== 'undefined' && window.i18n && typeof window.i18n.applyTranslations === 'function')
        ? window.i18n.applyTranslations
        : null;
    if (apply && root) {
        try { apply(root); } catch (_) { /* ignore */ }
    }
}

function parcelIdFromLayer(layer) {
    if (!layer) return null;
    const feature = layer.feature || layer;
    const props = feature.properties || {};
    const id = typeof ensureParcelId === 'function'
        ? ensureParcelId(feature)
        : (props.parcelId ?? props.parcel_id ?? props.id);
    return id !== undefined && id !== null ? id.toString() : null;
}

function isCorridorParcel(parcelOrId, layer = null) {
    const parcelId = (typeof parcelOrId === 'string' || typeof parcelOrId === 'number')
        ? parcelOrId.toString()
        : parcelIdFromLayer(parcelOrId || layer);
    const props = (parcelOrId && parcelOrId.feature && parcelOrId.feature.properties)
        || (parcelOrId && parcelOrId.properties)
        || (layer && layer.feature && layer.feature.properties)
        || (layer && layer.properties)
        || {};

    if (props.isCorridor === true || props.isTrack === true) {
        return true;
    }

    // Road parcels BOUND blocks — they are never inside one. The legacy detectors marked roads
    // with isCorridor too, but the curated road source sets only isRoad, so ask the road-parcel
    // set directly or the flood-fill crosses every street.
    if (parcelId && typeof window.isRoadParcel === 'function' && window.isRoadParcel(parcelId)) {
        return true;
    }

    if (parcelId && typeof readPersistedParcelRecord === 'function') {
        const record = readPersistedParcelRecord(parcelId);
        const persistedProps = record?.properties || {};
        if (persistedProps.isCorridor === true || persistedProps.isTrack === true) {
            return true;
        }
    }

    return false;
}

// Add block storage management
const blockStorage = {
    blocks: new Map(),  // Key: blockName, Value: { parcels: [], valid: boolean, polygon?: any }

    // Save blocks to PersistentStorage
    save() {
        const data = Array.from(this.blocks.entries()).map(([name, block]) => ({
            name,
            parcelIds: block.parcels.map(p => parcelIdFromLayer(p)).filter(Boolean),
            valid: block.valid,
            polygon: block.polygon && block.polygon.type ? block.polygon : null
        }));
        PersistentStorage.setItem('cadastre_blocks', JSON.stringify(data));
    },

    // Load blocks from PersistentStorage
    load() {
        const data = PersistentStorage.getItem('cadastre_blocks');
        if (data) {
            this.blocks.clear();
            JSON.parse(data).forEach(block => {
                // Find all parcels that match the stored IDs
                const parcels = [];
                if (parcelLayer) {
                    parcelLayer.eachLayer(layer => {
                        const pid = parcelIdFromLayer(layer);
                        if (pid && block.parcelIds.includes(pid)) {
                            parcels.push(layer);
                        }
                    });
                }

                this.blocks.set(block.name, {
                    parcels,
                    parcelIds: block.parcelIds,
                    valid: block.valid,
                    polygon: block.polygon || null
                });
            });
        }
    },

    // Add a new block
    addBlock(name, parcels, valid = true) {
        this.blocks.set(name, {
            parcels,
            parcelIds: parcels.map(p => parcelIdFromLayer(p)).filter(Boolean),
            valid,
            polygon: null
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
        PersistentStorage.removeItem('cadastre_blocks');
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
    },

    setBlockPolygon(name, polygonFeature) {
        if (!this.blocks.has(name)) return;
        const block = this.blocks.get(name);
        block.polygon = polygonFeature || null;
        this.blocks.set(name, block);
        this.save();
    }
};

function initialiseBlockStorage() {
    blockStorage.load();
}

if (typeof PersistentStorage !== 'undefined' && PersistentStorage.ensureReady) {
    PersistentStorage.ensureReady(initialiseBlockStorage);
} else {
    initialiseBlockStorage();
}

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
        .map(p => parcelIdFromLayer(p))
        .filter(Boolean)
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
    try {
        const geom = parcel && parcel.feature && parcel.feature.geometry;
        if (!geom) return false;
        const bounds = map.getBounds();
        if (geom.type === 'Polygon') {
            // All rings' vertices must be within bounds
            return geom.coordinates.every(ring => Array.isArray(ring) && ring.every(coord => bounds.contains([coord[1], coord[0]])));
        } else if (geom.type === 'MultiPolygon') {
            // Every vertex of every ring of every polygon must be within bounds
            return geom.coordinates.every(poly => Array.isArray(poly) && poly.every(ring => Array.isArray(ring) && ring.every(coord => bounds.contains([coord[1], coord[0]]))));
        }
        return false;
    } catch (_) {
        return false;
    }
}

// Helper function to check if a block is complete (all parcels fully visible)
function isBlockComplete(blockParcels) {
    return blockParcels.every(parcel => isParcelFullyVisible(parcel));
}

// Helper function to check if two parcels share a boundary (using HTRS96 with tolerance)
function parcelsShareBoundary(p1, p2) {
    // Debug info for drawn roads
    const p1IsDrawnRoad = p1?.feature?.properties?.isRoad === true;
    const p2IsDrawnRoad = p2?.feature?.properties?.isRoad === true;

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
    const parcelId = parcelIdFromLayer(parcel.feature);
    if (!parcelId) return [];
    // Return neighbors from the map, filtering out any potential road parcels if needed elsewhere
    // (floodfill already checks isRoad, so maybe not needed here)
    return neighborMap.get(parcelId) || [];
}

// Compute combined LatLngBounds for an array of Leaflet layers safely
function computeCombinedBounds(layers) {
    let combined = null;
    if (!Array.isArray(layers)) {
        console.warn('computeCombinedBounds: layers is not an array', layers);
        return combined;
    }
    if (layers.length === 0) {
        console.warn('computeCombinedBounds: empty layers array');
        return combined;
    }

    let validLayerCount = 0;
    for (const layer of layers) {
        if (!layer) {
            console.warn('computeCombinedBounds: null/undefined layer found');
            continue;
        }
        if (typeof layer.getBounds !== 'function') {
            console.warn('computeCombinedBounds: layer missing getBounds method', layer);
            continue;
        }
        try {
            const b = layer.getBounds();
            if (!b) {
                console.warn('computeCombinedBounds: getBounds returned null/undefined', layer);
                continue;
            }
            if (!b.isValid || !b.isValid()) {
                console.warn('computeCombinedBounds: invalid bounds', b);
                continue;
            }

            // Validate that coordinates are in valid WGS84 range
            const sw = b.getSouthWest();
            const ne = b.getNorthEast();
            if (!isFinite(sw.lat) || !isFinite(sw.lng) || !isFinite(ne.lat) || !isFinite(ne.lng)) {
                console.error('computeCombinedBounds: bounds with non-finite coordinates', { sw, ne });
                continue;
            }
            // Check if coordinates are in valid lat/lng ranges
            // Valid lat: -90 to 90, valid lng: -180 to 180
            if (Math.abs(sw.lat) > 90 || Math.abs(ne.lat) > 90 || Math.abs(sw.lng) > 180 || Math.abs(ne.lng) > 180) {
                console.error('computeCombinedBounds: coordinates out of valid WGS84 range (possible HTRS96 coords?)',
                    { sw, ne, parcelId: parcelIdFromLayer(layer) });
                continue;
            }

            validLayerCount++;
            if (combined) {
                combined.extend(b);
            } else {
                // Create new bounds from the first valid bounds
                combined = L.latLngBounds(sw, ne);
            }
        } catch (e) {
            console.warn('Error in computeCombinedBounds:', e, layer);
        }
    }

    if (validLayerCount === 0) {
        console.error('computeCombinedBounds: no valid layers found out of', layers.length);
    }

    return combined;
}

// Build neighbors using an edge-index (near-linear) over visible non-corridor parcels
function getVisibleNonCorridorParcels() {
    if (!parcelLayer) return [];
    const bounds = map.getBounds();
    const all = parcelLayer.getLayers().filter(layer => {
        if (!layer || typeof layer.getBounds !== 'function') return false;
        try {
            return bounds.intersects(layer.getBounds());
        } catch (_) { return false; }
    });
    const nonCorridor = all.filter(p => {
        const pid = parcelIdFromLayer(p);
        return pid && !isCorridorParcel(pid, p);
    });

    // Return all intersecting parcels - we'll validate block completeness later
    // This allows us to process parcels for performance while ensuring blocks are complete
    return nonCorridor;
}

function buildNeighborMapFromEdges(parcels) {
    // Quantization to 1 cm to make keys stable in HTRS96
    const quantizeFactor = 100; // 1 cm
    const minEdgeLenMeters = 0.1; // ignore edges shorter than 10 cm
    const edgeMap = new Map(); // key -> { ids: Set<string>, len: number }
    const idToLayer = new Map();

    function keyForEdge(p, q) {
        const x1 = Math.round(p[0] * quantizeFactor), y1 = Math.round(p[1] * quantizeFactor);
        const x2 = Math.round(q[0] * quantizeFactor), y2 = Math.round(q[1] * quantizeFactor);
        const a = x1 === x2 ? (y1 <= y2) : (x1 < x2);
        return a ? `${x1},${y1}|${x2},${y2}` : `${x2},${y2}|${x1},${y1}`;
    }

    function addEdgesForParcel(layer) {
        const feature = layer.feature;
        const id = parcelIdFromLayer(feature);
        if (!id) return;
        idToLayer.set(id, layer);
        // Get exterior ring in HTRS96
        const ring = getHtrsCoordinates(feature);
        if (!Array.isArray(ring) || ring.length < 2) return;
        // Some datasets repeat the first vertex as last; iterate pairs including wrap
        const n = ring.length - 1; // if closed, last equals first; this still covers all edges once
        for (let i = 0; i < n; i++) {
            const p = ring[i];
            const q = ring[i + 1];
            if (!Array.isArray(p) || !Array.isArray(q)) continue;
            const dx = q[0] - p[0];
            const dy = q[1] - p[1];
            const len = Math.hypot(dx, dy);
            if (!(len > minEdgeLenMeters)) continue;
            const k = keyForEdge(p, q);
            let rec = edgeMap.get(k);
            if (!rec) {
                rec = { ids: new Set(), len };
                edgeMap.set(k, rec);
            }
            rec.ids.add(id);
        }
    }

    parcels.forEach(addEdgesForParcel);

    // Build neighbor map: edges shared by exactly two parcels (sufficient edge length) form adjacency
    const neighborMap = new Map(); // id -> Array<layer>
    function ensureList(id) {
        if (!neighborMap.has(id)) neighborMap.set(id, []);
        return neighborMap.get(id);
    }
    edgeMap.forEach((rec) => {
        if (rec.ids.size === 2) {
            const ids = Array.from(rec.ids);
            const a = ids[0];
            const b = ids[1];
            const la = idToLayer.get(a);
            const lb = idToLayer.get(b);
            if (la && lb) {
                ensureList(a).push(lb);
                ensureList(b).push(la);
            }
        }
    });

    // Handle containment: connect parcels fully inside another (assuming both are non-road).
    // First, a targeted pass for isolated (degree 0) parcels to keep it fast.
    const ids = Array.from(idToLayer.keys());
    // Precompute bounds to prune
    const idToBounds = new Map();
    ids.forEach(id => {
        const layer = idToLayer.get(id);
        let b = null;
        try { b = layer && typeof layer.getBounds === 'function' ? layer.getBounds() : null; } catch (_) { }
        idToBounds.set(id, b);
    });

    function layerContains(outerLayer, innerLayer) {
        try {
            const outer = outerLayer.feature;
            const inner = innerLayer.feature;
            if (!outer || !inner) return false;
            return turf.booleanContains(outer, inner);
        } catch (_) { return false; }
    }

    // Pass 1: isolated only (existing behavior)
    ids.forEach(idA => {
        const degA = (neighborMap.get(idA) || []).length;
        if (degA > 0) return; // only isolated parcels
        const layerA = idToLayer.get(idA);
        const boundsA = idToBounds.get(idA);
        if (!layerA || !boundsA || !boundsA.isValid || !boundsA.isValid()) return;
        for (let i = 0; i < ids.length; i++) {
            const idB = ids[i];
            if (idB === idA) continue;
            const layerB = idToLayer.get(idB);
            const boundsB = idToBounds.get(idB);
            if (!layerB || !boundsB || !boundsB.isValid || !boundsB.isValid()) continue;
            if (!(boundsB.contains && boundsB.contains(boundsA))) continue;
            if (layerContains(layerB, layerA)) {
                ensureList(idA).push(layerB);
                ensureList(idB).push(layerA);
                break;
            }
        }
    });

    // Pass 2: robust containment linking for non-isolated islands entirely inside another parcel
    // This prevents 1-parcel islands from forming standalone blocks when they are inside non-road parcels.
    ids.forEach(idA => {
        const layerA = idToLayer.get(idA);
        const boundsA = idToBounds.get(idA);
        if (!layerA || !boundsA || !boundsA.isValid || !boundsA.isValid()) return;
        for (let i = 0; i < ids.length; i++) {
            const idB = ids[i];
            if (idB === idA) continue;
            const layerB = idToLayer.get(idB);
            const boundsB = idToBounds.get(idB);
            if (!layerB || !boundsB || !boundsB.isValid || !boundsB.isValid()) continue;
            if (!(boundsB.contains && boundsB.contains(boundsA))) continue;
            if (layerContains(layerB, layerA)) {
                // Link both ways if not already linked
                const listA = ensureList(idA);
                const listB = ensureList(idB);
                if (!listA.includes(layerB)) listA.push(layerB);
                if (!listB.includes(layerA)) listB.push(layerA);
                break;
            }
        }
    });

    return { neighborMap, idToLayer };
}

// Modify the countBlocks function to pre-calculate neighbors
async function countBlocks() {
    if (!parcelLayer) {
        updateStatus('No parcels loaded. Please refresh data first.');
        return;
    }

    const parcelsCountedLabel = document.getElementById('parcels-counted');

    const run = async () => {
        try {
            updateStatus('Filtering visible parcels...');
            await new Promise(resolve => setTimeout(resolve, 0));

            const currentParcels = getVisibleNonCorridorParcels();
            const totalParcelsInView = currentParcels.length;
            if (totalParcelsInView === 0) {
                const msg = 'No parcels in the current map view to form blocks from';
                console.warn(msg);
                updateStatus(msg);
                hideBlockInfo();
                return;
            }

            console.log(`Starting count with ${totalParcelsInView} parcels intersecting viewport.`);
            console.log('countBlocks: Parcels being processed:', currentParcels.map(p => parcelIdFromLayer(p)).filter(Boolean));
            updateStatus(`Found ${totalParcelsInView} parcels intersecting viewport. Building edge index...`);
            if (parcelsCountedLabel) {
                parcelsCountedLabel.textContent = `Parcels processed: 0 / ${totalParcelsInView} (0%)`;
            }
            await new Promise(resolve => setTimeout(resolve, 0));

            const { neighborMap } = buildNeighborMapFromEdges(currentParcels);
            console.log('Neighbor map (edge-index) built for', neighborMap.size, 'parcels');
            updateStatus('Neighbor graph built. Finding blocks...');
            await new Promise(resolve => setTimeout(resolve, 0));

            const blocksToRemove = new Set();
            const processed = new Set();
            let blockCount = 0;
            const totalNonCorridor = currentParcels.length;

            for (const parcel of currentParcels) {
                const startId = parcelIdFromLayer(parcel);
                if (!startId) continue;
                if (processed.has(startId)) continue;

                const queue = [parcel];
                const blockParcels = [];
                processed.add(startId);
                while (queue.length > 0) {
                    const cur = queue.shift();
                    blockParcels.push(cur);
                    const neighbors = findNeighbors(cur, neighborMap);
                    for (const n of neighbors) {
                        const nid = parcelIdFromLayer(n);
                        if (!nid) continue;
                        if (!processed.has(nid)) {
                            processed.add(nid);
                            queue.push(n);
                        }
                    }
                }

                if (blockParcels.length > 0) {
                    const blockName = getBlockName(blockParcels);
                    const isComplete = isBlockComplete(blockParcels);

                    if (isComplete) {
                        console.log(`countBlocks: Found complete block "${blockName}" with ${blockParcels.length} parcels:`,
                            blockParcels.map(p => parcelIdFromLayer(p)).filter(Boolean));
                        blockParcels.forEach(p => {
                            if (p?.feature?.properties) {
                                const oldBlock = p.feature.properties.block;
                                if (oldBlock && oldBlock !== blockName) {
                                    blocksToRemove.add(oldBlock);
                                }
                                p.feature.properties.block = blockName;
                                p.feature.properties.blockValid = true;
                            }
                        });
                        blockStorage.addBlock(blockName, blockParcels, true);
                        blockCount++;
                    } else {
                        console.log(`countBlocks: Rejected incomplete block "${blockName}" with ${blockParcels.length} parcels (some parcels not fully visible):`,
                            blockParcels.map(p => parcelIdFromLayer(p)).filter(Boolean));
                    }
                }

                const parcelsProcessedCount = processed.size;
                const progress = Math.round((parcelsProcessedCount / totalNonCorridor) * 100);
                if (parcelsCountedLabel) {
                    parcelsCountedLabel.textContent = `Parcels processed: ${parcelsProcessedCount} / ${totalNonCorridor} (${progress}%)`;
                }
                if (parcelsProcessedCount % 50 === 0) {
                    updateStatus(`Counting blocks... ${progress}%`);
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }

            console.log(`Removing ${blocksToRemove.size} blocks that lost parcels:`, Array.from(blocksToRemove));
            blocksToRemove.forEach(blockName => {
                blockStorage.removeBlock(blockName);
                blockPolygonCache.delete(blockName);
            });

            blockPolygonCache.clear();
            updateBlocksList();
            if (document.getElementById('parcelBlocksCheckbox') && document.getElementById('parcelBlocksCheckbox').checked) {
                updateBlockLayer();
            }

            updateStatus(`Finished count. Found ${blockCount} new blocks, removed ${blocksToRemove.size} blocks. Total non-corridor parcels processed: ${totalNonCorridor}.`);
        } catch (error) {
            console.error('Error during countBlocks:', error);
            updateStatus('Error occurred while counting blocks. Please try again.');
        }
    };

    const button = document.querySelector('button[onclick="countBlocks()"]');
    if (typeof runWithButtonBusyState === 'function' && button) {
        return runWithButtonBusyState(button, 'Forming...', run);
    }
    return run();
}

// Modify the floodfill function to accept the neighborMap
function floodfillBlock(startParcel, blockParcels, neighborMap) { // Changed last parameter
    const queue = [startParcel];
    const visited = new Set();

    const result = {
        isValid: true,
        invalidParcel: null,
        invalidParcelId: null,
        invalidReason: null
    };

    function markInvalid(parcel, reason) {
        result.isValid = false;
        result.invalidParcel = parcel || null;
        result.invalidParcelId = parcel ? parcelIdFromLayer(parcel) : null;
        result.invalidReason = reason || null;
    }

    // Check visibility of the starting parcel itself
    if (!isParcelFullyVisible(startParcel)) {
        markInvalid(startParcel, 'start_not_fully_visible');
        return result; // Return immediately if starting parcel is not visible
    }

    while (queue.length > 0 && result.isValid) { // Stop if block becomes invalid
        const currentParcel = queue.shift();

        // Check for valid parcel structure
        const parcelId = parcelIdFromLayer(currentParcel);
        if (!parcelId) {
            console.warn("Invalid parcel in floodfill queue:", currentParcel);
            continue;
        }

        if (visited.has(parcelId)) continue;
        visited.add(parcelId);

        // Add to block parcels *before* checking visibility of neighbors
        blockParcels.push(currentParcel);

        // Find neighbors using the precomputed map
        const neighbors = findNeighbors(currentParcel, neighborMap); // Use the map

        for (const neighbor of neighbors) {
            if (!neighbor) continue;
            const neighborId = parcelIdFromLayer(neighbor);
            if (!neighborId || visited.has(neighborId)) continue;

            // Check if the neighbor is fully visible *before* adding to queue
            // If any neighbor isn't fully visible, the whole block is invalid
            if (!isParcelFullyVisible(neighbor)) {
                markInvalid(neighbor, 'not_fully_visible');
                break; // Break out of neighbor loop
            }

            queue.push(neighbor);
        }
    }

    // The block is only valid if *all* its constituent parcels were fully visible
    return result;
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
        blockItem.onclick = () => highlightAndCenterBlock(block.name);
        blocksContent.appendChild(blockItem);
    });
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
        updateStatus(`Block ${blockName} not found`);
        return;
    }

    // Make sure the "Parcel Blocks" checkbox is checked
    const parcelBlocksCheckbox = document.getElementById('parcelBlocksCheckbox');
    if (parcelBlocksCheckbox && !parcelBlocksCheckbox.checked) {
        parcelBlocksCheckbox.checked = true;
        if (typeof toggleBlocksVisibility === 'function') {
            toggleBlocksVisibility();
        } else if (typeof updateBlockLayer === 'function') {
            updateBlockLayer();
        }
    }

    // Highlight block and center in one place
    const previousSelected = selectedBlockName;
    selectedBlockName = blockName;
    if (typeof window !== 'undefined') {
        window.selectedBlockName = selectedBlockName;
    }
    // Redraw block borders immediately when a block is selected
    try {
        if (document.getElementById('parcelBlocksCheckbox') && document.getElementById('parcelBlocksCheckbox').checked) {
            updateBlockLayer();
        }
    } catch (_) { }

    // Un-highlight previous block polygon
    if (previousSelected && blockPolygonsLayer) {
        blockPolygonsLayer.eachLayer(layer => {
            if (layer.blockName === previousSelected && typeof layer.setStyle === 'function') {
                layer.setStyle({ fillColor: 'yellow', fillOpacity: 0.2, color: 'black', weight: 6, opacity: 1 });
            }
        });
    }
    // Clear prior parcel highlights
    clearHighlightedBlockParcels();
    // Highlight current block polygon
    if (blockPolygonsLayer) {
        blockPolygonsLayer.eachLayer(layer => {
            if (layer.blockName === blockName && typeof layer.setStyle === 'function') {
                layer.setStyle({ fillColor: 'yellow', fillOpacity: 0.4, color: 'black', weight: 6, opacity: 1 });
            }
        });
    }
    updateBlockifyButton();
    document.querySelectorAll('.block-item').forEach(item => {
        item.classList.toggle('active', item.dataset.block === blockName);
    });
    // Highlight parcel members via common helper
    rehighlightSelectedBlockParcels();

    // Show info panel immediately with placeholder
    showBlockInfo(blockName, true);

    // Calculate bounds of the block and center
    const blockCenterRef = blockStorage.blocks.get(blockName);
    console.log('[highlightAndCenterBlock] Block ref:', blockName, 'parcels count:', blockCenterRef?.parcels?.length);

    if (!blockCenterRef) {
        console.error('[highlightAndCenterBlock] Block not found in storage:', blockName);
        updateStatus(`Block ${blockName} not found`);
        return;
    }

    if (!blockCenterRef.parcels || blockCenterRef.parcels.length === 0) {
        console.error('[highlightAndCenterBlock] Block has no parcels:', blockName);
        updateStatus(`Block ${blockName} has no parcels`);
        return;
    }

    console.log('[highlightAndCenterBlock] Computing bounds for', blockCenterRef.parcels.length, 'parcels');
    const bounds = computeCombinedBounds(blockCenterRef.parcels);
    console.log('[highlightAndCenterBlock] Computed bounds:', bounds);

    if (!bounds) {
        console.error('[highlightAndCenterBlock] computeCombinedBounds returned null');
        updateStatus(`Could not calculate bounds for block ${blockName}`);
        return;
    }

    if (!bounds.isValid || !bounds.isValid()) {
        console.error('[highlightAndCenterBlock] Bounds validation failed:', bounds);
        updateStatus(`Invalid bounds for block ${blockName}`);
        return;
    }

    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    console.log('[highlightAndCenterBlock] Bounds SW:', sw, 'NE:', ne);

    if (!isFinite(sw.lat) || !isFinite(sw.lng) || !isFinite(ne.lat) || !isFinite(ne.lng)) {
        console.error('[highlightAndCenterBlock] Non-finite coordinates:', { sw, ne });
        updateStatus(`Invalid block bounds for ${blockName}`);
        return;
    }

    const currentZoom = map.getZoom();
    console.log('[highlightAndCenterBlock] Calling fitBounds with zoom:', currentZoom);

    try {
        map.fitBounds(bounds, { padding: [60, 60], maxZoom: currentZoom });
        console.log('[highlightAndCenterBlock] fitBounds completed successfully');
    } catch (e) {
        console.error('[highlightAndCenterBlock] Error in fitBounds:', e, bounds);
        updateStatus(`Error centering on block ${blockName}`);
        return;
    }

    updateStatus(`Focused on block ${blockName}`);
}

// Clear current block selection and related UI/highlights
function clearSelectedBlockAndUI() {
    try {
        // Hide info panel
        if (typeof hideBlockInfo === 'function') hideBlockInfo();

        // Clear neighbor hover/highlights if any
        if (typeof clearHighlightedNeighbors === 'function') clearHighlightedNeighbors();

        // Clear vertices overlay for blocks (if shown)
        if (typeof clearBlockVerticesDisplay === 'function') clearBlockVerticesDisplay();

        // Clear parcel-level blue highlights
        if (typeof clearHighlightedBlockParcels === 'function') clearHighlightedBlockParcels();

        // Deselect block state in both global binding and window mirror, then refresh styles
        try { selectedBlockName = null; } catch (_) { }
        try { window.selectedBlockName = null; } catch (_) { }

        // Remove active class from blocks list items
        try {
            document.querySelectorAll('.block-item').forEach(item => item.classList.remove('active'));
        } catch (_) { }

        // Redraw block layer to update polygon fillOpacity/style
        if (document.getElementById('parcelBlocksCheckbox') && document.getElementById('parcelBlocksCheckbox').checked) {
            if (typeof updateBlockLayer === 'function') updateBlockLayer();
        }

        // Update button states
        if (typeof updateBlockButtonStates === 'function') updateBlockButtonStates();
    } catch (e) { console.warn('Failed to clear selected block/UI', e); }
}

// Add function to clear blocks
function clearBlocks() {
    // Get the number of blocks before clearing
    const numberOfBlocks = blockStorage.blocks.size;

    // Clear blocks from storage
    blockStorage.clear();

    // Clear legacy blocks layer from map (if still used)
    if (blockLayer) {
        map.removeLayer(blockLayer);
        blockLayer = null;
    }

    // Clear block polygons layer from map (current overlay)
    if (typeof blockPolygonsLayer !== 'undefined' && blockPolygonsLayer) {
        try { map.removeLayer(blockPolygonsLayer); } catch (_) { }
        blockPolygonsLayer = null;
        if (typeof window !== 'undefined') window.blockPolygonsLayer = null;
    }

    // Remove block name labels from map
    if (Array.isArray(blockNameLabels) && blockNameLabels.length) {
        try { blockNameLabels.forEach(label => map.removeLayer(label)); } catch (_) { }
        blockNameLabels = [];
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

    // Clear any highlighted block parcel styles
    try { clearHighlightedBlockParcels(); } catch (_) { }

    // Reset cached polygons
    try { blockPolygonCache.clear(); } catch (_) { }

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
    updateStatus(`Cleared ${numberOfBlocks} blocks from storage`);
}

// Track ongoing stats calculation to allow cancellation
let statsCalculationTimeout = null;
let currentStatsBlockName = null;
let activeBlockInfoName = null;

function switchBlockTab(button, tabId) {
    const panel = document.getElementById('block-info-panel');
    if (!panel) return;

    const tabButtons = panel.querySelectorAll('.block-tab-btn');
    tabButtons.forEach(btn => btn.classList.remove('active'));

    if (button) {
        button.classList.add('active');
    } else {
        const fallback = panel.querySelector(`.block-tab-btn[data-target="${tabId}"]`);
        if (fallback) fallback.classList.add('active');
    }

    const tabContents = panel.querySelectorAll('.block-tab-content');
    tabContents.forEach(content => content.classList.remove('active'));

    const target = document.getElementById(tabId);
    if (target) {
        target.classList.add('active');
    }
}

function setActiveBlockTab(tabId) {
    const panel = document.getElementById('block-info-panel');
    if (!panel) return;
    const button = panel.querySelector(`.block-tab-btn[data-target="${tabId}"]`);
    switchBlockTab(button, tabId);
}

function handleBlockProposalClick(proposalId) {
    if (!proposalId) return;
    if (typeof enableShowProposalsMode === 'function') {
        try { enableShowProposalsMode(); } catch (_) { }
    } else {
        const proposalsCheckbox = document.getElementById('showProposalsCheckbox');
        if (proposalsCheckbox && !proposalsCheckbox.checked) {
            proposalsCheckbox.checked = true;
            if (typeof updateProposalLayer === 'function') {
                try { updateProposalLayer(); } catch (_) { }
            }
        }
    }
    if (typeof centerOnProposal === 'function') {
        try { centerOnProposal(proposalId); } catch (_) { }
    }
}

function showBlockInfo(blockName, deferStats = false) {
    if (!blockStorage.blocks.has(blockName)) {
        return;
    }

    // Cancel any ongoing stats calculation
    if (statsCalculationTimeout) {
        clearTimeout(statsCalculationTimeout);
        statsCalculationTimeout = null;
    }
    currentStatsBlockName = blockName;
    activeBlockInfoName = blockName;

    clearBlockVerticesDisplay();

    const block = blockStorage.blocks.get(blockName);
    const titleEl = document.getElementById('block-info-title');
    if (titleEl) {
        titleEl.setAttribute('data-i18n-key', 'panel.block.titleWithName');
        titleEl.setAttribute('data-i18n-params', JSON.stringify({ name: blockName }));
        titleEl.textContent = tBlock('panel.block.titleWithName', { name: blockName }, `Block Info — ${blockName}`);
    }

    const infoPanel = document.getElementById('block-info-panel');
    if (!infoPanel) return;

    setActiveBlockTab('block-info-tab');

    const infoContent = document.getElementById('block-info-content');
    if (infoContent) {
        infoContent.innerHTML = `
            <div>
                <div class="metric-group">
                    <div class="metric-label" data-i18n-key="panel.block.metrics.name">${tBlock('panel.block.metrics.name', {}, 'Block Name:')}</div>
                    <div class="metric-value">${blockName}</div>
                </div>
                <div class="metric-group">
                    <div class="metric-label" data-i18n-key="panel.block.metrics.parcels">${tBlock('panel.block.metrics.parcels', {}, 'Parcels:')}</div>
                    <div class="metric-value">${block.parcels.length}</div>
                </div>
                <div class="metric-group">
                    <div class="metric-label" data-i18n-key="panel.block.metrics.statsCalculating">${tBlock('panel.block.metrics.statsCalculating', {}, 'Calculating stats…')}</div>
                    <div class="metric-value" data-i18n-key="panel.block.metrics.statsWait">${tBlock('panel.block.metrics.statsWait', {}, 'Please wait')}</div>
                </div>
            </div>
            <div>
                <div class="metric-group">
                    <div class="metric-label" data-i18n-key="panel.block.metrics.circumference">${tBlock('panel.block.metrics.circumference', {}, 'Circumference:')}</div>
                    <div class="metric-value" data-i18n-key="panel.block.metrics.statsCalculating">${tBlock('panel.block.metrics.statsCalculating', {}, 'Calculating stats…')}</div>
                </div>
                <div class="metric-group">
                    <div class="metric-label" data-i18n-key="panel.block.metrics.walkTime">${tBlock('panel.block.metrics.walkTime', {}, 'Walk time (5 km/h):')}</div>
                    <div class="metric-value" data-i18n-key="panel.block.metrics.statsCalculating">${tBlock('panel.block.metrics.statsCalculating', {}, 'Calculating stats…')}</div>
                </div>
            </div>`;
    }

    const parcelsList = document.getElementById('block-parcels-list');
    if (parcelsList) {
        parcelsList.textContent = tBlock('panel.block.metrics.loadingParcels', {}, 'Loading parcels…');
    }

    const proposalsContent = document.getElementById('block-proposals-content');
    if (proposalsContent) {
        const loadingText = tBlock('panel.block.metrics.loadingProposals', {}, 'Loading proposals…');
        proposalsContent.innerHTML = `<p class="block-proposals-empty" data-i18n-key="panel.block.metrics.loadingProposals">${loadingText}</p>`;
    }

    renderBlockInfoTools(blockName);
    renderBlockProposalsTab(blockName);

    infoPanel.classList.add('visible');
    applyBlockTranslations(infoPanel);

    // Always defer stats to avoid blocking UI
    if (deferStats) {
        statsCalculationTimeout = setTimeout(() => renderBlockInfoStats(blockName), 100);
    } else {
        renderBlockInfoStats(blockName);
    }
}

async function renderBlockInfoStats(blockName) {
    // Check if this is still the block we want to render (user might have clicked another)
    if (currentStatsBlockName !== blockName) {
        console.log(`Skipping stats for ${blockName} - user selected ${currentStatsBlockName}`);
        return;
    }
    if (!blockStorage.blocks.has(blockName)) return;
    const block = blockStorage.blocks.get(blockName);

    // Step 1: Basic calculations (quick)
    const totalArea = block.parcels.reduce((sum, parcel) =>
        sum + (parcel.feature.properties.calculatedArea || 0), 0);
    const avgParcelArea = block.parcels.length > 0 ? (totalArea / block.parcels.length) : 0;

    // Yield to browser
    await new Promise(resolve => setTimeout(resolve, 0));
    if (currentStatsBlockName !== blockName) return;

    // Step 2: Compute unioned polygon (expensive)
    let unioned = null;
    let sidesCount = 0;
    let unionOuter = null;
    try {
        unioned = getUnionedPolygonForBlock(blockName, block);
        if (unioned && unioned.geometry) {
            if (unioned.geometry.type === 'Polygon') {
                unionOuter = unioned.geometry.coordinates[0];
            } else if (unioned.geometry.type === 'MultiPolygon') {
                let best = null, bestArea = -Infinity;
                for (const rings of unioned.geometry.coordinates) {
                    const area = turf.area(turf.polygon(rings));
                    if (area > bestArea) { bestArea = area; best = rings[0]; }
                }
                unionOuter = best;
            }
            if (Array.isArray(unionOuter) && unionOuter.length > 1) {
                sidesCount = Math.max(0, unionOuter.length - 1);
            }
        }
    } catch (e) {
        console.warn('Failed to union block for sides count:', e);
    }

    // Yield to browser
    await new Promise(resolve => setTimeout(resolve, 0));
    if (currentStatsBlockName !== blockName) return;

    // Step 3: Average parcel perimeter
    let avgParcelPerimeter = 0;
    if (block.parcels.length > 0) {
        let sumPerim = 0;
        block.parcels.forEach(p => {
            const ring = getExteriorRing(p.feature);
            sumPerim += perimeterOfRingMeters(ring);
        });
        avgParcelPerimeter = sumPerim / block.parcels.length;
    }

    // Yield to browser
    await new Promise(resolve => setTimeout(resolve, 0));
    if (currentStatsBlockName !== blockName) return;

    // Step 4: Landlocked parcels (check if parcel touches block boundary)
    let landlockedCount = 0;
    let landlockedArea = 0;
    if (unionOuter && Array.isArray(unionOuter)) {
        try {
            // Create a LineString from the block's outer boundary
            const boundaryLine = turf.lineString(unionOuter);

            for (let i = 0; i < block.parcels.length; i++) {
                if (currentStatsBlockName !== blockName) return; // Check frequently
                const parcel = block.parcels[i];

                try {
                    // Check if parcel intersects with the block boundary
                    const parcelFeature = parcel.feature;
                    const touchesBoundary = turf.booleanIntersects(parcelFeature, boundaryLine);

                    if (!touchesBoundary) {
                        // Parcel doesn't touch the outer boundary = landlocked
                        landlockedCount++;
                        landlockedArea += (parcel?.feature?.properties?.calculatedArea || 0);
                    }
                } catch (e) {
                    console.warn('Error checking parcel boundary intersection:', e);
                }

                // Yield every 10 parcels (faster now, so can check more at once)
                if (i % 10 === 0 && i > 0) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }
        } catch (e) {
            console.warn('Failed to compute landlocked metrics:', e);
        }
    }

    // Final check before rendering
    if (currentStatsBlockName !== blockName) return;

    const perimeterMeters = unionOuter ? perimeterOfRingMeters(unionOuter) : 0;
    const walkMinutes = perimeterMeters > 0 ? Math.round((perimeterMeters / 1000) / 5 * 60) : 0;
    const content = `
        <div>
            <div class="metric-group">
                <div class="metric-label" data-i18n-key="panel.block.metrics.name">${tBlock('panel.block.metrics.name', {}, 'Block Name:')}</div>
                <div class="metric-value">${blockName}</div>
            </div>
            <div class="metric-group">
                <div class="metric-label" data-i18n-key="panel.block.metrics.parcels">${tBlock('panel.block.metrics.parcels', {}, 'Parcels:')}</div>
                <div class="metric-value">${block.parcels.length}</div>
            </div>
            <div class="metric-group">
                <div class="metric-label" data-i18n-key="panel.block.metrics.sides">${tBlock('panel.block.metrics.sides', {}, 'Sides:')}</div>
                <div class="metric-value" id="block-sides-count">${sidesCount}</div>
            </div>
            <div class="metric-group">
                <div class="metric-label" data-i18n-key="panel.block.metrics.totalArea">${tBlock('panel.block.metrics.totalArea', {}, 'Total Area:')}</div>
                <div class="metric-value">${Math.round(totalArea).toLocaleString('hr-HR')} m²</div>
            </div>
        </div>
        <div>
            <div class="metric-group">
                <div class="metric-label" data-i18n-key="panel.block.metrics.circumference">${tBlock('panel.block.metrics.circumference', {}, 'Circumference:')}</div>
                <div class="metric-value">${Math.round(perimeterMeters).toLocaleString('hr-HR')} m</div>
            </div>
            <div class="metric-group">
                <div class="metric-label" data-i18n-key="panel.block.metrics.walkTime">${tBlock('panel.block.metrics.walkTime', {}, 'Walk time (5 km/h):')}</div>
                <div class="metric-value">${walkMinutes} min</div>
            </div>
            <div class="metric-group">
                <div class="metric-label" data-i18n-key="panel.block.metrics.avgParcelArea">${tBlock('panel.block.metrics.avgParcelArea', {}, 'Avg parcel area:')}</div>
                <div class="metric-value">${Math.round(avgParcelArea).toLocaleString('hr-HR')} m²</div>
            </div>
            <div class="metric-group">
                <div class="metric-label" data-i18n-key="panel.block.metrics.avgParcelPerimeter">${tBlock('panel.block.metrics.avgParcelPerimeter', {}, 'Avg parcel perimeter:')}</div>
                <div class="metric-value">${Math.round(avgParcelPerimeter).toLocaleString('hr-HR')} m</div>
            </div>
            <div class="metric-group">
                <div class="metric-label" data-i18n-key="panel.block.metrics.landlockedParcels">${tBlock('panel.block.metrics.landlockedParcels', {}, 'Landlocked parcels:')}</div>
                <div class="metric-value">${landlockedCount}</div>
            </div>
            <div class="metric-group">
                <div class="metric-label" data-i18n-key="panel.block.metrics.landlockedArea">${tBlock('panel.block.metrics.landlockedArea', {}, 'Landlocked area:')}</div>
                <div class="metric-value">${Math.round(landlockedArea).toLocaleString('hr-HR')} m²</div>
            </div>
        </div>
    `;

    // Update the parcels list (sorted by area descending)
    const sortedParcels = block.parcels.slice().sort((a, b) => {
        const aArea = (a?.feature?.properties?.calculatedArea) || 0;
        const bArea = (b?.feature?.properties?.calculatedArea) || 0;
        return bArea - aArea;
    });
    const parcelsList = sortedParcels.map(parcel => {
        const parcelId = parcelIdFromLayer(parcel);
        const parcelNumber = parcel?.feature?.properties?.BROJ_CESTICE;
        const parcelArea = parcel?.feature?.properties?.calculatedArea || 0;
        return `
            <div class="parcel-item" style="cursor: pointer;" data-parcel-id="${parcelId}">
                ${tBlock('panel.block.parcelLabel', { number: parcelNumber }, `Parcel ${parcelNumber}`)} 
                (${Math.round(parcelArea).toLocaleString('hr-HR')} m²)
            </div>
        `;
    }).join('');

    const infoPanel = document.getElementById('block-info-panel');
    document.getElementById('block-info-content').innerHTML = content;
    const parcelsListContainer = document.getElementById('block-parcels-list');
    if (parcelsListContainer) {
        const heading = tBlock('panel.block.parcelsHeading', { count: sortedParcels.length }, `Parcels (${sortedParcels.length})`);
        parcelsListContainer.innerHTML = `
            <div class="block-parcels-heading" data-i18n-key="panel.block.parcelsHeading" data-i18n-params='${JSON.stringify({ count: sortedParcels.length })}'>${heading}</div>
            ${parcelsList}
        `;
    }
    if (infoPanel) {
        infoPanel.classList.add('visible');
        applyBlockTranslations(infoPanel);
    }

    // Add click event listeners to all parcel items
    document.querySelectorAll('.parcel-item').forEach(item => {
        item.addEventListener('click', function () {
            const parcelId = this.dataset.parcelId;
            console.log('Clicked parcel ID:', parcelId);

            // Find the parcel in the parcel layer
            let selectedParcel = null;
            parcelLayer.eachLayer(layer => {
                if (parcelIdFromLayer(layer) === parcelId) {
                    selectedParcel = layer;
                    return false; // Break the loop
                }
            });

            if (selectedParcel) {
                // Store the selected parcel ID
                selectedParcelId = parcelId;

                // First normalize other parcels but preserve block highlight for current block
                parcelLayer.eachLayer(layer => {
                    const layerParcelId = parcelIdFromLayer(layer);
                    const isRoad = layerParcelId && typeof window.isRoadParcel === 'function' ? window.isRoadParcel(layerParcelId) : false;
                    const isTrack = Boolean(layer?.feature?.properties?.isTrack) || Boolean(layer?._trackStyle);
                    const layerBlockName = layer?.feature?.properties?.block;
                    const currentSelectedBlockName = (typeof selectedBlockName !== 'undefined' && selectedBlockName)
                        ? selectedBlockName
                        : (typeof window !== 'undefined' ? window.selectedBlockName : null);
                    if (currentSelectedBlockName && layerBlockName && currentSelectedBlockName === layerBlockName) {
                        const parcelHighlightStyle = { fillColor: '#3388ff', fillOpacity: 0.4, color: '#3388ff', weight: 2 };
                        layer.setStyle(parcelHighlightStyle);
                    } else {
                        const styleFn = typeof window.getParcelBaseStyle === 'function' ? window.getParcelBaseStyle : null;
                        const style = styleFn
                            ? styleFn(layerParcelId, layer, { isRoad, isTrack })
                            : (isRoad ? roadStyle : normalStyle);
                        layer.setStyle(style);
                    }
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
                const isTrackSelected = (selectedParcel?.feature?.properties?.isTrack === true) || Boolean(selectedParcel?._trackStyle);
                if (isTrackSelected) {
                    const styleFn = typeof window.getParcelStyle === 'function' ? window.getParcelStyle : window.getParcelBaseStyle;
                    const trackStyle = styleFn ? styleFn(parcelId, selectedParcel, { isTrack: true }) : (window.trackStyle || {});
                    selectedParcel.setStyle({ ...trackStyle, weight: 4 });
                } else {
                    selectedParcel.setStyle(selectedParcelStyle);
                }
                selectedParcel.bringToFront();

                // Store the current parcel for checkbox updates
                currentParcel = {
                    id: parcelId,
                    layer: selectedParcel,
                    isRoad: typeof window.isRoadParcel === 'function' ? window.isRoadParcel(parcelId) : false
                };

                // Show parcel info panel with metrics
                const metrics = calculateRoadMetrics(selectedParcel.feature.geometry.coordinates);
                showParcelInfoPanel(selectedParcel.feature, metrics);

                // Show the parcel info panel
                document.getElementById('parcel-info-panel').classList.add('visible');

                // Update status
                updateStatus(
                    `Selected parcel ${selectedParcel.feature.properties.BROJ_CESTICE}`);
            } else {
                console.error('Could not find parcel with ID:', parcelId);
                updateStatus(`Could not find parcel with ID: ${parcelId}`);
            }
        });
    });
}

function renderBlockInfoTools(blockName) {
    const toolsContainer = document.getElementById('block-tools-content');
    if (!toolsContainer) return;

    const hasBlock = blockStorage.blocks.has(blockName);
    const disabledAttr = hasBlock ? '' : ' disabled';

    toolsContainer.innerHTML = `
        <div class="parcel-info-buttons block-tools-buttons">
            <div class="button-row">
                <button id="block-zoom-button" class="parcel-info-btn visualize-button"${disabledAttr}>Zoom to block</button>
                <button id="block-vertices-button" class="parcel-info-btn vertices-button"${disabledAttr}>Show vertices</button>
            </div>
        </div>
        <div class="tools-hint">Use these tools to inspect the block geometry and focus the map.</div>
    `;

    if (!hasBlock) {
        return;
    }

    const zoomButton = document.getElementById('block-zoom-button');
    if (zoomButton) {
        zoomButton.addEventListener('click', () => {
            const block = blockStorage.blocks.get(blockName);
            if (!block) return;
            const bounds = computeCombinedBounds(block.parcels);
            if (bounds && typeof bounds.isValid === 'function' && bounds.isValid()) {
                try { map.fitBounds(bounds, { padding: [40, 40] }); } catch (_) { }
            } else if (typeof updateStatus === 'function') {
                updateStatus('Unable to compute bounds for this block.');
            }
        });
    }

    const verticesBtn = document.getElementById('block-vertices-button');
    if (verticesBtn) {
        verticesBtn.classList.remove('active', 'active-black-border');
        verticesBtn.textContent = 'Show vertices';
        verticesBtn.addEventListener('click', function () {
            const isActive = verticesBtn.classList.toggle('active');
            if (isActive) {
                verticesBtn.classList.add('active-black-border');
                verticesBtn.textContent = 'Hide vertices';
                toggleBlockVerticesDisplay(blockName);
            } else {
                verticesBtn.classList.remove('active-black-border');
                verticesBtn.textContent = 'Show vertices';
                clearBlockVerticesDisplay();
            }
        });
    }
}

function isProposalForBlock(proposal, blockName) {
    if (!proposal || !blockName) return false;

    if (proposal.structureProposal && proposal.structureProposal.blockName === blockName) {
        return true;
    }

    const bp = proposal.buildingProposal || null;
    if (bp) {
        if (bp.blockName === blockName) return true;
        if (bp.metadata && bp.metadata.blockName === blockName) return true;
        if (Array.isArray(proposal.geometry && proposal.geometry.buildings)) {
            const hasBlock = proposal.geometry.buildings.some(f => f && f.properties && f.properties.block === blockName);
            if (hasBlock) return true;
        }
    }

    if (proposal.buildingProperties && proposal.buildingProperties.block === blockName) return true;
    if (proposal.properties && proposal.properties.block === blockName) return true;

    return false;
}

function buildBlockProposalListItem(proposal) {
    if (!proposal || !proposal.proposalId) return '';

    const proposalIdOrHash = proposal.proposalId;
    const color = (typeof getProposalColor === 'function') ? getProposalColor(proposalIdOrHash) : '#007bff';
    const safeTitle = (typeof escapeHtml === 'function') ? escapeHtml(proposal.title || 'Untitled proposal') : (proposal.title || 'Untitled proposal');

    const goalKey = (typeof window.normalizeProposalGoalKey === 'function') ? window.normalizeProposalGoalKey(proposal.goal) : (proposal.goal || '').toLowerCase();
    const isRoadProposal = goalKey === 'road-track' || (!!proposal.roadProposal && goalKey === '');
    const isBuildingProposal = !isRoadProposal && (['buildings', 'building(s)', 'single-building', 'parcelBased'].includes(goalKey) || !!proposal.buildingProposal);
    const isStructureProposal = !isRoadProposal && !isBuildingProposal && (['park', 'square', 'lake'].includes(goalKey) || !!proposal.structureProposal);

    const roadStatus = isRoadProposal
        ? (proposal.roadProposal.status || ((typeof isAppliedStatus === 'function' ? isAppliedStatus(proposal.status) : (proposal.status || '').toLowerCase() === 'applied') ? 'applied' : 'unapplied'))
        : null;
    const buildingStatus = isBuildingProposal
        ? ((proposal.buildingProposal && proposal.buildingProposal.status) || ((typeof isAppliedStatus === 'function' ? isAppliedStatus(proposal.status) : (proposal.status || '').toLowerCase() === 'applied') ? 'applied' : 'unapplied'))
        : null;
    const structureStatus = isStructureProposal
        ? ((proposal.structureProposal && proposal.structureProposal.status) || ((typeof isAppliedStatus === 'function' ? isAppliedStatus(proposal.status) : (proposal.status || '').toLowerCase() === 'applied') ? 'applied' : 'unapplied'))
        : null;

    let actionButtons = '';
    if (typeof ProposalManager !== 'undefined') {
        if (isRoadProposal) {
            if (roadStatus === 'applied') {
                actionButtons = `
                    <button id="proposal-action-btn-${proposalIdOrHash}" class="proposal-action-btn" onclick="event.stopPropagation(); removeProposalFromMap('${proposalIdOrHash}')" title="Un-apply this road proposal">
                        <i class="fas fa-eye-slash"></i> Remove from map
                    </button>
                `;
            } else {
                actionButtons = `
                    <button class="proposal-action-btn" onclick="event.stopPropagation(); applyProposalToMap('${proposalIdOrHash}')" title="Apply this road proposal">
                        <i class="fas fa-check"></i> Apply to map
                    </button>
                `;
            }
        } else if (isBuildingProposal) {
            if (buildingStatus === 'applied' || buildingStatus === 'executed') {
                actionButtons = `
                    <button id="proposal-action-btn-${proposalIdOrHash}" class="proposal-action-btn" onclick="event.stopPropagation(); removeProposalFromMap('${proposalIdOrHash}')" title="Un-apply this building proposal">
                        <i class="fas fa-eye-slash"></i> Remove from map
                    </button>
                `;
            } else {
                actionButtons = `
                    <button class="proposal-action-btn" onclick="event.stopPropagation(); applyProposalToMap('${proposalIdOrHash}')" title="Apply this building proposal">
                        <i class="fas fa-check"></i> Apply to map
                    </button>
                `;
            }
        } else if (isStructureProposal) {
            if (structureStatus === 'applied' || structureStatus === 'executed') {
                actionButtons = `
                    <button id="proposal-action-btn-${proposalIdOrHash}" class="proposal-action-btn" onclick="event.stopPropagation(); removeProposalFromMap('${proposalIdOrHash}')" title="Un-apply this structure proposal">
                        <i class="fas fa-eye-slash"></i> Remove from map
                    </button>
                `;
            } else {
                actionButtons = `
                    <button class="proposal-action-btn" onclick="event.stopPropagation(); applyProposalToMap('${proposalIdOrHash}')" title="Apply this structure proposal">
                        <i class="fas fa-check"></i> Apply to map
                    </button>
                `;
            }
        }
    }

    const parcelCount = Array.isArray(proposal.parentParcelIds)
        ? proposal.parentParcelIds.length
        : (Array.isArray(proposal.childParcelIds)
            ? proposal.childParcelIds.length
            : (proposal.buildingProposal?.parentParcelIds?.length || 0));
    const metaParts = [];
    if (parcelCount > 0) {
        metaParts.push(`${parcelCount} parcel${parcelCount === 1 ? '' : 's'}`);
    }
    if (isStructureProposal) {
        const kind = (proposal.structureProposal && proposal.structureProposal.kind) || 'structure';
        metaParts.push(kind.charAt(0).toUpperCase() + kind.slice(1));
    } else if (isBuildingProposal) {
        const height = proposal.buildingProposal?.parameters?.height || proposal.buildingProperties?.height;
        if (height) {
            metaParts.push(`${height} m`);
        }
    }
    if (proposal.author) {
        metaParts.push(proposal.author);
    }
    if (proposal.createdAt) {
        const createdDate = new Date(proposal.createdAt);
        if (!isNaN(createdDate.getTime())) {
            metaParts.push(`Created: ${createdDate.toLocaleDateString()}`);
        }
    }

    const metaInfo = metaParts.join(' • ');
    const lifecycleKey = (typeof getProposalLifecycleKey === 'function') ? getProposalLifecycleKey(proposal) : null;
    const statusLabel = (typeof getProposalLifecycleLabel === 'function' && lifecycleKey)
        ? getProposalLifecycleLabel(lifecycleKey)
        : (proposal.status || 'Active');
    const statusClass = (typeof getProposalLifecycleClass === 'function' && lifecycleKey)
        ? getProposalLifecycleClass(lifecycleKey)
        : 'active';
    const typeLabel = isRoadProposal ? 'Road' : isBuildingProposal ? 'Building' : isStructureProposal ? (proposal.structureProposal.kind ? proposal.structureProposal.kind.charAt(0).toUpperCase() + proposal.structureProposal.kind.slice(1) : 'Structure') : '';

    return `
        <div class="proposal-list-item" data-proposal-id="${proposal.proposalId}" onclick="handleBlockProposalClick('${proposal.proposalId}')" style="border-left: 4px solid ${color};">
            <div class="proposal-list-header">
                <div class="proposal-color-dot" style="background-color: ${color};"></div>
                <div class="proposal-list-title">${safeTitle}${typeLabel ? ` (${typeLabel})` : ''}</div>
                <div class="proposal-actions">
                    ${actionButtons}
                    <div class="proposal-status-indicator ${statusClass}">${statusLabel}</div>
                    <button class="proposal-delete-btn" onclick="event.stopPropagation(); if (typeof deleteProposal === 'function') deleteProposal('${proposal.proposalId}')" title="Delete proposal">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
            <div class="proposal-list-meta">${metaInfo}</div>
        </div>
    `;
}

/**
 * Create a proposal from all parcels in a block
 * Adds all block parcels to the selection and shows the proposal dialog
 */
function createProposalFromBlock(blockName) {
    if (!blockName || !blockStorage.blocks.has(blockName)) {
        if (typeof updateStatus === 'function') {
            updateStatus(tBlock('panel.block.proposals.blockNotFound', {}, 'Block not found'));
        }
        return;
    }

    const block = blockStorage.blocks.get(blockName);
    if (!block || !block.parcels || block.parcels.length === 0) {
        if (typeof updateStatus === 'function') {
            updateStatus(tBlock('panel.block.proposals.noParcels', {}, 'No parcels in this block'));
        }
        return;
    }

    // Check if multiParcelSelection is available
    if (typeof multiParcelSelection === 'undefined' || !multiParcelSelection) {
        if (typeof updateStatus === 'function') {
            updateStatus(tBlock('panel.block.proposals.multiSelectUnavailable', {}, 'Multi-parcel selection is not available'));
        }
        return;
    }

    // Activate multi-select mode if not active
    if (!multiParcelSelection.isActive) {
        if (typeof multiParcelSelection.activate === 'function') {
            multiParcelSelection.activate();
        } else {
            multiParcelSelection.isActive = true;
        }
    }

    // Clear existing selection
    if (typeof multiParcelSelection.clearSelection === 'function') {
        multiParcelSelection.clearSelection();
    } else {
        multiParcelSelection.selectedParcels.clear();
    }

    // Add all block parcels to selection
    let addedCount = 0;
    block.parcels.forEach(parcel => {
        const parcelId = parcelIdFromLayer(parcel);
        if (parcelId) {
            multiParcelSelection.selectedParcels.add(parcelId.toString());
            if (typeof multiParcelSelection.addParcelHighlight === 'function') {
                multiParcelSelection.addParcelHighlight(parcel);
            }
            addedCount++;
        }
    });

    // Update the last selected parcel ID
    if (block.parcels.length > 0) {
        const lastParcelId = parcelIdFromLayer(block.parcels[block.parcels.length - 1]);
        if (lastParcelId) {
            multiParcelSelection.lastSelectedParcelId = lastParcelId.toString();
        }
    }

    // Update UI
    if (typeof multiParcelSelection.updateUI === 'function') {
        multiParcelSelection.updateUI();
    }

    // Show proposal dialog
    if (typeof showProposalDialog === 'function') {
        showProposalDialog();
    } else if (typeof window.showProposalDialog === 'function') {
        window.showProposalDialog();
    }

    // Notify user
    if (typeof updateStatus === 'function') {
        updateStatus(tBlock('panel.block.proposals.parcelsSelected', { count: addedCount }, `${addedCount} parcels selected for proposal`));
    }
}

function renderBlockProposalsTab(blockName) {
    const proposalsContainer = document.getElementById('block-proposals-content');
    const tabButton = document.getElementById('block-proposals-tab-button');

    if (!proposalsContainer) return;

    // Build the create proposal button HTML
    const createButtonLabel = tBlock('panel.block.proposals.create', {}, 'Create Proposal');
    const createButtonHtml = blockName ? `
        <div class="block-proposals-actions">
            <button type="button" class="btn btn-proposal" onclick="createProposalFromBlock('${blockName}')">
                ${createButtonLabel}
            </button>
        </div>
    ` : '';

    if (!blockName) {
        if (tabButton) tabButton.textContent = 'Proposals (0)';
        proposalsContainer.innerHTML = '<p class="block-proposals-empty">Select a block to see proposals.</p>';
        return;
    }

    if (typeof proposalStorage === 'undefined' || typeof proposalStorage.getAllProposals !== 'function') {
        if (tabButton) tabButton.textContent = 'Proposals (0)';
        proposalsContainer.innerHTML = createButtonHtml + '<p class="block-proposals-empty">Proposal data is unavailable.</p>';
        return;
    }

    const proposals = proposalStorage
        .getAllProposals()
        .filter(proposal => isProposalForBlock(proposal, blockName));

    proposals.sort((a, b) => {
        const aDate = new Date(a.createdAt || a.updatedAt || 0);
        const bDate = new Date(b.createdAt || b.updatedAt || 0);
        return bDate - aDate;
    });

    if (tabButton) {
        tabButton.textContent = `Proposals (${proposals.length})`;
    }

    if (proposals.length === 0) {
        proposalsContainer.innerHTML = createButtonHtml + `<p class="block-proposals-empty">${tBlock('panel.block.proposals.noProposals', {}, 'No proposals for this block yet.')}</p>`;
        return;
    }

    proposalsContainer.innerHTML = createButtonHtml + proposals.map(buildBlockProposalListItem).join('');
}

function refreshBlockInfoProposalTab() {
    if (!activeBlockInfoName) return;
    const panel = document.getElementById('block-info-panel');
    if (!panel || !panel.classList.contains('visible')) return;
    renderBlockProposalsTab(activeBlockInfoName);
}

if (typeof window !== 'undefined') {
    window.refreshBlockInfoProposalTab = refreshBlockInfoProposalTab;
    window.switchBlockTab = switchBlockTab;
    window.handleBlockProposalClick = handleBlockProposalClick;
    window.createProposalFromBlock = createProposalFromBlock;
}

function hideBlockInfo() {
    const panel = document.getElementById('block-info-panel');
    if (panel) {
        panel.classList.remove('visible');
    }

    activeBlockInfoName = null;
    clearBlockVerticesDisplay();
    setActiveBlockTab('block-info-tab');

    const titleEl = document.getElementById('block-info-title');
    if (titleEl) {
        titleEl.textContent = 'Block Info';
    }

    const proposalsButton = document.getElementById('block-proposals-tab-button');
    if (proposalsButton) {
        proposalsButton.textContent = 'Proposals (0)';
    }

    const infoContent = document.getElementById('block-info-content');
    if (infoContent) {
        infoContent.innerHTML = '';
    }

    const parcelsList = document.getElementById('block-parcels-list');
    if (parcelsList) {
        parcelsList.innerHTML = '';
    }

    const proposalsContent = document.getElementById('block-proposals-content');
    if (proposalsContent) {
        proposalsContent.innerHTML = '';
    }

    const toolsContent = document.getElementById('block-tools-content');
    if (toolsContent) {
        toolsContent.innerHTML = '';
    }

    // Update button states if function exists (it will after DOM is loaded)
    if (typeof updateBlockButtonStates === 'function') {
        updateBlockButtonStates();
    }
}

// Toggle block union vertices display
let blockVerticesLayer = null;
let blockVerticesShownFor = null;

// Explicit clearer to be used by UI when turning the toggle off
function clearBlockVerticesDisplay() {
    if (blockVerticesLayer) {
        try { map.removeLayer(blockVerticesLayer); } catch (_) { }
        blockVerticesLayer = null;
    }
    blockVerticesShownFor = null;

    const verticesBtn = document.getElementById('block-vertices-button');
    if (verticesBtn) {
        verticesBtn.classList.remove('active', 'active-black-border');
        verticesBtn.textContent = 'Show vertices';
    }
}

function toggleBlockVerticesDisplay(blockName) {
    // If already shown, clear and exit (true toggle)
    if (blockVerticesLayer && blockVerticesShownFor === blockName) {
        clearBlockVerticesDisplay();
        return;
    }

    // Always clear previous display first
    clearBlockVerticesDisplay();

    if (!blockStorage.blocks.has(blockName)) return;
    const block = blockStorage.blocks.get(blockName);
    // Build union once more
    let unioned = null;
    try {
        if (block.parcels.length > 0) {
            unioned = block.parcels[0].feature;
            for (let i = 1; i < block.parcels.length; i++) {
                const merged = turf.union(unioned, block.parcels[i].feature);
                if (merged) unioned = merged;
            }
        }
    } catch (e) { }
    if (!unioned || !unioned.geometry) return;

    // Extract outer ring of largest polygon
    let outer = null;
    if (unioned.geometry.type === 'Polygon') outer = unioned.geometry.coordinates[0];
    else if (unioned.geometry.type === 'MultiPolygon') {
        let best = null, bestArea = -Infinity;
        for (const rings of unioned.geometry.coordinates) {
            const area = turf.area(turf.polygon(rings));
            if (area > bestArea) { bestArea = area; best = rings[0]; }
        }
        outer = best;
    }
    if (!Array.isArray(outer)) return;

    blockVerticesLayer = L.layerGroup().addTo(map);
    outer.forEach(coord => {
        const latLng = [coord[1], coord[0]];
        L.circleMarker(latLng, {
            radius: 4,
            color: '#222',
            weight: 1.5,
            fillColor: 'white',
            fillOpacity: 1
        }).addTo(blockVerticesLayer);
    });
    blockVerticesShownFor = blockName;
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

// Floodfill the current block and add all member parcels to multi-select without entering block mode
function selectCurrentBlockIntoMultiSelection(startParcel) {
    const button = document.querySelector('button[onclick="animateFloodfillFromSelected()"]');

    const run = () => {
        if (typeof multiParcelSelection === 'undefined' || !multiParcelSelection || !multiParcelSelection.selectedParcels) {
            if (typeof updateStatus === 'function') {
                updateStatus('Multi-select is unavailable.');
            }
            return true;
        }

        if (!multiParcelSelection.isActive) {
            if (typeof multiParcelSelection.toggle === 'function') {
                multiParcelSelection.toggle({ preserveSelectedParcel: true, restoreSingleSelection: false });
            } else if (typeof multiParcelSelection.activate === 'function') {
                multiParcelSelection.activate();
            } else {
                multiParcelSelection.isActive = true;
                if (typeof multiParcelSelection.updateUI === 'function') {
                    multiParcelSelection.updateUI();
                }
            }
        }

        if (!multiParcelSelection.isActive) {
            if (typeof updateStatus === 'function') {
                updateStatus('Turn on multi-select first to select a whole block.');
            }
            return true;
        }

        // Resolve the seed parcel: prefer the passed layer, else last multi-select parcel, else current parcel layer
        let seedParcel = startParcel;
        if (!seedParcel) {
            const candidateId = multiParcelSelection.lastSelectedParcelId
                || (multiParcelSelection.selectedParcels.size > 0 ? Array.from(multiParcelSelection.selectedParcels).slice(-1)[0] : null)
                || (currentParcel && currentParcel.id ? currentParcel.id : null);
            if (candidateId && typeof multiParcelSelection.findParcelById === 'function') {
                seedParcel = multiParcelSelection.findParcelById(candidateId);
            }
            if (!seedParcel && currentParcel && currentParcel.layer) {
                seedParcel = currentParcel.layer;
            }
        }

        if (!seedParcel) {
            if (typeof updateStatus === 'function') {
                updateStatus('Select at least one parcel while multi-select is on, then press Detect.');
            }
            return true;
        }

        const startParcelId = parcelIdFromLayer(seedParcel);
        if (!startParcelId) {
            if (typeof updateStatus === 'function') {
                updateStatus('Could not resolve the selected parcel.');
            }
            return true;
        }
        if (isCorridorParcel(startParcelId, seedParcel)) {
            if (typeof updateStatus === 'function') {
                updateStatus('Block selection for multi-select works on non-corridor parcels only.');
            }
            return true;
        }

        if (!parcelLayer || typeof parcelLayer.getLayers !== 'function') {
            if (typeof updateStatus === 'function') {
                updateStatus('Parcels are not loaded yet.');
            }
            return true;
        }

        const bounds = map.getBounds();
        const visibleParcels = parcelLayer.getLayers().filter(layer => {
            if (!layer || typeof layer.getBounds !== 'function') return false;
            try { return bounds.intersects(layer.getBounds()); } catch (_) { return false; }
        });
        const nonCorridorParcels = visibleParcels.filter(p => {
            const pid = parcelIdFromLayer(p);
            return pid && !isCorridorParcel(pid, p);
        });

        if (nonCorridorParcels.length === 0) {
            if (typeof updateStatus === 'function') {
                updateStatus('No visible non-corridor parcels to select.');
            }
            return true;
        }

        const { neighborMap } = buildNeighborMapFromEdges(nonCorridorParcels);
        const blockParcels = [];
        const floodResult = floodfillBlock(seedParcel, blockParcels, neighborMap);
        const isValid = !!(floodResult && floodResult.isValid);

        if (!isValid || blockParcels.length === 0) {
            const invalidParcel = floodResult ? floodResult.invalidParcel : null;
            const invalidParcelId = floodResult ? (floodResult.invalidParcelId || parcelIdFromLayer(invalidParcel)) : null;
            const unknownLabel = tBlock('common.unknown', {}, 'Unknown');
            const actionLabel = tBlock('panel.parcel.detectBlock', {}, 'Detect block');
            const idLabel = invalidParcelId || unknownLabel;

            if (invalidParcel) {
                // Focus the viewport on the parcel that failed the visibility check,
                // without zooming in further (zoom-in tends to make the "fully visible" requirement worse).
                try {
                    if (typeof map !== 'undefined' && map && typeof map.getZoom === 'function' && typeof map.fitBounds === 'function' && typeof invalidParcel.getBounds === 'function') {
                        const currentZoom = map.getZoom();
                        const bounds = invalidParcel.getBounds();
                        if (bounds && typeof bounds.isValid === 'function' && bounds.isValid()) {
                            map.fitBounds(bounds, { padding: [60, 60], maxZoom: currentZoom });
                        }
                    }
                } catch (_) { /* ignore */ }

                // Select the offending parcel for inspection (without additional camera moves).
                try {
                    if (invalidParcelId && typeof selectParcel === 'function') {
                        const hadSuppress = (typeof window !== 'undefined') && Object.prototype.hasOwnProperty.call(window, 'suppressCameraMoves');
                        const prevSuppress = (typeof window !== 'undefined') ? window.suppressCameraMoves : undefined;
                        if (typeof window !== 'undefined') window.suppressCameraMoves = true;
                        try {
                            selectParcel(invalidParcelId, false);
                        } finally {
                            if (typeof window !== 'undefined') {
                                if (hadSuppress) window.suppressCameraMoves = prevSuppress;
                                else delete window.suppressCameraMoves;
                            }
                        }
                    } else if (typeof invalidParcel.bringToFront === 'function') {
                        invalidParcel.bringToFront();
                    }
                } catch (_) { /* ignore */ }
            }

            if (typeof updateStatus === 'function') {
                updateStatus(tBlock(
                    'status.messages.block_not_fully_visible_zoomed_to_parcel',
                    { id: idLabel, action: actionLabel },
                    'Block not fully visible (parcel {{id}} is outside the current view). Centered on it — press {{action}} again.'
                ));
            }
            return true;
        }

        let addedCount = 0;
        blockParcels.forEach(parcel => {
            const pid = parcelIdFromLayer(parcel);
            if (!pid) return;
            const key = pid.toString();
            const alreadySelected = multiParcelSelection.selectedParcels.has(key);
            multiParcelSelection.selectedParcels.add(key);
            if (!alreadySelected && typeof multiParcelSelection.addParcelHighlight === 'function') {
                multiParcelSelection.addParcelHighlight(parcel);
            }
            if (!alreadySelected) addedCount++;
        });

        const lastParcelId = parcelIdFromLayer(blockParcels[blockParcels.length - 1]);
        if (lastParcelId) {
            multiParcelSelection.lastSelectedParcelId = lastParcelId.toString();
        }

        if (typeof multiParcelSelection.updateUI === 'function') {
            multiParcelSelection.updateUI();
        }

        if (typeof updateStatus === 'function') {
            const label = addedCount === 1 ? 'parcel' : 'parcels';
            const message = addedCount > 0
                ? `${addedCount} ${label} added to selection from this block.`
                : 'All parcels in this block were already selected.';
            updateStatus(message);
        }

        return true;
    };

    if (typeof runWithButtonBusyState === 'function' && button) {
        return runWithButtonBusyState(button, 'Selecting...', run);
    }
    return run();
}

// Rewrite: Animate block formation from selected parcel, highlight accepted, label rejected
// Silent block detection for UX suggestions ("did you mean the whole block?"): the same
// visibility + floodfill as the Detect button, but no animation, no selection, no status —
// returns { count, parcelIds } or null whenever a valid block cannot be derived.
function detectBlockParcelIdsForParcel(parcelId) {
    try {
        const idStr = parcelId !== undefined && parcelId !== null ? String(parcelId) : null;
        if (!idStr) return null;
        const seed = (window.parcelLayerById instanceof Map) ? window.parcelLayerById.get(idStr) : null;
        if (!seed) return null;
        if (isCorridorParcel(idStr, seed)) return null;
        if (!parcelLayer || typeof parcelLayer.getLayers !== 'function') return null;
        const bounds = map.getBounds();
        const visibleParcels = parcelLayer.getLayers().filter(layer => {
            if (!layer || typeof layer.getBounds !== 'function') return false;
            try { return bounds.intersects(layer.getBounds()); } catch (_) { return false; }
        });
        const nonCorridorParcels = visibleParcels.filter(p => {
            const pid = parcelIdFromLayer(p);
            return pid && !isCorridorParcel(pid, p);
        });
        if (!nonCorridorParcels.length) return null;
        const { neighborMap } = buildNeighborMapFromEdges(nonCorridorParcels);
        const blockParcels = [];
        const floodResult = floodfillBlock(seed, blockParcels, neighborMap);
        if (!floodResult || !floodResult.isValid || !blockParcels.length) return null;
        const ids = blockParcels.map(parcelIdFromLayer).filter(Boolean).map(String);
        return { count: ids.length, parcelIds: ids };
    } catch (error) {
        console.warn('[parcel-blocks] silent block detection failed', error);
        return null;
    }
}
window.detectBlockParcelIdsForParcel = detectBlockParcelIdsForParcel;

function animateFloodfillFromSelected() {
    if (window.debugLayer) window.debugLayer.clearLayers();
    clearRejectionLabels();

    const hasMultiSelect = typeof multiParcelSelection !== 'undefined' && !!multiParcelSelection;
    if (hasMultiSelect && !multiParcelSelection.isActive) {
        if (typeof multiParcelSelection.toggle === 'function') {
            multiParcelSelection.toggle({ preserveSelectedParcel: true, restoreSingleSelection: false });
        } else if (typeof multiParcelSelection.activate === 'function') {
            multiParcelSelection.activate();
        } else {
            multiParcelSelection.isActive = true;
            if (typeof multiParcelSelection.updateUI === 'function') {
                multiParcelSelection.updateUI();
            }
        }
    }

    if (hasMultiSelect && multiParcelSelection.isActive) {
        // Allow multi-select flow even if single selection was cleared by toggle
        return selectCurrentBlockIntoMultiSelection(currentParcel && currentParcel.layer);
    }

    if (!currentParcel || !currentParcel.layer) {
        updateStatus('No parcel selected. Please select a parcel first.');
        return;
    }

    const startParcel = currentParcel.layer;
    const button = document.querySelector('button[onclick="animateFloodfillFromSelected()"]');

    const run = () => new Promise(resolve => {
        let finished = false;
        const finish = () => {
            if (!finished) {
                finished = true;
                resolve();
            }
        };

        try {
            console.log('floodfillFromSelected: Starting from parcel:', parcelIdFromLayer(startParcel));
            const bounds = map.getBounds();
            const allParcels = parcelLayer.getLayers().filter(layer => {
                if (!layer || typeof layer.getBounds !== 'function') return false;
                try { return bounds.intersects(layer.getBounds()); } catch { return false; }
            });
            const nonCorridorParcels = allParcels.filter(p => {
                const pid = parcelIdFromLayer(p);
                return pid && p?.feature?.properties && !isCorridorParcel(pid, p);
            });
            console.log('floodfillFromSelected: Parcels being processed:', nonCorridorParcels.map(parcelIdFromLayer).filter(Boolean));
            const { neighborMap } = buildNeighborMapFromEdges(nonCorridorParcels);

            const visited = new Set();
            const blockParcels = [];
            const queue = [startParcel];
            let blockInvalid = false;
            const acceptedStyle = {
                fillColor: '#3388ff', fillOpacity: 0.4, color: '#3388ff', weight: 2
            };
            const rejectedStyle = {
                fillColor: '#fff3f3', fillOpacity: 0.7, color: '#c00', weight: 2
            };

            function animateStep() {
                try {
                    if (queue.length === 0 || blockInvalid) {
                        if (!blockInvalid && blockParcels.length > 0) {
                            const blockName = getBlockName(blockParcels);
                            console.log(`floodfillFromSelected: Found block "${blockName}" with ${blockParcels.length} parcels:`,
                                blockParcels.map(parcelIdFromLayer).filter(Boolean));
                            blockStorage.addBlock(blockName, blockParcels, true);
                            blockPolygonCache.clear();
                            blockParcels.forEach(p => {
                                if (p && p.feature && p.feature.properties) {
                                    p.feature.properties.block = blockName;
                                    p.feature.properties.blockValid = true;
                                }
                            });
                            L.popup()
                                .setLatLng(startParcel.getBounds().getCenter())
                                .setContent(`A block was successfully formed starting from the selected parcel. Block name: ${blockName}, parcel count: ${blockParcels.length}`)
                                .openOn(map);
                            updateBlocksList();
                            if (document.getElementById('parcelBlocksCheckbox') && document.getElementById('parcelBlocksCheckbox').checked) {
                                updateBlockLayer();
                            }
                        } else {
                            L.popup()
                                .setLatLng(startParcel.getBounds().getCenter())
                                .setContent('A block was not formed starting from the selected parcel. No valid block could be formed. Make sure the parcel is part of a group of parcels fully enclosed by corridors and that they are all visible in the current map view.')
                                .openOn(map);
                        }
                        finish();
                        return;
                    }

                    const current = queue.shift();
                    const parcelId = parcelIdFromLayer(current);
                    if (!parcelId) {
                        setTimeout(animateStep, 100);
                        return;
                    }
                    if (visited.has(parcelId)) {
                        setTimeout(animateStep, 100);
                        return;
                    }
                    visited.add(parcelId);

                    let reason = null;
                    if (isCorridorParcel(parcelId, current)) reason = 'is corridor';
                    else if (!isParcelFullyVisible(current)) {
                        reason = 'not fully visible';
                        blockInvalid = true;
                    } else if (blockParcels.includes(current)) {
                        reason = 'already in block';
                    }

                    if (reason) {
                        L.geoJSON(current.toGeoJSON(), { style: rejectedStyle, interactive: false }).addTo(map);
                        addRejectionLabel(current, reason);
                        setTimeout(animateStep, 100);
                        return;
                    }

                    blockParcels.push(current);
                    L.geoJSON(current.toGeoJSON(), { style: acceptedStyle, interactive: false }).addTo(map);

                    const neighbors = findNeighbors(current, neighborMap);
                    for (const neighbor of neighbors) {
                        const nId = parcelIdFromLayer(neighbor);
                        if (nId && !visited.has(nId)) queue.push(neighbor);
                    }
                    setTimeout(animateStep, 100);
                } catch (err) {
                    console.error('Error during floodfill animation step:', err);
                    updateStatus('Error while forming block from selected parcel.');
                    finish();
                }
            }

            animateStep();
        } catch (error) {
            console.error('Error starting floodfill animation:', error);
            updateStatus('Error while forming block from selected parcel.');
            finish();
        }
    });

    if (typeof runWithButtonBusyState === 'function' && button) {
        return runWithButtonBusyState(button, 'Forming...', run);
    }
    return run();
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
            updateStatus('No parcel selected. Please select a parcel first.');
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
        const neighborId = parcelIdFromLayer(neighbor);
        const isNeighborRoad = neighborId ? isRoad(neighborId) : false;

        // Create a highlight layer from the neighbor's GeoJSON
        const highlightLayer = L.geoJSON(neighbor.toGeoJSON(), {
            style: isNeighborRoad ? roadNeighborStyle : normalNeighborStyle,
            interactive: false
        }).addTo(map);

        // Store the created layer for later removal
        highlightedNeighbors.push(highlightLayer);
    });

    updateStatus(`Highlighted ${neighbors.length} neighboring parcels`);
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
            updateStatus('No parcel selected. Please select a parcel first.');
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

    // Extract exterior ring safely (Polygon or MultiPolygon)
    let coordinates;
    try {
        const geom = parcel.feature.geometry;
        if (geom.type === 'Polygon') {
            coordinates = geom.coordinates[0];
        } else if (geom.type === 'MultiPolygon') {
            coordinates = geom.coordinates[0][0];
        } else {
            console.error('Unsupported geometry type for vertices display:', geom.type);
            return;
        }
    } catch (e) {
        console.error('Failed to extract exterior ring for vertices display', e);
        return;
    }

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

    updateStatus(`Showing ${coordinates.length} vertices for parcel ${parcel.feature.properties.BROJ_CESTICE}`);
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
    if (!feature || !feature.geometry || !feature.geometry.coordinates) {
        console.warn('Invalid feature for HTRS conversion', feature);
        return [];
    }

    let ringCoords = null;

    if (feature.geometry.type === 'Polygon') {
        if (!Array.isArray(feature.geometry.coordinates[0])) {
            console.warn('Unexpected Polygon coordinates structure', feature.geometry.coordinates);
            return [];
        }
        // Exterior ring of the Polygon
        ringCoords = feature.geometry.coordinates[0];
    } else if (feature.geometry.type === 'MultiPolygon') {
        // Expecting [[[ [lng,lat], ... ]]]
        if (!Array.isArray(feature.geometry.coordinates[0]) ||
            !Array.isArray(feature.geometry.coordinates[0][0])) {
            console.warn('Unexpected MultiPolygon coordinates structure', feature.geometry.coordinates);
            return [];
        }
        // Exterior ring of the first Polygon
        ringCoords = feature.geometry.coordinates[0][0];
    } else {
        // Unsupported geometry type
        console.warn('Unsupported geometry type for HTRS conversion:', feature.geometry.type);
        return [];
    }

    // Validate that ringCoords is an array of coordinate pairs
    if (!Array.isArray(ringCoords) || ringCoords.length === 0 || !Array.isArray(ringCoords[0]) || ringCoords[0].length !== 2) {
        console.warn('Invalid ring coordinates for HTRS conversion', ringCoords);
        return [];
    }

    // Convert WGS84 [lng, lat] to HTRS96 [easting, northing]
    return ringCoords.map(coord => wgs84ToHTRS96(coord[1], coord[0]));
}

// Add this at the top with other layer variables
let blockPolygonsLayer = null;
let blockNameLabels = [];
window.blockPolygonsLayer = null;

// Cache for pre-computed block polygons to avoid expensive turf.union operations
let blockPolygonCache = new Map(); // blockName -> unioned polygon feature

// Keep track of currently highlighted block parcel layers to restore styles later
let highlightedBlockParcels = [];

function clearHighlightedBlockParcels() {
    if (!Array.isArray(highlightedBlockParcels) || highlightedBlockParcels.length === 0) return;
    try {
        highlightedBlockParcels.forEach(layer => {
            try {
                const parcelId = parcelIdFromLayer(layer);
                const isRoadFlag = parcelId && typeof window.isRoadParcel === 'function' ? window.isRoadParcel(parcelId) : false;
                const isTrackFlag = Boolean(layer?.feature?.properties?.isTrack) || Boolean(layer?._trackStyle);
                if (typeof layer.setStyle === 'function') {
                    const styleFn = typeof window.getParcelBaseStyle === 'function' ? window.getParcelBaseStyle : null;
                    const style = styleFn
                        ? styleFn(parcelId, layer, { isRoad: isRoadFlag, isTrack: isTrackFlag })
                        : (isRoadFlag ? roadStyle : normalStyle);
                    layer.setStyle(style);
                }
                if (typeof layer.bringToBack === 'function') layer.bringToBack();
            } catch (_) { }
        });
    } catch (_) { }
    highlightedBlockParcels = [];
}

// Re-apply blue highlight to parcels that belong to the currently selected block
function rehighlightSelectedBlockParcels() {
    try {
        const currentSelected = (typeof selectedBlockName !== 'undefined' && selectedBlockName)
            ? selectedBlockName
            : (typeof window !== 'undefined' ? window.selectedBlockName : null);
        if (!currentSelected) return;
        if (!blockStorage || !blockStorage.blocks || !blockStorage.blocks.has(currentSelected)) return;

        clearHighlightedBlockParcels();

        const block = blockStorage.blocks.get(currentSelected);
        if (!block || !Array.isArray(block.parcels) || block.parcels.length === 0) return;
        const parcelHighlightStyle = { fillColor: '#3388ff', fillOpacity: 0.4, color: '#3388ff', weight: 2 };
        block.parcels.forEach(layer => {
            try {
                if (layer && typeof layer.setStyle === 'function') {
                    layer.setStyle(parcelHighlightStyle);
                    if (typeof layer.bringToFront === 'function') layer.bringToFront();
                    highlightedBlockParcels.push(layer);
                }
            } catch (_) { }
        });
    } catch (_) { }
}

// Helpers reused by stats rendering
function getUnionedPolygonForBlock(blockName, block) {
    // Prefer persisted polygon if available
    try {
        const stored = blockStorage.blocks.get(blockName);
        if (stored && stored.polygon && stored.polygon.type && stored.polygon.geometry) {
            return stored.polygon;
        }
    } catch (_) { }
    if (blockPolygonCache.has(blockName)) {
        return blockPolygonCache.get(blockName);
    }
    if (!block || !Array.isArray(block.parcels) || block.parcels.length === 0) {
        return null;
    }
    let unioned = block.parcels[0].feature;
    for (let i = 1; i < block.parcels.length; i++) {
        try {
            const merged = turf.union(unioned, block.parcels[i].feature);
            if (merged) unioned = merged;
        } catch (_) { }
    }
    if (unioned) {
        blockPolygonCache.set(blockName, unioned);
        // Persist unioned polygon for future sessions
        try { blockStorage.setBlockPolygon(blockName, unioned); } catch (_) { }
    }
    return unioned;
}

function getExteriorRing(feature) {
    try {
        if (!feature || !feature.geometry) return null;
        if (feature.geometry.type === 'Polygon') return feature.geometry.coordinates[0] || null;
        if (feature.geometry.type === 'MultiPolygon') {
            let best = null, bestArea = -Infinity;
            for (const rings of feature.geometry.coordinates) {
                const area = turf.area(turf.polygon(rings));
                if (area > bestArea) { bestArea = area; best = rings[0]; }
            }
            return best;
        }
    } catch (_) { }
    return null;
}

function perimeterOfRingMeters(ring) {
    try {
        if (!Array.isArray(ring) || ring.length < 2) return 0;
        const closed = (ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1])
            ? ring
            : [...ring, ring[0]];
        const ls = turf.lineString(closed);
        return turf.length(ls, { units: 'kilometers' }) * 1000;
    } catch (_) {
        return 0;
    }
}

// Pre-compute and cache block polygons
function precomputeBlockPolygons() {
    blockPolygonCache.clear();

    blockStorage.blocks.forEach((block, blockName) => {
        // Prefer persisted polygon if available
        if (block && block.polygon && block.polygon.type && block.polygon.geometry) {
            blockPolygonCache.set(blockName, block.polygon);
            return;
        }
        // Fallback: compute from parcels if available
        if (block.parcels && block.parcels.length) {
            let unioned = block.parcels[0].feature;
            for (let i = 1; i < block.parcels.length; i++) {
                try {
                    const next = block.parcels[i].feature;
                    const merged = turf.union(unioned, next);
                    if (merged) unioned = merged;
                } catch (e) {
                    console.warn('Failed to union parcel', i, 'in block', blockName, e);
                }
            }
            blockPolygonCache.set(blockName, unioned);
            try { blockStorage.setBlockPolygon(blockName, unioned); } catch (_) { }
        }
    });
}

// Replace updateBlockLayer with new logic for unioned block polygons
function updateBlockLayer() {
    // console.log('updateBlockLayer called', new Error().stack);
    // const showBlocks = document.getElementById('showBlocks').checked; // REMOVED - state is now managed by parcelBlocksCheckbox via toggleAccordion

    // Remove previous block polygons layer
    if (blockPolygonsLayer) {
        map.removeLayer(blockPolygonsLayer);
        blockPolygonsLayer = null;
        window.blockPolygonsLayer = null;
    }
    // Remove previous block name labels
    if (blockNameLabels && blockNameLabels.length) {
        blockNameLabels.forEach(label => map.removeLayer(label));
        blockNameLabels = [];
    }

    // if (!showBlocks) return; // REMOVED - This function is now called when blocks should be shown

    blockPolygonsLayer = L.featureGroup().addTo(map);
    window.blockPolygonsLayer = blockPolygonsLayer;

    // Check whether to show block name labels
    const namesCheckbox = document.getElementById('showBlockNames');
    const shouldShowNames = namesCheckbox ? namesCheckbox.checked : true;

    // Ensure block polygons are pre-computed (from persisted polygons if possible)
    precomputeBlockPolygons();

    // For each cached block polygon, add it to the layer
    blockPolygonCache.forEach((unioned, blockName) => {
        // Style for block polygon
        const isSelected = blockName === selectedBlockName;
        const style = {
            fillColor: 'yellow',
            fillOpacity: isSelected ? 0.4 : 0.2,
            color: 'black',
            weight: 6,
            opacity: 1
        };
        // Add the cached polygon to the blockPolygonsLayer
        const geoJson = L.geoJSON(unioned, {
            style,
            onEachFeature: function (feature, layer) {
                layer.blockName = blockName;
                layer.on('click', function (e) {
                    highlightAndCenterBlock(blockName);
                    L.DomEvent.stopPropagation(e);
                });
            },
            interactive: true
        });
        geoJson.eachLayer(layer => {
            blockPolygonsLayer.addLayer(layer);
        });

        // Labels will be added separately if needed
    });

    // Add labels if they should be shown
    if (shouldShowNames) {
        addBlockNameLabels();
    }

    // Reapply parcel-level highlights for the selected block
    rehighlightSelectedBlockParcels();
}

// Toggle handler for the "Block names" checkbox
function toggleBlockNameLabels() {
    const blocksChecked = document.getElementById('parcelBlocksCheckbox');
    if (!blocksChecked || !blocksChecked.checked) {
        // If blocks are not shown, do nothing
        return;
    }

    const namesCheckbox = document.getElementById('showBlockNames');
    const shouldShowNames = namesCheckbox ? namesCheckbox.checked : true;

    if (shouldShowNames) {
        // Show labels - add them to existing block polygons
        addBlockNameLabels();
    } else {
        // Hide labels - remove them from map but keep block polygons
        removeBlockNameLabels();
    }
}

// Add block name labels to existing block polygons
function addBlockNameLabels() {
    // Only add labels if they don't already exist
    if (blockNameLabels.length > 0) {
        return; // Labels already exist
    }

    // Use cached block polygons for centroid calculation
    blockPolygonCache.forEach((unioned, blockName) => {
        try {
            // Use turf.centroid on the cached polygon geometry
            const centroidFeature = turf.centroid(unioned);
            const centroid = centroidFeature.geometry.coordinates; // [lng, lat]
            if (isFinite(centroid[0]) && isFinite(centroid[1])) {
                const label = L.marker([centroid[1], centroid[0]], {
                    icon: L.divIcon({
                        className: 'block-name-label',
                        html: `<span style="background:rgba(255,255,200,0.85);color:#222;padding:2px 10px;border-radius:8px;font-weight:bold;font-size:15px;border:1.5px solid #222;box-shadow:0 1px 6px rgba(0,0,0,0.10);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px;">${blockName}</span>`,
                        iconSize: [120, 24],
                        iconAnchor: [60, 12]
                    }),
                    interactive: false
                });
                label.addTo(blockPolygonsLayer);
                blockNameLabels.push(label);
            }
        } catch (e) {
            console.warn('Could not place block name label for', blockName, e);
        }
    });
}

// Remove block name labels from map
function removeBlockNameLabels() {
    if (blockNameLabels && blockNameLabels.length) {
        blockNameLabels.forEach(label => map.removeLayer(label));
        blockNameLabels = [];
    }
}

// Update highlightBlock to only update blockPolygonsLayer style
// Deprecated: merged into highlightAndCenterBlock. Keep a tiny shim for any lingering calls.
function highlightBlock(blockName) {
    highlightAndCenterBlock(blockName);
}

// Break selected block up by inserting a perpendicular road through the block's longest side midpoint
async function breakSelectedBlockUp() {
    if (!selectedBlockName || !blockStorage.blocks.has(selectedBlockName)) {
        updateStatus('No block selected');
        return;
    }
    const initialBlock = blockStorage.blocks.get(selectedBlockName);
    if (!initialBlock || !initialBlock.parcels || initialBlock.parcels.length === 0) {
        updateStatus('Selected block has no parcels');
        return;
    }

    const button = document.getElementById('breakBlockUpButton');

    const run = async () => {
        try {
            await new Promise(resolve => setTimeout(resolve, 0));
            const block = blockStorage.blocks.get(selectedBlockName) || initialBlock;
            if (!block || !block.parcels || block.parcels.length === 0) {
                updateStatus('Selected block has no parcels');
                return;
            }

            // Build a union polygon of the block
            let unioned = block.parcels[0].feature;
            for (let i = 1; i < block.parcels.length; i++) {
                try {
                    const merged = turf.union(unioned, block.parcels[i].feature);
                    if (merged) unioned = merged;
                } catch (e) {
                    console.warn('Union failed while preparing block split:', e);
                }
            }

            let outerRing = null;
            if (unioned && unioned.geometry) {
                if (unioned.geometry.type === 'Polygon') {
                    outerRing = unioned.geometry.coordinates[0];
                } else if (unioned.geometry.type === 'MultiPolygon') {
                    let best = null;
                    let bestArea = -Infinity;
                    for (const rings of unioned.geometry.coordinates) {
                        const poly = turf.polygon(rings);
                        const area = turf.area(poly);
                        if (area > bestArea) {
                            bestArea = area;
                            best = rings[0];
                        }
                    }
                    outerRing = best;
                }
            }
            if (!outerRing || outerRing.length < 2) {
                updateStatus('Could not determine block outline');
                return;
            }

            let hull = null;
            try { hull = turf.convex(unioned); } catch (_) { }
            const ringForMBR = (hull && hull.geometry && hull.geometry.type === 'Polygon')
                ? hull.geometry.coordinates[0]
                : outerRing;
            if (!Array.isArray(ringForMBR) || ringForMBR.length < 2) {
                updateStatus('Failed to compute block hull for MBR');
                return;
            }

            const ptsHTRS = ringForMBR.map(p => wgs84ToHTRS96(p[1], p[0]));
            const angles = [];
            for (let i = 0; i < ptsHTRS.length - 1; i++) {
                const x1 = ptsHTRS[i][0], y1 = ptsHTRS[i][1];
                const x2 = ptsHTRS[i + 1][0], y2 = ptsHTRS[i + 1][1];
                const ax = x2 - x1, ay = y2 - y1;
                const ang = Math.atan2(ay, ax);
                if (isFinite(ang)) angles.push(ang);
            }
            if (angles.length === 0) angles.push(0);

            let bestRect = null;
            let bestArea = Infinity;
            let bestAngle = 0;
            for (const theta of angles) {
                const cos = Math.cos(theta), sin = Math.sin(theta);
                let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
                for (const [x, y] of ptsHTRS) {
                    const rx = cos * x + sin * y;
                    const ry = -sin * x + cos * y;
                    if (rx < minX) minX = rx;
                    if (rx > maxX) maxX = rx;
                    if (ry < minY) minY = ry;
                    if (ry > maxY) maxY = ry;
                }
                const w = maxX - minX;
                const h = maxY - minY;
                const area = w * h;
                if (area < bestArea) {
                    bestArea = area;
                    bestAngle = theta;
                    bestRect = { minX, maxX, minY, maxY, w, h };
                }
            }
            if (!bestRect) {
                updateStatus('Failed to compute MBR');
                return;
            }

            const { minX, maxX, minY, maxY, w, h } = bestRect;
            const cosB = Math.cos(bestAngle);
            const sinB = Math.sin(bestAngle);
            const cxr = (minX + maxX) / 2;
            const cyr = (minY + maxY) / 2;
            const centerHTRS = [cosB * cxr - sinB * cyr, sinB * cxr + cosB * cyr];
            let px = -sinB;
            let py = cosB;
            if (w < h) {
                px = cosB;
                py = sinB;
            }

            try {
                if (window.blockSplitDebugLayer) {
                    map.removeLayer(window.blockSplitDebugLayer);
                    window.blockSplitDebugLayer = null;
                }
                const rectCornersRot = [
                    [minX, minY],
                    [maxX, minY],
                    [maxX, maxY],
                    [minX, maxY],
                    [minX, minY]
                ];
                const rectCornersWGS = rectCornersRot.map(([rx, ry]) => {
                    const x = cosB * rx - sinB * ry;
                    const y = sinB * rx + cosB * ry;
                    const [lat, lng] = htrs96ToWGS84(x, y);
                    return [lat, lng];
                });
                window.blockSplitDebugLayer = L.polygon(rectCornersWGS, {
                    color: '#0066ff',
                    weight: 2,
                    opacity: 0.9,
                    fillOpacity: 0.05,
                    dashArray: '6,4'
                }).addTo(map);
            } catch (e) {
                console.warn('Failed to render MBR debug rectangle:', e);
            }

            const midHTRS = centerHTRS;
            const farNegHTRS = [midHTRS[0] - px * 2000, midHTRS[1] - py * 2000];
            const farPosHTRS = [midHTRS[0] + px * 2000, midHTRS[1] + py * 2000];
            const farNegWGS = htrs96ToWGS84(farNegHTRS[0], farNegHTRS[1]);
            const farPosWGS = htrs96ToWGS84(farPosHTRS[0], farPosHTRS[1]);

            let endA = null;
            let endB = null;
            try {
                const across = turf.lineString([
                    [farNegWGS[1], farNegWGS[0]],
                    [farPosWGS[1], farPosWGS[0]]
                ]);
                let roadHits = [];
                try {
                    if (parcelLayer && typeof parcelLayer.eachLayer === 'function') {
                        parcelLayer.eachLayer(layer => {
                            try {
                                const id = parcelIdFromLayer(layer);
                                const isRoadFlag = (layer?.feature?.properties?.isRoad === true)
                                    || (id && typeof window.isRoadParcel === 'function' && window.isRoadParcel(id));
                                if (!isRoadFlag) return;
                                const coords = layer.feature.geometry.coordinates[0];
                                const ls = turf.lineString(coords);
                                const h = turf.lineIntersect(across, ls);
                                if (h && h.features && h.features.length) {
                                    roadHits.push(...h.features);
                                }
                            } catch (_) { }
                        });
                    }
                } catch (_) { }

                const collectBest = (features) => {
                    let bestNeg = { s: -Infinity, pt: null };
                    let bestPos = { s: Infinity, pt: null };
                    features.forEach(f => {
                        const pt = f.geometry.coordinates;
                        const pHTRS = wgs84ToHTRS96(pt[1], pt[0]);
                        const vX = pHTRS[0] - midHTRS[0];
                        const vY = pHTRS[1] - midHTRS[1];
                        const s = vX * px + vY * py;
                        if (s < 0 && s > bestNeg.s) { bestNeg = { s, pt }; }
                        if (s > 0 && s < bestPos.s) { bestPos = { s, pt }; }
                    });
                    return { bestNeg, bestPos };
                };

                if (roadHits.length >= 2) {
                    const { bestNeg, bestPos } = collectBest(roadHits);
                    if (bestNeg.pt && bestPos.pt) {
                        endA = [bestNeg.pt[1], bestNeg.pt[0]];
                        endB = [bestPos.pt[1], bestPos.pt[0]];
                    }
                }

                if (!endA || !endB) {
                    const boundary = turf.lineString(outerRing);
                    const hits = turf.lineIntersect(across, boundary);
                    if (hits && hits.features && hits.features.length > 0) {
                        const { bestNeg, bestPos } = collectBest(hits.features);
                        if (bestNeg.pt && bestPos.pt) {
                            endA = [bestNeg.pt[1], bestNeg.pt[0]];
                            endB = [bestPos.pt[1], bestPos.pt[0]];
                        }
                    }
                }
            } catch (e) {
                console.warn('Line intersection failed; using fallback end points', e);
            }

            if (!endA || !endB) {
                endA = farNegWGS;
                endB = farPosWGS;
            }

            let widthMeters = 7;
            try {
                const sel = document.getElementById('roadWidthSelect');
                if (sel) widthMeters = parseFloat(sel.value) || widthMeters;
            } catch (_) { }

            const halfW = widthMeters / 2;
            const dLen = Math.hypot(px, py) || 1;
            const dxu = px / dLen;
            const dyu = py / dLen;
            const nx = -dyu;
            const ny = dxu;

            const leftBase = [midHTRS[0] + nx * halfW, midHTRS[1] + ny * halfW];
            const rightBase = [midHTRS[0] - nx * halfW, midHTRS[1] - ny * halfW];
            const longL = 2000;

            function buildLongLineWGS(base) {
                const pNeg = htrs96ToWGS84(base[0] - dxu * longL, base[1] - dyu * longL);
                const pPos = htrs96ToWGS84(base[0] + dxu * longL, base[1] + dyu * longL);
                return turf.lineString([[pNeg[1], pNeg[0]], [pPos[1], pPos[0]]]);
            }

            function collectRoadBoundaries() {
                const lines = [];
                try {
                    if (parcelLayer && typeof parcelLayer.eachLayer === 'function') {
                        parcelLayer.eachLayer(layer => {
                            const id = parcelIdFromLayer(layer);
                            const isRoadFlag = (layer?.feature?.properties?.isRoad === true)
                                || (id && typeof window.isRoadParcel === 'function' && window.isRoadParcel(id));
                            if (!isRoadFlag) return;
                            const coords = layer.feature.geometry.coordinates[0];
                            lines.push(turf.lineString(coords));
                        });
                    }
                } catch (_) { }
                return lines;
            }

            function bestHitsForLine(line) {
                const roadLines = collectRoadBoundaries();
                const hits = [];
                roadLines.forEach(ls => {
                    try {
                        const h = turf.lineIntersect(line, ls);
                        if (h && h.features && h.features.length) hits.push(...h.features);
                    } catch (_) { }
                });
                if (hits.length < 2) {
                    try {
                        const boundary = turf.lineString(outerRing);
                        const h2 = turf.lineIntersect(line, boundary);
                        if (h2 && h2.features && h2.features.length) hits.push(...h2.features);
                    } catch (_) { }
                }
                let bestNeg = { s: -Infinity, pt: null };
                let bestPos = { s: Infinity, pt: null };
                hits.forEach(f => {
                    const pt = f.geometry.coordinates;
                    const pH = wgs84ToHTRS96(pt[1], pt[0]);
                    const vx = pH[0] - midHTRS[0];
                    const vy = pH[1] - midHTRS[1];
                    const s = vx * dxu + vy * dyu;
                    if (s < 0 && s > bestNeg.s) bestNeg = { s, pt };
                    if (s > 0 && s < bestPos.s) bestPos = { s, pt };
                });
                return { bestNeg, bestPos };
            }

            const leftLine = buildLongLineWGS(leftBase);
            const rightLine = buildLongLineWGS(rightBase);
            const leftHits = bestHitsForLine(leftLine);
            const rightHits = bestHitsForLine(rightLine);

            if (!(leftHits.bestNeg.pt && leftHits.bestPos.pt && rightHits.bestNeg.pt && rightHits.bestPos.pt)) {
                updateStatus('Could not resolve road endpoints on both sides; aborting split.');
                return;
            }

            const Lneg = leftHits.bestNeg.pt;
            const Lpos = leftHits.bestPos.pt;
            const Rneg = rightHits.bestNeg.pt;
            const Rpos = rightHits.bestPos.pt;
            const roadPoly = [
                L.latLng(Lneg[1], Lneg[0]),
                L.latLng(Lpos[1], Lpos[0]),
                L.latLng(Rpos[1], Rpos[0]),
                L.latLng(Rneg[1], Rneg[0])
            ];
            if (!roadPoly || roadPoly.length < 3) {
                updateStatus('Failed to compute split road geometry');
                return;
            }

            if (typeof findAffectedParcels === 'function') {
                try {
                    findAffectedParcels(roadPoly);
                } catch (e) {
                    console.warn('findAffectedParcels error:', e);
                }
            }
            let affected = [];
            try {
                if (typeof roadAffectedParcels !== 'undefined' && Array.isArray(roadAffectedParcels)) {
                    affected = roadAffectedParcels;
                }
            } catch (_) { }

            if (!affected || affected.length === 0) {
                updateStatus('Split road did not intersect any parcels. Try adjusting width or ensure the block is fully in view.');
                return;
            }

            if (typeof updateParcelsWithRoad === 'function') {
                updateParcelsWithRoad(roadPoly, affected, `Split ${selectedBlockName}`);
                updateStatus('Block split by a perpendicular road through its middle');
                if (typeof countBlocks === 'function') {
                    setTimeout(countBlocks, 0);
                }
            } else {
                updateStatus('Missing road update function');
            }
        } catch (error) {
            console.error('Error splitting block:', error);
            updateStatus('Error while splitting the selected block.');
        }
    };

    if (typeof runWithButtonBusyState === 'function' && button) {
        return runWithButtonBusyState(button, 'Splitting...', run);
    }
    return run();
}

window.breakSelectedBlockUp = breakSelectedBlockUp;

// Redraw block borders when parcels finish loading if blocks are shown
try {
    window.addEventListener('parcelDataLoaded', function () {
        const blocksShown = document.getElementById('parcelBlocksCheckbox') && document.getElementById('parcelBlocksCheckbox').checked;
        if (blocksShown && typeof updateBlockLayer === 'function') {
            updateBlockLayer();
        }
    });

    // When in Parcel Blocks mode, clicking outside any block polygon should clear selection and close panel
    try {
        window.addEventListener('DOMContentLoaded', () => {
            if (typeof map !== 'undefined' && map && typeof map.on === 'function') {
                // Avoid attaching multiple times
                if (!map._blocksOutsideClickHandlerAttached) {
                    map.on('click', function () {
                        try {
                            const blocksShown = document.getElementById('parcelBlocksCheckbox') && document.getElementById('parcelBlocksCheckbox').checked;
                            if (!blocksShown) return;
                            // If a block is selected, clear it on outside click
                            const hasSelected = (typeof selectedBlockName !== 'undefined' && selectedBlockName)
                                || (typeof window !== 'undefined' && window.selectedBlockName);
                            if (hasSelected) {
                                clearSelectedBlockAndUI();
                            }
                        } catch (_) { }
                    });
                    map._blocksOutsideClickHandlerAttached = true;
                }
            }
        });
    } catch (_) { }

    // Expose for external callers if needed
    window.clearSelectedBlockAndUI = clearSelectedBlockAndUI;
} catch (_) { }
