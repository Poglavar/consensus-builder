// Photorealistic base layer: streams Google Photorealistic 3D Tiles (brokered by Cesium ion)
// straight into three-mode's OWN scene via 3d-tiles-renderer — no second renderer, no Cesium.
// Ported from zagreb-isochrone's photoreal sim (station-3d/world/photoreal.js): same tile
// stack, same seating technique, adapted to this app's scene frame (EPSG:3857 — XY inflated
// by 1/cos(lat), Z true metres, Z-up; see photoreal-frame.js) and to its proposal model.
// "Realistic" is a layer INSIDE 3D mode: proposals, corridors, parks and trees keep rendering
// exactly as the abstract 3D draws them, standing on the real photogrammetric city.
(function () {
    'use strict';

    // Cesium ion access token (client-side by design) — ion only brokers the Google tileset;
    // no Cesium code runs. Same token + asset as the isochrone sim.
    // TODO before public/commercial launch: rotate this token and scope it to asset 2275207.
    const ION_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI5MTBkNDc1Ny0zNzlkLTRiOTMtYTM2Zi1hZjYzNWY0MTJjMTIiLCJpZCI6NDI0MDY3LCJpYXQiOjE3NzcyNzM2ODF9.-GY-QQkFSEcYl8fkkm_u4AxVbmWY2aNefvzoHAiLuLE';
    const GOOGLE_PHOTOREALISTIC_ION_ASSET = 2275207;
    const DRACO_DECODER = 'https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/libs/draco/gltf/';

    // How far (true metres) the camera may see while the tile layer is up: keeps a tilted view
    // from streaming the whole horizon. Converted to scene metres with the Mercator factor.
    const FAR_CLAMP_TRUE_M = 2000;
    // Seating tuning, ported from the sim's lockTrackHeightOnce.
    const GROUND_BELOW_CONTENT_M = 0.2;   // mesh ground sits this far below the z=0 slabs
    const LOCK_STABLE_SAMPLES = 3;
    const LOCK_STABLE_SPREAD_M = 1.5;
    const LOCK_MAX_WAIT_S = 12;
    const LOCK_SAMPLE_INTERVAL_S = 0.25;
    const FAR_EARTH_LIMIT_M = 1500;       // |ground z| beyond this = a coarse far-earth tile
    const NO_COVERAGE_TIMEOUT_S = 20;     // nothing streamed at all -> declare no coverage

    // ---- lazy tiles library (ESM, resolved through the page's import map) ----
    let TilesRenderer, CesiumIonAuthPlugin, GLTFExtensionsPlugin, TileCompressionPlugin,
        ReorientationPlugin, DRACOLoaderCtor;
    let tilesLibPromise = null;
    function loadTilesLib() {
        if (!tilesLibPromise) {
            tilesLibPromise = Promise.all([
                import('3d-tiles-renderer/three'),
                import('3d-tiles-renderer/three/plugins'),
                import('three/addons/loaders/DRACOLoader.js')
            ]).then(function (mods) {
                ({ TilesRenderer } = mods[0]);
                ({ CesiumIonAuthPlugin, GLTFExtensionsPlugin, TileCompressionPlugin,
                    ReorientationPlugin } = mods[1]);
                DRACOLoaderCtor = mods[2].DRACOLoader;
            });
        }
        return tilesLibPromise;
    }

    // ---- state ----
    let active = false;
    let tiles = null;
    let scaleNode = null;   // (k, k, 1) Mercator inflation, scene-axis aligned
    let seatNode = null;    // vertical seating offset, scene-axis aligned (z scale is 1)
    let frameNode = null;   // fixed tiles-ENU -> scene rotation (photoreal-frame.js)
    let internals = null;   // three-mode scene internals while attached
    let mercatorK = 1;
    let savedBackground;
    let hadSavedBackground = false;
    let grounded = false;
    let lockSamples = [];
    let lockWaitS = 0;
    let lockAccumS = 0;
    let lastFrameNow = 0;
    let sinceAnyLoadS = 0;
    let statusEl = null;
    let loaderEl = null;
    let loaderTextEl = null;
    let fpsEl = null;
    let fpsFrames = 0;
    let fpsSinceS = 0;

    const containerEl = () => document.getElementById('three-container');
    const toggleBtn = () => document.getElementById('mode-realistic-toggle');

    function photorealI18n(key, fallback) {
        try {
            if (window.i18n && typeof window.i18n.t === 'function') {
                const value = window.i18n.t(key, {});
                if (value && value !== key) return value;
            }
        } catch (_) { }
        return fallback;
    }

    // ---- small in-container UI (status toast + tile-streaming indicator) ----
    function setStatus(msg) {
        const host = containerEl();
        if (!host) return;
        if (!statusEl) {
            statusEl = document.createElement('div');
            statusEl.className = 'photoreal-status';
            host.appendChild(statusEl);
        }
        statusEl.textContent = msg || '';
        statusEl.style.display = msg ? 'block' : 'none';
    }

    function updateLoader(progress) {
        const host = containerEl();
        if (!host) return;
        if (!loaderEl) {
            loaderEl = document.createElement('div');
            loaderEl.className = 'photoreal-tile-loader';
            loaderEl.innerHTML = '<span class="photoreal-spinner"></span><span>'
                + photorealI18n('threeMode.controls.streamingTiles', 'Streaming 3D tiles…')
                + '</span><span class="photoreal-tile-count"></span>';
            loaderTextEl = loaderEl.querySelector('.photoreal-tile-count');
            host.appendChild(loaderEl);
        }
        const show = active && progress < 1;
        loaderEl.classList.toggle('visible', show);
        if (show && loaderTextEl) loaderTextEl.textContent = Math.round(progress * 100) + '%';
    }

    function removeUiElements() {
        [statusEl, loaderEl, fpsEl].forEach(function (el) {
            if (el) { try { el.remove(); } catch (_) { } }
        });
        statusEl = loaderEl = loaderTextEl = fpsEl = null;
    }

    // ---- seating (port of the sim's lockTrackHeightOnce) ----
    // Raycast straight down at the scene origin (the proposal centre) against the streamed
    // tiles and shift the whole world so its ground surface sits just below the z=0 content.
    // Heights are true metres in both frames (z scale is 1), so all sim thresholds carry over.
    function tryLockGround(dtS) {
        lockWaitS += dtS;
        lockAccumS += dtS;
        if (lockAccumS < LOCK_SAMPLE_INTERVAL_S) return;
        lockAccumS = 0;
        const THREE = window.THREE;
        if (!THREE || !tiles) return;
        let groundZ = null;
        try {
            const raycaster = new THREE.Raycaster(
                new THREE.Vector3(0, 0, 4000), new THREE.Vector3(0, 0, -1), 0, 9000);
            const hits = raycaster.intersectObject(tiles.group, true);
            if (hits.length) groundZ = hits[0].point.z;
        } catch (_) { return; }
        if (groundZ === null) return;
        // Far-earth trap (from the sim): before local tiles stream in, the ray can hit a
        // coarse far-earth tile kilometres below/above; a static coarse tile passes the
        // stability test, so reject on magnitude before it can seat the world in orbit.
        if (Math.abs(groundZ) > FAR_EARTH_LIMIT_M) return;
        // Let the local tiles refine a little before trusting early readings.
        const prog = Number(tiles.loadProgress);
        if (Number.isFinite(prog) && prog < 0.95 && lockWaitS < LOCK_MAX_WAIT_S * 0.5) return;
        lockSamples.push(groundZ);
        if (lockSamples.length > LOCK_STABLE_SAMPLES) lockSamples.shift();
        const spread = Math.max.apply(null, lockSamples) - Math.min.apply(null, lockSamples);
        const stable = lockSamples.length >= LOCK_STABLE_SAMPLES && spread <= LOCK_STABLE_SPREAD_M;
        if (!stable && lockWaitS < LOCK_MAX_WAIT_S) return;
        const sorted = lockSamples.slice().sort(function (a, b) { return a - b; });
        const use = stable ? lockSamples[lockSamples.length - 1] : sorted[Math.floor(sorted.length / 2)];
        seatNode.position.z -= (use + GROUND_BELOW_CONTENT_M);
        grounded = true;
        tiles.group.visible = true;
        console.log('[photoreal] world seated: ground shifted ' + (use + GROUND_BELOW_CONTENT_M).toFixed(2)
            + ' m (' + (stable ? 'stable' : 'median-after-timeout') + ')');
    }

    // ---- per-frame hook (registered with three-mode's render loop) ----
    function onFrame(now) {
        if (!tiles || !internals) return;
        const dtS = lastFrameNow ? Math.min(0.25, (now - lastFrameNow) / 1000) : 0.016;
        lastFrameNow = now;
        const camera = internals.camera;
        const renderer = internals.renderer;
        // Vicinity-only rendering: cap how far the frustum reaches while the mesh is up.
        const farClamp = FAR_CLAMP_TRUE_M * mercatorK;
        if (camera.far > farClamp) {
            camera.far = farClamp;
            if (camera.near >= camera.far) camera.near = Math.max(0.5, camera.far / 10000);
            camera.updateProjectionMatrix();
        }
        tiles.setResolutionFromRenderer(camera, renderer);
        camera.updateMatrixWorld();
        tiles.update();
        const prog = Number(tiles.loadProgress);
        updateLoader(Number.isFinite(prog) ? prog : 1);
        // No-coverage watchdog: if nothing ever streams, say so and fall back to abstract 3D.
        if (!grounded) {
            sinceAnyLoadS = (Number.isFinite(prog) && prog > 0) ? -Infinity : sinceAnyLoadS + dtS;
            if (sinceAnyLoadS > NO_COVERAGE_TIMEOUT_S) {
                console.warn('[photoreal] no tiles streamed — no Google coverage here?');
                setStatus(photorealI18n('threeMode.controls.noCoverage',
                    'No photorealistic coverage here — staying in abstract 3D.'));
                deactivate({ keepStatus: true });
                return;
            }
            tryLockGround(dtS);
        }
        if (fpsEl) {
            fpsFrames += 1;
            fpsSinceS += dtS;
            if (fpsSinceS >= 1) {
                fpsEl.textContent = Math.round(fpsFrames / fpsSinceS) + ' fps';
                fpsFrames = 0;
                fpsSinceS = 0;
            }
        }
    }

    // ---- activate / deactivate ----
    async function activate() {
        if (active) return;
        // Direct calls (URL-driven entry) can arrive before 3D mode is up — route through
        // the same enter-3D-first path the globe button takes, then re-enter here.
        if (!(typeof window.isThreeModeActive === 'function' && window.isThreeModeActive())) {
            goRealistic();
            return;
        }
        const btn = toggleBtn();
        if (btn) { btn.classList.add('active'); btn.disabled = true; }
        try {
            const b2 = document.getElementById('mode-2d-toggle'); if (b2) b2.classList.remove('active');
        } catch (_) { }
        document.body.classList.add('realistic-mode-active');
        try {
            internals = (typeof window.getThreeModeInternals === 'function') ? window.getThreeModeInternals() : null;
            if (!internals) throw new Error('3D mode internals unavailable');
            const anchor = internals.originLatLng();
            const frame = window.__photorealFrame;
            if (!frame) throw new Error('photoreal-frame helper missing');
            mercatorK = frame.mercatorScaleFactor(anchor.lat);

            await loadTilesLib();
            if (!document.body.classList.contains('realistic-mode-active')) return; // left meanwhile

            tiles = new TilesRenderer();
            tiles.registerPlugin(new CesiumIonAuthPlugin({
                apiToken: ION_TOKEN,
                assetId: GOOGLE_PHOTOREALISTIC_ION_ASSET
            }));
            // Anchor the ECEF tileset so the scene origin's lat/lng sits at (0,0,0) in the
            // plugin's local ENU frame; photoreal-frame.js maps that frame into the scene.
            tiles.registerPlugin(new ReorientationPlugin({
                lat: anchor.lat * Math.PI / 180,
                lon: anchor.lng * Math.PI / 180,
                height: 0
            }));
            tiles.registerPlugin(new GLTFExtensionsPlugin({
                dracoLoader: new DRACOLoaderCtor().setDecoderPath(DRACO_DECODER)
            }));
            tiles.registerPlugin(new TileCompressionPlugin());

            // Performance, straight from the sim: coarser error target (tunable via ?prq=<n>,
            // higher = lighter/blurrier), capped caches and queues so parsing never hitches.
            const prq = Number(new URLSearchParams(window.location.search || '').get('prq'));
            tiles.errorTarget = (Number.isFinite(prq) && prq > 0) ? prq : 24;
            if (tiles.lruCache) { tiles.lruCache.minSize = 300; tiles.lruCache.maxSize = 500; }
            if (tiles.parseQueue) tiles.parseQueue.maxJobs = 2;
            if (tiles.downloadQueue) tiles.downloadQueue.maxJobs = 6;

            tiles.setCamera(internals.camera);
            tiles.setResolutionFromRenderer(internals.camera, internals.renderer);

            // scene <- scaleNode(k,k,1) <- seatNode(z offset; z scale is 1, so it shifts world
            // z 1:1) <- frameNode(tiles-ENU -> scene rotation) <- tiles.group
            const THREE = window.THREE;
            scaleNode = new THREE.Group();
            scaleNode.name = 'PhotorealScale';
            scaleNode.scale.set(mercatorK, mercatorK, 1);
            seatNode = new THREE.Group();
            seatNode.name = 'PhotorealSeat';
            frameNode = new THREE.Group();
            frameNode.name = 'PhotorealFrame';
            const e = frame.TILES_FRAME_EULER;
            frameNode.rotation.set(e.x, e.y, e.z, e.order);
            frameNode.add(tiles.group);
            seatNode.add(frameNode);
            scaleNode.add(seatNode);
            // Hidden until seated: the first visible frame is the city in place, not a mesh
            // sliding into position.
            tiles.group.visible = false;
            internals.scene.add(scaleNode);

            // Sky instead of the abstract near-white while the real world is the backdrop.
            savedBackground = internals.scene.background;
            hadSavedBackground = true;
            internals.scene.background = new THREE.Color(0x87ceeb);

            grounded = false;
            lockSamples = [];
            lockWaitS = 0;
            lockAccumS = 0;
            lastFrameNow = 0;
            sinceAnyLoadS = 0;
            if (new URLSearchParams(window.location.search || '').get('fps')) {
                fpsEl = document.createElement('div');
                fpsEl.className = 'photoreal-status';
                fpsEl.style.display = 'block';
                fpsEl.style.top = '8px';
                containerEl().appendChild(fpsEl);
            }
            if (typeof window.registerThreeModeFrameHook === 'function') {
                window.registerThreeModeFrameHook(onFrame);
            }
            active = true;
            console.log('[photoreal] streaming Google 3D Tiles anchored at '
                + anchor.lat.toFixed(5) + ',' + anchor.lng.toFixed(5) + ' (k=' + mercatorK.toFixed(3) + ')');
        } catch (err) {
            console.error('[photoreal] activation failed:', err);
            setStatus('Failed to load photorealistic 3D.');
            deactivate({ keepStatus: true });
        } finally {
            if (btn) btn.disabled = false;
            if (typeof window.updateModeButtonStates === 'function') window.updateModeButtonStates();
        }
    }

    function deactivate(options) {
        options = options || {};
        active = false;
        if (typeof window.unregisterThreeModeFrameHook === 'function') {
            window.unregisterThreeModeFrameHook(onFrame);
        }
        if (internals && internals.scene) {
            if (scaleNode) { try { internals.scene.remove(scaleNode); } catch (_) { } }
            if (hadSavedBackground) {
                try { internals.scene.background = savedBackground; } catch (_) { }
            }
        }
        hadSavedBackground = false;
        if (tiles) { try { tiles.dispose(); } catch (_) { } }
        tiles = null;
        scaleNode = seatNode = frameNode = null;
        internals = null;
        grounded = false;
        if (options.keepStatus) {
            if (loaderEl) loaderEl.classList.remove('visible');
            setTimeout(function () { removeUiElements(); }, 6000);
        } else {
            removeUiElements();
        }
        document.body.classList.remove('realistic-mode-active');
        const btn = toggleBtn();
        if (btn) btn.classList.remove('active');
        if (typeof window.updateModeButtonStates === 'function') window.updateModeButtonStates();
    }

    function toggle() {
        if (active) deactivate(); else goRealistic();
    }

    // Globe-button click: layer the real world into 3D mode. From 2D it first enters abstract
    // 3D and waits for the scene to actually be up (threeModeReady) before attaching tiles.
    function goRealistic() {
        if (active) return;
        if (typeof window.isThreeModeActive === 'function' && window.isThreeModeActive()) {
            activate();
            return;
        }
        if (typeof window.enterThreeMode !== 'function') { activate(); return; }
        const btn = toggleBtn();
        if (btn) btn.classList.add('active');
        try {
            const b2 = document.getElementById('mode-2d-toggle'); if (b2) b2.classList.remove('active');
        } catch (_) { }
        const onReady = function () { window.removeEventListener('threeModeReady', onReady); activate(); };
        window.addEventListener('threeModeReady', onReady);
        try { window.enterThreeMode(); } catch (_) { window.removeEventListener('threeModeReady', onReady); }
    }

    // Auto-exit when the user leaves 3D mode entirely (three-mode clears the body class).
    const bodyObserver = new MutationObserver(function () {
        if (active && !document.body.classList.contains('three-mode-active')) {
            deactivate();
        }
    });
    bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    function init() {
        const btn = toggleBtn();
        if (btn) btn.addEventListener('click', toggle);
        if (typeof window.updateModeButtonStates === 'function') window.updateModeButtonStates();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.PhotorealMode = {
        activate: activate,
        deactivate: deactivate,
        toggle: toggle,
        isActive: function () { return active; },
        getViewer: function () { return tiles; }
    };
})();
