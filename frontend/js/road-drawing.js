// Hide road info panel
function hideRoadInfoPanel() {
    document.getElementById('road-info-panel').classList.remove('visible');
}

// Road drawing tool variables
let roadDrawingMode = false;
let roadPoints = [];
// Default width in meters; overridden by picker. The mapping uses representative carriageway widths.
let roadWidth = 7.5;
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
let roadPreviewAffectedParcels = []; // Stores parcels affected by the preview segment

// Define style for preview-affected parcels
const previewAffectedStyle = {
    fillColor: '#ff6600', // Orange
    fillOpacity: 0.4,
    color: '#ff6600',
    weight: 2
};

// Toggle road drawing tool
function toggleRoadDrawTool() {
    roadDrawingMode = !roadDrawingMode;
    const roadDrawButton = document.getElementById('roadDrawButton');
    const roadWidthContainer = document.getElementById('roadWidthContainer');
    const roadWidthSelect = document.getElementById('roadWidthSelect');
    const finishRoadButton = document.getElementById('finishRoadButton');
    const cancelRoadButton = document.getElementById('cancelRoadButton');

    if (roadDrawingMode) {
        // Activate road drawing mode
        console.log("Activating road drawing mode");
        roadDrawButton.classList.add('active');
        roadDrawButton.classList.add('active-black-border');

        // Show width container and drawing controls in the Road Info panel
        // Hide legacy dropdown UI while using the modal-based picker
        if (roadWidthContainer) roadWidthContainer.style.display = 'none';
        if (roadWidthSelect) roadWidthSelect.disabled = true;

        const roadDrawingControls = document.getElementById('road-drawing-controls');
        if (roadDrawingControls) roadDrawingControls.style.display = 'grid';
        map.getContainer().style.cursor = 'crosshair';
        map.getContainer().classList.add('crosshairs-cursor');

        // Disable other tools and interactivity
        if (typeof measureMode !== 'undefined' && measureMode) toggleMeasureTool(); // Add check for measureMode existence

        // --- Robustly disable parcel interaction --- 
        if (parcelLayer) {
            console.log("Disabling parcel click listeners");
            parcelLayer.eachLayer(layer => {
                layer.off('click'); // Remove all click listeners
            });
        }
        // --- End robust disable --- 

        // Hide block info and parcel info panels
        const blockInfoPanel = document.getElementById('block-info-panel');
        const parcelInfoPanel = document.getElementById('parcel-info-panel');
        if (blockInfoPanel) blockInfoPanel.classList.remove('visible');
        if (parcelInfoPanel) parcelInfoPanel.classList.remove('visible');

        // Initialize road width via the new width picker modal; fallback to dropdown if modal is unavailable
        try {
            showRoadWidthPicker().then(width => {
                if (typeof width === 'number' && isFinite(width)) {
                    roadWidth = width;
                } else if (roadWidthSelect) {
                    roadWidth = parseFloat(roadWidthSelect.value);
                }
                // Show the road info panel and set status after width is chosen
                const roadInfoPanel = document.getElementById('road-info-panel');
                if (roadInfoPanel) roadInfoPanel.classList.add('visible');
                const statusElement = document.getElementById('status');
                if (statusElement) updateStatus('Click on the map to start drawing a road');
                // Show drawing controls now that we're ready
                const roadDrawingControls = document.getElementById('road-drawing-controls');
                if (roadDrawingControls) roadDrawingControls.style.display = 'grid';
                // Activate map and keyboard handlers now that width is set
                map.on('click', handleRoadClick);
                map.on('mousemove', handleRoadMouseMove);
                map.on('mouseout', handleRoadMouseOut);
                document.addEventListener('keydown', handleRoadKeydown);
            }).catch(() => {
                // If picker was cancelled, turn off drawing mode gracefully
                roadDrawingMode = false;
                if (roadDrawButton) {
                    roadDrawButton.classList.remove('active');
                    roadDrawButton.classList.remove('active-black-border');
                }
                if (roadWidthContainer) roadWidthContainer.style.display = 'none';
                const roadDrawingControls = document.getElementById('road-drawing-controls');
                if (roadDrawingControls) roadDrawingControls.style.display = 'none';
                map.getContainer().style.cursor = '';
                map.getContainer().classList.remove('crosshairs-cursor');
                // Remove event handlers bound for drawing
                map.off('click', handleRoadClick);
                map.off('mousemove', handleRoadMouseMove);
                map.off('mouseout', handleRoadMouseOut);
                document.removeEventListener('keydown', handleRoadKeydown);
                // Re-enable parcel interaction
                if (parcelLayer) {
                    try {
                        parcelLayer.eachLayer(layer => {
                            layer.off('click');
                            if (typeof getCorrectClickHandler === 'function') {
                                layer.on('click', getCorrectClickHandler());
                            }
                        });
                    } catch (_) { }
                }
            });
        } catch (e) {
            console.warn('Road width picker unavailable, falling back to dropdown', e);
            if (roadWidthSelect) roadWidth = parseFloat(roadWidthSelect.value);
            const roadInfoPanel = document.getElementById('road-info-panel');
            if (roadInfoPanel) roadInfoPanel.classList.add('visible');
            const statusElement = document.getElementById('status');
            if (statusElement) updateStatus('Click on the map to start drawing a road');
        }
        // Map and keyboard handlers will be attached after width is chosen

        // Note: Road info panel visibility and status are handled after width pick

    } else {
        // Deactivate road drawing mode
        console.log("Deactivating road drawing mode");
        if (roadDrawButton) {
            roadDrawButton.classList.remove('active');
            roadDrawButton.classList.remove('active-black-border');
        }
        if (roadWidthContainer) roadWidthContainer.style.display = 'none';

        const roadDrawingControls = document.getElementById('road-drawing-controls');
        if (roadDrawingControls) roadDrawingControls.style.display = 'none';
        map.getContainer().style.cursor = '';
        map.getContainer().classList.remove('crosshairs-cursor');

        // Remove road drawing event handlers from the map
        map.off('click', handleRoadClick);
        map.off('mousemove', handleRoadMouseMove);
        map.off('mouseout', handleRoadMouseOut);
        document.removeEventListener('keydown', handleRoadKeydown);

        // --- Robustly re-enable parcel interaction --- 
        if (parcelLayer) {
            console.log("Re-enabling parcel click listeners");
            parcelLayer.eachLayer(layer => {
                layer.off('click'); // Remove any lingering road-related handlers
                layer.on('click', getCorrectClickHandler()); // Use the authoritative handler
            });
        }
        // --- End robust re-enable ---

        // Reset road drawing variables
        resetRoadDrawing(false);

        // Hide the road info panel
        const roadInfoPanel = document.getElementById('road-info-panel');
        if (roadInfoPanel) roadInfoPanel.classList.remove('visible');

        // Clear status
        const statusElement = document.getElementById('status');
        if (statusElement) updateStatus('');
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
const widthSelectEl = document.getElementById('roadWidthSelect');
if (widthSelectEl) {
    widthSelectEl.addEventListener('change', function () {
        roadWidth = parseFloat(this.value);
        if (roadHasStarted) {
            updateRoadPreview();
            updateRoadInfoPanel();
        }
    });
}

// Road Width Picker modal implementation
function showRoadWidthPicker() {
    return new Promise((resolve, reject) => {
        const modal = document.getElementById('road-width-modal');
        const grid = document.getElementById('road-width-grid');
        const btnConfirm = document.getElementById('road-width-confirm-btn');
        const btnCancel = document.getElementById('road-width-cancel-btn');
        if (!modal || !grid || !btnConfirm || !btnCancel) {
            console.warn('Road width modal elements missing');
            resolve(7.5); // fallback silently
            return;
        }

        // Options: label -> width meters
        const options = [
            { id: 'roadwidth1', label: 'Boulevard ~80 m', width: 80 },
            { id: 'roadwidth2', label: 'Avenue ~40 m', width: 40 },
            { id: 'roadwidth3', label: 'Main street ~26 m', width: 26 },
            { id: 'roadwidth4', label: 'Collector ~18 m', width: 18 },
            { id: 'roadwidth5', label: 'Local ~10 m', width: 10 },
            { id: 'roadwidth6', label: 'Alley ~7.5 m', width: 7.5 },
        ];

        // Prefill grid
        grid.innerHTML = '';
        let selectedId = (PersistentStorage.getItem('lastRoadWidthId')) || 'roadwidth6';

        options.forEach(opt => {
            const card = document.createElement('div');
            card.className = 'roadwidth-card' + (opt.id === selectedId ? ' selected' : '');
            card.setAttribute('role', 'button');
            card.setAttribute('tabindex', '0');
            card.dataset.id = opt.id;
            card.dataset.width = String(opt.width);
            const img = document.createElement('img');
            img.className = 'roadwidth-thumb';
            img.alt = opt.label;
            img.src = getRoadWidthThumbDataURI(opt.id);
            const lbl = document.createElement('div');
            lbl.className = 'roadwidth-label';
            lbl.textContent = `${opt.label}`;
            card.appendChild(img);
            card.appendChild(lbl);
            card.addEventListener('click', () => {
                selectedId = opt.id;
                grid.querySelectorAll('.roadwidth-card').forEach(el => el.classList.remove('selected'));
                card.classList.add('selected');
                // Confirm immediately on click
                confirmSelection();
            });
            card.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    card.click();
                }
            });
            grid.appendChild(card);
        });

        function confirmSelection() {
            const opt = options.find(o => o.id === selectedId) || options[options.length - 1];
            PersistentStorage.setItem('lastRoadWidthId', opt.id);
            hide();
            resolve(opt.width);
        }
        function cancelSelection() { hide(); reject(new Error('cancelled')); }
        function handleKey(ev) {
            if (ev.key === 'Enter') { ev.preventDefault(); confirmSelection(); }
            if (ev.key === 'Escape') { ev.preventDefault(); cancelSelection(); }
        }
        function hide() {
            modal.style.display = 'none';
            document.removeEventListener('keydown', handleKey);
            btnConfirm.removeEventListener('click', confirmSelection);
            btnCancel.removeEventListener('click', cancelSelection);
        }

        btnConfirm.addEventListener('click', confirmSelection);
        btnCancel.addEventListener('click', cancelSelection);
        document.addEventListener('keydown', handleKey);
        // Use flex to center the modal content per CSS
        modal.style.display = 'flex';
    });
}

