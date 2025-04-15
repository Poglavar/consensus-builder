// Hide road info panel
function hideRoadInfoPanel() {
    document.getElementById('road-info-panel').style.display = 'none';
}

// Road drawing tool variables
let roadDrawingMode = false;
let roadPoints = [];
let roadWidth = 2; // Default width in meters
let roadCenterline = null;
let roadPolygon = null;
let roadPreviewLine = null;
let roadPreviewPolygon = null;
let roadAffectedParcels = [];
let roadMouseMarker = null;
let roadHasStarted = false;
let roadPreviewPolygonLayer = null;
let roadCenterlineLayer = null;
let roadPolygonLayer = null;
let roadMarkers = [];
let lastRoadMoveUpdate = 0;
let throttleDelay = 150; // milliseconds between updates

// Toggle road drawing tool
function toggleRoadDrawTool() {
    roadDrawingMode = !roadDrawingMode;
    const roadDrawButton = document.getElementById('roadDrawButton');
    const roadWidthSelect = document.getElementById('roadWidthSelect');
    const finishRoadButton = document.getElementById('finishRoadButton');
    const cancelRoadButton = document.getElementById('cancelRoadButton');

    if (roadDrawingMode) {
        // Activate road drawing mode
        roadDrawButton.classList.add('active');
        roadDrawButton.style.backgroundColor = '#dc3545';
        roadWidthSelect.style.display = 'inline-block';
        finishRoadButton.style.display = 'inline-block';
        cancelRoadButton.style.display = 'inline-block';
        map.getContainer().style.cursor = 'crosshair';

        // Disable other tools and interactivity
        if (measureMode) toggleMeasureTool();
        if (parcelLayer) {
            parcelLayer.eachLayer(layer => {
                layer.off('click');
            });
        }

        // Initialize road width from dropdown
        roadWidth = parseFloat(document.getElementById('roadWidthSelect').value);

        // Add click and mousemove handlers
        map.on('click', handleRoadClick);
        map.on('mousemove', handleRoadMouseMove);

        // Add keyboard handlers
        document.addEventListener('keydown', handleRoadKeydown);

        // Show the road info panel
        document.getElementById('road-info-panel').style.display = 'block';

        // Show status message
        document.getElementById('status').textContent = 'Click on the map to start drawing a road';
    } else {
        // Deactivate road drawing mode
        roadDrawButton.classList.remove('active');
        roadDrawButton.style.backgroundColor = '#007bff';
        roadWidthSelect.style.display = 'none';
        finishRoadButton.style.display = 'none';
        cancelRoadButton.style.display = 'none';
        map.getContainer().style.cursor = '';

        // Remove road drawing event handlers
        map.off('click', handleRoadClick);
        map.off('mousemove', handleRoadMouseMove);
        document.removeEventListener('keydown', handleRoadKeydown);

        // Re-enable parcel click handlers
        if (parcelLayer) {
            parcelLayer.eachLayer(layer => {
                layer.on('click', onParcelClick);
            });
        }

        // Reset road drawing variables
        resetRoadDrawing();

        // Hide the road info panel
        document.getElementById('road-info-panel').style.display = 'none';

        // Clear status
        document.getElementById('status').textContent = '';
    }
}

// Handle keyboard events during road drawing
function handleRoadKeydown(e) {
    // Prevent handling if we're in an input field
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
        return;
    }

    // Check for F key (finish road)
    if ((e.key === 'f' || e.key === 'F') && roadHasStarted && roadPoints.length >= 2) {
        e.preventDefault(); // Prevent browser default behavior
        finishRoadDrawing();
    }

    // Check for Escape key (cancel road)
    if (e.key === 'Escape') {
        e.preventDefault(); // Prevent browser default behavior
        cancelRoadDrawing();
    }
}

// Handle road width selection change
document.getElementById('roadWidthSelect').addEventListener('change', function () {
    roadWidth = parseFloat(this.value);
    if (roadHasStarted) {
        updateRoadPreview();
        updateRoadInfoPanel();
    }
});

// Handle road drawing clicks
function handleRoadClick(e) {
    const clickPoint = e.latlng;

    if (!roadHasStarted) {
        // First click - start the road
        roadPoints = [clickPoint];
        roadHasStarted = true;

        // Add marker for the starting point
        L.circleMarker(clickPoint, {
            radius: 5,
            color: 'green',
            fillColor: '#00ff00',
            fillOpacity: 1
        }).addTo(map);

        // Initialize road centerline
        roadCenterline = L.polyline([clickPoint], {
            color: 'green',
            weight: 3,
            dashArray: '5, 5',
            opacity: 0.7
        }).addTo(map);

        // Show status for next point
        document.getElementById('status').textContent = 'Click to add road points, "Finish" when done';
    } else {
        // Add another point to the road
        roadPoints.push(clickPoint);

        // Add marker for this point
        L.circleMarker(clickPoint, {
            radius: 5,
            color: 'green',
            fillColor: '#00ff00',
            fillOpacity: 1
        }).addTo(map);

        // Update the centerline
        roadCenterline.addLatLng(clickPoint);

        // Update the polygon - create rectangular segments and combine them
        try {
            // If we have only 2 points, create a single rectangle
            let roadSegmentPolygon;
            if (roadPoints.length === 2) {
                roadSegmentPolygon = createRectangularRoadSegment(roadPoints[0], roadPoints[1], roadWidth);
            } else {
                // For multiple segments, get the current segments and add a new one
                const lastSegment = createRectangularRoadSegment(
                    roadPoints[roadPoints.length - 2],
                    roadPoints[roadPoints.length - 1],
                    roadWidth
                );

                // Remove previous preview polygon if it exists
                if (roadPolygon) {
                    map.removeLayer(roadPolygon);
                }

                // Get the current road polygon
                roadSegmentPolygon = calculateRoadPolygon(roadPoints, roadWidth);
            }

            if (roadSegmentPolygon) {
                roadPolygon = L.polygon(roadSegmentPolygon, {
                    color: 'green',
                    weight: 2,
                    fillColor: 'green',
                    fillOpacity: 0.3
                }).addTo(map);

                // Find affected parcels
                findAffectedParcels(roadSegmentPolygon);
            }
        } catch (error) {
            console.error('Error creating road segment:', error);
        }
    }

    // Update road info panel
    updateRoadInfoPanel();
}

