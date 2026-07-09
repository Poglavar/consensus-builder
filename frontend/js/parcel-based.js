/**
 * Parcel-based Urban Rule functionality.
 * 
 * This file contains the functionality for parcel-based urban rules - generating
 * individual buildings per parcel with setback from borders and random floor counts.
 * 
 * Unlike block or row typology which work with superparcels, parcel-based typology
 * generates one building per parcel using configurable rules:
 * - min_distance: setback from parcel borders
 * - max_floors: random floors from 1 to max_floors per building
 */

(function () {
    // Modal state
    let parcelBasedModal = null;
    let parcelBasedMap = null;
    let parcelBasedParcelLayer = null;
    let parcelBasedBuildingLayers = [];
    let generatedParcelBasedFeatures = [];
    let parcelBasedBlockNameOverride = null;
    let parcelBasedBlock = null;
    let pendingParcelBasedProposalContext = null;

    // Default parameter values
    const DEFAULT_MAX_FLOORS = 5;
    const DEFAULT_MIN_DISTANCE = 3; // meters from parcel borders
    const DEFAULT_FLOOR_HEIGHT = 3; // meters per floor
    let currentMaxFloors = DEFAULT_MAX_FLOORS;
    let currentMinDistance = DEFAULT_MIN_DISTANCE;

    // Parameters to restore when the modal next opens, instead of the defaults. Set by
    // openParcelBasedForParcels({ initialParameters }); consumed once by showParcelBasedModal().
    let parcelBasedSeedParameters = null;

    // 3D preview state
    let parcelBased3D = {
        handle: null,
        renderer: null,
        scene: null,
        camera: null,
        controls: null,
        frameId: null,
        container: null,
        originHTRS: null,
        modelGroup: null,
        contextGroup: null,
        resizeHandler: null,
        hasCenteredOnce: false
    };
    let parcelBasedThreeLoadPromise = null;

    // Random colors for buildings
    const BUILDING_COLORS = [
        '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
        '#1abc9c', '#e67e22', '#34495e', '#16a085', '#c0392b',
        '#2980b9', '#27ae60', '#d35400', '#8e44ad', '#f1c40f'
    ];

    // Helper functions
    function formatParcelBasedText(template, params = {}) {
        if (!template) return '';
        return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
            return Object.prototype.hasOwnProperty.call(params, key) ? params[key] : match;
        });
    }

    function translateParcelBasedText(key, fallback, params = {}) {
        const api = (typeof window !== 'undefined' && window.i18n) ? window.i18n : null;
        if (api && typeof api.t === 'function') {
            return api.t(key, params);
        }
        return formatParcelBasedText(fallback, params);
    }

    function showParcelBasedAlert(key, fallback, params = {}) {
        const message = key
            ? translateParcelBasedText(`alerts.messages.${key}`, fallback, params)
            : translateParcelBasedText('', fallback, params);
        const alertFn = (typeof window !== 'undefined' && typeof window.showStyledAlert === 'function')
            ? window.showStyledAlert
            : window.alert;
        if (typeof alertFn === 'function') {
            alertFn(message);
        }
        return message;
    }

    function setParcelBasedInfo(key, fallback, params = {}) {
        const infoElement = document.getElementById('parcelbased-info');
        if (!infoElement) return;
        if (key) {
            infoElement.setAttribute('data-i18n-key', key);
            infoElement.setAttribute('data-i18n-attr', 'text');
        } else {
            infoElement.removeAttribute('data-i18n-key');
        }
        if (params && Object.keys(params).length > 0) {
            try {
                infoElement.setAttribute('data-i18n-params', JSON.stringify(params));
            } catch (_) {
                infoElement.removeAttribute('data-i18n-params');
            }
        } else {
            infoElement.removeAttribute('data-i18n-params');
        }
        infoElement.textContent = translateParcelBasedText(key, fallback, params);
    }

    function setPendingParcelBasedProposalContext(ctx) {
        pendingParcelBasedProposalContext = ctx || null;
        if (typeof window !== 'undefined') {
            window.pendingParcelBasedProposalContext = pendingParcelBasedProposalContext;
        }
    }

    function getParcelBasedDisplayName() {
        if (parcelBasedBlockNameOverride) return parcelBasedBlockNameOverride;
        return translateParcelBasedText('parcelBased.modal.messages.selectedParcels', 'Selected Parcels');
    }

    function getActiveParcelBasedBlock() {
        if (parcelBasedBlock && Array.isArray(parcelBasedBlock.parcels) && parcelBasedBlock.parcels.length > 0) {
            return parcelBasedBlock;
        }
        return null;
    }

    function describeParcelBasedParcelSelection(ids) {
        if (!Array.isArray(ids) || ids.length === 0) return translateParcelBasedText('parcelBased.modal.messages.selectedParcels', 'Selected Parcels');
        if (ids.length === 1) return translateParcelBasedText('parcelBased.modal.messages.singleParcelLabel', 'Parcel {{id}}', { id: ids[0] });
        return translateParcelBasedText('parcelBased.modal.messages.multiParcelLabel', '{{count}} Parcels', { count: ids.length });
    }

    function getRandomColor(index) {
        return BUILDING_COLORS[index % BUILDING_COLORS.length];
    }

    // --- Geometry utilities ---

    // Sanitize and convert polygon to single largest polygon
    function toSingleLargestPolygonLocal(feature) {
        if (typeof toSingleLargestPolygon === 'function') {
            return toSingleLargestPolygon(feature);
        }
        if (!feature || !feature.geometry) return feature;
        const geom = feature.geometry;
        if (geom.type === 'Polygon') return feature;
        if (geom.type === 'MultiPolygon') {
            let maxArea = -Infinity;
            let largestCoords = null;
            geom.coordinates.forEach(poly => {
                try {
                    const tempFeature = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: poly } };
                    const area = turf.area(tempFeature);
                    if (area > maxArea) {
                        maxArea = area;
                        largestCoords = poly;
                    }
                } catch (_) { }
            });
            if (largestCoords) {
                return {
                    type: 'Feature',
                    properties: feature.properties || {},
                    geometry: { type: 'Polygon', coordinates: largestCoords }
                };
            }
        }
        return feature;
    }

    // Generate a building polygon set back from the parcel border
    function generateSetbackPolygon(parcelFeature, minDistance) {
        if (!parcelFeature || !parcelFeature.geometry) return null;

        // Sanitize polygon first
        let feature = parcelFeature;
        if (typeof sanitizePolygonFeature === 'function') {
            feature = sanitizePolygonFeature(feature) || feature;
        }
        feature = toSingleLargestPolygonLocal(feature) || feature;

        if (!feature || !feature.geometry) return null;

        // Apply negative buffer (inward setback)
        try {
            const buffered = turf.buffer(feature, -minDistance / 1000, { units: 'kilometers', steps: 16 });
            if (!buffered || !buffered.geometry) {
                // If buffer results in nothing (parcel too small), return null
                return null;
            }
            // Ensure we have a valid polygon
            const result = toSingleLargestPolygonLocal(buffered);
            if (!result || !result.geometry) return null;

            // Check if resulting polygon has reasonable area
            const resultArea = turf.area(result);
            if (resultArea < 1) return null; // Less than 1 m² is too small

            return result;
        } catch (e) {
            console.warn('[ParcelBased] Error generating setback polygon:', e);
            return null;
        }
    }

    // Generate building for a single parcel
    function generateBuildingForParcel(parcel, index, minDistance, maxFloors) {
        const feature = parcel.feature;
        if (!feature) return null;

        // Get parcel ID for properties
        const props = feature.properties || {};
        const parcelId = typeof ensureParcelId === 'function'
            ? ensureParcelId(feature)
            : (props.parcelId || props.parcel_id || props.id || `parcel-${index}`);

        // Generate setback polygon
        const buildingPolygon = generateSetbackPolygon(feature, minDistance);
        if (!buildingPolygon) {
            console.warn(`[ParcelBased] Could not generate building for parcel ${parcelId} - polygon too small or invalid`);
            return null;
        }

        // Pick random number of floors between 1 and maxFloors
        const floors = Math.floor(Math.random() * maxFloors) + 1;
        const height = floors * DEFAULT_FLOOR_HEIGHT;

        // Set building properties
        buildingPolygon.properties = {
            type: 'proposedParcelBasedBuilding',
            parcelId: parcelId,
            floors: floors,
            height: height,
            minDistance: minDistance,
            maxFloors: maxFloors,
            color: getRandomColor(index),
            buildingIndex: index
        };

        return buildingPolygon;
    }

    // Generate all buildings for the block
    function generateBuildingsForBlock(block, minDistance, maxFloors) {
        if (!block || !Array.isArray(block.parcels) || block.parcels.length === 0) {
            return [];
        }

        const buildings = [];
        block.parcels.forEach((parcel, index) => {
            const building = generateBuildingForParcel(parcel, index, minDistance, maxFloors);
            if (building) {
                buildings.push(building);
            }
        });

        return buildings;
    }

    // Display buildings on the modal map
    function displayBuildingsInModal(features) {
        if (!parcelBasedMap) return;

        // Clear existing building layers
        parcelBasedBuildingLayers.forEach(layer => {
            if (parcelBasedMap && layer) {
                parcelBasedMap.removeLayer(layer);
            }
        });
        parcelBasedBuildingLayers = [];

        if (!Array.isArray(features) || features.length === 0) return;

        features.forEach((feature, index) => {
            if (!feature || !feature.geometry) return;

            const color = feature.properties?.color || getRandomColor(index);
            const layer = L.geoJSON(feature, {
                style: {
                    fillColor: color,
                    fillOpacity: 0.6,
                    color: color,
                    weight: 2
                }
            }).addTo(parcelBasedMap);

            // Add tooltip with building info
            const floors = feature.properties?.floors || 1;
            const parcelId = feature.properties?.parcelId || 'Unknown';
            layer.bindTooltip(`Parcel ${parcelId}: ${floors} floor${floors > 1 ? 's' : ''}`, {
                permanent: false,
                direction: 'center'
            });

            parcelBasedBuildingLayers.push(layer);
        });

        // Update metrics display
        updateBuildingMetrics(features);

        // Update 3D view
        try { updateParcelBased3DScene(features); } catch (_) { }
    }

    // Calculate and display building metrics
    function updateBuildingMetrics(features) {
        const buildingCountEl = document.getElementById('parcelbased-building-count-value');
        const totalAreaEl = document.getElementById('parcelbased-total-area-value');
        const totalVolumeEl = document.getElementById('parcelbased-total-volume-value');
        const avgFloorsEl = document.getElementById('parcelbased-avg-floors-value');

        if (!buildingCountEl || !totalAreaEl || !totalVolumeEl || !avgFloorsEl) return;

        if (!Array.isArray(features) || features.length === 0) {
            buildingCountEl.textContent = '0';
            totalAreaEl.textContent = '0';
            totalVolumeEl.textContent = '0';
            avgFloorsEl.textContent = '0';
            return;
        }

        try {
            let totalArea = 0;
            let totalVolume = 0;
            let totalFloors = 0;

            features.forEach(feature => {
                if (!feature || !feature.geometry) return;
                const area = turf.area(feature);
                const height = feature.properties?.height || DEFAULT_FLOOR_HEIGHT;
                const floors = feature.properties?.floors || 1;
                totalArea += area;
                totalVolume += area * height;
                totalFloors += floors;
            });

            const avgFloors = features.length > 0 ? totalFloors / features.length : 0;

            buildingCountEl.textContent = features.length.toString();
            totalAreaEl.textContent = totalArea.toFixed(1);
            totalVolumeEl.textContent = totalVolume.toFixed(1);
            avgFloorsEl.textContent = avgFloors.toFixed(1);
        } catch (e) {
            console.warn('[ParcelBased] Error calculating metrics:', e);
            buildingCountEl.textContent = '0';
            totalAreaEl.textContent = '0';
            totalVolumeEl.textContent = '0';
            avgFloorsEl.textContent = '0';
        }
    }

    // Generate buildings in modal
    function generateBuildingsInModal() {
        const block = getActiveParcelBasedBlock();
        if (!block || !Array.isArray(block.parcels) || block.parcels.length === 0) {
            return;
        }

        setParcelBasedInfo('parcelBased.modal.generating', 'Generating buildings...');

        try {
            // Ensure 3D is initialized
            try { if (!parcelBased3D || !parcelBased3D.renderer) initParcelBased3DSimple(); } catch (_) { }

            const buildings = generateBuildingsForBlock(block, currentMinDistance, currentMaxFloors);

            if (!buildings || buildings.length === 0) {
                throw new Error('Failed to generate any buildings');
            }

            generatedParcelBasedFeatures = buildings;
            displayBuildingsInModal(buildings);

            const doneButton = document.getElementById('btn-parcelbased-done');
            if (doneButton) doneButton.disabled = false;

            // Clear info text on successful generation
            setParcelBasedInfo('parcelBased.modal.generatedSummary',
                'Generated {{count}} building(s)',
                { count: buildings.length });

        } catch (error) {
            console.error('[ParcelBased] Generation error:', error);
            setParcelBasedInfo(
                'parcelBased.modal.messages.creationFailed',
                'Building generation failed. Try adjusting parameters.',
                {}
            );
            const doneButton = document.getElementById('btn-parcelbased-done');
            if (doneButton) doneButton.disabled = true;
        }
    }

    // --- 3D Preview ---

    async function ensureThreeForParcelBased() {
        if (typeof THREE !== 'undefined') return true;

        const loadScript = (src) => new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = src;
            script.async = true;
            script.onload = () => resolve(true);
            script.onerror = () => resolve(false);
            document.head.appendChild(script);
        });

        if (!parcelBasedThreeLoadPromise) {
            parcelBasedThreeLoadPromise = loadScript('https://cdn.jsdelivr.net/npm/three@0.147.0/build/three.min.js');
        }
        await parcelBasedThreeLoadPromise;

        if (typeof THREE === 'undefined') return false;

        if (typeof THREE.OrbitControls === 'undefined') {
            await loadScript('https://cdn.jsdelivr.net/npm/three@0.147.0/examples/js/controls/OrbitControls.js');
        }

        return typeof THREE !== 'undefined';
    }

    function getParcelBasedProjector() {
        const crs = (parcelBasedMap && parcelBasedMap.options && parcelBasedMap.options.crs) || L.CRS.EPSG3857;
        if (!crs || typeof crs.project !== 'function' || typeof crs.unproject !== 'function') return null;
        return {
            project: (ll) => {
                const p = crs.project(L.latLng(ll.lat, ll.lng));
                return [p.x, p.y];
            },
            unproject: (xy) => {
                const llOut = crs.unproject(L.point(xy[0], xy[1]));
                return [llOut.lat, llOut.lng];
            }
        };
    }

    function computeParcelBasedOrigin(features, projector) {
        try {
            if (!features || !Array.isArray(features) || features.length === 0 || !projector) return [0, 0];
            const coords = [];
            features.forEach(feature => {
                if (!feature || !feature.geometry) return;
                const geom = feature.geometry;
                if (geom.type === 'Polygon') {
                    geom.coordinates.forEach(ring => {
                        ring.forEach(coord => coords.push(coord));
                    });
                } else if (geom.type === 'MultiPolygon') {
                    geom.coordinates.forEach(poly => {
                        poly.forEach(ring => {
                            ring.forEach(coord => coords.push(coord));
                        });
                    });
                }
            });
            if (!coords.length) return [0, 0];
            let sumX = 0, sumY = 0;
            coords.forEach(([lng, lat]) => {
                const [x, y] = projector.project(L.latLng(lat, lng));
                sumX += x;
                sumY += y;
            });
            return [sumX / coords.length, sumY / coords.length];
        } catch (_) {
            return [0, 0];
        }
    }

    async function initParcelBased3DSimple() {
        const ok = await ensureThreeForParcelBased();
        if (!ok) return;
        const container = document.getElementById('parcelbased-3d');
        if (!container) return;

        disposeParcelBased3D();

        const handle = window.ThreeEditScene.create({ container, defaultHeight: 200 });

        const modelGroup = new THREE.Group();
        handle.scene.add(modelGroup);

        parcelBased3D.handle = handle;
        parcelBased3D.container = handle.container;
        parcelBased3D.renderer = handle.renderer;
        parcelBased3D.scene = handle.scene;
        parcelBased3D.camera = handle.camera;
        parcelBased3D.controls = handle.controls;
        parcelBased3D.modelGroup = modelGroup;
        parcelBased3D.contextGroup = handle.contextGroup;
        parcelBased3D.cameraFramed = false; // re-frame once on the first render of this fresh scene
    }

    function disposeParcelBased3D() {
        if (parcelBased3D.handle && typeof parcelBased3D.handle.dispose === 'function') {
            parcelBased3D.handle.dispose();
        }
        parcelBased3D.handle = null;
        parcelBased3D.renderer = null;
        parcelBased3D.scene = null;
        parcelBased3D.camera = null;
        parcelBased3D.controls = null;
        parcelBased3D.frameId = null;
        parcelBased3D.container = null;
        parcelBased3D.originHTRS = null;
        parcelBased3D.modelGroup = null;
        parcelBased3D.contextGroup = null;
        parcelBased3D.resizeHandler = null;
    }

    function loadParcelBasedContextBuildings(features, origin) {
        if (!parcelBased3D.contextGroup || !window.ContextBuildings3D || !Array.isArray(features) || features.length === 0) return;
        const projector = getParcelBasedProjector();
        if (!projector) return;
        let queryGeom = null;
        try {
            const fc = turf.featureCollection(features.filter(f => f && f.geometry));
            if (fc.features.length === 0) return;
            const bbox = turf.bbox(fc);
            if (!bbox || bbox.some(v => !isFinite(v))) return;
            const [minX, minY, maxX, maxY] = bbox;
            queryGeom = {
                type: 'Polygon',
                coordinates: [[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]]]
            };
        } catch (_) { return; }

        const safeOrigin = Array.isArray(origin) ? origin : [0, 0];
        const latLngToLocalXY = (lng, lat) => {
            const [x, y] = projector.project(L.latLng(lat, lng));
            return [x - safeOrigin[0], y - safeOrigin[1]];
        };
        try {
            window.ContextBuildings3D.loadInto(parcelBased3D.contextGroup, {
                geometry: queryGeom,
                latLngToLocalXY
            });
        } catch (e) {
            console.warn('[parcel-based] context buildings load failed:', e);
        }
    }

    function clearThreeGroup(group) {
        if (!group) return;
        for (let i = group.children.length - 1; i >= 0; i--) {
            const child = group.children[i];
            try {
                if (child.geometry && typeof child.geometry.dispose === 'function') child.geometry.dispose();
            } catch (_) { }
            try {
                if (child.material) {
                    if (Array.isArray(child.material)) {
                        child.material.forEach(mat => { if (mat && typeof mat.dispose === 'function') mat.dispose(); });
                    } else if (typeof child.material.dispose === 'function') {
                        child.material.dispose();
                    }
                }
            } catch (_) { }
            try { group.remove(child); } catch (_) { }
        }
    }

    function updateParcelBased3DScene(features) {
        if (!parcelBased3D.modelGroup || typeof THREE === 'undefined' || !features || !Array.isArray(features)) return;

        clearThreeGroup(parcelBased3D.modelGroup);

        const projector = getParcelBasedProjector();
        const origin = computeParcelBasedOrigin(features, projector);
        parcelBased3D.originHTRS = origin;
        loadParcelBasedContextBuildings(features, origin);

        let maxHeight = 0;

        features.forEach((feature, idx) => {
            if (!feature || !feature.geometry) return;
            const geom = feature.geometry;
            if (geom.type !== 'Polygon') return;

            const height = feature.properties?.height || DEFAULT_FLOOR_HEIGHT;
            if (height > maxHeight) maxHeight = height;
            const color = feature.properties?.color || getRandomColor(idx);
            const ring = geom.coordinates[0];

            if (!Array.isArray(ring) || ring.length < 4) return;

            const shape = new THREE.Shape();
            ring.forEach(([lng, lat], i) => {
                const [x, y] = projector ? projector.project(L.latLng(lat, lng)) : [lng, lat];
                const px = x - origin[0];
                const py = y - origin[1];
                if (i === 0) shape.moveTo(px, py); else shape.lineTo(px, py);
            });

            const extrudeGeom = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, steps: 1 });

            // Convert hex color to THREE.Color
            const threeColor = new THREE.Color(color);
            const material = new THREE.MeshLambertMaterial({ color: threeColor, transparent: true, opacity: 0.8 });
            const mesh = new THREE.Mesh(extrudeGeom, material);
            parcelBased3D.modelGroup.add(mesh);

            // Add edges
            const edgeGeom = new THREE.EdgesGeometry(extrudeGeom);
            const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x333333 });
            const edges = new THREE.LineSegments(edgeGeom, edgeMaterial);
            parcelBased3D.modelGroup.add(edges);
        });

        // Fit the camera only on the first render of the scene. On slider-driven updates
        // (max floors / min distance regenerate the buildings), preserve the user's current
        // orbit/zoom instead of re-fitting — re-fitting every input made the 3D view jump and
        // flicker and made height changes hard to see.
        if (!parcelBased3D.cameraFramed) {
            fitParcelBasedCamera(maxHeight);
            parcelBased3D.cameraFramed = true;
        }
    }

    function fitParcelBasedCamera(height = 20) {
        if (!parcelBased3D.camera || !parcelBased3D.controls || !parcelBased3D.modelGroup) return;

        const box = new THREE.Box3().setFromObject(parcelBased3D.modelGroup);
        if (box.isEmpty()) return;

        const center = new THREE.Vector3();
        box.getCenter(center);
        const size = new THREE.Vector3();
        box.getSize(size);

        const maxDim = Math.max(size.x, size.y, size.z, 50);
        const dist = maxDim * 1.5;

        parcelBased3D.camera.position.set(center.x + dist * 0.6, center.y + dist * 0.6, center.z + dist * 0.4);
        parcelBased3D.controls.target.copy(center);
        parcelBased3D.camera.lookAt(center);
    }

    // --- Modal management ---

    function showParcelBasedModal() {
        const block = getActiveParcelBasedBlock();
        if (!block || !Array.isArray(block.parcels) || block.parcels.length === 0) {
            if (typeof updateStatus === 'function') {
                updateStatus('No parcels selected');
            }
            return;
        }

        parcelBasedBlock = block;
        const blockLabel = getParcelBasedDisplayName();

        console.log('[ParcelBased] showParcelBasedModal called for block:', blockLabel, 'with', block.parcels.length, 'parcels');

        // Create modal if it doesn't exist
        if (!document.getElementById('parcelbased-modal')) {
            const modalDiv = document.createElement('div');
            modalDiv.id = 'parcelbased-modal';
            modalDiv.className = 'parcelbased-modal-overlay';

            const container = document.createElement('div');
            container.id = 'parcelbased-container';

            container.innerHTML = `
                <div id="parcelbased-main">
                    <div id="parcelbased-header">
                        <h2 data-i18n-key="parcelBased.modal.title">Parcel-based Urban Rules</h2>
                        <button id="parcelbased-close" type="button" class="close-circle-btn close-circle-btn--lg" data-i18n-key="parcelBased.modal.closeAria" data-i18n-attr="aria-label" aria-label="Close parcel-based modal">×</button>
                    </div>
                    <div id="parcelbased-map"></div>
                    <div id="parcelbased-3d"></div>
                    <div id="parcelbased-controls">
                        <div id="parcelbased-info" data-i18n-attr="text"></div>
                        <div id="parcelbased-buttons" style="display: flex; justify-content: center; gap: 10px;">
                            <button class="btn btn-secondary" id="btn-parcelbased-regenerate" style="width: auto; padding: 8px 24px;" data-i18n-key="parcelBased.modal.regenerate" data-i18n-attr="text">Regenerate</button>
                            <button class="btn btn-proposal" id="btn-parcelbased-done" style="width: auto; padding: 8px 24px;" data-i18n-key="parcelBased.modal.done" data-i18n-attr="text">Done</button>
                        </div>
                    </div>
                </div>
                <div id="parcelbased-sidebar">
                    <h3 data-i18n-key="parcelBased.modal.parametersTitle">Parameters</h3>
                    <div class="parameter-group">
                        <label for="parcelbased-maxfloors-slider">
                            <span data-i18n-key="parcelBased.modal.labels.maxFloors" data-i18n-attr="text">Max Floors:</span>
                            <span id="parcelbased-maxfloors-value">${DEFAULT_MAX_FLOORS}</span>
                        </label>
                        <input type="range" id="parcelbased-maxfloors-slider" min="1" max="20" value="${DEFAULT_MAX_FLOORS}" step="1">
                    </div>
                    <div class="parameter-group">
                        <label for="parcelbased-mindistance-slider">
                            <span data-i18n-key="parcelBased.modal.labels.minDistance" data-i18n-attr="text">Min Distance from Borders (m):</span>
                            <span id="parcelbased-mindistance-value">${DEFAULT_MIN_DISTANCE.toFixed(1)}</span>
                        </label>
                        <input type="range" id="parcelbased-mindistance-slider" min="0.5" max="20" value="${DEFAULT_MIN_DISTANCE}" step="0.5">
                    </div>
                    <div class="parameter-metrics">
                        <div class="metric-row">
                            <span data-i18n-key="parcelBased.modal.labels.buildingCount" data-i18n-attr="text">Buildings:</span>
                            <span id="parcelbased-building-count-value">0</span>
                        </div>
                        <div class="metric-row">
                            <span data-i18n-key="parcelBased.modal.labels.totalArea" data-i18n-attr="text">Total Footprint (m²):</span>
                            <span id="parcelbased-total-area-value">0</span>
                        </div>
                        <div class="metric-row">
                            <span data-i18n-key="parcelBased.modal.labels.totalVolume" data-i18n-attr="text">Total Volume (m³):</span>
                            <span id="parcelbased-total-volume-value">0</span>
                        </div>
                        <div class="metric-row">
                            <span data-i18n-key="parcelBased.modal.labels.avgFloors" data-i18n-attr="text">Avg Floors:</span>
                            <span id="parcelbased-avg-floors-value">0</span>
                        </div>
                    </div>
                    <div class="parameter-info">
                        <p>
                            <span data-i18n-key="parcelBased.modal.helper.maxFloors">Max Floors: each building gets a random number of floors from 1 to this value.</span>
                            <span data-i18n-key="parcelBased.modal.helper.minDistance">Min Distance: buildings are set back this distance from parcel borders.</span>
                            <span data-i18n-key="parcelBased.modal.helper.regenerate">Click Regenerate to randomize floor counts again.</span>
                        </p>
                    </div>
                </div>
            `;

            modalDiv.appendChild(container);
            document.body.appendChild(modalDiv);

            setParcelBasedInfo('parcelBased.modal.generating', 'Generating buildings...');

            // Apply translations
            try {
                if (typeof window !== 'undefined' && window.i18n && typeof window.i18n.applyTranslations === 'function') {
                    window.i18n.applyTranslations(container);
                }
            } catch (_) { }

            document.dispatchEvent(new CustomEvent('parcelBasedModalOpened'));
            document.dispatchEvent(new CustomEvent('urbanRuleModalOpened'));

            // Add event listeners
            document.getElementById('parcelbased-close').addEventListener('click', closeParcelBasedModal);
            const doneButton = document.getElementById('btn-parcelbased-done');
            if (doneButton) {
                doneButton.addEventListener('click', saveParcelBasedDesignForProposal);
                doneButton.disabled = true;
            }

            const regenerateButton = document.getElementById('btn-parcelbased-regenerate');
            if (regenerateButton) {
                regenerateButton.addEventListener('click', generateBuildingsInModal);
            }

            // Slider event listeners
            document.getElementById('parcelbased-maxfloors-slider').addEventListener('input', function (e) {
                currentMaxFloors = parseInt(e.target.value, 10);
                document.getElementById('parcelbased-maxfloors-value').textContent = currentMaxFloors.toString();
                generateBuildingsInModal();
            });

            document.getElementById('parcelbased-mindistance-slider').addEventListener('input', function (e) {
                currentMinDistance = parseFloat(e.target.value);
                document.getElementById('parcelbased-mindistance-value').textContent = currentMinDistance.toFixed(1);
                generateBuildingsInModal();
            });

            // Close modal when clicking outside the container
            modalDiv.addEventListener('click', (e) => {
                if (e.target === modalDiv) {
                    closeParcelBasedModal();
                }
            });

            // Ensure 3D canvas is interactive
            const threeDiv = document.getElementById('parcelbased-3d');
            if (threeDiv) {
                threeDiv.style.pointerEvents = 'auto';
            }
        }

        // Initialize the map if needed
        if (!parcelBasedMap) {
            parcelBasedMap = L.map('parcelbased-map', {
                zoomControl: true,
                dragging: true,
                scrollWheelZoom: true
            });

            L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '© OpenStreetMap contributors'
            }).addTo(parcelBasedMap);
        }

        // Display the parcels on the map
        displayParcelsOnMap(block);

        // Reset parameters
        currentMaxFloors = DEFAULT_MAX_FLOORS;
        currentMinDistance = DEFAULT_MIN_DISTANCE;

        // Restore a saved design over the defaults (e.g. a copied proposal). Buildings here are a
        // pure function of these two parameters, so seeding them reproduces the exact geometry.
        const seed = parcelBasedSeedParameters;
        parcelBasedSeedParameters = null;
        if (seed) {
            if (Number.isFinite(Number(seed.maxFloors))) currentMaxFloors = Number(seed.maxFloors);
            if (Number.isFinite(Number(seed.minDistance))) currentMinDistance = Number(seed.minDistance);
        }

        // Update sliders
        const maxFloorsSlider = document.getElementById('parcelbased-maxfloors-slider');
        const minDistanceSlider = document.getElementById('parcelbased-mindistance-slider');

        if (maxFloorsSlider) {
            maxFloorsSlider.value = currentMaxFloors;
            document.getElementById('parcelbased-maxfloors-value').textContent = currentMaxFloors.toString();
        }
        if (minDistanceSlider) {
            minDistanceSlider.value = currentMinDistance;
            document.getElementById('parcelbased-mindistance-value').textContent = currentMinDistance.toFixed(1);
        }

        // Generate buildings immediately
        setTimeout(() => {
            generateBuildingsInModal();
        }, 500);
    }

    function displayParcelsOnMap(block) {
        // Clear existing layers
        if (parcelBasedParcelLayer) {
            parcelBasedMap.removeLayer(parcelBasedParcelLayer);
            parcelBasedParcelLayer = null;
        }

        // Create a feature collection for all parcels in the block
        const features = block.parcels.map(parcel => parcel.feature);
        const featureCollection = {
            type: 'FeatureCollection',
            features: features
        };

        // Add the parcels to the map with distinct styling to show borders
        parcelBasedParcelLayer = L.geoJSON(featureCollection, {
            style: {
                fillColor: '#f0f0f0',
                fillOpacity: 0.3,
                color: '#333',
                weight: 2,
                dashArray: '5, 5'
            }
        }).addTo(parcelBasedMap);

        // Fit the map to the bounds of the block
        parcelBasedMap.fitBounds(parcelBasedParcelLayer.getBounds(), {
            padding: [50, 50]
        });

        // Initialize 3D preview
        try { initParcelBased3DSimple(); } catch (e) { console.warn('3D init failed', e); }
    }

    function closeParcelBasedModal(options = {}) {
        const { preservePending = false } = options;

        // Remove the map instance
        if (parcelBasedMap) {
            if (parcelBasedParcelLayer) {
                parcelBasedMap.removeLayer(parcelBasedParcelLayer);
                parcelBasedParcelLayer = null;
            }
            parcelBasedBuildingLayers.forEach(layer => {
                if (parcelBasedMap && layer) {
                    parcelBasedMap.removeLayer(layer);
                }
            });
            parcelBasedBuildingLayers = [];
            parcelBasedMap.remove();
            parcelBasedMap = null;
        }

        // Clear state
        generatedParcelBasedFeatures = [];
        parcelBasedBlock = null;
        parcelBasedBlockNameOverride = null;

        // Dispose 3D resources
        disposeParcelBased3D();

        // Remove the modal from DOM
        const modal = document.getElementById('parcelbased-modal');
        if (modal) {
            modal.remove();
            document.dispatchEvent(new CustomEvent('parcelBasedModalClosed'));
            document.dispatchEvent(new CustomEvent('urbanRuleModalClosed'));
        }

        // Force a reflow of the main map
        if (typeof map !== 'undefined' && map) {
            map.invalidateSize();
        }

        // Reset parameters to defaults
        currentMaxFloors = DEFAULT_MAX_FLOORS;
        currentMinDistance = DEFAULT_MIN_DISTANCE;

        if (!preservePending) {
            setPendingParcelBasedProposalContext(null);
            if (typeof window !== 'undefined') {
                window.pendingParcelBasedFromModal = null;
            }
        }
    }

    // Save design for proposal
    function saveParcelBasedDesignForProposal() {
        if (!generatedParcelBasedFeatures || generatedParcelBasedFeatures.length === 0) {
            setParcelBasedInfo('parcelBased.modal.messages.generateBeforeFinishing', 'Generate buildings before finishing.');
            return;
        }

        const block = getActiveParcelBasedBlock();
        if (!block || !Array.isArray(block.parcels) || block.parcels.length === 0) {
            setParcelBasedInfo('parcelBased.modal.messages.blockHasNoParcels', 'Block has no parcels.');
            return;
        }

        const parentDetails = [];
        const normalizedParcelIds = [];

        // Clear multi-selection if available
        if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection) {
            if (typeof multiParcelSelection.clearSelection === 'function') {
                multiParcelSelection.clearSelection();
            }
        }

        block.parcels.forEach(parcel => {
            const props = parcel?.feature?.properties;
            const parcelId = typeof ensureParcelId === 'function'
                ? ensureParcelId(parcel?.feature)
                : (props?.parcelId ?? props?.parcel_id ?? props?.id);
            if (!parcelId) return;
            const idStr = parcelId.toString();
            let number = idStr;
            try {
                if (parcel.feature?.properties?.BROJ_CESTICE) {
                    number = String(parcel.feature.properties.BROJ_CESTICE);
                }
            } catch (_) { }
            normalizedParcelIds.push(idStr);
            parentDetails.push({ id: idStr, number });
            if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection?.selectedParcels) {
                multiParcelSelection.selectedParcels.add(idStr);
            }
        });

        if (typeof multiParcelSelection !== 'undefined' && typeof multiParcelSelection.updateUI === 'function') {
            multiParcelSelection.updateUI();
        }

        if (!normalizedParcelIds.length) {
            setParcelBasedInfo('parcelBased.modal.messages.unableToMapParcels', 'Unable to map parcels for this block.');
            return;
        }

        const clonedFeatures = JSON.parse(JSON.stringify(generatedParcelBasedFeatures));
        const context = {
            parcelIds: normalizedParcelIds.slice(),
            parentDetails: parentDetails.slice(),
            blockName: getParcelBasedDisplayName(),
            parameters: {
                maxFloors: Number.isFinite(Number(currentMaxFloors)) ? Number(currentMaxFloors) : DEFAULT_MAX_FLOORS,
                minDistance: Number.isFinite(Number(currentMinDistance)) ? Number(currentMinDistance) : DEFAULT_MIN_DISTANCE,
                typology: 'parcelBased'
            },
            buildings: clonedFeatures,
            buildingFeature: clonedFeatures[0] || null
        };

        window.pendingParcelBasedFromModal = clonedFeatures;
        window.pendingBuildingFromBlockify = clonedFeatures; // For compatibility with proposal creation
        setPendingParcelBasedProposalContext(context);

        // Also set the building context for existing proposal creation flow
        if (typeof setPendingBuildingProposalContext === 'function') {
            setPendingBuildingProposalContext(context);
        } else if (typeof window !== 'undefined') {
            window.pendingBuildingProposalContext = context;
        }

        closeParcelBasedModal({ preservePending: true });

        if (typeof updateStatus === 'function') {
            updateStatus('Parcel-based buildings saved. Add proposal details to submit.');
        }

        const description = document.getElementById('proposalDescription');
        if (description) {
            if (!description.value.trim()) {
                description.value = translateParcelBasedText(
                    'parcelBased.modal.messages.defaultProposalDescription',
                    'Parcel-based proposal for {{blockName}}',
                    { blockName: context.blockName || 'selected parcels' }
                );
            }
            description.focus();
        }
    }

    // Entry point for opening parcel-based modal from parcels. `initialParameters` (optional)
    // reopens the editor on a previously-saved design — used by "Copy into new proposal".
    function openParcelBasedForParcels({ blockName, parcels, initialParameters = null }) {
        parcelBasedSeedParameters = initialParameters || null;
        const rawParcels = Array.isArray(parcels) ? parcels.filter(Boolean) : [];
        if (!rawParcels.length) {
            if (typeof updateStatus === 'function') {
                updateStatus('Select parcels before launching the parcel-based tool.');
            }
            return;
        }

        const seenIds = new Set();
        const normalizedParcels = [];
        rawParcels.forEach(layer => {
            try {
                const props = layer?.feature?.properties;
                const parcelId = typeof ensureParcelId === 'function'
                    ? ensureParcelId(layer?.feature)
                    : (props?.parcelId ?? props?.parcel_id ?? props?.id);
                if (!parcelId) return;
                const idStr = parcelId.toString();
                if (seenIds.has(idStr)) return;
                seenIds.add(idStr);
                normalizedParcels.push(layer);
            } catch (_) { }
        });

        if (!normalizedParcels.length) {
            if (typeof updateStatus === 'function') {
                updateStatus('Could not resolve parcel data for the selected parcels.');
            }
            return;
        }

        const parcelIds = Array.from(seenIds);
        parcelBasedBlock = {
            parcels: normalizedParcels,
            parcelIds,
            valid: true,
            polygon: null
        };
        parcelBasedBlockNameOverride = blockName || describeParcelBasedParcelSelection(parcelIds);
        showParcelBasedModal();
    }

    // Export to window
    if (typeof window !== 'undefined') {
        window.openParcelBasedForParcels = openParcelBasedForParcels;
        window.closeParcelBasedModal = closeParcelBasedModal;
    }

})();
