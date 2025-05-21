// Measurement tool variables
let measureMode = false;
let measureStartPoint = null;
let measureEndPoint = null;
let measureLine = null;
let measureMarkers = [];
let measureLabel = null;
let measureMouseMarker = null;
let measureMouseLine = null;
let allMeasurements = []; // Store all completed measurements

// Toggle measurement tool
function toggleMeasureTool() {
    measureMode = !measureMode;
    const measureButton = document.getElementById('measureButton');

    if (measureMode) {
        // Activate measurement mode
        measureButton.classList.add('active');
        map.getContainer().style.cursor = 'crosshair';

        // Disable other map click handlers temporarily
        if (parcelLayer) {
            parcelLayer.eachLayer(layer => {
                layer.off('click');
            });
        }

        // Add click handler for measurements
        map.on('click', handleMeasureClick);

        // Add mousemove handler for live preview
        map.on('mousemove', handleMeasureMouseMove);

        // Add escape key handler to cancel
        document.addEventListener('keydown', handleMeasureKeydown);

        // Show status message
        document.getElementById('status').textContent = 'Click on the map to start measuring';
    } else {
        // Deactivate measurement mode
        measureButton.classList.remove('active');
        map.getContainer().style.cursor = '';

        // Remove measurement handlers
        map.off('click', handleMeasureClick);
        map.off('mousemove', handleMeasureMouseMove);
        document.removeEventListener('keydown', handleMeasureKeydown);

        // Re-enable parcel click handlers
        if (parcelLayer) {
            parcelLayer.eachLayer(layer => {
                layer.on('click', (e) => {
                    // Clear any existing visualization first
                    clearRoadVisualization();

                    // Get the feature properties
                    const feature = layer.feature;

                    // Calculate road metrics
                    const metrics = calculateRoadMetrics(feature.geometry.coordinates);

                    // Draw visualization
                    drawRoadVisualization(metrics);

                    // Show info panel with metrics
                    showInfoPanel(feature, metrics);

                    // Store the current parcel coordinates for later use
                    currentParcelCoordinates = feature.geometry.coordinates;

                    // Handle road status
                    const parcelId = feature.properties.CESTICA_ID;
                    const isRoad = localStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';

                    // Update the checkbox state
                    document.getElementById('roadCheckbox').checked = isRoad;

                    // Update the parcel's appearance
                    layer.setStyle(isRoad ? roadStyle : normalStyle);

                    // Store the current parcel for checkbox updates
                    currentParcel = {
                        id: parcelId,
                        layer: layer,
                        isRoad: isRoad
                    };

                    // Show the info panel
                    document.getElementById('parcel-info-panel').classList.add('visible');

                    // Stop event propagation to prevent map click from clearing the visualization
                    L.DomEvent.stopPropagation(e);
                });
            });
        }

        // Clear any partial measurements
        clearMeasurement();

        // Clear status
        document.getElementById('status').textContent = '';
    }

    // Show/hide cancel measurements button based on whether we have measurements
    updateCancelMeasurementsButton();
}

// Handle measurement clicks
function handleMeasureClick(e) {
    if (!measureStartPoint) {
        // First click - set start point
        measureStartPoint = e.latlng;

        // Add marker for start point
        const startMarker = L.circleMarker(measureStartPoint, {
            radius: 5,
            className: 'measurement-marker'
        }).addTo(map);
        measureMarkers.push(startMarker);

        // Show status for second point
        document.getElementById('status').textContent = 'Click to set end point (ESC to cancel)';
    } else {
        // Second click - set end point
        measureEndPoint = e.latlng;

        // Add marker for end point
        const endMarker = L.circleMarker(measureEndPoint, {
            radius: 5,
            className: 'measurement-marker'
        }).addTo(map);
        measureMarkers.push(endMarker);

        // Calculate the distance
        const htrsStartPoint = wgs84ToHTRS96(measureStartPoint.lat, measureStartPoint.lng);
        const htrsEndPoint = wgs84ToHTRS96(measureEndPoint.lat, measureEndPoint.lng);

        // Calculate distance in meters (using HTRS96/TM coordinates)
        const dx = htrsEndPoint[0] - htrsStartPoint[0];
        const dy = htrsEndPoint[1] - htrsStartPoint[1];
        const distanceMeters = Math.sqrt(dx * dx + dy * dy);

        // Format the distance
        const formattedDistance = distanceMeters.toFixed(1);

        // Draw the final measurement line
        if (measureMouseLine) {
            map.removeLayer(measureMouseLine);
        }

        measureLine = L.polyline([measureStartPoint, measureEndPoint], {
            className: 'measurement-line',
            interactive: false
        }).addTo(map);

        // Add distance label at midpoint
        const midpoint = L.latLng(
            (measureStartPoint.lat + measureEndPoint.lat) / 2,
            (measureStartPoint.lng + measureEndPoint.lng) / 2
        );

        measureLabel = L.marker(midpoint, {
            icon: L.divIcon({
                className: 'measurement-label',
                html: `${formattedDistance} m`,
                iconSize: [80, 20],
                iconAnchor: [40, 10]
            }),
            interactive: false
        }).addTo(map);

        // Store completed measurement
        allMeasurements.push({
            line: measureLine,
            startMarker: measureMarkers[measureMarkers.length - 2],
            endMarker: measureMarkers[measureMarkers.length - 1],
            label: measureLabel
        });

        // Show/hide cancel measurements button
        updateCancelMeasurementsButton();

        // Reset for new measurement
        measureStartPoint = null;
        measureEndPoint = null;
        measureLine = null;
        measureLabel = null;
        measureMarkers = [];

        // Update status
        document.getElementById('status').textContent = 'Click to start a new measurement (ESC to clear)';
    }
}