// Handle road mouse movement for preview
function handleRoadMouseMove(e) {
    if (!roadHasStarted || !roadPoints || roadPoints.length === 0) return;

    // Get current mouse position
    const mouseLatLng = e.latlng;

    // Display temporary line from last point to current mouse position
    if (roadPreviewLine) {
        roadPreviewLine.removeFrom(map);
    }

    // Create the latest centerline segment
    const latestRoadPoints = [...roadPoints, mouseLatLng];

    // Only try to calculate a road polygon if we have at least 2 points
    if (latestRoadPoints.length >= 2) {
        try {
            const tempRoadPolygon = calculateRoadPolygon(latestRoadPoints, roadWidth);

            // Only continue if we have a valid polygon
            if (tempRoadPolygon && tempRoadPolygon.length >= 3) {
                // Draw the new preview
                roadPreviewLine = L.polyline([roadPoints[roadPoints.length - 1], mouseLatLng], {
                    color: '#ff6600',
                    dashArray: '5, 10',
                    weight: 2
                }).addTo(map);

                if (roadPreviewPolygonLayer) {
                    roadPreviewPolygonLayer.removeFrom(map);
                }

                roadPreviewPolygonLayer = L.polygon(tempRoadPolygon, {
                    color: '#ff6600',
                    weight: 1,
                    fillColor: '#ff6600',
                    fillOpacity: 0.2
                }).addTo(map);

                // IMPORTANT: Always call findAffectedParcels without throttling
                // This ensures parcels are highlighted on every mouse move
                findAffectedParcels(tempRoadPolygon);
                lastRoadMoveUpdate = Date.now();

                // Update road info with preview metrics
                updateRoadInfoWithPreview(latestRoadPoints, tempRoadPolygon);
            } else {
                console.warn('Invalid road polygon for preview - cannot display polygon');
                // Clear any highlighted parcels when the polygon is invalid
                clearAffectedParcels();

                // Still show a simple preview line
                roadPreviewLine = L.polyline([roadPoints[roadPoints.length - 1], mouseLatLng], {
                    color: '#ff6600',
                    dashArray: '5, 10',
                    weight: 2
                }).addTo(map);
            }
        } catch (error) {
            console.error('Error in road preview calculation:', error);
            // Clear any highlighted parcels when there's an error
            clearAffectedParcels();

            // Still show a simple preview line
            roadPreviewLine = L.polyline([roadPoints[roadPoints.length - 1], mouseLatLng], {
                color: '#ff6600',
                dashArray: '5, 10',
                weight: 2
            }).addTo(map);
        }
    } else {
        // If we only have one point, just show a line to the mouse cursor
        roadPreviewLine = L.polyline([roadPoints[0], mouseLatLng], {
            color: '#ff6600',
            dashArray: '5, 10',
            weight: 2
        }).addTo(map);
    }
}

// Calculate road polygon from centerline using rectangular segments
function calculateRoadPolygon(points, width) {
    if (!points || points.length < 2 || !isFinite(width)) {
        console.warn('Invalid inputs to calculateRoadPolygon:', { pointsLength: points?.length, width });
        return null;
    }

    // If we only have two points, just return a single rectangle
    if (points.length === 2) {
        return createRectangularRoadSegment(points[0], points[1], width);
    }

    // Create individual rectangular segments for each pair of points
    let combinedPolygon = null;

    for (let i = 0; i < points.length - 1; i++) {
        const segment = createRectangularRoadSegment(points[i], points[i + 1], width);

        if (!segment) {
            console.warn(`Failed to create segment ${i}`);
            continue;
        }

        // For the first segment, initialize the combined polygon
        if (combinedPolygon === null) {
            combinedPolygon = segment;
        } else {
            // Combine with existing polygon
            combinedPolygon = combineRoadPolygons(combinedPolygon, segment);
        }

        // If combining failed, use just this segment
        if (!combinedPolygon) {
            console.error(`Failed to combine segment ${i}, reverting to single segment`);
            combinedPolygon = segment;
        }
    }

    return combinedPolygon;
}

// Helper function to check if a point is valid
function isValidPoint(point) {
    return point &&
        Array.isArray(point) &&
        point.length === 2 &&
        isFinite(point[0]) &&
        isFinite(point[1]);
}

// Helper function to ensure a polygon is closed (first and last points match)
function ensurePolygonIsClosed(coords) {
    if (!coords || coords.length < 3) return coords; // Can't close with fewer than 3 points

    const first = coords[0];
    const last = coords[coords.length - 1];

    // Check if first and last points are the same
    if (first[0] !== last[0] || first[1] !== last[1]) {
        // Make a deep copy to avoid modifying the original
        const newCoords = [...coords];
        // Add a copy of the first point at the end
        newCoords.push([...first]);
        return newCoords;
    }

    return coords; // Already closed
}