// Create a simple inline SVG thumb for each option id.
function getRoadWidthThumbDataURI(id) {
    // Map ID to an approximate lane/offset visualization by road band height
    const map = {
        roadwidth1: 80,
        roadwidth2: 40,
        roadwidth3: 26,
        roadwidth4: 18,
        roadwidth5: 10,
        roadwidth6: 7.5
    };
    const w = 200, h = 120;
    const bg = '#cfd8dc';
    const asphalt = '#616161';
    const line = '#ffffff';
    const label = map[id] ?? 7.5;
    // Convert "width meters" to a normalized band thickness between 20 and 100 px
    const minBand = 22, maxBand = 98;
    const minM = 7.5, maxM = 80;
    const t = Math.max(0, Math.min(1, (label - minM) / (maxM - minM)));
    const band = Math.round(minBand + t * (maxBand - minBand));
    const y = Math.round((h - band) / 2);
    const dashHeight = 4;
    const dashWidth = 8;
    // Build SVG
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}'>
    <defs>
        <pattern id='dash' width='${dashWidth * 2}' height='${dashHeight}' patternUnits='userSpaceOnUse'>
            <rect x='0' y='0' width='${dashWidth}' height='${dashHeight}' fill='${line}' />
        </pattern>
    </defs>
    <rect width='${w}' height='${h}' fill='${bg}'/>
    <rect x='20' y='${y}' width='${w - 40}' height='${band}' rx='6' fill='${asphalt}'/>
    <rect x='20' y='${Math.round(h / 2 - dashHeight / 2)}' width='${w - 40}' height='${dashHeight}' fill='url(#dash)'/>
</svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

// Handle road drawing clicks
function handleRoadClick(e) {
    console.log("handleRoadClick fired");
    // Stop event propagation to prevent parcel selection or other click handlers
    L.DomEvent.stopPropagation(e);

    const clickPoint = e.latlng;

    if (!roadHasStarted) {
        // First click - start the road
        roadPoints = [clickPoint];
        roadHasStarted = true;

        // Add marker for the starting point
        const startMarker = L.circleMarker(clickPoint, {
            radius: 5,
            color: 'green',
            fillColor: '#00ff00',
            fillOpacity: 1
        }).addTo(map);
        roadMarkers.push(startMarker); // Store the marker

        // Initialize road centerline
        roadCenterline = L.polyline([clickPoint], {
            color: 'green',
            weight: 3,
            dashArray: '5, 5',
            opacity: 0.7
        }).addTo(map);

        // Show status for next point
        updateStatus('Click to add road points, "Finish" when done');
    } else {
        // Add another point to the road
        roadPoints.push(clickPoint);

        // Add marker for this point
        const pointMarker = L.circleMarker(clickPoint, {
            radius: 5,
            color: 'green',
            fillColor: '#00ff00',
            fillOpacity: 1
        }).addTo(map);
        roadMarkers.push(pointMarker); // Store the marker

        // Update the centerline
        roadCenterline.addLatLng(clickPoint);

        // Wrap the entire segment processing in try...catch for robustness
        try {
            // Clear any existing *preview* highlighting and polygon layers
            // Do this *before* calculating the new committed polygon
            clearPreviewAffectedParcels();
            if (roadPreviewPolygonLayer) {
                roadPreviewPolygonLayer.removeFrom(map);
                roadPreviewPolygonLayer = null;
            }
            if (roadPreviewLine) {
                roadPreviewLine.removeFrom(map);
                roadPreviewLine = null;
            }

            // Calculate the new committed road polygon
            const newCommittedPolygon = calculateRoadPolygon(roadPoints, roadWidth);

            // Update the global roadPolygon variable
            roadPolygon = newCommittedPolygon;

            // Remove the *previous* committed polygon layer before adding the new one
            if (roadPolygonLayer) {
                map.removeLayer(roadPolygonLayer);
                roadPolygonLayer = null; // Ensure it's cleared
            }

            if (roadPolygon) {
                // Draw the new committed road polygon
                roadPolygonLayer = L.polygon(roadPolygon, {
                    color: 'green',
                    weight: 2,
                    fillColor: 'green',
                    fillOpacity: 0.3
                }).addTo(map);

                // Find and highlight parcels affected by the *newly committed* road
                findAffectedParcels(roadPolygon);
            } else {
                console.warn("Failed to calculate committed road polygon after click.");
                // Optionally, clear committed highlights if calculation fails?
                // clearAffectedParcels(); // Decided against this for now
            }

        } catch (error) {
            console.error('Error processing road segment after click:', error);
            // Consider what state to reset on error? Maybe cancel the drawing?
            // For now, just log the error.
        }
    }

    // Always update the info panel
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
                // Draw the new preview line
                roadPreviewLine = L.polyline([roadPoints[roadPoints.length - 1], mouseLatLng], {
                    color: '#ff6600',
                    dashArray: '5, 10',
                    weight: 2
                }).addTo(map);

                // Draw the new preview polygon
                if (roadPreviewPolygonLayer) {
                    roadPreviewPolygonLayer.removeFrom(map);
                }
                roadPreviewPolygonLayer = L.polygon(tempRoadPolygon, {
                    color: '#ff6600',
                    weight: 1,
                    fillColor: '#ff6600',
                    fillOpacity: 0.2
                }).addTo(map);

                // Find and highlight parcels affected *only* by the preview
                findPreviewAffectedParcels(tempRoadPolygon);

                lastRoadMoveUpdate = Date.now(); // Keep for potential throttling later

                // Update road info with preview metrics
                updateRoadInfoWithPreview(latestRoadPoints, tempRoadPolygon);
            } else {
                console.warn('Invalid road polygon for preview - cannot display polygon');
                // Clear only preview highlighting if polygon becomes invalid
                clearPreviewAffectedParcels();

                // Still show a simple preview line
                roadPreviewLine = L.polyline([roadPoints[roadPoints.length - 1], mouseLatLng], {
                    color: '#ff6600',
                    dashArray: '5, 10',
                    weight: 2
                }).addTo(map);
            }
        } catch (error) {
            console.error('Error in road preview calculation:', error);
            // Clear only preview highlighting on error
            clearPreviewAffectedParcels();

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

// Handle road mouse movement out
function handleRoadMouseOut(e) {
    if (!roadDrawingMode) return; // Only act if in drawing mode

    // Clear preview line
    if (roadPreviewLine) {
        roadPreviewLine.removeFrom(map);
        roadPreviewLine = null;
    }

    // Clear preview polygon
    if (roadPreviewPolygonLayer) {
        roadPreviewPolygonLayer.removeFrom(map);
        roadPreviewPolygonLayer = null;
    }

    // Clear only the preview highlighting
    clearPreviewAffectedParcels();
}

// Legacy road polygon builder using per-segment rectangles and wedges
function calculateRoadPolygonRectangular(points, width) {
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

        // At each interior joint, add a wedge to fill the outer gap between segments
        if (i >= 1 && i < points.length - 1) {
            try {
                const wedge = createJointWedgePolygon(points[i - 1], points[i], points[i + 1], width);
                if (wedge) {
                    const combinedWithWedge = combineRoadPolygons(combinedPolygon, wedge);
                    if (combinedWithWedge) {
                        combinedPolygon = combinedWithWedge;
                    }
                }
            } catch (e) {
                // Silent failure for wedge calculation to avoid interrupting drawing
            }
        }
    }

    return combinedPolygon;
}

