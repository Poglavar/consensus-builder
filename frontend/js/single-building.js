// Single Building modal and placement
// Creates a draggable rectangle within the currently selected block (union polygon),
// with sliders for length, width, height, and chamfer.

(function () {
    let singleModal = null;
    let singleMap = null;
    let singleBlockLayer = null;
    let singleRectLayer = null;
    let singleDragMarker = null;
    let singleBlockFeature = null;
    let lastValidCenter = null; // LatLng of last valid rectangle center

    // Dimensions in meters
    const DEFAULT_LENGTH_M = 6; // along Y
    const DEFAULT_WIDTH_M = 3;  // along X
    const DEFAULT_HEIGHT_M = 10; // meters
    const DEFAULT_CHAMFER_M = 0; // meters
    let currentLengthM = DEFAULT_LENGTH_M;
    let currentWidthM = DEFAULT_WIDTH_M;
    let currentHeightM = DEFAULT_HEIGHT_M;
    let currentChamferM = DEFAULT_CHAMFER_M;

    // Proposed building collection shares the same layer/array as blockify
    if (typeof window !== 'undefined') {
        try { if (!Array.isArray(window.proposedBuildings)) window.proposedBuildings = []; } catch (_) { }
    }

    function getSelectedBlockFeature() {
        try {
            if (typeof selectedBlockName === 'undefined' || !selectedBlockName) return null;
            if (typeof blockStorage === 'undefined' || !blockStorage || !blockStorage.blocks || !blockStorage.blocks.has(selectedBlockName)) return null;
            const blk = blockStorage.blocks.get(selectedBlockName);
            if (!blk || !Array.isArray(blk.parcels) || blk.parcels.length === 0) return null;
            const parcelFeatures = blk.parcels.map(p => p.feature);
            // Use robust union and reduce to largest polygon if available from building-blocks.js
            let unioned = null;
            try { unioned = robustUnion(parcelFeatures); } catch (_) { unioned = null; }
            if (!unioned) {
                // Fallback to manual union via turf.union sequentially
                try {
                    let acc = parcelFeatures[0];
                    for (let i = 1; i < parcelFeatures.length; i++) {
                        try { acc = turf.union(acc, parcelFeatures[i]) || acc; } catch (_) { }
                    }
                    unioned = acc;
                } catch (_) { unioned = parcelFeatures[0]; }
            }
            try { unioned = toSingleLargestPolygon(unioned) || unioned; } catch (_) { }
            return unioned;
        } catch (_) { return null; }
    }

    function ensureClosed(ring) {
        if (!Array.isArray(ring) || ring.length < 3) return ring;
        const a = ring[0], b = ring[ring.length - 1];
        if (a[0] !== b[0] || a[1] !== b[1]) {
            return [...ring, [a[0], a[1]]];
        }
        return ring;
    }

    function buildRectangleFeature(centerLatLng, widthM, lengthM, chamferM, heightM) {
        // Build axis-aligned rectangle in meters around center, then convert to lat/lng via local metric frame
        const [cx, cy] = wgs84ToHTRS96(centerLatLng.lat, centerLatLng.lng);
        const halfW = Math.max(0.5, widthM / 2);
        const halfL = Math.max(0.5, lengthM / 2);
        // Clamp chamfer to feasible range
        const maxChamferX = Math.max(0, halfW - 0.1);
        const maxChamferY = Math.max(0, halfL - 0.1);
        const dX = Math.min(Math.max(0, chamferM || 0), maxChamferX);
        const dY = Math.min(Math.max(0, chamferM || 0), maxChamferY);

        let pts;
        if (dX > 0 || dY > 0) {
            const left = cx - halfW, right = cx + halfW, bottom = cy - halfL, top = cy + halfL;
            // 8-point chamfered rectangle ring (counter-clockwise)
            pts = [
                [left + dX, bottom],
                [right - dX, bottom],
                [right, bottom + dY],
                [right, top - dY],
                [right - dX, top],
                [left + dX, top],
                [left, top - dY],
                [left, bottom + dY]
            ];
        } else {
            pts = [
                [cx - halfW, cy - halfL],
                [cx + halfW, cy - halfL],
                [cx + halfW, cy + halfL],
                [cx - halfW, cy + halfL]
            ];
        }

        const ring = pts.map(([x, y]) => {
            const [lat, lng] = htrs96ToWGS84(x, y);
            return [lng, lat];
        });
        const closed = ensureClosed(ring);
        return {
            type: 'Feature',
            properties: { type: 'proposedBuildingSingle', width: widthM, length: lengthM, height: heightM || DEFAULT_HEIGHT_M, chamfer: chamferM || 0, block: (typeof selectedBlockName !== 'undefined' ? selectedBlockName : null) },
            geometry: { type: 'Polygon', coordinates: [closed] }
        };
    }

    function rectangleFullyInsideBlock(rectFeature, blockFeature) {
        try {
            if (!rectFeature || !blockFeature) return false;
            // Require rectangle polygon to be fully within the block polygon
            return turf.booleanWithin(rectFeature, blockFeature);
        } catch (_) { return false; }
    }

    function getBlockCentroid(blockFeature) {
        try {
            const c = turf.centroid(blockFeature);
            const [lng, lat] = c.geometry.coordinates;
            return L.latLng(lat, lng);
        } catch (_) {
            // fallback: use bounds center
            try {
                const layer = L.geoJSON(blockFeature);
                const b = layer.getBounds().getCenter();
                return L.latLng(b.lat, b.lng);
            } catch (__) { return map.getCenter(); }
        }
    }

    function drawBlockOnModal(blockFeature) {
        if (singleBlockLayer) {
            singleMap.removeLayer(singleBlockLayer);
            singleBlockLayer = null;
        }
        singleBlockLayer = L.geoJSON(blockFeature, {
            style: { color: 'red', weight: 2, fillColor: 'red', fillOpacity: 0.2 }
        }).addTo(singleMap);
        singleMap.fitBounds(singleBlockLayer.getBounds(), { padding: [40, 40] });
    }

    function placeOrAdjustRectangle(centerLatLng) {
        if (!singleBlockFeature) return;
        let feature = buildRectangleFeature(centerLatLng, currentWidthM, currentLengthM, currentChamferM, currentHeightM);
        // If not fully inside, try to nudge towards centroid until it fits (limited attempts)
        if (!rectangleFullyInsideBlock(feature, singleBlockFeature)) {
            const centroid = getBlockCentroid(singleBlockFeature);
            const [cx, cy] = [centroid.lat, centroid.lng];
            const maxIters = 12;
            let current = centerLatLng;
            for (let i = 0; i < maxIters; i++) {
                const dx = (cx - current.lat) * 0.5;
                const dy = (cy - current.lng) * 0.5;
                current = L.latLng(current.lat + dx, current.lng + dy);
                const candidate = buildRectangleFeature(current, currentWidthM, currentLengthM, currentChamferM, currentHeightM);
                if (rectangleFullyInsideBlock(candidate, singleBlockFeature)) {
                    feature = candidate;
                    break;
                }
            }
        }

        if (singleRectLayer) { singleMap.removeLayer(singleRectLayer); singleRectLayer = null; }
        singleRectLayer = L.geoJSON(feature, {
            style: { color: '#007bff', weight: 3, fillOpacity: 0.2 }
        }).addTo(singleMap);

        // Add/Move drag marker at rectangle centroid
        try {
            const c = turf.centroid(feature);
            const [lng, lat] = c.geometry.coordinates;
            const ll = L.latLng(lat, lng);
            if (!singleDragMarker) {
                singleDragMarker = L.marker(ll, { draggable: true }).addTo(singleMap);
                singleDragMarker.on('drag', (e) => {
                    const newCenter = e.latlng;
                    const candidate = buildRectangleFeature(newCenter, currentWidthM, currentLengthM, currentChamferM, currentHeightM);
                    if (rectangleFullyInsideBlock(candidate, singleBlockFeature)) {
                        if (singleRectLayer) singleMap.removeLayer(singleRectLayer);
                        singleRectLayer = L.geoJSON(candidate, { style: { color: '#007bff', weight: 3, fillOpacity: 0.2 } }).addTo(singleMap);
                        lastValidCenter = newCenter;
                    } else {
                        // Revert marker position if drag would violate containment
                        const revertTo = lastValidCenter || ll;
                        try { singleDragMarker.setLatLng(revertTo); } catch (_) { }
                    }
                });
            } else {
                singleDragMarker.setLatLng(ll);
            }
            lastValidCenter = ll;
        } catch (_) { }
    }

    function closeSingleBuildingModal() {
        if (singleMap) {
            if (singleBlockLayer) try { singleMap.removeLayer(singleBlockLayer); } catch (_) { }
            if (singleRectLayer) try { singleMap.removeLayer(singleRectLayer); } catch (_) { }
            try { singleMap.remove(); } catch (_) { }
            singleMap = null;
            singleBlockLayer = null;
            singleRectLayer = null;
            singleDragMarker = null;
        }
        singleBlockFeature = null;
        if (singleModal) {
            try { document.body.removeChild(singleModal); } catch (_) { }
            singleModal = null;
        }
        if (map && map.invalidateSize) map.invalidateSize();
    }

    function confirmSingleBuilding() {
        if (!singleRectLayer) return;
        let feature = null;
        try { singleRectLayer.eachLayer(l => { if (!feature && l.toGeoJSON) feature = l.toGeoJSON(); }); } catch (_) { }
        if (!feature) return;
        // Push to proposed buildings and refresh
        try {
            // Ensure height metadata is present
            if (!feature.properties) feature.properties = {};
            if (!isFinite(Number(feature.properties.height))) feature.properties.height = Math.round(Number(currentHeightM || DEFAULT_HEIGHT_M));
            if (typeof window.proposedBuildings !== 'undefined') {
                window.proposedBuildings.push(feature);
            }
            if (typeof updateProposedBuildingsLayer === 'function') updateProposedBuildingsLayer();
            const showProp = document.getElementById('showProposedBuildings');
            if (showProp) showProp.checked = true;
            if (typeof updateStatus === 'function') updateStatus(`Added single building ${currentWidthM.toFixed(1)}m x ${currentLengthM.toFixed(1)}m, h=${currentHeightM.toFixed(0)}m, chamfer=${currentChamferM.toFixed(1)}m`);
        } catch (_) { }
        closeSingleBuildingModal();
    }

    function showSingleBuildingModal() {
        singleBlockFeature = getSelectedBlockFeature();
        if (!singleBlockFeature) {
            if (typeof updateStatus === 'function') updateStatus('Select a block first');
            return;
        }

        if (!singleModal) {
            const modal = document.createElement('div');
            modal.id = 'single-building-modal';
            modal.style.position = 'fixed';
            modal.style.top = '0';
            modal.style.left = '0';
            modal.style.width = '100%';
            modal.style.height = '100%';
            modal.style.backgroundColor = 'rgba(0,0,0,0.5)';
            modal.style.zIndex = '1000';
            modal.style.display = 'flex';
            modal.style.alignItems = 'center';
            modal.style.justifyContent = 'center';

            const container = document.createElement('div');
            container.style.backgroundColor = 'white';
            container.style.borderRadius = '8px';
            container.style.display = 'flex';
            container.style.flexDirection = 'row';
            container.style.maxWidth = '90%';
            container.style.maxHeight = '90%';
            container.style.width = '1000px';
            container.style.height = '600px';

            container.innerHTML = (
                '<div style="flex:1;display:flex;flex-direction:column;min-width:0;">' +
                '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #eee;">' +
                '<h2 style="margin:0;font-size:18px;">Single Building</h2>' +
                '<button id="single-building-close" class="blockify-button">×</button>' +
                '</div>' +
                '<div id="single-building-map" style="flex:1;min-height:300px;"></div>' +
                '<div style="padding:10px;border-top:1px solid #eee;display:flex;gap:8px;justify-content:flex-end;">' +
                '<button id="single-building-confirm" class="btn btn-proposal">Create Proposal</button>' +
                '<button id="single-building-cancel" class="blockify-button">Cancel</button>' +
                '</div>' +
                '</div>' +
                '<div style="width:320px;border-left:1px solid #eee;padding:12px;">' +
                '<h3 style="margin-top:0">Parameters</h3>' +
                '<div class="parameter-group">' +
                '<label>Width (m): <span id="single-width-value">' + DEFAULT_WIDTH_M + '</span></label>' +
                '<input type="range" id="single-width-slider" min="1" max="100" step="0.5" value="' + DEFAULT_WIDTH_M + '">' +
                '</div>' +
                '<div class="parameter-group">' +
                '<label>Length (m): <span id="single-length-value">' + DEFAULT_LENGTH_M + '</span></label>' +
                '<input type="range" id="single-length-slider" min="1" max="100" step="0.5" value="' + DEFAULT_LENGTH_M + '">' +
                '</div>' +
                '<div class="parameter-group">' +
                '<label>Height (m): <span id="single-height-value">' + DEFAULT_HEIGHT_M + '</span></label>' +
                '<input type="range" id="single-height-slider" min="3" max="250" step="1" value="' + DEFAULT_HEIGHT_M + '">' +
                '</div>' +
                '<div class="parameter-group">' +
                '<label>Chamfer (m): <span id="single-chamfer-value">' + DEFAULT_CHAMFER_M + '</span></label>' +
                '<input type="range" id="single-chamfer-slider" min="0" max="10" step="0.5" value="' + DEFAULT_CHAMFER_M + '">' +
                '</div>' +
                '<p style="color:#666">Drag the rectangle to reposition. The building must remain fully within the block.</p>' +
                '</div>'
            );

            modal.appendChild(container);
            document.body.appendChild(modal);
            singleModal = modal;

            document.getElementById('single-building-close').addEventListener('click', closeSingleBuildingModal);
            document.getElementById('single-building-cancel').addEventListener('click', closeSingleBuildingModal);
            document.getElementById('single-building-confirm').addEventListener('click', confirmSingleBuilding);

            const wSlider = document.getElementById('single-width-slider');
            const lSlider = document.getElementById('single-length-slider');
            const hSlider = document.getElementById('single-height-slider');
            const cSlider = document.getElementById('single-chamfer-slider');
            wSlider.addEventListener('input', (e) => {
                currentWidthM = parseFloat(e.target.value);
                document.getElementById('single-width-value').textContent = currentWidthM.toFixed(1);
                // regenerate centered at current marker/centroid
                const c = singleDragMarker ? singleDragMarker.getLatLng() : getBlockCentroid(singleBlockFeature);
                placeOrAdjustRectangle(c);
            });
            lSlider.addEventListener('input', (e) => {
                currentLengthM = parseFloat(e.target.value);
                document.getElementById('single-length-value').textContent = currentLengthM.toFixed(1);
                const c = singleDragMarker ? singleDragMarker.getLatLng() : getBlockCentroid(singleBlockFeature);
                placeOrAdjustRectangle(c);
            });
            hSlider.addEventListener('input', (e) => {
                currentHeightM = parseFloat(e.target.value);
                document.getElementById('single-height-value').textContent = currentHeightM.toFixed(0);
                // No geometry change; affects 3D height rendering
            });
            cSlider.addEventListener('input', (e) => {
                currentChamferM = parseFloat(e.target.value);
                document.getElementById('single-chamfer-value').textContent = currentChamferM.toFixed(1);
                const c = singleDragMarker ? singleDragMarker.getLatLng() : getBlockCentroid(singleBlockFeature);
                placeOrAdjustRectangle(c);
            });

            // Close when clicking outside
            modal.addEventListener('click', (e) => { if (e.target === modal) closeSingleBuildingModal(); });
        }

        if (!singleMap) {
            singleMap = L.map('single-building-map', { zoomControl: true, dragging: true, scrollWheelZoom: true });
            L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '© OpenStreetMap contributors'
            }).addTo(singleMap);
        }

        drawBlockOnModal(singleBlockFeature);
        const startCenter = getBlockCentroid(singleBlockFeature);
        // First attempt is default 3m x 6m; if it doesn't fit due to tiny parcel, sliders allow changing
        currentWidthM = DEFAULT_WIDTH_M;
        currentLengthM = DEFAULT_LENGTH_M;
        currentHeightM = DEFAULT_HEIGHT_M;
        currentChamferM = DEFAULT_CHAMFER_M;
        const wEl = document.getElementById('single-width-slider');
        const lEl = document.getElementById('single-length-slider');
        const hEl = document.getElementById('single-height-slider');
        const cEl = document.getElementById('single-chamfer-slider');
        if (wEl) { wEl.value = currentWidthM; document.getElementById('single-width-value').textContent = currentWidthM.toFixed(1); }
        if (lEl) { lEl.value = currentLengthM; document.getElementById('single-length-value').textContent = currentLengthM.toFixed(1); }
        if (hEl) { hEl.value = currentHeightM; document.getElementById('single-height-value').textContent = currentHeightM.toFixed(0); }
        if (cEl) { cEl.value = currentChamferM; document.getElementById('single-chamfer-value').textContent = currentChamferM.toFixed(1); }
        placeOrAdjustRectangle(startCenter);
    }

    // Button handler exposed globally
    function singleBuildingOnSelectedBlock() {
        showSingleBuildingModal();
    }

    window.singleBuildingOnSelectedBlock = singleBuildingOnSelectedBlock;
})();


