// Animation variables
let animationMap = null;
let animationCurrentStep = 0;
let animationSteps = [];
let animationTimer = null;
let animationSpeed = 1000; // ms between steps
let animationPlaying = false;

// Animation layers
let animParcelLayer = null;
let animBoundaryPointsLayer = null;
let animSamplePointsLayer = null;
let animOppositePointsLayer = null;
let animMidpointsLayer = null;
let animSearchLinesLayer = null;
let animWidthLinesLayer = null;
let animCenterlineSegmentsLayer = null;
let animFinalCenterlineLayer = null;

// Add function to show animation modal for current parcel
function showAnimationModalForCurrentParcel() {
    if (currentParcelCoordinates) {
        showAnimationModal(currentParcelCoordinates);
    }
}

// Show the animation modal
function showAnimationModal(coordinates) {
    // Create modal elements properly instead of using innerHTML
    if (!document.getElementById('animation-modal')) {
        const modalDiv = document.createElement('div');
        modalDiv.id = 'animation-modal';
        modalDiv.style.position = 'fixed';
        modalDiv.style.top = '0';
        modalDiv.style.left = '0';
        modalDiv.style.width = '100%';
        modalDiv.style.height = '100%';
        modalDiv.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
        modalDiv.style.zIndex = '1000';
        modalDiv.style.display = 'flex';
        modalDiv.style.alignItems = 'center';
        modalDiv.style.justifyContent = 'center';

        const container = document.createElement('div');
        container.id = 'animation-container';
        container.style.backgroundColor = 'white';
        container.style.padding = '20px';
        container.style.borderRadius = '8px';
        container.style.maxWidth = '80%';
        container.style.maxHeight = '80%';
        container.style.display = 'flex';
        container.style.flexDirection = 'column';

        container.innerHTML = `
            <div id="animation-header">
                <h2>Centerline Algorithm Visualization</h2>
                <button id="animation-close" type="button" class="close-circle-btn close-circle-btn--lg" aria-label="Close animation modal">×</button>
            </div>
            <div id="animation-map"></div>
            <div id="animation-controls" style="display: flex; flex-direction: column; align-items: center; padding: 15px;">
                <div id="animation-step" style="text-align: center; margin-bottom: 15px; min-height: 20px;">Step 1: Loading parcel geometry</div>
                <div id="animation-buttons" style="display: flex; gap: 10px;">
                    <button class="animation-button" id="btn-prev" disabled>Previous</button>
                    <button class="animation-button" id="btn-next">Next</button>
                    <button class="animation-button" id="btn-play">Play</button>
                </div>
            </div>
        `;

        modalDiv.appendChild(container);
        document.body.appendChild(modalDiv);

        // Add event listeners
        document.getElementById('animation-close').addEventListener('click', closeAnimationModal);
        document.getElementById('btn-prev').addEventListener('click', prevAnimationStep);
        document.getElementById('btn-next').addEventListener('click', nextAnimationStep);
        document.getElementById('btn-play').addEventListener('click', togglePlayAnimation);

        // Close modal when clicking outside the container
        modalDiv.addEventListener('click', (e) => {
            if (e.target === modalDiv) {
                closeAnimationModal();
            }
        });
    }

    // Reset animation state
    animationCurrentStep = 0;
    animationSteps = [];
    clearAnimationLayers();

    // Set up the animation steps based on the parcel
    setupAnimationSteps(coordinates);

    // Initialize the animation map if needed
    if (!animationMap) {
        animationMap = L.map('animation-map', {
            zoomControl: true,
            dragging: true,
            scrollWheelZoom: true
        });

        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '© OpenStreetMap contributors'
        }).addTo(animationMap);
    }

    // Update buttons
    updateAnimationButtons();

    // Start with the first step
    renderAnimationStep(0);
}