// Calculate road polygon from centerline using smoothed offsets
function calculateRoadPolygon(points, width) {
    if (!points || points.length < 2 || !isFinite(width)) {
        console.warn('Invalid inputs to calculateRoadPolygon:', { pointsLength: points?.length, width });
        return null;
    }

    const smoothed = buildOffsetRoadPolygon(points, width);
    if (smoothed && smoothed.length >= 4) {
        return smoothed;
    }

    // Fallback to the legacy rectangle-based approach if smoothing fails
    return calculateRoadPolygonRectangular(points, width);
}

function buildOffsetRoadPolygon(points, width) {
    try {
        const halfWidth = width / 2;
        if (!isFinite(halfWidth) || halfWidth <= 0) {
            return null;
        }

        // Convert to metric coordinates and remove consecutive duplicates
        const rawHTRS = points
            .map(p => wgs84ToHTRS96(p.lat, p.lng))
            .filter(isValidPoint);

        if (rawHTRS.length < 2) return null;

        const cleanedHTRS = [];
        const minDistance = 0.05; // meters
        for (const pt of rawHTRS) {
            if (cleanedHTRS.length === 0) {
                cleanedHTRS.push(pt);
                continue;
            }
            const prev = cleanedHTRS[cleanedHTRS.length - 1];
            const dx = pt[0] - prev[0];
            const dy = pt[1] - prev[1];
            if (Math.hypot(dx, dy) >= minDistance) {
                cleanedHTRS.push(pt);
            }
        }

        if (cleanedHTRS.length < 2) return null;

        const directions = [];
        for (let i = 0; i < cleanedHTRS.length - 1; i++) {
            const dx = cleanedHTRS[i + 1][0] - cleanedHTRS[i][0];
            const dy = cleanedHTRS[i + 1][1] - cleanedHTRS[i][1];
            const len = Math.hypot(dx, dy);
            directions.push(len < 1e-6 ? null : [dx / len, dy / len]);
        }

        const resolvePrevDirection = (idx) => {
            for (let i = idx - 1; i >= 0; i--) {
                if (directions[i]) return directions[i];
            }
            for (let i = 0; i < directions.length; i++) {
                if (directions[i]) return directions[i];
            }
            return null;
        };

        const resolveNextDirection = (idx) => {
            for (let i = idx; i < directions.length; i++) {
                if (directions[i]) return directions[i];
            }
            for (let i = directions.length - 1; i >= 0; i--) {
                if (directions[i]) return directions[i];
            }
            return null;
        };

        const addVec = (a, b) => [a[0] + b[0], a[1] + b[1]];
        const scaleVec = (v, scalar) => [v[0] * scalar, v[1] * scalar];
        const vecLength = (v) => Math.hypot(v[0], v[1]);
        const leftNormal = (dir) => [-dir[1], dir[0]];
        const rightNormal = (dir) => [dir[1], -dir[0]];

        const computeOffsetPoint = (point, dirPrev, dirNext, side) => {
            const normalFromDir = side === 1 ? leftNormal : rightNormal;

            if (!dirPrev && dirNext) {
                const normal = normalFromDir(dirNext);
                return addVec(point, scaleVec(normal, halfWidth));
            }
            if (dirPrev && !dirNext) {
                const normal = normalFromDir(dirPrev);
                return addVec(point, scaleVec(normal, halfWidth));
            }
            if (!dirPrev && !dirNext) {
                return [point[0], point[1]];
            }

            const normalPrev = normalFromDir(dirPrev);
            const normalNext = normalFromDir(dirNext);
            const summed = addVec(normalPrev, normalNext);
            const sumLen = vecLength(summed);

            if (sumLen < 1e-6) {
                return addVec(point, scaleVec(normalNext, halfWidth));
            }

            const miter = [summed[0] / sumLen, summed[1] / sumLen];
            let dot = miter[0] * normalNext[0] + miter[1] * normalNext[1];
            if (Math.abs(dot) < 1e-6) {
                dot = 1e-6 * Math.sign(dot || 1);
            }

            let scaleFactor = halfWidth / dot;
            const miterLimit = 6;
            const maxScale = miterLimit * halfWidth;
            if (Math.abs(scaleFactor) > maxScale) {
                const fallbackNormal = dot > 0 ? normalNext : normalPrev;
                return addVec(point, scaleVec(fallbackNormal, halfWidth));
            }

            return addVec(point, scaleVec(miter, scaleFactor));
        };

        const leftPts = [];
        const rightPts = [];
        for (let i = 0; i < cleanedHTRS.length; i++) {
            const dirPrev = i > 0 ? resolvePrevDirection(i) : null;
            const dirNext = i < cleanedHTRS.length - 1 ? resolveNextDirection(i) : null;

            const leftPt = computeOffsetPoint(cleanedHTRS[i], dirPrev, dirNext, 1);
            const rightPt = computeOffsetPoint(cleanedHTRS[i], dirPrev, dirNext, -1);

            leftPts.push(leftPt);
            rightPts.push(rightPt);
        }

        const polygonHTRS = [...leftPts, ...rightPts.reverse()];
        if (polygonHTRS.length < 4) return null;

        const first = polygonHTRS[0];
        const last = polygonHTRS[polygonHTRS.length - 1];
        if (Math.hypot(first[0] - last[0], first[1] - last[1]) > 0.001) {
            polygonHTRS.push([...first]);
        }

        return polygonHTRS.map(([x, y]) => {
            const [lat, lng] = htrs96ToWGS84(x, y);
            return L.latLng(lat, lng);
        });
    } catch (error) {
        console.warn('Failed to build offset road polygon', error);
        return null;
    }
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

// Get parcel outer ring(s) in [lng, lat] arrays; handles Polygon and MultiPolygon, with fallback to layer.getLatLngs()
function getParcelOuterRingsLngLat(layer) {
    const rings = [];
    try {
        const geom = layer && layer.feature ? layer.feature.geometry : null;
        if (geom && geom.type) {
            if (geom.type === 'Polygon') {
                if (Array.isArray(geom.coordinates) && geom.coordinates.length > 0) {
                    const ring = ensurePolygonIsClosed(geom.coordinates[0]);
                    if (Array.isArray(ring) && ring.length >= 4) rings.push(ring);
                }
            } else if (geom.type === 'MultiPolygon') {
                if (Array.isArray(geom.coordinates)) {
                    geom.coordinates.forEach(poly => {
                        if (Array.isArray(poly) && poly.length > 0) {
                            const ring = ensurePolygonIsClosed(poly[0]);
                            if (Array.isArray(ring) && ring.length >= 4) rings.push(ring);
                        }
                    });
                }
            }
        } else if (typeof layer.getLatLngs === 'function') {
            const latlngs = layer.getLatLngs();
            // MultiPolygon form: [ [ [LatLng...] (outer), [LatLng...] (holes) ], ... ]
            if (Array.isArray(latlngs) && Array.isArray(latlngs[0]) && Array.isArray(latlngs[0][0])) {
                latlngs.forEach(polyRings => {
                    if (Array.isArray(polyRings) && Array.isArray(polyRings[0])) {
                        const ring = polyRings[0].map(ll => [ll.lng, ll.lat]);
                        const closed = ensurePolygonIsClosed(ring);
                        if (Array.isArray(closed) && closed.length >= 4) rings.push(closed);
                    }
                });
            } else if (Array.isArray(latlngs) && Array.isArray(latlngs[0])) {
                // Polygon form: [ [LatLng...] (outer), [LatLng...] (hole1), ... ]
                const ring = latlngs[0].map(ll => [ll.lng, ll.lat]);
                const closed = ensurePolygonIsClosed(ring);
                if (Array.isArray(closed) && closed.length >= 4) rings.push(closed);
            }
        }
    } catch (_) { }
    return rings;
}

function convertRoadPolygonToLatLngPairs(polygon) {
    if (!Array.isArray(polygon)) return null;
    const pairs = [];
    polygon.forEach(entry => {
        if (!entry) return;
        if (typeof entry.lat === 'number' && typeof entry.lng === 'number') {
            pairs.push([entry.lat, entry.lng]);
        } else if (Array.isArray(entry) && entry.length >= 2) {
            let [a, b] = entry;
            if (Math.abs(a) > 90 && Math.abs(b) <= 90) {
                pairs.push([b, a]);
            } else if (Number.isFinite(a) && Number.isFinite(b)) {
                pairs.push([a, b]);
            }
        }
    });
    if (pairs.length >= 3) {
        const first = pairs[0];
        const last = pairs[pairs.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) {
            pairs.push([...first]);
        }
        return pairs;
    }
    return null;
}

function buildParcelPolygonLatLngs(parcels) {
    const results = [];
    if (!Array.isArray(parcels)) return results;
    parcels.forEach(parcel => {
        const rings = getParcelOuterRingsLngLat(parcel.layer);
        if (Array.isArray(rings) && rings.length > 0) {
            rings.forEach(ring => {
                if (Array.isArray(ring) && ring.length >= 4) {
                    const latLngRing = ring
                        .map(([lng, lat]) => {
                            const latNum = Number(lat);
                            const lngNum = Number(lng);
                            if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
                                return null;
                            }
                            return [latNum, lngNum];
                        })
                        .filter(Boolean);
                    if (latLngRing.length >= 4) {
                        const closed = convertRoadPolygonToLatLngPairs(latLngRing);
                        if (closed && closed.length >= 4) {
                            results.push(closed);
                        }
                    }
                }
            });
        }
    });
    return results;
}

