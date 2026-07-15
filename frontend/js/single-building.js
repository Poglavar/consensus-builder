// Single Building modal and placement
// Creates a draggable rectangle within the currently selected block (union polygon),
// with sliders for length, width, height, chamfer, and rotation.

(function () {
    let singleModal = null;
    let singleMap = null;
    let singleBlockLayer = null;
    let singleParcelBorderLayer = null;
    let singleRectGroup = null;
    let singleRectLayer = null;
    let singleDragMarker = null; // legacy marker; not rendered anymore
    let singleBlockFeature = null;
    let lastValidCenter = null; // LatLng of last valid rectangle center
    let singleRectFeature = null;
    let rectDragActive = false;
    let rectDragStartPointerPt = null;
    let rectDragStartCenterPt = null;
    let singleMapClickHandlerBound = false;
    let singleMapDragStarterBound = false;

    // Rotation state
    let currentRotationDeg = 0; // current rotation in degrees

    const single3D = {
        handle: null,
        renderer: null,
        scene: null,
        camera: null,
        controls: null,
        frameId: null,
        container: null,
        originHTRS: null,
        blockGroup: null,
        buildingGroup: null,
        contextGroup: null,
        resizeHandler: null,
        projector: null
    };
    let singleThreeLoadPromise = null;

    function resolveParcelId(feature) {
        if (!feature || typeof feature !== 'object') return null;
        try {
            if (typeof ensureParcelId === 'function') {
                const ensured = ensureParcelId(feature);
                if (ensured !== undefined && ensured !== null) return ensured.toString();
            }
        } catch (_) { }
        const props = feature.properties || {};
        const candidates = [props.parcelId];
        for (const candidate of candidates) {
            if (candidate !== undefined && candidate !== null) {
                try { return candidate.toString(); } catch (_) { return String(candidate); }
            }
        }
        return null;
    }

    async function ensureThreeForSingle() {
        const loadScript = (src) => new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = src;
            script.async = true;
            script.onload = () => resolve(true);
            script.onerror = () => resolve(false);
            document.head.appendChild(script);
        });

        if (typeof THREE === 'undefined') {
            if (!singleThreeLoadPromise) {
                singleThreeLoadPromise = loadScript('https://cdn.jsdelivr.net/npm/three@0.147.0/build/three.min.js');
            }
            await singleThreeLoadPromise;
        }

        if (typeof THREE === 'undefined') return false;

        if (typeof THREE.OrbitControls === 'undefined') {
            await loadScript('https://cdn.jsdelivr.net/npm/three@0.147.0/examples/js/controls/OrbitControls.js');
        }

        return typeof THREE !== 'undefined';
    }

    function getMercatorProjector() {
        const crs = singleMap && singleMap.options && singleMap.options.crs ? singleMap.options.crs : L.CRS.EPSG3857;
        if (crs && typeof crs.project === 'function' && typeof crs.unproject === 'function') {
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
        // Fallback identity (degrees) should not happen for Leaflet maps
        return {
            project: (ll) => [ll.lng, ll.lat],
            unproject: (xy) => [xy[1], xy[0]]
        };
    }

    // Dimensions in meters
    const DEFAULT_LENGTH_M = 6; // along Y
    const DEFAULT_WIDTH_M = 3;  // along X
    const DEFAULT_HEIGHT_M = 10; // meters
    const DEFAULT_CHAMFER_M = 0; // meters
    let currentLengthM = DEFAULT_LENGTH_M;
    let currentWidthM = DEFAULT_WIDTH_M;
    let currentHeightM = DEFAULT_HEIGHT_M;
    let currentChamferM = DEFAULT_CHAMFER_M;
    let pendingSingleBuildingMeta = null;
    let singleBuildingOverrideContext = null;
    let buildingEntries = [];
    let activeBuildingId = null;
    let nextBuildingId = 1;
    // Buildings to restore when the modal next opens, instead of one default building. Set by
    // openSingleBuildingForParcels({ initialBuildings }); consumed once by showSingleBuildingModal().
    let singleBuildingSeedBuildings = null;

    // Centre of a stored building feature, as a Leaflet LatLng. Position isn't in `parameters`,
    // so a fork has to recover it from the geometry.
    function featureCenterLatLng(feature) {
        try {
            if (typeof turf === 'undefined' || !turf || !feature || !feature.geometry) return null;
            const [lng, lat] = turf.centroid(feature).geometry.coordinates;
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
            return L.latLng(lat, lng);
        } catch (_) {
            return null;
        }
    }
    const BUILDING_COLORS = ['#0d6efd', '#d63384', '#198754', '#fd7e14', '#20c997', '#6f42c1', '#0dcaf0', '#e83e8c'];

    const formatSingleBuildingText = (template, params = {}) => {
        if (!template) return '';
        return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
            return Object.prototype.hasOwnProperty.call(params, key) ? params[key] : match;
        });
    };

    const translateSingleBuildingText = (key, fallback, params = {}) => {
        const api = (typeof window !== 'undefined' && window.i18n) ? window.i18n : null;
        if (api && typeof api.t === 'function') {
            return api.t(key, params);
        }
        return formatSingleBuildingText(fallback, params);
    };

    const showSingleBuildingAlert = (key, fallback, params = {}) => {
        const message = translateSingleBuildingText(`alerts.messages.${key}`, fallback, params);
        const alertFn = (typeof window !== 'undefined' && typeof window.showStyledAlert === 'function')
            ? window.showStyledAlert
            : window.alert;
        if (typeof alertFn === 'function') {
            alertFn(message);
        }
        return message;
    };

    const setSingleBuildingStatus = (key, fallback, params = {}) => {
        if (typeof updateStatus === 'function') {
            updateStatus(translateSingleBuildingText(`status.messages.${key}`, fallback, params));
        }
    };

    function pickBuildingColor(idx) {
        if (!BUILDING_COLORS.length) return '#0d6efd';
        return BUILDING_COLORS[idx % BUILDING_COLORS.length];
    }

    function getActiveBuilding() {
        return buildingEntries.find(b => b.id === activeBuildingId) || null;
    }

    function setActiveBuilding(buildingId, { refreshUI = true, skip3D = false } = {}) {
        const target = buildingEntries.find(b => b.id === buildingId) || buildingEntries[0];
        if (!target) return;
        activeBuildingId = target.id;
        singleRectFeature = target.feature || null;
        lastValidCenter = target.lastValidCenter || null;
        currentWidthM = target.width;
        currentLengthM = target.length;
        currentHeightM = target.height;
        currentChamferM = target.chamfer;
        currentRotationDeg = target.rotation || 0;
        if (refreshUI) {
            syncSlidersFromActive();
            updateRectangleLayers();
            try { updateSingleBuilding3D(singleRectFeature, { skipFit: skip3D }); } catch (_) { }
        }
    }

    function syncSlidersFromActive() {
        const wEl = document.getElementById('single-width-slider');
        const lEl = document.getElementById('single-length-slider');
        const hEl = document.getElementById('single-height-slider');
        const cEl = document.getElementById('single-chamfer-slider');
        const rEl = document.getElementById('single-rotation-slider');
        if (wEl) { wEl.value = currentWidthM; const v = document.getElementById('single-width-value'); if (v) v.textContent = Number(currentWidthM).toFixed(1); }
        if (lEl) { lEl.value = currentLengthM; const v = document.getElementById('single-length-value'); if (v) v.textContent = Number(currentLengthM).toFixed(1); }
        if (hEl) { hEl.value = currentHeightM; const v = document.getElementById('single-height-value'); if (v) v.textContent = Number(currentHeightM).toFixed(0); }
        if (cEl) { cEl.value = currentChamferM; const v = document.getElementById('single-chamfer-value'); if (v) v.textContent = Number(currentChamferM).toFixed(1); }
        if (rEl) { rEl.value = currentRotationDeg; const v = document.getElementById('single-rotation-value'); if (v) v.textContent = Number(currentRotationDeg).toFixed(0); }
        const select = document.getElementById('single-building-selector');
        if (select) select.value = String(activeBuildingId);
    }

    function buildInitialBuildingFeature(centerLatLng, widthM, lengthM, chamferM, heightM, rotationDeg = 0) {
        const fitted = fitRectangleAtCenter(centerLatLng, widthM, lengthM, chamferM, heightM, rotationDeg) || null;
        if (fitted && fitted.properties) {
            fitted.properties.height = heightM;
            fitted.properties.width = widthM;
            fitted.properties.length = lengthM;
            fitted.properties.chamfer = chamferM;
            fitted.properties.rotation = rotationDeg;
            fitted.properties.type = 'proposedBuildingSingle';
        }
        return fitted;
    }

    function addNewBuildingEntry(centerLatLng, options = {}) {
        const placement = computeInitialPlacement(singleBlockFeature);
        const center = centerLatLng || placement.center;
        const width = Number(options.width) || placement.width || DEFAULT_WIDTH_M;
        const length = Number(options.length) || placement.length || DEFAULT_LENGTH_M;
        const height = Number(options.height) || width;
        const chamfer = Number(options.chamfer) || DEFAULT_CHAMFER_M;
        const rotation = Number(options.rotation) || 0;
        const feature = buildInitialBuildingFeature(center, width, length, chamfer, height, rotation);
        if (!feature) return null;
        const id = nextBuildingId++;
        const entry = {
            id,
            name: translateSingleBuildingText('modal.singleBuilding.defaultName', 'Building {{n}}', { n: id }),
            color: pickBuildingColor(buildingEntries.length),
            feature,
            width,
            length,
            height,
            chamfer,
            rotation,
            lastValidCenter: centerLatLng
        };
        buildingEntries.push(entry);
        activeBuildingId = id;
        return entry;
    }

    function removeActiveBuilding() {
        if (!buildingEntries.length) return;
        if (buildingEntries.length === 1) return; // keep at least one building
        buildingEntries = buildingEntries.filter(b => b.id !== activeBuildingId);
        const next = buildingEntries[buildingEntries.length - 1];
        setActiveBuilding(next.id);
        refreshBuildingSelector();
        updateRectangleLayers();
        try { updateSingleBuilding3D(singleRectFeature); } catch (_) { }
    }

    function refreshBuildingSelector() {
        const select = document.getElementById('single-building-selector');
        if (!select) return;
        select.innerHTML = buildingEntries.map(b => `<option value="${b.id}">${b.name}</option>`).join('');
        select.value = String(activeBuildingId);
    }

    // Proposed building collection shares the same layer/array as blockify
    if (typeof window !== 'undefined') {
        try { if (!Array.isArray(window.proposedBuildings)) window.proposedBuildings = []; } catch (_) { }
        try { window.pendingSingleBuildingFeature = null; } catch (_) { }
        try { window.pendingSingleBuildingFeatures = null; } catch (_) { }
    }

    function getSingleBuildingContext() {
        if (singleBuildingOverrideContext && Array.isArray(singleBuildingOverrideContext.parcels) && singleBuildingOverrideContext.parcels.length) {
            return singleBuildingOverrideContext;
        }
        if (typeof selectedBlockName === 'undefined' || !selectedBlockName) return null;
        if (typeof blockStorage === 'undefined' || !blockStorage || !blockStorage.blocks || !blockStorage.blocks.has(selectedBlockName)) return null;
        const blk = blockStorage.blocks.get(selectedBlockName);
        if (!blk || !Array.isArray(blk.parcels) || blk.parcels.length === 0) return null;
        return { blockName: selectedBlockName, parcels: blk.parcels };
    }

    function describeSingleBuildingSelection(ids = []) {
        if (!ids || ids.length === 0) return 'Selected Parcels';
        if (ids.length === 1) return `Parcel ${ids[0]}`;
        return `${ids.length} Parcels`;
    }

    function getSelectedBlockFeature() {
        try {
            const context = getSingleBuildingContext();
            if (!context || !Array.isArray(context.parcels) || context.parcels.length === 0) return null;
            const parcelFeatures = context.parcels.map(p => p.feature);
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

    function disposeSingleBuilding3D() {
        if (single3D.handle && typeof single3D.handle.dispose === 'function') {
            single3D.handle.dispose();
        }
        single3D.handle = null;
        single3D.renderer = null;
        single3D.scene = null;
        single3D.camera = null;
        single3D.controls = null;
        single3D.frameId = null;
        single3D.container = null;
        single3D.originHTRS = null;
        single3D.blockGroup = null;
        single3D.buildingGroup = null;
        single3D.contextGroup = null;
        single3D.resizeHandler = null;
    }

    function loadSingleContextBuildings(queryFeature) {
        if (!single3D.contextGroup || !window.ContextBuildings3D || !queryFeature || !queryFeature.geometry) return;
        const projector = single3D.projector || getSingleProjector();
        if (!projector) return;
        // Capture origin lazily — initSingleBuilding3D writes single3D.originHTRS before this runs.
        const latLngToLocalXY = (lng, lat) => {
            const origin = single3D.originHTRS || [0, 0];
            const [x, y] = projector.project(L.latLng(lat, lng));
            return [x - origin[0], y - origin[1]];
        };
        try {
            window.ContextBuildings3D.loadInto(single3D.contextGroup, {
                geometry: queryFeature.geometry,
                latLngToLocalXY
            });
        } catch (e) {
            console.warn('[single-building] context buildings load failed:', e);
        }
    }

    function getSingleProjector() {
        const crs = (singleMap && singleMap.options && singleMap.options.crs) || L.CRS.EPSG3857;
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

    function randomPointInsideBlock(blockFeature) {
        if (!blockFeature || !blockFeature.geometry) return null;
        try {
            const bbox = turf.bbox(blockFeature);
            for (let i = 0; i < 24; i++) {
                const pt = turf.randomPoint(1, { bbox }).features[0];
                if (turf.booleanPointInPolygon(pt, blockFeature)) {
                    const [lng, lat] = pt.geometry.coordinates;
                    return L.latLng(lat, lng);
                }
            }
        } catch (_) { }
        return getBlockCentroid(blockFeature) || null;
    }

    function computeInitialPlacement(blockFeature) {
        if (!blockFeature) return { center: null, width: DEFAULT_WIDTH_M, length: DEFAULT_LENGTH_M };

        const attempts = 12;
        const growStep = 3;
        const retreat = 2.5;
        let best = { center: null, width: DEFAULT_WIDTH_M, length: DEFAULT_LENGTH_M };

        for (let i = 0; i < attempts; i++) {
            const center = randomPointInsideBlock(blockFeature);
            if (!center) continue;

            let size = 6;
            let lastValid = null;
            for (let j = 0; j < 160; j++) {
                const candidate = buildRectangleFeature(center, size, size, DEFAULT_CHAMFER_M, DEFAULT_HEIGHT_M);
                if (rectangleFullyInsideBlock(candidate, blockFeature)) {
                    lastValid = size;
                    size += growStep;
                } else {
                    break;
                }
            }

            if (!lastValid) continue;

            let targetSize = Math.max(1, lastValid - retreat * 2);
            for (let k = 0; k < 12; k++) {
                const candidate = buildRectangleFeature(center, targetSize, targetSize, DEFAULT_CHAMFER_M, DEFAULT_HEIGHT_M);
                if (rectangleFullyInsideBlock(candidate, blockFeature)) break;
                targetSize = Math.max(1, targetSize - retreat);
            }

            if (targetSize > best.width) {
                best = { center, width: targetSize, length: targetSize };
            }
        }

        if (!best.center) {
            const fallbackCenter = getBlockCentroid(blockFeature);
            return { center: fallbackCenter, width: DEFAULT_WIDTH_M, length: DEFAULT_LENGTH_M };
        }

        return best;
    }

    function computeFeatureOrigin(feature, projector) {
        try {
            if (!feature || !feature.geometry || !projector || typeof projector.project !== 'function') return [0, 0];
            const coords = [];
            const collectPolygon = (polygon) => {
                if (!Array.isArray(polygon)) return;
                polygon.forEach(ring => {
                    if (!Array.isArray(ring)) return;
                    ring.forEach(coord => {
                        if (Array.isArray(coord) && coord.length === 2) coords.push(coord);
                    });
                });
            };
            const geom = feature.geometry;
            if (geom.type === 'Polygon') {
                collectPolygon(geom.coordinates);
            } else if (geom.type === 'MultiPolygon') {
                geom.coordinates.forEach(collectPolygon);
            }
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

    async function initSingleBuilding3D(blockFeature) {
        const ok = await ensureThreeForSingle();
        if (!ok) return;
        const container = document.getElementById('single-building-3d');
        if (!container || !blockFeature || !blockFeature.geometry) return;

        disposeSingleBuilding3D();

        const handle = window.ThreeEditScene.create({ container, defaultHeight: 240 });

        const blockGroup = new THREE.Group();
        const buildingGroup = new THREE.Group();
        handle.scene.add(blockGroup);
        handle.scene.add(buildingGroup);

        single3D.handle = handle;
        single3D.container = handle.container;
        single3D.renderer = handle.renderer;
        single3D.scene = handle.scene;
        single3D.camera = handle.camera;
        single3D.controls = handle.controls;
        single3D.blockGroup = blockGroup;
        single3D.buildingGroup = buildingGroup;
        single3D.contextGroup = handle.contextGroup;
        single3D.projector = getSingleProjector();
        single3D.originHTRS = computeFeatureOrigin(blockFeature, single3D.projector);

        drawSingleBlock3D(blockFeature);
        fitSingleBuildingCamera();
        loadSingleContextBuildings(blockFeature);

        if (singleRectFeature) {
            updateSingleBuilding3D(singleRectFeature);
        }
    }

    function drawSingleBlock3D(blockFeature) {
        if (!single3D.blockGroup || typeof THREE === 'undefined') return;
        if (!blockFeature || !blockFeature.geometry) {
            clearThreeGroup(single3D.blockGroup);
            return;
        }

        clearThreeGroup(single3D.blockGroup);

        const geom = blockFeature.geometry;
        const projector = single3D.projector || getSingleProjector();
        const origin = single3D.originHTRS || [0, 0];
        const polygons = [];
        if (geom.type === 'Polygon') {
            polygons.push(geom.coordinates);
        } else if (geom.type === 'MultiPolygon') {
            polygons.push(...geom.coordinates);
        }

        const baseMaterial = new THREE.MeshLambertMaterial({ color: 0x9ec5fe, transparent: true, opacity: 0.35, depthWrite: false });
        const edgeMaterial = new THREE.LineBasicMaterial({ color: 0xe53935 });

        polygons.forEach(rings => {
            if (!Array.isArray(rings) || !Array.isArray(rings[0]) || rings[0].length < 3) return;
            const shape = new THREE.Shape();
            rings[0].forEach(([lng, lat], idx) => {
                const [x, y] = projector ? projector.project(L.latLng(lat, lng)) : [lng, lat];
                const px = x - origin[0];
                const py = y - origin[1];
                if (idx === 0) shape.moveTo(px, py); else shape.lineTo(px, py);
            });

            for (let h = 1; h < rings.length; h++) {
                const path = new THREE.Path();
                const holeRing = rings[h];
                if (!Array.isArray(holeRing)) continue;
                holeRing.forEach(([lng, lat], idx) => {
                    const [x, y] = projector ? projector.project(L.latLng(lat, lng)) : [lng, lat];
                    const px = x - origin[0];
                    const py = y - origin[1];
                    if (idx === 0) path.moveTo(px, py); else path.lineTo(px, py);
                });
                shape.holes.push(path);
            }

            const extrudeGeom = new THREE.ExtrudeGeometry(shape, { depth: 2, bevelEnabled: false, steps: 1 });
            const mesh = new THREE.Mesh(extrudeGeom, baseMaterial);
            single3D.blockGroup.add(mesh);

            const outerPoints = rings[0].map(([lng, lat]) => {
                const [x, y] = projector ? projector.project(L.latLng(lat, lng)) : [lng, lat];
                return new THREE.Vector3(x - origin[0], y - origin[1], 0.05);
            });
            if (outerPoints.length) {
                if (!outerPoints[0].equals(outerPoints[outerPoints.length - 1])) {
                    outerPoints.push(outerPoints[0].clone());
                }
                const lineGeom = new THREE.BufferGeometry().setFromPoints(outerPoints);
                const line = new THREE.Line(lineGeom, edgeMaterial);
                single3D.blockGroup.add(line);
            }
        });

        fitSingleBuildingCamera();
    }

    function fitSingleBuildingCamera(paddingFactor = 1.35) {
        if (typeof THREE === 'undefined') return;
        if (!single3D.camera || !single3D.controls) return;

        const bbox = new THREE.Box3();
        let hasObject = false;
        if (single3D.blockGroup && single3D.blockGroup.children.length) {
            bbox.expandByObject(single3D.blockGroup);
            hasObject = true;
        }
        if (single3D.buildingGroup && single3D.buildingGroup.children.length) {
            bbox.expandByObject(single3D.buildingGroup);
            hasObject = true;
        }
        if (!hasObject || bbox.isEmpty()) return;

        const previousTarget = single3D.controls.target.clone();
        const center = bbox.getCenter(new THREE.Vector3());
        const size = bbox.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z, 1);
        const fov = single3D.camera.fov * (Math.PI / 180);
        const dist = (maxDim / 2) / Math.tan(fov / 2) * paddingFactor;

        let dir = single3D.camera.position.clone().sub(previousTarget);
        if (dir.lengthSq() < 1e-6) {
            dir = new THREE.Vector3(1, 1, 1);
        }
        dir.normalize();

        single3D.controls.target.copy(center);
        single3D.camera.position.copy(center.clone().add(dir.multiplyScalar(dist)));
        single3D.camera.near = Math.max(0.1, dist / 1000);
        single3D.camera.far = Math.max(5000, dist * 10);
        single3D.camera.updateProjectionMatrix();
    }

    function createSingleMeshesFromGeoJSON(geometry, material, depth, origin) {
        const meshes = [];
        if (!geometry || typeof THREE === 'undefined') return meshes;
        const projector = single3D.projector || getSingleProjector();
        const polygons = [];
        if (geometry.type === 'Polygon') {
            polygons.push(geometry.coordinates);
        } else if (geometry.type === 'MultiPolygon') {
            polygons.push(...geometry.coordinates);
        }

        polygons.forEach(rings => {
            if (!Array.isArray(rings) || !Array.isArray(rings[0]) || rings[0].length < 3) return;
            const shape = new THREE.Shape();
            rings[0].forEach(([lng, lat], idx) => {
                const [x, y] = projector ? projector.project(L.latLng(lat, lng)) : wgs84ToHTRS96(lat, lng);
                const px = x - origin[0];
                const py = y - origin[1];
                if (idx === 0) shape.moveTo(px, py); else shape.lineTo(px, py);
            });

            for (let h = 1; h < rings.length; h++) {
                const holePath = new THREE.Path();
                const ring = rings[h];
                if (!Array.isArray(ring)) continue;
                ring.forEach(([lng, lat], idx) => {
                    const [x, y] = projector ? projector.project(L.latLng(lat, lng)) : wgs84ToHTRS96(lat, lng);
                    const px = x - origin[0];
                    const py = y - origin[1];
                    if (idx === 0) holePath.moveTo(px, py); else holePath.lineTo(px, py);
                });
                shape.holes.push(holePath);
            }

            const extrudeSettings = { depth, bevelEnabled: false, steps: 1 };
            const extrudeGeom = new THREE.ExtrudeGeometry(shape, extrudeSettings);
            meshes.push(new THREE.Mesh(extrudeGeom, material.clone ? material.clone() : material));
        });
        return meshes;
    }

    function addLabelToBuilding3D(target, origin, height) {
        if (!target || !target.name || typeof THREE === 'undefined') return;

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const fontSize = 64;
        ctx.font = `bold ${fontSize}px Arial`;
        const textWidth = ctx.measureText(target.name).width;
        canvas.width = textWidth + 40;
        canvas.height = fontSize + 40;

        ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.fillStyle = '#000000';
        ctx.font = `bold ${fontSize}px Arial`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        ctx.fillText(target.name, canvas.width / 2, canvas.height / 2);

        const texture = new THREE.CanvasTexture(canvas);
        texture.minFilter = THREE.LinearFilter;

        const material = new THREE.MeshBasicMaterial({
            map: texture,
            transparent: true,
            side: THREE.DoubleSide,
            depthTest: false,
            depthWrite: false
        });

        const center = turf.centroid(target.feature);
        const [lng, lat] = center.geometry.coordinates;
        const projector = single3D.projector || getSingleProjector();
        const [x, y] = projector.project(L.latLng(lat, lng));
        const px = x - origin[0];
        const py = y - origin[1];

        const width = target.width || DEFAULT_WIDTH_M;
        const length = target.length || DEFAULT_LENGTH_M;
        const rotation = target.rotation || 0;

        const aspect = canvas.width / canvas.height;
        const labelHeight = Math.min(height * 0.6, 3);
        const labelWidth = labelHeight * aspect;

        const geometry = new THREE.PlaneGeometry(labelWidth, labelHeight);
        const mesh = new THREE.Mesh(geometry, material);

        const angleRad = (rotation * Math.PI) / 180;

        // Position on the "south" face (relative to rotation)
        // Face is at y = -length/2
        const offX = 0;
        const offY = -length / 2 - 0.2;

        const rotOffX = offX * Math.cos(angleRad) - offY * Math.sin(angleRad);
        const rotOffY = offX * Math.sin(angleRad) + offY * Math.cos(angleRad);

        mesh.position.set(px + rotOffX, py + rotOffY, height / 2);
        mesh.rotation.x = Math.PI / 2;
        mesh.rotation.z = angleRad;
        mesh.renderOrder = 999;

        single3D.buildingGroup.add(mesh);
    }

    function updateSingleBuilding3D(buildingFeature, options = {}) {
        const { skipFit = false, buildings = null } = options;
        if (typeof THREE === 'undefined') return;
        if (!single3D.renderer) {
            initSingleBuilding3D(singleBlockFeature);
        }
        if (!single3D.buildingGroup) return;

        const targets = Array.isArray(buildings) && buildings.length
            ? buildings
            : (buildingEntries && buildingEntries.length ? buildingEntries : (buildingFeature ? [{ feature: buildingFeature, height: currentHeightM }] : []));

        if (!targets.length) return;

        clearThreeGroup(single3D.buildingGroup);

        single3D.projector = single3D.projector || getSingleProjector();
        const origin = single3D.originHTRS || computeFeatureOrigin(singleBlockFeature, single3D.projector) || [0, 0];
        single3D.originHTRS = origin;

        targets.forEach(target => {
            if (!target || !target.feature || !target.feature.geometry) return;
            const heightMeters = Math.max(3, Number(target.height || target.feature?.properties?.height || currentHeightM) || DEFAULT_HEIGHT_M);
            const colorValue = target.color || target.feature?.properties?.color || '#0d6efd';
            const material = new THREE.MeshPhongMaterial({
                color: new THREE.Color(colorValue),
                transparent: true,
                opacity: 0.9,
                polygonOffset: true,
                polygonOffsetFactor: 1,
                polygonOffsetUnits: 1
            });

            const meshes = createSingleMeshesFromGeoJSON(target.feature.geometry, material, heightMeters, origin);
            meshes.forEach(mesh => {
                single3D.buildingGroup.add(mesh);
                try {
                    const edges = new THREE.EdgesGeometry(mesh.geometry);
                    const edgeLines = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: new THREE.Color(colorValue).offsetHSL(0, 0, -0.2) }));
                    single3D.buildingGroup.add(edgeLines);
                } catch (_) { }
            });
            try { if (typeof material.dispose === 'function') material.dispose(); } catch (_) { }

            if (target.name) {
                addLabelToBuilding3D(target, origin, heightMeters);
            }
        });

        if (!skipFit) {
            const tallest = Math.max(...targets.map(t => Math.max(3, Number(t.height || t.feature?.properties?.height || currentHeightM) || DEFAULT_HEIGHT_M)));
            fitSingleBuildingCamera(tallest > 80 ? 1.6 : 1.35);
        }
    }

    function buildRectangleFeature(centerLatLng, widthM, lengthM, chamferM, heightM, rotationDeg = 0) {
        // Build rectangle in meters using map CRS (WebMercator). Assumes WGS84 inputs.
        const centerLL = L.latLng(centerLatLng.lat, centerLatLng.lng);
        const projector = getSingleProjector();

        const halfW = Math.max(0.5, widthM / 2);
        const halfL = Math.max(0.5, lengthM / 2);
        const maxChamferX = Math.max(0, halfW - 0.1);
        const maxChamferY = Math.max(0, halfL - 0.1);
        const dX = Math.min(Math.max(0, chamferM || 0), maxChamferX);
        const dY = Math.min(Math.max(0, chamferM || 0), maxChamferY);

        let ring;

        if (projector) {
            // The projected ring math lives in frontend/js/single-building-geometry.js (tested). It
            // scales the ground-metre size by 1/cos(lat) before offsetting in Mercator space — the
            // fix for buildings coming out cos(φ) too small (a "20 m" building was ~14 m at Zagreb).
            ring = window.SingleBuildingGeometry.buildRectangleRing(
                projector,
                { lat: centerLL.lat, lng: centerLL.lng },
                { widthM, lengthM, chamferM, rotationDeg }
            );
        } else {
            // Rhumb fallback
            const centerPt = turf.point([centerLL.lng, centerLL.lat]);
            const east = turf.rhumbDestination(centerPt, halfW / 1000, 90).geometry.coordinates[0];
            const west = turf.rhumbDestination(centerPt, halfW / 1000, 270).geometry.coordinates[0];
            const north = turf.rhumbDestination(centerPt, halfL / 1000, 0).geometry.coordinates[1];
            const south = turf.rhumbDestination(centerPt, halfL / 1000, 180).geometry.coordinates[1];
            const chamferXDeg = dX > 0 ? turf.rhumbDestination(centerPt, dX / 1000, 90).geometry.coordinates[0] - centerLL.lng : 0;
            const chamferYDeg = dY > 0 ? turf.rhumbDestination(centerPt, dY / 1000, 0).geometry.coordinates[1] - centerLL.lat : 0;

            let pts;
            if (dX > 0 || dY > 0) {
                pts = [
                    [west + chamferXDeg, south],
                    [east - chamferXDeg, south],
                    [east, south + chamferYDeg],
                    [east, north - chamferYDeg],
                    [east - chamferXDeg, north],
                    [west + chamferXDeg, north],
                    [west, north - chamferYDeg],
                    [west, south + chamferYDeg]
                ];
            } else {
                pts = [
                    [west, south],
                    [east, south],
                    [east, north],
                    [west, north]
                ];
            }
            // Apply rotation using turf.transformRotate
            const unrotatedFeature = {
                type: 'Feature',
                properties: {},
                geometry: { type: 'Polygon', coordinates: [ensureClosed(pts)] }
            };
            if (rotationDeg !== 0) {
                try {
                    const rotated = turf.transformRotate(unrotatedFeature, rotationDeg, { pivot: [centerLL.lng, centerLL.lat] });
                    ring = rotated.geometry.coordinates[0];
                } catch (_) {
                    ring = pts;
                }
            } else {
                ring = pts;
            }
        }

        const closed = ensureClosed(ring);

        const context = getSingleBuildingContext();
        const blockLabel = context && context.blockName ? context.blockName : null;

        return {
            type: 'Feature',
            properties: {
                type: 'proposedBuildingSingle',
                width: widthM,
                length: lengthM,
                height: heightM || DEFAULT_HEIGHT_M,
                chamfer: chamferM || 0,
                rotation: rotationDeg || 0,
                block: blockLabel
            },
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

    function getCurrentCenter() {
        if (lastValidCenter) return lastValidCenter;
        const active = getActiveBuilding();
        const geomFeature = (active && active.feature) || singleRectFeature;
        if (geomFeature) {
            try {
                const c = turf.centroid(geomFeature);
                const [lng, lat] = c.geometry.coordinates;
                return L.latLng(lat, lng);
            } catch (_) { }
        }
        return getBlockCentroid(singleBlockFeature);
    }

    function fitRectangleAtCenter(centerLatLng, widthM, lengthM, chamferM, heightM, rotationDeg = 0) {
        if (!singleBlockFeature || !centerLatLng) return null;
        let w = widthM;
        let l = lengthM;
        let best = null;
        const maxIters = 14;
        for (let i = 0; i < maxIters; i++) {
            let candidate = buildRectangleFeature(centerLatLng, w, l, chamferM, heightM, rotationDeg);
            try { candidate = turf.rewind(candidate, { reverse: false }); } catch (_) { }
            if (rectangleFullyInsideBlock(candidate, singleBlockFeature)) {
                best = candidate;
                if (best && best.properties) {
                    best.properties.width = w;
                    best.properties.length = l;
                    best.properties.rotation = rotationDeg;
                }
                currentWidthM = w;
                currentLengthM = l;
                break;
            }
            w *= 0.93;
            l *= 0.93;
        }
        return best;
    }

    function bindRectangleLayerEvents() {
        if (!singleRectLayer) return;
        singleRectLayer.off('mousedown', handleRectDragStart);
        singleRectLayer.off('touchstart', handleRectDragStart);
        singleRectLayer.on('mousedown', handleRectDragStart);
        singleRectLayer.on('touchstart', handleRectDragStart);
        singleRectLayer.eachLayer(layer => {
            layer.off('mousedown', handleRectDragStart);
            layer.off('touchstart', handleRectDragStart);
            layer.on('mousedown', handleRectDragStart);
            layer.on('touchstart', handleRectDragStart);
            try { layer.bringToFront(); } catch (_) { }
        });
    }

    function autosaveSingleBuildingDraft() {
        const activeDraft = window.getActiveProposalDesignDraft?.();
        const context = getSingleBuildingContext();
        if (!activeDraft || !['buildings', 'row', 'parcelBased', 'single'].includes(activeDraft.adapterKey || activeDraft.goal)
            || !context?.parcels?.length || !buildingEntries.some(entry => entry?.feature)
            || typeof window.syncActiveProposalDraftFromEditor !== 'function') return;
        const parcelIds = [];
        const parentDetails = [];
        context.parcels.forEach(parcel => {
            let parcelId = null;
            try { parcelId = resolveParcelId(parcel?.feature); } catch (_) { }
            if (!parcelId) return;
            const id = String(parcelId);
            parcelIds.push(id);
            parentDetails.push({ id, number: String(parcel?.feature?.properties?.BROJ_CESTICE || id) });
        });
        const buildings = buildingEntries.filter(entry => entry?.feature).map(entry => {
            const feature = JSON.parse(JSON.stringify(entry.feature));
            feature.properties = {
                ...(feature.properties || {}),
                width: Number(entry.width),
                length: Number(entry.length),
                height: Math.max(3, Number(entry.height) || DEFAULT_HEIGHT_M),
                chamfer: Number(entry.chamfer) || 0,
                rotation: Number(entry.rotation) || 0,
                type: 'proposedBuildingSingle'
            };
            return feature;
        });
        window.syncActiveProposalDraftFromEditor('building', {
            parcelIds,
            parentDetails,
            blockName: context.blockName || describeSingleBuildingSelection(parcelIds),
            parameters: {
                typology: 'single',
                width: buildings[0]?.properties?.width ?? null,
                length: buildings[0]?.properties?.length ?? null,
                height: buildings[0]?.properties?.height ?? null,
                chamfer: buildings[0]?.properties?.chamfer ?? null,
                rotation: buildings[0]?.properties?.rotation ?? null
            },
            buildingFeature: buildings[0] || null,
            buildings
        }, { coalesceKey: 'single-building-live' });
    }

    function updateRectangleLayers() {
        if (!singleMap || !buildingEntries.length) return;
        if (!singleRectGroup) {
            singleRectGroup = L.featureGroup().addTo(singleMap);
        } else {
            singleRectGroup.clearLayers();
        }

        buildingEntries.forEach(entry => {
            if (!entry.feature) return;
            const isActive = entry.id === activeBuildingId;
            const layer = L.geoJSON(entry.feature, {
                style: {
                    color: entry.color,
                    weight: isActive ? 3 : 2,
                    fillColor: entry.color,
                    fillOpacity: isActive ? 0.4 : 0.2
                },
                interactive: isActive,
                bubblingMouseEvents: false
            }).addTo(singleRectGroup);
            if (isActive) {
                singleRectLayer = layer;
            }

            if (entry.name) {
                layer.bindTooltip(entry.name, {
                    permanent: true,
                    direction: 'center',
                    className: 'single-building-label-tooltip',
                    opacity: 0.9
                });
            }
        });

        if (singleParcelBorderLayer) {
            try { singleParcelBorderLayer.bringToFront(); } catch (_) { }
        }
        try { singleRectGroup.bringToFront(); } catch (_) { }
        bindRectangleLayerEvents();
        autosaveSingleBuildingDraft();
    }

    function pointInsideRect(latlng) {
        if (!singleRectFeature || !latlng) return false;
        try {
            const pt = turf.point([latlng.lng, latlng.lat]);
            return turf.booleanPointInPolygon(pt, singleRectFeature);
        } catch (_) {
            return false;
        }
    }

    function handleRectDragEnd() {
        rectDragActive = false;
        rectDragStartPointerPt = null;
        rectDragStartCenterPt = null;

        if (singleMap) {
            singleMap.off('mousemove', handleRectDragMove);
            singleMap.off('touchmove', handleRectDragMove);
            singleMap.off('mouseup', handleRectDragEnd);
            singleMap.off('touchend', handleRectDragEnd);
            try { singleMap.dragging.enable(); } catch (_) { }
            try { if (singleMap.boxZoom) singleMap.boxZoom.enable(); } catch (_) { }
            try { if (singleMap.doubleClickZoom) singleMap.doubleClickZoom.enable(); } catch (_) { }
        }
        document.removeEventListener('mouseup', handleRectDragEnd);
        document.removeEventListener('touchend', handleRectDragEnd);

        bindRectangleLayerEvents();
    }

    function handleRectDragMove(e) {
        if (!rectDragActive || !rectDragStartPointerPt || !rectDragStartCenterPt) return;
        if (!e || !e.latlng) return;

        const currentPt = singleMap.latLngToLayerPoint(e.latlng);
        const delta = currentPt.subtract(rectDragStartPointerPt);
        const newCenterPt = rectDragStartCenterPt.add(delta);
        const newCenter = singleMap.layerPointToLatLng(newCenterPt);
        let candidate = buildRectangleFeature(newCenter, currentWidthM, currentLengthM, currentChamferM, currentHeightM, currentRotationDeg);
        try { candidate = turf.rewind(candidate, { reverse: false }); } catch (_) { }
        if (!rectangleFullyInsideBlock(candidate, singleBlockFeature)) {
            return;
        }

        singleRectFeature = candidate;
        lastValidCenter = newCenter;
        const active = getActiveBuilding();
        if (active) {
            active.feature = candidate;
            active.lastValidCenter = newCenter;
        }
        updateRectangleLayers();
        if (singleDragMarker) {
            try { singleDragMarker.setLatLng(newCenter); } catch (_) { }
        }
        try { updateSingleBuilding3D(candidate, { skipFit: true }); } catch (_) { }
    }

    function handleRectDragStart(e) {
        if (!singleMap || !singleBlockFeature || !e || !e.latlng) return;
        // Only start a building drag when the touch is over the active building; otherwise let the map pan.
        if (!pointInsideRect(e.latlng)) return;
        try {
            if (e.originalEvent) {
                // Stop Leaflet's map drag from starting on this touch
                L.DomEvent.stop(e.originalEvent);
            } else {
                L.DomEvent.stop(e);
            }
        } catch (_) { }
        const centerLL = lastValidCenter
            || (singleDragMarker && typeof singleDragMarker.getLatLng === 'function' ? singleDragMarker.getLatLng() : null)
            || e.latlng;
        rectDragStartCenterPt = singleMap.latLngToLayerPoint(centerLL);
        rectDragStartPointerPt = singleMap.latLngToLayerPoint(e.latlng);
        rectDragActive = true;

        try { singleMap.dragging.disable(); } catch (_) { }
        try { if (singleMap.boxZoom) singleMap.boxZoom.disable(); } catch (_) { }
        try { if (singleMap.doubleClickZoom) singleMap.doubleClickZoom.disable(); } catch (_) { }
        if (e.originalEvent && typeof e.originalEvent.preventDefault === 'function') {
            e.originalEvent.preventDefault();
        }
        try { L.DomEvent.stopPropagation(e); } catch (_) { }

        singleMap.on('mousemove', handleRectDragMove);
        singleMap.on('touchmove', handleRectDragMove);
        singleMap.on('mouseup', handleRectDragEnd);
        singleMap.on('touchend', handleRectDragEnd);
        document.addEventListener('mouseup', handleRectDragEnd);
        document.addEventListener('touchend', handleRectDragEnd);
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
        if (singleParcelBorderLayer) {
            try { singleMap.removeLayer(singleParcelBorderLayer); } catch (_) { }
            singleParcelBorderLayer = null;
        }
        try {
            const layer = L.geoJSON(blockFeature, { interactive: false });
            const bounds = layer.getBounds();
            singleMap.fitBounds(bounds, { padding: [40, 40] });
        } catch (_) { }
        setTimeout(() => { try { singleMap.invalidateSize(); } catch (_) { } }, 30);

        // Draw parcel outline only (no fill)
        singleParcelBorderLayer = L.geoJSON(blockFeature, {
            style: { color: '#e53935', weight: 2, fillOpacity: 0, opacity: 1 },
            interactive: false
        }).addTo(singleMap);
    }

    function placeOrAdjustRectangle(centerLatLng) {
        if (!singleBlockFeature) return;
        let feature = fitRectangleAtCenter(centerLatLng, currentWidthM, currentLengthM, currentChamferM, currentHeightM, currentRotationDeg);
        try { if (feature) feature = turf.rewind(feature, { reverse: false }); } catch (_) { }
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
                let candidate = fitRectangleAtCenter(current, currentWidthM, currentLengthM, currentChamferM, currentHeightM, currentRotationDeg);
                try { if (candidate) candidate = turf.rewind(candidate, { reverse: false }); } catch (_) { }
                if (rectangleFullyInsideBlock(candidate, singleBlockFeature)) {
                    feature = candidate;
                    break;
                }
            }
            // If still not inside, progressively shrink until it fits
            if (!rectangleFullyInsideBlock(feature, singleBlockFeature)) {
                const shrinkFactor = 0.85;
                for (let s = 0; s < 10; s++) {
                    currentWidthM *= shrinkFactor;
                    currentLengthM *= shrinkFactor;
                    feature = fitRectangleAtCenter(centerLatLng, currentWidthM, currentLengthM, currentChamferM, currentHeightM, currentRotationDeg);
                    try { if (feature) feature = turf.rewind(feature, { reverse: false }); } catch (_) { }
                    if (rectangleFullyInsideBlock(feature, singleBlockFeature)) break;
                }
            }
        }

        singleRectFeature = feature;
        const active = getActiveBuilding();
        if (active) {
            active.feature = feature;
            active.width = currentWidthM;
            active.length = currentLengthM;
            active.chamfer = currentChamferM;
            active.height = currentHeightM;
            active.rotation = currentRotationDeg;
        }
        updateRectangleLayers();
        try { updateSingleBuilding3D(feature); } catch (_) { }

        // Marker intentionally not rendered; footprint is the only handle
        try {
            const c = turf.centroid(feature);
            const [lng, lat] = c.geometry.coordinates;
            lastValidCenter = L.latLng(lat, lng);
            if (active) active.lastValidCenter = lastValidCenter;
        } catch (_) { }
    }

    function clearSingleBuildingPendingState() {
        pendingSingleBuildingMeta = null;
        singleBuildingOverrideContext = null;
        if (typeof window !== 'undefined') {
            try { window.pendingSingleBuildingFeature = null; } catch (_) { }
            try { window.pendingSingleBuildingFeatures = null; } catch (_) { }
        }
    }

    // The X / Esc path. Closing NEVER saves — only "Done" (confirmSingleBuilding) does. When the
    // editor is running a commit-on-confirm session (a geometry edit, or a Build-palette creation)
    // the design would be lost, so ask first; declining keeps the editor open.
    async function requestCloseSingleBuildingModal() {
        if (typeof window !== 'undefined' && typeof window.confirmDiscardProposalDesignSession === 'function') {
            const proceed = await window.confirmDiscardProposalDesignSession({
                hasDesign: buildingEntries.some(entry => entry && entry.feature)
            });
            if (!proceed) return;
        }
        closeSingleBuildingModal();
    }

    // Escape closes the editor exactly like the X does (discard, after confirming).
    function handleSingleBuildingKeydown(event) {
        if (event.key !== 'Escape') return;
        if (!singleModal) return;
        event.preventDefault();
        requestCloseSingleBuildingModal();
    }

    // Pure teardown: the design is committed (or not) by the caller — "Done" saves first,
    // X/Esc discards the design session first.
    function closeSingleBuildingModal(options = {}) {
        const { preservePending = false } = options;
        document.removeEventListener('keydown', handleSingleBuildingKeydown);
        handleRectDragEnd();
        if (singleMap) {
            if (singleBlockLayer) try { singleMap.removeLayer(singleBlockLayer); } catch (_) { }
            if (singleParcelBorderLayer) try { singleMap.removeLayer(singleParcelBorderLayer); } catch (_) { }
            if (singleRectGroup) try { singleMap.removeLayer(singleRectGroup); } catch (_) { }
            singleRectGroup = null;
            singleRectLayer = null;
            try { singleMap.remove(); } catch (_) { }
            singleMap = null;
            singleBlockLayer = null;
            singleParcelBorderLayer = null;
            singleDragMarker = null;
        }
        singleMapClickHandlerBound = false;
        singleMapDragStarterBound = false;
        singleBlockFeature = null;
        singleRectFeature = null;
        currentRotationDeg = 0;
        if (!preservePending) {
            clearSingleBuildingPendingState();
        }
        disposeSingleBuilding3D();
        if (singleModal) {
            try { document.body.removeChild(singleModal); } catch (_) { }
            singleModal = null;
        }
        if (map && map.invalidateSize) map.invalidateSize();
        if (typeof window !== 'undefined') {
            // Only "Done" commits — it tears down with preservePending after saving. Every other
            // close abandons the design session, leaving the edited object exactly as it was.
            if (!preservePending) window.discardProposalDraftDesignSession?.();
            window.finishProposalDraftDesignSession?.();
        }
    }

    function confirmSingleBuilding() {
        const active = getActiveBuilding();
        const hasAnyBuilding = buildingEntries.some(b => b && b.feature);
        if (!active || !hasAnyBuilding) {
            setSingleBuildingStatus('draw_the_single_building_inside_the_selected_block_first', 'Draw the building inside the selected block first.');
            return;
        }

        const context = getSingleBuildingContext();
        if (!context || !Array.isArray(context.parcels) || context.parcels.length === 0) {
            setSingleBuildingStatus('select_a_parcel_block_before_creating_a_proposal', 'Select a parcel block before creating a proposal.');
            return;
        }

        const block = { parcels: context.parcels };
        const blockParcelIds = block.parcels.map(parcel => {
            try {
                return resolveParcelId(parcel?.feature);
            } catch (_) { return null; }
        }).filter(Boolean);
        const blockLabel = context.blockName || describeSingleBuildingSelection(blockParcelIds);
        if (!block.parcels || block.parcels.length === 0) {
            setSingleBuildingStatus('selected_block_has_no_parcels_2', 'Selected block has no parcels.');
            return;
        }

        if (typeof multiParcelSelection === 'undefined' || !multiParcelSelection || typeof multiParcelSelection.clearSelection !== 'function') {
            setSingleBuildingStatus('parcel_selection_tools_are_unavailable_cannot_prepare_proposal', 'Parcel selection tools are unavailable, cannot prepare proposal.');
            return;
        }

        multiParcelSelection.clearSelection();

        const normalizedParcelIds = [];
        const parentDetails = [];
        block.parcels.forEach(parcel => {
            const parcelId = resolveParcelId(parcel?.feature);
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
            multiParcelSelection.selectedParcels.add(idStr);
        });

        if (typeof multiParcelSelection.updateUI === 'function') {
            multiParcelSelection.updateUI();
        }

        if (!normalizedParcelIds.length) {
            setSingleBuildingStatus('could_not_determine_parcels_for_this_block', 'Could not determine parcels for this block.');
            return;
        }

        const clonedBuildings = [];
        for (const entry of buildingEntries) {
            if (!entry || !entry.feature) continue;
            const cloned = JSON.parse(JSON.stringify(entry.feature));
            if (!cloned.properties) cloned.properties = {};
            cloned.properties.width = Number(entry.width);
            cloned.properties.length = Number(entry.length);
            cloned.properties.height = Math.max(3, Number(entry.height) || DEFAULT_HEIGHT_M);
            cloned.properties.chamfer = Number(entry.chamfer) || 0;
            cloned.properties.rotation = Number(entry.rotation) || 0;
            cloned.properties.block = blockLabel || cloned.properties.block || null;
            cloned.properties.type = 'proposedBuildingSingle';
            cloned.properties.color = entry.color;
            clonedBuildings.push({
                id: entry.id,
                name: entry.name,
                color: entry.color,
                feature: cloned,
                width: cloned.properties.width,
                length: cloned.properties.length,
                height: cloned.properties.height,
                chamfer: cloned.properties.chamfer,
                rotation: cloned.properties.rotation
            });
        }

        if (!clonedBuildings.length) {
            setSingleBuildingStatus('unable_to_prepare_building_geometry_for_proposal', 'Unable to prepare building geometry for proposal.');
            return;
        }

        if (typeof window !== 'undefined') {
            try { window.pendingSingleBuildingFeatures = clonedBuildings.map(b => b.feature); } catch (_) { }
            try { window.pendingSingleBuildingFeature = clonedBuildings[0]?.feature || null; } catch (_) { }
        }

        pendingSingleBuildingMeta = {
            blockName: blockLabel,
            parcelIds: normalizedParcelIds.slice(),
            buildings: clonedBuildings
        };

        const buildingFeatures = clonedBuildings.map(b => b.feature).filter(f => f && f.geometry);
        const singleContext = {
            parcelIds: normalizedParcelIds.slice(),
            parentDetails: parentDetails.slice(),
            blockName: blockLabel,
            parameters: {
                typology: 'single',
                width: clonedBuildings[0]?.width ?? null,
                length: clonedBuildings[0]?.length ?? null,
                height: clonedBuildings[0]?.height ?? null,
                chamfer: clonedBuildings[0]?.chamfer ?? null,
                rotation: clonedBuildings[0]?.rotation ?? null
            },
            buildingFeature: buildingFeatures[0] || null,
            buildings: buildingFeatures
        };
        if (typeof setPendingBuildingProposalContext === 'function') {
            setPendingBuildingProposalContext(singleContext);
        } else if (typeof window !== 'undefined') {
            window.pendingBuildingProposalContext = singleContext;
        }
        if (typeof window !== 'undefined') {
            window.pendingBuildingFromBlockify = buildingFeatures[0] || null;
        }

        closeSingleBuildingModal({ preservePending: true });

        setSingleBuildingStatus('single_building_design_saved_complete_the_proposal_form_to_submit', 'Single building design saved. Complete the proposal form to submit.');

        const description = document.getElementById('proposalDescription');
        if (description) description.focus();
    }

    function createSingleBuildingProposal(event) {
        if (event && typeof event.preventDefault === 'function') {
            event.preventDefault();
        }

        const authorInput = document.getElementById('proposalAuthor');
        const typeInput = document.getElementById('proposalType');
        const descriptionInput = document.getElementById('proposalDescription');
        const offerInput = document.getElementById('proposalOffer');

        const author = (typeof getProposalAuthorValue === 'function'
            ? getProposalAuthorValue()
            : (authorInput ? authorInput.value.trim() : ''));
        const proposalType = typeInput ? typeInput.value : 'Building(s)';
        const nameInput = document.getElementById('proposalName');
        const proposalName = (nameInput && nameInput.value ? nameInput.value.trim() : '')
            || (typeof generateDefaultProposalName === 'function' ? generateDefaultProposalName(proposalType) : proposalType);
        const description = descriptionInput ? descriptionInput.value.trim() : '';
        const offer = offerInput ? (typeof window.parseProposalOfferValue === 'function' ? window.parseProposalOfferValue(offerInput.value) : parseFloat(offerInput.value)) : NaN;

        if (!author) {
            showSingleBuildingAlert('please_enter_an_author_name', 'Please enter an author name.');
            return;
        }
        if (!proposalType) {
            showSingleBuildingAlert('please_choose_a_proposal_type', 'Please choose a proposal type.');
            return;
        }
        if (!description) {
            showSingleBuildingAlert('please_enter_a_description_for_the_proposal', 'Please enter a description for the proposal.');
            return;
        }
        if (!Number.isFinite(offer) || offer <= 0) {
            showSingleBuildingAlert('please_enter_a_valid_offer_amount_eur', 'Please enter a valid offer amount (EUR).');
            return;
        }

        const buildingMetaList = Array.isArray(pendingSingleBuildingMeta?.buildings)
            ? pendingSingleBuildingMeta.buildings
            : [];
        const pendingFeatureList = (typeof window !== 'undefined')
            ? (window.pendingSingleBuildingFeatures
                || (window.pendingSingleBuildingFeature ? [window.pendingSingleBuildingFeature] : []))
            : [];
        const preparedBuildings = buildingMetaList.map(b => {
            if (!b || !b.feature || !b.feature.geometry) return null;
            const feature = JSON.parse(JSON.stringify(b.feature));
            return {
                id: b.id,
                name: b.name,
                color: b.color,
                feature,
                width: Number(b.width),
                length: Number(b.length),
                height: Math.max(3, Number(b.height) || DEFAULT_HEIGHT_M),
                chamfer: Number(b.chamfer) || 0
            };
        }).filter(Boolean);

        if (!preparedBuildings.length) {
            pendingFeatureList.forEach(f => {
                if (f && f.geometry) {
                    try {
                        const clone = JSON.parse(JSON.stringify(f));
                        preparedBuildings.push({
                            id: null,
                            name: 'Building',
                            color: null,
                            feature: clone,
                            width: Number(clone?.properties?.width) || currentWidthM,
                            length: Number(clone?.properties?.length) || currentLengthM,
                            height: Math.max(3, Number(clone?.properties?.height) || DEFAULT_HEIGHT_M),
                            chamfer: Number(clone?.properties?.chamfer) || 0
                        });
                    } catch (_) { }
                }
            });
        }

        if (!preparedBuildings.length) {
            showSingleBuildingAlert('no_building_geometry_prepared_please_create_the_building_again', 'No building geometry prepared. Please create the building again.');
            return;
        }

        const blockName = (pendingSingleBuildingMeta && pendingSingleBuildingMeta.blockName) || (getSingleBuildingContext()?.blockName) || selectedBlockName || null;

        let finalParcelIds = [];
        if (typeof multiParcelSelection !== 'undefined' && multiParcelSelection.selectedParcels && multiParcelSelection.selectedParcels.size > 0) {
            finalParcelIds = Array.from(multiParcelSelection.selectedParcels);
        } else if (pendingSingleBuildingMeta && Array.isArray(pendingSingleBuildingMeta.parcelIds) && pendingSingleBuildingMeta.parcelIds.length > 0) {
            finalParcelIds = pendingSingleBuildingMeta.parcelIds.slice();
        }

        finalParcelIds = finalParcelIds
            .map(value => value != null ? value.toString() : null)
            .filter(Boolean);

        if (finalParcelIds.length === 0) {
            showSingleBuildingAlert('no_parcels_selected_for_this_proposal', 'No parcels selected for this proposal.');
            return;
        }

        const uniqueParcelIds = Array.from(new Set(finalParcelIds));

        const parentDetails = uniqueParcelIds.map(idStr => {
            let parcelNumber = idStr;
            try {
                if (typeof multiParcelSelection !== 'undefined' && typeof multiParcelSelection.findParcelById === 'function') {
                    const layer = multiParcelSelection.findParcelById(idStr);
                    if (layer && layer.feature && layer.feature.properties && layer.feature.properties.BROJ_CESTICE) {
                        parcelNumber = String(layer.feature.properties.BROJ_CESTICE);
                    }
                }
            } catch (_) { }
            return { id: idStr, number: parcelNumber };
        });

        const ancestorKey = uniqueParcelIds
            .slice()
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
            .join('|');

        const primaryBuilding = preparedBuildings[0];
        const proposedHeightMeters = Math.round(Number(primaryBuilding.height || currentHeightM || DEFAULT_HEIGHT_M));
        const proposedWidthMeters = Number(primaryBuilding.width || currentWidthM);
        const proposedLengthMeters = Number(primaryBuilding.length || currentLengthM);
        const proposedChamferMeters = Number(primaryBuilding.chamfer || currentChamferM || 0);
        const proposedRotationDeg = Number(primaryBuilding.rotation || currentRotationDeg || 0);

        if (!primaryBuilding.feature.properties) {
            primaryBuilding.feature.properties = {};
        }
        primaryBuilding.feature.properties.height = proposedHeightMeters;
        primaryBuilding.feature.properties.width = proposedWidthMeters;
        primaryBuilding.feature.properties.length = proposedLengthMeters;
        primaryBuilding.feature.properties.chamfer = proposedChamferMeters;
        primaryBuilding.feature.properties.rotation = proposedRotationDeg;
        primaryBuilding.feature.properties.block = blockName;
        primaryBuilding.feature.properties.type = 'proposedBuildingSingle';

        const buildingFeatures = preparedBuildings.map(b => {
            if (!b.feature.properties) b.feature.properties = {};
            b.feature.properties.block = blockName;
            b.feature.properties.type = 'proposedBuildingSingle';
            b.feature.properties.height = Math.max(3, Number(b.height) || DEFAULT_HEIGHT_M);
            b.feature.properties.width = Number(b.width) || currentWidthM;
            b.feature.properties.length = Number(b.length) || currentLengthM;
            b.feature.properties.chamfer = Number(b.chamfer) || 0;
            b.feature.properties.rotation = Number(b.rotation) || 0;
            b.feature.properties.color = b.color;
            return b.feature;
        });

        const buildingProperties = { ...primaryBuilding.feature.properties };

        const buildingProposalMetadata = {
            parentParcelIds: uniqueParcelIds,
            parentParcelNumbers: parentDetails,
            applied: false,
            createdFrom: 'single-building',
            blockName: blockName,
            parameters: {
                width: proposedWidthMeters,
                length: proposedLengthMeters,
                height: proposedHeightMeters,
                chamfer: proposedChamferMeters,
                rotation: proposedRotationDeg
            },
            ancestorKey
        };

        const nowIso = new Date().toISOString();
        const goal = 'Buildings';
        const offerCurrency = 'EUR';
        const geometryObject = {
            superParcel: null,
            lakeGraphics: null,
            parkGraphics: null,
            squareGraphics: null,
            roadGeometry: null,
            roadPlan: null,
            buildings: buildingFeatures.map(f => ({
                type: f.type || 'Feature',
                geometry: f.geometry ? JSON.parse(JSON.stringify(f.geometry)) : null,
                properties: f.properties ? { ...f.properties } : {}
            })),
            reparcellizationPolygons: null
        };

        const offerObject = {
            amount: offer,
            currency: offerCurrency,
            decayEnabled: false,
            decayPercent: 0,
            decayDurationMs: 0,
            depositEnabled: false,
            depositPercent: 0,
            expiresAt: null,
            isConditional: false,
            disbursementMode: 'partial'
        };

        const proposal = {
            // Canonical schema fields
            proposalId: null,
            name: proposalName,
            description: description || proposalName,
            author,
            createdAt: nowIso,
            updatedAt: nowIso,
            lifecycleStatus: 'draft',
            applied: false,
            tags: ['buildings'],
            lens: undefined,
            parentParcelIds: uniqueParcelIds,
            childParcelIds: [],
            media: { screenshotUrl: null, imageUrl: null },
            goal,
            acquisitionStrategy: 'full',
            typologyType: 'block',
            boundaryAdjustmentType: null,
            offer: offerObject,
            budget: {},
            corridorType: null,
            blockName: blockName || null,
            geometry: geometryObject,

            // Legacy/compatibility fields used elsewhere
            authorName: author,
            title: proposalName,
            proposalName: proposalName,
            offerCurrency,
            offer,
            budgetCurrency: offerCurrency,
            budget: offer,
            parcelIds: uniqueParcelIds,
            type: 'building',
            buildingProperties,
            properties: { ...buildingProperties },
            buildingProposal: buildingProposalMetadata,
            acceptedParcelIds: []
        };

        // Capture the active lens so single-building proposals carry the expected pattern and metadata
        const lensSnapshot = normalizeLensEntries(typeof getLensEntries === 'function' ? getLensEntries() : []);
        if (lensSnapshot.length) {
            proposal.lens = lensSnapshot;
        }

        const storage = (typeof Proposals !== 'undefined' && Proposals.storage) ? Proposals.storage : proposalStorage;
        const addProposalFn = storage && (storage.addProposal || storage.add);
        if (!storage || typeof addProposalFn !== 'function') {
            showSingleBuildingAlert('proposal_storage_is_unavailable', 'Proposal storage is unavailable.');
            return;
        }

        const proposalId = addProposalFn.call(storage, proposal);
        if (!proposalId) {
            showSingleBuildingAlert('a_proposal_with_the_same_parcels_already_exists', 'A proposal with the same parcels already exists.');
            return;
        }

        const primaryParcelId = uniqueParcelIds.length ? uniqueParcelIds[0] : null;

        const proposalApi = (typeof Proposals !== 'undefined' && Proposals.manager) ? Proposals.manager : ProposalManager;
        if (proposalApi && typeof proposalApi.registerBuildingProposal === 'function') {
            try {
                proposalApi.registerBuildingProposal(proposalId, uniqueParcelIds);
            } catch (error) {
                console.warn('registerBuildingProposal failed', error);
            }
        }

        if (typeof enableShowProposalsMode === 'function') {
            enableShowProposalsMode();
        } else {
            const showProposalsCheckbox = document.getElementById('showProposalsCheckbox');
            if (showProposalsCheckbox && !showProposalsCheckbox.checked) {
                showProposalsCheckbox.checked = true;
            }
            if (typeof updateProposalLayer === 'function') updateProposalLayer();
        }

        if (typeof window !== 'undefined') {
            try { window.pendingSingleBuildingFeature = null; } catch (_) { }
            try { window.pendingSingleBuildingFeatures = null; } catch (_) { }
        }
        pendingSingleBuildingMeta = null;

        if (typeof multiParcelSelection !== 'undefined') {
            multiParcelSelection.clearSelection();
            if (typeof multiParcelSelection.updateUI === 'function') multiParcelSelection.updateUI();
        }

        if (typeof hideParcelInfoPanel === 'function') {
            hideParcelInfoPanel();
        }

        if (typeof closeProposalDialog === 'function') {
            closeProposalDialog();
        }

        closeSingleBuildingModal();

        if (typeof updateProposalList === 'function') {
            updateProposalList();
        }

        if (typeof focusProposalDetails === 'function') {
            const proposalKey = proposalId || null;
            focusProposalDetails(proposalKey, {
                parcelId: primaryParcelId,
                centerOnProposal: true
            });
        }

        if (blockName && typeof refreshBlockInfoProposalTab === 'function') {
            setTimeout(() => refreshBlockInfoProposalTab(blockName), 0);
        }

        setSingleBuildingStatus(
            'single_building_proposal_created_use_apply_when_ready',
            'Proposal "{{title}}" created. Use Apply to map from the proposal details when ready.',
            { title: proposalName }
        );
    }

    function showSingleBuildingModal() {
        singleBlockFeature = getSelectedBlockFeature();
        if (!singleBlockFeature) {
            setSingleBuildingStatus('select_a_block_first', 'Select a block first');
            return;
        }

        const modalText = {
            title: translateSingleBuildingText('modal.singleBuilding.title', 'Freeform'),
            closeLabel: translateSingleBuildingText('modal.singleBuilding.closeLabel', 'Close buildings modal'),
            previewLabel: translateSingleBuildingText('modal.singleBuilding.previewLabel', '3D Preview'),
            confirm: translateSingleBuildingText('modal.singleBuilding.confirm', 'Done'),
            buildingsTitle: translateSingleBuildingText('modal.singleBuilding.buildingsTitle', 'Buildings'),
            addLabel: translateSingleBuildingText('modal.singleBuilding.addLabel', 'Add'),
            deleteLabel: translateSingleBuildingText('modal.singleBuilding.deleteLabel', 'Delete'),
            renameLabel: translateSingleBuildingText('modal.singleBuilding.renameLabel', 'Rename'),
            parametersTitle: translateSingleBuildingText('modal.singleBuilding.parametersTitle', 'Parameters'),
            widthLabel: translateSingleBuildingText('modal.singleBuilding.widthLabel', 'Width (m):'),
            lengthLabel: translateSingleBuildingText('modal.singleBuilding.lengthLabel', 'Length (m):'),
            heightLabel: translateSingleBuildingText('modal.singleBuilding.heightLabel', 'Height (m):'),
            chamferLabel: translateSingleBuildingText('modal.singleBuilding.chamferLabel', 'Chamfer (m):'),
            rotationLabel: translateSingleBuildingText('modal.singleBuilding.rotationLabel', 'Rotation (°):'),
            infoText: translateSingleBuildingText(
                'modal.singleBuilding.infoText',
                'Drag the rectangle to reposition, or drag the handles on the sides to rotate. The building must remain fully within the block.'
            )
        };

        if (!singleModal) {
            const modal = document.createElement('div');
            modal.id = 'single-building-modal';
            modal.style.position = 'fixed';
            modal.style.top = '0';
            modal.style.left = '0';
            modal.style.width = '100%';
            modal.style.height = '100%';
            modal.style.backgroundColor = 'rgba(0,0,0,0.5)';
            modal.style.zIndex = '12060';
            modal.style.display = 'flex';
            modal.style.alignItems = 'center';
            modal.style.justifyContent = 'center';

            const container = document.createElement('div');
            container.id = 'single-building-container';

            container.innerHTML = `
                <div id="single-building-header">
                    <h2>${modalText.title}</h2>
                    <button id="single-building-close" type="button" class="close-circle-btn close-circle-btn--lg" aria-label="${modalText.closeLabel}">×</button>
                </div>
                <div id="single-building-body">
                <div id="single-building-main">
                    <div id="single-building-map"></div>
                    <div class="single-building-3d-wrapper">
                        <div class="single-building-3d-label">${modalText.previewLabel}</div>
                        <div id="single-building-3d"></div>
                    </div>
                    <div id="single-building-controls">
                        <button id="single-building-confirm" class="btn btn-proposal">${modalText.confirm}</button>
                    </div>
                </div>
                <div id="single-building-sidebar">
                    <h3>${modalText.buildingsTitle}</h3>
                    <div class="building-picker-row" style="display:flex; align-items:center; gap:8px; margin-bottom:12px;">
                        <select id="single-building-selector" aria-label="${modalText.buildingsTitle}" style="flex:1 1 auto; padding:6px 8px; border-radius:6px; border:1px solid #ccc;"></select>
                        <input type="text" id="single-building-name-input" maxlength="20" style="display:none; flex:1 1 auto; padding:6px 8px; border-radius:6px; border:1px solid #ccc;" placeholder="Building Name">
                        <button id="single-building-rename" class="btn btn-light" type="button" title="${modalText.renameLabel}" aria-label="${modalText.renameLabel}" style="flex:0 0 auto; padding:0; width:40px; height:40px; display:inline-flex; align-items:center; justify-content:center; line-height:1; font-weight:bold;">T</button>
                        <button id="single-building-delete" class="btn btn-light" type="button" title="${modalText.deleteLabel}" aria-label="${modalText.deleteLabel}" style="flex:0 0 auto; padding:0; width:40px; height:40px; display:inline-flex; align-items:center; justify-content:center; line-height:1;">&#128465;</button>
                        <button id="single-building-add" class="btn btn-light" type="button" title="${modalText.addLabel}" aria-label="${modalText.addLabel}" style="flex:0 0 auto; padding:0; width:40px; height:40px; display:inline-flex; align-items:center; justify-content:center; line-height:1;">+</button>
                    </div>
                    <h3>${modalText.parametersTitle}</h3>
                    <div class="parameter-group">
                        <label>${modalText.widthLabel} <span id="single-width-value">${DEFAULT_WIDTH_M}</span></label>
                        <input type="range" id="single-width-slider" min="1" max="100" step="0.5" value="${DEFAULT_WIDTH_M}">
                    </div>
                    <div class="parameter-group">
                        <label>${modalText.lengthLabel} <span id="single-length-value">${DEFAULT_LENGTH_M}</span></label>
                        <input type="range" id="single-length-slider" min="1" max="100" step="0.5" value="${DEFAULT_LENGTH_M}">
                    </div>
                    <div class="parameter-group">
                        <label>${modalText.heightLabel} <span id="single-height-value">${DEFAULT_HEIGHT_M}</span></label>
                        <input type="range" id="single-height-slider" min="3" max="250" step="1" value="${DEFAULT_HEIGHT_M}">
                    </div>
                    <div class="parameter-group">
                        <label>${modalText.chamferLabel} <span id="single-chamfer-value">${DEFAULT_CHAMFER_M}</span></label>
                        <input type="range" id="single-chamfer-slider" min="0" max="10" step="0.5" value="${DEFAULT_CHAMFER_M}">
                    </div>
                    <div class="parameter-group">
                        <label>${modalText.rotationLabel} <span id="single-rotation-value">0</span></label>
                        <input type="range" id="single-rotation-slider" min="0" max="355" step="5" value="0">
                    </div>
                    <p class="parameter-info-text">${modalText.infoText}</p>
                </div>
            </div>
        `;

            modal.appendChild(container);
            document.body.appendChild(modal);
            singleModal = modal;

            document.getElementById('single-building-close').addEventListener('click', requestCloseSingleBuildingModal);
            document.addEventListener('keydown', handleSingleBuildingKeydown);
            document.getElementById('single-building-confirm').addEventListener('click', confirmSingleBuilding);

            const wSlider = document.getElementById('single-width-slider');
            const lSlider = document.getElementById('single-length-slider');
            const hSlider = document.getElementById('single-height-slider');
            const cSlider = document.getElementById('single-chamfer-slider');
            const rSlider = document.getElementById('single-rotation-slider');
            wSlider.addEventListener('input', (e) => {
                const prevWidth = currentWidthM;
                const desiredWidth = parseFloat(e.target.value);
                const center = getCurrentCenter();
                if (!center) return;
                const fitted = fitRectangleAtCenter(center, desiredWidth, currentLengthM, currentChamferM, currentHeightM, currentRotationDeg);
                if (fitted) {
                    const finalWidth = fitted.properties?.width || desiredWidth;
                    currentWidthM = finalWidth;
                    document.getElementById('single-width-value').textContent = currentWidthM.toFixed(1);
                    singleRectFeature = fitted;
                    const active = getActiveBuilding();
                    if (active) {
                        active.width = currentWidthM;
                        active.feature = fitted;
                        active.lastValidCenter = center;
                    }
                    wSlider.value = currentWidthM;
                    updateRectangleLayers();
                    try { updateSingleBuilding3D(fitted, { skipFit: true }); } catch (_) { }
                    try { const cFeat = turf.centroid(fitted); const [lng, lat] = cFeat.geometry.coordinates; lastValidCenter = L.latLng(lat, lng); } catch (_) { }
                } else {
                    currentWidthM = prevWidth;
                    wSlider.value = prevWidth;
                    document.getElementById('single-width-value').textContent = prevWidth.toFixed(1);
                }
            });
            lSlider.addEventListener('input', (e) => {
                const prevLength = currentLengthM;
                const desiredLength = parseFloat(e.target.value);
                const center = getCurrentCenter();
                if (!center) return;
                const fitted = fitRectangleAtCenter(center, currentWidthM, desiredLength, currentChamferM, currentHeightM, currentRotationDeg);
                if (fitted) {
                    const finalLength = fitted.properties?.length || desiredLength;
                    currentLengthM = finalLength;
                    document.getElementById('single-length-value').textContent = currentLengthM.toFixed(1);
                    singleRectFeature = fitted;
                    const active = getActiveBuilding();
                    if (active) {
                        active.length = currentLengthM;
                        active.feature = fitted;
                        active.lastValidCenter = center;
                    }
                    lSlider.value = currentLengthM;
                    updateRectangleLayers();
                    try { updateSingleBuilding3D(fitted, { skipFit: true }); } catch (_) { }
                    try { const cFeat = turf.centroid(fitted); const [lng, lat] = cFeat.geometry.coordinates; lastValidCenter = L.latLng(lat, lng); } catch (_) { }
                } else {
                    currentLengthM = prevLength;
                    lSlider.value = prevLength;
                    document.getElementById('single-length-value').textContent = prevLength.toFixed(1);
                }
            });
            hSlider.addEventListener('input', (e) => {
                currentHeightM = parseFloat(e.target.value);
                document.getElementById('single-height-value').textContent = currentHeightM.toFixed(0);
                if (singleRectFeature) {
                    if (singleRectFeature.properties) singleRectFeature.properties.height = currentHeightM;
                    const active = getActiveBuilding();
                    if (active) {
                        active.height = currentHeightM;
                        active.feature = singleRectFeature;
                    }
                    try { updateSingleBuilding3D(singleRectFeature); } catch (_) { }
                }
            });
            cSlider.addEventListener('input', (e) => {
                const prevChamfer = currentChamferM;
                currentChamferM = parseFloat(e.target.value);
                document.getElementById('single-chamfer-value').textContent = currentChamferM.toFixed(1);
                const center = getCurrentCenter();
                if (!center) return;
                const fitted = fitRectangleAtCenter(center, currentWidthM, currentLengthM, currentChamferM, currentHeightM, currentRotationDeg);
                if (fitted) {
                    singleRectFeature = fitted;
                    const active = getActiveBuilding();
                    if (active) {
                        active.chamfer = currentChamferM;
                        active.feature = fitted;
                        active.lastValidCenter = center;
                    }
                    updateRectangleLayers();
                    try { updateSingleBuilding3D(fitted, { skipFit: true }); } catch (_) { }
                    try { const cFeat = turf.centroid(fitted); const [lng, lat] = cFeat.geometry.coordinates; lastValidCenter = L.latLng(lat, lng); } catch (_) { }
                } else {
                    currentChamferM = prevChamfer;
                    cSlider.value = prevChamfer;
                    document.getElementById('single-chamfer-value').textContent = prevChamfer.toFixed(1);
                }
            });
            rSlider.addEventListener('input', (e) => {
                const prevRotation = currentRotationDeg;
                const desiredRotation = parseFloat(e.target.value);
                const center = getCurrentCenter();
                if (!center) return;
                const fitted = fitRectangleAtCenter(center, currentWidthM, currentLengthM, currentChamferM, currentHeightM, desiredRotation);
                if (fitted) {
                    currentRotationDeg = desiredRotation;
                    document.getElementById('single-rotation-value').textContent = currentRotationDeg.toFixed(0);
                    singleRectFeature = fitted;
                    const active = getActiveBuilding();
                    if (active) {
                        active.rotation = currentRotationDeg;
                        active.feature = fitted;
                        active.lastValidCenter = center;
                    }
                    updateRectangleLayers();
                    try { updateSingleBuilding3D(fitted, { skipFit: true }); } catch (_) { }
                    try { const cFeat = turf.centroid(fitted); const [lng, lat] = cFeat.geometry.coordinates; lastValidCenter = L.latLng(lat, lng); } catch (_) { }
                } else {
                    currentRotationDeg = prevRotation;
                    rSlider.value = prevRotation;
                    document.getElementById('single-rotation-value').textContent = prevRotation.toFixed(0);
                }
            });

            const selector = document.getElementById('single-building-selector');
            const addBtn = document.getElementById('single-building-add');
            const deleteBtn = document.getElementById('single-building-delete');
            const renameBtn = document.getElementById('single-building-rename');
            const nameInput = document.getElementById('single-building-name-input');

            if (renameBtn && nameInput && selector) {
                renameBtn.addEventListener('click', () => {
                    const isInputVisible = nameInput.style.display !== 'none';
                    if (isInputVisible) {
                        nameInput.style.display = 'none';
                        selector.style.display = 'block';
                        const newName = nameInput.value.trim().substring(0, 20);
                        const active = getActiveBuilding();
                        if (active && newName && newName !== active.name) {
                            active.name = newName;
                            if (active.feature && active.feature.properties) {
                                active.feature.properties.name = newName;
                            }
                            refreshBuildingSelector();
                            updateRectangleLayers();
                            try { updateSingleBuilding3D(active.feature, { skipFit: true }); } catch (_) { }
                        }
                    } else {
                        const active = getActiveBuilding();
                        if (active) {
                            nameInput.value = active.name;
                            selector.style.display = 'none';
                            nameInput.style.display = 'block';
                            nameInput.focus();
                        }
                    }
                });

                const commitNameChange = () => {
                    const newName = nameInput.value.trim().substring(0, 20);
                    const active = getActiveBuilding();
                    if (active && newName) {
                        active.name = newName;
                        if (active.feature && active.feature.properties) {
                            active.feature.properties.name = newName;
                        }
                        refreshBuildingSelector();
                        updateRectangleLayers();
                        try { updateSingleBuilding3D(active.feature, { skipFit: true }); } catch (_) { }
                    }
                };

                nameInput.addEventListener('change', commitNameChange);
                nameInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        commitNameChange();
                        nameInput.style.display = 'none';
                        selector.style.display = 'block';
                    }
                });
            }

            if (selector) {
                selector.addEventListener('change', (e) => {
                    const id = Number(e.target.value);
                    if (Number.isFinite(id)) {
                        setActiveBuilding(id, { refreshUI: true });
                    }
                });
            }
            if (addBtn) {
                addBtn.addEventListener('click', () => {
                    const placement = computeInitialPlacement(singleBlockFeature);
                    const active = getActiveBuilding();
                    const baseWidth = active?.width ?? currentWidthM ?? placement.width ?? DEFAULT_WIDTH_M;
                    const baseLength = active?.length ?? currentLengthM ?? placement.length ?? DEFAULT_LENGTH_M;
                    const baseHeight = active?.height ?? currentHeightM ?? baseWidth;
                    const baseChamfer = active?.chamfer ?? currentChamferM ?? DEFAULT_CHAMFER_M;
                    const baseRotation = active?.rotation ?? currentRotationDeg ?? 0;
                    const entry = addNewBuildingEntry(placement.center, {
                        width: baseWidth,
                        length: baseLength,
                        height: baseHeight,
                        chamfer: baseChamfer,
                        rotation: baseRotation
                    });
                    refreshBuildingSelector();
                    if (entry) {
                        setActiveBuilding(entry.id, { refreshUI: true, skip3D: false });
                    }
                });
            }
            if (deleteBtn) {
                deleteBtn.addEventListener('click', () => {
                    removeActiveBuilding();
                });
            }

            // No outside-click close: a stray click on the backdrop would throw the design away.
            // The editor is left only via the X (discard, after confirming) or Done (save).
        }

        if (!singleMap) {
            singleMap = L.map('single-building-map', { zoomControl: true, dragging: true, scrollWheelZoom: true });
            L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '© OpenStreetMap contributors'
            }).addTo(singleMap);
            setTimeout(() => {
                try { singleMap.invalidateSize(); } catch (_) { }
            }, 50);
        }
        if (singleMap && !singleMapClickHandlerBound) {
            singleMap.on('click', (e) => {
                if (!e || !e.latlng) return;
                const candidate = buildRectangleFeature(e.latlng, currentWidthM, currentLengthM, currentChamferM, currentHeightM);
                if (rectangleFullyInsideBlock(candidate, singleBlockFeature)) {
                    placeOrAdjustRectangle(e.latlng);
                }
            });
            singleMapClickHandlerBound = true;
        }
        if (singleMap && !singleMapDragStarterBound) {
            const tryStartDragFromMap = (e) => {
                if (!e || !e.latlng) return;
                if (!pointInsideRect(e.latlng)) return;
                handleRectDragStart(e);
            };
            singleMap.on('mousedown', tryStartDragFromMap);
            singleMap.on('touchstart', tryStartDragFromMap);
            singleMapDragStarterBound = true;
        }

        drawBlockOnModal(singleBlockFeature);
        buildingEntries = [];
        activeBuildingId = null;
        nextBuildingId = 1;
        try { initSingleBuilding3D(singleBlockFeature); } catch (_) { }
        const initialPlacement = computeInitialPlacement(singleBlockFeature);
        const startCenter = initialPlacement.center || getBlockCentroid(singleBlockFeature);
        currentWidthM = initialPlacement.width;
        currentLengthM = initialPlacement.length;
        currentHeightM = initialPlacement.width || DEFAULT_HEIGHT_M;
        currentChamferM = DEFAULT_CHAMFER_M;
        currentRotationDeg = 0;
        singleRectFeature = null;

        // Restore a saved design over the defaults (e.g. a copied proposal). Unlike the other
        // building tools, `parameters` here only describes building #0 — each building's position
        // and any extra buildings live in the stored features — so seed from the features.
        const seedBuildings = singleBuildingSeedBuildings;
        singleBuildingSeedBuildings = null;
        let initialEntry = null;
        if (Array.isArray(seedBuildings) && seedBuildings.length) {
            seedBuildings.forEach((feature) => {
                if (!feature || !feature.geometry) return;
                const props = feature.properties || {};
                const entry = addNewBuildingEntry(featureCenterLatLng(feature) || startCenter, {
                    width: props.width,
                    length: props.length,
                    height: props.height,
                    chamfer: props.chamfer,
                    rotation: props.rotation
                });
                if (!entry) return;
                // Keep the exact stored outline rather than a re-fitted approximation of it.
                try { entry.feature = JSON.parse(JSON.stringify(feature)); } catch (_) { }
                if (!initialEntry) initialEntry = entry;
            });
        }
        if (!initialEntry) {
            initialEntry = addNewBuildingEntry(startCenter, {
                width: currentWidthM,
                length: currentLengthM,
                height: currentHeightM,
                chamfer: currentChamferM,
                rotation: currentRotationDeg
            });
        }
        refreshBuildingSelector();
        if (initialEntry) {
            setActiveBuilding(initialEntry.id, { refreshUI: true });
        } else {
            placeOrAdjustRectangle(startCenter);
        }

        // Re-run 3D init after layout settles to ensure renderer size is correct
        setTimeout(() => {
            try {
                initSingleBuilding3D(singleBlockFeature);
                if (singleRectFeature) updateSingleBuilding3D(singleRectFeature);
            } catch (_) { }
        }, 80);
        setTimeout(() => {
            try {
                initSingleBuilding3D(singleBlockFeature);
                if (singleRectFeature) updateSingleBuilding3D(singleRectFeature);
            } catch (_) { }
        }, 200);
    }

    // `initialBuildings` (optional) reopens the editor on previously-saved building features
    // instead of one default building — used by "Copy into new proposal".
    function openSingleBuildingForParcels({ blockName, parcels, initialBuildings = null }) {
        const rawParcels = Array.isArray(parcels) ? parcels.filter(Boolean) : [];
        if (!rawParcels.length) {
            setSingleBuildingStatus('select_parcels_before_launching_the_single_building_tool', 'Select parcels before launching the single building tool.');
            return;
        }
        singleBuildingSeedBuildings = (Array.isArray(initialBuildings) && initialBuildings.length) ? initialBuildings : null;
        const ids = rawParcels.map(layer => {
            try {
                return resolveParcelId(layer?.feature);
            } catch (_) { return null; }
        }).filter(Boolean);
        if (!ids.length) {
            setSingleBuildingStatus('could_not_resolve_parcel_data_for_the_single_building_tool', 'Could not resolve parcel data for the single building tool.');
            return;
        }
        singleBuildingOverrideContext = {
            blockName: blockName || describeSingleBuildingSelection(ids),
            parcels: rawParcels
        };
        showSingleBuildingModal();
    }

    // Button handler exposed globally
    function singleBuildingOnSelectedBlock() {
        // Route single-building creation through the unified Create Proposal modal
        if (typeof showProposalDialog === 'function') {
            showProposalDialog();
            setTimeout(() => {
                try {
                    if (typeof handleProposalToolButton === 'function') handleProposalToolButton('single');
                } catch (_) { }
            }, 0);
            return;
        }
        singleBuildingOverrideContext = null;
        showSingleBuildingModal();
    }

    // Headless entry for the "Upload" geometry path: turns an uploaded 3D model's
    // footprint + height into a single-building proposal without opening the placement modal.
    // The model mesh itself is previewed in the upload modal; the proposal stores the standard
    // footprint box (auto-fit to the block) so it flows through the existing building pipeline.
    function createSingleBuildingFromUpload({ blockName, parcels, width, length, height, modelName, modelUrl } = {}) {
        const rawParcels = Array.isArray(parcels) ? parcels.filter(Boolean) : [];
        if (!rawParcels.length) {
            setSingleBuildingStatus('select_parcels_before_launching_the_single_building_tool', 'Select parcels before uploading a building.');
            return false;
        }
        const ids = rawParcels.map(layer => { try { return resolveParcelId(layer?.feature); } catch (_) { return null; } }).filter(Boolean);
        if (!ids.length) {
            setSingleBuildingStatus('could_not_resolve_parcel_data_for_the_single_building_tool', 'Could not resolve parcel data for the uploaded building.');
            return false;
        }

        singleBuildingOverrideContext = { blockName: blockName || describeSingleBuildingSelection(ids), parcels: rawParcels };
        singleBlockFeature = getSelectedBlockFeature();
        if (!singleBlockFeature) {
            setSingleBuildingStatus('select_a_block_first', 'Could not build a block from the selected parcels.');
            return false;
        }

        // Reset building state so the upload produces a single, clean entry.
        buildingEntries = [];
        activeBuildingId = null;
        nextBuildingId = 1;

        const placement = computeInitialPlacement(singleBlockFeature);
        const safeHeight = Math.max(3, Math.round(Number(height) || DEFAULT_HEIGHT_M));
        const entry = addNewBuildingEntry(placement.center, {
            width: Number(width) || placement.width || DEFAULT_WIDTH_M,
            length: Number(length) || placement.length || DEFAULT_LENGTH_M,
            height: safeHeight,
            chamfer: 0,
            rotation: 0
        });
        if (!entry || !entry.feature) {
            setSingleBuildingStatus('unable_to_prepare_building_geometry_for_proposal', 'Unable to fit the uploaded building inside the selected block.');
            return false;
        }

        // Tag the footprint with the model origin so it can be recognised later.
        if (!entry.feature.properties) entry.feature.properties = {};
        entry.feature.properties.source = 'upload';
        if (modelName) entry.feature.properties.modelName = String(modelName).slice(0, 120);
        // modelUrl lets the main-map 3D view render the actual mesh instead of an extruded box.
        // It rides along in feature.properties → proposal_data JSONB → window.proposedBuildings.
        if (modelUrl) entry.feature.properties.modelUrl = String(modelUrl);
        entry.height = safeHeight;
        entry.feature.properties.height = safeHeight;

        confirmSingleBuilding();
        return true;
    }

    window.singleBuildingOnSelectedBlock = singleBuildingOnSelectedBlock;
    window.openSingleBuildingForParcels = openSingleBuildingForParcels;
    window.createSingleBuildingProposal = createSingleBuildingProposal;
    window.createSingleBuildingFromUpload = createSingleBuildingFromUpload;
    window.clearSingleBuildingPendingState = clearSingleBuildingPendingState;
})();
