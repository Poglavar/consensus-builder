// Shared scene scaffolding for the per-proposal 3D edit views (single-building,
// row-house, parcel-based). Each view used to inline ~80 lines of identical
// THREE setup; this factory keeps the scaffolding in one place so future
// additions (lights, helpers, hooks like the context-buildings group) stay
// one-touch instead of four-touch.

(function () {
    if (typeof window === 'undefined') return;
    if (typeof THREE === 'undefined') {
        console.warn('[ThreeEditScene] THREE.js not available; skipping init.');
        return;
    }

    function clearGroup(group) {
        if (!group) return;
        for (let i = group.children.length - 1; i >= 0; i--) {
            const child = group.children[i];
            try { if (child.geometry && typeof child.geometry.dispose === 'function') child.geometry.dispose(); } catch (_) { }
            try {
                if (child.material) {
                    if (Array.isArray(child.material)) child.material.forEach(m => { if (m && typeof m.dispose === 'function') m.dispose(); });
                    else if (typeof child.material.dispose === 'function') child.material.dispose();
                }
            } catch (_) { }
            try { group.remove(child); } catch (_) { }
        }
    }

    // (lng, lat) -> [x, y] using the supplied Leaflet map's CRS, or EPSG:3857 by default.
    function getProjector(leafletMap) {
        const crs = (leafletMap && leafletMap.options && leafletMap.options.crs) || L.CRS.EPSG3857;
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

    // Centroid-of-vertices in projected XY. Accepts a single Feature or an array.
    function computeOriginFromFeatures(featuresOrFeature, projector) {
        if (!projector || typeof projector.project !== 'function') return [0, 0];
        const features = Array.isArray(featuresOrFeature) ? featuresOrFeature : [featuresOrFeature];
        const coords = [];
        for (const feature of features) {
            if (!feature || !feature.geometry) continue;
            const geom = feature.geometry;
            if (geom.type === 'Polygon') {
                geom.coordinates.forEach(ring => ring.forEach(c => { if (Array.isArray(c) && c.length === 2) coords.push(c); }));
            } else if (geom.type === 'MultiPolygon') {
                geom.coordinates.forEach(poly => poly.forEach(ring => ring.forEach(c => { if (Array.isArray(c) && c.length === 2) coords.push(c); })));
            }
        }
        if (!coords.length) return [0, 0];
        let sumX = 0, sumY = 0;
        for (const [lng, lat] of coords) {
            const [x, y] = projector.project(L.latLng(lat, lng));
            sumX += x;
            sumY += y;
        }
        return [sumX / coords.length, sumY / coords.length];
    }

    // Builds the standard scaffolding (scene/camera/renderer/orbit/lights/grid/axes/contextGroup)
    // and starts the animate + resize loops. Returns a handle with everything the caller needs;
    // the caller adds its own model groups and is responsible for fitCamera-style policy.
    //
    // opts: { container, defaultHeight = 200, background = 0xf8f9fa, gridSize = 2000,
    //         gridDivisions = 40, axesSize = 80, dampingFactor = 0.08 }
    function create(opts) {
        const container = opts && opts.container;
        if (!container) throw new Error('[ThreeEditScene] container is required');

        const defaultHeight = (opts && opts.defaultHeight) || 200;
        const background = (opts && opts.background !== undefined) ? opts.background : 0xf8f9fa;
        const gridSize = (opts && opts.gridSize) || 2000;
        const gridDivisions = (opts && opts.gridDivisions) || 40;
        const axesSize = (opts && opts.axesSize) || 80;
        const dampingFactor = (opts && opts.dampingFactor) || 0.08;

        const sizeStr = typeof defaultHeight === 'number' ? `${defaultHeight}px` : String(defaultHeight);
        if (!container.style.minHeight) container.style.minHeight = sizeStr;
        if (!container.style.height) container.style.height = sizeStr;

        const w0 = Math.max(1, container.clientWidth || 600);
        const h0 = Math.max(1, container.clientHeight || (typeof defaultHeight === 'number' ? defaultHeight : 200));

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(background);

        const camera = new THREE.PerspectiveCamera(45, w0 / h0, 0.1, 10000);
        camera.up.set(0, 0, 1);

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(w0, h0);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        container.appendChild(renderer.domElement);
        renderer.domElement.style.touchAction = 'none';
        renderer.domElement.style.cursor = 'grab';
        container.style.pointerEvents = 'auto';

        const OrbitControlsCtor = (THREE.OrbitControls) ? THREE.OrbitControls : (window.OrbitControls || null);
        const controls = OrbitControlsCtor
            ? new OrbitControlsCtor(camera, renderer.domElement)
            : { update: () => { }, dispose: () => { }, target: new THREE.Vector3() };
        controls.enableDamping = true;
        controls.dampingFactor = dampingFactor;
        controls.enablePan = true;

        // ×π: three r155+ dropped the implicit π factor legacy lighting applied.
        scene.add(new THREE.AmbientLight(0xffffff, 0.8 * Math.PI));
        const dirLight = new THREE.DirectionalLight(0xffffff, 0.6 * Math.PI);
        dirLight.position.set(300, 300, 500);
        scene.add(dirLight);

        const grid = new THREE.GridHelper(gridSize, gridDivisions, 0xcccccc, 0xe0e0e0);
        grid.rotation.x = Math.PI / 2;
        scene.add(grid);
        scene.add(new THREE.AxesHelper(axesSize));

        // Context buildings (existing neighbours, ghost-style) live in their own group so
        // they're never included in the model-only camera-fit bbox.
        const contextGroup = new THREE.Group();
        scene.add(contextGroup);

        // Default camera framing — callers typically replace this via their own fit logic.
        camera.position.set(100, 100, 100);
        controls.target.set(0, 0, 0);
        camera.lookAt(controls.target);

        const handle = {
            container, scene, camera, renderer, controls, contextGroup,
            frameId: null,
            resizeHandler: null,
            disposed: false
        };

        const animate = () => {
            if (handle.disposed || !handle.renderer) return;
            controls.update();
            renderer.render(scene, camera);
            handle.frameId = requestAnimationFrame(animate);
        };
        handle.frameId = requestAnimationFrame(animate);

        const handleResize = () => {
            if (handle.disposed || !handle.renderer || !handle.container) return;
            const w = handle.container.clientWidth || w0;
            const h = handle.container.clientHeight || h0;
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            handle.renderer.setSize(w, h);
        };
        window.addEventListener('resize', handleResize);
        handle.resizeHandler = handleResize;

        handle.dispose = () => {
            if (handle.disposed) return;
            handle.disposed = true;
            try { if (handle.frameId) cancelAnimationFrame(handle.frameId); } catch (_) { }
            try { if (controls && typeof controls.dispose === 'function') controls.dispose(); } catch (_) { }
            try {
                if (renderer) {
                    if (typeof renderer.forceContextLoss === 'function') renderer.forceContextLoss();
                    if (typeof renderer.dispose === 'function') renderer.dispose();
                }
            } catch (_) { }
            try { window.removeEventListener('resize', handleResize); } catch (_) { }
            try { if (container) container.innerHTML = ''; } catch (_) { }
        };

        return handle;
    }

    window.ThreeEditScene = { create, getProjector, computeOriginFromFeatures, clearGroup };
})();
