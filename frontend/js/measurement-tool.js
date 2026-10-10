// Measurement tool variables
if (typeof window.measureMode === 'undefined') window.measureMode = false;
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
    window.measureMode = !window.measureMode;
    const measureButton = document.getElementById('measureButton');
    const mapContainer = map.getContainer();

    if (window.measureMode) {
        // Activate measurement mode
        measureButton.classList.add('active-black-border');
        mapContainer.classList.add('crosshairs-cursor');
        map.getContainer().style.cursor = 'crosshair';

        // Add click handler for measurements
        map.on('click', handleMeasureClick);

        // Add mousemove handler for live preview
        map.on('mousemove', handleMeasureMouseMove);

        // Add escape key handler to cancel
        document.addEventListener('keydown', handleMeasureKeydown);

        // Show status message
        updateStatus('Click on the map to start measuring');
    } else {
        // Deactivate measurement mode
        measureButton.classList.remove('active-black-border');
        mapContainer.classList.remove('crosshairs-cursor');
        map.getContainer().style.cursor = '';

        // Remove measurement handlers
        map.off('click', handleMeasureClick);
        map.off('mousemove', handleMeasureMouseMove);
        document.removeEventListener('keydown', handleMeasureKeydown);

        // Clear any partial measurements
        clearMeasurement();

        // Clear status
        updateStatus('');
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
        updateStatus('Click to set end point (ESC to cancel)');
    } else {
        // Second click - set end point
        measureEndPoint = e.latlng;

        // Add marker for end point
        const endMarker = L.circleMarker(measureEndPoint, {
            radius: 5,
            className: 'measurement-marker'
        }).addTo(map);
        measureMarkers.push(endMarker);

        // The distance on the ellipsoid: measuring needs no projection (projections.md §2), so it
        // is the same whichever city is active
        const distanceMeters = window.__metricFrame.geodesicDistance(
            [measureStartPoint.lng, measureStartPoint.lat],
            [measureEndPoint.lng, measureEndPoint.lat]
        );

        // Format the distance: a measuring tool keeps its decimetre in every language
        // (frontend-measurement-tool.test.js runs this file without js/format.js)
        const formattedDistance = typeof CbFormat !== 'undefined'
            ? CbFormat.formatLength(distanceMeters, { maxFractionDigits: 1, minFractionDigits: 1 })
            : `${distanceMeters.toFixed(1)} m`;

        // Draw the final measurement line
        if (measureMouseLine) {
            map.removeLayer(measureMouseLine);
            measureMouseLine = null;
        }
        if (measureMouseMarker) {
            map.removeLayer(measureMouseMarker);
            measureMouseMarker = null;
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
                html: formattedDistance,
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
        updateStatus('Click to start a new measurement (ESC to clear)');
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
    updateStatus('All measurements cleared');
}

// Update the visibility of the Cancel Measurements button
function updateCancelMeasurementsButton() {
    const button = document.getElementById('clearMeasurementsButton');
    button.style.display = allMeasurements.length > 0 ? '' : 'none';
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

        // Calculate and display the current distance, on the ellipsoid
        const distanceMeters = window.__metricFrame.geodesicDistance(
            [measureStartPoint.lng, measureStartPoint.lat],
            [e.latlng.lng, e.latlng.lat]
        );

        // Format the distance: a measuring tool keeps its decimetre in every language
        // (frontend-measurement-tool.test.js runs this file without js/format.js)
        const formattedDistance = typeof CbFormat !== 'undefined'
            ? CbFormat.formatLength(distanceMeters, { maxFractionDigits: 1, minFractionDigits: 1 })
            : `${distanceMeters.toFixed(1)} m`;

        // Update status with current measurement
        updateStatus(`Distance: ${formattedDistance} (click to set end point, ESC to cancel)`);
    }
}

// Handle keydown events for measurement tool
function handleMeasureKeydown(e) {
    if (e.key === 'Escape') {
        // One Escape, one step: the Tools sheet Measure was started from stays open for the next.
        e.preventDefault();
        if (measureStartPoint || measureLine) {
            clearMeasurement();
            updateStatus('Measurement cancelled. Click to start measuring.');

            if (!window.measureMode) {
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
