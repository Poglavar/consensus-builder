// OSM Road Detection and Naming System
let osmRoadLayer = null;
let osmData = null;
let roadDetectionProgress = { current: 0, total: 0 };
const OSM_CACHE_KEY = 'osm_roads_cache';
const OSM_CACHE_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
let wfsRoadUseLayer = null;

// WFS (OSS) config for land use (DKP_NACINI_UPORABE)
const OSS_WFS_BASE = 'https://oss.uredjenazemlja.hr/OssWebServices/wfs';
const OSS_TOKEN = '7effb6395af73ee111123d3d1317471357a1f012d4df977d3ab05ebdc184a46e';
// Usage codes considered as roads
const ROAD_USAGE_CODES = new Set(['520', '521', '522', '523', '524', '526', '544', '545', '547']);

// Fetch DKP_NACINI_UPORABE features in current bbox, paginated if needed
async function fetchWFSUsageInBbox() {
    const bounds = map.getBounds();
    const bbox = typeof getBboxFromBounds === 'function' ? getBboxFromBounds(bounds) : null;
    if (!bbox) {
        throw new Error('Could not compute bbox');
    }

    const params = {
        token: OSS_TOKEN,
        service: 'WFS',
        version: '2.0.0',
        request: 'GetFeature',
        outputFormat: 'json',
        typeName: 'oss:DKP_NACINI_UPORABE',
        srsName: 'EPSG:3765',
        bbox: bbox,
        count: '4000'
    };

    let startIndex = 0;
    const allFeatures = [];
    while (true) {
        const usp = new URLSearchParams(params);
        if (startIndex > 0) usp.set('startIndex', String(startIndex));
        const url = `${OSS_WFS_BASE}?${usp.toString()}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('Failed to fetch DKP_NACINI_UPORABE');
        const data = await resp.json();
        const features = Array.isArray(data.features) ? data.features : [];
        allFeatures.push(...features);
        const numberReturned = Number(data.numberReturned || features.length);
        const numberMatched = Number(data.numberMatched);
        if (isFinite(numberMatched) && numberMatched > 0) {
            if (startIndex + numberReturned >= numberMatched || numberReturned === 0) break;
        } else {
            if (numberReturned < Number(params.count)) break;
        }
        startIndex += numberReturned;
    }

    return { type: 'FeatureCollection', features: allFeatures };
}

// Check if two polygonal features are geometrically identical (within tolerance)
// Compute Intersection-over-Union (IoU) between two polygonal features
function computeIoU(featureA, featureB) {
    try {
        const areaA = turf.area(featureA);
        const areaB = turf.area(featureB);
        if (!isFinite(areaA) || !isFinite(areaB) || areaA <= 0 || areaB <= 0) return 0;
        let inter = null;
        try { inter = turf.intersect(featureA, featureB); } catch (_) { inter = null; }
        const areaI = inter ? turf.area(inter) : 0;
        const areaU = areaA + areaB - areaI;
        if (areaU <= 0) return 0;
        return areaI / areaU;
    } catch (_) {
        return 0;
    }
}

// Main entry: Detect roads from WFS DKP_NACINI_UPORABE by parcel intersection
async function detectRoadsFromWFS() {
    if (!parcelLayer) {
        updateStatus('No parcels loaded. Please refresh data first.');
        return;
    }

    const progressContainer = document.getElementById('progressContainer');
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');
    if (progressContainer) progressContainer.style.display = 'block';
    if (progressText) progressText.textContent = 'Fetching WFS usage data...';

    try {
        const usageData = await fetchWFSUsageInBbox();
        // Filter by road usage codes and polygonal geometry
        let roadUseFeatures = (usageData.features || []).filter(f => {
            const code = String(f?.properties?.SIFRA_VRSTE_UPORABE || '');
            const isPoly = f?.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon');
            return isPoly && ROAD_USAGE_CODES.has(code);
        });

        // Convert all usage features to WGS84 if needed
        try {
            const fc = { type: 'FeatureCollection', features: roadUseFeatures };
            const converted = typeof convertGeoJSON === 'function' ? convertGeoJSON(fc) : fc;
            roadUseFeatures = converted.features;
        } catch (_) { }

        if (progressText) progressText.textContent = `Matching ${roadUseFeatures.length} WFS polygons to parcel geometries (overlap)...`;

        // Prepare parcels in current view
        const parcelsInView = parcelLayer.getLayers().filter(layer => {
            try { return map.getBounds().intersects(layer.getBounds()); } catch (_) { return false; }
        });
        const parcelEntries = parcelsInView.map(layer => ({ layer, bounds: layer.getBounds(), gj: layer.toGeoJSON() }));

        let processed = 0;
        let marked = 0;
        const total = roadUseFeatures.length;

        for (const usage of roadUseFeatures) {
            processed++;
            // Prefilter by bounds overlap to reduce comparisons
            let uBounds = null;
            try { uBounds = L.geoJSON(usage).getBounds(); } catch (_) { }
            const candidates = uBounds ? parcelEntries.filter(pe => { try { return uBounds.intersects(pe.bounds); } catch (_) { return true; } }) : parcelEntries;

            for (const pe of candidates) {
                const parcelGeoJSON = pe.gj;
                if (!parcelGeoJSON || !parcelGeoJSON.geometry) continue;
                // Compute overlap ratios instead of strict IoU threshold
                let overlapA = 0; // intersection / area(parcel)
                let overlapB = 0; // intersection / area(usage)
                try {
                    const areaA = turf.area(parcelGeoJSON);
                    const areaB = turf.area(usage);
                    if (!isFinite(areaA) || !isFinite(areaB) || areaA <= 0 || areaB <= 0) {
                        continue;
                    }
                    let inter = null;
                    try { inter = turf.intersect(parcelGeoJSON, usage); } catch (_) { inter = null; }
                    const areaI = inter ? turf.area(inter) : 0;
                    overlapA = areaI / areaA;
                    overlapB = areaI / areaB;
                } catch (_) { }

                // Loosen match: consider a match if either polygon overlaps the other by >= 90%
                if (overlapA >= 0.9 || overlapB >= 0.9) {
                    const parcelId = pe.layer.feature.properties.CESTICA_ID;
                    PersistentStorage.setItem(`parcel_${parcelId}_isRoad`, 'true');
                    pe.layer.setStyle(roadStyle);
                    pe.layer.feature.properties.isRoad = true;
                    marked++;
                }
            }

            const pct = total > 0 ? Math.round((processed / total) * 100) : 100;
            if (progressFill) progressFill.style.width = `${pct}%`;
            if (progressText) progressText.textContent = `Geometry matching: ${processed}/${total} (${pct}%)`;
            await new Promise(r => setTimeout(r, 0));
        }

        if (progressContainer) progressContainer.style.display = 'none';
        updateStatus(`Geometry-based WFS detection complete. Marked ${marked} parcels as roads.`);
        updateParcelStyles();
    } catch (err) {
        console.error('Error detecting roads from WFS:', err);
        if (progressContainer) progressContainer.style.display = 'none';
        updateStatus('Error detecting roads from WFS.');
    }
}

// Expose for UI
window.detectRoadsFromWFS = detectRoadsFromWFS;

// Draw-only overlay for WFS road usage polygons
async function drawWFSRoadParcels() {
    const status = document.getElementById('status');
    updateStatus('Fetching WFS road usage polygons...');
    try {
        const usageData = await fetchWFSUsageInBbox();
        const roadUseFeatures = (usageData.features || []).filter(f => {
            const code = String(f?.properties?.SIFRA_VRSTE_UPORABE || '');
            return ROAD_USAGE_CODES.has(code);
        });

        // Convert to WGS84 if needed and draw
        let fc = { type: 'FeatureCollection', features: roadUseFeatures };
        try {
            fc = typeof convertGeoJSON === 'function' ? convertGeoJSON(fc) : fc;
        } catch (_) { }

        if (wfsRoadUseLayer) {
            map.removeLayer(wfsRoadUseLayer);
            wfsRoadUseLayer = null;
        }

        wfsRoadUseLayer = L.geoJSON(fc, {
            style: {
                color: '#2a9d8f',
                weight: 2,
                fillColor: '#2a9d8f',
                fillOpacity: 0.15
            },
            onEachFeature: (feature, layer) => {
                const code = feature?.properties?.SIFRA_VRSTE_UPORABE;
                const broj = feature?.properties?.BROJ;
                const ko = feature?.properties?.MATICNI_BROJ_KO;
                layer.bindTooltip(`KO: ${ko || '-'} | BROJ: ${broj || '-'} | UPORABA: ${code || '-'}`);
            }
        }).addTo(map);

        updateStatus(`Drew ${roadUseFeatures.length} WFS road-usage polygons`);

        // Ensure the checkbox reflects visibility state
        const wfsCheckbox = document.getElementById('showWFSPolygons');
        if (wfsCheckbox) {
            wfsCheckbox.checked = true;
        }
    } catch (e) {
        console.error('Error drawing WFS road usage polygons:', e);
        updateStatus('Error drawing WFS road usage polygons.');
    }
}

window.drawWFSRoadParcels = drawWFSRoadParcels;

// Toggle visibility for WFS polygons layer
function toggleWFSPolygons() {
    try {
        const checkbox = document.getElementById('showWFSPolygons');
        if (!checkbox) return;

        if (checkbox.checked) {
            // If layer exists, ensure it's on the map; otherwise draw it now
            if (wfsRoadUseLayer) {
                if (!map.hasLayer(wfsRoadUseLayer)) {
                    wfsRoadUseLayer.addTo(map);
                    updateStatus('WFS polygons shown');
                }
            } else {
                // Fetch and draw if not already present
                drawWFSRoadParcels();
            }
        } else {
            // Remove the layer if present
            if (wfsRoadUseLayer && map.hasLayer(wfsRoadUseLayer)) {
                map.removeLayer(wfsRoadUseLayer);
                updateStatus('WFS polygons hidden');
            }
        }
    } catch (err) {
        console.error('Error toggling WFS polygons:', err);
    }
}

window.toggleWFSPolygons = toggleWFSPolygons;

// Function to fetch road data from OpenStreetMap using Overpass API
async function fetchOSMRoads() {
    const status = document.getElementById('status');
    updateStatus('Fetching road data from OpenStreetMap...');

    try {
        const bounds = map.getBounds();
        const south = bounds.getSouth();
        const west = bounds.getWest();
        const north = bounds.getNorth();
        const east = bounds.getEast();

        // Check cache first
        const cachedData = checkOSMCache(south, west, north, east);
        if (cachedData) {
            updateStatus('Using cached OSM road data');
            return cachedData;
        }

        // Overpass API query for roads (highway) and railways; exclude footpaths explicitly
        const overpassQuery = `
            [out:json][timeout:60];
            (
                way[highway][name](${south},${west},${north},${east});
                way[highway~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|service|living_street)$"](${south},${west},${north},${east});
                way[railway](${south},${west},${north},${east});
            );
            out body geom;
        `;

        const overpassUrl = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(overpassQuery)}`;

        const response = await fetch(overpassUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch OSM data: ${response.statusText}`);
        }

        const data = await response.json();

        // Cache the result
        cacheOSMData(data, south, west, north, east);

        updateStatus(`Fetched ${data.elements.length} roads from OpenStreetMap`);
        return data;
    } catch (error) {
        console.error('Error fetching OSM data:', error);
        updateStatus(`Error fetching OSM data: ${error.message}`);
        return null;
    }
}

// Function to store OSM data in cache
function cacheOSMData(data, south, west, north, east) {
    const cacheItem = {
        data: data,
        bounds: { south, west, north, east },
        timestamp: Date.now()
    };
    PersistentStorage.setItem(OSM_CACHE_KEY, JSON.stringify(cacheItem));
}

// Function to check if valid cached data exists
function checkOSMCache(south, west, north, east) {
    try {
        const cachedItem = JSON.parse(PersistentStorage.getItem(OSM_CACHE_KEY));
        if (!cachedItem) return null;

        // Check if cache is expired
        if (Date.now() - cachedItem.timestamp > OSM_CACHE_EXPIRY) {
            console.log('OSM cache expired');
            return null;
        }

        // Check if current bounds are contained within cached bounds
        const cachedBounds = cachedItem.bounds;
        if (south < cachedBounds.south || north > cachedBounds.north ||
            west < cachedBounds.west || east > cachedBounds.east) {
            console.log('Current view outside cached bounds');
            return null;
        }

        console.log('Using cached OSM data');
        return cachedItem.data;
    } catch (error) {
        console.error('Error reading OSM cache:', error);
        return null;
    }
}

// Convert OSM ways to GeoJSON
function osmToGeoJSON(osmData) {
    const features = [];

    if (!osmData || !osmData.elements) return { type: 'FeatureCollection', features: [] };

    for (const element of osmData.elements) {
        if (element.type !== 'way' || !element.geometry || element.geometry.length < 2) continue;

        const coordinates = element.geometry.map(node => [node.lon, node.lat]);

        const feature = {
            type: 'Feature',
            properties: {
                id: element.id,
                name: element.tags.name || 'Unnamed Road',
                highway: element.tags.highway,
                railway: element.tags.railway,
                width: element.tags.width,
                osmTags: element.tags
            },
            geometry: {
                type: 'LineString',
                coordinates: coordinates
            }
        };

        features.push(feature);
    }

    return {
        type: 'FeatureCollection',
        features: features
    };
}

// Display the fetched OSM roads on the map
function displayOSMRoads(osmGeoJSON) {
    window.osmRoadGeoJSON = osmGeoJSON;
    if (window.osmRoadLayer) {
        map.removeLayer(window.osmRoadLayer);
    }
    window.osmRoadLayer = L.geoJSON(osmGeoJSON, {
        style: function (feature) {
            const isRail = !!feature.properties.railway;
            if (isRail) {
                return { color: '#444', weight: 2, opacity: 0.8, dashArray: '4,4' };
            }
            function getRandomColor() {
                const hue = Math.floor(Math.random() * 360);
                return `hsl(${hue}, 70%, 60%)`;
            }
            return { color: getRandomColor(), weight: 3, opacity: 0.6 };
        },
        onEachFeature: (feature, layer) => {
            const name = feature.properties.name || 'Unnamed';
            const type = feature.properties.railway ? `railway:${feature.properties.railway}` : feature.properties.highway;
            layer.bindTooltip(`${name} (${type})`);
        }
    });
    // Only add to map if checkbox is checked
    const cb = document.getElementById('showOSMRoadLines');
    if (!cb || cb.checked) {
        window.osmRoadLayer.addTo(map);
    }
}

// Toggle OSM road lines visibility
function toggleOSMRoadLines() {
    const cb = document.getElementById('showOSMRoadLines');
    if (cb && window.osmRoadLayer) {
        if (cb.checked) {
            window.osmRoadLayer.addTo(map);
        } else {
            map.removeLayer(window.osmRoadLayer);
        }
    }
}

// Function to detect which parcels are roads based on OSM data
async function detectRoadsFromOSM() {
    if (!parcelLayer) {
        updateStatus('No parcels loaded. Please refresh data first.');
        return;
    }

    const status = document.getElementById('status');
    const progressContainer = document.getElementById('progressContainer');
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');

    // Show progress indicator if it exists
    if (progressContainer) {
        progressContainer.style.display = 'block';
    }

    if (progressText) {
        progressText.textContent = 'Fetching OSM data...';
    }

    try {
        // Fetch OSM road data
        const osmData = await fetchOSMRoads();
        if (!osmData) {
            updateStatus('Failed to fetch OSM road data.');
            if (progressContainer) {
                progressContainer.style.display = 'none';
            }
            return;
        }

        // Convert to GeoJSON
        const osmGeoJSON = osmToGeoJSON(osmData);

        // Optional: Display the OSM roads on the map
        displayOSMRoads(osmGeoJSON);

        // Get parcels in current viewport only
        const mapBounds = map.getBounds();
        const allParcels = parcelLayer.getLayers();
        const parcels = allParcels.filter(layer => {
            try {
                return mapBounds.intersects(layer.getBounds());
            } catch (e) {
                // If bounds are unavailable, skip the layer for safety
                return false;
            }
        });
        const totalParcels = parcels.length;
        if (totalParcels === 0) {
            if (progressContainer) {
                progressContainer.style.display = 'none';
            }
            updateStatus('No parcels in the current view to analyze.');
            return;
        }
        roadDetectionProgress = { current: 0, total: totalParcels };

        updateStatus(`Analyzing ${totalParcels} parcels...`);

        // Faster approach: iterate OSM lines and mark intersecting parcels
        const foundRoads = await detectRoadsByOSMLinesFirst(parcels, osmGeoJSON);

        // Hide progress indicator
        if (progressContainer) {
            progressContainer.style.display = 'none';
        }
        updateStatus(`Road detection complete. Found ${foundRoads} road parcels and assigned names.`);

        // Update the parcel styles after detection
        updateParcelStyles();

    } catch (error) {
        console.error('Error in road detection:', error);
        updateStatus(`Error in road detection: ${error.message}`);
        if (progressContainer) {
            progressContainer.style.display = 'none';
        }
    }
}

// Process road detection in chunks to prevent UI freezing
async function processRoadDetectionInChunks(parcels, osmGeoJSON) {
    const CHUNK_SIZE = 20;
    const totalParcels = parcels.length;
    let processedParcels = 0;
    let foundRoads = 0;

    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');

    for (let i = 0; i < totalParcels; i += CHUNK_SIZE) {
        const chunk = parcels.slice(i, i + CHUNK_SIZE);

        // Process this chunk
        for (const parcel of chunk) {
            try {
                foundRoads += await detectIfParcelIsRoad(parcel, osmGeoJSON) ? 1 : 0;
            } catch (error) {
                console.error(`Failed to process parcel:`, error);
                // Continue with next parcel rather than failing the entire process
            }
            processedParcels++;

            // Update progress
            const progress = Math.round((processedParcels / totalParcels) * 100);
            if (progressFill) {
                progressFill.style.width = `${progress}%`;
            }
            if (progressText) {
                progressText.textContent = `Analyzing parcels: ${processedParcels}/${totalParcels} (${progress}%)`;
            }
        }

        // Allow UI update before continuing to next chunk
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    return foundRoads;
}

// Detect if a specific parcel is a road and assign road name
async function detectIfParcelIsRoad(parcel, osmGeoJSON) {
    try {
        if (!parcel || !parcel.feature || !parcel.feature.geometry || !parcel.feature.properties) {
            return false;
        }

        const parcelId = parcel.feature.properties.CESTICA_ID;
        const parcelGeoJSON = parcel.toGeoJSON();

        // Skip shape analysis and use only OSM data for detection
        let isRoad = false;
        let bestRoadName = null;
        let bestRoadId = null;
        let bestRoadConfidence = 0;

        // Buffer the parcel to check for intersections (using Turf.js)
        let parcelBuffer;
        try {
            // Ensure the parcel GeoJSON is valid for buffering
            if (!parcelGeoJSON || !parcelGeoJSON.geometry || !parcelGeoJSON.geometry.coordinates ||
                parcelGeoJSON.geometry.coordinates.length === 0) {
                console.warn(`Skipping invalid parcel ${parcelId} - invalid geometry`);
                return false;
            }

            // Create a smaller buffer to be more precise (reduced from 5m to 2m)
            parcelBuffer = turf.buffer(parcelGeoJSON, 2, { units: 'meters' });

            // Verify buffer was created successfully
            if (!parcelBuffer || !parcelBuffer.geometry) {
                console.warn(`Failed to create buffer for parcel ${parcelId}`);
                return false;
            }
        } catch (error) {
            console.warn(`Error buffering parcel ${parcelId}:`, error);
            return false;
        }

        // Check intersections with OSM roads
        let maxOverlap = 0;
        for (const roadFeature of osmGeoJSON.features) {
            try {
                // Skip invalid road features
                if (!roadFeature || !roadFeature.geometry || !roadFeature.geometry.coordinates ||
                    roadFeature.geometry.coordinates.length < 2) {
                    continue;
                }

                // Create buffered road
                let bufferedRoad;
                try {
                    // Use a fixed small buffer size for more precision
                    bufferedRoad = turf.buffer(roadFeature, 3, { units: 'meters' });
                    if (!bufferedRoad || !bufferedRoad.geometry) {
                        continue; // Skip if buffer creation failed
                    }
                } catch (bufferError) {
                    console.warn(`Error buffering road ${roadFeature.properties?.id}:`, bufferError);
                    continue; // Skip this road and continue with others
                }

                // Calculate intersection with validation
                let intersection;
                try {
                    intersection = turf.intersect(parcelBuffer, bufferedRoad);
                } catch (intersectError) {
                    console.warn(`Error calculating intersection between parcel ${parcelId} and road:`, intersectError);
                    continue; // Skip this road and continue with others
                }

                if (intersection) {
                    // Calculate overlap ratio (more strict threshold)
                    const intersectionArea = turf.area(intersection);
                    const parcelArea = turf.area(parcelGeoJSON);
                    const parcelBufferArea = turf.area(parcelBuffer);

                    // Calculate both ratios - intersection to parcel and intersection to buffer
                    const overlapRatioToParcel = intersectionArea / parcelArea;
                    const overlapRatioToBuffer = intersectionArea / parcelBufferArea;

                    // Use the more accurate ratio for detection
                    const overlapRatio = overlapRatioToParcel;

                    if (overlapRatio > maxOverlap) {
                        maxOverlap = overlapRatio;
                        bestRoadName = roadFeature.properties.name;
                        bestRoadId = roadFeature.properties.id;
                        bestRoadConfidence = overlapRatio;
                    }

                    // Only consider it a road if there's SIGNIFICANT overlap (increased threshold)
                    if (overlapRatio > 0.5) {  // Increased from 0.3 to 0.5 for stricter matching
                        isRoad = true;
                    }
                }
            } catch (err) {
                // Skip errors in individual road comparisons
                console.warn(`Error comparing parcel ${parcelId} with road:`, err);
            }
        }

        // Save the result only if it's a road with good confidence
        if (isRoad && bestRoadConfidence > 0.5) {  // Increased confidence threshold from 0.3 to 0.5
            // Store road information in PersistentStorage
            PersistentStorage.setItem(`parcel_${parcelId}_isRoad`, 'true');
            PersistentStorage.setItem(`parcel_${parcelId}_roadName`, bestRoadName || 'Unnamed Road');
            PersistentStorage.setItem(`parcel_${parcelId}_roadId`, bestRoadId || '');
            PersistentStorage.setItem(`parcel_${parcelId}_roadConfidence`, bestRoadConfidence.toString());

            // Update the parcel style
            parcel.setStyle(roadStyle);

            // Update feature properties for later use
            parcel.feature.properties.isRoad = true;
            parcel.feature.properties.roadName = bestRoadName;
            parcel.feature.properties.roadId = bestRoadId;
            parcel.feature.properties.roadConfidence = bestRoadConfidence;
        }

        return isRoad;
    } catch (error) {
        console.error('Error detecting if parcel is road:', error);
        return false;
    }
}

// Update styles for all parcels based on road detection
function updateParcelStyles() {
    if (!parcelLayer) return;

    parcelLayer.eachLayer(layer => {
        const parcelId = layer.feature.properties.CESTICA_ID;
        const isRoad = PersistentStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';

        if (isRoad) {
            layer.setStyle(roadStyle);

            // Get road name for tooltip
            const roadName = PersistentStorage.getItem(`parcel_${parcelId}_roadName`) || 'Unnamed Road';

            // Add or update tooltip with road name
            if (layer.getTooltip()) {
                layer.setTooltipContent(roadName);
            } else {
                layer.bindTooltip(roadName, {
                    permanent: false,
                    direction: 'center',
                    className: 'road-name-tooltip'
                });
            }
        } else {
            layer.setStyle(normalStyle);
            // Remove any existing tooltip
            if (layer.getTooltip()) {
                layer.unbindTooltip();
            }
        }
    });
}

// New: Iterate OSM lines first and mark intersecting parcels
async function detectRoadsByOSMLinesFirst(parcels, osmGeoJSON) {
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');

    // Build quick spatial index by parcel bounds
    const parcelEntries = parcels.map(layer => {
        const b = layer.getBounds();
        return { layer, bounds: b };
    });

    let marked = 0;
    let processed = 0;
    const total = (osmGeoJSON.features || []).length;

    for (const roadFeature of (osmGeoJSON.features || [])) {
        processed++;
        try {
            if (!roadFeature || !roadFeature.geometry || !roadFeature.geometry.coordinates) continue;

            // Buffer OSM line to a narrow corridor (3m) to intersect with parcels
            let bufferedRoad;
            try {
                bufferedRoad = turf.buffer(roadFeature, 3, { units: 'meters' });
                if (!bufferedRoad || !bufferedRoad.geometry) continue;
            } catch (_) { continue; }

            // Rough prefilter: compute bbox of buffered road
            const br = L.geoJSON(bufferedRoad).getBounds();

            // Check only parcels whose bounds intersect this bbox
            const candidates = parcelEntries.filter(pe => {
                try { return br.intersects(pe.bounds); } catch (_) { return false; }
            });

            for (const pe of candidates) {
                const parcelGeoJSON = pe.layer.toGeoJSON();
                let parcelBuffer;
                try {
                    parcelBuffer = turf.buffer(parcelGeoJSON, 2, { units: 'meters' });
                } catch (_) { continue; }

                let intersection = null;
                try {
                    intersection = turf.intersect(parcelBuffer, bufferedRoad);
                } catch (_) { }
                if (!intersection) continue;

                const intersectionArea = turf.area(intersection);
                const parcelArea = turf.area(parcelGeoJSON);
                const overlapRatio = intersectionArea / parcelArea;
                if (overlapRatio > 0.5) {
                    const parcelId = pe.layer.feature.properties.CESTICA_ID;
                    const name = roadFeature.properties.name || 'Unnamed Road';
                    const roadId = roadFeature.properties.id || '';
                    PersistentStorage.setItem(`parcel_${parcelId}_isRoad`, 'true');
                    PersistentStorage.setItem(`parcel_${parcelId}_roadName`, name);
                    PersistentStorage.setItem(`parcel_${parcelId}_roadId`, roadId);
                    PersistentStorage.setItem(`parcel_${parcelId}_roadConfidence`, overlapRatio.toString());
                    pe.layer.setStyle(roadStyle);
                    pe.layer.feature.properties.isRoad = true;
                    pe.layer.feature.properties.roadName = name;
                    pe.layer.feature.properties.roadId = roadId;
                    pe.layer.feature.properties.roadConfidence = overlapRatio;
                    marked++;
                }
            }
        } catch (_) { }

        // Progress UI
        const pct = Math.round((processed / total) * 100);
        if (progressFill) progressFill.style.width = `${pct}%`;
        if (progressText) progressText.textContent = `Analyzing OSM lines: ${processed}/${total} (${pct}%)`;
        await new Promise(r => setTimeout(r, 0));
    }

    return marked;
}

// Function to clear all detected roads
function clearDetectedRoads() {
    const status = document.getElementById('status');

    if (!parcelLayer) {
        updateStatus('No parcels to clear.');
        return;
    }

    // Count roads to clear
    let roadCount = 0;

    // Gather all PersistentStorage keys related to roads
    const keysToRemove = [];
    for (let i = 0; i < PersistentStorage.length; i++) {
        const key = PersistentStorage.key(i);
        if (key && key.startsWith('parcel_') && key.includes('_isRoad')) {
            keysToRemove.push(key);
            roadCount++;

            // Also remove related keys
            const baseKey = key.replace('_isRoad', '');
            keysToRemove.push(`${baseKey}_roadName`);
            keysToRemove.push(`${baseKey}_roadId`);
            keysToRemove.push(`${baseKey}_roadConfidence`);
        }
    }

    // Remove all road-related keys
    keysToRemove.forEach(key => PersistentStorage.removeItem(key));

    // Update styles on all parcel layers
    parcelLayer.eachLayer(layer => {
        // Remove road styling
        layer.setStyle(normalStyle);

        // Remove tooltip
        if (layer.getTooltip()) {
            layer.unbindTooltip();
        }

        // Update feature properties
        if (layer.feature && layer.feature.properties) {
            layer.feature.properties.isRoad = false;
            delete layer.feature.properties.roadName;
            delete layer.feature.properties.roadId;
            delete layer.feature.properties.roadConfidence;
        }
    });

    // Remove any OSM road layer
    if (osmRoadLayer) {
        map.removeLayer(osmRoadLayer);
        osmRoadLayer = null;
    }

    updateStatus(`Cleared ${roadCount} road parcels.`);
}

// Function to draw OSM roads without parcel analysis
async function drawOSMRoads() {
    const status = document.getElementById('status');
    updateStatus('Fetching OSM road data...');

    try {
        // Fetch OSM road data
        const osmData = await fetchOSMRoads();
        if (!osmData) {
            updateStatus('Failed to fetch OSM road data.');
            return;
        }

        // Convert to GeoJSON
        const osmGeoJSON = osmToGeoJSON(osmData);

        // Display the OSM roads on the map
        displayOSMRoads(osmGeoJSON);

        // Ensure the checkbox is checked if we just drew the lines
        const cb = document.getElementById('showOSMRoadLines');
        if (cb) cb.checked = true;

        updateStatus(`Displayed ${osmGeoJSON.features.length} roads from OpenStreetMap`);
    } catch (error) {
        console.error('Error drawing OSM roads:', error);
        updateStatus(`Error drawing OSM roads: ${error.message}`);
    }
}
