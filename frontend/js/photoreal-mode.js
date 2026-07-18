// Photorealistic 3D mode: overlays Google Photorealistic 3D Tiles (CesiumJS + Cesium ion)
// on top of the existing 3D view, rendering the proposal's proposed buildings and applied road
// corridors on real-world context. Toggled from a button inside 3D mode. Cesium is lazy-loaded on
// first use so it never affects initial page load. Kept loosely coupled to three-mode.js: it only
// reads the shared `window.proposedBuildings` / `window.map` / proposal-store corridor helpers
// (corridor-profile.js et al) and watches the `three-mode-active` body class.
(function () {
    'use strict';

    // Cesium ion access token (client-side by design).
    // TODO before public/commercial launch: rotate this token and scope it to asset 2275207
    // (Google Photorealistic 3D Tiles) in the ion console. See realistic-3d.md §8.
    const ION_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI5MTBkNDc1Ny0zNzlkLTRiOTMtYTM2Zi1hZjYzNWY0MTJjMTIiLCJpZCI6NDI0MDY3LCJpYXQiOjE3NzcyNzM2ODF9.-GY-QQkFSEcYl8fkkm_u4AxVbmWY2aNefvzoHAiLuLE';
    const CESIUM_VERSION = '1.124';
    const CESIUM_BASE = 'https://cesium.com/downloads/cesiumjs/releases/' + CESIUM_VERSION + '/Build/Cesium/';

    let cesiumLoadPromise = null;
    let tilesetPromise = null;
    let viewer = null;
    let googleTileset = null;
    let tilesetState = 'pending'; // 'pending' | 'ready' | 'failed' — drives whether the globe renders
    let active = false;
    let statusEl = null;
    let lastGroundHeight = 0;     // elevation of the last camera target (for the auto-orbit)
    let autoRotateRemove = null;  // remover fn for the preRender auto-orbit listener
    const proposalEntities = [];
    const proposalPrimitives = []; // batched scene primitives (trees) — cleared with the entities

    // Display states, mirroring 3D mode's two-row control (no radius here — Cesium streams
    // tiles by screen-space error, so distance culling is automatic). "Built" is the Google
    // photoreal mesh, "Planned" is the proposal massing.
    let builtDisplay = 'solid';    // 'solid' | 'ghost' | 'off'
    let plannedDisplay = 'solid';  // 'solid' | 'ghost' | 'off'
    // Carve the real mesh away under proposal footprints, so a proposal replaces the real
    // building standing on its spot instead of interpenetrating it.
    let carveUnderProposals = true;
    let controlsEl = null;
    let tileLoaderEl = null;
    let tileLoaderCountEl = null;
    let tileProgressBound = false;
    let rotateHintEl = null;
    let rotateHintTimer = null;
    const ROTATE_HINT_DONE_KEY = 'photorealRotateHintDone';

    const containerEl = () => document.getElementById('cesium-container');
    const toggleBtn = () => document.getElementById('mode-realistic-toggle');

    function setStatus(msg) {
        if (!statusEl) return;
        statusEl.textContent = msg || '';
        statusEl.style.display = msg ? 'block' : 'none';
    }

    function photorealI18n(key, fallback) {
        try {
            if (window.i18n && typeof window.i18n.t === 'function') {
                const value = window.i18n.t(key, {});
                if (value && value !== key) return value;
            }
        } catch (_) { }
        return fallback;
    }

    // ---- display states (Built = Google mesh, Planned = proposals) ----
    function applyBuiltDisplay() {
        if (viewer) {
            // The globe renders only when it IS the ground (mesh hidden or unavailable) — same as
            // the isochrone photoreal sim, which renders no globe at all. When both drew, coarse
            // terrain lobes covered the mesh ground in flat "generic green" wherever the two
            // surfaces disagree vertically, and the whole earth flashed into view on first entry.
            viewer.scene.globe.show = tilesetState === 'failed' || builtDisplay === 'off';
        }
        if (!googleTileset || !window.Cesium) return;
        googleTileset.show = builtDisplay !== 'off';
        try {
            googleTileset.style = builtDisplay === 'ghost'
                ? new Cesium.Cesium3DTileStyle({ color: 'color("white", 0.5)' })
                : undefined;
        } catch (err) {
            console.warn('[photoreal] tileset style failed', err);
        }
    }

    // Real mesh carved away under every proposal footprint: the proposal REPLACES the real
    // building on its spot. The hole floor shows the globe's satellite terrain, and the
    // extruded proposal stands in it. Off (or planned hidden) restores the untouched mesh.
    function applyCarving() {
        if (!googleTileset || !window.Cesium || !Cesium.ClippingPolygonCollection) return;
        let supported = false;
        try { supported = Cesium.ClippingPolygonCollection.isSupported(viewer.scene); } catch (_) { }
        if (!supported) return;
        if (!carveUnderProposals || plannedDisplay === 'off' || builtDisplay === 'off') {
            googleTileset.clippingPolygons = undefined;
            return;
        }
        const polygons = [];
        const pushClipRings = function (geometry) {
            polygonsOf(geometry).forEach(function (rings) {
                const outer = rings && rings[0];
                if (!Array.isArray(outer) || outer.length < 3) return;
                try {
                    polygons.push(new Cesium.ClippingPolygon({ positions: ringToCartesians(outer) }));
                } catch (_) { }
            });
        };
        const arr = Array.isArray(window.proposedBuildings) ? window.proposedBuildings : [];
        arr.forEach(function (feat) {
            if (feat && feat.geometry) pushClipRings(feat.geometry);
        });
        // Applied road corridors carve the mesh along their footprint, so the road replaces
        // whatever stands on it. Tunnelled / grade-separated stretches keep the mesh above them:
        // the surface-level footprint wins over the full outline when the definition carries one.
        appliedCorridorProposals().forEach(function (proposal) {
            const definition = window.corridorProposalDefinition(proposal);
            if (definition) pushClipRings(definition.surfaceFootprint || definition.polygon);
        });
        // Applied structures (parks/squares/lakes) replace the ground wholesale — a park over a
        // parking lot must not show the cars through its lawn. renderCorridors fills the hole
        // with the structure's own surface body.
        appliedStructureProposals().forEach(function (proposal) {
            pushClipRings(proposal.structureProposal.geometry);
        });
        // A building a proposal razes entirely can stick out past the footprint that razed it —
        // carve its whole outline too, or its outer half would keep standing in the mesh. Cut
        // records are skipped: their demolished part lies inside the corridor footprint already.
        if (typeof window.collectCarveRecords === 'function'
            && typeof proposalStorage !== 'undefined' && typeof proposalStorage.getAllProposals === 'function') {
            try {
                window.collectCarveRecords(proposalStorage.getAllProposals()).records.forEach(function (record) {
                    if (record.remainder) return;
                    // Demolished PROPOSED buildings are simply not rendered — only real buildings
                    // exist in the photoreal mesh and need a hole cut for them.
                    if (String(record.id).indexOf('proposal:') === 0) return;
                    const outside = razedFootprintOutsideStructures(record.geometry);
                    if (outside) pushClipRings(outside);
                });
            } catch (err) {
                console.warn('[photoreal] demolition carve failed', err);
            }
        }
        console.log('[photoreal] carving ' + polygons.length + ' clip polygons');
        try {
            googleTileset.clippingPolygons = polygons.length
                ? new Cesium.ClippingPolygonCollection({ polygons: polygons })
                : undefined;
        } catch (err) {
            console.warn('[photoreal] clipping polygons failed', err);
        }
    }

    function setBuiltDisplay(state) {
        builtDisplay = state;
        applyBuiltDisplay();
        // Re-render the proposal too: the corridor undercoat exists only when the globe shows.
        renderProposedBuildings();
        updateDisplayControls();
    }

    function setPlannedDisplay(state) {
        plannedDisplay = state;
        renderProposedBuildings();
        applyCarving();
        updateDisplayControls();
    }

    function setCarveUnderProposals(value) {
        carveUnderProposals = !!value;
        applyCarving();
    }

    function updateDisplayControls() {
        if (!controlsEl) return;
        controlsEl.querySelectorAll('[data-photoreal-display]').forEach(function (button) {
            const row = button.getAttribute('data-photoreal-row');
            const state = button.getAttribute('data-photoreal-display');
            const current = row === 'built' ? builtDisplay : plannedDisplay;
            button.classList.toggle('three-mode-segment--active', state === current);
        });
    }

    // Two rows of Solid / Transparent / Off plus the carve checkbox. Deliberately built from the
    // SAME classes as 3D mode's panel (three-mode-ui-panel/segmented/segment) so the control looks
    // identical and sits in the same upper-right spot in both views.
    function ensureDisplayControls() {
        if (controlsEl) return;
        const el = containerEl();
        if (!el) return;
        controlsEl = document.createElement('div');
        controlsEl.className = 'three-mode-ui-panel photoreal-controls';
        const states = [
            ['solid', photorealI18n('threeMode.controls.stateSolid', 'Solid')],
            ['ghost', photorealI18n('threeMode.controls.stateGhost', 'Transparent')],
            ['off', photorealI18n('threeMode.controls.stateOff', 'Off')]
        ];
        const rowHtml = function (row, label) {
            const buttons = states.map(function (pair) {
                return '<button type="button" class="three-mode-segment" data-photoreal-row="' + row + '" data-photoreal-display="' + pair[0] + '">' + pair[1] + '</button>';
            }).join('');
            return '<div class="three-mode-emphasis-row"><span class="three-mode-emphasis-label">' + label + '</span><div class="three-mode-segmented">' + buttons + '</div></div>';
        };
        controlsEl.innerHTML =
            rowHtml('built', photorealI18n('threeMode.controls.built', 'Built'))
            + rowHtml('planned', photorealI18n('threeMode.controls.planned', 'Planned'))
            + '<label class="three-mode-trees-toggle photoreal-controls-carve"><input type="checkbox" data-photoreal-carve'
            + (carveUnderProposals ? ' checked' : '') + '> '
            + photorealI18n('threeMode.controls.carveUnderProposals', 'Hide real buildings under proposals')
            + '</label>';
        controlsEl.addEventListener('click', function (event) {
            const button = event.target && event.target.closest && event.target.closest('[data-photoreal-display]');
            if (!button) return;
            const state = button.getAttribute('data-photoreal-display');
            if (button.getAttribute('data-photoreal-row') === 'built') setBuiltDisplay(state);
            else setPlannedDisplay(state);
        });
        const carveInput = controlsEl.querySelector('[data-photoreal-carve]');
        if (carveInput) {
            carveInput.addEventListener('change', function () { setCarveUnderProposals(carveInput.checked); });
        }
        el.appendChild(controlsEl);
        updateDisplayControls();
    }

    // ---- lazy Cesium loading ----
    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            const s = document.createElement('script');
            s.src = src;
            s.async = true;
            s.onload = resolve;
            s.onerror = function () { reject(new Error('Failed to load ' + src)); };
            document.head.appendChild(s);
        });
    }

    function ensureCesiumLoaded() {
        if (window.Cesium) return Promise.resolve();
        if (cesiumLoadPromise) return cesiumLoadPromise;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = CESIUM_BASE + 'Widgets/widgets.css';
        document.head.appendChild(link);
        cesiumLoadPromise = loadScript(CESIUM_BASE + 'Cesium.js');
        return cesiumLoadPromise;
    }

    // ---- tile-streaming indicator ----
    // Google tiles stream by view, so there is no meaningful percentage — but Cesium reports
    // how many tile requests are still in flight, which is an honest "working on it" number.
    function updateTileLoader(pending, processing) {
        if (!tileLoaderEl) return;
        const count = Math.max(0, (pending || 0) + (processing || 0));
        const show = active && count > 0 && builtDisplay !== 'off';
        tileLoaderEl.classList.toggle('visible', show);
        if (show && tileLoaderCountEl) tileLoaderCountEl.textContent = String(count);
    }

    function bindTileProgress(ts) {
        if (!ts || tileProgressBound || !ts.loadProgress) return;
        tileProgressBound = true;
        ts.loadProgress.addEventListener(function (pending, processing) {
            updateTileLoader(pending, processing);
        });
    }

    // ---- one-time rotate hint ----
    function rotateHintDone() {
        try {
            if (typeof PersistentStorage !== 'undefined') return PersistentStorage.getItem(ROTATE_HINT_DONE_KEY) === '1';
        } catch (_) { }
        return false;
    }

    function markRotateHintDone() {
        try {
            if (typeof PersistentStorage !== 'undefined') PersistentStorage.setItem(ROTATE_HINT_DONE_KEY, '1');
        } catch (_) { }
        hideRotateHint();
    }

    function hideRotateHint() {
        if (rotateHintTimer) { clearTimeout(rotateHintTimer); rotateHintTimer = null; }
        if (!rotateHintEl) return;
        rotateHintEl.classList.add('fading');
        const el = rotateHintEl;
        rotateHintEl = null;
        setTimeout(function () { try { el.remove(); } catch (_) { } }, 700);
    }

    // Shown until the user rotates once (ever): ctrl-drag / middle-drag on desktop,
    // two-finger drag on touch. Auto-fades after 12 s either way.
    function showRotateHint() {
        if (rotateHintDone() || rotateHintEl) return;
        const el = containerEl();
        if (!el) return;
        const touch = ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
        const message = touch
            ? photorealI18n('threeMode.controls.rotateHintMobile', 'Swipe with two fingers to rotate the view')
            : photorealI18n('threeMode.controls.rotateHintDesktop', 'Hold Ctrl and drag to rotate the view');
        rotateHintEl = document.createElement('div');
        rotateHintEl.className = 'photoreal-rotate-hint';
        rotateHintEl.textContent = message;
        el.appendChild(rotateHintEl);
        rotateHintTimer = setTimeout(hideRotateHint, 12000);
        try {
            const canvas = viewer && viewer.canvas;
            if (canvas) {
                const onPointer = function (event) {
                    if (event.ctrlKey || event.button === 1) markRotateHintDone();
                };
                const onTouch = function (event) {
                    if (event.touches && event.touches.length >= 2) markRotateHintDone();
                };
                canvas.addEventListener('pointerdown', onPointer, { passive: true });
                canvas.addEventListener('touchstart', onTouch, { passive: true });
            }
        } catch (_) { }
    }

    async function ensureViewer() {
        await ensureCesiumLoaded();
        const el = containerEl();
        if (!statusEl) {
            statusEl = document.createElement('div');
            statusEl.className = 'photoreal-status';
            el.appendChild(statusEl);
        }
        if (!tileLoaderEl) {
            tileLoaderEl = document.createElement('div');
            tileLoaderEl.className = 'photoreal-tile-loader';
            tileLoaderEl.innerHTML = '<span class="photoreal-spinner"></span><span>'
                + photorealI18n('threeMode.controls.streamingTiles', 'Streaming 3D tiles…')
                + '</span><span class="photoreal-tile-count"></span>';
            tileLoaderCountEl = tileLoaderEl.querySelector('.photoreal-tile-count');
            el.appendChild(tileLoaderEl);
        }
        if (viewer) return viewer;
        Cesium.Ion.defaultAccessToken = ION_TOKEN;
        viewer = new Cesium.Viewer(el, {
            timeline: false, animation: false, baseLayerPicker: false,
            geocoder: false, homeButton: false, sceneModePicker: false,
            navigationHelpButton: false, infoBox: false, selectionIndicator: false,
            fullscreenButton: false,
            // Render only when something changed (camera moved, tiles arrived, entities
            // edited) instead of every animation frame — the single biggest interaction
            // speedup, same "skip work that recomputes nothing" idea as the isochrone
            // photoreal sim. Cesium detects camera motion exactly, so zoom/pan/orbit
            // still render every moving frame.
            requestRenderMode: true,
            maximumRenderTimeChange: Infinity,
            // Cesium defaults to 4x MSAA — a big fragment-cost tax on integrated GPUs. FXAA
            // (still on) covers the jaggies far cheaper.
            msaaSamples: 1
        });
        const urlParams = new URLSearchParams(window.location.search || '');
        // The proposal's immediate vicinity is what matters: cap the far plane so tilted views
        // stop streaming and shading Google tiles all the way to the horizon. ?prfar=<m> to widen
        // (e.g. ?prfar=20000 for city panoramas); ?fps=1 shows Cesium's FPS meter for measuring.
        const prfar = Number(urlParams.get('prfar'));
        viewer.camera.frustum.far = (Number.isFinite(prfar) && prfar > 500) ? prfar : 2000;
        if (urlParams.get('fps')) viewer.scene.debugShowFramesPerSecond = true;
        viewer.scene.fog.enabled = false; // fog only shades the globe, which we keep hidden
        viewer.scene.globe.depthTestAgainstTerrain = true;
        // Coarser terrain+imagery refinement: the globe only renders as the satellite fallback
        // (mesh off or unavailable), never underneath the mesh.
        viewer.scene.globe.maximumScreenSpaceError = 3;
        // Off until the tileset's fate is known — kills the whole-earth flash on first entry.
        viewer.scene.globe.show = false;
        // No starfield / space backdrop — go straight to the city view while tiles stream.
        viewer.scene.skyBox.show = false;
        viewer.scene.sun.show = false;
        viewer.scene.moon.show = false;
        // Real terrain so the camera can be placed at the correct ground height *before* the
        // photoreal mesh streams in — otherwise high-elevation cities (Denver ~1.6 km) would
        // render underground and we'd need the old far pull-back to hide it.
        try { viewer.terrainProvider = await Cesium.createWorldTerrainAsync(); } catch (_) { }
        return viewer;
    }

    // Tileset loads separately from the viewer so the camera can be positioned before tiles
    // stream in — otherwise the user briefly sees the default globe-from-space while loading.
    function ensureTileset() {
        if (googleTileset) return Promise.resolve(googleTileset);
        if (tilesetPromise) return tilesetPromise;
        setStatus('Loading photorealistic tiles…');
        tilesetPromise = Cesium.createGooglePhotorealistic3DTileset()
            .then(function (ts) {
                googleTileset = ts;
                // Streaming settings ported from the zagreb-isochrone photoreal sim, where the
                // same Google tileset zooms fluidly: a coarser screen-space-error target streams
                // far fewer tiles per view (its errorTarget 24 vs the renderer default), dynamic
                // SSE refines distant/oblique tiles even less, skipping intermediate LODs stops
                // a zoom-in from downloading every level on the way down, and a bigger tile
                // cache means zooming back out re-uses tiles instead of re-fetching them.
                // ?prq=<n> mirrors the isochrone sim's ?rwq quality knob: lower = sharper but
                // heavier (Cesium's default is 16), higher = lighter but blurrier.
                const prq = Number(new URLSearchParams(window.location.search || '').get('prq'));
                ts.maximumScreenSpaceError = (Number.isFinite(prq) && prq > 0) ? prq : 24;
                ts.dynamicScreenSpaceError = true;
                // Aggressive distance falloff: tiles beyond the immediate vicinity refine far
                // less (the proposal neighbourhood is the subject; the skyline is backdrop).
                ts.dynamicScreenSpaceErrorDensity = 6.0e-4;
                ts.dynamicScreenSpaceErrorFactor = 24;
                ts.skipLevelOfDetail = true;
                ts.cacheBytes = 1024 * 1024 * 1024;
                ts.maximumCacheOverflowBytes = 512 * 1024 * 1024;
                viewer.scene.primitives.add(ts);
                tilesetState = 'ready';
                setStatus('');
                applyBuiltDisplay();
                // Re-render so the entry-time undercoat (created while the tileset was pending)
                // is dropped now that the mesh, not the globe, is the ground.
                renderProposedBuildings();
                bindTileProgress(ts);
                seatMeshToTerrain(ts);
                return ts;
            })
            .catch(function (err) {
                // No Google coverage for this city (or EEA-billed direct access): the globe still
                // shows satellite imagery + terrain so the proposal stays in real-ish context.
                tilesetState = 'failed';
                applyBuiltDisplay();
                setStatus('No photorealistic coverage here — showing satellite + terrain.');
                console.warn('[photoreal] Google tileset failed to load:', err);
                return null;
            });
        return tilesetPromise;
    }

    // ---- proposed-building rendering (lng/lat footprints + height in metres -> extruded massing) ----
    function clearProposal() {
        if (!viewer) return;
        corridorRenderToken++; // orphan any in-flight corridor terrain sampling
        proposalEntities.forEach(function (e) { viewer.entities.remove(e); });
        proposalEntities.length = 0;
        proposalPrimitives.forEach(function (p) { try { viewer.scene.primitives.remove(p); } catch (_) { } });
        proposalPrimitives.length = 0;
    }

    // Each entry is one polygon's full ring set: [outerRing, hole1, hole2, ...].
    function polygonsOf(geometry) {
        if (!geometry) return [];
        if (geometry.type === 'Polygon') return [geometry.coordinates];
        if (geometry.type === 'MultiPolygon') return geometry.coordinates;
        return [];
    }

    function ringToCartesians(ring) {
        const flat = [];
        ring.forEach(function (c) { flat.push(c[0], c[1]); });
        return Cesium.Cartesian3.fromDegreesArray(flat);
    }

    // Height comes from the shared estimator in frontend/js/building-height.js (loaded first) so
    // this view and the 3D view cannot disagree about a building's massing. It accepts a feature or
    // a props object.
    const buildingHeightM = (props) => window.estimateBuildingHeightMeters(props);

    // Uploaded buildings carry a glTF model URL — render the real mesh (legacy's
    // placeUploadedModel branch) instead of an extruded box. Cesium is geographic, so the model
    // goes at the footprint centroid clamped to ground at 1:1 real-metre scale — no Mercator
    // inflation (that's a quirk of three-mode's local scene), and Cesium handles glTF Y-up→Z-up.
    function addProposedModel(feat) {
        if (!viewer) return;
        let lng, lat;
        try {
            const c = turf.centroid(feat);
            lng = c.geometry.coordinates[0];
            lat = c.geometry.coordinates[1];
        } catch (_) { return; }
        if (!isFinite(lng) || !isFinite(lat)) return;
        const ent = viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(lng, lat),
            model: {
                uri: feat.properties.modelUrl,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND
            }
        });
        proposalEntities.push(ent);
    }

    // Sampling the ground height under a footprint is what used to make entering realistic mode feel
    // stalled (~10s). Instead we draw each box immediately on a provisional base, then refine its base
    // in the background — so the proposal appears instantly and settles onto the ground after.
    //
    // We sample the world-terrain DEM (light, loads fully on any device) rather than the Google
    // photoreal mesh: on mobile the heavy mesh only streams to a coarse LOD, so mesh sampling returned
    // wildly wrong heights and flung the box out of view ("briefly draws then disappears"). Terrain
    // sampling is deterministic across mobile/desktop and gives bare-ground height (no rooftop hits).
    function refineBase(ent, outer, hM) {
        if (!viewer) return;
        // No real terrain (world-terrain load failed) -> provisional base is already ellipsoid 0; skip.
        if (!viewer.terrainProvider || viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider) return;
        let cartos;
        try {
            cartos = outer.map(function (c) { return Cesium.Cartographic.fromDegrees(c[0], c[1]); });
        } catch (_) { return; }
        Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, cartos).then(function (sampled) {
            const hs = sampled.map(function (s) { return (s && isFinite(s.height)) ? s.height : null; })
                .filter(function (v) { return v !== null; });
            if (!hs.length) return;
            const base = Math.min.apply(null, hs);
            // The entity may have been cleared/replaced by a re-render in the meantime — patching a
            // removed entity is harmless, so no guard needed.
            ent.polygon.height = base;
            ent.polygon.extrudedHeight = base + hM;
        }).catch(function () { /* keep the provisional base */ });
    }

    // ---- applied road corridors (lane bodies + markings + junctions + trees on the carved floor) ----
    //
    // An applied road renders exactly the geometry the 2D map and abstract 3D draw — the strip /
    // marking / junction / decoration builders in corridor-profile.js are the single source — but
    // as real 3D bodies standing on the carved-out floor: each lane is its own prism whose top
    // follows the sampled terrain, kerb lanes (sidewalk/verge/median) raised by their kerb height
    // so an actual curb face shows, and every white line is a metre-wide quad at road height, so
    // paint grows toward the camera the way real paint does (a pixel-width polyline is constant
    // on screen, which reads exactly backwards in a street-level view). Terrain sampling is
    // async: strips appear DRAPED on the floor instantly and the bodies land on top when the
    // samples arrive — the draped layer STAYS as an undercoat, so where the rendered globe's
    // coarser LOD bulges above the sampled heights, the bulge shows lane colour instead of bare
    // ground poking through the road. Markings, junction patches and trees only exist in the
    // sampled pass. Painted bike/pedestrian glyphs are skipped, as in 2D; rail sleepers likewise.
    const CORRIDOR_BODY = {
        road: 0.08,        // roadway surface above the carved floor (clears coarse-LOD terrain bumps)
        markingLift: 0.04, // white paint above the surface it is painted on
        // Junction patches sit ABOVE kerb tops (road 0.08 + kerb 0.15 = 0.23) — exactly as the
        // abstract 3D layers them — so a crossing's asphalt swallows through-markings AND the
        // sidewalk/cycleway bands inside the conflict area.
        junction: 0.24,
        crosswalk: 0.26,
        skirt: 1.5,        // lane bodies extrude this far below their lowest vertex (no slope gaps)
        densifyStep: 12    // metres between added terrain samples along a strip edge
    };
    const MAX_PHOTOREAL_TREES = 600;
    // Bumped on every corridor render AND every clear; a terrain-sampling pass that resolves
    // after a newer render (or a clear) simply discards its result instead of resurrecting
    // stale roads into the scene.
    let corridorRenderToken = 0;

    function appliedCorridorProposals() {
        if (typeof proposalStorage === 'undefined' || typeof proposalStorage.getAllProposals !== 'function') return [];
        if (typeof window.isAppliedCorridorProposal !== 'function' || typeof window.corridorProposalDefinition !== 'function') return [];
        try {
            return proposalStorage.getAllProposals().filter(window.isAppliedCorridorProposal);
        } catch (_) { return []; }
    }

    // Same per-segment expansion as three-mode's buildCorridorStrips3D: each segment renders with
    // ITS cross-section (segmentProfiles override), falling back to the whole-corridor profile.
    function corridorRenderEntriesOf(definition) {
        if (typeof corridorProfileOf !== 'function' || typeof corridorCenterlineOf !== 'function') return [];
        const fallbackProfile = corridorProfileOf(definition);
        const centerline = corridorCenterlineOf(definition);
        if (!fallbackProfile || !centerline.length) return [];
        const entries = ((typeof corridorSegmentEntries === 'function') ? corridorSegmentEntries(definition) : [])
            .filter(function (entry) { return Array.isArray(entry.points) && entry.points.length >= 2; })
            .map(function (entry) { return entry.profile ? entry : { ...entry, profile: fallbackProfile }; });
        return entries.length ? entries : centerline.map(function (points) { return { points: points, profile: fallbackProfile }; });
    }

    // The corridor builders return {lat,lng} points (Leaflet's shape), unlike the [lng,lat]
    // GeoJSON rings buildings use — hence a second Cartesian converter.
    function latLngsToCartesians(points) {
        const flat = [];
        points.forEach(function (p) { flat.push(p.lng, p.lat); });
        return Cesium.Cartesian3.fromDegreesArray(flat);
    }

    // Draped lane undercoat: classified onto the terrain it hugs every terrain bump, which makes
    // it both the instant stand-in while terrain sampling runs AND the permanent safety layer
    // under the 3D body — a coarse-LOD bulge that pierces the body shows lane colour, not grass.
    // TERRAIN only, deliberately: classifying on the mesh too painted the carve's vertical cut
    // faces and boundary-straddling tree canopy in lane colours ("the road drapes over objects").
    function addDrapedPolygon(ring, color, alpha) {
        if (!Array.isArray(ring) || ring.length < 3) return;
        try {
            proposalEntities.push(viewer.entities.add({
                polygon: {
                    hierarchy: new Cesium.PolygonHierarchy(latLngsToCartesians(ring)),
                    material: Cesium.Color.fromCssColorString(color).withAlpha(alpha),
                    classificationType: Cesium.ClassificationType.TERRAIN
                }
            }));
        } catch (_) { }
    }

    function corridorProjectionReady() {
        return typeof window.wgs84ToHTRS96 === 'function' && typeof window.htrs96ToWGS84 === 'function';
    }

    function planarOf(point) { return wgs84ToHTRS96(point.lat, point.lng); }

    function latLngOf(xy) {
        const ll = htrs96ToWGS84(xy[0], xy[1]);
        return { lat: ll[0], lng: ll[1] };
    }

    // Insert vertices along each edge of a strip ring so a long straight lane gets terrain
    // samples mid-span — the ring's own vertices only sit at bends, and a body whose top is
    // interpolated between two far-apart bends would ignore every dip in between.
    function densifyRing(ring, stepM) {
        if (!corridorProjectionReady()) return ring;
        const out = [];
        for (let i = 0; i < ring.length; i++) {
            const a = ring[i];
            const b = ring[(i + 1) % ring.length];
            out.push(a);
            const pa = planarOf(a), pb = planarOf(b);
            const len = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
            const extra = Math.floor(len / stepM);
            for (let k = 1; k <= extra; k++) {
                const t = k / (extra + 1);
                out.push(latLngOf([pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t]));
            }
        }
        return out;
    }

    // A painted line (or a whole self-crossing strip) as world-space quads: one quad per
    // centre-line edge between the two signed offsets, optionally chopped into `dash`
    // ({on, off} metres) pieces. Dashes restart at each vertex — fine for near-straight roads.
    function bandQuads(line, offsetLeft, offsetRight, dash) {
        if (!corridorProjectionReady() || !Array.isArray(line) || line.length < 2) return [];
        const pts = line.map(planarOf);
        const quads = [];
        const pushQuad = function (a, b) {
            const dx = b[0] - a[0], dy = b[1] - a[1];
            const len = Math.hypot(dx, dy);
            if (len < 1e-6) return;
            const nx = -dy / len, ny = dx / len; // left normal, same sign convention as offsetPolylinePlanar
            quads.push([
                latLngOf([a[0] + nx * offsetLeft, a[1] + ny * offsetLeft]),
                latLngOf([b[0] + nx * offsetLeft, b[1] + ny * offsetLeft]),
                latLngOf([b[0] + nx * offsetRight, b[1] + ny * offsetRight]),
                latLngOf([a[0] + nx * offsetRight, a[1] + ny * offsetRight])
            ]);
        };
        for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i], b = pts[i + 1];
            if (!dash) { pushQuad(a, b); continue; }
            const dx = b[0] - a[0], dy = b[1] - a[1];
            const len = Math.hypot(dx, dy);
            if (len < 1e-6) continue;
            const ux = dx / len, uy = dy / len;
            for (let d = 0; d < len; d += dash.on + dash.off) {
                const end = Math.min(d + dash.on, len);
                pushQuad([a[0] + ux * d, a[1] + uy * d], [a[0] + ux * end, a[1] + uy * end]);
            }
        }
        return quads;
    }

    // A flat strip whose ring crosses itself (a star, a loop, a hairpin) floods when triangulated —
    // the same failure earcut has in three-mode, with the same cure: lay the band per centre-line
    // edge instead (bandQuads over the full strip width).
    function stripRingSelfIntersects(polygon) {
        if (typeof window.ringSelfIntersectsXY !== 'function' || typeof window.wgs84ToHTRS96 !== 'function') return false;
        try {
            return window.ringSelfIntersectsXY(polygon.map(planarOf));
        } catch (_) { return false; }
    }

    // Deterministic per-tree size — the same hash three-mode instances its trees with, so a tree
    // is the same height in the abstract and photoreal views.
    function treeRandom(lng, lat) {
        let h = Math.imul(((lng * 1e6) | 0) ^ 0x9e3779b9, 0x85ebca6b);
        h ^= Math.imul(((lat * 1e6) | 0) ^ 0x165667b1, 0xc2b2ae35);
        h = (h ^ (h >>> 15)) >>> 0;
        return (h % 100000) / 100000;
    }

    // Trunk + crown per tree at ABSOLUTE heights from the same terrain batch as the lane bodies.
    // Height-reference clamping was tried first and floated every tree at the height of the
    // clipped-away Google mesh — clipping is a shader effect, the clipped geometry still answers
    // the clamping height query — so trees place themselves off our own terrain samples instead.
    //
    // All trees batch into TWO scene primitives (trunks + crowns): as per-tree entities, a couple
    // of parks' worth of trees meant ~1200 entities for the visualizer to sweep every frame.
    // Synchronous build on purpose — an async primitive's worker roundtrip stalls under
    // requestRenderMode, and the one-time build happens while the mode is still revealing.
    function addCorridorTrees(treePoints, alpha) {
        if (!treePoints.length || !viewer) return;
        const trunkColor = Cesium.Color.fromCssColorString('#5c3d1e').withAlpha(alpha);
        const crownColor = Cesium.Color.fromCssColorString('#3a6b35').withAlpha(alpha);
        const vertexFormat = Cesium.PerInstanceColorAppearance.VERTEX_FORMAT;
        const trunkInstances = [];
        const crownInstances = [];
        treePoints.forEach(function (item) {
            const random = treeRandom(item.lng, item.lat);
            const totalHeight = 5 + random * 3;
            const trunkHeight = totalHeight * 0.48;
            const crownRadius = totalHeight * 0.2 + 0.4;
            // Trees stand on their lane's surface (a verge is a raised body), not on the raw floor.
            const base = (Number(item.groundHeight) || 0) + (Number(item.surfaceOffset) || 0);
            trunkInstances.push(new Cesium.GeometryInstance({
                geometry: new Cesium.CylinderGeometry({
                    length: trunkHeight, topRadius: 0.12, bottomRadius: 0.18, slices: 6,
                    vertexFormat: vertexFormat
                }),
                modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(
                    Cesium.Cartesian3.fromDegrees(item.lng, item.lat, base + trunkHeight / 2)),
                attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(trunkColor) }
            }));
            crownInstances.push(new Cesium.GeometryInstance({
                geometry: new Cesium.EllipsoidGeometry({
                    radii: new Cesium.Cartesian3(crownRadius, crownRadius, crownRadius * 1.15),
                    slicePartitions: 6, stackPartitions: 5,
                    vertexFormat: vertexFormat
                }),
                modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(
                    Cesium.Cartesian3.fromDegrees(item.lng, item.lat, base + trunkHeight + crownRadius * 0.65)),
                attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(crownColor) }
            }));
        });
        try {
            [trunkInstances, crownInstances].forEach(function (instances) {
                proposalPrimitives.push(viewer.scene.primitives.add(new Cesium.Primitive({
                    geometryInstances: instances,
                    appearance: new Cesium.PerInstanceColorAppearance({ translucent: alpha < 1, closed: true }),
                    asynchronous: false,
                    allowPicking: false
                })));
            });
            viewer.scene.requestRender();
        } catch (err) {
            console.warn('[photoreal] tree primitives failed', err);
        }
    }

    function collectJunctionFlats(junctions, flatJobs, alpha, markingAlpha) {
        const asphalt = (typeof CORRIDOR_LANE_TYPES !== 'undefined'
            && CORRIDOR_LANE_TYPES.driving && CORRIDOR_LANE_TYPES.driving.surface) || '#2b2b2b';
        (junctions || []).forEach(function (junction) {
            (junction.surfacePolygons || []).forEach(function (polygon) {
                flatJobs.push({ ring: polygon, top: CORRIDOR_BODY.junction, color: asphalt, alpha: alpha });
            });
            (junction.crosswalkPolygons || []).forEach(function (polygon) {
                flatJobs.push({ ring: polygon, top: CORRIDOR_BODY.crosswalk, color: '#ffffff', alpha: markingAlpha });
            });
        });
    }

    // Add the terrain-following bodies over the draped undercoat. One batched most-detailed
    // terrain query covers every strip vertex, one anchor per small flat object (a dash or a
    // patch spans a couple of metres — one height is plenty), and one point per tree. A strip
    // whose samples fail keeps just its undercoat; a failed whole query keeps every road draped
    // (still correct from above) and roots the trees at the entry ground height.
    function buildCorridorBodies(stripJobs, flatJobs, treeJobs, treeAlpha, token) {
        if (!viewer || (!stripJobs.length && !flatJobs.length && !treeJobs.length)) return;
        const treesAtEntryGround = function () {
            treeJobs.forEach(function (item) { item.groundHeight = lastGroundHeight; });
            addCorridorTrees(treeJobs, treeAlpha);
        };
        if (!viewer.terrainProvider || viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider) {
            treesAtEntryGround();
            return;
        }
        const cartos = [];
        stripJobs.forEach(function (job) {
            job.ring.forEach(function (p) { cartos.push(Cesium.Cartographic.fromDegrees(p.lng, p.lat)); });
        });
        flatJobs.forEach(function (job) {
            const anchor = job.ring[0];
            cartos.push(Cesium.Cartographic.fromDegrees(anchor.lng, anchor.lat));
        });
        treeJobs.forEach(function (item) {
            cartos.push(Cesium.Cartographic.fromDegrees(item.lng, item.lat));
        });
        Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, cartos).then(function (sampled) {
            if (token !== corridorRenderToken || !viewer) return; // a newer render owns the scene now
            let cursor = 0;
            stripJobs.forEach(function (job) {
                const samples = sampled.slice(cursor, cursor + job.ring.length);
                cursor += job.ring.length;
                let minH = Infinity;
                const heights = samples.map(function (s) {
                    const h = (s && isFinite(s.height)) ? s.height : null;
                    if (h !== null && h < minH) minH = h;
                    return h;
                });
                if (!isFinite(minH)) return; // no usable samples: the undercoat alone shows this strip
                const positions = job.ring.map(function (p, i) {
                    return Cesium.Cartesian3.fromDegrees(p.lng, p.lat, (heights[i] !== null ? heights[i] : minH) + job.top);
                });
                try {
                    proposalEntities.push(viewer.entities.add({
                        polygon: {
                            hierarchy: new Cesium.PolygonHierarchy(positions),
                            perPositionHeight: true,
                            extrudedHeight: minH - CORRIDOR_BODY.skirt,
                            material: Cesium.Color.fromCssColorString(job.color).withAlpha(job.alpha)
                        }
                    }));
                } catch (_) { }
            });
            flatJobs.forEach(function (job) {
                const s = sampled[cursor++];
                const h = (s && isFinite(s.height)) ? s.height : lastGroundHeight;
                try {
                    proposalEntities.push(viewer.entities.add({
                        polygon: {
                            hierarchy: new Cesium.PolygonHierarchy(latLngsToCartesians(job.ring)),
                            height: h + job.top,
                            material: Cesium.Color.fromCssColorString(job.color).withAlpha(job.alpha)
                        }
                    }));
                } catch (_) { }
            });
            treeJobs.forEach(function (item) {
                const s = sampled[cursor++];
                item.groundHeight = (s && isFinite(s.height)) ? s.height : lastGroundHeight;
            });
            addCorridorTrees(treeJobs, treeAlpha);
        }).catch(function (err) {
            console.warn('[photoreal] corridor terrain sampling failed — roads stay draped', err);
            if (token === corridorRenderToken && viewer) treesAtEntryGround();
        });
    }

    // Seat the Google mesh onto the globe. The photogrammetric mesh and Cesium World Terrain can
    // disagree vertically by metres (the mesh street sat ~4-5 m below the terrain the corridor
    // stands on, so the road read as a causeway towering over the real ground). Same idea as the
    // isochrone sim's lockTrackHeightOnce: measure terrain-minus-mesh along the corridor
    // centreline — height queries ignore the carve clipping, so the ORIGINAL street surface
    // still answers — take the median, and shift the whole tileset rigidly to close the gap.
    // Our geometry is terrain-based and does not move, so nothing re-renders.
    let meshSeated = false;
    let meshSeatingInFlight = false;
    function seatMeshToTerrain(ts) {
        if (!viewer || !ts || meshSeated || meshSeatingInFlight) return;
        if (typeof samplePolylinePlanar !== 'function' || !corridorProjectionReady()) return;
        if (!viewer.scene.sampleHeightSupported) { meshSeated = true; return; }
        if (!viewer.terrainProvider || viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider) return;
        const pts = [];
        appliedCorridorProposals().forEach(function (proposal) {
            const definition = window.corridorProposalDefinition(proposal);
            corridorRenderEntriesOf(definition).forEach(function (entry) {
                samplePolylinePlanar(entry.points.map(planarOf), 25).forEach(function (sample) {
                    if (pts.length < 60) pts.push(latLngOf(sample.point));
                });
            });
        });
        if (!pts.length) return;
        meshSeatingInFlight = true;
        // The carve clips the mesh exactly where the measurement wants to touch it, and — unlike
        // the height-reference queries that floated the trees — sampleHeight DOES respect the
        // clipping. Lift the clip for the duration of the measurement; the sampling passes render
        // offscreen, so with requestRenderMode on, the visible frame never shows the un-carved
        // mesh. applyCarving() afterwards restores the canonical clip state either way.
        try { ts.clippingPolygons = undefined; } catch (_) { }
        const toCartos = function () {
            return pts.map(function (p) { return Cesium.Cartographic.fromDegrees(p.lng, p.lat); });
        };
        Promise.all([
            Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, toCartos()),
            viewer.scene.sampleHeightMostDetailed(toCartos(), proposalEntities.slice())
        ]).then(function (results) {
            meshSeatingInFlight = false;
            applyCarving();
            if (!viewer || !googleTileset) return;
            const deltas = [];
            for (let i = 0; i < pts.length; i++) {
                const t = results[0][i], m = results[1][i];
                if (t && m && isFinite(t.height) && isFinite(m.height)) deltas.push(t.height - m.height);
            }
            if (deltas.length < 3) {
                console.warn('[photoreal] mesh seating inconclusive: ' + deltas.length + '/' + pts.length
                    + ' usable samples — will retry on the next corridor render');
                return;
            }
            meshSeated = true;
            deltas.sort(function (a, b) { return a - b; });
            const median = deltas[Math.floor(deltas.length / 2)];
            // Parked cars and tree canopy in the mesh only ever bias a sample HIGH (the mesh
            // answers with a roof, never with a basement), which biases its delta LOW — so the
            // true-ground answer sits in the upper part of the distribution: lean on p75. But
            // cap the correction at +2 m over the median (a car's height): the tail also holds
            // outright garbage samples (an interior surface under dense canopy), and a raw p75
            // once chased one past the far-earth guard, cancelling the entire shift.
            const p75 = deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * 0.75))];
            const delta = Math.min(p75, median + 2);
            console.log('[photoreal] mesh seating: terrain-minus-mesh median ' + median.toFixed(2)
                + ' m / p75 ' + p75.toFixed(2) + ' m -> shifting by ' + delta.toFixed(2)
                + ' m (' + deltas.length + ' samples)');
            // Far-earth trap from the isochrone sim: one nonsense measure must not launch the
            // city into orbit. A sub-half-metre offset is not worth a visible shift either.
            if (!isFinite(delta) || Math.abs(delta) > 25 || Math.abs(delta) < 0.5) return;
            const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
                Cesium.Cartesian3.fromDegrees(pts[0].lng, pts[0].lat), new Cesium.Cartesian3());
            googleTileset.modelMatrix = Cesium.Matrix4.fromTranslation(
                Cesium.Cartesian3.multiplyByScalar(up, delta, new Cesium.Cartesian3()));
            try { viewer.scene.requestRender(); } catch (_) { }
            console.log('[photoreal] seated Google mesh onto terrain: shifted ' + delta.toFixed(2) + ' m');
        }).catch(function (err) {
            meshSeatingInFlight = false;
            applyCarving();
            console.warn('[photoreal] mesh seating failed', err);
        });
    }

    // ---- applied structures (parks / squares / lakes / stations): carve + fill + greenery ----
    //
    // A park drawn over a parking lot must READ as a park: the mesh under the structure is carved
    // away (applyCarving) and replaced by the structure's own ground — a terrain-following body
    // like a lane, in the structure's surface colour — plus, for parks, scattered trees. Cheap by
    // construction: one body per polygon, a deterministic jittered tree grid, the shared tree
    // budget and terrain-sampling batch.
    const STRUCTURE_STYLES = {
        park: { surface: '#4f7f52', trees: true },
        square: { surface: '#c2beb4', trees: false },
        lake: { surface: '#41729f', trees: false },
        station: { surface: '#c2beb4', trees: false }
    };
    const STRUCTURE_SURFACE_TOP = 0.06;     // below the roadway (0.08), so an adjacent road wins
    const CLEARED_GROUND_COLOR = '#9b9484'; // bare soil where a razed building stood
    const STRUCTURE_TREE_SPACING = 11;      // metres between scattered park trees

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

    function geoRingToLatLngs(ring) {
        return ring.map(function (c) { return { lat: c[1], lng: c[0] }; });
    }

    // The part of a razed building's footprint not already covered by an applied structure's own
    // carve+fill. Carving (and flooring) building-by-building is redundant inside a structure —
    // and every ClippingPolygon is evaluated per FRAGMENT of the whole Google mesh, so hundreds
    // of redundant ones (a park razing a dense block) made the entire tileset render crawl.
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

    // Deterministic tree scatter: a jittered planar grid clipped to the polygon. Same treeRandom
    // hash as everywhere else, so the layout is stable across renders.
    function scatterTreesInPolygon(geometry, spacing) {
        if (!corridorProjectionReady() || typeof turf === 'undefined' || !turf) return [];
        const trees = [];
        try {
            const feature = { type: 'Feature', properties: {}, geometry: geometry };
            const bbox = turf.bbox(feature);
            const a = wgs84ToHTRS96(bbox[1], bbox[0]);
            const b = wgs84ToHTRS96(bbox[3], bbox[2]);
            const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]);
            const y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
            if ((x1 - x0) * (y1 - y0) > 4e6) return []; // >4 km² of bbox: not scattering a forest
            for (let x = x0 + spacing / 2; x < x1; x += spacing) {
                for (let y = y0 + spacing / 2; y < y1; y += spacing) {
                    const cell = latLngOf([x, y]);
                    const jx = (treeRandom(cell.lng, cell.lat) - 0.5) * spacing * 0.7;
                    const jy = (treeRandom(cell.lat, cell.lng) - 0.5) * spacing * 0.7;
                    const ll = latLngOf([x + jx, y + jy]);
                    if (turf.booleanPointInPolygon(turf.point([ll.lng, ll.lat]), feature)) {
                        trees.push({ lat: ll.lat, lng: ll.lng, surfaceOffset: STRUCTURE_SURFACE_TOP });
                    }
                }
            }
        } catch (_) { }
        return trees;
    }

    function renderCorridors() {
        if (!viewer || plannedDisplay === 'off') return;
        if (typeof buildCorridorStrips !== 'function') return;
        const token = ++corridorRenderToken;
        // Fully opaque in solid mode: translucent asphalt let the crossing road's markings and
        // bays ghost through junction patches, which is what made intersections look broken.
        const alpha = plannedDisplay === 'ghost' ? 0.35 : 1;
        const markingAlpha = plannedDisplay === 'ghost' ? 0.4 : 1;
        // The draped undercoat only produces pixels on the globe — and the globe only renders
        // when the mesh is off or unavailable. While the mesh is up, classification volumes are
        // pure per-frame cost with zero output, so they are simply not created.
        const undercoatNeeded = tilesetState !== 'ready' || builtDisplay === 'off';
        const stripJobs = []; // long lane bodies: per-vertex terrain heights
        const flatJobs = [];  // small flats (dashes, bays, arrows, rails, junction patches): one height each
        const crossJunctionInput = [];
        let treePoints = [];
        appliedCorridorProposals().forEach(function (proposal) {
            try {
                const definition = window.corridorProposalDefinition(proposal);
                const entries = corridorRenderEntriesOf(definition);
                entries.forEach(function (entry) {
                    const spans = (typeof corridorStripSpans === 'function') ? corridorStripSpans(entry.profile) : [];
                    buildCorridorStrips([entry.points], entry.profile).forEach(function (strip) {
                        const lane = (typeof CORRIDOR_LANE_TYPES !== 'undefined' && CORRIDOR_LANE_TYPES[strip.type]) || {};
                        const color = lane.surface || '#2b2b2b';
                        // The lane's kerb height is what lifts a sidewalk/verge body above the
                        // roadway — the visible curb face is the side wall of that taller prism.
                        const top = CORRIDOR_BODY.road + (Number(lane.height) || 0);
                        strip.polygons.forEach(function (polygon) {
                            if (stripRingSelfIntersects(polygon)) {
                                bandQuads(entry.points, strip.left, strip.right, null).forEach(function (quad) {
                                    flatJobs.push({ ring: quad, top: top, color: color, alpha: alpha });
                                });
                                return;
                            }
                            if (undercoatNeeded) addDrapedPolygon(polygon, color, alpha);
                            stripJobs.push({
                                ring: densifyRing(polygon, CORRIDOR_BODY.densifyStep),
                                top: top,
                                color: color,
                                alpha: alpha
                            });
                        });
                        // A rail lane draws its pair of rails on the lane's own centre at the
                        // lane's gauge — the same rule the 2D canvas renderer applies.
                        if (strip.type === 'rail' && typeof buildCorridorOffsetLine === 'function') {
                            const center = (strip.left + strip.right) / 2;
                            const gauge = (typeof corridorRailGaugeOf === 'function' ? corridorRailGaugeOf(strip) : null) || 1435;
                            const half = gauge / 2000; // mm -> m, half the gauge each side of the track centre
                            [center + half, center - half].forEach(function (offset) {
                                const line = buildCorridorOffsetLine(entry.points, offset);
                                if (!line) return;
                                bandQuads(line, 0.05, -0.05, null).forEach(function (quad) {
                                    flatJobs.push({ ring: quad, top: top + CORRIDOR_BODY.markingLift, color: '#000000', alpha: markingAlpha });
                                });
                            });
                        }
                    });

                    // White paint: lane separators (dashed; the opposing-flow divide heavier),
                    // parking-bay edges + dividers, and direction arrows — from the same builders
                    // as 2D/3D, laid as metre-wide quads just above the roadway surface. Same
                    // half-widths and dash rhythms as three-mode's flat paint ribbons.
                    const paintTop = CORRIDOR_BODY.road + CORRIDOR_BODY.markingLift;
                    const markings = (typeof buildCorridorLaneMarkings === 'function')
                        ? buildCorridorLaneMarkings([entry.points], entry.profile) : [];
                    markings.forEach(function (marking) {
                        const isCenterline = marking.kind === 'centerline';
                        const half = isCenterline ? 0.09 : 0.075;
                        const dash = isCenterline ? { on: 3, off: 2.5 } : { on: 1.5, off: 2.5 };
                        (marking.lines || []).forEach(function (line) {
                            bandQuads(line, half, -half, dash).forEach(function (quad) {
                                flatJobs.push({ ring: quad, top: paintTop, color: '#f4f4f4', alpha: markingAlpha });
                            });
                        });
                    });
                    const bays = (typeof buildCorridorParkingBays === 'function')
                        ? buildCorridorParkingBays([entry.points], entry.profile) : [];
                    bays.forEach(function (bay) {
                        const half = bay.kind === 'edge' ? 0.075 : 0.06;
                        bandQuads(bay.line, half, -half, null).forEach(function (quad) {
                            flatJobs.push({ ring: quad, top: paintTop, color: '#f4f4f4', alpha: markingAlpha });
                        });
                    });
                    const arrows = (typeof buildCorridorDirectionArrows === 'function')
                        ? buildCorridorDirectionArrows([entry.points], entry.profile) : [];
                    arrows.forEach(function (ring) {
                        flatJobs.push({ ring: ring, top: paintTop, color: '#f4f4f4', alpha: markingAlpha });
                    });

                    const decorations = (typeof buildCorridorDecorations === 'function')
                        ? buildCorridorDecorations([entry.points], entry.profile) : [];
                    decorations.forEach(function (item) {
                        if (item.kind !== 'tree') return;
                        const span = spans[item.stripIndex];
                        const spanLane = (span && typeof CORRIDOR_LANE_TYPES !== 'undefined' && CORRIDOR_LANE_TYPES[span.type]) || {};
                        item.surfaceOffset = CORRIDOR_BODY.road + (Number(spanLane.height) || 0);
                        treePoints.push(item);
                    });

                    crossJunctionInput.push({
                        centerline: [entry.points],
                        profile: entry.profile,
                        corridorId: String(proposal.proposalId !== undefined ? proposal.proposalId : (proposal.id || ''))
                    });
                });
                const junctions = (typeof buildCorridorJunctionTreatmentsForEntries === 'function')
                    ? buildCorridorJunctionTreatmentsForEntries(entries) : [];
                collectJunctionFlats(junctions, flatJobs, alpha, markingAlpha);
            } catch (err) {
                // One corrupt road must not cost every other road its asphalt (2D/3D isolate the same way).
                console.error('[photoreal] corridor render failed for proposal', proposal && proposal.proposalId, err);
            }
        });

        // Intersections BETWEEN different applied roads get the same asphalt + zebra treatment.
        if (typeof buildCrossCorridorJunctionTreatments === 'function'
            && new Set(crossJunctionInput.map(function (c) { return c.corridorId; })).size >= 2) {
            try {
                collectJunctionFlats(buildCrossCorridorJunctionTreatments(crossJunctionInput), flatJobs, alpha, markingAlpha);
            } catch (err) {
                console.warn('[photoreal] cross-corridor junctions failed', err);
            }
        }

        // Applied structures: their ground body + park trees.
        appliedStructureProposals().forEach(function (proposal) {
            try {
                const sp = proposal.structureProposal;
                const style = STRUCTURE_STYLES[sp.kind] || STRUCTURE_STYLES.square;
                polygonsOf(sp.geometry).forEach(function (rings) {
                    const outer = rings && rings[0];
                    if (!Array.isArray(outer) || outer.length < 3) return;
                    stripJobs.push({
                        ring: densifyRing(geoRingToLatLngs(outer), 20),
                        top: STRUCTURE_SURFACE_TOP,
                        color: style.surface,
                        alpha: alpha
                    });
                });
                if (style.trees) {
                    treePoints = treePoints.concat(scatterTreesInPolygon(sp.geometry, STRUCTURE_TREE_SPACING));
                }
            } catch (err) {
                console.error('[photoreal] structure render failed for proposal', proposal && proposal.proposalId, err);
            }
        });

        // A designation corridor (an area DECLARED road land: polygon, no centerline, no lanes)
        // gets the same fill treatment, in plain asphalt.
        appliedCorridorProposals().forEach(function (proposal) {
            const definition = window.corridorProposalDefinition(proposal);
            if (!definition || typeof corridorIsDesignation !== 'function' || !corridorIsDesignation(definition)) return;
            polygonsOf(definition.polygon).forEach(function (rings) {
                const outer = rings && rings[0];
                if (!Array.isArray(outer) || outer.length < 3) return;
                stripJobs.push({
                    ring: densifyRing(geoRingToLatLngs(outer), 20),
                    top: STRUCTURE_SURFACE_TOP,
                    color: '#3d3d3d',
                    alpha: alpha
                });
            });
        });

        // Bare ground where a razed building stood: with the globe hidden, its carve hole would
        // otherwise open into the void. Two hard-won rules: (1) the fill is CLIPPED out of every
        // applied structure surface — the lawn IS the ground there, and an overlapping fill used
        // to poke through the terrain-following lawn as angular soil patches wherever the local
        // terrain dipped below the fill's height; (2) the remainder is itself terrain-following
        // (a body, not an anchor-height flat), so a slope cannot lift it through the road above.
        if (typeof window.collectCarveRecords === 'function'
            && typeof proposalStorage !== 'undefined' && typeof proposalStorage.getAllProposals === 'function') {
            try {
                window.collectCarveRecords(proposalStorage.getAllProposals()).records.forEach(function (record) {
                    if (record.remainder) return;
                    if (String(record.id).indexOf('proposal:') === 0) return;
                    const geometry = razedFootprintOutsideStructures(record.geometry);
                    if (!geometry) return; // fully under a structure: its surface is the ground
                    polygonsOf(geometry).forEach(function (rings) {
                        const outer = rings && rings[0];
                        if (!Array.isArray(outer) || outer.length < 3) return;
                        stripJobs.push({
                            ring: densifyRing(geoRingToLatLngs(outer), 12),
                            top: 0.04,
                            color: CLEARED_GROUND_COLOR,
                            alpha: alpha
                        });
                    });
                });
            } catch (_) { }
        }

        if (treePoints.length > MAX_PHOTOREAL_TREES) {
            console.warn('[photoreal] rendering ' + MAX_PHOTOREAL_TREES + ' of ' + treePoints.length
                + ' trees (entity budget, corridors + parks)');
            treePoints = treePoints.slice(0, MAX_PHOTOREAL_TREES);
        }
        buildCorridorBodies(stripJobs, flatJobs, treePoints, alpha, token);
        // A corridor applied after the tileset loaded still wants the mesh seated to it.
        if (googleTileset) seatMeshToTerrain(googleTileset);
    }

    function renderProposedBuildings() {
        if (!viewer) return;
        clearProposal();
        if (plannedDisplay === 'off') { applyCarving(); return; }
        const proposalAlpha = plannedDisplay === 'ghost' ? 0.35 : 0.85;
        const arr = Array.isArray(window.proposedBuildings) ? window.proposedBuildings : [];
        // Provisional base for every box: the entry target's ground height (sampled from world
        // terrain, already loaded) — good enough to appear on the ground before per-box mesh refine.
        const provisionalBase = lastGroundHeight || 0;
        for (let i = 0; i < arr.length; i++) {
            const feat = arr[i];
            if (!feat || !feat.geometry) continue;
            // Mirror legacy's two render paths: glTF model when modelUrl is present, else extrusion.
            if (feat.properties && feat.properties.modelUrl) {
                addProposedModel(feat);
                continue;
            }
            const polys = polygonsOf(feat.geometry);
            const hM = buildingHeightM(feat.properties);
            const color = (feat.properties && feat.properties.color) || '#2f6df6';
            for (let p = 0; p < polys.length; p++) {
                const rings = polys[p];               // [outerRing, hole1, hole2, ...]
                if (!rings || !Array.isArray(rings[0]) || rings[0].length < 3) continue;
                const outer = rings[0];
                // Footprints are EPSG:4326 [lng,lat] — fed straight to Cesium (it does geo->ECEF).

                // Inner rings become holes so courtyards (perimeter blocks) stay open — matching
                // the legacy 3D extrusion, which honours shape.holes.
                const holes = [];
                for (let k = 1; k < rings.length; k++) {
                    if (Array.isArray(rings[k]) && rings[k].length >= 3) {
                        holes.push(new Cesium.PolygonHierarchy(ringToCartesians(rings[k])));
                    }
                }
                const ent = viewer.entities.add({
                    polygon: {
                        hierarchy: new Cesium.PolygonHierarchy(ringToCartesians(outer), holes),
                        perPositionHeight: false,
                        height: provisionalBase,
                        extrudedHeight: provisionalBase + hM,
                        material: Cesium.Color.fromCssColorString(color).withAlpha(proposalAlpha),
                        outline: true,
                        outlineColor: Cesium.Color.WHITE
                    }
                });
                proposalEntities.push(ent);
                // Settle the box onto the real mesh once the tiles under it stream in (non-blocking).
                refineBase(ent, outer, hM);
            }
        }
        renderCorridors();
        applyCarving();
    }

    // ---- camera: open from the exact legacy-3D vantage point, no fly-in animation ----
    // Everything the proposal puts on the map, as GeoJSON features for bbox framing: proposed
    // buildings plus applied corridor footprints (a road-only proposal must still frame its road).
    function proposalBboxFeatures() {
        const arr = Array.isArray(window.proposedBuildings) ? window.proposedBuildings : [];
        const feats = arr.filter(function (f) { return f && f.geometry; });
        appliedCorridorProposals().forEach(function (proposal) {
            const definition = window.corridorProposalDefinition(proposal);
            const polygon = definition && (definition.surfaceFootprint || definition.polygon);
            if (polygon && polygon.type) feats.push({ type: 'Feature', properties: {}, geometry: polygon });
        });
        return feats;
    }

    // Read the current Three.js 3D camera (target lng/lat, heading, pitch, range) so the photoreal
    // view starts where the user already is. Falls back to the proposal bbox, then the Leaflet view.
    function getEntryView() {
        const v = (typeof window.getThree3DGeoView === 'function') ? window.getThree3DGeoView() : null;
        if (v) return v;
        // Fallback A: frame the proposal bounding box.
        const feats = proposalBboxFeatures();
        if (feats.length && typeof turf !== 'undefined' && turf) {
            try {
                const bbox = turf.bbox(turf.featureCollection(feats));
                const cx = (bbox[0] + bbox[2]) / 2, cy = (bbox[1] + bbox[3]) / 2;
                const diag = (turf.distance([bbox[0], bbox[1]], [bbox[2], bbox[3]]) || 0.2) * 1000;
                return { targetLng: cx, targetLat: cy, headingDeg: 0, pitchRad: Cesium.Math.toRadians(-35), range: Math.max(180, diag * 1.6) };
            } catch (_) { /* fall through */ }
        }
        // Fallback B: the current Leaflet map view.
        const m = window.map;
        if (m && typeof m.getCenter === 'function') {
            const c = m.getCenter();
            const zoom = (typeof m.getZoom === 'function') ? m.getZoom() : 17;
            const mpp = 156543.03392 * Math.cos(c.lat * Math.PI / 180) / Math.pow(2, zoom);
            const range = Math.max(180, mpp * (window.innerHeight || 800) * 0.9);
            return { targetLng: c.lng, targetLat: c.lat, headingDeg: 0, pitchRad: Cesium.Math.toRadians(-35), range: range };
        }
        return null;
    }

    // Instantly point the camera at the entry view's target. `groundHeight` is the target's
    // elevation on the mesh (sampled once tiles are present) so the camera sits at the right height.
    function setCameraToView(v, groundHeight) {
        if (!viewer || !v) return;
        const target = Cesium.Cartesian3.fromDegrees(v.targetLng, v.targetLat, groundHeight || 0);
        viewer.camera.lookAt(
            target,
            new Cesium.HeadingPitchRange(Cesium.Math.toRadians(v.headingDeg), v.pitchRad, v.range)
        );
        // Release the lookAt reference frame so OrbitControls-style navigation works afterwards.
        viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    }

    async function applyEntryView(v) {
        if (!viewer || !v) return;
        let gElev = 0;
        try {
            const s = await viewer.scene.sampleHeightMostDetailed([Cesium.Cartographic.fromDegrees(v.targetLng, v.targetLat)]);
            if (s[0] && isFinite(s[0].height)) gElev = s[0].height;
        } catch (_) { /* ellipsoid */ }
        lastGroundHeight = gElev;
        setCameraToView(v, gElev);
    }

    // Gentle auto-orbit around the proposal for URL-driven entries. Re-aims the camera each frame with
    // a slowly incrementing heading, and stops the instant the user grabs the camera.
    function stopAutoRotate() {
        if (autoRotateRemove) { try { autoRotateRemove(); } catch (_) { } autoRotateRemove = null; }
    }
    function startAutoRotate(v) {
        stopAutoRotate();
        if (!viewer || !v) return;
        let heading = v.headingDeg || 0;
        const target = Cesium.Cartesian3.fromDegrees(v.targetLng, v.targetLat, lastGroundHeight || 0);
        autoRotateRemove = viewer.scene.preRender.addEventListener(function () {
            heading = (heading + 0.08) % 360; // ~gentle spin
            viewer.camera.lookAt(target, new Cesium.HeadingPitchRange(Cesium.Math.toRadians(heading), v.pitchRad, v.range));
            viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
            // Under requestRenderMode each orbited frame must schedule the next one.
            viewer.scene.requestRender();
        });
        try {
            const canvas = viewer.canvas;
            ['pointerdown', 'wheel', 'touchstart'].forEach(function (e) {
                canvas.addEventListener(e, stopAutoRotate, { once: true, passive: true });
            });
        } catch (_) { }
    }

    // ---- activate / deactivate ----
    // Frame the whole proposal from a top-down-ish angle (used for URL-driven realistic entry, so the
    // camera encompasses the entire proposal and then tilts to show the 3D — independent of wherever
    // the abstract-3D camera happened to be).
    function getProposalBboxView(pitchDeg) {
        const feats = proposalBboxFeatures();
        if (!feats.length || typeof turf === 'undefined' || !turf) return null;
        try {
            const bbox = turf.bbox(turf.featureCollection(feats));
            const cx = (bbox[0] + bbox[2]) / 2, cy = (bbox[1] + bbox[3]) / 2;
            const diag = (turf.distance([bbox[0], bbox[1]], [bbox[2], bbox[3]]) || 0.2) * 1000;
            return { targetLng: cx, targetLat: cy, headingDeg: 0, pitchRad: Cesium.Math.toRadians(pitchDeg || -45), range: Math.max(180, diag * 1.6) };
        } catch (_) { return null; }
    }

    async function activate(options) {
        options = options || {};
        const btn = toggleBtn();
        if (btn) { btn.classList.add('active'); btn.disabled = true; }
        // Select the globe (and deselect 2D/3D) immediately, before the async tile load —
        // updateModeButtonStates keys off `active`, which only flips true once the viewer is up.
        try {
            const b2 = document.getElementById('mode-2d-toggle'); if (b2) b2.classList.remove('active');
            const b3 = document.getElementById('mode-3d-toggle'); if (b3) b3.classList.remove('active');
        } catch (_) { }
        document.body.classList.add('realistic-mode-active');
        const el = containerEl();
        if (el) el.classList.add('active'); // give the container size before creating the viewer
        // Ported from the isochrone sim ("hidden until seated + cut + dressed"): the canvas stays
        // invisible until the camera is aimed and the first tiles are in, so the first visible
        // frame is the city — never a globe collapsing into place. visibility (not display)
        // preserves layout, so the viewer sizes correctly and keeps rendering while hidden; the
        // abstract 3D view stays on screen underneath meanwhile.
        if (el) el.style.visibility = 'hidden';
        const reveal = function () {
            const c = containerEl();
            if (c) c.style.visibility = '';
        };
        // URL-driven entry frames the whole proposal; otherwise start from the abstract-3D vantage.
        const entryView = (options.frameProposal ? getProposalBboxView(options.pitchDeg) : null) || getEntryView();
        try {
            await ensureViewer();
            ensureDisplayControls();
            active = true;
            if (window.activeProposalDraftComparison?.draftId && typeof window.renderProposalDraftComparison === 'function') {
                window.renderProposalDraftComparison(
                    window.activeProposalDraftComparison.draftId,
                    window.activeProposalDraftComparison.mode || 'overlay'
                );
            }
            try { viewer.resize(); } catch (_) { }
            if (entryView) {
                // Aim at the matched view immediately so we skip straight to the loading view —
                // no starfield, no fly-in. The sync call avoids a one-frame whole-earth flash;
                // applyEntryView then corrects the ground height from terrain (pre-photoreal).
                setCameraToView(entryView, 0);
                await applyEntryView(entryView);
            }
            // Draw the proposal right away on a provisional (terrain) base — don't wait on the mesh.
            // Each box then settles onto the real ground in the background as tiles stream in, so the
            // proposal is visible immediately instead of after the ~10s mesh-height sampling.
            renderProposedBuildings();
            const ts = await ensureTileset();
            if (entryView) await applyEntryView(entryView); // fine-tune once the photoreal mesh is present
            if (!ts || ts.tilesLoaded) {
                reveal();
            } else {
                // First frames stream in shortly; 8 s is the give-up point so a slow connection
                // still gets a (filling-in) view rather than a blank mode.
                const revealTimer = setTimeout(reveal, 8000);
                try {
                    ts.initialTilesLoaded.addEventListener(function () { clearTimeout(revealTimer); reveal(); });
                } catch (_) { clearTimeout(revealTimer); reveal(); }
            }
            if (options.autoRotate && entryView) startAutoRotate(entryView);
            showRotateHint();
        } catch (err) {
            reveal(); // never leave the mode invisible
            console.error('[photoreal] activation failed:', err);
            setStatus('Failed to load photorealistic 3D.');
        } finally {
            if (btn) btn.disabled = false;
            // Re-sync the mode buttons to the settled state — if activation failed, `active`
            // is still false and this drops the globe's selection back onto 3D.
            if (typeof window.updateModeButtonStates === 'function') window.updateModeButtonStates();
        }
    }

    function deactivate() {
        active = false;
        stopAutoRotate();
        hideRotateHint();
        updateTileLoader(0, 0);
        const el = containerEl();
        if (el) { el.classList.remove('active'); el.style.visibility = ''; }
        document.body.classList.remove('realistic-mode-active');
        if (window.activeProposalDraftComparison?.draftId && typeof window.renderProposalDraftComparison === 'function') {
            window.renderProposalDraftComparison(
                window.activeProposalDraftComparison.draftId,
                window.activeProposalDraftComparison.mode || 'overlay'
            );
        }
        const btn = toggleBtn();
        if (btn) btn.classList.remove('active');
        if (typeof window.updateModeButtonStates === 'function') window.updateModeButtonStates();
        // The abstract-3D canvas was display:none while the globe covered it, so its renderer
        // size may be stale if the window changed meanwhile. Nudge three-mode to re-fit.
        try { window.dispatchEvent(new Event('resize')); } catch (_) { }
    }

    function toggle() {
        if (active) deactivate(); else activate();
    }

    // Globe-button click: go to real-world. It's a no-op when already realistic (use the
    // 2D / 3D buttons to leave). From 2D it first enters abstract 3D so the realistic globe
    // sits on top of a live 3D scene, matching the 3D → realistic path; we wait for the 3D
    // scene to actually be up (threeModeReady) before overlaying Cesium, so the two don't
    // race and leave the 3D entry half-initialised.
    function goRealistic() {
        if (active) return;
        if (typeof window.isThreeModeActive === 'function' && window.isThreeModeActive()) {
            activate();
            return;
        }
        if (typeof window.enterThreeMode !== 'function') { activate(); return; }
        // Select the globe immediately for responsive feedback, then wait for 3D readiness.
        const btn = toggleBtn();
        if (btn) btn.classList.add('active');
        try {
            const b2 = document.getElementById('mode-2d-toggle'); if (b2) b2.classList.remove('active');
            const b3 = document.getElementById('mode-3d-toggle'); if (b3) b3.classList.remove('active');
        } catch (_) { }
        const onReady = function () { window.removeEventListener('threeModeReady', onReady); activate(); };
        window.addEventListener('threeModeReady', onReady);
        try { window.enterThreeMode(); } catch (_) { window.removeEventListener('threeModeReady', onReady); }
    }

    // Re-render when the proposal changes while we're showing the globe.
    window.addEventListener('proposedBuildingsUpdated', function () {
        if (active) { renderProposedBuildings(); }
    });

    // Auto-exit photoreal when the user leaves 3D mode entirely (three-mode clears the body class).
    const bodyObserver = new MutationObserver(function () {
        if (active && !document.body.classList.contains('three-mode-active')) {
            deactivate();
        }
    });
    bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    function init() {
        const btn = toggleBtn();
        if (btn) btn.addEventListener('click', goRealistic);
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
        getViewer: function () { return viewer; }
    };
})();