// Find parcels affected by the road
function findAffectedParcels(roadPolygon) {
    if (!roadPolygon || !parcelLayer) return;

    // Clear previously affected parcels
    if (roadAffectedParcels.length > 0) {
        parcelLayer.eachLayer(layer => {
            // Reset style for previously affected parcels
            if (roadAffectedParcels.some(p => p.id === layer.feature.properties.CESTICA_ID)) {
                const isRoad = localStorage.getItem(`parcel_${layer.feature.properties.CESTICA_ID}_isRoad`) === 'true';
                layer.setStyle(isRoad ? roadStyle : normalStyle);
            }
        });
    }

    roadAffectedParcels = [];

    // Create a turf polygon from the road polygon
    const roadLatLngs = roadPolygon.map(p => [p.lng, p.lat]);

    // Check if we have enough points to form a valid polygon
    if (roadLatLngs.length < 4) {
        // If we don't have enough points, create a small square around the points
        const center = roadLatLngs[0];
        const offset = 0.0001; // Small offset in degrees
        roadLatLngs.length = 0; // Clear the array
        roadLatLngs.push(
            [center[0] - offset, center[1] - offset],
            [center[0] + offset, center[1] - offset],
            [center[0] + offset, center[1] + offset],
            [center[0] - offset, center[1] + offset],
            [center[0] - offset, center[1] - offset] // Close the polygon
        );
    } else {
        // Ensure the polygon is closed
        const closedRoadLatLngs = ensurePolygonIsClosed(roadLatLngs);
        if (closedRoadLatLngs.length !== roadLatLngs.length) {
            roadLatLngs.length = 0;
            roadLatLngs.push(...closedRoadLatLngs);
        }
    }

    let turfRoadPolygon;
    try {
        turfRoadPolygon = turf.polygon([roadLatLngs]);
    } catch (error) {
        // Silently return without showing error modal during mouse movement
        return;
    }

    // Get current map bounds for filtering
    const mapBounds = map.getBounds();

    // Check each parcel for intersection, but only if visible in the current view
    parcelLayer.eachLayer(layer => {
        // Skip parcels outside the current map view for performance
        try {
            const layerBounds = layer.getBounds();
            if (!mapBounds.intersects(layerBounds)) {
                return; // Skip parcels outside view
            }
        } catch (e) {
            // Some layers might not have bounds, continue anyway
        }

        const parcelId = layer.feature.properties.CESTICA_ID;
        let parcelCoords = layer.feature.geometry.coordinates[0];

        // Skip parcels with invalid coordinates
        if (!parcelCoords || parcelCoords.length < 4) {
            return;
        }

        try {
            // Ensure the parcel polygon is closed
            const closedParcelCoords = ensurePolygonIsClosed(parcelCoords);

            // Create the turf polygon
            const turfParcelPolygon = turf.polygon([closedParcelCoords]);

            // Check if the polygons intersect
            if (turf.booleanIntersects(turfRoadPolygon, turfParcelPolygon)) {
                // Calculate intersection area without throttling
                let intersectionArea = 0;
                try {
                    const intersection = turf.intersect(turfRoadPolygon, turfParcelPolygon);
                    if (intersection) {
                        intersectionArea = turf.area(intersection);
                    }
                } catch (e) {
                    // Silent error handling for area calculation
                }

                // Add to affected parcels list
                roadAffectedParcels.push({
                    id: parcelId,
                    number: layer.feature.properties.BROJ_CESTICE,
                    area: intersectionArea,
                    layer: layer
                });

                // Highlight the affected parcel with a more visible style
                layer.setStyle({
                    fillColor: 'green',
                    fillOpacity: 0.6,  // Increased opacity for better visibility
                    color: 'green',
                    weight: 3          // Thicker border
                });

                // Bring to front to ensure visibility
                if (typeof layer.bringToFront === 'function') {
                    layer.bringToFront();
                }
            }
        } catch (error) {
            // Silent error handling
        }
    });

    // Always update UI with the parcels count
    const parcelsSection = document.getElementById('road-parcels');
    if (parcelsSection) {
        parcelsSection.innerHTML = roadAffectedParcels.length > 0
            ? `${roadAffectedParcels.length} parcels affected`
            : 'None';
    }
}

// Update road info panel with current metrics
function updateRoadInfoPanel() {
    // Check if road has started and panel exists
    if (!roadHasStarted) return;

    // Make sure the road info panel exists
    const roadInfoPanel = document.getElementById('road-info-panel');
    if (!roadInfoPanel || roadInfoPanel.style.display === 'none') {
        // The panel doesn't exist or is hidden, so make it visible
        if (roadInfoPanel) {
            roadInfoPanel.style.display = 'block';
        } else {
            console.error('Road info panel element not found');
            return; // Exit early if the panel doesn't exist
        }
    }

    // Only try to calculate metrics if we have at least 2 points
    if (roadPoints.length >= 2) {
        // Calculate metrics for the current road
        const roadPolygon = calculateRoadPolygon(roadPoints, roadWidth);
        if (roadPolygon) {
            updateRoadInfoWithPreview(roadPoints, roadPolygon);
        }
    } else {
        // For the initial point, just show basic info
        const roadLengthElement = document.getElementById('road-length');
        const roadAreaElement = document.getElementById('road-area');
        const parcelsSection = document.getElementById('road-parcels');

        if (roadLengthElement) roadLengthElement.textContent = '0 m';
        if (roadAreaElement) roadAreaElement.textContent = '0 m²';
        if (parcelsSection) parcelsSection.innerHTML = 'None';
    }
}

