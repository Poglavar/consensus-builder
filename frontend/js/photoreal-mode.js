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
    let builtVisible = true; // three-mode's Built row drives the mesh while the layer is up
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
        // The world is in place: carve it under the proposals, swap the abstract built layers
        // for the mesh, and reveal — the first visible frame is the final composition.
        buildMaskShapes();
        renderCarveMask(0, 0);
        if (typeof window.setRealisticLayerActive === 'function') window.setRealisticLayerActive(true);
        tiles.group.visible = builtVisible;
        console.log('[photoreal] world seated: ground shifted ' + (use + GROUND_BELOW_CONTENT_M).toFixed(2)
            + ' m (' + (stable ? 'stable' : 'median-after-timeout') + ')');
    }

    // ---- carve mask: shader clip of the mesh under proposals (ported from the sim) ----
    //
    // Every tile material gets a small fragment-shader patch that DISCARDS fragments lying
    // inside the carve footprints and above the floor plane — the AEC "clip the reality mesh
    // around the design" technique. The footprints are rasterised once into a sliding
    // top-down mask texture; moving the window costs one small texture render plus two
    // uniform updates, never geometry work. The holes are filled by three-mode's own corridor
    // strips, park grounds and proposed buildings, which keep rendering at z≈0.
    const MASK_WINDOW_HALF_M = 512;  // scene metres to each side of the window centre
    const MASK_RES = 1024;           // texels across the window (1 scene-metre per texel)
    const MASK_MOVE_M = 150;         // re-render the window when the orbit target strays this far
    const CARVE_FLOOR_Z = -0.3;      // fragments above this (inside a footprint) are discarded

    let maskRT = null;
    let maskScene = null;
    let maskCamera = null;
    let maskShapesGroup = null;
    let maskMaterial = null;
    let maskReady = false;
    let maskCenterX = 0;
    let maskCenterY = 0;
    let carveProposedBuildings = true; // proposed-building footprints join the carve (roads/parks always do)
    const corridorUniforms = {
        uCorridorMask: { value: null },
        uCorridorMin: { value: null }, // THREE.Vector2, created once THREE is up
        uCorridorScale: { value: 1 / (2 * MASK_WINDOW_HALF_M) },
        uCorridorOn: { value: 0 },
        uFloorZ: { value: CARVE_FLOOR_Z }
    };

    // -- carve footprint sources (same set the Cesium version clipped with) --
    function polygonsOf(geometry) {
        if (!geometry) return [];
        if (geometry.type === 'Polygon') return [geometry.coordinates];
        if (geometry.type === 'MultiPolygon') return geometry.coordinates;
        return [];
    }

    function appliedCorridorProposals() {
        if (typeof proposalStorage === 'undefined' || typeof proposalStorage.getAllProposals !== 'function') return [];
        if (typeof window.isAppliedCorridorProposal !== 'function' || typeof window.corridorProposalDefinition !== 'function') return [];
        try {
            return proposalStorage.getAllProposals().filter(window.isAppliedCorridorProposal);
        } catch (_) { return []; }
    }

    function appliedStructureProposals() {
        if (typeof proposalStorage === 'undefined' || typeof proposalStorage.getAllProposals !== 'function') return [];
        if (typeof isApplied !== 'function') return [];
        try {
            return proposalStorage.getAllProposals().filter(function (p) {
                return p && p.structureProposal && p.structureProposal.geometry
                    && isApplied(p, p.structureProposal);
            });
        } catch (_) { return []; }
    }

    // The part of a razed building's footprint not already covered by an applied structure —
    // carving building-by-building inside a structure is redundant (its own polygon carves).
    function razedFootprintOutsideStructures(geometry) {
        if (typeof turf === 'undefined' || !turf || typeof turf.difference !== 'function') return geometry;
        let feat = { type: 'Feature', properties: {}, geometry: geometry };
        try {
            const structures = appliedStructureProposals();
            for (let i = 0; i < structures.length && feat; i++) {
                feat = turf.difference(feat,
                    { type: 'Feature', properties: {}, geometry: structures[i].structureProposal.geometry });
            }
        } catch (_) { return geometry; }
        return feat ? feat.geometry : null;
    }

    function collectCarveGeometries() {
        const out = [];
        // Applied road corridors: the surface-level footprint wins over the full outline, so
        // tunnelled / grade-separated stretches keep the mesh above them.
        appliedCorridorProposals().forEach(function (proposal) {
            const definition = window.corridorProposalDefinition(proposal);
            if (definition) {
                const geom = definition.surfaceFootprint || definition.polygon;
                if (geom && geom.type) out.push(geom);
            }
        });
        // Applied structures (parks/squares/lakes/stations) replace the ground wholesale.
        appliedStructureProposals().forEach(function (proposal) {
            out.push(proposal.structureProposal.geometry);
        });
        // Buildings a proposal razes entirely (their outlines can stick out past the footprint
        // that razed them). Cut records are skipped — their demolished part lies inside a
        // corridor footprint already; demolished PROPOSED buildings aren't in the mesh at all.
        if (typeof window.collectCarveRecords === 'function'
            && typeof proposalStorage !== 'undefined' && typeof proposalStorage.getAllProposals === 'function') {
            try {
                window.collectCarveRecords(proposalStorage.getAllProposals()).records.forEach(function (record) {
                    if (record.remainder) return;
                    if (String(record.id).indexOf('proposal:') === 0) return;
                    const outside = razedFootprintOutsideStructures(record.geometry);
                    if (outside) out.push(outside);
                });
            } catch (err) {
                console.warn('[photoreal] demolition carve collection failed', err);
            }
        }
        // Proposed buildings replace the real mesh standing on their spot.
        if (carveProposedBuildings && Array.isArray(window.proposedBuildings)) {
            window.proposedBuildings.forEach(function (feat) {
                if (feat && feat.geometry) out.push(feat.geometry);
            });
        }
        return out;
    }

    // -- mask rendering --
    function ensureMaskObjects() {
        const THREE = window.THREE;
        if (!THREE || maskRT) return;
        maskRT = new THREE.WebGLRenderTarget(MASK_RES, MASK_RES, { depthBuffer: false });
        maskRT.texture.minFilter = THREE.LinearFilter;
        maskRT.texture.magFilter = THREE.LinearFilter;
        maskRT.texture.generateMipmaps = false;
        maskScene = new THREE.Scene();
        maskScene.background = new THREE.Color(0x000000);
        // Top-down orthographic camera, up = +Y: texture v grows with scene +Y, so the shader
        // samples (xy − min) · scale directly, no flip.
        maskCamera = new THREE.OrthographicCamera(
            -MASK_WINDOW_HALF_M, MASK_WINDOW_HALF_M, MASK_WINDOW_HALF_M, -MASK_WINDOW_HALF_M, 1, 1000);
        maskCamera.up.set(0, 1, 0);
        maskMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000, side: THREE.DoubleSide });
        if (!corridorUniforms.uCorridorMin.value) corridorUniforms.uCorridorMin.value = new THREE.Vector2();
        corridorUniforms.uCorridorMask.value = maskRT.texture;
    }

    function disposeMaskShapes() {
        if (!maskShapesGroup) return;
        maskShapesGroup.traverse(function (o) {
            if (o.isMesh && o.geometry) { try { o.geometry.dispose(); } catch (_) { } }
        });
        if (maskScene) { try { maskScene.remove(maskShapesGroup); } catch (_) { } }
        maskShapesGroup = null;
    }

    // Carve footprints (lat/lng GeoJSON) → filled shapes in scene XY, on the mask scene's z=0.
    function buildMaskShapes() {
        const THREE = window.THREE;
        if (!THREE || !maskScene || !internals) return;
        disposeMaskShapes();
        maskShapesGroup = new THREE.Group();
        const toXY = internals.latLngToXY;
        collectCarveGeometries().forEach(function (geometry) {
            polygonsOf(geometry).forEach(function (rings) {
                const outer = rings && rings[0];
                if (!Array.isArray(outer) || outer.length < 3) return;
                try {
                    const shape = new THREE.Shape();
                    outer.forEach(function (c, i) {
                        const xy = toXY(c[1], c[0]);
                        if (i === 0) shape.moveTo(xy[0], xy[1]); else shape.lineTo(xy[0], xy[1]);
                    });
                    for (let h = 1; h < rings.length; h++) {
                        const ring = rings[h];
                        if (!Array.isArray(ring) || ring.length < 3) continue;
                        const hole = new THREE.Path();
                        ring.forEach(function (c, i) {
                            const xy = toXY(c[1], c[0]);
                            if (i === 0) hole.moveTo(xy[0], xy[1]); else hole.lineTo(xy[0], xy[1]);
                        });
                        shape.holes.push(hole);
                    }
                    const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), maskMaterial);
                    mesh.frustumCulled = false;
                    maskShapesGroup.add(mesh);
                } catch (_) { /* one bad polygon must not cost the rest their carve */ }
            });
        });
        maskScene.add(maskShapesGroup);
    }

    function renderCarveMask(cx, cy) {
        if (!maskRT || !maskCamera || !internals) return;
        const renderer = internals.renderer;
        try {
            maskCamera.position.set(cx, cy, 500);
            maskCamera.lookAt(cx, cy, 0);
            maskCamera.updateMatrixWorld();
            const prev = renderer.getRenderTarget();
            renderer.setRenderTarget(maskRT);
            renderer.render(maskScene, maskCamera);
            renderer.setRenderTarget(prev);
            corridorUniforms.uCorridorMin.value.set(cx - MASK_WINDOW_HALF_M, cy - MASK_WINDOW_HALF_M);
            corridorUniforms.uCorridorOn.value = 1;
            maskCenterX = cx;
            maskCenterY = cy;
            maskReady = true;
        } catch (err) {
            console.warn('[photoreal] carve mask render failed', err);
            corridorUniforms.uCorridorOn.value = 0;
        }
    }

    function rebuildCarveMask() {
        if (!active || !maskScene) return;
        buildMaskShapes();
        renderCarveMask(maskCenterX, maskCenterY);
    }

    // -- tile material patch (onBeforeCompile; all patched shaders share corridorUniforms) --
    function patchTileMaterial(material) {
        if (!material || (material.userData && material.userData.__corridorPatched)) return;
        material.userData = material.userData || {};
        material.userData.__corridorPatched = true;
        // Google tiles are double-sided; single-sided culls the terrain-shell underside so a
        // carve doesn't open into a view of the shell's inside.
        material.side = window.THREE.FrontSide;
        material.onBeforeCompile = function (shader) {
            Object.assign(shader.uniforms, corridorUniforms);
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>', '#include <common>\nvarying vec3 vCorridorWorld;')
                .replace('#include <project_vertex>',
                    '#include <project_vertex>\nvCorridorWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
            shader.fragmentShader = shader.fragmentShader
                .replace('#include <common>', '#include <common>\n'
                    + 'varying vec3 vCorridorWorld;\n'
                    + 'uniform sampler2D uCorridorMask;\n'
                    + 'uniform vec2 uCorridorMin;\n'
                    + 'uniform float uCorridorScale;\n'
                    + 'uniform float uCorridorOn;\n'
                    + 'uniform float uFloorZ;')
                .replace('void main() {', 'void main() {\n'
                    + 'if (uCorridorOn > 0.5 && vCorridorWorld.z > uFloorZ) {\n'
                    + '    vec2 cuv = (vCorridorWorld.xy - uCorridorMin) * uCorridorScale;\n'
                    + '    if (cuv.x > 0.0 && cuv.x < 1.0 && cuv.y > 0.0 && cuv.y < 1.0) {\n'
                    + '        if (texture2D(uCorridorMask, cuv).r > 0.5) discard;\n'
                    + '    }\n'
                    + '}\n');
        };
        material.needsUpdate = true;
    }

    function onTileModelLoad(ev) {
        if (!ev || !ev.scene) return;
        ev.scene.traverse(function (o) {
            if (!o.isMesh || !o.material) return;
            if (Array.isArray(o.material)) o.material.forEach(patchTileMaterial);
            else patchTileMaterial(o.material);
        });
    }

    function disposeMask() {
        disposeMaskShapes();
        if (maskRT) { try { maskRT.dispose(); } catch (_) { } }
        maskRT = null;
        maskScene = null;
        maskCamera = null;
        maskMaterial = null;
        maskReady = false;
        corridorUniforms.uCorridorMask.value = null;
        corridorUniforms.uCorridorOn.value = 0;
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
        } else if (maskScene && internals.controls && internals.controls.target) {
            // Slide the carve window with the orbit target; a slide is one small texture render.
            const t = internals.controls.target;
            const dx = t.x - maskCenterX;
            const dy = t.y - maskCenterY;
            if (!maskReady || (dx * dx + dy * dy) > MASK_MOVE_M * MASK_MOVE_M) {
                renderCarveMask(t.x, t.y);
            }
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
            // (Entry options like frameProposal/autoRotate are handled by three-mode's own
            // URL-driven entry — by the time this layer attaches, the camera is already
            // framed on the proposal and the intro auto-rotate is running.)
            internals = (typeof window.getThreeModeInternals === 'function') ? window.getThreeModeInternals() : null;
            if (!internals) {
                // 3D mode may still be booting (URL-driven entry): wait for its ready signal.
                await new Promise(function (resolve) {
                    const onReady = function () { window.removeEventListener('threeModeReady', onReady); resolve(); };
                    window.addEventListener('threeModeReady', onReady);
                    setTimeout(function () { window.removeEventListener('threeModeReady', onReady); resolve(); }, 15000);
                });
                internals = (typeof window.getThreeModeInternals === 'function') ? window.getThreeModeInternals() : null;
            }
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
            // Every streamed tile material gets the carve-mask shader patch.
            tiles.addEventListener('load-model', onTileModelLoad);

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

            ensureMaskObjects();

            grounded = false;
            builtVisible = true;
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
        if (typeof window.setRealisticLayerActive === 'function') window.setRealisticLayerActive(false);
        if (internals && internals.scene) {
            if (scaleNode) { try { internals.scene.remove(scaleNode); } catch (_) { } }
            if (hadSavedBackground) {
                try { internals.scene.background = savedBackground; } catch (_) { }
            }
        }
        hadSavedBackground = false;
        disposeMask();
        if (tiles) { try { tiles.removeEventListener('load-model', onTileModelLoad); } catch (_) { } }
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

    // Keep the carve in sync while the layer is up (proposal edits re-mirror this global).
    window.addEventListener('proposedBuildingsUpdated', function () {
        if (active && grounded) rebuildCarveMask();
    });

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
        getViewer: function () { return tiles; },
        // three-mode's Built row drives the mesh while the layer is up.
        setBuiltVisible: function (v) {
            builtVisible = !!v;
            if (tiles && grounded) tiles.group.visible = builtVisible;
        },
        // Whether proposed-building footprints join the carve (roads/parks/demolitions always do).
        setCarveProposedBuildings: function (v) {
            carveProposedBuildings = !!v;
            if (active && grounded) rebuildCarveMask();
        }
    };
})();
