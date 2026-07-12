// Photorealistic 3D mode: overlays Google Photorealistic 3D Tiles (CesiumJS + Cesium ion)
// on top of the existing 3D view, rendering the proposal's proposed buildings on real-world
// context. Toggled from a button inside 3D mode. Cesium is lazy-loaded on first use so it
// never affects initial page load. Kept loosely coupled to three-mode.js: it only reads the
// shared `window.proposedBuildings` / `window.map` and watches the `three-mode-active` body class.
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
    let active = false;
    let statusEl = null;
    let lastGroundHeight = 0;     // elevation of the last camera target (for the auto-orbit)
    let autoRotateRemove = null;  // remover fn for the preRender auto-orbit listener
    const proposalEntities = [];

    const containerEl = () => document.getElementById('cesium-container');
    const toggleBtn = () => document.getElementById('mode-realistic-toggle');

    function setStatus(msg) {
        if (!statusEl) return;
        statusEl.textContent = msg || '';
        statusEl.style.display = msg ? 'block' : 'none';
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

    async function ensureViewer() {
        await ensureCesiumLoaded();
        const el = containerEl();
        if (!statusEl) {
            statusEl = document.createElement('div');
            statusEl.className = 'photoreal-status';
            el.appendChild(statusEl);
        }
        if (viewer) return viewer;
        Cesium.Ion.defaultAccessToken = ION_TOKEN;
        viewer = new Cesium.Viewer(el, {
            timeline: false, animation: false, baseLayerPicker: false,
            geocoder: false, homeButton: false, sceneModePicker: false,
            navigationHelpButton: false, infoBox: false, selectionIndicator: false,
            fullscreenButton: false
        });
        viewer.scene.globe.depthTestAgainstTerrain = true;
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
                viewer.scene.primitives.add(ts);
                setStatus('');
                return ts;
            })
            .catch(function (err) {
                // No Google coverage for this city (or EEA-billed direct access): the globe still
                // shows satellite imagery + terrain so the proposal stays in real-ish context.
                setStatus('No photorealistic coverage here — showing satellite + terrain.');
                console.warn('[photoreal] Google tileset failed to load:', err);
                return null;
            });
        return tilesetPromise;
    }

    // ---- proposed-building rendering (lng/lat footprints + height in metres -> extruded massing) ----
    function clearProposal() {
        if (!viewer) return;
        proposalEntities.forEach(function (e) { viewer.entities.remove(e); });
        proposalEntities.length = 0;
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

    // Mirror three-mode.js estimateBuildingHeightMeters priority.
    function buildingHeightM(props) {
        if (!props) return 10;
        const h = (props.height != null) ? props.height : (props.HEIGHT != null ? props.HEIGHT : props.elevation);
        if (isFinite(+h) && +h > 0) return +h;
        const lv = (props.levels != null) ? props.levels : (props.storeys != null ? props.storeys : props.stories);
        if (isFinite(+lv) && +lv > 0) return +lv * 3.3;
        return 10;
    }

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

    function renderProposedBuildings() {
        if (!viewer) return;
        clearProposal();
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
                        material: Cesium.Color.fromCssColorString(color).withAlpha(0.85),
                        outline: true,
                        outlineColor: Cesium.Color.WHITE
                    }
                });
                proposalEntities.push(ent);
                // Settle the box onto the real mesh once the tiles under it stream in (non-blocking).
                refineBase(ent, outer, hM);
            }
        }
    }

    // ---- camera: open from the exact legacy-3D vantage point, no fly-in animation ----
    // Read the current Three.js 3D camera (target lng/lat, heading, pitch, range) so the photoreal
    // view starts where the user already is. Falls back to the proposal bbox, then the Leaflet view.
    function getEntryView() {
        const v = (typeof window.getThree3DGeoView === 'function') ? window.getThree3DGeoView() : null;
        if (v) return v;
        // Fallback A: frame the proposal bounding box.
        const arr = Array.isArray(window.proposedBuildings) ? window.proposedBuildings : [];
        const feats = arr.filter(function (f) { return f && f.geometry; });
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
        const arr = Array.isArray(window.proposedBuildings) ? window.proposedBuildings : [];
        const feats = arr.filter(function (f) { return f && f.geometry; });
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
        // URL-driven entry frames the whole proposal; otherwise start from the abstract-3D vantage.
        const entryView = (options.frameProposal ? getProposalBboxView(options.pitchDeg) : null) || getEntryView();
        try {
            await ensureViewer();
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
            await ensureTileset();
            if (entryView) await applyEntryView(entryView); // fine-tune once the photoreal mesh is present
            if (options.autoRotate && entryView) startAutoRotate(entryView);
        } catch (err) {
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
        const el = containerEl();
        if (el) el.classList.remove('active');
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