// Update road info with preview metrics
function updateRoadInfoWithPreview(points, polygon) {
    if (!points || points.length < 2) {
        // Basic initialization of the road info panel when not enough points
        const roadLengthElement = document.getElementById('road-length');
        const roadAreaElement = document.getElementById('road-area');

        if (roadLengthElement) roadLengthElement.textContent = '0 m';
        if (roadAreaElement) roadAreaElement.textContent = '0 m²';
        return;
    }

    try {
        // Calculate road length in meters
        let length = 0;
        const htrsPoints = [];

        // Convert and validate each point
        for (const p of points) {
            if (!p || !isFinite(p.lat) || !isFinite(p.lng)) {
                console.warn('Invalid point in updateRoadInfoWithPreview:', p);
                continue;
            }
            try {
                const htrsPoint = wgs84ToHTRS96(p.lat, p.lng);
                if (isValidPoint(htrsPoint)) {
                    htrsPoints.push(htrsPoint);
                }
            } catch (error) {
                console.error('Error converting point in updateRoadInfoWithPreview:', error);
            }
        }

        // Calculate length only if we have enough valid points
        if (htrsPoints.length >= 2) {
            for (let i = 0; i < htrsPoints.length - 1; i++) {
                const p1 = htrsPoints[i];
                const p2 = htrsPoints[i + 1];
                const dx = p2[0] - p1[0];
                const dy = p2[1] - p1[1];
                length += Math.sqrt(dx * dx + dy * dy);
            }
        } else {
            console.warn('Not enough valid points to calculate length');
            length = 0;
        }

        // Calculate road area
        let area = 0;
        if (polygon && polygon.length > 2) {
            try {
                // Convert polygon to turf polygon format
                const turfFormat = polygon.map(p => [p.lng, p.lat]);
                // Make sure it's a closed polygon
                const closedTurfFormat = ensurePolygonIsClosed(turfFormat);

                // Create the turf polygon
                const turfPolygon = turf.polygon([closedTurfFormat]);
                area = turf.area(turfPolygon);
            } catch (error) {
                console.error('Error calculating area in updateRoadInfoWithPreview:', error);
                area = 0;
            }
        }

        // Update info panel - safely access each element
        const roadLengthElement = document.getElementById('road-length');
        const roadAreaElement = document.getElementById('road-area');

        // Only update elements if they exist
        if (roadLengthElement) {
            roadLengthElement.textContent = `${length.toFixed(1)} m`;
        }

        if (roadAreaElement) {
            roadAreaElement.textContent = `${area.toFixed(1)} m²`;
        }
    } catch (error) {
        console.error('Error in updateRoadInfoWithPreview:', error);
    }
}

// Function to show polygon error details in a modal
function showPolygonErrorModal(error, polygon) {
    // Create modal if it doesn't exist
    let modal = document.getElementById('polygon-error-modal');

    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'polygon-error-modal';
        modal.style.cssText = `
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background-color: rgba(0,0,0,0.7);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 10000;
                `;

        document.body.appendChild(modal);
    }

    // Format polygon points for display
    const pointsTable = polygon.map((p, i) =>
        `<tr>
                    <td>${i}</td>
                    <td>${p.lat.toFixed(6)}</td>
                    <td>${p.lng.toFixed(6)}</td>
                </tr>`
    ).join('');

    // Diagnose common polygon issues
    let diagnosticMessages = [];

    // Check if polygon is closed
    if (polygon.length > 1) {
        const firstPoint = polygon[0];
        const lastPoint = polygon[polygon.length - 1];

        if (firstPoint.lat !== lastPoint.lat || firstPoint.lng !== lastPoint.lng) {
            diagnosticMessages.push(`Polygon is not closed: first point [${firstPoint.lat.toFixed(6)}, ${firstPoint.lng.toFixed(6)}] 
                        is different from last point [${lastPoint.lat.toFixed(6)}, ${lastPoint.lng.toFixed(6)}]`);
        }
    }

    // Check for minimum points
    if (polygon.length < 4) {
        diagnosticMessages.push(`Polygon has only ${polygon.length} points, minimum 4 required.`);
    }

    // Look for duplicate consecutive points
    for (let i = 0; i < polygon.length - 1; i++) {
        const p1 = polygon[i];
        const p2 = polygon[i + 1];

        if (p1.lat === p2.lat && p1.lng === p2.lng) {
            diagnosticMessages.push(`Duplicate consecutive points found at index ${i} and ${i + 1}`);
        }
    }

    // Create content
    modal.innerHTML = `
                <div style="
                    background-color: white;
                    padding: 20px;
                    border-radius: 5px;
                    max-width: 80%;
                    max-height: 80%;
                    overflow: auto;
                ">
                    <h2 style="color: #d9534f;">Polygon Error</h2>
                    <p><strong>Error:</strong> ${error.message}</p>
                    <p><strong>Polygon Information:</strong></p>
                    <p>Number of points: ${polygon.length}</p>
                    
                    ${diagnosticMessages.length > 0 ? `
                        <div style="margin: 15px 0; padding: 15px; background-color: #fff3cd; border-left: 4px solid #ffc107; border-radius: 4px;">
                            <h4 style="margin-top: 0; color: #856404;">Diagnostic Information</h4>
                            <ul style="margin-bottom: 0;">
                                ${diagnosticMessages.map(msg => `<li>${msg}</li>`).join('')}
                            </ul>
                        </div>
                    ` : ''}
                    
                    <div style="max-height: 300px; overflow-y: auto; margin-top: 15px;">
                        <table style="border-collapse: collapse; width: 100%;">
                            <thead>
                                <tr style="background-color: #f8f9fa;">
                                    <th style="padding: 8px; border: 1px solid #dee2e6; text-align: left;">Point #</th>
                                    <th style="padding: 8px; border: 1px solid #dee2e6; text-align: left;">Latitude</th>
                                    <th style="padding: 8px; border: 1px solid #dee2e6; text-align: left;">Longitude</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${pointsTable}
                            </tbody>
                        </table>
                    </div>
                    
                    <div style="margin-top: 20px; display: flex; justify-content: space-between;">
                        <button onclick="showPolygonOnMap(${JSON.stringify(polygon).replace(/"/g, '&quot;')});"
                                style="padding: 8px 16px; background-color: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer;">
                            Show on Map
                        </button>
                        <button onclick="document.getElementById('polygon-error-modal').remove();"
                                style="padding: 8px 16px; background-color: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer;">
                            Close
                        </button>
                    </div>
                </div>
            `;
}

