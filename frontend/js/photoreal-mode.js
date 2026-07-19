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
    // Diagnostic: `?seat` shows the live seating state on-screen (readable on mobile, no console).
    // Checked at runtime and persisted for the session, because the share flow rewrites the
    // /proposals/... URL and can drop the query before this reads it.
    function seatDebugActive() {
        try {
            if (new URLSearchParams(window.location.search || '').has('seat')) {
                try { sessionStorage.setItem('cbSeatDebug', '1'); } catch (_) { }
                return true;
            }
            return sessionStorage.getItem('cbSeatDebug') === '1';
        } catch (_) { return false; }
    }

    // Experimental exact caps for every Google mesh triangle crossed by a full-discard boundary.
    // `debug` uses the same geometry as `mesh`, but renders it visibly through everything so we
    // can distinguish bad placement from a texture/depth-order problem. Persist like ?seat because
    // proposal-route normalization can remove query parameters early.
    function meshSeamMode() {
        try {
            const params = new URLSearchParams(window.location.search || '');
            if (params.has('seam')) sessionStorage.setItem('cbPhotorealSeam', params.get('seam'));
            const mode = sessionStorage.getItem('cbPhotorealSeam');
            return mode === 'mesh' || mode === 'debug' ? mode : 'off';
        } catch (_) { return 'off'; }
    }

    function meshSeamCapsActive() {
        return meshSeamMode() !== 'off';
    }

    function meshSeamDebugActive() {
        return meshSeamMode() === 'debug';
    }

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
    let tilesAnchorKey = null; // anchor of the live tile session; reuse while it matches
    let tilesCamera = null;    // camera bound to the renderer (re-bound when three-mode rebuilds)
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
    let lockedGroundZ = null; // final pre-seat height chosen by the temporal stability gate
    let lastProbeSummary = null; // raw round distribution, exposed by ?seat for ground-vs-roof diagnosis
    let lockWaitS = 0;
    let lockAccumS = 0;
    let seatDebugAccumS = 0;
    let lastFrameNow = 0;
    let sinceAnyLoadS = 0;
    let profT = null; // transition profile timestamps (activate -> lib -> setup -> stream -> seat)
    let statusEl = null;
    let loaderEl = null;
    let loaderTextEl = null;
    let fpsEl = null;
    let seatDebugEl = null;
    let coverEl = null; // opaque loading cover hiding the abstract 3D during a URL-driven rw entry
    let fpsFrames = 0;
    let fpsSinceS = 0;
    const loadedTileScenes = new Set();
    let tileSeamCaps = new WeakMap();
    let seamScheduled = new WeakMap();
    let seamBoundaryGrid = null;
    let seamGeneration = 0;
    let seamReadyScenes = 0;
    let seamCapSegments = 0;

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

    // On a URL-driven rw entry, cover the abstract 3D while Google tiles stream, so the view goes
    // 2D -> loading -> composed rw instead of flashing the flat plan first. Removed at first-seat
    // (the composed reveal). z-index sits below the controls panel/mode buttons, so 2D still works.
    function showCover() {
        const host = containerEl();
        if (!host || coverEl) return;
        coverEl = document.createElement('div');
        coverEl.className = 'photoreal-cover';
        coverEl.innerHTML = '<div class="photoreal-cover-spinner"></div>'
            + '<div class="photoreal-cover-text">'
            + photorealI18n('threeMode.controls.streamingTiles', 'Loading photorealistic view…') + '</div>';
        host.appendChild(coverEl);
    }
    function hideCover() {
        if (coverEl) { try { coverEl.remove(); } catch (_) { } coverEl = null; }
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
        [statusEl, loaderEl, fpsEl, seatDebugEl, coverEl].forEach(function (el) {
            if (el) { try { el.remove(); } catch (_) { } }
        });
        statusEl = loaderEl = loaderTextEl = fpsEl = seatDebugEl = coverEl = null;
    }

    // ---- seating (port of the sim's lockTrackHeightOnce) ----
    // Probe offsets (scene metres) around the origin for the ground raycast. A single ray at
    // the proposal centre seats the world on whatever it hits — in Manhattan that was a tower
    // ROOF, which sank every street ~100 m below the proposals. Roofs only ever bias a probe
    // HIGH, so the round's MINIMUM hit is the street level (same reasoning that fixed the
    // Cesium seating against parked-car roofs).
    const LOCK_PROBE_OFFSETS = [
        [0, 0], [60, 0], [-60, 0], [0, 60], [0, -60],
        [120, 60], [-120, 60], [120, -60], [-120, -60],
        [180, 0], [-180, 0], [0, 180], [0, -180]
    ];

    // Raycast a spread of points near the scene origin against the streamed tiles and shift
    // the whole world so its STREET surface sits just below the z=0 content. Heights are true
    // metres in both frames (z scale is 1), so all sim thresholds carry over.
    function tryLockGround(dtS) {
        lockWaitS += dtS;
        lockAccumS += dtS;
        if (lockAccumS < LOCK_SAMPLE_INTERVAL_S) return;
        lockAccumS = 0;
        const THREE = window.THREE;
        if (!THREE || !tiles) return;
        let groundZ = null;
        try {
            const origin = new THREE.Vector3();
            const down = new THREE.Vector3(0, 0, -1);
            const zs = [];
            for (let i = 0; i < LOCK_PROBE_OFFSETS.length; i++) {
                origin.set(LOCK_PROBE_OFFSETS[i][0], LOCK_PROBE_OFFSETS[i][1], 4000);
                const raycaster = new THREE.Raycaster(origin, down, 0, 9000);
                const hits = raycaster.intersectObject(tiles.group, true);
                if (!hits.length) continue;
                const z = hits[0].point.z;
                // Far-earth trap (from the sim): before local tiles stream in, a ray can hit a
                // coarse far-earth tile kilometres below/above; a static coarse tile passes the
                // stability test, so reject on magnitude before it can seat the world in orbit.
                if (Math.abs(z) > FAR_EARTH_LIMIT_M) continue;
                zs.push(z);
            }
            if (zs.length) {
                if (profT && !profT.firstProbe) profT.firstProbe = performance.now();
                zs.sort(function (a, b) { return a - b; });
                // p25 of the round, not its minimum: the minimum over-corrects into pits (a
                // sunken rail trench in Zagreb seated the streets ABOVE the proposals), while
                // roofs and canopy only ever populate the top of the distribution.
                const p25Index = Math.min(zs.length - 1, Math.floor(zs.length * 0.25));
                groundZ = zs[p25Index];
                lastProbeSummary = {
                    count: zs.length,
                    min: zs[0],
                    p25: groundZ,
                    median: zs[Math.floor(zs.length / 2)],
                    max: zs[zs.length - 1]
                };
            }
        } catch (_) { return; }
        if (groundZ === null) return;
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
        lockedGroundZ = use;
        seatNode.position.z -= (use + GROUND_BELOW_CONTENT_M);
        grounded = true;
        terrainGrid = null; // re-seated: the height field must be re-sampled in the new frame
        // The world is in place: carve it under the proposals, swap the abstract built layers
        // for the mesh, and reveal — the first visible frame is the final composition.
        buildMaskShapes();
        renderCarveMask(0, 0);
        if (typeof window.setRealisticLayerActive === 'function') window.setRealisticLayerActive(true);
        tiles.group.visible = builtVisible;
        console.log('[photoreal] world seated: ground shifted ' + (use + GROUND_BELOW_CONTENT_M).toFixed(2)
            + ' m (' + (stable ? 'stable' : 'median-after-timeout') + ')');
        if (profT) {
            const span = function (a, b) { return (a && b && b >= a) ? ((b - a) / 1000).toFixed(1) + 's' : '—'; };
            const now = performance.now();
            console.log('[photoreal] transition profile: tiles-lib ' + span(profT.t0, profT.lib)
                + ' | ion+setup ' + span(profT.lib, profT.setup)
                + ' | first-tile ' + span(profT.setup, profT.firstTile)
                + ' | stream-to-95% ' + span(profT.firstTile, profT.streamed)
                + ' | seat ' + span(profT.streamed || profT.firstProbe || profT.firstTile, now)
                + ' | TOTAL ' + span(profT.t0, now));
        }
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
    // ONE clean carve, sealed by construction. The Google tiles are a HOLLOW SHELL of one
    // fused surface (ground, trees and buildings are the same skin): any partial trim of that
    // skin opens a hole, and with backface culling a grazing sightline then travels inside the
    // shell and out to the sky — which is where every light-blue edge artefact came from. Two
    // axioms end that class of bug: (1) cut ONLY the exact footprints our own surfaces cover;
    // edge trees stay whole and may lean over proposals like real trees do; (2) leave the tile
    // materials DOUBLE-SIDED (as Google ships them), so even where a cut does expose the shell
    // interior, a sightline hits mirrored terrain texture — never the background.
    const CARVE_FLOOR_Z = -0.3;      // fragments above this, inside a footprint, are discarded
    const CARVE_CORE_BUFFER_M = 1.2; // dilation against mask-texel combs along cut facades
    // Sealing the cut edge — a TERRAIN-CONFORMING CURTAIN. Our content is a flat table at z≈0, but
    // we seat the whole Google mesh from ONE probe, so away from that point the real ground rides
    // above or below the table. A fixed-depth earth skirt sealed the DOWNHILL edges (ground below
    // the table) but never the UPHILL ones (ground above it): a downward wall cannot fill an upward
    // gap, and that was the residual light-blue. So we sample the tile mesh's real height along
    // every cut edge — a coarse grid raycast once per seating and cached (the terrain doesn't move)
    // — clean that noisy top-surface grid into a bare-ground estimate, then build the earth wall
    // from the content up OR down to that height, meeting the rim wherever it sits. A flat earth
    // cap over the footprint handles the top-down view + razed pad.
    const CARVE_APRON_TOP_Z = -0.02;    // cap height: just under the z=0 content
    const CARVE_PLINTH_DEPTH_M = 4;     // fallback skirt depth where no terrain sample is available
    const CARVE_APRON_COLOR = 0x6e7563; // muted earth-green: plausible under grass and asphalt alike
    const CURTAIN_CONTENT_TOP_Z = 0.06;    // reach up to the park/plaza surface level
    const CURTAIN_TOP_MARGIN_M = 0.1;      // overlap the rim / content — no hairline seam
    const CURTAIN_BOTTOM_MARGIN_M = 1.0;   // sink below the lower of content/terrain
    const CURTAIN_MAX_RISE_M = 8;          // clamp rim height: ignore a stray tree/roof hit at the edge
    const CURTAIN_MAX_DIP_M = 25;          // clamp embankment depth on steep drops
    // Parks discard only the tile GROUND (below groundHeight + this band) and keep taller mesh, so
    // hedges/trees stand instead of being sliced into sky-windows. ~1 m ≈ the grass/shrub line:
    // remove Google's lawn so our park shows, keep anything taller as real greenery.
    const CARVE_KEEPVEG_BAND_M = 1.0;
    const TERRAIN_GRID_MAX = 22;           // grid samples per axis (<= ~484 raycasts, once per seat)
    const TERRAIN_GRID_MIN_CELL_M = 12;    // target grid spacing in scene metres
    // The ray grid is a digital-surface model (roofs/canopy included). A 5x5 morphological opening
    // finds the locally continuous low envelope without the rejected per-column minimum, whose
    // underside/coarse-tile hits warped the terrain. Only features >=1.5 m above that envelope move.
    const TERRAIN_OPENING_RADIUS_CELLS = 2;
    const TERRAIN_OBSTACLE_MIN_HEIGHT_M = 1.5;
    const TERRAIN_GAP_FILL_PASSES = 2;
    // ?seam=mesh prototype: intersect streamed triangles with the actual vector cut boundary and
    // give every clipped surface (ground, canopy, roof, facade) a short texture-matched fascia.
    // The earth curtain still handles the ground-to-road elevation difference below it.
    const MESH_SEAM_CAP_DEPTH_M = 1.25;
    const MESH_SEAM_GRID_CELL_M = 16;

    let maskRT = null;
    let maskScene = null;
    let maskCamera = null;
    let maskShapesGroup = null;
    let maskMaterial = null;
    let apronGroup = null;
    let apronMaterial = null;
    let maskMaterialPark = null; // green mask = keep-vegetation (park) regions
    let terrainGrid = null; // cached cleaned ground field, sampled once per covered plan extent
    let groundTexture = null; // DataTexture of terrainGrid heights, fed to the keep-veg shader
    let maskReady = false;
    let maskCenterX = 0;
    let maskCenterY = 0;
    let carveProposedBuildings = true; // proposed-building footprints join the carve (roads/parks always do)
    // Isolation in three-mode hides other proposals' surfaces; their carve holes must lift
    // with them. null = no isolation; a proposalId = carve only that proposal; '__parcel__'
    // = parcel isolation, carve nothing (the mesh returns wholesale during inspection).
    let isolationFilter = null;
    const corridorUniforms = {
        uCorridorMask: { value: null },
        uCorridorMin: { value: null }, // THREE.Vector2, created once THREE is up
        uCorridorScale: { value: 1 / (2 * MASK_WINDOW_HALF_M) },
        uCorridorOn: { value: 0 },
        uFloorZ: { value: CARVE_FLOOR_Z },
        // Keep-vegetation (green mask channel = parks only): discard the tile ground layer below
        // groundHeight + band, so hedges/trees stay standing instead of being sliced into windows.
        uGroundTex: { value: null },       // DataTexture of tile ground heights over the plan bbox
        uGroundMin: { value: null },       // THREE.Vector2, grid origin in scene XY
        uGroundInvSpan: { value: null },   // THREE.Vector2, 1 / grid span (world XY -> [0,1])
        uKeepBand: { value: CARVE_KEEPVEG_BAND_M }
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

    // Carve footprints, classified: 'covered' footprints are filled by our own surfaces (roads,
    // parks, proposed buildings) and get the core cut + a trim ring; 'razed' buildings have
    // nothing of ours on top and get the core cut + a bare-soil slab instead of a ring.
    function collectCarveGeometries() {
        const out = [];
        if (isolationFilter === '__parcel__') return out;
        const passesIsolation = function (proposal) {
            return !isolationFilter || String(proposal && proposal.proposalId) === isolationFilter;
        };
        // Applied road corridors: the surface-level footprint wins over the full outline, so
        // tunnelled / grade-separated stretches keep the mesh above them.
        appliedCorridorProposals().forEach(function (proposal) {
            if (!passesIsolation(proposal)) return;
            const definition = window.corridorProposalDefinition(proposal);
            if (definition) {
                const geom = definition.surfaceFootprint || definition.polygon;
                // Roads need a deterministic full cut. A keep-vegetation cut depends on the cached
                // terrain heightfield; when finer tile LODs replace the surface after that one-time
                // sample, their ground can rise above the stale cutoff and occlude the road again.
                // buffer 0 keeps this full cut exact: vegetation beside the paved footprint remains,
                // while anything actually inside the replacement road is intentionally removed.
                if (geom && geom.type) out.push({ geometry: geom, kind: 'covered', mode: 'full', buffer: 0 });
            }
        });
        // Applied structures. Squares/lakes/stations pave or flood the ground (full cut), but a
        // PARK keeps its trees and hedges — it only removes the tile lawn (keep-veg), so Google's
        // vegetation isn't sliced into sky-windows at the park edges.
        appliedStructureProposals().forEach(function (proposal) {
            if (!passesIsolation(proposal)) return;
            const isPark = proposal.structureProposal && proposal.structureProposal.kind === 'park';
            out.push({ geometry: proposal.structureProposal.geometry, kind: 'covered', mode: isPark ? 'keepveg' : 'full' });
        });
        // Buildings a proposal razes entirely (their outlines can stick out past the footprint
        // that razed them). Cut records are skipped — their demolished part lies inside a
        // corridor footprint already; demolished PROPOSED buildings aren't in the mesh at all.
        // Razed-building records carry no proposal provenance: they only carve when no
        // isolation filter is active (the mesh buildings return during isolation).
        if (!isolationFilter
            && typeof window.collectCarveRecords === 'function'
            && typeof proposalStorage !== 'undefined' && typeof proposalStorage.getAllProposals === 'function') {
            try {
                window.collectCarveRecords(proposalStorage.getAllProposals()).records.forEach(function (record) {
                    if (record.remainder) return;
                    if (String(record.id).indexOf('proposal:') === 0) return;
                    const outside = razedFootprintOutsideStructures(record.geometry);
                    if (outside) out.push({ geometry: outside, kind: 'razed', mode: 'full' });
                });
            } catch (err) {
                console.warn('[photoreal] demolition carve collection failed', err);
            }
        }
        // Proposed buildings replace the real mesh standing on their spot.
        if (carveProposedBuildings && Array.isArray(window.proposedBuildings)) {
            window.proposedBuildings.forEach(function (feat) {
                if (!feat || !feat.geometry) return;
                if (isolationFilter && String(feat.properties && feat.properties.proposalId) !== isolationFilter) return;
                out.push({ geometry: feat.geometry, kind: 'covered', mode: 'full' });
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
        maskMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000, side: THREE.DoubleSide });      // full discard
        maskMaterialPark = new THREE.MeshBasicMaterial({ color: 0x00ff00, side: THREE.DoubleSide });  // keep-veg (ground only)
        // DOUBLE-SIDED, like the mask: this material paints both the flat cap and the curtain
        // walls, and either can face the camera from either side depending on ring winding — a
        // single-sided earth surface would be back-face culled for ~half of all footprints and the
        // camera would look straight through the seal into the hole. A solid earth wall has no back.
        apronMaterial = new THREE.MeshBasicMaterial({ color: CARVE_APRON_COLOR, side: THREE.DoubleSide });
        if (!corridorUniforms.uCorridorMin.value) corridorUniforms.uCorridorMin.value = new THREE.Vector2();
        if (!corridorUniforms.uGroundMin.value) corridorUniforms.uGroundMin.value = new THREE.Vector2();
        if (!corridorUniforms.uGroundInvSpan.value) corridorUniforms.uGroundInvSpan.value = new THREE.Vector2();
        corridorUniforms.uCorridorMask.value = maskRT.texture;
    }

    function disposeGroupMeshes(group, parent) {
        if (!group) return;
        group.traverse(function (o) {
            if (o.isMesh && o.geometry) { try { o.geometry.dispose(); } catch (_) { } }
        });
        if (parent) { try { parent.remove(group); } catch (_) { } }
    }

    function disposeMaskShapes() {
        disposeGroupMeshes(maskShapesGroup, maskScene);
        maskShapesGroup = null;
        disposeGroupMeshes(apronGroup, internals && internals.scene);
        apronGroup = null;
    }

    function bufferGeometry(geometry, metres) {
        if (typeof turf === 'undefined' || !turf || typeof turf.buffer !== 'function') return geometry;
        try {
            const buffered = turf.buffer(
                { type: 'Feature', properties: {}, geometry: geometry }, metres, { units: 'meters' });
            return (buffered && buffered.geometry) ? buffered.geometry : geometry;
        } catch (_) { return geometry; }
    }

    // Carve footprint polygons → a THREE.Shape per polygon (for the cut mask + the flat cap) AND
    // that polygon's ring coordinates in scene XY (outer + holes), so the curtain walls can follow
    // the exact cut edge the mask cut.
    function polygonShapesAndRings(geometry, toXY) {
        const THREE = window.THREE;
        const out = [];
        polygonsOf(geometry).forEach(function (rings) {
            const outer = rings && rings[0];
            if (!Array.isArray(outer) || outer.length < 3) return;
            try {
                const shape = new THREE.Shape();
                const ringXY = [];
                const outerXY = outer.map(function (c) { return toXY(c[1], c[0]); });
                outerXY.forEach(function (xy, i) { if (i === 0) shape.moveTo(xy[0], xy[1]); else shape.lineTo(xy[0], xy[1]); });
                ringXY.push(outerXY);
                for (let h = 1; h < rings.length; h++) {
                    const ring = rings[h];
                    if (!Array.isArray(ring) || ring.length < 3) continue;
                    const holeXY = ring.map(function (c) { return toXY(c[1], c[0]); });
                    const hole = new THREE.Path();
                    holeXY.forEach(function (xy, i) { if (i === 0) hole.moveTo(xy[0], xy[1]); else hole.lineTo(xy[0], xy[1]); });
                    shape.holes.push(hole);
                    ringXY.push(holeXY);
                }
                out.push({ shape: shape, rings: ringXY });
            } catch (_) { /* one bad polygon must not cost the rest their carve */ }
        });
        return out;
    }

    function appendSeamRingSegments(ring, out) {
        if (!Array.isArray(ring) || ring.length < 2) return;
        for (let i = 1; i < ring.length; i++) {
            const a = ring[i - 1];
            const b = ring[i];
            if (!a || !b || (a[0] === b[0] && a[1] === b[1])) continue;
            out.push({ a: [a[0], a[1]], b: [b[0], b[1]] });
        }
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
            out.push({ a: [last[0], last[1]], b: [first[0], first[1]] });
        }
    }

    function disposeTileSeamCaps(scene) {
        const record = scene && tileSeamCaps.get(scene);
        if (!record) return;
        (record.caps || []).forEach(function (cap) {
            try { if (cap.parent) cap.parent.remove(cap); } catch (_) { }
            try { if (cap.geometry) cap.geometry.dispose(); } catch (_) { }
            try { if (cap.material) cap.material.dispose(); } catch (_) { }
        });
        seamReadyScenes = Math.max(0, seamReadyScenes - 1);
        seamCapSegments = Math.max(0, seamCapSegments - (record.segmentCount || 0));
        tileSeamCaps.delete(scene);
    }

    function clearAllTileSeamCaps() {
        seamGeneration += 1;
        loadedTileScenes.forEach(disposeTileSeamCaps);
        tileSeamCaps = new WeakMap();
        seamScheduled = new WeakMap();
        seamReadyScenes = 0;
        seamCapSegments = 0;
    }

    function seamMaterialFor(sourceMaterial) {
        const THREE = window.THREE;
        if (meshSeamDebugActive()) {
            const debugMaterial = new THREE.MeshBasicMaterial({
                color: 0xff00d4,
                side: THREE.DoubleSide,
                depthTest: false,
                depthWrite: false,
                transparent: true,
                opacity: 1,
                fog: false,
                toneMapped: false
            });
            debugMaterial.name = 'PhotorealSeamCapDebugMaterial';
            debugMaterial.userData.__photorealSeamCapMaterial = true;
            return debugMaterial;
        }
        const color = sourceMaterial && sourceMaterial.color
            ? sourceMaterial.color.clone()
            : new THREE.Color(CARVE_APRON_COLOR);
        const material = new THREE.MeshBasicMaterial({
            color: color,
            map: sourceMaterial && sourceMaterial.map ? sourceMaterial.map : null,
            side: THREE.DoubleSide,
            depthTest: true,
            depthWrite: true,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1
        });
        material.name = 'PhotorealSeamCapMaterial';
        material.userData.__photorealSeamCapMaterial = true;
        return material;
    }

    function sourceMaterialAt(mesh, materialIndex) {
        if (Array.isArray(mesh.material)) {
            return mesh.material[materialIndex] || mesh.material[0] || null;
        }
        return mesh.material || null;
    }

    function materialIndexAtOffset(groups, offset) {
        for (let i = 0; i < groups.length; i++) {
            const group = groups[i];
            if (offset >= group.start && offset < group.start + group.count) {
                return Number(group.materialIndex) || 0;
            }
        }
        return 0;
    }

    function interpolatedUv(uvAttribute, indices, barycentric) {
        if (!uvAttribute) return [0, 0];
        let u = 0;
        let v = 0;
        for (let i = 0; i < 3; i++) {
            u += uvAttribute.getX(indices[i]) * barycentric[i];
            v += uvAttribute.getY(indices[i]) * barycentric[i];
        }
        return [u, v];
    }

    function appendSeamQuad(bucket, hit, uvAttribute, indices, inverseWorld, scratch) {
        const start = hit.start.position;
        const end = hit.end.position;
        const startBottom = [start[0], start[1], start[2] - MESH_SEAM_CAP_DEPTH_M];
        const endBottom = [end[0], end[1], end[2] - MESH_SEAM_CAP_DEPTH_M];
        const toLocal = function (point) {
            scratch.set(point[0], point[1], point[2]).applyMatrix4(inverseWorld);
            return [scratch.x, scratch.y, scratch.z];
        };
        const topA = toLocal(start);
        const bottomA = toLocal(startBottom);
        const topB = toLocal(end);
        const bottomB = toLocal(endBottom);
        bucket.positions.push(
            topA[0], topA[1], topA[2], bottomA[0], bottomA[1], bottomA[2], bottomB[0], bottomB[1], bottomB[2],
            topA[0], topA[1], topA[2], bottomB[0], bottomB[1], bottomB[2], topB[0], topB[1], topB[2]
        );
        const uvA = interpolatedUv(uvAttribute, indices, hit.start.barycentric);
        const uvB = interpolatedUv(uvAttribute, indices, hit.end.barycentric);
        bucket.uvs.push(
            uvA[0], uvA[1], uvA[0], uvA[1], uvB[0], uvB[1],
            uvA[0], uvA[1], uvB[0], uvB[1], uvB[0], uvB[1]
        );
        bucket.segmentCount += 1;
    }

    function buildMeshSeamCaps(mesh) {
        const THREE = window.THREE;
        const seam = window.__photorealSeam;
        const geometry = mesh && mesh.geometry;
        const position = geometry && geometry.attributes && geometry.attributes.position;
        if (!THREE || !seam || !seamBoundaryGrid || !position
            || mesh.isSkinnedMesh || mesh.isInstancedMesh || mesh.isBatchedMesh) return [];

        if (!geometry.boundingBox) geometry.computeBoundingBox();
        if (!geometry.boundingBox) return [];
        const worldBox = geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
        const meshBounds = {
            minX: worldBox.min.x,
            minY: worldBox.min.y,
            maxX: worldBox.max.x,
            maxY: worldBox.max.y
        };
        if (!seam.boundsOverlap(seamBoundaryGrid.bounds, meshBounds)) return [];

        const index = geometry.index;
        const uv = geometry.attributes.uv || null;
        const elementCount = index ? index.count : position.count;
        const drawStart = Math.max(0, Number(geometry.drawRange && geometry.drawRange.start) || 0);
        const requestedCount = Number(geometry.drawRange && geometry.drawRange.count);
        const drawEnd = Math.min(elementCount,
            Number.isFinite(requestedCount) ? drawStart + requestedCount : elementCount);
        const groups = Array.isArray(geometry.groups) ? geometry.groups : [];
        const buckets = new Map();
        const matrixWorld = mesh.matrixWorld;
        const inverseWorld = matrixWorld.clone().invert();
        const va = new THREE.Vector3();
        const vb = new THREE.Vector3();
        const vc = new THREE.Vector3();
        const localScratch = new THREE.Vector3();
        const vertexIndex = function (offset) { return index ? index.getX(offset) : offset; };

        for (let offset = drawStart; offset + 2 < drawEnd; offset += 3) {
            const ia = vertexIndex(offset);
            const ib = vertexIndex(offset + 1);
            const ic = vertexIndex(offset + 2);
            va.fromBufferAttribute(position, ia).applyMatrix4(matrixWorld);
            vb.fromBufferAttribute(position, ib).applyMatrix4(matrixWorld);
            vc.fromBufferAttribute(position, ic).applyMatrix4(matrixWorld);
            const triangleBounds = {
                minX: Math.min(va.x, vb.x, vc.x),
                minY: Math.min(va.y, vb.y, vc.y),
                maxX: Math.max(va.x, vb.x, vc.x),
                maxY: Math.max(va.y, vb.y, vc.y)
            };
            const candidates = seam.querySegmentGrid(seamBoundaryGrid, triangleBounds);
            if (!candidates.length) continue;
            const triangle = [va.toArray(), vb.toArray(), vc.toArray()];
            const materialIndex = materialIndexAtOffset(groups, offset);
            let bucket = buckets.get(materialIndex);
            if (!bucket) {
                bucket = { positions: [], uvs: [], segmentCount: 0, materialIndex: materialIndex };
                buckets.set(materialIndex, bucket);
            }
            const indices = [ia, ib, ic];
            candidates.forEach(function (segment) {
                const hit = seam.intersectTriangleWithVerticalSegment(triangle, segment);
                if (hit) appendSeamQuad(bucket, hit, uv, indices, inverseWorld, localScratch);
            });
        }

        const caps = [];
        buckets.forEach(function (bucket) {
            if (!bucket.positions.length) return;
            const capGeometry = new THREE.BufferGeometry();
            capGeometry.setAttribute('position', new THREE.Float32BufferAttribute(bucket.positions, 3));
            capGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(bucket.uvs, 2));
            capGeometry.computeBoundingSphere();
            const cap = new THREE.Mesh(capGeometry, seamMaterialFor(sourceMaterialAt(mesh, bucket.materialIndex)));
            cap.name = 'PhotorealSeamCap';
            cap.userData.__photorealSeamCap = true;
            cap.userData.segmentCount = bucket.segmentCount;
            cap.frustumCulled = false;
            if (meshSeamDebugActive()) cap.renderOrder = 10000;
            mesh.add(cap);
            caps.push(cap);
        });
        return caps;
    }

    function buildTileSeamCaps(scene) {
        if (!scene || !internals || !seamBoundaryGrid || !meshSeamCapsActive()) return;
        disposeTileSeamCaps(scene);
        try { internals.scene.updateMatrixWorld(true); } catch (_) { }
        const sourceMeshes = [];
        scene.traverse(function (object) {
            if (object.isMesh && !object.userData.__photorealSeamCap) sourceMeshes.push(object);
        });
        const caps = [];
        sourceMeshes.forEach(function (mesh) {
            try { buildMeshSeamCaps(mesh).forEach(function (cap) { caps.push(cap); }); } catch (_) { }
        });
        const segmentCount = caps.reduce(function (sum, cap) {
            return sum + (Number(cap.userData.segmentCount) || 0);
        }, 0);
        tileSeamCaps.set(scene, { caps: caps, segmentCount: segmentCount });
        seamReadyScenes += 1;
        seamCapSegments += segmentCount;
    }

    function scheduleTileSeamCaps(scene) {
        if (!scene || !meshSeamCapsActive() || !seamBoundaryGrid) return;
        if (tileSeamCaps.has(scene)) return;
        const generation = seamGeneration;
        if (seamScheduled.get(scene) === generation) return;
        seamScheduled.set(scene, generation);
        const run = function () {
            if (seamScheduled.get(scene) !== generation) return;
            seamScheduled.delete(scene);
            if (generation !== seamGeneration || !loadedTileScenes.has(scene) || !active) return;
            buildTileSeamCaps(scene);
        };
        if (typeof window.requestIdleCallback === 'function') {
            window.requestIdleCallback(run, { timeout: 350 });
        } else {
            setTimeout(run, 0);
        }
    }

    function replaceSeamBoundaryGrid(segments) {
        clearAllTileSeamCaps();
        const seam = window.__photorealSeam;
        seamBoundaryGrid = meshSeamCapsActive() && seam && segments.length
            ? seam.buildSegmentGrid(segments, MESH_SEAM_GRID_CELL_M)
            : null;
        if (seamBoundaryGrid) loadedTileScenes.forEach(function (scene) {
            // Detached cached scenes do not inherit a later seating matrix until the renderer makes
            // them active again. Their visibility event schedules them with the then-current frame.
            if (scene.parent) scheduleTileSeamCaps(scene);
        });
    }

    // Raycast the SEATED tile mesh straight down at a scene-XY point; z is true metres, directly
    // comparable to our content's z. This deliberately returns the FIRST/top surface. Taking the
    // lowest hit in each column was rejected: overlapping coarse tiles and mesh undersides produced
    // false pits. buildTerrainGrid removes canopy/roofs spatially after all columns are sampled.
    function sampleTileSurfaceZ(x, y) {
        const THREE = window.THREE;
        if (!THREE || !tiles) return null;
        try {
            const raycaster = new THREE.Raycaster(new THREE.Vector3(x, y, 4000), new THREE.Vector3(0, 0, -1), 0, 9000);
            const hits = raycaster.intersectObject(tiles.group, true);
            return window.__photorealGround.selectTopSurfaceHeight(hits.map(function (hit) {
                return hit && hit.point ? hit.point.z : NaN;
            }), FAR_EARTH_LIMIT_M);
        } catch (_) { }
        return null;
    }

    function terrainBoundsForEntries(entries) {
        if (!internals) return null;
        const toXY = internals.latLngToXY;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        entries.forEach(function (entry) {
            polygonsOf(entry.geometry).forEach(function (rings) {
                (rings[0] || []).forEach(function (c) {
                    const xy = toXY(c[1], c[0]);
                    if (xy[0] < minX) minX = xy[0]; if (xy[0] > maxX) maxX = xy[0];
                    if (xy[1] < minY) minY = xy[1]; if (xy[1] > maxY) maxY = xy[1];
                });
            });
        });
        if (!isFinite(minX)) return null;
        const pad = CARVE_CORE_BUFFER_M + 6;
        return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
    }

    // Sample a coarse tile-height grid over the bbox of all carve footprints, ONCE. The tile mesh
    // has no BVH, so per-vertex raycasting every rebuild would hitch; the terrain doesn't move, so
    // one grid serves every wall. A later carve outside the cached extent triggers a larger rebuild.
    function buildTerrainGrid(entries, suppliedBounds) {
        if (!internals || !tiles) { terrainGrid = null; return; }
        // The seat shift was just applied — bake it into the world matrices before we raycast.
        try { internals.scene.updateMatrixWorld(true); } catch (_) { }
        const bounds = suppliedBounds || terrainBoundsForEntries(entries);
        if (!bounds) { terrainGrid = null; return; }
        const minX = bounds.minX, minY = bounds.minY, maxX = bounds.maxX, maxY = bounds.maxY;
        const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
        const nx = Math.max(2, Math.min(TERRAIN_GRID_MAX, Math.ceil(w / TERRAIN_GRID_MIN_CELL_M) + 1));
        const ny = Math.max(2, Math.min(TERRAIN_GRID_MAX, Math.ceil(h / TERRAIN_GRID_MIN_CELL_M) + 1));
        const rawZ = new Float32Array(nx * ny);
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const t = sampleTileSurfaceZ(minX + (w * i) / (nx - 1), minY + (h * j) / (ny - 1));
                rawZ[j * nx + i] = (t === null || !isFinite(t)) ? NaN : t;
            }
        }
        const z = window.__photorealGround.cleanGroundGrid(rawZ, nx, ny, {
            openingRadiusCells: TERRAIN_OPENING_RADIUS_CELLS,
            obstacleMinHeightM: TERRAIN_OBSTACLE_MIN_HEIGHT_M,
            gapFillPasses: TERRAIN_GAP_FILL_PASSES
        });
        terrainGrid = { minX: minX, minY: minY, dx: w / (nx - 1), dy: h / (ny - 1), nx: nx, ny: ny, z: z };
        updateGroundTexture();
    }

    // Upload the height grid as a single-channel float texture the keep-veg shader samples for the
    // local ground height (nearest filtering — no float-linear extension needed). Missing samples
    // (NaN) fall back to 0 so a park over unstreamed tiles still discards its lawn near z≈0.
    function updateGroundTexture() {
        const THREE = window.THREE;
        const g = terrainGrid;
        if (!THREE || !g) return;
        if (groundTexture) { try { groundTexture.dispose(); } catch (_) { } groundTexture = null; }
        const data = new Float32Array(g.nx * g.ny);
        for (let i = 0; i < data.length; i++) data[i] = isFinite(g.z[i]) ? g.z[i] : 0;
        const tex = new THREE.DataTexture(data, g.nx, g.ny, THREE.RedFormat, THREE.FloatType);
        tex.minFilter = THREE.NearestFilter;
        tex.magFilter = THREE.NearestFilter;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.needsUpdate = true;
        groundTexture = tex;
        corridorUniforms.uGroundTex.value = tex;
        if (corridorUniforms.uGroundMin.value) corridorUniforms.uGroundMin.value.set(g.minX, g.minY);
        if (corridorUniforms.uGroundInvSpan.value) {
            corridorUniforms.uGroundInvSpan.value.set(1 / ((g.nx - 1) * g.dx), 1 / ((g.ny - 1) * g.dy));
        }
    }

    // Bilinear tile height at a scene-XY point from the cached grid; null if outside it or if every
    // surrounding sample missed the mesh. Partial NoData weights are renormalised by the helper.
    function terrainZAt(x, y) {
        return window.__photorealGround.sampleBilinear(terrainGrid, x, y);
    }

    // A terrain-conforming earth wall around one ring: at each vertex the wall spans from the
    // content down/up to the local tile height, so it meets the Google rim whether the ground sits
    // above the plan (uphill: wall rises to it) or below it (downhill: wall drops to it).
    function addCurtainRibbon(ringXY, group) {
        const THREE = window.THREE;
        const n = ringXY.length;
        if (n < 2) return;
        const topBot = function (x, y) {
            let t = terrainZAt(x, y);
            if (t === null || !isFinite(t)) {                 // no sample -> degrade to the fixed skirt
                return [CURTAIN_CONTENT_TOP_Z + CURTAIN_TOP_MARGIN_M, -CARVE_PLINTH_DEPTH_M];
            }
            t = Math.max(-CURTAIN_MAX_DIP_M, Math.min(CURTAIN_MAX_RISE_M, t));
            return [Math.max(CURTAIN_CONTENT_TOP_Z, t) + CURTAIN_TOP_MARGIN_M, Math.min(0, t) - CURTAIN_BOTTOM_MARGIN_M];
        };
        const pos = [];
        let prev = null;
        for (let i = 0; i < n; i++) {
            const x = ringXY[i][0], y = ringXY[i][1];
            const tb = topBot(x, y);
            const cur = { x: x, y: y, top: tb[0], bot: tb[1] };
            if (prev) {
                pos.push(prev.x, prev.y, prev.top, prev.x, prev.y, prev.bot, cur.x, cur.y, cur.bot);
                pos.push(prev.x, prev.y, prev.top, cur.x, cur.y, cur.bot, cur.x, cur.y, cur.top);
            }
            prev = cur;
        }
        if (!pos.length) return;
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        group.add(new THREE.Mesh(geom, apronMaterial));
    }

    // Carve footprints (lat/lng GeoJSON) → the cut mask (drives the tile-discard shader) plus the
    // seal in the SCENE: a flat earth cap (top-down + razed pad) and a terrain-conforming curtain
    // around every ring (see the curtain comment above).
    function buildMaskShapes() {
        const THREE = window.THREE;
        if (!THREE || !maskScene || !internals) return;
        disposeMaskShapes();
        maskShapesGroup = new THREE.Group();
        apronGroup = new THREE.Group();
        apronGroup.name = 'PhotorealCarvePlinth';
        const toXY = internals.latLngToXY;
        const entries = collectCarveGeometries();
        const seamSegments = [];
        // Terrain sampling must never break the seal: a failure just leaves the grid null, and the
        // curtain falls back to the fixed skirt (old plinth behaviour).
        const terrainBounds = terrainBoundsForEntries(entries);
        if (terrainBounds && (!terrainGrid
            || !window.__photorealGround.coversBounds(terrainGrid, terrainBounds))) {
            try { buildTerrainGrid(entries, terrainBounds); } catch (_) { terrainGrid = null; }
        }
        entries.forEach(function (entry) {
            try {
                const buf = (typeof entry.buffer === 'number') ? entry.buffer : CARVE_CORE_BUFFER_M;
                const core = buf > 0 ? bufferGeometry(entry.geometry, buf) : entry.geometry;
                const keepVeg = (entry.mode === 'keepveg');
                const maskMat = keepVeg ? maskMaterialPark : maskMaterial;
                polygonShapesAndRings(core, toXY).forEach(function (sr) {
                    if (!keepVeg && meshSeamCapsActive()) {
                        sr.rings.forEach(function (ring) { appendSeamRingSegments(ring, seamSegments); });
                    }
                    const mask = new THREE.Mesh(new THREE.ShapeGeometry(sr.shape), maskMat);
                    mask.frustumCulled = false;
                    // No depth buffer on the mask RT, so draw order decides overlaps: full discard
                    // (renderOrder 1) paints over keep-veg (0), so a road through a park still clears.
                    mask.renderOrder = keepVeg ? 0 : 1;
                    maskShapesGroup.add(mask);
                    const cap = new THREE.Mesh(new THREE.ShapeGeometry(sr.shape), apronMaterial);
                    cap.position.z = CARVE_APRON_TOP_Z;
                    cap.frustumCulled = false;
                    apronGroup.add(cap);
                    sr.rings.forEach(function (ring) { addCurtainRibbon(ring, apronGroup); });
                });
            } catch (_) { /* one carve entry must not cost the rest their seal, nor block the reveal */ }
        });
        maskScene.add(maskShapesGroup);
        internals.scene.add(apronGroup);
        replaceSeamBoundaryGrid(seamSegments);
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
        // Deliberately NOT forcing FrontSide (the sim did, and covered its cuts with walls):
        // the tiles ship double-sided, and that is load-bearing here — with backfaces culled,
        // any hole lets a grazing sightline travel inside the hollow shell and out to the sky.
        // Double-sided, the worst a cut can show is mirrored terrain texture.
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
                    + 'uniform float uFloorZ;\n'
                    + 'uniform sampler2D uGroundTex;\n'
                    + 'uniform vec2 uGroundMin;\n'
                    + 'uniform vec2 uGroundInvSpan;\n'
                    + 'uniform float uKeepBand;')
                .replace('void main() {', 'void main() {\n'
                    + 'if (uCorridorOn > 0.5) {\n'
                    + '    vec2 cuv = (vCorridorWorld.xy - uCorridorMin) * uCorridorScale;\n'
                    + '    if (cuv.x > 0.0 && cuv.x < 1.0 && cuv.y > 0.0 && cuv.y < 1.0) {\n'
                    // Threshold 0.3, not 0.5: linear filtering leaves boundary texels partial, and a
                    // mid threshold turned them into per-texel combs along facades. Red wins ties.
                    + '        vec4 cmask = texture2D(uCorridorMask, cuv);\n'
                    // RED = full discard (roads, razed & proposed buildings): everything above the floor.
                    + '        if (cmask.r > 0.3) {\n'
                    + '            if (vCorridorWorld.z > uFloorZ) discard;\n'
                    // GREEN = keep-vegetation (parks): discard ONLY the tile ground layer — below the
                    // local ground height + band — so hedges and trees stand instead of being sliced.
                    + '        } else if (cmask.g > 0.3) {\n'
                    + '            vec2 guv = (vCorridorWorld.xy - uGroundMin) * uGroundInvSpan;\n'
                    + '            float gh = uFloorZ;\n'
                    + '            if (guv.x >= 0.0 && guv.x <= 1.0 && guv.y >= 0.0 && guv.y <= 1.0) gh = texture2D(uGroundTex, guv).r;\n'
                    + '            if (vCorridorWorld.z < gh + uKeepBand) discard;\n'
                    + '        }\n'
                    + '    }\n'
                    + '}\n');
        };
        material.needsUpdate = true;
    }

    function onTileModelLoad(ev) {
        if (!ev || !ev.scene) return;
        loadedTileScenes.add(ev.scene);
        ev.scene.traverse(function (o) {
            if (!o.isMesh || !o.material) return;
            if (Array.isArray(o.material)) o.material.forEach(patchTileMaterial);
            else patchTileMaterial(o.material);
        });
        if (grounded && ev.scene.parent) scheduleTileSeamCaps(ev.scene);
    }

    function onTileModelDispose(ev) {
        if (!ev || !ev.scene) return;
        disposeTileSeamCaps(ev.scene);
        loadedTileScenes.delete(ev.scene);
        seamScheduled.delete(ev.scene);
    }

    function onTileVisibilityChange(ev) {
        if (!ev || !ev.visible || !ev.scene || !grounded) return;
        scheduleTileSeamCaps(ev.scene);
    }

    function disposeMask() {
        disposeMaskShapes();
        if (maskRT) { try { maskRT.dispose(); } catch (_) { } }
        maskRT = null;
        maskScene = null;
        maskCamera = null;
        maskMaterial = null;
        maskMaterialPark = null;
        apronMaterial = null;
        terrainGrid = null;
        replaceSeamBoundaryGrid([]);
        if (groundTexture) { try { groundTexture.dispose(); } catch (_) { } groundTexture = null; }
        corridorUniforms.uGroundTex.value = null;
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
        // Vicinity-only rendering: cap how far the frustum reaches while the mesh is up — but
        // NEVER below the orbit distance itself. A URL entry framing a whole plan sits ~3 km
        // out; clamping under that culled the entire world (and, because tiles outside the
        // frustum are never streamed, the seating raycast had nothing to hit): solid sky.
        const target = internals.controls && internals.controls.target;
        const orbitDist = target ? camera.position.distanceTo(target) : 0;
        const farClamp = Math.max(FAR_CLAMP_TRUE_M * mercatorK, orbitDist * 2.5);
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
        if (seatDebugActive()) {
            seatDebugAccumS += dtS;
            if (seatDebugAccumS >= 0.5) {
                seatDebugAccumS = 0;
                let surface0 = null; try { surface0 = sampleTileSurfaceZ(0, 0); } catch (_) { }
                let terrain0 = null; try { terrain0 = terrainZAt(0, 0); } catch (_) { }
                if (!seatDebugEl) {
                    // Fixed to the viewport (not the container) and above the 2D/3D buttons — the
                    // status toast at top-12px is hidden behind the controls panel on mobile.
                    seatDebugEl = document.createElement('div');
                    seatDebugEl.style.cssText = 'position:fixed;left:50%;bottom:96px;transform:translateX(-50%);'
                        + 'z-index:100000;background:rgba(20,22,28,0.94);color:#fff;'
                        + 'font:600 12px/1.35 ui-monospace,monospace;padding:7px 11px;border-radius:8px;'
                        + 'pointer-events:auto;cursor:copy;max-width:94vw;text-align:center;';
                    const copyHint = photorealI18n('common.copyToClipboard', 'Copy to clipboard');
                    seatDebugEl.tabIndex = 0;
                    seatDebugEl.setAttribute('role', 'button');
                    seatDebugEl.setAttribute('aria-label', copyHint);
                    seatDebugEl.title = copyHint;
                    const copySeatDiagnostic = function () {
                        if (typeof window.copyTextWithFeedback === 'function') {
                            window.copyTextWithFeedback(seatDebugEl.textContent);
                        }
                    };
                    seatDebugEl.addEventListener('click', copySeatDiagnostic);
                    seatDebugEl.addEventListener('keydown', function (event) {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        copySeatDiagnostic();
                    });
                    document.body.appendChild(seatDebugEl);
                }
                seatDebugEl.textContent = 'seat grounded=' + grounded
                    + ' seatZ=' + (seatNode ? seatNode.position.z.toFixed(1) : '—')
                    + ' surface@0=' + (surface0 == null ? 'miss' : surface0.toFixed(1))
                    + ' terrain@0=' + (terrain0 == null ? 'miss' : terrain0.toFixed(1))
                    + ' lock=' + (lockedGroundZ == null ? '—' : lockedGroundZ.toFixed(1))
                    + (lastProbeSummary ? ' probes(min/p25/med/max)='
                        + [lastProbeSummary.min, lastProbeSummary.p25, lastProbeSummary.median, lastProbeSummary.max]
                            .map(function (v) { return v.toFixed(1); }).join('/') : '')
                    + ' seam=' + (meshSeamCapsActive()
                        ? meshSeamMode() + '(scenes=' + seamReadyScenes + ',caps=' + seamCapSegments + ')'
                        : 'off')
                    + ' tiles=' + (tiles.group ? tiles.group.children.length : 0)
                    + ' lp=' + (Number.isFinite(prog) ? prog.toFixed(2) : '—');
            }
        }
        if (profT && Number.isFinite(prog)) {
            if (!profT.firstTile && prog < 1) profT.firstTile = performance.now();
            if (profT.firstTile && !profT.streamed && prog >= 0.95) profT.streamed = performance.now();
        }
        // No-coverage watchdog: if no tile CONTENT ever arrives, say so and fall back to
        // abstract 3D. loadProgress alone lies here — a rate-limited session reports 1
        // ("nothing queued") while the group stays empty forever.
        if (!grounded) {
            const noContent = !Number.isFinite(prog) || prog === 0
                || (prog >= 1 && tiles.group && tiles.group.children.length === 0);
            sinceAnyLoadS = noContent ? sinceAnyLoadS + dtS : -Infinity;
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
        if (grounded && coverEl) hideCover(); // composed scene is up — drop the loading cover
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
    async function activate(options) {
        if (active) return;
        // Direct calls (URL-driven entry) can arrive before 3D mode is up — route through
        // the same enter-3D-first path the globe button takes, then re-enter here. Only when
        // that path actually exists: if three-mode failed to load, bouncing to goRealistic()
        // would recurse right back here forever.
        if (!(typeof window.isThreeModeActive === 'function' && window.isThreeModeActive())) {
            if (typeof window.enterThreeMode === 'function') { goRealistic(); return; }
            console.error('[photoreal] 3D mode is unavailable (three-mode failed to load)');
            setStatus('Failed to start 3D mode.');
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
            if (!window.__photorealGround) throw new Error('photoreal-ground helper missing');
            if (meshSeamCapsActive() && !window.__photorealSeam) throw new Error('photoreal-seam helper missing');
            mercatorK = frame.mercatorScaleFactor(anchor.lat);

            // URL-driven entry (frameProposal): hide the abstract 3D behind a loading cover until
            // the composed scene is ready. Skip it when reusing an already-seated session (instant).
            if (options && options.frameProposal && !grounded) showCover();

            // Reuse the streamed session when re-entering at the same anchor. Google's tile
            // URLs carry a per-session token, so a dispose-and-rebuild both defeats the HTTP
            // cache AND mints a new (quota-counted) session — toggling 3D<->realistic used to
            // re-download the whole neighbourhood every time.
            const anchorKey = anchor.lat.toFixed(6) + ',' + anchor.lng.toFixed(6);
            if (tiles && scaleNode && tilesAnchorKey === anchorKey) {
                internals.scene.add(scaleNode);
                if (tilesCamera && tilesCamera !== internals.camera) {
                    try { tiles.deleteCamera(tilesCamera); } catch (_) { }
                }
                tiles.setCamera(internals.camera);
                tiles.setResolutionFromRenderer(internals.camera, internals.renderer);
                tilesCamera = internals.camera;
                savedBackground = internals.scene.background;
                hadSavedBackground = true;
                internals.scene.background = new window.THREE.Color(0x87ceeb);
                ensureMaskObjects();
                buildMaskShapes();
                renderCarveMask(0, 0);
                if (grounded) {
                    if (typeof window.setRealisticLayerActive === 'function') window.setRealisticLayerActive(true);
                    tiles.group.visible = builtVisible;
                }
                lastFrameNow = 0;
                sinceAnyLoadS = 0;
                if (typeof window.registerThreeModeFrameHook === 'function') {
                    window.registerThreeModeFrameHook(onFrame);
                }
                active = true;
                console.log('[photoreal] reusing streamed tile session (anchor unchanged)');
                return;
            }
            if (tiles) hardDisposeTiles(); // anchor changed — a fresh session is genuinely needed

            profT = { t0: performance.now() };
            await loadTilesLib();
            profT.lib = performance.now();
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
            tiles.addEventListener('dispose-model', onTileModelDispose);
            tiles.addEventListener('tile-visibility-change', onTileVisibilityChange);

            // Performance, straight from the sim: coarser error target (tunable via ?prq=<n>,
            // higher = lighter/blurrier), capped caches and queues so parsing never hitches.
            const prq = Number(new URLSearchParams(window.location.search || '').get('prq'));
            tiles.errorTarget = (Number.isFinite(prq) && prq > 0) ? prq : 24;
            if (tiles.lruCache) { tiles.lruCache.minSize = 300; tiles.lruCache.maxSize = 500; }
            if (tiles.parseQueue) tiles.parseQueue.maxJobs = 2;
            if (tiles.downloadQueue) tiles.downloadQueue.maxJobs = 6;

            tiles.setCamera(internals.camera);
            tiles.setResolutionFromRenderer(internals.camera, internals.renderer);
            tilesCamera = internals.camera;
            tilesAnchorKey = anchorKey;
            profT.setup = performance.now();

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
            lockedGroundZ = null;
            lastProbeSummary = null;
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
        hideCover(); // never let the loading cover outlive the mode (e.g. no-coverage fallback)
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
        // The tiles renderer, its node chain, seating and streamed cache SURVIVE deactivation:
        // re-entering at the same anchor re-attaches them instantly instead of minting a new
        // Google session and re-downloading the neighbourhood. hardDisposeTiles() drops them
        // when the anchor actually changes.
        internals = null;
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

    function hardDisposeTiles() {
        clearAllTileSeamCaps();
        loadedTileScenes.clear();
        seamBoundaryGrid = null;
        if (tiles) {
            try { tiles.removeEventListener('load-model', onTileModelLoad); } catch (_) { }
            try { tiles.removeEventListener('dispose-model', onTileModelDispose); } catch (_) { }
            try { tiles.removeEventListener('tile-visibility-change', onTileVisibilityChange); } catch (_) { }
            try { tiles.dispose(); } catch (_) { }
        }
        tiles = null;
        scaleNode = seatNode = frameNode = null;
        tilesCamera = null;
        tilesAnchorKey = null;
        grounded = false;
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
        if (typeof window.enterThreeMode !== 'function') {
            console.error('[photoreal] 3D mode is unavailable (three-mode failed to load)');
            setStatus('Failed to start 3D mode.');
            return;
        }
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

    // Isolation hides other proposals' surfaces; lift their carve holes with them.
    window.addEventListener('threeModeIsolationChanged', function (ev) {
        const d = (ev && ev.detail) || {};
        isolationFilter = d.proposalId ? String(d.proposalId) : (d.parcelId ? '__parcel__' : null);
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