// Find parcels affected by the road
function findAffectedParcels(roadPolygon) {
    if (!roadPolygon || !parcelLayer) return;

    // Clear previously affected parcels
    if (roadAffectedParcels.length > 0) {
        parcelLayer.eachLayer(layer => {
            // Reset style for previously affected parcels
            if (roadAffectedParcels.some(p => p.id === layer.feature.properties.CESTICA_ID)) {
                const isRoad = PersistentStorage.getItem(`parcel_${layer.feature.properties.CESTICA_ID}_isRoad`) === 'true';
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
        const outerRings = getParcelOuterRingsLngLat(layer);
        if (!outerRings || outerRings.length === 0) return;

        try {
            // Check intersects against any outer ring; stop at first match
            for (let r = 0; r < outerRings.length; r++) {
                const ring = outerRings[r];
                const turfParcelPolygon = turf.polygon([ring]);
                if (turf.booleanIntersects(turfRoadPolygon, turfParcelPolygon)) {
                    let intersectionArea = 0;
                    try {
                        const intersection = turf.intersect(turfRoadPolygon, turfParcelPolygon);
                        if (intersection) {
                            intersectionArea = turf.area(intersection);
                        }
                    } catch (e) { }

                    roadAffectedParcels.push({
                        id: parcelId,
                        number: layer.feature.properties.BROJ_CESTICE,
                        area: intersectionArea,
                        layer: layer
                    });

                    layer.setStyle({
                        fillColor: 'green',
                        fillOpacity: 0.6,
                        color: 'green',
                        weight: 3
                    });

                    if (typeof layer.bringToFront === 'function') {
                        layer.bringToFront();
                    }
                    break;
                }
            }
        } catch (error) { }
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
    if (!roadInfoPanel || !roadInfoPanel.classList.contains('visible')) {
        // The panel doesn't exist or is hidden, so make it visible
        if (roadInfoPanel) {
            roadInfoPanel.classList.add('visible');
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
async function finishRoadDrawing() {
    if (!roadHasStarted || roadPoints.length < 2) return;

    const roadPolygon = calculateRoadPolygon(roadPoints, roadWidth);
    if (!roadPolygon) {
        alert('Invalid road shape. Please try drawing the road again.');
        return;
    }

    const affectedParcels = roadAffectedParcels;
    if (affectedParcels.length === 0) {
        alert('No parcels affected by this road. Please try drawing the road again.');
        return;
    }

    const defaultAuthor = (typeof getCurrentUsername === 'function' && getCurrentUsername()) || '';
    const defaultName = generateRandomRoadName();
    const defaultOffer = generateRandomRoadOffer();

    let modalResult;
    try {
        modalResult = await showRoadProposalModal({
            defaultAuthor,
            defaultName,
            defaultOffer,
            affectedParcels,
            roadPolygon: roadPolygon
        });
    } catch (_) {
        // User cancelled the modal; keep drawing state intact
        return;
    }

    const roadNameInput = (modalResult?.roadName || '').trim();
    const authorInput = (modalResult?.author || '').trim();
    const descriptionInput = (modalResult?.description || '').trim();
    const offerInputValue = typeof modalResult?.offer === 'number' ? modalResult.offer : NaN;
    const formState = modalResult?.form || {};

    const finalRoadName = roadNameInput || defaultName;
    const finalAuthor = authorInput || defaultAuthor || 'User';
    const finalOffer = Number.isFinite(offerInputValue) && offerInputValue > 0 ? offerInputValue : defaultOffer;
    const finalDescription = descriptionInput || `Manual road proposal affecting ${affectedParcels.length} parcel${affectedParcels.length === 1 ? '' : 's'}.`;

    // --- Create a Proposal ---
    // 1. Get the full GeoJSON features of parent parcels
    const parentFeatures = affectedParcels.map(p => {
        // We need a deep copy so the original features in parcelLayer are not mutated
        return JSON.parse(JSON.stringify(p.layer.feature));
    });

    // 2. Create the proposal
    const proposal = ProposalManager.createProposal({
        name: finalRoadName,
        type: 'road',
        definition: {
            points: roadPoints,
            width: roadWidth,
            metadata: {
                author: finalAuthor,
                offer: finalOffer,
                description: finalDescription
            }
        },
        parentFeatures: parentFeatures,
        author: finalAuthor,
        description: finalDescription,
        offer: finalOffer,
        budget: finalOffer
    });

    if (proposal && proposal.onchain) {
        parentFeatures.forEach(feature => {
            if (!feature || !feature.properties) return;
            feature.properties.onchainProposal = { ...proposal.onchain };
        });
    }

    // 3. Apply the proposal to the map
    if (!proposal || !proposal.proposalHash) {
        if (typeof showEphemeralMessage === 'function') {
            showEphemeralMessage('Road proposal already exists or could not be saved. Review proposals for details.', 6000, 'error');
        }
        if (typeof updateStatus === 'function') {
            updateStatus('Review proposal before applying.');
        }
        if (typeof enableShowProposalsMode === 'function') {
            enableShowProposalsMode();
        }
        if (typeof showAllProposalsModal === 'function') {
            setTimeout(() => {
                try { showAllProposalsModal(); } catch (err) { console.warn('Failed to open proposals modal', err); }
            }, 50);
        }
        return;
    }

    let onchainResult = null;
    const shouldMintOnchain = typeof window.ProposalChainBridge !== 'undefined'
        && window.ProposalChainBridge.isSupported()
        && window.walletManager
        && proposal?.parentFeatures?.length;

    const screenshotPolygonForMint = convertRoadPolygonToLatLngPairs(roadPolygon);
    const parcelPolygonsForMint = buildParcelPolygonLatLngs(affectedParcels);

    if (shouldMintOnchain) {
        try {
            const ids = proposal.parentFeatures
                .map(feature => window.ProposalChainBridge.deriveParcelIdFromFeature(feature))
                .filter(Boolean);

            if (!ids.length) {
                console.warn('No parcel IDs could be derived for on-chain minting.');
            } else {
                if (!window.MapScreenshot || typeof window.MapScreenshot.capturePolygonImage !== 'function') {
                    throw new Error('Map screenshot capture is not available.');
                }
                if (!window.AssetService || typeof window.AssetService.uploadProposalAssets !== 'function') {
                    throw new Error('Asset upload service is not available.');
                }
                if (!screenshotPolygonForMint || screenshotPolygonForMint.length < 3) {
                    throw new Error('Unable to derive proposal polygon for NFT metadata.');
                }

                let assetUploadResult = null;
                let metadataUri = '';

                try {
                    const screenshotDataUrl = await window.MapScreenshot.capturePolygonImage({
                        polygon: screenshotPolygonForMint,
                        parcelPolygons: parcelPolygonsForMint,
                        padding: 0.05,
                        size: 600
                    });

                    const ethAmountValue = formState.ethAmount !== undefined && formState.ethAmount !== null
                        ? Number(formState.ethAmount)
                        : null;

                    const metadataPayload = {
                        name: finalRoadName,
                        description: finalDescription,
                        image: '', // populated after image upload
                        attributes: [
                            {
                                trait_type: 'Proposal Type',
                                value: 'Road'
                            },
                            {
                                trait_type: 'Conditional',
                                value: Boolean(formState.isConditional) ? 'Yes' : 'No'
                            },
                            {
                                trait_type: 'Parcel Count',
                                value: ids.length
                            },
                            {
                                trait_type: 'Road Width (m)',
                                value: Number.isFinite(roadWidth) ? Number(roadWidth).toFixed(2) : 'N/A'
                            }
                        ],
                        properties: {
                            parcelIds: ids,
                            conditional: Boolean(formState.isConditional),
                            ethAmount: ethAmountValue,
                            createdAt: new Date().toISOString(),
                            proposalHash: proposal.proposalHash || null
                        }
                    };

                    const fileNameBase = proposal.proposalHash || proposal.id || `road-proposal-${Date.now()}`;
                    assetUploadResult = await window.AssetService.uploadProposalAssets({
                        imageData: screenshotDataUrl,
                        metadata: metadataPayload,
                        fileName: `${fileNameBase}.png`
                    });
                    metadataUri = assetUploadResult?.metadataUri || assetUploadResult?.metadataUrl || '';
                    console.log('Asset upload result:', {
                        metadataUri,
                        metadataGatewayUrl: assetUploadResult?.metadataGatewayUrl,
                        imageUri: assetUploadResult?.imageUri,
                        imageGatewayUrl: assetUploadResult?.imageGatewayUrl
                    });
                    if (!metadataUri) {
                        throw new Error('Metadata URI missing from asset upload response.');
                    }
                } catch (assetError) {
                    console.error('Failed to prepare proposal assets for on-chain minting:', assetError);
                    throw assetError instanceof Error ? assetError : new Error('Failed to prepare assets for on-chain minting.');
                }

                onchainResult = await window.ProposalChainBridge.mintRoadProposal({
                    parcelIds: ids,
                    isConditional: Boolean(formState.isConditional),
                    ethAmount: formState.ethAmount,
                    tokenAmount: 0n,
                    imageURI: metadataUri
                });

                proposal.onchain = {
                    transactionHash: onchainResult.transactionHash,
                    proposalId: onchainResult.proposalId,
                    chainId: onchainResult.chainId,
                    contractAddress: onchainResult.contractAddress,
                    metadataUri,
                    metadataUrl: assetUploadResult?.metadataGatewayUrl || null,
                    imageUri: assetUploadResult?.imageUri || null,
                    imageUrl: assetUploadResult?.imageGatewayUrl || null
                };

                if (proposal.proposalHash && typeof proposalStorage !== 'undefined') {
                    const stored = proposalStorage.getProposal(proposal.proposalHash);
                    if (stored) {
                        stored.onchain = { ...proposal.onchain };
                        proposalStorage.proposals.set(proposal.proposalHash, stored);
                        if (typeof proposalStorage.save === 'function') {
                            proposalStorage.save();
                        }
                    }
                }
            }
        } catch (error) {
            console.error('On-chain mint failed:', error);
            if (typeof showEphemeralMessage === 'function') {
                showEphemeralMessage(error.message || 'On-chain proposal mint failed.', 6000, 'error');
            }
        }

        if (!onchainResult) {
            if (proposal.proposalHash && typeof proposalStorage !== 'undefined') {
                proposalStorage.removeProposal(proposal.proposalHash);
            }
            return;
        }
    }

    const applied = ProposalManager.applyProposal(proposal.proposalHash);
    if (!applied) {
        if (typeof proposalStorage !== 'undefined' && proposalStorage.removeProposal) {
            try { proposalStorage.removeProposal(proposal.proposalHash); } catch (err) { console.warn('Failed to remove unapplied road proposal', err); }
        }
        if (typeof showEphemeralMessage === 'function') {
            showEphemeralMessage('Failed to apply road proposal. Review proposals for details.', 6000, 'error');
        }
        if (typeof updateStatus === 'function') {
            updateStatus('Review proposal before applying.');
        }
        if (typeof enableShowProposalsMode === 'function') {
            enableShowProposalsMode();
        }
        if (typeof showAllProposalsModal === 'function') {
            setTimeout(() => {
                try { showAllProposalsModal(); } catch (err) { console.warn('Failed to open proposals modal', err); }
            }, 50);
        }
        return;
    }

    // 4. Clean up the road drawing UI
    resetRoadDrawing();
    toggleRoadDrawTool();

    updateStatus(`Road proposal "${finalRoadName}" created and applied.`);
}

// Cancel road drawing
function cancelRoadDrawing() {
    // Re-enable buttons if they were disabled
    const finishRoadButton = document.getElementById('finishRoadButton');
    const cancelRoadButton = document.getElementById('cancelRoadButton');
    if (finishRoadButton) finishRoadButton.disabled = false;
    if (cancelRoadButton) cancelRoadButton.disabled = false;

    // Clean up road name input and create button if they exist
    const roadInfoPanel = document.getElementById('road-info-panel');
    if (roadInfoPanel) {
        const roadNameSection = document.getElementById('road-name-section');
        const createButtonSection = document.getElementById('road-create-button-section');

        if (roadNameSection) roadInfoPanel.removeChild(roadNameSection);
        if (createButtonSection) roadInfoPanel.removeChild(createButtonSection);
    }

    resetRoadDrawing();
    toggleRoadDrawTool();
}

// Reset road drawing variables and state
function resetRoadDrawing(hidePanel = true) {
    roadPoints = [];
    roadWidth = 2;
    roadHasStarted = false;
    roadAffectedParcels = [];

    // Clear any existing road layers
    if (roadCenterline) {
        map.removeLayer(roadCenterline);
        roadCenterline = null;
    }

    // Correctly remove the committed road preview layer (roadPolygonLayer)
    // The global 'roadPolygon' variable stores geometry, not the layer itself.
    if (roadPolygonLayer && map.hasLayer(roadPolygonLayer)) {
        map.removeLayer(roadPolygonLayer);
        roadPolygonLayer = null;
    }
    roadPolygon = null; // Also clear the geometry variable

    if (roadPreviewLine) {
        map.removeLayer(roadPreviewLine);
        roadPreviewLine = null;
    }

    if (roadPreviewPolygonLayer) {
        roadPreviewPolygonLayer.removeFrom(map);
        roadPreviewPolygonLayer = null;
    }

    // Remove any road markers
    for (const marker of roadMarkers) {
        if (marker && map.hasLayer(marker)) {
            map.removeLayer(marker);
        }
    }
    roadMarkers = [];

    // Hide road info panel if requested
    if (hidePanel) {
        document.getElementById('road-info-panel').classList.remove('visible');
    }

    // Clear affected parcels highlighting
    clearAffectedParcels();
}

// Add a helper function to clear affected parcels
function clearAffectedParcels() {
    if (roadAffectedParcels.length > 0) {
        parcelLayer.eachLayer(layer => {
            // Reset style for previously affected parcels
            if (roadAffectedParcels.some(p => p.id === layer.feature.properties.CESTICA_ID)) {
                const isRoad = PersistentStorage.getItem(`parcel_${layer.feature.properties.CESTICA_ID}_isRoad`) === 'true';
                layer.setStyle(isRoad ? roadStyle : normalStyle);
            }
        });
    }
    roadAffectedParcels = [];
}

// Helper function to clear highlighting for preview-affected parcels
function clearPreviewAffectedParcels() {
    if (roadPreviewAffectedParcels.length > 0) {
        parcelLayer.eachLayer(layer => {
            const parcelId = layer.feature.properties.CESTICA_ID;
            // Check if this layer was part of the last preview
            if (roadPreviewAffectedParcels.some(p => p.id === parcelId)) {
                // Check if it's also part of the *committed* affected parcels
                if (roadAffectedParcels.some(p => p.id === parcelId)) {
                    // It's committed, revert to committed style (green)
                    layer.setStyle({
                        fillColor: 'green',
                        fillOpacity: 0.6,
                        color: 'green',
                        weight: 3
                    });
                } else {
                    // Not committed, revert to its base style
                    const isMarkedAsRoad = PersistentStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
                    layer.setStyle(isMarkedAsRoad ? roadStyle : normalStyle);
                }
            }
        });
    }
    roadPreviewAffectedParcels = []; // Clear the preview list
    // Update UI to reflect preview cleared; fall back to committed count if any
    try {
        const parcelsSection = document.getElementById('road-parcels');
        if (parcelsSection) {
            parcelsSection.innerHTML = roadAffectedParcels.length > 0
                ? `${roadAffectedParcels.length} parcels affected`
                : 'None';
        }
    } catch (_) { }
}

function generateRandomRoadName() {
    const prefixes = ['Liberty', 'Oak', 'Maple', 'Harbor', 'Sunset', 'Riverside', 'Heritage', 'Unity', 'Cedar', 'Willow', 'Silver', 'Golden', 'Evergreen', 'Aurora', 'Lakeside'];
    const suffixes = ['Avenue', 'Boulevard', 'Road', 'Way', 'Street', 'Drive', 'Lane', 'Terrace', 'Parkway', 'Trail', 'Route'];
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)] || 'New';
    const suffix = suffixes[Math.floor(Math.random() * suffixes.length)] || 'Road';
    return `${prefix} ${suffix}`;
}

function generateRandomRoadOffer(min = 10000, max = 500000) {
    if (!isFinite(min) || !isFinite(max) || max <= min) {
        min = 10000;
        max = 500000;
    }
    const random = Math.random();
    const value = min + random * (max - min);
    // Round to nearest 1,000 for cleaner numbers
    return Math.round(value / 1000) * 1000;
}

function showRoadProposalModal({ defaultAuthor = '', defaultName = 'New Road', defaultOffer = 10000, affectedParcels = [], roadPolygon = null } = {}) {
    return new Promise((resolve, reject) => {
        try {
            if (typeof closeProposalDialog === 'function') {
                closeProposalDialog();
            }
        } catch (_) { }

        const existingModal = document.querySelector('.create-proposal-modal');
        if (existingModal) {
            try { existingModal.remove(); } catch (_) { }
        }

        const totalArea = affectedParcels.reduce((sum, parcel) => sum + (parcel?.area || 0), 0);

        const modal = document.createElement('div');
        modal.className = 'create-proposal-modal road-proposal-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');

        const parcelItems = affectedParcels.map(parcel => {
            const parcelNumber = parcel?.number || parcel?.id || 'Unknown';
            const area = parcel?.area || 0;
            return `<div class="proposal-parcel-item"><span class="parcel-number">Parcel ${parcelNumber}</span><span class="parcel-area">(${Math.round(area).toLocaleString('hr-HR')} m²)</span></div>`;
        }).join('');

        const screenshotPolygon = convertRoadPolygonToLatLngPairs(roadPolygon);

        // Fallback to the Leaflet polygon layer if needed
        if ((!screenshotPolygon || screenshotPolygon.length < 3) && roadPolygonLayer && typeof roadPolygonLayer.getLatLngs === 'function') {
            const latLngs = roadPolygonLayer.getLatLngs();
            const primaryRing = Array.isArray(latLngs) && latLngs.length > 0
                ? (Array.isArray(latLngs[0]) ? latLngs[0] : latLngs)
                : [];
            screenshotPolygon = primaryRing
                .map(latlng => {
                    if (latlng && typeof latlng.lat === 'number' && typeof latlng.lng === 'number') {
                        return [latlng.lat, latlng.lng];
                    }
                    return null;
                })
                .filter(Boolean);
        }

        // Derive bounds primarily for logging/fallback contexts
        let screenshotBounds = null;
        if (roadPolygonLayer && typeof roadPolygonLayer.getBounds === 'function') {
            screenshotBounds = roadPolygonLayer.getBounds();
        } else if (screenshotPolygon && screenshotPolygon.length >= 3 && typeof L !== 'undefined') {
            try {
                const latLngs = screenshotPolygon
                    .map(coord => Array.isArray(coord) && coord.length >= 2 ? L.latLng(coord[0], coord[1]) : null)
                    .filter(Boolean);
                if (latLngs.length) {
                    screenshotBounds = L.latLngBounds(latLngs);
                }
            } catch (error) {
                console.warn('Failed to calculate screenshot bounds from polygon:', error);
            }
        }

        if (screenshotBounds) {
            console.log('Screenshot bounds:', {
                source: roadPolygonLayer ? 'roadPolygonLayer' : 'roadPolygon',
                bounds: screenshotBounds.toBBoxString(),
                isValid: screenshotBounds.isValid()
            });
        }

        if (screenshotPolygon && screenshotPolygon.length >= 3) {
            const sample = screenshotPolygon.slice(0, Math.min(8, screenshotPolygon.length)).map(pt => {
                if (Array.isArray(pt) && pt.length >= 2) {
                    return `${pt[0].toFixed(8)}, ${pt[1].toFixed(8)}`;
                }
                if (pt && typeof pt.lat === 'number' && typeof pt.lng === 'number') {
                    return `${pt.lat.toFixed(8)}, ${pt.lng.toFixed(8)}`;
                }
                return pt;
            });
            console.log('Screenshot polygon sample (lat,lng):', sample);
        }

        const computedParcelPolygons = buildParcelPolygonLatLngs(affectedParcels);

        modal.innerHTML = `
            <div class="proposal-modal-content">
                <div class="proposal-modal-header">
                    <h2>Create Road Proposal</h2>
                    <button type="button" class="proposal-modal-close close-circle-btn close-circle-btn--lg" aria-label="Close">&times;</button>
                </div>
                <div class="proposal-modal-body">
                    ${(screenshotPolygon && screenshotPolygon.length >= 3) ? '<div class="form-group" id="roadProposalScreenshotContainer" style="margin-bottom: 15px;"></div>' : ''}
                    <div class="form-group">
                        <label for="roadProposalAuthor">Author:</label>
                        <input type="text" id="roadProposalAuthor" placeholder="Your name">
                    </div>
                    <div class="form-group">
                        <label for="roadProposalName">Road Name:</label>
                        <input type="text" id="roadProposalName" placeholder="e.g. Sunset Boulevard">
                    </div>
                    <div class="form-group">
                        <label for="roadProposalOffer">Offer (EUR):</label>
                        <input type="number" id="roadProposalOffer" min="0" step="1000" placeholder="0">
                    </div>
                    <div class="form-group">
                        <label for="roadProposalDescription">Description:</label>
                        <textarea id="roadProposalDescription" rows="3" placeholder="Describe your road proposal..."></textarea>
                    </div>
                    <div class="proposal-summary">
                        <div class="summary-stats">
                            <p><strong>Parcels Affected:</strong> ${affectedParcels.length}</p>
                            <p><strong>Total Area:</strong> ${Math.round(totalArea).toLocaleString('hr-HR')} m²</p>
                        </div>
                        <div class="parcel-list">
                            <h4>Affected Parcels:</h4>
                            ${parcelItems || '<div class="proposal-parcel-item">No parcels detected.</div>'}
                        </div>
                    </div>
                </div>
                <div class="proposal-modal-footer">
                    <button type="button" class="btn btn-secondary" id="roadProposalCancelBtn">Cancel</button>
                    <button type="button" class="btn btn-proposal" id="roadProposalConfirmBtn">Create Proposal</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        const authorInput = modal.querySelector('#roadProposalAuthor');
        const nameInput = modal.querySelector('#roadProposalName');
        const offerInput = modal.querySelector('#roadProposalOffer');
        const descriptionInput = modal.querySelector('#roadProposalDescription');
        const cancelButton = modal.querySelector('#roadProposalCancelBtn');
        const confirmButton = modal.querySelector('#roadProposalConfirmBtn');
        const closeButton = modal.querySelector('.proposal-modal-close');

        if (authorInput) authorInput.value = defaultAuthor || '';
        if (nameInput) nameInput.value = defaultName;
        if (offerInput) offerInput.value = Number.isFinite(defaultOffer) ? defaultOffer : '';

        const cleanup = () => {
            modal.removeEventListener('keydown', handleKeyDown, true);
            if (confirmButton) confirmButton.removeEventListener('click', handleSubmit);
            if (cancelButton) cancelButton.removeEventListener('click', handleCancel);
            if (closeButton) closeButton.removeEventListener('click', handleCancel);
            modal.removeEventListener('click', handleOverlayClick);
            if (modal.parentNode) {
                modal.parentNode.removeChild(modal);
            }
        };

        const handleCancel = () => {
            cleanup();
            reject(new Error('cancelled'));
        };

        const handleSubmit = () => {
            const nameValue = (nameInput?.value || '').trim() || defaultName;
            const authorValue = (authorInput?.value || '').trim() || defaultAuthor || 'User';
            const descriptionValue = (descriptionInput?.value || '').trim();
            const offerValueRaw = offerInput ? parseFloat(offerInput.value) : NaN;
            const offerValue = Number.isFinite(offerValueRaw) && offerValueRaw > 0 ? offerValueRaw : defaultOffer;

            if (offerInput) offerInput.value = offerValue;
            if (nameInput) nameInput.value = nameValue;

            cleanup();
            resolve({
                roadName: nameValue,
                author: authorValue,
                description: descriptionValue,
                offer: offerValue,
                form: {
                    ethAmount: offerValue,
                    isConditional: true
                }
            });
        };

        const handleOverlayClick = (event) => {
            if (event.target === modal) {
                handleCancel();
            }
        };

        const handleKeyDown = (event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
                event.preventDefault();
                handleSubmit();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                handleCancel();
            }
        };

        modal.addEventListener('keydown', handleKeyDown, true);
        modal.addEventListener('click', handleOverlayClick);

        if (confirmButton) confirmButton.addEventListener('click', handleSubmit);
        if (cancelButton) cancelButton.addEventListener('click', handleCancel);
        if (closeButton) closeButton.addEventListener('click', handleCancel);

        // Capture and display screenshot if bounds are available
        if (screenshotPolygon && screenshotPolygon.length >= 3 && window.MapScreenshot) {
            const screenshotContainer = modal.querySelector('#roadProposalScreenshotContainer');
            if (screenshotContainer) {
                (async () => {
                    try {
                        const previewWrapper = document.createElement('div');
                        previewWrapper.className = 'map-screenshot-container';
                        previewWrapper.style.margin = '0 auto';
                        screenshotContainer.appendChild(previewWrapper);

                        window.MapScreenshot.renderPolygonPreview(previewWrapper, {
                            polygon: screenshotPolygon,
                            bounds: screenshotBounds,
                            padding: 0.05,
                            parcelPolygons: computedParcelPolygons
                        });
                    } catch (error) {
                        console.warn('Failed to capture map screenshot:', error);
                        screenshotContainer.innerHTML = '';
                        const fallbackDiv = document.createElement('div');
                        fallbackDiv.className = 'map-screenshot-container';
                        fallbackDiv.style.color = '#999';
                        fallbackDiv.textContent = 'Preview unavailable';
                        screenshotContainer.appendChild(fallbackDiv);
                    }
                })();
            }
        }

        requestAnimationFrame(() => {
            if (nameInput) {
                nameInput.focus();
                nameInput.select();
            }
        });
    });
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

// Create a wedge polygon at a joint to fill the outer angle gap between two segments
function createJointWedgePolygon(prevPoint, jointPoint, nextPoint, width) {
    // Validate inputs
    if (!prevPoint || !jointPoint || !nextPoint || !isFinite(width) || width <= 0) {
        return null;
    }

    if (!isFinite(prevPoint.lat) || !isFinite(prevPoint.lng) ||
        !isFinite(jointPoint.lat) || !isFinite(jointPoint.lng) ||
        !isFinite(nextPoint.lat) || !isFinite(nextPoint.lng)) {
        return null;
    }

    // Convert to HTRS96/TM meters
    const p0 = wgs84ToHTRS96(prevPoint.lat, prevPoint.lng);
    const pj = wgs84ToHTRS96(jointPoint.lat, jointPoint.lng);
    const p1 = wgs84ToHTRS96(nextPoint.lat, nextPoint.lng);

    if (!isValidPoint(p0) || !isValidPoint(pj) || !isValidPoint(p1)) {
        return null;
    }

    const v1 = [pj[0] - p0[0], pj[1] - p0[1]]; // incoming dir
    const v2 = [p1[0] - pj[0], p1[1] - pj[1]]; // outgoing dir

    const len1 = Math.hypot(v1[0], v1[1]);
    const len2 = Math.hypot(v2[0], v2[1]);
    if (len1 < 1e-6 || len2 < 1e-6) {
        return null;
    }

    const u1 = [v1[0] / len1, v1[1] / len1];
    const u2 = [v2[0] / len2, v2[1] / len2];

    // Left normals for each segment
    const n1L = [-u1[1], u1[0]];
    const n2L = [-u2[1], u2[0]];
    // Right normals are negatives
    const n1R = [u1[1], -u1[0]];
    const n2R = [u2[1], -u2[0]];

    // Determine turn direction: positive => left turn
    const cross = u1[0] * u2[1] - u1[1] * u2[0];
    const outerIsRight = cross > 0; // inner on left when turning left

    const halfWidth = width / 2;

    // Pick outer normals
    const n1 = outerIsRight ? n1R : n1L;
    const n2 = outerIsRight ? n2R : n2L;

    // Offset points at the joint on the outer side
    const pA = [pj[0] + n1[0] * halfWidth, pj[1] + n1[1] * halfWidth];
    const pB = [pj[0] + n2[0] * halfWidth, pj[1] + n2[1] * halfWidth];

    // Intersect offset edge lines: L1: pA + t * u1; L2: pB + s * u2
    const r = [pB[0] - pA[0], pB[1] - pA[1]];
    const denom = u1[0] * u2[1] - u1[1] * u2[0];

    let miterPoint = null;
    if (Math.abs(denom) > 1e-8) {
        const t = (r[0] * u2[1] - r[1] * u2[0]) / denom;
        miterPoint = [pA[0] + t * u1[0], pA[1] + t * u1[1]];
    }

    // Miter limit to avoid spikes for very acute angles
    const miterLimit = 4; // times halfWidth
    let wedgeHTRS;
    if (miterPoint) {
        const dx = miterPoint[0] - pj[0];
        const dy = miterPoint[1] - pj[1];
        const miterLen = Math.hypot(dx, dy);
        if (miterLen > miterLimit * halfWidth) {
            // Use bevel: connect with a triangle to a capped midpoint along outer bisector
            const bisector = [n1[0] + n2[0], n1[1] + n2[1]];
            const bisLen = Math.hypot(bisector[0], bisector[1]) || 1;
            const cap = [pj[0] + (bisector[0] / bisLen) * halfWidth, pj[1] + (bisector[1] / bisLen) * halfWidth];
            wedgeHTRS = [pA, cap, pB, pA];
        } else {
            // Miter triangle
            wedgeHTRS = [pA, miterPoint, pB, pA];
        }
    } else {
        // Nearly parallel; bevel join
        const bisector = [n1[0] + n2[0], n1[1] + n2[1]];
        const bisLen = Math.hypot(bisector[0], bisector[1]) || 1;
        const cap = [pj[0] + (bisector[0] / bisLen) * halfWidth, pj[1] + (bisector[1] / bisLen) * halfWidth];
        wedgeHTRS = [pA, cap, pB, pA];
    }

    // Convert back to WGS84 lat/lngs and return as Leaflet LatLng[]
    const result = [];
    for (const pt of wedgeHTRS) {
        const [lat, lng] = htrs96ToWGS84(pt[0], pt[1]);
        if (isFinite(lat) && isFinite(lng)) {
            result.push(L.latLng(lat, lng));
        }
    }

    return result.length >= 3 ? result : null;
}

// Combine two road polygons using Turf's union operation
function combineRoadPolygons(polygon1, polygon2) {
    // Validate inputs
    if (!polygon1 && polygon2) return polygon2;
    if (polygon1 && !polygon2) return polygon1;
    if (!polygon1 && !polygon2) return null;

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

// Check if a parcel number exists
function parcelNumberExists(number) {
    // Check parcelLayer
    if (window.parcelLayer && typeof window.parcelLayer.eachLayer === 'function') {
        let exists = false;
        window.parcelLayer.eachLayer(layer => {
            if (layer && layer.feature && layer.feature.properties &&
                layer.feature.properties.BROJ_CESTICE === number) {
                exists = true;
            }
        });
        if (exists) return true;
    }

    // Check PersistentStorage
    for (let i = 0; i < PersistentStorage.length; i++) {
        const key = PersistentStorage.key(i);
        if (key.startsWith('parcel_') && key.endsWith('_properties')) {
            try {
                const properties = JSON.parse(PersistentStorage.getItem(key));
                if (properties && properties.BROJ_CESTICE === number) {
                    return true;
                }
            } catch (e) {
                console.warn('Error parsing properties from PersistentStorage:', e);
            }
        }
    }
    return false;
}

// Find next available number
function findNextAvailableSubNumber(baseNumber, usedNumbers = new Set()) {
    let counter = 1;
    while (parcelNumberExists(`${baseNumber}/${counter}`) || usedNumbers.has(`${baseNumber}/${counter}`)) {
        counter++;
    }
    return counter;
}

// Helper function to hash geometry coordinates (rounded for robustness)
function geometryHash(coords) {
    return JSON.stringify(coords.map(ring => ring.map(
        pt => [Number(pt[0].toFixed(6)), Number(pt[1].toFixed(6))]
    )));
}

// Function to update parcel numbers and split parcels
// MOVED to proposal-manager.js

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

// New function to find and highlight preview-affected parcels
function findPreviewAffectedParcels(previewPolygon) {
    if (!previewPolygon || !parcelLayer) return;

    // Clear previous preview highlights
    clearPreviewAffectedParcels();

    const newPreviewAffected = [];
    const roadLatLngs = previewPolygon.map(p => [p.lng, p.lat]);
    const closedRoadLatLngs = ensurePolygonIsClosed(roadLatLngs);
    if (closedRoadLatLngs.length < 4) return; // Need at least 4 points for a valid polygon

    let turfRoadPolygon;
    try {
        turfRoadPolygon = turf.polygon([closedRoadLatLngs]);
    } catch (error) {
        return; // Silent error
    }

    const mapBounds = map.getBounds();

    parcelLayer.eachLayer(layer => {
        try {
            const layerBounds = layer.getBounds();
            if (!mapBounds.intersects(layerBounds)) return;

            const parcelId = layer.feature.properties.CESTICA_ID;
            const outerRings = getParcelOuterRingsLngLat(layer);
            if (!outerRings || outerRings.length === 0) return;

            for (let r = 0; r < outerRings.length; r++) {
                const ring = outerRings[r];
                const closedRing = ensurePolygonIsClosed(ring);
                if (!closedRing || closedRing.length < 4) continue;
                const turfParcelPolygon = turf.polygon([closedRing]);

                if (turf.booleanIntersects(turfRoadPolygon, turfParcelPolygon)) {
                    newPreviewAffected.push({ id: parcelId, layer: layer });

                    // Apply preview style only if not already committed (green)
                    if (!roadAffectedParcels.some(p => p.id === parcelId)) {
                        layer.setStyle(previewAffectedStyle);
                        if (typeof layer.bringToFront === 'function') {
                            layer.bringToFront();
                        }
                    }
                    break; // No need to check further rings
                }
            }
        } catch (error) {
            // Silent error handling for individual parcels
        }
    });

    roadPreviewAffectedParcels = newPreviewAffected; // Update the global state

    // Update UI with PREVIEW count (takes precedence over committed during move)
    try {
        const parcelsSection = document.getElementById('road-parcels');
        if (parcelsSection) {
            parcelsSection.innerHTML = roadPreviewAffectedParcels.length > 0
                ? `${roadPreviewAffectedParcels.length} parcels affected`
                : (roadAffectedParcels.length > 0
                    ? `${roadAffectedParcels.length} parcels affected`
                    : 'None');
        }
    } catch (_) { }
}