// Function to visualize the problematic polygon on the map
function showPolygonOnMap(points) {
    // Clear any existing highlighted polygon
    if (window.errorPolygonLayer) {
        map.removeLayer(window.errorPolygonLayer);
    }

    if (window.errorPointsLayer) {
        map.removeLayer(window.errorPointsLayer);
    }

    // Create a polygon from the points
    window.errorPolygonLayer = L.polygon(points, {
        color: 'red',
        weight: 2,
        fillColor: 'red',
        fillOpacity: 0.2
    }).addTo(map);

    // Add markers for each point
    window.errorPointsLayer = L.featureGroup();

    points.forEach((point, index) => {
        const marker = L.circleMarker([point.lat, point.lng], {
            radius: 5,
            color: 'black',
            fillColor: index === 0 ? 'green' : (index === points.length - 1 ? 'red' : 'blue'),
            fillOpacity: 1,
            weight: 2
        }).bindTooltip(`Point ${index}: [${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}]`);

        window.errorPointsLayer.addLayer(marker);
    });

    window.errorPointsLayer.addTo(map);

    // Fit bounds to the polygon
    map.fitBounds(window.errorPolygonLayer.getBounds(), {
        padding: [50, 50]
    });

    // Close the modal
    document.getElementById('polygon-error-modal').remove();
}

// Update the road preview
function updateRoadPreview() {
    // Remove any existing preview
    if (roadPreviewPolygon) {
        map.removeLayer(roadPreviewPolygon);
        roadPreviewPolygon = null;
    }

    if (roadPoints.length < 2) return;

    // Calculate and draw road polygon
    const roadPolygonPoints = calculateRoadPolygon(roadPoints, roadWidth);
    if (roadPolygonPoints) {
        roadPreviewPolygon = L.polygon(roadPolygonPoints, {
            color: 'green',
            weight: 2,
            fillColor: 'green',
            fillOpacity: 0.3
        }).addTo(map);

        // Find affected parcels
        findAffectedParcels(roadPolygonPoints);
    }
}

// Function to finish road drawing
function finishRoadDrawing() {
    if (!roadHasStarted || roadPoints.length < 2) return;

    // Create the road polygon
    const roadPolygon = calculateRoadPolygon(roadPoints, roadWidth);

    // Find affected parcels
    const affectedParcels = roadAffectedParcels;

    if (affectedParcels.length === 0) {
        alert('No parcels affected by this road. Please try drawing the road again.');
        return;
    }

    // Update parcels and create road parcel
    updateParcelsWithRoad(roadPolygon, affectedParcels);

    // Clear all road drawing elements
    if (roadCenterline) {
        map.removeLayer(roadCenterline);
        roadCenterline = null;
    }

    if (roadPreviewLine) {
        map.removeLayer(roadPreviewLine);
        roadPreviewLine = null;
    }

    if (roadPolygon && typeof roadPolygon.removeFrom === 'function') {
        roadPolygon.removeFrom(map);
    }

    if (roadPreviewPolygonLayer) {
        roadPreviewPolygonLayer.removeFrom(map);
        roadPreviewPolygonLayer = null;
    }

    if (roadCenterlineLayer) {
        roadCenterlineLayer.removeFrom(map);
        roadCenterlineLayer = null;
    }

    // Remove all markers
    roadMarkers.forEach(marker => {
        map.removeLayer(marker);
    });
    roadMarkers = [];

    // Reset road drawing state
    roadPoints = [];
    roadHasStarted = false;

    // Remove mouse event handlers
    map.off('mousemove', handleRoadMouseMove);
    map.off('click', handleRoadClick);
    document.removeEventListener('keydown', handleRoadKeydown);

    // Reset cursor style
    map.getContainer().style.cursor = '';

    // Deactivate road drawing mode
    roadDrawingMode = false;
    const roadDrawButton = document.getElementById('roadDrawButton');
    const roadWidthSelect = document.getElementById('roadWidthSelect');
    const finishRoadButton = document.getElementById('finishRoadButton');
    const cancelRoadButton = document.getElementById('cancelRoadButton');

    // Reset button styles
    roadDrawButton.classList.remove('active');
    roadDrawButton.style.backgroundColor = '#007bff';
    roadWidthSelect.style.display = 'none';
    finishRoadButton.style.display = 'none';
    cancelRoadButton.style.display = 'none';

    // Hide the road info panel
    const roadInfoPanel = document.getElementById('road-info-panel');
    if (roadInfoPanel) {
        roadInfoPanel.style.display = 'none';
    }

    // Re-enable parcel selection
    if (parcelLayer) {
        parcelLayer.eachLayer(layer => {
            layer.on('click', onParcelClick);
        });
    }

    // Show success message
    document.getElementById('status').textContent = 'Road creation complete';
}

// Cancel road drawing
function cancelRoadDrawing() {
    resetRoadDrawing();
    toggleRoadDrawTool();
}

