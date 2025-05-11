// OSM Road Detection and Naming System
let osmRoadLayer = null;
let osmData = null;
let roadDetectionProgress = { current: 0, total: 0 };
const OSM_CACHE_KEY = 'osm_roads_cache';
const OSM_CACHE_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

// Function to fetch road data from OpenStreetMap using Overpass API
async function fetchOSMRoads() {
    const status = document.getElementById('status');
    status.textContent = 'Fetching road data from OpenStreetMap...';

    try {
        const bounds = map.getBounds();
        const south = bounds.getSouth();
        const west = bounds.getWest();
        const north = bounds.getNorth();
        const east = bounds.getEast();

        // Check cache first
        const cachedData = checkOSMCache(south, west, north, east);
        if (cachedData) {
            status.textContent = 'Using cached OSM road data';
            return cachedData;
        }

        // Overpass API query for roads with names
        const overpassQuery = `
            [out:json][timeout:60];
            (
                way[highway][name](${south},${west},${north},${east});
                way[highway~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|service)$"](${south},${west},${north},${east});
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

        status.textContent = `Fetched ${data.elements.length} roads from OpenStreetMap`;
        return data;
    } catch (error) {
        console.error('Error fetching OSM data:', error);
        status.textContent = `Error fetching OSM data: ${error.message}`;
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
    localStorage.setItem(OSM_CACHE_KEY, JSON.stringify(cacheItem));
}

// Function to check if valid cached data exists
function checkOSMCache(south, west, north, east) {
    try {
        const cachedItem = JSON.parse(localStorage.getItem(OSM_CACHE_KEY));
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
    if (osmRoadLayer) {
        map.removeLayer(osmRoadLayer);
    }
    osmRoadLayer = L.geoJSON(osmGeoJSON, {
        style: function (feature) {
            // Generate a random color for each LineString
            function getRandomColor() {
                // Pastel random color
                const hue = Math.floor(Math.random() * 360);
                return `hsl(${hue}, 70%, 60%)`;
            }
            return {
                color: getRandomColor(),
                weight: 3,
                opacity: 0.6
            };
        },
        onEachFeature: (feature, layer) => {
            const name = feature.properties.name || 'Unnamed Road';
            const type = feature.properties.highway;
            layer.bindTooltip(`${name} (${type})`);
        }
    }).addTo(map);
}

// Function to detect which parcels are roads based on OSM data
async function detectRoadsFromOSM() {
    if (!parcelLayer) {
        document.getElementById('status').textContent = 'No parcels loaded. Please refresh data first.';
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
            status.textContent = 'Failed to fetch OSM road data.';
            if (progressContainer) {
                progressContainer.style.display = 'none';
            }
            return;
        }

        // Convert to GeoJSON
        const osmGeoJSON = osmToGeoJSON(osmData);

        // Optional: Display the OSM roads on the map
        displayOSMRoads(osmGeoJSON);

        // Get visible parcels
        const parcels = parcelLayer.getLayers();
        const totalParcels = parcels.length;
        roadDetectionProgress = { current: 0, total: totalParcels };

        status.textContent = `Analyzing ${totalParcels} parcels...`;

        // Process parcels in chunks to avoid UI freezing
        await processRoadDetectionInChunks(parcels, osmGeoJSON);

        // Hide progress indicator
        if (progressContainer) {
            progressContainer.style.display = 'none';
        }
        status.textContent = `Road detection complete. Found road parcels and assigned names.`;

        // Update the parcel styles after detection
        updateParcelStyles();

    } catch (error) {
        console.error('Error in road detection:', error);
        status.textContent = `Error in road detection: ${error.message}`;
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

    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');

    for (let i = 0; i < totalParcels; i += CHUNK_SIZE) {
        const chunk = parcels.slice(i, i + CHUNK_SIZE);

        // Process this chunk
        for (const parcel of chunk) {
            try {
                await detectIfParcelIsRoad(parcel, osmGeoJSON);
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
            // Store road information in localStorage
            localStorage.setItem(`parcel_${parcelId}_isRoad`, 'true');
            localStorage.setItem(`parcel_${parcelId}_roadName`, bestRoadName || 'Unnamed Road');
            localStorage.setItem(`parcel_${parcelId}_roadId`, bestRoadId || '');
            localStorage.setItem(`parcel_${parcelId}_roadConfidence`, bestRoadConfidence.toString());

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
        const isRoad = localStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';

        if (isRoad) {
            layer.setStyle(roadStyle);

            // Get road name for tooltip
            const roadName = localStorage.getItem(`parcel_${parcelId}_roadName`) || 'Unnamed Road';

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

// Function to clear all detected roads
function clearDetectedRoads() {
    const status = document.getElementById('status');

    if (!parcelLayer) {
        status.textContent = 'No parcels to clear.';
        return;
    }

    // Count roads to clear
    let roadCount = 0;

    // Gather all localStorage keys related to roads
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
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
    keysToRemove.forEach(key => localStorage.removeItem(key));

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

    status.textContent = `Cleared ${roadCount} road parcels.`;
}

// Function to draw OSM roads without parcel analysis
async function drawOSMRoads() {
    const status = document.getElementById('status');
    status.textContent = 'Fetching OSM road data...';

    try {
        // Fetch OSM road data
        const osmData = await fetchOSMRoads();
        if (!osmData) {
            status.textContent = 'Failed to fetch OSM road data.';
            return;
        }

        // Convert to GeoJSON
        const osmGeoJSON = osmToGeoJSON(osmData);

        // Display the OSM roads on the map
        displayOSMRoads(osmGeoJSON);

        status.textContent = `Displayed ${osmGeoJSON.features.length} roads from OpenStreetMap`;
    } catch (error) {
        console.error('Error drawing OSM roads:', error);
        status.textContent = `Error drawing OSM roads: ${error.message}`;
    }
}
