// Three.js 3D Map Mode Overlay for Leaflet map
// - Renders parcels and roads as flat geometry
// - Renders buildings as extruded volumes (default 10m if unknown)
// - Provides tilt-in animation and OrbitControls

(function () {
    if (typeof THREE === 'undefined') {
        console.warn('[3D] THREE.js not available. Skipping 3D mode initialization.');
        return;
    }

    // Internal state
    let isActive = false;
    let scene = null;
    let camera = null;
    let renderer = null;
    let controls = null;
    let frameId = null;
    let origin3857 = null; // Leaflet EPSG:3857 origin for local XY

    // Groups for layers
    let flatGroup = null; // parcels + roads
    let buildingGroup = null; // buildings extrusion

    // Checkbox listeners to sync 3D buildings with sidebar
    let onShowExistingBuildingsChange = null;
    let onShowProposedBuildingsChange = null;

    const threeContainer = document.getElementById('three-container');
    const toggleBtn = document.getElementById('mode-3d-toggle');

    // Basic materials
    const materials = {
        parcels: new THREE.MeshLambertMaterial({ color: 0xdddddd, emissive: 0x000000 }),
        parcelEdges: new THREE.LineBasicMaterial({ color: 0x999999, linewidth: 1 }),
        roads: new THREE.MeshLambertMaterial({ color: 0xb0b0b0, emissive: 0x000000 }),
        roadLines: new THREE.LineBasicMaterial({ color: 0x666666, linewidth: 1 }),
        buildings: new THREE.MeshPhongMaterial({ color: 0x9aa4ad, specular: 0x333333, shininess: 20 })
    };

    // Scale factor to control how close the camera is vs top-down fit distance
    const CAMERA_DISTANCE_SCALE = 0.25; // closer (25% of top-down fit distance)

    function getOrigin3857() {
        // Use map center projected to EPSG:3857 to produce small local XY coordinates
        const center = (typeof map !== 'undefined' && map) ? map.getCenter() : { lat: 0, lng: 0 };
        const p = L.CRS.EPSG3857.project(L.latLng(center.lat, center.lng));
        return p; // {x,y}
    }

    function latLngToXY(lat, lng) {
        const p = L.CRS.EPSG3857.project(L.latLng(lat, lng));
        return [p.x - origin3857.x, p.y - origin3857.y];
    }

    function coordsToXY(coords) {
        // coords: [lng, lat]
        return latLngToXY(coords[1], coords[0]);
    }

    function arrayOfLngLatRingsToShape(rings) {
        // rings: [ [ [lng, lat], ... ], hole1, hole2, ...]
        if (!rings || rings.length === 0) return null;
        const toVec2 = (pt) => {
            const xy = coordsToXY(pt);
            return new THREE.Vector2(xy[0], xy[1]);
        };

        const outer = rings[0].map(toVec2);
        const shape = new THREE.Shape(outer);
        for (let i = 1; i < rings.length; i++) {
            const holePath = new THREE.Path(rings[i].map(toVec2));
            shape.holes.push(holePath);
        }
        return shape;
    }

    function polygonFeatureToMeshes(feature, material, z = 0, depth = 0) {
        // Returns array of THREE.Mesh (flat if depth=0, extruded if depth>0)
        const meshes = [];
        const geom = feature.geometry;
        if (!geom) return meshes;

        const addShape = (rings) => {
            const shape = arrayOfLngLatRingsToShape(rings);
            if (!shape) return;
            let geometry;
            if (depth > 0) {
                geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1 });
            } else {
                geometry = new THREE.ShapeGeometry(shape);
            }
            geometry.translate(0, 0, z);
            const mesh = new THREE.Mesh(geometry, material);
            meshes.push(mesh);
        };

        if (geom.type === 'Polygon') {
            addShape(geom.coordinates);
        } else if (geom.type === 'MultiPolygon') {
            geom.coordinates.forEach(addShape);
        }
        return meshes;
    }

    function polygonFeatureToBorderLines(feature, material, z = 0.01) {
        // Returns array of THREE.LineLoop objects for each polygon ring
        const lines = [];
        const geom = feature.geometry;
        if (!geom) return lines;

        const addRingLines = (rings) => {
            if (!rings || rings.length === 0) return;
            rings.forEach((ring) => {
                const points = ring.map((pt) => {
                    const xy = coordsToXY(pt);
                    return new THREE.Vector3(xy[0], xy[1], z);
                });
                const g = new THREE.BufferGeometry().setFromPoints(points);
                const loop = new THREE.LineLoop(g, material);
                lines.push(loop);
            });
        };

        if (geom.type === 'Polygon') {
            addRingLines(geom.coordinates);
        } else if (geom.type === 'MultiPolygon') {
            geom.coordinates.forEach(addRingLines);
        }
        return lines;
    }

    function lineFeatureToLine(feature, material, z = 0) {
        const geom = feature.geometry;
        if (!geom) return null;

        const toLine = (coords) => {
            const points = coords.map(c => {
                const xy = coordsToXY(c);
                return new THREE.Vector3(xy[0], xy[1], z);
            });
            const g = new THREE.BufferGeometry().setFromPoints(points);
            return new THREE.Line(g, material);
        };

        if (geom.type === 'LineString') {
            return toLine(geom.coordinates);
        }
        if (geom.type === 'MultiLineString') {
            const group = new THREE.Group();
            geom.coordinates.forEach(coords => {
                const line = toLine(coords);
                if (line) group.add(line);
            });
            return group;
        }
        return null;
    }

    function estimateBuildingHeightMeters(feature) {
        try {
            const props = feature.properties || {};
            if (typeof props.height === 'number' && isFinite(props.height) && props.height > 0) return props.height;
            if (typeof props.HEIGHT === 'number' && isFinite(props.HEIGHT) && props.HEIGHT > 0) return props.HEIGHT;
            if (typeof props.elevation === 'number' && isFinite(props.elevation) && props.elevation > 0) return props.elevation;
            // stories/levels fallback
            const levels = props.levels || props.storeys || props.stories || props.LEVELS || props.STORIES;
            if (typeof levels === 'number' && isFinite(levels) && levels > 0) return levels * 3.3;
        } catch (_) { }
        return 10; // default 3 stories ~10 meters
    }

    function buildParcels3D(targetGroup) {
        if (typeof parcelLayer === 'undefined' || !parcelLayer) return;
        // parcels at z=0
        parcelLayer.getLayers().forEach(l => {
            const f = l.feature;
            if (!f || !f.geometry) return;
            const meshes = polygonFeatureToMeshes(f, materials.parcels, 0, 0);
            meshes.forEach(m => targetGroup.add(m));
            const borders = polygonFeatureToBorderLines(f, materials.parcelEdges, 0.03);
            borders.forEach(line => targetGroup.add(line));
        });
    }

    function buildRoads3D(targetGroup) {
        // OSM lines as polylines at z=0.05, WFS road parcels as filled at z=0.02
        if (typeof window.osmRoadLayer !== 'undefined' && window.osmRoadLayer) {
            window.osmRoadLayer.getLayers().forEach(l => {
                const f = l.feature;
                if (!f || !f.geometry) return;
                const ln = lineFeatureToLine(f, materials.roadLines, 0.05);
                if (ln) targetGroup.add(ln);
            });
        }

        if (typeof window.wfsRoadUseLayer !== 'undefined' && window.wfsRoadUseLayer) {
            window.wfsRoadUseLayer.getLayers().forEach(l => {
                const f = l.feature;
                if (!f || !f.geometry) return;
                const meshes = polygonFeatureToMeshes(f, materials.roads, 0.02, 0);
                meshes.forEach(m => targetGroup.add(m));
            });
        }
    }

    function buildExistingBuildings3D(targetGroup) {
        if (typeof buildingLayer === 'undefined' || !buildingLayer) return;
        try {
            buildingLayer.getLayers().forEach(l => {
                const f = l.feature;
                if (!f || !f.geometry) return;
                const height = estimateBuildingHeightMeters(f);
                const meshes = polygonFeatureToMeshes(f, materials.buildings, 0, height);
                meshes.forEach(m => targetGroup.add(m));
            });
        } catch (_) { }
    }

    function buildProposedBuildings3D(targetGroup) {
        const arr = (typeof window !== 'undefined' && Array.isArray(window.proposedBuildings)) ? window.proposedBuildings : [];
        if (!arr || arr.length === 0) return;
        for (let i = 0; i < arr.length; i++) {
            const feat = arr[i];
            if (!feat || !feat.geometry) continue;
            try {
                const height = estimateBuildingHeightMeters(feat);
                const meshes = polygonFeatureToMeshes(feat, materials.buildings, 0, height);
                meshes.forEach(m => targetGroup.add(m));
            } catch (_) { }
        }
    }

    function clearGroupChildren(group) {
        if (!group) return;
        for (let i = group.children.length - 1; i >= 0; i--) group.remove(group.children[i]);
    }

    function rebuild3DBuildingsOnly() {
        if (!isActive || !buildingGroup) return;
        clearGroupChildren(buildingGroup);
        const showExisting = !!document.getElementById('showBuildings')?.checked;
        const showProposed = !!document.getElementById('showProposedBuildings')?.checked;
        if (showExisting) buildExistingBuildings3D(buildingGroup);
        if (showProposed) buildProposedBuildings3D(buildingGroup);
    }

    function computeContentBoundsXY() {
        // Try parcelLayer bounds primarily, fall back to map bounds
        let bounds = null;
        if (typeof parcelLayer !== 'undefined' && parcelLayer && parcelLayer.getBounds) {
            try { bounds = parcelLayer.getBounds(); } catch (_) { bounds = null; }
        }
        if (!bounds && typeof map !== 'undefined' && map) bounds = map.getBounds();
        if (!bounds) return { width: 100, height: 100 };
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        const [x0, y0] = latLngToXY(sw.lat, sw.lng);
        const [x1, y1] = latLngToXY(ne.lat, ne.lng);
        return { width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
    }

    function initScene() {
        // Clean up if re-initializing
        disposeScene();

        const width = Math.max(1, threeContainer.clientWidth || 800);
        const height = Math.max(1, threeContainer.clientHeight || 600);

        scene = new THREE.Scene();
        scene.background = new THREE.Color(0xf8f9fb);

        camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 200000);
        camera.up.set(0, 0, 1);

        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        threeContainer.innerHTML = '';
        threeContainer.appendChild(renderer.domElement);

        // Lights
        const hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 0.6);
        hemi.position.set(0, 0, 1);
        scene.add(hemi);

        const dir = new THREE.DirectionalLight(0xffffff, 0.8);
        dir.position.set(200, 200, 400);
        scene.add(dir);

        // Groups
        flatGroup = new THREE.Group();
        buildingGroup = new THREE.Group();
        scene.add(flatGroup);
        scene.add(buildingGroup);

        // Controls
        const OrbitControlsCtor = (THREE.OrbitControls) ? THREE.OrbitControls : (window.OrbitControls || null);
        if (OrbitControlsCtor) {
            controls = new OrbitControlsCtor(camera, renderer.domElement);
            controls.enableDamping = true;
            controls.dampingFactor = 0.05;
            controls.screenSpacePanning = true;
            controls.maxPolarAngle = Math.PI * 0.49; // limit below horizon
        }

        // Build content
        origin3857 = getOrigin3857();
        buildParcels3D(flatGroup);
        buildRoads3D(flatGroup);
        rebuild3DBuildingsOnly();

        // Camera framing that preserves current 2D view scale and center
        const content = computeContentBoundsXY();
        const target = new THREE.Vector3(0, 0, 0);
        if (controls) controls.target.copy(target);

        // Keep track of current pitch for resize
        let currentPitchRad = 0;
        const finalPitchRad = (35 * Math.PI) / 180; // ~35° tilt

        function placeCameraForPitch(pitchRad) {
            // Compute distance to fit current visible content given pitch
            const vFov = THREE.MathUtils.degToRad(camera.fov);
            const aspect = camera.aspect;
            const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);

            const width = Math.max(1, content.width);
            const height = Math.max(1, content.height);

            const distForHeightTopDown = (height / 2) / Math.tan(vFov / 2);
            const distForWidthTopDown = (width / 2) / Math.tan(hFov / 2);
            const distTopDown = Math.max(distForHeightTopDown, distForWidthTopDown);

            // Adjust for pitch: foreshortening reduces vertical ground coverage by cos(pitch)
            const distance = (distTopDown / Math.max(0.1, Math.cos(pitchRad))) * CAMERA_DISTANCE_SCALE;

            const y = Math.sin(pitchRad) * distance;
            const z = Math.cos(pitchRad) * distance;
            camera.position.set(0, y, z);
            camera.lookAt(target);
            if (controls) controls.update();
        }

        // Start at top-down, then animate to final tilt while maintaining scale
        placeCameraForPitch(0);
        const start = performance.now();
        const duration = 700; // ms
        function tiltStep(now) {
            const t = Math.min(1, (now - start) / duration);
            const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // easeInOutQuad
            const pitch = finalPitchRad * ease;
            currentPitchRad = pitch;
            placeCameraForPitch(pitch);
            renderer.render(scene, camera);
            if (t < 1) {
                frameId = requestAnimationFrame(tiltStep);
            } else {
                startLoop();
            }
        }
        frameId = requestAnimationFrame(tiltStep);

        // Resize handling
        window.addEventListener('resize', handleResize, { passive: true });

        // Checkbox listeners (sync 3D buildings with sidebar state)
        const showExistingEl = document.getElementById('showBuildings');
        const showProposedEl = document.getElementById('showProposedBuildings');
        onShowExistingBuildingsChange = () => { rebuild3DBuildingsOnly(); };
        onShowProposedBuildingsChange = () => { rebuild3DBuildingsOnly(); };
        if (showExistingEl) showExistingEl.addEventListener('change', onShowExistingBuildingsChange);
        if (showProposedEl) showProposedEl.addEventListener('change', onShowProposedBuildingsChange);
    }

    function startLoop() {
        cancelLoop();
        const loop = () => {
            if (controls) controls.update();
            renderer.render(scene, camera);
            frameId = requestAnimationFrame(loop);
        };
        frameId = requestAnimationFrame(loop);
    }

    function cancelLoop() {
        if (frameId) {
            try { cancelAnimationFrame(frameId); } catch (_) { }
            frameId = null;
        }
    }

    function handleResize() {
        if (!renderer || !camera) return;
        const w = Math.max(1, threeContainer.clientWidth || 800);
        const h = Math.max(1, threeContainer.clientHeight || 600);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
        // Re-place camera to preserve view scale on resize (using last known pitch via controls orientation)
        try {
            // Approximate pitch from camera position
            const pos = camera.position;
            const distance = Math.max(1, Math.sqrt(pos.x * pos.x + pos.y * pos.y + pos.z * pos.z));
            const pitchRad = Math.acos(Math.min(1, Math.max(-1, pos.z / distance)));
            // Recompute placement with current content bounds
            const content = computeContentBoundsXY();
            const vFov = THREE.MathUtils.degToRad(camera.fov);
            const aspect = camera.aspect;
            const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
            const width = Math.max(1, content.width);
            const height = Math.max(1, content.height);
            const distForHeightTopDown = (height / 2) / Math.tan(vFov / 2);
            const distForWidthTopDown = (width / 2) / Math.tan(hFov / 2);
            const distTopDown = Math.max(distForHeightTopDown, distForWidthTopDown);
            const newDistance = (distTopDown / Math.max(0.1, Math.cos(pitchRad))) * CAMERA_DISTANCE_SCALE;
            const y = Math.sin(pitchRad) * newDistance;
            const z = Math.cos(pitchRad) * newDistance;
            camera.position.set(0, y, z);
            camera.lookAt(new THREE.Vector3(0, 0, 0));
        } catch (_) { }
    }

    function disposeScene() {
        cancelLoop();
        if (controls && controls.dispose) {
            try { controls.dispose(); } catch (_) { }
        }
        controls = null;
        if (renderer) {
            try { renderer.dispose(); } catch (_) { }
        }
        renderer = null;
        scene = null;
        camera = null;
        flatGroup = null;
        buildingGroup = null;
        threeContainer && (threeContainer.innerHTML = '');
        window.removeEventListener('resize', handleResize);

        // Remove checkbox listeners
        try {
            const showExistingEl = document.getElementById('showBuildings');
            const showProposedEl = document.getElementById('showProposedBuildings');
            if (showExistingEl && onShowExistingBuildingsChange) showExistingEl.removeEventListener('change', onShowExistingBuildingsChange);
            if (showProposedEl && onShowProposedBuildingsChange) showProposedEl.removeEventListener('change', onShowProposedBuildingsChange);
        } catch (_) { }
        onShowExistingBuildingsChange = null;
        onShowProposedBuildingsChange = null;
    }

    function disableLeafletInteractions() {
        try { map.dragging && map.dragging.disable(); } catch (_) { }
        try { map.scrollWheelZoom && map.scrollWheelZoom.disable(); } catch (_) { }
        try { map.doubleClickZoom && map.doubleClickZoom.disable(); } catch (_) { }
        try { map.boxZoom && map.boxZoom.disable(); } catch (_) { }
        try { map.keyboard && map.keyboard.disable(); } catch (_) { }
        // Hide attribution if desired? Keep it.
    }

    function enableLeafletInteractions() {
        try { map.dragging && map.dragging.enable(); } catch (_) { }
        try { map.scrollWheelZoom && map.scrollWheelZoom.enable(); } catch (_) { }
        try { map.doubleClickZoom && map.doubleClickZoom.enable(); } catch (_) { }
        try { map.boxZoom && map.boxZoom.enable(); } catch (_) { }
        try { map.keyboard && map.keyboard.enable(); } catch (_) { }
    }

    function enter3D() {
        if (isActive) return;
        isActive = true;
        if (threeContainer) threeContainer.classList.add('active');
        if (toggleBtn) {
            toggleBtn.classList.add('active');
            toggleBtn.textContent = '2D';
            toggleBtn.title = 'Switch to 2D';
        }
        disableLeafletInteractions();
        initScene();
    }

    function exit3D() {
        if (!isActive) return;
        isActive = false;
        if (threeContainer) threeContainer.classList.remove('active');
        if (toggleBtn) {
            toggleBtn.classList.remove('active');
            toggleBtn.textContent = '3D';
            toggleBtn.title = 'Switch to 3D';
        }
        enableLeafletInteractions();
        disposeScene();
    }

    function toggle3D() {
        if (isActive) exit3D(); else enter3D();
    }

    // Optional: rebuild content if parcel data reloads while in 3D
    window.addEventListener('parcelDataLoaded', () => {
        if (!isActive) return;
        // Rebuild scene content without re-creating renderer/camera
        if (!scene) { initScene(); return; }
        // Clear groups
        if (flatGroup) {
            for (let i = flatGroup.children.length - 1; i >= 0; i--) flatGroup.remove(flatGroup.children[i]);
        }
        clearGroupChildren(buildingGroup);
        origin3857 = getOrigin3857();
        buildParcels3D(flatGroup);
        buildRoads3D(flatGroup);
        rebuild3DBuildingsOnly();
    });

    // Rebuild buildings if the 2D buildings layer updates (e.g., after fetch)
    window.addEventListener('buildingsLayerUpdated', () => {
        if (!isActive) return;
        rebuild3DBuildingsOnly();
    });

    // Rebuild on proposed buildings updates
    window.addEventListener('proposedBuildingsUpdated', () => {
        if (!isActive) return;
        rebuild3DBuildingsOnly();
    });

    // Wire button
    if (toggleBtn) {
        toggleBtn.addEventListener('click', function () {
            toggle3D();
        });
    }

    // Expose globals for debugging/manual control
    window.enterThreeMode = enter3D;
    window.exitThreeMode = exit3D;
    window.isThreeModeActive = function () { return isActive; };
})();


