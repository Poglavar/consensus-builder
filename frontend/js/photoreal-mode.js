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

    async function renderProposedBuildings() {
        if (!viewer) return;
        clearProposal();
        const arr = Array.isArray(window.proposedBuildings) ? window.proposedBuildings : [];
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
                // Sample the photoreal mesh under the outer ring so the massing sits on the ground.
                let base = 0;
                try {
                    const cartos = outer.map(function (c) { return Cesium.Cartographic.fromDegrees(c[0], c[1]); });
                    const sampled = await viewer.scene.sampleHeightMostDetailed(cartos);
                    const hs = sampled.map(function (s) { return (s && isFinite(s.height)) ? s.height : null; })
                        .filter(function (v) { return v !== null; });
                    if (hs.length) base = Math.min.apply(null, hs);
                } catch (_) { /* fall back to ellipsoid height 0 */ }

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
                        height: base,
                        extrudedHeight: base + hM,
                        material: Cesium.Color.fromCssColorString(color).withAlpha(0.85),
                        outline: true,
                        outlineColor: Cesium.Color.WHITE
                    }
                });
                proposalEntities.push(ent);
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
        setCameraToView(v, gElev);
    }

    // ---- activate / deactivate ----
    async function activate() {
        const btn = toggleBtn();
        if (btn) { btn.classList.add('active'); btn.disabled = true; }
        document.body.classList.add('realistic-mode-active');
        const el = containerEl();
        if (el) el.classList.add('active'); // give the container size before creating the viewer
        const entryView = getEntryView();   // capture the legacy-3D camera before anything changes
        try {
            await ensureViewer();
            active = true;
            try { viewer.resize(); } catch (_) { }
            if (entryView) {
                // Aim at the matched view immediately so we skip straight to the loading view —
                // no starfield, no fly-in. The sync call avoids a one-frame whole-earth flash;
                // applyEntryView then corrects the ground height from terrain (pre-photoreal).
                setCameraToView(entryView, 0);
                await applyEntryView(entryView);
            }
            await ensureTileset();
            await renderProposedBuildings();
            if (entryView) await applyEntryView(entryView); // fine-tune once the photoreal mesh is present
        } catch (err) {
            console.error('[photoreal] activation failed:', err);
            setStatus('Failed to load photorealistic 3D.');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    function deactivate() {
        active = false;
        const el = containerEl();
        if (el) el.classList.remove('active');
        document.body.classList.remove('realistic-mode-active');
        const btn = toggleBtn();
        if (btn) btn.classList.remove('active');
    }

    function toggle() {
        if (active) deactivate(); else activate();
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
        if (btn) btn.addEventListener('click', toggle);
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