// Close the animation modal
function closeAnimationModal() {
    // Stop any ongoing animation
    stopPlayAnimation();

    // Remove the map instance properly
    if (animationMap) {
        clearAnimationLayers();
        animationMap.remove();
        animationMap = null;
    }

    // Remove the modal from DOM
    const modal = document.getElementById('animation-modal');
    if (modal) {
        // Remove all event listeners
        const closeBtn = document.getElementById('animation-close');
        const prevBtn = document.getElementById('btn-prev');
        const nextBtn = document.getElementById('btn-next');
        const playBtn = document.getElementById('btn-play');

        if (closeBtn) closeBtn.removeEventListener('click', closeAnimationModal);
        if (prevBtn) prevBtn.removeEventListener('click', prevAnimationStep);
        if (nextBtn) nextBtn.removeEventListener('click', nextAnimationStep);
        if (playBtn) playBtn.removeEventListener('click', togglePlayAnimation);

        modal.removeEventListener('click', closeAnimationModal);

        // Remove the modal
        modal.remove();
    }

    // Force a reflow of the main map
    if (map) {
        map.invalidateSize();
    }
}

// Clear all animation layers
function clearAnimationLayers() {
    if (!animationMap) return;  // Don't proceed if map doesn't exist

    // Remove each layer if it exists
    const layers = [
        animParcelLayer,
        animBoundaryPointsLayer,
        animSamplePointsLayer,
        animOppositePointsLayer,
        animMidpointsLayer,
        animSearchLinesLayer,
        animWidthLinesLayer,
        animCenterlineSegmentsLayer,
        animFinalCenterlineLayer
    ];

    layers.forEach(layer => {
        if (layer) {
            animationMap.removeLayer(layer);
        }
    });

    // Reset all layer variables
    animParcelLayer = null;
    animBoundaryPointsLayer = null;
    animSamplePointsLayer = null;
    animOppositePointsLayer = null;
    animMidpointsLayer = null;
    animSearchLinesLayer = null;
    animWidthLinesLayer = null;
    animCenterlineSegmentsLayer = null;
    animFinalCenterlineLayer = null;
}

// Set up the animation steps
function getExteriorRingForAnimation(coords) {
    if (!Array.isArray(coords)) return [];
    if (Array.isArray(coords[0]) && typeof coords[0][0] === 'number') {
        return coords; // already a ring
    }
    if (Array.isArray(coords[0]) && Array.isArray(coords[0][0]) && typeof coords[0][0][0] === 'number') {
        return coords[0]; // Polygon outer ring
    }
    if (Array.isArray(coords[0]) && Array.isArray(coords[0][0]) && Array.isArray(coords[0][0][0]) && typeof coords[0][0][0][0] === 'number') {
        return coords[0][0]; // MultiPolygon first polygon outer ring
    }
    return [];
}

