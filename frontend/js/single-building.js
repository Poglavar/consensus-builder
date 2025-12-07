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
    let singleRectFeature = null;

    const single3D = {
        renderer: null,
        scene: null,
        camera: null,
        controls: null,
        frameId: null,
        container: null,
        originHTRS: null,
        blockGroup: null,
        buildingGroup: null,
        resizeHandler: null
    };

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

    // Proposed building collection shares the same layer/array as blockify
    if (typeof window !== 'undefined') {
        try { if (!Array.isArray(window.proposedBuildings)) window.proposedBuildings = []; } catch (_) { }
        try { window.pendingSingleBuildingFeature = null; } catch (_) { }
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
        try { if (single3D.frameId) cancelAnimationFrame(single3D.frameId); } catch (_) { }
        try { if (single3D.controls && typeof single3D.controls.dispose === 'function') single3D.controls.dispose(); } catch (_) { }
        try {
            if (single3D.renderer) {
                if (typeof single3D.renderer.forceContextLoss === 'function') single3D.renderer.forceContextLoss();
                if (typeof single3D.renderer.dispose === 'function') single3D.renderer.dispose();
            }
        } catch (_) { }
        if (single3D.resizeHandler) {
            try { window.removeEventListener('resize', single3D.resizeHandler); } catch (_) { }
        }
        if (single3D.container) {
            try { single3D.container.innerHTML = ''; } catch (_) { }
        }
        single3D.renderer = null;
        single3D.scene = null;
        single3D.camera = null;
        single3D.controls = null;
        single3D.frameId = null;
        single3D.container = null;
        single3D.originHTRS = null;
        single3D.blockGroup = null;
        single3D.buildingGroup = null;
        single3D.resizeHandler = null;
    }

    function computeFeatureOrigin(feature) {
        try {
            if (!feature || !feature.geometry) return [0, 0];
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
                const [x, y] = wgs84ToHTRS96(lat, lng);
                sumX += x;
                sumY += y;
            });
            return [sumX / coords.length, sumY / coords.length];
        } catch (_) {
            return [0, 0];
        }
    }

    function initSingleBuilding3D(blockFeature) {
        if (typeof THREE === 'undefined') return;
        const container = document.getElementById('single-building-3d');
        if (!container || !blockFeature || !blockFeature.geometry) return;

        disposeSingleBuilding3D();

        const width = Math.max(1, container.clientWidth || container.offsetWidth || 600);
        const height = Math.max(1, container.clientHeight || container.offsetHeight || 220);

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0xf8f9fa);

        const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000);
        camera.up.set(0, 0, 1);

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        container.appendChild(renderer.domElement);
        renderer.domElement.style.touchAction = 'none';
        renderer.domElement.style.cursor = 'grab';
        container.style.pointerEvents = 'auto';

        const OrbitControlsCtor = (typeof THREE !== 'undefined' && THREE.OrbitControls)
            ? THREE.OrbitControls
            : (typeof window !== 'undefined' ? window.OrbitControls : null);
        const controls = OrbitControlsCtor ? new OrbitControlsCtor(camera, renderer.domElement) : { update: () => { }, dispose: () => { }, target: new THREE.Vector3() };
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.enablePan = true;

        const ambLight = new THREE.AmbientLight(0xffffff, 0.8);
        const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
        dirLight.position.set(300, 300, 500);
        scene.add(ambLight);
        scene.add(dirLight);

        const grid = new THREE.GridHelper(2000, 40, 0xcccccc, 0xe0e0e0);
        grid.rotation.x = Math.PI / 2;
        scene.add(grid);

        const axes = new THREE.AxesHelper(80);
        scene.add(axes);

        const blockGroup = new THREE.Group();
        const buildingGroup = new THREE.Group();
        scene.add(blockGroup);
        scene.add(buildingGroup);

        single3D.container = container;
        single3D.renderer = renderer;
        single3D.scene = scene;
        single3D.camera = camera;
        single3D.controls = controls;
        single3D.blockGroup = blockGroup;
        single3D.buildingGroup = buildingGroup;
        single3D.originHTRS = computeFeatureOrigin(blockFeature);

        drawSingleBlock3D(blockFeature);
        fitSingleBuildingCamera();

        const animate = () => {
            if (!single3D.renderer || !single3D.scene || !single3D.camera) return;
            controls.update();
            renderer.render(scene, camera);
            single3D.frameId = requestAnimationFrame(animate);
        };
        animate();

        const handleResize = () => {
            if (!single3D.renderer || !single3D.container) return;
            const w = single3D.container.clientWidth || width;
            const h = single3D.container.clientHeight || height;
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            single3D.renderer.setSize(w, h);
        };
        window.addEventListener('resize', handleResize);
        single3D.resizeHandler = handleResize;

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
        const origin = single3D.originHTRS || [0, 0];
        const polygons = [];
        if (geom.type === 'Polygon') {
            polygons.push(geom.coordinates);
        } else if (geom.type === 'MultiPolygon') {
            polygons.push(...geom.coordinates);
        }

        const baseMaterial = new THREE.MeshLambertMaterial({ color: 0x9ec5fe, transparent: true, opacity: 0.35, depthWrite: false });
        const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x3a77c3 });

        polygons.forEach(rings => {
            if (!Array.isArray(rings) || !Array.isArray(rings[0]) || rings[0].length < 3) return;
            const shape = new THREE.Shape();
            rings[0].forEach(([lng, lat], idx) => {
                const [x, y] = wgs84ToHTRS96(lat, lng);
                const px = x - origin[0];
                const py = y - origin[1];
                if (idx === 0) shape.moveTo(px, py); else shape.lineTo(px, py);
            });

            for (let h = 1; h < rings.length; h++) {
                const path = new THREE.Path();
                const holeRing = rings[h];
                if (!Array.isArray(holeRing)) continue;
                holeRing.forEach(([lng, lat], idx) => {
                    const [x, y] = wgs84ToHTRS96(lat, lng);
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
                const [x, y] = wgs84ToHTRS96(lat, lng);
                return new THREE.Vector3(x - origin[0], y - origin[1], 0);
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
                const [x, y] = wgs84ToHTRS96(lat, lng);
                const px = x - origin[0];
                const py = y - origin[1];
                if (idx === 0) shape.moveTo(px, py); else shape.lineTo(px, py);
            });

            for (let h = 1; h < rings.length; h++) {
                const holePath = new THREE.Path();
                const ring = rings[h];
                if (!Array.isArray(ring)) continue;
                ring.forEach(([lng, lat], idx) => {
                    const [x, y] = wgs84ToHTRS96(lat, lng);
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

    function updateSingleBuilding3D(buildingFeature) {
        if (typeof THREE === 'undefined') return;
        if (!buildingFeature || !buildingFeature.geometry) return;
        if (!single3D.renderer) {
            initSingleBuilding3D(singleBlockFeature);
        }
        if (!single3D.buildingGroup) return;

        clearThreeGroup(single3D.buildingGroup);

        const origin = single3D.originHTRS || [0, 0];
        const heightMeters = Math.max(3, Number(currentHeightM) || DEFAULT_HEIGHT_M);
        const material = new THREE.MeshPhongMaterial({ color: 0x0d6efd, transparent: true, opacity: 0.9, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });

        const meshes = createSingleMeshesFromGeoJSON(buildingFeature.geometry, material, heightMeters, origin);
        meshes.forEach(mesh => {
            single3D.buildingGroup.add(mesh);
            try {
                const edges = new THREE.EdgesGeometry(mesh.geometry);
                const edgeLines = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x082c5b }));
                single3D.buildingGroup.add(edgeLines);
            } catch (_) { }
        });
        try { if (typeof material.dispose === 'function') material.dispose(); } catch (_) { }
        fitSingleBuildingCamera(heightMeters > 80 ? 1.6 : 1.35);
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

        const context = getSingleBuildingContext();
        const blockLabel = context && context.blockName ? context.blockName : null;

        const ring = pts.map(([x, y]) => {
            const [lat, lng] = htrs96ToWGS84(x, y);
            return [lng, lat];
        });
        const closed = ensureClosed(ring);
        return {
            type: 'Feature',
            properties: { type: 'proposedBuildingSingle', width: widthM, length: lengthM, height: heightM || DEFAULT_HEIGHT_M, chamfer: chamferM || 0, block: blockLabel },
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

        singleRectFeature = feature;
        try { updateSingleBuilding3D(feature); } catch (_) { }

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
                        singleRectFeature = candidate;
                        try { updateSingleBuilding3D(candidate); } catch (_) { }
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

    function clearSingleBuildingPendingState() {
        pendingSingleBuildingMeta = null;
        singleBuildingOverrideContext = null;
        if (typeof window !== 'undefined') {
            try { window.pendingSingleBuildingFeature = null; } catch (_) { }
        }
    }

    function closeSingleBuildingModal(options = {}) {
        const { preservePending = false } = options;
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
        singleRectFeature = null;
        if (!preservePending) {
            clearSingleBuildingPendingState();
        }
        disposeSingleBuilding3D();
        if (singleModal) {
            try { document.body.removeChild(singleModal); } catch (_) { }
            singleModal = null;
        }
        if (map && map.invalidateSize) map.invalidateSize();
    }

    function confirmSingleBuilding() {
        if (!singleRectFeature) {
            if (typeof updateStatus === 'function') updateStatus('Draw the single building inside the selected block first.');
            return;
        }

        const context = getSingleBuildingContext();
        if (!context || !Array.isArray(context.parcels) || context.parcels.length === 0) {
            if (typeof updateStatus === 'function') updateStatus('Select a parcel block before creating a proposal.');
            return;
        }

        const block = { parcels: context.parcels };
        const blockParcelIds = block.parcels.map(parcel => {
            try { return parcel?.feature?.properties?.CESTICA_ID?.toString(); } catch (_) { return null; }
        }).filter(Boolean);
        const blockLabel = context.blockName || describeSingleBuildingSelection(blockParcelIds);
        if (!block.parcels || block.parcels.length === 0) {
            if (typeof updateStatus === 'function') updateStatus('Selected block has no parcels.');
            return;
        }

        if (typeof multiParcelSelection === 'undefined' || !multiParcelSelection || typeof multiParcelSelection.clearSelection !== 'function') {
            if (typeof updateStatus === 'function') updateStatus('Parcel selection tools are unavailable, cannot prepare proposal.');
            return;
        }

        multiParcelSelection.clearSelection();

        const normalizedParcelIds = [];
        block.parcels.forEach(parcel => {
            const parcelId = parcel?.feature?.properties?.CESTICA_ID;
            if (!parcelId) return;
            const idStr = parcelId.toString();
            normalizedParcelIds.push(idStr);
            multiParcelSelection.selectedParcels.add(idStr);
        });

        if (typeof multiParcelSelection.updateUI === 'function') {
            multiParcelSelection.updateUI();
        }

        if (!normalizedParcelIds.length) {
            if (typeof updateStatus === 'function') updateStatus('Could not determine parcels for this block.');
            return;
        }

        if (singleRectFeature && singleRectFeature.properties) {
            singleRectFeature.properties.width = Number(currentWidthM);
            singleRectFeature.properties.length = Number(currentLengthM);
            singleRectFeature.properties.height = Math.max(3, Number(currentHeightM) || DEFAULT_HEIGHT_M);
            singleRectFeature.properties.chamfer = Number(currentChamferM) || 0;
            singleRectFeature.properties.block = blockLabel || singleRectFeature.properties.block || null;
            singleRectFeature.properties.type = 'proposedBuildingSingle';
        }

        let clonedFeature = null;
        try {
            clonedFeature = JSON.parse(JSON.stringify(singleRectFeature));
        } catch (_) {
            clonedFeature = null;
        }

        if (!clonedFeature) {
            if (typeof updateStatus === 'function') updateStatus('Unable to prepare building geometry for proposal.');
            return;
        }

        if (!clonedFeature.properties) clonedFeature.properties = {};
        clonedFeature.properties.width = Number(currentWidthM);
        clonedFeature.properties.length = Number(currentLengthM);
        clonedFeature.properties.height = Math.max(3, Number(currentHeightM) || DEFAULT_HEIGHT_M);
        clonedFeature.properties.chamfer = Number(currentChamferM) || 0;
        clonedFeature.properties.block = blockLabel || clonedFeature.properties.block || null;
        clonedFeature.properties.type = 'proposedBuildingSingle';

        if (typeof window !== 'undefined') {
            try { window.pendingSingleBuildingFeature = clonedFeature; } catch (_) { }
        }

        pendingSingleBuildingMeta = {
            blockName: blockLabel,
            parcelIds: normalizedParcelIds.slice(),
            width: Number(currentWidthM),
            length: Number(currentLengthM),
            height: Math.max(3, Number(currentHeightM) || DEFAULT_HEIGHT_M),
            chamfer: Number(currentChamferM) || 0
        };

        closeSingleBuildingModal({ preservePending: true });

        if (typeof updateStatus === 'function') {
            updateStatus('Single building design saved. Complete the proposal form to submit.');
        }

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
        const proposalType = typeInput ? typeInput.value : 'Single Building';
        const description = descriptionInput ? descriptionInput.value.trim() : '';
        const offer = offerInput ? (typeof window.parseProposalOfferValue === 'function' ? window.parseProposalOfferValue(offerInput.value) : parseFloat(offerInput.value)) : NaN;

        if (!author) {
            window.showStyledAlert('Please enter an author name.');
            return;
        }
        if (!proposalType) {
            window.showStyledAlert('Please choose a proposal type.');
            return;
        }
        if (!description) {
            window.showStyledAlert('Please enter a description for the proposal.');
            return;
        }
        if (!Number.isFinite(offer) || offer <= 0) {
            window.showStyledAlert('Please enter a valid offer amount (EUR).');
            return;
        }

        const pendingFeature = (typeof window !== 'undefined') ? window.pendingSingleBuildingFeature : null;
        if (!pendingFeature || !pendingFeature.geometry) {
            alert('No building geometry prepared. Please create the building again.');
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
            alert('No parcels selected for this proposal.');
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

        const proposedHeightMeters = Math.round(Number((pendingSingleBuildingMeta && pendingSingleBuildingMeta.height) || currentHeightM || DEFAULT_HEIGHT_M));
        const proposedWidthMeters = Number((pendingSingleBuildingMeta && pendingSingleBuildingMeta.width) || currentWidthM);
        const proposedLengthMeters = Number((pendingSingleBuildingMeta && pendingSingleBuildingMeta.length) || currentLengthM);
        const proposedChamferMeters = Number((pendingSingleBuildingMeta && pendingSingleBuildingMeta.chamfer) || currentChamferM || 0);

        let buildingFeature;
        try {
            buildingFeature = JSON.parse(JSON.stringify(pendingFeature));
        } catch (error) {
            console.warn('Failed to clone pending building feature', error);
            alert('Could not prepare building data for the proposal. Please try again.');
            return;
        }

        if (!buildingFeature.properties) {
            buildingFeature.properties = {};
        }
        buildingFeature.properties.height = proposedHeightMeters;
        buildingFeature.properties.width = proposedWidthMeters;
        buildingFeature.properties.length = proposedLengthMeters;
        buildingFeature.properties.chamfer = proposedChamferMeters;
        buildingFeature.properties.block = blockName;
        buildingFeature.properties.type = 'proposedBuildingSingle';

        const buildingProperties = { ...buildingFeature.properties };

        const buildingProposalMetadata = {
            parentParcelIds: uniqueParcelIds,
            parentParcelNumbers: parentDetails,
            status: 'unapplied',
            createdFrom: 'single-building',
            blockName: blockName,
            parameters: {
                width: proposedWidthMeters,
                length: proposedLengthMeters,
                height: proposedHeightMeters,
                chamfer: proposedChamferMeters
            },
            buildingFeature,
            ancestorKey
        };

        const proposal = {
            author,
            title: proposalType,
            description,
            offer,
            parcelIds: uniqueParcelIds,
            type: 'building',
            buildingGeometry: buildingFeature.geometry,
            buildingProperties,
            properties: { ...buildingProperties },
            buildingProposal: buildingProposalMetadata,
            acceptedParcelIds: [],
            createdAt: new Date().toISOString()
        };

        if (typeof proposalStorage === 'undefined' || typeof proposalStorage.addProposal !== 'function') {
            alert('Proposal storage is unavailable.');
            return;
        }

        const hash = proposalStorage.addProposal(proposal);
        if (!hash) {
            alert('A proposal with the same parcels already exists.');
            return;
        }

        const primaryParcelId = uniqueParcelIds.length ? uniqueParcelIds[0] : null;

        if (typeof ProposalManager !== 'undefined' && typeof ProposalManager.registerBuildingProposal === 'function') {
            try {
                ProposalManager.registerBuildingProposal(hash, uniqueParcelIds);
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
            focusProposalDetails(hash, {
                parcelId: primaryParcelId,
                centerOnProposal: true
            });
        }

        if (blockName && typeof refreshBlockInfoProposalTab === 'function') {
            setTimeout(() => refreshBlockInfoProposalTab(blockName), 0);
        }

        if (typeof updateStatus === 'function') {
            updateStatus(`Proposal "${proposalType}" created. Use Apply to map from the proposal details when ready.`);
        }
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
            modal.style.zIndex = '2400';
            modal.style.display = 'flex';
            modal.style.alignItems = 'center';
            modal.style.justifyContent = 'center';

            const container = document.createElement('div');
            container.id = 'single-building-container';

            container.innerHTML = (
                '<div id="single-building-main">' +
                '<div id="single-building-header">' +
                '<h2>Single Building</h2>' +
                '<button id="single-building-close" type="button" class="close-circle-btn close-circle-btn--lg" aria-label="Close single building modal">×</button>' +
                '</div>' +
                '<div id="single-building-map"></div>' +
                '<div class="single-building-3d-wrapper">' +
                '<div class="single-building-3d-label">3D Preview</div>' +
                '<div id="single-building-3d"></div>' +
                '</div>' +
                '<div id="single-building-controls">' +
                '<button id="single-building-confirm" class="btn btn-proposal">Done</button>' +
                '</div>' +
                '</div>' +
                '<div id="single-building-sidebar">' +
                '<h3>Parameters</h3>' +
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
                '<p class="parameter-info-text">Drag the rectangle to reposition. The building must remain fully within the block.</p>' +
                '</div>'
            );

            modal.appendChild(container);
            document.body.appendChild(modal);
            singleModal = modal;

            document.getElementById('single-building-close').addEventListener('click', closeSingleBuildingModal);
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
                if (singleRectFeature) {
                    if (singleRectFeature.properties) singleRectFeature.properties.height = currentHeightM;
                    try { updateSingleBuilding3D(singleRectFeature); } catch (_) { }
                }
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
        try { initSingleBuilding3D(singleBlockFeature); } catch (_) { }
        const startCenter = getBlockCentroid(singleBlockFeature);
        // First attempt is default 3m x 6m; if it doesn't fit due to tiny parcel, sliders allow changing
        currentWidthM = DEFAULT_WIDTH_M;
        currentLengthM = DEFAULT_LENGTH_M;
        currentHeightM = DEFAULT_HEIGHT_M;
        currentChamferM = DEFAULT_CHAMFER_M;
        singleRectFeature = null;
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

    function openSingleBuildingForParcels({ blockName, parcels }) {
        const rawParcels = Array.isArray(parcels) ? parcels.filter(Boolean) : [];
        if (!rawParcels.length) {
            if (typeof updateStatus === 'function') updateStatus('Select parcels before launching the single building tool.');
            return;
        }
        const ids = rawParcels.map(layer => {
            try { return layer?.feature?.properties?.CESTICA_ID?.toString(); } catch (_) { return null; }
        }).filter(Boolean);
        if (!ids.length) {
            if (typeof updateStatus === 'function') updateStatus('Could not resolve parcel data for the single building tool.');
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
        singleBuildingOverrideContext = null;
        showSingleBuildingModal();
    }

    window.singleBuildingOnSelectedBlock = singleBuildingOnSelectedBlock;
    window.openSingleBuildingForParcels = openSingleBuildingForParcels;
    window.createSingleBuildingProposal = createSingleBuildingProposal;
    window.clearSingleBuildingPendingState = clearSingleBuildingPendingState;
})();