// Reset road drawing state
function resetRoadDrawing(hidePanel = true) {
    // Clear road points
    roadPoints = [];
    roadHasStarted = false;

    // Remove markers and lines
    if (roadCenterline) {
        map.removeLayer(roadCenterline);
        roadCenterline = null;
    }

    if (roadPreviewLine) {
        map.removeLayer(roadPreviewLine);
        roadPreviewLine = null;
    }

    if (roadPreviewPolygon) {
        map.removeLayer(roadPreviewPolygon);
        roadPreviewPolygon = null;
    }

    if (roadMouseMarker) {
        map.removeLayer(roadMouseMarker);
        roadMouseMarker = null;
    }

    // Reset affected parcels
    if (roadAffectedParcels.length > 0 && parcelLayer) {
        parcelLayer.eachLayer(layer => {
            // Reset style for affected parcels
            if (roadAffectedParcels.some(p => p.id === layer.feature.properties.CESTICA_ID)) {
                const isRoad = localStorage.getItem(`parcel_${layer.feature.properties.CESTICA_ID}_isRoad`) === 'true';
                layer.setStyle(isRoad ? roadStyle : normalStyle);
            }
        });
    }

    roadAffectedParcels = [];

    // Hide road info panel if requested
    if (hidePanel) {
        document.getElementById('road-info-panel').style.display = 'none';
    }
}

// Add a helper function to clear affected parcels
function clearAffectedParcels() {
    if (roadAffectedParcels.length > 0) {
        parcelLayer.eachLayer(layer => {
            // Reset style for previously affected parcels
            if (roadAffectedParcels.some(p => p.id === layer.feature.properties.CESTICA_ID)) {
                const isRoad = localStorage.getItem(`parcel_${layer.feature.properties.CESTICA_ID}_isRoad`) === 'true';
                layer.setStyle(isRoad ? roadStyle : normalStyle);
            }
        });
    }
    roadAffectedParcels = [];
}

// Create a rectangular segment between two road points
function createRectangularRoadSegment(point1, point2, width) {
    // Validate input
    if (!point1 || !point2 || !isFinite(width) || width <= 0) {
        console.warn('Invalid inputs to createRectangularRoadSegment');
        return null;
    }

    if (!isFinite(point1.lat) || !isFinite(point1.lng) ||
        !isFinite(point2.lat) || !isFinite(point2.lng)) {
        console.warn('Invalid coordinates in createRectangularRoadSegment');
        return null;
    }

    // Convert to HTRS96/TM for accurate distance calculations
    const htrsPoint1 = wgs84ToHTRS96(point1.lat, point1.lng);
    const htrsPoint2 = wgs84ToHTRS96(point2.lat, point2.lng);

    // Validate converted points
    if (!isValidPoint(htrsPoint1) || !isValidPoint(htrsPoint2)) {
        console.warn('Invalid HTRS points in createRectangularRoadSegment');
        return null;
    }

    // Calculate segment direction
    const dx = htrsPoint2[0] - htrsPoint1[0];
    const dy = htrsPoint2[1] - htrsPoint1[1];
    const length = Math.sqrt(dx * dx + dy * dy);

    // Skip if segment has near-zero length
    if (length < 0.001) {
        // Use a minimum segment length to avoid zero-length segments
        // Instead of just returning null, create a small circle around the point
        const minLength = 0.1; // 10cm minimum
        // Create a point offset in a random direction if points are too close
        const angle = Math.random() * Math.PI * 2; // Random angle
        const offsetX = Math.cos(angle) * minLength;
        const offsetY = Math.sin(angle) * minLength;

        // Create new point2 with the offset
        const newHtrsPoint2 = [htrsPoint1[0] + offsetX, htrsPoint1[1] + offsetY];

        // Recalculate direction with the new point
        const newDx = newHtrsPoint2[0] - htrsPoint1[0];
        const newDy = newHtrsPoint2[1] - htrsPoint1[1];
        const newLength = Math.sqrt(newDx * newDx + newDy * newDy);

        // Calculate normalized perpendicular vector
        const perpX = -newDy / newLength;
        const perpY = newDx / newLength;

        // Rest of the function is the same, just using the new values
        const halfWidth = width / 2;

        // Calculate the 4 corners of the rectangle
        const corners = [
            [htrsPoint1[0] + perpX * halfWidth, htrsPoint1[1] + perpY * halfWidth], // top-left
            [newHtrsPoint2[0] + perpX * halfWidth, newHtrsPoint2[1] + perpY * halfWidth], // top-right
            [newHtrsPoint2[0] - perpX * halfWidth, newHtrsPoint2[1] - perpY * halfWidth], // bottom-right
            [htrsPoint1[0] - perpX * halfWidth, htrsPoint1[1] - perpY * halfWidth], // bottom-left
            [htrsPoint1[0] + perpX * halfWidth, htrsPoint1[1] + perpY * halfWidth]  // close polygon - back to top-left
        ];

        // Convert back to WGS84
        const wgsCorners = [];
        for (const corner of corners) {
            const [lat, lng] = htrs96ToWGS84(corner[0], corner[1]);
            if (isFinite(lat) && isFinite(lng)) {
                wgsCorners.push(L.latLng(lat, lng));
            }
        }

        // Check if we have enough points for a valid polygon
        if (wgsCorners.length < 4) {
            console.warn('Not enough valid corners for rectangle');
            return null;
        }

        return wgsCorners;
    }

    // Calculate perpendicular vector (normalized)
    const perpX = -dy / length;
    const perpY = dx / length;

    // Calculate half-width
    const halfWidth = width / 2;

    // Calculate the 4 corners of the rectangle
    const corners = [
        [htrsPoint1[0] + perpX * halfWidth, htrsPoint1[1] + perpY * halfWidth], // top-left
        [htrsPoint2[0] + perpX * halfWidth, htrsPoint2[1] + perpY * halfWidth], // top-right
        [htrsPoint2[0] - perpX * halfWidth, htrsPoint2[1] - perpY * halfWidth], // bottom-right
        [htrsPoint1[0] - perpX * halfWidth, htrsPoint1[1] - perpY * halfWidth], // bottom-left
        [htrsPoint1[0] + perpX * halfWidth, htrsPoint1[1] + perpY * halfWidth]  // close polygon - back to top-left
    ];

    // Convert back to WGS84
    const wgsCorners = [];
    for (const corner of corners) {
        const [lat, lng] = htrs96ToWGS84(corner[0], corner[1]);
        if (isFinite(lat) && isFinite(lng)) {
            wgsCorners.push(L.latLng(lat, lng));
        } else {
            console.warn('Invalid conversion result:', lat, lng);
        }
    }

    // Check if we have enough points for a valid polygon
    if (wgsCorners.length < 4) {
        console.warn('Not enough valid corners for rectangle');
        return null;
    }

    return wgsCorners;
}

