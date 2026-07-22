// Three.js 3D Map Mode Overlay for Leaflet map
// - Renders parcels and roads as flat geometry
// - Renders buildings as extruded volumes (default 10m if unknown)
// - Provides tilt-in animation and OrbitControls

(function () {
    if (typeof THREE === 'undefined') {
        console.warn('[3D] THREE.js not available. Skipping 3D mode initialization.');
        return;
    }
    const meshSanitize = (typeof window !== 'undefined') ? window.__threeMeshSanitize : null;
    if (!meshSanitize) {
        console.error('[3D] City-model mesh sanitizer is unavailable. Skipping 3D mode initialization.');
        return;
    }
    const screenDoor = (typeof window !== 'undefined') ? window.__threeScreenDoor : null;
    if (!screenDoor) {
        console.error('[3D] Stable building transparency is unavailable. Skipping 3D mode initialization.');
        return;
    }
    const smoothTransparency = (typeof window !== 'undefined') ? window.__threeSmoothTransparency : null;
    if (!smoothTransparency) {
        console.error('[3D] Smooth building transparency is unavailable. Skipping 3D mode initialization.');
        return;
    }
    const buildingDisplayPolicy = (typeof window !== 'undefined') ? window.__threeBuildingDisplay : null;
    if (!buildingDisplayPolicy
        || typeof buildingDisplayPolicy.displayStatesForKind !== 'function'
        || typeof buildingDisplayPolicy.resolveBuiltDisplayPolicy !== 'function'
        || typeof buildingDisplayPolicy.resolveBuildingRenderParts !== 'function') {
        console.error('[3D] Building display policy is unavailable. Skipping 3D mode initialization.');
        return;
    }
    const structureRefresh = (typeof window !== 'undefined') ? window.__threeStructureRefresh : null;
    if (!structureRefresh
        || typeof structureRefresh.refreshStructureScene3D !== 'function'
        || typeof structureRefresh.applyStructureDisplayMode !== 'function') {
        console.error('[3D] Live structure refresh is unavailable. Skipping 3D mode initialization.');
        return;
    }
    const squarePaving = (typeof window !== 'undefined') ? window.__threeSquarePaving : null;
    if (!squarePaving || typeof squarePaving.createSquarePavingTexture !== 'function') {
        console.error('[3D] Square paving renderer is unavailable. Skipping 3D mode initialization.');
        return;
    }
    const snapshotNavigation = (typeof window !== 'undefined') ? window.__threeSnapshotNavigation : null;
    if (!snapshotNavigation
        || typeof snapshotNavigation.configurePannableOrbitControls !== 'function'
        || typeof snapshotNavigation.resolveExitMapCenter !== 'function') {
        console.error('[3D] Snapshot navigation policy is unavailable. Skipping 3D mode initialization.');
        return;
    }
    const keyboardContext = (typeof window !== 'undefined') ? window.__threeKeyboardContext : null;
    if (!keyboardContext || typeof keyboardContext.classifyThreeModeKeydown !== 'function') {
        console.error('[3D] Keyboard context policy is unavailable. Skipping 3D mode initialization.');
        return;
    }

    // Smooth is the production candidate. `?ghostStyle=grain` retains the already-proven
    // screen-door renderer as an A/B fallback without maintaining a separate code path.
    let BUILDING_GHOST_STYLE = 'smooth';
    try {
        if (new URLSearchParams(window.location.search).get('ghostStyle') === 'grain') {
            BUILDING_GHOST_STYLE = 'grain';
        }
    } catch (_) { }
    window.__threeBuildingGhostStyle = BUILDING_GHOST_STYLE;

    // Internal state
    let isActive = false;
    let scene = null;
    let camera = null;
    let renderer = null;
    let controls = null;
    // External per-frame hooks (the photoreal tile layer registers here): run after controls
    // and near/far updates, immediately before render, only while the 3D loop is running.
    const frameHooks = [];
    let frameId = null;
    let origin3857 = null; // Leaflet EPSG:3857 origin for local XY
    let sceneLoadGeometry = null; // frozen at 3D entry; panning never moves the backend query
    let sceneLoadGeometrySource = 'camera';
    let sceneTreeLoadGeometry = null; // preserves the existing tree query scope, but freezes its anchor
    let sceneTreeLoadGeometrySource = 'camera';
    let focusProposalIds = null; // Set of proposalIds to frame on 3D entry (shared-link focus), or null for all
    let renderingOverlayEl = null; // transient overlay while 3D initializes
    let isTransitioning3D = false; // avoid double-activation
    let buildingsLoaderEl = null; // in-view "loading buildings" badge
    let pendingModelLoads = 0; // count of uploaded glTF models still downloading

    // URL-driven entry: optionally start a gentle camera rotation until the user interacts.
    const INTRO_AUTO_ROTATE_SPEED = 0.7; // OrbitControls: ~86s per revolution (1.0 ≈ 60s)
    const INTRO_MANUAL_AUTO_ROTATE_RAD_PER_SEC = 0.18; // fallback if OrbitControls is missing
    // (No parse-time THREE usage in this file: the global arrives from the deferred ESM
    // bootstrap, so THREE may only be touched once the user actually enters a 3D flow.)
    let pendingIntroAutoRotate = false;
    let introAutoRotateCleanup = null;
    let suppressClickAfterRotateStop = false; // the click that stops the intro spin must not select
    let manualAutoRotateActive = false;
    let manualAutoRotateLastTs = 0;

    // Groups for layers
    let flatGroup = null; // existing parcels + existing roads (always part of "built")
    let corridorGroup = null; // applied corridor cross-sections — kept visible in realistic mode
    // Realistic mode gets a separately-built ruled road group. Keeping the abstract group untouched
    // makes leaving photoreal an exact restoration instead of a lossy reverse vertex mutation.
    let terrainCorridorGroup = null;
    let corridorTerrainProfiles = [];
    let corridorTerrainCutPatches = [];
    let corridorTerrainCommittedKeys = new Set(); // corridor keys the currently-committed build covers
    let corridorTerrainSampler = null;
    let corridorTerrainReferenceGeneration = 0;
    let corridorTerrainReferences = new Map();
    const corridorDguProfileCache = new Map();
    let realisticLayerActive = false; // photoreal mesh is the built world; abstract built layers hide
    let plannedFlatGroup = null; // park/square/lake grounds, paths, ponds, water, etc.
    let buildingGroup = null; // buildings extrusion
    let parkGroup = null; // park decorations (trees)
    let squareGroup = null; // square decorations (fountains, stalls)
    let lakeGroup = null; // lake decorations (fish)
    let stationGroup = null; // placeable bus/tram/underground/elevated station models
    let existingTransitAlignmentGroup = null; // immutable tram/heavy-rail snapshot (city-gated)
    let treesGroup = null; // real-world OSM trees (Overture base/land), toggleable scenery
    let proposalInteractionGroup = null; // selectable applied/unapplied proposal surfaces
    let proposalDraftGroup = null; // source-vs-draft comparison overlay; never mutates proposal state
    let latestProposalDraftPreviewDetail = null;
    let treesEnabled = true; // user toggle (default ON); real value loaded from storage on 3D init

    // Checkbox listeners to sync 3D buildings with sidebar
    let onShowExistingBuildingsChange = null;
    let onShowProposedBuildingsChange = null;

    const threeContainer = document.getElementById('three-container');
    const toggleBtn = document.getElementById('mode-3d-toggle');
    const toggle2dBtn = document.getElementById('mode-2d-toggle');
    const walkBtn = document.getElementById('mode-walk-toggle');

    // Sync the always-visible 2D / 3D / realistic-globe mode buttons so exactly one reads
    // as "pressed" (.active): 2D when neither 3D nor realistic is on, 3D for abstract 3D,
    // realistic when the photoreal globe is up. Called on every mode transition (here and
    // from photoreal-mode.js). Exposed globally so photoreal can reuse it.
    function updateModeButtonStates() {
        try {
            const rw = !!(window.PhotorealMode && typeof window.PhotorealMode.isActive === 'function' && window.PhotorealMode.isActive());
            // Loading spinners on the lower-left mode icons: photo (globe) while its tiles compose,
            // model (3D) while its scene renders. Photo entry passes through 3D init, so photo-loading
            // wins there — only the globe spins, never both.
            const photoLoading = !!(window.PhotorealMode && typeof window.PhotorealMode.isLoading === 'function' && window.PhotorealMode.isLoading());
            const modelLoading = !!renderingOverlayEl && !photoLoading;
            const btn2d = document.getElementById('mode-2d-toggle');
            const btn3d = document.getElementById('mode-3d-toggle');
            const btnRw = document.getElementById('mode-realistic-toggle');
            if (btn2d) btn2d.classList.toggle('active', !isActive);
            if (btn3d) { btn3d.classList.toggle('active', isActive && !rw); btn3d.classList.toggle('mode-btn-loading', modelLoading); }
            if (btnRw) { btnRw.classList.toggle('active', rw); btnRw.classList.toggle('mode-btn-loading', photoLoading); }
        } catch (_) { }
    }
    window.updateModeButtonStates = updateModeButtonStates;

    // Walk-mode launcher state. Target is a per-city 3D walk overlay configured via
    // city-config `walk.url` (Zagreb points at the transit planner at zagreb.lol/prijevoz/
    // with `?st3d=walk`, per zagreb-isochrone-main station-3d/modes/cab.js buildWalkShareUrl).
    // Cities without a `walk.url` hide the button entirely — it is NOT generally available yet.
    function getWalkUrlBase() {
        try {
            const cfg = window.CityConfigManager;
            const walk = cfg && typeof cfg.getWalkConfig === 'function' ? cfg.getWalkConfig() : null;
            return walk && walk.url ? walk.url : null;
        } catch (_) { return null; }
    }
    let walkPickActive = false;
    let walkPickClickHandler = null;

    const BUILDING_OPACITY_KEY = 'cbBuildingOpacity';

    function buildingOpacityOf(material) {
        const opacity = Number(material?.userData?.[BUILDING_OPACITY_KEY]);
        return Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1;
    }

    function configureBuildingMaterial(material, opacity = 1) {
        const numericOpacity = Number(opacity);
        const normalizedOpacity = Number.isFinite(numericOpacity)
            ? Math.min(1, Math.max(0, numericOpacity))
            : 1;
        material.userData = material.userData || {};
        material.userData[BUILDING_OPACITY_KEY] = normalizedOpacity;

        if (normalizedOpacity < 1 && BUILDING_GHOST_STYLE === 'grain') {
            return screenDoor.configureMaterial(material, {
                coverage: normalizedOpacity,
                depthFunc: THREE.LessDepth
            });
        }
        if (normalizedOpacity < 1) {
            return smoothTransparency.configureColorMaterial(material, {
                opacity: normalizedOpacity,
                equalDepth: THREE.EqualDepth,
                lessDepth: THREE.LessDepth,
                notEqualStencilFunc: THREE.NotEqualStencilFunc,
                keepStencilOp: THREE.KeepStencilOp,
                replaceStencilOp: THREE.ReplaceStencilOp
            });
        }

        material.transparent = false;
        material.opacity = 1;
        material.colorWrite = true;
        material.depthTest = true;
        material.depthWrite = true;
        material.depthFunc = THREE.LessDepth;
        material.stencilWrite = false;
        if ('alphaToCoverage' in material) material.alphaToCoverage = false;
        material.needsUpdate = true;
        return material;
    }

    function makeBuildingMaterial(parameters, opacity = 1) {
        const material = new THREE.MeshPhongMaterial({
            ...parameters,
            depthFunc: THREE.LessDepth,
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1
        });
        return configureBuildingMaterial(material, opacity);
    }

    // Three.js Material.clone() does not copy custom compile hooks. Reapply the selected ghost
    // renderer whenever a material is cloned for a city face, parcel slice, or uploaded model.
    function cloneBuildingMaterial(material) {
        const cloned = material.clone();
        return configureBuildingMaterial(cloned, buildingOpacityOf(material));
    }

    function attachBuildingDepthPrepass(mesh) {
        if (BUILDING_GHOST_STYLE !== 'smooth' || !mesh) return null;
        return smoothTransparency.attachDepthPrepass(mesh, {
            lessDepth: THREE.LessDepth,
            createMesh: (geometry, material) => new THREE.Mesh(geometry, material)
        });
    }

    // Basic materials
    // - solid: opaque gray, used for the "emphasized" buildings in the current mode.
    // - ghost: smooth 50% alpha over the one nearest facade selected by an invisible depth pass.
    //   The optional grain renderer remains available via `?ghostStyle=grain` for comparison.
    const buildingMaterials = {
        solid: makeBuildingMaterial({ color: 0x9aa4ad, specular: 0x333333, shininess: 20 }),
        ghost: makeBuildingMaterial({ color: 0x6b7682, specular: 0x333333, shininess: 20 }, 0.5),
        // Buildings an applied proposal demolishes stay reddish in inclusive Built modes; Removed
        // also uses the solid variant so the isolated demolition footprint reads clearly.
        demolishedSolid: makeBuildingMaterial({ color: 0xa2645a, specular: 0x333333, shininess: 12 }),
        demolishedGhost: makeBuildingMaterial({ color: 0xa2645a, specular: 0x333333, shininess: 12 }, 0.3)
    };

    function demolishedMaterialFor(buildingMaterial) {
        return buildingOpacityOf(buildingMaterial) < 1
            ? buildingMaterials.demolishedGhost
            : buildingMaterials.demolishedSolid;
    }

    const materials = {
        parcels: new THREE.MeshLambertMaterial({ color: 0xdddddd, emissive: 0x000000 }),
        parcelEdges: new THREE.LineBasicMaterial({ color: 0x999999, linewidth: 1, depthTest: false, depthWrite: false }),
        roads: new THREE.MeshLambertMaterial({ color: 0xb0b0b0, emissive: 0x000000 }),
        roadLines: new THREE.LineBasicMaterial({ color: 0x666666, linewidth: 1, depthTest: false, depthWrite: false }),
        sliceEdges: new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 1 })
    };

    // Building display: both families support solid / transparent / off. Built additionally offers
    // complementary Surviving and Removed views from the exact stored carve halves. Defaults make
    // the proposal pop against a translucent context.
    let builtDisplay = 'ghost';
    let plannedDisplay = 'solid';
    let buildingModeControlsEl = null;
    let displayStateSelects = { built: null, planned: null };
    let decorTogglesEl = null; // container for per-layer scenery toggles, populated from /decor/layers

    // Parcel isolation: clicking a parcel hides everything but that parcel and the
    // building(s) sitting on it. null = not isolated (full scene).
    let isolatedParcelId = null;
    // Proposal isolation: showing a whole proposal (all its parcels + their buildings) at once,
    // reached via the [show] button in the parcel panel. null = not isolating a proposal.
    let isolatedProposalId = null;
    let isolationResetEl = null;
    let parcelInfoPanelEl = null;
    // Floor areas of the currently-shown parcel, kept so the price slider can recompute the
    // value gain without re-running the (price-independent) volume maths on every tick.
    let lastFloorAreas = null;
    // Parcel count behind the currently-shown panel (proposal panel only; null for single parcel),
    // so the price slider can recompute the average gain/loss per parcel live.
    let lastParcelCount = null;

    // Assumptions for the parcel value panel. GFA (floor area) is derived from built/proposed
    // volume by dividing out a typical storey height; value uses a €/m² rate the user can slide.
    const FLOOR_HEIGHT_M = 3.5;        // "reasonably high" storey height for GFA estimation
    let priceEurPerM2 = 4000;          // €/m² of floor area; adjustable via the panel slider
    const PRICE_MIN_EUR = 2000;
    const PRICE_MAX_EUR = 10000;
    const PRICE_STEP_EUR = 100;
    let parcelClickHandler = null;
    let parcelPointerDownHandler = null;
    let proposalSelectionUnsubscribe = null;
    // Pointer-down position, used to tell a short click apart from an orbit/tilt drag.
    let clickDownXY = null;

    // Scale factor to control how close the camera is vs top-down fit distance.
    // 1.0 means the 3D camera sits at the natural distance to fit the current
    // 2D map viewport — i.e. switching to 3D preserves the user's 2D altitude
    // and just adds tilt, instead of reframing to a different scale.
    const CAMERA_DISTANCE_SCALE = 1.0;

    function updateDisplayStateControls() {
        try {
            ['built', 'planned'].forEach((kind) => {
                const current = kind === 'built' ? builtDisplay : plannedDisplay;
                const select = displayStateSelects[kind];
                if (!select) return;
                select.value = current;
                const selectedOption = select.options && select.options[select.selectedIndex];
                select.title = selectedOption?.dataset?.tooltip || selectedOption?.textContent || '';
            });
        } catch (_) { }
    }

    // With planned proposals off, the cadastre shows its pre-proposal state (proposal-created
    // parcels hidden); any other combination shows the full fabric.
    function derivedParcelVisibilityMode() {
        return plannedDisplay === 'off' ? 'built' : 'both';
    }

    // Apply the visibility implied by the current display states (no isolation).
    function applyModeVisibility() {
        // Planned structures use ordinary scoped alpha materials (rather than the city-building
        // depth/stencil ghost renderer): they are simple non-coincident surfaces and decorations.
        // Transparent mode disables depth writes so a ghost park/square/lake cannot invisibly
        // occlude another proposal behind it.
        structureRefresh.applyStructureDisplayMode(
            [plannedFlatGroup, parkGroup, squareGroup, lakeGroup, stationGroup],
            plannedDisplay,
            { ghostOpacity: 0.38 }
        );
        applyParcelVisibilityForMode(derivedParcelVisibilityMode());
    }

    function setBuildingDisplay(kind, state) {
        if (!buildingDisplayPolicy.displayStatesForKind(kind).includes(state)) return;
        if (kind === 'built') {
            if (builtDisplay === state) return;
            builtDisplay = state;
        } else if (kind === 'planned') {
            if (plannedDisplay === state) return;
            plannedDisplay = state;
        } else {
            return;
        }
        updateDisplayStateControls();
        // Changing display drops out of parcel isolation so the new state is shown in full.
        isolatedParcelId = null;
        updateIsolationButton();
        rebuild3DBuildingsOnly();
        applyModeVisibility();
        // In realistic mode the Built row also drives the photoreal mesh itself.
        if (kind === 'built' && window.PhotorealMode && typeof window.PhotorealMode.isActive === 'function'
            && window.PhotorealMode.isActive() && typeof window.PhotorealMode.setBuiltVisible === 'function') {
            window.PhotorealMode.setBuiltVisible(state !== 'off');
        }
    }

    // Sets the built-context load radius (metres) and refetches at the new size. The camera is
    // left where it is — widening the radius reveals more surrounding buildings in place.
    function setBuildingLoadRadius(meters) {
        const r = Math.max(BUILDING_RADIUS_MIN_M, Math.min(BUILDING_RADIUS_MAX_M, Math.round(meters)));
        if (r === buildingLoadRadiusM) return;
        buildingLoadRadiusM = r;
        nearbyProposalBuildingsKey = null; // invalidate cache so the next call refetches
        ensureNearbyProposalBuildings();
    }

    function getParcelFeatureById(parcelId) {
        if (typeof parcelLayer === 'undefined' || !parcelLayer) return null;
        let found = null;
        try {
            parcelLayer.getLayers().forEach(l => {
                const f = l && l.feature;
                if (found || !f || !f.properties) return;
                if (f.properties.parcelId != null && String(f.properties.parcelId) === parcelId) found = f;
            });
        } catch (_) { }
        return found;
    }

    // Ground-plane footprint polygon (lng/lat) of a nearby 3D building, from the convex hull of all
    // its face vertices. Cached on the building object since it never changes.
    //
    // NOT used by the carve — that matches records to meshes by object_id and takes its polygons
    // from the record. This hull is an approximation (it fills in the notch of an L-shaped block),
    // which is fine for the parcel VOLUME estimate below, its only remaining caller.
    function buildingFootprintPolygon(bld) {
        if (!bld || !Array.isArray(bld.faces)) return null;
        if (bld.__footprintPolygon !== undefined) return bld.__footprintPolygon;
        const hull = window.buildingFootprintFromFaces(bld.faces, turf);
        bld.__footprintPolygon = hull;
        return hull;
    }

    // Drop coincident duplicate meshes from a nearby-buildings response. Some city 3D models
    // (notably Zagreb gdi_building_3d) store a building twice under different object_ids with the same
    // footprint — this causes z-fighting in the 3D view and double-counts existing volume in the
    // gain calc. Deduping once at fetch intake gives every consumer a clean list. Two buildings are
    // treated as the same when their vertex-mean centroids are within ~2 m and their vertical
    // extents (z_min/z_max) match within 1 m. A ~5 m spatial grid with a 3x3 neighbour scan keeps
    // this O(vertices) — no convex hulls — so even a multi-thousand-building response costs a few ms.
    // dedupeCoincidentBuildings lives in frontend/js/proposals/gain.js (loaded first). Kept as a
    // global there; the fetch-intake call below uses it unchanged.

    // Built/proposed volume (m³) and derived floor area (m²) for one parcel — the money math is in
    // frontend/js/proposals/gain.js (unit-tested). This wrapper resolves the parcel feature and the
    // built (nearbyProposalBuildings, deduped at intake) + proposed (window.proposedBuildings)
    // building lists, and injects turf + the footprint/height lookups.
    function computeParcelMetrics(parcelId) {
        const parcel = getParcelFeatureById(parcelId);
        if (!parcel) return null;
        return window.ProposalGain.computeParcelMetrics(
            parcel,
            Array.isArray(nearbyProposalBuildings) ? nearbyProposalBuildings : [],
            Array.isArray(window.proposedBuildings) ? window.proposedBuildings : [],
            {
                floorHeightM: FLOOR_HEIGHT_M,
                turf,
                footprintOf: buildingFootprintPolygon,
                heightOf: estimateBuildingHeightMeters
            }
        );
    }

    function threeI18n(key, fallback, params) {
        const api = (typeof window !== 'undefined' && window.i18n) ? window.i18n : null;
        if (api && typeof api.t === 'function') {
            try { return api.t(key, params || {}); } catch (_) { /* fall through */ }
        }
        return fallback;
    }

    function formatInt(n) {
        const v = Math.round(Number(n) || 0);
        try { return v.toLocaleString('en-US'); } catch (_) { return String(v); }
    }

    // --- Proposal lookup helpers (for the "Proposal info" view) ---
    function getProposalForParcel(parcelId) {
        try {
            const store = (typeof window !== 'undefined') ? window.proposalStorage : null;
            if (!store || typeof store.getProposalsForParcel !== 'function') return null;
            const list = store.getProposalsForParcel(parcelId) || [];
            if (!list.length) return null;
            // Prefer an applied proposal; else the first match.
            const applied = list.find(p => isApplied(p));
            return applied || list[0];
        } catch (_) { return null; }
    }

    function proposalDisplayTitle(p) {
        if (!p) return '';
        return p.title || p.name || p.proposalName || ('Proposal ' + (p.proposalId || p.id || ''));
    }

    function proposalIdOf(p) {
        return p ? (p.proposalId || p.id || null) : null;
    }

    // Union of every parcel id a proposal touches (before + after, across its sub-proposals).
    function getProposalParcelIdSet(proposal) {
        const ids = new Set();
        if (!proposal) return ids;
        const add = (arr) => { if (Array.isArray(arr)) arr.forEach(id => { if (id != null) ids.add(String(id)); }); };
        add(proposal.parentParcelIds);
        add(proposal.childParcelIds);
        ['roadProposal', 'decideLaterProposal', 'reparcellization', 'buildingProposal', 'structureProposal'].forEach(k => {
            const sp = proposal[k];
            if (sp) { add(sp.parentParcelIds); add(sp.childParcelIds); }
        });
        return ids;
    }

    function ensureParcelInfoPanel() {
        if (!threeContainer) return null;
        if (parcelInfoPanelEl && parcelInfoPanelEl.parentElement === threeContainer) return parcelInfoPanelEl;
        parcelInfoPanelEl = document.createElement('div');
        parcelInfoPanelEl.className = 'three-mode-parcel-panel';
        parcelInfoPanelEl.style.display = 'none';
        threeContainer.appendChild(parcelInfoPanelEl);
        return parcelInfoPanelEl;
    }

    function hideParcelInfoPanel() {
        if (parcelInfoPanelEl) parcelInfoPanelEl.style.display = 'none';
        // The open info box covers the floating status message (mobile); clear that when it closes.
        try { document.body.classList.remove('three-info-open'); } catch (_) { }
    }

    // Refresh the price label and the value-gain line from the current slider price and the
    // stored floor areas. Cheap — runs on every slider tick.
    function renderValueAndGain(panel) {
        const built = lastFloorAreas ? lastFloorAreas.built : 0;
        const proposed = lastFloorAreas ? lastFloorAreas.proposed : 0;
        // Money math from the shared, tested module.
        const { gain, currentValue, hasProposed, avg } = window.ProposalGain.computeGain({
            builtFloorArea: built,
            proposedFloorArea: proposed,
            priceEurPerM2,
            parcelCount: lastParcelCount
        });

        const titleEl = panel.querySelector('[data-role="value-title"]');
        if (titleEl) titleEl.textContent = threeI18n('threeMode.parcelPanel.valueTitle', 'Value @ €{{p}}/m²', { p: formatInt(priceEurPerM2) });

        const gainEl = panel.querySelector('[data-role="gain"]');
        if (gainEl) {
            // No proposed massing on this parcel → there's no "gain", just the current
            // built value. Show that as a positive figure instead of a negative delta.
            if (!hasProposed) {
                gainEl.className = 'parcel-panel-gain' + (currentValue > 0 ? ' gain-positive' : '');
                gainEl.textContent = `${threeI18n('threeMode.parcelPanel.currentValue', 'Current value')}: €${formatInt(currentValue)}`;
            } else {
                const cls = gain > 0 ? 'gain-positive' : (gain < 0 ? 'gain-negative' : '');
                gainEl.className = 'parcel-panel-gain ' + cls;
                const sign = gain > 0 ? '+' : '';
                gainEl.textContent = `${threeI18n('threeMode.parcelPanel.gain', 'Proposal gain')}: ${sign}€${formatInt(gain)}`;
            }
        }

        // Proposal panel only: average gain/loss per parcel (total gain ÷ parcel count).
        const avgEl = panel.querySelector('[data-role="avg-gain"]');
        if (avgEl) {
            if (avg !== null) {
                const cls = avg > 0 ? 'gain-positive' : (avg < 0 ? 'gain-negative' : '');
                const sign = avg > 0 ? '+' : '';
                avgEl.className = 'parcel-panel-avg ' + cls;
                avgEl.textContent = `${threeI18n('threeMode.proposalPanel.avgPerParcel', 'Avg / parcel')}: ${sign}€${formatInt(avg)}`;
            } else {
                avgEl.className = 'parcel-panel-avg';
                avgEl.textContent = '';
            }
        }
    }

    // Shared by the parcel and proposal panels: wire the price slider and render the value/gain
    // line from the current priceEurPerM2 and lastFloorAreas, then reveal the panel.
    function wireSliderAndGain(panel) {
        const slider = panel.querySelector('[data-role="price-slider"]');
        if (slider) {
            slider.addEventListener('input', () => {
                const v = Number(slider.value);
                if (Number.isFinite(v)) priceEurPerM2 = v;
                renderValueAndGain(panel);
            });
        }
        renderValueAndGain(panel);
        panel.style.display = '';
        // Mark an info box as open so CSS can cover the overlapping floating status on mobile.
        try { document.body.classList.add('three-info-open'); } catch (_) { }
    }

    // The Built/Proposed volume + floor-area rows shared by both panels.
    function metricsTableHtml(L, builtVolume, proposedVolume, builtFloorArea, proposedFloorArea) {
        return `
            <table class="parcel-panel-table">
                <tr><th></th><th>${L.built}</th><th>${L.proposed}</th></tr>
                <tr><td>${L.volume}</td><td>${formatInt(builtVolume)} m³</td><td>${formatInt(proposedVolume)} m³</td></tr>
                <tr><td>${L.floorArea}</td><td>${formatInt(builtFloorArea)} m²</td><td>${formatInt(proposedFloorArea)} m²</td></tr>
            </table>
            <div class="parcel-panel-note">${L.floorNote}</div>
            <div class="parcel-panel-value-title" data-role="value-title"></div>
            <input type="range" class="parcel-panel-price-slider" data-role="price-slider"
                min="${PRICE_MIN_EUR}" max="${PRICE_MAX_EUR}" step="${PRICE_STEP_EUR}" value="${priceEurPerM2}"
                aria-label="${L.priceLabel}">
            <div class="parcel-panel-gain" data-role="gain"></div>`;
    }

    function panelLabels() {
        return {
            title: threeI18n('threeMode.parcelPanel.title', 'Parcel'),
            built: threeI18n('threeMode.parcelPanel.built', 'Built'),
            proposed: threeI18n('threeMode.parcelPanel.proposed', 'Proposed'),
            volume: threeI18n('threeMode.parcelPanel.volume', 'Volume'),
            floorArea: threeI18n('threeMode.parcelPanel.floorArea', 'Floor area'),
            floorNote: threeI18n('threeMode.parcelPanel.floorNote', '@ {{h}} m/floor', { h: FLOOR_HEIGHT_M }),
            priceLabel: threeI18n('threeMode.parcelPanel.priceLabel', 'Price per m²'),
            proposalLabel: threeI18n('threeMode.parcelPanel.proposalLabel', 'Proposal'),
            show: threeI18n('threeMode.parcelPanel.show', 'show'),
            proposalHeading: threeI18n('threeMode.proposalPanel.title', 'Proposal info'),
            parcelsLabel: threeI18n('threeMode.proposalPanel.parcelsLabel', 'Parcels')
        };
    }

    function updateParcelInfoPanel(parcelId) {
        const panel = ensureParcelInfoPanel();
        if (!panel) return;
        const m = computeParcelMetrics(parcelId);
        if (!m) { panel.style.display = 'none'; try { document.body.classList.remove('three-info-open'); } catch (_) { } return; }
        lastFloorAreas = { built: m.builtFloorArea, proposed: m.proposedFloorArea };
        lastParcelCount = null; // single parcel — no per-parcel average

        const L = panelLabels();
        // If the parcel belongs to a proposal, offer a [show] button that opens the proposal view.
        const proposal = getProposalForParcel(parcelId);
        const proposalRow = proposal ? `
            <div class="parcel-panel-proposal">
                <span class="parcel-panel-proposal-label">${L.proposalLabel}:</span>
                <button type="button" class="parcel-panel-proposal-show" data-role="show-proposal">${escapeHtml(proposalDisplayTitle(proposal))} <span class="show-tag">[${L.show}]</span></button>
            </div>` : '';

        panel.innerHTML = `
            <div class="parcel-panel-title">${L.title} ${escapeHtml(String(parcelId))}</div>
            ${proposalRow}
            ${metricsTableHtml(L, m.builtVolume, m.proposedVolume, m.builtFloorArea, m.proposedFloorArea)}
        `;

        const showBtn = panel.querySelector('[data-role="show-proposal"]');
        if (showBtn && proposal) {
            const pid = proposalIdOf(proposal);
            showBtn.addEventListener('click', () => { if (pid != null) isolateProposal(pid); });
        }
        wireSliderAndGain(panel);
    }

    // Aggregate panel for a whole proposal: totals across all its parcels, total gain/loss.
    function updateProposalInfoPanel(proposal, idSet) {
        const panel = ensureParcelInfoPanel();
        if (!panel) return;
        let builtVolume = 0, proposedVolume = 0, builtFloorArea = 0, proposedFloorArea = 0, parcelCount = 0;
        idSet.forEach(id => {
            const m = computeParcelMetrics(id);
            if (!m) return;
            parcelCount++;
            builtVolume += m.builtVolume;
            proposedVolume += m.proposedVolume;
            builtFloorArea += m.builtFloorArea;
            proposedFloorArea += m.proposedFloorArea;
        });
        lastFloorAreas = { built: builtFloorArea, proposed: proposedFloorArea };
        lastParcelCount = parcelCount;

        const L = panelLabels();
        panel.innerHTML = `
            <div class="parcel-panel-title">${L.proposalHeading}</div>
            <div class="parcel-panel-proposal-name">${escapeHtml(proposalDisplayTitle(proposal))}</div>
            <div class="parcel-panel-subnote">${L.parcelsLabel}: ${parcelCount}</div>
            ${metricsTableHtml(L, builtVolume, proposedVolume, builtFloorArea, proposedFloorArea)}
            <div class="parcel-panel-avg" data-role="avg-gain"></div>
        `;
        wireSliderAndGain(panel);
    }

    // Show only the given set of parcels (and the buildings on them). Used by both single-parcel
    // and whole-proposal isolation. parcelFeatures are the polygons for testing existing
    // (untagged) context buildings by footprint centre.
    function applyIsolationVisibility(parcelIdSet, parcelFeatures) {
        // flatGroup holds parcels (tagged) and roads (untagged) — show only members of the set.
        if (flatGroup) flatGroup.children.forEach(c => {
            const pid = c.userData && c.userData.parcelId;
            c.visible = (pid != null) && parcelIdSet.has(String(pid));
        });
        // buildingGroup holds proposed slices (tagged with their parcelId) and existing context
        // buildings (untagged). Show proposed slices on member parcels, plus existing buildings
        // whose footprint centre falls inside any member parcel polygon.
        if (buildingGroup) buildingGroup.children.forEach(c => {
            const ud = c.userData || {};
            if (ud.parcelId != null) { c.visible = parcelIdSet.has(String(ud.parcelId)); return; }
            if (ud.isNearbyBuilding3D && ud.footprintLatLng && parcelFeatures.length) {
                let inside = false;
                try {
                    const pt = turf.point(ud.footprintLatLng);
                    for (let i = 0; i < parcelFeatures.length; i++) {
                        if (turf.booleanPointInPolygon(pt, parcelFeatures[i])) { inside = true; break; }
                    }
                } catch (_) { }
                c.visible = inside;
                return;
            }
            c.visible = false;
        });
        // Planned decorations aren't parcel-specific; hide them while isolated.
        [plannedFlatGroup, parkGroup, squareGroup, lakeGroup, stationGroup, existingTransitAlignmentGroup].forEach(g => { if (g) g.visible = false; });
    }

    // Hide everything except the given parcel and the building footprint(s) on it.
    // The photoreal layer carves the mesh for every applied proposal; when isolation hides
    // some proposals' surfaces, their carve holes would gape open — so it listens for this.
    function notifyIsolationChanged() {
        try {
            window.dispatchEvent(new CustomEvent('threeModeIsolationChanged', {
                detail: { proposalId: isolatedProposalId, parcelId: isolatedParcelId }
            }));
        } catch (_) { }
    }

    function isolateParcel(parcelId) {
        if (!parcelId) return;
        isolatedParcelId = parcelId;
        isolatedProposalId = null;
        updateIsolationButton();
        updateParcelInfoPanel(parcelId);
        const pf = getParcelFeatureById(parcelId);
        applyIsolationVisibility(new Set([String(parcelId)]), pf ? [pf] : []);
        notifyIsolationChanged();
    }

    // Hide everything except the parcels (and their buildings) belonging to a whole proposal.
    function isolateProposal(proposalId) {
        const store = (typeof window !== 'undefined') ? window.proposalStorage : null;
        const proposal = (store && typeof store.getProposal === 'function') ? store.getProposal(proposalId) : null;
        if (!proposal) return;
        const idSet = getProposalParcelIdSet(proposal);
        if (!idSet.size) return;
        isolatedProposalId = String(proposalId);
        isolatedParcelId = null;
        updateIsolationButton();
        updateProposalInfoPanel(proposal, idSet);
        const feats = [];
        idSet.forEach(id => { const f = getParcelFeatureById(id); if (f) feats.push(f); });
        applyIsolationVisibility(idSet, feats);
        notifyIsolationChanged();
    }

    function clearIsolation() {
        if (isolatedParcelId === null && isolatedProposalId === null) return;
        isolatedParcelId = null;
        isolatedProposalId = null;
        updateIsolationButton();
        hideParcelInfoPanel();
        // Restore every flatGroup child (roads + all parcels) before re-applying the mode,
        // which may then re-hide applied-descendant parcels in Built mode.
        if (flatGroup) flatGroup.children.forEach(c => { c.visible = true; });
        // Rebuild buildings so their per-object visibility resets cleanly to the mode default.
        rebuild3DBuildingsOnly();
        applyModeVisibility();
        notifyIsolationChanged();
    }

    function updateIsolationButton() {
        try {
            if (isolationResetEl) isolationResetEl.style.display = (isolatedParcelId === null && isolatedProposalId === null) ? 'none' : '';
        } catch (_) { }
    }

    function ensureBuildingModeControls() {
        if (!threeContainer) return;
        if (buildingModeControlsEl && buildingModeControlsEl.parentElement === threeContainer) {
            updateDisplayStateControls();
            return;
        }

        buildingModeControlsEl = document.createElement('div');
        buildingModeControlsEl.className = 'three-mode-ui-panel';
        buildingModeControlsEl.setAttribute('role', 'group');
        buildingModeControlsEl.setAttribute('aria-label', threeI18n('threeMode.controls.buildingRenderingAria', 'Building rendering'));

        // Collapse toggle — on phones the panel eats the top of the map, so it folds to a single
        // gear icon (tap to expand). Hidden on desktop via CSS, where the panel is always open.
        const collapseToggle = document.createElement('button');
        collapseToggle.type = 'button';
        collapseToggle.className = 'three-mode-ui-collapse';
        collapseToggle.setAttribute('aria-label', threeI18n('threeMode.controls.togglePanel', 'Toggle controls'));
        collapseToggle.innerHTML = '<span aria-hidden="true">⚙</span>';
        collapseToggle.addEventListener('click', () => buildingModeControlsEl.classList.toggle('collapsed'));
        buildingModeControlsEl.appendChild(collapseToggle);
        try {
            if (window.matchMedia && window.matchMedia('(max-width: 768px)').matches) {
                buildingModeControlsEl.classList.add('collapsed');
            }
        } catch (_) { }

        // Radius row — controls how wide a band of built context is loaded/rendered.
        const radiusRow = document.createElement('div');
        radiusRow.className = 'three-mode-radius-row';

        const radiusHeader = document.createElement('div');
        radiusHeader.className = 'three-mode-radius-header';
        const radiusLabel = document.createElement('span');
        radiusLabel.className = 'three-mode-emphasis-label';
        radiusLabel.textContent = threeI18n('threeMode.controls.radius', 'Radius');
        radiusLabel.title = threeI18n('threeMode.controls.radiusTooltip', 'Radius');
        const radiusValue = document.createElement('span');
        radiusValue.className = 'three-mode-radius-value';
        radiusValue.textContent = `${buildingLoadRadiusM} m`;
        radiusHeader.appendChild(radiusLabel);
        radiusHeader.appendChild(radiusValue);

        const radiusSlider = document.createElement('input');
        radiusSlider.type = 'range';
        radiusSlider.className = 'three-mode-radius-slider';
        radiusSlider.min = String(BUILDING_RADIUS_MIN_M);
        radiusSlider.max = String(BUILDING_RADIUS_MAX_M);
        radiusSlider.step = '50';
        radiusSlider.value = String(buildingLoadRadiusM);
        // Live label while dragging; only refetch on release ('change') to avoid spamming the backend.
        radiusSlider.addEventListener('input', () => { radiusValue.textContent = `${radiusSlider.value} m`; });
        radiusSlider.addEventListener('change', () => { setBuildingLoadRadius(Number(radiusSlider.value)); });

        radiusRow.appendChild(radiusHeader);
        radiusRow.appendChild(radiusSlider);
        buildingModeControlsEl.appendChild(radiusRow);

        // Display-state rows use equal-width selects. Built has one more state than Planned, so
        // segmented buttons divided the same panel into four versus three unequal/truncated cells.
        // A select represents this compact state choice without hiding any localized label.
        const makeDisplayRow = (kind, labelText) => {
            const row = document.createElement('div');
            row.className = 'three-mode-emphasis-row';
            const label = document.createElement('label');
            label.className = 'three-mode-emphasis-label';
            label.textContent = labelText;
            // Full explanation on hover — the row label is short but its meaning isn't obvious.
            label.title = threeI18n('threeMode.controls.' + kind + 'Tooltip', labelText);
            label.htmlFor = `three-mode-${kind}-display`;
            row.appendChild(label);
            const stateTooltips = {
                solid: threeI18n('threeMode.controls.stateSolidTooltip', 'Solid'),
                ghost: threeI18n('threeMode.controls.stateGhostTooltip', 'Transparent'),
                surviving: threeI18n('threeMode.controls.stateSurvivingTooltip', 'Surviving'),
                removed: threeI18n('threeMode.controls.stateRemovedTooltip', 'Removed'),
                off: threeI18n('threeMode.controls.stateOffTooltip', 'Off')
            };
            const stateLabels = {
                solid: threeI18n('threeMode.controls.stateSolid', 'Solid'),
                ghost: threeI18n('threeMode.controls.stateGhost', 'Transparent'),
                surviving: threeI18n('threeMode.controls.stateSurviving', 'Surviving'),
                removed: threeI18n('threeMode.controls.stateRemoved', 'Removed'),
                off: threeI18n('threeMode.controls.stateOff', 'Off')
            };
            const states = buildingDisplayPolicy.displayStatesForKind(kind)
                .map(state => [state, stateLabels[state]]);
            const select = document.createElement('select');
            select.id = `three-mode-${kind}-display`;
            select.className = 'three-mode-display-select';
            states.forEach(([state, stateLabel]) => {
                const option = document.createElement('option');
                option.value = state;
                option.textContent = stateLabel;
                if (stateTooltips[state]) option.dataset.tooltip = stateTooltips[state];
                select.appendChild(option);
            });
            select.addEventListener('change', () => setBuildingDisplay(kind, select.value));
            displayStateSelects[kind] = select;
            row.appendChild(select);
            return row;
        };
        buildingModeControlsEl.appendChild(makeDisplayRow('built', threeI18n('threeMode.controls.built', 'Built')));
        buildingModeControlsEl.appendChild(makeDisplayRow('planned', threeI18n('threeMode.controls.planned', 'Planned')));

        // Scenery toggles — populated dynamically from GET /decor/layers (see refreshDecorToggles),
        // so a checkbox appears only for layers the current city has actually ingested (e.g. Trees for
        // Belgrade, nothing for cities without scenery). Independent of the Built/Planned mode.
        decorTogglesEl = document.createElement('div');
        decorTogglesEl.className = 'three-mode-decor-toggles';
        buildingModeControlsEl.appendChild(decorTogglesEl);

        // Show-all reset, only visible while a parcel is isolated.
        isolationResetEl = document.createElement('div');
        isolationResetEl.className = 'three-mode-emphasis-row';
        const showAllBtn = document.createElement('button');
        showAllBtn.type = 'button';
        showAllBtn.className = 'three-mode-reset-btn';
        showAllBtn.textContent = threeI18n('threeMode.controls.showAllParcels', 'Show all parcels');
        showAllBtn.addEventListener('click', () => clearIsolation());
        isolationResetEl.appendChild(showAllBtn);
        buildingModeControlsEl.appendChild(isolationResetEl);

        threeContainer.appendChild(buildingModeControlsEl);
        updateDisplayStateControls();
        updateIsolationButton();
    }

    // Centre of the proposal being viewed (midpoint of the proposed buildings' bbox),
    // or null when there is no building proposal in the scene.
    function getProposalCenterLatLng() {
        // Prefer the focused proposals' real geometry (roads/parks included) so a road link anchors
        // the scene on the road, not on the union of unrelated applied buildings.
        const geom = computeFocusFramingGeometry() || computeProposalQueryGeometry();
        if (geom && geom.coordinates && geom.coordinates[0] && geom.coordinates[0].length) {
            let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
            for (const p of geom.coordinates[0]) {
                const lng = p[0], lat = p[1];
                if (lng < minLng) minLng = lng;
                if (lng > maxLng) maxLng = lng;
                if (lat < minLat) minLat = lat;
                if (lat > maxLat) maxLat = lat;
            }
            if (isFinite(minLng) && isFinite(minLat)) {
                return { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
            }
        }
        return null;
    }

    // Entering 3D has two meanings, and they want different cameras.
    //
    // "Show me this proposal" — arriving on a shared link, or pressing 3D with a proposal selected on the
    // map — anchors the scene on that proposal, frames it, and loads its surroundings. "Show me this, in
    // 3D" — pressing 3D while looking at the map with nothing selected — keeps the camera exactly where
    // the 2D map was. It used to anchor on whatever proposal happened to be *applied*, which could be
    // kilometres from what the user was looking at.
    //
    // Which of the two it is comes from the selection: a shared link selects the proposal it opened, and
    // a click on the map selects the proposal it hit. `focusProposalIds` narrows a shared link to the
    // proposals it named, and is empty otherwise.
    function focusedProposalIds() {
        if (focusProposalIds && focusProposalIds.size) return focusProposalIds;
        const selection = window.ProposalSelection;
        const key = (selection && typeof selection.getKey === 'function') ? selection.getKey() : null;
        return key ? new Set([String(key)]) : null;
    }

    function isProposalFocusedEntry() {
        return !!focusedProposalIds();
    }

    // The bbox to frame when specific proposals are in focus (a shared link, or a map selection).
    // computeProposalQueryGeometry only sees proposed BUILDINGS, so a road- or park-only link found
    // zero matching building features and fell back to framing every applied proposal (the "ski view"
    // zoom-out). This gathers the focused proposals' ACTUAL geometry from the store — road corridors,
    // parks/structures, buildings alike — via collectProposalFeatureSets, so the camera lands on them.
    function computeFocusFramingGeometry() {
        const focusIds = focusedProposalIds();
        if (!focusIds || !focusIds.size) return null;
        if (typeof proposalStorage === 'undefined' || typeof proposalStorage.getAllProposals !== 'function') return null;
        if (typeof collectProposalFeatureSets !== 'function' || typeof turf === 'undefined') return null;
        const idsOf = (p) => {
            const ids = [];
            if (!p) return ids;
            if (p.proposalId != null) ids.push(String(p.proposalId));
            if (p.serverProposalId != null) ids.push(String(p.serverProposalId));
            if (typeof window.getServerProposalId === 'function') {
                const s = window.getServerProposalId(p); if (s != null) ids.push(String(s));
            }
            if (typeof window.getProposalKey === 'function') {
                const k = window.getProposalKey(p); if (k) ids.push(String(k));
            }
            return ids;
        };
        const features = [];
        try {
            (proposalStorage.getAllProposals() || []).forEach(p => {
                if (!idsOf(p).some(id => focusIds.has(id))) return;
                const sets = collectProposalFeatureSets(p) || {};
                (sets.primaryFeatures || []).forEach(f => { if (f && f.geometry) features.push(f); });
            });
        } catch (_) { return null; }
        if (!features.length) return null;
        try {
            const bbox = turf.bbox(turf.featureCollection(features));
            if (!bbox || bbox.some(v => !isFinite(v))) return null;
            const [minX, minY, maxX, maxY] = bbox;
            return { type: 'Polygon', coordinates: [[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]]] };
        } catch (_) { return null; }
    }

    // The geometry the scene should anchor, frame and load context around: the selected proposal, and
    // nothing when nothing is selected — which makes every consumer fall through to the camera-focus
    // path, so the built context loads around where the user actually is. Prefer the type-agnostic
    // focus geometry (roads/parks included); fall back to the buildings-only query geometry.
    function proposalFramingGeometry() {
        if (!isProposalFocusedEntry()) return null;
        return computeFocusFramingGeometry() || computeProposalQueryGeometry();
    }

    function getOrigin3857() {
        // Anchor the local XY frame on the proposal when one was asked for, so it sits at the scene
        // origin and the built context loads around it; otherwise on the 2D map center, so a free
        // entry lands exactly where the user was already looking.
        const center = (isProposalFocusedEntry() ? getProposalCenterLatLng() : null)
            || ((typeof map !== 'undefined' && map) ? map.getCenter() : { lat: 0, lng: 0 });
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
        // Drop near-duplicate consecutive vertices (in the local metric XY frame) and the closing
        // duplicate. turf.intersect emits sub-mm-apart points along buffer arcs and where a building
        // crosses a parcel edge; those become zero-length edges that make THREE's earcut triangulation
        // produce overlapping/degenerate faces — the frayed top + striped walls seen on some slices.
        const EPS = 0.02; // metres
        const toCleanVecs = (ring) => {
            const out = [];
            for (const pt of ring) {
                const xy = coordsToXY(pt);
                const v = new THREE.Vector2(xy[0], xy[1]);
                const prev = out[out.length - 1];
                if (prev && Math.hypot(v.x - prev.x, v.y - prev.y) < EPS) continue;
                out.push(v);
            }
            if (out.length >= 2) {
                const f = out[0], l = out[out.length - 1];
                if (Math.hypot(f.x - l.x, f.y - l.y) < EPS) out.pop(); // THREE closes the ring itself
            }
            return out;
        };

        const outer = toCleanVecs(rings[0]);
        if (outer.length < 3) return null;
        // A self-intersecting outer ring (a bowtie strip from a sharp bend, or a degenerate footprint
        // from a dragged node) triangulates into overlapping faces with degenerate normals — the flat
        // black area + radiating spikes seen in 3D. It renders fine in 2D, so the guard is HERE (3D
        // only): skip the mesh rather than draw the artifact. `ringSelfIntersectsXY` takes [x,y] pairs.
        // (Corridor asphalt takes a different route for this case — see addFlatStripRibbon3D.)
        if (typeof window !== 'undefined' && typeof window.ringSelfIntersectsXY === 'function') {
            try {
                if (window.ringSelfIntersectsXY(outer.map(v => [v.x, v.y]))) return null;
            } catch (_) { /* fall through and mesh it */ }
        }
        const shape = new THREE.Shape(outer);
        for (let i = 1; i < rings.length; i++) {
            const holePts = toCleanVecs(rings[i]);
            if (holePts.length >= 3) shape.holes.push(new THREE.Path(holePts));
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
            // Building ghost materials are tagged by configureBuildingMaterial; other flat and
            // extruded scene materials pass through untouched.
            attachBuildingDepthPrepass(mesh);
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
                loop.renderOrder = 9000;
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

    function collectDraftPreviewFeatures(descriptor, draft) {
        const features = [];
        const push = (value) => {
            if (!value) return;
            if (value.type === 'Feature' && value.geometry) { features.push(value); return; }
            if (value.type === 'FeatureCollection') { (value.features || []).forEach(push); return; }
            if (value.type && Array.isArray(value.coordinates)) features.push({ type: 'Feature', properties: {}, geometry: value });
        };
        if (descriptor?.kind === 'corridor') {
            const definition = descriptor.definition || {};
            push(definition.polygon);
            if (!features.length) {
                const raw = definition.points || definition.segments || [];
                const segments = Array.isArray(raw?.[0]) ? raw : (raw.length ? [raw] : []);
                segments.forEach(segment => {
                    const coordinates = (segment || []).map(point => {
                        const lat = Number(point?.lat !== undefined ? point.lat : point?.[1]);
                        const lng = Number(point?.lng !== undefined ? point.lng : point?.[0]);
                        return Number.isFinite(lat) && Number.isFinite(lng) ? [lng, lat] : null;
                    }).filter(Boolean);
                    if (coordinates.length >= 2) push({ type: 'LineString', coordinates });
                });
            }
        } else if (descriptor?.kind === 'buildings') {
            (descriptor.features || []).forEach(push);
        } else if (descriptor?.kind === 'reparcellization') {
            (descriptor.polygons || []).forEach(polygon => push(polygon.geometry || polygon));
        } else {
            push(descriptor?.geometry);
        }
        if (!features.length && draft?.fields?.parentParcelIds?.length && typeof parcelLayer !== 'undefined' && parcelLayer) {
            const ids = new Set(draft.fields.parentParcelIds.map(String));
            parcelLayer.getLayers().forEach(layer => {
                const feature = layer?.feature;
                const id = feature?.properties?.parcelId || feature?.properties?.parcel_id || feature?.properties?.id;
                if (id !== undefined && ids.has(String(id))) push(feature);
            });
        }
        return features;
    }

    function collectSourcePreviewFeatures(proposal) {
        const features = [];
        const push = value => {
            if (!value) return;
            if (value.type === 'Feature' && value.geometry) { features.push(value); return; }
            if (value.type === 'FeatureCollection') { (value.features || []).forEach(push); return; }
            if (value.type && Array.isArray(value.coordinates)) features.push({ type: 'Feature', properties: {}, geometry: value });
        };
        const definition = proposal?.roadProposal?.definition || proposal?.geometry?.roadPlan || proposal?.definition;
        push(definition?.polygon);
        (proposal?.buildingProposal?.buildings || proposal?.geometry?.buildings || []).forEach(push);
        push(proposal?.buildingProposal?.buildingFeature);
        if (!features.length && proposal?.buildingGeometry) push({ type: 'Feature', properties: proposal.buildingProperties || {}, geometry: proposal.buildingGeometry });
        (proposal?.reparcellization?.polygons || []).forEach(polygon => push(polygon.geometry || polygon));
        push(proposal?.structureProposal?.geometry);
        push(proposal?.geometry?.roadGeometry?.polygon);
        return features;
    }

    function disposeDraftPreviewChildren(group) {
        if (!group) return;
        while (group.children.length) {
            const child = group.children.pop();
            child.traverse?.(node => {
                try { node.geometry?.dispose?.(); } catch (_) { }
                try {
                    if (Array.isArray(node.material)) node.material.forEach(material => material?.dispose?.());
                    else node.material?.dispose?.();
                } catch (_) { }
            });
        }
    }

    function addDraftPreviewFeature3D(feature, target, style, kind) {
        if (!feature?.geometry || !target) return;
        const color = style === 'source' ? 0x64748b : 0x2563eb;
        const opacity = style === 'source' ? 0.2 : 0.55;
        const fill = new THREE.MeshLambertMaterial({
            color,
            transparent: true,
            opacity,
            depthWrite: style !== 'source',
            polygonOffset: true,
            polygonOffsetFactor: -5,
            polygonOffsetUnits: -5,
            side: THREE.DoubleSide
        });
        const line = new THREE.LineBasicMaterial({ color, transparent: true, opacity: style === 'source' ? 0.55 : 1, depthTest: false });
        if (feature.geometry.type === 'LineString' || feature.geometry.type === 'MultiLineString') {
            const object = lineFeatureToLine(feature, line, style === 'source' ? 0.35 : 0.55);
            if (object) { object.renderOrder = style === 'source' ? 9100 : 9200; target.add(object); }
            return;
        }
        const height = kind === 'buildings' ? estimateBuildingHeightMeters(feature) : 0;
        polygonFeatureToMeshes(feature, fill, style === 'source' ? 0.22 : 0.38, height)
            .forEach(mesh => { mesh.renderOrder = style === 'source' ? 9100 : 9200; target.add(mesh); });
        polygonFeatureToBorderLines(feature, line, Math.max(0.5, height + 0.5))
            .forEach(border => { border.renderOrder = style === 'source' ? 9101 : 9201; target.add(border); });
    }

    function rebuildProposalDraftPreview3D(detail = latestProposalDraftPreviewDetail) {
        latestProposalDraftPreviewDetail = detail || null;
        if (!isActive || !proposalDraftGroup) return;
        disposeDraftPreviewChildren(proposalDraftGroup);
        if (!detail) return;
        const sourceGroup = new THREE.Group();
        const draftGroup = new THREE.Group();
        proposalDraftGroup.add(sourceGroup, draftGroup);
        if (detail.sourceProposal) {
            collectSourcePreviewFeatures(detail.sourceProposal)
                .forEach(feature => addDraftPreviewFeature3D(feature, sourceGroup, 'source', 'source'));
        }
        if (detail.draftPreview) {
            const draft = window.proposalDraftStore?.getDraft?.(detail.draftId) || null;
            collectDraftPreviewFeatures(detail.draftPreview, draft)
                .forEach(feature => addDraftPreviewFeature3D(feature, draftGroup, 'draft', detail.draftPreview.kind));
        }
    }

    function proposalKey3D(proposal) {
        if (!proposal) return null;
        try {
            if (typeof window.getProposalKey === 'function') return String(window.getProposalKey(proposal) || '') || null;
        } catch (_) { }
        const value = proposal.proposalId || proposal.id || proposal.hash || null;
        return value === null || value === undefined ? null : String(value);
    }

    function proposalApplied3D(proposal) {
        if (!proposal) return false;
        if (isApplied(proposal)) return true;
        return ['roadProposal', 'buildingProposal', 'structureProposal', 'reparcellization', 'decideLaterProposal']
            .some(k => proposal[k] && isApplied(proposal, proposal[k]));
    }

    function proposalParcelFeatures3D(proposal) {
        if (typeof parcelLayer === 'undefined' || !parcelLayer) return [];
        const ids = new Set([
            ...(proposal?.parentParcelIds || []),
            ...(proposal?.childParcelIds || []),
            ...(proposal?.roadProposal?.childParcelIds || []),
            ...(proposal?.buildingProposal?.childParcelIds || []),
            ...(proposal?.reparcellization?.childParcelIds || [])
        ].map(String));
        const features = [];
        parcelLayer.getLayers().forEach(layer => {
            const feature = layer?.feature;
            const value = feature?.properties?.parcelId || feature?.properties?.parcel_id || feature?.properties?.id;
            if (value !== undefined && ids.has(String(value))) features.push(feature);
        });
        return features;
    }

    function rebuildProposalInteraction3D() {
        if (!isActive || !proposalInteractionGroup) return;
        disposeDraftPreviewChildren(proposalInteractionGroup);
        const storage = window.proposalStorage;
        if (!storage || typeof storage.getAllProposals !== 'function') return;
        const selectedKey = window.ProposalSelection?.getKey?.() || null;
        storage.getAllProposals().forEach(proposal => {
            try {
            const proposalId = proposalKey3D(proposal);
            if (!proposalId) return;
            // Reparcellization is land-administration scaffolding under the whole plan: its
            // pick surface blanketed the area and intercepted clicks meant for the buildings
            // standing on it. It stays selectable from lists/panels, never from map clicks.
            if (proposal.reparcellization && !proposal.buildingProposal && !proposal.structureProposal
                && !proposal.roadProposal) return;
            // Parked (unapplied) ideas stay off the map entirely; they only render while
            // selected, as a preview of where they would land when applied.
            const applied = proposalApplied3D(proposal);
            if (!applied && proposalId !== selectedKey) return;
            let features = collectSourcePreviewFeatures(proposal);
            if (!features.length) features = proposalParcelFeatures3D(proposal);
            if (!features.length) return;
            const wrapper = new THREE.Group();
            wrapper.userData.proposalId = proposalId;
            wrapper.userData.isProposalSurface = true;
            proposalInteractionGroup.add(wrapper);
            const isBuilding = !!(proposal.buildingProposal || proposal.buildingGeometry || proposal.geometry?.buildings);
            features.forEach(feature => {
                const before = new Set(wrapper.children);
                addDraftPreviewFeature3D(feature, wrapper, applied ? 'source' : 'draft', isBuilding ? 'buildings' : 'proposal');
                const parcelId = feature?.properties?.parcelId || feature?.properties?.parcel_id || feature?.properties?.id
                    || proposal.parentParcelIds?.[0] || null;
                wrapper.children.filter(child => !before.has(child)).forEach(child => {
                    child.traverse?.(object => {
                        object.userData = object.userData || {};
                        object.userData.proposalId = proposalId;
                        object.userData.isProposalSurface = true;
                        if (parcelId !== null && parcelId !== undefined) object.userData.parcelId = String(parcelId);
                        // Applied proposals already render their real geometry (buildings,
                        // corridors, parks); this copy is a pick target only. A visible copy
                        // sits coplanar with the real mesh and z-fights (green/grey flicker).
                        if (applied) {
                            // Multi-material meshes exist here (wall/cap arrays): cloning must
                            // handle arrays, and any single failure must not abort the traverse —
                            // a partially-processed copy stays VISIBLE source-white and washes the
                            // real coloured mesh out ("whitening" bug, three times over).
                            try {
                                if (object.isMesh && object.material) {
                                    const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
                                    const cloned = sourceMaterials.map(m => {
                                        const c = m.clone();
                                        c.transparent = true;
                                        c.opacity = 0;
                                        c.depthWrite = false;
                                        return c;
                                    });
                                    object.material = Array.isArray(object.material) ? cloned : cloned[0];
                                } else if (object.isLine || object.isLineSegments) {
                                    object.visible = false;
                                }
                            } catch (materialError) {
                                // Last resort: an unpatchable pick object must not stay visible.
                                object.visible = false;
                            }
                        }
                    });
                });
            });
            if (!applied && selectedKey && String(selectedKey) === proposalId) {
                wrapper.traverse(object => {
                    const materialsToHighlight = Array.isArray(object.material) ? object.material : [object.material].filter(Boolean);
                    materialsToHighlight.forEach(material => {
                        try {
                            material.color?.set?.(0xf59e0b);
                            material.opacity = Math.max(Number(material.opacity) || 0, 0.88);
                            material.transparent = true;
                            material.needsUpdate = true;
                        } catch (_) { }
                    });
                    object.renderOrder = Math.max(Number(object.renderOrder) || 0, 9300);
                });
            }
            } catch (proposalError) {
                console.warn('[3D] proposal pick surface failed; skipping one proposal', proposalError);
            }
        });
    }

    function buildParks3D(flatTarget, decoTarget) {
        const parks = (typeof window !== 'undefined' && Array.isArray(window.parks)) ? window.parks : [];
        if (!parks || parks.length === 0) return;
        // Use polygonOffset to float slightly over base to avoid z-fighting and flicker
        const grassMat = new THREE.MeshLambertMaterial({ color: 0x1b5e20, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
        const flowerMat = new THREE.MeshLambertMaterial({ color: 0xf472b6, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
        const waterMat = new THREE.MeshPhongMaterial({ color: 0x2b6cb0, specular: 0x1f3a60, shininess: 40, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
        const pathLineMat = new THREE.LineBasicMaterial({ color: 0xdfe8d6, depthTest: false });

        parks.forEach(p => {
            try {
                if (!p || !p.geometry) return;
                // Ground at slight z offset
                const groundMeshes = polygonFeatureToMeshes(p, grassMat, 0.06, 0);
                groundMeshes.forEach(m => { m.userData.isParkGround = true; flatTarget.add(m); });

                // Draw ponds (slightly above ground)
                const deco = (p.properties && p.properties.decorations) ? p.properties.decorations : null;
                if (deco && Array.isArray(deco.ponds)) {
                    deco.ponds.forEach(ring => {
                        try {
                            const feature = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} };
                            const waterMeshes = polygonFeatureToMeshes(feature, waterMat, 0.065, 0);
                            waterMeshes.forEach(m => flatTarget.add(m));
                        } catch (_) { }
                    });
                }

                // Draw footpaths as lines above ground (ensure visible over ponds/ground)
                if (deco && Array.isArray(deco.paths)) {
                    deco.paths.forEach(pathCoords => {
                        try {
                            const feature = { type: 'Feature', geometry: { type: 'LineString', coordinates: pathCoords }, properties: {} };
                            const line = lineFeatureToLine(feature, pathLineMat, 0.075);
                            if (line) {
                                // Elevate and ensure render on top
                                line.renderOrder = 9999;
                                if (line.material) { line.material.depthTest = false; }
                                // If it's a Group (MultiLineString), apply to children
                                if (line.isGroup) {
                                    line.traverse(obj => {
                                        if (obj.isLine) {
                                            obj.renderOrder = 9999;
                                            if (obj.material) obj.material.depthTest = false;
                                        }
                                    });
                                }
                                decoTarget.add(line);
                            }
                        } catch (_) { }
                    });
                }

                // Flowerbeds: pink patches slightly above the grass (mirrors the 2D rendering —
                // they were previously not rendered in 3D at all).
                if (deco && Array.isArray(deco.flowerbeds)) {
                    deco.flowerbeds.forEach(ring => {
                        try {
                            const feature = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} };
                            polygonFeatureToMeshes(feature, flowerMat, 0.068, 0).forEach(m => flatTarget.add(m));
                        } catch (_) { }
                    });
                }

                // Benches: user-placed first-class objects (same as trees).
                if (deco && Array.isArray(deco.benches)) {
                    deco.benches.forEach(bench => {
                        try {
                            const coord = Array.isArray(bench?.coordinate) ? bench.coordinate : bench;
                            if (!Array.isArray(coord) || coord.length < 2) return;
                            addBench3D(decoTarget, coord[0], coord[1], Number(bench?.bearing) || 0);
                        } catch (_) { }
                    });
                }

                const addTreeAt = (lng, lat) => addTree3D(decoTarget, lng, lat);

                // Trees: the STORED coordinates are the truth — auto-generated and user-placed
                // alike (the old random sampling ignored edits, so a repositioned tree never
                // moved in 3D). Random sampling remains only for legacy parks without tree data.
                const storedTrees = (deco && Array.isArray(deco.trees)) ? deco.trees.filter(coord => {
                    if (!Array.isArray(coord) || coord.length < 2) return false;
                    try { return turf.booleanPointInPolygon(turf.point(coord), p); } catch (_) { return true; }
                }) : [];
                if (storedTrees.length) {
                    storedTrees.forEach(coord => addTreeAt(coord[0], coord[1]));
                } else {
                    let area = 0; try { area = turf.area(p); } catch (_) { }
                    const count = Math.max(3, Math.min(60, Math.round(area / 2000)));
                    let bbox = null; try { bbox = turf.bbox(p); } catch (_) { }
                    if (!bbox) return;
                    let placed = 0, safety = 0;
                    while (placed < count && safety < count * 20) {
                        safety++;
                        const rnd = turf.randomPoint(1, { bbox }).features[0];
                        try { if (!turf.booleanPointInPolygon(rnd, p)) continue; } catch (_) { continue; }
                        // Avoid placing in ponds
                        try {
                            if (deco && Array.isArray(deco.ponds)) {
                                let inPond = false;
                                for (let i = 0; i < deco.ponds.length; i++) {
                                    const ring = deco.ponds[i];
                                    const pondPoly = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} };
                                    if (turf.booleanPointInPolygon(rnd, pondPoly)) { inPond = true; break; }
                                }
                                if (inPond) continue;
                            }
                        } catch (_) { }
                        addTreeAt(rnd.geometry.coordinates[0], rnd.geometry.coordinates[1]);
                        placed++;
                    }
                }
            } catch (_) { }
        });
    }

    // ---- Shared park/square furniture (module-scope materials, created once) ----
    let furnitureMats = null;
    function furnitureMaterials() {
        if (!furnitureMats) {
            furnitureMats = {
                wood: new THREE.MeshLambertMaterial({ color: 0x8a5a2b }),
                trunk: new THREE.MeshLambertMaterial({ color: 0x6d4c41 }),
                crown: new THREE.MeshLambertMaterial({ color: 0x2e7d32 }),
                stone: new THREE.MeshLambertMaterial({ color: 0xc9c9c2 }),
                table: new THREE.MeshLambertMaterial({ color: 0xf5f5f0 })
            };
        }
        return furnitureMats;
    }

    // Trunk + cone crown, deterministic per position (the same park renders the same forest).
    function addTree3D(target, lng, lat) {
        const [x, y] = latLngToXY(lat, lng);
        const mats = furnitureMaterials();
        const random = treeRng(lng, lat);
        const trunkH = 3 + random * 2;
        const crownH = 4 + random * 3;
        const trunkR = 0.45 + random * 0.35;
        const crownR = 1.8 + random * 1.2;
        const trunkGeo = new THREE.CylinderGeometry(trunkR, trunkR, trunkH, 8);
        trunkGeo.rotateX(Math.PI / 2); // stand upright along Z
        trunkGeo.translate(x, y, trunkH / 2);
        target.add(new THREE.Mesh(trunkGeo, mats.trunk));
        const crownGeo = new THREE.ConeGeometry(crownR, crownH, 8);
        crownGeo.rotateX(Math.PI / 2);
        crownGeo.translate(x, y, trunkH + crownH / 2);
        target.add(new THREE.Mesh(crownGeo, mats.crown));
    }

    // A bench: seat slab + backrest + legs, rotated to `bearing` (degrees from north).
    function addBench3D(target, lng, lat, bearingDeg = 0) {
        const [x, y] = latLngToXY(lat, lng);
        const wood = furnitureMaterials().wood;
        const group = new THREE.Group();
        const seatGeo = new THREE.BoxGeometry(1.7, 0.55, 0.1);
        seatGeo.translate(0, 0, 0.45);
        group.add(new THREE.Mesh(seatGeo, wood));
        const backGeo = new THREE.BoxGeometry(1.7, 0.08, 0.5);
        backGeo.translate(0, -0.28, 0.75);
        group.add(new THREE.Mesh(backGeo, wood));
        [-0.7, 0.7].forEach(offset => {
            const legGeo = new THREE.BoxGeometry(0.08, 0.45, 0.45);
            legGeo.translate(offset, 0, 0.22);
            group.add(new THREE.Mesh(legGeo, wood));
        });
        group.position.set(x, y, 0.06);
        group.rotation.z = ((90 - (Number(bearingDeg) || 0)) * Math.PI) / 180;
        target.add(group);
    }

    // A restaurant/terrace table (the 2D "plate" stall): round top on a centre leg.
    function addTable3D(target, lng, lat) {
        const [x, y] = latLngToXY(lat, lng);
        const mats = furnitureMaterials();
        const legGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.72, 8);
        legGeo.rotateX(Math.PI / 2);
        legGeo.translate(x, y, 0.06 + 0.36);
        target.add(new THREE.Mesh(legGeo, mats.stone));
        const topGeo = new THREE.CylinderGeometry(0.75, 0.75, 0.06, 20);
        topGeo.rotateX(Math.PI / 2);
        topGeo.translate(x, y, 0.06 + 0.75);
        target.add(new THREE.Mesh(topGeo, mats.table));
    }

    // A statue: stone pedestal + simple standing figure.
    function addStatue3D(target, lng, lat) {
        const [x, y] = latLngToXY(lat, lng);
        const stone = furnitureMaterials().stone;
        const pedGeo = new THREE.BoxGeometry(1.4, 1.4, 1.0);
        pedGeo.translate(x, y, 0.06 + 0.5);
        target.add(new THREE.Mesh(pedGeo, stone));
        const bodyGeo = new THREE.CylinderGeometry(0.32, 0.45, 1.9, 10);
        bodyGeo.rotateX(Math.PI / 2);
        bodyGeo.translate(x, y, 0.06 + 1.0 + 0.95);
        target.add(new THREE.Mesh(bodyGeo, stone));
        const headGeo = new THREE.SphereGeometry(0.3, 10, 10);
        headGeo.translate(x, y, 0.06 + 1.0 + 1.9 + 0.25);
        target.add(new THREE.Mesh(headGeo, stone));
    }

    let squareSurfaceMats = null;
    function squareSurfaceMaterials() {
        if (!squareSurfaceMats) {
            const texture = squarePaving.createSquarePavingTexture(THREE, document, renderer);
            squareSurfaceMats = {
                paving: new THREE.MeshLambertMaterial({
                    color: texture ? 0xffffff : 0xc8c0ae,
                    map: texture || null,
                    polygonOffset: true,
                    polygonOffsetFactor: -2,
                    polygonOffsetUnits: -2
                }),
                border: new THREE.LineBasicMaterial({ color: 0x756f63, transparent: true, opacity: 0.75 }),
                rim: new THREE.MeshLambertMaterial({ color: 0x9a9a9a }),
                water: new THREE.MeshPhongMaterial({ color: 0x3a8ad3, specular: 0x1f4f7a, shininess: 60 })
            };
        }
        return squareSurfaceMats;
    }

    // Build Squares (running-bond paving + furniture/fountains)
    function buildSquares3D(flatTarget, decoTarget) {
        const squares = (typeof window !== 'undefined' && Array.isArray(window.squares)) ? window.squares : [];
        if (!squares || squares.length === 0) return;

        const squareMats = squareSurfaceMaterials();
        const stoneMat = squareMats.paving;
        const rimMat = squareMats.rim;
        const waterMat = squareMats.water;

        squares.forEach(sq => {
            try {
                if (!sq || !sq.geometry) return;
                // Ground slightly above base to avoid z-fighting
                const groundMeshes = polygonFeatureToMeshes(sq, stoneMat, 0.06, 0);
                groundMeshes.forEach(m => { m.userData.isSquareGround = true; flatTarget.add(m); });
                const borderLines = polygonFeatureToBorderLines(sq, squareMats.border, 0.075);
                borderLines.forEach(line => { line.userData.isSquarePavingBorder = true; flatTarget.add(line); });

                const dec = sq.properties && sq.properties.decorations;
                if (!dec) return;

                // Furniture from the geometry editor (all first-class objects there).
                (Array.isArray(dec.trees) ? dec.trees : []).forEach(coord => {
                    try { if (Array.isArray(coord)) addTree3D(decoTarget, coord[0], coord[1]); } catch (_) { }
                });
                (Array.isArray(dec.benches) ? dec.benches : []).forEach(bench => {
                    try {
                        const coord = Array.isArray(bench?.coordinate) ? bench.coordinate : bench;
                        if (Array.isArray(coord)) addBench3D(decoTarget, coord[0], coord[1], Number(bench?.bearing) || 0);
                    } catch (_) { }
                });
                (Array.isArray(dec.stalls) ? dec.stalls : []).forEach(coord => {
                    try { if (Array.isArray(coord)) addTable3D(decoTarget, coord[0], coord[1]); } catch (_) { }
                });
                (Array.isArray(dec.statues) ? dec.statues : []).forEach(coord => {
                    try { if (Array.isArray(coord)) addStatue3D(decoTarget, coord[0], coord[1]); } catch (_) { }
                });

                // Fountains: edited squares store an ARRAY; legacy squares a single `fountain`.
                const fountains = (Array.isArray(dec.fountains) && dec.fountains.length)
                    ? dec.fountains
                    : (Array.isArray(dec.fountain) ? [dec.fountain] : []);
                fountains.forEach(fountainCoord => {
                if (!Array.isArray(fountainCoord) || fountainCoord.length < 2) return;
                const [lng, lat] = fountainCoord;
                const [x, y] = latLngToXY(lat, lng);

                // Simple fountain: pedestal + basin + water disk + small spout
                const group = new THREE.Group();

                // Pedestal
                const pedH = 0.3;
                const pedR = 0.8;
                const pedGeo = new THREE.CylinderGeometry(pedR, pedR, pedH, 24);
                pedGeo.rotateX(Math.PI / 2);
                pedGeo.translate(x, y, 0.06 + pedH / 2);
                const pedestal = new THREE.Mesh(pedGeo, rimMat);
                group.add(pedestal);

                // Basin rim
                const basinH = 0.2;
                const basinR = 2.0;
                const basinGeo = new THREE.CylinderGeometry(basinR, basinR, basinH, 48, 1, false);
                basinGeo.rotateX(Math.PI / 2);
                basinGeo.translate(x, y, 0.06 + pedH + basinH / 2);
                const basin = new THREE.Mesh(basinGeo, rimMat);
                group.add(basin);

                // Water disk inside basin
                const waterR = basinR * 0.85;
                const waterGeo = new THREE.CylinderGeometry(waterR, waterR, 0.06, 48);
                waterGeo.rotateX(Math.PI / 2);
                waterGeo.translate(x, y, 0.06 + pedH + basinH + 0.03);
                const water = new THREE.Mesh(waterGeo, waterMat);
                water.renderOrder = 8000;
                group.add(water);

                // Central spout
                const spoutH = 0.8;
                const spoutR = 0.12;
                const spoutGeo = new THREE.CylinderGeometry(spoutR, spoutR, spoutH, 12);
                spoutGeo.rotateX(Math.PI / 2);
                spoutGeo.translate(x, y, 0.06 + pedH + basinH + spoutH / 2);
                const spout = new THREE.Mesh(spoutGeo, waterMat);
                spout.material.transparent = true;
                spout.material.opacity = 0.9;
                group.add(spout);

                decoTarget.add(group);
                });
            } catch (_) { }
        });
    }

    // The paved/green surround of an applied freeform building proposal — the parcel area around
    // its buildings. Same two surfaces as squares and parks, minus all the furniture: it is ground
    // treatment, not a designed structure. See building-ground.js.
    function buildProposalGrounds3D(flatTarget) {
        const api = (typeof window !== 'undefined') ? window.BuildingGround : null;
        if (!api || typeof proposalStorage === 'undefined' || typeof proposalStorage.getAllProposals !== 'function') return;
        let surfaces = [];
        try {
            surfaces = api.appliedSurfaces(proposalStorage.getAllProposals(), isApplied);
        } catch (error) {
            console.error('[three-mode] building ground surfaces could not be collected', error);
            return;
        }
        if (!surfaces.length) return;

        const pavingMat = squareSurfaceMaterials().paving;
        const grassMat = new THREE.MeshLambertMaterial({
            color: 0x1b5e20, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
        });
        surfaces.forEach(surface => {
            try {
                const feature = { type: 'Feature', properties: {}, geometry: surface.geometry };
                const material = surface.treatment === 'paved' ? pavingMat : grassMat;
                polygonFeatureToMeshes(feature, material, 0.06, 0).forEach(mesh => {
                    mesh.userData.isProposalGround = true;
                    flatTarget.add(mesh);
                });
            } catch (error) {
                console.error('[three-mode] failed to build a proposal ground surface', surface.proposalId, error);
            }
        });
    }

    // Build Lakes (shore + water + fish)
    function buildLakes3D(flatTarget, decoTarget) {
        const lakes = (typeof window !== 'undefined' && Array.isArray(window.lakes)) ? window.lakes : [];
        if (!lakes || lakes.length === 0) return;

        const shoreMat = new THREE.MeshLambertMaterial({ color: 0xf3d7a0 });
        const transitionMat = new THREE.MeshLambertMaterial({ color: 0x3c92d6 });
        const waterMat = new THREE.MeshPhongMaterial({ color: 0x3fa7f5, specular: 0x1b6fa8, shininess: 50, transparent: true, opacity: 0.88 });
        const fishMat = new THREE.MeshLambertMaterial({ color: 0xffa500 });

        lakes.forEach(lake => {
            try {
                if (!lake || !lake.geometry) return;

                // Ensure lake graphics are generated
                try {
                    if (typeof ensureLakeGraphics === 'function') ensureLakeGraphics(lake);
                } catch (_) { }

                const graphics = lake.properties && lake.properties.lakeGraphics;
                const shoreGeom = graphics && graphics.shore ? graphics.shore : lake.geometry;
                const waterGeom = graphics && graphics.water ? graphics.water : null;
                const transitionGeom = graphics && graphics.transition ? graphics.transition : null;

                // RECESSED basin: the parcel ground has the lake footprint cut out (see
                // buildParcels3D), so the lake digs below grade instead of floating above it.
                const SHELF_Z = -0.7;   // shallow shelf
                const WATER_Z = -1.4;   // water surface depth
                // Sandy beach stays at grade, as a solid going down to the water depth so its
                // outer face closes the pit wall where it meets the surrounding ground.
                if (shoreGeom) {
                    const shoreFeature = { type: 'Feature', geometry: shoreGeom, properties: {} };
                    const shoreMeshes = polygonFeatureToMeshes(shoreFeature, shoreMat, WATER_Z - 0.2, 0.26 - (WATER_Z - 0.2));
                    shoreMeshes.forEach(m => { m.userData.isLakeShore = true; flatTarget.add(m); });
                }

                // Shallow shelf: a solid band from the deep floor up to the shelf level — its
                // sides close the step down to the open water.
                if (transitionGeom) {
                    const transitionFeature = { type: 'Feature', geometry: transitionGeom, properties: {} };
                    const transitionMeshes = polygonFeatureToMeshes(transitionFeature, transitionMat, WATER_Z - 0.2, (SHELF_Z - (WATER_Z - 0.2)));
                    transitionMeshes.forEach(m => flatTarget.add(m));
                }

                // Open water surface, below grade, over a dark lake bed (the water is slightly
                // transparent, so the bed is what reads as depth).
                const bedMat = new THREE.MeshLambertMaterial({ color: 0x14324a });
                if (waterGeom) {
                    const waterFeature = { type: 'Feature', geometry: waterGeom, properties: {} };
                    polygonFeatureToMeshes(waterFeature, bedMat, WATER_Z - 0.2, 0).forEach(m => flatTarget.add(m));
                    const waterMeshes = polygonFeatureToMeshes(waterFeature, waterMat, WATER_Z, 0);
                    waterMeshes.forEach(m => flatTarget.add(m));
                } else {
                    // Fallback: render entire lake as water if no water geometry
                    polygonFeatureToMeshes(lake, bedMat, WATER_Z - 0.2, 0).forEach(m => flatTarget.add(m));
                    const waterMeshes = polygonFeatureToMeshes(lake, waterMat, WATER_Z, 0);
                    waterMeshes.forEach(m => flatTarget.add(m));
                }

                // Render fish as small decorative elements
                const fishCoords = (graphics && Array.isArray(graphics.fish)) ? graphics.fish : [];
                fishCoords.forEach(([lng, lat]) => {
                    try {
                        const [x, y] = latLngToXY(lat, lng);
                        // Simple fish: small ellipsoid
                        const fishGeo = new THREE.SphereGeometry(0.15, 8, 8);
                        const fish = new THREE.Mesh(fishGeo, fishMat);
                        fish.scale.set(1.5, 0.6, 0.4); // Make it fish-shaped
                        fish.position.set(x, y, -1.32); // just above the recessed water surface
                        decoTarget.add(fish);
                    } catch (_) { }
                });
            } catch (_) { }
        });
    }

    // Shared procedural station models are authored in the isochrone app's conventional
    // Three.js frame (X right, Y up, Z forward). This scene uses X east, Y north, Z up, so each
    // model gets one fixed axis adapter and an outer geographic-bearing rotation.
    function buildTransitStations3D(targetGroup) {
        const library = (typeof window !== 'undefined') ? window.TransitStationModels : null;
        const stations = (typeof window !== 'undefined' && Array.isArray(window.transitStations))
            ? window.transitStations
            : [];
        if (!targetGroup || !library || typeof library.createStationModel !== 'function' || !stations.length) return;

        stations.forEach(station => {
            try {
                const type = window.TransitStations?.stationType?.(station)
                    || library.normalizeType?.(station?.properties?.stationType);
                const center = window.TransitStations?.stationCenter?.(station)
                    || station?.properties?.center;
                if (!type || !Array.isArray(center) || center.length < 2) return;
                const [x, y] = coordsToXY(center);
                const bearing = Number(window.TransitStations?.stationBearing?.(station)
                    ?? station?.properties?.bearing
                    ?? 0);
                const placement = new THREE.Group();
                placement.name = `TransitStation:${type}`;
                placement.position.set(x, y, 0.04);
                placement.rotation.z = Math.PI - (Number.isFinite(bearing) ? bearing : 0) * Math.PI / 180;

                const model = library.createStationModel(THREE, type, {
                    name: station?.properties?.name || library.specFor?.(type)?.label,
                    platformHeightM: Number.isFinite(Number(station?.properties?.platformHeightM))
                        ? Number(station.properties.platformHeightM)
                        : undefined,
                    document
                });
                model.rotation.x = Math.PI / 2;
                placement.add(model);
                const proposalId = station?.properties?.proposalId;
                placement.traverse(object => {
                    object.userData = object.userData || {};
                    object.userData.isTransitStation = true;
                    object.userData.stationType = type;
                    if (proposalId !== undefined && proposalId !== null) object.userData.proposalId = String(proposalId);
                });
                targetGroup.add(placement);
            } catch (error) {
                console.warn('[3D] Failed to build a transit station:', error);
            }
        });
    }

    // Existing tram/rail alignments are context; an applied road or track PROPOSAL replaces the
    // street it runs down, and the raised trackbed (z≈0.33–0.55) would otherwise float over the
    // proposal deck (z=0.05) and overpower it. Clip the tram LINES so the stretch inside an applied
    // road/track footprint is not drawn, while the rest — a junction off to the side, the line beyond
    // the proposal — stays. Best-effort turf; on any failure the line passes through unchanged.
    function clipTransitLinesOutsideProposals(featureCollection, footprints) {
        if (typeof turf === 'undefined' || !Array.isArray(footprints) || !footprints.length) return featureCollection;
        const T = turf;
        if (typeof T.lineSplit !== 'function' || typeof T.booleanPointInPolygon !== 'function') return featureCollection;
        let mask = null;
        try { footprints.forEach(fp => { mask = mask ? (T.union(mask, fp) || mask) : fp; }); } catch (_) { mask = null; }
        if (!mask) return featureCollection;
        let maskBbox = null;
        try { maskBbox = T.bbox(mask); } catch (_) { maskBbox = null; }
        const bboxHit = (b) => !maskBbox || !b
            || (b[0] <= maskBbox[2] && maskBbox[0] <= b[2] && b[1] <= maskBbox[3] && maskBbox[1] <= b[3]);
        const insideMask = (pt) => { try { return T.booleanPointInPolygon(pt, mask); } catch (_) { return false; } };
        const kept = [];
        ((featureCollection && featureCollection.features) || []).forEach(feature => {
            const geom = feature && feature.geometry;
            if (!geom) return;
            const lines = geom.type === 'MultiLineString'
                ? geom.coordinates.map(c => T.lineString(c, feature.properties || {}))
                : (geom.type === 'LineString' ? [feature] : null);
            if (!lines) { kept.push(feature); return; } // non-line features pass through untouched
            lines.forEach(line => {
                let lb = null; try { lb = T.bbox(line); } catch (_) { }
                if (!bboxHit(lb)) { kept.push(line); return; } // nowhere near a proposal — keep whole
                let pieces;
                try {
                    const split = T.lineSplit(line, mask);
                    pieces = (split && split.features && split.features.length) ? split.features : [line];
                } catch (_) { pieces = [line]; }
                pieces.forEach(piece => {
                    try {
                        const mid = T.along(piece, (T.length(piece) || 0) / 2);
                        if (!insideMask(mid)) kept.push(piece);
                    } catch (_) { kept.push(piece); }
                });
            });
        });
        return T.featureCollection(kept);
    }

    // Applied road/track proposal footprints (polygons), for clipping the existing tram under them.
    function collectAppliedCorridorFootprints() {
        const footprints = [];
        try {
            if (typeof proposalStorage === 'undefined' || typeof collectProposalFeatureSets !== 'function'
                || typeof isApplied !== 'function') return footprints;
            (proposalStorage.getAllProposals() || []).forEach(p => {
                if (!p || !p.roadProposal || !isApplied(p, p.roadProposal)) return;
                const sets = collectProposalFeatureSets(p) || {};
                (sets.primaryFeatures || []).forEach(f => {
                    if (f && f.geometry && /Polygon/.test(f.geometry.type)) footprints.push(f);
                });
            });
        } catch (_) { }
        return footprints;
    }

    // Render the same immutable alignments used by 2D station snapping. Sources are loaded once,
    // while mesh construction is clipped to this scene's initial content bounds and never streams
    // additional geometry as the user pans the frozen 3D snapshot.
    function buildExistingTransitAlignments3D(targetScene) {
        const registry = window.TransitAlignments;
        if (!registry || typeof registry.ensureLoaded !== 'function') return;

        const attach = loadedSources => {
            if (!isActive || !scene || scene !== targetScene) return; // scene changed mid-fetch
            const content = computeContentBoundsXY();
            const diagonal = Math.max(1, Math.hypot(content.width || 0, content.height || 0));
            const maxRadius = Math.min(7000, Math.max(2000, diagonal * 1.5));
            const root = new THREE.Group();
            root.name = 'ExistingTransitAlignments';
            // The applied road/track proposals win: clip the existing tram out from under them.
            const proposalFootprints = collectAppliedCorridorFootprints();
            for (const source of loadedSources || []) {
                const featureCollection = clipTransitLinesOutsideProposals(source.featureCollection, proposalFootprints);
                let child = null;
                if (source.render3d === 'elevated' && typeof window.buildElevatedRail3D === 'function') {
                    child = window.buildElevatedRail3D(featureCollection, coordsToXY, { maxRadius });
                } else if (source.render3d === 'surface' && typeof window.buildSurfaceRail3D === 'function') {
                    child = window.buildSurfaceRail3D(featureCollection, coordsToXY, {
                        maxRadius,
                        gaugeM: source.mode === 'tram' ? 1.0 : 1.435
                    });
                }
                if (!child) continue;
                child.userData.sourceId = source.id;
                child.userData.alignmentMode = source.mode;
                root.add(child);
            }
            if (!root.children.length) return;
            existingTransitAlignmentGroup = root;
            const builtPolicy = buildingDisplayPolicy.resolveBuiltDisplayPolicy(builtDisplay);
            existingTransitAlignmentGroup.visible = builtPolicy.showExistingRail
                && isolatedParcelId === null
                && isolatedProposalId === null;
            targetScene.add(existingTransitAlignmentGroup);
        };

        registry.ensureLoaded()
            .then(() => attach(registry.getLoadedSources?.() || []))
            .catch(error => console.error('[three-mode] existing transit alignments failed to load', error));
    }

    // estimateBuildingHeightMeters is the shared estimator in frontend/js/building-height.js
    // (loaded first). It accepts a feature or props, so the call sites below pass unchanged. It
    // used to live here with a NUMBER-only height check that dropped string heights to the default.

    // Reparcellization plans that have NOT been applied to the map. An applied plan has already
    // replaced its parent parcels inside parcelLayer, so buildParcels3D draws the new parcels and
    // there is nothing to add here. An unapplied one exists only on the proposal — without this the
    // 3D view showed the untouched original parcel and the proposed subdivision was invisible.
    function getPlannedReparcellizationProposals() {
        try {
            const storage = (typeof window !== 'undefined') ? window.proposalStorage : null;
            if (!storage || typeof storage.getAllProposals !== 'function') return [];
            return storage.getAllProposals().filter(p => {
                if (!p || !p.reparcellization) return false;
                if (!Array.isArray(p.reparcellization.polygons) || !p.reparcellization.polygons.length) return false;
                if (isApplied(p, p.reparcellization)) return false;
                return true;
            });
        } catch (error) {
            console.warn('[3D] Failed to enumerate planned reparcellization proposals:', error);
            return [];
        }
    }

    // Draw each planned plot as a flat slab just above the parcel plane, tinted with the owner
    // colour the reparcellization editor assigned it, and outline it so the new boundaries read
    // clearly against the parcel underneath.
    function buildPlannedReparcellization3D(targetGroup) {
        if (!targetGroup) return;
        const proposals = getPlannedReparcellizationProposals();
        if (!proposals.length) return;

        proposals.forEach(proposal => {
            proposal.reparcellization.polygons.forEach(slice => {
                if (!slice || !slice.geometry) return;
                try {
                    const feature = { type: 'Feature', geometry: slice.geometry, properties: {} };
                    let color = 0xcccccc;
                    try {
                        if (typeof slice.color === 'string' && slice.color.startsWith('#')) {
                            color = parseInt(slice.color.slice(1), 16);
                        }
                    } catch (_) { }

                    const fillMat = new THREE.MeshLambertMaterial({
                        color,
                        transparent: true,
                        opacity: 0.75,
                        polygonOffset: true,
                        polygonOffsetFactor: -2,
                        polygonOffsetUnits: -2
                    });
                    const meshes = polygonFeatureToMeshes(feature, fillMat, 0.08, 0);
                    meshes.forEach(m => { m.userData.isPlannedReparcelPlot = true; targetGroup.add(m); });

                    const borders = polygonFeatureToBorderLines(feature, materials.sliceEdges, 0.12);
                    borders.forEach(line => { line.userData.isPlannedReparcelPlot = true; targetGroup.add(line); });
                } catch (error) {
                    console.warn('[3D] Failed to draw a planned reparcellization plot:', error);
                }
            });
        });
    }

    // Recessed lakes and underground station entrances need openings in the otherwise opaque
    // parcel plane. The underground hall itself remains covered; surface/elevated stations do not
    // cut the ground at all.
    function groundCutFootprintFeatures() {
        const lakes = (typeof window !== 'undefined' && Array.isArray(window.lakes)) ? window.lakes : [];
        const lakeCuts = lakes
            .filter(lake => lake && lake.geometry)
            .map(lake => ({ type: 'Feature', properties: {}, geometry: lake.geometry }));
        const stationCuts = (typeof window !== 'undefined' && Array.isArray(window.transitStations) ? window.transitStations : [])
            .flatMap(station => {
                const geometries = window.TransitStations?.stationSurfaceCutouts?.(station) || [];
                return geometries
                    .filter(geometry => geometry?.type && Array.isArray(geometry.coordinates))
                    .map(geometry => ({ type: 'Feature', properties: {}, geometry }));
            });
        const underpassCuts = [];
        try {
            (proposalStorage?.getAllProposals?.() || []).forEach(proposal => {
                if (!isApplied(proposal, proposal?.roadProposal)) return;
                const definition = corridorProposalDefinition(proposal);
                (definition?.gradeSeparations || []).forEach(record => {
                    if (record?.mode !== 'underpass') return;
                    let geometry = record.footprint?.geometry || record.footprint || null;
                    if (!geometry?.type && record.from && record.crossing && record.to && typeof turf !== 'undefined') {
                        try {
                            geometry = turf.buffer(turf.lineString([
                                [record.from.lng, record.from.lat],
                                [record.crossing.lng, record.crossing.lat],
                                [record.to.lng, record.to.lat]
                            ]), Math.max(1, Number(record.width) || 2) / 2, { units: 'meters' })?.geometry || null;
                        } catch (_) { geometry = null; }
                    }
                    if (geometry?.type) underpassCuts.push({ type: 'Feature', properties: {}, geometry });
                });
            });
        } catch (error) {
            console.warn('[three-mode] Could not derive pedestrian underpass openings', error);
        }
        return lakeCuts.concat(stationCuts, underpassCuts);
    }

    function cutGroundOpeningsOutOfFeature(feature, cutFeatures) {
        if (!cutFeatures.length || typeof turf === 'undefined') return feature;
        let current = feature;
        for (const cut of cutFeatures) {
            try {
                if (!turf.booleanIntersects(current, cut)) continue;
                const remainder = turf.difference(current, cut);
                if (!remainder) return null;
                current = remainder;
            } catch (error) {
                console.error('[three-mode] ground opening failed for a parcel', error);
            }
        }
        return current;
    }

    function buildParcels3D(targetGroup) {
        if (typeof parcelLayer === 'undefined' || !parcelLayer) return;
        const groundCutFeatures = groundCutFootprintFeatures();
        // parcels at z=0
        parcelLayer.getLayers().forEach(l => {
            const f = l.feature;
            if (!f || !f.geometry) return;
            const props = f.properties || {};
            let isRoadParcel = props.isRoad === true;
            try {
                if (!isRoadParcel && props.parcelId && typeof window.isRoadParcel === 'function') {
                    isRoadParcel = window.isRoadParcel(props.parcelId);
                }
            } catch (_) { }

            const fillMat = isRoadParcel ? materials.roads : materials.parcels;
            const edgeMat = isRoadParcel ? materials.roadLines : materials.parcelEdges;

            const parcelId = props.parcelId != null ? String(props.parcelId) : null;
            const tag = (obj) => {
                obj.userData.isParcel = true;
                if (parcelId) obj.userData.parcelId = parcelId;
            };
            const groundFeature = cutGroundOpeningsOutOfFeature(f, groundCutFeatures);
            if (groundFeature) {
                const meshes = polygonFeatureToMeshes(groundFeature, fillMat, 0, 0);
                meshes.forEach(m => { tag(m); targetGroup.add(m); });
            }
            const borders = polygonFeatureToBorderLines(f, edgeMat, 0.5);
            borders.forEach(line => { tag(line); targetGroup.add(line); });
        });
    }

    function rebuildParcelGround3D() {
        if (!isActive || !flatGroup) return;
        for (let index = flatGroup.children.length - 1; index >= 0; index--) {
            const child = flatGroup.children[index];
            if (child?.userData?.isParcel) flatGroup.remove(child);
        }
        buildParcels3D(flatGroup);
        applyParcelVisibilityForMode(derivedParcelVisibilityMode());
    }

    // Set of parcel IDs that exist *only* because of an applied/executed proposal.
    // Built mode hides them so the 3D view reflects the pre-proposal cadastre.
    // (The corresponding ancestor parcels were removed from parcelLayer at apply
    // time; restoring them would need to redraw from each proposal's
    // parentFeatures and is out of scope for this gate — Built mode currently
    // shows holes where proposals replaced the originals.)
    function getAppliedDescendantParcelIdSet() {
        const ids = new Set();
        try {
            for (const p of getAppliedProposals()) {
                const buckets = [];
                if (p.roadProposal && Array.isArray(p.roadProposal.childParcelIds)) buckets.push(p.roadProposal.childParcelIds);
                if (p.decideLaterProposal && Array.isArray(p.decideLaterProposal.childParcelIds)) buckets.push(p.decideLaterProposal.childParcelIds);
                if (p.reparcellization && Array.isArray(p.reparcellization.childParcelIds)) buckets.push(p.reparcellization.childParcelIds);
                if (p.buildingProposal && Array.isArray(p.buildingProposal.childParcelIds)) buckets.push(p.buildingProposal.childParcelIds);
                if (Array.isArray(p.childParcelIds)) buckets.push(p.childParcelIds);
                for (const arr of buckets) {
                    for (const id of arr) {
                        if (id != null) ids.add(String(id));
                    }
                }
            }
        } catch (e) {
            console.warn('[3D] getAppliedDescendantParcelIdSet failed:', e);
        }
        return ids;
    }

    function applyParcelVisibilityForMode(mode) {
        if (!flatGroup) return;
        if (mode !== 'built') {
            flatGroup.traverse(obj => {
                if (obj && obj.userData && obj.userData.isParcel) obj.visible = true;
            });
            return;
        }
        const descendantIds = getAppliedDescendantParcelIdSet();
        flatGroup.traverse(obj => {
            if (!obj || !obj.userData || !obj.userData.isParcel) return;
            const id = obj.userData.parcelId;
            obj.visible = !(id && descendantIds.has(id));
        });
    }

    function buildRoads3D(targetGroup) {
        // OSM lines as polylines at z=0.5m, DGU road parcels as filled at z=0.3m
        if (typeof window.osmRoadLayer !== 'undefined' && window.osmRoadLayer) {
            window.osmRoadLayer.getLayers().forEach(l => {
                const f = l.feature;
                if (!f || !f.geometry) return;
                const ln = lineFeatureToLine(f, materials.roadLines, 0.5);
                if (ln) targetGroup.add(ln);
            });
        }

        if (typeof window.wfsRoadUseLayer !== 'undefined' && window.wfsRoadUseLayer) {
            window.wfsRoadUseLayer.getLayers().forEach(l => {
                const f = l.feature;
                if (!f || !f.geometry) return;
                const meshes = polygonFeatureToMeshes(f, materials.roads, 0.3, 0);
                meshes.forEach(m => targetGroup.add(m));
            });
        }
    }

    // Corridor cross-sections in 3D. An applied road is a corridor parcel — one flat grey slab — and
    // this lays its lanes over it: carriageway and cycle paths flush with the road, sidewalks, verges
    // and medians raised to their kerb height. Colours and kerb heights come from CORRIDOR_LANE_TYPES,
    // the same table the 2D map reads, so a lane is retextured for both views in one edit.
    const corridorLaneMaterials = {};
    const corridorSymbolMaterials = {};
    const CORRIDOR_STRIP_Z = 0.05; // clear of the corridor parcel's own slab at z=0

    function corridorLaneMaterial(type) {
        if (!corridorLaneMaterials[type]) {
            const lane = (typeof CORRIDOR_LANE_TYPES !== 'undefined' && CORRIDOR_LANE_TYPES[type]) || {};
            corridorLaneMaterials[type] = new THREE.MeshLambertMaterial({
                color: new THREE.Color(lane.surface || '#2b2b2b'),
                emissive: 0x000000
            });
        }
        return corridorLaneMaterials[type];
    }

    // ---------------------------------------------------------------------------
    // Self-crossing strips
    //
    // A strip is ONE object with ONE colour, the same one the 2D map paints — the 3D mesh is built from
    // the very same strip polygon and the very same CORRIDOR_LANE_TYPES colour, no per-lane special work.
    // The ONE thing THREE can't do that Leaflet can is fill a SELF-CROSSING polygon (a star road, a loop):
    // Leaflet uses the even-odd rule and draws the thin band; THREE's earcut floods the whole enclosed
    // area (the "dark blob"). turf.unkinkPolygon doesn't help — it fills ~2x the band (the enclosed lobes
    // too). So for a self-crossing FLAT strip we lay the SAME band as a per-edge ribbon: a quad per
    // centre-line edge between the strip's own two offsets, overlapping itself where the road crosses —
    // which measures within ~10% of Leaflet's even-odd fill. Clean strips keep their crisp mitred earcut.
    // ---------------------------------------------------------------------------

    // Same colour as the ordinary lane material, but double-sided: the per-edge quads have mixed winding,
    // so their normals are forced to +Z (they are flat and horizontal) and both faces must draw.
    const corridorRibbonMaterials = {};
    function corridorRibbonMaterial(type) {
        if (!corridorRibbonMaterials[type]) {
            const lane = (typeof CORRIDOR_LANE_TYPES !== 'undefined' && CORRIDOR_LANE_TYPES[type]) || {};
            corridorRibbonMaterials[type] = new THREE.MeshLambertMaterial({
                color: new THREE.Color(lane.surface || '#2b2b2b'),
                emissive: 0x000000,
                side: THREE.DoubleSide
            });
        }
        return corridorRibbonMaterials[type];
    }

    // Does a strip's outline cross itself? Tested in the same XY frame the mesh is built in, so it agrees
    // with the guard inside arrayOfLngLatRingsToShape.
    function corridorStripRingSelfIntersects(polygon) {
        if (typeof window === 'undefined' || typeof window.ringSelfIntersectsXY !== 'function') return false;
        try {
            return window.ringSelfIntersectsXY(polygon.map(point => latLngToXY(point.lat, point.lng)));
        } catch (_) { return false; }
    }

    // Lay a FLAT strip as one quad per centre-line edge, spanning the strip's two offsets — a thin band
    // that overlaps itself where the road crosses (dark asphalt, not a flooded interior).
    function addFlatStripRibbon3D(targetGroup, points, offsetLeft, offsetRight, material, laneType) {
        if (!Array.isArray(points) || points.length < 2) return;
        const xy = points.map(point => latLngToXY(point.lat, point.lng));
        const positions = [];
        const z = CORRIDOR_STRIP_Z;
        for (let i = 0; i < xy.length - 1; i++) {
            const a = xy[i];
            const b = xy[i + 1];
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const len = Math.hypot(dx, dy);
            if (len < 1e-6) continue;
            const nx = -dy / len; // left normal (unit), same sign convention as offsetPolylinePlanar
            const ny = dx / len;
            const aL = [a[0] + nx * offsetLeft, a[1] + ny * offsetLeft];
            const bL = [b[0] + nx * offsetLeft, b[1] + ny * offsetLeft];
            const aR = [a[0] + nx * offsetRight, a[1] + ny * offsetRight];
            const bR = [b[0] + nx * offsetRight, b[1] + ny * offsetRight];
            positions.push(
                aL[0], aL[1], z, bL[0], bL[1], z, bR[0], bR[1], z,
                aL[0], aL[1], z, bR[0], bR[1], z, aR[0], aR[1], z
            );
        }
        if (!positions.length) return;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        // Flat and horizontal: force every normal up so the double-sided material lights it uniformly.
        const normals = new Float32Array(positions.length);
        for (let i = 2; i < normals.length; i += 3) normals[i] = 1;
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData.isCorridorStrip = true;
        mesh.userData.laneType = laneType;
        targetGroup.add(mesh);
    }

    const CORRIDOR_TERRAIN_STATION_SPACING_M = 4;
    const CORRIDOR_TERRAIN_SMOOTHING_RADIUS = 2; // local gross-outlier window, not a low-pass
    // A road must not follow one photogrammetry triangle seam or pothole. The residual-median
    // filter changes only locally unsupported stations, so broad terrain hollows and steady grades
    // remain intact while a single ~0.5 m LOD step cannot create a 15% road kink.
    const CORRIDOR_TERRAIN_OUTLIER_THRESHOLD_M = 0.45;
    const CORRIDOR_TERRAIN_VERTICAL_CURVE_PASSES = 8;
    const CORRIDOR_TERRAIN_MAX_NODATA_GAP_M = 16;
    const CORRIDOR_DGU_PROFILE_STEP_M = 20;
    const CORRIDOR_DGU_MAX_GAP_M = 40;
    // Keep the engineered formation deliberately clear of the Google support surface. Asphalt is
    // another CORRIDOR_STRIP_Z above this, so the visible carriageway is about 10 cm over the
    // sampled mesh instead of becoming coplanar with individual photogrammetry triangles.
    const CORRIDOR_TERRAIN_CLEARANCE_M = 0.05;

    function corridorFormationForPoints(points, sampleHeight, corridorProfile, verticalOffsetM, terrainReference) {
        const formation = window.__corridorTerrainFormation;
        if (!formation || typeof sampleHeight !== 'function' || !Array.isArray(points) || points.length < 2) return null;
        const xy = points.map(point => latLngToXY(point.lat, point.lng));
        const width = (typeof corridorProfileWidth === 'function')
            ? Number(corridorProfileWidth(corridorProfile)) : 0;
        let mercatorScale = 1;
        try {
            const origin = xyToLatLng(0, 0);
            if (window.__photorealFrame && typeof window.__photorealFrame.mercatorScaleFactor === 'function') {
                mercatorScale = window.__photorealFrame.mercatorScaleFactor(origin.lat);
            }
        } catch (_) { }
        if (!Number.isFinite(mercatorScale) || !(mercatorScale > 0)) mercatorScale = 1;
        const contextualSample = function (x, y, station) {
            return sampleHeight(x, y, {
                station: station,
                halfWidthSceneM: Number.isFinite(width) && width > 0
                    ? width * mercatorScale / 2 : 0
            });
        };
        const requestedOffset = Number.isFinite(verticalOffsetM)
            ? verticalOffsetM : CORRIDOR_TERRAIN_CLEARANCE_M;
        const buildOptions = {
            maxSpacingM: CORRIDOR_TERRAIN_STATION_SPACING_M,
            distanceScale: 1 / mercatorScale,
            smoothingRadiusStations: CORRIDOR_TERRAIN_SMOOTHING_RADIUS,
            outlierThresholdM: CORRIDOR_TERRAIN_OUTLIER_THRESHOLD_M,
            verticalCurvePasses: CORRIDOR_TERRAIN_VERTICAL_CURVE_PASSES,
            maxNoDataGapM: CORRIDOR_TERRAIN_MAX_NODATA_GAP_M,
            verticalOffsetM: requestedOffset
        };
        const visibleProfile = formation.buildFormation(xy, contextualSample, buildOptions);
        let profile = visibleProfile;
        if (terrainReference && terrainReference.source === 'dgu-dtm-20m'
            && terrainReference.datum === 'EVRF2000'
            && Array.isArray(terrainReference.points)
            && typeof formation.referenceElevationAt === 'function'
            && typeof formation.fitReferenceGroundFormation === 'function') {
            const referenceProfile = formation.buildFormation(xy, function (_x, _y, station) {
                return formation.referenceElevationAt(
                    terrainReference.points, station && station.s, CORRIDOR_DGU_MAX_GAP_M);
            }, { ...buildOptions, verticalOffsetM: 0 });
            const fittedGround = formation.fitReferenceGroundFormation(referenceProfile, visibleProfile, {
                verticalOffsetM: requestedOffset,
                source: terrainReference.source,
                datum: terrainReference.datum,
                resolutionM: terrainReference.resolutionM,
                minimumPairs: 2,
                minimumCoverage: 0.1,
                maximumMadM: 1,
                lowerQuantile: 0.15,
                anchorBandM: 1,
                agreementToleranceM: 0.75,
                obstacleMinHeightM: 1.5,
                maximumGroundGrade: 0.2
            });
            if (fittedGround && fittedGround.ok) {
                profile = fittedGround;
            } else if (visibleProfile) {
                visibleProfile.referenceStatus = referenceProfile && referenceProfile.ok
                    ? (fittedGround && fittedGround.reason
                        ? fittedGround.reason : 'no-obstacle-backed-reference')
                    : 'invalid-reference-profile';
            }
        }
        if (profile) {
            // Profile projections clamp to their endpoints, so callers must not let one road arm
            // supply terrain to an unrelated road across the scene. This still leaves enough room
            // for the widest strip, its junction patch and the cut-wall overlap.
            profile.supportRadiusSceneM = Math.max(12,
                (Number.isFinite(width) && width > 0 ? width / 2 : 0) + 8) * mercatorScale;
            profile.widthM = Number.isFinite(width) ? width : null;
            profile.mercatorScale = mercatorScale;
        }
        return profile || null;
    }

    function corridorFormationFailureSummary(profile) {
        const stations = profile && Array.isArray(profile.stations) ? profile.stations : [];
        return {
            reason: profile && profile.reason ? profile.reason : 'no-profile',
            stations: stations.length,
            sampledStations: stations.filter(station => Number.isFinite(station.rawZ)).length,
            firstSampled: !!(stations.length && Number.isFinite(stations[0].rawZ)),
            lastSampled: !!(stations.length && Number.isFinite(stations[stations.length - 1].rawZ)),
            unresolvedRanges: (profile && Array.isArray(profile.unresolvedRanges)
                ? profile.unresolvedRanges : []).map(range => ({
                    startS: range.startS,
                    endS: range.endS,
                    bounded: range.bounded,
                    spanM: Number.isFinite(range.spanM) ? range.spanM : null
                }))
        };
    }

    function terrainHeightFromProfiles(profiles, x, y) {
        const formation = window.__corridorTerrainFormation;
        if (!formation || !Array.isArray(profiles)) return null;
        let best = null;
        profiles.forEach(profile => {
            const sample = formation.projectToProfile(profile, x, y);
            if (!sample || !Number.isFinite(sample.z) || !Number.isFinite(sample.distance)) return;
            const supportRadius = Number(profile && profile.supportRadiusSceneM);
            if (Number.isFinite(supportRadius) && sample.distance > supportRadius) return;
            if (!best || sample.distance < best.distance) best = sample;
        });
        return best ? best.z : null;
    }

    // Interpolate the original Google top-hit support belonging to the same nearest accepted road
    // profile. Photoreal mode uses this only to close the vertical void left when a canopy component
    // lies wholly inside the road footprint and therefore never intersects the exterior cut plane.
    function terrainVisibleSurfaceFromProfiles(profiles, x, y) {
        const formation = window.__corridorTerrainFormation;
        if (!formation || !Array.isArray(profiles)) return null;
        let best = null;
        profiles.forEach(profile => {
            const sample = formation.projectToProfile(profile, x, y);
            const stations = profile && Array.isArray(profile.stations) ? profile.stations : [];
            if (!sample || !Number.isFinite(sample.distance) || !stations.length) return;
            const supportRadius = Number(profile.supportRadiusSceneM);
            if (Number.isFinite(supportRadius) && sample.distance > supportRadius) return;
            const stationValue = station => {
                if (Number.isFinite(station && station.googleSupportZ)) return station.googleSupportZ;
                if (Number.isFinite(station && station.rawZ)) {
                    return station.rawZ + (Number(profile.verticalOffsetM) || 0);
                }
                return Number.isFinite(station && station.z) ? station.z : null;
            };
            const index = Math.max(0, Math.min(stations.length - 1,
                Number.isFinite(sample.segmentIndex) ? sample.segmentIndex : 0));
            const a = stations[index];
            const b = stations[Math.min(stations.length - 1, index + 1)];
            const aValue = stationValue(a);
            const bValue = stationValue(b);
            let value = null;
            if (Number.isFinite(aValue) && Number.isFinite(bValue)) {
                const t = Number.isFinite(sample.t) ? sample.t : 0;
                value = aValue + (bValue - aValue) * t;
            } else if (Number.isFinite(aValue)) value = aValue;
            else if (Number.isFinite(bValue)) value = bValue;
            if (!Number.isFinite(value)) return;
            if (!best || sample.distance < best.distance) best = { distance: sample.distance, value };
        });
        return best ? best.value : null;
    }

    function terrainHeightOrZero(heightAt, x, y) {
        const value = typeof heightAt === 'function' ? heightAt(x, y) : null;
        return Number.isFinite(value) ? value : 0;
    }

    // Terrain roads are explicit station-to-station quads. ShapeGeometry/Earcut is intentionally
    // not used here: it may discard collinear densification vertices and span a whole 200 m road
    // with one tilted triangle, which is exactly the floating-at-one-end failure this path fixes.
    function addTerrainStrip3D(targetGroup, formationProfile, strip, lane, laneType) {
        const helper = window.__corridorTerrainFormation;
        if (!helper || !formationProfile) return false;
        const kerb = Math.max(0, Number(lane && lane.height) || 0);
        const ruled = helper.buildRuledStripPositions(
            formationProfile,
            Number(strip.left),
            Number(strip.right),
            CORRIDOR_STRIP_Z,
            kerb
        );
        if (!ruled || !ruled.ok || !ruled.positions.length) return false;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(ruled.positions, 3));
        geometry.computeVertexNormals();
        geometry.computeBoundingSphere();
        const mesh = new THREE.Mesh(geometry, corridorRibbonMaterial(laneType));
        mesh.userData.isCorridorStrip = true;
        mesh.userData.isTerrainCorridorStrip = true;
        mesh.userData.laneType = laneType;
        targetGroup.add(mesh);
        return true;
    }

    // Rail/tram TRACK rendering. A proposal's track lane is drawn with buildSurfaceRail3D — the SAME
    // renderer that draws the existing tram tracks (trackbed + sleepers + rails) — so proposal and
    // existing track read identically, rather than hand-rolled geometry that needs per-pixel tuning.

    // Rail-to-rail spacing in metres from the lane's gauge (1.0 metre / 1.435 standard).
    function railGaugeMetres(strip) {
        const g = (typeof corridorRailGauge === 'function') ? Number(corridorRailGauge(strip && strip.gauge)) : NaN;
        return (Number.isFinite(g) && g > 0 ? g : 1000) / 1000;
    }

    // A proposal's TRACK lane, drawn with buildSurfaceRail3D — the SAME renderer as the existing tram
    // tracks — so proposal track and existing track look identical. Uses the lane's own centerline
    // (the corridor centerline offset to the lane's centre) and its gauge. Same call for the terrain
    // and flat paths, exactly as the existing tram uses one style everywhere.
    function addProposalTrack3D(group, points, strip, formation) {
        if (typeof window.buildSurfaceRail3D !== 'function' || !Array.isArray(points) || points.length < 2) return false;
        try {
            let coords = points.map(p => [Number(p.lng), Number(p.lat)])
                .filter(c => Number.isFinite(c[0]) && Number.isFinite(c[1]));
            if (coords.length < 2) return false;
            // Offset the corridor centerline onto the rail lane's own centre when it is not centred.
            // turf's +distance is to the RIGHT of travel, so negate the left-positive strip offset.
            const centre = (Number(strip.left) + Number(strip.right)) / 2;
            if (Math.abs(centre) > 0.05 && typeof turf !== 'undefined' && typeof turf.lineOffset === 'function') {
                try {
                    const offset = turf.lineOffset(turf.lineString(coords), -centre, { units: 'meters' });
                    const oc = offset && offset.geometry && offset.geometry.coordinates;
                    if (Array.isArray(oc) && oc.length >= 2) coords = oc;
                } catch (_) { }
            }
            const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }] };
            // In photo mode the track rides the corridor terrain (formation heightAt) so it sits on
            // the road instead of floating at the existing-tram's fixed z; flat model 3D has no
            // formation and keeps the fixed surface z.
            const helper = window.__corridorTerrainFormation;
            const zAt = (formation && formation.ok && helper && typeof helper.heightAt === 'function')
                ? function (x, y) { return helper.heightAt(formation, x, y); }
                : null;
            const child = window.buildSurfaceRail3D(fc, coordsToXY, { gaugeM: railGaugeMetres(strip), zAt: zAt });
            if (!child) return false;
            child.userData.isCorridorStrip = true;
            child.userData.laneType = 'rail';
            group.add(child);
            return true;
        } catch (e) {
            console.warn('[three-mode] proposal track render failed', e);
            return false;
        }
    }

    function corridorTerrainEntryKey(proposal, entry) {
        const proposalId = proposal && (proposal.proposalId ?? proposal.id ?? proposal.hash ?? 'proposal');
        const segmentId = entry && entry.segmentId != null ? String(entry.segmentId) : '';
        const geometry = (entry && Array.isArray(entry.points) ? entry.points : []).map(function (point) {
            return Number(point.lat).toFixed(7) + ',' + Number(point.lng).toFixed(7);
        }).join(';');
        return String(proposalId) + '|' + segmentId + '|' + geometry;
    }

    function corridorPointSequencesEqual(a, b) {
        return Array.isArray(a) && Array.isArray(b) && a.length === b.length
            && a.every(function (point, index) {
                const other = b[index];
                return other && Number(point && point.lat) === Number(other.lat)
                    && Number(point && point.lng) === Number(other.lng);
            });
    }

    function corridorRenderEntriesForDefinition(definition) {
        const fallbackProfile = corridorProfileOf(definition);
        const centerline = corridorCenterlineOf(definition);
        if (!fallbackProfile || !centerline.length) return [];
        const entries = ((typeof corridorSegmentEntries === 'function') ? corridorSegmentEntries(definition) : [])
            .filter(entry => Array.isArray(entry.points) && entry.points.length >= 2)
            .map(entry => entry.profile ? entry : { ...entry, profile: fallbackProfile });
        return entries.length ? entries : centerline.map(points => ({ points, profile: fallbackProfile }));
    }

    function corridorDguTerrainProfileUrl() {
        const override = window.__CORRIDOR_TERRAIN_PROFILE_URL__;
        if (typeof override === 'string' && override.trim()) return override.trim();
        const configuredBase = window.__ZAGREB_RUNTIME_CONFIG__
            && window.__ZAGREB_RUNTIME_CONFIG__.zagrebApiBaseUrl;
        if (configuredBase) return String(configuredBase).replace(/\/+$/, '') + '/terrain/profile';
        const hostname = String(window.location && window.location.hostname || '').toLowerCase();
        if (hostname === 'localhost' || hostname === '127.0.0.1') {
            return 'http://localhost:3001/api/terrain/profile';
        }
        return String(window.location.origin || '').replace(/\/+$/, '') + '/api/terrain/profile';
    }

    function fetchCorridorDguProfile(points) {
        const url = corridorDguTerrainProfileUrl();
        const coordinates = (points || []).map(point => [Number(point.lng), Number(point.lat)]);
        if (coordinates.length < 2 || coordinates.some(pair => !pair.every(Number.isFinite))) {
            return Promise.resolve(null);
        }
        const cacheKey = url + '|' + coordinates.map(pair => pair.map(value => value.toFixed(7)).join(',')).join(';');
        if (corridorDguProfileCache.has(cacheKey)) return corridorDguProfileCache.get(cacheKey);
        const request = (async function () {
            let timeout = null;
            let controller = null;
            try {
                if (typeof AbortController === 'function') {
                    controller = new AbortController();
                    timeout = setTimeout(function () { controller.abort(); }, 5000);
                }
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ coordinates: coordinates, stepM: CORRIDOR_DGU_PROFILE_STEP_M }),
                    signal: controller ? controller.signal : undefined
                });
                if (!response.ok) {
                    console.warn('[three-mode] DGU terrain profile request failed: HTTP '
                        + response.status + ' from ' + url);
                    return null;
                }
                const result = await response.json();
                if (!result || result.source !== 'dgu-dtm-20m' || result.datum !== 'EVRF2000'
                    || !Array.isArray(result.points) || result.points.length < 2) {
                    console.warn('[three-mode] DGU terrain profile response has an invalid contract', {
                        source: result && result.source,
                        datum: result && result.datum,
                        points: result && Array.isArray(result.points) ? result.points.length : null
                    });
                    return null;
                }
                return result;
            } catch (error) {
                console.warn('[three-mode] DGU terrain profile request unavailable; retaining Google profile',
                    error && (error.name || error.message) ? (error.name || error.message) : error);
                return null;
            } finally {
                if (timeout) clearTimeout(timeout);
            }
        })();
        corridorDguProfileCache.set(cacheKey, request);
        // A transient outage must not poison this geometry for the rest of the page session.
        // Keep successful profiles (the settled-LOD refit reuses them), but let a later rebuild
        // retry any timeout, HTTP error or invalid response.
        void request.then(function (result) {
            if (!result && corridorDguProfileCache.get(cacheKey) === request) {
                corridorDguProfileCache.delete(cacheKey);
            }
        });
        return request;
    }

    function publishCorridorTerrainReferenceState(generation, state) {
        if (generation !== corridorTerrainReferenceGeneration || !corridorTerrainSampler) return;
        try {
            document.body.dataset.corridorTerrainReference = JSON.stringify(state);
        } catch (_) { }
    }

    async function loadCorridorDguReferences(generation) {
        const references = new Map();
        const failures = [];
        if (typeof proposalStorage === 'undefined' || typeof proposalStorage.getAllProposals !== 'function'
            || typeof isAppliedCorridorProposal !== 'function') {
            publishCorridorTerrainReferenceState(generation, {
                state: 'unavailable', requested: 0, loaded: 0, failed: 0,
                error: 'proposal-storage-unavailable'
            });
            return references;
        }
        const work = [];
        proposalStorage.getAllProposals().filter(isAppliedCorridorProposal).forEach(function (proposal) {
            const definition = corridorProposalDefinition(proposal);
            corridorRenderEntriesForDefinition(definition).forEach(function (entry) {
                const key = corridorTerrainEntryKey(proposal, entry);
                work.push(fetchCorridorDguProfile(entry.points).then(function (reference) {
                    if (reference) references.set(key, reference);
                    else failures.push(key);
                }));
            });
        });
        publishCorridorTerrainReferenceState(generation, {
            state: 'loading', requested: work.length, loaded: 0, failed: 0, error: null
        });
        await Promise.all(work);
        publishCorridorTerrainReferenceState(generation, {
            state: 'ready', requested: work.length, loaded: references.size,
            failed: failures.length,
            error: failures.length ? 'profile-unavailable' : null
        });
        if (generation === corridorTerrainReferenceGeneration && corridorTerrainSampler) {
            console.log('[three-mode] DGU terrain references loaded: ' + references.size + '/' + work.length);
        }
        return references;
    }

    function addTerrainCutPatch(out, formationProfile, corridorProfile, proposal, entry) {
        const helper = window.__corridorTerrainFormation;
        if (!helper || !formationProfile || !formationProfile.ok
            || typeof helper.buildRuledStripPositions !== 'function'
            || typeof corridorStripSpans !== 'function') return;
        const spans = corridorStripSpans(corridorProfile);
        if (!spans.length) return;
        const left = Math.max.apply(null, spans.map(span => Number(span.left)).filter(Number.isFinite));
        const right = Math.min.apply(null, spans.map(span => Number(span.right)).filter(Number.isFinite));
        if (!Number.isFinite(left) || !Number.isFinite(right) || !(left > right)) return;
        const topOffsetForSpan = function (span) {
            const lane = (typeof CORRIDOR_LANE_TYPES !== 'undefined'
                && CORRIDOR_LANE_TYPES[span && span.type]) || {};
            return CORRIDOR_STRIP_Z + Math.max(0, Number(lane.height) || 0);
        };
        const leftEdgeSpan = spans.reduce(function (best, span) {
            return !best || Number(span.left) > Number(best.left) ? span : best;
        }, null);
        const rightEdgeSpan = spans.reduce(function (best, span) {
            return !best || Number(span.right) < Number(best.right) ? span : best;
        }, null);
        const ruled = helper.buildRuledStripPositions(formationProfile, left, right, 0, 0);
        if (!ruled || !ruled.ok || !ruled.topPositions || !ruled.topPositions.length) return;
        const stations = formationProfile.stations || [];
        const first = stations[0] || {};
        const last = stations[stations.length - 1] || {};
        const replacementKey = [
            proposal && proposal.proposalId != null ? String(proposal.proposalId) : '',
            entry && entry.segmentId != null ? String(entry.segmentId) : '',
            Number(first.x).toPrecision(15), Number(first.y).toPrecision(15),
            Number(last.x).toPrecision(15), Number(last.y).toPrecision(15),
            stations.length
        ].join('|');
        out.push({
            proposalId: proposal && proposal.proposalId != null ? String(proposal.proposalId) : null,
            segmentId: entry && entry.segmentId != null ? String(entry.segmentId) : null,
            positions: ruled.topPositions,
            boundaryRings: ruled.boundaryRings,
            // Keep the source profile and authored lateral limits privately available so the
            // photoreal mask can rebuild this same station quilt through its exact raster-owned
            // edge collar.  A generic ShapeGeometry across that collar would interpolate between
            // sparse polygon vertices and can miss a nonlinear dip half-way along a long road.
            _formationProfile: formationProfile,
            _leftM: left,
            _rightM: right,
            _leftTopOffsetM: topOffsetForSpan(leftEdgeSpan),
            _rightTopOffsetM: topOffsetForSpan(rightEdgeSpan),
            _replacementKey: replacementKey
        });
    }

    function corridorStripToFeature(polygon) {
        const sourceRings = Array.isArray(polygon?.[0]) ? polygon : [polygon];
        const rings = sourceRings.map(source => {
            const ring = source.map(point => [point.lng, point.lat]);
            const first = ring[0];
            const last = ring[ring.length - 1];
            if (first && last && (first[0] !== last[0] || first[1] !== last[1])) ring.push([first[0], first[1]]);
            return ring;
        }).filter(ring => ring.length >= 4);
        return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: rings } };
    }

    // The established 2D strip ring deliberately uses even-odd fill and remains untouched. A closed
    // centerline needs a different 3D representation: two cyclic offsets form an annulus (outer +
    // hole), otherwise the cap-based flat ring becomes a bowtie and the mesh guard correctly drops it.
    function corridorStripPolygon3D(centerline, strip, fallbackPolygon) {
        if (typeof corridorClosedStripPolygonPlanar !== 'function'
            || typeof wgs84ToHTRS96 !== 'function'
            || typeof htrs96ToWGS84 !== 'function'
            || !Array.isArray(centerline)
            || centerline.length < 4) return fallbackPolygon;
        const first = centerline[0];
        const last = centerline[centerline.length - 1];
        if (!first || !last || Math.abs(first.lat - last.lat) >= 1e-7 || Math.abs(first.lng - last.lng) >= 1e-7) {
            return fallbackPolygon;
        }
        const planar = centerline.map(point => wgs84ToHTRS96(point.lat, point.lng));
        const rings = corridorClosedStripPolygonPlanar(planar, strip.left, strip.right);
        if (!rings) return fallbackPolygon;
        return rings.map(ring => ring.map(([x, y]) => {
            const [lat, lng] = htrs96ToWGS84(x, y);
            return { lat, lng };
        }));
    }

    // Sharp reversals make the inside edge of an offset lane cross itself. The generic 3D mesh
    // guard quite rightly refuses that bow-tie polygon (triangulating it produces spikes), but a
    // refused strip exposes the flat grey corridor parcel underneath — commonly half the road.
    // Turf's established footprint sanitizer splits the bow-tie into simple pieces and dissolves
    // them back into the actual lane surface, which ShapeGeometry can triangulate safely.
    function corridorStripMeshes3D(feature, material, z, depth) {
        let meshes = polygonFeatureToMeshes(feature, material, z, depth);
        if (meshes.length || typeof window.sanitizePolygonFeature !== 'function') return meshes;
        try {
            const repaired = window.sanitizePolygonFeature(feature);
            if (repaired && repaired.geometry) {
                meshes = polygonFeatureToMeshes(repaired, material, z, depth);
            }
        } catch (error) {
            console.warn('[three-mode] Could not repair a self-intersecting corridor strip', error);
        }
        return meshes;
    }

    function corridorSymbolMaterial(kind) {
        if (corridorSymbolMaterials[kind]) return corridorSymbolMaterials[kind];
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, 128, 128);
        ctx.strokeStyle = '#ffffff';
        ctx.fillStyle = '#ffffff';
        ctx.lineWidth = 8;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        if (kind === 'manhole') {
            // Dark iron cover with a lighter rim and pick-hole cross.
            ctx.fillStyle = '#3a3a3a';
            ctx.beginPath(); ctx.arc(64, 64, 42, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = '#c9c9c9'; ctx.lineWidth = 6;
            ctx.beginPath(); ctx.arc(64, 64, 42, 0, Math.PI * 2); ctx.stroke();
            ctx.lineWidth = 5;
            ctx.beginPath();
            ctx.moveTo(64, 30); ctx.lineTo(64, 98);
            ctx.moveTo(30, 64); ctx.lineTo(98, 64);
            ctx.stroke();
        } else if (kind === 'grate') {
            // Dark drainage grate with parallel slots.
            ctx.fillStyle = '#3a3a3a';
            ctx.fillRect(22, 40, 84, 48);
            ctx.strokeStyle = '#c9c9c9'; ctx.lineWidth = 5;
            for (let gx = 34; gx <= 94; gx += 12) {
                ctx.beginPath(); ctx.moveTo(gx, 46); ctx.lineTo(gx, 82); ctx.stroke();
            }
            ctx.lineWidth = 4;
            ctx.strokeRect(22, 40, 84, 48);
        } else if (kind === 'bike') {
            ctx.beginPath(); ctx.arc(32, 83, 22, 0, Math.PI * 2); ctx.stroke();
            ctx.beginPath(); ctx.arc(96, 83, 22, 0, Math.PI * 2); ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(32, 83); ctx.lineTo(53, 50); ctx.lineTo(69, 83); ctx.lineTo(32, 83);
            ctx.moveTo(53, 50); ctx.lineTo(84, 50); ctx.lineTo(96, 83);
            ctx.moveTo(47, 39); ctx.lineTo(61, 39);
            ctx.stroke();
        } else {
            const person = (x, scale) => {
                ctx.beginPath(); ctx.arc(x, 30 + (1 - scale) * 20, 10 * scale, 0, Math.PI * 2); ctx.fill();
                ctx.beginPath();
                ctx.moveTo(x, 43); ctx.lineTo(x, 82);
                ctx.moveTo(x, 57); ctx.lineTo(x - 15 * scale, 70);
                ctx.moveTo(x, 57); ctx.lineTo(x + 15 * scale, 70);
                ctx.moveTo(x, 82); ctx.lineTo(x - 13 * scale, 111);
                ctx.moveTo(x, 82); ctx.lineTo(x + 13 * scale, 111);
                ctx.stroke();
            };
            person(45, 1);
            person(88, 0.68);
            ctx.beginPath(); ctx.moveTo(60, 67); ctx.lineTo(77, 69); ctx.stroke();
        }

        const texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;
        corridorSymbolMaterials[kind] = new THREE.MeshBasicMaterial({
            map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide
        });
        return corridorSymbolMaterials[kind];
    }

    function addCorridorDecorations3D(targetGroup, decorations, terrainHeightAt) {
        const treePoints = decorations.filter(item => item.kind === 'tree');
        const signs = decorations.filter(item => item.kind !== 'tree');
        signs.forEach(item => {
            const [x, y] = latLngToXY(item.lat, item.lng);
            // Utility covers are small fixed objects; painted symbols scale to their strip.
            const isUtility = item.kind === 'manhole' || item.kind === 'grate';
            const size = isUtility ? 0.9 : Math.max(1.2, Math.min(3, Number(item.stripWidth) * 0.85));
            const geometry = new THREE.PlaneGeometry(size, size);
            const mesh = new THREE.Mesh(geometry, corridorSymbolMaterial(item.kind));
            mesh.position.set(x, y, terrainHeightOrZero(terrainHeightAt, x, y) + CORRIDOR_STRIP_Z + 0.18);
            mesh.rotation.z = Number(item.angle) || 0;
            mesh.userData.isCorridorDecoration = true;
            mesh.userData.decorationKind = item.kind;
            targetGroup.add(mesh);
        });

        if (!treePoints.length) return;
        ensureTreeAssets();
        const trunks = new THREE.InstancedMesh(treeTrunkGeo, treeTrunkMat, treePoints.length);
        const crowns = new THREE.InstancedMesh(treeCrownGeo, treeCrownMat, treePoints.length);
        const dummy = new THREE.Object3D();
        treePoints.forEach((item, index) => {
            const [x, y] = latLngToXY(item.lat, item.lng);
            const random = treeRng(item.lng, item.lat);
            const totalHeight = 5 + random * 3;
            const trunkHeight = totalHeight * 0.48;
            const crownRadius = totalHeight * 0.2 + 0.4;
            const terrainZ = terrainHeightOrZero(terrainHeightAt, x, y);
            dummy.position.set(x, y, terrainZ + CORRIDOR_STRIP_Z + 0.15 + trunkHeight / 2);
            dummy.scale.set(1, 1, trunkHeight);
            dummy.rotation.set(0, 0, 0);
            dummy.updateMatrix();
            trunks.setMatrixAt(index, dummy.matrix);
            dummy.position.set(x, y, terrainZ + CORRIDOR_STRIP_Z + 0.15 + trunkHeight + crownRadius * 0.65);
            dummy.scale.set(crownRadius, crownRadius, crownRadius * 1.15);
            dummy.updateMatrix();
            crowns.setMatrixAt(index, dummy.matrix);
        });
        trunks.instanceMatrix.needsUpdate = true;
        crowns.instanceMatrix.needsUpdate = true;
        trunks.userData.isCorridorDecoration = true;
        trunks.userData.decorationKind = 'tree';
        crowns.userData.isCorridorDecoration = true;
        crowns.userData.decorationKind = 'tree';
        targetGroup.add(trunks, crowns);
    }

    function addCorridorJunctions3D(targetGroup, junctions, terrainHeightAt) {
        const asphalt = corridorLaneMaterial('driving');
        const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
        junctions.forEach(junction => {
            const center = latLngToXY(junction.lat, junction.lng);
            const terrainZ = terrainHeightOrZero(terrainHeightAt, center[0], center[1]);
            (junction.surfacePolygons || []).forEach(polygon => {
                polygonFeatureToMeshes(corridorStripToFeature(polygon), asphalt,
                    terrainZ + CORRIDOR_STRIP_Z + 0.16, 0)
                    .forEach(mesh => {
                        mesh.userData.isCorridorJunction = true;
                        targetGroup.add(mesh);
                    });
            });
            (junction.crosswalkPolygons || []).forEach(polygon => {
                polygonFeatureToMeshes(corridorStripToFeature(polygon), white,
                    terrainZ + CORRIDOR_STRIP_Z + 0.17, 0)
                    .forEach(mesh => {
                        mesh.userData.isCorridorCrosswalk = true;
                        targetGroup.add(mesh);
                    });
            });
        });
    }

    // ---------------------------------------------------------------------------
    // Lane markings in 3D
    //
    // The 2D map paints lane separators and parking bays as white lines on the asphalt; 3D paints the
    // SAME lines, from the same geometry builders, as flat opaque ribbons just above the surface. They
    // sit below the junction patches (+0.16), so a crossing's asphalt still swallows the through-lines
    // exactly as it does in 2D. Opaque, so they never join the translucent stack that flickers.
    // ---------------------------------------------------------------------------
    const CORRIDOR_MARKING_Z = CORRIDOR_STRIP_Z + 0.03;
    let corridorMarkingMat = null;
    function corridorMarkingMaterial() {
        if (!corridorMarkingMat) {
            corridorMarkingMat = new THREE.MeshBasicMaterial({ color: 0xf4f4f4, side: THREE.DoubleSide });
        }
        return corridorMarkingMat;
    }

    // The two triangles of one flat paint rectangle from XY point `a` to `b`, `half` metres to each side,
    // appended to a flat positions array. MeshBasicMaterial is unlit, so no normals are needed.
    function pushCorridorMarkingQuad(positions, a, b, half, terrainHeightAt) {
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const length = Math.hypot(dx, dy);
        if (length < 1e-6) return;
        const nx = (-dy / length) * half;
        const ny = (dx / length) * half;
        const zA = terrainHeightOrZero(terrainHeightAt, a[0], a[1]) + CORRIDOR_MARKING_Z;
        const zB = terrainHeightOrZero(terrainHeightAt, b[0], b[1]) + CORRIDOR_MARKING_Z;
        const ax = a[0], ay = a[1], bx = b[0], by = b[1];
        positions.push(
            ax + nx, ay + ny, zA, bx + nx, by + ny, zB, bx - nx, by - ny, zB,
            ax + nx, ay + ny, zA, bx - nx, by - ny, zB, ax - nx, ay - ny, zA
        );
    }

    // Lay one marking polyline (Leaflet LatLngs) as flat paint: a solid ribbon, or dashes when `dash`
    // ({ on, off } in metres) is given. Dashes restart at each vertex — fine for the near-straight road
    // segments these lines run along.
    function addCorridorMarkingPolyline(positions, line, half, dash, terrainHeightAt) {
        if (!Array.isArray(line) || line.length < 2) return;
        const pts = line.map(point => latLngToXY(point.lat, point.lng));
        for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i];
            const b = pts[i + 1];
            if (!dash) { pushCorridorMarkingQuad(positions, a, b, half, terrainHeightAt); continue; }
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const length = Math.hypot(dx, dy);
            if (length < 1e-6) continue;
            const ux = dx / length;
            const uy = dy / length;
            for (let d = 0; d < length; d += dash.on + dash.off) {
                const end = Math.min(d + dash.on, length);
                pushCorridorMarkingQuad(positions,
                    [a[0] + ux * d, a[1] + uy * d], [a[0] + ux * end, a[1] + uy * end],
                    half, terrainHeightAt);
            }
        }
    }

    // Every white line of one corridor segment — lane separators (dashed, the solid-flow divide heavier)
    // and parking bays (solid edge + bay dividers) — batched into ONE opaque mesh, so a long road is a
    // single draw call rather than thousands of little ones.
    function addCorridorMarkings3D(targetGroup, entry, terrainHeightAt) {
        try {
        const positions = [];
        const markings = (typeof buildCorridorLaneMarkings === 'function')
            ? buildCorridorLaneMarkings([entry.points], entry.profile) : [];
        markings.forEach(marking => {
            const isCenterline = marking.kind === 'centerline';
            const half = isCenterline ? 0.09 : 0.075;
            const dash = isCenterline ? { on: 3, off: 2.5 } : { on: 1.5, off: 2.5 };
            (marking.lines || []).forEach(line => addCorridorMarkingPolyline(
                positions, line, half, dash, terrainHeightAt));
        });
        const bays = (typeof buildCorridorParkingBays === 'function')
            ? buildCorridorParkingBays([entry.points], entry.profile) : [];
        bays.forEach(bay => addCorridorMarkingPolyline(
            positions, bay.line, bay.kind === 'edge' ? 0.075 : 0.06, null, terrainHeightAt));

        // Direction arrows arrive as convex rings; a fan from vertex 0 triangulates each into the same
        // flat white mesh as the lines.
        const arrows = (typeof buildCorridorDirectionArrows === 'function')
            ? buildCorridorDirectionArrows([entry.points], entry.profile) : [];
        arrows.forEach(ring => {
            const pts = ring.map(point => latLngToXY(point.lat, point.lng));
            for (let i = 1; i < pts.length - 1; i++) {
                positions.push(
                    pts[0][0], pts[0][1], terrainHeightOrZero(terrainHeightAt, pts[0][0], pts[0][1]) + CORRIDOR_MARKING_Z,
                    pts[i][0], pts[i][1], terrainHeightOrZero(terrainHeightAt, pts[i][0], pts[i][1]) + CORRIDOR_MARKING_Z,
                    pts[i + 1][0], pts[i + 1][1],
                    terrainHeightOrZero(terrainHeightAt, pts[i + 1][0], pts[i + 1][1]) + CORRIDOR_MARKING_Z
                );
            }
        });

        if (!positions.length) return;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        const mesh = new THREE.Mesh(geometry, corridorMarkingMaterial());
        mesh.userData.isCorridorMarking = true;
        targetGroup.add(mesh);
        } catch (error) {
            // Markings are cosmetic: their failure must never cost a road its asphalt.
            console.error('[three-mode] corridor markings failed', error);
        }
    }

    function addBuildingTunnelLiners3D(targetGroup, definition, terrainHeightAt) {
        const tunnels = Array.isArray(definition?.tunnels) ? definition.tunnels : [];
        if (!tunnels.length) return;
        const isTrack = corridorIsTrack(definition);
        const clearHeight = isTrack ? 6 : 4.5;
        const clearWidth = Math.max(3, Number(definition?.width) || (isTrack ? 3 : 7.5)) + 0.8;
        const thickness = 0.25;
        const linerMaterial = new THREE.MeshLambertMaterial({
            color: 0x2e2340, transparent: true, opacity: 0.82, side: THREE.DoubleSide
        });
        const portalMaterial = new THREE.MeshBasicMaterial({ color: 0x8b5cf6 });

        tunnels.forEach(tunnel => {
            if (tunnel?.kind !== 'building' || !tunnel.from || !tunnel.to) return;
            const [x1, y1] = latLngToXY(Number(tunnel.from.lat), Number(tunnel.from.lng));
            const [x2, y2] = latLngToXY(Number(tunnel.to.lat), Number(tunnel.to.lng));
            const length = Math.hypot(x2 - x1, y2 - y1);
            if (!Number.isFinite(length) || length < 0.5) return;
            const z1 = terrainHeightOrZero(terrainHeightAt, x1, y1);
            const z2 = terrainHeightOrZero(terrainHeightAt, x2, y2);
            const dz = z2 - z1;
            const slopedLength = Math.hypot(length, dz);
            const assembly = new THREE.Group();
            assembly.position.set((x1 + x2) / 2, (y1 + y2) / 2,
                (z1 + z2) / 2 + CORRIDOR_STRIP_Z + 0.05);
            assembly.rotation.z = Math.atan2(y2 - y1, x2 - x1);
            assembly.rotation.y = -Math.atan2(dz, length);

            const addBox = (geometry, material, x, y, z) => {
                const mesh = new THREE.Mesh(geometry, material);
                mesh.position.set(x, y, z);
                mesh.userData.isBuildingTunnel = true;
                mesh.userData.tunnelId = tunnel.id || tunnel.edgeKey;
                assembly.add(mesh);
            };

            addBox(new THREE.BoxGeometry(slopedLength, thickness, clearHeight), linerMaterial,
                0, -clearWidth / 2, clearHeight / 2);
            addBox(new THREE.BoxGeometry(slopedLength, thickness, clearHeight), linerMaterial,
                0, clearWidth / 2, clearHeight / 2);
            addBox(new THREE.BoxGeometry(slopedLength, clearWidth, thickness), linerMaterial,
                0, 0, clearHeight);

            [-slopedLength / 2, slopedLength / 2].forEach(x => {
                addBox(new THREE.BoxGeometry(thickness * 1.5, thickness * 1.5, clearHeight), portalMaterial,
                    x, -clearWidth / 2, clearHeight / 2);
                addBox(new THREE.BoxGeometry(thickness * 1.5, thickness * 1.5, clearHeight), portalMaterial,
                    x, clearWidth / 2, clearHeight / 2);
                addBox(new THREE.BoxGeometry(thickness * 1.5, clearWidth, thickness * 1.5), portalMaterial,
                    x, 0, clearHeight);
            });
            targetGroup.add(assembly);
        });
    }

    function gradeRecordPointXY(point) {
        if (!point || !Number.isFinite(Number(point.lat)) || !Number.isFinite(Number(point.lng))) return null;
        const [x, y] = latLngToXY(Number(point.lat), Number(point.lng));
        return { x, y };
    }

    function closestGradeSegmentSample(x, y, start, end, zStart, zEnd) {
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const lengthSq = dx * dx + dy * dy;
        const t = lengthSq > 1e-9
            ? Math.max(0, Math.min(1, ((x - start.x) * dx + (y - start.y) * dy) / lengthSq))
            : 0;
        const px = start.x + dx * t;
        const py = start.y + dy * t;
        return { distanceSq: (x - px) ** 2 + (y - py) ** 2, z: zStart + (zEnd - zStart) * t };
    }

    function gradeElevationAtXY(record, x, y) {
        const start = gradeRecordPointXY(record?.from);
        const crossing = gradeRecordPointXY(record?.crossing);
        const end = gradeRecordPointXY(record?.to);
        const peak = Number(record?.elevation) || (record?.mode === 'overpass' ? 5.2 : -3.2);
        if (!start || !crossing || !end) return 0;
        const before = closestGradeSegmentSample(x, y, start, crossing, 0, peak);
        const after = closestGradeSegmentSample(x, y, crossing, end, peak, 0);
        return before.distanceSq <= after.distanceSq ? before.z : after.z;
    }

    function elevateGradeMeshes(meshes, record, terrainHeightAt) {
        (meshes || []).forEach(mesh => {
            const position = mesh?.geometry?.getAttribute?.('position');
            if (!position) return;
            for (let index = 0; index < position.count; index++) {
                const x = position.getX(index);
                const y = position.getY(index);
                position.setZ(index, position.getZ(index)
                    + terrainHeightOrZero(terrainHeightAt, x, y)
                    + gradeElevationAtXY(record, x, y));
            }
            position.needsUpdate = true;
            try { mesh.geometry.computeVertexNormals(); } catch (_) { }
            try { mesh.geometry.computeBoundingSphere(); } catch (_) { }
            mesh.userData.isGradeSeparatedCorridor = true;
            mesh.userData.gradeSeparationMode = record.mode;
            mesh.userData.gradeSeparationId = record.id || null;
        });
    }

    function addGradeSeparationEdges3D(targetGroup, record, terrainHeightAt) {
        const points = [record?.from, record?.crossing, record?.to].map(gradeRecordPointXY);
        if (points.some(point => !point)) return;
        const peak = Number(record.elevation) || (record.mode === 'overpass' ? 5.2 : -3.2);
        const heights = [
            terrainHeightOrZero(terrainHeightAt, points[0].x, points[0].y),
            terrainHeightOrZero(terrainHeightAt, points[1].x, points[1].y) + peak,
            terrainHeightOrZero(terrainHeightAt, points[2].x, points[2].y)
        ];
        const width = Math.max(2, Number(record.width) || 2);
        const railMaterial = new THREE.MeshLambertMaterial({
            color: record.mode === 'overpass' ? 0xc47608 : 0x315f9f
        });
        for (let index = 0; index < 2; index++) {
            const a = points[index];
            const b = points[index + 1];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const horizontal = Math.hypot(dx, dy);
            if (horizontal < 0.2) continue;
            const dz = heights[index + 1] - heights[index];
            const assembly = new THREE.Group();
            assembly.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (heights[index] + heights[index + 1]) / 2);
            assembly.rotation.z = Math.atan2(dy, dx);
            assembly.rotation.y = -Math.atan2(dz, horizontal);
            const length = Math.hypot(horizontal, dz);
            [-1, 1].forEach(side => {
                const barrier = new THREE.Mesh(
                    new THREE.BoxGeometry(length, 0.12, record.mode === 'overpass' ? 1.1 : 0.8),
                    railMaterial
                );
                barrier.position.set(0, side * (width / 2 + 0.08), record.mode === 'overpass' ? 0.55 : 0.4);
                barrier.userData.isGradeSeparationEdge = true;
                barrier.userData.gradeSeparationMode = record.mode;
                assembly.add(barrier);
            });
            targetGroup.add(assembly);
        }

        if (record.mode === 'overpass') {
            const supportMaterial = new THREE.MeshLambertMaterial({ color: 0x6b7280 });
            [[points[0], points[1]], [points[2], points[1]]].forEach(([outer, inner]) => {
                const t = 0.58;
                const x = outer.x + (inner.x - outer.x) * t;
                const y = outer.y + (inner.y - outer.y) * t;
                const groundZ = terrainHeightOrZero(terrainHeightAt, x, y);
                const deckZ = groundZ + gradeElevationAtXY(record, x, y);
                const height = Math.max(0.8, deckZ - groundZ - 0.18);
                const pier = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.42, height, 10), supportMaterial);
                pier.rotation.x = Math.PI / 2;
                pier.position.set(x, y, groundZ + height / 2);
                pier.userData.isGradeSeparationPier = true;
                targetGroup.add(pier);
            });
        }
    }

    function addGradeSeparatedCorridors3D(targetGroup, definition, entries, fallbackProfile, terrainHeightAt) {
        const records = Array.isArray(definition?.gradeSeparations) ? definition.gradeSeparations : [];
        records.forEach(record => {
            if (!record?.from || !record?.crossing || !record?.to
                || (record.mode !== 'underpass' && record.mode !== 'overpass')) return;
            const entry = entries.find(candidate => record.segmentId != null
                && String(candidate.segmentId) === String(record.segmentId));
            const profile = entry?.profile || fallbackProfile;
            if (!profile) return;
            const path = [record.from, record.crossing, record.to];
            buildCorridorStrips([path], profile).forEach(strip => {
                const lane = (typeof CORRIDOR_LANE_TYPES !== 'undefined' && CORRIDOR_LANE_TYPES[strip.type]) || {};
                const kerb = Number(lane.height) || 0;
                (strip.polygons || []).forEach(polygon => {
                    const meshes = corridorStripMeshes3D(
                        corridorStripToFeature(polygon),
                        corridorLaneMaterial(strip.type),
                        CORRIDOR_STRIP_Z,
                        kerb
                    );
                    elevateGradeMeshes(meshes, record, terrainHeightAt);
                    meshes.forEach(mesh => {
                        mesh.userData.isCorridorStrip = true;
                        mesh.userData.laneType = strip.type;
                        targetGroup.add(mesh);
                    });
                });
            });
            addGradeSeparationEdges3D(targetGroup, record, terrainHeightAt);
        });
    }

    function buildCorridorStrips3D(targetGroup, options) {
        if (typeof buildCorridorStrips !== 'function' || typeof isAppliedCorridorProposal !== 'function') return;
        if (typeof proposalStorage === 'undefined' || typeof proposalStorage.getAllProposals !== 'function') return;
        options = options || {};
        const terrainSampler = typeof options.terrainSampler === 'function' ? options.terrainSampler : null;
        const terrainMode = !!terrainSampler && !!window.__corridorTerrainFormation;
        const terrainProfilesOut = Array.isArray(options.profilesOut) ? options.profilesOut : [];
        const terrainFailuresOut = Array.isArray(options.failuresOut) ? options.failuresOut : [];
        const terrainCutPatchesOut = Array.isArray(options.cutPatchesOut) ? options.cutPatchesOut : [];
        const terrainExpectedKeysOut = options.expectedKeysOut instanceof Set
            ? options.expectedKeysOut : null;
        const terrainReferences = options.terrainReferences instanceof Map
            ? options.terrainReferences : new Map();

        const renderFlatSurface = function (points, entry) {
            buildCorridorStrips([points], entry.profile).forEach(strip => {
                // Rail lanes render as real track in the existing-tram style, not a flat strip.
                if (strip.type === 'rail') { addProposalTrack3D(targetGroup, points, strip); return; }
                const lane = (typeof CORRIDOR_LANE_TYPES !== 'undefined' && CORRIDOR_LANE_TYPES[strip.type]) || {};
                const kerb = Number(lane.height) || 0;
                strip.polygons.forEach(polygon => {
                    const meshPolygon = corridorStripPolygon3D(points, strip, polygon);
                    // A flat OPEN strip whose outline crosses itself (a star, a hairpin) can't be
                    // earcut — the fill floods the whole enclosed area. Lay the same per-edge band.
                    if (kerb === 0 && meshPolygon === polygon && corridorStripRingSelfIntersects(polygon)) {
                        addFlatStripRibbon3D(targetGroup, points, strip.left, strip.right,
                            corridorRibbonMaterial(strip.type), strip.type);
                        return;
                    }
                    corridorStripMeshes3D(
                        corridorStripToFeature(meshPolygon),
                        corridorLaneMaterial(strip.type),
                        CORRIDOR_STRIP_Z,
                        kerb
                    ).forEach(mesh => {
                        mesh.userData.isCorridorStrip = true;
                        mesh.userData.laneType = strip.type;
                        targetGroup.add(mesh);
                    });
                });
            });
        };

        proposalStorage.getAllProposals().filter(isAppliedCorridorProposal).forEach(proposal => {
            try {
            const definition = corridorProposalDefinition(proposal);
            const fallbackProfile = corridorProfileOf(definition);
            const centerline = corridorCenterlineOf(definition);
            if (!fallbackProfile || !centerline.length) return;

            // Per-segment cross-sections, same as the 2D renderer: each segment draws with ITS
            // profile (width, lanes, tree groves). Rendering the whole centerline with the
            // default profile flattened every network to one width and dropped override-only
            // lanes (a segment's tree grove never made it into 3D).
            const renderEntries = corridorRenderEntriesForDefinition(definition);
            if (terrainMode && terrainExpectedKeysOut) {
                renderEntries.forEach(function (entry) {
                    terrainExpectedKeysOut.add(corridorTerrainEntryKey(proposal, entry));
                });
            }

            // Full-entry profiles remain available through grade-separated and tunnel spans. Surface
            // runs below get their own station quads, but every semantic consumer samples one shared
            // smoothed longitudinal family rather than raw tile hits.
            const proposalTerrainProfiles = [];
            const terrainProfileByEntry = new Map();
            const terrainAttemptByEntry = new Map();
            const registerTerrainProfile = function (profile, entry) {
                if (!profile || !profile.ok) return false;
                profile.proposalId = proposal && proposal.proposalId != null
                    ? String(proposal.proposalId) : null;
                profile.segmentId = entry && entry.segmentId != null
                    ? String(entry.segmentId) : null;
                profile.terrainEntryKey = corridorTerrainEntryKey(proposal, entry);
                if (!proposalTerrainProfiles.includes(profile)) proposalTerrainProfiles.push(profile);
                if (!terrainProfilesOut.includes(profile)) terrainProfilesOut.push(profile);
                return true;
            };
            if (terrainMode) renderEntries.forEach(entry => {
                const reference = terrainReferences.get(corridorTerrainEntryKey(proposal, entry)) || null;
                const profile = corridorFormationForPoints(
                    entry.points, terrainSampler, entry.profile, undefined, reference);
                terrainAttemptByEntry.set(entry, profile);
                if (!profile || !profile.ok) {
                    terrainFailuresOut.push(corridorFormationFailureSummary(profile));
                    return;
                }
                terrainProfileByEntry.set(entry, profile);
                registerTerrainProfile(profile, entry);
            });
            const formationHelper = window.__corridorTerrainFormation;
            const gradeSpanRecords = (typeof gradeSeparationSpanRecords === 'function')
                ? gradeSeparationSpanRecords(definition.gradeSeparations || [])
                : [];
            const protectedRecords = (typeof corridorProtectedSpanRecordsForDefinition === 'function')
                ? corridorProtectedSpanRecordsForDefinition(definition) : gradeSpanRecords;
            const surfaceRenderEntries = [];
            const surfaceRunRecords = [];
            renderEntries.forEach(entry => {
                const surfaceRuns = gradeSpanRecords.length && typeof corridorSurfaceRuns === 'function'
                    ? corridorSurfaceRuns([entry.points], gradeSpanRecords)
                    : [entry.points];
                surfaceRuns.forEach(points => {
                    surfaceRenderEntries.push({ ...entry, points });
                    const fullFormation = terrainProfileByEntry.get(entry);
                    const inheritsFullFormation = !!(fullFormation && fullFormation.ok);
                    const derivesFromFullFormation = terrainMode && points !== entry.points
                        && inheritsFullFormation;
                    const runAttempt = terrainMode
                        ? (points === entry.points
                            ? terrainAttemptByEntry.get(entry)
                            : (derivesFromFullFormation
                                ? null
                                : corridorFormationForPoints(points, terrainSampler,
                                    entry.profile,
                                    CORRIDOR_TERRAIN_CLEARANCE_M)))
                        : null;
                    if (terrainMode && points !== entry.points && !derivesFromFullFormation
                        && (!runAttempt || !runAttempt.ok)) {
                        terrainFailuresOut.push(corridorFormationFailureSummary(runAttempt));
                    }
                    const runResolution = terrainMode && !derivesFromFullFormation
                        ? formationHelper.resolveSurfaceRunFormation(fullFormation, runAttempt, {
                            proposalId: proposal && proposal.proposalId,
                            segmentId: entry && entry.segmentId
                        })
                        : { formation: null, supportProfile: null };
                    const runFormation = runResolution.formation;
                    // A broad NoData/protected span can invalidate the complete entry while each
                    // remaining surface run still has a sound formation. Promote those successful
                    // runs so terrain queries and the photoreal mask cannot fall back to datum zero.
                    if (runResolution.supportProfile) {
                        registerTerrainProfile(runResolution.supportProfile, entry);
                    }
                    surfaceRunRecords.push({
                        entry,
                        points,
                        formation: runFormation,
                        parentFormation: derivesFromFullFormation ? fullFormation : null
                    });
                });
            });
            // Segment profiles are fitted independently, but graph-connected endpoints are one
            // physical road node. Include recovered surface runs in the same reconciliation as valid
            // full entries, then derive split children so they inherit the final shared-node height.
            if (proposalTerrainProfiles.length > 1 && formationHelper
                && typeof formationHelper.reconcileProfileEndpointHeights === 'function') {
                formationHelper.reconcileProfileEndpointHeights(proposalTerrainProfiles);
            }
            surfaceRunRecords.forEach(record => {
                if (!record.parentFormation) return;
                record.formation = corridorFormationForPoints(record.points, function (x, y) {
                    return window.__corridorTerrainFormation.heightAt(record.parentFormation, x, y);
                }, record.entry.profile, 0);
                if (!record.formation || !record.formation.ok) {
                    terrainFailuresOut.push(corridorFormationFailureSummary(record.formation));
                    record.formation = null;
                }
            });
            const proposalTerrainHeightAt = proposalTerrainProfiles.length
                ? function (x, y) { return terrainHeightFromProfiles(proposalTerrainProfiles, x, y); }
                : null;

            surfaceRunRecords.forEach(record => {
                const entry = record.entry;
                const points = record.points;
                const runFormation = record.formation;
                    const runTerrainHeightAt = runFormation
                        ? function (x, y) { return window.__corridorTerrainFormation.heightAt(runFormation, x, y); }
                        : null;
                    if (runFormation && typeof corridorStripSpans === 'function') {
                        corridorStripSpans(entry.profile).forEach(strip => {
                            // A rail lane is drawn as real track, in the existing-tram style, riding
                            // the corridor terrain (runFormation) so it sits on the road in photo mode.
                            if (strip.type === 'rail') { addProposalTrack3D(targetGroup, points, strip, runFormation); return; }
                            const lane = (typeof CORRIDOR_LANE_TYPES !== 'undefined'
                                && CORRIDOR_LANE_TYPES[strip.type]) || {};
                            if (!addTerrainStrip3D(targetGroup, runFormation, strip, lane, strip.type)) {
                                console.warn('[three-mode] terrain strip skipped', strip.type);
                            }
                        });
                    } else {
                        // NoData is never treated as z=0. If a bounded profile cannot be formed, this
                        // one run retains the established flat rendering instead of diving to datum.
                        renderFlatSurface(points, entry);
                    }
                    const decorations = (typeof buildCorridorDecorations === 'function')
                        ? buildCorridorDecorations([points], entry.profile) : [];
                    addCorridorDecorations3D(targetGroup, decorations, runTerrainHeightAt);
                    addCorridorMarkings3D(targetGroup, { ...entry, points }, runTerrainHeightAt);

                    // The shader cut uses the exact successful run formation that produced the
                    // visible road. Protected tunnel/underpass/overpass edges are removed from that
                    // run first; a resulting sub-run inherits its parent's already-lifted profile.
                    if (terrainMode && runFormation && typeof corridorSurfaceRuns === 'function') {
                        const cutRuns = protectedRecords && protectedRecords.length
                            ? corridorSurfaceRuns([points], protectedRecords) : [points];
                        cutRuns.forEach(cutPoints => {
                            const cutFormation = corridorPointSequencesEqual(cutPoints, points)
                                ? runFormation
                                : corridorFormationForPoints(cutPoints, function (x, y) {
                                    return window.__corridorTerrainFormation.heightAt(runFormation, x, y);
                                }, entry.profile, 0);
                            addTerrainCutPatch(
                                terrainCutPatchesOut, cutFormation, entry.profile, proposal, entry);
                        });
                    }
            });
            addGradeSeparatedCorridors3D(
                targetGroup, definition, renderEntries, fallbackProfile, proposalTerrainHeightAt);
            // Junction patches sized per arm cover the seams where different widths meet.
            const junctions = (typeof buildCorridorJunctionTreatmentsForEntries === 'function')
                ? buildCorridorJunctionTreatmentsForEntries(surfaceRenderEntries)
                : ((typeof buildCorridorJunctionTreatments === 'function')
                    ? buildCorridorJunctionTreatments(centerline, fallbackProfile) : []);
            addCorridorJunctions3D(targetGroup, junctions, proposalTerrainHeightAt);
            } catch (error) {
                // One corrupt road must not strip the asphalt off EVERY road in 3D (the 2D renderer
                // already isolates per-proposal failures the same way).
                console.error('[three-mode] corridor strips failed for proposal', proposal?.proposalId, error);
            }
        });

        // Track surfaces use a different renderer, but building-tunnel metadata is common to both
        // corridor kinds, so liners are added in a second pass over every applied corridor proposal.
        proposalStorage.getAllProposals().forEach(proposal => {
            const definition = corridorProposalDefinition(proposal);
            if (!definition || !Array.isArray(definition.tunnels) || !definition.tunnels.length) return;
            if (!isApplied(proposal, proposal.roadProposal)) return;
            const terrainHeightAt = terrainProfilesOut.length
                ? function (x, y) { return terrainHeightFromProfiles(terrainProfilesOut, x, y); }
                : null;
            addBuildingTunnelLiners3D(targetGroup, definition, terrainHeightAt);
        });
    }

    // Every APPLIED park/square/lake footprint, as a clearance region { region, bbox }. A structure
    // footprint IS a clearance region: it razes the ground under it by default. See
    // structureClearanceCarve for why this record-less fallback exists.
    function collectAppliedStructureClearanceRegions() {
        const regions = [];
        if (typeof turf === 'undefined' || typeof proposalStorage === 'undefined') return regions;
        try {
            (proposalStorage.getAllProposals() || []).forEach(proposal => {
                const sp = proposal && proposal.structureProposal;
                if (!sp || !sp.geometry || !sp.geometry.type) return;
                if (!isApplied(proposal, sp)) return;
                try {
                    const region = { type: 'Feature', properties: {}, geometry: sp.geometry };
                    regions.push({ region, bbox: turf.bbox(region) });
                } catch (_) { }
            });
        } catch (error) {
            console.error('[three-mode] structure clearance regions could not be collected', error);
        }
        return regions;
    }

    // Carve one 3D mesh against the applied structure regions, in the SAME shape the record-based
    // carve returns: null (untouched) / { remainder: null, demolished } (razed whole) /
    // { remainder, demolished } (partial, at the footprint edge). The record carve
    // (carveBuildingByObjectId) hides a mesh only if the 2D footprint scan produced a record whose
    // id === object_id; a building that scan missed — a coverage gap, or a /buildings/near mesh with
    // no counterpart in the 2D footprint pool — has NO record and would otherwise survive inside the
    // park. This is the record-less clearance carve commit 18cf211 removed, now scoped to structures
    // only (roads keep their precise record-based cut, which handles tunnels and partial slices). A
    // park is a region, not a precise cut, so the hull-footprint approximation is immaterial here.
    function structureClearanceCarve(bld, regions) {
        if (!regions || !regions.length || typeof turf === 'undefined') return null;
        try {
            const footprint = buildingFootprintPolygon(bld);
            if (!footprint) return null;
            const footprintBbox = turf.bbox(footprint);
            const bboxesOverlap = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
            let demolishedUnion = null;
            for (const { region, bbox } of regions) {
                if (!bboxesOverlap(footprintBbox, bbox)) continue;
                let part = null;
                try { part = turf.intersect(footprint, region); } catch (_) { part = null; }
                if (!part || (Number(turf.area(part)) || 0) < 2) continue;
                if (!demolishedUnion) demolishedUnion = part;
                else { try { demolishedUnion = turf.union(demolishedUnion, part) || demolishedUnion; } catch (_) { } }
            }
            if (!demolishedUnion) return null;
            let remainder = null;
            try { remainder = turf.difference(footprint, demolishedUnion); } catch (_) { remainder = null; }
            const footprintArea = Number(turf.area(footprint)) || 0;
            const remainderArea = remainder ? (Number(turf.area(remainder)) || 0) : 0;
            const minArea = window.CARVE_MIN_REMAINDER_AREA_M2 || 10;
            const minFraction = window.CARVE_MIN_REMAINDER_FRACTION || 0.15;
            // Same sliver rule as the 2D cut: a remainder under max(10 m², 15%) is not worth keeping —
            // the whole building reads as demolished (small sheds fully inside a park clear cleanly).
            if (!remainder || remainderArea < Math.max(minArea, footprintArea * minFraction)) {
                return { remainder: null, demolished: (demolishedUnion.geometry) || footprint.geometry };
            }
            return { remainder: remainder.geometry, demolished: demolishedUnion.geometry };
        } catch (_) { return null; }
    }

    function buildNearbyProposalBuildings3D(targetGroup, buildingMaterial, visibility = {}) {
        // Existing buildings in the 3D view are drawn entirely from the `gdi_building_3d` city
        // model fetched via POST /buildings/near — the SAME GDI objects, under the SAME object_id,
        // that the 2D map serves and that cut/tunnel/demolish detection scans. So a demolished or
        // cut building is found here by ID, exactly. They stay reddish but follow the Built
        // solid/transparent control like every other existing building.
        try {
            // The carve lives in corridor-carve.js — the SAME module the server runs, so the 3D
            // view here and the walk sim's carved meshes cannot disagree about which buildings
            // survive. Hard dependency: a missing export is a load-order bug, fail loud.
            //
            // There is no geometry matching here any more, and no thresholds. A demolition record
            // NAMES its mesh (record.id === object_id) and carries the polygons the draw-time
            // subtraction produced against that object's own footprint. Lookup, not guesswork.
            // A TUNNELLED building simply has no record, so it comes back untouched.
            const carveRecords = window.collectCarveRecords(
                (typeof proposalStorage !== 'undefined' && proposalStorage.getAllProposals()) || [],
                {
                    consolidateCorridorRecords: (records, region) =>
                        window.consolidateCorridorDemolitionRecords(records, region, window.turf),
                    consolidateBuildingRecords: records =>
                        window.consolidateBuildingDemolitionRecords(records, window.turf)
                }
            );
            // One response can contain the same source surface twice: within one object (usually
            // opposite winding) or across adjacent/duplicate object_ids. Share these sets across the
            // entire rebuild so only one copy reaches the depth buffer.
            const meshDedupeState = { seenFaceKeys: new Set(), seenTriangleKeys: new Set() };
            const demolishedMaterial = demolishedMaterialFor(buildingMaterial);
            // null → untouched; { remainder: null, demolished } → whole building razed;
            // { remainder, demolished } → partial: prisms for both parts. Both are raw geometries.
            const asFeature = (geometry) => (geometry ? { type: 'Feature', properties: {}, geometry } : null);
            // Structures clear their whole footprint even for meshes the 2D scan never recorded.
            const structureRegions = collectAppliedStructureClearanceRegions();
            if (Array.isArray(nearbyProposalBuildings) && nearbyProposalBuildings.length > 0) {
                nearbyProposalBuildings.forEach(bld => {
                    try {
                        const carve = window.carveBuildingByObjectId(bld.object_id, carveRecords)
                            || structureClearanceCarve(bld, structureRegions);
                        const renderParts = buildingDisplayPolicy.resolveBuildingRenderParts(carve, visibility);
                        if (!carve) {
                            if (!renderParts.detailed) return;
                            const mesh = buildMeshFromBuilding3D(bld, buildingMaterial, meshDedupeState);
                            if (mesh) targetGroup.add(mesh);
                            return;
                        }
                        if (carve.remainder) {
                            // PARTIAL demolition: the real mesh cannot be sliced, so the affected
                            // building trades facade detail for truth — two extruded prisms at
                            // its measured height: the surviving remainder in normal material,
                            // the demolished part as a condemned volume (absent in Surviving).
                            const height = building3DHeightMeters(bld);
                            const remainder = asFeature(carve.remainder);
                            const demolished = asFeature(carve.demolished);
                            if (renderParts.remainder && remainder) {
                                polygonFeatureToMeshes(remainder, buildingMaterial, 0, height)
                                    .forEach(m => targetGroup.add(m));
                            }
                            if (renderParts.demolished && demolished) {
                                polygonFeatureToMeshes(demolished, demolishedMaterial, 0, height)
                                    .forEach(m => targetGroup.add(m));
                            }
                            return;
                        }
                        if (!renderParts.detailed) return;
                        const mesh = buildMeshFromBuilding3D(bld, demolishedMaterial, meshDedupeState);
                        if (mesh) targetGroup.add(mesh);
                    } catch (e) {
                        console.warn('Failed to build 3D mesh for building', bld && bld.object_id, e);
                    }
                });
            }
        } catch (_) { }
        ensureNearbyProposalBuildings();
    }

    // Height of a { z_min, z_max, faces[] } building in metres; falls back to scanning face
    // vertices when z_max is absent.
    function building3DHeightMeters(bld) {
        const zmin = Number(bld?.z_min);
        const zmax = Number(bld?.z_max);
        if (Number.isFinite(zmin) && Number.isFinite(zmax) && zmax > zmin) return zmax - zmin;
        let top = -Infinity;
        let bottom = Infinity;
        (bld?.faces || []).forEach(face => {
            (face?.coordinates || []).forEach(ring => {
                (ring || []).forEach(c => {
                    if (c && Number.isFinite(c[2])) {
                        if (c[2] > top) top = c[2];
                        if (c[2] < bottom) bottom = c[2];
                    }
                });
            });
        });
        return (Number.isFinite(top) && Number.isFinite(bottom) && top > bottom) ? (top - bottom) : 10;
    }

    // Build a THREE.Mesh from a { object_id, z_min, faces[] } building returned by /buildings/near.
    // Each face is a flat 3D polygon (wall section or roof panel). We triangulate each face in
    // its best-fit 2D plane, then lift the triangles back to their original 3D vertices.
    function buildMeshFromBuilding3D(bld, material, dedupeState = {}) {
        if (!bld || !Array.isArray(bld.faces) || bld.faces.length === 0) return null;
        const groundZ = Number.isFinite(bld.z_min) ? bld.z_min : 0;

        const positions = [];

        for (let fi = 0; fi < bld.faces.length; fi++) {
            const face = bld.faces[fi];
            if (!face || face.type !== 'Polygon' || !Array.isArray(face.coordinates)) continue;
            const rings = face.coordinates;
            if (rings.length === 0) continue;

            // Convert each ring's [lng, lat, z] → local-XY [x, y, z-groundZ] and drop the closing point.
            const convertedRings = rings.map(ring => {
                const pts = [];
                for (let i = 0; i < ring.length - 1; i++) {
                    const c = ring[i];
                    if (!c || c.length < 2) continue;
                    const [x, y] = latLngToXY(c[1], c[0]);
                    const z = (Number.isFinite(c[2]) ? c[2] : groundZ) - groundZ;
                    pts.push([x, y, z]);
                }
                return pts;
            }).filter(r => r.length >= 3);

            if (convertedRings.length === 0) continue;
            const prepared = meshSanitize.prepareFaceRings(convertedRings, {
                seenFaceKeys: dedupeState.seenFaceKeys
            });
            if (!prepared) continue;
            const outer = prepared.rings[0];
            const holes = prepared.rings.slice(1);

            // Compute face normal from the outer ring (Newell's method — robust for non-trivial polygons).
            let nx = 0, ny = 0, nz = 0;
            for (let i = 0; i < outer.length; i++) {
                const a = outer[i];
                const b = outer[(i + 1) % outer.length];
                nx += (a[1] - b[1]) * (a[2] + b[2]);
                ny += (a[2] - b[2]) * (a[0] + b[0]);
                nz += (a[0] - b[0]) * (a[1] + b[1]);
            }
            const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
            // Drop the axis with the largest normal component (project onto the other two).
            let dropAxis = 2;
            if (ax >= ay && ax >= az) dropAxis = 0;
            else if (ay >= ax && ay >= az) dropAxis = 1;

            const project = (p) => {
                if (dropAxis === 0) return new THREE.Vector2(p[1], p[2]);
                if (dropAxis === 1) return new THREE.Vector2(p[0], p[2]);
                return new THREE.Vector2(p[0], p[1]);
            };

            const contour2D = outer.map(project);
            const holes2D = holes.map(h => h.map(project));

            // THREE.ShapeUtils.triangulateShape expects the contour and an array of holes and
            // returns an array of triangles, each triangle being [i0, i1, i2] indices into the
            // concatenated [contour, ...holes] list.
            let triangles;
            try {
                triangles = THREE.ShapeUtils.triangulateShape(contour2D, holes2D);
            } catch (_) {
                continue;
            }
            if (!triangles || triangles.length === 0) continue;

            const flat3D = outer.slice();
            for (let h = 0; h < holes.length; h++) {
                for (let j = 0; j < holes[h].length; j++) flat3D.push(holes[h][j]);
            }

            for (let t = 0; t < triangles.length; t++) {
                const tri = triangles[t];
                const vertices = tri.map(index => flat3D[index]).filter(Boolean);
                if (vertices.length !== 3) continue;
                meshSanitize.appendUniqueTriangle(positions, vertices, {
                    seenTriangleKeys: dedupeState.seenTriangleKeys
                });
            }
        }

        if (positions.length === 0) return null;

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.computeVertexNormals();

        // Use a two-sided material clone so back faces (from inconsistent winding in source data) still render.
        const mat = cloneBuildingMaterial(material);
        mat.side = THREE.DoubleSide;
        const mesh = new THREE.Mesh(geometry, mat);
        attachBuildingDepthPrepass(mesh);
        mesh.userData.isNearbyBuilding3D = true;
        // Existing buildings carry no parcelId. Stamp a footprint center (as [lng, lat])
        // so parcel-isolation can later test which parcel this building sits on.
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < positions.length; i += 3) {
            const x = positions[i], y = positions[i + 1];
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
        try {
            const ll = xyToLatLng((minX + maxX) / 2, (minY + maxY) / 2);
            if (ll) mesh.userData.footprintLatLng = [ll.lng, ll.lat];
        } catch (_) { }
        return mesh;
    }

    // --- Nearby buildings (sourced from gdi_building_3d via POST /buildings/near) ---
    // Query preference:
    //   1. Union-bbox of `window.proposedBuildings` (which already aggregates a chain of
    //      applied proposals). The backend uses ST_DWithin so this loads everything within
    //      100m of the proposal's outer shape — exactly the neighbour band the user wants,
    //      and robust to large proposals where the centroid would miss real neighbours.
    //   2. Fallback: the OrbitControls camera focus as a point + 150m radius, for the
    //      (rare) case of entering 3D without a proposal.
    let nearbyProposalBuildings = [];
    let nearbyProposalBuildingsKey = null;
    let nearbyProposalBuildingsFetching = false;
    // How far out (metres) built context is fetched & rendered around the focus. User-adjustable
    // via the Radius slider in the 3D panel; dense cities (e.g. NYC) need a wider radius to look
    // right — at the tighter end a sparse spot like a park can yield only a handful of buildings.
    const BUILDING_RADIUS_MIN_M = 100;
    const BUILDING_RADIUS_MAX_M = 500;
    let buildingLoadRadiusM = 300;
    // Camera framing band around a proposal — fixed, independent of the load radius, so widening
    // the radius loads more context without pulling the camera back and shrinking the proposal.
    const NEARBY_FRAME_PAD_M = 100;
    // Round fallback focus coords to ~55m so we only refetch after meaningful camera movement.
    const NEARBY_BUILDINGS_KEY_PRECISION = 0.0005;

    function xyToLatLng(x, y) {
        if (!origin3857) return null;
        try {
            const p = L.point(x + origin3857.x, y + origin3857.y);
            const ll = L.CRS.EPSG3857.unproject(p);
            return { lat: ll.lat, lng: ll.lng };
        } catch (_) { return null; }
    }

    function computeProposalQueryGeometry() {
        const arr = (typeof window !== 'undefined' && Array.isArray(window.proposedBuildings)) ? window.proposedBuildings : [];
        if (!arr || arr.length === 0) return null;
        if (typeof turf === 'undefined' || !turf) return null;
        // Only consider proposal buildings in the active city. proposedBuildings is a global,
        // cross-session list, so a stale Zagreb building must not define the NYC nearby-buildings
        // query bbox (which would query Socrata around Zagreb → "loaded 0 nearby 3d buildings").
        const cityId = (typeof window !== 'undefined' && window.CityConfigManager
                && typeof window.CityConfigManager.getCurrentCityId === 'function')
            ? window.CityConfigManager.getCurrentCityId() : null;
        const isInCityFn = (typeof isInCity === 'function') ? isInCity
            : ((typeof window !== 'undefined' && typeof window.isInCity === 'function') ? window.isInCity : null);
        const inActiveCity = (f) => {
            if (!cityId || !isInCityFn) return true;
            const props = (f && f.properties) || {};
            const ids = Array.isArray(props.parentParcelIds) && props.parentParcelIds.length
                ? props.parentParcelIds
                : (props.parcelId ? [props.parcelId] : []);
            if (!ids.length) return true;
            return ids.some(id => isInCityFn(id, cityId));
        };
        const features = [];
        for (let i = 0; i < arr.length; i++) {
            const f = arr[i];
            if (f && f.geometry && inActiveCity(f)) features.push(f);
        }
        if (features.length === 0) return null;
        // Frame ONLY the proposals in focus — the ones a shared link named, or the one selected on the
        // map — so the camera lands on them rather than on the union bbox of every applied proposal. A
        // big cached proposal on another block would otherwise drag the centre away.
        let framed = features;
        const focusIds = focusedProposalIds();
        if (focusIds && focusIds.size) {
            const subset = features.filter(f => {
                const pid = (f.properties && f.properties.proposalId != null) ? String(f.properties.proposalId) : null;
                return pid && focusIds.has(pid);
            });
            console.log('[3D] framing subset: ' + subset.length + '/' + features.length
                + ' features match ' + focusIds.size + ' focus ids'
                + (subset.length ? '' : ' — FALLING BACK to all applied'));
            if (subset.length) framed = subset;
        }
        try {
            const bbox = turf.bbox(turf.featureCollection(framed));
            if (!bbox || bbox.some(v => !isFinite(v))) return null;
            const [minX, minY, maxX, maxY] = bbox;
            return {
                type: 'Polygon',
                coordinates: [[
                    [minX, minY],
                    [maxX, minY],
                    [maxX, maxY],
                    [minX, maxY],
                    [minX, minY]
                ]]
            };
        } catch (_) { return null; }
    }

    function computeCameraFocusGeometry() {
        let lat = null, lng = null;
        if (controls && controls.target) {
            const ll = xyToLatLng(controls.target.x, controls.target.y);
            if (ll) { lat = ll.lat; lng = ll.lng; }
        }
        if (lat === null && typeof map !== 'undefined' && map) {
            try {
                const c = map.getCenter();
                lat = c.lat; lng = c.lng;
            } catch (_) { }
        }
        if (lat === null) return null;
        return { type: 'Point', coordinates: [lng, lat] };
    }

    function captureSceneLoadGeometry() {
        const proposalGeometry = proposalFramingGeometry();
        const appliedWorkGeometry = appliedWorkFramingGeometry();
        const entryAnchorGeometry = snapshotNavigation.captureSceneLoadAnchor(computeCameraFocusGeometry());
        const selected = snapshotNavigation.resolveSceneLoadGeometry({
            proposalGeometry,
            appliedWorkGeometry,
            entryAnchorGeometry
        });
        sceneLoadGeometry = snapshotNavigation.captureSceneLoadAnchor(selected);
        sceneLoadGeometrySource = proposalGeometry
            ? 'proposal'
            : (appliedWorkGeometry ? 'plan' : 'camera');
        sceneTreeLoadGeometry = snapshotNavigation.captureSceneLoadAnchor(
            proposalGeometry || entryAnchorGeometry
        );
        sceneTreeLoadGeometrySource = proposalGeometry ? 'proposal' : 'camera';
    }

    // Everything the user has placed on the map, as one bbox superpolygon: entering 3D loads
    // the built context around the WHOLE plan (edges + apron), not just around the camera.
    function appliedWorkFramingGeometry() {
        try {
            const proposals = (typeof proposalStorage !== 'undefined' && typeof proposalStorage.getAllProposals === 'function')
                ? proposalStorage.getAllProposals()
                : [];
            let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
            let found = false;
            const extend = geometry => {
                if (!geometry || !geometry.type) return;
                try {
                    const [a, b, c, d] = turf.bbox({ type: 'Feature', properties: {}, geometry });
                    if (![a, b, c, d].every(Number.isFinite)) return;
                    minLng = Math.min(minLng, a);
                    minLat = Math.min(minLat, b);
                    maxLng = Math.max(maxLng, c);
                    maxLat = Math.max(maxLat, d);
                    found = true;
                } catch (_) { }
            };
            proposals.forEach(proposal => {
                const applied = (typeof isProposalApplied === 'function') ? isProposalApplied(proposal) : false;
                if (!applied) return;
                extend(proposal.roadProposal?.definition?.polygon);
                extend(proposal.structureProposal?.geometry);
                (proposal.geometry?.buildings || []).forEach(feature => extend(feature?.geometry));
                (proposal.reparcellization?.polygons || []).forEach(polygon => extend(polygon?.geometry));
            });
            if (!found) return null;
            return {
                type: 'Polygon',
                coordinates: [[[minLng, minLat], [maxLng, minLat], [maxLng, maxLat], [minLng, maxLat], [minLng, minLat]]]
            };
        } catch (error) {
            console.error('[three-mode] applied-work framing failed', error);
            return null;
        }
    }

    function ensureNearbyProposalBuildings() {
        if (nearbyProposalBuildingsFetching) return;

        // The query geometry was frozen at 3D entry. Panning moves only the camera over this
        // snapshot; it never streams a new band of buildings. The radius control may explicitly
        // refetch a wider band around this same anchor.
        const queryGeometry = sceneLoadGeometry;
        if (!queryGeometry) return;
        const proposalGeom = queryGeometry.type === 'Point' ? null : queryGeometry;
        let geometry, buffer, key;
        if (proposalGeom) {
            geometry = proposalGeom;
            // The backend buffers the proposal bbox, so `buffer` is measured from the EDGES.
            // Coverage target: max(edges + 200 m, roughly centre + slider radius) — a small
            // proposal keeps the slider's radius of context, while a block-spanning one still
            // gets a 200 m apron instead of the radius vanishing inside its own extent.
            let halfDiagonalM = 0;
            try {
                const ring = proposalGeom.coordinates[0];
                halfDiagonalM = (turf.distance(ring[0], ring[2], { units: 'kilometers' }) * 1000) / 2;
            } catch (_) { }
            buffer = Math.max(200, buildingLoadRadiusM - halfDiagonalM);
            // Key from bbox coords rounded to 6 decimals (~10cm) — essentially exact. Radius is
            // part of the key so moving the slider forces a refetch at the new radius.
            const bb = proposalGeom.coordinates[0];
            key = 'prop:' + bb.map(p => p.map(n => n.toFixed(6)).join(',')).join('|') + '|r' + buildingLoadRadiusM;
        } else {
            const pt = queryGeometry;
            if (!pt) return;
            geometry = pt;
            buffer = buildingLoadRadiusM;
            const snap = v => Math.round(v / NEARBY_BUILDINGS_KEY_PRECISION) * NEARBY_BUILDINGS_KEY_PRECISION;
            key = `pt:${snap(pt.coordinates[0]).toFixed(5)},${snap(pt.coordinates[1]).toFixed(5)}|r${buildingLoadRadiusM}`;
        }

        if (key === nearbyProposalBuildingsKey) return;

        nearbyProposalBuildingsFetching = true;
        updateBuildingsLoader();
        const base = (typeof window !== 'undefined' && typeof window.getBackendBase === 'function') ? window.getBackendBase() : '';
        // The 3D building source is city-specific (resolved server-side from this id).
        let city;
        try { city = window.CityConfigManager && window.CityConfigManager.getCurrentCityId(); } catch (_) { }
        fetch(`${base}/buildings/near`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ geometry, buffer_meters: buffer, city })
        })
            .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
            .then(payload => {
                const rawBuildings = (payload && Array.isArray(payload.buildings)) ? payload.buildings : [];
                nearbyProposalBuildings = dedupeCoincidentBuildings(rawBuildings);
                nearbyProposalBuildingsKey = key;
                nearbyProposalBuildingsFetching = false;
                const dupCount = rawBuildings.length - nearbyProposalBuildings.length;
                console.log(`[3D] Loaded ${nearbyProposalBuildings.length} nearby 3D buildings (${sceneLoadGeometrySource}+${buffer}m${dupCount > 0 ? `, dropped ${dupCount} coincident duplicate${dupCount === 1 ? '' : 's'}` : ''})`);
                if (isActive) rebuild3DBuildingsOnly();
                updateBuildingsLoader();
            })
            .catch(err => {
                console.warn('Failed to fetch nearby buildings:', err);
                nearbyProposalBuildingsFetching = false;
                updateBuildingsLoader();
            });
    }

    // --- Real-world OSM trees (Overture base/land) ---
    // Toggleable scenery fetched via POST /decor/near using the SAME query geometry + radius as the
    // nearby buildings, then rendered as two InstancedMesh layers (trunk + crown) so a few thousand
    // trees cost two draw calls. Cities without ingested trees just get an empty list (no-op).
    const TREES_STORAGE_KEY = 'cb_3d_trees_enabled';
    let nearbyTrees = [];               // [[lng, lat], ...] from the backend
    let nearbyTreesKey = null;          // query key so we don't refetch the same band
    let nearbyTreesFetching = false;

    function loadTreesEnabledPref() {
        try {
            if (typeof PersistentStorage !== 'undefined' && PersistentStorage) {
                const v = PersistentStorage.getItem(TREES_STORAGE_KEY);
                if (v === '0' || v === 'false') return false;
                if (v === '1' || v === 'true') return true;
            }
        } catch (_) { }
        return true; // default ON
    }

    // Deterministic [0,1) hash from a tree's lng/lat so each tree's height/jitter is stable across
    // rebuilds (no flicker) without storing per-tree attributes.
    function treeRng(lng, lat) {
        let h = Math.imul(((lng * 1e6) | 0) ^ 0x9e3779b9, 0x85ebca6b);
        h ^= Math.imul(((lat * 1e6) | 0) ^ 0x165667b1, 0xc2b2ae35);
        h = (h ^ (h >>> 15)) >>> 0;
        return (h % 100000) / 100000;
    }

    // Shared base geometries (unit-sized; per-tree size comes from the instance matrix). The trunk
    // cylinder is rotated so its length runs along +Z to match the Z-up scene.
    let treeTrunkGeo = null, treeCrownGeo = null, treeTrunkMat = null, treeCrownMat = null;
    function ensureTreeAssets() {
        if (treeTrunkGeo) return;
        treeTrunkGeo = new THREE.CylinderGeometry(0.12, 0.18, 1, 5);
        treeTrunkGeo.rotateX(Math.PI / 2); // Y-length → Z-length (scene is Z-up)
        treeCrownGeo = new THREE.SphereGeometry(1, 6, 5);
        treeTrunkMat = new THREE.MeshLambertMaterial({ color: 0x5c3d1e });
        treeCrownMat = new THREE.MeshLambertMaterial({ color: 0x3a6b35 });
    }

    function disposeTreesGroup() {
        if (!treesGroup) return;
        for (let i = treesGroup.children.length - 1; i >= 0; i--) {
            const c = treesGroup.children[i];
            treesGroup.remove(c);
            if (c.geometry && c.geometry !== treeTrunkGeo && c.geometry !== treeCrownGeo) c.geometry.dispose();
        }
    }

    function buildTreesGroup() {
        if (!treesGroup || !Array.isArray(nearbyTrees) || nearbyTrees.length === 0 || !origin3857) return;
        ensureTreeAssets();
        const n = nearbyTrees.length;
        const trunkMesh = new THREE.InstancedMesh(treeTrunkGeo, treeTrunkMat, n);
        const crownMesh = new THREE.InstancedMesh(treeCrownGeo, treeCrownMat, n);
        const dummy = new THREE.Object3D();
        let placed = 0;
        for (let i = 0; i < n; i++) {
            const t = nearbyTrees[i];
            if (!t || t.length < 2) continue;
            const [x, y] = latLngToXY(t[1], t[0]);
            const r = treeRng(t[0], t[1]);
            const totalH = 5 + r * 8;          // ~5–13 m, deterministic per tree
            const trunkH = totalH * 0.48;
            const crownR = totalH * 0.20 + 0.5;

            dummy.position.set(x, y, trunkH / 2);
            dummy.scale.set(1, 1, trunkH);
            dummy.rotation.set(0, 0, 0);
            dummy.updateMatrix();
            trunkMesh.setMatrixAt(placed, dummy.matrix);

            dummy.position.set(x, y, trunkH + crownR * 0.65);
            dummy.scale.set(crownR, crownR, crownR * 1.15);
            dummy.updateMatrix();
            crownMesh.setMatrixAt(placed, dummy.matrix);
            placed++;
        }
        trunkMesh.count = placed;
        crownMesh.count = placed;
        trunkMesh.instanceMatrix.needsUpdate = true;
        crownMesh.instanceMatrix.needsUpdate = true;
        treesGroup.add(trunkMesh);
        treesGroup.add(crownMesh);
    }

    function rebuildTreesOnly() {
        if (!isActive || !treesGroup) return;
        disposeTreesGroup();
        if (treesEnabled) buildTreesGroup();
    }

    function ensureNearbyTrees() {
        if (!treesEnabled || nearbyTreesFetching) return;

        const queryGeometry = sceneTreeLoadGeometry;
        if (!queryGeometry) return;
        const proposalGeom = queryGeometry.type === 'Point' ? null : queryGeometry;
        let geometry, buffer, key;
        if (proposalGeom) {
            geometry = proposalGeom;
            buffer = buildingLoadRadiusM;
            const bb = proposalGeom.coordinates[0];
            key = 'prop:' + bb.map(p => p.map(n => n.toFixed(6)).join(',')).join('|') + '|r' + buildingLoadRadiusM;
        } else {
            const pt = queryGeometry;
            if (!pt) return;
            geometry = pt;
            buffer = buildingLoadRadiusM;
            const snap = v => Math.round(v / NEARBY_BUILDINGS_KEY_PRECISION) * NEARBY_BUILDINGS_KEY_PRECISION;
            key = `pt:${snap(pt.coordinates[0]).toFixed(5)},${snap(pt.coordinates[1]).toFixed(5)}|r${buildingLoadRadiusM}`;
        }
        if (key === nearbyTreesKey) return;

        nearbyTreesFetching = true;
        const base = (typeof window !== 'undefined' && typeof window.getBackendBase === 'function') ? window.getBackendBase() : '';
        let city;
        try { city = window.CityConfigManager && window.CityConfigManager.getCurrentCityId(); } catch (_) { }
        fetch(`${base}/decor/near`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ geometry, buffer_meters: buffer, city, kinds: ['trees'] })
        })
            .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
            .then(payload => {
                nearbyTrees = (payload && Array.isArray(payload.trees)) ? payload.trees : [];
                nearbyTreesKey = key;
                nearbyTreesFetching = false;
                console.log(`[3D] Loaded ${nearbyTrees.length} nearby trees (${sceneTreeLoadGeometrySource}+${buffer}m)`);
                if (isActive) rebuildTreesOnly();
            })
            .catch(err => {
                console.warn('Failed to fetch nearby trees:', err);
                nearbyTreesFetching = false;
            });
    }

    // Flip the trees toggle: persist, show/hide the group, and fetch+build on first enable.
    function setTreesEnabled(on) {
        treesEnabled = !!on;
        try { PersistentStorage.setItem(TREES_STORAGE_KEY, treesEnabled ? '1' : '0'); } catch (_) { }
        if (treesGroup) treesGroup.visible = treesEnabled && !realisticLayerActive;
        if (treesEnabled) {
            ensureNearbyTrees();
            rebuildTreesOnly();
        }
    }

    // Registry of renderable scenery layers: maps an overture_feature layer key to its panel label and
    // enable/disable hooks. The 3D panel renders a checkbox per layer that BOTH appears here AND is
    // reported available by GET /decor/layers for the current city. Add a layer's renderer + an entry
    // here and it shows up automatically wherever it's been ingested.
    const DECOR_LAYERS = {
        trees: { label: 'Trees', isEnabled: () => treesEnabled, setEnabled: (on) => setTreesEnabled(on) }
    };

    // Render one checkbox per available scenery layer (intersection of DECOR_LAYERS and `available`).
    function renderDecorToggles(available) {
        if (!decorTogglesEl) return;
        decorTogglesEl.innerHTML = '';
        for (const key of available) {
            const spec = DECOR_LAYERS[key];
            if (!spec) continue; // ingested layer with no frontend renderer yet — skip silently
            const row = document.createElement('div');
            row.className = 'three-mode-trees-row';
            const label = document.createElement('label');
            label.className = 'three-mode-trees-toggle';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = spec.isEnabled();
            cb.addEventListener('change', () => spec.setEnabled(cb.checked));
            const text = document.createElement('span');
            text.className = 'three-mode-emphasis-label';
            // Resolve at render time (after i18n loads); falls back to the DECOR_LAYERS label.
            text.textContent = threeI18n('threeMode.controls.' + key, spec.label);
            label.appendChild(cb);
            label.appendChild(text);
            row.appendChild(label);
            decorTogglesEl.appendChild(row);
        }
    }

    // Ask the backend which scenery layers the active city has, then render toggles for them. Called
    // on entering 3D (city may have changed); cities with no scenery get no toggles.
    function refreshDecorToggles() {
        if (!decorTogglesEl) return;
        let city;
        try { city = window.CityConfigManager && window.CityConfigManager.getCurrentCityId(); } catch (_) { }
        if (!city) { decorTogglesEl.innerHTML = ''; return; }
        const base = (typeof window !== 'undefined' && typeof window.getBackendBase === 'function') ? window.getBackendBase() : '';
        fetch(`${base}/decor/layers?city=${encodeURIComponent(city)}`)
            .then(r => (r.ok ? r.json() : { layers: [] }))
            .then(payload => renderDecorToggles((payload && Array.isArray(payload.layers)) ? payload.layers : []))
            .catch(() => { /* leave whatever's there; toggles are non-critical */ });
    }

    function buildProposedBuildings3D(targetGroup, buildingMaterial) {
        const arr = (typeof window !== 'undefined' && Array.isArray(window.proposedBuildings)) ? window.proposedBuildings : [];
        if (!arr || arr.length === 0) return;
        for (let i = 0; i < arr.length; i++) {
            const feat = arr[i];
            if (!feat || !feat.geometry) continue;
            try {
                // Uploaded buildings carry a glTF model URL — render the real mesh instead of an extruded box.
                if (feat.properties && feat.properties.modelUrl) {
                    placeUploadedModel(feat, targetGroup, buildingMaterial);
                    continue;
                }
                const height = estimateBuildingHeightMeters(feat);
                createBuildingSlices(feat, height, buildingMaterial, targetGroup);
            } catch (_) { }
        }
    }

    // Cache of parsed glTF scenes keyed by URL; cloned per placement (geometry/materials shared).
    const gltfModelCache = new Map();
    let buildingsRenderGeneration = 0;

    function loadGltfScene(url) {
        if (gltfModelCache.has(url)) return gltfModelCache.get(url);
        const promise = new Promise((resolve, reject) => {
            const LoaderCtor = (typeof THREE !== 'undefined' && THREE.GLTFLoader) ? THREE.GLTFLoader : null;
            if (!LoaderCtor) { reject(new Error('GLTFLoader unavailable')); return; }
            new LoaderCtor().load(
                url,
                (gltf) => resolve(gltf.scene || (gltf.scenes && gltf.scenes[0]) || null),
                undefined,
                (err) => reject(err)
            );
        });
        gltfModelCache.set(url, promise);
        return promise;
    }

    // Loads an uploaded building model and places it at the footprint centroid, grounded and
    // oriented (glTF Y-up → scene Z-up). Async: meshes pop in when the file finishes loading.
    function placeUploadedModel(feat, targetGroup, buildingMaterial) {
        let cx = 0, cy = 0, lat = 0;
        try {
            const c = turf.centroid(feat);
            const [lng, latC] = c.geometry.coordinates;
            lat = latC;
            const xy = latLngToXY(lat, lng);
            cx = xy[0]; cy = xy[1];
        } catch (_) { return; }

        const url = feat.properties.modelUrl;
        const gen = buildingsRenderGeneration;
        const buildingOpacity = buildingOpacityOf(buildingMaterial);
        const stale = () => !isActive || gen !== buildingsRenderGeneration || targetGroup !== buildingGroup;
        // The scene's XY is Web-Mercator (EPSG:3857), which inflates horizontal distance by
        // ~1/cos(lat) vs real meters, while extrude heights use raw meters. The glTF model is in
        // real meters, so scale its footprint (X/Y) by this factor to match surrounding buildings;
        // height (Z) stays 1:1.
        const horizScale = 1 / Math.max(0.1, Math.cos(lat * Math.PI / 180));

        pendingModelLoads++;
        updateBuildingsLoader();
        loadGltfScene(url).then((scene) => {
            if (stale() || !scene) return;
            const inner = scene.clone(true);
            inner.rotation.x = Math.PI / 2; // glTF Y-up → scene Z-up
            inner.updateMatrixWorld(true);

            const box = new THREE.Box3().setFromObject(inner);
            if (box.isEmpty()) return;
            const center = new THREE.Vector3();
            box.getCenter(center);
            // Center the footprint on the origin and sit the base on the ground (z=0).
            inner.position.set(-center.x, -center.y, -box.min.z);

            const wrapper = new THREE.Group();
            wrapper.add(inner);
            wrapper.scale.set(horizScale, horizScale, 1);
            wrapper.position.set(cx, cy, 0);

            // Collect before attaching depth children: mutating an Object3D hierarchy during
            // traverse would make the newly-added prepass meshes participate in this same walk.
            const modelMeshes = [];
            wrapper.traverse((node) => {
                if (node.isMesh && node.material) modelMeshes.push(node);
            });
            modelMeshes.forEach((node) => {
                // scene.clone(true) still shares glTF materials with the cache and other
                // placements. Clone each one before applying this display mode, then use the
                // same stable transparency path as generated building geometry.
                const sourceMaterials = Array.isArray(node.material) ? node.material : [node.material];
                const configuredMaterials = sourceMaterials.map((sourceMaterial) => {
                    if (!sourceMaterial) return sourceMaterial;
                    const cloned = sourceMaterial.clone();
                    return configureBuildingMaterial(cloned, buildingOpacity);
                });
                node.material = Array.isArray(node.material) ? configuredMaterials : configuredMaterials[0];
                attachBuildingDepthPrepass(node);
            });
            targetGroup.add(wrapper);
        }).catch((err) => {
            // Fall back to the extruded box so the building is still visible.
            if (stale()) return;
            try {
                const height = estimateBuildingHeightMeters(feat);
                createBuildingSlices(feat, height, buildingMaterial, targetGroup);
            } catch (_) { }
            if (typeof console !== 'undefined') console.warn('Building model load failed, used box fallback:', url, err);
        }).finally(() => {
            pendingModelLoads = Math.max(0, pendingModelLoads - 1);
            updateBuildingsLoader();
        });
    }

    function stringToColor(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = str.charCodeAt(i) + ((hash << 5) - hash);
        }
        let color = '#';
        for (let i = 0; i < 3; i++) {
            let value = (hash >> (i * 8)) & 0xFF;
            color += ('00' + value.toString(16)).substr(-2);
        }
        return color;
    }

    // Floor lines: thin horizontal divisions every storey, so a proposal box reads as an
    // N-storey building rather than an undifferentiated mass. Proposal buildings ONLY —
    // createBuildingSlices is the proposed-building path (existing/context buildings go through
    // buildNearbyProposalBuildings3D). The step is the SAME storey height the height estimator
    // uses (building-height.js), so a level-derived building's lines land exactly on its storeys.
    // Perspective handles the spacing for free (closer buildings show their floors farther apart,
    // like the lane markings); the lines sit a few centimetres proud of the wall so depth-testing
    // keeps them on the near faces only, never x-rayed through.
    const floorLineMaterial = new THREE.LineBasicMaterial({
        color: 0x2a2f36, transparent: true, opacity: 0.4, depthWrite: false
    });

    function buildingFloorRingsXY(buildingFeature) {
        // Outer + courtyard rings of the footprint, nudged ~0.06 m outward (real metres) so the
        // floor lines clear the wall plane and win the depth test on the faces we can see.
        let feature = buildingFeature;
        try {
            const buffered = turf.buffer(buildingFeature, 0.06, { units: 'meters' });
            if (buffered && buffered.geometry) feature = buffered;
        } catch (_) { }
        const geom = feature.geometry;
        const polys = geom.type === 'Polygon' ? [geom.coordinates]
            : geom.type === 'MultiPolygon' ? geom.coordinates : [];
        const rings = [];
        polys.forEach(poly => poly.forEach(ring => {
            if (!Array.isArray(ring) || ring.length < 4) return;
            rings.push(ring.map(c => latLngToXY(c[1], c[0])));
        }));
        return rings;
    }

    function addBuildingFloorLines(buildingFeature, height, targetGroup) {
        const step = (typeof window !== 'undefined' && Number(window.STOREY_HEIGHT_M)) || 3.3;
        if (!(height > step * 1.5)) return; // nothing to divide on a ~1-storey box
        let rings;
        try { rings = buildingFloorRingsXY(buildingFeature); } catch (_) { return; }
        if (!rings.length) return;
        const positions = [];
        for (let z = step; z < height - 0.4; z += step) {
            rings.forEach(xy => {
                for (let i = 0; i < xy.length - 1; i++) {
                    positions.push(xy[i][0], xy[i][1], z, xy[i + 1][0], xy[i + 1][1], z);
                }
            });
        }
        if (!positions.length) return;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        const lines = new THREE.LineSegments(geometry, floorLineMaterial);
        lines.userData.isBuildingFloorLines = true;
        targetGroup.add(lines);
    }

    function createBuildingSlices(buildingFeature, height, material, targetGroup) {
        if (!buildingFeature || !buildingFeature.geometry || typeof parcelLayer === 'undefined' || !parcelLayer) {
            const meshes = polygonFeatureToMeshes(buildingFeature, material, 0, height);
            meshes.forEach(m => targetGroup.add(m));
            return;
        }

        const candidateParcels = [];
        try {
            const bBbox = turf.bbox(buildingFeature);
            parcelLayer.getLayers().forEach(l => {
                const pf = l && l.feature;
                if (!pf || !pf.geometry) return;
                try {
                    const pBbox = turf.bbox(pf);
                    const overlaps = !(pBbox[2] < bBbox[0] || pBbox[0] > bBbox[2] || pBbox[3] < bBbox[1] || pBbox[1] > bBbox[3]);
                    if (overlaps) {
                        candidateParcels.push(pf);
                    }
                } catch (_) { }
            });
        } catch (_) { }

        let totalBuildingArea = 0;
        try { totalBuildingArea = turf.area(buildingFeature); } catch (_) { }
        let slicedArea = 0;

        let buildingId;
        try {
            buildingId = JSON.stringify(buildingFeature.geometry.coordinates[0][0]);
        } catch (e) {
            buildingId = Math.random().toString();
        }
        const baseColor = new THREE.Color(stringToColor(buildingId));

        // Intersect the building with each candidate parcel and keep only the parcels it
        // actually covers (a bbox overlap is not enough — non-intersecting candidates would
        // otherwise desync the light/dark alternation). Each kept entry is one slice.
        const sliceData = [];
        candidateParcels.forEach((parcelFeature) => {
            let intersection = null;
            try { intersection = turf.intersect(buildingFeature, parcelFeature); } catch (_) { }
            if (!intersection) return;
            try { slicedArea += turf.area(intersection); } catch (_) { }
            let cx = 0, cy = 0;
            try { const c = turf.centroid(intersection).geometry.coordinates; cx = c[0]; cy = c[1]; } catch (_) { }
            sliceData.push({ parcelFeature, intersection, cx, cy });
        });

        // Walk slices in a stable spatial order (left→right, then bottom→top).
        sliceData.sort((a, b) => (a.cx - b.cx) || (a.cy - b.cy));

        // Decide each slice's shade. Index-parity over a 1-D sort fails because parcels are
        // adjacent in 2-D, not in sort order — so 2-colour the parcel-adjacency graph instead
        // (two slices are adjacent when their polygons share a boundary). Bipartite blocks get a
        // perfect light/dark checkerboard; odd cycles fall back to the fewest same-shade touches.
        const n = sliceData.length;
        const shade = new Array(n).fill(-1);
        const hasBooleanIntersects = (typeof turf.booleanIntersects === 'function');

        if (hasBooleanIntersects && n > 0) {
            const adjacency = Array.from({ length: n }, () => []);
            for (let i = 0; i < n; i++) {
                for (let j = i + 1; j < n; j++) {
                    let touch = false;
                    try { touch = turf.booleanIntersects(sliceData[i].intersection, sliceData[j].intersection); } catch (_) { }
                    if (touch) { adjacency[i].push(j); adjacency[j].push(i); }
                }
            }
            // BFS 2-colouring per connected component.
            for (let s = 0; s < n; s++) {
                if (shade[s] !== -1) continue;
                shade[s] = 0;
                const queue = [s];
                while (queue.length) {
                    const u = queue.shift();
                    for (const v of adjacency[u]) {
                        if (shade[v] === -1) { shade[v] = shade[u] ^ 1; queue.push(v); }
                    }
                }
            }
            // Local fix-up for non-bipartite blocks: flip any slice that clashes with more
            // neighbours than it would after flipping. Strict '>' avoids oscillation.
            const conflicts = (i, c) => adjacency[i].reduce((acc, v) => acc + (shade[v] === c ? 1 : 0), 0);
            for (let pass = 0; pass < 4; pass++) {
                let changed = false;
                for (let i = 0; i < n; i++) {
                    if (conflicts(i, shade[i]) > conflicts(i, shade[i] ^ 1)) { shade[i] ^= 1; changed = true; }
                }
                if (!changed) break;
            }
        } else {
            // Fallback: parity over the spatial sort order.
            for (let i = 0; i < n; i++) shade[i] = i % 2;
        }

        const pendingSliceObjects = [];
        sliceData.forEach((slice, i) => {
            try {
                const sliceMaterial = cloneBuildingMaterial(material);
                const shadedColor = baseColor.clone();
                const hsl = {};
                shadedColor.getHSL(hsl);
                // Alternate two shades per parcel so adjacent slices read as distinct parcels.
                // Anchor BOTH shades to a saturated mid-tone band (instead of shifting relative to
                // the base lightness): a light base (light blue/pink) previously shifted up to ~0.8
                // and washed out to white under lighting/specular at grazing angles. Clamping the
                // centre keeps both shades clearly coloured whatever the base colour's lightness.
                hsl.s = Math.max(hsl.s, 0.6);
                const centerL = Math.min(Math.max(hsl.l, 0.34), 0.46);
                hsl.l = centerL + (shade[i] === 0 ? 0.10 : -0.10);
                shadedColor.setHSL(hsl.h, hsl.s, hsl.l);
                sliceMaterial.color.set(shadedColor);

                // Clean the slice before extruding: cleanCoords drops redundant/duplicate points and
                // rewind gives a consistent ring winding, so every slice triangulates cleanly (no
                // frayed caps / striped walls from degenerate turf.intersect output).
                let sliceGeom = slice.intersection;
                try {
                    let cleaned = turf.cleanCoords(sliceGeom);
                    cleaned = turf.rewind(cleaned, { mutate: false });
                    if (cleaned && cleaned.geometry && turf.area(cleaned) > 0) sliceGeom = cleaned;
                } catch (_) { }

                const sliceMeshes = polygonFeatureToMeshes(sliceGeom, sliceMaterial, 0, height);

                // Tag the slice with its parcel so parcel-isolation can match the
                // building footprint sitting on a clicked parcel.
                const sliceParcelId = (slice.parcelFeature.properties && slice.parcelFeature.properties.parcelId != null)
                    ? String(slice.parcelFeature.properties.parcelId) : null;

                sliceMeshes.forEach(mesh => {
                    if (sliceParcelId) mesh.userData.parcelId = sliceParcelId;
                    pendingSliceObjects.push(mesh);
                    const edges = new THREE.EdgesGeometry(mesh.geometry);
                    const line = new THREE.LineSegments(edges, materials.sliceEdges);
                    if (sliceParcelId) line.userData.parcelId = sliceParcelId;
                    pendingSliceObjects.push(line);
                });
            } catch (e) {
                console.warn("Error creating building slice", e);
            }
        });

        // Commit the slices ONLY when they cover the building; otherwise draw the full building
        // INSTEAD. Drawing both used to stack the full mesh coplanar with the partial slices,
        // and the z-fight showed as striped/whitened walls and caps.
        const slices = n;
        if (slices > 0 && !(totalBuildingArea > 0 && (slicedArea / totalBuildingArea) < 0.95)) {
            pendingSliceObjects.forEach(object => targetGroup.add(object));
        } else {
            if (slices > 0) {
                console.warn("Slicing did not cover the whole building, drawing it unsliced instead.");
                pendingSliceObjects.forEach(object => { try { object.geometry?.dispose?.(); } catch (_) { } });
            }
            const meshes = polygonFeatureToMeshes(buildingFeature, material, 0, height);
            meshes.forEach(m => targetGroup.add(m));
        }

        // Storey divisions wrap the whole building once, whether it drew sliced or unsliced.
        try { addBuildingFloorLines(buildingFeature, height, targetGroup); } catch (_) { }
    }

    function getBuildingParcelIntersectionPoints(buildingFeature) {
        const intersectionPoints = [];
        if (!buildingFeature || !buildingFeature.geometry) return intersectionPoints;
        if (typeof parcelLayer === 'undefined' || !parcelLayer) return intersectionPoints;

        let buildingLine = null;
        try {
            // Use a simplified representation to avoid self-intersection issues in source data
            const simplified = turf.simplify(buildingFeature, { tolerance: 0.1, highQuality: false });
            buildingLine = turf.polygonToLine(simplified);
        } catch (e) {
            console.warn('Could not convert building polygon to line', e);
            return intersectionPoints; // Cannot proceed
        }

        if (!buildingLine) return intersectionPoints;

        parcelLayer.getLayers().forEach(l => {
            const pf = l && l.feature;
            if (!pf || !pf.geometry) return;

            // Bbox pre-filter for performance
            try {
                const bBbox = turf.bbox(buildingFeature);
                const pBbox = turf.bbox(pf);
                const overlaps = !(pBbox[2] < bBbox[0] || pBbox[0] > bBbox[2] || pBbox[3] < bBbox[1] || pBbox[1] > bBbox[3]);
                if (!overlaps) return;
            } catch (_) { /* continue */ }

            let parcelLine = null;
            try {
                parcelLine = turf.polygonToLine(pf);
            } catch (e) { /* ignore parcels that can't be converted */
                return;
            }

            if (!parcelLine) return;

            try {
                const intersections = turf.lineIntersect(buildingLine, parcelLine);
                if (intersections && intersections.features) {
                    intersections.features.forEach(feat => {
                        intersectionPoints.push(feat.geometry.coordinates);
                    });
                }
            } catch (e) {
                console.warn('turf.lineIntersect failed', e);
            }
        });

        return intersectionPoints;
    }

    function pointsToVerticalLines(points, height, material) {
        const lines = [];
        if (!points || points.length === 0) return lines;

        points.forEach(p => {
            try {
                const [lng, lat] = p;
                const xy = coordsToXY([lng, lat]);
                const x = xy[0];
                const y = xy[1];

                const points = [
                    new THREE.Vector3(x, y, 0),
                    new THREE.Vector3(x, y, height)
                ];

                const geometry = new THREE.BufferGeometry().setFromPoints(points);
                const line = new THREE.Line(geometry, material);
                line.renderOrder = 9999;
                lines.push(line);
            } catch (e) { console.warn('Failed to create vertical line', e); }
        });
        return lines;
    }

    function clearGroupChildren(group) {
        if (!group) return;
        for (let i = group.children.length - 1; i >= 0; i--) group.remove(group.children[i]);
    }

    function disposeTerrainCorridorGeometry(group) {
        if (group) {
            group.traverse(object => {
                // Instanced corridor trees reuse the global tree geometries; everything else in this
                // temporary group owns its geometry and can release it on a mode switch/rebuild.
                if (object && object.isMesh && !object.isInstancedMesh && object.geometry) {
                    try { object.geometry.dispose(); } catch (_) { }
                }
            });
        }
    }

    function disposeTerrainCorridorGroup() {
        if (terrainCorridorGroup) {
            disposeTerrainCorridorGeometry(terrainCorridorGroup);
            if (terrainCorridorGroup.parent) terrainCorridorGroup.parent.remove(terrainCorridorGroup);
        }
        terrainCorridorGroup = null;
        corridorTerrainProfiles = [];
        corridorTerrainCutPatches = [];
        corridorTerrainCommittedKeys = new Set();
        if (corridorGroup) corridorGroup.visible = true;
        try { delete document.body.dataset.corridorTerrain; } catch (_) { }
    }

    function rebuildTerrainCorridorGroup(sampleHeight, terrainReferences) {
        if (typeof sampleHeight !== 'function' || !scene || !corridorGroup) {
            disposeTerrainCorridorGroup();
            return null;
        }
        const profiles = [];
        const failures = [];
        const cutPatches = [];
        const expectedKeys = new Set();
        const group = new THREE.Group();
        group.name = 'TerrainFollowingCorridors';
        buildCorridorStrips3D(group, {
            terrainSampler: sampleHeight,
            profilesOut: profiles,
            failuresOut: failures,
            cutPatchesOut: cutPatches,
            expectedKeysOut: expectedKeys,
            terrainReferences: terrainReferences
        });
        if (!expectedKeys.size) {
            disposeTerrainCorridorGeometry(group);
            disposeTerrainCorridorGroup();
            return null;
        }
        // Tile streaming is view-dependent. A close camera may unload the road's distant tiles,
        // making a later refit incomplete even though the previous settled profile is still valid.
        // Build off-scene and swap atomically only when every currently applied corridor entry has
        // at least one complete profile. A partial multi-road success must not erase a distant old
        // road's mask/envelope merely because its current tiles unloaded.
        const completedKeys = new Set(profiles.map(function (profile) {
            return profile && profile.terrainEntryKey;
        }).filter(Boolean));
        const missingKeys = Array.from(expectedKeys).filter(function (key) {
            return !completedKeys.has(key);
        });
        // Commit the corridors that fitted rather than discarding the whole build for one
        // unstreamed corridor. decideTerrainCorridorCommit still retains the prior build in the
        // cases that would REGRESS a carve (an incomplete rebuild over an existing carve, or a
        // no-carve/empty build) — so this only ADDS the first-fit partial commit that used to
        // produce zero carve when any corridor's tiles were not yet streamed.
        // Retaining the prior build is only worth it when this build would DROP a corridor the prior
        // one covered — otherwise a partial rebuild that still covers everything (e.g. the DGU re-fit)
        // must commit, or the better fit is silently discarded (the "dgu=0 despite 14/14" bug).
        const losesPriorKey = Array.from(corridorTerrainCommittedKeys).some(function (key) {
            return !completedKeys.has(key);
        });
        const commitDecision = (window.__corridorTerrainFormation
            && typeof window.__corridorTerrainFormation.decideTerrainCorridorCommit === 'function')
            ? window.__corridorTerrainFormation.decideTerrainCorridorCommit({
                builtChildren: group.children.length,
                cutPatches: cutPatches.length,
                missingKeys: missingKeys.length,
                priorCarve: !!(terrainCorridorGroup && corridorTerrainCutPatches.length),
                losesPriorKey: losesPriorKey
            })
            : { commit: !(!group.children.length || missingKeys.length), reason: 'fallback' };
        if (!commitDecision.commit) {
            disposeTerrainCorridorGeometry(group);
            if (terrainCorridorGroup && corridorTerrainProfiles.length) {
                try {
                    document.body.dataset.corridorTerrainRetained = JSON.stringify({
                        reason: commitDecision.reason,
                        missingEntries: missingKeys,
                        failures: failures
                    });
                } catch (_) { }
            }
            return null;
        }
        disposeTerrainCorridorGroup();
        try { delete document.body.dataset.corridorTerrainRetained; } catch (_) { }
        terrainCorridorGroup = group;
        corridorTerrainProfiles = profiles;
        corridorTerrainCutPatches = cutPatches;
        corridorTerrainCommittedKeys = completedKeys;
        corridorGroup.visible = false;
        scene.add(group);
        const stationHeights = profiles.flatMap(profile => profile.stations.map(station => station.z))
            .filter(Number.isFinite);
        const minZ = stationHeights.length ? Math.min(...stationHeights) : null;
        const maxZ = stationHeights.length ? Math.max(...stationHeights) : null;
        const profileStats = profiles.map(profile => {
            const stations = Array.isArray(profile.stations) ? profile.stations : [];
            const valid = stations.filter(station => Number.isFinite(station.z));
            if (valid.length < 2) return null;
            const first = valid[0];
            const last = valid[valid.length - 1];
            const span = last.s - first.s;
            let maxLineDeviationM = 0;
            let maxAbsGrade = 0;
            let maxRawAdjustmentM = 0;
            valid.forEach((station, index) => {
                const t = span > 0 ? (station.s - first.s) / span : 0;
                const lineZ = first.z + (last.z - first.z) * t;
                maxLineDeviationM = Math.max(maxLineDeviationM, Math.abs(station.z - lineZ));
                if (Number.isFinite(station.rawZ)) {
                    maxRawAdjustmentM = Math.max(maxRawAdjustmentM,
                        Math.abs(station.z - station.rawZ));
                }
                if (index) {
                    const ds = station.s - valid[index - 1].s;
                    if (ds > 0) maxAbsGrade = Math.max(maxAbsGrade,
                        Math.abs(station.z - valid[index - 1].z) / ds);
                }
            });
            return {
                source: profile.source || 'google-visible-mesh',
                lengthM: span,
                startZ: first.z,
                endZ: last.z,
                endpointDeltaM: last.z - first.z,
                minZ: Math.min(...valid.map(station => station.z)),
                maxZ: Math.max(...valid.map(station => station.z)),
                maxLineDeviationM: maxLineDeviationM,
                maxRawAdjustmentM: maxRawAdjustmentM,
                maxAbsGrade: maxAbsGrade,
                calibrationOffsetM: Number.isFinite(profile.calibrationOffsetM)
                    ? profile.calibrationOffsetM : null,
                calibrationMadM: Number.isFinite(profile.calibrationMadM)
                    ? profile.calibrationMadM : null,
                obstacleRuns: Number(profile.obstacleRuns) || 0,
                obstacleStations: Number(profile.obstacleStations) || 0,
                referenceStatus: profile.referenceStatus || null
            };
        }).filter(Boolean);
        const dguProfiles = profiles.filter(profile => profile.source === 'dgu-dtm-20m').length;
        try {
            document.body.dataset.corridorTerrain = JSON.stringify({
                source: dguProfiles ? 'dgu-dtm-20m+google-anchor' : 'google-visible-mesh',
                profiles: profiles.length,
                dguProfiles: dguProfiles,
                dguReferences: terrainReferences instanceof Map ? terrainReferences.size : 0,
                cutPatches: cutPatches.length,
                stations: stationHeights.length,
                // A partial commit carved the corridors that fitted; the listed entries are still
                // waiting on tile streaming and render flat until a later refit completes them.
                partial: missingKeys.length > 0,
                missingEntries: missingKeys,
                minZ: minZ,
                maxZ: maxZ,
                failures: failures,
                profileStats: profileStats
            });
        } catch (_) { }
        console.log('[three-mode] terrain corridors built: profiles=' + profiles.length
            + ' dgu=' + dguProfiles + ' cutPatches=' + cutPatches.length
            + ' stations=' + stationHeights.length
            + (minZ === null ? '' : ' elevation=' + minZ.toFixed(2) + '..' + maxZ.toFixed(2) + 'm'));
        return { profiles: profiles, cutPatches: cutPatches, dguProfiles: dguProfiles };
    }

    function setCorridorTerrainSampler(sampleHeight) {
        corridorTerrainSampler = typeof sampleHeight === 'function' ? sampleHeight : null;
        corridorTerrainReferenceGeneration += 1;
        const generation = corridorTerrainReferenceGeneration;
        const result = rebuildTerrainCorridorGroup(corridorTerrainSampler, corridorTerrainReferences);
        if (!corridorTerrainSampler) {
            try { delete document.body.dataset.corridorTerrainReference; } catch (_) { }
            return result;
        }
        void loadCorridorDguReferences(generation).then(function (references) {
            if (generation !== corridorTerrainReferenceGeneration
                || corridorTerrainSampler !== sampleHeight || !(references instanceof Map)) return;
            let changed = references.size !== corridorTerrainReferences.size;
            if (!changed) references.forEach(function (value, key) {
                if (corridorTerrainReferences.get(key) !== value) changed = true;
            });
            if (!changed || !references.size) return;
            corridorTerrainReferences = references;
            const refined = rebuildTerrainCorridorGroup(corridorTerrainSampler, corridorTerrainReferences);
            if (refined) {
                window.dispatchEvent(new CustomEvent('corridorTerrainUpdated', {
                    detail: { source: refined.dguProfiles ? 'dgu-dtm-20m+google-anchor' : 'google-visible-mesh' }
                }));
            }
        });
        return result;
    }

    function rebuild3DBuildingsOnly() {
        if (!isActive || !buildingGroup) return;
        clearGroupChildren(buildingGroup);
        // Bump the generation so in-flight async model loads from a prior rebuild don't
        // attach their meshes to the freshly cleared group.
        buildingsRenderGeneration++;

        // Each family follows its own display state. Built additionally supports complementary
        // Surviving and Removed views using the exact two halves stored by the carve pipeline.
        const builtPolicy = buildingDisplayPolicy.resolveBuiltDisplayPolicy(builtDisplay);
        // In realistic mode the photoreal mesh IS the built world: abstract existing buildings
        // and rail stay hidden (demolitions are carved out of the mesh by the photoreal layer).
        const showExisting = builtPolicy.visible && !realisticLayerActive;
        // Photo mode always shows the proposals (the Google mesh is cut to make way for them, so the
        // scene reads as survivors-only): the built/proposed display controls are hidden there.
        const showProposed = realisticLayerActive || plannedDisplay !== 'off';
        if (existingTransitAlignmentGroup) {
            existingTransitAlignmentGroup.visible = builtPolicy.showExistingRail && !realisticLayerActive;
        }
        const existingMaterial = builtPolicy.material === 'solid'
            ? buildingMaterials.solid
            : buildingMaterials.ghost;
        const proposedMaterial = plannedDisplay === 'solid' ? buildingMaterials.solid : buildingMaterials.ghost;

        if (showExisting) {
            buildNearbyProposalBuildings3D(buildingGroup, existingMaterial, {
                showSurviving: builtPolicy.showSurviving,
                showDemolished: builtPolicy.showDemolished
            });
        }
        if (showProposed) buildProposedBuildings3D(buildingGroup, proposedMaterial);

        // Always make sure the nearby-buildings fetch is in flight (it may render on arrival).
        ensureNearbyProposalBuildings();
        // Trees follow the same near-query; fetch if enabled, and rebuild from whatever we have.
        ensureNearbyTrees();
        rebuildTreesOnly();

        // Freshly rebuilt buildings default to visible; re-apply isolation if active.
        if (isolatedParcelId !== null) isolateParcel(isolatedParcelId);
        else if (isolatedProposalId !== null) isolateProposal(isolatedProposalId);
    }

    function computeContentBoundsXY() {
        // When the entry asked for a proposal (a shared link), frame the proposal plus a margin for its
        // built surroundings, centred on the origin (= proposal centre), regardless of where the 2D map
        // was panned. A free entry from the 3D button falls through to the viewport below, so it frames
        // what the user was looking at rather than a proposal that may be kilometres away.
        const proposalGeom = proposalFramingGeometry();
        if (proposalGeom && proposalGeom.coordinates && proposalGeom.coordinates[0]) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const pt of proposalGeom.coordinates[0]) {
                const [x, y] = latLngToXY(pt[1], pt[0]);
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
            if (isFinite(minX) && isFinite(minY)) {
                // Pad by the neighbour-band radius (both sides) so the surrounding built
                // context the backend loaded is visible around the proposal.
                const pad = NEARBY_FRAME_PAD_M * 2;
                return {
                    width: Math.max(1, (maxX - minX) + pad),
                    height: Math.max(1, (maxY - minY) + pad)
                };
            }
        }

        // Fallback: use the current 2D viewport so switching to 3D preserves what the user
        // is actually looking at. The parcelLayer can span the whole dataset and
        // would force the camera to pull back far beyond the visible 2D area.
        let bounds = null;
        if (typeof map !== 'undefined' && map) {
            try { bounds = map.getBounds(); } catch (_) { bounds = null; }
        }
        if (!bounds && typeof parcelLayer !== 'undefined' && parcelLayer && parcelLayer.getBounds) {
            try { bounds = parcelLayer.getBounds(); } catch (_) { bounds = null; }
        }
        if (!bounds) return { width: 100, height: 100 };
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        const [x0, y0] = latLngToXY(sw.lat, sw.lng);
        const [x1, y1] = latLngToXY(ne.lat, ne.lng);
        return { width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
    }

    function initScene() {
        // Preserve pendingIntroAutoRotate across dispose/init cycle
        const preserveAutoRotate = pendingIntroAutoRotate;
        // Clean up if re-initializing
        disposeScene();
        // Restore the flag after dispose
        pendingIntroAutoRotate = preserveAutoRotate;

        const width = Math.max(1, threeContainer.clientWidth || 800);
        const height = Math.max(1, threeContainer.clientHeight || 600);

        scene = new THREE.Scene();
        scene.background = new THREE.Color(0xf8f9fb);

        camera = new THREE.PerspectiveCamera(45, width / height, 0.5, 200000);
        camera.up.set(0, 0, 1);

        // The scene is already in a local metric frame and camera planes stay within a modest
        // ratio, so a conventional depth buffer is both sufficient and more stable for coplanar
        // offsets. A logarithmic buffer rewrites fragment depth and made tiny plane changes visible.
        // The smooth ghost pass uses stencil to ensure that only one nearest translucent facade
        // blends at each pixel, even if a residual coincident triangle survives sanitation.
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, stencil: true });
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        threeContainer.innerHTML = '';
        threeContainer.appendChild(renderer.domElement);
        ensureBuildingModeControls();
        // Populate scenery toggles for the active city (which layers it has ingested).
        refreshDecorToggles();

        // Lights (×π: three r155+ dropped the implicit π factor legacy lighting applied)
        const hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 0.6 * Math.PI);
        hemi.position.set(0, 0, 1);
        scene.add(hemi);

        const dir = new THREE.DirectionalLight(0xffffff, 0.8 * Math.PI);
        dir.position.set(200, 200, 400);
        scene.add(dir);

        // Groups
        flatGroup = new THREE.Group();
        corridorGroup = new THREE.Group();
        plannedFlatGroup = new THREE.Group();
        buildingGroup = new THREE.Group();
        parkGroup = new THREE.Group();
        squareGroup = new THREE.Group();
        lakeGroup = new THREE.Group();
        stationGroup = new THREE.Group();
        treesGroup = new THREE.Group();
        proposalInteractionGroup = new THREE.Group();
        proposalDraftGroup = new THREE.Group();
        treesEnabled = loadTreesEnabledPref();
        treesGroup.visible = treesEnabled && !realisticLayerActive;
        scene.add(flatGroup);
        scene.add(corridorGroup);
        scene.add(plannedFlatGroup);
        scene.add(buildingGroup);
        scene.add(parkGroup);
        scene.add(squareGroup);
        scene.add(lakeGroup);
        scene.add(stationGroup);
        scene.add(treesGroup);
        scene.add(proposalInteractionGroup);
        scene.add(proposalDraftGroup);
        existingTransitAlignmentGroup = null; // rebuilt from the cached city sources below

        // Controls
        const OrbitControlsCtor = (THREE.OrbitControls) ? THREE.OrbitControls : (window.OrbitControls || null);
        if (OrbitControlsCtor) {
            controls = new OrbitControlsCtor(camera, renderer.domElement);
            snapshotNavigation.configurePannableOrbitControls(controls, THREE);
            controls.maxPolarAngle = Math.PI * 0.49; // limit below horizon
        }

        // Build content
        origin3857 = getOrigin3857();
        captureSceneLoadGeometry();
        buildParcels3D(flatGroup);
        buildRoads3D(flatGroup);
        // Corridors render into their own group (not flatGroup): in realistic mode the parcel
        // and road slabs hide behind the photoreal mesh while the corridor cross-sections stay.
        try { buildCorridorStrips3D(corridorGroup); } catch (error) { console.warn('[three-mode] corridor strips failed', error); }
        try { buildParks3D(plannedFlatGroup, parkGroup); } catch (_) { }
        try { buildSquares3D(plannedFlatGroup, squareGroup); } catch (_) { }
        try { buildLakes3D(plannedFlatGroup, lakeGroup); } catch (_) { }
        try { buildProposalGrounds3D(plannedFlatGroup); } catch (error) { console.error('[three-mode] proposal grounds failed', error); }
        try { buildTransitStations3D(stationGroup); } catch (error) { console.warn('[three-mode] transit stations failed', error); }
        try { buildPlannedReparcellization3D(plannedFlatGroup); } catch (_) { }
        try { buildExistingTransitAlignments3D(scene); } catch (error) { console.error('[three-mode] transit alignments failed', error); }
        // Apply initial visibility based on the current display states.
        applyModeVisibility();
        rebuild3DBuildingsOnly();
        rebuildProposalInteraction3D();
        rebuildProposalDraftPreview3D();

        // Camera framing that preserves current 2D view scale and center
        const content = computeContentBoundsXY();
        try {
            const diagonal = Math.max(1, Math.hypot(content.width, content.height));
            camera.far = Math.max(2000, diagonal * 8);
            camera.updateProjectionMatrix();
        } catch (_) { }
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

            // Keep north-up orientation consistent with 2D (flip Y)
            const y = -Math.sin(pitchRad) * distance;
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

        // Parcel isolation: click a parcel to show only it; click empty/again or Escape to reset.
        // pointerdown records the press position so a click that ends a drag is ignored.
        parcelPointerDownHandler = (e) => { if (e.button === 0) clickDownXY = { x: e.clientX, y: e.clientY }; };
        renderer.domElement.addEventListener('pointerdown', parcelPointerDownHandler);
        parcelClickHandler = handleParcelClick;
        renderer.domElement.addEventListener('click', parcelClickHandler);
        if (!proposalSelectionUnsubscribe && window.ProposalSelection?.subscribe) {
            proposalSelectionUnsubscribe = window.ProposalSelection.subscribe(() => rebuildProposalInteraction3D());
        }

        // Checkbox listeners (sync 3D buildings with sidebar state)
        const showExistingEl = document.getElementById('showBuildings');
        const showProposedEl = document.getElementById('showProposedBuildings');
        onShowExistingBuildingsChange = () => { rebuild3DBuildingsOnly(); };
        onShowProposedBuildingsChange = () => { rebuild3DBuildingsOnly(); };
        if (showExistingEl) showExistingEl.addEventListener('change', onShowExistingBuildingsChange);
        if (showProposedEl) showProposedEl.addEventListener('change', onShowProposedBuildingsChange);
    }

    function showRenderingOverlay() {
        try {
            if (renderingOverlayEl) return;
            const el = document.createElement('div');
            el.id = 'three-rendering-overlay';
            el.textContent = threeI18n('threeMode.overlay.rendering', 'Rendering…');
            el.style.position = 'fixed';
            el.style.left = '50%';
            el.style.top = '50%';
            el.style.transform = 'translate(-50%, -50%)';
            el.style.padding = '10px 14px';
            el.style.background = 'rgba(0,0,0,0.66)';
            el.style.color = '#fff';
            el.style.borderRadius = '8px';
            el.style.fontSize = '16px';
            el.style.fontWeight = '600';
            el.style.zIndex = '999999';
            el.style.pointerEvents = 'none';
            document.body.appendChild(el);
            renderingOverlayEl = el;
        } catch (_) { }
        try { updateModeButtonStates(); } catch (_) { }
    }

    function hideRenderingOverlay() {
        try {
            if (renderingOverlayEl && renderingOverlayEl.parentNode) {
                renderingOverlayEl.parentNode.removeChild(renderingOverlayEl);
            }
        } catch (_) { }
        renderingOverlayEl = null;
        try { updateModeButtonStates(); } catch (_) { }
    }

    // A small badge in the 3D view, shown while built buildings are loading: the /buildings/near
    // fetch (can pull thousands of city meshes) and any uploaded glTF models still downloading.
    function ensureBuildingsLoaderEl() {
        if (buildingsLoaderEl && buildingsLoaderEl.parentElement) return buildingsLoaderEl;
        if (!threeContainer) return null;
        const el = document.createElement('div');
        el.className = 'three-mode-buildings-loader';
        const spinner = document.createElement('span');
        spinner.className = 'three-mode-loader-spinner';
        const label = document.createElement('span');
        label.textContent = threeI18n('threeMode.overlay.loadingBuildings', 'Loading buildings…');
        const count = document.createElement('span');
        count.className = 'three-mode-loader-count';
        el.appendChild(spinner);
        el.appendChild(label);
        el.appendChild(count);
        threeContainer.appendChild(el);
        buildingsLoaderEl = el;
        return el;
    }

    // Visible whenever either source of building loading is in flight (and 3D is active).
    function updateBuildingsLoader() {
        try {
            const loading = isActive && (nearbyProposalBuildingsFetching || pendingModelLoads > 0);
            const el = ensureBuildingsLoaderEl();
            if (!el) return;
            el.classList.toggle('is-visible', loading);
            const count = el.querySelector('.three-mode-loader-count');
            if (count) {
                // The /near fetch is one request (no incremental total); pending glTF models are
                // countable, so show that number while any are still downloading.
                count.textContent = pendingModelLoads > 0 ? String(pendingModelLoads) : '';
            }
        } catch (_) { }
    }

    function stopIntroAutoRotate() {
        try {
            // The pointerdown that stops an ACTIVE intro rotation must not double as a map
            // click: it isolated whichever proposal sat under the cursor, hiding all others
            // (and, in realistic mode, gaping their carve holes open).
            if ((controls && controls.autoRotate) || manualAutoRotateActive) {
                suppressClickAfterRotateStop = true;
            }
            const wasPending = pendingIntroAutoRotate;
            pendingIntroAutoRotate = false;
            if (wasPending) {
                console.log('[3D] stopIntroAutoRotate() called, clearing pendingIntroAutoRotate');
            }
            manualAutoRotateActive = false;
            manualAutoRotateLastTs = 0;
            if (controls) {
                try { controls.autoRotate = false; } catch (_) { }
            }
            if (typeof introAutoRotateCleanup === 'function') {
                try { introAutoRotateCleanup(); } catch (_) { }
            }
        } catch (_) { }
        introAutoRotateCleanup = null;
    }

    function startIntroAutoRotate() {
        // Idempotent: clear any previous listeners/state first
        stopIntroAutoRotate();

        const controlsInstance = controls;
        try {
            if (controlsInstance) {
                controlsInstance.autoRotate = true;
                controlsInstance.autoRotateSpeed = INTRO_AUTO_ROTATE_SPEED;
                console.log('[3D] Enabled OrbitControls auto-rotate, speed:', INTRO_AUTO_ROTATE_SPEED);
            } else {
                manualAutoRotateActive = true;
                manualAutoRotateLastTs = 0;
                console.log('[3D] OrbitControls not available, using manual auto-rotate');
            }
        } catch (err) {
            console.warn('[3D] Failed to enable auto-rotate:', err);
        }

        const stop = () => { stopIntroAutoRotate(); };

        // Stop as soon as the user clicks/touches/presses anywhere.
        try { document.addEventListener('pointerdown', stop, { passive: true, capture: true }); } catch (_) { }
        try { document.addEventListener('mousedown', stop, { passive: true, capture: true }); } catch (_) { }
        try { document.addEventListener('touchstart', stop, { passive: true, capture: true }); } catch (_) { }
        try {
            if (controlsInstance && typeof controlsInstance.addEventListener === 'function') {
                controlsInstance.addEventListener('start', stop);
            }
        } catch (_) { }

        introAutoRotateCleanup = () => {
            try { document.removeEventListener('pointerdown', stop, true); } catch (_) { }
            try { document.removeEventListener('mousedown', stop, true); } catch (_) { }
            try { document.removeEventListener('touchstart', stop, true); } catch (_) { }
            try {
                if (controlsInstance && typeof controlsInstance.removeEventListener === 'function') {
                    controlsInstance.removeEventListener('start', stop);
                }
            } catch (_) { }
            try { if (controlsInstance) controlsInstance.autoRotate = false; } catch (_) { }
        };
    }

    function stepManualAutoRotate(now) {
        if (!manualAutoRotateActive || !camera) return;
        if (!Number.isFinite(now)) return;
        if (!manualAutoRotateLastTs) {
            manualAutoRotateLastTs = now;
            return;
        }
        const dt = (now - manualAutoRotateLastTs) / 1000;
        manualAutoRotateLastTs = now;
        if (!Number.isFinite(dt) || dt <= 0) return;
        const angle = dt * INTRO_MANUAL_AUTO_ROTATE_RAD_PER_SEC;
        if (!Number.isFinite(angle) || angle === 0) return;
        const x = camera.position.x;
        const y = camera.position.y;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        camera.position.x = (x * cos) - (y * sin);
        camera.position.y = (x * sin) + (y * cos);
        camera.lookAt(0, 0, 0);
    }

    function startLoop() {
        cancelLoop();
        // We are ready: hide overlay and settle the mode buttons.
        hideRenderingOverlay();
        isTransitioning3D = false;
        updateModeButtonStates();
        // Signal readiness so callers that entered 3D just to stack another mode on top
        // (e.g. realistic-from-2D) can proceed once the abstract scene is actually up.
        try { window.dispatchEvent(new Event('threeModeReady')); } catch (_) { }
        console.log('[3D] startLoop() called, pendingIntroAutoRotate:', pendingIntroAutoRotate);
        if (pendingIntroAutoRotate) {
            pendingIntroAutoRotate = false;
            console.log('[3D] Starting intro auto-rotate');
            startIntroAutoRotate();
        }
        // Hysteresis for the depth-plane retune. The planes only need to follow real dolly/zoom
        // distance, not orbit or pan. Retuning on every damped frame remaps nearly coplanar depth
        // values and can make their winner alternate; use camera-to-controls-target distance and
        // wait for a meaningful zoom before changing the projection.
        let lastPlaneDist = 0;
        const loop = (now) => {
            stepManualAutoRotate(now);
            // Keep the canvas locked to its container every frame. The window 'resize'
            // listener misses box changes that don't fire a window resize (sidebar toggle,
            // browser UI showing/hiding, a layout reflow after entering 3D before it settled),
            // which left the canvas stale and shorter than the viewport — the 2D map then
            // showed through along the bottom edge. This is size-only (no camera re-framing,
            // unlike handleResize) so it never disturbs the user's current orbit/pan/zoom.
            syncRendererSize();
            if (controls) controls.update();
            // Adjust near/far planes only when camera distance has changed enough to matter,
            // to keep depth precision across big zooms without churning the depth buffer per frame.
            if (camera) {
                const dist = (controls && controls.target)
                    ? camera.position.distanceTo(controls.target)
                    : camera.position.length();
                if (lastPlaneDist === 0 || Math.abs(dist - lastPlaneDist) > lastPlaneDist * 0.15) {
                    camera.near = Math.max(1, dist * 0.001);
                    camera.far = Math.max(1000, dist * 10);
                    camera.updateProjectionMatrix();
                    lastPlaneDist = dist;
                }
            }
            for (let i = 0; i < frameHooks.length; i++) {
                try { frameHooks[i](now); } catch (err) { console.error('[3D] frame hook failed', err); }
            }
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

    // Lightweight per-frame guard that the drawing buffer matches the container box.
    // Only touches renderer size + camera aspect when they actually drift — no camera
    // re-placement — so it's safe to call every frame and never resets the user's view.
    const _rendererSize = (typeof THREE !== 'undefined') ? new THREE.Vector2() : null;
    function syncRendererSize() {
        if (!renderer || !camera || !threeContainer) return;
        const w = Math.max(1, threeContainer.clientWidth || 0);
        const h = Math.max(1, threeContainer.clientHeight || 0);
        if (w <= 1 || h <= 1) return; // container not laid out yet; don't clamp to a fallback
        renderer.getSize(_rendererSize);
        if (Math.round(_rendererSize.x) === w && Math.round(_rendererSize.y) === h) return;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }

    function handleResize() {
        if (!renderer || !camera) return;
        const w = Math.max(1, threeContainer.clientWidth || 800);
        const h = Math.max(1, threeContainer.clientHeight || 600);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
        // Do not reframe here: camera + controls.target are the user's current pan/orbit state.
        // Updating only the projection keeps that state intact across sidebar and window resizes.
    }

    function disposeScene() {
        cancelLoop();
        stopIntroAutoRotate();
        corridorTerrainSampler = null;
        corridorTerrainReferenceGeneration += 1;
        disposeTerrainCorridorGroup();
        hideRenderingOverlay();
        isTransitioning3D = false;
        if (controls && controls.dispose) {
            try { controls.dispose(); } catch (_) { }
        }
        controls = null;
        // Tear down parcel-isolation pointer listeners and reset state.
        if (renderer && renderer.domElement) {
            if (parcelClickHandler) { try { renderer.domElement.removeEventListener('click', parcelClickHandler); } catch (_) { } }
            if (parcelPointerDownHandler) { try { renderer.domElement.removeEventListener('pointerdown', parcelPointerDownHandler); } catch (_) { } }
        }
        parcelClickHandler = null;
        parcelPointerDownHandler = null;
        if (proposalSelectionUnsubscribe) {
            try { proposalSelectionUnsubscribe(); } catch (_) { }
            proposalSelectionUnsubscribe = null;
        }
        clickDownXY = null;
        isolatedParcelId = null;
        isolationResetEl = null;
        parcelInfoPanelEl = null;
        displayStateSelects = { built: null, planned: null };
        if (renderer) {
            try { renderer.forceContextLoss && renderer.forceContextLoss(); } catch (_) { }
            try { renderer.dispose(); } catch (_) { }
        }
        renderer = null;
        scene = null;
        camera = null;
        sceneLoadGeometry = null;
        sceneLoadGeometrySource = 'camera';
        sceneTreeLoadGeometry = null;
        sceneTreeLoadGeometrySource = 'camera';
        flatGroup = null;
        corridorGroup = null;
        terrainCorridorGroup = null;
        corridorTerrainProfiles = [];
        plannedFlatGroup = null;
        buildingGroup = null;
        parkGroup = null;
        squareGroup = null;
        lakeGroup = null;
        stationGroup = null;
        proposalInteractionGroup = null;
        proposalDraftGroup = null;
        threeContainer && (threeContainer.innerHTML = '');
        buildingModeControlsEl = null;
        buildingModeButtons = { built: null, planned: null };
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

    function disableSidebarFor3D() {
        try {
            const sidebar = document.getElementById('sidebar');
            if (!sidebar) return;
            const buildingsSection = document.querySelector('.accordion-section[data-section="buildings"]');
            const interactive = sidebar.querySelectorAll('input, button, select, textarea');
            interactive.forEach(el => {
                const inBuildings = buildingsSection && el.closest('.accordion-section') === buildingsSection;
                if (!inBuildings) {
                    if (!el.disabled) el.setAttribute('data-three-disabled', '1');
                    el.disabled = true;
                }
            });
        } catch (_) { }
    }

    function enableSidebarAfter3D() {
        try {
            const sidebar = document.getElementById('sidebar');
            if (!sidebar) return;
            const toEnable = sidebar.querySelectorAll('[data-three-disabled="1"]');
            toEnable.forEach(el => {
                try { el.disabled = false; } catch (_) { }
                try { el.removeAttribute('data-three-disabled'); } catch (_) { }
            });
        } catch (_) { }
    }

    function closeAllPanelsAndModalsFor3D() {
        // `hideParcelInfoPanel` in this module belongs to the Three.js overlay. Explicitly call the
        // 2D parcel-panel owner as well; otherwise its identically named local function shadows the
        // global closer and the Leaflet Parcel Info panel remains visible over 3D.
        try {
            const hideLeafletParcelInfo = window.Parcels?.uiParcelPanel?.hideParcelInfoPanel
                || window.hideParcelInfoPanel;
            if (typeof hideLeafletParcelInfo === 'function') hideLeafletParcelInfo();
        } catch (_) { }
        try { hideParcelInfoPanel(); } catch (_) { }
        try { typeof hideProposalDetailsPanel === 'function' && hideProposalDetailsPanel(); } catch (_) { }
        try { typeof hideBlockInfo === 'function' && hideBlockInfo(); } catch (_) { }
        try { typeof hideRoadInfoPanel === 'function' && hideRoadInfoPanel(); } catch (_) { }
        try { typeof hideRoadAnalysisPanel === 'function' && hideRoadAnalysisPanel(); } catch (_) { }
        try { typeof hideOSMRoadSegmentListPopup === 'function' && hideOSMRoadSegmentListPopup(); } catch (_) { }
        try { typeof hideBlocksList === 'function' && hideBlocksList(); } catch (_) { }
        try { typeof closeProposalDialog === 'function' && closeProposalDialog(); } catch (_) { }
        try {
            const blockifyModal = document.getElementById('blockify-modal');
            if (blockifyModal && typeof closeBlockifyModal === 'function') closeBlockifyModal();
        } catch (_) { }
        // Close share modals (e.g., shared proposal inspector/summary) so they don't block 3D controls.
        try {
            document.querySelectorAll('.share-modal-overlay .share-modal-close').forEach(btn => {
                try { btn.click(); } catch (_) { }
            });
        } catch (_) { }
        // Ensure built-in static modals are hidden
        ['welcome-modal', 'logout-modal', 'locate-parcel-modal', 'osm-road-segment-list-popup']
            .forEach(id => { try { const el = document.getElementById(id); if (el) el.style.display = 'none'; } catch (_) { } });
    }

    function enter3D(options = {}) {
        if (isActive) return;
        isActive = true;
        // 3D takes the full stage: collapse an expanded sidebar so the canvas and its in-view
        // controls get the whole viewport instead of sharing it with the sidebar column.
        try {
            const sidebar = document.getElementById('sidebar');
            if (sidebar && !sidebar.classList.contains('collapsed') && typeof toggleSidebar === 'function') {
                toggleSidebar();
            }
        } catch (_) { }
        // Optional focus: frame only these proposals (by proposalId) instead of all applied ones.
        // Used by shared-link entry so the camera lands on the just-loaded proposal.
        focusProposalIds = (options && Array.isArray(options.focusProposalIds) && options.focusProposalIds.length)
            ? new Set(options.focusProposalIds.map(String))
            : null;
        console.log('[3D] enter3D focus ids:', focusProposalIds ? focusProposalIds.size : 0,
            focusProposalIds ? Array.from(focusProposalIds).slice(0, 4) : '(none — framing all applied)');
        pendingIntroAutoRotate = !!(options && options.fromUrl);
        if (pendingIntroAutoRotate) {
            console.log('[3D] URL-driven entry detected, will start auto-rotate after tilt animation');
        }
        try { document.body.classList.add('three-mode-active'); } catch (_) { }
        if (threeContainer) threeContainer.classList.add('active');
        updateModeButtonStates();
        // Only show the walk launcher for cities that configure a walk overlay (e.g. Zagreb).
        if (walkBtn) walkBtn.hidden = !getWalkUrlBase();
        showRenderingOverlay();
        disableLeafletInteractions();
        closeAllPanelsAndModalsFor3D();
        disableSidebarFor3D();
        initScene();
        if (window.activeProposalDraftComparison?.draftId && typeof window.renderProposalDraftComparison === 'function') {
            window.renderProposalDraftComparison(
                window.activeProposalDraftComparison.draftId,
                window.activeProposalDraftComparison.mode || 'overlay'
            );
        }
    }

    function exit3D() {
        try { document.body.classList.remove('three-mode-active'); } catch (_) { }
        if (!isActive) return;
        // Capture this before disposing the local scene frame. The Leaflet map intentionally stays
        // motionless while 3D is active (so it cannot stream tiles or parcels), then jumps once to
        // the current 3D focus when the user explicitly returns to 2D.
        const exitMapCenter = snapshotNavigation.resolveExitMapCenter(
            controls && controls.target,
            xyToLatLng
        );
        isActive = false;
        focusProposalIds = null; // reset shared-link focus; a manual re-entry frames all proposals
        stopIntroAutoRotate();
        cancelWalkPick();
        if (walkBtn) walkBtn.hidden = true;
        if (threeContainer) threeContainer.classList.remove('active');
        // Defensive: if we exit before startLoop ran (aborted entry), the "Rendering…" overlay
        // and the transition guard would otherwise leak and jam future entries.
        isTransitioning3D = false;
        hideRenderingOverlay();
        updateModeButtonStates();
        enableLeafletInteractions();
        enableSidebarAfter3D();
        pendingModelLoads = 0;
        updateBuildingsLoader();
        disposeScene();
        if (exitMapCenter && typeof map !== 'undefined' && map && typeof map.setView === 'function') {
            try {
                const zoom = (typeof map.getZoom === 'function') ? map.getZoom() : undefined;
                map.setView([exitMapCenter.lat, exitMapCenter.lng], zoom, { animate: false });
            } catch (_) { }
        }
        if (window.activeProposalDraftComparison?.draftId && typeof window.renderProposalDraftComparison === 'function') {
            window.renderProposalDraftComparison(
                window.activeProposalDraftComparison.draftId,
                window.activeProposalDraftComparison.mode || 'overlay'
            );
        }
    }

    // Deliberately do not listen for `parcelDataLoaded` while 3D is active. `buildParcels3D` copies
    // the entry-time Leaflet layers into `flatGroup`; keeping that mesh untouched makes parcels the
    // same fixed scene snapshot as buildings and trees. OrbitControls never moves Leaflet itself.

    // Rebuild buildings if the 2D buildings layer updates (e.g., after fetch)
    window.addEventListener('buildingsLayerUpdated', () => {
        if (!isActive) return;
        rebuild3DBuildingsOnly();
    });

    // Rebuild on proposed buildings updates. Invalidate the nearby cache too so the
    // buffer query re-runs against the new proposal shape.
    window.addEventListener('proposedBuildingsUpdated', () => {
        nearbyProposalBuildingsKey = null;
        if (!isActive) return;
        rebuild3DBuildingsOnly();
        rebuildProposalInteraction3D();
    });

    // Rebuild parks/squares/lakes/stations when their 2D state changes. The "flat" portion of each
    // (grounds, paths, water) lives in plannedFlatGroup; the "deco" portion (trees,
    // fountains, fish) lives in its own group. Both clear together so the legacy
    // userData.isParkGround/isSquareGround/isLakeShore filtering on flatGroup is no longer
    // needed.
    function refreshStructures3D() {
        // Structure footprints own parcel-ground openings (lake beds and station entrances), so
        // rebuild only the fixed snapshot's parcel meshes before repainting the structure groups.
        rebuildParcelGround3D();
        structureRefresh.refreshStructureScene3D({
            isActive: () => isActive,
            hasScene: () => !!scene,
            initScene,
            groups: [plannedFlatGroup, parkGroup, squareGroup, lakeGroup, stationGroup],
            clearGroup: clearGroupChildren,
            buildParks: () => buildParks3D(plannedFlatGroup, parkGroup),
            buildSquares: () => buildSquares3D(plannedFlatGroup, squareGroup),
            buildLakes: () => buildLakes3D(plannedFlatGroup, lakeGroup),
            buildStations: () => buildTransitStations3D(stationGroup),
            buildProposalGrounds: () => buildProposalGrounds3D(plannedFlatGroup),
            buildReparcellization: () => buildPlannedReparcellization3D(plannedFlatGroup),
            applyDisplay: applyModeVisibility,
            rebuildBuildings: rebuild3DBuildingsOnly,
            rebuildInteraction: rebuildProposalInteraction3D,
            onError: (label, error) => console.error(`[three-mode] Failed to rebuild ${label} in 3D`, error)
        });
    }

    ['parksUpdated', 'squaresUpdated', 'lakesUpdated', 'stationsUpdated', 'buildingGroundsUpdated'].forEach(eventName => {
        window.addEventListener(eventName, refreshStructures3D);
    });

    document.addEventListener('proposalCreated', () => {
        if (isActive) rebuildProposalInteraction3D();
    });

    function realisticActive() {
        return !!(window.PhotorealMode && typeof window.PhotorealMode.isActive === 'function' && window.PhotorealMode.isActive());
    }

    // Wire the 3D button. It always means "abstract 3D": from realistic it drops the globe,
    // from 2D it enters 3D, and while already in abstract 3D it does nothing.
    if (toggleBtn) {
        toggleBtn.addEventListener('click', function () {
            if (realisticActive()) {
                try { window.PhotorealMode.deactivate(); } catch (_) { }
                updateModeButtonStates();
                return;
            }
            if (isActive) return; // already in abstract 3D
            if (isTransitioning3D) return;
            isTransitioning3D = true;
            updateModeButtonStates();
            showRenderingOverlay();
            // Yield once so the overlay/button paints before the heavy scene init. setTimeout
            // (not rAF) so it still fires when the tab is throttled and rAF would stall.
            setTimeout(enter3D, 0);
        });
    }

    // Wire the 2D button. It always returns to the flat Leaflet map, dropping the globe first
    // if realistic is up, then exiting 3D.
    if (toggle2dBtn) {
        toggle2dBtn.addEventListener('click', function () {
            if (realisticActive()) {
                try { window.PhotorealMode.deactivate(); } catch (_) { }
            }
            if (isActive) exit3D();
            updateModeButtonStates();
        });
    }

    // --- Walk-through (zagreb.lol/voznja) launcher ---
    // The user clicks the walk button while in 3D, then clicks a point on the ground;
    // we open zagreb.lol/voznja in a new tab with that lat/lng plus the currently-applied
    // proposal serial IDs so voznja loads exactly the same scene the user is looking at.
    function pickSerialProposalId(proposal) {
        if (typeof window.getSerialProposalId === 'function') return window.getSerialProposalId(proposal);
        const candidates = [proposal && proposal.serverProposalId, proposal && proposal.proposalId, proposal && proposal.id];
        for (const c of candidates) {
            if (c == null) continue;
            const s = String(c);
            if (/^\d+$/.test(s)) return s;
        }
        return null;
    }

    function getAppliedProposals() {
        try {
            const storage = (typeof window !== 'undefined') ? window.proposalStorage : null;
            if (!storage || typeof storage.getAllProposals !== 'function') return [];
            return storage.getAllProposals().filter(p => {
                if (!p) return false;
                if (isApplied(p)) return true;
                return ['roadProposal', 'buildingProposal', 'structureProposal', 'reparcellization', 'decideLaterProposal']
                    .some(key => p[key] && isApplied(p, p[key]));
            });
        } catch (e) {
            console.warn('[walk] failed to enumerate applied proposals:', e);
            return [];
        }
    }

    function getAppliedSerialProposalIds() {
        const seen = new Set();
        const out = [];
        for (const p of getAppliedProposals()) {
            const sid = pickSerialProposalId(p);
            if (sid && !seen.has(sid)) { seen.add(sid); out.push(sid); }
        }
        // Numeric ascending (matches sortProposalIdsForShare output for numeric IDs).
        return out.sort((a, b) => Number(a) - Number(b));
    }

    function getNonUploadedAppliedProposals() {
        return getAppliedProposals().filter(p => !pickSerialProposalId(p));
    }

    function buildWalkUrl(lat, lng) {
        // Param shape per zagreb-isochrone-main/website/station-3d/modes/cab.js
        // (buildWalkShareUrl): st3d=walk, lat, lon (NOT lng), heading, pitch, proposals.
        const ids = getAppliedSerialProposalIds();
        const params = new URLSearchParams();
        params.set('st3d', 'walk');
        params.set('lat', lat.toFixed(6));
        params.set('lon', lng.toFixed(6));
        if (ids.length) params.set('proposals', ids.join(','));
        const cfg = window.CityConfigManager;
        const walk = cfg && typeof cfg.getWalkConfig === 'function' ? cfg.getWalkConfig() : null;
        if (!walk || !walk.url) return null;
        // loc selects the sim's per-city world sources (station-3d/core/locations.js).
        if (walk.locParam) params.set('loc', walk.locParam);
        return `${walk.url}?${params.toString()}`;
    }

    // Raycast a click on the renderer canvas onto the z=0 ground plane and return the lat/lng.
    function pickGroundLatLngFromEvent(evt) {
        if (!renderer || !camera) return null;
        const rect = renderer.domElement.getBoundingClientRect();
        const ndc = new THREE.Vector2(
            ((evt.clientX - rect.left) / rect.width) * 2 - 1,
            -((evt.clientY - rect.top) / rect.height) * 2 + 1
        );
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(ndc, camera);
        const groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
        const hit = new THREE.Vector3();
        if (!raycaster.ray.intersectPlane(groundPlane, hit)) return null;
        return xyToLatLng(hit.x, hit.y);
    }

    // Raycast a click against proposal surfaces, parcels, and buildings. Proposal geometry is
    // checked first so an editable overlay wins over the cadastral parcel beneath it.
    // Skips invisible objects so an isolated scene only "hits" what's actually shown.
    function pickMapSubjectFromEvent(evt) {
        if (!renderer || !camera) return null;
        const rect = renderer.domElement.getBoundingClientRect();
        const ndc = new THREE.Vector2(
            ((evt.clientX - rect.left) / rect.width) * 2 - 1,
            -((evt.clientY - rect.top) / rect.height) * 2 + 1
        );
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(ndc, camera);
        const targets = [];
        if (proposalInteractionGroup) targets.push(proposalInteractionGroup);
        if (buildingGroup) targets.push(buildingGroup);
        if (flatGroup) targets.push(flatGroup);
        if (plannedFlatGroup) targets.push(plannedFlatGroup);
        if (stationGroup) targets.push(stationGroup);
        const hits = raycaster.intersectObjects(targets, true);
        for (const h of hits) {
            let obj = h.object;
            if (!obj || obj.visible === false) continue;
            let proposalId = null;
            let parcelId = null;
            while (obj) {
                if (!proposalId && obj.userData?.proposalId) proposalId = String(obj.userData.proposalId);
                if (!parcelId && obj.userData?.parcelId) parcelId = String(obj.userData.parcelId);
                obj = obj.parent;
            }
            if (proposalId || parcelId) return { proposalId, parcelId };
        }
        return null;
    }

    function handleParcelClick(evt) {
        if (evt.button !== 0) return;
        // Photo mode is view-only: clicks still pan/tilt the camera (orbit controls), but never
        // select a parcel or proposal — no isolation, no "Proposal info" panel. Model 3D keeps
        // full click interaction.
        if (realisticLayerActive) return;
        if (suppressClickAfterRotateStop) { suppressClickAfterRotateStop = false; return; }
        // Walk-pick owns clicks while it's active.
        if (walkPickActive) return;
        // Ignore the click that ends a camera drag (orbit/tilt) — only a near-stationary
        // press-and-release should isolate.
        if (clickDownXY) {
            const moved = Math.hypot(evt.clientX - clickDownXY.x, evt.clientY - clickDownXY.y);
            clickDownXY = null;
            if (moved > 6) return;
        }
        const picked = pickMapSubjectFromEvent(evt);
        if (picked?.proposalId) {
            const proposal = window.proposalStorage?.getProposal?.(picked.proposalId) || null;
            const parcelId = picked.parcelId || proposal?.parentParcelIds?.[0] || null;
            if (proposal) {
                // 3D is a viewing mode (for now): no 2D details panel here. Clicking a proposal
                // selects it silently and isolates it; clicking it again returns to full view.
                if (isolatedProposalId === String(picked.proposalId)) {
                    clearIsolation();
                    try { window.ProposalSelection?.clear?.(); } catch (_) { }
                    return;
                }
                if (typeof window.selectAndHighlightProposal === 'function') {
                    // keepHighlightsWithoutUi: with no 2D panel open, the selection would
                    // otherwise be cleared by the function's no-visible-UI safety net.
                    window.selectAndHighlightProposal(picked.proposalId, parcelId, false, false, true);
                }
                isolateProposal(picked.proposalId);
                return;
            }
        }
        const pid = picked?.parcelId || null;
        // Click on empty ground, or on the already-isolated parcel, returns to full view.
        if (!pid || pid === isolatedParcelId) { clearIsolation(); return; }
        isolateParcel(pid);
    }

    // Capture-phase boundary: when 3D is active, its keyboard context gets first refusal and
    // document-level 2D shortcuts never see the event. Text fields and native control activation
    // still pass through; modifier combinations retain their browser/OS default without reaching
    // application-level 2D listeners.
    function handleThreeModeKeyboardContext(evt) {
        const action = keyboardContext.classifyThreeModeKeydown({
            active: isActive,
            key: evt.key,
            ctrlKey: evt.ctrlKey,
            metaKey: evt.metaKey,
            altKey: evt.altKey,
            target: evt.target,
            walkPickActive,
            hasIsolation: isolatedParcelId !== null || isolatedProposalId !== null
        });
        if (action === 'pass') return;
        if (action === 'cancel-walk') cancelWalkPick();
        else if (action === 'clear-isolation') clearIsolation();
        if (action !== 'block-2d-native') evt.preventDefault();
        evt.stopImmediatePropagation();
    }

    // Ground lat/lng at the centre of the viewport (NDC 0,0), or null if the ray misses the ground.
    function groundLatLngAtScreenCenter() {
        if (!renderer || !camera) return null;
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
        const groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
        const hit = new THREE.Vector3();
        if (!raycaster.ray.intersectPlane(groundPlane, hit)) return null;
        return xyToLatLng(hit.x, hit.y);
    }

    // Build + open the walk URL for a given ground point (new tab).
    function openWalkAt(ll) {
        if (!ll) { console.warn('[walk] no ground point for walk'); return; }
        try {
            const url = buildWalkUrl(ll.lat, ll.lng);
            if (!url) { console.warn('[walk] no walk overlay configured for this city'); return; }
            window.open(url, '_blank', 'noopener,noreferrer');
        } catch (e) {
            console.warn('[walk] failed to open walk URL:', e);
        }
    }

    // Touch devices have no cursor, so a "tap the ground to place yourself" step is confusing —
    // the user doesn't know a second tap is needed. On a coarse pointer, walk from screen centre
    // immediately; on a mouse, keep the click-to-place pick.
    const isCoarsePointer = () => {
        try { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); }
        catch (_) { return false; }
    };
    function startWalk() {
        if (!isActive) return;
        if (isCoarsePointer()) {
            openWalkAt(groundLatLngAtScreenCenter());
        } else {
            startWalkPick();
        }
    }

    function startWalkPick() {
        if (!isActive || walkPickActive) return;
        walkPickActive = true;
        if (walkBtn) walkBtn.classList.add('active');
        if (threeContainer) threeContainer.classList.add('three-mode-walk-pick');

        walkPickClickHandler = (evt) => {
            // Only react to primary-button clicks.
            if (evt.button !== 0) return;
            const ll = pickGroundLatLngFromEvent(evt);
            cancelWalkPick();
            openWalkAt(ll);
        };
        // 'click' (not 'mousedown') so OrbitControls drags don't trigger a pick.
        if (renderer && renderer.domElement) {
            renderer.domElement.addEventListener('click', walkPickClickHandler);
        }
    }

    function cancelWalkPick() {
        if (!walkPickActive) return;
        walkPickActive = false;
        if (walkBtn) walkBtn.classList.remove('active');
        if (threeContainer) threeContainer.classList.remove('three-mode-walk-pick');
        if (renderer && renderer.domElement && walkPickClickHandler) {
            renderer.domElement.removeEventListener('click', walkPickClickHandler);
        }
        walkPickClickHandler = null;
    }

    if (walkBtn) {
        walkBtn.addEventListener('click', () => {
            if (!isActive) return;
            if (walkPickActive) { cancelWalkPick(); return; }

            const nonUploaded = getNonUploadedAppliedProposals();
            if (nonUploaded.length === 0) {
                startWalk();
                return;
            }

            // Some applied proposals lack a numeric serverProposalId, so the walk page can't
            // load them. Open the upload-gate modal; it auto-closes when the list is empty
            // and then we drop straight into the walk pick.
            if (typeof window.showWalkUploadGateModal === 'function') {
                window.showWalkUploadGateModal({
                    onComplete: () => {
                        if (!isActive) return;
                        if (getNonUploadedAppliedProposals().length === 0) startWalk();
                    }
                });
            } else {
                console.warn('[walk] showWalkUploadGateModal helper missing — falling back to no-op');
            }
        });
    }

    // Expose the current 3D camera as a geographic view (target lat/lng, heading, pitch, range
    // in true metres) for share links and other geo consumers. Returns null when
    // not in 3D. The scene is uniformly Web-Mercator scaled (horizontal distances inflated by
    // ~1/cos(lat)), so the camera->target range is converted back to real metres; the tilt angle
    // is scale-invariant and needs no correction.
    function getGeoCameraView() {
        try {
            if (!isActive || !camera || !controls || !origin3857) return null;
            const camLL = xyToLatLng(camera.position.x, camera.position.y);
            const tgt = controls.target;
            const tgtLL = xyToLatLng(tgt.x, tgt.y);
            if (!camLL || !tgtLL) return null;
            const polar = controls.getPolarAngle();        // 0 = top-down, π/2 = horizon
            const pitchRad = polar - Math.PI / 2;           // 0 = horizon, -π/2 = straight down
            const latRad = tgtLL.lat * Math.PI / 180;
            const range = Math.max(1, controls.getDistance() * Math.cos(latRad));
            let headingDeg = 0;
            if (typeof turf !== 'undefined' && turf) {
                try { headingDeg = turf.bearing([camLL.lng, camLL.lat], [tgtLL.lng, tgtLL.lat]); } catch (_) { }
            }
            return { targetLng: tgtLL.lng, targetLat: tgtLL.lat, headingDeg: headingDeg, pitchRad: pitchRad, range: range };
        } catch (_) { return null; }
    }

    // Expose globals for debugging/manual control
    // Realistic layer policy: while the photoreal mesh is the built world, the abstract built
    // representations (parcel/road slabs, existing buildings, existing rail, OSM trees) hide —
    // proposals, corridor cross-sections and planned structures stay, standing on the mesh.
    window.setRealisticLayerActive = function (on) {
        realisticLayerActive = !!on;
        if (flatGroup) flatGroup.visible = !realisticLayerActive;
        if (treesGroup) treesGroup.visible = treesEnabled && !realisticLayerActive;
        // Photo mode is view-only: hide the model-mode building controls (radius / built / proposed)
        // and drop any isolation + the "Proposal info" panel, so the whole cut scene and all its
        // proposals are shown. Restored on return to model 3D.
        if (buildingModeControlsEl) buildingModeControlsEl.style.display = realisticLayerActive ? 'none' : '';
        if (realisticLayerActive) {
            isolatedParcelId = null;
            isolatedProposalId = null;
            try { updateIsolationButton(); } catch (_) { }
            try { hideParcelInfoPanel(); } catch (_) { }
        }
        if (isActive) rebuild3DBuildingsOnly();
    };
    window.registerThreeModeFrameHook = function (fn) {
        if (typeof fn === 'function' && !frameHooks.includes(fn)) frameHooks.push(fn);
    };
    window.unregisterThreeModeFrameHook = function (fn) {
        const i = frameHooks.indexOf(fn);
        if (i >= 0) frameHooks.splice(i, 1);
    };
    window.setCorridorTerrainSampler = setCorridorTerrainSampler;
    function rebuiltCorridorTerrainPatches(options) {
        options = options || {};
        const paddingM = Math.max(0, Number(options.paddingM) || 0);
        const baseZ = Number.isFinite(Number(options.baseZ)) ? Number(options.baseZ) : 0;
        const depthM = Math.max(0, Number(options.depthM) || 0);
        const includeDepth = !!options.includeDepth;
        const helper = window.__corridorTerrainFormation;
        if (!helper || typeof helper.buildPaddedRuledStripPositions !== 'function') {
            // A top-only fallback would let mask/envelope pairing publish a cut whose solid skirt
            // was never built. Fail closed and leave the Google shell intact instead.
            return [];
        }
        return corridorTerrainCutPatches.map(function (patch) {
            if (!patch || !patch._formationProfile
                || !Number.isFinite(patch._leftM) || !Number.isFinite(patch._rightM)) return patch;
            const ruled = helper.buildPaddedRuledStripPositions(
                patch._formationProfile,
                patch._leftM,
                patch._rightM,
                paddingM,
                baseZ,
                depthM
            );
            const positions = includeDepth ? ruled && ruled.positions : ruled && ruled.topPositions;
            return ruled && ruled.ok && positions && positions.length
                ? {
                    ...patch,
                    positions: positions,
                    boundaryRings: ruled.boundaryRings,
                    _paddingM: paddingM,
                    _baseZ: baseZ,
                    _depthM: depthM
                }
                : null;
        });
    }
    window.getCorridorTerrainCutPatches = function (options) {
        const paddingM = Math.max(0, Number(options && options.lateralPaddingM) || 0);
        return rebuiltCorridorTerrainPatches({ paddingM: paddingM });
    };
    // Realistic mode owns the raster cut only inside this solid station-derived foundation.
    // Its top sits just below the visible lane quilt and its sides/end caps penetrate downward,
    // matching photoreal-sim's continuous slab-over-mask contract.
    window.getCorridorTerrainFoundationPatches = function (options) {
        options = options || {};
        const paddingM = Math.max(0, Number(options.paddingM) || 0);
        const topOffsetM = Number.isFinite(Number(options.topOffsetM))
            ? Number(options.topOffsetM) : 0;
        const skirtDepthM = Math.max(0, Number(options.skirtDepthM) || 0);
        return rebuiltCorridorTerrainPatches({
            paddingM: paddingM,
            baseZ: topOffsetM - skirtDepthM,
            depthM: skirtDepthM,
            includeDepth: true
        });
    };
    window.corridorTerrainHeightAt = function (x, y) {
        const z = terrainHeightFromProfiles(corridorTerrainProfiles, Number(x), Number(y));
        return Number.isFinite(z) ? z : null;
    };
    window.corridorTerrainVisibleSurfaceAt = function (x, y) {
        const z = terrainVisibleSurfaceFromProfiles(corridorTerrainProfiles, Number(x), Number(y));
        return Number.isFinite(z) ? z : null;
    };
    window.corridorTerrainHeightAtForProposal = function (proposalId, x, y) {
        const id = proposalId == null ? null : String(proposalId);
        if (id === null) return null;
        const ownedProfiles = corridorTerrainProfiles.filter(profile => profile
            && profile.proposalId != null && String(profile.proposalId) === id);
        const z = terrainHeightFromProfiles(ownedProfiles, Number(x), Number(y));
        return Number.isFinite(z) ? z : null;
    };
    // The photoreal tile layer builds INTO this scene — hand it the live internals rather
    // than letting it run a second renderer (the whole point of retiring Cesium).
    window.getThreeModeInternals = function () {
        if (!isActive || !scene || !camera || !renderer) return null;
        return {
            scene: scene, camera: camera, renderer: renderer, controls: controls,
            latLngToXY: latLngToXY, xyToLatLng: xyToLatLng,
            originLatLng: function () { const ll = xyToLatLng(0, 0); return { lat: ll.lat, lng: ll.lng }; }
        };
    };
    window.enterThreeMode = enter3D;
    window.exitThreeMode = exit3D;
    window.isThreeModeActive = function () { return isActive; };
    window.getThree3DGeoView = getGeoCameraView;

    // Window capture runs before every document-level shortcut, including the few legacy handlers
    // that also use capture. This is the keyboard-context boundary between the 3D and 2D apps.
    window.addEventListener('keydown', handleThreeModeKeyboardContext, true);

    document.addEventListener('proposal-draft-preview-change', event => {
        rebuildProposalDraftPreview3D(event.detail || null);
    });

    // Initial paint: mark 2D as the active mode on load.
    updateModeButtonStates();
})();