function setupAnimationSteps(coordinates) {
    // Normalize coordinates to an exterior ring [ [lng,lat], ... ]
    const polygonCoords = getExteriorRingForAnimation(coordinates);
    if (!Array.isArray(polygonCoords) || polygonCoords.length < 3) {
        return;
    }

    // Convert to HTRS96/TM for calculations
    const htrsPolygonCoords = polygonCoords.map(coord => {
        return wgs84ToHTRS96(coord[1], coord[0]);
    });

    // Calculate the centroid
    let centroidX = 0, centroidY = 0;
    for (const coord of htrsPolygonCoords) {
        centroidX += coord[0];
        centroidY += coord[1];
    }
    centroidX /= htrsPolygonCoords.length;
    centroidY /= htrsPolygonCoords.length;

    // Calculate boundary length
    let boundaryLength = 0;
    for (let i = 0; i < htrsPolygonCoords.length - 1; i++) {
        const dx = htrsPolygonCoords[i + 1][0] - htrsPolygonCoords[i][0];
        const dy = htrsPolygonCoords[i + 1][1] - htrsPolygonCoords[i][1];
        boundaryLength += Math.sqrt(dx * dx + dy * dy);
    }

    // Step 1: Show original parcel
    animationSteps.push({
        description: "Step 1: Original Parcel Boundary",
        render: () => {
            // Create the parcel layer
            const parcelGeoJSON = {
                type: 'Feature',
                properties: {},
                geometry: {
                    type: 'Polygon',
                    coordinates: [polygonCoords]
                }
            };

            animParcelLayer = L.geoJSON(parcelGeoJSON, {
                style: {
                    fillColor: 'red',
                    fillOpacity: 0.2,
                    color: 'red',
                    weight: 2
                }
            }).addTo(animationMap);

            // Fit bounds to the parcel
            animationMap.fitBounds(animParcelLayer.getBounds(), {
                padding: [50, 50]
            });
        }
    });

    // Step 2: Sample points along the boundary
    const numSamplePoints = Math.max(50, Math.ceil(boundaryLength / 5));
    const samplePoints = [];

    animationSteps.push({
        description: "Step 2: Sample Points Along Boundary",
        render: () => {
            // Sample points along the boundary (same as in calculateRoadMetrics)
            let currentDist = 0;
            for (let i = 0; i < numSamplePoints; i++) {
                const targetDist = (i / (numSamplePoints - 1)) * boundaryLength;
                currentDist = 0;

                for (let j = 0; j < htrsPolygonCoords.length - 1; j++) {
                    const dx = htrsPolygonCoords[j + 1][0] - htrsPolygonCoords[j][0];
                    const dy = htrsPolygonCoords[j + 1][1] - htrsPolygonCoords[j][1];
                    const segmentLength = Math.sqrt(dx * dx + dy * dy);

                    if (currentDist + segmentLength >= targetDist) {
                        const fraction = (targetDist - currentDist) / segmentLength;
                        const point = [
                            htrsPolygonCoords[j][0] + dx * fraction,
                            htrsPolygonCoords[j][1] + dy * fraction
                        ];
                        samplePoints.push(point);
                        break;
                    }
                    currentDist += segmentLength;
                }
            }

            // Display sample points
            const samplePointsGeoJSON = {
                type: 'FeatureCollection',
                features: samplePoints.map(point => {
                    const [lat, lon] = htrs96ToWGS84(point[0], point[1]);
                    return {
                        type: 'Feature',
                        properties: {},
                        geometry: {
                            type: 'Point',
                            coordinates: [lon, lat]
                        }
                    };
                })
            };

            animSamplePointsLayer = L.geoJSON(samplePointsGeoJSON, {
                pointToLayer: (feature, latlng) => {
                    return L.circleMarker(latlng, {
                        radius: 3,
                        fillColor: 'blue',
                        color: '#000',
                        weight: 1,
                        opacity: 1,
                        fillOpacity: 1
                    });
                }
            }).addTo(animationMap);
        }
    });

    // Step 2.5: Detect main axis
    const mainAxis = findMainAxis(htrsPolygonCoords);

    animationSteps.push({
        description: "Step 2.5: Detecting Long Sides and Road Direction",
        render: () => {
            // Find which points are on long sides
            const longSidePoints = [];
            const shortSidePoints = [];

            for (const point of samplePoints) {
                if (isOnLongSide(point, htrsPolygonCoords, mainAxis)) {
                    longSidePoints.push(point);
                } else {
                    shortSidePoints.push(point);
                }
            }

            // Draw main axis
            const axisLine = [
                [
                    mainAxis.centroid[0] - mainAxis.majorAxis[0] * mainAxis.majorLength * 1.5,
                    mainAxis.centroid[1] - mainAxis.majorAxis[1] * mainAxis.majorLength * 1.5
                ],
                [
                    mainAxis.centroid[0] + mainAxis.majorAxis[0] * mainAxis.majorLength * 1.5,
                    mainAxis.centroid[1] + mainAxis.majorAxis[1] * mainAxis.majorLength * 1.5
                ]
            ];

            const wgs84AxisLine = axisLine.map(p => {
                const [lat, lon] = htrs96ToWGS84(p[0], p[1]);
                return [lon, lat];
            });

            const axisLineGeoJSON = {
                type: 'Feature',
                properties: {},
                geometry: {
                    type: 'LineString',
                    coordinates: wgs84AxisLine
                }
            };

            // Display the axis line
            L.geoJSON(axisLineGeoJSON, {
                style: {
                    color: 'red',
                    weight: 2,
                    dashArray: '10, 5',
                    opacity: 0.8
                }
            }).addTo(animationMap);

            // Display the points on long sides with a different color
            const longSidePointsGeoJSON = {
                type: 'FeatureCollection',
                features: longSidePoints.map(point => {
                    const [lat, lon] = htrs96ToWGS84(point[0], point[1]);
                    return {
                        type: 'Feature',
                        properties: {},
                        geometry: {
                            type: 'Point',
                            coordinates: [lon, lat]
                        }
                    };
                })
            };

            // Update the existing sample points to show long side points
            if (animSamplePointsLayer) {
                animationMap.removeLayer(animSamplePointsLayer);
            }

            // First show short side points in gray
            const shortSidePointsGeoJSON = {
                type: 'FeatureCollection',
                features: shortSidePoints.map(point => {
                    const [lat, lon] = htrs96ToWGS84(point[0], point[1]);
                    return {
                        type: 'Feature',
                        properties: {},
                        geometry: {
                            type: 'Point',
                            coordinates: [lon, lat]
                        }
                    };
                })
            };

            L.geoJSON(shortSidePointsGeoJSON, {
                pointToLayer: (feature, latlng) => {
                    return L.circleMarker(latlng, {
                        radius: 3,
                        fillColor: '#aaa',
                        color: '#888',
                        weight: 1,
                        opacity: 0.6,
                        fillOpacity: 0.6
                    });
                }
            }).addTo(animationMap);

            // Then show long side points in blue
            animSamplePointsLayer = L.geoJSON(longSidePointsGeoJSON, {
                pointToLayer: (feature, latlng) => {
                    return L.circleMarker(latlng, {
                        radius: 3,
                        fillColor: 'blue',
                        color: '#000',
                        weight: 1,
                        opacity: 1,
                        fillOpacity: 1
                    });
                }
            }).addTo(animationMap);
        }
    });

    // Step 3: Finding opposite boundary points
    const oppositePoints = [];
    const midpoints = [];
    const widthLines = [];
    const searchLines = [];

    animationSteps.push({
        description: "Step 3: Finding Perpendicular Width Measurements (Only from Long Sides)",
        render: () => {
            // Find the opposite points for each sample point
            for (const point of samplePoints) {
                // For animation, we'll show the search process but only for long side points
                if (!isOnLongSide(point, htrsPolygonCoords, mainAxis)) {
                    continue; // Skip points not on long sides
                }

                // First find which segment this point is on or closest to
                let minDistToSegment = Infinity;
                let closestSegmentIndex = -1;
                let closestPointOnSegment = null;

                for (let i = 0; i < htrsPolygonCoords.length - 1; i++) {
                    const [p1, p2] = [htrsPolygonCoords[i], htrsPolygonCoords[i + 1]];
                    const pointOnSegment = closestPointOnLineSegment(point, p1, p2);
                    const dx = pointOnSegment[0] - point[0];
                    const dy = pointOnSegment[1] - point[1];
                    const distToSegment = Math.sqrt(dx * dx + dy * dy);

                    if (distToSegment < minDistToSegment) {
                        minDistToSegment = distToSegment;
                        closestSegmentIndex = i;
                        closestPointOnSegment = pointOnSegment;
                    }
                }

                if (closestSegmentIndex === -1) continue;

                // Get the segment and calculate its direction
                const [p1, p2] = [htrsPolygonCoords[closestSegmentIndex], htrsPolygonCoords[closestSegmentIndex + 1]];
                const segDx = p2[0] - p1[0];
                const segDy = p2[1] - p1[1];
                const segLength = Math.sqrt(segDx * segDx + segDy * segDy);

                // Calculate perpendicular direction
                const perpDx = -segDy / segLength;
                const perpDy = segDx / segLength;

                // Ensure the perpendicular direction is aligned with the minor axis
                const dotWithMinor = perpDx * mainAxis.minorAxis[0] + perpDy * mainAxis.minorAxis[1];

                // Adjust the perpendicular direction if needed
                let adjustedPerpDx = perpDx;
                let adjustedPerpDy = perpDy;
                if (dotWithMinor < 0) {
                    // Flip the direction
                    adjustedPerpDx = -perpDx;
                    adjustedPerpDy = -perpDy;
                }

                // Create a ray starting from point or closest point on segment
                const startPoint = (minDistToSegment < 0.001) ? point : closestPointOnSegment;

                // Create a ray that extends perpendicular to the boundary
                const searchDistance = boundaryLength / 2;
                const searchEndPoint = [
                    startPoint[0] + adjustedPerpDx * searchDistance,
                    startPoint[1] + adjustedPerpDy * searchDistance
                ];

                // Save the search line for visualization
                const wgs84SearchLine = [
                    htrs96ToWGS84(startPoint[0], startPoint[1]),
                    htrs96ToWGS84(searchEndPoint[0], searchEndPoint[1])
                ].map(p => [p[1], p[0]]); // Convert to [lon, lat]

                searchLines.push(wgs84SearchLine);

                // Find opposite point
                const opposite = findOppositePoint(point, samplePoints, htrsPolygonCoords, boundaryLength, mainAxis);
                if (opposite) {
                    oppositePoints.push(opposite);

                    // Calculate midpoint
                    const midpoint = [
                        (point[0] + opposite[0]) / 2,
                        (point[1] + opposite[1]) / 2
                    ];
                    midpoints.push(midpoint);

                    // Create width line
                    const wgs84Line = [
                        htrs96ToWGS84(point[0], point[1]),
                        htrs96ToWGS84(opposite[0], opposite[1])
                    ].map(p => [p[1], p[0]]); // Convert to [lon, lat]

                    widthLines.push(wgs84Line);
                }
            }

            // First display search rays
            animSearchLinesLayer = L.featureGroup();
            searchLines.forEach(line => {
                L.polyline([
                    [line[0][1], line[0][0]], // First point
                    [line[1][1], line[1][0]]  // Second point
                ], {
                    color: '#aaa',
                    weight: 1,
                    opacity: 0.4,
                    dashArray: '3, 3'
                }).addTo(animSearchLinesLayer);
            });
            animSearchLinesLayer.addTo(animationMap);

            // Then display opposite points
            const oppositePointsGeoJSON = {
                type: 'FeatureCollection',
                features: oppositePoints.map(point => {
                    const [lat, lon] = htrs96ToWGS84(point[0], point[1]);
                    return {
                        type: 'Feature',
                        properties: {},
                        geometry: {
                            type: 'Point',
                            coordinates: [lon, lat]
                        }
                    };
                })
            };

            animOppositePointsLayer = L.geoJSON(oppositePointsGeoJSON, {
                pointToLayer: (feature, latlng) => {
                    return L.circleMarker(latlng, {
                        radius: 3,
                        fillColor: 'green',
                        color: '#000',
                        weight: 1,
                        opacity: 1,
                        fillOpacity: 1
                    });
                }
            }).addTo(animationMap);

            // Finally display width lines
            animWidthLinesLayer = L.featureGroup();
            widthLines.forEach(line => {
                L.polyline([
                    [line[0][1], line[0][0]], // First point
                    [line[1][1], line[1][0]]  // Second point
                ], {
                    color: 'orange',
                    weight: 2,
                    opacity: 0.7
                }).addTo(animWidthLinesLayer);
            });
            animWidthLinesLayer.addTo(animationMap);
        }
    });

    // Step 4: Calculating midpoints
    animationSteps.push({
        description: "Step 4: Calculating Midpoints Between Opposite Points",
        render: () => {
            // Display midpoints
            const midpointsGeoJSON = {
                type: 'FeatureCollection',
                features: midpoints.map(point => {
                    const [lat, lon] = htrs96ToWGS84(point[0], point[1]);
                    return {
                        type: 'Feature',
                        properties: {},
                        geometry: {
                            type: 'Point',
                            coordinates: [lon, lat]
                        }
                    };
                })
            };

            animMidpointsLayer = L.geoJSON(midpointsGeoJSON, {
                pointToLayer: (feature, latlng) => {
                    return L.circleMarker(latlng, {
                        radius: 3,
                        fillColor: 'yellow',
                        color: '#000',
                        weight: 1,
                        opacity: 1,
                        fillOpacity: 1
                    });
                }
            }).addTo(animationMap);
        }
    });

    // Step 5: Sorting and connecting midpoints to form centerline
    animationSteps.push({
        description: "Step 5: Sorting and Connecting Midpoints to Form Centerline",
        render: () => {
            // Sort centerline points (same as in calculateRoadMetrics)
            const sortedCenterline = [midpoints[0]];
            const remaining = midpoints.slice(1);

            while (remaining.length > 0) {
                const current = sortedCenterline[sortedCenterline.length - 1];
                let nearestIdx = 0;
                let minDist = Infinity;

                for (let i = 0; i < remaining.length; i++) {
                    const dx = remaining[i][0] - current[0];
                    const dy = remaining[i][1] - current[1];
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist < minDist) {
                        minDist = dist;
                        nearestIdx = i;
                    }
                }

                sortedCenterline.push(remaining[nearestIdx]);
                remaining.splice(nearestIdx, 1);
            }

            // Convert to WGS84
            const centerlineWGS84 = sortedCenterline.map(point => {
                const [lat, lon] = htrs96ToWGS84(point[0], point[1]);
                return [lon, lat];
            });

            // Display final centerline
            const centerlineGeoJSON = {
                type: 'Feature',
                properties: {},
                geometry: {
                    type: 'LineString',
                    coordinates: centerlineWGS84
                }
            };

            animFinalCenterlineLayer = L.geoJSON(centerlineGeoJSON, {
                style: {
                    color: 'yellow',
                    weight: 3,
                    dashArray: '10, 5',
                    opacity: 0.8
                }
            }).addTo(animationMap);
        }
    });
}