// Combine two road polygons using Turf's union operation
function combineRoadPolygons(polygon1, polygon2) {
    // Validate inputs
    if (!polygon1 || !polygon2) {
        if (!polygon1 && polygon2) return polygon2;
        if (polygon1 && !polygon2) return polygon1;
        return null;
    }

    try {
        // Convert Leaflet latLng objects to Turf format [lng, lat]
        const formatForTurf = (poly) => {
            return poly.map(p => [p.lng, p.lat]);
        };

        // Format and close both polygons
        const turfFormat1 = ensurePolygonIsClosed(formatForTurf(polygon1));
        const turfFormat2 = ensurePolygonIsClosed(formatForTurf(polygon2));

        // Create Turf polygons
        const turfPoly1 = turf.polygon([turfFormat1]);
        const turfPoly2 = turf.polygon([turfFormat2]);

        // Perform the union operation
        const combined = turf.union(turfPoly1, turfPoly2);

        // Extract coordinates from the result
        let resultCoords;
        if (combined.geometry.type === 'Polygon') {
            // Simple case - we got a single polygon back
            resultCoords = combined.geometry.coordinates[0];
        } else if (combined.geometry.type === 'MultiPolygon') {
            // We got multiple polygons - use the largest one
            let maxArea = 0;
            let largestPolygon = null;

            for (const polygon of combined.geometry.coordinates) {
                const poly = turf.polygon([polygon[0]]);
                const area = turf.area(poly);

                if (area > maxArea) {
                    maxArea = area;
                    largestPolygon = polygon[0];
                }
            }

            resultCoords = largestPolygon;
        } else {
            console.error('Unexpected geometry type from union:', combined.geometry.type);
            return null;
        }

        // Convert back to Leaflet format
        return resultCoords.map(coord => L.latLng(coord[1], coord[0]));
    } catch (error) {
        console.error('Error combining road polygons:', error);
        // Fall back to the most recent polygon if there's an error
        return polygon2 || polygon1;
    }
}

// Find a suitable base parcel number for the road
function findRoadBaseParcelNumber(affectedParcels) {
    // Sort parcels by number to ensure consistent ordering
    const sortedParcels = [...affectedParcels].sort((a, b) => a.number.localeCompare(b.number));

    // Find the first parcel number without a slash
    for (const parcel of sortedParcels) {
        if (!parcel.number.includes('/')) {
            return parcel.number;
        }
    }

    // If all parcels have slashes, use the first parcel's number and add /1
    return sortedParcels[0]?.number + '/1';
}

// Function to split a polygon into multiple polygons if it has holes or is disconnected
function splitPolygonIfNeeded(polygon) {
    try {
        // Convert to Turf format
        const turfFormat = polygon.map(p => [p.lng, p.lat]);
        const closedPolygon = ensurePolygonIsClosed(turfFormat);

        // Create a Turf polygon
        const turfPoly = turf.polygon([closedPolygon]);

        // Check if the polygon has holes or is disconnected
        const holes = turf.getHoles(turfPoly);

        if (holes && holes.length > 0) {
            // The polygon has holes, we need to handle each part separately
            const parts = [];

            // Add the main polygon
            parts.push(polygon);

            // Add each hole as a separate polygon
            for (const hole of holes) {
                parts.push(hole.map(p => L.latLng(p[1], p[0])));
            }

            return parts;
        }

        // No holes, return the original polygon
        return [polygon];
    } catch (error) {
        console.error('Error splitting polygon:', error);
        return [polygon]; // Return original polygon if there's an error
    }
}

// Function to subtract road polygon from parcel polygon
function subtractRoadFromParcel(parcelPolygon, roadPolygon) {
    try {
        // Convert polygons to Turf format
        const parcelTurf = turf.polygon([ensurePolygonIsClosed(parcelPolygon.map(p => [p.lng, p.lat]))]);
        const roadTurf = turf.polygon([ensurePolygonIsClosed(roadPolygon.map(p => [p.lng, p.lat]))]);

        // Perform the difference operation
        const difference = turf.difference(parcelTurf, roadTurf);

        if (!difference) {
            // If no difference, return empty array
            return [];
        }

        // Convert back to Leaflet format
        if (difference.geometry.type === 'Polygon') {
            return [difference.geometry.coordinates[0].map(p => L.latLng(p[1], p[0]))];
        } else if (difference.geometry.type === 'MultiPolygon') {
            return difference.geometry.coordinates.map(polygon =>
                polygon[0].map(p => L.latLng(p[1], p[0]))
            );
        }

        return [];
    } catch (error) {
        console.error('Error subtracting road from parcel:', error);
        return [];
    }
}