// Clear current measurement (in-progress measurement)
function clearMeasurement() {
    // Remove all measurement objects from map
    if (measureLine) {
        map.removeLayer(measureLine);
        measureLine = null;
    }

    if (measureLabel) {
        map.removeLayer(measureLabel);
        measureLabel = null;
    }

    if (measureMouseLine) {
        map.removeLayer(measureMouseLine);
        measureMouseLine = null;
    }

    if (measureMouseMarker) {
        map.removeLayer(measureMouseMarker);
        measureMouseMarker = null;
    }

    // Remove all markers
    measureMarkers.forEach(marker => map.removeLayer(marker));
    measureMarkers = [];

    // Reset points
    measureStartPoint = null;
    measureEndPoint = null;
}

// Clear all measurements from the map
function clearAllMeasurements() {
    // Clear any in-progress measurement
    clearMeasurement();

    // Remove all completed measurements
    allMeasurements.forEach(measurement => {
        map.removeLayer(measurement.line);
        map.removeLayer(measurement.startMarker);
        map.removeLayer(measurement.endMarker);
        map.removeLayer(measurement.label);
    });

    // Clear the measurements array
    allMeasurements = [];

    // Update button visibility
    updateCancelMeasurementsButton();

    // Update status
    document.getElementById('status').textContent = 'All measurements cleared';
}

// Update the visibility of the Cancel Measurements button
function updateCancelMeasurementsButton() {
    const button = document.getElementById('clearMeasurementsButton');
    button.style.display = allMeasurements.length > 0 ? 'inline-block' : 'none';
}

// Handle mouse movement for measurement preview
function handleMeasureMouseMove(e) {
    if (measureStartPoint && !measureEndPoint) {
        // Remove previous preview if exists
        if (measureMouseLine) {
            map.removeLayer(measureMouseLine);
        }

        if (measureMouseMarker) {
            map.removeLayer(measureMouseMarker);
        }

        // Draw preview line
        measureMouseLine = L.polyline([measureStartPoint, e.latlng], {
            className: 'measurement-line',
            opacity: 0.7,
            interactive: false
        }).addTo(map);

        // Add temporary end marker
        measureMouseMarker = L.circleMarker(e.latlng, {
            radius: 5,
            className: 'measurement-marker',
            opacity: 0.7,
            interactive: false
        }).addTo(map);

        // Calculate and display the current distance
        const htrsStartPoint = wgs84ToHTRS96(measureStartPoint.lat, measureStartPoint.lng);
        const htrsMousePoint = wgs84ToHTRS96(e.latlng.lat, e.latlng.lng);

        const dx = htrsMousePoint[0] - htrsStartPoint[0];
        const dy = htrsMousePoint[1] - htrsStartPoint[1];
        const distanceMeters = Math.sqrt(dx * dx + dy * dy);

        // Format the distance
        const formattedDistance = distanceMeters.toFixed(1);

        // Update status with current measurement
        document.getElementById('status').textContent = `Distance: ${formattedDistance} m (click to set end point, ESC to cancel)`;
    }
}

// Handle keydown events for measurement tool
function handleMeasureKeydown(e) {
    if (e.key === 'Escape') {
        if (measureStartPoint || measureLine) {
            clearMeasurement();
            document.getElementById('status').textContent = 'Measurement cancelled. Click to start measuring.';

            if (!measureMode) {
                toggleMeasureTool();
            } else {
                measureStartPoint = null;
                measureEndPoint = null;
            }
        } else {
            // Exit measurement mode entirely
            toggleMeasureTool();
        }
    }
}