// Render a specific step of the animation
function renderAnimationStep(stepIndex) {
    if (stepIndex < 0 || stepIndex >= animationSteps.length) return;

    // Clear previous layers
    clearAnimationLayers();

    // Update the step description
    document.getElementById('animation-step').textContent = animationSteps[stepIndex].description;

    // Render all steps up to and including the current step
    for (let i = 0; i <= stepIndex; i++) {
        animationSteps[i].render();
    }

    // Update current step
    animationCurrentStep = stepIndex;

    // Update buttons
    updateAnimationButtons();
}

// Update the animation control buttons
function updateAnimationButtons() {
    document.getElementById('btn-prev').disabled = animationCurrentStep <= 0;
    document.getElementById('btn-next').disabled = animationCurrentStep >= animationSteps.length - 1;
}

// Navigate to the previous step
function prevAnimationStep() {
    if (animationCurrentStep > 0) {
        renderAnimationStep(animationCurrentStep - 1);
    }
}

// Navigate to the next step
function nextAnimationStep() {
    if (animationCurrentStep < animationSteps.length - 1) {
        renderAnimationStep(animationCurrentStep + 1);
    } else {
        stopPlayAnimation();
    }
}

// Toggle play/pause animation
function togglePlayAnimation() {
    if (animationPlaying) {
        stopPlayAnimation();
    } else {
        startPlayAnimation();
    }
}

// Start playing the animation
function startPlayAnimation() {
    if (!animationPlaying) {
        animationPlaying = true;
        document.getElementById('btn-play').textContent = 'Pause';

        // If we're at the end, start over
        if (animationCurrentStep >= animationSteps.length - 1) {
            renderAnimationStep(0);
        }

        // Schedule the next step
        animationTimer = setTimeout(playNextStep, animationSpeed);
    }
}

// Stop playing the animation
function stopPlayAnimation() {
    if (animationPlaying) {
        animationPlaying = false;
        document.getElementById('btn-play').textContent = 'Play';

        if (animationTimer) {
            clearTimeout(animationTimer);
            animationTimer = null;
        }
    }
}

// Play the next step in the animation
function playNextStep() {
    if (animationCurrentStep < animationSteps.length - 1) {
        renderAnimationStep(animationCurrentStep + 1);
        animationTimer = setTimeout(playNextStep, animationSpeed);
    } else {
        stopPlayAnimation();
    }
}