// Function to update parcel numbers and split parcels
function updateParcelsWithRoad(roadPolygon, affectedParcels) {
    if (!roadPolygon || !affectedParcels || affectedParcels.length === 0) {
        console.error('Invalid inputs to updateParcelsWithRoad');
        return;
    }

    // Find base parcel number for the road
    const roadBaseNumber = findRoadBaseParcelNumber(affectedParcels);
    const roadParcelNumber = roadBaseNumber + '/1';

    // Create the road parcel feature
    const roadFeature = {
        type: 'Feature',
        properties: {
            CESTICA_ID: 'road_' + roadParcelNumber.replace(/\//g, '_'),
            BROJ_CESTICE: roadParcelNumber,
            isRoad: true,
            calculatedArea: calculateAreaFromLatLngPolygon(roadPolygon)
        },
        geometry: {
            type: 'Polygon',
            coordinates: [roadPolygon.map(p => [p.lng, p.lat])]
        }
    };

    // Process each affected parcel
    for (const parcel of affectedParcels) {
        const originalNumber = parcel.number;
        const parcelLayer = parcel.layer;
        const parcelId = parcel.id;

        // Skip if we can't find the layer
        if (!parcelLayer || !parcelLayer.feature) {
            console.warn(`Skipping parcel ${parcelId} - layer not found or invalid`);
            continue;
        }

        try {
            // Get the parcel's polygon
            const parcelCoords = parcelLayer.feature.geometry.coordinates[0];
            const parcelPolygon = parcelCoords.map(p => L.latLng(p[1], p[0]));

            // Prepare Turf.js geometries for operations
            const parcelCoordsTurf = ensurePolygonIsClosed(parcelCoords);
            const roadCoordsTurf = ensurePolygonIsClosed(roadPolygon.map(p => [p.lng, p.lat]));

            // Create Turf polygons
            const parcelTurf = turf.polygon([parcelCoordsTurf]);
            const roadTurf = turf.polygon([roadCoordsTurf]);

            // Calculate the difference (parcel minus road)
            const difference = turf.difference(parcelTurf, roadTurf);

            if (!difference) {
                // Parcel is completely covered by the road - remove it
                map.removeLayer(parcelLayer);
                console.log(`Parcel ${parcelId} completely covered by road - removed`);
                continue;
            }

            if (difference.geometry.type === 'Polygon') {
                // Simple case - one polygon remaining
                const remainingCoords = difference.geometry.coordinates[0];

                // Update the existing parcel's geometry
                parcelLayer.feature.geometry.coordinates[0] = remainingCoords;
                parcelLayer.setLatLngs(remainingCoords.map(p => [p[1], p[0]])); // Convert to [lat, lng] for Leaflet

                // Recalculate area
                parcelLayer.feature.properties.calculatedArea = turf.area(turf.polygon([remainingCoords]));

            } else if (difference.geometry.type === 'MultiPolygon') {
                // Complex case - multiple polygons after splitting
                const polygons = difference.geometry.coordinates;

                // Sort polygons by area (largest first)
                const polygonsWithArea = polygons.map(poly => ({
                    polygon: poly[0],
                    area: turf.area(turf.polygon([poly[0]]))
                }));

                // Sort by area descending
                polygonsWithArea.sort((a, b) => b.area - a.area);

                // Update the original parcel with the largest part
                const largestPart = polygonsWithArea[0].polygon;
                parcelLayer.feature.geometry.coordinates[0] = largestPart;
                parcelLayer.setLatLngs(largestPart.map(p => [p[1], p[0]]));
                parcelLayer.feature.properties.calculatedArea = polygonsWithArea[0].area;

                // Create new parcels for the additional parts
                for (let i = 1; i < polygonsWithArea.length; i++) {
                    const newNumber = originalNumber + '/' + (i + 1);
                    const newId = parcelId + '_' + i;
                    const partPolygon = polygonsWithArea[i].polygon;

                    // Create new feature for the split part
                    const newFeature = {
                        type: 'Feature',
                        properties: {
                            ...parcelLayer.feature.properties,
                            CESTICA_ID: newId,
                            BROJ_CESTICE: newNumber,
                            calculatedArea: polygonsWithArea[i].area
                        },
                        geometry: {
                            type: 'Polygon',
                            coordinates: [partPolygon]
                        }
                    };

                    // Add the new parcel to the map in the same layer as other parcels
                    const newParcelLayer = L.geoJSON(newFeature, {
                        style: normalStyle,
                        onEachFeature: onEachFeature // Use the same handler as other parcels
                    }).addTo(map);

                    console.log(`Created split parcel ${newNumber} from ${originalNumber}`);
                }
            }
        } catch (error) {
            console.error(`Error processing parcel ${parcelId}:`, error);
        }
    }

    // Add the road parcel to the map in the same layer as other parcels
    try {
        // Create and add the road parcel to the parcel layer
        const newRoadLayer = L.geoJSON(roadFeature, {
            style: roadStyle,
            onEachFeature: onEachFeature // Use the same handler as other parcels
        }).addTo(map);

        // Mark this parcel as a road in localStorage
        localStorage.setItem(`parcel_${roadFeature.properties.CESTICA_ID}_isRoad`, 'true');

        console.log(`Created road parcel ${roadParcelNumber}`);
    } catch (error) {
        console.error('Error creating road parcel:', error);
    }
}

// Helper function to calculate area from a Leaflet polygon
function calculateAreaFromLatLngPolygon(latLngPolygon) {
    // Convert to HTRS96/TM coordinates
    const htrsCoords = latLngPolygon.map(point => wgs84ToHTRS96(point.lat, point.lng));

    // Create closed polygon
    const closedCoords = [...htrsCoords];
    if (htrsCoords.length > 0 &&
        (htrsCoords[0][0] !== htrsCoords[htrsCoords.length - 1][0] ||
            htrsCoords[0][1] !== htrsCoords[htrsCoords.length - 1][1])) {
        closedCoords.push(htrsCoords[0]);
    }

    // Calculate area
    let area = 0;
    for (let i = 0; i < closedCoords.length - 1; i++) {
        area += closedCoords[i][0] * closedCoords[i + 1][1] - closedCoords[i + 1][0] * closedCoords[i][1];
    }

    return Math.abs(area / 2);
}

